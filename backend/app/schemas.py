"""Source-tagged Pydantic schemas — field-for-field mirror of frontend/src/types/mission.ts."""

from __future__ import annotations

from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, Field

Status = Literal["GO", "MARGINAL", "NO-GO"]
T = TypeVar("T")


class DataSourceTag(BaseModel):
    source_name: str
    resolution: str
    is_derived: bool = False
    is_synthetic_fallback: bool = False
    is_approx_coord: bool | None = None


class MetricWithSource(BaseModel, Generic[T]):
    value: T
    unit: str
    status: Status
    source: DataSourceTag


# ─────────── requests ───────────


class SiteEvaluationRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-360, le=360)
    epoch_utc: str
    mission_duration_days: float = Field(default=7, ge=0.5, le=30)
    min_earth_elevation_deg: float = Field(default=5, ge=0, le=20)
    site_name: str | None = None
    region_id: str | None = None
    skyline_azimuths: int = Field(default=360, ge=72, le=720)
    trajectory_step_minutes: int = Field(default=30, ge=5, le=240)


class NearestAlternativeRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-360, le=360)
    epoch_utc: str
    mission_duration_days: float = Field(default=7, ge=0.5, le=30)
    min_earth_elevation_deg: float = Field(default=5, ge=0, le=20)
    search_radius_km: float = Field(default=5, gt=0, le=25)
    date_window_days: float = Field(default=14, gt=0, le=30)


# ─────────── responses ───────────


class SkylinePoint(BaseModel):
    azimuth_deg: float
    elevation_deg: float
    distance_km: float


class SkylineProfile(BaseModel):
    observer_lat: float
    observer_lon: float
    observer_elevation_m: float
    n_azimuths: int
    max_range_km: float
    curvature_corrected: bool
    points: list[SkylinePoint]
    source: DataSourceTag


class EphemerisSample(BaseModel):
    t_utc: str
    hours_from_start: float
    sun_az_deg: float
    sun_el_deg: float
    sun_horizon_el_deg: float | None
    sun_visible_fraction: float
    earth_az_deg: float
    earth_el_deg: float
    earth_horizon_el_deg: float | None
    earth_visible: bool
    subsolar_lat_deg: float
    subsolar_lon_deg: float
    subearth_lat_deg: float
    subearth_lon_deg: float


class EphemerisTrajectory(BaseModel):
    start_utc: str
    end_utc: str
    step_minutes: float
    samples: list[EphemerisSample]
    source: DataSourceTag


class SpaceWeatherStatus(BaseModel):
    status: Literal["CLEAR", "ELEVATED RADIATION", "UNKNOWN"]
    eva_status: Status
    window_start: str
    window_end: str
    sep_event_count: int
    flare_count: int
    strongest_flare_class: str | None
    latest_event_utc: str | None
    summary: str
    cached_at_utc: str | None
    served_from_cache: bool
    source: DataSourceTag


class ThermalRange(BaseModel):
    min_k: float | None
    mean_k: float | None
    max_k: float | None


class SiteInfo(BaseModel):
    lat: float
    lon: float
    name: str | None
    region_id: str | None
    artemis_region: str | None
    map_x_m: float
    map_y_m: float
    elevation_m: MetricWithSource[float]


class Illumination(BaseModel):
    sunlit_pct: MetricWithSource[float]
    longest_darkness_hours: MetricWithSource[float]
    time_to_sunset_hours: MetricWithSource[float | None]
    time_to_earthset_hours: MetricWithSource[float | None]
    earth_contact_pct: MetricWithSource[float]


class Terrain(BaseModel):
    slope_deg: MetricWithSource[float]
    roughness_m: MetricWithSource[float]


class Thermal(BaseModel):
    surface_temperature_k: MetricWithSource[ThermalRange]


class Hazards(BaseModel):
    rock_abundance_pct: MetricWithSource[float | None]


class Isru(BaseModel):
    nearest_ice_psr_km: MetricWithSource[float | None]


class SiteEvaluationResponse(BaseModel):
    site: SiteInfo
    epoch_utc: str
    mission_duration_days: float
    min_earth_elevation_deg: float
    overall_status: Status
    verdict_reasons: list[str]
    illumination: Illumination
    terrain: Terrain
    thermal: Thermal
    hazards: Hazards
    isru: Isru
    space_weather: SpaceWeatherStatus
    skyline: SkylineProfile
    trajectory: EphemerisTrajectory
    computed_in_ms: float


class LaunchCalendarDay(BaseModel):
    date: str
    status: Status
    score: float
    sunlit_pct: float
    earth_contact_pct: float
    longest_darkness_hours: float


class LaunchCalendarResponse(BaseModel):
    lat: float
    lon: float
    start_date: str
    mission_duration_days: float
    min_earth_elevation_deg: float
    days: list[LaunchCalendarDay]
    computed_in_ms: float
    source: DataSourceTag


ValidationQuantity = Literal["SUN_AZ", "SUN_EL", "EARTH_AZ", "EARTH_EL"]


class ValidationRow(BaseModel):
    benchmark_id: str
    benchmark_name: str
    lat: float
    lon: float
    epoch_utc: str
    quantity: ValidationQuantity
    local_deg: float
    horizons_deg: float | None
    reference_deg: float | None
    delta_horizons_deg: float | None
    delta_reference_deg: float | None
    local_source: DataSourceTag
    horizons_source: DataSourceTag | None
    horizons_cached: bool


class ValidationBenchmarkResponse(BaseModel):
    generated_at_utc: str
    horizons_reachable: bool
    tolerance_deg: float
    max_abs_delta_horizons_deg: float | None
    rows: list[ValidationRow]


class AlternativeSiteOption(BaseModel):
    lat: float
    lon: float
    distance_km: float
    bearing_deg: float
    slope_deg: float
    sunlit_pct: float
    earth_contact_pct: float
    longest_darkness_hours: float
    rock_abundance_pct: float | None
    status: Status
    summary: str
    source: DataSourceTag


class AlternativeDateOption(BaseModel):
    epoch_utc: str
    offset_days: float
    sunlit_pct: float
    earth_contact_pct: float
    longest_darkness_hours: float
    status: Status
    summary: str
    source: DataSourceTag


class AlternativeSearchStats(BaseModel):
    stage1_pixels_scanned: int
    stage1_candidates_kept: int
    stage1_bbox_km: float
    stage1_ms: float
    stage2_epochs_evaluated: int
    stage2_ms: float


class Baseline(BaseModel):
    status: Status
    sunlit_pct: float
    slope_deg: float
    earth_contact_pct: float
    longest_darkness_hours: float


class AltQuery(BaseModel):
    lat: float
    lon: float
    epoch_utc: str


class NearestAlternativeResponse(BaseModel):
    query: AltQuery
    trigger_reasons: list[str]
    baseline: Baseline
    best_nearby_site: AlternativeSiteOption | None
    best_launch_date: AlternativeDateOption | None
    stats: AlternativeSearchStats
    computed_in_ms: float
