"""
South-polar overlay images rendered from the ingested NASA rasters (no third-party tiles needed).

Each overlay covers the LDEM_75S_240M footprint (±457 440 m in South Polar Stereographic x/y,
lon 0° toward +y / image top) at 480 m/px, and is cached as a PNG on first request.
"""

from __future__ import annotations

import threading
from pathlib import Path

import numpy as np
from PIL import Image

from .cache import PROC_DIR, GridStore

OUT = PROC_DIR / "overlays"
_lock = threading.Lock()


def _ramp(values: np.ndarray, stops: list[tuple[float, tuple[int, int, int]]]) -> np.ndarray:
    xs = np.array([s[0] for s in stops])
    cols = np.array([s[1] for s in stops], dtype=np.float32)
    v = np.clip(values, xs[0], xs[-1])
    return np.stack([np.interp(v, xs, cols[:, i]) for i in range(3)], axis=-1)


def _downsample(a: np.ndarray) -> np.ndarray:
    n = a.shape[0] // 2 * 2
    a = a[:n, :n]
    return a.reshape(n // 2, 2, n // 2, 2, *a.shape[2:]).mean(axis=(1, 3))


def _crop_to_ldem(grid) -> np.ndarray:
    """Cut the 65°S PGDA grid down to the co-registered 75°S LDEM window."""
    store = GridStore.get()
    shift = int(round(grid.offset_px - store.ldem.offset_px))
    n = store.ldem.data.shape[0]
    return np.asarray(grid.data[shift : shift + n, shift : shift + n], dtype=np.float32)


def _render_relief() -> np.ndarray:
    store = GridStore.get()
    dem = np.asarray(store.ldem.data, dtype=np.float32)
    px = store.ldem.pixel_m
    dzdy, dzdx = np.gradient(dem, px)
    az, alt = np.radians(315.0), np.radians(35.0)
    slope = np.arctan(np.hypot(dzdx, dzdy) * 3.0)  # 3× vertical exaggeration for legibility
    aspect = np.arctan2(-dzdx, dzdy)
    shade = np.clip(np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect), 0, 1)
    color = _ramp(dem, [(-5000, (40, 40, 120)), (-2500, (40, 110, 170)), (-500, (60, 160, 120)),
                        (1000, (200, 190, 90)), (3000, (200, 120, 60)), (5500, (250, 245, 240))])
    rgb = color * (0.3 + 0.7 * shade[..., None])
    return np.concatenate([rgb, np.full((*dem.shape, 1), 255.0)], axis=-1)


def _render_sun_vis() -> np.ndarray:
    store = GridStore.get()
    vis = _crop_to_ldem(store.avg_vis)
    psr = _crop_to_ldem(store.psr) > 0.5
    rgb = _ramp(vis, [(0.0, (8, 6, 20)), (0.2, (80, 20, 110)), (0.45, (190, 60, 70)), (0.7, (250, 150, 30)), (0.95, (255, 250, 180))])
    rgb[psr] = (40, 120, 255)  # permanently shadowed regions (cold traps)
    return np.concatenate([rgb, np.full((*vis.shape, 1), 255.0)], axis=-1)


def _render_earth_vis() -> np.ndarray:
    store = GridStore.get()
    vis = _crop_to_ldem(store.earth_vis)
    rgb = _ramp(vis, [(0.0, (6, 10, 20)), (0.25, (20, 60, 110)), (0.5, (30, 140, 170)), (0.75, (110, 220, 210)), (1.0, (235, 255, 250))])
    return np.concatenate([rgb, np.full((*vis.shape, 1), 255.0)], axis=-1)


OVERLAYS = {
    "lola_relief": (_render_relief, "ldem", "LOLA LDEM_75S_240M colour-shaded relief"),
    "pgda_sun_vis": (_render_sun_vis, "avg_vis", "PGDA AVGVISIB_65S_240M (Sun) + LPSR"),
    "pgda_earth_vis": (_render_earth_vis, "earth_vis", "PGDA AVGVISIB_65S_240M_EARTH"),
}


def overlay_png(name: str) -> Path:
    if name not in OVERLAYS:
        raise KeyError(name)
    path = OUT / f"{name}.png"
    with _lock:
        if not path.exists():
            OUT.mkdir(parents=True, exist_ok=True)
            img = _downsample(OVERLAYS[name][0]())
            Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGBA").save(path)
    return path


def overlay_meta(name: str) -> dict:
    store = GridStore.get()
    render, layer, label = OVERLAYS[name]
    n = store.ldem.data.shape[0] // 2 * 2
    half = n / 2 * store.ldem.pixel_m
    src = store.manifest["layers"][layer]
    return {
        "name": name,
        "bounds_m": [-half, -half, half, half],
        "pixel_size_m": store.ldem.pixel_m * 2,
        "source": {"source_name": label, "resolution": "480 m/px (2× mean of 240 m)", "is_derived": True,
                   "is_synthetic_fallback": bool(src.get("is_synthetic_fallback"))},
    }
