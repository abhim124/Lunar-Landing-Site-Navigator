'use client';

import { useEffect, useMemo } from 'react';
import type { EnvPreset, EnvSite, RadiationLevel } from '@/components/EnvComparisonModal';
import { useMissionStore } from '@/store/useMissionStore';
import type { SiteEvaluationResponse, SkylineProfile } from '@/types/mission';
import { angleDiffDeg, greatCircleDestination, greatCircleDistanceKm } from './geo';
import { CAP_EDGE_LAT_DEG, elevationAtLatLon, loadPolarHeightmap, useTerrainSnapshot } from './terrainHeight';

/** Quick sites for the comparison modal. Registry ids select curated sites; `shackleton-floor` is a custom pad. */
export const ENV_PRESETS: EnvPreset[] = [
  { id: 'artemis-peak-near-shackleton', label: 'Shackleton Rim' },
  { id: 'shackleton-floor', label: 'Shackleton Floor (PSR)' },
  { id: 'artemis-malapert-massif', label: 'Malapert Massif' },
  { id: 'apollo-11', label: 'Apollo 11 · Tranquillitatis' },
];

/** Approximate centre of Shackleton crater's floor (≈89.67°S 129.8°E), a permanently shadowed region. */
const SHACKLETON_FLOOR = { lat: -89.67, lon: 129.8 };

export function selectEnvPreset(id: string) {
  const m = useMissionStore.getState();
  // Comparison only: the PSR floor is shown with a warning, never accepted as a landing pad.
  if (id === 'shackleton-floor') m.selectSite({ ...SHACKLETON_FLOOR, name: 'Shackleton Crater Floor (PSR, ≈)', regionId: null }, { allowPsr: true, psrView: true });
  else m.selectCuratedSite(id);
}

const PROFILE_POINTS = 20;
const PROFILE_HALF_KM = 10;

/** 20 LOLA elevations along a west→east line through the site (only inside the client heightmap's 75°S cap). */
function lolaProfile(lat: number, lon: number): number[] | null {
  if (lat > CAP_EDGE_LAT_DEG + 0.5) return null;
  return Array.from({ length: PROFILE_POINTS }, (_, i) => {
    const d = (i / (PROFILE_POINTS - 1) - 0.5) * 2 * PROFILE_HALF_KM * 1000;
    const p = greatCircleDestination(lat, lon, d >= 0 ? 90 : 270, Math.abs(d));
    return elevationAtLatLon(p.lat, p.lon);
  });
}

/**
 * Open-sky exposure (0–1) from the terrain horizon: galactic cosmic rays arrive from the whole sky, so
 * surrounding terrain that rises h above the horizon blocks ≈ sin(h) of the upper hemisphere's
 * solid angle at that azimuth. Exposure = 1 − mean(sin max(h, 0)).
 */
export function skyExposure(sky: SkylineProfile | null | undefined): number | null {
  const pts = sky?.points ?? [];
  if (!pts.length) return null;
  const blocked = pts.reduce((a, p) => a + Math.sin((Math.max(0, p.elevation_deg) * Math.PI) / 180), 0) / pts.length;
  return Math.max(0, 1 - blocked);
}

function radiationFor(ev: SiteEvaluationResponse): { level: RadiationLevel; exposurePct: number; note: string } {
  const exp = skyExposure(ev.skyline) ?? 1;
  const pct = Math.round(exp * 1000) / 10;
  const sw = ev.space_weather.status;
  const shield = `Terrain blocks about ${(100 - pct).toFixed(1)}% of the sky here (from the LOLA horizon), so ${pct.toFixed(1)}% open-sky exposure to cosmic rays.`;
  if (sw === 'ELEVATED RADIATION')
    return { level: 'EXTREME', exposurePct: Math.max(pct, 95), note: `NASA DONKI reports a solar energetic particle event in this mission window. ${shield} Estimate, not a dose calculation.` };
  const level: RadiationLevel = exp < 0.9 ? 'ELEVATED' : 'HAZARDOUS';
  return {
    level,
    exposurePct: pct,
    note: `${sw === 'UNKNOWN' ? 'Space weather could not be checked (DONKI only covers past dates). ' : 'No solar particle event in DONKI for this window. '}${shield} No atmosphere or magnetic field: unshielded surface exposure is hazardous; terrain shielding lowers it to "elevated" below 90% exposure. Estimate, not a dose calculation.`,
  };
}

/** The selected lunar site in the comparison modal's shape, from real app data where available. */
export function useEnvSite(): { site: EnvSite | null; presetId: string | null; loading: boolean } {
  const site = useMissionStore((s) => s.selectedSite);
  const evaluation = useMissionStore((s) => s.evaluation);
  const status = useMissionStore((s) => s.evaluationStatus);
  const terrain = useTerrainSnapshot();
  // The globe normally loads the polar LOLA heightmap; start it here too (idempotent) so the
  // cross-section is real even before the globe has finished loading.
  useEffect(() => {
    void loadPolarHeightmap();
  }, []);

  return useMemo(() => {
    if (!site) return { site: null, presetId: null, loading: false };
    const ev =
      evaluation && Math.abs(evaluation.site.lat - site.lat) < 1e-4 && Math.abs(angleDiffDeg(evaluation.site.lon, site.lon)) < 1e-4 ? evaluation : null;
    const presetId =
      ENV_PRESETS.find((p) => p.id === site.regionId)?.id ??
      (greatCircleDistanceKm(site.lat, site.lon, SHACKLETON_FLOOR.lat, SHACKLETON_FLOOR.lon) < 0.5 ? 'shackleton-floor' : null);
    if (!ev) return { site: null, presetId, loading: true };

    const profile = terrain.mode === 'lola' ? lolaProfile(site.lat, site.lon) : null;
    const div = ev.thermal.surface_temperature_k.value;
    const rad = radiationFor(ev);
    const env: EnvSite = {
      siteName: site.name,
      elevationM: Math.round(ev.site.elevation_m.value),
      slopeDeg: Math.round(ev.terrain.slope_deg.value * 10) / 10,
      elevationProfile: profile ?? undefined,
      profileHalfWidthKm: PROFILE_HALF_KM,
      minTempC: div.min_k != null ? Math.round(div.min_k - 273.15) : undefined,
      maxTempC: div.max_k != null ? Math.round(div.max_k - 273.15) : undefined,
      radiationLevel: rad.level,
      radiationExposurePct: rad.exposurePct,
      lat: site.lat,
      lon: site.lon,
      provenance: {
        topography: { kind: 'measured', note: `Elevation and slope from NASA LOLA laser altimetry (${ev.site.elevation_m.source.source_name}; ${ev.terrain.slope_deg.source.source_name}).` },
        profile: profile
          ? { kind: 'measured', note: `Silhouette: ${PROFILE_POINTS} LOLA elevations along a ${2 * PROFILE_HALF_KM} km west→east line through the site.` }
          : { kind: 'illustrative', note: 'Outside the polar LOLA heightmap loaded in the browser: the silhouette is generated from the real elevation and slope, not a measured profile.' },
        temperature:
          div.min_k != null
            ? { kind: 'measured', note: 'LRO Diviner measured surface temperature range (Global Cumulative Product, 0.5° map cell). A long-term day/night range, not a forecast for these dates.' }
            : { kind: 'default', note: 'Diviner data unavailable here; showing default range.' },
        radiation: { kind: 'est.', note: rad.note },
      },
    };
    return { site: env, presetId, loading: status === 'loading' };
  }, [site, evaluation, status, terrain.mode]);
}
