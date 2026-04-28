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

// Circle-vs-circle test between the car and each live moot. Requires the car
// to exceed ramMinSpeed so idling into a moot doesn't register.
export function detectRams(vehicle, handles) {
  if (Math.abs(vehicle.speed) < MOOT.ramMinSpeed) return [];
  const r = MOOT.ramRadius + CAR.collisionRadius;
  const rSq = r * r;
  const hits = [];
  for (const h of handles) {
    if (!h.alive) continue;
    const dx = h.group.position.x - vehicle.position.x;
    const dz = h.group.position.z - vehicle.position.z;
    if (dx * dx + dz * dz < rSq) hits.push(h);
  }
  return hits;
}
