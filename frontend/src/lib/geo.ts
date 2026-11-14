/**
 * Selenographic ↔ scene ↔ South Polar Stereographic math.
 *
 * Scene frame (Moon mesh is never rotated):
 *   +Y → north pole (+90° lat), −Y → south pole
 *   +Z → sub-Earth mean point (0° lat, 0° lon)
 *   +X → 90°E
 *
 *   lat = asin(y / |p|),  lon = atan2(x, z)
 *   x = R cos(lat) sin(lon),  y = R sin(lat),  z = R cos(lat) cos(lon)
 *
 * South Polar Stereographic (sphere R = 1 737 400 m, λ0 = 0°, φ0 = −90°):
 *   ρ = 2R tan(π/4 + φ/2) = 2R cos φ / (1 − sin φ)
 *   x = ρ sin λ,  y = ρ cos λ          (0° lon points "up" the map, 90°E to the right)
 * Because the scene unit vector is d = (cos φ sin λ, sin φ, cos φ cos λ):
 *   x = 2R d.x / (1 − d.y),  y = 2R d.z / (1 − d.y)     ← trig-free, used in the shader too.
 */

export const MOON_RADIUS_M = 1_737_400;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export type Vec3 = [number, number, number];

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Longitude into (−180, 180]. */
export function normalizeLon(lon: number): number {
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  return l === -180 ? 180 : l;
}

export const wrap360 = (a: number) => ((a % 360) + 360) % 360;

/** Smallest signed angular difference a − b in degrees, in (−180, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  return normalizeLon(a - b);
}

export function latLonToVec3(latDeg: number, lonDeg: number, radius = 1): Vec3 {
  const la = latDeg * DEG2RAD;
  const lo = lonDeg * DEG2RAD;
  const c = Math.cos(la);
  return [radius * c * Math.sin(lo), radius * Math.sin(la), radius * c * Math.cos(lo)];
}

export function vec3ToLatLon(x: number, y: number, z: number): { lat: number; lon: number } {
  const r = Math.hypot(x, y, z) || 1;
  return {
    lat: Math.asin(clamp(y / r, -1, 1)) * RAD2DEG,
    lon: Math.atan2(x, z) * RAD2DEG,
  };
}

export function normalize3(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

export const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/* ───────────── South Polar Stereographic ───────────── */

export function stereoForward(latDeg: number, lonDeg: number): { x: number; y: number } {
  const d = latLonToVec3(latDeg, lonDeg, 1);
  const k = (2 * MOON_RADIUS_M) / Math.max(1 - d[1], 1e-12);
  return { x: k * d[0], y: k * d[2] };
}

export function stereoInverse(x: number, y: number): { lat: number; lon: number } {
  const rho = Math.hypot(x, y);
  const lat = (2 * Math.atan(rho / (2 * MOON_RADIUS_M)) - Math.PI / 2) * RAD2DEG;
  const lon = rho === 0 ? 0 : Math.atan2(x, y) * RAD2DEG;
  return { lat, lon };
}

/** Stereographic radius ρ (m) of a given latitude ring. */
export const stereoRho = (latDeg: number) => 2 * MOON_RADIUS_M * Math.tan(Math.PI / 4 + (latDeg * DEG2RAD) / 2);

/* ───────────── Great-circle helpers ───────────── */

export function greatCircleDestination(
  latDeg: number,
  lonDeg: number,
  bearingDeg: number,
  distanceM: number,
): { lat: number; lon: number } {
  const φ1 = latDeg * DEG2RAD;
  const λ1 = lonDeg * DEG2RAD;
  const θ = bearingDeg * DEG2RAD;
  const δ = distanceM / MOON_RADIUS_M;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(clamp(sinφ2, -1, 1));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * sinφ2);
  return { lat: φ2 * RAD2DEG, lon: normalizeLon(λ2 * RAD2DEG) };
}

export function greatCircleDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * DEG2RAD;
  const φ2 = lat2 * DEG2RAD;
  const dφ = φ2 - φ1;
  const dλ = (lon2 - lon1) * DEG2RAD;
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return (2 * MOON_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))) / 1000;
}

/* ───────────── Local horizon (ENU) frame ───────────── */

/**
 * East/North/Up unit vectors at a site, expressed in the scene frame.
 * Derived from ∂p/∂λ and ∂p/∂φ, so they stay well defined arbitrarily close to the pole.
 */
export function enuBasis(latDeg: number, lonDeg: number): { east: Vec3; north: Vec3; up: Vec3 } {
  const φ = latDeg * DEG2RAD;
  const λ = lonDeg * DEG2RAD;
  const up = latLonToVec3(latDeg, lonDeg, 1);
  const east: Vec3 = [Math.cos(λ), 0, -Math.sin(λ)];
  const north: Vec3 = [-Math.sin(φ) * Math.sin(λ), Math.cos(φ), -Math.sin(φ) * Math.cos(λ)];
  return { east, north, up };
}

/** Topocentric azimuth (from north, through east) + elevation → scene-frame unit direction. */
export function azElToDirection(latDeg: number, lonDeg: number, azDeg: number, elDeg: number): Vec3 {
  const { east, north, up } = enuBasis(latDeg, lonDeg);
  const a = azDeg * DEG2RAD;
  const e = elDeg * DEG2RAD;
  const ce = Math.cos(e);
  const ke = ce * Math.sin(a);
  const kn = ce * Math.cos(a);
  const ku = Math.sin(e);
  return [
    ke * east[0] + kn * north[0] + ku * up[0],
    ke * east[1] + kn * north[1] + ku * up[1],
    ke * east[2] + kn * north[2] + ku * up[2],
  ];
}

export function directionToAzEl(latDeg: number, lonDeg: number, dir: Vec3): { az: number; el: number } {
  const { east, north, up } = enuBasis(latDeg, lonDeg);
  const d = normalize3(dir);
  const e = dot3(d, east);
  const n = dot3(d, north);
  const u = dot3(d, up);
  return { az: wrap360(Math.atan2(e, n) * RAD2DEG), el: Math.asin(clamp(u, -1, 1)) * RAD2DEG };
}

/* ───────────── Formatting ───────────── */

export function formatLat(lat: number, digits = 4): string {
  return `${Math.abs(lat).toFixed(digits)}°${lat < 0 ? 'S' : 'N'}`;
}

export function formatLon(lon: number, digits = 4): string {
  const l = normalizeLon(lon);
  return `${Math.abs(l).toFixed(digits)}°${l < 0 ? 'W' : 'E'}`;
}

export const formatLatLon = (lat: number, lon: number, digits = 4) =>
  `${formatLat(lat, digits)}, ${formatLon(lon, digits)}`;
