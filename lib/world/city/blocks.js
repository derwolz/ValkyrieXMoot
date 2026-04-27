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
// perpendicular at 40-60%, recurse until area drops below plotMinArea or we
// hit the recursion cap.
export function subdividePlots(block, rand, depth = 0, out = []) {
  const w = block.maxX - block.minX;
  const d = block.maxZ - block.minZ;
  if (w * d < CITY.plotMinArea || depth >= CITY.plotBSPDepth) {
    out.push(block);
    return out;
  }
  const t = 0.40 + rand() * 0.20;
  if (w > d) {
    const xSplit = block.minX + w * t;
    subdividePlots({ ...block, maxX: xSplit }, rand, depth + 1, out);
    subdividePlots({ ...block, minX: xSplit }, rand, depth + 1, out);
  } else {
    const zSplit = block.minZ + d * t;
    subdividePlots({ ...block, maxZ: zSplit }, rand, depth + 1, out);
    subdividePlots({ ...block, minZ: zSplit }, rand, depth + 1, out);
  }
  return out;
}
