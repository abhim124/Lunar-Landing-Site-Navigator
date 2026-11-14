import type { MissionStore } from '@/store/useMissionStore';
import type { MissionPhase } from '@/types/assistant';
import { angleDiffDeg } from './geo';

const r1 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? undefined : Math.round(n * 10) / 10);

/** "9 days 4 hours" — easier for the model to read aloud than raw hours. */
function humanHours(h: number | null | undefined): string | undefined {
  if (h == null || !Number.isFinite(h)) return undefined;
  const d = Math.floor(h / 24);
  const hr = Math.round(h - d * 24);
  if (d === 0) return `${hr} hours`;
  return `${d} day${d === 1 ? '' : 's'} ${hr} hour${hr === 1 ? '' : 's'}`;
}

/** Drop undefined/null leaves and empty objects so the prompt stays compact. */
function compact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(compact) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const c = compact(val);
      if (c === undefined || c === null) continue;
      if (typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out as T;
  }
  return v;
}

/** Top upcoming runs of consecutive GO days from the 365-day launch calendar. */
function bestGoWindows(s: MissionStore, limit = 3) {
  const days = s.calendar?.days;
  if (!days?.length) return undefined;
  const from = s.epochUTC.slice(0, 10);
  const runs: { start: string; end: string; days: number; avgScore: number }[] = [];
  let cur: { start: string; end: string; days: number; total: number } | null = null;
  for (const d of days) {
    if (d.date < from) continue;
    if (d.status === 'GO') {
      if (cur) {
        cur.end = d.date;
        cur.days++;
        cur.total += d.score;
      } else cur = { start: d.date, end: d.date, days: 1, total: d.score };
    } else if (cur) {
      runs.push({ start: cur.start, end: cur.end, days: cur.days, avgScore: Math.round((cur.total / cur.days) * 100) / 100 });
      cur = null;
    }
  }
  if (cur) runs.push({ start: cur.start, end: cur.end, days: cur.days, avgScore: Math.round((cur.total / cur.days) * 100) / 100 });
  return runs.length ? runs.slice(0, limit) : [];
}

export function buildMissionState(s: MissionStore, missionPhase: MissionPhase) {
  const site = s.selectedSite;
  // Only trust the evaluation if it matches the current site + epoch (it may be stale mid-refresh).
  const ev =
    site &&
    s.evaluation &&
    Math.abs(s.evaluation.site.lat - site.lat) < 1e-4 &&
    Math.abs(angleDiffDeg(s.evaluation.site.lon, site.lon)) < 1e-4 &&
    Date.parse(s.evaluation.epoch_utc) === Date.parse(s.epochUTC)
      ? s.evaluation
      : null;

  // Earth position at the current timeline position (nearest backend trajectory sample).
  const samples = ev?.trajectory.samples ?? [];
  const now = samples.length
    ? samples.reduce((best, x) => (Math.abs(x.hours_from_start - s.scrubHour) < Math.abs(best.hours_from_start - s.scrubHour) ? x : best))
    : null;

  const alt = s.alternative;
  const il = ev?.illumination;

  return compact({
    missionPhase,
    site: site?.name ?? 'No site selected',
    lat: site ? Number(site.lat.toFixed(4)) : undefined,
    lon: site ? Number(site.lon.toFixed(4)) : undefined,
    artemisRegion: ev?.site.artemis_region ?? undefined,
    dateUtc: s.epochUTC,
    timelineHoursFromStart: s.scrubHour || undefined,
    durationDays: s.missionDurationDays,
    antennaMaskDeg: s.minEarthElevationDeg,
    evaluationStatus: ev ? undefined : s.evaluationStatus === 'loading' ? 'computing' : s.evaluationStatus === 'error' ? 'evaluation failed' : undefined,
    verdict: ev?.overall_status,
    verdictReason: ev?.verdict_reasons.length ? ev.verdict_reasons.join(' ') : undefined,
    power: il && {
      sunlitPct: r1(il.sunlit_pct.value),
      longestDarknessHours: r1(il.longest_darkness_hours.value),
      timeUntilNextDarknessHours: r1(il.time_to_sunset_hours.value),
      timeUntilNextDarkness: il.time_to_sunset_hours.value == null ? 'Sun stays up for the whole mission' : humanHours(il.time_to_sunset_hours.value),
      status: il.sunlit_pct.status,
    },
    comms: il && {
      earthElevationDeg: r1(now?.earth_el_deg),
      terrainHorizonTowardEarthDeg: r1(now?.earth_horizon_el_deg),
      linkStatus: now ? (now.earth_visible ? 'LINK UP (Earth in line of sight)' : 'NO LINE OF SIGHT to Earth') : undefined,
      earthVisibilityPct: r1(il.earth_contact_pct.value),
      timeUntilEarthsetHours: r1(il.time_to_earthset_hours.value),
      timeUntilEarthset: il.time_to_earthset_hours.value == null ? 'Earth stays in view for the whole mission' : humanHours(il.time_to_earthset_hours.value),
      status: il.earth_contact_pct.status,
    },
    terrain: ev && { slopeDeg: r1(ev.terrain.slope_deg.value), surfaceTempK: ev.thermal.surface_temperature_k.value },
    spaceWeather: ev && {
      status: ev.space_weather.status,
      evaStatus: ev.space_weather.eva_status,
      solarParticleEvents: ev.space_weather.sep_event_count,
      flares: ev.space_weather.flare_count,
      strongestFlare: ev.space_weather.strongest_flare_class,
      summary: ev.space_weather.summary,
    },
    alternatives: alt && {
      nearbyPad: alt.best_nearby_site && {
        distanceKm: r1(alt.best_nearby_site.distance_km),
        bearingDeg: Math.round(alt.best_nearby_site.bearing_deg),
        status: alt.best_nearby_site.status,
        sunlitPct: r1(alt.best_nearby_site.sunlit_pct),
        earthContactPct: r1(alt.best_nearby_site.earth_contact_pct),
        summary: alt.best_nearby_site.summary,
      },
      betterDate: alt.best_launch_date && {
        dateUtc: alt.best_launch_date.epoch_utc,
        offsetDays: alt.best_launch_date.offset_days,
        status: alt.best_launch_date.status,
        sunlitPct: r1(alt.best_launch_date.sunlit_pct),
        earthContactPct: r1(alt.best_launch_date.earth_contact_pct),
        summary: alt.best_launch_date.summary,
      },
    },
    bestGoWindows: bestGoWindows(s),
  });
}
