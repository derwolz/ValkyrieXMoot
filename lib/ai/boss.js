/**
 * lib/ai/boss.js — Boss AI tick function.
 *
 * The boss is a tuned moot that skips the normal perception / state-machine
 * pipeline.  Once the player enters BOSS.detectRadius, aggro is permanent — it
 * never breaks.  Two sub-modes while aggroed (no LOS check anywhere):
 *
 *   engage  — player within BOSS.engageRadius (60 m)
 *             Boss kites: backs away if closer than kiteDistance, holds if at
 *             kiteDistance, advances if farther.  Fires on MOOT.armedCooldownSec
 *             cooldown.  Replans every BOSS.engageReplanInterval seconds.
 *
 *   pursue  — player beyond BOSS.engageRadius
 *             Boss pathfinds toward last known player position.
 *             Replans every BOSS.pursueReplanInterval seconds.  No firing.
 *
 * Boss state is stored directly on the moot handle:
 *   moot.bossAggro        {boolean}  — one-way latch
 *   moot.bossMode         {'engage'|'pursue'|null}
 *   moot.bossLastKnownPos {{x,z}|null}
 *   moot._bossReplanTimer {number}   — seconds until next replan
 *
 * ctx = {
 *   navGrid,         // from buildNavGrid
 *   buildingAABBs,   // [{minX,maxX,minZ,maxZ}]
 *   truckPos,        // {x,z}
 *   now,             // performance.now() ms
 *   spawnProjectile, // (origin:{x,y,z}, target:{x,z}) => void
 * }
 */

import { AI, BOSS, MOOT, NAV } from '../config.js';
import { findPath } from '../nav/pathfind.js';
import { moveWithCollision } from '../nav/collision.js';

/**
 * Tick the boss AI for one frame.
 *
 * @param {number} dt  — seconds since last frame
 * @param {object} moot — boss moot handle (isBoss === true)
 * @param {{
 *   navGrid:         object,
 *   buildingAABBs:   {minX:number,maxX:number,minZ:number,maxZ:number}[],
 *   truckPos:        {x:number,z:number},
 *   now:             number,
 *   spawnProjectile: (origin:{x:number,y:number,z:number}, target:{x:number,z:number}) => void,
 * }} ctx
 */
export function tickBoss(dt, moot, ctx) {
  if (!moot.alive) return;

  const { navGrid, buildingAABBs, truckPos, now, spawnProjectile } = ctx;
  const pos = moot.group.position; // THREE.Vector3
  // Read scalars directly — no { x, z } object allocated per frame.

  // ── Aggro latch: one-way, distance only ──────────────────────────────────────
  const dxT    = truckPos.x - pos.x;
  const dzT    = truckPos.z - pos.z;
  const distToTruck = Math.sqrt(dxT * dxT + dzT * dzT);

  if (!moot.bossAggro && distToTruck <= BOSS.detectRadius) {
    moot.bossAggro = true;
  }

  if (!moot.bossAggro) return; // not yet aggroed — stand still

  // Update last known position every tick (no LOS check — boss always "knows").
  // Mutate in place — avoid allocating a new {x,z} object every frame.
  if (moot.bossLastKnownPos) {
    moot.bossLastKnownPos.x = truckPos.x;
    moot.bossLastKnownPos.z = truckPos.z;
  } else {
    moot.bossLastKnownPos = { x: truckPos.x, z: truckPos.z };
  }

  // ── Choose mode ───────────────────────────────────────────────────────────────
  const prevMode  = moot.bossMode;
  const newMode   = distToTruck <= BOSS.engageRadius ? 'engage' : 'pursue';

  if (newMode !== prevMode) {
    // Mode switched — clear path so we replan immediately.
    moot.bossMode         = newMode;
    moot.path             = [];
    moot.pathIndex        = 0;
    moot.destination      = null;
    moot._bossReplanTimer = 0;
  }

  // ── Engage mode: kite + fire ──────────────────────────────────────────────────
  if (moot.bossMode === 'engage') {
    _tickEngage(dt, moot, pos, truckPos, distToTruck, navGrid, buildingAABBs, spawnProjectile, now);
    return;
  }

  // ── Pursue mode: pathfind toward last known position ─────────────────────────
  _tickPursue(dt, moot, pos, navGrid, buildingAABBs);
}

// ---------------------------------------------------------------------------
// Engage sub-tick: kite at BOSS.kiteDistance, fire at truck.
// ---------------------------------------------------------------------------
function _tickEngage(dt, moot, pos, truckPos, distToTruck, navGrid, buildingAABBs, spawnProjectile, now) {
  // pos is moot.group.position (THREE.Vector3), read directly — no per-frame copy.

  // Decay replan timer
  moot._bossReplanTimer -= dt;

  // ── Kite movement ─────────────────────────────────────────────────────────────
  // Direction from truck → boss (boss wants to be ~kiteDistance away).
  const dx = pos.x - truckPos.x;
  const dz = pos.z - truckPos.z;
  const dist = distToTruck;

  // Desired position = truck + normalize(boss - truck) * kiteDistance
  // Boss moves: advance if dist > kiteDistance, retreat if dist < kiteDistance.
  // Use a proportional speed scaled to the displacement from kiteDistance.
  const kiteErr = dist - BOSS.kiteDistance; // positive = too far (advance), negative = too close (retreat)

  // Boss moves toward kiteDistance at AI.fleeSpeed (same as regular flee).
  // If too close, move away (retreat); if too far, move closer (advance).
  const moveSpeed = AI.fleeSpeed;
  let vx = 0;
  let vz = 0;

  if (Math.abs(kiteErr) > 1.0 && dist > 0.01) {
    // Unit vector from truck toward boss.
    const nx = dx / dist;
    const nz = dz / dist;

    if (kiteErr < 0) {
      // Too close — retreat (move away from truck).
      vx = nx * moveSpeed * dt;
      vz = nz * moveSpeed * dt;
    } else {
      // Too far — advance (move toward truck).
      vx = -nx * moveSpeed * dt;
      vz = -nz * moveSpeed * dt;
    }

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

  // ── Fire at truck on cooldown ─────────────────────────────────────────────────
  moot.gunCooldown -= dt;
  if (moot.gunCooldown <= 0) {
    const origin = {
      x: pos.x,
      y: MOOT.projectileSpawnHeight,
      z: pos.z,
    };
    if (spawnProjectile) spawnProjectile(origin, truckPos);
    moot.gunCooldown = MOOT.armedCooldownSec;
  }
}

// ---------------------------------------------------------------------------
// Pursue sub-tick: pathfind toward last known player position.
// ---------------------------------------------------------------------------
function _tickPursue(dt, moot, pos, navGrid, buildingAABBs) {
  const replanInterval = BOSS.pursueReplanInterval;
  moot._bossReplanTimer -= dt;

  const target = moot.bossLastKnownPos;
  if (!target) return;

  // Replan when timer expires or path is exhausted.
  const needsReplan =
    moot._bossReplanTimer <= 0 ||
    !moot.path ||
    moot.path.length === 0 ||
    moot.pathIndex >= moot.path.length;

  if (needsReplan) {
    // { x, z } literal only allocated when actually replanning — not every frame.
    moot.path             = findPath(navGrid, { x: pos.x, z: pos.z }, target);
    moot.pathIndex        = 0;
    moot.destination      = target;
    moot._bossReplanTimer = replanInterval;
  }

  // Walk the path at fleeSpeed (boss moves fast).
  const path = moot.path;
  if (!path || path.length === 0) return;

  const arrivalRadius = (navGrid.cellSize || NAV.cellSize) * 1.5;
  const arrivalSq    = arrivalRadius * arrivalRadius;

  // Advance past already-reached waypoints.
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
    moot.path        = [];
    moot.pathIndex   = 0;
    moot.destination = null;
    return;
  }

  const wp   = path[moot.pathIndex];
  const dx   = wp.x - pos.x;
  const dz   = wp.z - pos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1e-4) return;

  const speed = AI.fleeSpeed; // boss pursues at same speed as regular flee
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
