#!/usr/bin/env python3
"""
Lunar Landing Site Navigator — NASA data ingestion.

Downloads (with Content-Type + magic-byte guards), derives and co-registers every raster the
FastAPI backend needs, then writes `backend/data/processed/manifest.json` describing where each
layer came from. Anything that cannot be fetched is replaced by a deterministic analytic model
and flagged `synthetic: true` so the UI shows a SYNTHETIC FALLBACK chip.

Verified sources (2026-11):
  • NAIF SPICE: de421.bsp (now under spk/planets/a_old_versions/), moon_pa_de421_1900-2050.bpc,
    moon_080317.tf, moon_assoc_me.tf, pck00010.tpc (pck00008.tpc has been retired).
  • LOLA LDEM_75S_240M (PDS Geosciences) + LDEM_16 global (for non-polar benchmark sites).
  • PGDA product 69 illumination maps: the pgda.gsfc.nasa.gov *.TIF links currently answer
    HTTP 200 with an HTML "Not Found" page, so the resolver scrapes product 69, rejects HTML,
    and falls back to the MIT imbrium mirror IMG + LBL files linked from the same page.
  • PGDA LOLA 5 m/px site DEMs live in per-site folders: /data/LOLA_5mpp/Site01/Site01_final_adj_5mpp_surf.tif
  • Diviner GCP temperatures and Diviner rock abundance are *not* bulk-downloaded: the backend
    reads only the bytes for a site via HTTP Range requests and caches them (see backend/app/diviner.py).

Usage:
  python scripts/ingest_nasa_data.py                # everything (≈ 400 MB download)
  python scripts/ingest_nasa_data.py --no-5m        # skip the PGDA 5 m site DEMs
  python scripts/ingest_nasa_data.py --synthetic    # offline: analytic grids only, boots in seconds
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

import httpx
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "backend" / "data"
RAW = DATA / "raw"
PROC = DATA / "processed"

MOON_R = 1_737_400.0
MAX_BYTES = 200 * 1024 * 1024  # spec: anything larger than 200 MB falls back
UA = {"User-Agent": "lunar-landing-site-navigator-ingest/1.0"}

NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
SPICE_KERNELS = {
    "de421.bsp": [f"{NAIF}/spk/planets/de421.bsp", f"{NAIF}/spk/planets/a_old_versions/de421.bsp"],
    "moon_pa_de421_1900-2050.bpc": [f"{NAIF}/pck/moon_pa_de421_1900-2050.bpc"],
    "moon_080317.tf": [f"{NAIF}/fk/satellites/moon_080317.tf"],
    "moon_assoc_me.tf": [f"{NAIF}/fk/satellites/moon_assoc_me.tf"],
    "pck00010.tpc": [f"{NAIF}/pck/pck00008.tpc", f"{NAIF}/pck/pck00010.tpc"],
}

LOLA = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr"
LOLA_FILES = {
    "ldem_75s_240m": f"{LOLA}/polar/img/ldem_75s_240m",
    "ldem_16": f"{LOLA}/cylindrical/img/ldem_16",
}

PGDA_PRODUCT_69 = "https://pgda.gsfc.nasa.gov/products/69"
ILLUMINATION_PRODUCTS = {
    "avg_vis": r"AVGVISIB_65S_240M_201608\.(?:IMG|TIF)",
    "earth_vis": r"AVGVISIB_65S_240M_201608_EARTH\.(?:IMG|TIF)",
    "psr": r"LPSR_65S_240M_201608\.(?:IMG|TIF)",
}

PGDA_5M = "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp"
PGDA_5M_SITES = {"Site01": "Connecting Ridge", "Site04": "Shackleton Rim", "Site07": "Peak Near Shackleton"}

BINARY_MAGIC = {
    ".tif": (b"II*\x00", b"MM\x00*", b"II+\x00"),
    ".tiff": (b"II*\x00", b"MM\x00*", b"II+\x00"),
    ".bsp": (b"DAF/SPK",),
    ".bpc": (b"DAF/PCK",),
}


def log(msg: str) -> None:
    print(f"[ingest] {msg}", flush=True)


# ─────────────────────────────── network hygiene ───────────────────────────────


class NotBinary(RuntimeError):
    pass


def assert_binary(resp: httpx.Response, url: str, first_bytes: bytes) -> None:
    """Content-Type guard + magic-byte check so HTML never reaches numpy/rasterio."""
    ctype = resp.headers.get("Content-Type", "")
    if "text/html" in ctype:
        raise NotBinary(f"{url} returned HTML ({ctype})")
    head = first_bytes.lstrip()[:15].lower()
    if head.startswith((b"<!doctype", b"<html")):
        raise NotBinary(f"{url} body is HTML despite Content-Type {ctype!r}")
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    magics = BINARY_MAGIC.get(suffix)
    if magics and not first_bytes.startswith(magics):
        raise NotBinary(f"{url} does not start with a {suffix} signature")


def download(url: str, dest: Path, *, text: bool = False, max_bytes: int = MAX_BYTES, timeout: float = 60.0) -> Path:
    """Stream to disk with guards; skips when an identical-size file already exists."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    with httpx.Client(follow_redirects=True, timeout=timeout, headers=UA) as client:
        with client.stream("GET", url) as resp:
            if resp.status_code != 200:
                raise RuntimeError(f"{url} → HTTP {resp.status_code}")
            size = int(resp.headers.get("Content-Length", "0") or 0)
            if size > max_bytes:
                raise RuntimeError(f"{url} is {size / 1e6:.0f} MB (> {max_bytes / 1e6:.0f} MB cap)")
            if dest.exists() and size and dest.stat().st_size == size:
                log(f"cached  {dest.name} ({size / 1e6:.1f} MB)")
                return dest
            tmp = dest.with_suffix(dest.suffix + ".part")
            written = 0
            t0 = time.time()
            with open(tmp, "wb") as fh:
                for i, chunk in enumerate(resp.iter_bytes(1 << 20)):
                    if i == 0 and not text:
                        assert_binary(resp, url, chunk)
                    if i == 0 and text and "text/html" in resp.headers.get("Content-Type", ""):
                        raise NotBinary(f"{url} returned HTML instead of a label/kernel")
                    written += len(chunk)
                    if written > max_bytes:
                        raise RuntimeError(f"{url} exceeded {max_bytes / 1e6:.0f} MB")
                    fh.write(chunk)
            tmp.replace(dest)
            log(f"fetched {dest.name} ({written / 1e6:.1f} MB in {time.time() - t0:.1f} s)")
            return dest


def download_first(urls: list[str], dest: Path, **kw) -> tuple[Path, str]:
    last: Exception | None = None
    for u in urls:
        try:
            return download(u, dest, **kw), u
        except Exception as exc:  # noqa: BLE001 — try the next mirror
            log(f"  ✗ {u}: {exc}")
            last = exc
    raise RuntimeError(f"all mirrors failed for {dest.name}: {last}")


def resolve_nasa_directory_link(page_url: str, pattern: str) -> list[str]:
    """Scrape an HTML landing page / Apache index for binary hrefs matching `pattern`.

    Returns absolute URLs, IMG/raw products first, after HEAD-verifying none of them is HTML.
    """
    with httpx.Client(follow_redirects=True, timeout=30, headers=UA) as client:
        html = client.get(page_url).text
        hrefs = re.findall(r'href=["\']([^"\']+\.(?:tif|tiff|img|tab|lbl))["\']', html, re.I)
        urls = []
        for h in hrefs:
            absolute = urllib.parse.urljoin(page_url, h)
            if re.search(pattern, absolute, re.I) and absolute not in urls:
                urls.append(absolute)
        verified = []
        for u in urls:
            try:
                head = client.head(u)
                if head.status_code == 200 and "text/html" not in head.headers.get("Content-Type", ""):
                    verified.append(u)
                else:
                    log(f"  ✗ resolver rejected {u} ({head.status_code}, {head.headers.get('Content-Type')})")
            except httpx.HTTPError as exc:
                log(f"  ✗ resolver could not reach {u}: {exc}")
        verified.sort(key=lambda u: (not u.upper().endswith(".IMG"), u))
        return verified


# ─────────────────────────────── PDS3 labels ───────────────────────────────


@dataclass
class PdsImage:
    lines: int
    samples: int
    dtype: np.dtype
    scale: float
    offset: float
    map_scale: float | None
    line_off: float | None
    sample_off: float | None
    header_bytes: int = 0


def parse_pds3_label(text: str) -> PdsImage:
    def grab(key: str, default: str | None = None) -> str | None:
        m = re.search(rf"^\s*{key}\s*=\s*\"?([^\"\n<]+)", text, re.M)
        return m.group(1).strip() if m else default

    stype = (grab("SAMPLE_TYPE") or "LSB_INTEGER").upper()
    bits = int(grab("SAMPLE_BITS") or 16)
    endian = ">" if stype.startswith(("MSB", "SUN", "MAC")) else "<"
    kind = "f" if "REAL" in stype or "FLOAT" in stype else ("u" if "UNSIGNED" in stype else "i")
    rec_bytes = int(grab("RECORD_BYTES") or 0)
    image_ptr = re.search(r"\^IMAGE\s*=\s*(\d+)", text)
    header = (int(image_ptr.group(1)) - 1) * rec_bytes if image_ptr else 0
    ms = grab("MAP_SCALE")
    return PdsImage(
        lines=int(grab("LINES")),
        samples=int(grab("LINE_SAMPLES")),
        dtype=np.dtype(f"{endian}{kind}{bits // 8}"),
        scale=float(grab("SCALING_FACTOR") or 1.0),
        offset=float((grab("OFFSET") or "0").rstrip(".") or 0),
        map_scale=float(ms.split()[0]) if ms else None,
        line_off=float(grab("LINE_PROJECTION_OFFSET").split()[0]) if grab("LINE_PROJECTION_OFFSET") else None,
        sample_off=float(grab("SAMPLE_PROJECTION_OFFSET").split()[0]) if grab("SAMPLE_PROJECTION_OFFSET") else None,
        header_bytes=header,
    )


def read_pds_image(img: Path, lbl: Path) -> tuple[np.ndarray, PdsImage]:
    info = parse_pds3_label(lbl.read_text(errors="replace"))
    raw = np.fromfile(img, dtype=info.dtype, offset=info.header_bytes, count=info.lines * info.samples)
    return raw.reshape(info.lines, info.samples), info


# ─────────────────────────────── analytic fallback ───────────────────────────────


def stereo_forward(lat: np.ndarray | float, lon: np.ndarray | float) -> tuple[np.ndarray, np.ndarray]:
    lat_r, lon_r = np.radians(lat), np.radians(lon)
    rho = 2 * MOON_R * np.tan(np.pi / 4 + lat_r / 2)
    return rho * np.sin(lon_r), rho * np.cos(lon_r)


def stereo_inverse(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    rho = np.hypot(x, y)
    return np.degrees(2 * np.arctan(rho / (2 * MOON_R)) - np.pi / 2), np.degrees(np.arctan2(x, y))


CRATERS = [  # lat, lon, diameter km, depth m, rim m
    (-89.67, 129.78, 21.0, 4100, 900), (-88.5, -87.1, 32.8, 2900, 700), (-88.1, 44.9, 51.0, 3300, 800),
    (-87.45, -5.16, 51.0, 3400, 900), (-87.3, 77.0, 39.0, 2800, 700), (-88.5, -152.0, 33.0, 2500, 600),
    (-88.1, 110.5, 22.0, 2000, 500), (-85.2, 53.5, 73.0, 3200, 900), (-84.5, 82.8, 103.0, 4200, 1100),
    (-85.3, -42.1, 98.0, 3800, 1000),
]
MASSIFS = [(-85.99, -2.9, 4800, 17, 11, 30), (-84.6, 31.4, 5200, 24, 15, 70), (-85.81, -111.2, 2600, 14, 9, 0), (-88.79, 123.64, 1300, 5, 5, 0)]


def synthetic_dem(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Deterministic analytic model of the real south-polar landforms (metres re 1737.4 km)."""
    h = np.zeros_like(x, dtype=np.float32)
    for lat, lon, dkm, depth, rim in CRATERS:
        cx, cy = stereo_forward(lat, lon)
        s = np.hypot(x - cx, y - cy) / (dkm * 500)
        inside = -depth * (1 - s**2) + rim * s**4
        outside = rim * np.exp(-(((s - 1) / 0.45) ** 2))
        h += np.where(s < 1, inside, np.where(s < 3, outside, 0)).astype(np.float32)
    for lat, lon, hm, smaj, smin, orient in MASSIFS:
        cx, cy = stereo_forward(lat, lon)
        t = np.radians(orient)
        u = (x - cx) * np.cos(t) + (y - cy) * np.sin(t)
        v = -(x - cx) * np.sin(t) + (y - cy) * np.cos(t)
        h += (hm * np.exp(-0.5 * ((u / (smaj * 1e3)) ** 2 + (v / (smin * 1e3)) ** 2))).astype(np.float32)
    return h


def polar_grid_xy(n: int, pixel: float, off: float) -> tuple[np.ndarray, np.ndarray]:
    idx = np.arange(n, dtype=np.float64)
    xs = (idx - off) * pixel
    ys = (off - idx) * pixel
    return np.meshgrid(xs, ys)


# ─────────────────────────────── pipeline steps ───────────────────────────────


def tag(source: str, resolution: str, *, derived: bool = False, synthetic: bool = False, **extra) -> dict:
    return {"source_name": source, "resolution": resolution, "is_derived": derived, "is_synthetic_fallback": synthetic, **extra}


def step_spice(manifest: dict) -> None:
    for name, urls in SPICE_KERNELS.items():
        dest = RAW / "spice" / name
        _, used = download_first(urls, dest, text=name.endswith((".tf", ".tpc")))
        manifest["spice"][name] = used


def step_lola(manifest: dict, synthetic: bool) -> None:
    out = {}
    if not synthetic:
        try:
            for key, base in LOLA_FILES.items():
                download(base + ".lbl", RAW / "lola" / f"{key}.lbl", text=True)
                download(base + ".img", RAW / "lola" / f"{key}.img")
            out["ok"] = True
        except Exception as exc:  # noqa: BLE001
            log(f"LOLA download failed → synthetic DEM: {exc}")
            synthetic = True

    if not synthetic:
        dn, info = read_pds_image(RAW / "lola/ldem_75s_240m.img", RAW / "lola/ldem_75s_240m.lbl")
        dem = dn.astype(np.float32) * np.float32(info.scale)
        pixel, off = info.map_scale, info.line_off
        g16, g16info = read_pds_image(RAW / "lola/ldem_16.img", RAW / "lola/ldem_16.lbl")
        np.save(PROC / "ldem_16_m.npy", g16.astype(np.float32) * np.float32(g16info.scale))
        manifest["layers"]["ldem_16"] = tag("LOLA LDEM_16", "16 ppd (1.9 km/px)", path="ldem_16_m.npy",
                                            lines=g16info.lines, samples=g16info.samples)
        src = tag("LOLA LDEM_75S_240M", "240 m/px")
    else:
        pixel, off, n = 240.0, 1905.5, 3812
        x, y = polar_grid_xy(n, pixel, off)
        dem = synthetic_dem(x, y)
        src = tag("Analytic south-pole DEM", "240 m/px", synthetic=True)

    # Orientation check against Shackleton (a ~4 km deep bowl at 89.67°S 129.78°E).
    sx, sy = stereo_forward(-89.67, 129.78)
    r, c = int(round(off - sy / pixel)), int(round(sx / pixel + off))
    win = dem[r - 20 : r + 21, c - 20 : c + 21]
    rim = dem[r - 60 : r + 61, c - 60 : c + 61]
    log(f"Shackleton check: floor {win.min():.0f} m vs. surroundings median {np.median(rim):.0f} m")

    np.save(PROC / "ldem_75s_240m_m.npy", dem)
    manifest["layers"]["ldem"] = {**src, "path": "ldem_75s_240m_m.npy", "pixel_m": pixel, "offset_px": off, "n": int(dem.shape[0])}

    # Slope (°) via np.gradient and RMS roughness via uniform_filter window variance.
    dz_dy, dz_dx = np.gradient(dem, pixel)
    slope = np.degrees(np.arctan(np.hypot(dz_dx, dz_dy))).astype(np.float32)
    mean = ndimage.uniform_filter(dem.astype(np.float64), 3)
    sq = ndimage.uniform_filter(dem.astype(np.float64) ** 2, 3)
    rough = np.sqrt(np.clip(sq - mean**2, 0, None)).astype(np.float32)
    np.save(PROC / "slope_deg.npy", slope)
    np.save(PROC / "roughness_m.npy", rough)
    syn = src["is_synthetic_fallback"]
    manifest["layers"]["slope"] = tag("LOLA LDEM 240m (np.gradient)", "240 m/px", derived=True, synthetic=syn, path="slope_deg.npy")
    manifest["layers"]["roughness"] = tag("LOLA LDEM 240m (uniform_filter RMS, 3×3)", "720 m window", derived=True, synthetic=syn, path="roughness_m.npy")

    # Browser heightmap: 2× downsampled, RG16-packed PNG (see frontend/src/lib/terrainHeight.ts).
    half = dem[: dem.shape[0] // 2 * 2, : dem.shape[1] // 2 * 2]
    half = half.reshape(half.shape[0] // 2, 2, half.shape[1] // 2, 2).mean(axis=(1, 3))
    scale_m, offset_m = 0.5, -16384.0
    dn16 = np.clip(np.round((half - offset_m) / scale_m), 0, 65535).astype(np.uint16)
    rgba = np.zeros((*dn16.shape, 4), np.uint8)
    rgba[..., 0] = dn16 >> 8
    rgba[..., 1] = dn16 & 0xFF
    rgba[..., 3] = 255
    Image.fromarray(rgba, "RGBA").save(PROC / "polar_heightmap.png", optimize=False)
    hp = pixel * 2
    extent = dn16.shape[1] * hp / 2
    (PROC / "polar_heightmap.json").write_text(json.dumps({
        "width": int(dn16.shape[1]), "height": int(dn16.shape[0]), "pixel_size_m": hp,
        "x_min_m": -extent, "y_max_m": extent, "encoding": "rg16", "scale_m": scale_m, "offset_m": offset_m,
        "source": tag(src["source_name"], f"{hp:.0f} m/px (2× mean)", synthetic=syn),
    }))


def step_illumination(manifest: dict, synthetic: bool) -> None:
    ldem = manifest["layers"]["ldem"]
    pixel = 240.0
    for key, pattern in ILLUMINATION_PRODUCTS.items():
        done = False
        if not synthetic:
            try:
                urls = resolve_nasa_directory_link(PGDA_PRODUCT_69, pattern)
                img_urls = [u for u in urls if u.upper().endswith(".IMG")]
                if not img_urls:
                    raise RuntimeError("no binary IMG link survived the HTML guard")
                img, used = download_first(img_urls, RAW / "pgda" / f"{key}.img")
                download_first([u[:-4] + ".LBL" for u in img_urls], RAW / "pgda" / f"{key}.lbl", text=True)
                manifest["sources"][key] = used
                done = True
            except Exception as exc:  # noqa: BLE001
                log(f"{key}: {exc} → synthetic")
        if done:
            dn, info = read_pds_image(RAW / "pgda" / f"{key}.img", RAW / "pgda" / f"{key}.lbl")
            off = info.line_off
            values = dn.astype(np.float32) * np.float32(info.scale) + np.float32(info.offset)
            src_name = {"avg_vis": "PGDA AVGVISIB_65S_240M (Sun)", "earth_vis": "PGDA AVGVISIB_65S_240M_EARTH",
                        "psr": "PGDA LPSR_65S_240M"}[key]
            syn = False
        else:
            n, off = 6420, 3209.5
            x, y = polar_grid_xy(n, pixel, off)
            lat, _ = stereo_inverse(x, y)
            dem = synthetic_dem(x, y)
            if key == "avg_vis":
                values = np.clip(0.25 + dem / 8000 + (lat + 90) / 120, 0, 0.95).astype(np.float32)
            elif key == "earth_vis":
                values = np.clip(0.5 + dem / 10000 + np.sin(np.radians(stereo_inverse(x, y)[1])) * 0.0, 0, 1).astype(np.float32)
            else:
                values = ((dem < -1500) & (lat < -84)).astype(np.float32)
            src_name, syn = f"Analytic {key}", True
        np.save(PROC / f"{key}_65s_240m.npy", values.astype(np.float32))
        manifest["layers"][key] = tag(src_name, "240 m/px", synthetic=syn, path=f"{key}_65s_240m.npy",
                                      offset_px=off, pixel_m=pixel, n=int(values.shape[0]))
        if key == "psr":
            # Euclidean distance (km) from every pixel to the nearest permanently shadowed pixel.
            psr = values > 0.5
            dist = ndimage.distance_transform_edt(~psr) * pixel / 1000.0
            np.save(PROC / "psr_distance_km.npy", dist.astype(np.float32))
            manifest["layers"]["psr_distance"] = tag(f"{src_name} (EDT)", "240 m/px", derived=True, synthetic=syn,
                                                     path="psr_distance_km.npy", offset_px=off, pixel_m=pixel, n=int(values.shape[0]))
    log(f"illumination grids co-registered with LDEM (offset Δ = {manifest['layers']['avg_vis']['offset_px'] - ldem['offset_px']:.0f} px)")


def step_pgda_5m(manifest: dict, enabled: bool) -> None:
    import rasterio

    for site, region in PGDA_5M_SITES.items():
        if not enabled:
            break
        dest = RAW / "pgda5m" / f"{site}_final_adj_5mpp_surf.tif"
        try:
            download(f"{PGDA_5M}/{site}/{site}_final_adj_5mpp_surf.tif", dest)
            with rasterio.open(dest) as ds:
                b = ds.bounds
            manifest["sites_5m"][site] = {"region": region, "path": str(dest.relative_to(DATA)),
                                          "bounds": [b.left, b.bottom, b.right, b.top]}
        except Exception as exc:  # noqa: BLE001
            log(f"PGDA 5 m {site} unavailable: {exc}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--synthetic", action="store_true", help="skip all downloads except SPICE; analytic grids")
    ap.add_argument("--no-5m", action="store_true", help="skip PGDA 5 m/px site DEMs")
    args = ap.parse_args()

    PROC.mkdir(parents=True, exist_ok=True)
    manifest: dict = {"generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "spice": {}, "layers": {},
                      "sources": {}, "sites_5m": {}}
    t0 = time.time()
    step_spice(manifest)
    step_lola(manifest, args.synthetic)
    step_illumination(manifest, args.synthetic)
    step_pgda_5m(manifest, not (args.synthetic or args.no_5m))
    (PROC / "manifest.json").write_text(json.dumps(manifest, indent=2))
    synth = [k for k, v in manifest["layers"].items() if v.get("is_synthetic_fallback")]
    log(f"done in {time.time() - t0:.0f} s · synthetic layers: {synth or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
