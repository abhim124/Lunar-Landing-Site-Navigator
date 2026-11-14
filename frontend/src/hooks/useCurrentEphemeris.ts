'use client';

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { approxSubsolarPoint, approximateEphemeris, interpolateTrajectory, type ScrubbedEphemeris } from '@/lib/ephemerisMath';
import { angleDiffDeg, latLonToVec3, type Vec3 } from '@/lib/geo';
import { useMissionStore } from '@/store/useMissionStore';

export interface CurrentEphemeris {
  /** null only when no site is selected. */
  ephem: ScrubbedEphemeris | null;
  /** Selenocentric unit vector toward the Sun (scene frame) — drives the directional light. */
  sunDir: Vec3;
  timeMs: number;
  /** true → the backend trajectory for exactly this site/epoch is loaded. */
  authoritative: boolean;
}

/**
 * The single source of "what time is it on the timeline": backend trajectory interpolated at
 * scrubHour when available (zero network per tick), otherwise a local analytic approximation.
 */
export function useCurrentEphemeris(): CurrentEphemeris {
  const { evaluation, scrubHour, epochUTC, selectedSite, minEl } = useMissionStore(
    useShallow((s) => ({
      evaluation: s.evaluation,
      scrubHour: s.scrubHour,
      epochUTC: s.epochUTC,
      selectedSite: s.selectedSite,
      minEl: s.minEarthElevationDeg,
    })),
  );

  return useMemo(() => {
    const epochMs = Date.parse(epochUTC);
    const timeMs = epochMs + scrubHour * 3_600_000;
    let ephem: ScrubbedEphemeris | null = null;
    let authoritative = false;

    if (
      selectedSite &&
      evaluation &&
      Date.parse(evaluation.epoch_utc) === epochMs &&
      Math.abs(evaluation.site.lat - selectedSite.lat) < 1e-4 &&
      Math.abs(angleDiffDeg(evaluation.site.lon, selectedSite.lon)) < 1e-4
    ) {
      ephem = interpolateTrajectory(evaluation.trajectory, scrubHour, minEl);
      authoritative = ephem !== null;
    }
    if (!ephem && selectedSite) {
      ephem = approximateEphemeris(selectedSite.lat, selectedSite.lon, new Date(timeMs), minEl);
    }
    const sub = ephem ? { lat: ephem.subsolarLat, lon: ephem.subsolarLon } : approxSubsolarPoint(new Date(timeMs));
    return { ephem, sunDir: latLonToVec3(sub.lat, sub.lon, 1), timeMs, authoritative };
  }, [evaluation, scrubHour, epochUTC, selectedSite, minEl]);
}
