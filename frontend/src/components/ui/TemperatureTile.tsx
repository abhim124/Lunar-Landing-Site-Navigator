'use client';

import { useMemo } from 'react';
import { fmtNum } from '@/lib/format';
import { everydayComparison, isInPsr, kToC, temperatureSeries, type TemperatureSummary } from '@/lib/temperature';
import { useMissionStore } from '@/store/useMissionStore';
import type { SiteEvaluationResponse } from '@/types/mission';
import { EstTag } from './EstTag';
import { LearnBlock } from './LearnBlock';

export const TEMP_MODEL_TIP =
  'Estimate from a simple radiative-equilibrium model: T = ((1 − 0.12) · 1361 W/m² · sin e / (0.95 · σ))^¼, where e is the Sun’s height above the local terrain horizon from the app’s DE421 + LOLA calculation. Shadow ≈ 90 K, inside a permanently shadowed region ≈ 40 K. A real mission would use LRO Diviner measurements instead.';

/** Model temperature series for the current evaluation, following the timeline scrubber. */
export function useTemperature(ev: SiteEvaluationResponse | null): TemperatureSummary | null {
  const scrub = useMissionStore((s) => s.scrubHour);
  const inPsr = isInPsr(ev?.isru.nearest_ice_psr_km.value);
  const base = useMemo(() => (ev ? temperatureSeries(ev.trajectory.samples, inPsr, 0) : null), [ev, inPsr]);
  return useMemo(() => {
    if (!base) return null;
    const now = base.series.reduce((b, x) => (Math.abs(x.h - scrub) < Math.abs(b.h - scrub) ? x : b));
    return { ...base, nowK: now.k };
  }, [base, scrub]);
}

const c0 = (k: number) => `${fmtNum(kToC(k), 0)} °C`;

/** Verdict-strip tile: surface temperature now, and min / max over the mission (all modes). */
export function TemperatureTile({ ev }: { ev: SiteEvaluationResponse }) {
  const t = useTemperature(ev);
  const expert = useMissionStore((s) => s.displayMode === 'expert');
  const learn = useMissionStore((s) => s.displayMode === 'learn');
  const div = ev.thermal.surface_temperature_k.value;
  if (!t) return null;
  const nowC = kToC(t.nowK);
  return (
    <div data-highlight-target="temperature" className="rounded-xl border border-slate-800/80 bg-slate-900/50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Surface temp</span>
        <EstTag kind="est" tip={TEMP_MODEL_TIP} />
      </div>
      <div className="mt-0.5 font-mono text-lg tabular-nums text-slate-50">
        {fmtNum(nowC, 0)}
        <span className="ml-1 text-xs text-slate-400">°C now</span>
        {expert && <span className="ml-1.5 text-xs text-slate-500">{fmtNum(t.nowK, 0)} K</span>}
      </div>
      <p className="font-mono text-[10px] tabular-nums text-slate-400">
        <span className="text-sky-300">min {c0(t.minK)}</span> · <span className="text-orange-300">max {c0(t.maxK)}</span>
        {expert && (
          <span className="text-slate-500">
            {' '}
            ({fmtNum(t.minK, 0)}–{fmtNum(t.maxK, 0)} K)
          </span>
        )}
      </p>
      {div.min_k != null && div.max_k != null && (
        <p className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-500">
          Diviner measured {c0(div.min_k)} to {c0(div.max_k)}
          {expert && ` (${fmtNum(div.min_k, 0)}–${fmtNum(div.max_k, 0)} K)`}
          <EstTag
            kind="measured"
            tip="LRO Diviner Global Cumulative Product: the measured range of surface temperature over a full lunar day in this 0.5° map cell (about 15 km wide at the pole). It is a long-term average, not a forecast for these dates."
          />
        </p>
      )}
      {learn && (
        <LearnBlock
          id="temperature"
          className="mt-1.5"
          extra={`Right now about ${fmtNum(nowC, 0)} °C: ${everydayComparison(nowC)}.`}
        />
      )}
    </div>
  );
}
