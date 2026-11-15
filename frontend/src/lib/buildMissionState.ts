import type { MissionStore } from '@/store/useMissionStore';
import type { MissionPhase } from '@/types/assistant';
import { angleDiffDeg } from './geo';
import { iceLikelihood, wehAt } from './iceHydrogen';
import { powerSeries, powerStats, sampleStepH } from './power';
import { isInPsr, kToC, temperatureSeries } from './temperature';

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
  const expert = s.displayMode === 'expert';

  // Temperature (model estimate) at the timeline position + over the mission; Diviner measured range alongside.
  const temp = ev ? temperatureSeries(samples, isInPsr(ev.isru.nearest_ice_psr_km.value), s.scrubHour) : null;
  const div = ev?.thermal.surface_temperature_k.value;
  const pw = expert && ev ? powerStats(powerSeries(samples, s.expert), sampleStepH(samples), s.expert.loadW) : null;
  const slope = expert && site && s.slopeStats && Math.abs(s.slopeStats.lat - site.lat) < 1e-6 ? s.slopeStats : null;
  const weh = expert && site ? wehAt(site.lat, site.lon) : null;

  return compact({
    displayMode: s.displayMode,
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
    terrain: ev && { slopeDeg: r1(ev.terrain.slope_deg.value), roughnessM: r1(ev.terrain.roughness_m.value) },
    temperature: temp && {
      estimateNote: 'model estimate (radiative equilibrium using Sun height above the terrain horizon; shadow 90 K, PSR 40 K)',
      nowC: Math.round(kToC(temp.nowK)),
      minC: Math.round(kToC(temp.minK)),
      maxC: Math.round(kToC(temp.maxK)),
      nowK: Math.round(temp.nowK),
      divinerMeasuredRangeK: div && div.min_k != null && div.max_k != null ? `${Math.round(div.min_k)}–${Math.round(div.max_k)} K (LRO Diviner, measured climatology)` : undefined,
    },
    expertAnalysis: expert
      ? {
          panelAssumptions: {
            areaM2: s.expert.panelAreaM2,
            efficiency: s.expert.panelEff,
            orientation: s.expert.orientation === 'tracking' ? 'vertical, Sun-tracking' : `vertical, fixed facing ${s.expert.facingAzDeg}°`,
            loadW: s.expert.loadW,
          },
          powerEstimate: pw && {
            averageW: Math.round(pw.avgW),
            peakW: Math.round(pw.peakW),
            energyKWh: r1(pw.energyKWh),
            longestZeroPowerHours: r1(pw.longestZeroH),
            batteryNeededKWh: r1(pw.batteryWh / 1000),
          },
          slope: slope && {
            atPadDeg: r1(slope.slope_at_point_deg),
            meanDeg: r1(slope.mean_slope_deg),
            maxDeg: r1(slope.max_slope_deg),
            roughnessRmsM: r1(slope.roughness_rms_m),
            radiusM: slope.effective_radius_m,
            demResolutionM: slope.pixel_m,
            maxSafeSlopeDeg: s.expert.maxSafeSlopeDeg,
            pass: slope.slope_at_point_deg <= s.expert.maxSafeSlopeDeg && slope.mean_slope_deg <= s.expert.maxSafeSlopeDeg,
          },
          iceHydrogen: weh != null && {
            hydrogenWehWtPct: Math.round(weh * 100) / 100,
            hydrogenNote: 'ILLUSTRATIVE value, not a measurement',
            nearestPsrKm: r1(ev?.isru.nearest_ice_psr_km.value ?? null),
            iceLikelihood: iceLikelihood(weh, ev?.isru.nearest_ice_psr_km.value ?? null),
          },
        }
      : undefined,
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
