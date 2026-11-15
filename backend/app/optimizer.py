"""
"Nearest Viable Alternative" — 2-stage coarse-to-fine recommender.

Stage 1 (coarse, spatial, vectorised NumPy): over a 55 km box around the target, mask the
co-registered 240 m grids — PGDA average Sun visibility, PGDA average Earth visibility, LOLA
np.gradient slope, PGDA PSR — keep pixels within the search radius with slope ≤ 10° and not
in permanent shadow, score them, and keep the top 10 with non-maximum suppression.

Stage 2 (fine, temporal, Skyfield): for each candidate, ray-march its own LOLA skyline and run
the DE421 Sun/Earth ephemeris across the actual mission window → best nearby pad. Separately,
slide the mission window over ±N days at the original pad (one hourly ephemeris pass) → best
launch date.
"""

from __future__ import annotations

import time
from datetime import timedelta

import numpy as np

from .cache import GridStore
from .ephemeris import SPICE_SOURCE, EphemerisEngine, iso_z, parse_utc
from .evaluation import ORDER, grade, visibility, window_metrics, worst
from .terrain import (
    OBSERVER_HEIGHT_M,
    compute_skyline,
    destination,
    great_circle_km,
    initial_bearing,
    stereo_forward,
    stereo_inverse,
    tag,
    terrain_at,
)

BOX_KM = 55.0
TOP_K = 10


def _composite(wm, slope: float, window_h: float) -> float:
    return wm.score(window_h) - 0.15 * max(0.0, slope - 5.0) / 10.0


def _evaluate_pad(lat: float, lon: float, start, hours: np.ndarray, step_h: float, min_el: float, n_az: int = 180):
    tp = terrain_at(lat, lon)
    sky = compute_skyline(lat, lon, n_az=n_az)
    topo = EphemerisEngine.get().topocentric(lat, lon, sky.observer_elev_m + OBSERVER_HEIGHT_M, start, hours)
    frac, earth_ok, *_ = visibility(topo, sky, min_el)
    wm = window_metrics(frac, earth_ok, step_h)
    st = wm.statuses()
    status = worst(st["sunlit"], st["darkness"], st["earth"], grade(tp.slope_deg, 10, 15, False))
    return tp, wm, status


def _stage1_polar(lat: float, lon: float, radius_km: float, max_slope: float = 10.0,
                  weights: tuple[float, float, float] = (0.55, 0.35, 0.10), top_k: int = TOP_K):
    store = GridStore.get()
    x, y = (float(v) for v in stereo_forward(lat, lon))
    half = int(round(BOX_KM / 2 * 1000 / store.ldem.pixel_m))
    av, r0, c0 = store.avg_vis.window(x, y, half)
    ev, *_ = store.earth_vis.window(x, y, half)
    ps, *_ = store.psr.window(x, y, half)
    sl, *_ = store.slope.window(x, y, half)
    n = min(av.shape[0], ev.shape[0], ps.shape[0], sl.shape[0])
    m = min(av.shape[1], ev.shape[1], ps.shape[1], sl.shape[1])
    av, ev, ps, sl = av[:n, :m], ev[:n, :m], ps[:n, :m], sl[:n, :m]
    rr, cc = np.mgrid[0:n, 0:m]
    px, py = store.avg_vis.xy(rr + r0, cc + c0)
    dist_km = np.hypot(px - x, py - y) / 1000.0
    mask = (dist_km <= radius_km) & (dist_km > 0.12) & (sl <= max_slope) & (ps < 0.5)
    w_sun, w_earth, w_slope = weights
    score = np.where(mask, w_sun * av + w_earth * ev - w_slope * sl / 15.0, -np.inf)
    picks: list[tuple[float, float]] = []
    order = np.argsort(score, axis=None)[::-1]
    taken = np.zeros_like(mask)
    for flat in order:
        if not np.isfinite(score.flat[flat]) or len(picks) >= top_k:
            break
        r, c = divmod(int(flat), m)
        if taken[max(0, r - 2) : r + 3, max(0, c - 2) : c + 3].any():
            continue
        taken[r, c] = True
        la, lo = stereo_inverse(px[r, c], py[r, c])
        picks.append((float(la), float(lo)))
    return picks, int(n * m), BOX_KM


def _stage1_global(lat: float, lon: float, radius_km: float, max_slope: float = 90.0, top_k: int = TOP_K):
    """Outside PGDA coverage: candidate rings scored by LOLA LDEM_16 slope only."""
    bearings = np.arange(0, 360, 30.0)
    dists = np.array([0.25, 0.5, 0.75, 1.0]) * radius_km * 1000
    la, lo = destination(lat, lon, bearings[:, None], dists[None, :])
    cands = list(zip(la.ravel().tolist(), lo.ravel().tolist()))
    slopes = {p: terrain_at(*p).slope_deg for p in cands}
    scored = sorted((p for p in cands if slopes[p] <= max_slope), key=slopes.__getitem__)[:top_k]
    return scored, len(cands), 2 * radius_km


def nearest_alternative(req) -> dict:
    t_start = time.perf_counter()
    lat = float(req.lat)
    lon = (float(req.lon) + 180.0) % 360.0 - 180.0
    start = parse_utc(req.epoch_utc)
    step_h = 0.5
    window_h = req.mission_duration_days * 24
    hours = np.arange(0.0, window_h + 1e-9, step_h)
    min_el = req.min_earth_elevation_deg

    base_tp, base_wm, base_status = _evaluate_pad(lat, lon, start, hours, step_h, min_el, n_az=360)
    base_comp = _composite(base_wm, base_tp.slope_deg, window_h)
    bst = base_wm.statuses()
    triggers = [k for k, v in {"sunlight": bst["sunlit"], "darkness": bst["darkness"], "earth contact": bst["earth"],
                               "slope": grade(base_tp.slope_deg, 10, 15, False)}.items() if v != "GO"]

    # ── Stage 1 ──
    t1 = time.perf_counter()
    store = GridStore.get()
    x, y = (float(v) for v in stereo_forward(lat, lon))
    polar = store.avg_vis is not None and store.avg_vis.contains(x, y, margin_px=120) and store.slope.contains(x, y, margin_px=120)
    picks, scanned, box_km = _stage1_polar(lat, lon, req.search_radius_km) if polar else _stage1_global(lat, lon, req.search_radius_km)
    stage1_ms = (time.perf_counter() - t1) * 1000

    # ── Stage 2a: candidate pads over the real mission window ──
    t2 = time.perf_counter()
    evals = 0
    best_site = None
    best_comp = base_comp
    for la, lo in picks:
        tp, wm, status = _evaluate_pad(la, lo, start, hours, step_h, min_el)
        evals += len(hours)
        comp = _composite(wm, tp.slope_deg, window_h)
        if comp > best_comp + 1e-3 and tp.slope_deg <= 15:
            best_comp = comp
            best_site = (la, lo, tp, wm, status)

    site_opt = None
    if best_site:
        la, lo, tp, wm, status = best_site
        gains = []
        if wm.sunlit_pct - base_wm.sunlit_pct > 1:
            gains.append(f"+{wm.sunlit_pct - base_wm.sunlit_pct:.0f} pt sunlight")
        if base_wm.earth_contact_pct - wm.earth_contact_pct < -1:
            gains.append(f"+{wm.earth_contact_pct - base_wm.earth_contact_pct:.0f} pt Earth contact")
        if base_tp.slope_deg - tp.slope_deg > 0.5:
            gains.append(f"{base_tp.slope_deg - tp.slope_deg:.1f}° flatter")
        if base_wm.longest_dark_h - wm.longest_dark_h > 1:
            gains.append(f"{base_wm.longest_dark_h - wm.longest_dark_h:.0f} h shorter night")
        site_opt = {
            "lat": la, "lon": lo, "distance_km": great_circle_km(lat, lon, la, lo), "bearing_deg": initial_bearing(lat, lon, la, lo),
            "slope_deg": tp.slope_deg, "sunlit_pct": wm.sunlit_pct, "earth_contact_pct": wm.earth_contact_pct,
            "longest_darkness_hours": wm.longest_dark_h, "rock_abundance_pct": None, "status": status,
            "summary": ", ".join(gains) or "Marginally better composite score",
            "source": tag("PGDA avg_vis + earth_vis + LOLA slope → DE421 skyline check" if polar else "LOLA LDEM_16 slope → DE421 skyline check",
                          "240 m/px · 2-stage" if polar else "1.9 km/px · 2-stage", derived=True),
        }

    # ── Stage 2b: slide the launch window ±N days at the original pad ──
    W = req.date_window_days
    sky = compute_skyline(lat, lon, n_az=360)
    long_hours = np.arange(-W * 24, W * 24 + window_h + 1e-9, 1.0)
    topo = EphemerisEngine.get().topocentric(lat, lon, sky.observer_elev_m + OBSERVER_HEIGHT_M, start, long_hours)
    frac, earth_ok, *_ = visibility(topo, sky, min_el)
    evals += len(long_hours)
    win = int(round(window_h))
    base_window = window_metrics(frac[int(W * 24) : int(W * 24) + win + 1], earth_ok[int(W * 24) : int(W * 24) + win + 1], 1.0)
    base_date_comp = base_window.score(window_h)
    slope_status = grade(base_tp.slope_deg, 10, 15, False)

    def date_status(wm) -> str:
        st = wm.statuses()
        return worst(st["sunlit"], st["darkness"], st["earth"], slope_status)

    # Rank by verdict first (GO beats MARGINAL beats NO-GO), then by composite score;
    # ties prefer the smallest slip from the planned epoch.
    base_key = (-ORDER[date_status(base_window)], base_date_comp)
    best_date = None
    for off_h in range(0, int(2 * W * 24) + 1, 3):
        wm = window_metrics(frac[off_h : off_h + win + 1], earth_ok[off_h : off_h + win + 1], 1.0)
        comp = wm.score(window_h)
        key = (-ORDER[date_status(wm)], comp, -abs(off_h - W * 24))
        if key[:2] > (base_key[0], base_key[1] + 0.01) and (best_date is None or key > best_date[0]):
            best_date = (key, off_h - W * 24, wm)
    date_opt = None
    if best_date:
        _, off, wm = best_date
        status = date_status(wm)
        parts = []
        if wm.sunlit_pct - base_window.sunlit_pct > 1:
            parts.append(f"+{wm.sunlit_pct - base_window.sunlit_pct:.0f} pt sunlight")
        if wm.earth_contact_pct - base_window.earth_contact_pct > 1:
            parts.append(f"+{wm.earth_contact_pct - base_window.earth_contact_pct:.0f} pt Earth contact")
        if base_window.longest_dark_h - wm.longest_dark_h > 1:
            parts.append(f"{base_window.longest_dark_h - wm.longest_dark_h:.0f} h shorter longest night")
        date_opt = {
            "epoch_utc": iso_z(start + timedelta(hours=float(off))), "offset_days": off / 24.0,
            "sunlit_pct": wm.sunlit_pct, "earth_contact_pct": wm.earth_contact_pct, "longest_darkness_hours": wm.longest_dark_h,
            "status": status, "summary": ", ".join(parts) or "Better composite illumination/comms score",
            "source": {**SPICE_SOURCE, "source_name": "NAIF DE421 SPICE + LOLA skyline", "resolution": f"1 h · ±{W:g} d · 3 h stride", "is_derived": True},
        }
    stage2_ms = (time.perf_counter() - t2) * 1000

    return {
        "query": {"lat": lat, "lon": lon, "epoch_utc": iso_z(start)},
        "trigger_reasons": triggers,
        "baseline": {"status": base_status, "sunlit_pct": base_wm.sunlit_pct, "slope_deg": base_tp.slope_deg,
                     "earth_contact_pct": base_wm.earth_contact_pct, "longest_darkness_hours": base_wm.longest_dark_h},
        "best_nearby_site": site_opt,
        "best_launch_date": date_opt,
        "stats": {"stage1_pixels_scanned": scanned, "stage1_candidates_kept": len(picks), "stage1_bbox_km": box_km,
                  "stage1_ms": stage1_ms, "stage2_epochs_evaluated": evals, "stage2_ms": stage2_ms},
        "computed_in_ms": (time.perf_counter() - t_start) * 1000,
    }
