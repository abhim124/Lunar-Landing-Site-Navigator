'use client';

import { useAssistantStore } from '@/store/useAssistantStore';
import { useMissionStore } from '@/store/useMissionStore';
import type { AgentAction, AgentContext, AgentPanel } from '@/types/assistant';
import type { LayerId, SelectedSite } from '@/types/mission';

/** Mission settings before Hadfield acted, so one click can undo a whole turn. */
export interface AgentSnapshot {
  site: SelectedSite | null;
  epochUTC: string;
  missionDays: number;
  minEarthElevationDeg: number;
  layer: LayerId;
}

export function agentContext(): AgentContext {
  const m = useMissionStore.getState();
  return {
    site: m.selectedSite ? { lat: m.selectedSite.lat, lon: m.selectedSite.lon, name: m.selectedSite.name } : null,
    epochUTC: m.epochUTC,
    missionDays: m.missionDurationDays,
    minEarthElevationDeg: m.minEarthElevationDeg,
  };
}

export function snapshot(): AgentSnapshot {
  const m = useMissionStore.getState();
  return {
    site: m.selectedSite,
    epochUTC: m.epochUTC,
    missionDays: m.missionDurationDays,
    minEarthElevationDeg: m.minEarthElevationDeg,
    layer: m.activeLayer,
  };
}

export function restore(s: AgentSnapshot) {
  const m = useMissionStore.getState();
  m.setActiveLayer(s.layer);
  m.setMissionDurationDays(s.missionDays);
  m.setMinEarthElevationDeg(s.minEarthElevationDeg);
  if (s.site) m.selectSite(s.site, { epochUTC: s.epochUTC, fly: true });
  else {
    m.clearSelection();
    m.setEpochUTC(s.epochUTC);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function flashEl(el: Element | null) {
  if (!(el instanceof HTMLElement)) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('llsn-flash');
  void el.offsetWidth;
  el.classList.add('llsn-flash');
  window.setTimeout(() => el.classList.remove('llsn-flash'), 2100);
}

function showPanel(panel: AgentPanel) {
  const flash = useAssistantStore.getState().flash;
  switch (panel) {
    case 'calendar': {
      flashEl(document.querySelector('[data-highlight-target="calendar"]'));
      // Then bring the focused (best) day into view inside the calendar.
      window.setTimeout(() => {
        const focus = useMissionStore.getState().calendarFocus;
        const cell = focus && document.querySelector(`[data-highlight-target="calendar"] [data-date="${focus.date}"]`);
        if (cell instanceof HTMLElement) cell.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 900);
      return;
    }
    case 'compare':
      flashEl(document.querySelector('[aria-label="Nearby site comparison"]')?.parentElement ?? null);
      return;
    case 'alternatives':
      flashEl(document.querySelector('[data-highlight-target="alternatives"]'));
      return;
    case 'validation': {
      const m = useMissionStore.getState();
      if (!(m.isDrawerOpen && m.activeDrawerTab === 'VALIDATION')) m.setActiveDrawerTab('VALIDATION');
      window.setTimeout(() => flashEl(document.querySelector('footer')), 150);
      return;
    }
    default:
      flash(panel);
  }
}

/** Apply Hadfield's queued UI actions in order. Panels are shown after the site/date changes render. */
export async function applyAgentActions(actions: AgentAction[]) {
  const panels: AgentPanel[] = [];
  for (const a of actions) {
    const m = useMissionStore.getState();
    switch (a.type) {
      case 'select_site':
        m.selectSite({ lat: a.lat, lon: a.lon, name: a.name, regionId: a.regionId ?? null }, { epochUTC: a.epochUTC, fly: true });
        break;
      case 'set_mission':
        if (a.missionDays !== undefined) m.setMissionDurationDays(a.missionDays);
        if (a.minEarthElevationDeg !== undefined) m.setMinEarthElevationDeg(a.minEarthElevationDeg);
        if (a.epochUTC) m.setEpochUTC(a.epochUTC);
        break;
      case 'set_layer':
        m.setActiveLayer(a.layer);
        break;
      case 'focus_calendar': {
        const site = useMissionStore.getState().selectedSite;
        if (site) m.setCalendarFocus({ date: a.date, label: a.label, status: a.status, lat: site.lat, lon: site.lon });
        break;
      }
      case 'show_panel':
        panels.push(a.panel);
        break;
    }
  }
  if (!panels.length) return;
  await wait(700); // let the new site's panels mount and the calendar start loading
  for (const p of panels) {
    showPanel(p);
    await wait(250);
  }
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC';

const PANEL_LABEL: Record<AgentPanel, string> = {
  calendar: 'Opened launch calendar',
  compare: 'Opened site comparison',
  verdict: 'Showed verdict',
  alternatives: 'Showed alternatives',
  validation: 'Opened NASA validation',
  power: 'Showed power',
  comms: 'Showed comms',
};

/** Short, human labels for the chips under a Hadfield reply. */
export function describeActions(actions: AgentAction[]): string[] {
  return actions.map((a) => {
    switch (a.type) {
      case 'select_site':
        return `Moved to ${a.name} (${a.lat.toFixed(2)}°, ${a.lon.toFixed(2)}°)`;
      case 'set_mission': {
        const parts = [];
        if (a.epochUTC) parts.push(`date ${shortDate(a.epochUTC)}`);
        if (a.missionDays !== undefined) parts.push(`${a.missionDays}-day mission`);
        if (a.minEarthElevationDeg !== undefined) parts.push(`Earth ≥ ${a.minEarthElevationDeg}°`);
        return `Set ${parts.join(', ')}`;
      }
      case 'set_layer':
        return `Map layer ${a.layer}`;
      case 'show_panel':
        return PANEL_LABEL[a.panel];
      case 'focus_calendar':
        return `Marked ${a.label.toLowerCase()} ${new Date(`${a.date}T00:00:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })} on the calendar`;
    }
  });
}
