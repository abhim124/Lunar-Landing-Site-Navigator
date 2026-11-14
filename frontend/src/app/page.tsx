'use client';

import dynamic from 'next/dynamic';
import { useEffect, type CSSProperties } from 'react';
import { MissionChat } from '@/components/ui/MissionChat';
import { SkyPanoramaDrawer } from '@/components/ui/SkyPanoramaDrawer';
import { TopCommandPill } from '@/components/ui/TopCommandPill';
import { VerdictCard } from '@/components/ui/VerdictCard';
import { useUrlSync } from '@/hooks/useUrlSync';
import { useMissionStore } from '@/store/useMissionStore';

// WebGL must never render on the server.
const LunarGlobe = dynamic(() => import('@/components/canvas/LunarGlobe'), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-[#020308]" />,
});

export default function MissionPage() {
  useUrlSync();
  const hasSite = useMissionStore((s) => s.selectedSite !== null);
  const drawerOpen = useMissionStore((s) => s.isDrawerOpen);
  const drawerTab = useMissionStore((s) => s.activeDrawerTab);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === 'Escape' && tag !== 'INPUT' && tag !== 'SELECT') useMissionStore.getState().clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const layoutVars = {
    // The Timeline tab is just a scrubber now, so it only needs a slim drawer.
    '--drawer-open-h': drawerTab === 'PANORAMA' ? '124px' : 'min(46vh, 440px)',
    '--drawer-h': hasSite ? (drawerOpen ? 'var(--drawer-open-h)' : '48px') : '0px',
  } as CSSProperties;

  return (
    <main className="fixed inset-0 overflow-hidden bg-[#020308] text-slate-100" style={layoutVars}>
      <LunarGlobe />
      <TopCommandPill />
      <MissionChat />
      {hasSite && (
        <>
          <VerdictCard />
          <SkyPanoramaDrawer />
        </>
      )}
    </main>
  );
}
