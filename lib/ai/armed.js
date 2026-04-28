/**
 * lib/ai/armed.js — alarmed-armed state behavior.
 *
 * tickArmed(dt, moot, ctx)
 *   Stops the moot, faces the truck, fires on cooldown.
 *   Drops to alarmed-flee if the truck closes within AI.armedDropFleeRadius.
 *   Enters recovering if truck loses LOS for > AI.armedLostLosSeconds.
 *
 * ctx = {
 *   navGrid,        // from buildNavGrid
 *   buildingAABBs,  // [{minX,maxX,minZ,maxZ}]
 *   truckPos,       // {x,z}
 *   now,            // performance.now() in ms
 *   scene,          // THREE.Scene for projectile spawning
 *   onFire,         // optional callback () called when moot fires
 * }
 *
 * Projectile firing reuses the same spawnProjectile-compatible data path as
 * the existing updateMootGunfire but via the spawnArmedProjectile helper
 * exported from moots.js. We call a ctx.spawnProjectile(origin, target)
 * callback so the armed module stays scene-free and testable.
 */

import { AI, MOOT } from '../config.js';
import { hasLOS } from './perception.js';

/**
 * Tick alarmed-armed state for one moot.
 * Does NOT own state transitions from armed→flee or armed→recovering;
 * those are managed here by directly mutating moot.state so tickPerception
 * has accurate state on the next frame.  (The transitions are simple and
 * per-spec so it's cleaner to co-locate them with the behavior.)
 *
 * @param {number} dt
 * @param {object} moot
 * @param {{
 *   buildingAABBs: {minX:number,maxX:number,minZ:number,maxZ:number}[],
 *   truckPos:      {x:number,z:number},
 *   now:           number,
 *   spawnProjectile: (origin:{x:number,y:number,z:number}, target:{x:number,z:number}) => void,
 * }} ctx
 */
export function tickArmed(dt, moot, ctx) {
  if (!moot.alive) return;
  if (!moot.armed) return; // safety guard — non-armed moots shouldn't be here

  const { buildingAABBs, truckPos, now, spawnProjectile } = ctx;
  const pos    = moot.group.position;
  // Read position scalars directly to avoid a {x,z} allocation each frame.
  const mpx = pos.x;
  const mpz = pos.z;
  const nowSec  = now / 1000;

  // Distance to truck.
  const dxT = truckPos.x - mpx;
  const dzT = truckPos.z - mpz;
  const distTruck = Math.sqrt(dxT * dxT + dzT * dzT);

  // ── Transition: armed → flee if truck gets too close ─────────────────────────
  if (distTruck < AI.armedDropFleeRadius) {
    moot.state          = 'alarmed-flee';
    moot.stateEnteredAt = nowSec;
    moot._alarmExitTimer = 0;
    moot.path        = [];
    moot.pathIndex   = 0;
    moot.destination = null;
    return;
  }

  // ── LOS check: track how long we've lost LOS ─────────────────────────────────
  const los = hasLOS({ x: mpx, z: mpz }, truckPos, buildingAABBs);
  if (los) {
    moot._armedLosTimer = 0; // reset lost-LOS timer
    moot.lastSeenTruckAt = nowSec;
  } else {
    moot._armedLosTimer += dt;
    if (moot._armedLosTimer >= AI.armedLostLosSeconds) {
      // Lost LOS for too long → recovering.
      moot.state          = 'recovering';
      moot.stateEnteredAt = nowSec;
      moot._recoveryTimer = 0;
      moot._armedLosTimer = 0;
      moot.path        = [];
      moot.pathIndex   = 0;
      moot.destination = null;
      return;
    }
  }

  // ── Fire at truck on cooldown (only when we have LOS) ────────────────────────
  if (los) {
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

  // Armed moots stand still — no movement update.
}
