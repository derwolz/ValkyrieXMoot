/**
 * lib/nav/grid.js — build and query the shared navigation grid.
 *
 * buildNavGrid({ bounds, buildingAABBs, roadSegments, intersections,
 *                interestPoints, alleys, zoneMap? })
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
 *   - Park zone cells are also walkable (open green space for ambient moots).
 *   - Highway and water reservation cells are blocked except for explicit
 *     street-level ramp-feeder road strips inside the ramp reservation.
 *   - "On road/sidewalk" is determined by testing whether the cell centre
 *     falls within the road half-width + sidewalk strip of any segment,
 *     or within an intersection box, or within an alley strip.
 *
 * Cost multiplier:
 *   - Default (road / sidewalk): 1.0
 *   - Intersection centre cell:  NAV.costIntersection  (1.3)
 *   - Alley cell:                NAV.costAlley         (0.7)
 *   - Highway zone cell:         3.0  (strongly discouraged, not blocked)
 *   - Park zone cell:            0.8  (slightly preferred — open space)
 */

import { NAV } from '../config.js';
import { CITY } from '../config.js';
import { createSpatialGrid } from '../world/spatialGrid.js';

/**
 * @param {{
 *   bounds: {minX:number,maxX:number,minZ:number,maxZ:number},
 *   buildingAABBs: {minX:number,maxX:number,minZ:number,maxZ:number}[],
 *   roadSegments: {a:{x:number,z:number}, b:{x:number,z:number}, width:number, kind:string}[],
 *   intersections: {pos:{x:number,z:number}, widthX:number, widthZ:number}[],
 *   interestPoints: {x:number,z:number,kind:string}[],
 *   alleys?: {a:{x:number,z:number}, b:{x:number,z:number}, width:number, kind:string}[],
 *   zoneMap?: { getZone:(x:number,z:number)=>string } | null,
 * }} cityData
 * @returns {import('./grid.js').NavGrid}
 */
export function buildNavGrid(cityData) {
  const { bounds, buildingAABBs, roadSegments, intersections, interestPoints } = cityData;
  const zoneMap = cityData.zoneMap ?? null;
  const cs = NAV.cellSize;

  const originX = bounds.minX;
  const originZ = bounds.minZ;
  const cols = Math.ceil((bounds.maxX - bounds.minX) / cs) + 1;
  const rows = Math.ceil((bounds.maxZ - bounds.minZ) / cs) + 1;

  const walkable = new Uint8Array(cols * rows);
  const costMul = new Float32Array(cols * rows).fill(1.0);

  // Precompute a few things we'll need per-cell.
  const mootR = NAV.mootRadius;
  const swHalf = CITY.sidewalkWidth / 2;
  const indexCellSize = Math.max(cs * 4, 16);

  // Inflate buildings for moot clearance and index them so each nav cell only
  // checks nearby building bounds instead of rescanning the full city.
  const inflatedAABBs = buildingAABBs.map((a) => ({
    minX: a.minX - mootR,
    maxX: a.maxX + mootR,
    minZ: a.minZ - mootR,
    maxZ: a.maxZ + mootR,
  }));
  const buildingGrid = createSpatialGrid(inflatedAABBs, indexCellSize);

  // Separate and precompute segment bounds by kind for efficient per-cell lookup.
  const alleySegs = [];
  const roadSegs = [];
  for (const s of roadSegments) {
    const prepared = prepareSegment(s, s.kind === 'alley' ? s.width / 2 : s.width / 2 + swHalf);
    if (s.kind === 'alley') alleySegs.push(prepared);
    else roadSegs.push(prepared);
  }
  const roadGrid = createSpatialGrid(roadSegs, indexCellSize);
  const alleyGrid = createSpatialGrid(alleySegs, indexCellSize);

  const intersectionAABBs = intersections.map((it) => ({
    minX: it.pos.x - it.widthX / 2,
    maxX: it.pos.x + it.widthX / 2,
    minZ: it.pos.z - it.widthZ / 2,
    maxZ: it.pos.z + it.widthZ / 2,
  }));
  const intersectionGrid = createSpatialGrid(intersectionAABBs, indexCellSize);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const wx = originX + col * cs;
      const wz = originZ + row * cs;
      const fi = row * cols + col;

      // Zone check: highway/water reservation cells are excluded unless they
      // are the explicit street-level ramp feeder road created for a touchdown.
      let zoneOverride = null;
      if (zoneMap) {
        const zone = zoneMap.getZone(wx, wz);
        if (isWaterCell(zoneMap, wx, wz, zone)) {
          zoneOverride = 'water';
        } else if (zone === 'highway') {
          zoneOverride = 'highway';
        } else if (zone === 'park') {
          zoneOverride = 'park';
        } else if (zone === 'beach') {
          zoneOverride = 'beach';
        }
      }

      // 1. Is it on a navigable surface?
      const nearbyRoads = roadGrid.queryArray(wx, wx, wz, wz);
      const onRoad = isOnRoad(wx, wz, nearbyRoads);
      const onFeeder = isOnRoadSource(wx, wz, nearbyRoads, 'ramp-feeder');
      const onAlley = isOnAlley(wx, wz, alleyGrid.queryArray(wx, wx, wz, wz));
      const onPark = zoneOverride === 'park'; // park cells are open walkable space

      if (zoneOverride === 'water') continue;
      if (zoneOverride === 'highway' && !onFeeder) continue;

      if (!onRoad && !onAlley && !onPark) continue;

      // Beach zones outside road geometry are not walkable.
      if (zoneOverride === 'beach' && !onRoad && !onAlley) continue;

      // 2. Is it inside an inflated building?
      if (isInsideAny(wx, wz, buildingGrid.queryArray(wx, wx, wz, wz))) continue;

      walkable[fi] = 1;

      // 3. Cost multiplier.
      if (zoneOverride === 'highway') {
        costMul[fi] = 3.0; // strongly discouraged but not impossible
      } else if (onAlley) {
        costMul[fi] = NAV.costAlley;
      } else if (isIntersectionCell(wx, wz, intersectionGrid.queryArray(wx, wx, wz, wz))) {
        costMul[fi] = NAV.costIntersection;
      } else if (onPark) {
        costMul[fi] = 0.8; // park is preferred roaming space
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

  return {
    cellSize: cs,
    cols,
    rows,
    origin: { x: originX, z: originZ },
    walkable,
    costMul,
    interestPoints,
    worldToCell,
    cellToWorld,
    idx,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function prepareSegment(segment, half) {
  const ax = Number(segment?.a?.x);
  const az = Number(segment?.a?.z);
  const bx = Number(segment?.b?.x);
  const bz = Number(segment?.b?.z);
  const safeHalf = Math.max(0, Number(half) || 0);

  if (
    !Number.isFinite(ax) ||
    !Number.isFinite(az) ||
    !Number.isFinite(bx) ||
    !Number.isFinite(bz)
  ) {
    return {
      segment,
      half: safeHalf,
      ax: 0,
      az: 0,
      bx: 0,
      bz: 0,
      dx: 0,
      dz: 0,
      lenSq: 0,
      minX: 0,
      maxX: 0,
      minZ: 0,
      maxZ: 0,
    };
  }

  return {
    segment,
    half: safeHalf,
    ax,
    az,
    bx,
    bz,
    dx: bx - ax,
    dz: bz - az,
    lenSq: (bx - ax) * (bx - ax) + (bz - az) * (bz - az),
    minX: Math.min(ax, bx) - safeHalf,
    maxX: Math.max(ax, bx) + safeHalf,
    minZ: Math.min(az, bz) - safeHalf,
    maxZ: Math.max(az, bz) + safeHalf,
  };
}

function pointSegmentDistanceSq(wx, wz, segment) {
  if (segment.lenSq <= 0) {
    const dx = wx - segment.ax;
    const dz = wz - segment.az;
    return dx * dx + dz * dz;
  }

  const t = Math.max(
    0,
    Math.min(1, ((wx - segment.ax) * segment.dx + (wz - segment.az) * segment.dz) / segment.lenSq),
  );
  const px = segment.ax + segment.dx * t;
  const pz = segment.az + segment.dz * t;
  const dx = wx - px;
  const dz = wz - pz;
  return dx * dx + dz * dz;
}

/**
 * Is world point (wx,wz) within the half-width + sidewalk strip of any road segment?
 * Supports both the retained grid backbone and arbitrary organic/ramp-feeder road headings.
 */
function isOnRoad(wx, wz, segs) {
  for (const s of segs) {
    if (pointSegmentDistanceSq(wx, wz, s) <= s.half * s.half) return true;
  }
  return false;
}

function isOnRoadSource(wx, wz, segs, source) {
  for (const s of segs) {
    if (s?.segment?.source !== source) continue;
    if (pointSegmentDistanceSq(wx, wz, s) <= s.half * s.half) return true;
  }
  return false;
}

function isOnAlley(wx, wz, segs) {
  for (const s of segs) {
    if (pointSegmentDistanceSq(wx, wz, s) <= s.half * s.half) return true;
  }
  return false;
}

function isIntersectionCell(wx, wz, intersections) {
  for (const it of intersections) {
    if (wx >= it.minX && wx <= it.maxX && wz >= it.minZ && wz <= it.maxZ) return true;
  }
  return false;
}

function isWaterCell(zoneMap, wx, wz, zone = null) {
  if (!zoneMap) return false;
  if (typeof zoneMap.getWaterInfo === 'function' && zoneMap.getWaterInfo(wx, wz)?.isWater)
    return true;
  if (typeof zoneMap.isWater === 'function' && zoneMap.isWater(wx, wz)) return true;
  return zone === 'water';
}

function isInsideAny(wx, wz, aabbs) {
  for (const a of aabbs) {
    if (wx >= a.minX && wx <= a.maxX && wz >= a.minZ && wz <= a.maxZ) return true;
  }
  return false;
}
