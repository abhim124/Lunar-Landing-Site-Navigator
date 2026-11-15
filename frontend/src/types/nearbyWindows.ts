import type { MissionStatus } from './mission';

export interface NearbyWindowsRequest {
  lat: number;
  lon: number;
  start_date: string;
  planned_date: string;
  n_days?: number;
  mission_duration_days: number;
  min_earth_elevation_deg: number;
  radius_km?: number;
  k?: number;
}

export interface CalendarSummary {
  go_days: number;
  marginal_days: number;
  longest_go_run_days: number;
  longest_go_run_start: string | null;
  next_go_date: string | null;
  days_until_next_go: number | null;
  planned_status: MissionStatus | null;
  planned_score: number | null;
  mean_score: number;
}

export interface StatusDay {
  date: string;
  status: MissionStatus;
}

export interface NearbyWindowsSite {
  lat: number;
  lon: number;
  slope_deg: number;
  summary: CalendarSummary;
  days: StatusDay[];
  distance_km?: number;
  bearing_deg?: number;
  reasons?: string[];
}

export interface NearbyWindowsResponse {
  baseline: NearbyWindowsSite;
  alternatives: NearbyWindowsSite[];
  candidates_evaluated: number;
  search_radius_km: number;
  start_date: string;
  planned_date: string;
  computed_in_ms: number;
}
