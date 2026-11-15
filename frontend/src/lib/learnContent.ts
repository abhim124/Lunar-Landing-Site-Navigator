import type { SiteEvaluationResponse } from '@/types/mission';
import { benchmarkById, benchmarkSeries } from './earthSolar';
import { DEFAULT_EXPERT } from './displayMode';
import { powerSeries, powerStats, sampleStepH } from './power';

/**
 * Learn-mode copy, written for a curious 12-year-old. One entry per on-screen element:
 *   what    — what the thing on screen is, in plain words
 *   mission — what it means for the mission
 * [[glossary-id|shown words]] marks a glossary term (underlined, opens a tooltip).
 */
export interface LearnEntry {
  what: string;
  mission: string;
}

export const LEARN_CONTENT = {
  verdict: {
    what: 'This is the overall answer for this spot and date, like a mission controller’s thumbs up or down: [[verdict|GO, MARGINAL or NO-GO]].',
    mission: 'GO means a lander could get power, talk to Earth and land safely here. NO-GO means something important would fail.',
  },
  sunlit: {
    what: 'How much of the mission the Sun shines on this spot. At the Moon’s south pole the Sun barely peeks over the horizon, like a sunset that lasts for days.',
    mission: 'The lander runs on solar panels. More sunlight means more power; when the Sun hides behind a hill, the lander lives on its batteries.',
  },
  earth: {
    what: 'How much of the mission Earth can be seen in the sky from here, high enough for the antenna to reach it ([[dte|direct-to-Earth]] radio).',
    mission: 'If a hill or crater rim hides Earth, the crew can’t call mission control without a relay satellite.',
  },
  temperature: {
    what: 'How hot or cold the ground is. With no air to hold heat, the Moon goes from warm to unbelievably cold the moment the Sun disappears.',
    mission: 'Electronics and batteries must be kept warm with heaters, which use power. Very cold sites need bigger batteries.',
  },
  alternatives: {
    what: 'The app searched the ground nearby and nearby dates to see if moving a little, or waiting a few days, would be better.',
    mission: 'A spot a few kilometres away on a higher ridge can see the Sun for much longer, so small moves can turn a NO-GO into a GO.',
  },
  timeline: {
    what: 'Press play or drag the slider to move through the mission hour by hour. The Sun and Earth move across the sky on the 3D Moon.',
    mission: 'It shows exactly when the lander will be in sunlight, in shadow, or out of contact with Earth.',
  },
  calendar: {
    what: 'Each square is one possible landing day over the next year: green is GO, yellow is MARGINAL, red is NO-GO. Click a day to try it.',
    mission: 'Because the Sun and Earth move slowly across the polar sky, some weeks are much better than others. This shows the good launch windows.',
  },
  compare: {
    what: 'Nearby landing spots, each with its own year of good and bad days, so you can compare them side by side.',
    mission: 'If a nearby spot has many more GO days, it gives the mission more chances to launch on time.',
  },
  capcom: {
    what: 'Hatfield is the app’s mission-control assistant. In real missions the person who talks to the astronauts is called CAPCOM, and Hatfield plays that role. Ask it anything by typing or holding the mic, or tell it about a problem.',
    mission: 'It can find the best spot for a date, take you there, explain the numbers, and re-check the site if something breaks.',
  },
  contingency: {
    what: 'When you report a problem, Hatfield checks whether this spot is still safe for that problem, using real terrain and Sun data.',
    mission: 'For example, a fuel leak means the lander can’t fly far or hover long, so it needs a flat spot close by.',
  },
  globe: {
    what: 'A 3D model of the Moon built from NASA laser measurements of its surface ([[lola|LOLA]]). Drag to spin it, scroll to zoom, click to pick a spot.',
    mission: 'The yellow line points to the Sun and the blue line to Earth, so you can see what the lander sees.',
  },
  validation: {
    what: 'A check of this app’s maths against NASA JPL’s own calculator (Horizons) and real past landings.',
    mission: 'If the numbers match, you can trust the app’s Sun and Earth positions.',
  },
  dataSource: {
    what: 'Where the numbers come from: NASA maps and orbit data. “est.” means a simple estimate made by the app, not a measurement.',
    mission: 'Real missions need to know which numbers are measured and which are guesses.',
  },
  darkness: {
    what: 'The longest stretch of the mission with the Sun hidden.',
    mission: 'The batteries must last this long. NASA’s IM-2 lander tipped over in shadow near Mons Mouton and its power ran out early.',
  },
  sunset: { what: 'How long until the Sun goes behind the hills for the first time.', mission: 'That’s when the lander first has to switch to battery power.' },
  earthset: { what: 'How long until Earth drops out of view.', mission: 'That’s when radio contact with mission control is first lost.' },
  slope: {
    what: 'How tilted the ground is ([[slope|slope]]).',
    mission: 'A lander on a steep hill can tip over. Both recent commercial landers (IM-1 and IM-2) ended up on their sides.',
  },
  roughness: { what: 'How bumpy the ground is ([[roughness|roughness]]).', mission: 'Boulders and holes under a landing leg are dangerous.' },
  rock: { what: 'How many big rocks cover the ground.', mission: 'Even a few large boulders can damage a landing leg.' },
  ice: {
    what: 'How far it is to the nearest crater floor that never sees sunlight (a [[psr|permanently shadowed region]]), where water ice can hide.',
    mission: 'Ice can be turned into drinking water, air and rocket fuel ([[isru|ISRU]]), so being close is a big bonus.',
  },
  weather: {
    what: 'Space weather: storms of [[sep|fast particles from the Sun]].',
    mission: 'During a storm, astronauts stay inside the lander instead of going outside.',
  },
} satisfies Record<string, LearnEntry>;

export type LearnId = keyof typeof LEARN_CONTENT;

/** One plain-language sentence explaining why the verdict is what it is. */
export function verdictWhy(ev: SiteEvaluationResponse): string {
  const il = ev.illumination;
  const sun = il.sunlit_pct.value;
  const earth = il.earth_contact_pct.value;
  const dark = il.longest_darkness_hours.value;
  const slope = ev.terrain.slope_deg.value;
  const problems: string[] = [];
  if (il.sunlit_pct.status !== 'GO') problems.push(`the Sun only shines here ${Math.round(sun)}% of the time, so the solar panels would go hungry`);
  if (il.longest_darkness_hours.status !== 'GO') problems.push(`the longest night lasts about ${Math.round(dark)} hours, longer than the batteries are planned for`);
  if (il.earth_contact_pct.status !== 'GO') problems.push(`Earth is only visible ${Math.round(earth)}% of the time, so radio calls home would often drop`);
  if (ev.terrain.slope_deg.status !== 'GO') problems.push(`the ground tilts about ${Math.round(slope)}°, steep enough to risk tipping over`);
  if (il.time_to_sunset_hours.status !== 'GO' && il.sunlit_pct.status === 'GO') problems.push('the Sun sets behind the hills soon after landing');
  if (il.time_to_earthset_hours.status !== 'GO' && il.earth_contact_pct.status === 'GO') problems.push('Earth drops out of view soon after landing');
  if (ev.terrain.roughness_m.status !== 'GO') problems.push('the ground is bumpy, with dips and boulders that could catch a landing leg');
  if (ev.space_weather.status === 'ELEVATED RADIATION')
    problems.push('the Sun threw out a storm of harmful particles during these dates, so astronauts would have to shelter inside instead of exploring');
  else if (ev.space_weather.status === 'UNKNOWN') problems.push('the space-weather forecast for these dates could not be checked');
  if (ev.overall_status === 'GO')
    return `GO because the Sun shines ${Math.round(sun)}% of the time, Earth is in view ${Math.round(earth)}% of the time, and the ground is fairly flat.`;
  const word = ev.overall_status === 'NO-GO' ? 'NO-GO' : 'MARGINAL';
  return problems.length
    ? `${word} because ${problems.slice(0, 2).join(', and ')}.`
    : `${word} because one of the safety checks is borderline. Ask Hatfield which one.`;
}

/** "This site gets 3.2× the solar energy of Toronto over these 7 days." — default panel, same dates. */
export function benchmarkLine(ev: SiteEvaluationResponse, benchmark: 'toronto' | 'phoenix' | 'southpole' = 'toronto'): string | null {
  const samples = ev.trajectory.samples;
  if (samples.length < 2) return null;
  const step = sampleStepH(samples);
  const moon = powerStats(powerSeries(samples, DEFAULT_EXPERT), step, 0).energyKWh;
  const b = benchmarkById(benchmark);
  const earth = benchmarkSeries(b, ev.epoch_utc, samples.map((s) => s.hours_from_start), DEFAULT_EXPERT);
  const earthKWh = (earth.reduce((a, p) => a + p.w, 0) * step) / 1000;
  const days = ev.mission_duration_days;
  if (earthKWh < 0.01) return moon > 0 ? `${b.name} gets almost no sunlight on these dates, while this site would still make power.` : null;
  const r = moon / earthKWh;
  const place = b.name.split(',')[0];
  if (r >= 1.05) return `This site gets ${r.toFixed(1)}× the solar energy of ${place} over these ${days} days.`;
  if (r <= 0.95) return `This site gets only ${Math.round(r * 100)}% of the solar energy of ${place} over these ${days} days.`;
  return `This site gets about the same solar energy as ${place} over these ${days} days.`;
}
