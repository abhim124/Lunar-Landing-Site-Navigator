'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { AssistantPanel } from '@/components/AssistantPanel';
import { ExpertAnalysis } from '@/components/expert/ExpertAnalysis';
import { DataSourceBadge } from '@/components/ui/DataSourceBadge';
import { NearbyWindowsPanel } from '@/components/ui/NearbyWindowsPanel';
import { LearnBlock } from '@/components/ui/LearnBlock';
import { ANALYTICS_PANEL, CalendarTab, PanoramaTab, ValidationTab, tabButtonClass } from '@/components/ui/SkyPanoramaDrawer';
import { TopCommandPill } from '@/components/ui/TopCommandPill';
import { VerdictCard } from '@/components/ui/VerdictCard';
import { PsrNotice } from '@/components/ui/PsrNotice';
import { useUrlSync } from '@/hooks/useUrlSync';
import { useAssistantStore } from '@/store/useAssistantStore';
import { useMissionStore } from '@/store/useMissionStore';

// WebGL must never render on the server.
const LunarGlobe = dynamic(() => import('@/components/canvas/LunarGlobe'), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-[#020308]" />,
});

export default function MissionPage() {
  useUrlSync();
  const hasSite = useMissionStore((s) => s.selectedSite !== null);
  const assistantOpen = useAssistantStore((s) => s.isOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === 'Escape' && tag !== 'INPUT' && tag !== 'SELECT') useMissionStore.getState().clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <main className="flex min-h-screen flex-col gap-3 bg-[#020308] pb-3 text-slate-100">
      {/* Zone 1 — top bar */}
      <TopCommandPill />

      {/* Zone 2 — verdict strip */}
      {hasSite && (
        <div className="flex flex-col gap-2 px-3">
          <PsrNotice />
          <VerdictCard />
        </div>
      )}

      {/* Zone 3 — view (globe + timeline) | CAPCOM */}
      <div className={`grid gap-3 px-3 ${assistantOpen ? 'xl:grid-cols-[2fr_1fr]' : ''}`}>
        <div className="flex min-w-0 flex-col gap-3">
          <div className={`relative overflow-hidden rounded-2xl ${hasSite ? 'h-[280px]' : 'h-[calc(100vh-88px)]'}`}>
            <LunarGlobe />
          </div>
          {hasSite && (
            <section className={ANALYTICS_PANEL} aria-label="Mission timeline">
              <PanoramaTab />
            </section>
          )}
        </div>
        {assistantOpen && (
          <div className="relative min-w-0">
            <AssistantPanel />
          </div>
        )}
      </div>

      {hasSite && (
        <>
          {/* Expert only — engineering analysis */}
          <ExpertAnalysis />

          {/* Zone 4 — launch calendar */}
          <LaunchCalendarZone />

          {/* Zone 5 — footer */}
          <FooterZone />
        </>
      )}
    </main>
  );
}

function LaunchCalendarZone() {
  const site = useMissionStore((s) => s.selectedSite);
  const epochUTC = useMissionStore((s) => s.epochUTC);
  const days = useMissionStore((s) => s.missionDurationDays);
  const ant = useMissionStore((s) => s.minEarthElevationDeg);

  // The calendar used to load when its drawer tab opened; it is always visible now.
  // fetchLaunchCalendar is keyed and dedupes repeat calls.
  useEffect(() => {
    if (site) void useMissionStore.getState().fetchLaunchCalendar();
  }, [site, epochUTC, days, ant]);

  return (
    <div className="px-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section data-highlight-target="calendar" className={ANALYTICS_PANEL} aria-label="365-day launch slip calendar">
          <h3 className="px-3 pt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">365-Day Launch Slip</h3>
          <LearnBlock id="calendar" className="mx-3" />
          <CalendarTab />
        </section>
        <div className={ANALYTICS_PANEL}>
          <NearbyWindowsPanel />
        </div>
      </div>
    </div>
  );
}

function FooterZone() {
  const source = useMissionStore((s) => s.evaluation?.illumination.sunlit_pct.source ?? null);
  const validationOpen = useMissionStore((s) => s.isDrawerOpen && s.activeDrawerTab === 'VALIDATION');

  const toggleValidation = () => {
    const m = useMissionStore.getState();
    if (validationOpen) m.setDrawerOpen(false);
    else m.setActiveDrawerTab('VALIDATION');
  };

  return (
    <footer className="px-3">
      <div className={ANALYTICS_PANEL}>
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">{source && <DataSourceBadge source={source} />}</div>
          <button type="button" aria-expanded={validationOpen} onClick={toggleValidation} className={tabButtonClass(validationOpen)}>
            NASA Validation
          </button>
        </div>
        <LearnBlock id="dataSource" className="mx-3 mb-2 mt-0" />
        {validationOpen && (
          <div className="border-t border-slate-800/70">
            <LearnBlock id="validation" className="mx-3" />
            <ValidationTab />
          </div>
        )}
      </div>
    </footer>
  );
}
