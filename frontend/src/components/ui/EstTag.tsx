'use client';

import { useId, useState } from 'react';

const STYLE = {
  est: 'bg-amber-500/10 text-amber-200 ring-amber-400/40',
  illustrative: 'bg-fuchsia-500/10 text-fuchsia-200 ring-fuchsia-400/40',
  typical: 'bg-slate-500/10 text-slate-300 ring-slate-400/40',
  measured: 'bg-emerald-500/10 text-emerald-200 ring-emerald-400/40',
} as const;

/** Small provenance chip ("est.", "illustrative", "typical", "measured") with the source/assumption in a tooltip. */
export function EstTag({ kind, tip }: { kind: keyof typeof STYLE; tip: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const label = kind === 'est' ? 'est.' : kind;
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={`cursor-help rounded px-1 py-px font-sans text-[9px] font-semibold uppercase tracking-wide ring-1 ${STYLE[kind]}`}
      >
        {label}
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute bottom-full right-0 z-50 mb-1.5 block w-64 rounded-lg bg-slate-950 p-2 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-slate-200 shadow-xl ring-1 ring-slate-600"
        >
          {tip}
        </span>
      )}
    </span>
  );
}
