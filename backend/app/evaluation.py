"""
Site evaluation: combines the ephemeris engine, the LOLA skyline and every hazard layer into a
GO / MARGINAL / NO-GO verdict. Window-metric helpers are shared with the optimizer and calendar.

Thresholds (documented so judges can challenge them):
  sunlit %              GO ≥ 70     MARGINAL ≥ 40
  longest darkness h    GO ≤ 48     MARGINAL ≤ 96
  Earth contact %       GO ≥ 70     MARGINAL ≥ 40   (Earth above skyline AND ≥ antenna cutoff)
  slope °               GO ≤ 10     MARGINAL ≤ 15   (spec: warn > 10, fail > 15)
  time to sunset/set h  GO ≥ 48 or never   MARGINAL ≥ 12
  roughness, rock, temperature, PSR distance are advisory: at worst MARGINAL.
A Sun sample counts as "lit" when ≥ 50 % of the 0.266°-radius disk clears the skyline.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import timedelta

import numpy as np

from .diviner import rock_abundance_pct, surface_temperature
from .ephemeris import SPICE_SOURCE, EphemerisEngine, TopoSeries, iso_z, parse_utc
from .registry import ARTEMIS_BY_ID
from .terrain import OBSERVER_HEIGHT_M, Skyline, compute_skyline, great_circle_km, tag, terrain_at
from .psr_guard import PSR_BUFFER_M, psr_status

SUN_RADIUS_DEG = 0.266
ORDER = {"GO": 0, "MARGINAL": 1, "NO-GO": 2}


def worst(*statuses: str) -> str:
    return max(statuses, key=ORDER.__getitem__) if statuses else "GO"


def cap_marginal(status: str) -> str:
    return "MARGINAL" if status == "NO-GO" else status


def grade(value: float | None, go: float, marginal: float, higher_is_better: bool) -> str:
    if value is None:
        return "GO"
    if higher_is_better:
        return "GO" if value >= go else "MARGINAL" if value >= marginal else "NO-GO"
    return "GO" if value <= go else "MARGINAL" if value <= marginal else "NO-GO"


def visible_fraction(body_el: np.ndarray, horizon_el: np.ndarray, radius: float = SUN_RADIUS_DEG) -> np.ndarray:
    """Fraction of a disk above a horizontal skyline edge: 1 − (acos u − u√(1−u²))/π, u = Δ/r."""
    u = np.clip((body_el - horizon_el) / radius, -1.0, 1.0)
    return 1.0 - (np.arccos(u) - u * np.sqrt(1.0 - u * u)) / np.pi


def longest_run(mask: np.ndarray) -> int:
    if not mask.any():
        return 0
    padded = np.concatenate([[0], mask.astype(np.int8), [0]])
    d = np.diff(padded)
    starts, ends = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
    return int((ends - starts).max())


def first_false(mask: np.ndarray) -> int | None:
    idx = np.flatnonzero(~mask)
    return int(idx[0]) if idx.size else None


@dataclass
class WindowMetrics:
    sunlit_pct: float
    longest_dark_h: float
    time_to_sunset_h: float | None
    time_to_earthset_h: float | None
    earth_contact_pct: float

    def statuses(self) -> dict[str, str]:
        return {
            "sunlit": grade(self.sunlit_pct, 70, 40, True),
            "darkness": grade(self.longest_dark_h, 48, 96, False),
            "earth": grade(self.earth_contact_pct, 70, 40, True),
            "sunset": grade(self.time_to_sunset_h, 48, 12, True),
            "earthset": grade(self.time_to_earthset_h, 48, 12, True),
        }

    def score(self, window_h: float) -> float:
        return 0.5 * self.sunlit_pct / 100 + 0.3 * self.earth_contact_pct / 100 + 0.2 * (1 - min(self.longest_dark_h / max(window_h, 1), 1))


def window_metrics(sun_frac: np.ndarray, earth_ok: np.ndarray, step_h: float) -> WindowMetrics:
    lit = sun_frac >= 0.5
    fs = first_false(lit)
    fe = first_false(earth_ok)
    return WindowMetrics(
        sunlit_pct=float(sun_frac.mean() * 100),
        longest_dark_h=longest_run(~lit) * step_h,
        time_to_sunset_h=None if fs is None else fs * step_h,
        time_to_earthset_h=None if fe is None else fe * step_h,
        earth_contact_pct=float(earth_ok.mean() * 100),
    )


def visibility(topo: TopoSeries, sky: Skyline, min_el: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    sun_h = sky.at(topo.sun_az)
    earth_h = sky.at(topo.earth_az)
    frac = visible_fraction(topo.sun_el, sun_h)
    earth_vis = topo.earth_el > earth_h
    earth_ok = earth_vis & (topo.earth_el >= min_el)
    return frac, earth_ok, sun_h, earth_h, earth_vis


def metric(value, unit: str, status: str, source: dict) -> dict:
    return {"value": value, "unit": unit, "status": status, "source": source}


def evaluate_site(req) -> dict:
    """Everything except space weather, which main.py fetches concurrently and folds in."""
    t0 = time.perf_counter()
    lat = float(req.lat)
    lon = (float(req.lon) + 180.0) % 360.0 - 180.0
    start = parse_utc(req.epoch_utc)
    step_h = req.trajectory_step_minutes / 60.0
    hours = np.arange(0.0, req.mission_duration_days * 24 + 1e-9, step_h)

    tp = terrain_at(lat, lon)
    sky = compute_skyline(lat, lon, n_az=req.skyline_azimuths)
    topo = EphemerisEngine.get().topocentric(lat, lon, sky.observer_elev_m + OBSERVER_HEIGHT_M, start, hours)
    frac, earth_ok, sun_h, earth_h, earth_vis = visibility(topo, sky, req.min_earth_elevation_deg)
    wm = window_metrics(frac, earth_ok, step_h)
    st = wm.statuses()

    spice_derived = {**SPICE_SOURCE, "source_name": "NAIF DE421 SPICE + LOLA skyline", "resolution": f"{req.trajectory_step_minutes} min · {req.skyline_azimuths} az", "is_derived": True,
                     "is_synthetic_fallback": sky.source["is_synthetic_fallback"]}

    slope_status = grade(tp.slope_deg, 10, 15, False)
    rough_status = cap_marginal(grade(tp.roughness_m, *tp.roughness_thresholds, False))

    try:
        thermal, thermal_src = surface_temperature(lat, lon)
        thermal_status = "GO" if thermal["min_k"] >= 40 and thermal["max_k"] <= 390 else "MARGINAL"
    except Exception as exc:  # noqa: BLE001 — offline with no cached bytes
        thermal = {"min_k": None, "mean_k": None, "max_k": None}
        thermal_src = tag(f"Diviner GCP unavailable ({exc.__class__.__name__})", "—", synthetic=True)
        thermal_status = "MARGINAL"

    try:
        ra = rock_abundance_pct(lat, lon)
    except Exception:  # noqa: BLE001
        ra = None
    if ra:
        rock_val, rock_src = ra
        rock_status = cap_marginal(grade(rock_val, 1.0, 2.0, False))
    else:
        rock_val = None
        rock_src = tag("Diviner rock abundance: no coverage poleward of 60°", "—")
        rock_status = "MARGINAL"

    if tp.psr_km is not None:
        ice_status = "GO" if tp.psr_km <= 10 else "MARGINAL"
        ice_src = tp.psr_src
    else:
        ice_status, ice_src = "MARGINAL", tag("PGDA LPSR: outside 65°S map", "—")

    region = tp.artemis_site
    if not region and req.region_id in ARTEMIS_BY_ID:
        a = ARTEMIS_BY_ID[req.region_id]
        if great_circle_km(lat, lon, a["lat"], a["lon"]) < 10:
            region = f"{a['name']} (≈ region centre)"
    approx = bool(req.region_id in ARTEMIS_BY_ID)

    # Landing inside a permanently shadowed region is NO-GO; inside the 500 m buffer is MARGINAL.
    in_psr, psr_km_now, _ = psr_status(lat, lon)
    psr_land_status = "NO-GO" if in_psr else ("MARGINAL" if psr_km_now is not None and psr_km_now * 1000 < PSR_BUFFER_M else "GO")
    overall = worst(st["sunlit"], st["darkness"], st["earth"], slope_status, rough_status,
                    cap_marginal(st["sunset"]), cap_marginal(st["earthset"]), psr_land_status)
    reasons: list[str] = []
    if psr_land_status == "NO-GO":
        reasons.append("Pad is inside a permanently shadowed region (no sunlight, ~40 K ground)")
    elif psr_land_status == "MARGINAL":
        reasons.append(f"Pad is {psr_km_now * 1000:.0f} m from a permanently shadowed region (keep ≥ {PSR_BUFFER_M:.0f} m)")
    if st["sunlit"] != "GO":
        reasons.append(f"Sunlit {wm.sunlit_pct:.0f}% of the mission (GO ≥ 70%)")
    if st["darkness"] != "GO":
        reasons.append(f"Longest darkness {wm.longest_dark_h:.0f} h (GO ≤ 48 h)")
    if st["earth"] != "GO":
        reasons.append(f"Earth contact ≥ {req.min_earth_elevation_deg:g}° only {wm.earth_contact_pct:.0f}% of the time")
    if slope_status != "GO":
        reasons.append(f"Slope {tp.slope_deg:.1f}° exceeds the 10° tip-over warning" + (" (> 15° fail)" if slope_status == "NO-GO" else ""))
    if rough_status != "GO":
        reasons.append(f"Roughness {tp.roughness_m:.1f} m RMS over {tp.roughness_src['resolution']}")
    if st["sunset"] != "GO" and wm.time_to_sunset_h is not None:
        reasons.append("Site starts in darkness" if wm.time_to_sunset_h == 0 else f"Sunset in {wm.time_to_sunset_h:.0f} h")

    samples = []
    sub = np.column_stack([topo.subsolar_lat, topo.subsolar_lon, topo.subearth_lat, topo.subearth_lon])
    for i, h in enumerate(hours):
        samples.append({
            "t_utc": iso_z(start + timedelta(hours=float(h))), "hours_from_start": float(h),
            "sun_az_deg": float(topo.sun_az[i]), "sun_el_deg": float(topo.sun_el[i]),
            "sun_horizon_el_deg": float(sun_h[i]), "sun_visible_fraction": float(frac[i]),
            "earth_az_deg": float(topo.earth_az[i]), "earth_el_deg": float(topo.earth_el[i]),
            "earth_horizon_el_deg": float(earth_h[i]), "earth_visible": bool(earth_vis[i]),
            "subsolar_lat_deg": float(sub[i, 0]), "subsolar_lon_deg": float(sub[i, 1]),
            "subearth_lat_deg": float(sub[i, 2]), "subearth_lon_deg": float(sub[i, 3]),
        })

    return {
        "site": {
            "lat": lat, "lon": lon, "name": req.site_name, "region_id": req.region_id, "artemis_region": region,
            "map_x_m": tp.map_x, "map_y_m": tp.map_y,
            "elevation_m": metric(tp.elevation_m, "m", "GO", {**tp.elevation_src, "is_approx_coord": approx}),
        },
        "epoch_utc": iso_z(start),
        "mission_duration_days": req.mission_duration_days,
        "min_earth_elevation_deg": req.min_earth_elevation_deg,
        "overall_status": overall,
        "verdict_reasons": reasons,
        "illumination": {
            "sunlit_pct": metric(wm.sunlit_pct, "%", st["sunlit"], spice_derived),
            "longest_darkness_hours": metric(wm.longest_dark_h, "h", st["darkness"], spice_derived),
            "time_to_sunset_hours": metric(wm.time_to_sunset_h, "h", st["sunset"], spice_derived),
            "time_to_earthset_hours": metric(wm.time_to_earthset_h, "h", st["earthset"], spice_derived),
            "earth_contact_pct": metric(wm.earth_contact_pct, "%", st["earth"], spice_derived),
        },
        "terrain": {
            "slope_deg": metric(tp.slope_deg, "°", slope_status, tp.slope_src),
            "roughness_m": metric(tp.roughness_m, "m", rough_status, tp.roughness_src),
        },
        "thermal": {"surface_temperature_k": metric(thermal, "K", thermal_status, thermal_src)},
        "hazards": {"rock_abundance_pct": metric(rock_val, "%", rock_status, rock_src)},
        "isru": {"nearest_ice_psr_km": metric(tp.psr_km, "km", ice_status, ice_src)},
        "skyline": {
            "observer_lat": lat, "observer_lon": lon, "observer_elevation_m": sky.observer_elev_m,
            "n_azimuths": len(sky.azimuth), "max_range_km": sky.max_range_km, "curvature_corrected": True,
            "points": [{"azimuth_deg": float(a), "elevation_deg": float(e), "distance_km": float(d)}
                       for a, e, d in zip(sky.azimuth, sky.elevation, sky.distance_km)],
            "source": sky.source,
        },
        "trajectory": {
            "start_utc": iso_z(start), "end_utc": iso_z(start + timedelta(hours=float(hours[-1]))),
            "step_minutes": req.trajectory_step_minutes, "samples": samples, "source": SPICE_SOURCE,
        },
        "computed_in_ms": (time.perf_counter() - t0) * 1000,
    }


def launch_calendar(lat: float, lon: float, start_date: str, n_days: int, mission_days: float, min_el: float) -> dict:
    """Score every launch day with one vectorised hourly ephemeris pass + sliding windows."""
    t0 = time.perf_counter()
    start = parse_utc(f"{start_date}T00:00:00Z")
    win = int(round(mission_days * 24))
    hours = np.arange(0.0, n_days * 24 + win, 1.0)
    sky = compute_skyline(lat, lon, n_az=360)
    topo = EphemerisEngine.get().topocentric(lat, lon, sky.observer_elev_m + OBSERVER_HEIGHT_M, start, hours)
    frac, earth_ok, *_ = visibility(topo, sky, min_el)
    days = []
    for i in range(n_days):
        s = i * 24
        wm = window_metrics(frac[s : s + win + 1], earth_ok[s : s + win + 1], 1.0)
        st = wm.statuses()
        days.append({
            "date": (start + timedelta(days=i)).date().isoformat(),
            "status": worst(st["sunlit"], st["darkness"], st["earth"]),
            "score": round(wm.score(win), 4), "sunlit_pct": wm.sunlit_pct,
            "earth_contact_pct": wm.earth_contact_pct, "longest_darkness_hours": wm.longest_dark_h,
        })
    return {
        "lat": lat, "lon": lon, "start_date": start_date, "mission_duration_days": mission_days,
        "min_earth_elevation_deg": min_el, "days": days, "computed_in_ms": (time.perf_counter() - t0) * 1000,
        "source": {**SPICE_SOURCE, "source_name": "Skyfield DE421 (vectorised) + LOLA skyline", "resolution": f"1 h · {n_days} days", "is_derived": True},
    }
