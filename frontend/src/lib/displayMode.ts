/** Three audiences, one app: the public (standard), students (learn) and mission planners (expert). */
export const DISPLAY_MODES = ['standard', 'learn', 'expert'] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

export const MODE_LABEL: Record<DisplayMode, string> = { standard: 'Standard', learn: 'Learn', expert: 'Expert' };

/** `mode=standard|learn|expert`; legacy `learn=1` links still open Learn mode. */
export function parseMode(p: URLSearchParams): DisplayMode | undefined {
  const m = p.get('mode');
  if (m && (DISPLAY_MODES as readonly string[]).includes(m)) return m as DisplayMode;
  if (p.get('learn') === '1') return 'learn';
  return undefined;
}

/** Engineering assumptions editable in Expert mode (kept in the store and the share URL). */
export interface ExpertSettings {
  /** Solar panel area, m². */
  panelAreaM2: number;
  /** Panel conversion efficiency, 0–1. */
  panelEff: number;
  /** "tracking": vertical panel that turns to face the Sun; "fixed": vertical panel facing `facingAzDeg`. */
  orientation: 'tracking' | 'fixed';
  facingAzDeg: number;
  /** Constant electrical load the battery must carry through the longest zero-power gap, W. */
  loadW: number;
  /** Configurable maximum safe landing slope, °. */
  maxSafeSlopeDeg: number;
  /** Radius for the slope / roughness statistics, m. */
  slopeRadiusM: number;
  benchmark: 'none' | 'toronto' | 'phoenix' | 'southpole';
  showTemperature: boolean;
}

export const DEFAULT_EXPERT: ExpertSettings = {
  panelAreaM2: 10,
  panelEff: 0.3,
  orientation: 'tracking',
  facingAzDeg: 0,
  loadW: 200,
  maxSafeSlopeDeg: 8,
  slopeRadiusM: 100,
  benchmark: 'none',
  showTemperature: true,
};

const clampNum = (v: string | null, lo: number, hi: number): number | undefined => {
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};

/** Expert settings from the URL (only keys that are present). */
export function parseExpert(p: URLSearchParams): Partial<ExpertSettings> {
  const out: Partial<ExpertSettings> = {};
  const pa = clampNum(p.get('pa'), 0.1, 1000);
  if (pa !== undefined) out.panelAreaM2 = pa;
  const eff = clampNum(p.get('eff'), 0.01, 1);
  if (eff !== undefined) out.panelEff = eff;
  const ori = p.get('ori');
  if (ori === 'tracking' || ori === 'fixed') out.orientation = ori;
  const paz = clampNum(p.get('paz'), 0, 360);
  if (paz !== undefined) out.facingAzDeg = paz;
  const load = clampNum(p.get('load'), 0, 100000);
  if (load !== undefined) out.loadW = load;
  const smax = clampNum(p.get('smax'), 1, 45);
  if (smax !== undefined) out.maxSafeSlopeDeg = smax;
  const srad = clampNum(p.get('srad'), 10, 2000);
  if (srad !== undefined) out.slopeRadiusM = srad;
  const bench = p.get('bench');
  if (bench === 'none' || bench === 'toronto' || bench === 'phoenix' || bench === 'southpole') out.benchmark = bench;
  return out;
}

/** Write only the Expert settings that differ from the defaults, so ordinary links stay short. */
export function writeExpert(p: URLSearchParams, e: ExpertSettings): void {
  const keys: [keyof ExpertSettings, string][] = [
    ['panelAreaM2', 'pa'],
    ['panelEff', 'eff'],
    ['orientation', 'ori'],
    ['facingAzDeg', 'paz'],
    ['loadW', 'load'],
    ['maxSafeSlopeDeg', 'smax'],
    ['slopeRadiusM', 'srad'],
    ['benchmark', 'bench'],
  ];
  for (const [k, q] of keys) if (e[k] !== DEFAULT_EXPERT[k]) p.set(q, String(e[k]));
}
