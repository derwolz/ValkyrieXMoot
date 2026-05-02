/**
 * lib/ai/ambient.js — Unaware (ambient pedestrian) AI state.
 *
 * tickUnaware(dt, moot, ctx)
 *   Moves a moot along a pathfound route between interest points at walk speed.
 *   On arrival picks a new destination 30–100 m away.
 *
 * ctx = {
 *   navGrid,          // NavGrid from buildNavGrid
 *   buildingAABBs,    // for wall slide
 *   now,              // performance.now() in ms
 * }
 */

import { AI } from '../config.js';
import { findPath } from '../nav/pathfind.js';
import { moveWithCollision } from '../nav/collision.js';

const ambientIndexByPoints = new WeakMap();
let ambientFrameNow = -1;
let ambientFrameReplans = 0;

function getInterestIndex(interestPoints) {
  const binSize = Math.max(8, AI.ambientDestBinSize || AI.destMaxDist);
  const cached = ambientIndexByPoints.get(interestPoints);
  if (cached && cached.binSize === binSize && cached.length === interestPoints.length) return cached;

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
  ambientIndexByPoints.set(interestPoints, index);
  return index;
}

function canRunAmbientReplan(now) {
  if (ambientFrameNow !== now) {
    ambientFrameNow = now;
    ambientFrameReplans = 0;
  }
  if (ambientFrameReplans >= AI.ambientMaxReplansPerFrame) return false;
  ambientFrameReplans++;
  return true;
}

function nextAmbientRetryDelay() {
  return AI.ambientReplanRetryDelay * (0.75 + Math.random() * 0.5);
}

/**
 * Pick a random destination interest point that is between destMinDist and
 * destMaxDist from the moot's current position.
 *
 * @param {{x:number, z:number}} pos
 * @param {{x:number, z:number, kind:string}[]} interestPoints
 * @returns {{x:number, z:number} | null}
 */
export function pickAmbientDest(pos, interestPoints) {
  const minSq = AI.destMinDist * AI.destMinDist;
  const maxSq = AI.destMaxDist * AI.destMaxDist;
  const index = getInterestIndex(interestPoints);
  const { binSize, bins } = index;

  const minBx = Math.floor((pos.x - AI.destMaxDist) / binSize);
  const maxBx = Math.floor((pos.x + AI.destMaxDist) / binSize);
  const minBz = Math.floor((pos.z - AI.destMaxDist) / binSize);
  const maxBz = Math.floor((pos.z + AI.destMaxDist) / binSize);

  // Reservoir sample across only nearby bins. This avoids allocating an
  // `eligible` array and avoids scanning city-wide interest points per replan.
  let chosen = null;
  let seen = 0;
  for (let bx = minBx; bx <= maxBx; bx++) {
    const zBins = bins.get(bx);
    if (!zBins) continue;
    for (let bz = minBz; bz <= maxBz; bz++) {
      const bucket = zBins.get(bz);
      if (!bucket) continue;
      for (const pt of bucket) {
        const dx = pt.x - pos.x;
        const dz = pt.z - pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < minSq || dSq > maxSq) continue;
        seen++;
        if (Math.random() * seen < 1) chosen = pt;
      }
    }
  }
  return chosen;
}

/**
 * Tick the unaware (ambient walk) state for one moot.
 *
 * The moot follows its current path waypoints at AI.walkSpeed.
 * When it arrives at the final waypoint it picks a new destination and replans.
 * If no path is set yet, one is requested immediately.
 *
 * Does NOT modify moot.state — that is handled by tickPerception in Phase 4.
 *
 * @param {number} dt seconds
 * @param {object} moot  — extended moot handle (see moots.js)
 * @param {{ navGrid: import('../nav/grid.js').NavGrid,
 *            buildingAABBs: {minX:number,maxX:number,minZ:number,maxZ:number}[],
 *            now: number }} ctx
 */
export function tickUnaware(dt, moot, ctx) {
  if (!moot.alive) return;

  const { navGrid, buildingAABBs } = ctx;
  const buildingSource = ctx.buildingGrid ?? buildingAABBs;
  const pos = moot.group.position; // THREE.Vector3, we use x and z

  // ── Ensure we have a destination and a path ───────────────────────────────
  if (!moot.destination || moot.path.length === 0) {
    if (moot._ambientReplanTimer > 0) {
      moot._ambientReplanTimer -= dt;
      return;
    }
    if (!canRunAmbientReplan(ctx.now ?? 0)) {
      moot._ambientReplanTimer = nextAmbientRetryDelay();
      return;
    }

    const dest = pickAmbientDest(pos, navGrid.interestPoints);
    if (!dest) {
      moot._ambientReplanTimer = nextAmbientRetryDelay();
      return; // No suitable point found — stay put until the bounded retry.
    }
    moot.destination = dest;
    moot.path        = findPath(navGrid, pos, dest);
    moot.pathIndex   = 0;
  }

  const path = moot.path;
  if (path.length === 0) {
    // Path was unreachable — clear and retry on a short stagger instead of
    // attempting A* again on the very next frame.
    moot.destination = null;
    moot._ambientReplanTimer = nextAmbientRetryDelay();
    return;
  }

  // ── Advance along waypoints ───────────────────────────────────────────────
  // Skip any waypoints we've already passed (within one cell of walk).
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

  // Reached end of path → pick a new destination.
  if (moot.pathIndex >= path.length) {
    moot.destination = null;
    moot.path        = [];
    moot.pathIndex   = 0;
    return;
  }

  // ── Move toward current waypoint ─────────────────────────────────────────
  const wp = path[moot.pathIndex];
  const dx = wp.x - pos.x;
  const dz = wp.z - pos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1e-4) return;

  const speed = AI.walkSpeed;
  const step  = Math.min(speed * dt, dist); // don't overshoot
  const vx    = (dx / dist) * step;
  const vz    = (dz / dist) * step;

  moveWithCollision(
    pos,                // THREE.Vector3 has .x and .z — no {x,z} wrapper needed
    vx, vz,
    1,                  // dt=1 because vx/vz already encode the full step
    buildingSource,
    0.4,                // moot collision radius
    pos,                // mutate position in place; avoids per-tick result allocation
  );
}
