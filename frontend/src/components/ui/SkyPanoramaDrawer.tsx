'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useCurrentEphemeris } from '@/hooks/useCurrentEphemeris';
import { SUN_ANGULAR_RADIUS_DEG, skylineElevationAt, sortSkyline, type ScrubbedEphemeris } from '@/lib/ephemerisMath';
import { PANEL, STATUS_STYLES, fmtNum, fmtUtc } from '@/lib/format';
import { angleDiffDeg, wrap360 } from '@/lib/geo';
import { useMissionStore } from '@/store/useMissionStore';
import type { EphemerisTrajectory, LaunchCalendarDay, SkylinePoint, ValidationRow } from '@/types/mission';
import { DataSourceBadge } from './DataSourceBadge';
import { InfoButton, InfoPanel, useInfo } from './InfoButton';

/** Tab-button classes shared by the footer "NASA Validation" toggle (formerly the drawer tab style). */
export function tabButtonClass(active: boolean): string {
  return `whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
    active ? 'bg-slate-100 text-slate-950' : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
  }`;
}

/** Panel classes of the former bottom drawer, reused by each analytics zone. */
export const ANALYTICS_PANEL = `${PANEL} overflow-hidden rounded-2xl shadow-2xl shadow-black/60`;

/* ═══════════════════════ Tab 1 — panorama + timeline scrubber ═══════════════════════ */

function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export function PanoramaTab() {
  const { evaluation, evalStatus, scrubHour, setScrubHour, days, minEl, site } = useMissionStore(
    useShallow((s) => ({
      evaluation: s.evaluation,
      evalStatus: s.evaluationStatus,
      scrubHour: s.scrubHour,
      setScrubHour: s.setScrubHour,
      days: s.missionDurationDays,
      minEl: s.minEarthElevationDeg,
      site: s.selectedSite,
    })),
  );
  const { ephem, authoritative, timeMs } = useCurrentEphemeris();
  const [playing, setPlaying] = useState(false);
  const info = useInfo();

  // Real-time playback: 6 mission-hours per second, entirely client-side.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const { scrubHour: h, missionDurationDays: d, setScrubHour: set } = useMissionStore.getState();
      const next = h + dt * 6;
      if (next >= d * 24) {
        set(d * 24);
        setPlaying(false);
        return;
      }
      set(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const maxHours = days * 24;

  const skyline = useMemo(() => (evaluation ? sortSkyline(evaluation.skyline.points) : []), [evaluation]);
  // Pick between the chart's two built-in tick sets: polar low-sky (≤ 25°) or full-sky (90°).
  const yMax = useMemo(() => {
    if (!evaluation) return 25;
    const peak = Math.max(
      ...evaluation.trajectory.samples.map((s) => Math.max(s.sun_el_deg, s.earth_el_deg)),
      ...skyline.map((p) => p.elevation_deg),
    );
    return peak > 25 ? 90 : 25;
  }, [evaluation, skyline]);

  // 360° sky panorama (terrain skyline, Sun path, Earth zone) above the timeline scrubber.
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">360° Sky Panorama</h3>
      {evaluation ? (
        <div className="relative h-[170px]">
          <PanoramaChart skyline={skyline} trajectory={evaluation.trajectory} ephem={ephem} minEl={minEl} yMax={yMax} />
        </div>
      ) : (
        <div className="h-[170px] animate-pulse rounded-xl bg-slate-800/50" />
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={() => {
            if (!playing && scrubHour >= maxHours) setScrubHour(0);
            setPlaying((p) => !p);
          }}
          aria-label={playing ? 'Pause timeline' : 'Play timeline'}
          className="grid h-7 w-7 place-items-center rounded-full bg-slate-100 text-[11px] text-slate-950 hover:bg-white"
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <input
          type="range"
          min={0}
          max={maxHours}
          step={0.25}
          value={scrubHour}
          onChange={(e) => {
            setPlaying(false);
            setScrubHour(Number(e.target.value));
          }}
          aria-label="Mission timeline scrubber (hours)"
          className="llsn-range min-w-[160px] flex-1"
        />
        <span className="font-mono text-[11px] tabular-nums text-slate-300">
          T+{scrubHour.toFixed(1)} h · {fmtUtc(new Date(timeMs).toISOString())}
        </span>
        {ephem && (
          <span className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
            <span className={ephem.sunVisibleFraction > 0.01 ? 'text-amber-300' : 'text-slate-500'}>
              ☉ {fmtNum(ephem.sunElDeg, 2)}° · {fmtNum(ephem.sunVisibleFraction * 100, 0)}%
            </span>
            <span className={ephem.earthAboveCutoff ? 'text-sky-300' : 'text-rose-300'}>
              ⊕ {fmtNum(ephem.earthElDeg, 2)}° {ephem.earthAboveCutoff ? 'LINK' : ephem.earthVisible ? 'MASKED' : 'OCCULTED'}
            </span>
            {!authoritative && <span className="rounded bg-amber-500/15 px-1 text-[9px] text-amber-300">APPROX</span>}
          </span>
        )}
        <InfoButton open={info.open} onToggle={info.toggle} controls={info.id} label="timeline details" />
      </div>
      {info.open && (
        <InfoPanel id={info.id} className="mt-0">
          {ephem && (
            <p className="font-mono text-[10px] text-slate-400">
              Sun az {fmtNum(ephem.sunAzDeg, 2)}° · terrain at Sun {fmtNum(ephem.sunHorizonElDeg, 2)}° · Earth az {fmtNum(ephem.earthAzDeg, 2)}° · terrain at
              Earth {fmtNum(ephem.earthHorizonElDeg, 2)}° · antenna cutoff {minEl}°
            </p>
          )}
          {evaluation && (
            <div className="flex flex-wrap gap-1">
              <DataSourceBadge source={evaluation.trajectory.source} />
              <DataSourceBadge source={evaluation.skyline.source} />
            </div>
          )}
          {!evaluation && evalStatus === 'loading' && <p className="text-slate-500">Loading the ephemeris trajectory…</p>}
        </InfoPanel>
      )}
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="flex items-center gap-1 text-slate-400">
      <span className={`inline-block h-2 w-3 rounded-sm ${swatch}`} />
      {label}
    </span>
  );
}

const M = { l: 34, r: 10, t: 8, b: 20 };
const Y_MIN = -10;

function splitOnWrap(points: [number, number][]): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (const p of points) {
    if (cur.length && Math.abs(p[0] - cur[cur.length - 1][0]) > 180) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

function PanoramaChart({
  skyline,
  trajectory,
  ephem,
  minEl,
  yMax,
}: {
  skyline: SkylinePoint[];
  trajectory: EphemerisTrajectory;
  ephem: ScrubbedEphemeris | null;
  minEl: number;
  yMax: number;
}) {
  const [ref, { width: W, height: H }] = useElementSize<HTMLDivElement>();
  const [hoverAz, setHoverAz] = useState<number | null>(null);
  const pw = Math.max(1, W - M.l - M.r);
  const ph = Math.max(1, H - M.t - M.b);
  const xs = (az: number) => M.l + (wrap360(az) / 360) * pw;
  const xsRaw = (az: number) => M.l + (az / 360) * pw;
  const ys = (el: number) => M.t + ((yMax - Math.min(yMax, Math.max(Y_MIN, el))) / (yMax - Y_MIN)) * ph;

  const skylinePath = useMemo(() => {
    if (!skyline.length || W === 0) return '';
    const first = skyline[0];
    const last = skyline[skyline.length - 1];
    // Close the 0°/360° seam with the wrap-interpolated value.
    const wrapEl = skylineElevationAt(skyline, 0) ?? first.elevation_deg;
    let d = `M${xsRaw(0)},${ys(Y_MIN)} L${xsRaw(0)},${ys(wrapEl)}`;
    for (const p of skyline) d += ` L${xsRaw(p.azimuth_deg)},${ys(p.elevation_deg)}`;
    d += ` L${xsRaw(360)},${ys(last.azimuth_deg < 360 ? wrapEl : last.elevation_deg)} L${xsRaw(360)},${ys(Y_MIN)} Z`;
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skyline, W, H, yMax]);

  const sunSegments = useMemo(
    () => splitOnWrap(trajectory.samples.map((s) => [wrap360(s.sun_az_deg), s.sun_el_deg])),
    [trajectory],
  );
  const earthSegments = useMemo(
    () => splitOnWrap(trajectory.samples.map((s) => [wrap360(s.earth_az_deg), s.earth_el_deg])),
    [trajectory],
  );

  // Earth libration zone: circular-mean-centred az span × el span over the mission.
  const earthZone = useMemo(() => {
    const s = trajectory.samples;
    if (!s.length) return null;
    const cx = s.reduce((a, p) => a + Math.cos((p.earth_az_deg * Math.PI) / 180), 0);
    const sx = s.reduce((a, p) => a + Math.sin((p.earth_az_deg * Math.PI) / 180), 0);
    const mean = wrap360((Math.atan2(sx, cx) * 180) / Math.PI);
    const offs = s.map((p) => angleDiffDeg(p.earth_az_deg, mean));
    const els = s.map((p) => p.earth_el_deg);
    return {
      az0: mean + Math.min(...offs) - 1,
      az1: mean + Math.max(...offs) + 1,
      el0: Math.min(...els) - 0.5,
      el1: Math.max(...els) + 0.5,
    };
  }, [trajectory]);

  const zoneRects = useMemo(() => {
    if (!earthZone) return [];
    const { az0, az1 } = earthZone;
    // Unwrapped span may cross 0°/360° → split into two rectangles.
    const a = wrap360(az0);
    const span = az1 - az0;
    return a + span <= 360 ? [[a, a + span]] : [[a, 360], [0, a + span - 360]];
  }, [earthZone]);

  const yTicks = yMax > 30 ? [-10, 0, 15, 30, 45, 60, 75, 90] : [-10, -5, 0, 5, 10, 15, 20, 25];
  const hoverEl = hoverAz != null ? skylineElevationAt(skyline, hoverAz) : null;
  const sunR = Math.max(4, (SUN_ANGULAR_RADIUS_DEG / (yMax - Y_MIN)) * ph);

  return (
    <div ref={ref} className="absolute inset-0">
      {W > 0 && (
        <svg
          width={W}
          height={H}
          className="select-none"
          onMouseMove={(e) => {
            const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
            setHoverAz(x >= M.l && x <= W - M.r ? ((x - M.l) / pw) * 360 : null);
          }}
          onMouseLeave={() => setHoverAz(null)}
          role="img"
          aria-label="360 degree sky panorama with terrain skyline, Sun path and Earth zone"
        >
          <defs>
            <linearGradient id="llsn-terrain" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#64748b" stopOpacity="0.85" />
              <stop offset="100%" stopColor="#1e293b" stopOpacity="0.95" />
            </linearGradient>
            <clipPath id="llsn-plot">
              <rect x={M.l} y={M.t} width={pw} height={ph} />
            </clipPath>
          </defs>

          {yTicks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={W - M.r} y1={ys(t)} y2={ys(t)} stroke={t === 0 ? '#475569' : '#1e293b'} strokeWidth={1} />
              <text x={M.l - 5} y={ys(t) + 3} textAnchor="end" className="fill-slate-500 font-mono text-[9px]">
                {t}°
              </text>
            </g>
          ))}
          {[0, 45, 90, 135, 180, 225, 270, 315, 360].map((a) => (
            <g key={a}>
              <line x1={xsRaw(a)} x2={xsRaw(a)} y1={M.t} y2={H - M.b} stroke="#1e293b" />
              <text x={xsRaw(a)} y={H - 6} textAnchor="middle" className="fill-slate-500 font-mono text-[9px]">
                {({ 0: 'N', 90: 'E', 180: 'S', 270: 'W', 360: 'N' } as Record<number, string>)[a] ?? `${a}°`}
              </text>
            </g>
          ))}

          <g clipPath="url(#llsn-plot)">
            {earthZone &&
              zoneRects.map(([a0, a1]) => (
                <rect
                  key={a0}
                  x={xsRaw(a0)}
                  width={Math.max(2, xsRaw(a1) - xsRaw(a0))}
                  y={ys(earthZone.el1)}
                  height={Math.max(2, ys(earthZone.el0) - ys(earthZone.el1))}
                  rx={4}
                  className="fill-sky-400/15 stroke-sky-400/50"
                  strokeDasharray="3 3"
                />
              ))}
            {earthSegments.map((seg, i) => (
              <polyline
                key={`e${i}`}
                points={seg.map(([a, e]) => `${xs(a)},${ys(e)}`).join(' ')}
                fill="none"
                stroke="#38bdf8"
                strokeOpacity={0.6}
                strokeWidth={1.25}
              />
            ))}
            {sunSegments.map((seg, i) => (
              <polyline
                key={`s${i}`}
                points={seg.map(([a, e]) => `${xs(a)},${ys(e)}`).join(' ')}
                fill="none"
                stroke="#fbbf24"
                strokeWidth={1.75}
              />
            ))}

            {skylinePath && <path d={skylinePath} fill="url(#llsn-terrain)" stroke="#94a3b8" strokeWidth={1} />}

            <line x1={M.l} x2={W - M.r} y1={ys(minEl)} y2={ys(minEl)} stroke="#fb7185" strokeDasharray="6 4" strokeWidth={1.25} />
            <text x={W - M.r - 4} y={ys(minEl) - 4} textAnchor="end" className="fill-rose-300 font-mono text-[9px]">
              antenna cutoff {minEl}°
            </text>

            {ephem && (
              <>
                <circle
                  cx={xs(ephem.earthAzDeg)}
                  cy={ys(ephem.earthElDeg)}
                  r={6}
                  className={ephem.earthAboveCutoff ? 'fill-sky-400 stroke-sky-100' : 'fill-rose-400/70 stroke-rose-100'}
                  strokeWidth={1.5}
                />
                <circle
                  cx={xs(ephem.sunAzDeg)}
                  cy={ys(ephem.sunElDeg)}
                  r={sunR}
                  className={ephem.sunVisibleFraction > 0.01 ? 'fill-amber-300 stroke-amber-50' : 'fill-stone-500 stroke-stone-300'}
                  strokeWidth={1.5}
                />
              </>
            )}

            {hoverAz != null && (
              <line x1={xsRaw(hoverAz)} x2={xsRaw(hoverAz)} y1={M.t} y2={H - M.b} stroke="#e2e8f0" strokeOpacity={0.35} />
            )}
          </g>

          {hoverAz != null && hoverEl != null && (
            <g transform={`translate(${Math.min(xsRaw(hoverAz) + 8, W - 130)},${M.t + 4})`}>
              <rect width={120} height={30} rx={6} className="fill-slate-950/90 stroke-slate-700" />
              <text x={8} y={13} className="fill-slate-200 font-mono text-[10px]">
                Az {hoverAz.toFixed(1)}°
              </text>
              <text x={8} y={25} className="fill-slate-400 font-mono text-[10px]">
                Skyline {hoverEl.toFixed(2)}°
              </text>
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

/* ═══════════════════════ Tab 2 — 365-day launch-slip calendar ═══════════════════════ */

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function CalendarTab() {
  const { calendar, status, error, epochUTC, setEpochUTC, fetchLaunchCalendar, showMore } = useMissionStore(
    useShallow((s) => ({
      calendar: s.calendar,
      status: s.calendarStatus,
      error: s.calendarError,
      epochUTC: s.epochUTC,
      setEpochUTC: s.setEpochUTC,
      fetchLaunchCalendar: s.fetchLaunchCalendar,
      showMore: s.showMore,
    })),
  );
  const info = useInfo();

  const months = useMemo(() => {
    const groups = new Map<string, LaunchCalendarDay[]>();
    for (const d of calendar?.days ?? []) {
      const k = d.date.slice(0, 7);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(d);
    }
    return [...groups.entries()];
  }, [calendar]);

  const counts = useMemo(() => {
    const c = { GO: 0, MARGINAL: 0, 'NO-GO': 0 };
    calendar?.days.forEach((d) => c[d.status]++);
    return c;
  }, [calendar]);

  const selectedDate = epochUTC.slice(0, 10);
  const timeOfDay = epochUTC.slice(11, 19);

  if (status === 'loading' && !calendar)
    return <div className="grid place-items-center py-6 text-xs text-slate-500">Scoring 365 launch days with vectorised Skyfield…</div>;
  if (status === 'error')
    return (
      <div className="grid place-items-center py-6 text-xs text-rose-300">
        <div className="text-center">
          {error}
          <button type="button" className="ml-2 underline" onClick={() => void fetchLaunchCalendar(true)}>
            Retry
          </button>
        </div>
      </div>
    );
  if (!calendar) return null;

  return (
    <div className="p-3">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
        {(['GO', 'MARGINAL', 'NO-GO'] as const).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${STATUS_STYLES[k].cell}`} />
            {k} <span className="font-mono text-slate-300">{counts[k]}</span>
          </span>
        ))}
        <span className="text-slate-500">· click a day to move the launch epoch (keeps {timeOfDay.slice(0, 5)} UTC)</span>
        <span className="flex-1" />
        {status === 'loading' && <span className="animate-pulse">refreshing…</span>}
        <InfoButton open={info.open} onToggle={info.toggle} controls={info.id} label="calendar method and source" />
      </div>
      {info.open && (
        <InfoPanel id={info.id} className="mb-2 mt-0">
          <p className="text-slate-400">
            Each day scores a {calendar.mission_duration_days}-day mission starting that day: sunlight (≥ 70% GO), longest darkness (≤ 48 h GO) and Earth contact above{' '}
            {calendar.min_earth_elevation_deg}° (≥ 70% GO). Cell brightness = composite score. Computed in {fmtNum(calendar.computed_in_ms, 0)} ms.
          </p>
          <DataSourceBadge source={calendar.source} />
        </InfoPanel>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-x-4 gap-y-3">
        {(showMore ? months : months.slice(0, 3)).map(([month, days]) => {
          const firstDow = new Date(`${days[0].date}T00:00:00Z`).getUTCDay();
          const label = new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
          return (
            <div key={month}>
              <p className="mb-1 text-[11px] font-medium text-slate-300">{label}</p>
              <div className="grid grid-cols-7 gap-[3px]">
                {WEEKDAYS.map((w, i) => (
                  <span key={i} className="text-center text-[8px] text-slate-600">
                    {w}
                  </span>
                ))}
                {Array.from({ length: firstDow }, (_, i) => (
                  <span key={`pad${i}`} />
                ))}
                {days.map((d) => {
                  const sel = d.date === selectedDate;
                  return (
                    <button
                      key={d.date}
                      type="button"
                      onClick={() => setEpochUTC(`${d.date}T${timeOfDay}Z`)}
                      title={`${d.date} · ${d.status}\nSunlit ${fmtNum(d.sunlit_pct, 1)}% · Earth ${fmtNum(d.earth_contact_pct, 0)}% · max dark ${fmtNum(d.longest_darkness_hours, 1)} h`}
                      aria-label={`${d.date} ${d.status}`}
                      className={`aspect-square rounded-[3px] ${STATUS_STYLES[d.status].cell} transition-transform hover:scale-125 ${
                        sel ? 'ring-2 ring-white ring-offset-1 ring-offset-slate-950' : ''
                      }`}
                      style={{ opacity: 0.35 + 0.65 * Math.max(0, Math.min(1, d.score)) }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════ Tab 3 — validation vs JPL Horizons & history ═══════════════════════ */

const QUANTITY_LABEL: Record<ValidationRow['quantity'], string> = {
  SUN_AZ: 'Sun azimuth',
  SUN_EL: 'Sun elevation',
  EARTH_AZ: 'Earth azimuth',
  EARTH_EL: 'Earth elevation',
};

function deltaClass(d: number | null, tol: number): string {
  if (d == null) return 'text-slate-600';
  const a = Math.abs(d);
  return a <= tol ? 'text-emerald-300' : a <= tol * 10 ? 'text-amber-300' : 'text-rose-300';
}

function computeDelta(row: ValidationRow, other: number | null, given: number | null): number | null {
  if (given != null) return given;
  if (other == null) return null;
  return row.quantity.endsWith('_AZ') ? angleDiffDeg(row.local_deg, other) : row.local_deg - other;
}

export function ValidationTab() {
  const { validation, status, error, fetchValidation } = useMissionStore(
    useShallow((s) => ({
      validation: s.validation,
      status: s.validationStatus,
      error: s.validationError,
      fetchValidation: s.fetchValidation,
    })),
  );
  const info = useInfo();

  const groups = useMemo(() => {
    const g = new Map<string, ValidationRow[]>();
    for (const r of validation?.rows ?? []) {
      if (!g.has(r.benchmark_id)) g.set(r.benchmark_id, []);
      g.get(r.benchmark_id)!.push(r);
    }
    return [...g.values()];
  }, [validation]);

  if (status === 'loading' && !validation)
    return <div className="grid place-items-center py-6 text-xs text-slate-500">Comparing Skyfield DE421 against JPL Horizons…</div>;
  if (status === 'error')
    return (
      <div className="grid place-items-center py-6 text-xs text-rose-300">
        <div>
          {error}
          <button type="button" className="ml-2 underline" onClick={() => void fetchValidation(true)}>
            Retry
          </button>
        </div>
      </div>
    );
  if (!validation) return null;
  const tol = validation.tolerance_deg;

  return (
    <div className="llsn-scroll max-h-[440px] overflow-auto p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <span
          className={`rounded-full px-2 py-0.5 font-mono text-[10px] ring-1 ${
            validation.horizons_reachable ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30' : 'bg-amber-500/10 text-amber-300 ring-amber-500/30'
          }`}
        >
          JPL Horizons {validation.horizons_reachable ? 'LIVE' : 'OFFLINE · disk cache'}
        </span>
        <span>
          max |Δ| vs Horizons:{' '}
          <span className={`font-mono ${deltaClass(validation.max_abs_delta_horizons_deg, tol)}`}>
            {fmtNum(validation.max_abs_delta_horizons_deg, 4)}°
          </span>{' '}
          (tolerance {tol}°)
        </span>
        <span className="flex-1" />
        <InfoButton open={info.open} onToggle={info.toggle} controls={info.id} label="validation method and sources" />
      </div>
      {info.open && validation.rows[0] && (
        <InfoPanel id={info.id} className="mb-2 mt-0">
          <p className="text-slate-400">
            Apparent (airless) Sun and Earth azimuth/elevation from our offline engine, compared with JPL Horizons queried for the same lunar surface point
            (coord@301) and with published mission references. Generated {fmtUtc(validation.generated_at_utc)}
            {validation.rows.some((r) => r.horizons_cached) ? ' · Horizons values served from the disk cache' : ''}.
          </p>
          <div className="flex flex-wrap gap-1">
            <DataSourceBadge source={validation.rows[0].local_source} />
            {validation.rows.find((r) => r.horizons_source)?.horizons_source && (
              <DataSourceBadge source={validation.rows.find((r) => r.horizons_source)!.horizons_source!} />
            )}
          </div>
        </InfoPanel>
      )}
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-[11px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
            <th className="sticky top-0 bg-slate-950/95 py-1.5 pr-2 font-medium">Benchmark / quantity</th>
            <th className="sticky top-0 bg-slate-950/95 px-2 text-right font-medium">Local (Skyfield DE421 + LOLA)</th>
            <th className="sticky top-0 bg-slate-950/95 px-2 text-right font-medium">JPL Horizons</th>
            <th className="sticky top-0 bg-slate-950/95 px-2 text-right font-medium">Δ Horizons</th>
            <th className="sticky top-0 bg-slate-950/95 px-2 text-right font-medium">Historical ref.</th>
            <th className="sticky top-0 bg-slate-950/95 pl-2 text-right font-medium">Δ ref.</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((rows) => (
            <ValidationGroup key={rows[0].benchmark_id} rows={rows} tol={tol} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ValidationGroup({ rows, tol }: { rows: ValidationRow[]; tol: number }) {
  const head = rows[0];
  return (
    <>
      <tr>
        <td colSpan={6} className="border-t border-slate-800 pb-1 pt-2.5">
          <span className="font-semibold text-slate-200">{head.benchmark_name}</span>
          <span className="ml-2 font-mono text-[10px] text-slate-500">
            {head.lat.toFixed(4)}°, {head.lon.toFixed(4)}° · {fmtUtc(head.epoch_utc)}
          </span>

        </td>
      </tr>
      {rows.map((r) => {
        const dH = computeDelta(r, r.horizons_deg, r.delta_horizons_deg);
        const dR = computeDelta(r, r.reference_deg, r.delta_reference_deg);
        return (
          <tr key={r.quantity} className="font-mono tabular-nums hover:bg-slate-900/60">
            <td className="py-1 pr-2 font-sans text-slate-400">{QUANTITY_LABEL[r.quantity]}</td>
            <td className="px-2 text-right text-slate-100">{fmtNum(r.local_deg, 4)}°</td>
            <td className="px-2 text-right text-slate-300">{r.horizons_deg == null ? '—' : `${fmtNum(r.horizons_deg, 4)}°`}</td>
            <td className={`px-2 text-right ${deltaClass(dH, tol)}`}>{dH == null ? '—' : `${dH >= 0 ? '+' : ''}${dH.toFixed(4)}°`}</td>
            <td className="px-2 text-right text-slate-300">{r.reference_deg == null ? '—' : `${fmtNum(r.reference_deg, 3)}°`}</td>
            <td className={`pl-2 text-right ${deltaClass(dR, Math.max(tol, 0.5))}`}>{dR == null ? '—' : `${dR >= 0 ? '+' : ''}${dR.toFixed(3)}°`}</td>
          </tr>
        );
      })}
    </>
  );
}
