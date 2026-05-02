import { CITY } from '../../config.js';

// Enumerate every block as the axis-aligned interior rectangle between
// adjacent grid lines, inset by (roadHalfWidth + sidewalkWidth) on every side
// so buildings don't overlap sidewalks.
export function extractBlocks(xLines, zLines) {
  const blocks = [];
  const sw = CITY.sidewalkWidth;
  for (let i = 0; i < xLines.length - 1; i++) {
    for (let j = 0; j < zLines.length - 1; j++) {
      const xL = xLines[i], xR = xLines[i + 1];
      const zN = zLines[j], zS = zLines[j + 1];
      const minX = xL.x + xL.width / 2 + sw;
      const maxX = xR.x - xR.width / 2 - sw;
      const minZ = zN.z + zN.width / 2 + sw;
      const maxZ = zS.z - zS.width / 2 - sw;
      if (maxX - minX > 6 && maxZ - minZ > 6) {
        blocks.push({ minX, maxX, minZ, maxZ });
      }
    }
  }
  return blocks;
}

// For every block long enough on at least one axis, insert one alley parallel
// to the long side at a 35–65% offset, splitting the block into two sub-blocks.
// Returns { subBlocks, alleys } — alley records use the same shape as roads.
export function insertAlleys(blocks, rand) {
  const subBlocks = [];
  const alleys = [];
  const alleyW = CITY.tiers.alley;
  const halfA = alleyW / 2;

  for (const b of blocks) {
    const w = b.maxX - b.minX;
    const d = b.maxZ - b.minZ;
    const longEnough =
      Math.max(w, d) >= CITY.alleyMinBlockDim &&
      Math.min(w, d) >= CITY.alleyMinBlockDim * 0.6;

    if (!longEnough || rand() > CITY.alleyChance) {
      subBlocks.push(b);
      continue;
    }

    // Split along the long axis (or random if near-square).
    const splitVertical = w > d + 4 || (Math.abs(w - d) <= 4 && rand() < 0.5);
    const t = 0.35 + rand() * 0.30;

    if (splitVertical) {
      const xSplit = b.minX + w * t;
      subBlocks.push({ minX: b.minX, maxX: xSplit - halfA, minZ: b.minZ, maxZ: b.maxZ });
      subBlocks.push({ minX: xSplit + halfA, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
      alleys.push({
        a: { x: xSplit, z: b.minZ },
        b: { x: xSplit, z: b.maxZ },
        width: alleyW,
        kind: 'alley',
      });
    } else {
      const zSplit = b.minZ + d * t;
      subBlocks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: zSplit - halfA });
      subBlocks.push({ minX: b.minX, maxX: b.maxX, minZ: zSplit + halfA, maxZ: b.maxZ });
      alleys.push({
        a: { x: b.minX, z: zSplit },
        b: { x: b.maxX, z: zSplit },
        width: alleyW,
        kind: 'alley',
      });
    }
  }
  return { subBlocks, alleys };
}

// BSP-subdivide a block into building plots. Pick the longer edge, split
// perpendicular at 40-60%, recurse until area drops below the zone-specific
// plot area or we hit the zone-specific recursion cap.
//
// Gap enforcement: each child plot must be at least (2 * plotSetback + min footprint)
// wide along the split axis so there is guaranteed visual clearance between buildings.
export function subdividePlots(block, rand, depth = 0, out = [], profile = {}) {
  const w = block.maxX - block.minX;
  const d = block.maxZ - block.minZ;
  const plotMinArea = profile.plotMinArea ?? CITY.plotMinArea;
  const plotSetback = profile.plotSetback ?? CITY.plotSetback;
  const plotBSPDepth = profile.plotBSPDepth ?? CITY.plotBSPDepth;
  const minFootprint = profile.minBuildingFootprint ?? 4;

  if (w * d < plotMinArea || depth >= plotBSPDepth) {
    out.push(block);
    return out;
  }

  // Minimum child dimension = 2*setback + min footprint so buildings
  // from adjacent BSP children can never visually touch.
  const minChildDim = 2 * plotSetback + minFootprint;

  const gap = plotSetback; // each child is inset by this much from the split line
  const t = 0.40 + rand() * 0.20;
  if (w > d) {
    const xSplit = block.minX + w * t;
    const leftW  = xSplit - gap - block.minX;
    const rightW = block.maxX - (xSplit + gap);
    // If either child would be too narrow to hold a building with setback, bail out.
    if (leftW < minChildDim || rightW < minChildDim) {
      out.push(block);
      return out;
    }
    subdividePlots({ ...block, maxX: xSplit - gap }, rand, depth + 1, out, profile);
    subdividePlots({ ...block, minX: xSplit + gap }, rand, depth + 1, out, profile);
  } else {
    const zSplit = block.minZ + d * t;
    const frontD = zSplit - gap - block.minZ;
    const backD  = block.maxZ - (zSplit + gap);
    if (frontD < minChildDim || backD < minChildDim) {
      out.push(block);
      return out;
    }
    subdividePlots({ ...block, maxZ: zSplit - gap }, rand, depth + 1, out, profile);
    subdividePlots({ ...block, minZ: zSplit + gap }, rand, depth + 1, out, profile);
  }
  return out;
}

export function filterPlotsByZoneMask(plots, zoneMap, sampleStep = 18) {
  if (!Array.isArray(plots)) return [];
  if (!zoneMap) return plots;
  return plots.filter((plot) => isUsablePlot(plot, 5) && !rectTouchesReservedZone(plot, zoneMap, sampleStep));
}

export function filterPlotsNearRoads(plots, roadSegments, clearance = 0) {
  if (!Array.isArray(plots) || !Array.isArray(roadSegments) || roadSegments.length === 0) return plots;
  const minPlotDim = 5;
  return plots.filter((plot) => {
    if (!isUsablePlot(plot, minPlotDim)) return false;
    return !roadSegments.some((segment) => segmentOverlapsPlot(plot, segment, clearance));
  });
}

function rectTouchesReservedZone(rect, zoneMap, sampleStep) {
  const w = rect.maxX - rect.minX;
  const d = rect.maxZ - rect.minZ;
  const xSteps = Math.max(1, Math.ceil(w / Math.max(6, sampleStep)));
  const zSteps = Math.max(1, Math.ceil(d / Math.max(6, sampleStep)));
  for (let ix = 0; ix <= xSteps; ix++) {
    const x = rect.minX + (w * ix) / xSteps;
    for (let iz = 0; iz <= zSteps; iz++) {
      const z = rect.minZ + (d * iz) / zSteps;
      if (isReservedZone(x, z, zoneMap)) return true;
    }
  }
  return false;
}

function isReservedZone(x, z, zoneMap) {
  if (!zoneMap) return false;
  if (typeof zoneMap.getWaterInfo === 'function' && zoneMap.getWaterInfo(x, z)?.isWater) return true;
  if (typeof zoneMap.isWater === 'function' && zoneMap.isWater(x, z)) return true;
  if (typeof zoneMap.getZone !== 'function') return false;
  const zone = zoneMap.getZone(x, z);
  return zone === 'water' || zone === 'highway';
}

function segmentOverlapsPlot(plot, segment, clearance) {
  if (!isPointLike(segment?.a) || !isPointLike(segment?.b)) return false;
  const radius = Math.max(0, (Number(segment.width) || 0) * 0.5 + clearance);
  const expanded = {
    minX: plot.minX - radius,
    maxX: plot.maxX + radius,
    minZ: plot.minZ - radius,
    maxZ: plot.maxZ + radius,
  };

  if (pointInsideRect(segment.a, expanded) || pointInsideRect(segment.b, expanded)) return true;
  if (segmentIntersectsRect(segment.a, segment.b, expanded)) return true;

  const corners = [
    { x: plot.minX, z: plot.minZ },
    { x: plot.maxX, z: plot.minZ },
    { x: plot.maxX, z: plot.maxZ },
    { x: plot.minX, z: plot.maxZ },
  ];
  return corners.some((corner) => distancePointToSegment(corner, segment.a, segment.b) <= radius);
}

function segmentIntersectsRect(a, b, rect) {
  const edges = [
    [{ x: rect.minX, z: rect.minZ }, { x: rect.maxX, z: rect.minZ }],
    [{ x: rect.maxX, z: rect.minZ }, { x: rect.maxX, z: rect.maxZ }],
    [{ x: rect.maxX, z: rect.maxZ }, { x: rect.minX, z: rect.maxZ }],
    [{ x: rect.minX, z: rect.maxZ }, { x: rect.minX, z: rect.minZ }],
  ];
  return edges.some(([c, d]) => segmentsIntersect(a, b, c, d));
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  return o4 === 0 && onSegment(c, b, d);
}

function orientation(a, b, c) {
  const value = (b.z - a.z) * (c.x - b.x) - (b.x - a.x) * (c.z - b.z);
  if (Math.abs(value) < 1e-6) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
  return b.x <= Math.max(a.x, c.x) + 1e-6 &&
    b.x >= Math.min(a.x, c.x) - 1e-6 &&
    b.z <= Math.max(a.z, c.z) + 1e-6 &&
    b.z >= Math.min(a.z, c.z) - 1e-6;
}

function distancePointToSegment(point, a, b) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lenSq = abx * abx + abz * abz;
  const t = lenSq > 1e-6
    ? clamp(((point.x - a.x) * abx + (point.z - a.z) * abz) / lenSq, 0, 1)
    : 0;
  const px = a.x + abx * t;
  const pz = a.z + abz * t;
  return Math.hypot(point.x - px, point.z - pz);
}

function pointInsideRect(point, rect) {
  return point.x >= rect.minX && point.x <= rect.maxX && point.z >= rect.minZ && point.z <= rect.maxZ;
}

function isUsablePlot(plot, minDim) {
  return Number.isFinite(plot?.minX) &&
    Number.isFinite(plot?.maxX) &&
    Number.isFinite(plot?.minZ) &&
    Number.isFinite(plot?.maxZ) &&
    plot.maxX - plot.minX >= minDim &&
    plot.maxZ - plot.minZ >= minDim;
}

function isPointLike(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.z);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
