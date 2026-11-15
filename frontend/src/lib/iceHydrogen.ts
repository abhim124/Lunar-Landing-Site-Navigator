import data from '@/data/iceHydrogen.json';
import { greatCircleDistanceKm } from './geo';
import { CURATED_BY_ID } from './siteRegistry';

/**
 * Hydrogen / water-ice for the Expert ice card. The hydrogen numbers are ILLUSTRATIVE (see
 * data/iceHydrogen.json): the repo has no neutron-spectrometer data. Distance to the nearest
 * permanently shadowed region comes from the real PGDA PSR map via the backend.
 *
 * Arbitrary points use inverse-distance weighting (power 2) of the curated-site values, blended
 * toward a latitude baseline far from any curated site:
 *     baseline(lat) = 0.02 + 0.5 · max(0, (|lat| − 70) / 20)²   wt%
 */

export const ICE_SOURCES =
  'Illustrative values. A real mission would use Lunar Prospector and LRO LEND neutron spectrometers (hydrogen), LRO LAMP (surface frost) and Chandrayaan-1 M3 (water-ice spectra).';

const POINTS = data.sites
  .map((s) => ({ ...s, site: CURATED_BY_ID[s.id] }))
  .filter((s) => s.site)
  .map((s) => ({ lat: s.site.lat, lon: s.site.lon, weh: s.weh_wt_pct }));

export const baselineWeh = (lat: number) => 0.02 + 0.5 * Math.pow(Math.max(0, (Math.abs(lat) - 70) / 20), 2);

/** Water-equivalent hydrogen (wt%) at a point (illustrative). */
export function wehAt(lat: number, lon: number): number {
  let num = 0;
  let den = 0;
  let nearest = Infinity;
  for (const p of POINTS) {
    const d = greatCircleDistanceKm(lat, lon, p.lat, p.lon);
    if (d < 0.5) return p.weh;
    nearest = Math.min(nearest, d);
    const w = 1 / (d * d);
    num += w * p.weh;
    den += w;
  }
  const idw = den > 0 ? num / den : baselineWeh(lat);
  // Trust the curated sites within ~50 km; fade to the latitude baseline by ~200 km.
  const t = Math.min(1, Math.max(0, (nearest - 50) / 150));
  return idw * (1 - t) + baselineWeh(lat) * t;
}

export type IceLikelihood = 'Low' | 'Moderate' | 'High';

/** Qualitative ice likelihood from hydrogen (illustrative) and distance to a PSR cold trap (real). */
export function iceLikelihood(wehPct: number, psrKm: number | null): IceLikelihood {
  const near = psrKm != null && psrKm <= 2;
  const close = psrKm != null && psrKm <= 5;
  if (wehPct >= 0.3 && near) return 'High';
  if (wehPct >= 0.15 || close) return 'Moderate';
  return 'Low';
}
