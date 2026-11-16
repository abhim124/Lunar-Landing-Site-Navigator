'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { agentContext, applyAgentActions, describeActions, restore, snapshot, type AgentSnapshot } from '@/lib/agentActions';
import { api, errorMessage } from '@/lib/api';
import { buildMissionState } from '@/lib/buildMissionState';
import {
  CONTINGENCY_PRESETS,
  buildContingencyRequest,
  compassWord,
  contingencySpeech,
  type AnomalyType,
  type ContingencyCheck,
  type ContingencyResponse,
} from '@/lib/contingency';
import { PANEL } from '@/lib/format';
import { useAssistantStore } from '@/store/useAssistantStore';
import { useMissionStore } from '@/store/useMissionStore';
import type { AssistantReply, AssistantTurn, MissionPhase } from '@/types/assistant';
import type { SelectedSite } from '@/types/mission';
import { LearnBlock } from '@/components/ui/LearnBlock';

/* ───────────── Web Speech API (not in TS's lib.dom) ───────────── */

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/* ───────────── voice ranking ───────────── */

const VOICE_KEY = 'capcom-voice';

// Smoothest first: neural/premium voices (macOS Premium/Enhanced, Edge "Natural", Chrome Google), then known good system voices.
const SMOOTH_HINTS = [/premium/i, /enhanced/i, /natural/i, /neural/i, /siri/i];
const GOOD_NAMES = ['Ava', 'Zoe', 'Evan', 'Nathan', 'Allison', 'Samantha', 'Google US English', 'Google UK English Female', 'Aria', 'Jenny', 'Serena', 'Daniel', 'Karen', 'Moira'];
// Novelty voices bundled with macOS that should never be the default.
const NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|fred|kathy|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley/i;

function rankVoices(all: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  const score = (v: SpeechSynthesisVoice) => {
    let s = 0;
    if (SMOOTH_HINTS.some((r) => r.test(v.name))) s += 100;
    const i = GOOD_NAMES.findIndex((n) => v.name.includes(n));
    if (i >= 0) s += 50 - i;
    if (v.lang.toLowerCase().startsWith('en-us')) s += 5;
    if (!v.localService) s += 3; // network voices (Google/Microsoft) are usually neural
    return s;
  };
  return all
    .filter((v) => v.lang.toLowerCase().startsWith('en') && !NOVELTY.test(v.name))
    .sort((a, b) => score(b) - score(a));
}

/* ───────────── constants ───────────── */

const OFFLINE: AssistantReply = { say: 'Hadfield is offline. Check the status cards.', details: '', action: '', highlight: 'none', error: true };

const PHASES: { id: MissionPhase; label: string }[] = [
  { id: 'pre-landing', label: 'Pre-landing' },
  { id: 'descent', label: 'Descent' },
  { id: 'surface', label: 'Surface' },
];

const CHIPS: { label: string; icon: string; question: string | null }[] = [
  { label: 'Power low', icon: '⚡', question: 'Our power is running low. What should we do?' },
  { label: 'Comms lost', icon: '📡', question: 'We just lost communication with Earth. What should we do?' },
  { label: 'Darkness soon', icon: '🌑', question: 'When does darkness start, and how long will it last?' },
  { label: 'Space weather', icon: '☢', question: "What's the space weather risk right now?" },
  { label: 'Better site/date', icon: '🧭', question: 'Is there a better nearby site or launch date?' },
  { label: 'Fuel leak', icon: '⛽', question: 'We have a fuel leak. Is our landing site still viable?' },
  { label: 'Landing radar out', icon: '⚠', question: 'Our landing hazard-detection radar has failed. Is our landing site still viable?' },
  { label: 'Other', icon: '✎', question: null },
];

interface ContingencyState {
  anomaly: AnomalyType;
  phase: MissionPhase;
  status: 'loading' | 'done' | 'error';
  result?: ContingencyResponse;
  error?: string;
  /** The pad before an automatic relocation, so the crew can undo it. */
  prevSite?: SelectedSite;
  epochUTC: string;
  relocated?: boolean;
  undone?: boolean;
}

type ChatEntry =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; reply: AssistantReply; before?: AgentSnapshot; undone?: boolean }
  | { id: string; role: 'contingency'; c: ContingencyState };

/** Text the model sees in history for a finished re-assessment. */
function contingencyHistory(c: ContingencyState): string | null {
  if (c.status !== 'done' || !c.result) return null;
  const r = c.result;
  const fmt = (x: ContingencyCheck) => `${x.label} ${Math.round(x.value * 10) / 10}${x.unit} (${x.kind === 'max' ? '≤' : '≥'}${x.limit}${x.unit} ${x.ok ? 'ok' : 'FAIL'})`;
  let t = `[Site re-assessment for ${CONTINGENCY_PRESETS[c.anomaly].label}] Original pad ${r.viable ? 'VIABLE' : 'NOT VIABLE'}: ${r.baseline.checks.map(fmt).join(', ')}.`;
  if (r.relocation && c.relocated && !c.undone)
    t += ` Relocated ${(r.relocation.distance_km ?? 0).toFixed(2)} km ${compassWord(r.relocation.bearing_deg ?? 0)} to ${r.relocation.lat.toFixed(4)}, ${r.relocation.lon.toFixed(4)}: ${r.relocation.checks.map(fmt).join(', ')}; verdict ${r.relocation.status}.`;
  else if (c.undone) t += ' Relocation was undone by the crew; back on the original pad.';
  else if (!r.viable) t += ` ${r.note}`;
  return t;
}

let seq = 0;
const nextId = () => `c${Date.now()}-${seq++}`;

/* ───────────── top-bar toggle ───────────── */

export function CapcomButton() {
  const isOpen = useAssistantStore((s) => s.isOpen);
  const setOpen = useAssistantStore((s) => s.setOpen);
  return (
    <button
      type="button"
      onClick={() => setOpen(!isOpen)}
      aria-expanded={isOpen}
      aria-label={isOpen ? 'Close Hadfield assistant' : 'Open Hadfield voice assistant'}
      title="Hadfield voice assistant"
      className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold ring-1 transition-colors ${
        isOpen ? 'bg-sky-400 text-slate-950 ring-sky-300' : 'bg-sky-500/20 text-sky-200 ring-sky-400/40 hover:bg-sky-500/30'
      }`}
    >
      <MicIcon className="h-4 w-4" />
      <span className="hidden sm:inline">Hadfield</span>
    </button>
  );
}

function MicIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8" />
    </svg>
  );
}

/* ───────────── panel ───────────── */

export function AssistantPanel() {
  const isOpen = useAssistantStore((s) => s.isOpen);
  const setOpen = useAssistantStore((s) => s.setOpen);
  const flash = useAssistantStore((s) => s.flash);
  const siteName = useMissionStore((s) => s.selectedSite?.name ?? null);
  const epochUTC = useMissionStore((s) => s.epochUTC);

  const [phase, setPhase] = useState<MissionPhase>('pre-landing');
  const [muted, setMuted] = useState(false);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState('');
  // With a site selected the screen is crowded: quick-issue buttons live behind a dropdown.
  const [issuesOpen, setIssuesOpen] = useState(false);
  const compact = siteName !== null;
  const [pending, setPending] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [voiceSupported, setVoiceSupported] = useState<boolean | null>(null);
  const [micBlocked, setMicBlocked] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState('');
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef('');
  const interimRef = useRef('');
  const sendOnEndRef = useRef(false);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  /* speech synthesis */
  const cancelSpeech = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  useEffect(() => {
    setVoiceSupported(getRecognitionCtor() !== null);
    if (!('speechSynthesis' in window)) return;
    const pick = () => {
      const en = rankVoices(window.speechSynthesis.getVoices());
      setVoices(en);
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(VOICE_KEY);
      } catch {
        /* storage unavailable */
      }
      voiceRef.current = en.find((v) => v.voiceURI === saved) ?? en[0] ?? null;
      setVoiceURI(voiceRef.current?.voiceURI ?? '');
    };
    pick();
    window.speechSynthesis.addEventListener('voiceschanged', pick);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', pick);
      window.speechSynthesis.cancel();
      recRef.current?.abort();
    };
  }, []);

  const speak = useCallback(
    (text: string, queue = false) => {
      if (mutedRef.current || !text || !('speechSynthesis' in window)) return;
      if (!queue) cancelSpeech();
      const u = new SpeechSynthesisUtterance(text);
      u.pitch = 1.0;
      u.rate = 1.02;
      if (voiceRef.current) {
        u.voice = voiceRef.current;
        u.lang = voiceRef.current.lang;
      } else u.lang = 'en-US';
      window.speechSynthesis.speak(u);
    },
    [cancelSpeech],
  );

  /* panel open/close side effects */
  useEffect(() => {
    if (!isOpen) {
      cancelSpeech();
      sendOnEndRef.current = false;
      recRef.current?.abort();
      return;
    }
    // Make sure the launch calendar is loaded so Hadfield can quote the best GO windows.
    const m = useMissionStore.getState();
    if (m.selectedSite) void m.fetchLaunchCalendar();
  }, [isOpen, cancelSpeech]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, pending, interim]);

  const patchContingency = (id: string, patch: Partial<ContingencyState>) =>
    setMessages((prev) => prev.map((m) => (m.id === id && m.role === 'contingency' ? { ...m, c: { ...m.c, ...patch } } : m)));

  /** Re-check the current pad for a reported anomaly and relocate automatically when it fails. */
  const runContingency = async (anomaly: AnomalyType) => {
    const m = useMissionStore.getState();
    const site = m.selectedSite;
    const id = nextId();
    if (!site) {
      setMessages((prev) => [
        ...prev,
        { id, role: 'contingency', c: { anomaly, phase, status: 'error', error: 'Select a landing site first.', epochUTC: m.epochUTC } },
      ]);
      return;
    }
    const epochUTC = m.epochUTC;
    setMessages((prev) => [...prev, { id, role: 'contingency', c: { anomaly, phase, status: 'loading', epochUTC, prevSite: site } }]);
    try {
      const result = await api.contingency(
        buildContingencyRequest(anomaly, phase, site, epochUTC, m.missionDurationDays, m.minEarthElevationDeg),
      );
      const rl = result.relocation;
      const relocate = !result.viable && !!rl && phase !== 'surface';
      if (relocate) {
        useMissionStore
          .getState()
          .selectSite(
            { lat: rl.lat, lon: rl.lon, name: `Contingency pad · ${site.name.replace(/^(Contingency|Alt\.) pad · /, '')}`, regionId: null },
            { epochUTC, fly: true },
          );
      }
      patchContingency(id, { status: 'done', result, relocated: relocate });
      speak(contingencySpeech(anomaly, result, phase), true);
      flash('verdict');
    } catch (err) {
      patchContingency(id, { status: 'error', error: errorMessage(err) });
    }
  };

  const undoRelocation = (id: string, c: ContingencyState) => {
    if (!c.prevSite) return;
    useMissionStore.getState().selectSite(c.prevSite, { epochUTC: c.epochUTC, fly: true });
    patchContingency(id, { undone: true });
  };

  /* send */
  const send = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (!question || pending) return;
      cancelSpeech();
      const history: AssistantTurn[] = messages.flatMap((m): AssistantTurn[] => {
        if (m.role === 'user') return [{ role: 'user', content: m.text }];
        if (m.role === 'contingency') {
          const t = contingencyHistory(m.c);
          return t ? [{ role: 'assistant', content: t }] : [];
        }
        if (m.reply.error) return [];
        const { say, details, action, highlight } = m.reply;
        const did = m.reply.actions?.length ? ` [App actions taken: ${describeActions(m.reply.actions).join('; ')}${m.undone ? ' — later UNDONE by the crew' : ''}]` : '';
        return [{ role: 'assistant', content: JSON.stringify({ say, details, action, highlight }) + did }];
      });
      setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: question }]);
      setPending(true);

      const mission = useMissionStore.getState();
      if (mission.selectedSite) void mission.fetchLaunchCalendar(); // no-op when already loaded
      let reply: AssistantReply;
      try {
        const res = await fetch('/api/assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, missionState: buildMissionState(mission, phase), history, context: agentContext() }),
        });
        reply = res.ok ? ((await res.json()) as AssistantReply) : OFFLINE;
      } catch {
        reply = OFFLINE;
      }
      const acted = !reply.error && !!reply.actions?.length;
      const before = acted ? snapshot() : undefined;
      setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', reply, before }]);
      speak(reply.say);
      if (acted) await applyAgentActions(reply.actions!);
      else if (reply.highlight && reply.highlight !== 'none') flash(reply.highlight);
      if (reply.anomaly && !reply.error) await runContingency(reply.anomaly);
      setPending(false);
    },
    [pending, messages, phase, cancelSpeech, speak, flash],
  );

  // Recognition callbacks outlive renders; always call the latest `send`.
  const sendRef = useRef(send);
  sendRef.current = send;

  /* hold-to-talk */
  const startListening = () => {
    cancelSpeech();
    if (pending || listening) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    finalRef.current = '';
    interimRef.current = '';
    sendOnEndRef.current = true;
    rec.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalRef.current += `${r[0].transcript} `;
        else live += r[0].transcript;
      }
      interimRef.current = live;
      setInterim(`${finalRef.current}${live}`.trim());
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setMicBlocked(true);
        sendOnEndRef.current = false;
      }
    };
    rec.onend = () => {
      const text = `${finalRef.current}${interimRef.current}`.trim();
      setListening(false);
      setInterim('');
      recRef.current = null;
      if (sendOnEndRef.current && text) void sendRef.current(text);
      sendOnEndRef.current = false;
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
      setMicBlocked(false);
    } catch {
      recRef.current = null;
    }
  };
  const stopListening = () => {
    try {
      recRef.current?.stop();
    } catch {
      /* already stopped */
    }
  };

  const toggleMute = () => {
    setMuted((m) => {
      if (!m) cancelSpeech();
      return !m;
    });
  };

  const clearChat = () => {
    cancelSpeech();
    setMessages([]);
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft.trim()) return;
    void send(draft);
    setDraft('');
  };

  const onMicKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      if (e.type === 'keydown') startListening();
      else stopListening();
    }
  };

  const IssueChips = () => (
      <div className={`grid grid-cols-2 gap-1.5 p-2 ${compact ? 'border-t' : 'border-b'} border-slate-800/80`} role="group" aria-label="Quick issues">
        {CHIPS.map((c) => (
          <button
            key={c.label}
            type="button"
            disabled={c.question !== null && pending}
            onClick={() => {
              setIssuesOpen(false);
              if (c.question) void send(c.question);
              else inputRef.current?.focus();
            }}
            className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-900/60 px-2.5 text-left text-xs font-medium text-slate-200 ring-1 ring-slate-700/80 transition-colors hover:bg-slate-800 hover:ring-sky-500/50 disabled:opacity-40"
          >
            <span aria-hidden className="w-4 text-center">
              {c.icon}
            </span>
            {c.label}
          </button>
        ))}
      </div>
  );

  if (!isOpen) return null;

  const micLabel = pending ? 'Thinking…' : listening ? 'Listening…' : 'Hold to talk';

  return (
    <aside
      className={`${PANEL} flex h-[min(560px,80svh)] flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/60 xl:absolute xl:inset-0 xl:h-auto`}
      aria-label="Hadfield mission assistant"
    >
      {/* header */}
      <header className="flex items-center gap-1.5 border-b sm:gap-2 border-slate-800/80 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="relative hidden h-8 w-8 shrink-0 place-items-center rounded-full bg-sky-500/15 sm:grid text-sky-300 ring-1 ring-sky-400/40">
            <MicIcon className="h-4 w-4" />
            {(listening || pending) && <span className="absolute inset-0 animate-ping rounded-full ring-2 ring-sky-400/50" />}
          </span>
          <div className="min-w-0">
            <h2 className="truncate font-mono text-sm font-bold tracking-[0.12em] text-slate-50 sm:tracking-[0.2em]">HADFIELD</h2>
            <p className="truncate font-mono text-[10px] text-slate-500" title={siteName ?? undefined}>
              {siteName ?? 'No site selected'} · {epochUTC.slice(0, 16).replace('T', ' ')}Z
            </p>
          </div>
        </div>
        <select
          aria-label="Mission phase"
          value={phase}
          onChange={(e) => setPhase(e.target.value as MissionPhase)}
          className="min-h-11 max-w-[8.5rem] shrink-0 rounded-lg bg-slate-900/80 px-2 text-xs text-slate-100 ring-1 ring-slate-700/80 outline-none focus:ring-sky-500/70"
        >
          {PHASES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={toggleMute}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute voice' : 'Mute voice'}
          title={muted ? 'Voice muted' : 'Voice on'}
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg ring-1 transition-colors ${
            muted ? 'bg-amber-500/15 text-amber-300 ring-amber-400/40' : 'text-slate-300 ring-slate-700 hover:bg-slate-800'
          }`}
        >
          <SpeakerIcon muted={muted} />
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close Hadfield"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-lg text-slate-400 ring-1 ring-slate-700 hover:bg-slate-800 hover:text-slate-100"
        >
          ×
        </button>
      </header>

      {/* issue chips: always shown with no site; behind the Quick issues dropdown once a site is selected */}
      {!compact && <IssueChips />}

      {/* transcript */}
      <div ref={listRef} className="llsn-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3" aria-live="polite">
        <LearnBlock id="capcom" className="mt-0" />
        {messages.length === 0 && !listening && (
          <p className="text-xs leading-relaxed text-slate-400">
            Hadfield standing by. {compact ? 'Type or hold the mic to report a problem, or open Issues for quick buttons.' : 'Tap an issue, type, or hold the mic to talk.'} Answers use the selected site, date and the numbers on screen.
          </p>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-sky-500/90 px-3 py-1.5 text-xs leading-relaxed text-slate-950">{m.text}</p>
            </div>
          ) : m.role === 'contingency' ? (
            <ContingencyCard key={m.id} c={m.c} onUndo={() => undoRelocation(m.id, m.c)} />
          ) : (
            <AssistantBubble
              key={m.id}
              reply={m.reply}
              undone={m.undone}
              onUndo={
                m.before
                  ? () => {
                      restore(m.before!);
                      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, undone: true } : x)));
                    }
                  : undefined
              }
            />
          ),
        )}
        {listening && interim && (
          <div className="flex justify-end">
            <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-sky-500/20 px-3 py-1.5 text-xs italic text-sky-100 ring-1 ring-sky-400/40">{interim}…</p>
          </div>
        )}
        {pending && <p className="animate-pulse font-mono text-[11px] tracking-wide text-sky-300/80">Hadfield · Thinking…</p>}
      </div>

      {/* quick issues dropdown (compact mode) */}
      {compact && issuesOpen && <IssueChips />}

      {/* input */}
      <form onSubmit={submit} className="flex items-center gap-2 border-t border-slate-800/80 p-2">
        {compact && (
          <button
            type="button"
            onClick={() => setIssuesOpen((o) => !o)}
            aria-expanded={issuesOpen}
            aria-label={issuesOpen ? 'Hide quick issues' : 'Show quick issues'}
            title="Quick issues"
            className={`flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-medium ring-1 transition-colors ${
              issuesOpen ? 'bg-sky-500/20 text-sky-100 ring-sky-400/50' : 'bg-slate-900/80 text-slate-300 ring-slate-700/80 hover:bg-slate-800'
            }`}
          >
            Issues
            <span aria-hidden className={`inline-block transition-transform ${issuesOpen ? 'rotate-180' : ''}`}>
              ▴
            </span>
          </button>
        )}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message Hadfield…"
          aria-label="Message Hadfield"
          className="min-h-11 min-w-0 flex-1 rounded-lg bg-slate-900/80 px-3 text-sm text-slate-100 ring-1 ring-slate-700/80 outline-none placeholder:text-slate-500 focus:ring-sky-500/70"
        />
        <button
          type="submit"
          disabled={!draft.trim() || pending}
          className="min-h-11 rounded-lg bg-slate-100 px-4 text-xs font-semibold text-slate-950 hover:bg-white disabled:opacity-40"
        >
          {pending ? 'Thinking…' : 'Send'}
        </button>
        {messages.length > 0 && (
          <button type="button" onClick={clearChat} className="min-h-11 rounded-lg px-2 text-[11px] text-slate-400 hover:text-slate-200">
            Clear
          </button>
        )}
      </form>

      {/* hold-to-talk */}
      <div className="border-t border-slate-800/80 px-3 pb-2 pt-2.5">
        {voiceSupported === false ? (
          <p className="rounded-lg bg-slate-800/50 px-3 py-2 text-center text-xs text-slate-300">Voice input isn&apos;t supported in this browser. Type instead.</p>
        ) : (
          voiceSupported && (
            <>
              {micBlocked && (
                <p className="mb-2 rounded-lg bg-amber-500/10 px-3 py-1.5 text-center text-[11px] text-amber-200 ring-1 ring-amber-400/30">
                  Microphone blocked. Allow it in your browser settings or type instead.
                </p>
              )}
              <button
                type="button"
                disabled={pending}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  startListening();
                }}
                onPointerUp={stopListening}
                onPointerCancel={stopListening}
                onKeyDown={onMicKey}
                onKeyUp={onMicKey}
                onContextMenu={(e) => e.preventDefault()}
                aria-label={micLabel}
                className={`flex min-h-14 w-full touch-none select-none items-center justify-center gap-2.5 rounded-2xl text-sm font-semibold tracking-wide ring-1 transition-all disabled:opacity-60 ${
                  listening
                    ? 'llsn-mic-live scale-[0.98] bg-rose-500/25 text-rose-100 ring-rose-400/70'
                    : pending
                      ? 'bg-slate-800/70 text-sky-200 ring-slate-700'
                      : 'bg-sky-500/20 text-sky-100 ring-sky-400/50 hover:bg-sky-500/30'
                }`}
              >
                <MicIcon className="h-5 w-5" />
                {micLabel}
              </button>
            </>
          )
        )}
        <div className="mt-1.5 flex items-center justify-center gap-2 text-[10px] text-slate-500">
          <span>Simulation assistant. Not flight-certified.</span>
          {voices.length > 1 && (
            <select
              aria-label="Hadfield voice"
              value={voiceURI}
              onChange={(e) => {
                const v = voices.find((x) => x.voiceURI === e.target.value) ?? null;
                voiceRef.current = v;
                setVoiceURI(e.target.value);
                try {
                  localStorage.setItem(VOICE_KEY, e.target.value);
                } catch {
                  /* storage unavailable */
                }
                speak('Hadfield standing by.');
              }}
              className="max-w-[150px] truncate rounded bg-slate-900/80 px-1 py-0.5 text-[10px] text-slate-300 ring-1 ring-slate-700/80 outline-none"
            >
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name.replace(/\s*\(.*English.*\)/, '')}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </aside>
  );
}

function AssistantBubble({ reply, onUndo, undone }: { reply: AssistantReply; onUndo?: () => void; undone?: boolean }) {
  const did = reply.actions?.length ? describeActions(reply.actions) : [];
  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[92%] rounded-2xl rounded-bl-sm px-3 py-2 ring-1 ${
          reply.error ? 'bg-amber-500/10 ring-amber-400/30' : 'bg-slate-800/80 ring-slate-700/60'
        }`}
      >
        <p className="mb-0.5 font-mono text-[9px] font-semibold tracking-[0.2em] text-sky-400/80">HADFIELD</p>
        <p className={`text-sm font-medium leading-snug ${reply.error ? 'text-amber-200' : 'text-slate-50'}`}>{reply.say}</p>
        {reply.action && (
          <p className="mt-1.5 rounded-lg bg-sky-500/10 px-2 py-1 text-xs text-sky-100 ring-1 ring-sky-400/30">
            <span className="mr-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-sky-300">Next step</span>
            {reply.action}
          </p>
        )}
        {did.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {did.map((d, i) => (
              <span
                key={i}
                className={`rounded-full px-2 py-0.5 text-[10px] ring-1 ${undone ? 'text-slate-500 line-through ring-slate-700' : 'bg-emerald-500/10 text-emerald-200 ring-emerald-400/30'}`}
              >
                ✓ {d}
              </span>
            ))}
            {onUndo && !undone && (
              <button type="button" onClick={onUndo} className="ml-1 text-[10px] text-slate-400 underline hover:text-slate-200">
                Undo
              </button>
            )}
          </div>
        )}
        {reply.details && (
          <details className="group mt-1.5">
            <summary className="cursor-pointer list-none text-[11px] font-medium text-slate-400 hover:text-slate-200">
              <span className="inline-block transition-transform group-open:rotate-90">▸</span> More
            </summary>
            <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-300">{reply.details}</p>
          </details>
        )}
      </div>
    </div>
  );
}

function fmtCheck(c: ContingencyCheck) {
  const v = c.unit === '°' ? c.value.toFixed(1) : Math.round(c.value).toString();
  return `${v}${c.unit}`;
}

function ContingencyCard({ c, onUndo }: { c: ContingencyState; onUndo: () => void }) {
  const preset = CONTINGENCY_PRESETS[c.anomaly];
  const r = c.result;
  const rl = r?.relocation ?? null;
  const tone =
    c.status === 'loading'
      ? 'ring-sky-500/40 bg-sky-500/5'
      : c.status === 'error'
        ? 'ring-amber-400/40 bg-amber-500/10'
        : r?.viable
          ? 'ring-emerald-400/40 bg-emerald-500/10'
          : 'ring-rose-400/40 bg-rose-500/10';
  return (
    <div className="flex justify-start">
      <div className={`w-full max-w-[92%] rounded-2xl rounded-bl-sm px-3 py-2 ring-1 ${tone}`} data-testid="contingency-card">
        <p className="mb-0.5 font-mono text-[9px] font-semibold tracking-[0.2em] text-sky-400/80">SITE RE-ASSESSMENT · {preset.label.toUpperCase()}</p>
        <LearnBlock id="contingency" className="mb-1 mt-0" />
        {c.status === 'loading' && (
          <p className="flex items-center gap-2 text-xs text-slate-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
            Checking the pad against {preset.label.toLowerCase()} limits…
          </p>
        )}
        {c.status === 'error' && <p className="text-xs text-amber-200">Re-assessment failed: {c.error}</p>}
        {c.status === 'done' && r && (
          <>
            <p className={`text-sm font-semibold ${r.viable ? 'text-emerald-200' : 'text-rose-200'}`}>
              {r.viable ? 'Current pad still viable' : 'Current pad NOT viable'}
              {!r.viable && r.failed.length > 0 && <span className="font-normal text-rose-200/80"> · fails {r.failed.join(', ').toLowerCase()}</span>}
            </p>
            <table className="mt-1.5 w-full text-[11px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="font-medium">Limit</th>
                  <th className="font-medium">Current</th>
                  {rl && <th className="font-medium">New pad</th>}
                </tr>
              </thead>
              <tbody className="font-mono">
                {r.baseline.checks.map((b, i) => {
                  const n = rl?.checks[i];
                  return (
                    <tr key={b.key}>
                      <td className="py-0.5 font-sans text-slate-400">
                        {b.label} {b.kind === 'max' ? '≤' : '≥'} {b.limit}
                        {b.unit}
                      </td>
                      <td className={b.ok ? 'text-emerald-300' : 'text-rose-300'}>{fmtCheck(b)}</td>
                      {n && <td className={n.ok ? 'text-emerald-300' : 'text-rose-300'}>{fmtCheck(n)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rl && c.phase !== 'surface' && (
              <p className="mt-1.5 rounded-lg bg-sky-500/10 px-2 py-1 text-xs text-sky-100 ring-1 ring-sky-400/30">
                <span className="mr-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-sky-300">
                  {c.undone ? 'Relocation undone' : 'Relocated'}
                </span>
                {(rl.distance_km ?? 0).toFixed(2)} km {compassWord(rl.bearing_deg ?? 0)} · verdict {rl.status}
                {!rl.meets_all && ' · best reachable, not all limits met'}
              </p>
            )}
            {!r.viable && !rl && <p className="mt-1.5 text-xs text-slate-300">{r.note}</p>}
            {c.relocated && !c.undone && (
              <button type="button" onClick={onUndo} className="mt-1.5 text-[11px] text-slate-400 underline hover:text-slate-200">
                Undo, return to original pad
              </button>
            )}
            <details className="group mt-1.5">
              <summary className="cursor-pointer list-none text-[11px] font-medium text-slate-400 hover:text-slate-200">
                <span className="inline-block transition-transform group-open:rotate-90">▸</span> Why these limits
              </summary>
              <p className="mt-1 text-xs leading-relaxed text-slate-300">
                {preset.rationale} Divert radius {r.search_radius_km} km{c.phase === 'descent' ? ' (halved during descent)' : ''};{' '}
                {r.candidates_evaluated} candidate pads checked against the DE421 Sun/Earth ephemeris and LOLA horizon in {Math.round(r.computed_in_ms)} ms.
              </p>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      {muted ? <path d="m23 9-6 6M17 9l6 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />}
    </svg>
  );
}
