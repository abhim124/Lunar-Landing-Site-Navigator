import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { anthropicParams, isHadfieldSystemPrompt, type ModelCall } from '@/lib/hadfieldModel';

/**
 * Hadfield relay: lets copies of the app that have no ANTHROPIC_API_KEY (a fresh clone) use the hosted key.
 * The key stays on this server. Abuse limits:
 *  - only Hadfield's own system prompt, tools, model and max_tokens (the caller cannot change them);
 *  - request size and conversation length caps;
 *  - per-IP and per-instance rate limits (in memory, so they reset when the serverless instance recycles;
 *    set a monthly spend limit in the Anthropic console as the hard backstop).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BODY_BYTES = 400_000;
const MAX_MESSAGES = 30;
const WINDOW_MS = 10 * 60_000;
const PER_IP_PER_WINDOW = 60; // ≈ 10 questions (each question is up to 7 model calls)
const PER_INSTANCE_PER_HOUR = 1_000;

const ipHits = new Map<string, number[]>();
let instanceHits: number[] = [];

function allow(ip: string): boolean {
  const now = Date.now();
  instanceHits = instanceHits.filter((t) => now - t < 3_600_000);
  if (instanceHits.length >= PER_INSTANCE_PER_HOUR) return false;
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= PER_IP_PER_WINDOW) return false;
  hits.push(now);
  ipHits.set(ip, hits);
  instanceHits.push(now);
  if (ipHits.size > 5_000) ipHits.clear(); // keep memory bounded
  return true;
}

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fail(503, 'This server has no ANTHROPIC_API_KEY, so it cannot relay.');

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
  if (!allow(ip)) return fail(429, 'Hadfield is busy: too many questions from this address. Try again in a few minutes.');

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, 'Request too large.');
  let call: Partial<ModelCall>;
  try {
    call = JSON.parse(raw) as Partial<ModelCall>;
  } catch {
    return fail(400, 'Invalid JSON.');
  }
  if (!isHadfieldSystemPrompt(call.system)) return fail(403, 'Only Hadfield requests are relayed.');
  if (!Array.isArray(call.messages) || call.messages.length === 0 || call.messages.length > MAX_MESSAGES) {
    return fail(400, 'Invalid messages.');
  }

  try {
    const message = await new Anthropic({ apiKey }).messages.create(
      anthropicParams({ system: call.system, messages: call.messages, withTools: call.withTools !== false }),
    );
    return NextResponse.json(message);
  } catch (err) {
    console.error('[llm relay] request failed:', err);
    const status = err instanceof Anthropic.APIError && typeof err.status === 'number' ? err.status : 502;
    return fail(status >= 400 && status < 600 ? status : 502, 'Model call failed.');
  }
}
