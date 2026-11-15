"""
Permanently-shadowed-region (PSR) landing guard.

PSRs (PGDA LPSR_65S_240M, with its Euclidean distance transform) never see sunlight: no solar
power, ~40 K ground, and steep shadowed walls at their rims. A landing pad must be outside every
PSR and at least PSR_BUFFER_M from its edge.

`psr_check` reports whether a point is safe and, if not, finds the nearest safe pad: outside the
buffer, slope ≤ 10° (LOLA), and with some long-term sunlight (PGDA average Sun visibility), falling
back to looser sunlight / slope limits only if nothing within SEARCH_KM qualifies.
"""

from __future__ import annotations

import numpy as np

from .cache import GridStore
from .terrain import great_circle_km, initial_bearing, stereo_forward, stereo_inverse

PSR_BUFFER_M = 500.0
SEARCH_KM = 40.0
_MARGIN_KM = 0.15  # stay a little beyond the buffer so bilinear sampling at the pad still clears it


def _grids_ready() -> bool:
    g = GridStore.get()
    return g.psr is not None and g.psr_distance is not None


def psr_status(lat: float, lon: float) -> tuple[bool, float | None, bool]:
    """(inside a PSR, distance to the nearest PSR in km, covered by the PSR map)."""
    if not _grids_ready():
        return False, None, False
    g = GridStore.get()
    x, y = (float(v) for v in stereo_forward(lat, lon))
    if not g.psr.contains(x, y, margin_px=2):
        return False, None, False
    r, c = (int(round(float(v))) for v in g.psr.rc(x, y))
    inside = bool(g.psr.data[r, c] >= 0.5)
    dist = 0.0 if inside else float(g.psr_distance.sample(x, y))
    return inside, dist, True


def psr_buffer_mask(x: float, y: float, half_px: int) -> tuple[np.ndarray, int, int] | None:
    """Window of 'far enough from any PSR' (True = allowed) on the 65°S PGDA grid."""
    if not _grids_ready():
        return None
    g = GridStore.get()
    d, r0, c0 = g.psr_distance.window(x, y, half_px)
    p, *_ = g.psr.window(x, y, half_px)
    n, m = min(d.shape[0], p.shape[0]), min(d.shape[1], p.shape[1])
    ok = (p[:n, :m] < 0.5) & (d[:n, :m] >= PSR_BUFFER_M / 1000 + _MARGIN_KM)
    return ok, r0, c0


def psr_check(lat: float, lon: float, buffer_m: float = PSR_BUFFER_M) -> dict:
    lon = (lon + 180.0) % 360.0 - 180.0
    inside, dist, covered = psr_status(lat, lon)
    safe = (not covered) or (not inside and dist is not None and dist * 1000 >= buffer_m)
    out = {
        "lat": lat, "lon": lon, "covered": covered, "in_psr": inside, "psr_distance_km": dist,
        "buffer_m": buffer_m, "safe": safe, "nearest_safe": None,
        "source": "PGDA LPSR_65S_240M (PSR mask + distance transform), LOLA slope, PGDA average Sun visibility",
    }
    if safe:
        return out

    g = GridStore.get()
    x, y = (float(v) for v in stereo_forward(lat, lon))
    half = int(np.ceil(SEARCH_KM * 1000 / g.psr.pixel_m))
    d, r0, c0 = g.psr_distance.window(x, y, half)
    p, *_ = g.psr.window(x, y, half)
    av, *_ = g.avg_vis.window(x, y, half) if g.avg_vis is not None else (np.ones_like(d), 0, 0)
    have_slope = g.slope.contains(x, y, margin_px=half + 2)
    sl = g.slope.window(x, y, half)[0] if have_slope else np.zeros_like(d)
    n = min(a.shape[0] for a in (d, p, av, sl))
    m = min(a.shape[1] for a in (d, p, av, sl))
    d, p, av, sl = d[:n, :m], p[:n, :m], av[:n, :m], sl[:n, :m]
    rr, cc = np.mgrid[0:n, 0:m]
    px, py = g.psr.xy(rr + r0, cc + c0)
    dist_km = np.hypot(px - x, py - y) / 1000.0
    clear = (p < 0.5) & (d >= buffer_m / 1000 + _MARGIN_KM) & (dist_km <= SEARCH_KM)

    choice = None
    for min_sun, max_slope in ((0.2, 10.0), (0.05, 10.0), (0.0, 15.0), (0.0, 90.0)):
        ok = clear & (av >= min_sun) & (sl <= max_slope)
        if ok.any():
            # nearest qualifying pixel; ties broken toward more long-term sunlight
            score = np.where(ok, dist_km - 0.05 * av, np.inf)
            k = int(np.argmin(score))
            choice = (k, min_sun, max_slope)
            break
    if choice is None:
        return out
    k, min_sun, max_slope = choice
    r, c = divmod(k, m)
    la, lo = (float(v) for v in stereo_inverse(px[r, c], py[r, c]))
    out["nearest_safe"] = {
        "lat": la, "lon": lo,
        "distance_km": great_circle_km(lat, lon, la, lo), "bearing_deg": initial_bearing(lat, lon, la, lo),
        "psr_distance_km": float(d[r, c]), "slope_deg": float(sl[r, c]) if have_slope else None,
        "avg_sun_visibility_pct": float(av[r, c] * 100),
        "criteria": f"outside PSR + {buffer_m:g} m buffer, slope ≤ {max_slope:g}°, average sunlight ≥ {min_sun * 100:g}%",
    }
    return out
