import * as THREE from 'three';
import { CAR, MOOT } from '../config.js';
import { makeNameTexture } from '../nameTexture.js';
export { tickUnaware, pickAmbientDest } from '../ai/ambient.js';

// ---------------------------------------------------------------------------
// Legacy projectile stubs — the new AI pipeline (armed.js / boss.js) owns
// all bullet creation via ctx.spawnProjectile in main.js.  These stubs keep
// the import surface stable for any remaining callers.
// ---------------------------------------------------------------------------

/** @deprecated No longer used — AI pipeline owns bullet spawning. */
export function getProjectiles() { return []; }

/** Remove legacy projectiles from scene.  No-op: array is always empty. */
export function clearMootProjectiles(_scene) {}

// ---------------------------------------------------------------------------
// buildMoot — construct a Three.js Group for one moot row and add it to scene.
// ---------------------------------------------------------------------------

/**
 * Build a moot Group (avatar sprite + name label).
 * Returns a moot handle used throughout the game loop.
 *
 * @param {import('../data/mootLoader.js').MootRow} row
 * @param {import('three').Scene} scene
 * @param {{ addToScene?: boolean }} [opts]
 * @returns {{ group: import('three').Group, avatarMat: import('three').SpriteMaterial, alive: boolean, mootRow: import('../data/mootLoader.js').MootRow }}
 */
export function buildMoot(row, scene, { addToScene = true } = {}) {
  const group = new THREE.Group();

  const avatarMat = new THREE.SpriteMaterial({ transparent: true, depthTest: true });
  const avatar = new THREE.Sprite(avatarMat);
  avatar.scale.set(MOOT.spriteScale, MOOT.spriteScale, 1);
  avatar.position.y = MOOT.spriteScale / 2;
  group.add(avatar);

  const { texture: nameTex, aspect: nameAspect } = makeNameTexture(row.display_name);
  const nameMat = new THREE.SpriteMaterial({ map: nameTex, transparent: true, depthTest: false });
  const nameSprite = new THREE.Sprite(nameMat);
  nameSprite.scale.set(MOOT.nameHeightUnits * nameAspect, MOOT.nameHeightUnits, 1);
  nameSprite.position.y = MOOT.spriteScale + MOOT.nameHeightUnits / 2 + 0.3;
  group.add(nameSprite);

  if (addToScene) scene.add(group);
  // mootRow stored on the handle so postKill can reference the username/handle.
  const handle = {
    group,
    avatarMat,
    alive: true,
    mootRow: row,
    // ── AI state fields (Phase 3+) ──────────────────────────────────────────
    state: 'unaware',           // 'unaware' | 'alarmed-flee' | 'alarmed-armed' | 'recovering'
    threat: 0,                  // 0..1 threat score
    path: [],                   // [{x,z}, …] world-space waypoints
    pathIndex: 0,
    destination: null,          // {x,z} current ambient/flee goal
    lastReplanAt: 0,            // performance.now() ms
    lastSeenTruckAt: 0,         // performance.now() ms
    stateEnteredAt: 0,          // performance.now() ms
    collisionRadius: 0.4,       // metres — used by moveWithCollision
    hp: 1,                      // regular moots die in one hit
    isBoss: false,
    // Time accumulator for recovery glance, armed lost-LOS timer, etc.
    _alarmExitTimer: 0,         // seconds threat has been below exit threshold
    _recoveryTimer: 0,          // seconds spent in recovering state
    _armedLosTimer: 0,          // seconds since LOS to truck was lost
    _glanceTimer: 0,            // seconds since last recovery glance
  };
  // Ancestor-walk during raycast hit uses this to splat via shooting.
  group.userData.mootHandle = handle;
  return handle;
}

// ---------------------------------------------------------------------------
// Push every live moot away from the car if within alertRadius. Moots that are
// far away stay put so sorting layouts are still recognizable from outside the
// alert zone.
export function updateMootFlee(dt, handles, carPos) {
  const alertSq = MOOT.alertRadius * MOOT.alertRadius;
  const step = MOOT.fleeSpeed * dt;
  for (const h of handles) {
    if (!h.alive) continue;
    const dx = h.group.position.x - carPos.x;
    const dz = h.group.position.z - carPos.z;
    const dSq = dx * dx + dz * dz;
    if (dSq > alertSq || dSq < 1e-6) continue;
    const scale = step / Math.sqrt(dSq);
    h.group.position.x += dx * scale;
    h.group.position.z += dz * scale;
  }
}

// ---------------------------------------------------------------------------
// Fling (fly-away) system — moots launched on ram or shot arc through the air
// and are removed from the scene after MOOT.flingDuration seconds.
// ---------------------------------------------------------------------------

/** @type {Array<object>} */
const _flingPool = [];

function _finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function _clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function _normaliseLaunchDirection(x, z) {
  const nx = _finiteNumber(x, 0);
  const nz = _finiteNumber(z, 1);
  const len = Math.hypot(nx, nz);
  if (len < 1e-6) return { x: 0, z: 1 };
  return { x: nx / len, z: nz / len };
}

function _resolveLegacyFling(dirX, dirZ, vy) {
  const dir = _normaliseLaunchDirection(dirX, dirZ);
  const horizontalSpeed = _finiteNumber(MOOT.flingSpeed, _finiteNumber(MOOT.shotFlingImpulse, 16));
  return {
    vx: dir.x * horizontalSpeed,
    vy: _finiteNumber(vy, _finiteNumber(MOOT.shotFlingUpSpeed, 9)),
    vz: dir.z * horizontalSpeed,
  };
}

function _resolveShotFling(options) {
  const dir = _normaliseLaunchDirection(options.dirX, options.dirZ);
  const impulse = _finiteNumber(options.impulse, _finiteNumber(MOOT.shotFlingImpulse, 20));
  return {
    vx: dir.x * impulse,
    vy: _finiteNumber(options.vy, _finiteNumber(MOOT.shotFlingUpSpeed, 9)),
    vz: dir.z * impulse,
  };
}

function _resolveRamFling(options) {
  const normal = _normaliseLaunchDirection(
    _finiteNumber(options.normalX, options.dirX),
    _finiteNumber(options.normalZ, options.dirZ),
  );
  const velocityX = _finiteNumber(options.vehicleVelocityX, 0);
  const velocityZ = _finiteNumber(options.vehicleVelocityZ, 0);
  const vehicleSpeed = Math.hypot(velocityX, velocityZ);
  let normalImpactSpeed = velocityX * normal.x + velocityZ * normal.z;
  if (!Number.isFinite(normalImpactSpeed) || normalImpactSpeed <= 0) {
    normalImpactSpeed = _finiteNumber(options.impactSpeed, vehicleSpeed);
  }
  normalImpactSpeed = Math.max(0, normalImpactSpeed);

  const minHorizontal = _finiteNumber(MOOT.ramFlingMinHorizontalSpeed, 7);
  const horizontalScale = _finiteNumber(MOOT.ramFlingSpeedScale, 0.85);
  const horizontalSpeed = Math.max(minHorizontal, normalImpactSpeed * horizontalScale);
  const maxReferenceSpeed = Math.max(_finiteNumber(CAR.maxSpeed, normalImpactSpeed), 1);
  const impactFrac = _clamp01(normalImpactSpeed / maxReferenceSpeed);
  const upMin = _finiteNumber(MOOT.ramFlingUpSpeedMin, _finiteNumber(MOOT.flingUpSpeedMin, 4));
  const upMax = _finiteNumber(MOOT.ramFlingUpSpeedMax, _finiteNumber(MOOT.flingUpSpeedMax, 18));

  return {
    vx: normal.x * horizontalSpeed,
    vy: upMin + impactFrac * (upMax - upMin),
    vz: normal.z * horizontalSpeed,
  };
}

function _resolveFlingVector(launch, dirZ, vy) {
  if (typeof launch === 'number') return _resolveLegacyFling(launch, dirZ, vy);
  if (!launch || typeof launch !== 'object') return _resolveLegacyFling(0, 1, vy);
  if (launch.kind === 'shot') return _resolveShotFling(launch);
  return _resolveRamFling(launch);
}

function _resolveFlingSpinRate(fling) {
  const launchSpeed = Math.hypot(
    _finiteNumber(fling.vx, 0),
    _finiteNumber(fling.vy, 0),
    _finiteNumber(fling.vz, 0),
  );
  const minRate = _finiteNumber(MOOT.flingSpinRateMin, _finiteNumber(MOOT.flingSpinRate, 6));
  const scale = _finiteNumber(MOOT.flingSpinRateScale, 0.25);
  const maxRate = Math.max(minRate, _finiteNumber(MOOT.flingSpinRateMax, minRate));
  return Math.max(minRate, Math.min(maxRate, minRate + launchSpeed * scale));
}

/**
 * Mark a moot as dead and add it to the fling pool so updateFlingMoots will
 * animate it flying through the air.  The launch vector is resolved here so
 * ram flings can use the vehicle's impact velocity/normal while shot flings
 * can use a separate projectile impulse.
 *
 * @param {object}  handle  - moot handle returned by buildMoot
 * @param {object|number} launch - ram/shot launch descriptor, or legacy dirX
 * @param {number} [dirZ]  - legacy normalized Z component
 * @param {number} [vy]    - legacy vertical launch speed
 */
export function flingMoot(handle, launch, dirZ, vy) {
  const fling = _resolveFlingVector(launch, dirZ, vy);
  handle.alive = false;
  handle.avatarMat.rotation = 0;
  handle._fling = {
    vx: fling.vx,
    vy: fling.vy,
    vz: fling.vz,
    spinRate: _resolveFlingSpinRate(fling),
    t: 0,
  };
  if (!_flingPool.includes(handle)) _flingPool.push(handle);
}

/**
 * Integrate all in-flight moots: arc position under gravity, spin sprite,
 * and remove from scene once MOOT.flingDuration is exceeded.
 *
 * @param {number}                  dt    - seconds since last frame
 * @param {import('three').Scene}   scene
 */
export function updateFlingMoots(dt, scene) {
  for (let i = _flingPool.length - 1; i >= 0; i--) {
    const h = _flingPool[i];
    const f = h._fling;
    if (!f) {
      h.avatarMat.rotation = 0;
      _flingPool.splice(i, 1);
      continue;
    }

    // Integrate position
    f.vy -= MOOT.flingGravity * dt;
    h.group.position.x += f.vx * dt;
    h.group.position.y += f.vy * dt;
    h.group.position.z += f.vz * dt;

    // Spin only during active hit-flight; walking/ambient moots remain neutral.
    h.avatarMat.rotation += _finiteNumber(f.spinRate, _resolveFlingSpinRate(f)) * dt;

    f.t += dt;
    if (f.t >= MOOT.flingDuration) {
      scene.remove(h.group);
      h.avatarMat.rotation = 0;
      delete h._fling;
      _flingPool.splice(i, 1);
      if (typeof h._onFlingComplete === 'function') {
        const onComplete = h._onFlingComplete;
        delete h._onFlingComplete;
        onComplete(h);
      }
    }
  }
}

// Circle-vs-circle test between the car and each live moot. Requires the car
// to exceed ramMinSpeed so idling into a moot doesn't register.
export function detectRams(vehicle, handles, out = []) {
  out.length = 0;
  if (Math.abs(vehicle.speed) < MOOT.ramMinSpeed) return out;
  const r = MOOT.ramRadius + CAR.collisionRadius;
  const rSq = r * r;
  for (const h of handles) {
    if (!h.alive) continue;
    const dx = h.group.position.x - vehicle.position.x;
    const dz = h.group.position.z - vehicle.position.z;
    if (dx * dx + dz * dz < rSq) out.push(h);
  }
  return out;
}
