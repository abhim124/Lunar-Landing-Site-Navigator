"""
Two-tier caching.

Tier 1 — persistent disk cache (diskcache/SQLite) for every outbound HTTP call: JPL Horizons,
NASA DONKI, Diviner byte-range reads and Moon Trek tiles. Entries never expire on disk; a
`fresh_s` window decides when to try the network again, and if the network is down the last
good response is served (`from_cache=True`). That is what lets the demo run fully offline.

Tier 2 — in-memory spatial grids: the 240 m LOLA DEM / slope / roughness live in RAM, the
6420² PGDA illumination grids are memory-mapped (O(1) windowed lookups, no 660 MB RSS).
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import numpy as np
from diskcache import Cache

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
PROC_DIR = DATA_DIR / "processed"
SPICE_DIR = DATA_DIR / "raw" / "spice"

http_cache = Cache(str(DATA_DIR / "cache" / "http"), size_limit=2 * 1024**3)
UA = {"User-Agent": "lunar-landing-site-navigator/1.0"}


def _key(url: str, params: dict | None, extra: str = "") -> str:
    blob = json.dumps([url, sorted((params or {}).items()), extra], default=str)
    return hashlib.sha256(blob.encode()).hexdigest()


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class CachedResult:
    value: Any
    from_cache: bool
    cached_at: str


async def fetch_json_cached(
    url: str, params: dict | None = None, *, fresh_s: float | None = None, timeout: float = 20.0
) -> CachedResult:
    """GET JSON with a permanent disk copy. `fresh_s=None` → cache forever (immutable data)."""
    key = _key(url, params)
    hit = http_cache.get(key)
    if hit and (fresh_s is None or time.time() - hit["ts"] < fresh_s):
        return CachedResult(hit["value"], True, _iso(hit["ts"]))
    if fresh_s == float("inf"):  # cache-only mode (caller is backing off the network)
        raise LookupError(f"no cached copy of {url}")
    try:
        async with httpx.AsyncClient(timeout=timeout, headers=UA, follow_redirects=True) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            if "text/html" in resp.headers.get("Content-Type", ""):
                raise ValueError(f"{url} returned HTML, expected JSON")
            value = resp.json()
        now = time.time()
        http_cache.set(key, {"value": value, "ts": now})
        return CachedResult(value, False, _iso(now))
    except Exception:
        if hit:  # offline / rate-limited → serve stale copy
            return CachedResult(hit["value"], True, _iso(hit["ts"]))
        raise


def fetch_bytes_cached(url: str, *, byte_range: tuple[int, int] | None = None, timeout: float = 20.0) -> bytes:
    """Synchronous binary GET (optionally a Range) cached forever. Rejects HTML bodies."""
    key = _key(url, None, f"range={byte_range}")
    hit = http_cache.get(key)
    if hit is not None:
        return hit
    headers = dict(UA)
    if byte_range:
        headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
    with httpx.Client(timeout=timeout, headers=headers, follow_redirects=True) as client:
        resp = client.get(url)
        if resp.status_code not in (200, 206):
            raise httpx.HTTPStatusError(f"{url} → {resp.status_code}", request=resp.request, response=resp)
        if "text/html" in resp.headers.get("Content-Type", ""):
            raise ValueError(f"{url} returned HTML instead of binary/text data")
        data = resp.content
    http_cache.set(key, data)
    return data


# ─────────────────────────────── Tier 2: spatial grids ───────────────────────────────


@dataclass
class PolarGrid:
    """A south-polar-stereographic raster with LOLA pixel registration (pixel centres)."""

    data: np.ndarray
    pixel_m: float
    offset_px: float
    source: dict

    def rc(self, x: np.ndarray | float, y: np.ndarray | float) -> tuple[np.ndarray, np.ndarray]:
        return self.offset_px - np.asarray(y) / self.pixel_m, np.asarray(x) / self.pixel_m + self.offset_px

    def xy(self, r: np.ndarray | float, c: np.ndarray | float) -> tuple[np.ndarray, np.ndarray]:
        return (np.asarray(c) - self.offset_px) * self.pixel_m, (self.offset_px - np.asarray(r)) * self.pixel_m

    def contains(self, x: float, y: float, margin_px: int = 1) -> bool:
        r, c = self.rc(x, y)
        n = self.data.shape[0]
        return margin_px <= r < n - 1 - margin_px and margin_px <= c < n - 1 - margin_px

    def sample(self, x: float, y: float) -> float:
        """Bilinear sample at one point (reads a 2×2 window — works on memmaps)."""
        r, c = self.rc(x, y)
        r0, c0 = int(np.floor(r)), int(np.floor(c))
        w = np.asarray(self.data[r0 : r0 + 2, c0 : c0 + 2], dtype=np.float64)
        fr, fc = r - r0, c - c0
        return float(w[0, 0] * (1 - fr) * (1 - fc) + w[0, 1] * (1 - fr) * fc + w[1, 0] * fr * (1 - fc) + w[1, 1] * fr * fc)

    def window(self, x: float, y: float, half_px: int) -> tuple[np.ndarray, int, int]:
        r, c = self.rc(x, y)
        r0 = max(0, int(round(float(r))) - half_px)
        c0 = max(0, int(round(float(c))) - half_px)
        return np.asarray(self.data[r0 : r0 + 2 * half_px + 1, c0 : c0 + 2 * half_px + 1], dtype=np.float32), r0, c0


class GridStore:
    """Process-wide singleton holding every raster the API touches."""

    _instance: "GridStore | None" = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        manifest_path = PROC_DIR / "manifest.json"
        if not manifest_path.exists():
            raise RuntimeError("backend/data/processed/manifest.json missing — run scripts/ingest_nasa_data.py first")
        self.manifest = json.loads(manifest_path.read_text())
        L = self.manifest["layers"]
        ld = L["ldem"]

        def polar(name: str, mmap: bool) -> PolarGrid | None:
            meta = L.get(name)
            if not meta:
                return None
            arr = np.load(PROC_DIR / meta["path"], mmap_mode="r" if mmap else None)
            return PolarGrid(arr, meta.get("pixel_m", ld["pixel_m"]), meta.get("offset_px", ld["offset_px"]), meta)

        self.ldem = polar("ldem", mmap=False)
        self.slope = polar("slope", mmap=False)
        self.roughness = polar("roughness", mmap=False)
        self.avg_vis = polar("avg_vis", mmap=True)
        self.earth_vis = polar("earth_vis", mmap=True)
        self.psr = polar("psr", mmap=True)
        self.psr_distance = polar("psr_distance", mmap=True)
        g16 = L.get("ldem_16")
        self.ldem16 = np.load(PROC_DIR / g16["path"]) if g16 else None
        self.ldem16_meta = g16
        self.sites_5m = self.manifest.get("sites_5m", {})

    @classmethod
    def get(cls) -> "GridStore":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = GridStore()
        return cls._instance
