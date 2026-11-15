'use client';

import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api, errorMessage, isAbortError } from '@/lib/api';
import { compassWord } from '@/lib/contingency';
import { fmtNum, STATUS_STYLES } from '@/lib/format';
import { useMissionStore } from '@/store/useMissionStore';
import type { NearbyWindowsResponse, NearbyWindowsSite, StatusDay } from '@/types/nearbyWindows';
import { InfoButton, InfoPanel, useInfo } from './InfoButton';
import { LearnBlock } from './LearnBlock';

const RADIUS_KM = 10;

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** 365 days as a 7-row week strip: whole-year scenario comparison at a glance. */
function YearStrip({ days, selected }: { days: StatusDay[]; selected: string }) {
  const pad = days.length ? new Date(`${days[0].date}T00:00:00Z`).getUTCDay() : 0;
  return (
    <div className="grid w-full max-w-[300px] grid-flow-col grid-rows-7 gap-[1.5px]" aria-hidden>
      {Array.from({ length: pad }, (_, i) => (
        <span key={`p${i}`} />
      ))}
      {days.map((d) => (
        <span
          key={d.date}
          className={`aspect-square w-full min-w-[3px] rounded-[1px] ${STATUS_STYLES[d.status].cell} ${
            d.date === selected ? 'outline outline-1 outline-white' : ''
          }`}
          style={{ opacity: d.status === 'NO-GO' ? 0.45 : 1 }}
        />
      ))}
    </div>
  );
}

function SiteRow({
  site,
  title,
  selected,
  current,
  onUseSite,
  onUseWindow,
}: {
  site: NearbyWindowsSite;
  title: string;
  selected: string;
  current?: boolean;
  onUseSite?: () => void;
  onUseWindow?: () => void;
}) {
  const s = site.summary;
  const planned = site.days.find((d) => d.date === selected)?.status ?? null;
  return (
    <div className={`rounded-xl p-2.5 ring-1 ${current ? 'bg-slate-900/40 ring-slate-700/70' : 'bg-sky-500/5 ring-sky-500/30'}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-semibold text-slate-100">{title}</p>
        {planned && <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[planned].pill}`}>{planned}</span>}
      </div>
      <dl className="mt-1.5 grid grid-cols-3 gap-1 text-[10px]">
        <div>
          <dt className="text-slate-500">GO days</dt>
          <dd className="font-mono text-sm text-slate-100">{s.go_days}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Best run</dt>
          <dd className="font-mono text-sm text-slate-100">{s.longest_go_run_days} d</dd>
        </div>
        <div>
          <dt className="text-slate-500">Next GO</dt>
          <dd className="font-mono text-sm text-slate-100">{s.next_go_date ? shortDate(s.next_go_date) : '—'}</dd>
        </div>
      </dl>
      <div className="mt-2">
        <YearStrip days={site.days} selected={selected} />
      </div>
      {site.reasons && site.reasons.length > 0 && <p className="mt-1.5 text-[11px] leading-snug text-sky-100/90">{site.reasons.join(' · ')}</p>}
      {(onUseSite || onUseWindow) && (
        <div className="mt-2 flex gap-1.5">
          {onUseSite && (
            <button type="button" onClick={onUseSite} className="flex-1 rounded-lg bg-sky-500/90 py-1.5 text-[11px] font-semibold text-slate-950 hover:bg-sky-400">
              Use this site
            </button>
          )}
          {onUseWindow && s.longest_go_run_start && (
            <button
              type="button"
              onClick={onUseWindow}
              className="flex-1 rounded-lg bg-violet-400/90 py-1.5 text-[11px] font-semibold text-slate-950 hover:bg-violet-300"
            >
              Best window · {shortDate(s.longest_go_run_start)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Beside the launch calendar: nearby pads whose whole-year calendar beats the selected pad's. */
export function NearbyWindowsPanel() {
  const { site, epochUTC, days, ant, calendarStart } = useMissionStore(
    useShallow((s) => ({
      site: s.selectedSite,
      epochUTC: s.epochUTC,
      days: s.missionDurationDays,
      ant: s.minEarthElevationDeg,
      calendarStart: s.calendar?.start_date ?? null,
    })),
  );
  const [data, setData] = useState<NearbyWindowsResponse | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const info = useInfo();

  const selected = epochUTC.slice(0, 10);
  const timeOfDay = epochUTC.slice(11, 19);

  // Refetch when the pad, the calendar window or the mission settings change, not on every day click:
  // the planned-date status is read from the returned day arrays.
  const lat = site?.lat;
  const lon = site?.lon;
  useEffect(() => {
    if (lat === undefined || lon === undefined || !calendarStart) return;
    const ctrl = new AbortController();
    setStatus('loading');
    setError(null);
    api
      .nearbyWindows(
        {
          lat,
          lon,
          start_date: calendarStart,
          planned_date: useMissionStore.getState().epochUTC.slice(0, 10),
          mission_duration_days: days,
          min_earth_elevation_deg: ant,
          radius_km: RADIUS_KM,
          k: 2,
        },
        ctrl.signal,
      )
      .then((res) => {
        setData(res);
        setStatus('success');
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        setError(errorMessage(err));
        setStatus('error');
      });
    return () => ctrl.abort();
  }, [lat, lon, calendarStart, days, ant, nonce]);

  const baseName = useMemo(() => site?.name.replace(/^(Nearby|Contingency|Alt\.) pad · /, '') ?? '', [site?.name]);

  const pickSite = (a: NearbyWindowsSite, epoch = epochUTC) =>
    useMissionStore.getState().selectSite({ lat: a.lat, lon: a.lon, name: `Nearby pad · ${baseName}`, regionId: null }, { epochUTC: epoch, fly: true });

  if (!site) return null;

  return (
    <section className="flex flex-col gap-2 p-3" aria-label="Nearby site comparison">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Compare nearby sites</h3>
        {status === 'loading' && <span className="animate-pulse text-[10px] text-slate-500">scoring…</span>}
        <InfoButton open={info.open} onToggle={info.toggle} controls={info.id} label="comparison method" />
      </div>
      <LearnBlock id="compare" className="mt-0" />
      {info.open && data && (
        <InfoPanel id={info.id} className="mt-0">
          <p className="text-slate-400">
            {data.candidates_evaluated} pads within {data.search_radius_km} km (slope ≤ 10°, outside permanent shadow) were picked from PGDA Sun/Earth
            visibility and LOLA slope, then each got the same 365-day DE421 + LOLA horizon calendar as the main calendar. Shown: pads that beat the
            current one on the planned date, GO days, longest GO run, or time to the next GO window. Computed in {fmtNum(data.computed_in_ms, 0)} ms.
          </p>
        </InfoPanel>
      )}

      {status === 'error' && (
        <p className="rounded-lg bg-rose-500/10 p-2 text-[11px] text-rose-200 ring-1 ring-rose-500/30">
          {error}
          <button type="button" onClick={() => setNonce((n) => n + 1)} className="ml-2 underline">
            Retry
          </button>
        </p>
      )}
      {!data && status === 'loading' && <p className="py-4 text-center text-[11px] text-slate-500">Scoring nearby pads over 365 days…</p>}

      {data && (
        <div className={`grid gap-2 md:grid-cols-3 xl:grid-cols-1 ${status === 'loading' ? 'opacity-60' : ''}`}>
          <SiteRow site={data.baseline} title={`Current · ${baseName}`} selected={selected} current />
          {data.alternatives.length === 0 ? (
            <p className="rounded-lg bg-slate-900/50 p-2 text-[11px] text-slate-400 ring-1 ring-slate-800">
              No pad within {data.search_radius_km} km has a better year-long launch calendar. This site is already the best nearby option.
            </p>
          ) : (
            data.alternatives.map((a) => (
              <SiteRow
                key={`${a.lat},${a.lon}`}
                site={a}
                title={`${fmtNum(a.distance_km ?? 0, 1)} km ${compassWord(a.bearing_deg ?? 0)} · ${fmtNum(a.slope_deg, 1)}° slope`}
                selected={selected}
                onUseSite={() => pickSite(a)}
                onUseWindow={() => a.summary.longest_go_run_start && pickSite(a, `${a.summary.longest_go_run_start}T${timeOfDay}Z`)}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}
