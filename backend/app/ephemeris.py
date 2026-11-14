"""
Ephemeris engine (offline, vectorised) + JPL Horizons validation client + NASA DONKI client.

Local engine: Skyfield + DE421 + MOON_PA_DE421 binary PCK + moon_080317.tf, observing from a
point fixed in the MOON_ME_DE421 frame. Verified against the IM-2 benchmark
(2025-03-06 17:28 UTC: Sun az 65.687°, el 2.464°) and Apollo 11 (88.8° / 10.7°).
"""

from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import numpy as np
from skyfield.api import load, load_file
from skyfield.planetarylib import PlanetaryConstants

from .cache import SPICE_DIR, fetch_json_cached

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
DONKI_URL = "https://api.nasa.gov/DONKI"
DONKI_CCMC_URL = "https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get"  # keyless origin server
_donki_backoff_until = 0.0
_donki_backoff_key: str | None = None
ENV_FILE = SPICE_DIR.parents[2] / ".env"  # backend/.env


def nasa_api_key() -> str:
    """NASA_API_KEY from the environment, else backend/.env (re-read each call: no restart needed)."""
    key = os.environ.get("NASA_API_KEY", "").strip()
    if not key and ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "NASA_API_KEY":
                key = value.strip().strip("'\"")
    return key or "DEMO_KEY"

SPICE_SOURCE = {
    "source_name": "NAIF DE421 + MOON_PA_DE421 (Skyfield)",
    "resolution": "topocentric, MOON_ME frame",
    "is_derived": False,
    "is_synthetic_fallback": False,
}


def parse_utc(iso: str) -> datetime:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class TopoSeries:
    hours: np.ndarray
    sun_az: np.ndarray
    sun_el: np.ndarray
    earth_az: np.ndarray
    earth_el: np.ndarray
    subsolar_lat: np.ndarray
    subsolar_lon: np.ndarray
    subearth_lat: np.ndarray
    subearth_lon: np.ndarray


class EphemerisEngine:
    _instance: "EphemerisEngine | None" = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self.ts = load.timescale(builtin=True)
        self.eph = load_file(str(SPICE_DIR / "de421.bsp"))
        self.pc = PlanetaryConstants()
        with open(SPICE_DIR / "moon_080317.tf", "rb") as fh:
            self.pc.read_text(fh)
        with open(SPICE_DIR / "pck00010.tpc", "rb") as fh:
            self.pc.read_text(fh)
        # jplephem reads PCK segments lazily, so this handle must stay open for the process lifetime.
        self._bpc = open(SPICE_DIR / "moon_pa_de421_1900-2050.bpc", "rb")  # noqa: SIM115
        self.pc.read_binary(self._bpc)
        self.frame = self.pc.build_frame_named("MOON_ME_DE421")
        self.moon, self.sun, self.earth = self.eph["moon"], self.eph["sun"], self.eph["earth"]

    @classmethod
    def get(cls) -> "EphemerisEngine":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = EphemerisEngine()
        return cls._instance

    def times(self, start: datetime, hours: np.ndarray):
        return self.ts.utc(start.year, start.month, start.day, start.hour, start.minute, start.second + hours * 3600.0)

    def topocentric(self, lat: float, lon: float, elev_m: float, start: datetime, hours: np.ndarray) -> TopoSeries:
        """Apparent (airless) Sun and Earth az/el for one surface point over a vector of times."""
        t = self.times(start, np.atleast_1d(hours).astype(float))
        place = self.moon + self.pc.build_latlon_degrees(self.frame, lat, lon, elevation_m=elev_m)
        obs = place.at(t)
        s_alt, s_az, _ = obs.observe(self.sun).apparent().altaz()
        e_alt, e_az, _ = obs.observe(self.earth).apparent().altaz()
        sv = (self.sun - self.moon).at(t).frame_xyz(self.frame).au
        ev = (self.earth - self.moon).at(t).frame_xyz(self.frame).au
        sub = lambda v: (np.degrees(np.arcsin(v[2] / np.linalg.norm(v, axis=0))), np.degrees(np.arctan2(v[1], v[0])))  # noqa: E731
        sl, so = sub(np.atleast_2d(sv.T).T)
        el_, eo = sub(np.atleast_2d(ev.T).T)
        return TopoSeries(
            hours=np.atleast_1d(hours).astype(float),
            sun_az=np.atleast_1d(s_az.degrees), sun_el=np.atleast_1d(s_alt.degrees),
            earth_az=np.atleast_1d(e_az.degrees), earth_el=np.atleast_1d(e_alt.degrees),
            subsolar_lat=np.atleast_1d(sl), subsolar_lon=np.atleast_1d(so),
            subearth_lat=np.atleast_1d(el_), subearth_lon=np.atleast_1d(eo),
        )


# ─────────────────────────────── JPL Horizons ───────────────────────────────


async def horizons_azel(body: str, lat: float, lon: float, alt_km: float, when: datetime) -> tuple[float, float, bool]:
    """Apparent (airless) az/el of `body` ('10' Sun, '399' Earth) from a lunar surface site."""
    start = when.strftime("%Y-%m-%d %H:%M:%S")
    stop = (when + timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S")
    params = {
        "format": "json",
        "COMMAND": f"'{body}'",
        "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "OBSERVER",
        "CENTER": "'coord@301'",
        "COORD_TYPE": "GEODETIC",
        "SITE_COORD": f"'{lon % 360:.6f},{lat:.6f},{alt_km:.4f}'",
        "START_TIME": f"'{start}'",
        "STOP_TIME": f"'{stop}'",
        "STEP_SIZE": "'1 m'",
        "QUANTITIES": "'4'",
        "ANG_FORMAT": "DEG",
        "APPARENT": "AIRLESS",
        "CSV_FORMAT": "YES",
        "TIME_DIGITS": "SECONDS",
    }
    res = await fetch_json_cached(HORIZONS_URL, params, fresh_s=None, timeout=30)
    text = res.value.get("result", "")
    block = re.search(r"\$\$SOE\s*(.*?)\s*\$\$EOE", text, re.S)
    if not block:
        raise ValueError(f"Horizons returned no ephemeris: {text[:200]}")
    first = [f.strip() for f in block.group(1).splitlines()[0].split(",")]
    nums = [float(f) for f in first[1:] if re.fullmatch(r"-?\d+(\.\d+)?", f)]
    az, el = nums[-2], nums[-1]
    return az, el, res.from_cache


# ─────────────────────────────── NASA DONKI ───────────────────────────────

DONKI_FIRST_DAY = datetime(2010, 4, 1, tzinfo=timezone.utc)


async def space_weather(epoch: datetime, mission_days: float) -> dict:
    """SEP + solar flare Go/No-Go for the window [epoch − 7 d, epoch + mission] (clamped to today)."""
    now = datetime.now(timezone.utc)
    start = epoch - timedelta(days=7)
    end = min(epoch + timedelta(days=mission_days), now)
    source = {"source_name": "NASA DONKI SEP + FLR", "resolution": "event catalogue", "is_derived": False,
              "is_synthetic_fallback": False}
    base = {"window_start": iso_z(start), "window_end": iso_z(epoch + timedelta(days=mission_days)),
            "sep_event_count": 0, "flare_count": 0, "strongest_flare_class": None, "latest_event_utc": None,
            "cached_at_utc": None, "served_from_cache": False, "source": source}

    if start > now:
        return {**base, "status": "UNKNOWN", "eva_status": "MARGINAL",
                "summary": "Epoch is in the future — DONKI only catalogues observed events. Check NOAA SWPC forecasts before EVA."}
    if end < DONKI_FIRST_DAY:
        return {**base, "status": "UNKNOWN", "eva_status": "MARGINAL",
                "summary": "Before DONKI coverage (April 2010) — no space-weather record for this epoch."}

    dates = {"startDate": start.date().isoformat(), "endDate": end.date().isoformat()}
    fresh = 3600 if (now - end) < timedelta(days=2) else None  # past windows are immutable
    global _donki_backoff_until, _donki_backoff_key
    api_key = nasa_api_key()
    # A newly added key lifts the back-off immediately.
    backing_off = time.time() < _donki_backoff_until and api_key == _donki_backoff_key
    # SEP (the EVA radiation driver) is required; the FLR catalogue is best-effort because NASA's
    # DONKI FLR endpoint has been returning 404 from its upstream while SEP/GST still work.
    sep_res = flr_res = None
    errors: list[str] = []
    for base_url, params in ((DONKI_URL, {**dates, "api_key": api_key}), (DONKI_CCMC_URL, dates)):
        f = float("inf") if backing_off else fresh  # back-off → disk cache only
        try:
            sep_res = await fetch_json_cached(f"{base_url}/SEP", params, fresh_s=f, timeout=6)
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            errors.append(f"{'api.nasa.gov' if base_url == DONKI_URL else 'CCMC'}: "
                          + ("429 rate limit" if "429" in msg else exc.__class__.__name__))
            continue
        try:
            flr_res = await fetch_json_cached(f"{base_url}/FLR", params, fresh_s=f, timeout=6)
        except Exception:  # noqa: BLE001
            flr_res = None
        break
    if sep_res is None:
        _donki_backoff_until = time.time() + 600
        _donki_backoff_key = api_key
        hint = " Add NASA_API_KEY to backend/.env." if api_key == "DEMO_KEY" else ""
        return {**base, "status": "UNKNOWN", "eva_status": "MARGINAL",
                "summary": f"DONKI SEP unavailable ({'; '.join(errors) or 'no route'}) and no cached copy.{hint}"}

    seps = sep_res.value or []
    flares = (flr_res.value or []) if flr_res else []
    flr_note = "" if flr_res else " (flare catalogue unavailable from DONKI)"
    classes = [f.get("classType") or "" for f in flares]

    def rank(c: str) -> float:
        m = re.match(r"([ABCMX])(\d+(?:\.\d+)?)", c)
        return {"A": 0, "B": 1, "C": 2, "M": 3, "X": 4}[m.group(1)] * 100 + float(m.group(2)) if m else -1

    strongest = max(classes, key=rank) if classes else None
    times = [e.get("eventTime") for e in seps] + [f.get("peakTime") for f in flares]
    latest = max((t for t in times if t), default=None)
    x_flare = strongest is not None and strongest.startswith("X")
    status = "ELEVATED RADIATION" if seps or x_flare else "CLEAR"
    eva = "NO-GO" if seps else ("MARGINAL" if x_flare else "GO")
    if seps:
        summary = f"{len(seps)} solar energetic particle event(s) in window — shelter, no EVA."
    elif x_flare:
        summary = f"{strongest} flare in window — SEP onset possible; EVA on short tether."
    elif flares:
        summary = f"No SEP events; {len(flares)} flare(s), strongest {strongest}."
    else:
        summary = "No SEP events" + (" or flares" if flr_res else "") + " catalogued in window."
    summary += flr_note
    if not flr_res:
        source = {**source, "source_name": "NASA DONKI SEP (FLR unavailable)"}
    cached = sep_res.from_cache and (flr_res is None or flr_res.from_cache)
    return {**base, "status": status, "eva_status": eva, "sep_event_count": len(seps), "flare_count": len(flares),
            "strongest_flare_class": strongest, "latest_event_utc": latest, "summary": summary,
            "cached_at_utc": sep_res.cached_at, "served_from_cache": cached, "source": source}
