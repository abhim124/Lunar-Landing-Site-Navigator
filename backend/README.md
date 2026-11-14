# Lunar Landing Site Navigator — Backend (Phase 1)

FastAPI + Skyfield/DE421 + NumPy/SciPy + rasterio, serving real NASA data to the Next.js frontend.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python ../scripts/ingest_nasa_data.py      # ≈ 440 MB download, ~4 min; --synthetic for offline
.venv/bin/uvicorn app.main:app --port 8000
export NASA_API_KEY=…                                 # optional: DEMO_KEY allows only 10 DONKI req/h
```

## Data actually used (all verified live, 2026-11)

| Layer | Source | Notes |
| --- | --- | --- |
| Ephemeris | NAIF `de421.bsp` (now at `spk/planets/a_old_versions/`), `moon_pa_de421_1900-2050.bpc`, `moon_080317.tf`, `pck00010.tpc` | `pck00008.tpc` was retired, so pck00010 replaces it. Matches JPL Horizons to ≤ 0.0004°. |
| Elevation, horizon, slope, roughness | LOLA `LDEM_75S_240M` | Slope comes from `np.gradient`, roughness from `uniform_filter` 3×3 RMS. |
| Non-polar sites | LOLA `LDEM_16` | 1.9 km/px, used for Apollo 11 and Chandrayaan-3. |
| Artemis 5 m pads | PGDA `LOLA_5mpp/SiteNN/SiteNN_final_adj_5mpp_surf.tif` (Sites 01, 04, 07) | Slope and roughness come from a plane fit over a 45 m pad. |
| Average Sun visibility, Earth visibility, PSR | PGDA product 69, via the MIT imbrium mirror | The pgda.gsfc.nasa.gov `.TIF` links return a 200-status HTML "Not Found" page, which the ingest guard rejects. These rasters are co-registered with LDEM at a +1304 px offset. |
| Distance to the nearest PSR | Euclidean distance transform of the LPSR map | This measures distance to a cold trap. It does not prove ice is there. |
| Surface temperature | Diviner GCP `tbol`, read by HTTP Range (one 10.8 KB read per site) | 0.5° bins × 96 local-time bins. That is ≈ 15 km, not 240 m. |
| Rock abundance | Diviner RA avg (32 ppd), read by HTTP Range | Covers ±60° only, so polar sites return `null` ("No data"). |
| Space weather | NASA DONKI SEP + FLR | Disk-cached. Responses that are UNKNOWN never downgrade a verdict. |
| Validation | JPL Horizons API (`coord@301`, `QUANTITIES=4`, `AIRLESS`) | Disk-cached for offline judging. |

Not used: LEND and Mini-RF, because their PDS directories expose no product links, and SLDEM2015, because LDEM_16 covers the equatorial benchmarks. Moon Trek layers `LRO_LOLA_ClrShade_SP_100m` and `LRO_DLRE_RockAbundance` return 404. The backend renders the relief, Sun-visibility and Earth-visibility overlays itself from the rasters above (`/api/overlays/*`).

## Routes

- `POST /api/evaluate`
- `POST /api/nearest-alternative`
- `GET /api/launch-calendar`
- `GET /api/validation`
- `GET /api/space-weather`
- `GET /api/terrain/polar-heightmap.{png,json}`
- `GET /api/overlays/{lola_relief|pgda_sun_vis|pgda_earth_vis}.{png,json}`
- `GET /api/tiles/SP/{layer}/{z}/{row}/{col}.png` (cached Moon Trek proxy)
- `GET /api/health`

Verdict thresholds are documented at the top of `app/evaluation.py`.
