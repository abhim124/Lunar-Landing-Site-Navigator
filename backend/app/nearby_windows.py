"""
Scenario comparison: nearby pads ranked by their whole launch calendar, not just today's window.

For the selected pad and up to N_CANDIDATES nearby pads (the optimizer's Stage 1 grid scan:
PGDA Sun/Earth visibility + LOLA slope, PSR excluded), run the same vectorised 365-day DE421 +
LOLA-skyline calendar the UI shows, summarise each one (GO days, longest GO run, next GO window,
status on the planned date) and return the pads that beat the current one on any of those.
"""

from __future__ import annotations

import time
from datetime import date

from .cache import GridStore
from .evaluation import launch_calendar
from .optimizer import _stage1_global, _stage1_polar
from .terrain import great_circle_km, initial_bearing, stereo_forward, terrain_at

N_CANDIDATES = 10
MIN_SEPARATION_KM = 1.0
MAX_SLOPE_DEG = 10.0


def _summary(days: list[dict], planned: str) -> dict:
    go = sum(d["status"] == "GO" for d in days)
    marginal = sum(d["status"] == "MARGINAL" for d in days)
    best_run, best_start, run, run_start = 0, None, 0, None
    for d in days:
        if d["status"] == "GO":
            if run == 0:
                run_start = d["date"]
            run += 1
            if run > best_run:
                best_run, best_start = run, run_start
        else:
            run = 0
    upcoming = [d for d in days if d["date"] >= planned]
    nxt = next((d["date"] for d in upcoming if d["status"] == "GO"), None)
    on_planned = next((d for d in days if d["date"] == planned), None)
    return {
        "go_days": go,
        "marginal_days": marginal,
        "longest_go_run_days": best_run,
        "longest_go_run_start": best_start,
        "next_go_date": nxt,
        "days_until_next_go": None if nxt is None else (date.fromisoformat(nxt) - date.fromisoformat(planned)).days,
        "planned_status": on_planned["status"] if on_planned else None,
        "planned_score": on_planned["score"] if on_planned else None,
        "mean_score": sum(d["score"] for d in days) / max(len(days), 1),
    }


def _reasons(s: dict, b: dict) -> list[str]:
    out = []
    order = {"NO-GO": 0, "MARGINAL": 1, "GO": 2}
    if s["planned_status"] and b["planned_status"] and order[s["planned_status"]] > order[b["planned_status"]]:
        out.append(f"{s['planned_status']} on the planned date (vs {b['planned_status']})")
    if s["go_days"] - b["go_days"] >= 5:
        out.append(f"+{s['go_days'] - b['go_days']} GO days this year")
    if s["longest_go_run_days"] - b["longest_go_run_days"] >= 2:
        out.append(f"{s['longest_go_run_days']}-day GO window (vs {b['longest_go_run_days']})")
    if s["days_until_next_go"] is not None and (b["days_until_next_go"] is None or s["days_until_next_go"] + 3 <= b["days_until_next_go"]):
        out.append("GO now" if s["days_until_next_go"] == 0 else f"next GO in {s['days_until_next_go']} d"
                   + ("" if b["days_until_next_go"] is None else f" (vs {b['days_until_next_go']} d)"))
    return out


def nearby_windows(lat: float, lon: float, start_date: str, planned_date: str, n_days: int, mission_days: float,
                   min_el: float, radius_km: float, k: int) -> dict:
    t0 = time.perf_counter()
    lon = (lon + 180.0) % 360.0 - 180.0
    base_cal = launch_calendar(lat, lon, start_date, n_days, mission_days, min_el)
    base = {"lat": lat, "lon": lon, "slope_deg": terrain_at(lat, lon).slope_deg, "summary": _summary(base_cal["days"], planned_date)}

    store = GridStore.get()
    x, y = (float(v) for v in stereo_forward(lat, lon))
    polar = store.avg_vis is not None and store.avg_vis.contains(x, y, margin_px=120) and store.slope.contains(x, y, margin_px=120)
    picks, *_ = (_stage1_polar(lat, lon, radius_km, max_slope=MAX_SLOPE_DEG, top_k=N_CANDIDATES) if polar
                 else _stage1_global(lat, lon, radius_km, max_slope=MAX_SLOPE_DEG, top_k=N_CANDIDATES))

    cands = []
    for la, lo in picks:
        dist = great_circle_km(lat, lon, la, lo)
        if dist < 0.3:
            continue
        slope = terrain_at(la, lo).slope_deg
        if slope > MAX_SLOPE_DEG + 2:
            continue
        cal = launch_calendar(la, lo, start_date, n_days, mission_days, min_el)
        s = _summary(cal["days"], planned_date)
        reasons = _reasons(s, base["summary"])
        if not reasons:
            continue
        cands.append({
            "lat": la, "lon": lo, "distance_km": dist, "bearing_deg": initial_bearing(lat, lon, la, lo), "slope_deg": slope,
            "summary": s, "reasons": reasons, "days": [{"date": d["date"], "status": d["status"]} for d in cal["days"]],
        })

    order = {"NO-GO": 0, "MARGINAL": 1, "GO": 2, None: -1}
    cands.sort(key=lambda c: (order[c["summary"]["planned_status"]], c["summary"]["go_days"], c["summary"]["longest_go_run_days"],
                              -c["distance_km"]), reverse=True)
    chosen: list[dict] = []
    for c in cands:
        if all(great_circle_km(c["lat"], c["lon"], o["lat"], o["lon"]) >= MIN_SEPARATION_KM for o in chosen):
            chosen.append(c)
        if len(chosen) >= k:
            break

    return {
        "baseline": {**base, "days": [{"date": d["date"], "status": d["status"]} for d in base_cal["days"]]},
        "alternatives": chosen,
        "candidates_evaluated": len(picks),
        "search_radius_km": radius_km,
        "start_date": start_date,
        "planned_date": planned_date,
        "computed_in_ms": (time.perf_counter() - t0) * 1000,
    }
