'use client';

import { DISPLAY_MODES, MODE_LABEL, type DisplayMode } from '@/lib/displayMode';
import { useMissionStore } from '@/store/useMissionStore';

const HINT: Record<DisplayMode, string> = {
  standard: 'The essentials: verdict, power, comms and temperature',
  learn: 'Everything explained in plain language, with a glossary',
  expert: 'Engineering detail: power curve, slope, ice, Earth benchmark and all controls',
};

/** Standard | Learn | Expert segmented control (replaces the old Learn switch and Less/More button). */
export function ModeSwitch() {
  const mode = useMissionStore((s) => s.displayMode);
  const setMode = useMissionStore((s) => s.setDisplayMode);
  return (
    <div role="radiogroup" aria-label="Display mode" className="flex h-8 items-center rounded-lg bg-slate-900/80 p-0.5 ring-1 ring-slate-700/80">
      {DISPLAY_MODES.map((m) => {
        const on = m === mode;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={on}
            title={HINT[m]}
            onClick={() => setMode(m)}
            className={`h-7 rounded-md px-2.5 text-xs font-semibold transition-colors ${
              on ? 'bg-sky-500/80 text-slate-950 shadow' : 'text-slate-300 hover:bg-slate-800 hover:text-slate-100'
            }`}
          >
            {MODE_LABEL[m]}
          </button>
        );
      })}
    </div>
  );
}
