/**
 * South Polar terrain height field shared by the polar-cap mesh, site pins, landing beacon and search ring.
 *
 * Source: FastAPI `/api/terrain/polar-heightmap.png`, rendered from LOLA `ldem_75s_240m.img`.
 * Encoding ("rg16"), chosen because browsers down-convert 16-bit PNG channels to 8 bits on decode:
 *   elevation_m = (R · 256 + G) · scale_m + offset_m        (A = 0 → nodata)
 * Grid geometry comes from `/api/terrain/polar-heightmap.json`
 *   col = (x − x_min_m) / pixel_size_m − 0.5,  row = (y_max_m − y) / pixel_size_m − 0.5
 * in the same South Polar Stereographic (x, y) used by geo.ts.
 *
 * If the backend is unreachable, a deterministic analytic model of the real south-polar
 * landforms (Shackleton, de Gerlache, Shoemaker, Haworth, Malapert, Mons Mouton, the
 * connecting ridge …) is used instead and every consumer is told it is SYNTHETIC.
 */

import { useSyncExternalStore } from 'react';
import type { DataSourceTag } from '@/types/mission';
import { TERRAIN_ENDPOINTS } from './api';
import { MOON_RADIUS_M, smoothstep, stereoForward } from './geo';
import { fetchWithTimeout } from './image';

export const VERTICAL_EXAGGERATION = 8;
/** Polar cap mesh spans 75°S → 90°S (the ldem_75s_240m footprint). */
export const CAP_EDGE_LAT_DEG = -75;
/** Displacement fades to zero over this band so the cap welds onto the undisplaced globe. */
export const CAP_TAPER_DEG = 1.5;
/** Globe sphere stops slightly south of the cap edge; the overlap band is resolved by polygon offset. */
export const GLOBE_SOUTH_LIMIT_DEG = -75.25;

export interface HeightmapMeta {
  width: number;
  height: number;
  pixel_size_m: number;
  x_min_m: number;
  y_max_m: number;
  encoding: 'rg16';
  scale_m: number;
  offset_m: number;
  source: DataSourceTag;
}

export type TerrainMode = 'loading' | 'lola' | 'synthetic';

interface TerrainSnapshot {
  mode: TerrainMode;
  version: number;
  meta: HeightmapMeta | null;
}

type ElevationSampler = (xM: number, yM: number) => number | null;

/* ─────────────── Analytic south-polar fallback model ─────────────── */

interface Crater { x: number; y: number; radius: number; depth: number; rim: number }
interface Massif { x: number; y: number; height: number; sMajor: number; sMinor: number; cosT: number; sinT: number }
interface Ridge { ax: number; ay: number; bx: number; by: number; height: number; width: number }

function crater(lat: number, lon: number, diameterKm: number, depthM: number, rimM: number): Crater {
  const { x, y } = stereoForward(lat, lon);
  return { x, y, radius: (diameterKm * 1000) / 2, depth: depthM, rim: rimM };
}
function massif(lat: number, lon: number, heightM: number, sMajorKm: number, sMinorKm: number, orientDeg: number): Massif {
  const { x, y } = stereoForward(lat, lon);
  const t = (orientDeg * Math.PI) / 180;
  return { x, y, height: heightM, sMajor: sMajorKm * 1000, sMinor: sMinorKm * 1000, cosT: Math.cos(t), sinT: Math.sin(t) };
}
function ridge(lat1: number, lon1: number, lat2: number, lon2: number, heightM: number, widthKm: number): Ridge {
  const a = stereoForward(lat1, lon1);
  const b = stereoForward(lat2, lon2);
  return { ax: a.x, ay: a.y, bx: b.x, by: b.y, height: heightM, width: widthKm * 1000 };
}

const CRATERS: Crater[] = [
  crater(-89.67, 129.78, 21.0, 4100, 900), // Shackleton
  crater(-88.5, -87.1, 32.8, 2900, 700), // de Gerlache
  crater(-88.1, 44.9, 51.0, 3300, 800), // Shoemaker
  crater(-87.45, -5.16, 51.0, 3400, 900), // Haworth
  crater(-87.3, 77.0, 39.0, 2800, 700), // Faustini
  crater(-88.5, -152.0, 33.0, 2500, 600), // Sverdrup
  crater(-88.1, 110.5, 22.0, 2000, 500), // Slater
  crater(-85.2, 53.5, 73.0, 3200, 900), // Nobile
  crater(-84.5, 82.8, 103.0, 4200, 1100), // Amundsen
  crater(-85.3, -42.1, 98.0, 3800, 1000), // Cabeus
];
const MASSIFS: Massif[] = [
  massif(-85.99, -2.9, 4800, 17, 11, 30), // Malapert Massif
  massif(-84.6, 31.4, 5200, 24, 15, 70), // Mons Mouton
  massif(-85.81, -111.2, 2600, 14, 9, 0), // de Gerlache–Kocher massif
  massif(-88.79, 123.64, 1300, 5, 5, 0), // Peak near Shackleton
];
const RIDGES: Ridge[] = [
  ridge(-89.45, -137.3, -88.75, -78.0, 1400, 4.5), // Shackleton–de Gerlache connecting ridge
];

function craterHeight(c: Crater, x: number, y: number): number {
  const s = Math.hypot(x - c.x, y - c.y) / c.radius;
  if (s > 3) return 0;
  if (s < 1) return -c.depth * (1 - s * s) + c.rim * s ** 4; // parabolic bowl rising to the rim crest
  return c.rim * Math.exp(-(((s - 1) / 0.45) ** 2)); // ejecta blanket decay
}

function massifHeight(m: Massif, x: number, y: number): number {
  const dx = x - m.x;
  const dy = y - m.y;
  const u = dx * m.cosT + dy * m.sinT;
  const v = -dx * m.sinT + dy * m.cosT;
  return m.height * Math.exp(-0.5 * ((u / m.sMajor) ** 2 + (v / m.sMinor) ** 2));
}

function ridgeHeight(r: Ridge, x: number, y: number): number {
  const vx = r.bx - r.ax;
  const vy = r.by - r.ay;
  const t = Math.max(0, Math.min(1, ((x - r.ax) * vx + (y - r.ay) * vy) / (vx * vx + vy * vy)));
  const d = Math.hypot(x - (r.ax + t * vx), y - (r.ay + t * vy));
  return r.height * Math.exp(-((d / r.width) ** 2));
}

/** Deterministic analytic DEM (metres relative to the 1737.4 km sphere). */
export function syntheticSouthPoleElevation(x: number, y: number): number {
  // Relief comes only from named landforms: periodic noise terms would form a visible lattice
  // once vertically exaggerated, which reads as a rendering artefact rather than terrain.
  let h = 0;
  for (const c of CRATERS) h += craterHeight(c, x, y);
  for (const m of MASSIFS) h += massifHeight(m, x, y);
  for (const r of RIDGES) h += ridgeHeight(r, x, y);
  return h;
}

/* ─────────────── Raster sampler (LOLA heightmap) ─────────────── */

function makeRasterSampler(field: Float32Array, w: number, h: number, meta: HeightmapMeta): ElevationSampler {
  const px = meta.pixel_size_m;
  return (x, y) => {
    const c = (x - meta.x_min_m) / px - 0.5;
    const r = (meta.y_max_m - y) / px - 0.5;
    if (c < 0 || r < 0 || c > w - 1 || r > h - 1) return null;
    const c0 = Math.floor(c);
    const r0 = Math.floor(r);
    const c1 = Math.min(c0 + 1, w - 1);
    const r1 = Math.min(r0 + 1, h - 1);
    const fc = c - c0;
    const fr = r - r0;
    const v00 = field[r0 * w + c0];
    const v01 = field[r0 * w + c1];
    const v10 = field[r1 * w + c0];
    const v11 = field[r1 * w + c1];
    if (Number.isNaN(v00) || Number.isNaN(v01) || Number.isNaN(v10) || Number.isNaN(v11)) {
      const valid = [v00, v01, v10, v11].filter((v) => !Number.isNaN(v));
      return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
    }
    return (v00 * (1 - fc) + v01 * fc) * (1 - fr) + (v10 * (1 - fc) + v11 * fc) * fr;
  };
}

function decodeRg16(data: Uint8ClampedArray, meta: HeightmapMeta): Float32Array {
  const n = data.length / 4;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = data[o + 3] === 0 ? Number.NaN : (data[o] * 256 + data[o + 1]) * meta.scale_m + meta.offset_m;
  }
  return out;
}

/* ─────────────── Shared state + React binding ─────────────── */

let sampler: ElevationSampler = syntheticSouthPoleElevation;
let snapshot: TerrainSnapshot = { mode: 'loading', version: 0, meta: null };
const listeners = new Set<() => void>();

function publish(next: Partial<TerrainSnapshot>) {
  snapshot = { ...snapshot, ...next, version: snapshot.version + 1 };
  listeners.forEach((l) => l());
}

export function subscribeTerrain(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const getTerrainSnapshot = () => snapshot;

export function useTerrainSnapshot(): TerrainSnapshot {
  return useSyncExternalStore(subscribeTerrain, getTerrainSnapshot, getTerrainSnapshot);
}

export const useTerrainVersion = () => useTerrainSnapshot().version;

/** Elevation (m, relative to the 1737.4 km sphere). 0 outside the 75°S cap. */
export function elevationAtLatLon(lat: number, lon: number): number {
  if (lat > CAP_EDGE_LAT_DEG) return 0;
  const { x, y } = stereoForward(lat, lon);
  return sampler(x, y) ?? 0;
}

/**
 * Box-prefiltered elevation at stereographic (x, y): 5-tap average over a footprint matching the
 * mesh vertex spacing, so 240 m LOLA detail does not alias into moiré on a ~2 km cap mesh.
 */
export function filteredElevationAtStereo(x: number, y: number, footprintM: number): number {
  const h = footprintM / 2;
  const s = (dx: number, dy: number) => sampler(x + dx, y + dy) ?? 0;
  return (2 * s(0, 0) + s(h, 0) + s(-h, 0) + s(0, h) + s(0, -h)) / 6;
}

/** Exaggerated scene radius for a given elevation (m) at latitude lat. */
export const radiusForElevation = (elevationM: number, lat: number) =>
  1 + (elevationM * capTaper(lat) * VERTICAL_EXAGGERATION) / MOON_RADIUS_M;

/** 1 deep inside the cap, smoothly → 0 at its 75°S edge. */
export const capTaper = (lat: number) => 1 - smoothstep(CAP_EDGE_LAT_DEG - CAP_TAPER_DEG, CAP_EDGE_LAT_DEG, lat);

/** Scene-space radius of the displayed (exaggerated) surface. */
export function surfaceRadius(lat: number, lon: number, liftUnits = 0): number {
  return 1 + (elevationAtLatLon(lat, lon) * capTaper(lat) * VERTICAL_EXAGGERATION) / MOON_RADIUS_M + liftUnits;
}

let loadPromise: Promise<TerrainMode> | null = null;

/** Idempotent: StrictMode double-mounts share one download. */
export function loadPolarHeightmap(): Promise<TerrainMode> {
  if (loadPromise) return loadPromise;
  loadPromise = (async (): Promise<TerrainMode> => {
    try {
      const metaRes = await fetchWithTimeout(TERRAIN_ENDPOINTS.heightmapMeta, 8_000);
      if (!metaRes.ok) throw new Error(`heightmap meta HTTP ${metaRes.status}`);
      const meta = (await metaRes.json()) as HeightmapMeta;
      if (meta.encoding !== 'rg16' || !(meta.pixel_size_m > 0)) throw new Error('unsupported heightmap encoding');

      const pngRes = await fetchWithTimeout(TERRAIN_ENDPOINTS.heightmapPng, 30_000);
      if (!pngRes.ok) throw new Error(`heightmap PNG HTTP ${pngRes.status}`);
      const type = pngRes.headers.get('Content-Type') ?? '';
      if (type.includes('text/html')) throw new Error('heightmap endpoint returned HTML');
      // colorSpaceConversion/premultiplyAlpha 'none' keeps the packed RG bytes bit-exact.
      const bitmap = await createImageBitmap(await pngRes.blob(), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('2D canvas unavailable');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const field = decodeRg16(data, meta);
      sampler = makeRasterSampler(field, canvas.width, canvas.height, meta);
      const mode: TerrainMode = meta.source?.is_synthetic_fallback ? 'synthetic' : 'lola';
      publish({ mode, meta });
      return mode;
    } catch (err) {
      console.warn('[terrain] LOLA heightmap unavailable, using analytic south-pole model:', err);
      sampler = syntheticSouthPoleElevation;
      publish({ mode: 'synthetic', meta: null });
      return 'synthetic';
    }
  })();
  return loadPromise;
}
