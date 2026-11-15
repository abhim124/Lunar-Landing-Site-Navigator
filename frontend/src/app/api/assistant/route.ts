import Anthropic from '@anthropic-ai/sdk';
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

const MODEL = 'claude-haiku-5-5';
const OFFLINE: AssistantReply = { say: 'CAPCOM is offline. Check the status cards.', details: '', action: '', highlight: 'none', error: true };

/** Last 6 turns, starting with a user turn, with strictly alternating roles. */
function sanitizeHistory(raw: unknown): Anthropic.MessageParam[] {
  if (!Array.isArray(raw)) return [];
  const turns = raw
    .filter((t): t is AssistantTurn => !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim() !== '')
    .slice(-6);
  const out: Anthropic.MessageParam[] = [];
  for (const t of turns) {
    if (out.length === 0 && t.role !== 'user') continue; // drop leading assistant turns
    const prev = out[out.length - 1];
    if (prev && prev.role === t.role) prev.content = `${prev.content as string}\n${t.content}`; // merge same-role neighbours
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
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

    const body = (await req.json()) as Partial<AssistantRequest>;
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) throw new Error('Empty question');

    const ctx = sanitizeContext(body.context);
    const actions: AgentAction[] = [];
    const client = new Anthropic({ apiKey });
    const mode = (body.missionState as { displayMode?: string } | undefined)?.displayMode;
    const system = `${ASSISTANT_SYSTEM_PROMPT}\n${JSON.stringify(body.missionState ?? {}, null, 2)}${AUDIENCE_REMINDER[mode ?? ''] ?? ''}`;
    const messages: Anthropic.MessageParam[] = [...sanitizeHistory(body.history), { role: 'user', content: question }];

    // Manual tool loop: data tools run here against the backend; UI tools are queued as actions for the browser.
    let response: Anthropic.Message | null = null;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 1500,
        // Haiku 5.5 rejects non-default `temperature` (400), so it is omitted; thinking stays off to keep voice latency low.
        thinking: { type: 'disabled' },
        system,
        tools: round < MAX_TOOL_ROUNDS ? AGENT_TOOLS : [],
        messages,
      });
      if (response.stop_reason === 'refusal') throw new Error('Model declined the request');
      if (response.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        try {
          const r = await runAgentTool(block.name, block.input, ctx, actions);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: r.content, is_error: r.isError });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: `Tool failed: ${err instanceof Error ? err.message : String(err)}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }

    const text = (response?.content ?? [])
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!text.trim() && actions.length === 0) throw new Error(`Empty reply (stop_reason=${response?.stop_reason})`);
    const reply = text.trim() ? parseReply(text) : { say: 'Done.', details: '', action: '', highlight: 'none' as const };
    return NextResponse.json({ ...reply, actions });
  } catch (err) {
    console.error('[assistant] request failed:', err);
    return NextResponse.json(OFFLINE, { status: 200 });
  }
}
