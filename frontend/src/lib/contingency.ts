import type { MissionPhase } from '@/types/assistant';

/** Anomaly classes CAPCOM can recognise in a crew report. The model picks one; the numbers below are ours. */
export const ANOMALY_TYPES = [
  'fuel_leak',
  'engine_fault',
  'landing_gear',
  'hazard_sensor',
  'power_loss',
  'battery_fault',
  'comms_failure',
  'thermal',
  'life_support',
  'other',
] as const;
export type AnomalyType = (typeof ANOMALY_TYPES)[number];

export type ContingencyPriority = 'slope' | 'sunlight' | 'darkness' | 'earth' | 'balanced';

export interface ContingencyPreset {
  label: string;
  /** Why these limits — shown on the assessment card. */
  rationale: string;
  maxDivertKm: number;
  maxSlopeDeg: number;
  minSunlitPct: number;
  maxDarknessHours: number;
  minEarthContactPct: number;
  /** Raised Earth elevation mask (e.g. a degraded antenna needs Earth higher above the horizon). */
  minEarthElevationDeg?: number;
  priority: ContingencyPriority;
}

// Baseline floors are the evaluator's MARGINAL limits (sunlit ≥ 40 %, night ≤ 96 h, Earth ≥ 40 %, slope ≤ 12°),
// so a pad is only rejected for problems the anomaly actually makes worse; the threatened metric is tightened.
const BASE = { maxDivertKm: 10, maxSlopeDeg: 12, minSunlitPct: 40, maxDarknessHours: 96, minEarthContactPct: 40 };

export const CONTINGENCY_PRESETS: Record<AnomalyType, ContingencyPreset> = {
  fuel_leak: {
    ...BASE,
    label: 'Propellant leak',
    rationale: 'Limited propellant: short divert only, no time to hover for hazard avoidance, so the pad must be close and flat.',
    maxDivertKm: 3,
    maxSlopeDeg: 8,
    priority: 'slope',
  },
  engine_fault: {
    ...BASE,
    label: 'Engine / thruster fault',
    rationale: 'Degraded throttle and attitude control: limited divert and a flatter pad for a less precise touchdown.',
    maxDivertKm: 5,
    maxSlopeDeg: 7,
    priority: 'slope',
  },
  landing_gear: {
    ...BASE,
    label: 'Landing gear damage',
    rationale: 'A damaged leg cannot absorb a tilted touchdown: the pad must be nearly level.',
    maxSlopeDeg: 5,
    priority: 'slope',
  },
  hazard_sensor: {
    ...BASE,
    label: 'Hazard-detection sensor failure',
    rationale: 'Without lidar/radar hazard avoidance the crew lands on the map alone, so pick the flattest mapped terrain.',
    maxDivertKm: 8,
    maxSlopeDeg: 6,
    priority: 'slope',
  },
  power_loss: {
    ...BASE,
    label: 'Solar array / power loss',
    rationale: 'Reduced generating capacity: the pad needs near-continuous sunlight and short nights.',
    minSunlitPct: 80,
    maxDarknessHours: 48,
    priority: 'sunlight',
  },
  battery_fault: {
    ...BASE,
    label: 'Battery fault',
    rationale: 'Reduced storage cannot carry the vehicle through a long night: cap the longest darkness.',
    minSunlitPct: 60,
    maxDarknessHours: 24,
    priority: 'darkness',
  },
  comms_failure: {
    ...BASE,
    label: 'Communications degraded',
    rationale: 'A degraded antenna needs Earth higher above the horizon and in view almost all the time.',
    minEarthContactPct: 85,
    minEarthElevationDeg: 8,
    priority: 'earth',
  },
  thermal: {
    ...BASE,
    label: 'Thermal control fault',
    rationale: 'Heaters and radiators are compromised: avoid long cold nights.',
    minSunlitPct: 60,
    maxDarknessHours: 24,
    priority: 'darkness',
  },
  life_support: {
    ...BASE,
    label: 'Life support / medical',
    rationale: 'Crew health issue: keep continuous contact with flight surgeons and avoid long nights.',
    minEarthContactPct: 85,
    maxDarknessHours: 48,
    priority: 'earth',
  },
  other: {
    ...BASE,
    label: 'Unclassified anomaly',
    rationale: 'Unknown impact: require GO-level sunlight, Earth contact and slope.',
    maxSlopeDeg: 10,
    minSunlitPct: 70,
    maxDarknessHours: 48,
    minEarthContactPct: 70,
    priority: 'balanced',
  },
};

export interface ContingencyCheck {
  key: 'slope' | 'sunlit' | 'darkness' | 'earth';
  label: string;
  value: number;
  limit: number;
  unit: string;
  kind: 'min' | 'max';
  ok: boolean;
}

export interface ContingencyPad {
  lat: number;
  lon: number;
  slope_deg: number;
  sunlit_pct: number;
  earth_contact_pct: number;
  longest_darkness_hours: number;
  status: 'GO' | 'MARGINAL' | 'NO-GO';
  checks: ContingencyCheck[];
  meets_all: boolean;
  distance_km?: number;
  bearing_deg?: number;
}

export interface ContingencyResponse {
  anomaly: string;
  viable: boolean;
  failed: string[];
  baseline: ContingencyPad;
  relocation: ContingencyPad | null;
  relocation_meets_all: boolean;
  candidates_evaluated: number;
  search_radius_km: number;
  note: string;
  computed_in_ms: number;
}

export interface ContingencyRequest {
  lat: number;
  lon: number;
  epoch_utc: string;
  mission_duration_days: number;
  min_earth_elevation_deg: number;
  anomaly: string;
  max_divert_km: number;
  max_slope_deg: number;
  min_sunlit_pct: number;
  max_darkness_hours: number;
  min_earth_contact_pct: number;
  priority: ContingencyPriority;
  allow_relocation: boolean;
}

export function buildContingencyRequest(
  type: AnomalyType,
  phase: MissionPhase,
  site: { lat: number; lon: number },
  epochUTC: string,
  missionDays: number,
  minEarthElevationDeg: number,
): ContingencyRequest {
  const p = CONTINGENCY_PRESETS[type];
  return {
    lat: site.lat,
    lon: site.lon,
    epoch_utc: epochUTC,
    mission_duration_days: missionDays,
    min_earth_elevation_deg: Math.max(minEarthElevationDeg, p.minEarthElevationDeg ?? 0),
    anomaly: type,
    // During descent the vehicle has already committed most of its propellant: halve the divert budget.
    max_divert_km: phase === 'descent' ? Math.max(1, p.maxDivertKm / 2) : p.maxDivertKm,
    max_slope_deg: p.maxSlopeDeg,
    min_sunlit_pct: p.minSunlitPct,
    max_darkness_hours: p.maxDarknessHours,
    min_earth_contact_pct: p.minEarthContactPct,
    priority: p.priority,
    // Once landed, the lander cannot move: assess only.
    allow_relocation: phase !== 'surface',
  };
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const compassWord = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

const fmt = (c: ContingencyCheck) => `${c.label.toLowerCase()} ${Math.round(c.value * 10) / 10}${c.unit} (limit ${c.kind === 'max' ? '≤' : '≥'} ${c.limit}${c.unit})`;

/** One or two spoken sentences describing the outcome, built from the backend numbers (not the model). */
export function contingencySpeech(type: AnomalyType, r: ContingencyResponse, phase: MissionPhase): string {
  const label = CONTINGENCY_PRESETS[type].label.toLowerCase();
  if (r.viable) return `Current pad remains viable with the ${label}. All constraints met.`;
  const failed = r.baseline.checks.filter((c) => !c.ok);
  const why = failed.slice(0, 2).map(fmt).join(' and ');
  if (phase === 'surface') return `Current pad no longer meets the ${label} limits: ${why}. The lander is down, so we cannot relocate.`;
  const rl = r.relocation;
  if (!rl) return `Current pad is not viable with the ${label}: ${why}. No reachable pad within ${r.search_radius_km} kilometres does better. Hold and await instructions.`;
  const dist = `${(rl.distance_km ?? 0).toFixed(1)} kilometres ${compassWord(rl.bearing_deg ?? 0)}`;
  return `Current pad is not viable with the ${label}: ${why}. Relocating ${dist} to a ${rl.slope_deg.toFixed(1)} degree pad${
    rl.meets_all ? ' that meets all limits' : ', the best reachable option'
  }.`;
}
