'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { PANEL } from '@/lib/format';
import { normalizeLon } from '@/lib/geo';
import { CURATED_SITES } from '@/lib/siteRegistry';
import { OVERLAY_LAYERS } from '@/lib/wmtsTileLoader';
import { useMissionStore, type SceneStatus } from '@/store/useMissionStore';
import { AskAiButton } from './MissionChat';
import type { LayerId } from '@/types/mission';

const LAYER_OPTIONS: { id: LayerId; label: string }[] = [
  { id: 'BASE_CGI', label: 'CGI Moon Kit (visual)' },
  ...Object.values(OVERLAY_LAYERS).map((l) => ({ id: l.id, label: l.label })),
];

const fieldCls =
  'h-8 rounded-lg bg-slate-900/80 px-2 text-xs text-slate-100 ring-1 ring-slate-700/80 outline-none focus:ring-sky-500/70 [color-scheme:dark]';
const labelCls = 'text-[10px] font-medium uppercase tracking-wider text-slate-500';

export function TopCommandPill() {
  const s = useMissionStore(
    useShallow((st) => ({
      selectedSite: st.selectedSite,
      epochUTC: st.epochUTC,
      days: st.missionDurationDays,
      ant: st.minEarthElevationDeg,
      layer: st.activeLayer,
      learn: st.learnMode,
      scene: st.sceneStatus,
      selectCuratedSite: st.selectCuratedSite,
      selectSite: st.selectSite,
      setEpochUTC: st.setEpochUTC,
      setDays: st.setMissionDurationDays,
      setAnt: st.setMinEarthElevationDeg,
      setLayer: st.setActiveLayer,
      setLearn: st.setLearnMode,
    })),
  );

  const [latStr, setLatStr] = useState('');
  const [lonStr, setLonStr] = useState('');
  const [coordError, setCoordError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [antLocal, setAntLocal] = useState(s.ant);
  const pillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (s.selectedSite) {
      setLatStr(s.selectedSite.lat.toFixed(5));
      setLonStr(s.selectedSite.lon.toFixed(5));
    }
  }, [s.selectedSite]);
  useEffect(() => setAntLocal(s.ant), [s.ant]);

  // Publish the pill height so the Verdict Card can sit just below it whatever the wrap.
  useEffect(() => {
    const el = pillRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      document.documentElement.style.setProperty('--pill-h', `${el.getBoundingClientRect().height}px`),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const submitCoords = (e: FormEvent) => {
    e.preventDefault();
    const lat = Number(latStr);
    const lon = Number(lonStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -360 || lon > 360) {
      setCoordError(true);
      return;
    }
    setCoordError(false);
    s.selectSite({ lat, lon: normalizeLon(lon), name: 'Custom site', regionId: null });
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setToast('Mission link copied to clipboard');
    } catch {
      setToast('Clipboard blocked — copy the URL from the address bar');
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-40 flex flex-col items-center px-3">
      <div
        ref={pillRef}
        className={`${PANEL} pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1.5 rounded-2xl px-2.5 py-1.5 shadow-2xl shadow-black/50`}
      >
        <div className="flex items-center gap-2 pr-1">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-slate-200 to-slate-500 text-[11px] font-black text-slate-950 shadow-inner">
            LN
          </span>
          <span className="hidden text-xs font-semibold tracking-wide text-slate-200 sm:inline">Lunar Landing Site Navigator</span>
        </div>

        <select
          aria-label="Curated site"
          className={`${fieldCls} max-w-[13rem]`}
          value={s.selectedSite?.regionId ?? ''}
          onChange={(e) => e.target.value && s.selectCuratedSite(e.target.value)}
        >
          <option value="">{s.selectedSite ? s.selectedSite.name : 'Select a site…'}</option>
          <optgroup label="Validation benchmarks">
            {CURATED_SITES.filter((c) => c.category === 'BENCHMARK').map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Artemis candidate regions (≈ coords)">
            {CURATED_SITES.filter((c) => c.category === 'ARTEMIS_III').map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        </select>

        <div className={`${expanded ? 'contents' : 'hidden'} xl:contents`}>
          <form onSubmit={submitCoords} className="flex items-center gap-1">
            <input
              aria-label="Latitude"
              inputMode="decimal"
              placeholder="Lat"
              value={latStr}
              onChange={(e) => setLatStr(e.target.value)}
              className={`${fieldCls} w-[5.5rem] font-mono ${coordError ? 'ring-rose-500' : ''}`}
            />
            <input
              aria-label="Longitude (east positive)"
              inputMode="decimal"
              placeholder="Lon °E"
              value={lonStr}
              onChange={(e) => setLonStr(e.target.value)}
              className={`${fieldCls} w-[5.5rem] font-mono ${coordError ? 'ring-rose-500' : ''}`}
            />
            <button type="submit" className="h-8 rounded-lg bg-sky-500/20 px-2 text-xs font-semibold text-sky-200 ring-1 ring-sky-400/40 hover:bg-sky-500/30">
              Go
            </button>
          </form>

          <label className="flex items-center gap-1.5">
            <span className={labelCls}>UTC</span>
            <input
              type="datetime-local"
              aria-label="Mission epoch (UTC)"
              step={60}
              value={s.epochUTC.slice(0, 16)}
              onChange={(e) => e.target.value && s.setEpochUTC(`${e.target.value}:00Z`)}
              className={`${fieldCls} font-mono`}
            />
          </label>

          <label className="flex items-center gap-1.5">
            <span className={labelCls}>Days</span>
            <input
              type="number"
              min={1}
              max={30}
              aria-label="Mission duration in days"
              value={s.days}
              onChange={(e) => s.setDays(Number(e.target.value) || 1)}
              className={`${fieldCls} w-14 font-mono`}
            />
          </label>

          <label className="flex items-center gap-1.5" title="Earth Antenna Cutoff: minimum Earth elevation for a direct-to-Earth link">
            <span className={labelCls}>Earth Ant.</span>
            <input
              type="range"
              min={0}
              max={20}
              step={0.5}
              aria-label="Earth antenna cutoff in degrees"
              value={antLocal}
              onChange={(e) => {
                setAntLocal(Number(e.target.value));
                s.setAnt(Number(e.target.value));
              }}
              className="llsn-range w-24"
            />
            <span className="w-9 font-mono text-xs tabular-nums text-sky-200">{antLocal.toFixed(1)}°</span>
          </label>

          <select
            aria-label="Moon Trek polar layer"
            className={`${fieldCls} max-w-[12rem]`}
            value={s.layer}
            onChange={(e) => s.setLayer(e.target.value as LayerId)}
          >
            {LAYER_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            role="switch"
            aria-checked={s.learn}
            onClick={() => s.setLearn(!s.learn)}
            className="flex h-8 items-center gap-1.5 rounded-lg px-1.5 text-xs text-slate-300 hover:bg-slate-800/60"
          >
            <span className={`relative h-4 w-7 rounded-full transition-colors ${s.learn ? 'bg-sky-500/70' : 'bg-slate-700'}`}>
              <span
                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${s.learn ? 'translate-x-3.5' : 'translate-x-0.5'}`}
              />
            </span>
            Learn
          </button>
        </div>

        <SceneStatusDot scene={s.scene} />

        <AskAiButton />

        <button
          type="button"
          onClick={share}
          className="h-8 rounded-lg bg-slate-100 px-3 text-xs font-semibold text-slate-950 hover:bg-white"
        >
          Share
        </button>

        <button
          type="button"
          aria-label={expanded ? 'Hide mission controls' : 'Show mission controls'}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="h-8 rounded-lg px-2 text-xs text-slate-300 ring-1 ring-slate-700/80 hover:bg-slate-800/60 xl:hidden"
        >
          {expanded ? 'Less' : 'Controls'}
        </button>
      </div>

      {s.layer !== 'BASE_CGI' && s.scene.overlayDetail && (
        <div className="pointer-events-none mt-1.5 rounded-full bg-slate-950/70 px-2.5 py-0.5 font-mono text-[10px] text-slate-400 ring-1 ring-slate-800/80">
          {s.scene.overlayDetail}
        </div>
      )}

      <div
        role="status"
        aria-live="polite"
        className={`mt-2 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-200 ring-1 ring-emerald-400/40 backdrop-blur transition-all duration-300 ${
          toast ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'
        }`}
      >
        {toast ?? ' '}
      </div>
    </div>
  );
}

function SceneStatusDot({ scene }: { scene: SceneStatus }) {
  const loading = scene.baseTexture === 'loading' || scene.heightmap === 'loading' || scene.overlay === 'loading';
  const fallback =
    scene.baseTexture === 'procedural' || scene.heightmap === 'synthetic' || scene.overlay === 'error';
  const color = loading ? 'bg-slate-500 animate-pulse' : fallback ? 'bg-amber-400' : 'bg-emerald-400';
  const base = {
    loading: 'loading…',
    svs: 'NASA SVS CGI Moon Kit 2K (remote)',
    local: 'NASA SVS CGI Moon Kit 2K (local copy)',
    procedural: 'SYNTHETIC FALLBACK texture',
  }[scene.baseTexture];
  const terrain = {
    loading: 'loading… (analytic model shown)',
    lola: 'LOLA LDEM 75S 240 m',
    synthetic: 'SYNTHETIC FALLBACK south-pole model',
  }[scene.heightmap];
  const title = `Globe data sources\nBase colour: ${base}\nPolar terrain: ${terrain}\nOverlay: ${scene.overlayDetail ?? 'none'}`;
  return (
    <span title={title} className="grid h-8 w-6 cursor-help place-items-center" aria-label={title}>
      <span className={`h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}
