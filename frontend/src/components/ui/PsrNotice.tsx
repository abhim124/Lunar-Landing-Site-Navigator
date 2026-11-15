'use client';

import { compassWord } from '@/lib/contingency';
import { fmtNum } from '@/lib/format';
import { useMissionStore } from '@/store/useMissionStore';
import { Term } from './Term';

/** Banner shown when a chosen pad is in / near a permanently shadowed region (PSR). */
export function PsrNotice() {
  const notice = useMissionStore((s) => s.psrNotice);
  const selectSite = useMissionStore((s) => s.selectSite);
  const setNotice = useMissionStore((s) => s.setPsrNotice);
  if (!notice) return null;

  const where = notice.inPsr
    ? 'inside a permanently shadowed region'
    : `${fmtNum((notice.psrDistanceKm ?? 0) * 1000, 0)} m from a permanently shadowed region (minimum 500 m)`;
  const landAnyway = () => {
    selectSite(notice.clicked, { allowPsr: true });
    setNotice({ ...notice, kind: 'override' });
  };
  const moveToSafe = () => selectSite(notice.clicked); // re-runs the guard, which relocates it

  const tone = notice.kind === 'moved' ? 'border-violet-400/40 bg-violet-500/10' : 'border-rose-400/40 bg-rose-500/10';
  return (
    <div role="status" aria-live="polite" className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border px-3 py-2 text-xs ${tone}`} data-psr-notice={notice.kind}>
      <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-violet-400/80 text-[11px] font-black text-slate-950">
        ◐
      </span>
      <p className="min-w-0 flex-1 leading-snug text-slate-100">
        {notice.kind === 'moved' && notice.to && (
          <>
            The clicked point is {where}, so the lander was moved{' '}
            <span className="font-semibold text-violet-200">
              {fmtNum(notice.to.distanceKm, 1)} km {compassWord(notice.to.bearingDeg)}
            </span>{' '}
            to the nearest safe pad <span className="text-slate-400">({notice.to.criteria}).</span>
          </>
        )}
        {notice.kind === 'override' && (
          <>
            <span className="font-semibold text-rose-200">Landing {where}.</span>{' '}
            {notice.inPsr ? 'No sunlight for solar power and ground near −230 °C' : 'Long shadows and cold ground at the PSR edge'}: the verdict is marked
            accordingly.
          </>
        )}
        {notice.kind === 'view' && (
          <>
            <span className="font-semibold text-rose-200">Comparison view only:</span> this point is {where}. It is shown for its conditions and is
            not accepted as a landing pad.
          </>
        )}
        {notice.kind === 'none' && (
          <>
            <span className="font-semibold text-rose-200">This point is {where}</span>, and no safe pad was found within 40 km.
          </>
        )}{' '}
        <span className="text-slate-400">
          <Term id="psr">What is a PSR?</Term>
        </span>
      </p>
      <div className="flex items-center gap-2">
        {notice.kind === 'moved' && (
          <button type="button" onClick={landAnyway} className="rounded-md px-2 py-1 text-[11px] text-slate-300 ring-1 ring-slate-600 hover:bg-slate-800">
            Land at clicked point anyway
          </button>
        )}
        {(notice.kind === 'override' || notice.kind === 'view') && (
          <button type="button" onClick={moveToSafe} className="rounded-md bg-violet-400/90 px-2 py-1 text-[11px] font-semibold text-slate-950 hover:bg-violet-300">
            Move to nearest safe pad
          </button>
        )}
        <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss PSR notice" className="text-slate-400 hover:text-slate-100">
          ✕
        </button>
      </div>
    </div>
  );
}
