'use client';

import type { ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { API_BASE } from '@/lib/api';
import { PANEL, STATUS_STYLES, fmtHours, fmtNum, fmtUtc } from '@/lib/format';
import { angleDiffDeg, formatLatLon } from '@/lib/geo';
import { CURATED_BY_ID } from '@/lib/siteRegistry';
import { useMissionStore } from '@/store/useMissionStore';
import type { MetricWithSource, SiteEvaluationResponse, SpaceWeatherStatus } from '@/types/mission';
import { DataSourceBadge, StatusPill } from './DataSourceBadge';
import { InfoButton, InfoPanel, useInfo } from './InfoButton';
import { NearestAlternativeCard } from './NearestAlternativeCard';

/** Plain-English Learn Mode notes tying each metric to real lunar engineering. */
const LEARN = {
  sunlit:
    'Solar-powered landers need near-continuous sunlight. At the pole the Sun skims the horizon (never more than ~1.6° up), so a ridge a few hundred metres higher can mean weeks more power — which is why Artemis candidates sit on rims and massifs.',
  darkness:
    'Batteries and heaters must bridge the longest night. IM-2 Athena came to rest on its side near Mons Mouton under a low Sun, its panels could not generate enough power, and surface operations ended early.',
  sunset: 'How long until the solar disk drops fully below the local terrain skyline — your operations clock for the first power-down.',
  earthset: 'How long until Earth drops below the terrain or your antenna cutoff. Crater rims can hide Earth for days near the pole.',
  earth:
    'Direct-to-Earth radio needs Earth above both the terrain skyline and the antenna mask. Libration makes Earth wobble only ±~7° in the polar sky, so a nearby rim can block it for most of a month.',
  temperature:
    'Diviner sees sunlit polar ridges swing between roughly 150 and 250 K, while permanently shadowed craters stay below 50 K — some of the coldest surfaces measured in the Solar System.',
  slope:
    'Landers tip over on slopes. Typical requirements cap the pad at ~8–10°; above 15° is a hard fail here. IM-1 and IM-2 both came to rest on their sides after touchdown.',
  roughness:
    'RMS height variation inside the local window. High roughness at metre scale means boulders, crater walls or blocky ejecta under the landing legs.',
  rock: 'Diviner infers the fraction of the surface covered by ≥1 m boulders from how fast rocks stay warm after sunset. Even a few percent is a footpad hazard.',
  ice: 'Distance to the nearest permanently shadowed pixel in the PGDA LPSR map. PSRs are cold traps where water ice can survive (LEND and Mini-RF see hints of it), so a short traverse makes ISRU cheaper — but a PSR is not proof of ice.',
  weather:
    'Solar energetic particles can arrive within tens of minutes of a flare. During elevated radiation, EVAs are postponed and crews shelter inside the lander.',
} as const;

type LearnKey = keyof typeof LEARN;

export function VerdictCard() {
  const { site, evaluation, status, error, learnMode, minEl, evaluateSite, clearSelection, fetchNearestAlternative, altStatus } =
    useMissionStore(
      useShallow((s) => ({
        site: s.selectedSite,
        evaluation: s.evaluation,
        status: s.evaluationStatus,
        error: s.evaluationError,
        learnMode: s.learnMode,
        minEl: s.minEarthElevationDeg,
        evaluateSite: s.evaluateSite,
        clearSelection: s.clearSelection,
        fetchNearestAlternative: s.fetchNearestAlternative,
        altStatus: s.alternativeStatus,
      })),
    );
  const headerInfo = useInfo();
  const siteInfo = useInfo();
  const reasonsInfo = useInfo();
  if (!site) return null;

  const curated = site.regionId ? CURATED_BY_ID[site.regionId] : undefined;
  const ev =
    evaluation &&
    Math.abs(evaluation.site.lat - site.lat) < 1e-4 &&
    Math.abs(angleDiffDeg(evaluation.site.lon, site.lon)) < 1e-4
      ? evaluation
      : null;

  return (
    <aside
      className={`${PANEL} fixed right-3 z-30 flex w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/60 bottom-[calc(var(--drawer-h)_+_24px)] lg:bottom-3`}
      style={{ top: 'calc(var(--pill-h, 48px) + 24px)' }}
      aria-label="Mission verdict"
    >
      <header className="border-b border-slate-800/80 px-4 pb-3 pt-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Mission Verdict</p>
            <h2 className="truncate text-base font-semibold text-slate-50" title={site.name}>
              {site.name}
            </h2>
            <p className="font-mono text-xs text-slate-400">
              {formatLatLon(site.lat, site.lon, 5)}
              {curated?.isApproxCoord && <span className="ml-1.5 text-amber-300">≈ region centre</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={clearSelection}
            aria-label="Close verdict"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-slate-400 ring-1 ring-slate-700 hover:bg-slate-800 hover:text-slate-100"
          >
            ×
          </button>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {ev ? (
            <span data-highlight-target="verdict" className="inline-flex rounded-full">
              <StatusPill status={ev.overall_status} size="lg" />
            </span>
          ) : <span className="h-7 w-24 animate-pulse rounded-full bg-slate-800" />}
          {status === 'loading' && <span className="text-[11px] text-slate-400">computing…</span>}
          {ev && <InfoButton open={headerInfo.open} onToggle={headerInfo.toggle} controls={headerInfo.id} label="evaluation details" />}
        </div>
        {ev && headerInfo.open && (
          <InfoPanel id={headerInfo.id}>
            <p className="font-mono text-[10px] text-slate-400">
              {fmtUtc(ev.epoch_utc)} · {ev.mission_duration_days} d mission · antenna ≥ {ev.min_earth_elevation_deg}° · computed in{' '}
              {fmtNum(ev.computed_in_ms, 0)} ms
            </p>
            {ev.site.artemis_region && <p className="text-violet-300">Inside Artemis candidate region: {ev.site.artemis_region}</p>}
            {curated?.isApproxCoord && <p className="text-amber-300">Coordinates are an approximate region centre, not a surveyed pad.</p>}
            {curated && <p className="text-slate-400">Coordinate source: {curated.coordSource}</p>}
            <DataSourceBadge source={ev.site.elevation_m.source} />
          </InfoPanel>
        )}
      </header>

      <div className="llsn-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {status === 'error' && (
          <div className="rounded-xl bg-rose-500/10 p-3 text-xs text-rose-200 ring-1 ring-rose-500/30">
            <p className="font-semibold">Evaluation failed</p>
            <p className="mt-1 text-rose-200/80">{error}</p>
            <p className="mt-1 font-mono text-[10px] text-rose-200/60">backend: {API_BASE}</p>
            <button type="button" onClick={() => void evaluateSite()} className="mt-2 rounded-md bg-rose-500/20 px-2 py-1 font-semibold ring-1 ring-rose-400/40">
              Retry
            </button>
          </div>
        )}

        {!ev && status === 'loading' && <SkeletonGrid />}

        {ev && (
          <>
            {ev.verdict_reasons.length > 0 && (
              <div>
                <ul className="space-y-1">
                  {(reasonsInfo.open ? ev.verdict_reasons : ev.verdict_reasons.slice(0, 2)).map((r) => (
                    <li key={r} className={`flex gap-2 text-xs ${STATUS_STYLES[ev.overall_status].text}`}>
                      <span aria-hidden>▸</span>
                      <span className="text-slate-300">{r}</span>
                    </li>
                  ))}
                </ul>
                {ev.verdict_reasons.length > 2 && (
                  <p className="mt-1 flex items-center gap-1.5 pl-4 text-[10px] text-slate-500">
                    <InfoButton open={reasonsInfo.open} onToggle={reasonsInfo.toggle} label="all verdict reasons" />
                    {reasonsInfo.open ? 'Show fewer' : `${ev.verdict_reasons.length - 2} more reason${ev.verdict_reasons.length - 2 > 1 ? 's' : ''}`}
                  </p>
                )}
              </div>
            )}

            {(ev.overall_status !== 'GO' || altStatus !== 'idle') && <NearestAlternativeCard />}

            <Section title="Illumination & Comms">
              <MetricTile target="power" label="Sunlit" metric={ev.illumination.sunlit_pct} display={fmtNum(ev.illumination.sunlit_pct.value, 1)} learn={learnMode ? 'sunlit' : null} />
              <MetricTile
                target="power"
                label="Longest darkness"
                metric={ev.illumination.longest_darkness_hours}
                display={fmtNum(ev.illumination.longest_darkness_hours.value, 1)}
                learn={learnMode ? 'darkness' : null}
              />
              <MetricTile
                target="power"
                label="Time to sunset"
                metric={ev.illumination.time_to_sunset_hours}
                display={ev.illumination.time_to_sunset_hours.value == null ? 'None' : fmtHours(ev.illumination.time_to_sunset_hours.value)}
                hideUnit
                hint={ev.illumination.time_to_sunset_hours.value == null ? 'Sun stays up all mission' : undefined}
                learn={learnMode ? 'sunset' : null}
              />
              <MetricTile
                target="comms"
                label="Time to Earthset"
                metric={ev.illumination.time_to_earthset_hours}
                display={ev.illumination.time_to_earthset_hours.value == null ? 'None' : fmtHours(ev.illumination.time_to_earthset_hours.value)}
                hideUnit
                hint={ev.illumination.time_to_earthset_hours.value == null ? 'Earth stays in view' : undefined}
                learn={learnMode ? 'earthset' : null}
              />
              <MetricTile
                target="comms"
                wide
                label={`Earth contact ≥ ${minEl}°`}
                metric={ev.illumination.earth_contact_pct}
                display={fmtNum(ev.illumination.earth_contact_pct.value, 1)}
                bar={{ value: ev.illumination.earth_contact_pct.value, max: 100 }}
                learn={learnMode ? 'earth' : null}
              />
            </Section>

            <section className="rounded-xl border border-slate-800/80 bg-slate-900/50 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Site conditions</h3>
                <InfoButton open={siteInfo.open} onToggle={siteInfo.toggle} controls={siteInfo.id} label="terrain, temperature and space-weather details" />
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-2 font-mono text-[11px] tabular-nums">
                <SummaryStat label="Slope" status={ev.terrain.slope_deg.status} value={`${fmtNum(ev.terrain.slope_deg.value, 1)}°`} />
                <SummaryStat
                  label="Surface temp"
                  status={ev.thermal.surface_temperature_k.status}
                  value={`${fmtNum(ev.thermal.surface_temperature_k.value.min_k, 0)}–${fmtNum(ev.thermal.surface_temperature_k.value.max_k, 0)} K`}
                />
                <SummaryStat
                  label="Space weather"
                  status={ev.space_weather.status === 'UNKNOWN' ? 'MARGINAL' : ev.space_weather.eva_status}
                  value={ev.space_weather.status === 'ELEVATED RADIATION' ? 'ELEVATED' : ev.space_weather.status}
                />
              </div>
              {siteInfo.open && (
                <div id={siteInfo.id} className="mt-3 space-y-3">
                <Section title="Terrain, Thermal & ISRU">
                  <ThermalTile ev={ev} learn={learnMode} />
                  <MetricTile
                    label="Tip-over slope"
                    metric={ev.terrain.slope_deg}
                    display={fmtNum(ev.terrain.slope_deg.value, 1)}
                    hint="warn > 10° · fail > 15°"
                    bar={{ value: ev.terrain.slope_deg.value, max: 20, marks: [10, 15] }}
                    learn={learnMode ? 'slope' : null}
                  />
                  <MetricTile label="Roughness (RMS)" metric={ev.terrain.roughness_m} display={fmtNum(ev.terrain.roughness_m.value, 2)} learn={learnMode ? 'roughness' : null} />
                  <MetricTile
                    label="Boulder hazard"
                    metric={ev.hazards.rock_abundance_pct}
                    display={ev.hazards.rock_abundance_pct.value == null ? 'No data' : fmtNum(ev.hazards.rock_abundance_pct.value, 2)}
                    hideUnit={ev.hazards.rock_abundance_pct.value == null}
                    hint={ev.hazards.rock_abundance_pct.value == null ? 'Diviner RA covers ±60° only' : undefined}
                    learn={learnMode ? 'rock' : null}
                  />
                  <MetricTile
                    label="Nearest PSR cold trap"
                    metric={ev.isru.nearest_ice_psr_km}
                    display={ev.isru.nearest_ice_psr_km.value == null ? 'No data' : fmtNum(ev.isru.nearest_ice_psr_km.value, 2)}
                    hideUnit={ev.isru.nearest_ice_psr_km.value == null}
                    hint={ev.isru.nearest_ice_psr_km.value == null ? 'Outside the 65°S PSR map' : undefined}
                    learn={learnMode ? 'ice' : null}
                  />
                  <MetricTile wide label="Pad elevation (1737.4 km datum)" metric={ev.site.elevation_m} display={fmtNum(ev.site.elevation_m.value, 0)} />
                </Section>

                <SpaceWeatherBadge sw={ev.space_weather} learn={learnMode} />
                </div>
              )}
            </section>

            {ev.overall_status === 'GO' && altStatus === 'idle' && (
              <button
                type="button"
                onClick={() => void fetchNearestAlternative()}
                className="w-full rounded-xl border border-dashed border-slate-700 py-2 text-xs text-slate-300 hover:border-sky-500/60 hover:text-sky-200"
              >
                Find better pad / date
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">{title}</h3>
      <div className="grid grid-cols-2 gap-2">{children}</div>
    </section>
  );
}

function MetricTile({
  label,
  metric,
  display,
  learn,
  hint,
  wide = false,
  hideUnit = false,
  bar,
  target,
}: {
  label: string;
  metric: MetricWithSource<number | null>;
  display: string;
  learn?: LearnKey | null;
  hint?: string;
  wide?: boolean;
  hideUnit?: boolean;
  bar?: { value: number; max: number; marks?: number[] };
  /** Assistant highlight group (data-highlight-target). */
  target?: 'power' | 'comms';
}) {
  const st = STATUS_STYLES[metric.status];
  const info = useInfo();
  return (
    <div data-highlight-target={target} className={`rounded-xl border border-slate-800/80 bg-slate-900/50 p-2.5 ${wide ? 'col-span-2' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</span>
        <span className="flex items-center gap-1.5">
          <InfoButton open={info.open} onToggle={info.toggle} controls={info.id} label={`${label} data source`} />
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.dot}`} title={metric.status} />
        </span>
      </div>
      <div className="mt-0.5 font-mono text-lg tabular-nums text-slate-50">
        {display}
        {!hideUnit && <span className="ml-1 text-xs text-slate-400">{metric.unit}</span>}
      </div>
      {hint && <p className="text-[10px] text-slate-500">{hint}</p>}
      {bar && (
        <div className="relative mt-1.5 h-1 rounded-full bg-slate-800">
          <div className={`absolute inset-y-0 left-0 rounded-full ${st.cell}`} style={{ width: `${Math.min(100, (bar.value / bar.max) * 100)}%` }} />
          {bar.marks?.map((m) => (
            <span key={m} className="absolute -top-0.5 h-2 w-px bg-slate-400" style={{ left: `${(m / bar.max) * 100}%` }} />
          ))}
        </div>
      )}
      {info.open && (
        <InfoPanel id={info.id}>
          <DataSourceBadge source={metric.source} />
          <p className="text-[10px] text-slate-500">Status: {metric.status}</p>
        </InfoPanel>
      )}
      {learn && <LearnNote>{LEARN[learn]}</LearnNote>}
    </div>
  );
}

function SummaryStat({ label, value, status }: { label: string; value: string; status: MetricWithSource<unknown>['status'] }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1 font-sans text-[10px] text-slate-500">
        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_STYLES[status].dot}`} />
        {label}
      </p>
      <p className="truncate text-slate-100">{value}</p>
    </div>
  );
}

function ThermalTile({ ev, learn }: { ev: SiteEvaluationResponse; learn: boolean }) {
  const m = ev.thermal.surface_temperature_k;
  const { min_k, mean_k, max_k } = m.value;
  const lo = 20;
  const hi = 400;
  const pos = (k: number) => `${((Math.min(hi, Math.max(lo, k)) - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="col-span-2 rounded-xl border border-slate-800/80 bg-slate-900/50 p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Surface Temperature (K)</span>
        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_STYLES[m.status].dot}`} title={m.status} />
      </div>
      <div className="mt-0.5 grid grid-cols-3 font-mono tabular-nums">
        <span className="text-sky-300">
          <span className="block text-[10px] text-slate-500">min</span>
          {fmtNum(min_k, 0)}
        </span>
        <span className="text-slate-50">
          <span className="block text-[10px] text-slate-500">mean</span>
          {fmtNum(mean_k, 0)}
        </span>
        <span className="text-orange-300">
          <span className="block text-[10px] text-slate-500">max</span>
          {fmtNum(max_k, 0)}
        </span>
      </div>
      <div className="relative mt-2 h-1.5 rounded-full bg-gradient-to-r from-indigo-600 via-slate-500 to-orange-500">
        {min_k != null && max_k != null && (
          <span className="absolute -top-0.5 h-2.5 rounded-sm bg-white/25 ring-1 ring-white/60" style={{ left: pos(min_k), width: `calc(${pos(max_k)} - ${pos(min_k)})` }} />
        )}
        {mean_k != null && <span className="absolute -top-1 h-3.5 w-0.5 bg-white" style={{ left: pos(mean_k) }} />}
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[9px] text-slate-600">
        <span>{lo} K</span>
        <span>{hi} K</span>
      </div>
      <DataSourceBadge source={m.source} className="mt-1.5" />
      {learn && <LearnNote>{LEARN.temperature}</LearnNote>}
    </div>
  );
}

function SpaceWeatherBadge({ sw, learn }: { sw: SpaceWeatherStatus; learn: boolean }) {
  const elevated = sw.status === 'ELEVATED RADIATION';
  const unknown = sw.status === 'UNKNOWN';
  return (
    <section
      className={`rounded-xl p-3 ring-1 ${
        elevated ? 'bg-rose-500/10 ring-rose-500/40' : unknown ? 'bg-slate-800/40 ring-slate-700' : 'bg-emerald-500/10 ring-emerald-500/30'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Space Weather · EVA</p>
          <p className={`font-mono text-sm font-semibold ${elevated ? 'text-rose-300' : unknown ? 'text-slate-300' : 'text-emerald-300'}`}>
            {sw.status}
          </p>
        </div>
        <StatusPill status={sw.eva_status} />
      </div>
      <p className="mt-1 text-[11px] text-slate-300">{sw.summary}</p>
      <p className="mt-1 font-mono text-[10px] text-slate-500">
        SEP {sw.sep_event_count} · FLR {sw.flare_count}
        {sw.strongest_flare_class ? ` (max ${sw.strongest_flare_class})` : ''} · {sw.window_start.slice(0, 10)} → {sw.window_end.slice(0, 10)}
        {sw.served_from_cache && sw.cached_at_utc ? ` · cached ${fmtUtc(sw.cached_at_utc)}` : ''}
      </p>
      <DataSourceBadge source={sw.source} className="mt-1.5" />
      {learn && <LearnNote>{LEARN.weather}</LearnNote>}
    </section>
  );
}

function LearnNote({ children }: { children: ReactNode }) {
  return <p className="mt-2 border-l-2 border-sky-500/50 pl-2 text-[11px] leading-snug text-slate-300/90">{children}</p>;
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-2" aria-busy="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className={`h-20 animate-pulse rounded-xl bg-slate-800/50 ${i === 4 ? 'col-span-2' : ''}`} />
      ))}
    </div>
  );
}
