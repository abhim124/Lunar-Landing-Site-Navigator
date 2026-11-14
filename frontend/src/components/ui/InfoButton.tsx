'use client';

import { useId, useState, type ReactNode } from 'react';

/** Small (i) toggle used to tuck secondary details (sources, stats, extra metrics) off the main display. */
export function InfoButton({
  open,
  onToggle,
  label,
  controls,
  className = '',
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  controls?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? `Hide ${label}` : `Show ${label}`}
      title={open ? `Hide ${label}` : label}
      className={`grid h-4 w-4 shrink-0 place-items-center rounded-full font-serif text-[10px] font-bold italic leading-none ring-1 transition-colors ${
        open ? 'bg-sky-400/90 text-slate-950 ring-sky-300' : 'text-slate-400 ring-slate-600 hover:text-slate-100 hover:ring-slate-400'
      } ${className}`}
    >
      i
    </button>
  );
}

export function InfoPanel({ id, children, className = '' }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <div id={id} className={`mt-2 space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/70 p-2 text-[11px] text-slate-300 ${className}`}>
      {children}
    </div>
  );
}

/** Convenience: state + ids for a single (i) disclosure. */
export function useInfo(initial = false) {
  const [open, setOpen] = useState(initial);
  const id = useId();
  return { open, toggle: () => setOpen((v) => !v), id };
}
