import type { EphemerisTrajectory, SkylinePoint } from '@/types/mission';
import {
  DEG2RAD,
  RAD2DEG,
  type Vec3,
  clamp,
  directionToAzEl,
  latLonToVec3,
  normalizeLon,
  vec3ToLatLon,
  wrap360,
} from './geo';

const toVecLatLon = (v: Vec3) => vec3ToLatLon(v[0], v[1], v[2]);

export const SUN_ANGULAR_RADIUS_DEG = 0.266;

/** A single instant along the mission timeline, either interpolated from the backend or approximated locally. */
export interface ScrubbedEphemeris {
  tUtcMs: number;
  hoursFromStart: number;
  sunAzDeg: number;
  sunElDeg: number;
  sunHorizonElDeg: number | null;
  sunVisibleFraction: number;
  earthAzDeg: number;
  earthElDeg: number;
  earthHorizonElDeg: number | null;
  earthVisible: boolean;
  earthAboveCutoff: boolean;
  subsolarLat: number;
  subsolarLon: number;
  subEarthLat: number;
  subEarthLon: number;
  /** true → local analytic approximation (no backend yet); never shown as authoritative. */
  isApproximate: boolean;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

function azElVec(az: number, el: number): Vec3 {
  const a = az * DEG2RAD;
  const e = el * DEG2RAD;
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
}

function vecAzEl(v: Vec3): { az: number; el: number } {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return { az: wrap360(Math.atan2(v[0], v[1]) * RAD2DEG), el: Math.asin(clamp(v[2] / n, -1, 1)) * RAD2DEG };
}

/** Interpolate on the unit sphere so azimuth wrap-around (359°→1°) never produces a 180° glitch. */
function lerpAzEl(az0: number, el0: number, az1: number, el1: number, f: number) {
  const a = azElVec(az0, el0);
  const b = azElVec(az1, el1);
  return vecAzEl([lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)]);
}

function lerpLatLon(lat0: number, lon0: number, lat1: number, lon1: number, f: number) {
  const a = latLonToVec3(lat0, lon0);
  const b = latLonToVec3(lat1, lon1);
  return toVecLatLon([lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)]);
}

const lerpNullable = (a: number | null, b: number | null, f: number) =>
  a == null || b == null ? (f < 0.5 ? a : b) : lerp(a, b, f);

/** O(log n) lookup + spherical interpolation — runs every scrubber tick with zero network calls. */
export function interpolateTrajectory(
  traj: EphemerisTrajectory,
  hours: number,
  minEarthElDeg: number,
): ScrubbedEphemeris | null {
  const s = traj.samples;
  if (!s.length) return null;
  const h = clamp(hours, s[0].hours_from_start, s[s.length - 1].hours_from_start);
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].hours_from_start <= h) lo = mid;
    else hi = mid;
  }
  const a = s[lo];
  const b = s[hi];
  const span = b.hours_from_start - a.hours_from_start;
  const f = span > 0 ? (h - a.hours_from_start) / span : 0;

  const sun = lerpAzEl(a.sun_az_deg, a.sun_el_deg, b.sun_az_deg, b.sun_el_deg, f);
  const earth = lerpAzEl(a.earth_az_deg, a.earth_el_deg, b.earth_az_deg, b.earth_el_deg, f);
  const subsolar = lerpLatLon(a.subsolar_lat_deg, a.subsolar_lon_deg, b.subsolar_lat_deg, b.subsolar_lon_deg, f);
  const subEarth = lerpLatLon(a.subearth_lat_deg, a.subearth_lon_deg, b.subearth_lat_deg, b.subearth_lon_deg, f);
  const sunHorizon = lerpNullable(a.sun_horizon_el_deg, b.sun_horizon_el_deg, f);
  const earthHorizon = lerpNullable(a.earth_horizon_el_deg, b.earth_horizon_el_deg, f);
  const earthVisible = earthHorizon != null ? earth.el > earthHorizon : f < 0.5 ? a.earth_visible : b.earth_visible;

  return {
    tUtcMs: Date.parse(traj.start_utc) + h * 3_600_000,
    hoursFromStart: h,
    sunAzDeg: sun.az,
    sunElDeg: sun.el,
    sunHorizonElDeg: sunHorizon,
    sunVisibleFraction: clamp(lerp(a.sun_visible_fraction, b.sun_visible_fraction, f), 0, 1),
    earthAzDeg: earth.az,
    earthElDeg: earth.el,
    earthHorizonElDeg: earthHorizon,
    earthVisible,
    earthAboveCutoff: earthVisible && earth.el >= minEarthElDeg,
    subsolarLat: subsolar.lat,
    subsolarLon: subsolar.lon,
    subEarthLat: subEarth.lat,
    subEarthLon: subEarth.lon,
    isApproximate: false,
  };
}

/* ─────────────── Skyline helpers ─────────────── */

export function sortSkyline(points: SkylinePoint[]): SkylinePoint[] {
  return [...points]
    .map((p) => ({ ...p, azimuth_deg: wrap360(p.azimuth_deg) }))
    .sort((a, b) => a.azimuth_deg - b.azimuth_deg);
}

/** Linear interpolation of the terrain horizon at any azimuth (expects sortSkyline output). */
export function skylineElevationAt(sorted: SkylinePoint[], azDeg: number): number | null {
  const n = sorted.length;
  if (!n) return null;
  const az = wrap360(azDeg);
  let i = sorted.findIndex((p) => p.azimuth_deg > az);
  if (i === -1) i = n; // past the last sample → wrap to the first
  const prev = sorted[(i - 1 + n) % n];
  const next = sorted[i % n];
  let span = next.azimuth_deg - prev.azimuth_deg;
  let off = az - prev.azimuth_deg;
  if (span <= 0) span += 360;
  if (off < 0) off += 360;
  return lerp(prev.elevation_deg, next.elevation_deg, span > 0 ? off / span : 0);
}

/* ─────────────── Local analytic approximation (pre-backend lighting) ─────────────── */

const REF_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14); // new Moon 2000-01-06 18:14 UTC
const SYNODIC_DAYS = 29.530588853;
const DAY_MS = 86_400_000;

/** Sub-solar point: longitude from synodic phase (new Moon → far side, 180°), ±1.54° latitude from the Cassini-state tilt. */
export function approxSubsolarPoint(date: Date): { lat: number; lon: number } {
  const days = (date.getTime() - REF_NEW_MOON_MS) / DAY_MS;
  const phase = (((days / SYNODIC_DAYS) % 1) + 1) % 1;
  return {
    lat: 1.54 * Math.sin((2 * Math.PI * days) / 346.62),
    lon: normalizeLon(180 - phase * 360),
  };
}

/** Sub-Earth point from optical libration (±6.7° lat over a draconic month, ±7.9° lon over an anomalistic month). */
export function approxSubEarthPoint(date: Date): { lat: number; lon: number } {
  const days = (date.getTime() - REF_NEW_MOON_MS) / DAY_MS;
  return {
    lat: 6.68 * Math.sin((2 * Math.PI * days) / 27.2122),
    lon: 7.9 * Math.sin((2 * Math.PI * days) / 27.5545),
  };
}

export function approximateEphemeris(lat: number, lon: number, date: Date, minEarthElDeg: number): ScrubbedEphemeris {
  const sub = approxSubsolarPoint(date);
  const se = approxSubEarthPoint(date);
  const sun = directionToAzEl(lat, lon, latLonToVec3(sub.lat, sub.lon));
  const earth = directionToAzEl(lat, lon, latLonToVec3(se.lat, se.lon));
  return {
    tUtcMs: date.getTime(),
    hoursFromStart: 0,
    sunAzDeg: sun.az,
    sunElDeg: sun.el,
    sunHorizonElDeg: null,
    sunVisibleFraction: clamp((sun.el + SUN_ANGULAR_RADIUS_DEG) / (2 * SUN_ANGULAR_RADIUS_DEG), 0, 1),
    earthAzDeg: earth.az,
    earthElDeg: earth.el,
    earthHorizonElDeg: null,
    earthVisible: earth.el > 0,
    earthAboveCutoff: earth.el >= minEarthElDeg,
    subsolarLat: sub.lat,
    subsolarLon: sub.lon,
    subEarthLat: se.lat,
    subEarthLon: se.lon,
    isApproximate: true,
  };
}
