// Distance-based level-of-detail selection over an ordered mesh list
// (index 0 = most detailed). Falls back gracefully when levels are missing.

/** Pick the mesh for a viewer `dist` away: full detail inside `near`, the middle
 *  level inside `far`, and the coarsest beyond. */
export function selectLod<T>(lods: readonly T[], dist: number, near: number, far: number): T {
  if (dist < near && lods[0]) return lods[0];
  if (dist < far && lods[1]) return lods[1];
  return (lods[2] ?? lods[1] ?? lods[0]) as T;
}
