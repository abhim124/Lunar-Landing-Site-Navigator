'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { EARTH_BENCHMARKS, benchmarkById, benchmarkSeries } from '@/lib/earthSolar';
import { fmtNum } from '@/lib/format';
import { powerSeries, powerStats, sampleStepH } from '@/lib/power';
import { kToC } from '@/lib/temperature';
import { useMissionStore } from '@/store/useMissionStore';
import type { SiteEvaluationResponse } from '@/types/mission';
import { EstTag } from '@/components/ui/EstTag';
import { TEMP_MODEL_TIP, useTemperature } from '@/components/ui/TemperatureTile';

const POWER_TIP =
  'Estimate: P = 1361 W/m² × panel area × efficiency × cos(incidence) × visible fraction of the solar disk. Sun position and the visible fraction come from the app’s DE421 ephemeris and LOLA terrain horizon; the panel is vertical (Sun-tracking, or fixed facing the azimuth you set). No dust, temperature derating or wiring losses.';
const BENCH_TIP =
  'Earth benchmark: Sun elevation from NOAA’s solar-position formulas; clear-sky panel power ≈ 1000 W/m² × sin(elevation) × the same panel area and efficiency (no clouds); temperature is the typical monthly mean (climate normals).';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const PAD_L = 44;
const PAD_R = 12;
const PANEL_H = 92;
const GAP = 18;

interface Line {
  pts: { h: number; v: number }[];
  className: string;
  dashed?: boolean;
}

function path(pts: { h: number; v: number }[], x: (h: number) => number, y: (v: number) => number) {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.h).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
}

/** Expert 4a: Sun vs terrain horizon, panel power and temperature over the mission, with an optional Earth benchmark. */
export function SolarPowerChart({ ev }: { ev: SiteEvaluationResponse }) {
  const { expert, setExpert, scrub, setScrub } = useMissionStore(
    useShallow((s) => ({ expert: s.expert, setExpert: s.setExpert, scrub: s.scrubHour, setScrub: s.setScrubHour })),
  );
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const samples = ev.trajectory.samples;
  const step = sampleStepH(samples);
  const hours = useMemo(() => samples.map((s) => s.hours_from_start), [samples]);
  const maxH = hours[hours.length - 1] ?? ev.mission_duration_days * 24;

  const power = useMemo(() => powerSeries(samples, expert), [samples, expert]);
  const stats = useMemo(() => powerStats(power, step, expert.loadW), [power, step, expert.loadW]);
  const temp = useTemperature(ev);
  const bench = useMemo(
    () => (expert.benchmark === 'none' ? null : { b: benchmarkById(expert.benchmark), s: benchmarkSeries(benchmarkById(expert.benchmark), ev.epoch_utc, hours, expert) }),
    [expert, ev.epoch_utc, hours],
  );
  const benchKWh = bench ? (bench.s.reduce((a, p) => a + p.w, 0) * step) / 1000 : 0;

  const x = (h: number) => PAD_L + (h / Math.max(maxH, 1e-6)) * (width - PAD_L - PAD_R);
  const panels: { key: string; title: string; unit: string; lines: Line[]; tag?: React.ReactNode; band?: boolean; range?: [number, number] }[] = [];

  const sunEl = samples.map((s) => ({ h: s.hours_from_start, v: s.sun_el_deg }));
  const horizon = samples.map((s) => ({ h: s.hours_from_start, v: s.sun_horizon_el_deg ?? 0 }));
  const elMin = Math.min(...sunEl.map((p) => p.v), ...horizon.map((p) => p.v));
  const elMax = Math.max(...sunEl.map((p) => p.v), ...horizon.map((p) => p.v));
  const elPad = Math.max(0.3, (elMax - elMin) * 0.12);
  panels.push({
    key: 'el',
    title: 'Sun elevation vs terrain horizon',
    unit: '°',
    band: true,
    range: [elMin - elPad, elMax + elPad],
    lines: [
      { pts: horizon, className: 'stroke-slate-400' },
      { pts: sunEl, className: 'stroke-amber-300' },
      ...(bench ? [{ pts: bench.s.map((p) => ({ h: p.h, v: p.elDeg })), className: 'stroke-sky-300', dashed: true }] : []),
    ],
  });
  panels.push({
    key: 'w',
    title: 'Panel power',
    unit: 'W',
    tag: <EstTag kind="est" tip={POWER_TIP} />,
    lines: [
      { pts: power.map((p) => ({ h: p.h, v: p.w })), className: 'stroke-emerald-300' },
      ...(bench ? [{ pts: bench.s.map((p) => ({ h: p.h, v: p.w })), className: 'stroke-sky-300', dashed: true }] : []),
    ],
  });
  if (expert.showTemperature && temp)
    panels.push({
      key: 't',
      title: 'Surface temperature',
      unit: '°C',
      tag: <EstTag kind="est" tip={TEMP_MODEL_TIP} />,
      lines: [
        { pts: temp.series.map((p) => ({ h: p.h, v: kToC(p.k) })), className: 'stroke-orange-300' },
        ...(bench ? [{ pts: bench.s.map((p) => ({ h: p.h, v: p.tempC })), className: 'stroke-sky-300', dashed: true }] : []),
      ],
    });

  const height = panels.length * (PANEL_H + GAP) + 18;
  const dayTicks = Array.from({ length: Math.floor(maxH / 24) + 1 }, (_, i) => i * 24);

  const onPick = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    setScrub(Math.min(maxH, Math.max(0, ((px - PAD_L) / (width - PAD_L - PAD_R)) * maxH)));
  };

  const ratio = bench && benchKWh > 0.01 ? stats.energyKWh / benchKWh : null;
  const place = bench?.b.name.split(',')[0];

  const num = (label: string, value: number, onChange: (v: number) => void, opts: { step: number; min: number; max: number; w?: string }) => (
    <label className="flex items-center gap-1 text-[10px] text-slate-400">
      {label}
      <input
        type="number"
        value={value}
        step={opts.step}
        min={opts.min}
        max={opts.max}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.min(opts.max, Math.max(opts.min, v)));
        }}
        className={`h-7 ${opts.w ?? 'w-16'} rounded-md bg-slate-900/80 px-1.5 font-mono text-xs text-slate-100 ring-1 ring-slate-700/80 outline-none focus:ring-sky-500/70`}
      />
    </label>
  );

  return (
    <div className="space-y-2">
      {/* assumptions */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {num('Panel m²', expert.panelAreaM2, (v) => setExpert({ panelAreaM2: v }), { step: 1, min: 0.1, max: 1000 })}
        {num('Efficiency', expert.panelEff, (v) => setExpert({ panelEff: v }), { step: 0.01, min: 0.01, max: 1 })}
        <label className="flex items-center gap-1 text-[10px] text-slate-400">
          Panel
          <select
            value={expert.orientation}
            onChange={(e) => setExpert({ orientation: e.target.value as 'tracking' | 'fixed' })}
            className="h-7 rounded-md bg-slate-900/80 px-1.5 text-xs text-slate-100 ring-1 ring-slate-700/80 outline-none"
          >
            <option value="tracking">Vertical, Sun-tracking</option>
            <option value="fixed">Vertical, fixed azimuth</option>
          </select>
        </label>
        {expert.orientation === 'fixed' && num('Facing °', expert.facingAzDeg, (v) => setExpert({ facingAzDeg: v }), { step: 5, min: 0, max: 360, w: 'w-14' })}
        {num('Load W', expert.loadW, (v) => setExpert({ loadW: v }), { step: 10, min: 0, max: 100000 })}
        <label className="flex items-center gap-1 text-[10px] text-slate-400">
          <input type="checkbox" checked={expert.showTemperature} onChange={(e) => setExpert({ showTemperature: e.target.checked })} />
          Temperature
        </label>
        <label className="flex items-center gap-1 text-[10px] text-slate-400">
          Earth benchmark
          <select
            value={expert.benchmark}
            onChange={(e) => setExpert({ benchmark: e.target.value as typeof expert.benchmark })}
            className="h-7 rounded-md bg-slate-900/80 px-1.5 text-xs text-slate-100 ring-1 ring-slate-700/80 outline-none"
          >
            <option value="none">Off</option>
            {EARTH_BENCHMARKS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        {bench && <EstTag kind="typical" tip={`${BENCH_TIP} ${bench.b.source}.`} />}
      </div>

      {/* chart */}
      <div ref={wrapRef} className="w-full min-w-0 overflow-hidden">
        <svg width={width} height={height} className="cursor-crosshair select-none" onClick={onPick} role="img" aria-label="Sun elevation, terrain horizon, panel power and temperature over the mission">
          {panels.map((p, i) => {
            const top = i * (PANEL_H + GAP) + GAP - 2;
            const vals = p.lines.flatMap((l) => (l.dashed && p.key === 'el' ? [] : l.pts.map((q) => q.v)));
            let [lo, hi] = p.range ?? [Math.min(0, ...vals), Math.max(...vals, 1)];
            if (!p.range) {
              const pad = (hi - lo) * 0.08 || 1;
              hi += pad;
              if (lo < 0) lo -= pad;
            }
            const y = (v: number) => top + PANEL_H - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1)) * PANEL_H;
            const clip = `clip-${p.key}`;
            return (
              <g key={p.key}>
                <defs>
                  <clipPath id={clip}>
                    <rect x={PAD_L} y={top} width={width - PAD_L - PAD_R} height={PANEL_H} />
                  </clipPath>
                </defs>
                <rect x={PAD_L} y={top} width={width - PAD_L - PAD_R} height={PANEL_H} className="fill-slate-900/40 stroke-slate-800" />
                <text x={PAD_L} y={top - 5} className="fill-slate-400 text-[10px]">
                  {p.title}
                </text>
                {[lo, (lo + hi) / 2, hi].map((v) => (
                  <g key={v}>
                    <line x1={PAD_L} x2={width - PAD_R} y1={y(v)} y2={y(v)} className="stroke-slate-800" strokeDasharray="2 3" />
                    <text x={PAD_L - 4} y={y(v) + 3} textAnchor="end" className="fill-slate-500 font-mono text-[9px]">
                      {fmtNum(v, Math.abs(hi - lo) < 10 ? 1 : 0)}
                      {p.unit === '°' ? '°' : ''}
                    </text>
                  </g>
                ))}
                {p.unit !== '°' && (
                  <text x={4} y={top + PANEL_H / 2} className="fill-slate-500 text-[9px]">
                    {p.unit}
                  </text>
                )}
                <g clipPath={`url(#${clip})`}>
                  {p.band &&
                    samples.map((s, k) => {
                      const hz = s.sun_horizon_el_deg ?? 0;
                      if (s.sun_el_deg >= hz || k === samples.length - 1) return null;
                      const x0 = x(s.hours_from_start);
                      const x1 = x(samples[k + 1].hours_from_start);
                      return <rect key={k} x={x0} width={Math.max(0.5, x1 - x0)} y={y(hz)} height={Math.max(0, y(s.sun_el_deg) - y(hz))} className="fill-rose-500/25" />;
                    })}
                  {p.lines.map((l, k) => (
                    <path key={k} d={path(l.pts, x, y)} fill="none" className={l.className} strokeWidth={1.5} strokeDasharray={l.dashed ? '5 4' : undefined} />
                  ))}
                </g>
              </g>
            );
          })}
          {dayTicks.map((h) => (
            <g key={h}>
              <line x1={x(h)} x2={x(h)} y1={4} y2={height - 16} className="stroke-slate-800/80" />
              <text x={x(h)} y={height - 4} textAnchor="middle" className="fill-slate-500 font-mono text-[9px]">
                d{h / 24}
              </text>
            </g>
          ))}
          <line x1={x(scrub)} x2={x(scrub)} y1={2} y2={height - 14} className="stroke-white" strokeWidth={1.5} />
          <text x={x(scrub) + 3} y={height - 18} className="fill-white font-mono text-[9px]">
            now
          </text>
        </svg>
        <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-slate-400">
          <span><span className="mr-1 inline-block h-0.5 w-4 bg-amber-300 align-middle" />Sun elevation</span>
          <span><span className="mr-1 inline-block h-0.5 w-4 bg-slate-400 align-middle" />Terrain horizon at the Sun’s azimuth</span>
          <span><span className="mr-1 inline-block h-2 w-3 bg-rose-500/25 align-middle" />Sun blocked</span>
          <span><span className="mr-1 inline-block h-0.5 w-4 bg-emerald-300 align-middle" />Power</span>
          {expert.showTemperature && <span><span className="mr-1 inline-block h-0.5 w-4 bg-orange-300 align-middle" />Temperature</span>}
          {bench && <span><span className="mr-1 inline-block w-4 border-t border-dashed border-sky-300 align-middle" />{bench.b.name} (same dates)</span>}
          <span className="text-slate-500">Click the chart to move the timeline.</span>
        </div>
      </div>

      {/* stats */}
      <dl className="grid grid-cols-2 gap-2 font-mono text-xs tabular-nums sm:grid-cols-5">
        {[
          ['Average power', `${fmtNum(stats.avgW, 0)} W`],
          ['Peak power', `${fmtNum(stats.peakW, 0)} W`],
          ['Energy', `${fmtNum(stats.energyKWh, 1)} kWh`],
          ['Longest zero-power', `${fmtNum(stats.longestZeroH, 1)} h`],
          [`Battery for ${fmtNum(expert.loadW, 0)} W`, `${fmtNum(stats.batteryWh / 1000, 2)} kWh`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-slate-900/60 px-2 py-1.5 ring-1 ring-slate-800">
            <dt className="font-sans text-[10px] text-slate-500">{k}</dt>
            <dd className="text-slate-100">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
        <EstTag kind="est" tip={POWER_TIP} />
        Battery = load × longest zero-power stretch (no depth-of-discharge margin).
      </p>
      {bench && (
        <p className="text-xs text-sky-100">
          {ratio == null
            ? `${place} gets almost no sunlight on these dates, so this site makes more power (${fmtNum(stats.energyKWh, 1)} kWh vs ${fmtNum(benchKWh, 2)} kWh).`
            : ratio >= 1
              ? `This site gets ${ratio.toFixed(1)}× the solar energy of ${place} over these ${ev.mission_duration_days} days (${fmtNum(stats.energyKWh, 1)} vs ${fmtNum(benchKWh, 1)} kWh, same panel).`
              : `This site gets ${Math.round(ratio * 100)}% of the solar energy of ${place} over these ${ev.mission_duration_days} days (${fmtNum(stats.energyKWh, 1)} vs ${fmtNum(benchKWh, 1)} kWh, same panel).`}
        </p>
      )}
    </div>
  );
}
