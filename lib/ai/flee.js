/**
 * lib/ai/flee.js — alarmed-flee state behavior.
 *
 * tickFlee(dt, moot, ctx)
 *   Moves a moot away from the truck at flee speed.
 *   Replans every fleeReplanMin–fleeReplanMax seconds while truck is in LOS.
 *   Goal = nav cell maximising (dist from truck) - 0.5*(dist from moot),
 *   sampled from a ring 30–60 m from the moot; prefers cells with lower cost
 *   (i.e. alleys).
 *
 * ctx = {
 *   navGrid,        // from buildNavGrid
 *   buildingAABBs,  // [{minX,maxX,minZ,maxZ}]
 *   truckPos,       // {x,z}
 *   now,            // performance.now() in ms
 * }
 */

import { AI } from '../config.js';
import { findPath } from '../nav/pathfind.js';
import { moveWithCollision } from '../nav/collision.js';
import { hasLOS } from './perception.js';

// How many candidate cells to sample when choosing a flee destination.
const FLEE_SAMPLES = 12;

/**
 * Choose a flee destination: sample FLEE_SAMPLES random interest-points in
 * [fleeSampleRingMin, fleeSampleRingMax] from the moot, score each as
 *   score = dist(pt, truck) - 0.5 * dist(pt, moot)
 * and return the highest-scoring one.  If none qualify, returns null.
 *
 * @param {{x:number,z:number}} mootPos
 * @param {{x:number,z:number}} truckPos
 * @param {{x:number,z:number,kind:string}[]} interestPoints
 * @returns {{x:number,z:number}|null}
 */
export function pickFleeDest(mootPos, truckPos, interestPoints) {
  const minR = AI.fleeSampleRingMin;
  const maxR = AI.fleeSampleRingMax;
  const minSq = minR * minR;
  const maxSq = maxR * maxR;

  // Collect eligible points in the ring.
  const eligible = [];
  for (const pt of interestPoints) {
    const dx = pt.x - mootPos.x;
    const dz = pt.z - mootPos.z;
    const dSq = dx * dx + dz * dz;
    if (dSq >= minSq && dSq <= maxSq) eligible.push(pt);
  }
  if (eligible.length === 0) return null;

  // Sample up to FLEE_SAMPLES, pick best score.
  const sample = [];
  if (eligible.length <= FLEE_SAMPLES) {
    sample.push(...eligible);
  } else {
    // Reservoir-sample FLEE_SAMPLES items.
    for (let i = 0; i < FLEE_SAMPLES; i++) {
      const idx = Math.floor(Math.random() * eligible.length);
      sample.push(eligible[idx]);
    }
  }

  let best = null;
  let bestScore = -Infinity;
  for (const pt of sample) {
    const dtx = pt.x - truckPos.x;
    const dtz = pt.z - truckPos.z;
    const distToTruck = Math.sqrt(dtx * dtx + dtz * dtz);

    const dmx = pt.x - mootPos.x;
    const dmz = pt.z - mootPos.z;
    const distToMoot = Math.sqrt(dmx * dmx + dmz * dmz);

    const score = distToTruck - 0.5 * distToMoot;
    if (score > bestScore) {
      bestScore = score;
      best = pt;
    }
  }
  return best;
}

/**
 * Tick alarmed-flee state for one moot.
 * Does NOT modify moot.state — tickPerception owns transitions.
 *
 * @param {number} dt
 * @param {object} moot
 * @param {{ navGrid: object, buildingAABBs: object[], truckPos: {x:number,z:number}, now: number }} ctx
 */
export function tickFlee(dt, moot, ctx) {
  if (!moot.alive) return;

  const { navGrid, buildingAABBs, truckPos, now } = ctx;
  const pos = moot.group.position; // THREE.Vector3

  // ── Replan if needed ─────────────────────────────────────────────────────────
  const nowSec = now / 1000;
  const timeSinceReplan = nowSec - moot.lastReplanAt;

  // First call or replan interval elapsed: pick new flee destination.
  const needsReplan = !moot.destination || moot.path.length === 0 || timeSinceReplan >= AI.fleeReplanMin;

  if (needsReplan) {
    // Update replan timestamp unconditionally — even if no valid destination is
    // found we must not retry on the very next frame (busy-spin).  The next
    // attempt will happen at least AI.fleeReplanMin seconds from now.
    moot.lastReplanAt = nowSec;
    const dest = pickFleeDest(
      { x: pos.x, z: pos.z },
      truckPos,
      navGrid.interestPoints,
    );
    if (dest) {
      moot.destination = dest;
      moot.path        = findPath(navGrid, { x: pos.x, z: pos.z }, dest);
      moot.pathIndex   = 0;
    }
  }

  // ── Walk the path at flee speed ──────────────────────────────────────────────
  const path = moot.path;
  if (!path || path.length === 0) return;

  const arrivalRadius = navGrid.cellSize * 1.5;
  const arrivalSq    = arrivalRadius * arrivalRadius;

  // Skip waypoints already reached.
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
    // Reached flee destination; clear so we replan next frame.
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

  const speed = AI.fleeSpeed;
  const step  = Math.min(speed * dt, dist);
  const vx    = (dx / dist) * step;
  const vz    = (dz / dist) * step;

  const newPos = moveWithCollision(
    { x: pos.x, z: pos.z },
    vx, vz,
    1,
    buildingAABBs,
    moot.collisionRadius,
  );
  pos.x = newPos.x;
  pos.z = newPos.z;
}
