import type { AnomalyType } from '@/lib/contingency';

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
  error?: boolean;
}

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantRequest {
  question: string;
  missionState: object;
  history: AssistantTurn[];
}
