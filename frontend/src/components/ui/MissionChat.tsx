'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CHAT_BACKEND_ENABLED, buildMissionContext } from '@/lib/chatClient';
import { PANEL, fmtNum } from '@/lib/format';
import { useChatStore } from '@/store/useChatStore';
import { useMissionStore } from '@/store/useMissionStore';
import { InfoButton, InfoPanel, useInfo } from './InfoButton';

/** Pill button that opens the chat panel. */
export function AskAiButton() {
  const { isOpen, setOpen } = useChatStore(useShallow((s) => ({ isOpen: s.isOpen, setOpen: s.setOpen })));
  return (
    <button
      type="button"
      onClick={() => setOpen(!isOpen)}
      aria-expanded={isOpen}
      className={`h-8 rounded-lg px-3 text-xs font-semibold ring-1 transition-colors ${
        isOpen ? 'bg-sky-400 text-slate-950 ring-sky-300' : 'bg-sky-500/20 text-sky-200 ring-sky-400/40 hover:bg-sky-500/30'
      }`}
    >
      Ask AI
    </button>
  );
}

export function MissionChat() {
  const { isOpen, messages, pending, setOpen, send, clear } = useChatStore(
    useShallow((s) => ({ isOpen: s.isOpen, messages: s.messages, pending: s.pending, setOpen: s.setOpen, send: s.send, clear: s.clear })),
  );
  const { site, verdict } = useMissionStore(useShallow((s) => ({ site: s.selectedSite, verdict: s.evaluation?.overall_status ?? null })));
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const info = useInfo();

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const suggestions = useMemo(() => {
    if (!site) return ['What makes a good south-pole landing site?', 'Why do Artemis sites sit on crater rims?', 'How is Earth contact calculated?'];
    const s = [`Why is ${site.name} ${verdict ?? 'rated this way'}?`];
    if (verdict && verdict !== 'GO') s.push('Where or when should we land instead?');
    s.push('Explain the Earth contact number', 'Is this site near water ice?');
    return s;
  }, [site, verdict]);

  if (!isOpen) return null;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft.trim()) return;
    void send(draft);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <aside
      className={`${PANEL} fixed left-3 z-40 flex w-[min(360px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/60`}
      style={{ top: 'calc(var(--pill-h, 48px) + 24px)', bottom: 'calc(var(--drawer-h, 0px) + 24px)', maxHeight: 560 }}
      aria-label="Mission AI chat"
    >
      <header className="flex items-center justify-between gap-2 border-b border-slate-800/80 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-50">Mission AI</h2>
          <span
            className={`rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold tracking-wide ring-1 ${
              CHAT_BACKEND_ENABLED ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/40' : 'bg-amber-500/15 text-amber-300 ring-amber-400/40'
            }`}
          >
            {CHAT_BACKEND_ENABLED ? 'CONNECTED' : 'NOT CONNECTED'}
          </span>
          <InfoButton open={info.open} onToggle={info.toggle} controls={info.id} label="what the assistant can see" />
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button type="button" onClick={clear} className="rounded-md px-2 py-0.5 text-[10px] text-slate-400 hover:text-slate-200">
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close chat"
            className="grid h-7 w-7 place-items-center rounded-full text-slate-400 ring-1 ring-slate-700 hover:bg-slate-800 hover:text-slate-100"
          >
            ×
          </button>
        </div>
      </header>

      {info.open && (
        <div className="px-3">
          <ContextPreview id={info.id} />
        </div>
      )}

      <div ref={listRef} className="llsn-scroll min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3" aria-live="polite">
        {messages.length === 0 && (
          <p className="text-xs text-slate-400">
            Ask about the selected site, the verdict, or what to do instead. Answers will use the numbers on screen.
          </p>
        )}
        {messages.map((m) =>
          m.role === 'notice' ? (
            <p key={m.id} className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200 ring-1 ring-amber-400/30">
              {m.text}
            </p>
          ) : (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <p
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-1.5 text-xs leading-relaxed ${
                  m.role === 'user' ? 'rounded-br-sm bg-sky-500/90 text-slate-950' : 'rounded-bl-sm bg-slate-800/80 text-slate-100'
                }`}
              >
                {m.text}
              </p>
            </div>
          ),
        )}
        {pending && <p className="animate-pulse text-[11px] text-slate-400">Thinking…</p>}
      </div>

      <div className="flex flex-wrap gap-1.5 px-3 pb-2">
        {suggestions.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => void send(q)}
            className="rounded-full bg-slate-800/70 px-2.5 py-1 text-[10px] text-slate-300 ring-1 ring-slate-700 hover:text-slate-100"
          >
            {q}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="flex items-end gap-2 border-t border-slate-800/80 p-2.5">
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder="Ask about this landing site…"
          aria-label="Message Mission AI"
          className="max-h-28 min-h-8 flex-1 resize-none rounded-lg bg-slate-900/80 px-2.5 py-1.5 text-xs text-slate-100 ring-1 ring-slate-700/80 outline-none placeholder:text-slate-500 focus:ring-sky-500/70"
        />
        <button
          type="submit"
          disabled={!draft.trim() || pending}
          className="h-8 rounded-lg bg-slate-100 px-3 text-xs font-semibold text-slate-950 hover:bg-white disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </aside>
  );
}

function ContextPreview({ id }: { id: string }) {
  const state = useMissionStore();
  const ctx = buildMissionContext(state);
  return (
    <InfoPanel id={id}>
      <p className="text-slate-400">Each question is sent with this snapshot of the app, so answers stay tied to the real numbers:</p>
      <ul className="space-y-0.5 font-mono text-[10px] text-slate-300">
        <li>site: {ctx.site ? `${ctx.site.name} (${fmtNum(ctx.site.lat, 3)}, ${fmtNum(ctx.site.lon, 3)})` : 'none selected'}</li>
        <li>
          epoch: {ctx.epoch_utc} · {ctx.mission_duration_days} d · antenna ≥ {ctx.min_earth_elevation_deg}°
        </li>
        <li>verdict: {ctx.verdict ?? '—'}</li>
        {Object.entries(ctx.metrics).map(([k, v]) => (
          <li key={k}>
            {k}: {fmtNum(v, 1)}
          </li>
        ))}
      </ul>
      {!CHAT_BACKEND_ENABLED && <p className="text-amber-300/90">Backend not built yet: set NEXT_PUBLIC_CHAT_ENABLED=true once POST /api/chat exists.</p>}
    </InfoPanel>
  );
}
