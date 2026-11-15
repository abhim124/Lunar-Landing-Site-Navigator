'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api, errorMessage, isAbortError } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { angleDiffDeg } from '@/lib/geo';
import { ICE_SOURCES, iceLikelihood, wehAt } from '@/lib/iceHydrogen';
import { useMissionStore } from '@/store/useMissionStore';
import type { SiteEvaluationResponse } from '@/types/mission';
import { DataSourceBadge } from '@/components/ui/DataSourceBadge';
import { EstTag } from '@/components/ui/EstTag';
import { ANALYTICS_PANEL } from '@/components/ui/SkyPanoramaDrawer';
import { SolarPowerChart } from './SolarPowerChart';

function Card({ title, children, defaultOpen = true, className = '' }: { title: string; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  return (
    <details open={defaultOpen} className={`group rounded-xl border border-slate-800/80 bg-slate-900/50 p-2.5 ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        <span className="inline-block transition-transform group-open:rotate-90">▸</span>
        {title}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

const LIKELIHOOD_STYLE = {
  Low: 'bg-slate-500/15 text-slate-300 ring-slate-400/40',
  Moderate: 'bg-sky-500/15 text-sky-200 ring-sky-400/40',
  High: 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/40',
} as const;

function IceHydrogenCard({ ev }: { ev: SiteEvaluationResponse }) {
  const weh = wehAt(ev.site.lat, ev.site.lon);
  const psr = ev.isru.nearest_ice_psr_km.value;
  const like = iceLikelihood(weh, psr);
  return (
    <Card title="Hydrogen & water ice">
      <dl className="grid grid-cols-3 gap-2 font-mono text-xs tabular-nums">
        <div>
          <dt className="flex items-center gap-1 font-sans text-[10px] text-slate-500">
            Hydrogen (WEH) <EstTag kind="illustrative" tip={ICE_SOURCES} />
          </dt>
          <dd className="text-lg text-slate-50">
            {fmtNum(weh, 2)}
            <span className="ml-1 text-xs text-slate-400">wt%</span>
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 font-sans text-[10px] text-slate-500">
            Nearest PSR <EstTag kind="measured" tip="Distance to the nearest permanently shadowed pixel in the PGDA south-polar PSR map (LOLA-derived illumination modelling)." />
          </dt>
          <dd className="text-lg text-slate-50">
            {psr == null ? '—' : fmtNum(psr, 2)}
            <span className="ml-1 text-xs text-slate-400">km</span>
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 font-sans text-[10px] text-slate-500">
            Ice likelihood <EstTag kind="illustrative" tip={`High = WEH ≥ 0.3 wt% and a PSR within 2 km; Moderate = WEH ≥ 0.15 wt% or a PSR within 5 km; otherwise Low. ${ICE_SOURCES}`} />
          </dt>
          <dd>
            <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${LIKELIHOOD_STYLE[like]}`}>{like}</span>
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] leading-snug text-slate-400">
        Hydrogen is interpolated (inverse-distance) from illustrative values at the curated sites. PSR distance is real map data, but a PSR is a cold trap,
        not proof of ice.
      </p>
      <DataSourceBadge source={ev.isru.nearest_ice_psr_km.source} className="mt-1.5" />
    </Card>
  );
}

function SlopeRoughnessCard({ ev }: { ev: SiteEvaluationResponse }) {
  const { expert, setExpert, stats, setStats } = useMissionStore(
    useShallow((s) => ({ expert: s.expert, setExpert: s.setExpert, stats: s.slopeStats, setStats: s.setSlopeStats })),
  );
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [error, setError] = useState('');
  const { lat, lon } = ev.site;
  const radius = expert.slopeRadiusM;

  useEffect(() => {
    const ctrl = new AbortController();
    setStatus('loading');
    api
      .slopeStats({ lat, lon, radius_m: radius }, ctrl.signal)
      .then((r) => {
        setStats(r);
        setStatus('ok');
      })
      .catch((e) => {
        if (isAbortError(e)) return;
        setError(errorMessage(e));
        setStatus('error');
      });
    return () => ctrl.abort();
  }, [lat, lon, radius, setStats]);

  const fresh = stats && Math.abs(stats.lat - lat) < 1e-6 && Math.abs(angleDiffDeg(stats.lon, lon)) < 1e-6 && stats.requested_radius_m === radius ? stats : null;
  const thr = expert.maxSafeSlopeDeg;
  const pass = fresh ? fresh.slope_at_point_deg <= thr && fresh.mean_slope_deg <= thr : null;

  return (
    <Card title="Slope & roughness">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[10px] text-slate-400">
        <label className="flex items-center gap-1">
          Radius m
          <input
            type="number"
            min={10}
            max={2000}
            step={10}
            value={radius}
            onChange={(e) => Number.isFinite(Number(e.target.value)) && setExpert({ slopeRadiusM: Math.min(2000, Math.max(10, Number(e.target.value))) })}
            className="h-7 w-16 rounded-md bg-slate-900/80 px-1.5 font-mono text-xs text-slate-100 ring-1 ring-slate-700/80 outline-none"
          />
        </label>
        <label className="flex items-center gap-1">
          Max safe slope °
          <input
            type="number"
            min={1}
            max={45}
            step={0.5}
            value={thr}
            onChange={(e) => Number.isFinite(Number(e.target.value)) && setExpert({ maxSafeSlopeDeg: Math.min(45, Math.max(1, Number(e.target.value))) })}
            className="h-7 w-14 rounded-md bg-slate-900/80 px-1.5 font-mono text-xs text-slate-100 ring-1 ring-slate-700/80 outline-none"
          />
          <span className="text-slate-500">(configurable threshold)</span>
        </label>
      </div>
      {status === 'error' && <p className="text-xs text-rose-300">{error}</p>}
      {!fresh && status === 'loading' && <p className="animate-pulse text-xs text-slate-500">Computing from LOLA…</p>}
      {fresh && (
        <>
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-bold ring-1 ${
                pass ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/40' : 'bg-rose-500/15 text-rose-200 ring-rose-400/40'
              }`}
            >
              {pass ? 'PASS' : 'FAIL'}
            </span>
            <span className="text-[11px] text-slate-400">
              slope at pad and mean within {fmtNum(fresh.effective_radius_m, 0)} m ≤ {thr}°
              {pass && fresh.max_slope_deg > thr && <span className="text-amber-300"> · steepest cell {fmtNum(fresh.max_slope_deg, 1)}° exceeds it</span>}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-4 gap-2 font-mono text-xs tabular-nums">
            {[
              ['At pad', `${fmtNum(fresh.slope_at_point_deg, 1)}°`],
              ['Mean', `${fmtNum(fresh.mean_slope_deg, 1)}°`],
              ['Max', `${fmtNum(fresh.max_slope_deg, 1)}°`],
              ['Roughness', `${fmtNum(fresh.roughness_rms_m, 2)} m`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-slate-900/60 px-2 py-1.5 ring-1 ring-slate-800">
                <dt className="font-sans text-[10px] text-slate-500">{k}</dt>
                <dd className="text-slate-100">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[11px] leading-snug text-slate-400">
            Real LOLA elevation data: per-cell slope from the height gradient; roughness = RMS height deviation from the best-fit plane over the disc ({fresh.n_pixels}{' '}
            cells at {fmtNum(fresh.pixel_m, 0)} m).
            {fresh.effective_radius_m > fresh.requested_radius_m && ` Only the 240 m map covers this spot, so the radius was widened to ${fmtNum(fresh.effective_radius_m, 0)} m.`}
          </p>
          <DataSourceBadge source={fresh.source} className="mt-1.5" />
        </>
      )}
    </Card>
  );
}

/** Expert-only zone: power/temperature curve, hydrogen & ice, slope & roughness. */
export function ExpertAnalysis() {
  const { site, evaluation, expert } = useMissionStore(useShallow((s) => ({ site: s.selectedSite, evaluation: s.evaluation, expert: s.displayMode === 'expert' })));
  if (!expert || !site) return null;
  const ev = evaluation && Math.abs(evaluation.site.lat - site.lat) < 1e-4 && Math.abs(angleDiffDeg(evaluation.site.lon, site.lon)) < 1e-4 ? evaluation : null;
  return (
    <div className="px-3">
      <section className={`${ANALYTICS_PANEL} p-3`} aria-label="Expert analysis">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Expert analysis</h3>
        {!ev ? (
          <p className="animate-pulse text-xs text-slate-500">Waiting for the site evaluation…</p>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            <Card title="Solar elevation, power & temperature" className="xl:col-span-2">
              <SolarPowerChart ev={ev} />
            </Card>
            <IceHydrogenCard ev={ev} />
            <SlopeRoughnessCard ev={ev} />
          </div>
        )}
      </section>
    </div>
  );
}
