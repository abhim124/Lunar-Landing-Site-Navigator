# Lunar Landing Site Navigator

Mission-planning and decision-support app for lunar south pole landings (NASA Space Apps 2026).
Pick any site and any date and the app answers "is it viable?". If not, it answers
**"so where, or when, should we land instead?"**

- **3D globe** of the Moon with real LOLA terrain, live Sun/Earth lighting, and NASA overlays.
- **Verdict card** shows sunlit %, longest darkness, time to sunset and Earthset, and Earth contact. Every number has a data-source label behind an (i) button.
- **Nearest viable alternative** finds the best pad within 5 km and the best date within ±14 days.
- **Timeline**, **365-day launch-slip calendar**, and a **validation panel** against JPL Horizons and mission history.
- **Space weather** from NASA DONKI, plus an **Ask AI** chat panel (frontend only; no AI backend yet).

```
frontend/   Next.js 15 + React Three Fiber (3D globe, UI)
backend/    FastAPI + Skyfield/DE421 + NumPy/SciPy + rasterio (all the physics and data)
scripts/    ingest_nasa_data.py: downloads and prepares the NASA datasets
```

---

## Requirements

- **Python 3.11 or newer** (tested on 3.14)
- **Node.js 20 or newer** (tested on 26)
- About **1.5 GB of free disk space** for the NASA data
- Internet access for the first setup (after that it runs fully offline)

## 1. Backend setup (one time)

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

On Windows, use `.venv\Scripts\pip` and `.venv\Scripts\python` instead of `.venv/bin/...`.

Download and prepare the NASA data. This is about 440 MB and takes around 4 minutes.

```bash
.venv/bin/python ../scripts/ingest_nasa_data.py
```

This fetches the NAIF SPICE kernels, LOLA elevation grids, PGDA illumination, Earth-visibility and permanent-shadow maps, and the PGDA 5 m Artemis site DEMs. It writes everything into `backend/data/`.

Options:

- `--no-5m` skips the 5 m site DEMs (about 120 MB).
- `--synthetic` builds an offline analytic model instead of downloading the terrain. Use it only if you have no internet.

### NASA API key (recommended)

Space weather uses NASA DONKI. The shared `DEMO_KEY` is limited to 10 requests per hour.

1. Get a free key at https://api.nasa.gov.
2. Copy the example file:

   ```bash
   cp .env.example .env
   ```

3. Paste the key after `NASA_API_KEY=` in `backend/.env`.

`backend/.env` is git-ignored, so the key is never committed.

## 2. Frontend setup (one time)

```bash
cd frontend
npm install
cp .env.example .env.local
```

`.env.local` points the app at `http://localhost:8000`. The Moon base texture is already in `public/textures/`. To re-download it, run `npm run fetch:textures`.

## 3. Run it

Use two terminals.

**Terminal 1, backend:**

```bash
cd backend
.venv/bin/uvicorn app.main:app --port 8000
```

**Terminal 2, frontend:**

```bash
cd frontend
npm run dev -- -p 3100
```

Open **http://localhost:3100**.

The first page load in dev mode takes about 15 seconds while Next.js compiles the 3D bundle. For a faster demo build, run `npm run build && npm start -- -p 3100`.

To check the backend is healthy, open http://localhost:8000/api/health. It should report `"synthetic_layers": []`.

## Demo path

1. In the top bar, pick **Malapert Massif**. On the default date it comes back **NO-GO**.
2. Under **Where or when instead?**, click **Relocate Lander** to move to a better pad 1.6 km away.
3. Click **Shift Launch Window**. The verdict becomes **GO**.
4. Open the **365-Day Launch Slip** tab to see every launch day scored. Click a day to jump to it.
5. Open **NASA Validation** to compare our numbers with JPL Horizons and mission history.
6. Hand the mouse to a judge: click anywhere on the Moon and change the date.

## Offline judging

Every external call is cached on disk in `backend/data/cache/`: JPL Horizons, DONKI, Diviner byte-range reads, and Moon Trek tiles. Run the demo once while online, and after that it works with no internet.

## Validation

All values are apparent (airless) positions from a lunar surface point. "Ours" is the offline Skyfield, DE421 and MOON_ME engine.

| Benchmark | Quantity | Ours | JPL Horizons | Published reference |
| --- | --- | --- | --- | --- |
| Apollo 11 (1969-07-20 20:17:40 UTC) | Sun elevation | 10.7035° | 10.7031° | 10.7° |
| Apollo 11 | Sun azimuth | 88.8055° | 88.8055° | 88.8° |
| IM-2 Athena (2025-03-06 17:28 UTC) | Sun azimuth | 65.6874° | 65.6874° | 65.687° |
| IM-2 Athena | Sun elevation | 2.4641° | 2.4641° | 2.464° |
| IM-2 Athena | Earth elevation | 11.1930° | 11.1930° | — |

The largest difference from Horizons across Apollo 11, Chandrayaan-3, IM-1 and IM-2 (Sun and Earth, azimuth and elevation) is **0.00034°**. Live results are in the app's **NASA Validation** tab.

## Data sources

See [`backend/README.md`](backend/README.md) for every dataset, its resolution, the URLs that had to be corrected, and the verdict thresholds. The Artemis region coordinates and their citations are in [`frontend/src/lib/siteRegistry.ts`](frontend/src/lib/siteRegistry.ts).

## Known limitations

- **Solar flares:** NASA's DONKI flare (FLR) endpoint currently returns 404 upstream. Solar energetic particle (SEP) events still drive the EVA radiation call.
- **Rock abundance:** Diviner rock abundance covers ±60° only, so polar sites show "No data".
- **Temperature:** uses the Diviner global cumulative product (0.5° bins), not the 240 m seasonal product.
- **Older Artemis regions:** the five 2022 regions use approximate region centres and are flagged "≈" in the UI.
- **Ask AI:** the chat backend is not built. To enable it, implement `POST /api/chat` (see `frontend/src/lib/chatClient.ts`) and set `NEXT_PUBLIC_CHAT_ENABLED=true`.
