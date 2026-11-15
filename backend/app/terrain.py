"""
Terrain: South Polar Stereographic projection, 360° LOLA horizon ray-marcher with lunar
curvature, O(1) hazard / illumination / PSR lookups, and windowed reads of the PGDA 5 m/px
Artemis site GeoTIFFs.

Projection (sphere R = 1 737 400 m, λ0 = 0°, φ0 = −90°; identical to LOLA polar products and
the PGDA GeoTIFF CRS "+proj=stere +lat_0=-90 +lon_0=0 +R=1737400"):
    ρ = 2R·tan(π/4 + φ/2),   x = ρ·sin λ,   y = ρ·cos λ
    φ = 2·atan(ρ / 2R) − π/2,   λ = atan2(x, y)
Grid index (0-based, pixel-registered, PDS LINE/SAMPLE_PROJECTION_OFFSET = o):
    col = x / s + o,   row = o − y / s
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
from scipy import ndimage

from .cache import DATA_DIR, GridStore

MOON_R = 1_737_400.0
OBSERVER_HEIGHT_M = 2.0  # lander deck / antenna height above the surface
POLAR_RAYMARCH_LIMIT_LAT = -76.7  # 50 km rays stay inside the 75°S LDEM south of this


def stereo_forward(lat, lon):
    lat_r, lon_r = np.radians(lat), np.radians(lon)
    rho = 2 * MOON_R * np.tan(np.pi / 4 + lat_r / 2)
    return rho * np.sin(lon_r), rho * np.cos(lon_r)


def stereo_inverse(x, y):
    rho = np.hypot(x, y)
    return np.degrees(2 * np.arctan(rho / (2 * MOON_R)) - np.pi / 2), np.degrees(np.arctan2(x, y))


def destination(lat: float, lon: float, bearing_deg: np.ndarray, dist_m: np.ndarray):
    """Vectorised great-circle destination (broadcasts bearing × distance)."""
    φ1, λ1 = np.radians(lat), np.radians(lon)
    θ = np.radians(bearing_deg)
    δ = dist_m / MOON_R
    sinφ2 = np.sin(φ1) * np.cos(δ) + np.cos(φ1) * np.sin(δ) * np.cos(θ)
    φ2 = np.arcsin(np.clip(sinφ2, -1, 1))
    λ2 = λ1 + np.arctan2(np.sin(θ) * np.sin(δ) * np.cos(φ1), np.cos(δ) - np.sin(φ1) * sinφ2)
    return np.degrees(φ2), (np.degrees(λ2) + 180) % 360 - 180


def great_circle_km(lat1, lon1, lat2, lon2) -> float:
    φ1, φ2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((φ2 - φ1) / 2) ** 2 + np.cos(φ1) * np.cos(φ2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return float(2 * MOON_R * np.arcsin(min(1.0, np.sqrt(a))) / 1000)


def initial_bearing(lat1, lon1, lat2, lon2) -> float:
    φ1, φ2 = np.radians(lat1), np.radians(lat2)
    dλ = np.radians(lon2 - lon1)
    y = np.sin(dλ) * np.cos(φ2)
    x = np.cos(φ1) * np.sin(φ2) - np.sin(φ1) * np.cos(φ2) * np.cos(dλ)
    return float(np.degrees(np.arctan2(y, x)) % 360)


def tag(name: str, res: str, derived: bool = False, synthetic: bool = False, approx: bool | None = None) -> dict:
    t = {"source_name": name, "resolution": res, "is_derived": derived, "is_synthetic_fallback": synthetic}
    if approx is not None:
        t["is_approx_coord"] = approx
    return t


# ─────────────────────────────── elevation sources ───────────────────────────────


class ElevationSource:
    name: str
    resolution: str
    pixel_m: float
    synthetic: bool

    def sample(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:  # pragma: no cover - interface
        raise NotImplementedError


class PolarLdem(ElevationSource):
    def __init__(self, store: GridStore):
        self.g = store.ldem
        self.name = self.g.source["source_name"]
        self.resolution = self.g.source["resolution"]
        self.pixel_m = self.g.pixel_m
        self.synthetic = bool(self.g.source.get("is_synthetic_fallback"))

    def sample(self, lat, lon):
        x, y = stereo_forward(lat, lon)
        r, c = self.g.rc(x, y)
        return ndimage.map_coordinates(self.g.data, [np.ravel(r), np.ravel(c)], order=1, mode="constant", cval=np.nan).reshape(np.shape(lat))


class GlobalLdem16(ElevationSource):
    """LOLA LDEM_16 (16 px/deg, centre lon 180°) for sites north of the polar grid."""

    def __init__(self, store: GridStore):
        self.data = store.ldem16
        self.name, self.resolution, self.pixel_m, self.synthetic = "LOLA LDEM_16", "16 ppd (≈1.9 km/px)", 1895.0, False

    def sample(self, lat, lon):
        lon360 = np.mod(lon, 360.0)
        c = 2879.5 + (lon360 - 180.0) * 16.0
        r = 1439.5 - np.asarray(lat) * 16.0
        return ndimage.map_coordinates(self.data, [np.ravel(r), np.ravel(c)], order=1, mode="wrap").reshape(np.shape(lat))


def elevation_source(lat: float) -> ElevationSource:
    store = GridStore.get()
    return PolarLdem(store) if lat <= POLAR_RAYMARCH_LIMIT_LAT else GlobalLdem16(store)


# ─────────────────────────────── 360° horizon ───────────────────────────────


@dataclass
class Skyline:
    azimuth: np.ndarray
    elevation: np.ndarray
    distance_km: np.ndarray
    observer_elev_m: float
    max_range_km: float
    source: dict

    def at(self, az_deg: np.ndarray) -> np.ndarray:
        """Horizon elevation at arbitrary azimuths (periodic linear interpolation)."""
        az = np.mod(az_deg, 360.0)
        return np.interp(az, self.azimuth, self.elevation, period=360.0)


def compute_skyline(lat: float, lon: float, n_az: int = 360, max_km: float = 50.0) -> Skyline:
    """Ray-march the LOLA DEM outward along great circles.

    Elevation angle of a terrain sample at ground distance d, including the curvature drop
    Δh = −d² / 2R_moon (no atmosphere → no refraction):
        θ(d) = atan2(h_target(d) − h_observer + Δh(d), d)
    The skyline at each azimuth is max_d θ(d).
    """
    src = elevation_source(lat)
    px = src.pixel_m
    near = np.arange(px, min(10_000.0, max_km * 1000), px / 2)
    far = np.arange(near[-1] + px, max_km * 1000 + 1, px)
    d = np.concatenate([near, far])
    az = np.arange(n_az) * (360.0 / n_az)
    tl, tlon = destination(lat, lon, az[:, None], d[None, :])
    h = src.sample(tl, tlon)
    h0 = float(src.sample(np.array([lat]), np.array([lon]))[0]) + OBSERVER_HEIGHT_M
    theta = np.degrees(np.arctan2(h - h0 - d[None, :] ** 2 / (2 * MOON_R), d[None, :]))
    theta = np.where(np.isnan(theta), -90.0, theta)
    idx = theta.argmax(axis=1)
    el = theta[np.arange(n_az), idx]
    return Skyline(
        azimuth=az,
        elevation=el,
        distance_km=d[idx] / 1000,
        observer_elev_m=h0 - OBSERVER_HEIGHT_M,
        max_range_km=max_km,
        source=tag(f"{src.name} ray-march", f"{src.resolution} · {n_az} rays · 50 km", derived=True, synthetic=src.synthetic),
    )


# ─────────────────────────────── PGDA 5 m Artemis sites ───────────────────────────────

_ds_lock = threading.Lock()


@lru_cache(maxsize=8)
def _open_5m(path: str):
    import rasterio

    return rasterio.open(str(DATA_DIR / path))


def site_5m_for(x: float, y: float) -> tuple[str, dict] | None:
    for site, meta in GridStore.get().sites_5m.items():
        l, b, r, t = meta["bounds"]
        if l + 50 < x < r - 50 and b + 50 < y < t - 50:
            return site, meta
    return None


def slope_roughness_5m(x: float, y: float, meta: dict, half_px: int = 4) -> tuple[float, float] | None:
    """Least-squares plane over a (2·half+1)² window (45 m at 5 m/px) → lander-pad slope and RMS residual."""
    from rasterio.windows import Window

    with _ds_lock:
        ds = _open_5m(meta["path"])
        row, col = ds.index(x, y)
        win = ds.read(1, window=Window(col - half_px, row - half_px, 2 * half_px + 1, 2 * half_px + 1)).astype(np.float64)
        res = abs(ds.transform.a)
    if win.size == 0 or np.isnan(win).mean() > 0.3:
        return None
    yy, xx = np.mgrid[-half_px : half_px + 1, -half_px : half_px + 1] * res
    ok = ~np.isnan(win)
    A = np.column_stack([xx[ok], yy[ok], np.ones(ok.sum())])
    coef, *_ = np.linalg.lstsq(A, win[ok], rcond=None)
    slope = float(np.degrees(np.arctan(np.hypot(coef[0], coef[1]))))
    rough = float(np.sqrt(np.mean((win[ok] - A @ coef) ** 2)))
    return slope, rough


# ─────────────────────────────── point lookups ───────────────────────────────


@dataclass
class TerrainPoint:
    elevation_m: float
    elevation_src: dict
    slope_deg: float
    roughness_m: float
    slope_src: dict
    roughness_src: dict
    roughness_thresholds: tuple[float, float]
    avg_vis: float | None
    earth_vis: float | None
    psr_km: float | None
    psr_src: dict | None
    artemis_site: str | None
    map_x: float
    map_y: float


def terrain_at(lat: float, lon: float) -> TerrainPoint:
    store = GridStore.get()
    x, y = stereo_forward(lat, lon)
    x, y = float(x), float(y)
    polar = store.ldem.contains(x, y, margin_px=2)
    if polar:
        elev = store.ldem.sample(x, y)
        e_src = tag(store.ldem.source["source_name"], store.ldem.source["resolution"], synthetic=bool(store.ldem.source.get("is_synthetic_fallback")))
        slope = store.slope.sample(x, y)
        rough = store.roughness.sample(x, y)
        s_src = {k: store.slope.source[k] for k in ("source_name", "resolution", "is_derived", "is_synthetic_fallback")}
        r_src = {k: store.roughness.source[k] for k in ("source_name", "resolution", "is_derived", "is_synthetic_fallback")}
        r_thr = (40.0, 80.0)  # 3×3 (720 m) std at 240 m/px; ~10° of tilt alone gives ≈40 m
    else:
        g = GlobalLdem16(store)
        elev = float(g.sample(np.array([lat]), np.array([lon]))[0])
        e_src = tag("LOLA LDEM_16", "16 ppd (≈1.9 km/px)")
        d = 1895.0
        nb = g.sample(np.array([lat, lat, *destination(lat, lon, np.array([0.0, 90.0]), np.array([d, d]))[0]]),
                      np.array([lon, lon, *destination(lat, lon, np.array([0.0, 90.0]), np.array([d, d]))[1]]))
        slope = float(np.degrees(np.arctan(np.hypot(nb[2] - nb[0], nb[3] - nb[1]) / d)))
        lats, lons = destination(lat, lon, np.arange(0, 360, 45.0), np.full(8, d))
        ring = g.sample(lats, lons)
        rough = float(np.std(np.concatenate([[elev], ring])))
        s_src = tag("LOLA LDEM_16 (finite difference)", "≈1.9 km baseline", derived=True)
        r_src = tag("LOLA LDEM_16 (3×3 RMS)", "≈5.7 km window", derived=True)
        r_thr = (150.0, 300.0)

    artemis = None
    hit = site_5m_for(x, y)
    if hit:
        site, meta = hit
        fine = slope_roughness_5m(x, y, meta)
        artemis = f"{meta['region']} (PGDA {site})"
        if fine:
            slope, rough = fine
            s_src = tag(f"PGDA LOLA 5m/px GeoTIFF {site} (plane fit)", "5 m/px · 45 m pad", derived=True)
            r_src = tag(f"PGDA LOLA 5m/px GeoTIFF {site} (RMS residual)", "5 m/px · 45 m pad", derived=True)
            r_thr = (0.5, 1.0)

    def opt(grid):
        return grid.sample(x, y) if grid is not None and grid.contains(x, y) else None

    psr_km = opt(store.psr_distance)
    psr_src = None
    if psr_km is not None:
        psr_src = {k: store.psr_distance.source[k] for k in ("source_name", "resolution", "is_derived", "is_synthetic_fallback")}
    return TerrainPoint(
        elevation_m=float(elev), elevation_src=e_src, slope_deg=float(slope), roughness_m=float(rough),
        slope_src=s_src, roughness_src=r_src, roughness_thresholds=r_thr,
        avg_vis=opt(store.avg_vis), earth_vis=opt(store.earth_vis), psr_km=psr_km, psr_src=psr_src,
        artemis_site=artemis, map_x=x, map_y=y,
    )


def heightmap_paths() -> tuple[Path, Path]:
    p = DATA_DIR / "processed"
    return p / "polar_heightmap.png", p / "polar_heightmap.json"


# ─────────────────────────────── slope / roughness statistics (Expert card) ───────────────────────────────


def _plane_rms(z: np.ndarray, xx: np.ndarray, yy: np.ndarray, mask: np.ndarray) -> tuple[float, float]:
    """Least-squares plane z = a·x + b·y + c over `mask` → (plane slope °, RMS residual m)."""
    ok = mask & np.isfinite(z)
    A = np.column_stack([xx[ok], yy[ok], np.ones(ok.sum())])
    coef, *_ = np.linalg.lstsq(A, z[ok], rcond=None)
    return float(np.degrees(np.arctan(np.hypot(coef[0], coef[1])))), float(np.sqrt(np.mean((z[ok] - A @ coef) ** 2)))


def slope_stats(lat: float, lon: float, radius_m: float) -> dict:
    """
    Slope and roughness around a pad from the best LOLA DEM available:
      • PGDA 5 m/px site product (Site01/04/07) where it covers the point;
      • otherwise the 240 m/px polar LDEM, with the radius widened to ≥ 1.5 px so it spans neighbours.
    Per-pixel slope = arctan |∇z| (central differences); roughness = RMS height deviation from the
    best-fit plane over the disc.
    """
    x, y = (float(v) for v in stereo_forward(lat, lon))
    hit = site_5m_for(x, y)
    if hit is not None:
        from rasterio.windows import Window

        site, meta = hit
        with _ds_lock:
            ds = _open_5m(meta["path"])
            res = abs(ds.transform.a)
            half = int(np.ceil(radius_m / res)) + 1
            row, col = ds.index(x, y)
            z = ds.read(1, window=Window(col - half, row - half, 2 * half + 1, 2 * half + 1)).astype(np.float64)
        eff_r = radius_m
        src = tag(f"PGDA LOLA 5m/px GeoTIFF {site}", f"5 m/px · r = {radius_m:g} m", derived=True)
    else:
        store = GridStore.get()
        res = store.ldem.pixel_m
        eff_r = max(radius_m, 1.5 * res)
        half = int(np.ceil(eff_r / res)) + 1
        z, *_ = store.ldem.window(x, y, half)
        z = z.astype(np.float64)
        src = tag(store.ldem.source["source_name"], f"{res:g} m/px · r widened to {eff_r:g} m", derived=True,
                  synthetic=bool(store.ldem.source.get("is_synthetic_fallback")))
    n = z.shape[0]
    c = n // 2
    yy, xx = (np.mgrid[0:n, 0:z.shape[1]] - c) * res
    yy = -yy  # rows grow southward in the raster
    gy, gx = np.gradient(z, res)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    disc = (np.hypot(xx, yy) <= eff_r) & np.isfinite(slope)
    at_point = float(slope[c, c]) if np.isfinite(slope[c, c]) else float(np.nanmean(slope[disc]))
    _, rms = _plane_rms(z, xx, yy, disc)
    return {
        "lat": lat, "lon": lon, "requested_radius_m": radius_m, "effective_radius_m": eff_r, "pixel_m": res,
        "n_pixels": int(disc.sum()), "slope_at_point_deg": at_point,
        "mean_slope_deg": float(np.nanmean(slope[disc])), "max_slope_deg": float(np.nanmax(slope[disc])),
        "roughness_rms_m": rms, "source": src,
    }
