/**
 * lib/ai/perception.js — Per-moot threat sensing and state transition machine.
 *
 * tickPerception(dt, moot, ctx)
 *   Updates moot.threat based on proximity / LOS / events, then fires
 *   state transitions according to the table in CITY_AND_AI_PLAN.md.
 *
 * ctx = {
 *   truckPos:     { x, z }      — current truck world position
 *   truckVelX:    number        — truck velocity X component (m/s)
 *   truckVelZ:    number        — truck velocity Z component (m/s)
 *   buildingAABBs: [{minX,maxX,minZ,maxZ}]
 *   now:          number        — performance.now() in ms
 *   recentKills:  [{x,z,at}]   — kill events in the last few seconds
 *   recentShots:  [{x,z,at}]   — gunshot events
 * }
 *
 * State machine (string literals match handle.state):
 *   'unaware'      → 'alarmed-flee' | 'alarmed-armed'  when threat ≥ AI.threatEnterFlee
 *   'alarmed-flee'
 *   'alarmed-armed' → 'recovering'  when threat < AI.threatExitAlarm for AI.alarmExitSeconds
 *                                    AND truck dist > AI.threatExitDistance
 *   'recovering'   → 'unaware'      after AI.recoverySeconds clean
 *   'recovering'   → 'alarmed-*'    if threat ≥ AI.threatEnterFlee again
 *
 * Boss moots (moot.isBoss === true) are skipped entirely.
 */

import { AI } from '../config.js';
import { queryRegion } from '../world/spatialGrid.js';

// ---------------------------------------------------------------------------
// LOS raycast — 2-D segment vs AABB list (top-down).
// Returns true if the straight line from `a` to `b` is unobstructed.
// ---------------------------------------------------------------------------

/**
 * @param {{x:number,z:number}} a
 * @param {{x:number,z:number}} b
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}[]} aabbs
 * @returns {boolean}
 */
export function hasLOS(a, b, aabbs) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;

  // Cull to segment bounding box when a spatial grid is provided.
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minZ = Math.min(a.z, b.z);
  const maxZ = Math.max(a.z, b.z);
  const candidates = queryRegion(aabbs, minX, maxX, minZ, maxZ);

  for (const aabb of candidates) {
    if (segmentIntersectsAABB(a.x, a.z, dx, dz, aabb)) return false;
  }
  return true;
}

/**
 * Slab method: intersect ray (ox,oz) + t*(dx,dz) with AABB.
 * Returns true if the segment [0..1] hits the AABB.
 */
function segmentIntersectsAABB(ox, oz, dx, dz, aabb) {
  let tMin = 0;
  let tMax = 1;

  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (ox < aabb.minX || ox > aabb.maxX) return false;
  } else {
    const invDx = 1 / dx;
    let t1 = (aabb.minX - ox) * invDx;
    let t2 = (aabb.maxX - ox) * invDx;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  // Z slab
  if (Math.abs(dz) < 1e-9) {
    if (oz < aabb.minZ || oz > aabb.maxZ) return false;
  } else {
    const invDz = 1 / dz;
    let t1 = (aabb.minZ - oz) * invDz;
    let t2 = (aabb.maxZ - oz) * invDz;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  return tMin <= tMax;
}

// ---------------------------------------------------------------------------
// tickPerception
// ---------------------------------------------------------------------------

/**
 * @param {number} dt  — seconds since last frame
 * @param {object} moot — extended handle (state, threat, stateEnteredAt, …)
 * @param {{
 *   truckPos:     {x:number,z:number},
 *   truckVelX:    number,
 *   truckVelZ:    number,
 *   buildingAABBs: {minX:number,maxX:number,minZ:number,maxZ:number}[],
 *   now:          number,
 *   recentKills:  {x:number,z:number,at:number}[],
 *   recentShots:  {x:number,z:number,at:number}[],
 * }} ctx
 */
export function tickPerception(dt, moot, ctx) {
  // Boss AI is managed separately — skip.
  if (moot.isBoss) return;
  if (!moot.alive) return;

  const { truckPos, truckVelX, truckVelZ, buildingAABBs, buildingGrid, now, recentKills, recentShots } = ctx;
  const buildingSource = buildingGrid ?? buildingAABBs;
  // Read position directly from Three.js object — no {x,z} allocation each frame.
  const mpx = moot.group.position.x;
  const mpz = moot.group.position.z;

  // ── Compute raw threat delta this frame ─────────────────────────────────

  let threatDelta = -AI.threatDecayRate * dt; // passive decay

  const dxTruck = truckPos.x - mpx;
  const dzTruck = truckPos.z - mpz;
  const distTruck = Math.sqrt(dxTruck * dxTruck + dzTruck * dzTruck);

  // Within 8 m — threat regardless of LOS.
  if (distTruck < 8) {
    threatDelta += 0.8;
  } else if (distTruck < 25) {
    // LOS check only needed in the 8–25 m band.
    // moot.group.position (THREE.Vector3) has .x/.z; pass it directly—no {x,z} allocation.
    if (hasLOS(moot.group.position, truckPos, buildingSource)) {
      threatDelta += 0.6;
    }
  }

  // Truck velocity toward moot > 6 m/s.
  // dxTruck = truckPos - mootPos, so the truck→moot unit vector is its negation.
  if (distTruck > 0.1) {
    const toMootX = -dxTruck / distTruck;  // unit vector truck → moot
    const toMootZ = -dzTruck / distTruck;
    const vToward = truckVelX * toMootX + truckVelZ * toMootZ;
    if (vToward > 6) {
      threatDelta += 0.3;
    }
  }

  // A moot was killed within 15 m in the last 4 s.
  // recentKills is already pruned by the caller (main.js); iterate from cursor.
  if (recentKills) {
    const cursor = ctx.recentKillsCursor || 0;
    for (let i = cursor; i < recentKills.length; i++) {
      const kill = recentKills[i];
      const dkx = kill.x - mpx;
      const dkz = kill.z - mpz;
      if (dkx * dkx + dkz * dkz < 15 * 15) {
        threatDelta += 0.5;
        break;
      }
    }
  }

  // Heard gunshot within 30 m.
  // recentShots is already pruned by the caller; iterate from cursor.
  if (recentShots) {
    const cursor = ctx.recentShotsCursor || 0;
    for (let i = cursor; i < recentShots.length; i++) {
      const shot = recentShots[i];
      const dsx = shot.x - mpx;
      const dsz = shot.z - mpz;
      if (dsx * dsx + dsz * dsz < 30 * 30) {
        threatDelta += 0.3;
        break;
      }
    }
  }

  // Clamp threat to [0, 1].
  moot.threat = Math.max(0, Math.min(1, moot.threat + threatDelta));

  // ── State transitions ─────────────────────────────────────────────────────

  const state = moot.state;
  const nowSec = now / 1000;

  if (state === 'unaware') {
    if (moot.threat >= AI.threatEnterFlee) {
      // Transition: unaware → alarmed-flee (or alarmed-armed if moot.armed).
      moot.state         = moot.armed ? 'alarmed-armed' : 'alarmed-flee';
      moot.stateEnteredAt = nowSec;
      moot._alarmExitTimer = 0;
      // Clear ambient path so flee/armed can pick their own target.
      moot.path        = [];
      moot.pathIndex   = 0;
      moot.destination = null;
    }

  } else if (state === 'alarmed-flee' || state === 'alarmed-armed') {
    if (moot.threat < AI.threatExitAlarm && distTruck > AI.threatExitDistance) {
      moot._alarmExitTimer += dt;
      if (moot._alarmExitTimer >= AI.alarmExitSeconds) {
        moot.state          = 'recovering';
        moot.stateEnteredAt = nowSec;
        moot._recoveryTimer = 0;
        moot.path           = [];
        moot.pathIndex      = 0;
        moot.destination    = null;
      }
    } else {
      // Conditions not met — reset the exit timer.
      moot._alarmExitTimer = 0;
    }

  } else if (state === 'recovering') {
    // Re-alarm immediately if threat spikes.
    if (moot.threat >= AI.threatEnterFlee) {
      moot.state          = moot.armed ? 'alarmed-armed' : 'alarmed-flee';
      moot.stateEnteredAt = nowSec;
      moot._alarmExitTimer = 0;
      moot.path        = [];
      moot.pathIndex   = 0;
      moot.destination = null;
    } else {
      moot._recoveryTimer += dt;
      if (moot._recoveryTimer >= AI.recoverySeconds) {
        moot.state          = 'unaware';
        moot.stateEnteredAt = nowSec;
        moot.destination    = null;
        moot.path           = [];
        moot.pathIndex      = 0;
      }
    }
  }
}
