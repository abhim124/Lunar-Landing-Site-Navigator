"""
"Best landing spot at the south pole on date X" — a whole-region search.

Stage 1 (static, vectorised): over every 960 m cell poleward of MAX_LAT (LOLA slope + PGDA average
Sun / Earth visibility + PSR, co-registered on the 240 m polar stereographic grid), keep cells with
slope ≤ 10° outside permanent shadow, score them on long-term illumination and Earth visibility, and
take the top N with non-maximum suppression so candidates spread across the pole. The 14 Artemis III
candidate-region centres are always added.

Stage 2 (date-specific): every candidate gets its own LOLA skyline and the DE421 Sun/Earth ephemeris
over the actual mission window (the same pipeline as the verdict card). Rank by verdict, then by the
composite window score. The winner is refined with a local Stage-1/Stage-2 pass inside 3 km.
"""

from __future__ import annotations

import time

import numpy as np

from .cache import GridStore
from .ephemeris import iso_z, parse_utc
from .evaluation import ORDER
from .optimizer import _composite, _evaluate_pad, _stage1_polar
from .registry import ARTEMIS_III
from .terrain import great_circle_km, stereo_forward, stereo_inverse

MAX_LAT = -80.0  # "south pole" search region
STRIDE = 4  # 240 m grid → 960 m cells for the coarse scan
N_GLOBAL = 36
NMS_KM = 12.0
REFINE_KM = 3.0


def _global_candidates(n: int) -> list[tuple[float, float]]:
    g = GridStore.get()
    sl = g.slope
    sub = np.asarray(sl.data[::STRIDE, ::STRIDE], dtype=np.float32)
    rr, cc = np.mgrid[0 : sl.data.shape[0] : STRIDE, 0 : sl.data.shape[1] : STRIDE]
    x, y = sl.xy(rr, cc)
    # same physical points on the PGDA grids (different pixel offset)
    vr, vc = g.avg_vis.rc(x, y)
    vr = np.clip(np.round(vr).astype(int), 0, g.avg_vis.data.shape[0] - 1)
    vc = np.clip(np.round(vc).astype(int), 0, g.avg_vis.data.shape[1] - 1)
    av = np.asarray(g.avg_vis.data[vr, vc], dtype=np.float32)
    ev = np.asarray(g.earth_vis.data[vr, vc], dtype=np.float32)
    ps = np.asarray(g.psr.data[vr, vc], dtype=np.float32)

    # radius of MAX_LAT on the stereographic plane
    rmax = float(np.hypot(*stereo_forward(MAX_LAT, 0.0)))
    inside = np.hypot(x, y) <= rmax
    ok = inside & np.isfinite(sub) & (sub <= 10.0) & (ps < 0.5) & np.isfinite(av) & np.isfinite(ev)
    score = np.where(ok, 0.55 * av + 0.35 * ev - 0.10 * sub / 15.0, -np.inf)

    flat = np.argsort(score, axis=None)[::-1]
    picks: list[tuple[float, float]] = []
    pxy: list[tuple[float, float]] = []
    for f in flat[: 20000]:
        if not np.isfinite(score.flat[f]) or len(picks) >= n:
            break
        px, py = float(x.flat[f]), float(y.flat[f])
        if any((px - qx) ** 2 + (py - qy) ** 2 < (NMS_KM * 1000) ** 2 for qx, qy in pxy):
            continue
        pxy.append((px, py))
        la, lo = stereo_inverse(px, py)
        picks.append((float(la), float(lo)))
    return picks


def _nearest_region(lat: float, lon: float) -> tuple[str, float]:
    best = min(ARTEMIS_III, key=lambda a: great_circle_km(lat, lon, a["lat"], a["lon"]))
    return best["name"], great_circle_km(lat, lon, best["lat"], best["lon"])


def best_site(epoch_utc: str, mission_days: float, min_el: float, top: int = 5) -> dict:
    t0 = time.perf_counter()
    start = parse_utc(epoch_utc)
    step_h = 0.5
    window_h = mission_days * 24
    hours = np.arange(0.0, window_h + 1e-9, step_h)

    cands = [(c, None) for c in _global_candidates(N_GLOBAL)] + [((a["lat"], a["lon"]), a["name"]) for a in ARTEMIS_III]
    t1 = time.perf_counter()

    scored = []
    for (la, lo), name in cands:
        tp, wm, status = _evaluate_pad(la, lo, start, hours, step_h, min_el)
        scored.append({"lat": la, "lon": lo, "region": name, "tp": tp, "wm": wm, "status": status,
                       "score": _composite(wm, tp.slope_deg, window_h)})
    # verdict first, then window score; ties (several pads at 100 % sun / 100 % Earth) go to the flattest pad
    scored.sort(key=lambda s: (-ORDER[s["status"]], round(s["score"], 3), -s["tp"].slope_deg), reverse=True)
    t2 = time.perf_counter()

    # refine the winner inside REFINE_KM
    win = scored[0]
    picks, *_ = _stage1_polar(win["lat"], win["lon"], REFINE_KM, top_k=8)
    for la, lo in picks:
        tp, wm, status = _evaluate_pad(la, lo, start, hours, step_h, min_el)
        sc = _composite(wm, tp.slope_deg, window_h)
        if (-ORDER[status], sc) > (-ORDER[win["status"]], win["score"] + 1e-3):
            win = {"lat": la, "lon": lo, "region": win["region"], "tp": tp, "wm": wm, "status": status, "score": sc}
    scored[0] = win

    def out(s: dict) -> dict:
        region, dist = _nearest_region(s["lat"], s["lon"])
        wm, tp = s["wm"], s["tp"]
        return {
            "lat": s["lat"], "lon": s["lon"], "status": s["status"], "score": round(s["score"], 4),
            "sunlit_pct": wm.sunlit_pct, "earth_contact_pct": wm.earth_contact_pct, "longest_darkness_hours": wm.longest_dark_h,
            "slope_deg": tp.slope_deg, "elevation_m": tp.elevation_m,
            "nearest_region": region, "nearest_region_km": dist, "is_region_centre": s["region"] is not None and dist < 0.5,
        }

    # de-duplicate the shortlist (refined winner can sit next to a runner-up)
    shortlist: list[dict] = []
    for s in scored:
        if all(great_circle_km(s["lat"], s["lon"], o["lat"], o["lon"]) > 3 for o in shortlist):
            shortlist.append(s)
        if len(shortlist) >= top:
            break

    counts = {"GO": 0, "MARGINAL": 0, "NO-GO": 0}
    for s in scored:
        counts[s["status"]] += 1
    return {
        "epoch_utc": iso_z(start), "mission_duration_days": mission_days, "min_earth_elevation_deg": min_el,
        "search_region": f"south pole, poleward of {abs(MAX_LAT):g}°S",
        "best": out(shortlist[0]), "runners_up": [out(s) for s in shortlist[1:]],
        "candidates_evaluated": len(cands) + len(picks), "verdict_counts": counts,
        "stage1_ms": (t1 - t0) * 1000, "stage2_ms": (t2 - t1) * 1000, "computed_in_ms": (time.perf_counter() - t0) * 1000,
    }
