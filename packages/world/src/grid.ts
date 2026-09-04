import { CELL_SIZE } from '@tellus/protocol';

/**
 * A spatial hash over the XZ plane. This is the interest-management primitive:
 * every tick the server drops all entities into cells, then asks "who is near
 * player P?" in O(neighbours) instead of O(all players). It's what lets a world
 * hold thousands of entities while each client only ever hears about the handful
 * around them.
 *
 * The key packs a cell coordinate into one int32 (collision-free for the world's
 * modest cell range), so buckets never merge.
 */
export class SpatialHashGrid {
  private readonly cells = new Map<number, number[]>();

  private static cellOf(v: number): number {
    return Math.floor(v / CELL_SIZE);
  }

  private static key(cx: number, cz: number): number {
    // offset into a positive range, then pack — safe for |cell| < 32768
    return (((cx + 32768) << 16) | (cz + 32768)) | 0;
  }

  clear(): void {
    this.cells.clear();
  }

  insert(id: number, x: number, z: number): void {
    const k = SpatialHashGrid.key(SpatialHashGrid.cellOf(x), SpatialHashGrid.cellOf(z));
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(id);
    else this.cells.set(k, [id]);
  }

  /** Collect candidate ids whose cells overlap the query disc. Callers should do
   *  a precise distance check afterwards; this only prunes the far field. */
  queryRadius(x: number, z: number, radius: number, out: number[] = []): number[] {
    const reach = Math.ceil(radius / CELL_SIZE);
    const cx = SpatialHashGrid.cellOf(x);
    const cz = SpatialHashGrid.cellOf(z);
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const bucket = this.cells.get(SpatialHashGrid.key(cx + dx, cz + dz));
        if (bucket) for (const id of bucket) out.push(id);
      }
    }
    return out;
  }
}
