'use client';

import { Crosshair, Gauge, Mountain, Orbit, Radiation, Thermometer, Wind, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/* ═══════════════════════════════ types & defaults ═══════════════════════════════ */

export type RadiationLevel = 'ELEVATED' | 'HAZARDOUS' | 'EXTREME';

/** Where a number came from, shown as a small tag + tooltip so estimates are never mistaken for measurements. */
export interface EnvProvenance {
  kind: 'measured' | 'est.' | 'illustrative' | 'default';
  note: string;
}

export interface EnvSite {
  siteName: string;
  /** Local elevation, m (LOLA DEM, relative to the 1737.4 km sphere). */
  elevationM: number;
  /** Local terrain slope, °. */
  slopeDeg: number;
  /** 20 elevations (m) along a line through the site; generated from elevation + slope when absent. */
  elevationProfile?: number[];
  /** Half-length of the profile line, km (for the axis label). */
  profileHalfWidthKm?: number;
  minTempC?: number;
  maxTempC?: number;
  radiationLevel?: RadiationLevel | string;
  /** 0–100 % of open-sky exposure (terrain shielding lowers it). */
  radiationExposurePct?: number;
  lat?: number;
  lon?: number;
  /** Optional provenance per row. */
  provenance?: Partial<Record<'topography' | 'profile' | 'temperature' | 'radiation', EnvProvenance>>;
  /** True when no site is selected and the Shackleton fallback is shown. */
  isDefault?: boolean;
}

export interface EnvPreset {
  id: string;
  label: string;
}

export interface EnvComparisonModalProps {
  selectedSite?: EnvSite | null;
  /** Quick site switcher shown in the modal header (selects the site in the host app). */
  presets?: EnvPreset[];
  activePresetId?: string | null;
  onSelectPreset?: (id: string) => void;
  /** True while the host app is re-computing the selected site. */
  loading?: boolean;
}

const DEFAULT_SITE: EnvSite = {
  siteName: 'Shackleton Crater Rim',
  elevationM: 1800,
  slopeDeg: 6,
  minTempC: -180,
  maxTempC: 120,
  radiationLevel: 'Hazardous (Cosmic & Solar)',
  radiationExposurePct: 92,
  lat: -89.45,
  lon: -137.3,
  isDefault: true,
  provenance: {
    topography: { kind: 'default', note: 'No site selected: placeholder values for the Shackleton rim. Select a site for real LOLA data.' },
    temperature: { kind: 'default', note: 'No site selected: placeholder range. Select a site for LRO Diviner measurements.' },
    radiation: { kind: 'default', note: 'No site selected: placeholder level.' },
  },
};

const ELEV_MAX = 5000;
const T_MIN = -230;
const T_MAX = 130;

/* ═══════════════════════════════ pure helpers ═══════════════════════════════ */

/** Small deterministic PRNG (mulberry32) so a generated profile is stable per site. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fallback 20-point profile when no DEM profile is passed: a crater/ridge silhouette whose depth and
 * jaggedness scale with the slope, centred on the site elevation and seeded from it (illustrative).
 */
export function generateProfile(elevationM: number, slopeDeg: number): number[] {
  const r = rng(Math.round(elevationM * 7 + slopeDeg * 1013));
  const relief = 300 + slopeDeg * 120;
  const crater = elevationM < 0;
  return Array.from({ length: 20 }, (_, i) => {
    const t = (i - 9.5) / 9.5; // -1 … 1
    const shape = crater ? relief * (t * t - 0.3) : relief * (0.3 - t * t) * 0.8;
    const jag = (r() - 0.5) * relief * 0.35 + Math.sin(i * 1.7 + slopeDeg) * relief * 0.12;
    return elevationM + shape + jag;
  });
}

/** Temperature → colour from cryo-blue (−220 °C) through grey to thermal-red (+120 °C). */
function tempColor(c: number): string {
  const stops: [number, [number, number, number]][] = [
    [-220, [37, 99, 235]],
    [-150, [56, 189, 248]],
    [-60, [148, 163, 184]],
    [20, [251, 191, 36]],
    [120, [239, 68, 68]],
  ];
  if (c <= stops[0][0]) return `rgb(${stops[0][1].join(',')})`;
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    const [t0, c0] = stops[i - 1];
    if (c <= t1) {
      const f = (c - t0) / (t1 - t0);
      return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * f)).join(',')})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1].join(',')})`;
}

const fmtSigned = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n)}`;

/* ═══════════════════════════════ small UI pieces ═══════════════════════════════ */

function Spine({ icon, label, children }: { icon: ReactNode; label: string; children?: ReactNode }) {
  return (
    <div className="relative order-first col-span-2 flex flex-col items-center justify-center self-stretch md:order-none md:col-span-1">
      <span aria-hidden className="absolute inset-y-[-10px] hidden md:block left-1/2 w-px -translate-x-1/2 bg-gradient-to-b from-zinc-800 via-zinc-600 to-zinc-800" />
      <span className="relative z-10 inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-center text-xs uppercase tracking-wider text-zinc-200">
        {icon}
        {label}
      </span>
      {children}
    </div>
  );
}

function Tag({ p }: { p?: EnvProvenance }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!p) return null;
  const style =
    p.kind === 'measured'
      ? 'border-emerald-500/40 text-emerald-300'
      : p.kind === 'est.'
        ? 'border-amber-500/40 text-amber-300'
        : p.kind === 'illustrative'
          ? 'border-fuchsia-500/40 text-fuchsia-300'
          : 'border-zinc-600 text-zinc-400';
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={`cursor-help rounded border px-1 text-[9px] uppercase tracking-wider ${style}`}
      >
        {p.kind}
      </button>
      {open && (
        <span id={id} role="tooltip" className="absolute bottom-full left-0 z-20 mb-1 w-64 rounded-md border border-zinc-700 bg-zinc-950 p-2 text-[10px] normal-case leading-snug tracking-normal text-zinc-300 shadow-xl">
          {p.note}
        </span>
      )}
    </span>
  );
}

/** Track that fills toward (Earth, `toward='right'`) or away from (Moon) the centre spine. */
function Track({ pct, fill, toward, empty, className = '', style }: { pct: number; fill: string; toward: 'left' | 'right'; empty?: boolean; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`relative h-3.5 w-full overflow-hidden rounded-full border border-zinc-800 bg-zinc-900/90 shadow-inner ${className}`}>
      {!empty && (
        <div
          className={`absolute inset-y-0 rounded-full transition-all duration-500 ${fill} ${toward === 'right' ? 'right-0' : 'left-0'}`}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%`, ...style }}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════ rows ═══════════════════════════════ */

/** Phones: the label (spine) spans both columns above Earth | Moon. md+: Earth | spine | Moon. */
const ROW = 'grid grid-cols-2 items-center gap-x-3 gap-y-2 md:grid-cols-[1fr_190px_1fr] md:gap-4';

const W = 360; // viewBox width of each topography half
const H = 120;
const yOf = (m: number) => H / 2 - (Math.max(-ELEV_MAX, Math.min(ELEV_MAX, m)) / ELEV_MAX) * (H / 2 - 6);

function TopographyRow({ site, profile }: { site: EnvSite; profile: number[] }) {
  // Earth: smooth rolling hills tapering to sea level on the far left.
  const earth = useMemo(() => {
    const n = 40;
    const pts = Array.from({ length: n + 1 }, (_, i) => {
      const t = i / n; // 0 (far left, sea) … 1 (spine)
      const hills = t < 0.18 ? 0 : (Math.sin(t * 9) * 0.5 + 0.5) * 900 * Math.min(1, (t - 0.18) * 4) + 200 * t;
      return [t * W, yOf(hills)] as const;
    });
    return `M0,${yOf(0)} ${pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} L${W},${H} L0,${H} Z`;
  }, []);
  const moonPts = profile.map((m, i) => [(i / (profile.length - 1)) * W, yOf(m)] as const);
  const moon = `M0,${H} ${moonPts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} L${W},${H} Z`;
  const pinX = W / 2;
  const pinY = yOf(site.elevationM);
  const transition = { transition: 'd 500ms ease, cy 500ms ease, y 500ms ease' } as React.CSSProperties;

  return (
    <>
      <div className="text-right">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" preserveAspectRatio="none" aria-label="Earth terrain cross-section">
          <defs>
            <linearGradient id="env-earth" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#4d7c0f" />
              <stop offset="0.6" stopColor="#78350f" />
              <stop offset="1" stopColor="#292524" />
            </linearGradient>
          </defs>
          <line x1="0" x2={W} y1={yOf(0)} y2={yOf(0)} stroke="#0ea5e9" strokeWidth="1" strokeDasharray="4 3" />
          <rect x="0" y={yOf(0)} width={W * 0.18} height={H - yOf(0)} fill="#0369a1" opacity="0.6" />
          <path d={earth} fill="url(#env-earth)" stroke="#a3e635" strokeWidth="1" opacity="0.9" />
        </svg>
        <p className="text-[10px] text-sky-300">Sea level (0 m) · rolling hills · soil &amp; vegetation</p>
      </div>
      <Spine icon={<Mountain className="h-3.5 w-3.5" />} label="Topography">
        <div className="relative z-10 mt-1 flex flex-col items-center rounded bg-zinc-950/80 px-1 text-[9px] leading-tight text-zinc-500">
          <span>+5000 m</span>
          <span className="text-zinc-400">0 m</span>
          <span>−5000 m</span>
        </div>
      </Spine>
      <div>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" preserveAspectRatio="none" aria-label={`Lunar terrain cross-section at ${site.siteName}`}>
          <defs>
            <linearGradient id="env-moon" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#a1a1aa" />
              <stop offset="0.5" stopColor="#52525b" />
              <stop offset="1" stopColor="#18181b" />
            </linearGradient>
          </defs>
          <line x1="0" x2={W} y1={yOf(0)} y2={yOf(0)} stroke="#3f3f46" strokeWidth="1" strokeDasharray="2 4" />
          <path d={moon} fill="url(#env-moon)" stroke="#d4d4d8" strokeWidth="1" style={transition} />
          <line x1={pinX} x2={pinX} y1={4} y2={pinY} stroke="#f59e0b" strokeWidth="1" strokeDasharray="2 2" style={transition} />
          <circle cx={pinX} cy={pinY} r="5" fill="none" stroke="#f59e0b" strokeWidth="1.5" style={transition} />
          <circle cx={pinX} cy={pinY} r="1.8" fill="#f59e0b" style={transition} />
        </svg>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-300">
          <Crosshair className="h-3 w-3 text-amber-400" />
          <span className="max-w-[12rem] truncate text-amber-300" title={site.siteName}>
            {site.siteName}
          </span>
          <span>{fmtSigned(site.elevationM)} m Elev</span>
          <span>{site.slopeDeg.toFixed(1)}° Slope</span>
          <span className="text-zinc-500">Rubble Regolith</span>
          <Tag p={site.provenance?.topography} />
          <Tag p={site.provenance?.profile} />
        </div>
      </div>
    </>
  );
}

function TemperatureWave({ minC, maxC }: { minC: number; maxC: number }) {
  const gid = useId().replace(/:/g, '');
  const x0 = ((minC - T_MIN) / (T_MAX - T_MIN)) * 100;
  const x1 = ((maxC - T_MIN) / (T_MAX - T_MIN)) * 100;
  const n = 28;
  const d = Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const x = x0 + (x1 - x0) * t;
    const y = 7 + Math.sin(t * Math.PI * 7) * 3.2 * (i % 2 ? 1 : 0.55);
    return `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  return (
    <svg viewBox="0 0 100 14" preserveAspectRatio="none" className="h-3.5 w-full overflow-visible rounded-full border border-zinc-800 bg-zinc-900/90">
      <defs>
        <linearGradient id={gid} x1={`${x0}%`} x2={`${x1}%`} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={tempColor(minC)} />
          <stop offset="1" stopColor={tempColor(maxC)} />
        </linearGradient>
      </defs>
      <rect x={x0} y="2" width={Math.max(0.5, x1 - x0)} height="10" rx="5" fill={`url(#${gid})`} opacity="0.25" style={{ transition: 'x 500ms, width 500ms' }} />
      <path d={d} fill="none" stroke={`url(#${gid})`} strokeWidth="1.6" vectorEffect="non-scaling-stroke" style={{ transition: 'd 500ms ease' }} />
    </svg>
  );
}

/* ═══════════════════════════════ main component ═══════════════════════════════ */

/**
 * Header button + pop-up HUD comparing Earth baseline conditions (left) with the selected lunar
 * landing site (right). Rows: topography cross-section, atmosphere, gravity, temperature extremes,
 * radiation. Rendered through a portal so it is never clipped by the header's backdrop filter.
 */
export default function EnvComparisonModal({ selectedSite, presets = [], activePresetId = null, onSelectPreset, loading = false }: EnvComparisonModalProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const site: EnvSite = selectedSite ?? DEFAULT_SITE;

  const minC = site.minTempC ?? -180;
  const maxC = site.maxTempC ?? 120;
  const radiation = site.radiationLevel ?? 'Hazardous (Cosmic & Solar)';
  const level = String(radiation).toUpperCase();
  const exposure = site.radiationExposurePct ?? (level.includes('EXTREME') ? 100 : level.includes('ELEVATED') ? 70 : 90);
  const pulseS = level.includes('EXTREME') ? 0.8 : level.includes('HAZARDOUS') ? 1.6 : 2.6;
  const profile = useMemo(
    () => (site.elevationProfile && site.elevationProfile.length >= 2 ? site.elevationProfile : generateProfile(site.elevationM, site.slopeDeg)),
    [site.elevationProfile, site.elevationM, site.slopeDeg],
  );

  useEffect(() => setMounted(true), []);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Swallow it so the page's own Esc shortcut (deselect site) does not also fire.
        e.stopImmediatePropagation();
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [open, close]);

  const coords = site.lat != null && site.lon != null ? `${Math.abs(site.lat).toFixed(2)}°${site.lat < 0 ? 'S' : 'N'} ${Math.abs(site.lon).toFixed(2)}°${site.lon < 0 ? 'W' : 'E'}` : null;

  const modal = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3 backdrop-blur-md" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[92svh] w-full max-w-5xl overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/95 p-4 font-mono md:p-6 text-zinc-100 shadow-2xl"
      >
        {/* header */}
        <div className="mb-5 flex flex-wrap items-start gap-3 border-b border-zinc-800 pb-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-sm font-bold uppercase tracking-[0.18em] text-zinc-100">
              Earth baseline vs. lunar target: <span className="text-amber-300">{site.siteName}</span>
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wider">
              {coords && <span className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-zinc-300">{coords}</span>}
              <span className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-zinc-300">Slope {site.slopeDeg.toFixed(1)}°</span>
              <span className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-zinc-300">Elev {fmtSigned(site.elevationM)} m</span>
              {site.isDefault && <span className="rounded border border-zinc-600 px-1.5 py-0.5 text-zinc-400">No site selected · defaults</span>}
              {loading && <span className="animate-pulse text-sky-300">updating…</span>}
            </div>
          </div>
          {presets.length > 0 && (
            <div role="radiogroup" aria-label="Quick lunar site" className="flex flex-wrap gap-1">
              {presets.map((p) => {
                const on = p.id === activePresetId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => onSelectPreset?.(p.id)}
                    className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors ${
                      on ? 'border-amber-400 bg-amber-400/15 text-amber-200' : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          )}
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label="Close comparison (Esc)"
            className="grid h-8 w-8 place-items-center rounded-md border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* column headings */}
        <div className={`mb-3 ${ROW} text-[10px] uppercase tracking-[0.2em]`}>
          <p className="text-right text-sky-300">◀ Earth baseline</p>
          <span className="hidden md:block" />
          <p className="text-amber-300">Lunar target ▶</p>
        </div>

        <div className="space-y-5">
          {/* Row 1 — topography */}
          <div className={ROW}>
            <TopographyRow site={site} profile={profile} />
          </div>

          {/* Row 2 — atmosphere */}
          <div className={ROW}>
            <div className="flex flex-col items-end gap-1 md:flex-row md:items-center md:gap-3">
              <span className="text-right text-xs md:shrink-0 text-sky-200">101.3 kPa (Breathable)</span>
              <Track pct={100} toward="right" fill="bg-gradient-to-l from-cyan-300 to-sky-600 shadow-[0_0_12px_rgba(34,211,238,0.6)]" />
            </div>
            <Spine icon={<Wind className="h-3.5 w-3.5" />} label="Atmosphere" />
            <div className="flex flex-col-reverse items-start gap-1 md:flex-row md:items-center md:gap-3">
              <Track pct={0} toward="left" fill="" empty />
              <span className="text-xs text-zinc-400 md:shrink-0">0 kPa (Hard Vacuum)</span>
            </div>
          </div>

          {/* Row 3 — gravity */}
          <div className={ROW}>
            <div className="flex flex-col items-end gap-1 md:flex-row md:items-center md:gap-3">
              <span className="text-right text-xs md:shrink-0 text-zinc-200">1.0g (Standard)</span>
              <Track pct={100} toward="right" fill="bg-gradient-to-l from-zinc-100 to-zinc-400" />
            </div>
            <Spine icon={<Orbit className="h-3.5 w-3.5" />} label="Gravity" />
            <div className="flex flex-col-reverse items-start gap-1 md:flex-row md:items-center md:gap-3">
              <Track pct={16.6} toward="left" fill="bg-zinc-500" />
              <span className="text-xs text-zinc-300 md:shrink-0">0.16g (1/6th Earth)</span>
            </div>
          </div>

          {/* Row 4 — temperature extremes */}
          <div className={ROW}>
            <div className="flex flex-col items-end gap-1 md:flex-row md:items-center md:gap-3">
              <span className="text-right text-xs md:shrink-0 text-sky-200">−50°C to +50°C</span>
              <div className="relative h-3.5 w-full rounded-full border border-zinc-800 bg-zinc-900/90">
                <div className="absolute inset-y-0.5 left-[32.5%] w-[35%] rounded-full bg-gradient-to-r from-sky-500/70 to-sky-300/70" />
              </div>
            </div>
            <Spine icon={<Thermometer className="h-3.5 w-3.5" />} label="Temperature extremes" />
            <div className="flex flex-col-reverse items-start gap-1 md:flex-row md:items-center md:gap-3">
              <div className="w-full">
                <TemperatureWave minC={minC} maxC={maxC} />
                <div className="mt-0.5 flex justify-between text-[8px] text-zinc-600">
                  <span>{T_MIN}°C</span>
                  <span>0°C</span>
                  <span>+{T_MAX}°C</span>
                </div>
              </div>
              <span className="flex flex-wrap items-center gap-1 text-xs md:shrink-0" style={{ color: tempColor((minC + maxC) / 2) }}>
                {Math.round(minC)}°C to {maxC > 0 ? '+' : ''}
                {Math.round(maxC)}°C
                <Tag p={site.provenance?.temperature} />
              </span>
            </div>
          </div>

          {/* Row 5 — radiation */}
          <div className={ROW}>
            <div className="flex flex-col items-end gap-1 md:flex-row md:items-center md:gap-3">
              <span className="text-right text-xs md:shrink-0 text-emerald-300">Safe / Protected (Magnetosphere)</span>
              <Track pct={100} toward="right" fill="bg-gradient-to-l from-emerald-300 to-emerald-600" />
            </div>
            <Spine icon={<Radiation className="h-3.5 w-3.5" />} label="Radiation" />
            <div className="flex flex-col-reverse items-start gap-1 md:flex-row md:items-center md:gap-3">
              <Track
                pct={exposure}
                toward="left"
                fill="bg-gradient-to-r from-amber-400 via-orange-500 to-red-600"
                style={{ animation: `env-pulse ${pulseS}s ease-in-out infinite` }}
              />
              <span className="flex flex-wrap items-center gap-1 text-xs text-orange-300 md:shrink-0">
                {radiation}
                <Tag p={site.provenance?.radiation} />
              </span>
            </div>
          </div>
        </div>

        <p className="mt-5 flex items-center gap-1.5 border-t border-zinc-800 pt-3 text-[10px] text-zinc-500">
          <Gauge className="h-3 w-3" />
          Earth values are standard sea-level references. Lunar values follow the selected site; tags show which are measured, estimated or illustrative. Esc or
          click outside to close.
        </p>
      </div>
      <style>{`@keyframes env-pulse{0%,100%{opacity:1;filter:brightness(1)}50%{opacity:.7;filter:brightness(1.35)}}@media (prefers-reduced-motion:reduce){[style*="env-pulse"]{animation:none!important}}`}</style>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Compare Earth conditions with the selected lunar site"
        className="flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-950 px-2 font-mono text-[11px] font-semibold tracking-wider text-zinc-100 hover:border-amber-400/60 hover:text-amber-100"
      >
        <span aria-hidden>🌍</span>
        <span className="text-zinc-500">vs</span>
        <span aria-hidden>🌑</span>
        <span className="hidden lg:inline">ENV COMPARE</span>
        <span className="max-w-[7rem] truncate rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-normal text-amber-200" title={site.siteName}>
          {site.isDefault ? 'Shackleton' : site.siteName}
        </span>
      </button>
      {open && mounted && createPortal(modal, document.body)}
    </>
  );
}
