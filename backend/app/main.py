"""
FastAPI app — Lunar Landing Site Navigator.

Run:  uvicorn app.main:app --port 8000      (from backend/, after scripts/ingest_nasa_data.py)
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from anyio import to_thread
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .cache import GridStore, fetch_bytes_cached
from .ephemeris import SPICE_SOURCE, EphemerisEngine, horizons_azel, iso_z, parse_utc, space_weather
from .evaluation import evaluate_site, launch_calendar
from .best_site import best_site
from .contingency import assess_contingency
from .nearby_windows import nearby_windows
from .optimizer import nearest_alternative
from .registry import BENCHMARKS
from .schemas import (
    ContingencyRequest,
    LaunchCalendarResponse,
    NearestAlternativeRequest,
    NearestAlternativeResponse,
    SiteEvaluationRequest,
    SiteEvaluationResponse,
    SpaceWeatherStatus,
    ValidationBenchmarkResponse,
)
from .overlays import OVERLAYS, overlay_meta, overlay_png
from .terrain import heightmap_paths

import numpy as np


@asynccontextmanager
async def lifespan(_: FastAPI):
    t0 = time.perf_counter()
    await to_thread.run_sync(GridStore.get)
    await to_thread.run_sync(EphemerisEngine.get)
    print(f"[startup] grids + SPICE kernels ready in {(time.perf_counter() - t0) * 1000:.0f} ms", flush=True)
    yield


app = FastAPI(title="Lunar Landing Site Navigator API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


def _parse_epoch(iso: str) -> datetime:
    try:
        dt = parse_utc(iso)
    except ValueError as exc:
        raise HTTPException(422, f"epoch_utc not ISO-8601: {iso}") from exc
    if not (datetime(1900, 1, 2, tzinfo=timezone.utc) < dt < datetime(2049, 12, 1, tzinfo=timezone.utc)):
        raise HTTPException(422, "epoch outside MOON_PA_DE421 kernel coverage (1900–2050)")
    return dt


@app.get("/api/health")
def health() -> dict:
    store = GridStore.get()
    return {"ok": True, "manifest_generated": store.manifest["generated_utc"],
            "synthetic_layers": [k for k, v in store.manifest["layers"].items() if v.get("is_synthetic_fallback")],
            "sites_5m": list(store.sites_5m)}


@app.post("/api/evaluate", response_model=SiteEvaluationResponse)
async def evaluate(req: SiteEvaluationRequest) -> dict:
    epoch = _parse_epoch(req.epoch_utc)
    sw_task = asyncio.create_task(space_weather(epoch, req.mission_duration_days))
    result = await to_thread.run_sync(evaluate_site, req)
    try:
        sw = await asyncio.wait_for(asyncio.shield(sw_task), timeout=3.0)  # shield: keeps fetching into the cache
    except asyncio.TimeoutError:
        sw = {"status": "UNKNOWN", "eva_status": "MARGINAL", "window_start": iso_z(epoch), "window_end": iso_z(epoch),
              "sep_event_count": 0, "flare_count": 0, "strongest_flare_class": None, "latest_event_utc": None,
              "summary": "DONKI did not answer within 3 s — retrying in the background.", "cached_at_utc": None,
              "served_from_cache": False, "source": {"source_name": "NASA DONKI SEP + FLR", "resolution": "event catalogue",
                                                     "is_derived": False, "is_synthetic_fallback": False}}
    # Fold space weather into the verdict now that it has arrived. UNKNOWN (no record / future
    # epoch / DONKI offline) is shown on the badge but never downgrades the landing verdict.
    if sw["status"] != "UNKNOWN" and sw["eva_status"] != "GO":
        result["verdict_reasons"].append(f"Space weather: {sw['summary']}")
        if result["overall_status"] == "GO":
            result["overall_status"] = "MARGINAL"
    result["space_weather"] = sw
    return result


@app.post("/api/nearest-alternative", response_model=NearestAlternativeResponse)
async def alternative(req: NearestAlternativeRequest) -> dict:
    _parse_epoch(req.epoch_utc)
    return await to_thread.run_sync(nearest_alternative, req)


@app.post("/api/contingency")
async def contingency(req: ContingencyRequest) -> dict:
    """Re-check the current pad against anomaly-specific constraints and, if it fails, find a reachable pad that passes."""
    _parse_epoch(req.epoch_utc)
    return await to_thread.run_sync(assess_contingency, req)


@app.get("/api/launch-calendar", response_model=LaunchCalendarResponse)
async def calendar(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-360, le=360),
    start_date: str = Query(pattern=r"^\d{4}-\d{2}-\d{2}$"),
    n_days: int = Query(365, ge=1, le=400),
    mission_duration_days: float = Query(7, ge=0.5, le=30),
    min_earth_elevation_deg: float = Query(5, ge=0, le=20),
) -> dict:
    _parse_epoch(f"{start_date}T00:00:00Z")
    lon = (lon + 180) % 360 - 180
    return await to_thread.run_sync(launch_calendar, lat, lon, start_date, n_days, mission_duration_days, min_earth_elevation_deg)


@app.get("/api/nearby-windows")
async def nearby_windows_route(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-360, le=360),
    start_date: str = Query(pattern=r"^\d{4}-\d{2}-\d{2}$"),
    planned_date: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    n_days: int = Query(365, ge=1, le=400),
    mission_duration_days: float = Query(7, ge=0.5, le=30),
    min_earth_elevation_deg: float = Query(5, ge=0, le=20),
    radius_km: float = Query(10, gt=0, le=25),
    k: int = Query(3, ge=1, le=6),
) -> dict:
    """Nearby pads whose 365-day launch calendar beats the selected pad's (scenario comparison)."""
    _parse_epoch(f"{start_date}T00:00:00Z")
    return await to_thread.run_sync(
        nearby_windows, lat, lon, start_date, planned_date or start_date, n_days, mission_duration_days, min_earth_elevation_deg, radius_km, k
    )


@app.get("/api/best-site")
async def best_site_route(
    epoch_utc: str,
    mission_duration_days: float = Query(7, ge=0.5, le=30),
    min_earth_elevation_deg: float = Query(5, ge=0, le=20),
    top: int = Query(5, ge=1, le=10),
) -> dict:
    """Best landing pad anywhere at the south pole (poleward of 80°S) for a given launch epoch."""
    _parse_epoch(epoch_utc)
    return await to_thread.run_sync(best_site, epoch_utc, mission_duration_days, min_earth_elevation_deg, top)


@app.get("/api/space-weather", response_model=SpaceWeatherStatus)
async def space_weather_route(epoch_utc: str, mission_duration_days: float = 7) -> dict:
    return await space_weather(_parse_epoch(epoch_utc), mission_duration_days)


QUANTITIES = (("SUN_AZ", "10", "az"), ("SUN_EL", "10", "el"), ("EARTH_AZ", "399", "az"), ("EARTH_EL", "399", "el"))
TOLERANCE_DEG = 0.01


@app.get("/api/validation", response_model=ValidationBenchmarkResponse)
async def validation(lat: float, lon: float, epoch_utc: str) -> dict:
    """Local Skyfield/DE421 vs live (disk-cached) JPL Horizons vs historical references."""
    epoch = _parse_epoch(epoch_utc)
    lon = (lon + 180) % 360 - 180
    sites = [dict(b) for b in BENCHMARKS]
    if not any(abs(b["lat"] - lat) < 1e-4 and abs(b["lon"] - lon) < 1e-4 and parse_utc(b["epoch_utc"]) == epoch for b in sites):
        sites.append({"id": "current-site", "name": "Current site", "lat": lat, "lon": lon, "epoch_utc": iso_z(epoch), "reference": {}})

    eng = EphemerisEngine.get()
    gate = asyncio.Semaphore(2)  # JPL Horizons rejects bursts of parallel requests

    async def horizons(body: str, site: dict, when):
        for attempt in range(2):
            try:
                async with gate:
                    return await horizons_azel(body, site["lat"], site["lon"], 0.0, when)
            except Exception:  # noqa: BLE001
                if attempt == 0:
                    await asyncio.sleep(1.0)
        return None

    async def one(site: dict) -> list[dict]:
        when = parse_utc(site["epoch_utc"])
        topo = await to_thread.run_sync(eng.topocentric, site["lat"], site["lon"], 0.0, when, np.array([0.0]))
        local = {"SUN_AZ": topo.sun_az[0], "SUN_EL": topo.sun_el[0], "EARTH_AZ": topo.earth_az[0], "EARTH_EL": topo.earth_el[0]}
        hz = {body: await horizons(body, site, when) for body in ("10", "399")}
        rows = []
        for q, body, kind in QUANTITIES:
            h = hz[body]
            h_val = None if h is None else (h[0] if kind == "az" else h[1])
            ref = site["reference"].get(q)

            def delta(a: float, b: float | None) -> float | None:
                if b is None:
                    return None
                d = a - b
                return float((d + 180) % 360 - 180) if kind == "az" else float(d)

            rows.append({
                "benchmark_id": site["id"], "benchmark_name": site["name"], "lat": site["lat"], "lon": site["lon"],
                "epoch_utc": site["epoch_utc"], "quantity": q, "local_deg": float(local[q]),
                "horizons_deg": h_val, "reference_deg": ref,
                "delta_horizons_deg": delta(float(local[q]), h_val), "delta_reference_deg": delta(float(local[q]), ref),
                "local_source": {**SPICE_SOURCE, "source_name": "Skyfield DE421 + MOON_ME", "resolution": "apparent, airless"},
                "horizons_source": {"source_name": "JPL Horizons API", "resolution": "QUANTITIES=4 · AIRLESS",
                                    "is_derived": False, "is_synthetic_fallback": False} if h else None,
                "horizons_cached": bool(h and h[2]),
            })
        return rows

    groups = await asyncio.gather(*(one(s) for s in sites))
    rows = [r for g in groups for r in g]
    deltas = [abs(r["delta_horizons_deg"]) for r in rows if r["delta_horizons_deg"] is not None]
    return {
        "generated_at_utc": iso_z(datetime.now(timezone.utc)),
        "horizons_reachable": any(r["horizons_deg"] is not None and not r["horizons_cached"] for r in rows),
        "tolerance_deg": TOLERANCE_DEG,
        "max_abs_delta_horizons_deg": max(deltas) if deltas else None,
        "rows": rows,
    }


@app.get("/api/terrain/polar-heightmap.png")
def heightmap_png() -> FileResponse:
    png, _ = heightmap_paths()
    return FileResponse(png, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/terrain/polar-heightmap.json")
def heightmap_meta() -> FileResponse:
    _, meta = heightmap_paths()
    return FileResponse(meta, media_type="application/json")


TREK = "https://trek.nasa.gov/tiles/Moon/{proj}/{layer}/1.0.0/default/default028mm/{z}/{row}/{col}.png"
LAYER_RE = re.compile(r"^[A-Za-z0-9_]{3,80}$")


@app.get("/api/tiles/{proj}/{layer}/{z}/{row}/{col}.png")
async def trek_tile(proj: str, layer: str, z: int, row: int, col: int) -> Response:
    """Tier-1 disk-cached Moon Trek WMTS proxy (CORS-safe for the WebGL canvas)."""
    if proj not in ("SP", "EQ") or not LAYER_RE.match(layer) or not (0 <= z <= 8):
        raise HTTPException(400, "bad tile request")
    url = TREK.format(proj=proj, layer=layer, z=z, row=row, col=col)
    try:
        data = await to_thread.run_sync(fetch_bytes_cached, url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Moon Trek tile unavailable: {exc}") from exc
    if not data.startswith(b"\x89PNG") and not data.startswith(b"\xff\xd8"):
        raise HTTPException(502, "Moon Trek returned a non-image body")
    return Response(data, media_type="image/png" if data.startswith(b"\x89PNG") else "image/jpeg",
                    headers={"Cache-Control": "public, max-age=604800"})


@app.get("/api/overlays/{name}.png")
async def overlay_image(name: str) -> FileResponse:
    if name not in OVERLAYS:
        raise HTTPException(404, f"unknown overlay {name}")
    path = await to_thread.run_sync(overlay_png, name)
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/overlays/{name}.json")
def overlay_info(name: str) -> dict:
    if name not in OVERLAYS:
        raise HTTPException(404, f"unknown overlay {name}")
    return overlay_meta(name)
