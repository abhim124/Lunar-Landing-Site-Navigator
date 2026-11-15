import type Anthropic from '@anthropic-ai/sdk';
import { CURATED_SITES } from '@/lib/siteRegistry';
import type { AgentAction, AgentContext, AgentPanel } from '@/types/assistant';
import { LAYER_IDS, type LayerId } from '@/types/mission';

/**
 * CAPCOM's tools. Data tools run here (server side) against the FastAPI backend; UI tools are
 * recorded as AgentActions that the browser applies, in order, when the reply arrives. A working
 * copy of the mission context is updated as actions are queued so later tool calls in the same
 * turn (e.g. go_to_site → find_best_date) see the new site and date.
 */

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8000').replace(/\/+$/, '');

const PANELS: AgentPanel[] = ['calendar', 'compare', 'verdict', 'alternatives', 'validation', 'power', 'comms'];

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'find_best_site',
    description:
      'Search the whole lunar south pole (poleward of 80°S: every flat, non-shadowed pad plus the 14 Artemis III candidate regions) for the best landing pad for a launch date, using real LOLA terrain and DE421 Sun/Earth ephemeris over the mission window. Use for "best landing spot on <date>", "where should we land", etc. By default it also moves the lander there, sets the date and opens the launch calendar.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Launch date YYYY-MM-DD or ISO datetime (UTC). Omit to use the current mission date.' },
        mission_days: { type: 'number', description: 'Mission length in days (0.5–30). Omit to keep the current one.' },
        move_there: { type: 'boolean', description: 'Move the lander to the result and open the calendar (default true).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'go_to_site',
    description:
      'Select and fly to a landing site: a named site (Artemis III regions such as Haworth, Malapert Massif, Peak Near Shackleton, Connecting Ridge, de Gerlache Rim 1/2, Nobile Rim 1/2, Mons Mouton, Mons Mouton Plateau, Slater Plain, Peak near Cabeus B; or historical landings: Apollo 11, Chandrayaan-3, IM-1, IM-2) or explicit coordinates. Keeps the current date unless the site is a historical landing.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Site name (fuzzy match).' },
        lat: { type: 'number', description: 'Latitude in degrees (south negative), with lon, instead of a name.' },
        lon: { type: 'number', description: 'Longitude in degrees east (−180..360).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_mission',
    description: 'Change the landing date/time, mission length, or minimum Earth elevation for communications.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD or ISO datetime (UTC).' },
        time_utc: { type: 'string', description: 'HH:MM (UTC), applied to the date.' },
        mission_days: { type: 'number', description: '0.5–30 days.' },
        min_earth_elevation_deg: { type: 'number', description: '0–20 degrees.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'find_best_date',
    description:
      'Find the best launch date for the currently selected site from its launch calendar (365 days by default, scored with DE421 + LOLA horizon). Use for "when is the best time to land here". By default moves the mission date there and opens the calendar.',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'Start of the search YYYY-MM-DD (default: current mission date).' },
        within_days: { type: 'number', description: 'How far ahead to search, 1–365 (default 365).' },
        move_there: { type: 'boolean', description: 'Set the mission date to the result and open the calendar (default true).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'show_panel',
    description:
      'Bring a panel into view and flash it: calendar (365-day launch calendar), compare (nearby-site comparison next to the calendar), verdict (mission verdict card), alternatives (where-or-when-instead card), validation (NASA/JPL Horizons validation), power, comms.',
    input_schema: {
      type: 'object',
      properties: { panel: { type: 'string', enum: PANELS } },
      required: ['panel'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_map_layer',
    description:
      'Change the globe map layer: BASE_CGI (visual), WAC_POLE_ILL_PCT_SOUTH_100M (LRO WAC illumination %), LOLA_COLOR_RELIEF (elevation), PGDA_SUN_VISIBILITY (average sunlight), PGDA_EARTH_VISIBILITY (average Earth visibility).',
    input_schema: {
      type: 'object',
      properties: { layer: { type: 'string', enum: [...LAYER_IDS] } },
      required: ['layer'],
      additionalProperties: false,
    },
  },
];

/* ───────────── helpers ───────────── */

const r1 = (n: number) => Math.round(n * 10) / 10;

async function backend<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`backend ${res.status} on ${path.split('?')[0]}`);
  return (await res.json()) as T;
}

/** "2027-03-01" or a full ISO string → ISO at the context's time of day (or the given HH:MM). */
function toEpoch(date: string | undefined, ctx: AgentContext, timeUtc?: string): string | null {
  const base = ctx.epochUTC;
  const d = (date ?? base).trim();
  const day = d.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return null;
  let time = /T\d{2}:\d{2}/.test(d) ? d.slice(11, 16) : base.slice(11, 16);
  if (timeUtc && /^\d{1,2}:\d{2}$/.test(timeUtc.trim())) time = timeUtc.trim().padStart(5, '0');
  return `${day}T${time}:00Z`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function matchSite(name: string) {
  const q = norm(name);
  if (!q) return null;
  const exact = CURATED_SITES.find((s) => norm(s.name) === q || norm(s.shortName) === q || s.id === q);
  if (exact) return exact;
  const contains = CURATED_SITES.filter((s) => norm(s.name).includes(q) || norm(s.shortName).includes(q) || q.includes(norm(s.shortName)));
  if (contains.length) return contains.sort((a, b) => a.name.length - b.name.length)[0];
  const words = q.split(' ').filter((w) => w.length > 2);
  const scored = CURATED_SITES.map((s) => ({ s, n: words.filter((w) => norm(s.name).includes(w)).length })).filter((x) => x.n > 0);
  return scored.sort((a, b) => b.n - a.n)[0]?.s ?? null;
}

interface BestSitePad {
  lat: number;
  lon: number;
  status: string;
  sunlit_pct: number;
  earth_contact_pct: number;
  longest_darkness_hours: number;
  slope_deg: number;
  nearest_region: string;
  nearest_region_km: number;
}

interface CalendarDay {
  date: string;
  status: 'GO' | 'MARGINAL' | 'NO-GO';
  score: number;
  sunlit_pct: number;
  earth_contact_pct: number;
  longest_darkness_hours: number;
}

const padSummary = (p: BestSitePad) => ({
  lat: Number(p.lat.toFixed(4)),
  lon: Number(p.lon.toFixed(4)),
  verdict: p.status,
  sunlit_pct: r1(p.sunlit_pct),
  earth_contact_pct: r1(p.earth_contact_pct),
  longest_darkness_hours: r1(p.longest_darkness_hours),
  slope_deg: r1(p.slope_deg),
  location: p.nearest_region_km < 2 ? p.nearest_region : `${r1(p.nearest_region_km)} km from ${p.nearest_region}`,
});

/** PSR landing rule: the app relocates pads inside / within 500 m of a permanently shadowed region. */
async function psrNote(lat: number, lon: number): Promise<Record<string, unknown> | undefined> {
  try {
    const r = await backend<{ safe: boolean; in_psr: boolean; psr_distance_km: number | null; nearest_safe: { lat: number; lon: number; distance_km: number; bearing_deg: number } | null }>(
      `/api/psr/check?lat=${lat}&lon=${lon}`,
    );
    if (r.safe) return undefined;
    return {
      psr_warning: r.in_psr ? 'requested point is INSIDE a permanently shadowed region' : `requested point is ${Math.round((r.psr_distance_km ?? 0) * 1000)} m from a PSR (minimum 500 m)`,
      app_relocates_to: r.nearest_safe
        ? { lat: Number(r.nearest_safe.lat.toFixed(4)), lon: Number(r.nearest_safe.lon.toFixed(4)), distance_km: r1(r.nearest_safe.distance_km), bearing_deg: Math.round(r.nearest_safe.bearing_deg) }
        : 'no safe pad within 40 km',
    };
  } catch {
    return undefined;
  }
}

/* ───────────── executor ───────────── */

export async function runAgentTool(
  name: string,
  rawInput: unknown,
  ctx: AgentContext,
  actions: AgentAction[],
): Promise<{ content: string; isError?: boolean }> {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  const num = (k: string) => (typeof input[k] === 'number' && Number.isFinite(input[k]) ? (input[k] as number) : undefined);
  const move = input.move_there !== false;
  const json = (o: unknown) => ({ content: JSON.stringify(o) });
  const fail = (msg: string) => ({ content: msg, isError: true });

  switch (name) {
    case 'find_best_site': {
      const epoch = toEpoch(str('date'), ctx);
      if (!epoch) return fail('Invalid date. Use YYYY-MM-DD.');
      const days = Math.min(30, Math.max(0.5, num('mission_days') ?? ctx.missionDays));
      const res = await backend<{
        best: BestSitePad;
        runners_up: BestSitePad[];
        candidates_evaluated: number;
        verdict_counts: Record<string, number>;
        search_region: string;
      }>(`/api/best-site?epoch_utc=${encodeURIComponent(epoch)}&mission_duration_days=${days}&min_earth_elevation_deg=${ctx.minEarthElevationDeg}&top=4`);
      if (move) {
        const b = res.best;
        const lonE = ((b.lon + 540) % 360) - 180;
        const coords = `${Math.abs(b.lat).toFixed(2)}°S ${Math.abs(lonE).toFixed(2)}°${lonE >= 0 ? 'E' : 'W'}`;
        const label = b.nearest_region_km < 2 ? b.nearest_region : b.nearest_region_km < 25 ? `Best pad · near ${b.nearest_region}` : `Best pad · ${coords}`;
        actions.push({ type: 'select_site', lat: res.best.lat, lon: res.best.lon, name: label, epochUTC: epoch });
        if (days !== ctx.missionDays) actions.push({ type: 'set_mission', missionDays: days });
        actions.push({ type: 'show_panel', panel: 'calendar' });
        ctx.site = { lat: res.best.lat, lon: res.best.lon, name: label };
        ctx.epochUTC = epoch;
        ctx.missionDays = days;
      }
      return json({
        search: `${res.search_region}; ${res.candidates_evaluated} candidate pads scored for a ${days}-day mission from ${epoch}`,
        verdict_counts: res.verdict_counts,
        best: padSummary(res.best),
        runners_up: res.runners_up.map(padSummary),
        moved_there: move,
      });
    }

    case 'go_to_site': {
      const lat = num('lat');
      const lon = num('lon');
      const n = str('name');
      if (lat !== undefined && lon !== undefined) {
        if (lat < -90 || lat > 90) return fail('Latitude out of range.');
        const label = n ?? 'Custom site';
        actions.push({ type: 'select_site', lat, lon, name: label, epochUTC: ctx.epochUTC });
        ctx.site = { lat, lon, name: label };
        const psr = await psrNote(lat, lon);
        if (psr && typeof psr.app_relocates_to === 'object') {
          const t = psr.app_relocates_to as { lat: number; lon: number };
          ctx.site = { lat: t.lat, lon: t.lon, name: `Safe pad · ${label}` };
        }
        return json({ moved_to: { name: label, lat, lon }, date: ctx.epochUTC, ...psr });
      }
      if (!n) return fail('Give a site name or lat/lon.');
      const site = matchSite(n);
      if (!site) return fail(`No site matches "${n}". Known sites: ${CURATED_SITES.map((s) => s.shortName).join(', ')}.`);
      const epoch = site.epochUTC ?? ctx.epochUTC;
      actions.push({ type: 'select_site', lat: site.lat, lon: site.lon, name: site.name, regionId: site.id, epochUTC: epoch });
      ctx.site = { lat: site.lat, lon: site.lon, name: site.name };
      ctx.epochUTC = epoch;
      return json({
        moved_to: { name: site.name, lat: site.lat, lon: site.lon, approximate_coordinates: site.isApproxCoord },
        date: epoch,
        note: site.epochUTC ? 'Historical landing: the clock moved to its landing epoch.' : undefined,
      });
    }

    case 'set_mission': {
      const date = str('date');
      const time = str('time_utc');
      const out: Record<string, unknown> = {};
      const action: Extract<AgentAction, { type: 'set_mission' }> = { type: 'set_mission' };
      if (date || time) {
        const epoch = toEpoch(date, ctx, time);
        if (!epoch) return fail('Invalid date/time. Use YYYY-MM-DD and HH:MM.');
        action.epochUTC = epoch;
        ctx.epochUTC = epoch;
        out.date = epoch;
      }
      const md = num('mission_days');
      if (md !== undefined) {
        action.missionDays = Math.min(30, Math.max(0.5, md));
        ctx.missionDays = action.missionDays;
        out.mission_days = action.missionDays;
      }
      const el = num('min_earth_elevation_deg');
      if (el !== undefined) {
        action.minEarthElevationDeg = Math.min(20, Math.max(0, el));
        ctx.minEarthElevationDeg = action.minEarthElevationDeg;
        out.min_earth_elevation_deg = action.minEarthElevationDeg;
      }
      if (Object.keys(out).length === 0) return fail('Nothing to change.');
      actions.push(action);
      return json({ updated: out });
    }

    case 'find_best_date': {
      if (!ctx.site) return fail('No site selected. Use go_to_site or find_best_site first.');
      const from = (str('from_date') ?? ctx.epochUTC).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return fail('Invalid from_date.');
      const within = Math.round(Math.min(365, Math.max(1, num('within_days') ?? 365)));
      const cal = await backend<{ days: CalendarDay[] }>(
        `/api/launch-calendar?lat=${ctx.site.lat}&lon=${ctx.site.lon}&start_date=${from}&n_days=${within}&mission_duration_days=${ctx.missionDays}&min_earth_elevation_deg=${ctx.minEarthElevationDeg}`,
      );
      const days = cal.days;
      const rank = { GO: 2, MARGINAL: 1, 'NO-GO': 0 } as const;
      // Best = best verdict, then score; ties go to the earliest date.
      const best = days.reduce((a, b) => (rank[b.status] > rank[a.status] || (rank[b.status] === rank[a.status] && b.score > a.score + 1e-6) ? b : a));
      let run = 0;
      let bestRun = { len: 0, start: '' };
      let start = '';
      for (const d of days) {
        if (d.status === 'GO') {
          if (run === 0) start = d.date;
          run++;
          if (run > bestRun.len) bestRun = { len: run, start };
        } else run = 0;
      }
      const counts = { GO: 0, MARGINAL: 0, 'NO-GO': 0 };
      days.forEach((d) => counts[d.status]++);
      if (move) {
        const epoch = toEpoch(best.date, ctx)!;
        actions.push({ type: 'set_mission', epochUTC: epoch });
        actions.push({ type: 'focus_calendar', date: best.date, label: 'Best day', status: best.status });
        actions.push({ type: 'show_panel', panel: 'calendar' });
        ctx.epochUTC = epoch;
      }
      return json({
        site: ctx.site.name,
        searched: `${within} days from ${from}`,
        best_date: { date: best.date, verdict: best.status, sunlit_pct: r1(best.sunlit_pct), earth_contact_pct: r1(best.earth_contact_pct), longest_darkness_hours: r1(best.longest_darkness_hours) },
        longest_go_window: bestRun.len ? { start: bestRun.start, days: bestRun.len } : null,
        next_go_date: days.find((d) => d.status === 'GO')?.date ?? null,
        day_counts: counts,
        moved_there: move,
      });
    }

    case 'show_panel': {
      const panel = str('panel') as AgentPanel | undefined;
      if (!panel || !PANELS.includes(panel)) return fail(`panel must be one of ${PANELS.join(', ')}`);
      actions.push({ type: 'show_panel', panel });
      return json({ shown: panel });
    }

    case 'set_map_layer': {
      const layer = str('layer') as LayerId | undefined;
      if (!layer || !LAYER_IDS.includes(layer)) return fail(`layer must be one of ${LAYER_IDS.join(', ')}`);
      actions.push({ type: 'set_layer', layer });
      return json({ layer });
    }

    default:
      return fail(`Unknown tool ${name}`);
  }
}
