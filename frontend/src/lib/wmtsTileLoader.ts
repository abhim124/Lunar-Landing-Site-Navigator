/**
 * South-polar overlay loader (Moon Trek OGC WMTS compositor + backend-rendered NASA rasters)
 * and the NASA SVS CGI Moon Kit base-texture loader.
 *
 * Browser rules this module enforces:
 *  • Never hands a .tif or WMTSCapabilities.xml to THREE — only JPEG/PNG rasters.
 *  • Every image is requested with crossOrigin='anonymous'. If trek.nasa.gov blocks CORS or is
 *    offline, tiles are re-requested through the FastAPI Tier-1 disk-cache proxy so the stitched
 *    canvas is never tainted (a tainted canvas throws on WebGL upload).
 *
 * Moon Trek SP tile matrix set `default028mm` (read from the layer's WMTSCapabilities.xml):
 *    TopLeftCorner = (−1 095 930, +1 095 930) m, tile = 256 px,
 *    z0 pixel = 3.0578404e7 × 0.28 mm = 8 561.95 m → one tile spans 2 191 860 m.
 *    Tile size at zoom z = 2 191 860 / 2^z m; row 0 is the +y (0° lon) edge.
 * Every overlay resolves to a texture + its stereographic bounds [xmin, ymin, xmax, ymax], which the
 * shader maps with uv = (x − xmin, y − ymin) / (xmax − xmin, ymax − ymin): conformal, no polar pinching.
 */

import * as THREE from 'three';
import type { OverlayLayerId } from '@/types/mission';
import { overlayUrls, tileProxyUrl } from './api';
import { fetchWithTimeout, loadImage, runPool } from './image';

export const TREK_SP_TILE_TEMPLATE =
  'https://trek.nasa.gov/tiles/Moon/SP/{LayerName}/1.0.0/default/default028mm/{TileMatrix}/{TileRow}/{TileCol}.png';
export const TREK_SP_TOP_LEFT_M = 1_095_930;
export const TREK_SP_Z0_TILE_M = 2 * TREK_SP_TOP_LEFT_M;

export const SVS_CGI_MOON_KIT_COLOR_2K = 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg';
export const LOCAL_CGI_MOON_KIT_COLOR_2K = '/textures/lroc_color_2k.jpg';

const TILE_PX = 256;

export type Bounds = [number, number, number, number]; // xmin, ymin, xmax, ymax (m, South Polar Stereographic)

interface BaseLayer {
  id: OverlayLayerId;
  label: string;
  legend: string;
  opacity: number;
  /** Self-illumination so data layers stay legible inside shadowed craters. */
  emissive: number;
}
interface TrekLayer extends BaseLayer {
  kind: 'trek';
  tileMatrix: number;
  /** Layer footprint from its WMTSCapabilities.xml (ows:BoundingBox). */
  bboxM: Bounds;
}
interface BackendLayer extends BaseLayer {
  kind: 'backend';
  overlay: string;
}
export type OverlayLayerConfig = TrekLayer | BackendLayer;

export const OVERLAY_LAYERS: Record<OverlayLayerId, OverlayLayerConfig> = {
  WAC_POLE_ILL_PCT_SOUTH_100M: {
    id: 'WAC_POLE_ILL_PCT_SOUTH_100M',
    kind: 'trek',
    label: 'Moon Trek: WAC illumination % (100 m)',
    legend: 'Percent of time sunlit, LROC WAC multi-temporal mosaic (±61 km of the pole)',
    tileMatrix: 5, // deepest TileMatrix in this layer's WMTSCapabilities.xml
    bboxM: [-60_884.204, -61_186.798, 61_115.796, 61_213.202],
    opacity: 0.9,
    emissive: 0.55,
  },
  LOLA_COLOR_RELIEF: {
    id: 'LOLA_COLOR_RELIEF',
    kind: 'backend',
    overlay: 'lola_relief',
    label: 'LOLA colour-shaded relief',
    legend: 'LDEM_75S_240M elevation, hill-shaded',
    opacity: 0.85,
    emissive: 0.35,
  },
  PGDA_SUN_VISIBILITY: {
    id: 'PGDA_SUN_VISIBILITY',
    kind: 'backend',
    overlay: 'pgda_sun_vis',
    label: 'PGDA avg. Sun visibility + PSRs',
    legend: '18.6-yr average solar visibility; blue = permanently shadowed',
    opacity: 0.9,
    emissive: 0.5,
  },
  PGDA_EARTH_VISIBILITY: {
    id: 'PGDA_EARTH_VISIBILITY',
    kind: 'backend',
    overlay: 'pgda_earth_vis',
    label: 'PGDA avg. Earth visibility',
    legend: '18.6-yr average fraction of time Earth is above the local horizon',
    opacity: 0.9,
    emissive: 0.5,
  },
};

export function buildTrekTileUrl(layer: string, z: number, row: number, col: number): string {
  return TREK_SP_TILE_TEMPLATE.replace('{LayerName}', layer)
    .replace('{TileMatrix}', String(z))
    .replace('{TileRow}', String(row))
    .replace('{TileCol}', String(col));
}

export interface OverlayTexture {
  layer: OverlayLayerId;
  texture: THREE.Texture;
  boundsM: Bounds;
  detail: string;
}

const overlayCache = new Map<OverlayLayerId, OverlayTexture>();
/** Once a direct trek.nasa.gov request fails (CORS/offline) we go straight to the proxy. */
let directTrekBlocked = false;

async function loadTrekTile(layer: string, z: number, row: number, col: number, signal?: AbortSignal) {
  if (!directTrekBlocked) {
    try {
      return { image: await loadImage(buildTrekTileUrl(layer, z, row, col), signal, 10_000), viaProxy: false };
    } catch (err) {
      if (signal?.aborted) throw err;
      directTrekBlocked = true;
    }
  }
  try {
    return { image: await loadImage(tileProxyUrl('SP', layer, z, row, col), signal, 15_000), viaProxy: true };
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

function finishTexture(source: HTMLCanvasElement | HTMLImageElement, anisotropy: number): THREE.Texture {
  const texture = source instanceof HTMLCanvasElement ? new THREE.CanvasTexture(source) : new THREE.Texture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = anisotropy;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Stitch only the Moon Trek SP tiles that intersect the layer footprint at zoom `tileMatrix`. */
async function loadTrekOverlay(
  cfg: TrekLayer,
  opts: { signal?: AbortSignal; anisotropy?: number; onProgress?: (done: number, total: number) => void },
): Promise<OverlayTexture> {
  const z = cfg.tileMatrix;
  const tileM = TREK_SP_Z0_TILE_M / 2 ** z;
  const [xmin, ymin, xmax, ymax] = cfg.bboxM;
  const c0 = Math.floor((xmin + TREK_SP_TOP_LEFT_M) / tileM);
  const c1 = Math.floor((xmax + TREK_SP_TOP_LEFT_M) / tileM);
  const r0 = Math.floor((TREK_SP_TOP_LEFT_M - ymax) / tileM);
  const r1 = Math.floor((TREK_SP_TOP_LEFT_M - ymin) / tileM);
  const cols = c1 - c0 + 1;
  const rows = r1 - r0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = cols * TILE_PX;
  canvas.height = rows * TILE_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');

  const jobs: { row: number; col: number }[] = [];
  for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) jobs.push({ row, col });
  let loaded = 0;
  let failed = 0;
  let viaProxy = 0;
  await runPool(jobs, 6, async ({ row, col }) => {
    const tile = await loadTrekTile(cfg.id, z, row, col, opts.signal);
    if (tile) {
      ctx.drawImage(tile.image, (col - c0) * TILE_PX, (row - r0) * TILE_PX, TILE_PX, TILE_PX);
      loaded++;
      if (tile.viaProxy) viaProxy++;
    } else {
      failed++;
    }
    opts.onProgress?.(loaded + failed, jobs.length);
  });
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (loaded === 0) throw new Error(`No Moon Trek tiles reachable for ${cfg.id} (direct or via backend proxy)`);

  const boundsM: Bounds = [
    c0 * tileM - TREK_SP_TOP_LEFT_M,
    TREK_SP_TOP_LEFT_M - (r1 + 1) * tileM,
    (c1 + 1) * tileM - TREK_SP_TOP_LEFT_M,
    TREK_SP_TOP_LEFT_M - r0 * tileM,
  ];
  return {
    layer: cfg.id,
    texture: finishTexture(canvas, opts.anisotropy ?? 4),
    boundsM,
    detail: `Moon Trek WMTS SP z${z} · ${loaded}/${jobs.length} tiles${viaProxy ? ` (${viaProxy} via backend cache)` : ''}`,
  };
}

async function loadBackendOverlay(cfg: BackendLayer, opts: { signal?: AbortSignal; anisotropy?: number }): Promise<OverlayTexture> {
  const urls = overlayUrls(cfg.overlay);
  const res = await fetchWithTimeout(urls.meta, 10_000);
  if (!res.ok) throw new Error(`overlay metadata HTTP ${res.status}`);
  const meta = (await res.json()) as { bounds_m: Bounds; source: { source_name: string; resolution: string } };
  const image = await loadImage(urls.png, opts.signal, 60_000);
  return {
    layer: cfg.id,
    texture: finishTexture(image, opts.anisotropy ?? 4),
    boundsM: meta.bounds_m,
    detail: `${meta.source.source_name} · ${meta.source.resolution}`,
  };
}

export async function loadOverlayTexture(
  layerId: OverlayLayerId,
  opts: { signal?: AbortSignal; anisotropy?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<OverlayTexture> {
  const cached = overlayCache.get(layerId);
  if (cached) return cached;
  const cfg = OVERLAY_LAYERS[layerId];
  const result = cfg.kind === 'trek' ? await loadTrekOverlay(cfg, opts) : await loadBackendOverlay(cfg, opts);
  overlayCache.set(layerId, result);
  return result;
}

/* ─────────────── CGI Moon Kit base colour ─────────────── */

export type BaseTextureOrigin = 'svs' | 'local' | 'procedural';

function proceduralMoonCanvas(): HTMLCanvasElement {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      const maria = Math.max(0, Math.sin(u * Math.PI * 2 + 1.2) * Math.sin(v * Math.PI * 1.4 + 0.3)) * 0.35;
      const g = 0.62 - maria;
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(g * 255);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

let cgiPromise: Promise<{ texture: THREE.Texture; origin: BaseTextureOrigin; url: string | null }> | null = null;

/** Local copy → NASA SVS 2K JPEG → procedural canvas. Never throws. */
export function loadCgiMoonKitTexture(
  anisotropy = 8,
): Promise<{ texture: THREE.Texture; origin: BaseTextureOrigin; url: string | null }> {
  if (cgiPromise) return cgiPromise;
  cgiPromise = (async () => {
    // Local copy first: svs.gsfc.nasa.gov answers with an Access-Control-Allow-Origin pinned to a
    // different site, so a browser WebGL upload from our origin is always CORS-blocked. The SVS URL
    // stays as a second attempt for deployments without the local file (run `npm run fetch:textures`).
    const candidates: [BaseTextureOrigin, string][] = [
      ['local', LOCAL_CGI_MOON_KIT_COLOR_2K],
      ['svs', SVS_CGI_MOON_KIT_COLOR_2K],
    ];
    for (const [origin, url] of candidates) {
      try {
        const image = await loadImage(url, undefined, origin === 'svs' ? 9_000 : 15_000);
        const texture = new THREE.Texture(image);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.anisotropy = anisotropy;
        texture.needsUpdate = true;
        return { texture, origin, url };
      } catch {
        /* try next source */
      }
    }
    const texture = new THREE.CanvasTexture(proceduralMoonCanvas());
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    return { texture, origin: 'procedural' as const, url: null };
  })();
  return cgiPromise;
}
