import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { ASSISTANT_SYSTEM_PROMPT } from '@/lib/assistantPrompt';
import { HIGHLIGHT_TARGETS, type AssistantReply, type AssistantRequest, type AssistantTurn, type HighlightTarget } from '@/types/assistant';

// Server-only: the API key is read here and never sent to the browser.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

function parseReply(text: string): AssistantReply {
  const stripped = text
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

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      // Haiku 5.5 rejects non-default `temperature` (400), so it is omitted; thinking is turned off
      // so the whole 500-token budget goes to the spoken reply and latency stays low for voice.
      thinking: { type: 'disabled' },
      system: `${ASSISTANT_SYSTEM_PROMPT}\n${JSON.stringify(body.missionState ?? {}, null, 2)}`,
      messages: [...sanitizeHistory(body.history), { role: 'user', content: question }],
    });

    if (response.stop_reason === 'refusal') throw new Error('Model declined the request');
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!text.trim()) throw new Error(`Empty reply (stop_reason=${response.stop_reason})`);
    return NextResponse.json(parseReply(text));
  } catch (err) {
    console.error('[assistant] request failed:', err);
    return NextResponse.json(OFFLINE, { status: 200 });
  }
}
