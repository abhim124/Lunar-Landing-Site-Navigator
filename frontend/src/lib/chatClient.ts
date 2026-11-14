/**
 * Mission AI chat — frontend contract only.
 *
 * The chat backend is intentionally not built yet (no LLM API key). The UI works today: messages are
 * kept in the session and every send shows a "not connected" notice. To switch it on later, implement
 * `POST /api/chat` on the FastAPI side with the request/response shapes below and set
 * NEXT_PUBLIC_CHAT_ENABLED=true.
 */

import type { MissionStore } from '@/store/useMissionStore';
import { API_BASE } from './api';

export const CHAT_BACKEND_ENABLED = process.env.NEXT_PUBLIC_CHAT_ENABLED === 'true';

export type ChatRole = 'user' | 'assistant' | 'notice';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
}

/** Snapshot of what is on screen, sent with every question so answers are grounded in the app's own numbers. */
export interface MissionContext {
  site: { name: string; lat: number; lon: number } | null;
  epoch_utc: string;
  mission_duration_days: number;
  min_earth_elevation_deg: number;
  verdict: string | null;
  verdict_reasons: string[];
  metrics: Record<string, number | null>;
  alternative: { nearby_pad: string | null; launch_date: string | null } | null;
}

export interface ChatRequest {
  messages: { role: 'user' | 'assistant'; content: string }[];
  context: MissionContext;
}

export interface ChatResponse {
  reply: string;
}

export function buildMissionContext(s: MissionStore): MissionContext {
  const ev = s.evaluation;
  const alt = s.alternative;
  return {
    site: s.selectedSite ? { name: s.selectedSite.name, lat: s.selectedSite.lat, lon: s.selectedSite.lon } : null,
    epoch_utc: s.epochUTC,
    mission_duration_days: s.missionDurationDays,
    min_earth_elevation_deg: s.minEarthElevationDeg,
    verdict: ev?.overall_status ?? null,
    verdict_reasons: ev?.verdict_reasons ?? [],
    metrics: ev
      ? {
          sunlit_pct: ev.illumination.sunlit_pct.value,
          longest_darkness_hours: ev.illumination.longest_darkness_hours.value,
          time_to_sunset_hours: ev.illumination.time_to_sunset_hours.value,
          time_to_earthset_hours: ev.illumination.time_to_earthset_hours.value,
          earth_contact_pct: ev.illumination.earth_contact_pct.value,
          slope_deg: ev.terrain.slope_deg.value,
          surface_temp_min_k: ev.thermal.surface_temperature_k.value.min_k,
          surface_temp_max_k: ev.thermal.surface_temperature_k.value.max_k,
        }
      : {},
    alternative: alt
      ? {
          nearby_pad: alt.best_nearby_site ? `${alt.best_nearby_site.distance_km.toFixed(1)} km at ${alt.best_nearby_site.bearing_deg.toFixed(0)}°` : null,
          launch_date: alt.best_launch_date?.epoch_utc ?? null,
        }
      : null,
  };
}

/** Only called when CHAT_BACKEND_ENABLED is true. */
export async function sendChat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) throw new Error(`Chat backend HTTP ${res.status}`);
  return (await res.json()) as ChatResponse;
}
