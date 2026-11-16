import { NextResponse } from 'next/server';
import { ASSISTANT_SYSTEM_PROMPT } from '@/lib/assistantPrompt';
import { AGENT_TOOLS, runAgentTool } from '@/lib/agentTools';
import { ANOMALY_TYPES, type AnomalyType } from '@/lib/contingency';
import {
  HIGHLIGHT_TARGETS,
  type AgentAction,
  type AgentContext,
  type AssistantReply,
  type AssistantRequest,
  type AssistantTurn,
  type HighlightTarget,
} from '@/types/assistant';

// Server-only: the API key is read here and never sent to the browser.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Tool turns call the mission backend (whole-pole search ≈ 1 s); allow headroom on Vercel.
export const maxDuration = 60;

const MAX_TOOL_ROUNDS = 6;

// Restated after the mission data so the display mode reliably shapes the wording.
const AUDIENCE_REMINDER: Record<string, string> = {
  learn:
    '\n\nAUDIENCE NOW: LEARN MODE (a beginner, about 12 years old). "say" must use everyday words and short sentences, no percentages with decimals, no jargon (never say ephemeris, azimuth, DTE, PSR, wt%, kWh without explaining it). Include exactly one everyday analogy (e.g. "like a phone charging in a sunny window"). "details" stays simple too: at most 3 short sentences, round numbers.',
  expert:
    '\n\nAUDIENCE NOW: EXPERT MODE (mission planner). Be technical and precise: numbers with units, the data source or model behind each number and its assumptions, standard terms (DTE, PSR, WEH, terrain horizon, incidence angle).',
};

// OpenRouter free models (OpenAI-compatible API). OpenRouter tries them in order if one is down or rate-limited.
// Override with OPENROUTER_MODEL (comma-separated). All of these support tool calling.
const MODELS = (process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free,nvidia/nemotron-3-ultra-550b-a55b:free,openrouter/free')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean)
  .slice(0, 3);
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
interface ChatResponse {
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[];
  error?: { message?: string; code?: number };
}

const TOOLS = AGENT_TOOLS.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));

async function chat(apiKey: string, messages: ChatMessage[], withTools: boolean): Promise<ChatResponse> {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Lunar Landing Site Navigator',
    },
    body: JSON.stringify({
      model: MODELS[0],
      models: MODELS, // fallbacks
      messages,
      max_tokens: 1500,
      temperature: 0.3,
      ...(withTools ? { tools: TOOLS, tool_choice: 'auto' } : {}),
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const json = (await res.json().catch(() => ({}))) as ChatResponse;
  if (!res.ok || json.error) throw new Error(`OpenRouter ${res.status}: ${json.error?.message ?? 'request failed'}`);
  return json;
}
const OFFLINE: AssistantReply = { say: 'Hadfield is offline. Check the status cards.', details: '', action: '', highlight: 'none', error: true };

/** Last 6 turns, starting with a user turn, with strictly alternating roles. */
function sanitizeHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const turns = raw
    .filter((t): t is AssistantTurn => !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim() !== '')
    .slice(-6);
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const t of turns) {
    if (out.length === 0 && t.role !== 'user') continue; // drop leading assistant turns
    const prev = out[out.length - 1];
    if (prev && prev.role === t.role) prev.content = `${prev.content}\n${t.content}`; // merge same-role neighbours
    else out.push({ role: t.role, content: t.content });
  }
  // The new question is appended as a user turn, so history must end on an assistant turn.
  if (out.length && out[out.length - 1].role === 'user') out.pop();
  return out;
}

function sanitizeContext(raw: unknown): AgentContext {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<AgentContext>;
  const site =
    c.site && typeof c.site.lat === 'number' && typeof c.site.lon === 'number'
      ? { lat: c.site.lat, lon: c.site.lon, name: typeof c.site.name === 'string' ? c.site.name : 'Selected site' }
      : null;
  const epoch = typeof c.epochUTC === 'string' && !Number.isNaN(Date.parse(c.epochUTC)) ? new Date(c.epochUTC).toISOString().slice(0, 19) + 'Z' : new Date().toISOString().slice(0, 13) + ':00:00Z';
  return {
    site,
    epochUTC: epoch,
    missionDays: typeof c.missionDays === 'number' ? c.missionDays : 7,
    minEarthElevationDeg: typeof c.minEarthElevationDeg === 'number' ? c.minEarthElevationDeg : 5,
  };
}

function parseReply(text: string): AssistantReply {
  const brace = text.indexOf('{');
  const stripped = (brace > 0 ? text.slice(brace) : text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    const j = JSON.parse(stripped) as Partial<Record<keyof AssistantReply, unknown>>;
    const highlight = HIGHLIGHT_TARGETS.includes(j.highlight as HighlightTarget) ? (j.highlight as HighlightTarget) : 'none';
    return {
      say: typeof j.say === 'string' ? j.say : '',
      details: typeof j.details === 'string' ? j.details : '',
      action: typeof j.action === 'string' ? j.action : '',
      highlight,
      anomaly: ANOMALY_TYPES.includes(j.anomaly as AnomalyType) ? (j.anomaly as AnomalyType) : null,
    };
  } catch {
    const raw = text.trim();
    return { say: raw.length > 200 ? `${raw.slice(0, 197)}…` : raw, details: raw, action: '', highlight: 'none' };
  }
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

    const body = (await req.json()) as Partial<AssistantRequest>;
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) throw new Error('Empty question');

    const ctx = sanitizeContext(body.context);
    const actions: AgentAction[] = [];
    const mode = (body.missionState as { displayMode?: string } | undefined)?.displayMode;
    const system = `${ASSISTANT_SYSTEM_PROMPT}\n${JSON.stringify(body.missionState ?? {}, null, 2)}${AUDIENCE_REMINDER[mode ?? ''] ?? ''}`;
    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...sanitizeHistory(body.history), { role: 'user', content: question }];

    // Manual tool loop: data tools run here against the backend; UI tools are queued as actions for the browser.
    let text = '';
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const msg = (await chat(apiKey, messages, round < MAX_TOOL_ROUNDS)).choices?.[0]?.message;
      const calls = msg?.tool_calls ?? [];
      if (!calls.length) {
        text = msg?.content ?? '';
        break;
      }
      messages.push({ role: 'assistant', content: msg?.content ?? null, tool_calls: calls });
      for (const call of calls) {
        let content: string;
        try {
          const input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          const r = await runAgentTool(call.function.name, input, ctx, actions);
          content = r.isError ? `Error: ${r.content}` : r.content;
        } catch (err) {
          content = `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }

    if (!text.trim() && actions.length === 0) throw new Error('Empty reply');
    const reply = text.trim() ? parseReply(text) : { say: 'Done.', details: '', action: '', highlight: 'none' as const };
    return NextResponse.json({ ...reply, actions });
  } catch (err) {
    console.error('[assistant] request failed:', err);
    return NextResponse.json(OFFLINE, { status: 200 });
  }
}
