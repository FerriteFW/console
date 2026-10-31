// A small grid clusterer for the "near me" map: markers whose screen points fall in the same square cell (`cell`
// pixels) at the map's zoom become one group. Groups keep the items' order, and come in the order of their first
// item, so redraws are stable. No plugin: the map has at most a few hundred sites.

export type Point = { x: number; y: number };

export function gridCluster<T>(items: readonly T[], at: (t: T) => Point, cell: number): T[][] {
  const by = new Map<string, T[]>();
  for (const t of items) {
    const p = at(t);
    const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    const g = by.get(k);
    if (g) g.push(t);
    else by.set(k, [t]);
  }
  return [...by.values()];
}
