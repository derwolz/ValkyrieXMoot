/**
 * lib/ai/recovery.js — recovering state behavior.
 *
 * tickRecovery(dt, moot, ctx)
 *   Walks the moot toward the nearest interest point at recoveryWalkSpeed.
 *   Every recoveryGlanceInterval seconds, glances back: if the truck has LOS,
 *   adds recoveryGlanceThreat to moot.threat.
 *   After AI.recoverySeconds clean → unaware (handled by tickPerception;
 *   here we just keep the moot walking and glancing).
 *
 * ctx = {
 *   navGrid,
 *   buildingAABBs,
 *   truckPos,
 *   now,
 * }
 */

import { AI } from '../config.js';
import { findPath } from '../nav/pathfind.js';
import { moveWithCollision } from '../nav/collision.js';
import { hasLOS } from './perception.js';

const recoveryIndexByPoints = new WeakMap();

function getRecoveryInterestIndex(interestPoints) {
  const binSize = Math.max(8, AI.ambientDestBinSize || AI.destMaxDist);
  const cached = recoveryIndexByPoints.get(interestPoints);
  if (cached && cached.binSize === binSize && cached.length === interestPoints.length)
    return cached;

  const bins = new Map();
  for (const pt of interestPoints) {
    const bx = Math.floor(pt.x / binSize);
    const bz = Math.floor(pt.z / binSize);
    let zBins = bins.get(bx);
    if (!zBins) {
      zBins = new Map();
      bins.set(bx, zBins);
    }
    let bucket = zBins.get(bz);
    if (!bucket) {
      bucket = [];
      zBins.set(bz, bucket);
    }
    bucket.push(pt);
  }

  const index = { binSize, bins, length: interestPoints.length };
  recoveryIndexByPoints.set(interestPoints, index);
  return index;
}

function visitRecoveryBin(index, bx, bz, mootPos, minSq, currentBest, currentBestSq) {
  const zBins = index.bins.get(bx);
  if (!zBins) return { best: currentBest, bestSq: currentBestSq };
  const bucket = zBins.get(bz);
  if (!bucket) return { best: currentBest, bestSq: currentBestSq };

  let best = currentBest;
  let bestSq = currentBestSq;
  for (const pt of bucket) {
    const dx = pt.x - mootPos.x;
    const dz = pt.z - mootPos.z;
    const dSq = dx * dx + dz * dz;
    if (dSq < minSq || dSq >= bestSq) continue;
    bestSq = dSq;
    best = pt;
  }
  return { best, bestSq };
}

/**
 * Pick the nearest interest point that is at least some minimum distance
 * away from the moot (so they don't instantly arrive and stop).
 */
function pickNearestDest(mootPos, interestPoints) {
  const minSq = 5 * 5; // must be at least 5 m away
  const index = getRecoveryInterestIndex(interestPoints);
  const { binSize } = index;
  const centerBx = Math.floor(mootPos.x / binSize);
  const centerBz = Math.floor(mootPos.z / binSize);

  let best = null;
  let bestSq = Number.POSITIVE_INFINITY;
  const maxRing = 4;
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let bx = centerBx - ring; bx <= centerBx + ring; bx++) {
      for (let bz = centerBz - ring; bz <= centerBz + ring; bz++) {
        if (
          ring > 0 &&
          bx !== centerBx - ring &&
          bx !== centerBx + ring &&
          bz !== centerBz - ring &&
          bz !== centerBz + ring
        )
          continue;
        const found = visitRecoveryBin(index, bx, bz, mootPos, minSq, best, bestSq);
        best = found.best;
        bestSq = found.bestSq;
      }
    }
    // Once a local bin ring has a destination, farther rings cannot affect the
    // visible goal choice enough to justify a city-wide scan on a replan spike.
    if (best) return best;
  }
  return best;
}

/**
 * @param {number} dt
 * @param {object} moot
 * @param {{ navGrid: object, buildingAABBs: object[], truckPos: {x:number,z:number}, now: number }} ctx
 */
export function tickRecovery(dt, moot, ctx) {
  if (!moot.alive) return;

  const { navGrid, buildingAABBs, truckPos, now } = ctx;
  const buildingSource = ctx.buildingGrid ?? buildingAABBs;
  const pos = moot.group.position;
  const _nowSec = now / 1000;

  // ── Periodic glance back ──────────────────────────────────────────────────────
  moot._glanceTimer += dt;
  if (moot._glanceTimer >= AI.recoveryGlanceInterval) {
    moot._glanceTimer = 0;
    // THREE.Vector3 has the x/z fields hasLOS needs — no wrapper allocation.
    if (hasLOS(pos, truckPos, buildingSource)) {
      moot.threat = Math.min(1, moot.threat + AI.recoveryGlanceThreat);
    }
  }

  // ── Walk toward nearest interest point ───────────────────────────────────────
  if (!moot.destination || moot.path.length === 0) {
    const dest = pickNearestDest(pos, navGrid.interestPoints);
    if (!dest) return;
    moot.destination = dest;
    moot.path = findPath(navGrid, pos, dest);
    moot.pathIndex = 0;
  }

  const path = moot.path;
  if (!path || path.length === 0) return;

  const arrivalRadius = navGrid.cellSize * 1.5;
  const arrivalSq = arrivalRadius * arrivalRadius;

  while (moot.pathIndex < path.length) {
    const wp = path[moot.pathIndex];
    const dx = wp.x - pos.x;
    const dz = wp.z - pos.z;
    if (dx * dx + dz * dz <= arrivalSq) {
      moot.pathIndex++;
    } else {
      break;
    }
  }

  if (moot.pathIndex >= path.length) {
    // Arrived — clear and let next tick pick another point.
    moot.destination = null;
    moot.path = [];
    moot.pathIndex = 0;
    return;
  }

  const wp = path[moot.pathIndex];
  const dx = wp.x - pos.x;
  const dz = wp.z - pos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1e-4) return;

  const speed = AI.recoveryWalkSpeed;
  const step = Math.min(speed * dt, dist);
  const vx = (dx / dist) * step;
  const vz = (dz / dist) * step;

  moveWithCollision(pos, vx, vz, 1, buildingSource, moot.collisionRadius, pos);
}
