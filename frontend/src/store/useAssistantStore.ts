'use client';

import { create } from 'zustand';
import type { HighlightTarget } from '@/types/assistant';
import { useMissionStore } from './useMissionStore';

interface AssistantState {
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  /** Briefly flash every element tagged `data-highlight-target="<target>"`. */
  flash: (target: HighlightTarget) => void;
}

const FLASH_MS = 2000;

function flashElements(target: string) {
  document.querySelectorAll<HTMLElement>(`[data-highlight-target="${target}"]`).forEach((el) => {
    el.classList.remove('llsn-flash');
    void el.offsetWidth; // restart the animation if it is already running
    el.classList.add('llsn-flash');
    if (target !== 'calendar') el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    window.setTimeout(() => el.classList.remove('llsn-flash'), FLASH_MS + 100);
  });
}

export const useAssistantStore = create<AssistantState>()((set) => ({
  isOpen: true,
  setOpen: (open) => set({ isOpen: open }),
  flash: (target) => {
    if (target === 'none' || typeof document === 'undefined') return;
    if (target === 'calendar') {
      // The calendar lives in a drawer tab: open it first, then flash once it has rendered.
      const m = useMissionStore.getState();
      if (m.selectedSite) m.setActiveDrawerTab('CALENDAR');
      window.setTimeout(() => flashElements(target), 120);
      return;
    }
    flashElements(target);
  },
}));
