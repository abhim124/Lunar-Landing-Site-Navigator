export type MissionPhase = 'pre-landing' | 'descent' | 'surface';

export const HIGHLIGHT_TARGETS = ['power', 'comms', 'verdict', 'calendar', 'none'] as const;
export type HighlightTarget = (typeof HIGHLIGHT_TARGETS)[number];

export interface AssistantReply {
  say: string;
  details: string;
  action: string;
  highlight: HighlightTarget;
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
