// Ferrite versions as the radio and the bundled release name them ("v0.8.3", "0.8.4"): compared by number, so
// 0.8.10 is newer than 0.8.9. Anything else (a missing or odd version) never counts as older.

const parse = (v: string): [number, number, number] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** True when `radio` is an older Ferrite than `latest` (the release bundled with Console). */
export function olderThan(radio: string, latest: string): boolean {
  const a = parse(radio);
  const b = parse(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** True when `v` is `min` or newer; a missing or odd version never counts. */
export function atLeast(v: string, min: string): boolean {
  return parse(v) !== null && parse(min) !== null && !olderThan(v, min);
}
