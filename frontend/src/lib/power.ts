import type { EphemerisSample } from '@/types/mission';
import type { ExpertSettings } from './displayMode';
import { SOLAR_CONSTANT } from './temperature';

/**
 * Solar panel output — a simple engineering estimate (labelled "est." in the UI).
 *
 *     P = S · A_panel · η · cos(incidence) · f_visible
 *
 * S = 1361 W/m² (no atmosphere), A_panel and η are editable. For a vertical panel the incidence
 * angle depends on where the Sun is:
 *   • vertical, Sun-tracking:          cos(incidence) = cos(elevation)
 *   • vertical, fixed facing azimuth φ: cos(incidence) = cos(elevation) · max(0, cos(azimuth − φ))
 * f_visible is the fraction of the solar disk above the terrain horizon. The app uses the backend's
 * exact disk-overlap value (`sun_visible_fraction`); `diskVisibleFractionLinear` is the simpler
 * linear approximation, kept for reference and offline use.
 */

const D2R = Math.PI / 180;
export const SUN_DIAMETER_DEG = 0.53;

/** Linear approximation of the visible solar-disk fraction: 0 when the top limb is below the horizon, 1 when the bottom limb clears it. */
export function diskVisibleFractionLinear(sunElDeg: number, horizonElDeg: number): number {
  const r = SUN_DIAMETER_DEG / 2;
  return Math.min(1, Math.max(0, (sunElDeg - horizonElDeg + r) / (2 * r)));
}

/** cos(incidence) for the panel orientation. */
export function cosIncidence(sunElDeg: number, sunAzDeg: number, p: Pick<ExpertSettings, 'orientation' | 'facingAzDeg'>): number {
  const ce = Math.cos(Math.max(0, sunElDeg) * D2R);
  if (p.orientation === 'tracking') return ce;
  return ce * Math.max(0, Math.cos((sunAzDeg - p.facingAzDeg) * D2R));
}

/** Panel output (W) at one trajectory sample. */
export function panelPowerW(
  s: Pick<EphemerisSample, 'sun_el_deg' | 'sun_az_deg' | 'sun_visible_fraction'>,
  p: Pick<ExpertSettings, 'panelAreaM2' | 'panelEff' | 'orientation' | 'facingAzDeg'>,
): number {
  if (s.sun_visible_fraction <= 0) return 0;
  return SOLAR_CONSTANT * p.panelAreaM2 * p.panelEff * cosIncidence(s.sun_el_deg, s.sun_az_deg, p) * s.sun_visible_fraction;
}

export interface PowerStats {
  avgW: number;
  peakW: number;
  energyKWh: number;
  /** Longest stretch with (effectively) zero output, hours. */
  longestZeroH: number;
  /** Battery needed to carry `loadW` through that stretch, Wh. */
  batteryWh: number;
}

/** Summary of a power series sampled every `stepH` hours. Zero power = below 0.5 % of peak (or exactly 0). */
export function powerStats(series: { h: number; w: number }[], stepH: number, loadW: number): PowerStats {
  if (!series.length) return { avgW: 0, peakW: 0, energyKWh: 0, longestZeroH: 0, batteryWh: 0 };
  let sum = 0;
  let peak = 0;
  for (const p of series) {
    sum += p.w;
    peak = Math.max(peak, p.w);
  }
  const floor = Math.max(1e-6, peak * 0.005);
  let run = 0;
  let longest = 0;
  for (const p of series) {
    run = p.w <= floor ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const longestZeroH = longest * stepH;
  return {
    avgW: sum / series.length,
    peakW: peak,
    energyKWh: (sum * stepH) / 1000,
    longestZeroH,
    batteryWh: loadW * longestZeroH,
  };
}

/** Power series over the mission for the given panel settings. */
export function powerSeries(samples: EphemerisSample[], p: ExpertSettings): { h: number; w: number }[] {
  return samples.map((s) => ({ h: s.hours_from_start, w: panelPowerW(s, p) }));
}

/** Trajectory step in hours (falls back to 0.5 h). */
export function sampleStepH(samples: EphemerisSample[]): number {
  return samples.length > 1 ? samples[1].hours_from_start - samples[0].hours_from_start : 0.5;
}
