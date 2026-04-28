/**
 * lib/nav/grid.js — build and query the shared navigation grid.
 *
 * buildNavGrid({ bounds, buildingAABBs, roadSegments, intersections,
 *                interestPoints, alleys })
 *   → NavGrid
 *
 * NavGrid = {
 *   cellSize, cols, rows,
 *   origin: { x, z },      // world-space centre of cell (0,0)
 *   walkable: Uint8Array,  // cols*rows — 0=blocked, 1=walkable
 *   costMul: Float32Array, // cols*rows — 1.0 default
 *   interestPoints,        // forwarded from city generator
 *   worldToCell(x,z)       // → {col,row} (clamped)
 *   cellToWorld(col,row)   // → {x,z}
 *   idx(col,row)           // → flat index, or -1 if out of bounds
 * }
 *
 * Walkability rules (all in XZ):
 *   - A cell is walkable when its centre lies on road/sidewalk/alley space
 *     AND is NOT inside any building AABB inflated by NAV.mootRadius.
 *   - "On road/sidewalk" is determined by testing whether the cell centre
 *     falls within the road half-width + sidewalk strip of any segment,
 *     or within an intersection box, or within an alley strip.
 *
 * Cost multiplier:
 *   - Default (road / sidewalk): 1.0
 *   - Intersection centre cell:  NAV.costIntersection  (1.3)
 *   - Alley cell:                NAV.costAlley         (0.7)
 */

import { NAV } from '../config.js';
import { CITY } from '../config.js';

/**
 * @param {{
 *   bounds: {minX:number,maxX:number,minZ:number,maxZ:number},
 *   buildingAABBs: {minX:number,maxX:number,minZ:number,maxZ:number}[],
 *   roadSegments: {a:{x:number,z:number}, b:{x:number,z:number}, width:number, kind:string}[],
 *   intersections: {pos:{x:number,z:number}, widthX:number, widthZ:number}[],
 *   interestPoints: {x:number,z:number,kind:string}[],
 *   alleys?: {a:{x:number,z:number}, b:{x:number,z:number}, width:number, kind:string}[],
 * }} cityData
 * @returns {import('./grid.js').NavGrid}
 */
export function buildNavGrid(cityData) {
  const { bounds, buildingAABBs, roadSegments, intersections, interestPoints } = cityData;
  const cs = NAV.cellSize;

  const originX = bounds.minX;
  const originZ = bounds.minZ;
  const cols = Math.ceil((bounds.maxX - bounds.minX) / cs) + 1;
  const rows = Math.ceil((bounds.maxZ - bounds.minZ) / cs) + 1;

  const walkable = new Uint8Array(cols * rows);
  const costMul  = new Float32Array(cols * rows).fill(1.0);

  // Precompute a few things we'll need per-cell.
  const mootR    = NAV.mootRadius;
  const swHalf   = CITY.sidewalkWidth / 2;

  // Inflate buildings for moot clearance.
  const inflatedAABBs = buildingAABBs.map(a => ({
    minX: a.minX - mootR,
    maxX: a.maxX + mootR,
    minZ: a.minZ - mootR,
    maxZ: a.maxZ + mootR,
  }));

  // Separate segments by kind for efficient per-cell lookup.
  const alleySegs      = roadSegments.filter(s => s.kind === 'alley');
  const roadSegs       = roadSegments.filter(s => s.kind !== 'alley');

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const wx = originX + col * cs;
      const wz = originZ + row * cs;
      const fi = row * cols + col;

      // 1. Is it on a navigable surface?
      const onRoad  = isOnRoad(wx, wz, roadSegs, swHalf);
      const onAlley = isOnAlley(wx, wz, alleySegs);

      if (!onRoad && !onAlley) continue;

      // 2. Is it inside an inflated building?
      if (isInsideAny(wx, wz, inflatedAABBs)) continue;

      walkable[fi] = 1;

      // 3. Cost multiplier.
      if (onAlley) {
        costMul[fi] = NAV.costAlley;
      } else if (isIntersectionCell(wx, wz, intersections)) {
        costMul[fi] = NAV.costIntersection;
      }
    }
  }

  function worldToCell(x, z) {
    return {
      col: Math.max(0, Math.min(cols - 1, Math.round((x - originX) / cs))),
      row: Math.max(0, Math.min(rows - 1, Math.round((z - originZ) / cs))),
    };
  }

  function cellToWorld(col, row) {
    return { x: originX + col * cs, z: originZ + row * cs };
  }

  function idx(col, row) {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return -1;
    return row * cols + col;
  }

  return { cellSize: cs, cols, rows, origin: { x: originX, z: originZ },
           walkable, costMul, interestPoints,
           worldToCell, cellToWorld, idx };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Is world point (wx,wz) within the half-width + sidewalk strip of any road segment?
 * Our grid segments are all axis-aligned (either same x or same z).
 */
function isOnRoad(wx, wz, segs, swHalf) {
  for (const s of segs) {
    const half = s.width / 2 + swHalf;
    if (s.a.x === s.b.x) {
      // Vertical segment — x-range is [seg.x ± half], z-range is [a.z..b.z].
      const zMin = Math.min(s.a.z, s.b.z);
      const zMax = Math.max(s.a.z, s.b.z);
      if (Math.abs(wx - s.a.x) <= half && wz >= zMin && wz <= zMax) return true;
    } else {
      // Horizontal segment
      const xMin = Math.min(s.a.x, s.b.x);
      const xMax = Math.max(s.a.x, s.b.x);
      if (Math.abs(wz - s.a.z) <= half && wx >= xMin && wx <= xMax) return true;
    }
  }
  return false;
}

function isOnAlley(wx, wz, segs) {
  for (const s of segs) {
    const half = s.width / 2;
    if (s.a.x === s.b.x) {
      const zMin = Math.min(s.a.z, s.b.z);
      const zMax = Math.max(s.a.z, s.b.z);
      if (Math.abs(wx - s.a.x) <= half && wz >= zMin && wz <= zMax) return true;
    } else {
      const xMin = Math.min(s.a.x, s.b.x);
      const xMax = Math.max(s.a.x, s.b.x);
      if (Math.abs(wz - s.a.z) <= half && wx >= xMin && wx <= xMax) return true;
    }
  }
  return false;
}

function isIntersectionCell(wx, wz, intersections) {
  for (const it of intersections) {
    const hx = it.widthX / 2;
    const hz = it.widthZ / 2;
    if (wx >= it.pos.x - hx && wx <= it.pos.x + hx &&
        wz >= it.pos.z - hz && wz <= it.pos.z + hz) return true;
  }
  return false;
}

function isInsideAny(wx, wz, aabbs) {
  for (const a of aabbs) {
    if (wx >= a.minX && wx <= a.maxX && wz >= a.minZ && wz <= a.maxZ) return true;
  }
  return false;
}
