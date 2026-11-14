"""Pre-loaded mission & benchmark registry (mirrors frontend/src/lib/siteRegistry.ts)."""

BENCHMARKS = [
    {"id": "apollo-11", "name": "Apollo 11 · Tranquility Base", "lat": 0.67408, "lon": 23.47297,
     "epoch_utc": "1969-07-20T20:17:40Z", "reference": {"SUN_EL": 10.7, "SUN_AZ": 88.8}},
    {"id": "chandrayaan-3", "name": "Chandrayaan-3 · Statio Shiv Shakti", "lat": -69.373, "lon": 32.319,
     "epoch_utc": "2023-08-23T12:33:00Z", "reference": {}},
    {"id": "im-1", "name": "IM-1 Odysseus · Malapert A", "lat": -80.13, "lon": 1.44,
     "epoch_utc": "2024-02-22T23:23:00Z", "reference": {}},
    {"id": "im-2", "name": "IM-2 Athena · Mons Mouton", "lat": -84.79059, "lon": 29.19567,
     "epoch_utc": "2025-03-06T17:28:00Z", "reference": {"SUN_AZ": 65.687, "SUN_EL": 2.464}},
]

# Representative centres of the Artemis III candidate regions (approximate — flagged in the UI).
ARTEMIS_III = [
    {"id": "artemis-peak-near-shackleton", "name": "Peak Near Shackleton", "lat": -88.79, "lon": 123.64},
    {"id": "artemis-connecting-ridge", "name": "Connecting Ridge", "lat": -89.45, "lon": -137.31},
    {"id": "artemis-connecting-ridge-extension", "name": "Connecting Ridge Extension", "lat": -89.02, "lon": -101.5},
    {"id": "artemis-de-gerlache-rim-1", "name": "de Gerlache Rim 1", "lat": -88.67, "lon": -68.6},
    {"id": "artemis-de-gerlache-rim-2", "name": "de Gerlache Rim 2", "lat": -88.25, "lon": -73.6},
    {"id": "artemis-de-gerlache-kocher-massif", "name": "de Gerlache–Kocher Massif", "lat": -85.81, "lon": -111.2},
    {"id": "artemis-haworth", "name": "Haworth", "lat": -86.84, "lon": -22.1},
    {"id": "artemis-malapert-massif", "name": "Malapert Massif", "lat": -85.99, "lon": -2.9},
    {"id": "artemis-nobile-rim-1", "name": "Nobile Rim 1", "lat": -85.42, "lon": 37.6},
    # October 2024 regions — published landing-site coordinates (see frontend siteRegistry.ts for citations)
    {"id": "artemis-mons-mouton-plateau", "name": "Mons Mouton Plateau", "lat": -84.528, "lon": 30.719},  # Mahanti et al. 2025, LPSC #2742
    {"id": "artemis-mons-mouton", "name": "Mons Mouton", "lat": -85.416, "lon": 31.851},  # Wueller et al. 2026, JGR, site MMO01
    {"id": "artemis-nobile-rim-2", "name": "Nobile Rim 2", "lat": -84.20156, "lon": 60.69989},  # Sánchez-Lozano et al. 2025, LPSC #1149
    {"id": "artemis-slater-plain", "name": "Slater Plain", "lat": -87.48, "lon": 124.52},  # Wueller et al. 2026, JGR, site SP01
    {"id": "artemis-peak-near-cabeus-b", "name": "Peak near Cabeus B", "lat": -83.6, "lon": -68.8},  # LROC NAC_ROI_CABEUSPKLOB mosaic centre
]

ARTEMIS_BY_ID = {a["id"]: a for a in ARTEMIS_III}
