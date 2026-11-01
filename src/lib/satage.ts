// Satellite list helpers with no Svelte or core (tests/unit/satellites.test.ts runs them under Node): the elements'
// age and its colour (SAT-9), the declination as text (SAT-18).

/** The ISS: its elements age faster (SAT-9). */
export const ISS = 25544;

/** SAT-9: 0 fresh, 1 amber (past 7 days, 3 for the ISS), 2 red (past 30). `epoch` and `now` in UTC seconds. */
export function ageLevel(id: number, epoch: number, now = Date.now() / 1000): 0 | 1 | 2 {
  const d = Math.max(0, now - epoch) / 86400;
  return d > 30 ? 2 : d > (id === ISS ? 3 : 7) ? 1 : 0;
}

/** The elements' age in whole days. */
export const ageDays = (epoch: number, now = Date.now() / 1000) => Math.max(0, Math.floor((now - epoch) / 86400));

/** 0.1° east positive as "15.6° E" (west "W"); null "none". */
export const declText = (d: number | null) => (d === null ? "none" : `${Math.abs(d / 10).toFixed(1)}° ${d < 0 ? "W" : "E"}`);
