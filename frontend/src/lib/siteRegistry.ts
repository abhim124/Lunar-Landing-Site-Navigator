/**
 * Pre-loaded mission & benchmark registry (mirrors backend/registry in Phase 1).
 *
 * Benchmark coordinates/epochs are the published landing solutions.
 * Older Artemis region coordinates are representative region centres digitised from NASA's
 * candidate-region maps — flagged `isApproxCoord` (amber APPROX COORD chip). The four regions
 * added from the October 2024 update use published landing-site coordinates, cited in `coordSource`.
 */

export type CuratedCategory = 'BENCHMARK' | 'ARTEMIS_III';

export interface CuratedSite {
  id: string;
  name: string;
  shortName: string;
  category: CuratedCategory;
  lat: number;
  lon: number;
  isApproxCoord: boolean;
  /** Historical landing / target epoch; selecting the site also moves the clock here. */
  epochUTC?: string;
  description: string;
  reference?: { sunAzDeg?: number; sunElDeg?: number };
  /** PGDA 5 m/px LOLA site product covering this region, when one exists. */
  pgdaSiteId?: 'Site01' | 'Site04' | 'Site07';
  /** Where the coordinate comes from (shown behind the Verdict card's (i)). */
  coordSource: string;
}

export const CURATED_SITES: CuratedSite[] = [
  {
    id: 'apollo-11',
    coordSource: 'Published Apollo 11 landing solution (project mission registry)',
    name: 'Apollo 11 · Tranquility Base',
    shortName: 'Apollo 11',
    category: 'BENCHMARK',
    lat: 0.67408,
    lon: 23.47297,
    isApproxCoord: false,
    epochUTC: '1969-07-20T20:17:40Z',
    description: 'Equatorial validation benchmark for the Sun-geometry engine.',
    reference: { sunElDeg: 10.7, sunAzDeg: 88.8 },
  },
  {
    id: 'chandrayaan-3',
    coordSource: 'Published Chandrayaan-3 landing solution (project mission registry)',
    name: 'Chandrayaan-3 · Statio Shiv Shakti',
    shortName: 'Chandrayaan-3',
    category: 'BENCHMARK',
    lat: -69.373,
    lon: 32.319,
    isApproxCoord: false,
    epochUTC: '2023-08-23T12:33:00Z',
    description: 'High-southern-latitude landing; Vikram operated through one lunar day.',
  },
  {
    id: 'im-1',
    coordSource: 'Published IM-1 landing solution (project mission registry)',
    name: 'IM-1 Odysseus · Malapert A',
    shortName: 'IM-1',
    category: 'BENCHMARK',
    lat: -80.13,
    lon: 1.44,
    isApproxCoord: false,
    epochUTC: '2024-02-22T23:23:00Z',
    description: 'First commercial lunar landing; tipped onto its side at touchdown.',
  },
  {
    id: 'im-2',
    coordSource: 'Published IM-2 landing solution (project mission registry)',
    name: 'IM-2 Athena · Mons Mouton',
    shortName: 'IM-2',
    category: 'BENCHMARK',
    lat: -84.79059,
    lon: 29.19567,
    isApproxCoord: false,
    epochUTC: '2025-03-06T17:28:00Z',
    description: 'Southernmost landing to date; low Sun angles and a tip-over cut the mission short.',
    reference: { sunAzDeg: 65.687, sunElDeg: 2.464 },
  },
  {
    id: 'artemis-peak-near-shackleton',
    name: 'Peak Near Shackleton',
    shortName: 'Peak Nr Shackleton',
    category: 'ARTEMIS_III',
    coordSource: 'Approximate region centre digitised from NASA region maps (not from a published coordinate)',
    lat: -88.79,
    lon: 123.64,
    isApproxCoord: true,
    description: 'Massif rising above Shackleton’s rim with extended illumination.',
    pgdaSiteId: 'Site07',
  },
  {
    id: 'artemis-connecting-ridge',
    name: 'Connecting Ridge',
    shortName: 'Connecting Ridge',
    category: 'ARTEMIS_III',
    coordSource: 'Approximate region centre digitised from NASA region maps (not from a published coordinate)',
    lat: -89.45,
    lon: -137.31,
    isApproxCoord: true,
    description: 'Ridge linking the Shackleton and de Gerlache rims; among the best-lit terrain at the pole.',
    pgdaSiteId: 'Site01',
  },
  {
    id: 'artemis-connecting-ridge-extension',
    name: 'Connecting Ridge Extension',
    shortName: 'Conn. Ridge Ext.',
    category: 'ARTEMIS_III',
    coordSource: 'Approximate region centre digitised from NASA region maps (not from a published coordinate)',
    lat: -89.02,
    lon: -101.5,
    isApproxCoord: true,
    description: 'Continuation of the connecting ridge toward de Gerlache.',
  },
  {
    id: 'artemis-de-gerlache-rim-1',
    name: 'de Gerlache Rim 1',
    shortName: 'de Gerlache Rim 1',
    category: 'ARTEMIS_III',
    coordSource: 'Approximate region centre digitised from NASA region maps (not from a published coordinate)',
    lat: -88.67,
    lon: -68.6,
    isApproxCoord: true,
    description: 'Eastern rim of de Gerlache crater bordering permanently shadowed floor.',
  },
  {
    id: 'artemis-de-gerlache-rim-2',
    name: 'de Gerlache Rim 2',
    shortName: 'de Gerlache Rim 2',
    category: 'ARTEMIS_III',
    coordSource: 'Approximate region centre digitised from NASA region maps (not from a published coordinate)',
    lat: -88.25,
    lon: -73.6,
    isApproxCoord: true,
    description: 'Northern rim segment of de Gerlache crater.',
  },
  {
    id: 'artemis-de-gerlache-kocher-massif',
    name: 'de Gerlache–Kocher Massif',
    shortName: 'dG–Kocher Massif',
    category: 'ARTEMIS_III',
    coordSource: 'Approximate region centre digitised from NASA region maps (not from a published coordinate)',
    lat: -85.81,
    lon: -111.2,
    isApproxCoord: true,
    description: 'Elevated massif between de Gerlache and Kocher craters.',
  },
  {
    id: 'artemis-haworth',
    name: 'Haworth',
    shortName: 'Haworth',
    category: 'ARTEMIS_III',
    coordSource: 'Approximate region centre digitised from NASA region maps (not from a published coordinate)',
    lat: -86.84,
    lon: -22.1,
    isApproxCoord: true,
    description: 'Plateau beside Haworth crater, adjacent to large PSRs.',
  },
  {
    id: 'artemis-malapert-massif',
    name: 'Malapert Massif',
    shortName: 'Malapert Massif',
    category: 'ARTEMIS_III',
    coordSource: 'Approximate region centre digitised from NASA region maps (not from a published coordinate)',
    lat: -85.99,
    lon: -2.9,
    isApproxCoord: true,
    description: 'Tall massif with near-continuous Earth visibility from its Earth-facing flank.',
  },
  {
    id: 'artemis-nobile-rim-1',
    name: 'Nobile Rim 1',
    shortName: 'Nobile Rim 1',
    category: 'ARTEMIS_III',
    coordSource: 'Approximate region centre digitised from NASA region maps (not from a published coordinate)',
    lat: -85.42,
    lon: 37.6,
    isApproxCoord: true,
    description: 'Rim of Nobile crater, a target region for VIPER-class ice prospecting.',
  },

  {
    id: 'artemis-mons-mouton-plateau',
    name: 'Mons Mouton Plateau',
    shortName: 'Mons Mouton Plateau',
    category: 'ARTEMIS_III',
    coordSource: 'Example landing site inside the region — Mahanti et al. (2025), LPSC 56, abstract #2742',
    lat: -84.528,
    lon: 30.719,
    isApproxCoord: false,
    description: 'Large (~4,450 km²) plateau region atop Mons Mouton; site placed for an EVA to PSR "P" within 1.5 km.',
  },
  {
    id: 'artemis-mons-mouton',
    name: 'Mons Mouton',
    shortName: 'Mons Mouton',
    category: 'ARTEMIS_III',
    coordSource: 'Candidate site MMO01 — Wueller et al. (2026), JGR Planets, doi:10.1029/2025JE009434 (appendix)',
    lat: -85.416,
    lon: 31.851,
    isApproxCoord: false,
    description: 'Smaller (~255 km²) summit region, formerly "Leibnitz Beta Plateau"; the planned VIPER landing area.',
  },
  {
    id: 'artemis-nobile-rim-2',
    name: 'Nobile Rim 2',
    shortName: 'Nobile Rim 2',
    category: 'ARTEMIS_III',
    coordSource: 'Top-ranked site in region DM2 — Sánchez-Lozano et al. (2025), LPSC 56, abstract #1149',
    lat: -84.20156,
    lon: 60.69989,
    isApproxCoord: false,
    description: 'Rim of Nobile crater; ranked best of 1,247 HLS-compliant points in a GIS multi-criteria study.',
  },
  {
    id: 'artemis-slater-plain',
    name: 'Slater Plain',
    shortName: 'Slater Plain',
    category: 'ARTEMIS_III',
    coordSource: 'Candidate site SP01 — Wueller et al. (2026), JGR Planets, doi:10.1029/2025JE009434 (appendix)',
    lat: -87.48,
    lon: 124.52,
    isApproxCoord: false,
    description: 'Lowest-elevation candidate region, north of Slater crater; few boulders and slopes < 7°.',
  },

  {
    id: 'artemis-peak-near-cabeus-b',
    name: 'Peak near Cabeus B',
    shortName: 'Peak nr Cabeus B',
    category: 'ARTEMIS_III',
    coordSource:
      'Centre of the LROC controlled NAC mosaic of this candidate region (NAC_ROI_CABEUSPKLOB: −83.6°, 291.2°E; spans 83.21–84.06°S) — Henriksen et al. (2023)',
    lat: -83.6,
    lon: -68.8,
    isApproxCoord: false,
    description: 'Elevated peak (~4.5 km) near Cabeus B crater on the Earth-facing side of the pole.',
  },
];

export const CURATED_BY_ID: Record<string, CuratedSite> = Object.fromEntries(
  CURATED_SITES.map((s) => [s.id, s]),
);
