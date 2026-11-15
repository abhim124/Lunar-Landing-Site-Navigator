import type { EphemerisSample } from '@/types/mission';

/**
 * Surface temperature — a deliberately simple estimate (labelled "est." in the UI).
 *
 * Sunlit ground is treated as a flat surface in instantaneous radiative equilibrium:
 *     T = ((1 − A) · S · sin(e_eff) / (ε · σ))^¼
 * with albedo A = 0.12, solar constant S = 1361 W/m², emissivity ε = 0.95, σ = 5.67e-8 W m⁻² K⁻⁴,
 * and e_eff = the Sun's elevation above the LOCAL TERRAIN horizon (clamped ≥ 0).
 * Ground in shadow is set to ≈ 90 K, or ≈ 40 K inside a permanently shadowed region (PSR).
 * A real mission would use LRO Diviner measurements (the app shows Diviner's measured range alongside).
 */

export const ALBEDO = 0.12;
export const SOLAR_CONSTANT = 1361;
export const EMISSIVITY = 0.95;
export const STEFAN_BOLTZMANN = 5.67e-8;
export const SHADOW_K = 90;
export const PSR_K = 40;

export const kToC = (k: number) => k - 273.15;

/** Equilibrium temperature (K) for a Sun `effElDeg` above the terrain horizon; 0 when it is not above it. */
export function equilibriumTempK(effElDeg: number): number {
  const e = Math.max(0, effElDeg) * (Math.PI / 180);
  return Math.pow(((1 - ALBEDO) * SOLAR_CONSTANT * Math.sin(e)) / (EMISSIVITY * STEFAN_BOLTZMANN), 0.25);
}

/** Temperature of ground the Sun does not reach. */
export const shadowTempK = (inPsr: boolean) => (inPsr ? PSR_K : SHADOW_K);

/** Temperature at one trajectory sample: equilibrium if the Sun is above the terrain horizon, else shadow. */
export function sampleTempK(s: Pick<EphemerisSample, 'sun_el_deg' | 'sun_horizon_el_deg' | 'sun_visible_fraction'>, inPsr: boolean): number {
  const horizon = s.sun_horizon_el_deg ?? 0;
  const eff = s.sun_el_deg - horizon;
  if (s.sun_visible_fraction <= 0 || eff <= 0) return shadowTempK(inPsr);
  return Math.max(shadowTempK(inPsr), equilibriumTempK(eff));
}

export interface TemperatureSummary {
  series: { h: number; k: number }[];
  nowK: number;
  minK: number;
  maxK: number;
}

/** Temperature over the mission (one point per trajectory sample) plus the value at `nowHour`. */
export function temperatureSeries(samples: EphemerisSample[], inPsr: boolean, nowHour: number): TemperatureSummary | null {
  if (!samples.length) return null;
  const series = samples.map((s) => ({ h: s.hours_from_start, k: sampleTempK(s, inPsr) }));
  const now = series.reduce((b, x) => (Math.abs(x.h - nowHour) < Math.abs(b.h - nowHour) ? x : b));
  let minK = Infinity;
  let maxK = -Infinity;
  for (const p of series) {
    minK = Math.min(minK, p.k);
    maxK = Math.max(maxK, p.k);
  }
  return { series, nowK: now.k, minK, maxK };
}

/** A site counts as inside a permanently shadowed region when the PSR-distance map puts it at ~0 km. */
export const isInPsr = (psrKm: number | null | undefined) => psrKm != null && psrKm < 0.12;

const EARTH_COLDEST_C = -89.2; // Vostok Station, Antarctica, 1983
const EARTH_HOTTEST_C = 56.7; // Death Valley, 1913

/** Everyday comparison for Learn mode. */
export function everydayComparison(c: number): string {
  if (c <= -150) return `about twice as cold as the coldest place ever recorded on Earth (${EARTH_COLDEST_C} °C in Antarctica)`;
  if (c <= EARTH_COLDEST_C) return `colder than the coldest place ever recorded on Earth (${EARTH_COLDEST_C} °C in Antarctica)`;
  if (c <= -20) return 'colder than a home freezer';
  if (c <= 30) return 'about the range of temperatures people live in on Earth';
  if (c <= EARTH_HOTTEST_C) return 'like a very hot desert day on Earth';
  if (c <= 100) return `hotter than the hottest place ever recorded on Earth (${EARTH_HOTTEST_C} °C)`;
  return 'hotter than boiling water';
}
