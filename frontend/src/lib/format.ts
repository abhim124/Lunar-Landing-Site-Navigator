import type { MissionStatus } from '@/types/mission';

/** ISO-8601 UTC without milliseconds: 2025-03-06T17:28:00Z */
export function toIsoZ(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Parse any ISO-ish string (naive strings are treated as UTC) → canonical ISO Z, or null. */
export function normalizeEpoch(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(s);
  const t = Date.parse(hasZone ? s : `${s}Z`);
  return Number.isFinite(t) ? toIsoZ(new Date(t)) : null;
}

export function currentHourUTC(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return toIsoZ(d);
}

export function fmtNum(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

export function fmtSigned(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
}

export function fmtHours(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return '—';
  if (h >= 48) return `${(h / 24).toFixed(1)} d`;
  return `${h.toFixed(1)} h`;
}

export function fmtUtc(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export const STATUS_STYLES: Record<
  MissionStatus,
  { pill: string; dot: string; text: string; cell: string; label: string }
> = {
  GO: {
    pill: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/40',
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
    cell: 'bg-emerald-500',
    label: 'GO',
  },
  MARGINAL: {
    pill: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/40',
    dot: 'bg-amber-400',
    text: 'text-amber-300',
    cell: 'bg-amber-500',
    label: 'MARGINAL',
  },
  'NO-GO': {
    pill: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/40',
    dot: 'bg-rose-500',
    text: 'text-rose-300',
    cell: 'bg-rose-500',
    label: 'NO-GO',
  },
};

/** Shared translucent panel surface. */
export const PANEL = 'bg-slate-950/85 backdrop-blur-xl border border-slate-800/80 text-slate-100';
