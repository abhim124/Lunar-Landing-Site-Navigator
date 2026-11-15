"""
Contingency re-assessment: "we have a fuel leak — is this pad still OK, and if not, where do we go?"

The caller (CAPCOM) turns a reported anomaly into hard constraints: a divert radius the crippled
vehicle can still reach, a slope ceiling, and floors/ceilings on sunlight, Earth contact and the
longest night. This module

  1. scores the current pad against those constraints with the same DE421 + LOLA skyline pipeline
     the verdict card uses, and
  2. if the pad fails, runs the optimizer's Stage 1 grid scan inside the divert radius (slope capped
     at the anomaly's ceiling, weights tilted toward the metric the anomaly threatens), then Stage 2
     ephemeris checks on every candidate, and returns the best pad that meets every constraint — or,
     if none does, the one that misses them by the least.
"""

from __future__ import annotations

import time

import numpy as np

from .ephemeris import parse_utc
from .optimizer import _evaluate_pad, _stage1_global, _stage1_polar
from .cache import GridStore
from .terrain import great_circle_km, initial_bearing, stereo_forward, tag

# Stage-1 weights (sun visibility, Earth visibility, slope penalty) and Stage-2 ranking weights
# (sunlit, earth, short darkness, flatness) for each priority.
STAGE1_WEIGHTS = {
    "slope": (0.25, 0.20, 0.55),
    "sunlight": (0.75, 0.15, 0.10),
    "darkness": (0.70, 0.15, 0.15),
    "earth": (0.20, 0.70, 0.10),
    "balanced": (0.55, 0.35, 0.10),
}
RANK_WEIGHTS = {
    "slope": (0.20, 0.15, 0.10, 0.55),
    "sunlight": (0.55, 0.15, 0.20, 0.10),
    "darkness": (0.30, 0.15, 0.45, 0.10),
    "earth": (0.15, 0.60, 0.10, 0.15),
    "balanced": (0.40, 0.30, 0.15, 0.15),
}
N_CANDIDATES = 14


def _checks(slope: float, wm, req) -> list[dict]:
    return [
        {"key": "slope", "label": "Slope", "value": slope, "limit": req.max_slope_deg, "unit": "°", "kind": "max",
         "ok": slope <= req.max_slope_deg},
        {"key": "sunlit", "label": "Sunlit", "value": wm.sunlit_pct, "limit": req.min_sunlit_pct, "unit": "%", "kind": "min",
         "ok": wm.sunlit_pct >= req.min_sunlit_pct},
        {"key": "darkness", "label": "Longest night", "value": wm.longest_dark_h, "limit": req.max_darkness_hours, "unit": "h",
         "kind": "max", "ok": wm.longest_dark_h <= req.max_darkness_hours},
        {"key": "earth", "label": "Earth contact", "value": wm.earth_contact_pct, "limit": req.min_earth_contact_pct, "unit": "%",
         "kind": "min", "ok": wm.earth_contact_pct >= req.min_earth_contact_pct},
    ]


def _shortfall(checks: list[dict]) -> float:
    """How badly a pad misses its constraints, normalised per metric (0 = meets all)."""
    scale = {"slope": 5.0, "sunlit": 20.0, "darkness": 48.0, "earth": 20.0}
    total = 0.0
    for c in checks:
        if c["ok"]:
            continue
        gap = (c["value"] - c["limit"]) if c["kind"] == "max" else (c["limit"] - c["value"])
        total += max(gap, 0.0) / scale[c["key"]]
    return total


def _rank(slope: float, wm, window_h: float, dist_km: float, req) -> float:
    ws, we, wd, wf = RANK_WEIGHTS[req.priority]
    score = (ws * wm.sunlit_pct / 100 + we * wm.earth_contact_pct / 100
             + wd * (1 - min(wm.longest_dark_h / max(window_h, 1), 1)) + wf * (1 - min(slope / 15.0, 1)))
    return score - 0.08 * dist_km / max(req.max_divert_km, 0.1)  # a crippled vehicle prefers the shorter divert


def _pad(lat, lon, tp, wm, status, checks) -> dict:
    return {"lat": lat, "lon": lon, "slope_deg": tp.slope_deg, "sunlit_pct": wm.sunlit_pct,
            "earth_contact_pct": wm.earth_contact_pct, "longest_darkness_hours": wm.longest_dark_h,
            "status": status, "checks": checks, "meets_all": all(c["ok"] for c in checks)}


def assess_contingency(req) -> dict:
    t0 = time.perf_counter()
    lat = float(req.lat)
    lon = (float(req.lon) + 180.0) % 360.0 - 180.0
    start = parse_utc(req.epoch_utc)
    step_h = 0.5
    window_h = req.mission_duration_days * 24
    hours = np.arange(0.0, window_h + 1e-9, step_h)
    min_el = req.min_earth_elevation_deg

    tp, wm, status = _evaluate_pad(lat, lon, start, hours, step_h, min_el, n_az=360)
    base_checks = _checks(tp.slope_deg, wm, req)
    baseline = _pad(lat, lon, tp, wm, status, base_checks)
    viable = baseline["meets_all"]

    out = {
        "anomaly": req.anomaly,
        "viable": viable,
        "failed": [c["label"] for c in base_checks if not c["ok"]],
        "baseline": baseline,
        "relocation": None,
        "relocation_meets_all": False,
        "candidates_evaluated": 0,
        "search_radius_km": req.max_divert_km,
        "note": "",
        "source": None,
        "computed_in_ms": 0.0,
    }
    if viable:
        out["note"] = "Current pad meets every constraint for this anomaly."
    elif not req.allow_relocation:
        out["note"] = "Current pad fails the anomaly constraints; relocation is not possible in this phase."
    else:
        store = GridStore.get()
        x, y = (float(v) for v in stereo_forward(lat, lon))
        polar = store.avg_vis is not None and store.avg_vis.contains(x, y, margin_px=120) and store.slope.contains(x, y, margin_px=120)
        if polar:
            picks, *_ = _stage1_polar(lat, lon, req.max_divert_km, max_slope=req.max_slope_deg,
                                      weights=STAGE1_WEIGHTS[req.priority], top_k=N_CANDIDATES)
        else:
            picks, *_ = _stage1_global(lat, lon, req.max_divert_km, max_slope=req.max_slope_deg, top_k=N_CANDIDATES)

        base_short = _shortfall(base_checks)
        best = None  # (meets_all, -shortfall, rank, pad)
        for la, lo in picks:
            ctp, cwm, cstatus = _evaluate_pad(la, lo, start, hours, step_h, min_el)
            out["candidates_evaluated"] += 1
            dist = great_circle_km(lat, lon, la, lo)
            if dist > req.max_divert_km + 0.05:
                continue
            checks = _checks(ctp.slope_deg, cwm, req)
            short = _shortfall(checks)
            if short >= base_short - 1e-6:
                continue  # not an improvement on the pad we already have
            key = (short == 0.0, -short, _rank(ctp.slope_deg, cwm, window_h, dist, req))
            if best is None or key > best[0]:
                pad = _pad(la, lo, ctp, cwm, cstatus, checks)
                pad.update(distance_km=dist, bearing_deg=initial_bearing(lat, lon, la, lo))
                best = (key, pad)

        if best:
            out["relocation"] = best[1]
            out["relocation_meets_all"] = best[1]["meets_all"]
            out["note"] = ("Found a pad inside the divert radius that meets every constraint." if best[1]["meets_all"]
                           else "No pad inside the divert radius meets every constraint; this one misses them by the least.")
        else:
            out["note"] = f"No pad within {req.max_divert_km:g} km improves on the current one for this anomaly."
        out["source"] = tag(
            "PGDA avg_vis + earth_vis + LOLA slope → DE421 skyline check" if polar else "LOLA LDEM_16 slope → DE421 skyline check",
            f"{'240 m/px' if polar else '1.9 km/px'} · ≤{req.max_divert_km:g} km divert", derived=True,
        )
    out["computed_in_ms"] = (time.perf_counter() - t0) * 1000
    return out
