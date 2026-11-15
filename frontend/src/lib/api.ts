import type {
  LaunchCalendarRequest,
  LaunchCalendarResponse,
  NearestAlternativeRequest,
  NearestAlternativeResponse,
  SiteEvaluationRequest,
  SiteEvaluationResponse,
  SlopeStatsResponse,
  ValidationBenchmarkResponse,
  ValidationRequest,
} from '@/types/mission';
import type { ContingencyRequest, ContingencyResponse } from './contingency';
import type { NearbyWindowsRequest, NearbyWindowsResponse } from '@/types/nearbyWindows';

export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8000').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiError(`Cannot reach the mission backend at ${API_BASE}. Is FastAPI running?`, 0, url);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: unknown };
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(`${res.status}: ${detail}`, res.status, url);
  }
  return (await res.json()) as T;
}

function qs(params: object): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) p.set(k, String(v));
  }
  return p.toString();
}

/** Every backend route the UI calls lives here — this is the Phase 1 ↔ Phase 2 contract. */
export const api = {
  evaluateSite: (body: SiteEvaluationRequest, signal?: AbortSignal) =>
    requestJson<SiteEvaluationResponse>('/api/evaluate', { method: 'POST', body: JSON.stringify(body), signal }),

  launchCalendar: (params: LaunchCalendarRequest, signal?: AbortSignal) =>
    requestJson<LaunchCalendarResponse>(`/api/launch-calendar?${qs(params)}`, { signal }),

  nearestAlternative: (body: NearestAlternativeRequest, signal?: AbortSignal) =>
    requestJson<NearestAlternativeResponse>('/api/nearest-alternative', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),

  contingency: (body: ContingencyRequest, signal?: AbortSignal) =>
    requestJson<ContingencyResponse>('/api/contingency', { method: 'POST', body: JSON.stringify(body), signal }),

  nearbyWindows: (params: NearbyWindowsRequest, signal?: AbortSignal) =>
    requestJson<NearbyWindowsResponse>(`/api/nearby-windows?${qs(params)}`, { signal }),

  slopeStats: (params: { lat: number; lon: number; radius_m: number }, signal?: AbortSignal) =>
    requestJson<SlopeStatsResponse>(`/api/terrain/slope-stats?${qs(params)}`, { signal }),

  validation: (params: ValidationRequest, signal?: AbortSignal) =>
    requestJson<ValidationBenchmarkResponse>(`/api/validation?${qs(params)}`, { signal }),
};

export const TERRAIN_ENDPOINTS = {
  /** RG16-packed PNG rendered from ldem_75s_240m.img (see terrainHeight.ts for decoding). */
  heightmapPng: `${API_BASE}/api/terrain/polar-heightmap.png`,
  heightmapMeta: `${API_BASE}/api/terrain/polar-heightmap.json`,
};

/** Backend Tier-1 disk-cached proxy for Moon Trek tiles (used when trek.nasa.gov blocks CORS or we are offline). */
export const tileProxyUrl = (projection: 'SP' | 'EQ', layer: string, z: number, row: number, col: number) =>
  `${API_BASE}/api/tiles/${projection}/${layer}/${z}/${row}/${col}.png`;

/** Overlays rendered by the backend from ingested NASA rasters (LOLA relief, PGDA Sun/Earth visibility). */
export const overlayUrls = (name: string) => ({
  png: `${API_BASE}/api/overlays/${name}.png`,
  meta: `${API_BASE}/api/overlays/${name}.json`,
});
