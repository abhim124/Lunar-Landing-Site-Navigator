'use client';

import { useShallow } from 'zustand/react/shallow';
import { fmtHours, fmtNum, fmtSigned, fmtUtc } from '@/lib/format';
import { formatLatLon } from '@/lib/geo';
import { DATE_WINDOW_DAYS, SEARCH_RADIUS_KM, useMissionStore } from '@/store/useMissionStore';
import type { AlternativeDateOption, AlternativeSiteOption, NearestAlternativeResponse } from '@/types/mission';
import { DataSourceBadge, StatusPill } from './DataSourceBadge';
import { InfoButton, InfoPanel, useInfo } from './InfoButton';

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

function siteSentence(a: AlternativeSiteOption): string {
  return `Move ${fmtNum(a.distance_km, 1)} km ${compass(a.bearing_deg)}: ${fmtNum(a.sunlit_pct, 0)}% sunlit, Earth in view ${fmtNum(
    a.earth_contact_pct,
    0,
  )}% of the time.`;
}

function dateSentence(d: AlternativeDateOption): string {
  const days = Math.abs(d.offset_days);
  const when =
    d.offset_days === 0 ? 'Keep the date' : d.offset_days > 0 ? `wait ${fmtNum(days, 1)} days` : `land ${fmtNum(days, 1)} days earlier`;
  return `${d.offset_days === 0 ? when : `Or ${when}`} at this site: ${fmtNum(d.sunlit_pct, 0)}% sunlit, Earth in view ${fmtNum(
    d.earth_contact_pct,
    0,
  )}%.`;
}

/** "So where — or when — should we go instead?" — 2-stage coarse-to-fine recommender output. */
export function NearestAlternativeCard() {
  const { alternative, status, error, site, epochUTC, fetchNearestAlternative, applyAlternative, showMore } = useMissionStore(
    useShallow((s) => ({
      alternative: s.alternative,
      status: s.alternativeStatus,
      error: s.alternativeError,
      site: s.selectedSite,
      epochUTC: s.epochUTC,
      fetchNearestAlternative: s.fetchNearestAlternative,
      applyAlternative: s.applyAlternative,
      showMore: s.showMore,
    })),
  );
  const info = useInfo();
  if (!site || status === 'idle') return null;

  const a = alternative?.best_nearby_site ?? null;
  const d = alternative?.best_launch_date ?? null;

  return (
    <section className="rounded-xl border border-sky-500/30 bg-gradient-to-b from-sky-500/10 to-slate-900/40 p-3">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-sky-200">Where or when instead?</h3>
        {status === 'success' && <InfoButton open={info.open || showMore} onToggle={info.toggle} controls={info.id} label="search details" />}
      </header>

      {status === 'loading' && (
        <p className="mt-2 flex items-center gap-2 text-[11px] text-slate-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
          Searching pads within {SEARCH_RADIUS_KM} km and dates within ±{DATE_WINDOW_DAYS} days…
        </p>
      )}

      {status === 'error' && (
        <div className="mt-2 rounded-lg bg-rose-500/10 p-2 text-[11px] text-rose-200 ring-1 ring-rose-500/30">
          {error}
          <button type="button" onClick={() => void fetchNearestAlternative()} className="ml-2 underline">
            Retry
          </button>
        </div>
      )}

      {status === 'success' && alternative && (
        <div className="mt-2 space-y-2.5">
          {!a && !d && (
            <p className="text-[11px] text-slate-400">
              Nothing within {SEARCH_RADIUS_KM} km or ±{DATE_WINDOW_DAYS} days beats the current plan.
            </p>
          )}

          {a && (
            <div>
              <div className="flex items-start justify-between gap-2">
                <p className="text-[13px] leading-snug text-slate-100">{siteSentence(a)}</p>
                <StatusPill status={a.status} />
              </div>
              <button
                type="button"
                onClick={() => applyAlternative(a.lat, a.lon, epochUTC)}
                className="mt-1.5 w-full rounded-lg bg-sky-500/90 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400"
              >
                Relocate Lander →
              </button>
            </div>
          )}

          {d && (
            <div>
              <div className="flex items-start justify-between gap-2">
                <p className="text-[13px] leading-snug text-slate-100">{dateSentence(d)}</p>
                <StatusPill status={d.status} />
              </div>
              <button
                type="button"
                onClick={() => applyAlternative(site.lat, site.lon, d.epoch_utc)}
                className="mt-1.5 w-full rounded-lg bg-violet-400/90 py-1.5 text-xs font-semibold text-slate-950 hover:bg-violet-300"
              >
                Shift Launch Window →
              </button>
            </div>
          )}

          {(info.open || showMore) && <SearchDetails id={info.id} alt={alternative} onRerun={() => void fetchNearestAlternative()} />}
        </div>
      )}
    </section>
  );
}

function SearchDetails({ id, alt, onRerun }: { id: string; alt: NearestAlternativeResponse; onRerun: () => void }) {
  const b = alt.baseline;
  const a = alt.best_nearby_site;
  const d = alt.best_launch_date;
  return (
    <InfoPanel id={id}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-slate-400">
          {SEARCH_RADIUS_KM} km pad search · ±{DATE_WINDOW_DAYS} day launch window
        </p>
        <button type="button" onClick={onRerun} className="rounded-md px-2 py-0.5 text-[10px] text-slate-400 ring-1 ring-slate-700 hover:text-slate-200">
          Re-run
        </button>
      </div>
      {alt.trigger_reasons.length > 0 && (
        <p className="text-slate-400">
          Triggered by: <span className="text-slate-300">{alt.trigger_reasons.join(' · ')}</span>
        </p>
      )}

      {a && (
        <div className="space-y-1">
          <p className="font-semibold text-slate-200">Option A · best nearby pad</p>
          <p className="font-mono text-slate-300">
            {formatLatLon(a.lat, a.lon, 4)} · {fmtNum(a.distance_km, 2)} km at {fmtNum(a.bearing_deg, 0)}°
          </p>
          <dl className="grid grid-cols-3 gap-1.5">
            <Delta label="Sunlit" value={`${fmtNum(a.sunlit_pct, 1)}%`} delta={a.sunlit_pct - b.sunlit_pct} unit="pt" good="up" />
            <Delta label="Slope" value={`${fmtNum(a.slope_deg, 1)}°`} delta={a.slope_deg - b.slope_deg} unit="°" good="down" />
            <Delta label="Earth link" value={`${fmtNum(a.earth_contact_pct, 0)}%`} delta={a.earth_contact_pct - b.earth_contact_pct} unit="pt" good="up" />
          </dl>
          {a.summary && <p className="text-slate-400">{a.summary}</p>}
          <DataSourceBadge source={a.source} />
        </div>
      )}

      {d && (
        <div className="space-y-1">
          <p className="font-semibold text-slate-200">Option B · best launch date</p>
          <p className="font-mono text-slate-300">
            {fmtUtc(d.epoch_utc)} · {fmtSigned(d.offset_days, 1)} d
          </p>
          <dl className="grid grid-cols-3 gap-1.5">
            <Delta label="Sunlit" value={`${fmtNum(d.sunlit_pct, 1)}%`} delta={d.sunlit_pct - b.sunlit_pct} unit="pt" good="up" />
            <Delta label="Max dark" value={fmtHours(d.longest_darkness_hours)} delta={d.longest_darkness_hours - b.longest_darkness_hours} unit="h" good="down" />
            <Delta label="Earth link" value={`${fmtNum(d.earth_contact_pct, 0)}%`} delta={d.earth_contact_pct - b.earth_contact_pct} unit="pt" good="up" />
          </dl>
          {d.summary && <p className="text-slate-400">{d.summary}</p>}
          <DataSourceBadge source={d.source} />
        </div>
      )}

      <p className="font-mono text-[10px] leading-relaxed text-slate-500">
        Stage 1 {alt.stats.stage1_pixels_scanned.toLocaleString()} px → {alt.stats.stage1_candidates_kept} candidates ({alt.stats.stage1_bbox_km} km box,{' '}
        {fmtNum(alt.stats.stage1_ms, 0)} ms) · Stage 2 {alt.stats.stage2_epochs_evaluated.toLocaleString()} epochs ({fmtNum(alt.stats.stage2_ms, 0)} ms)
      </p>
    </InfoPanel>
  );
}

function Delta({
  label,
  value,
  delta,
  unit,
  good,
}: {
  label: string;
  value: string;
  delta: number;
  unit: string;
  good: 'up' | 'down';
}) {
  const better = good === 'up' ? delta > 0.05 : delta < -0.05;
  const worse = good === 'up' ? delta < -0.05 : delta > 0.05;
  return (
    <div className="rounded-md bg-slate-900/70 px-1.5 py-1">
      <dt className="text-[10px] text-slate-500">{label}</dt>
      <dd className="font-mono text-slate-100">{value}</dd>
      <dd className={`font-mono text-[10px] ${better ? 'text-emerald-300' : worse ? 'text-rose-300' : 'text-slate-500'}`}>
        {fmtSigned(delta, 1)} {unit}
      </dd>
    </div>
  );
}
