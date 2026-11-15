/**
 * Plain-language glossary. In Learn mode, text written as [[id|shown words]] (see learnContent.ts)
 * renders the shown words underlined; tapping or hovering opens this definition.
 */
export interface GlossaryEntry {
  term: string;
  plain: string;
}

export const GLOSSARY = {
  azimuth: { term: 'Azimuth', plain: 'Which compass direction something is in, measured in degrees: 0° is north, 90° east, 180° south, 270° west.' },
  elevation: { term: 'Elevation (angle)', plain: 'How high something is above the flat horizon, in degrees. 0° is right at the horizon, 90° is straight overhead.' },
  'horizon-mask': {
    term: 'Horizon mask',
    plain: 'The lowest angle above the horizon at which something counts as usable, for example how high Earth must be before the antenna can reach it.',
  },
  'terrain-horizon': {
    term: 'Terrain horizon',
    plain: 'The real skyline you would see standing at the site: hills and crater rims that stick up and can block the Sun or Earth even when they are above the flat horizon.',
  },
  psr: {
    term: 'Permanently shadowed region (PSR)',
    plain: 'A spot, usually a deep crater floor near the poles, where sunlight never reaches. They are some of the coldest places in the Solar System and can trap water ice.',
  },
  dte: { term: 'Direct-to-Earth (DTE)', plain: 'Talking to Earth by radio straight from the lander, without a relay satellite. It only works while Earth is visible in the sky.' },
  libration: {
    term: 'Libration',
    plain: 'A slow wobble in how the Moon faces Earth. From the lunar south pole it makes Earth bob up and down a few degrees in the sky over about a month.',
  },
  ephemeris: { term: 'Ephemeris', plain: 'A precise table of where the Sun, Earth and Moon are at any moment. This app uses NASA JPL’s DE421 ephemeris.' },
  sep: {
    term: 'Solar energetic particles (SEP)',
    plain: 'Fast, harmful particles thrown out by the Sun during flares and storms. Astronauts shelter when they arrive because the Moon has no air or magnetic field to block them.',
  },
  regolith: { term: 'Regolith', plain: 'The loose dust and broken rock that covers the Moon’s surface, like very fine, sharp sand.' },
  slope: { term: 'Slope', plain: 'How tilted the ground is, in degrees. 0° is perfectly flat; a lander can tip over if the ground is too steep.' },
  weh: {
    term: 'Water-equivalent hydrogen (WEH)',
    plain: 'How much hydrogen is in the soil, written as if all of it were locked up in water. It is given as a percent of the soil’s weight (wt%).',
  },
  roughness: { term: 'Roughness', plain: 'How bumpy the ground is: how far the surface rises and dips compared with a perfectly flat plane, in metres.' },
  diviner: { term: 'Diviner', plain: 'A thermometer-like instrument on NASA’s Lunar Reconnaissance Orbiter that has measured the Moon’s surface temperature since 2009.' },
  lola: { term: 'LOLA', plain: 'The Lunar Orbiter Laser Altimeter: a laser on NASA’s Lunar Reconnaissance Orbiter that mapped the height of the Moon’s surface.' },
  verdict: {
    term: 'GO / MARGINAL / NO-GO',
    plain: 'Mission-control words. GO means everything checked looks good, MARGINAL means it could work but something is borderline, NO-GO means something important fails.',
  },
  isru: { term: 'ISRU', plain: 'In-situ resource utilisation: using materials found on the Moon, like ice for water and rocket fuel, instead of bringing everything from Earth.' },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryId = keyof typeof GLOSSARY;
export const isGlossaryId = (id: string): id is GlossaryId => id in GLOSSARY;
