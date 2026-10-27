/** The constant from Cormack et al. (2009); it damps the weight of the very top ranks. */
const K = 60;

/**
 * Reciprocal rank fusion: each id scores the sum of 1 / (K + rank) over the lists it
 * appears in, so an id near the top of either list ranks high and one in both ranks
 * higher. Returns the ids best first; a repeated id in one list counts once.
 */
export function fuseRanks(lists: readonly (readonly string[])[]): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (K + seen.size));
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
