import Anthropic from '@anthropic-ai/sdk';
import { ASSISTANT_SYSTEM_PROMPT } from '@/lib/assistantPrompt';
import { AGENT_TOOLS } from '@/lib/agentTools';

/**
 * One Claude call for Hadfield's tool loop.
 *
 * - With ANTHROPIC_API_KEY set (the hosted site, or anyone who adds their own key), Claude is called directly.
 * - Without a key (a fresh clone), the call goes through the hosted relay at HADFIELD_RELAY_URL/api/llm,
 *   which holds the key on its server. Only the model call is relayed: the tools still run on this machine
 *   against this machine's backend, and the key never leaves the hosted server.
 */
export const MODEL = 'claude-haiku-5-5';
export const MAX_TOKENS = 1500;
export const DEFAULT_RELAY_URL = 'https://lunar-landing-site-navigator-one.vercel.app';

export interface ModelCall {
  system: string;
  messages: Anthropic.MessageParam[];
  /** false on the final round, which must answer without tools. */
  withTools: boolean;
}

export function anthropicParams(call: ModelCall): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // Haiku 5.5 rejects non-default `temperature` (400), so it is omitted; thinking stays off to keep voice latency low.
    thinking: { type: 'disabled' },
    system: call.system,
    tools: call.withTools ? AGENT_TOOLS : [],
    messages: call.messages,
  };
}

/** The relay only forwards Hadfield's own prompt, never arbitrary ones. */
export function isHadfieldSystemPrompt(system: unknown): system is string {
  return typeof system === 'string' && system.startsWith(ASSISTANT_SYSTEM_PROMPT);
}

export async function createHadfieldMessage(call: ModelCall): Promise<Anthropic.Message> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) return new Anthropic({ apiKey }).messages.create(anthropicParams(call));

  const base = (process.env.HADFIELD_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/+$/, '');
  const res = await fetch(`${base}/api/llm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(call),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Hadfield relay ${base} returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Anthropic.Message;
}
