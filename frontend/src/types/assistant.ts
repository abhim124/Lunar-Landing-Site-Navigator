import type { AnomalyType } from '@/lib/contingency';
import type { LayerId } from './mission';

export type MissionPhase = 'pre-landing' | 'descent' | 'surface';

export const HIGHLIGHT_TARGETS = ['power', 'comms', 'verdict', 'calendar', 'none'] as const;
export type HighlightTarget = (typeof HIGHLIGHT_TARGETS)[number];

export interface AssistantReply {
  say: string;
  details: string;
  action: string;
  highlight: HighlightTarget;
  /** Set when the crew reported a vehicle anomaly: the app re-checks the pad for it and relocates if needed. */
  anomaly?: AnomalyType | null;
  /** UI actions Hatfield took this turn (applied by the browser in order). */
  actions?: AgentAction[];
  error?: boolean;
}

export type AgentPanel = 'calendar' | 'compare' | 'verdict' | 'alternatives' | 'validation' | 'power' | 'comms';

export type AgentAction =
  | { type: 'select_site'; lat: number; lon: number; name: string; regionId?: string; epochUTC: string }
  | { type: 'set_mission'; epochUTC?: string; missionDays?: number; minEarthElevationDeg?: number }
  | { type: 'show_panel'; panel: AgentPanel }
  | { type: 'focus_calendar'; date: string; label: string; status?: 'GO' | 'MARGINAL' | 'NO-GO' }
  | { type: 'set_layer'; layer: LayerId };

/** The mission settings the agent works from (updated as it queues actions within one turn). */
export interface AgentContext {
  site: { lat: number; lon: number; name: string } | null;
  epochUTC: string;
  missionDays: number;
  minEarthElevationDeg: number;
}

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantRequest {
  question: string;
  missionState: object;
  history: AssistantTurn[];
  context?: AgentContext;
}
