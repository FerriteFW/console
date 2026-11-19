// Reordering the channel table and the zones: which numbers change. A channel's number is its place on the radio, so
// moving one renumbers it and the channels it passes; these work out the renumbering (old number -> new) and nothing
// else, so the table (channels.svelte.ts) applies them as one undo and they are tested on their own.

/** Channel `from` dropped on number `to` (`used`: every channel number in the table). A free `to` is just a renumber.
 *  A used one takes the place: the channels from `to` towards `from` move one along, as far as the first free number
 *  (at most `from`, which the move frees), so a gap in the numbering stops the shift and nothing past it changes. */
export function moveMap(used: Iterable<number>, from: number, to: number): Map<number, number> {
  const map = new Map<number, number>();
  if (from === to) return map;
  const taken = new Set(used);
  taken.delete(from);
  map.set(from, to);
  const step = to < from ? 1 : -1;
  for (let k = to; taken.has(k); k += step) map.set(k, k + step);
  return map;
}

/** In a list held in number order (a zone's channels, `nums` ascending), the item at `from` moved to place `to`: the
 *  list's own numbers shared out again in the new order, so only the list's channels change number. */
export function orderMap(nums: number[], from: number, to: number): Map<number, number> {
  const map = new Map<number, number>();
  if (from === to || from < 0 || to < 0 || from >= nums.length || to >= nums.length) return map;
  const order = [...nums];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  order.forEach((n, i) => {
    if (n !== nums[i]) map.set(n, nums[i]);
  });
  return map;
}

/** Zones in order (`count` of them), the one at index `from` moved to index `to`: each zone's old index -> its new
 *  one (only the ones that change). */
export function zoneMap(count: number, from: number, to: number): Map<number, number> {
  return orderMap(
    Array.from({ length: count }, (_, i) => i),
    from,
    to,
  );
}

/** "5", or "5–14" for a run: the channels a move shifted, for the notice. */
export function spanText(nums: number[]): string {
  if (!nums.length) return "";
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}
