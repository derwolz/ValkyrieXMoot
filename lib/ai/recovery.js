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
import { queryRegion } from '../world/spatialGrid.js';

/**
 * Pick the nearest interest point that is at least some minimum distance
 * away from the moot (so they don't instantly arrive and stop).
 */
function pickNearestDest(mootPos, interestPoints) {
  const minSq = 5 * 5; // must be at least 5 m away
  let best = null;
  let bestSq = Infinity;
  for (const pt of interestPoints) {
    const dx = pt.x - mootPos.x;
    const dz = pt.z - mootPos.z;
    const dSq = dx * dx + dz * dz;
    if (dSq < minSq) continue;
    if (dSq < bestSq) {
      bestSq = dSq;
      best = pt;
    }
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
  const pos    = moot.group.position;
  const nowSec = now / 1000;

  // ── Periodic glance back ──────────────────────────────────────────────────────
  moot._glanceTimer += dt;
  if (moot._glanceTimer >= AI.recoveryGlanceInterval) {
    moot._glanceTimer = 0;
    // Read position scalars directly — no {x,z} allocation per glance.
    if (hasLOS({ x: pos.x, z: pos.z }, truckPos, buildingSource)) {
      moot.threat = Math.min(1, moot.threat + AI.recoveryGlanceThreat);
    }
  }

  // ── Walk toward nearest interest point ───────────────────────────────────────
  if (!moot.destination || moot.path.length === 0) {
    const dest = pickNearestDest({ x: pos.x, z: pos.z }, navGrid.interestPoints);
    if (!dest) return;
    moot.destination = dest;
    moot.path        = findPath(navGrid, { x: pos.x, z: pos.z }, dest);
    moot.pathIndex   = 0;
  }

  const path = moot.path;
  if (!path || path.length === 0) return;

  const arrivalRadius = navGrid.cellSize * 1.5;
  const arrivalSq    = arrivalRadius * arrivalRadius;

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
    moot.path        = [];
    moot.pathIndex   = 0;
    return;
  }

  const wp   = path[moot.pathIndex];
  const dx   = wp.x - pos.x;
  const dz   = wp.z - pos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1e-4) return;

  const speed = AI.recoveryWalkSpeed;
  const step  = Math.min(speed * dt, dist);
  const vx    = (dx / dist) * step;
  const vz    = (dz / dist) * step;

  const newPos = moveWithCollision(
    { x: pos.x, z: pos.z },
    vx, vz,
    1,
    buildingSource,
    moot.collisionRadius,
  );
  pos.x = newPos.x;
  pos.z = newPos.z;
}
