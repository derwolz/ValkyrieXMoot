/**
 * lib/world/spatialGrid.js — uniform spatial grid for AABB lookups.
 *
 * createSpatialGrid(aabbs, cellSize)
 *   Buckets each AABB into every cell it overlaps.
 *   Returns an object with:
 *     .query(minX, maxX, minZ, maxZ) → Set<AABB>   (no duplicates)
 *     .queryArray(minX, maxX, minZ, maxZ) → AABB[]  (convenience array)
 *
 * Typical usage — replace a full-array scan with a tight neighbourhood:
 *   const nearby = buildingGrid.queryArray(px - r, px + r, pz - r, pz + r);
 *   for (const aabb of nearby) { ... }
 *
 * Backward compat: callers can still pass a plain AABB array anywhere a grid
 * is accepted — the consumer helper `resolveAABBs(gridOrArray, ...)` handles
 * both, so incremental migration is safe.
 */

/**
 * @typedef {{ minX:number, maxX:number, minZ:number, maxZ:number, minY?:number, maxY?:number }} AABB
 */

/**
 * @param {AABB[]} aabbs
 * @param {number} [cellSize=20]
 * @returns {{ query(minX:number,maxX:number,minZ:number,maxZ:number):Set<AABB>,
 *             queryArray(minX:number,maxX:number,minZ:number,maxZ:number):AABB[],
 *             cellSize:number }}
 */
export function createSpatialGrid(aabbs, cellSize = 20) {
  /** @type {Map<number, AABB[]>} */
  const cells = new Map();

  // Reusable scratch structures — JS is single-threaded so these are safe
  // as long as callers don't stash a reference across frames.
  const _scratch = new Set();
  const _outBuf = [];  // reusable output buffer for queryArray()

  /**
   * Encode (col, row) into a single integer key.
   * Supports maps up to ±2^15 cells per axis — fine for any city scale.
   */
  function key(col, row) {
    // Shift row into upper 20 bits, col into lower 20 bits (with sign offset).
    return ((row + 0x7FFF) * 0x10000) + (col + 0x7FFF);
  }

  function cellOf(world) {
    return Math.floor(world / cellSize);
  }

  // Build phase — insert every AABB into all overlapping cells.
  for (const aabb of aabbs) {
    const c0 = cellOf(aabb.minX);
    const c1 = cellOf(aabb.maxX);
    const r0 = cellOf(aabb.minZ);
    const r1 = cellOf(aabb.maxZ);

    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const k = key(c, r);
        let bucket = cells.get(k);
        if (!bucket) { bucket = []; cells.set(k, bucket); }
        bucket.push(aabb);
      }
    }
  }

  /**
   * Return a deduplicated Set of AABBs overlapping the query rectangle.
   * NOTE: the returned Set is the shared _scratch Set — it is valid only
   * until the next query/queryArray call. Callers that need to stash the
   * result must copy it (new Set(result)).
   * queryRegion() iterates it immediately so this is safe for all current callers.
   */
  function query(minX, maxX, minZ, maxZ) {
    const c0 = cellOf(minX);
    const c1 = cellOf(maxX);
    const r0 = cellOf(minZ);
    const r1 = cellOf(maxZ);

    _scratch.clear();
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const bucket = cells.get(key(c, r));
        if (!bucket) continue;
        for (const aabb of bucket) _scratch.add(aabb);
      }
    }
    return _scratch;
  }

  /**
   * Convenience: same as query() but returns a reusable array.
   * The returned array is overwritten on the next call — iterate it
   * immediately or copy if you need to stash it.
   * Zero heap allocation on the hot path.
   */
  function queryArray(minX, maxX, minZ, maxZ) {
    const c0 = cellOf(minX);
    const c1 = cellOf(maxX);
    const r0 = cellOf(minZ);
    const r1 = cellOf(maxZ);

    _scratch.clear();
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const bucket = cells.get(key(c, r));
        if (!bucket) continue;
        for (const aabb of bucket) _scratch.add(aabb);
      }
    }

    // Write deduplicated results into the reusable buffer (no new array allocation).
    let i = 0;
    for (const aabb of _scratch) _outBuf[i++] = aabb;
    _outBuf.length = i;
    return _outBuf;
  }

  return { query, queryArray, cellSize };
}

/**
 * Helper: given either a plain AABB[] or a SpatialGrid, return the subset of
 * AABBs that could possibly interact with the given world-space rectangle.
 * Zero-allocation path when the caller already knows radius bounds.
 *
 * @param {AABB[]|ReturnType<createSpatialGrid>} gridOrArray
 * @param {number} minX
 * @param {number} maxX
 * @param {number} minZ
 * @param {number} maxZ
 * @returns {AABB[]|Set<AABB>|Iterable<AABB>}
 */
export function queryRegion(gridOrArray, minX, maxX, minZ, maxZ) {
  if (Array.isArray(gridOrArray)) return gridOrArray;
  return gridOrArray.query(minX, maxX, minZ, maxZ);
}
