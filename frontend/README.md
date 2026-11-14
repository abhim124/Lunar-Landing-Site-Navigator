# Lunar Landing Site Navigator — Frontend (Phase 2)

Next.js 15 (App Router) · React 19 · @react-three/fiber 9 · drei 10 · Zustand 5 · Tailwind 4.

```bash
npm install
npm run fetch:textures        # caches the NASA SVS CGI Moon Kit 2K JPEG into public/textures
cp .env.example .env.local    # point NEXT_PUBLIC_API_BASE at the FastAPI backend
npm run dev
```

## Backend contract (Phase 1 FastAPI must expose these)

All shapes are in `src/types/mission.ts` (snake_case, 1:1 with the Pydantic models). All routes live in `src/lib/api.ts`.

| Route | Purpose |
| --- | --- |
| `POST /api/evaluate` | `SiteEvaluationRequest` → `SiteEvaluationResponse` (verdict, metrics, skyline, 30-min trajectory with sub-solar/sub-Earth points) |
| `POST /api/nearest-alternative` | 2-stage coarse-to-fine recommender → `NearestAlternativeResponse` |
| `GET /api/launch-calendar` | `start_date`, `n_days=365`, … → `LaunchCalendarResponse` |
| `GET /api/validation` | `lat`, `lon`, `epoch_utc` → `ValidationBenchmarkResponse` (Skyfield vs. Horizons vs. history) |
| `GET /api/terrain/polar-heightmap.json` | Grid metadata for the PNG below (`width`, `height`, `pixel_size_m`, `x_min_m`, `y_max_m`, `scale_m`, `offset_m`, `encoding: "rg16"`, `source`) |
| `GET /api/terrain/polar-heightmap.png` | `ldem_75s_240m` packed as `elev_m = (R·256 + G)·scale_m + offset_m`, A=0 → nodata. Write it **without** gAMA/iCCP/sRGB chunks. |
| `GET /api/tiles/SP/{layer}/{z}/{row}/{col}.png` | Tier-1 disk-cached proxy for Moon Trek tiles (used when trek.nasa.gov is unreachable or blocks CORS) |
| `GET /api/overlays/{name}.{png,json}` | South-polar overlays rendered from ingested NASA rasters (`lola_relief`, `pgda_sun_vis`, `pgda_earth_vis`) with stereographic bounds |

The backend needs `CORSMiddleware` allowing the frontend origin.

## Behaviour notes

- **Graceful degradation:** with no backend, the globe still renders. Polar terrain falls back to an analytic model of the real south-pole landforms (flagged SYNTHETIC in the status dot). Lighting falls back to an approximate sub-solar point, and every number is labelled APPROX.
- **Base texture order:** the local copy is tried before `svs.gsfc.nasa.gov`, because SVS sends an `Access-Control-Allow-Origin` header for a different site, so WebGL uploads from other origins are always blocked.
- **Moon Trek tile grid:** the SP matrix set's top-left is ±1,095,930 m, and one z0 tile spans 2,191,860 m. These values come from the layer's `WMTSCapabilities.xml`. Only the tiles covering a layer's real footprint are fetched; for `WAC_POLE_ILL_PCT_SOUTH_100M` that is ±61 km at z5, its deepest level.
- **Real backend:** see `../backend/README.md` for every data source and the URLs that had to be corrected.
- **Dev-only console noise:** React 19 StrictMode double-mounts drei `<Html>` roots. That logs "Attempted to synchronously unmount a root…" once per pin in `next dev` only.
