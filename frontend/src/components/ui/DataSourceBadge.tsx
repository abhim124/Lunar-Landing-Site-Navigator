import type { ReactNode } from 'react';
import type { DataSourceTag, MissionStatus } from '@/types/mission';
import { STATUS_STYLES } from '@/lib/format';

/** Provenance micro-badge rendered next to every telemetry number. */
export function DataSourceBadge({
  source,
  className = '',
  approxCoord = false,
}: {
  source: DataSourceTag;
  className?: string;
  /** Force the APPROX COORD chip (e.g. curated Artemis region centre) even if the backend did not flag it. */
  approxCoord?: boolean;
}) {
  const tooltip = [
    `${source.source_name} · ${source.resolution}`,
    source.is_derived ? 'Derived quantity (computed from the source raster)' : 'Direct product value',
    source.is_synthetic_fallback ? 'SYNTHETIC FALLBACK: analytic model used because the NASA product was unavailable' : null,
    source.is_approx_coord || approxCoord ? 'APPROX COORD: site coordinates are approximate' : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span className={`inline-flex max-w-full flex-wrap items-center gap-1 align-middle ${className}`} title={tooltip}>
      <span className="min-w-0 rounded-md bg-slate-800/70 px-1.5 py-0.5 font-mono text-[10px] leading-snug text-slate-300 ring-1 ring-slate-700/70">
        {source.is_derived && <span className="mr-1 text-sky-300/90">ƒ</span>}
        {source.source_name}
        <span className="text-slate-500"> · </span>
        <span className="text-slate-400">{source.resolution}</span>
      </span>
      {(source.is_approx_coord || approxCoord) && <Chip>APPROX COORD</Chip>}
      {source.is_synthetic_fallback && <Chip>SYNTHETIC FALLBACK</Chip>}
    </span>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide text-amber-300 ring-1 ring-amber-400/40">
      {children}
    </span>
  );
}

export function StatusPill({ status, size = 'sm' }: { status: MissionStatus; size?: 'sm' | 'lg' }) {
  const s = STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-mono font-semibold tracking-wider ${s.pill} ${
        size === 'lg' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-[10px]'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
