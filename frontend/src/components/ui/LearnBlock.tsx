'use client';

import type { ReactNode } from 'react';
import { LEARN_CONTENT, type LearnId } from '@/lib/learnContent';
import { useMissionStore } from '@/store/useMissionStore';
import { GlossaryText } from './Term';

/**
 * Learn-mode explanation for one on-screen element (renders nothing in Standard / Expert):
 * what it is, plus a "What this means for the mission" line. `extra` adds a live sentence.
 */
export function LearnBlock({ id, extra, className = '' }: { id: LearnId; extra?: ReactNode; className?: string }) {
  const learn = useMissionStore((s) => s.displayMode === 'learn');
  if (!learn) return null;
  const c = LEARN_CONTENT[id];
  return (
    <div className={`mt-2 space-y-1 border-l-2 border-sky-500/50 pl-2 text-[11px] leading-snug text-slate-300/90 ${className}`} data-learn={id}>
      <p>
        <GlossaryText text={c.what} />
      </p>
      {extra && <p className="text-sky-100/90">{extra}</p>}
      <p>
        <span className="font-semibold text-sky-300">What this means for the mission: </span>
        <GlossaryText text={c.mission} />
      </p>
    </div>
  );
}
