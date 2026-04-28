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

  // Collect eligible points.
  const eligible = [];
  for (const pt of interestPoints) {
    const dx = pt.x - pos.x;
    const dz = pt.z - pos.z;
    const dSq = dx * dx + dz * dz;
    if (dSq >= minSq && dSq <= maxSq) eligible.push(pt);
  }
  if (eligible.length === 0) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
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
  const pos = moot.group.position; // THREE.Vector3, we use x and z

  // ── Ensure we have a destination and a path ───────────────────────────────
  if (!moot.destination || moot.path.length === 0) {
    const dest = pickAmbientDest({ x: pos.x, z: pos.z }, navGrid.interestPoints);
    if (!dest) return; // No suitable point found — stay put this frame.
    moot.destination = dest;
    moot.path        = findPath(navGrid, { x: pos.x, z: pos.z }, dest);
    moot.pathIndex   = 0;
  }

  const path = moot.path;
  if (path.length === 0) {
    // Path was unreachable — clear and retry next frame.
    moot.destination = null;
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

  const newPos = moveWithCollision(
    { x: pos.x, z: pos.z },
    vx, vz,
    1,                  // dt=1 because vx/vz already encode the full step
    buildingAABBs,
    0.4,                // moot collision radius
  );

  pos.x = newPos.x;
  pos.z = newPos.z;
}
