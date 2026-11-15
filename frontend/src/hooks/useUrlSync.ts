'use client';

import { useEffect } from 'react';
import { parseExpert, parseMode, writeExpert } from '@/lib/displayMode';
import { normalizeEpoch } from '@/lib/format';
import { useMissionStore, type MissionStore, type UrlHydration } from '@/store/useMissionStore';
import { LAYER_IDS, type LayerId } from '@/types/mission';

/**
 * Bi-directional URL ⇄ store sync:
 *   ?lat=-84.79059&lon=29.19567&date=2025-03-06T17:28:00Z&days=7&ant=5&layer=BASE_CGI[&site=im-2][&mode=learn|expert][&pa=…]
 *   (legacy `learn=1` still opens Learn mode)
 * Reads once on mount, then mirrors every relevant store change with history.replaceState
 * (throttled — Safari rate-limits replaceState to ~100 calls / 30 s).
 */

const num = (v: string | null): number | undefined => {
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function parseMissionParams(search: string): UrlHydration {
  const p = new URLSearchParams(search);
  const lat = num(p.get('lat'));
  const lon = num(p.get('lon'));
  const layer = p.get('layer');
  const out: UrlHydration = {
    epochUTC: normalizeEpoch(p.get('date')) ?? undefined,
    days: num(p.get('days')),
    ant: num(p.get('ant')),
    layer: layer && (LAYER_IDS as readonly string[]).includes(layer) ? (layer as LayerId) : undefined,
    mode: parseMode(p),
    expert: parseExpert(p),
    siteId: p.get('site') ?? undefined,
  };
  if (lat !== undefined && lon !== undefined && lat >= -90 && lat <= 90 && lon >= -360 && lon <= 360) {
    out.lat = lat;
    out.lon = lon;
  }
  return out;
}

export function buildMissionSearch(s: MissionStore): string {
  const p = new URLSearchParams();
  if (s.selectedSite) {
    p.set('lat', s.selectedSite.lat.toFixed(5));
    p.set('lon', s.selectedSite.lon.toFixed(5));
  }
  p.set('date', s.epochUTC);
  p.set('days', String(s.missionDurationDays));
  p.set('ant', String(s.minEarthElevationDeg));
  p.set('layer', s.activeLayer);
  if (s.selectedSite?.regionId) p.set('site', s.selectedSite.regionId);
  if (s.displayMode !== 'standard') p.set('mode', s.displayMode);
  if (s.displayMode === 'expert') writeExpert(p, s.expert);
  // URLSearchParams encodes ':' — keep the date human-readable in shared links.
  return p.toString().replace(/%3A/gi, ':');
}

const syncedSlice = (s: MissionStore) =>
  [
    s.selectedSite?.lat,
    s.selectedSite?.lon,
    s.selectedSite?.regionId,
    s.epochUTC,
    s.missionDurationDays,
    s.minEarthElevationDeg,
    s.activeLayer,
    s.displayMode,
    JSON.stringify(s.expert),
  ].join('|');

export function useUrlSync(): void {
  useEffect(() => {
    useMissionStore.getState().hydrateFromUrl(parseMissionParams(window.location.search));

    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = '';
    const write = () => {
      timer = null;
      const search = buildMissionSearch(useMissionStore.getState());
      const next = `${window.location.pathname}?${search}${window.location.hash}`;
      if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        window.history.replaceState(window.history.state, '', next);
      }
    };
    const unsubscribe = useMissionStore.subscribe((state) => {
      const slice = syncedSlice(state);
      if (slice === last) return;
      last = slice;
      if (!timer) timer = setTimeout(write, 250);
    });
    last = syncedSlice(useMissionStore.getState());
    write();
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
