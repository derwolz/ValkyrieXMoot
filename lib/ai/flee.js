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

// How many candidate cells to sample when choosing a flee destination.
const FLEE_SAMPLES = 12;

function nextFleeReplanDelay() {
  const span = Math.max(0, AI.fleeReplanMax - AI.fleeReplanMin);
  return AI.fleeReplanMin + Math.random() * span;
}

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
  const count = interestPoints.length;
  if (count === 0) return null;

  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let accepted = 0;
  const maxTries = Math.min(count, FLEE_SAMPLES * 6);

  for (let i = 0; i < maxTries && accepted < FLEE_SAMPLES; i++) {
    const pt = interestPoints[Math.floor(Math.random() * count)];
    const dmx = pt.x - mootPos.x;
    const dmz = pt.z - mootPos.z;
    const dSq = dmx * dmx + dmz * dmz;
    if (dSq < minSq || dSq > maxSq) continue;
    accepted++;

    const dtx = pt.x - truckPos.x;
    const dtz = pt.z - truckPos.z;
    const distToTruck = Math.sqrt(dtx * dtx + dtz * dtz);
    const distToMoot = Math.sqrt(dSq);
    const score = distToTruck - 0.5 * distToMoot;
    if (score > bestScore) {
      bestScore = score;
      best = pt;
    }
  }

  if (best) return best;

  // Sparse/local edge case: fall back to a single reservoir pass without
  // allocating eligible/sample arrays, then score the sampled candidate.
  let sampled = null;
  let seen = 0;
  for (const pt of interestPoints) {
    const dx = pt.x - mootPos.x;
    const dz = pt.z - mootPos.z;
    const dSq = dx * dx + dz * dz;
    if (dSq < minSq || dSq > maxSq) continue;
    seen++;
    if (Math.random() * seen < 1) sampled = pt;
  }
  return sampled;
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
  const buildingSource = ctx.buildingGrid ?? buildingAABBs;
  const pos = moot.group.position; // THREE.Vector3

  // ── Replan if needed ─────────────────────────────────────────────────────────
  const nowSec = now / 1000;
  const timeSinceReplan = nowSec - moot.lastReplanAt;

  const replanDelay = moot._fleeReplanDelay ?? AI.fleeReplanMin;

  // First call or replan interval elapsed: pick new flee destination.
  const needsReplan = !moot.destination || moot.path.length === 0 || timeSinceReplan >= replanDelay;

  if (needsReplan) {
    // Update replan timestamp unconditionally — even if no valid destination is
    // found we must not retry on the very next frame (busy-spin).  The next
    // attempt will happen at least AI.fleeReplanMin seconds from now.
    moot.lastReplanAt = nowSec;
    moot._fleeReplanDelay = nextFleeReplanDelay();
    const dest = pickFleeDest(
      pos, // THREE.Vector3 — has .x and .z, no wrapper needed
      truckPos,
      navGrid.interestPoints,
    );
    if (dest) {
      moot.destination = dest;
      moot.path = findPath(navGrid, pos, dest);
      moot.pathIndex = 0;
    }
  }

  // ── Walk the path at flee speed ──────────────────────────────────────────────
  const path = moot.path;
  if (!path || path.length === 0) return;

  const arrivalRadius = navGrid.cellSize * 1.5;
  const arrivalSq = arrivalRadius * arrivalRadius;

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
    moot.path = [];
    moot.pathIndex = 0;
    return;
  }

  const wp = path[moot.pathIndex];
  const dx = wp.x - pos.x;
  const dz = wp.z - pos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1e-4) return;

  const speed = AI.fleeSpeed;
  const step = Math.min(speed * dt, dist);
  const vx = (dx / dist) * step;
  const vz = (dz / dist) * step;

  moveWithCollision(
    pos, // THREE.Vector3 has .x and .z — pass directly, no {x,z} wrapper
    vx,
    vz,
    1,
    buildingSource,
    moot.collisionRadius,
    pos, // mutate position in place; avoids per-tick result allocation
  );
}
