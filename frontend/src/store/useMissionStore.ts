'use client';

import { create } from 'zustand';
import { api, errorMessage, isAbortError } from '@/lib/api';
import { DEFAULT_EXPERT, type DisplayMode, type ExpertSettings } from '@/lib/displayMode';
import { currentHourUTC, normalizeEpoch } from '@/lib/format';
import { clamp, greatCircleDistanceKm, normalizeLon } from '@/lib/geo';
import { CURATED_BY_ID } from '@/lib/siteRegistry';
import type {
  SlopeStatsResponse,
  DrawerTab,
  LaunchCalendarResponse,
  LayerId,
  NearestAlternativeResponse,
  SelectedSite,
  SiteEvaluationResponse,
  ValidationBenchmarkResponse,
} from '@/types/mission';

export type RequestStatus = 'idle' | 'loading' | 'success' | 'error';

export interface SceneStatus {
  baseTexture: 'loading' | 'svs' | 'local' | 'procedural';
  heightmap: 'loading' | 'lola' | 'synthetic';
  overlay: 'idle' | 'loading' | 'ready' | 'error';
  overlayDetail: string | null;
}

export type FlyToRequest =
  | { kind: 'site'; lat: number; lon: number; nonce: number }
  | { kind: 'overview'; nonce: number };

export const SEARCH_RADIUS_KM = 5;
export const DATE_WINDOW_DAYS = 14;
export const CALENDAR_DAYS = 365;

export interface MissionState {
  selectedSite: SelectedSite | null;
  epochUTC: string;
  missionDurationDays: number;
  minEarthElevationDeg: number;
  activeLayer: LayerId;
  /** Standard | Learn | Expert. `learnMode` and `showMore` are kept in sync with it for older readers. */
  displayMode: DisplayMode;
  learnMode: boolean;
  /** True in Expert mode: reveals secondary controls and details (what the old "More" toggle showed). */
  showMore: boolean;
  expert: ExpertSettings;
  /** A launch day CAPCOM picked (e.g. "best date"): the calendar jumps to its month and marks it. Tied to one site. */
  calendarFocus: CalendarFocus | null;
  psrNotice: PsrNotice | null;
  /** Last slope / roughness statistics fetched for the Expert card (also sent to CAPCOM). */
  slopeStats: SlopeStatsResponse | null;
  activeDrawerTab: DrawerTab;
  isDrawerOpen: boolean;
  /** Hours since epochUTC on the timeline scrubber (local-only, no network). */
  scrubHour: number;
  flyTo: FlyToRequest | null;
  sceneStatus: SceneStatus;

  evaluation: SiteEvaluationResponse | null;
  evaluationStatus: RequestStatus;
  evaluationError: string | null;

  calendar: LaunchCalendarResponse | null;
  calendarStatus: RequestStatus;
  calendarError: string | null;
  calendarKey: string | null;

  alternative: NearestAlternativeResponse | null;
  alternativeStatus: RequestStatus;
  alternativeError: string | null;

  validation: ValidationBenchmarkResponse | null;
  validationStatus: RequestStatus;
  validationError: string | null;
  validationKey: string | null;
}

/** Shown when a chosen pad falls in / near a permanently shadowed region (PSR). */
export interface PsrNotice {
  /** moved: auto-relocated to a safe pad · override: user chose to land anyway · view: PSR shown for comparison only · none: no safe pad found */
  kind: 'moved' | 'override' | 'view' | 'none';
  clicked: SelectedSite;
  inPsr: boolean;
  psrDistanceKm: number | null;
  to?: { lat: number; lon: number; distanceKm: number; bearingDeg: number; criteria: string };
}

export interface CalendarFocus {
  date: string;
  label: string;
  status?: 'GO' | 'MARGINAL' | 'NO-GO';
  lat: number;
  lon: number;
}

export interface UrlHydration {
  lat?: number;
  lon?: number;
  epochUTC?: string;
  days?: number;
  ant?: number;
  layer?: LayerId;
  mode?: DisplayMode;
  expert?: Partial<ExpertSettings>;
  siteId?: string;
}

export interface MissionActions {
  /** `allowPsr` skips the PSR landing guard (used for "land here anyway" and comparison-only views). */
  selectSite: (site: SelectedSite, opts?: { fly?: boolean; evaluate?: boolean; epochUTC?: string; allowPsr?: boolean; psrView?: boolean }) => void;
  selectCuratedSite: (id: string) => void;
  selectCustomSite: (lat: number, lon: number) => void;
  clearSelection: () => void;
  setEpochUTC: (iso: string) => void;
  setMissionDurationDays: (days: number) => void;
  setMinEarthElevationDeg: (deg: number) => void;
  setActiveLayer: (layer: LayerId) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  setLearnMode: (on: boolean) => void;
  setShowMore: (on: boolean) => void;
  setExpert: (patch: Partial<ExpertSettings>) => void;
  setSlopeStats: (stats: SlopeStatsResponse | null) => void;
  setCalendarFocus: (focus: CalendarFocus | null) => void;
  setPsrNotice: (notice: PsrNotice | null) => void;
  setActiveDrawerTab: (tab: DrawerTab) => void;
  setDrawerOpen: (open: boolean) => void;
  setScrubHour: (h: number) => void;
  setSceneStatus: (patch: Partial<SceneStatus>) => void;
  hydrateFromUrl: (p: UrlHydration) => void;

  evaluateSite: () => Promise<void>;
  fetchLaunchCalendar: (force?: boolean) => Promise<void>;
  fetchNearestAlternative: () => Promise<void>;
  fetchValidation: (force?: boolean) => Promise<void>;
  applyAlternative: (lat: number, lon: number, epochUTC: string) => void;
}

export type MissionStore = MissionState & MissionActions;

/* ─────────── request bookkeeping (module scope, never in React state) ─────────── */

type RequestKey = 'evaluate' | 'calendar' | 'alternative' | 'validation';
const controllers: Partial<Record<RequestKey, AbortController>> = {};
function beginRequest(key: RequestKey): AbortController {
  controllers[key]?.abort();
  const c = new AbortController();
  controllers[key] = c;
  return c;
}
function abortAll() {
  (Object.keys(controllers) as RequestKey[]).forEach((k) => controllers[k]?.abort());
}

let evaluateTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleEvaluate(get: () => MissionStore, delayMs = 400) {
  if (!get().selectedSite) return;
  if (evaluateTimer) clearTimeout(evaluateTimer);
  evaluateTimer = setTimeout(() => {
    evaluateTimer = null;
    void get().evaluateSite();
  }, delayMs);
}

/**
 * PSR landing guard: no pad may sit inside a permanently shadowed region or within 500 m of one.
 * Runs after every normal selection (map click, typed coordinates, presets, CAPCOM, shared links);
 * if the pad is unsafe it is moved to the nearest flat, sunlit pad outside the buffer.
 */
async function guardPsr(get: () => MissionStore, set: (p: Partial<MissionState>) => void, clicked: SelectedSite) {
  let r;
  try {
    r = await api.psrCheck({ lat: clicked.lat, lon: clicked.lon });
  } catch {
    return; // backend offline: the verdict still flags PSRs when it comes back
  }
  const now = get().selectedSite;
  if (!now || Math.abs(now.lat - clicked.lat) > 1e-9 || Math.abs(now.lon - clicked.lon) > 1e-9) return; // user moved on
  if (r.safe) return;
  const base = clicked.name.replace(/^(Safe pad|Contingency pad|Nearby pad|Alt\. pad) · /, '');
  if (!r.nearest_safe) {
    set({ psrNotice: { kind: 'none', clicked, inPsr: r.in_psr, psrDistanceKm: r.psr_distance_km } });
    return;
  }
  const t = r.nearest_safe;
  set({
    psrNotice: {
      kind: 'moved',
      clicked,
      inPsr: r.in_psr,
      psrDistanceKm: r.psr_distance_km,
      to: { lat: t.lat, lon: t.lon, distanceKm: t.distance_km, bearingDeg: t.bearing_deg, criteria: t.criteria },
    },
  });
  get().selectSite({ lat: t.lat, lon: t.lon, name: `Safe pad · ${base}`, regionId: null }, { epochUTC: get().epochUTC, fly: true, allowPsr: true });
}

const isoDate = (iso: string) => iso.slice(0, 10);
const addDaysIso = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const siteKey = (s: SelectedSite) => `${s.lat.toFixed(5)},${s.lon.toFixed(5)}`;

export const useMissionStore = create<MissionStore>()((set, get) => ({
  selectedSite: null,
  epochUTC: currentHourUTC(),
  missionDurationDays: 7,
  minEarthElevationDeg: 5,
  activeLayer: 'BASE_CGI',
  displayMode: 'standard',
  learnMode: false,
  showMore: false,
  expert: DEFAULT_EXPERT,
  slopeStats: null,
  calendarFocus: null,
  psrNotice: null,
  activeDrawerTab: 'PANORAMA',
  isDrawerOpen: true,
  scrubHour: 0,
  flyTo: null,
  sceneStatus: { baseTexture: 'loading', heightmap: 'loading', overlay: 'idle', overlayDetail: null },

  evaluation: null,
  evaluationStatus: 'idle',
  evaluationError: null,

  calendar: null,
  calendarStatus: 'idle',
  calendarError: null,
  calendarKey: null,

  alternative: null,
  alternativeStatus: 'idle',
  alternativeError: null,

  validation: null,
  validationStatus: 'idle',
  validationError: null,
  validationKey: null,

  /* ─────────── selection ─────────── */

  selectSite: (site, opts = {}) => {
    const { fly = true, evaluate = true, epochUTC, allowPsr = false, psrView = false } = opts;
    // A fresh, guarded selection clears any earlier PSR notice; guard-driven moves keep theirs.
    if (!allowPsr) set({ psrNotice: null });
    const lat = clamp(site.lat, -90, 90);
    const lon = normalizeLon(site.lon);
    controllers.alternative?.abort();
    set((s) => ({
      selectedSite: { ...site, lat, lon },
      epochUTC: epochUTC ?? s.epochUTC,
      scrubHour: 0,
      evaluation: null,
      evaluationStatus: 'idle',
      evaluationError: null,
      alternative: null,
      alternativeStatus: 'idle',
      alternativeError: null,
      flyTo: fly ? { kind: 'site', lat, lon, nonce: (s.flyTo?.nonce ?? 0) + 1 } : s.flyTo,
    }));
    if (evaluate) {
      if (evaluateTimer) clearTimeout(evaluateTimer);
      void get().evaluateSite();
    }
    if (psrView) {
      void api.psrCheck({ lat, lon }).then((r) => {
        if (!r.safe) set({ psrNotice: { kind: 'view', clicked: { ...site, lat, lon }, inPsr: r.in_psr, psrDistanceKm: r.psr_distance_km } });
      }).catch(() => undefined);
    } else if (!allowPsr) {
      void guardPsr(get, set, { ...site, lat, lon });
    }
  },

  selectCuratedSite: (id) => {
    const site = CURATED_BY_ID[id];
    if (!site) return;
    get().selectSite(
      { lat: site.lat, lon: site.lon, name: site.name, regionId: site.id },
      { epochUTC: site.epochUTC },
    );
  },

  selectCustomSite: (lat, lon) => get().selectSite({ lat, lon, name: 'Custom site', regionId: null }),

  clearSelection: () => {
    abortAll();
    if (evaluateTimer) clearTimeout(evaluateTimer);
    set((s) => ({
      selectedSite: null,
      evaluation: null,
      evaluationStatus: 'idle',
      evaluationError: null,
      alternative: null,
      alternativeStatus: 'idle',
      scrubHour: 0,
      flyTo: { kind: 'overview', nonce: (s.flyTo?.nonce ?? 0) + 1 },
    }));
  },

  /* ─────────── mission parameters (auto re-evaluate, debounced) ─────────── */

  setEpochUTC: (iso) => {
    const epoch = normalizeEpoch(iso);
    if (!epoch || epoch === get().epochUTC) return;
    set({ epochUTC: epoch, scrubHour: 0 });
    scheduleEvaluate(get);
  },
  setMissionDurationDays: (days) => {
    const d = clamp(Math.round(days), 1, 30);
    if (d === get().missionDurationDays) return;
    set((s) => ({ missionDurationDays: d, scrubHour: Math.min(s.scrubHour, d * 24) }));
    scheduleEvaluate(get);
  },
  setMinEarthElevationDeg: (deg) => {
    const v = clamp(Math.round(deg * 2) / 2, 0, 20);
    if (v === get().minEarthElevationDeg) return;
    set({ minEarthElevationDeg: v });
    scheduleEvaluate(get, 500);
  },
  setActiveLayer: (layer) => set({ activeLayer: layer }),
  setDisplayMode: (mode) => set({ displayMode: mode, learnMode: mode === 'learn', showMore: mode === 'expert' }),
  setLearnMode: (on) => get().setDisplayMode(on ? 'learn' : 'standard'),
  setShowMore: (on) => get().setDisplayMode(on ? 'expert' : 'standard'),
  setExpert: (patch) => set((s) => ({ expert: { ...s.expert, ...patch } })),
  setSlopeStats: (stats) => set({ slopeStats: stats }),
  setCalendarFocus: (focus) => set({ calendarFocus: focus }),
  setPsrNotice: (notice) => set({ psrNotice: notice }),
  setActiveDrawerTab: (tab) => {
    set({ activeDrawerTab: tab, isDrawerOpen: true });
    if (tab === 'CALENDAR') void get().fetchLaunchCalendar();
    if (tab === 'VALIDATION') void get().fetchValidation();
  },
  setDrawerOpen: (open) => set({ isDrawerOpen: open }),
  setScrubHour: (h) => set((s) => ({ scrubHour: clamp(h, 0, s.missionDurationDays * 24) })),
  setSceneStatus: (patch) => set((s) => ({ sceneStatus: { ...s.sceneStatus, ...patch } })),

  hydrateFromUrl: (p) => {
    set((s) => ({
      epochUTC: p.epochUTC ?? s.epochUTC,
      missionDurationDays: p.days !== undefined ? clamp(Math.round(p.days), 1, 30) : s.missionDurationDays,
      minEarthElevationDeg: p.ant !== undefined ? clamp(p.ant, 0, 20) : s.minEarthElevationDeg,
      activeLayer: p.layer ?? s.activeLayer,
      ...(p.mode ? { displayMode: p.mode, learnMode: p.mode === 'learn', showMore: p.mode === 'expert' } : {}),
      expert: p.expert ? { ...s.expert, ...p.expert } : s.expert,
    }));
    if (p.lat !== undefined && p.lon !== undefined) {
      const curated = p.siteId ? CURATED_BY_ID[p.siteId] : undefined;
      const matches = curated && greatCircleDistanceKm(curated.lat, curated.lon, p.lat, p.lon) < 0.05;
      get().selectSite({
        lat: p.lat,
        lon: p.lon,
        name: matches ? curated.name : 'Shared site',
        regionId: matches ? curated.id : null,
      });
    }
  },

  /* ─────────── backend calls ─────────── */

  evaluateSite: async () => {
    const s = get();
    const site = s.selectedSite;
    if (!site) return;
    const ctrl = beginRequest('evaluate');
    set({ evaluationStatus: 'loading', evaluationError: null });
    try {
      const res = await api.evaluateSite(
        {
          lat: site.lat,
          lon: site.lon,
          epoch_utc: s.epochUTC,
          mission_duration_days: s.missionDurationDays,
          min_earth_elevation_deg: s.minEarthElevationDeg,
          site_name: site.name,
          region_id: site.regionId,
          skyline_azimuths: 360,
          trajectory_step_minutes: 30,
        },
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      set((cur) => ({
        evaluation: res,
        evaluationStatus: 'success',
        scrubHour: clamp(cur.scrubHour, 0, cur.missionDurationDays * 24),
      }));
      const after = get();
      if (res.overall_status !== 'GO') void after.fetchNearestAlternative();
      else set({ alternative: null, alternativeStatus: 'idle', alternativeError: null });
      if (after.isDrawerOpen && after.activeDrawerTab === 'CALENDAR') void after.fetchLaunchCalendar();
      if (after.isDrawerOpen && after.activeDrawerTab === 'VALIDATION') void after.fetchValidation();
    } catch (err) {
      if (isAbortError(err)) return;
      set({ evaluationStatus: 'error', evaluationError: errorMessage(err) });
    }
  },

  fetchLaunchCalendar: async (force = false) => {
    const s = get();
    const site = s.selectedSite;
    if (!site) return;
    const epochDate = isoDate(s.epochUTC);
    // Keep the existing 365-day window while the epoch stays inside it, so clicking a cell
    // does not reshuffle the grid under the cursor.
    const prev = s.calendar;
    const prevStart = prev?.start_date;
    const inWindow =
      prevStart !== undefined && epochDate >= prevStart && epochDate < addDaysIso(prevStart, CALENDAR_DAYS);
    const startDate = inWindow && prevStart ? prevStart : `${epochDate.slice(0, 7)}-01`;
    const key = `${siteKey(site)}|${startDate}|${s.missionDurationDays}|${s.minEarthElevationDeg}`;
    if (!force && key === s.calendarKey && (s.calendarStatus === 'success' || s.calendarStatus === 'loading')) return;

    const ctrl = beginRequest('calendar');
    set({ calendarStatus: 'loading', calendarError: null, calendarKey: key });
    try {
      const res = await api.launchCalendar(
        {
          lat: site.lat,
          lon: site.lon,
          start_date: startDate,
          n_days: CALENDAR_DAYS,
          mission_duration_days: s.missionDurationDays,
          min_earth_elevation_deg: s.minEarthElevationDeg,
        },
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      set({ calendar: res, calendarStatus: 'success' });
    } catch (err) {
      if (isAbortError(err)) return;
      set({ calendarStatus: 'error', calendarError: errorMessage(err), calendarKey: null });
    }
  },

  fetchNearestAlternative: async () => {
    const s = get();
    const site = s.selectedSite;
    if (!site) return;
    const ctrl = beginRequest('alternative');
    set({ alternativeStatus: 'loading', alternativeError: null });
    try {
      const res = await api.nearestAlternative(
        {
          lat: site.lat,
          lon: site.lon,
          epoch_utc: s.epochUTC,
          mission_duration_days: s.missionDurationDays,
          min_earth_elevation_deg: s.minEarthElevationDeg,
          search_radius_km: SEARCH_RADIUS_KM,
          date_window_days: DATE_WINDOW_DAYS,
        },
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      set({ alternative: res, alternativeStatus: 'success' });
    } catch (err) {
      if (isAbortError(err)) return;
      set({ alternativeStatus: 'error', alternativeError: errorMessage(err) });
    }
  },

  fetchValidation: async (force = false) => {
    const s = get();
    const site = s.selectedSite;
    if (!site) return;
    const key = `${siteKey(site)}|${s.epochUTC}`;
    if (!force && key === s.validationKey && (s.validationStatus === 'success' || s.validationStatus === 'loading')) return;
    const ctrl = beginRequest('validation');
    set({ validationStatus: 'loading', validationError: null, validationKey: key });
    try {
      const res = await api.validation({ lat: site.lat, lon: site.lon, epoch_utc: s.epochUTC }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      set({ validation: res, validationStatus: 'success' });
    } catch (err) {
      if (isAbortError(err)) return;
      set({ validationStatus: 'error', validationError: errorMessage(err), validationKey: null });
    }
  },

  applyAlternative: (lat, lon, epochUTC) => {
    const prev = get().selectedSite;
    const moved = !prev || greatCircleDistanceKm(prev.lat, prev.lon, lat, lon) > 0.01;
    const epoch = normalizeEpoch(epochUTC) ?? get().epochUTC;
    get().selectSite(
      {
        lat,
        lon,
        name: moved ? `Alt. pad${prev ? ` · ${prev.name.replace(/^Alt\. pad · /, '')}` : ''}` : prev.name,
        regionId: moved ? null : prev.regionId,
      },
      { epochUTC: epoch, fly: moved },
    );
  },
}));
