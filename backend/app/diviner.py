"""
Diviner products read by HTTP byte range (no bulk download), cached forever in the Tier-1 disk cache.

• Global Cumulative Products (GCP), PDS Geosciences `data_derived_gcp/global_cumul_avg_cyl_{band}_002.tab`:
  fixed-width ASCII, 113-byte rows, 1 header row, binned 0.5° lat × 0.5° lon × 0.25 h local time
  (96 bins), ordered lon (outer) → lat → local time. A site's 96 bolometric temperatures (tbol)
  are therefore one contiguous 10 848-byte range.
• Rock abundance `dgdr_ra_avg_cyl_032_img.img`: 16-bit LSB, 32 px/deg, ±60° lat only
  (Diviner's rock-abundance retrieval does not cover the poles).
"""

from __future__ import annotations

import numpy as np

from .cache import fetch_bytes_cached
from .terrain import tag

PDS = "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1"
GCP_ROW = 113
GCP_LT_BINS = 96
RA_URL = f"{PDS}/data_derived_gdr_l3/cylindrical/img/dgdr_ra_avg_cyl_032_img.img"
RA_ROW_BYTES = 23040  # 11 520 int16 samples
RA_PPD = 32
RA_SCALE = 0.001
RA_MISSING = -32768


def _gcp_band(lat: float) -> tuple[str, float]:
    lo = int(np.floor(lat / 10.0) * 10)
    lo = max(-90, min(80, lo))
    hi = lo + 10
    hemi = "s" if lo < 0 else "n"
    if hemi == "s":
        name = f"{abs(lo):02d}s{abs(hi):02d}s"
    else:
        name = f"{lo:02d}n{hi:02d}n"
    return name, float(lo)


def surface_temperature(lat: float, lon: float) -> tuple[dict, dict]:
    """(min/mean/max K over the diurnal cycle, source tag) from Diviner GCP tbol."""
    band, lo = _gcp_band(lat)
    url = f"{PDS}/data_derived_gcp/global_cumul_avg_cyl_{band}_002.tab"
    lon_i = int(np.floor((((lon + 180.0) % 360.0)) / 0.5)) % 720
    lat_i = min(19, int(np.floor((lat - lo) / 0.5)))
    k0 = (lon_i * 20 + lat_i) * GCP_LT_BINS
    start = (1 + k0) * GCP_ROW
    raw = fetch_bytes_cached(url, byte_range=(start, start + GCP_LT_BINS * GCP_ROW - 1)).decode("ascii", "replace")
    tb = []
    for line in raw.splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) != 11:
            continue
        clon, clat, tbol = float(cols[0]), float(cols[1]), float(cols[10])
        if abs(clat - (lo + 0.25 + 0.5 * lat_i)) > 1e-3 or abs(clon - (-179.75 + 0.5 * lon_i)) > 1e-3:
            raise ValueError(f"GCP row layout mismatch at {clon},{clat}")
        if tbol > 0:
            tb.append(tbol)
    if not tb:
        raise ValueError("no valid Diviner tbol observations in this bin")
    arr = np.array(tb)
    return (
        {"min_k": float(arr.min()), "mean_k": float(arr.mean()), "max_k": float(arr.max())},
        tag("Diviner GCP tbol (Williams 2017)", f"0.5° bin · {len(tb)}/96 local-time bins"),
    )


def rock_abundance_pct(lat: float, lon: float) -> tuple[float, dict] | None:
    """Mean areal fraction (%) of ≥1 m rocks in a 3×3 window, or None outside ±60°."""
    if abs(lat) > 59.9:
        return None
    lon360 = lon % 360.0
    col = int(round(5759.5 + (lon360 - 180.0) * RA_PPD))
    row = int(round(1919.5 - lat * RA_PPD))
    vals = []
    for r in (row - 1, row, row + 1):
        start = r * RA_ROW_BYTES + (col - 1) * 2
        chunk = fetch_bytes_cached(RA_URL, byte_range=(start, start + 5))
        dn = np.frombuffer(chunk, dtype="<i2")
        vals.extend(int(v) for v in dn if v != RA_MISSING)
    if not vals:
        return None
    return float(np.mean(vals) * RA_SCALE * 100.0), tag("Diviner rock abundance (RA avg)", "32 ppd (≈950 m)")
