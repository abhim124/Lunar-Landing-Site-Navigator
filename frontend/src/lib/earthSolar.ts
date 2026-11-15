import benchmarks from '@/data/earthBenchmarks.json';
import type { ExpertSettings } from './displayMode';

/**
 * Earth benchmark for the Expert power chart.
 *
 * Sun position: NOAA's low-precision solar position algorithm (equation of time + declination,
 * accurate to a few tenths of a degree), good enough for a day/night and power comparison.
 * Panel power on Earth: a clear-sky model, irradiance ≈ 1000 W/m² × sin(elevation) on a horizontal
 * panel, times the same panel area and efficiency as the lunar setup. No clouds, no weather.
 * Temperatures are typical monthly means (climate normals), labelled "typical" in the UI.
 */

export type BenchmarkId = Exclude<ExpertSettings['benchmark'], 'none'>;

export interface EarthBenchmark {
  id: BenchmarkId;
  name: string;
  lat: number;
  lon: number;
  /** Typical monthly mean air temperature, °C (Jan … Dec). */
  monthlyMeanC: number[];
  source: string;
}

export const EARTH_BENCHMARKS = benchmarks as EarthBenchmark[];
export const benchmarkById = (id: BenchmarkId) => EARTH_BENCHMARKS.find((b) => b.id === id)!;

const D2R = Math.PI / 180;

/** Solar elevation (°) at a place on Earth at a UTC instant (NOAA approximation). */
export function sunElevationDeg(latDeg: number, lonDeg: number, date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000);
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const g = ((2 * Math.PI) / 365) * (dayOfYear + (hour - 12) / 24); // fractional year, rad
  const eqTime =
    229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const trueSolarMin = hour * 60 + eqTime + 4 * lonDeg;
  const ha = (trueSolarMin / 4 - 180) * D2R;
  const lat = latDeg * D2R;
  const cosZen = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  return 90 - Math.acos(Math.min(1, Math.max(-1, cosZen))) / D2R;
}

/** Clear-sky panel output on Earth (W). */
export function earthPanelPowerW(sunElDeg: number, p: Pick<ExpertSettings, 'panelAreaM2' | 'panelEff'>): number {
  return Math.max(0, 1000 * Math.sin(sunElDeg * D2R)) * p.panelAreaM2 * p.panelEff;
}

export interface BenchmarkPoint {
  h: number;
  elDeg: number;
  w: number;
  tempC: number;
}

/** Benchmark series on the same hourly offsets as the lunar trajectory. */
export function benchmarkSeries(b: EarthBenchmark, epochUTC: string, hours: number[], p: Pick<ExpertSettings, 'panelAreaM2' | 'panelEff'>): BenchmarkPoint[] {
  const t0 = Date.parse(epochUTC);
  return hours.map((h) => {
    const d = new Date(t0 + h * 3_600_000);
    const el = sunElevationDeg(b.lat, b.lon, d);
    return { h, elDeg: el, w: earthPanelPowerW(el, p), tempC: b.monthlyMeanC[d.getUTCMonth()] };
  });
}
