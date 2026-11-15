'use client';

import { useId, useState, type ReactNode } from 'react';
import { GLOSSARY, type GlossaryId } from '@/lib/glossary';

/** An underlined glossary term: hover, focus or tap shows the plain-language definition. */
export function Term({ id, children }: { id: GlossaryId; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const g = GLOSSARY[id];
  return (
    <span className="relative inline" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-describedby={open ? tipId : undefined}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="cursor-help underline decoration-sky-400/70 decoration-dotted underline-offset-2 hover:text-sky-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
      >
        {children ?? g.term}
      </button>
      {open && (
        <span
          id={tipId}
          role="tooltip"
          className="absolute bottom-full left-0 z-50 mb-1.5 block w-64 rounded-lg bg-slate-950 p-2 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-slate-200 shadow-xl ring-1 ring-sky-500/40"
        >
          <span className="mb-0.5 block font-semibold text-sky-200">{g.term}</span>
          {g.plain}
        </span>
      )}
    </span>
  );
}

/** Render text containing [[glossary-id|shown words]] markers as text + <Term>s. */
export function GlossaryText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /\[\[([a-z-]+)\|([^\]]+)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const id = m[1] as GlossaryId;
    parts.push(
      id in GLOSSARY ? (
        <Term key={m.index} id={id}>
          {m[2]}
        </Term>
      ) : (
        m[2]
      ),
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
