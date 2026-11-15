/**
 * Shared wire contract between the Next.js client and the Phase 1 FastAPI backend.
 * Field names stay snake_case so the Pydantic models serialise 1:1 with no mapping layer.
 */

export type MissionStatus = 'GO' | 'MARGINAL' | 'NO-GO';

export interface DataSourceTag {
  source_name: string;
  resolution: string;
  is_derived: boolean;
  is_synthetic_fallback: boolean;
  is_approx_coord?: boolean;
}

export interface MetricWithSource<T> {
  value: T;
  unit: string;
  status: MissionStatus;
  source: DataSourceTag;
}

export type OverlayLayerId =
  | 'WAC_POLE_ILL_PCT_SOUTH_100M'
  | 'LOLA_COLOR_RELIEF'
  | 'PGDA_SUN_VISIBILITY'
  | 'PGDA_EARTH_VISIBILITY';

export type LayerId = 'BASE_CGI' | OverlayLayerId;

export const LAYER_IDS: readonly LayerId[] = [
  'BASE_CGI',
  'WAC_POLE_ILL_PCT_SOUTH_100M',
  'LOLA_COLOR_RELIEF',
  'PGDA_SUN_VISIBILITY',
  'PGDA_EARTH_VISIBILITY',
] as const;

export type DrawerTab = 'PANORAMA' | 'CALENDAR' | 'VALIDATION';

export interface SelectedSite {
  lat: number;
  lon: number;
  name: string;
  /** Curated registry id (benchmark or Artemis III region), null for custom clicks. */
  regionId: string | null;
}

/* ────────────────────────────── Requests ────────────────────────────── */

export interface SiteEvaluationRequest {
  lat: number;
  lon: number;
  epoch_utc: string;
  mission_duration_days: number;
  min_earth_elevation_deg: number;
  site_name?: string | null;
  region_id?: string | null;
  /** Number of skyline azimuth rays (72–360). */
  skyline_azimuths?: number;
  /** Trajectory sample spacing returned for the local timeline scrubber. */
  trajectory_step_minutes?: number;
}

export interface LaunchCalendarRequest {
  lat: number;
  lon: number;
  start_date: string; // YYYY-MM-DD
  n_days: number;
  mission_duration_days: number;
  min_earth_elevation_deg: number;
}

export interface NearestAlternativeRequest {
  lat: number;
  lon: number;
  epoch_utc: string;
  mission_duration_days: number;
  min_earth_elevation_deg: number;
  search_radius_km: number;
  date_window_days: number;
}

export interface ValidationRequest {
  lat: number;
  lon: number;
  epoch_utc: string;
}

/* ────────────────────────────── Responses ───────────────────────────── */

export interface SkylinePoint {
  azimuth_deg: number;
  /** Terrain horizon elevation including the curvature drop  -d²/2R. */
  elevation_deg: number;
  /** Distance to the horizon-defining terrain sample. */
  distance_km: number;
}

export interface SkylineProfile {
  observer_lat: number;
  observer_lon: number;
  observer_elevation_m: number;
  n_azimuths: number;
  max_range_km: number;
  curvature_corrected: boolean;
  points: SkylinePoint[];
  source: DataSourceTag;
}

export interface EphemerisSample {
  t_utc: string;
  hours_from_start: number;
  sun_az_deg: number;
  sun_el_deg: number;
  /** Terrain horizon elevation at the Sun's azimuth (null if no skyline). */
  sun_horizon_el_deg: number | null;
  /** Fraction (0–1) of the solar disk (r = 0.266°) above the local skyline. */
  sun_visible_fraction: number;
  earth_az_deg: number;
  earth_el_deg: number;
  earth_horizon_el_deg: number | null;
  earth_visible: boolean;
  subsolar_lat_deg: number;
  subsolar_lon_deg: number;
  subearth_lat_deg: number;
  subearth_lon_deg: number;
}

export interface EphemerisTrajectory {
  start_utc: string;
  end_utc: string;
  step_minutes: number;
  samples: EphemerisSample[];
  source: DataSourceTag;
}

export interface SpaceWeatherStatus {
  status: 'CLEAR' | 'ELEVATED RADIATION' | 'UNKNOWN';
  eva_status: MissionStatus;
  window_start: string;
  window_end: string;
  sep_event_count: number;
  flare_count: number;
  strongest_flare_class: string | null;
  latest_event_utc: string | null;
  summary: string;
  cached_at_utc: string | null;
  served_from_cache: boolean;
  source: DataSourceTag;
}

/** null fields → Diviner GCP unreachable and not cached. */
export interface ThermalRange {
  min_k: number | null;
  mean_k: number | null;
  max_k: number | null;
}

export interface SiteEvaluationResponse {
  site: {
    lat: number;
    lon: number;
    name: string | null;
    region_id: string | null;
    /** Official Artemis III region / PGDA 5 m site that contains the point, if any. */
    artemis_region: string | null;
    map_x_m: number;
    map_y_m: number;
    elevation_m: MetricWithSource<number>;
  };
  epoch_utc: string;
  mission_duration_days: number;
  min_earth_elevation_deg: number;
  overall_status: MissionStatus;
  verdict_reasons: string[];
  illumination: {
    sunlit_pct: MetricWithSource<number>;
    longest_darkness_hours: MetricWithSource<number>;
    /** null → the Sun does not set inside the mission window. */
    time_to_sunset_hours: MetricWithSource<number | null>;
    /** null → Earth does not set inside the mission window. */
    time_to_earthset_hours: MetricWithSource<number | null>;
    earth_contact_pct: MetricWithSource<number>;
  };
  terrain: {
    slope_deg: MetricWithSource<number>;
    roughness_m: MetricWithSource<number>;
  };
  thermal: {
    surface_temperature_k: MetricWithSource<ThermalRange>;
  };
  hazards: {
    /** null → Diviner rock abundance has no coverage poleward of ±60°. */
    rock_abundance_pct: MetricWithSource<number | null>;
  };
  isru: {
    /** null → site lies outside the PGDA 65°S PSR map. */
    nearest_ice_psr_km: MetricWithSource<number | null>;
  };
  space_weather: SpaceWeatherStatus;
  skyline: SkylineProfile;
  trajectory: EphemerisTrajectory;
  computed_in_ms: number;
}

export interface LaunchCalendarDay {
  date: string; // YYYY-MM-DD
  status: MissionStatus;
  score: number; // 0–1
  sunlit_pct: number;
  earth_contact_pct: number;
  longest_darkness_hours: number;
}

export interface LaunchCalendarResponse {
  lat: number;
  lon: number;
  start_date: string;
  mission_duration_days: number;
  min_earth_elevation_deg: number;
  days: LaunchCalendarDay[];
  computed_in_ms: number;
  source: DataSourceTag;
}

export type ValidationQuantity = 'SUN_AZ' | 'SUN_EL' | 'EARTH_AZ' | 'EARTH_EL';

export interface ValidationRow {
  benchmark_id: string;
  benchmark_name: string;
  lat: number;
  lon: number;
  epoch_utc: string;
  quantity: ValidationQuantity;
  local_deg: number;
  horizons_deg: number | null;
  reference_deg: number | null;
  delta_horizons_deg: number | null;
  delta_reference_deg: number | null;
  local_source: DataSourceTag;
  horizons_source: DataSourceTag | null;
  horizons_cached: boolean;
}

export interface ValidationBenchmarkResponse {
  generated_at_utc: string;
  horizons_reachable: boolean;
  tolerance_deg: number;
  max_abs_delta_horizons_deg: number | null;
  rows: ValidationRow[];
}

export interface AlternativeSiteOption {
  lat: number;
  lon: number;
  distance_km: number;
  bearing_deg: number;
  slope_deg: number;
  sunlit_pct: number;
  earth_contact_pct: number;
  longest_darkness_hours: number;
  rock_abundance_pct: number | null;
  status: MissionStatus;
  summary: string;
  source: DataSourceTag;
}

export interface AlternativeDateOption {
  epoch_utc: string;
  offset_days: number;
  sunlit_pct: number;
  earth_contact_pct: number;
  longest_darkness_hours: number;
  status: MissionStatus;
  summary: string;
  source: DataSourceTag;
}

export interface AlternativeSearchStats {
  stage1_pixels_scanned: number;
  stage1_candidates_kept: number;
  stage1_bbox_km: number;
  stage1_ms: number;
  stage2_epochs_evaluated: number;
  stage2_ms: number;
}

export interface NearestAlternativeResponse {
  query: { lat: number; lon: number; epoch_utc: string };
  trigger_reasons: string[];
  baseline: {
    status: MissionStatus;
    sunlit_pct: number;
    slope_deg: number;
    earth_contact_pct: number;
    longest_darkness_hours: number;
  };
  best_nearby_site: AlternativeSiteOption | null;
  best_launch_date: AlternativeDateOption | null;
  stats: AlternativeSearchStats;
  computed_in_ms: number;
}

/** GET /api/terrain/slope-stats — LOLA-derived slope and roughness around a pad. */
export interface SlopeStatsResponse {
  lat: number;
  lon: number;
  requested_radius_m: number;
  effective_radius_m: number;
  pixel_m: number;
  n_pixels: number;
  slope_at_point_deg: number;
  mean_slope_deg: number;
  max_slope_deg: number;
  /** RMS height deviation from the best-fit plane over the radius, m. */
  roughness_rms_m: number;
  source: DataSourceTag;
}

/** GET /api/psr/check — is a pad clear of permanently shadowed regions (plus buffer)? */
export interface PsrCheckResponse {
  lat: number;
  lon: number;
  covered: boolean;
  in_psr: boolean;
  psr_distance_km: number | null;
  buffer_m: number;
  safe: boolean;
  nearest_safe: {
    lat: number;
    lon: number;
    distance_km: number;
    bearing_deg: number;
    psr_distance_km: number;
    slope_deg: number | null;
    avg_sun_visibility_pct: number;
    criteria: string;
  } | null;
  source: string;
}
