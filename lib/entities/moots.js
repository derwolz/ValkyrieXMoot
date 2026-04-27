import * as THREE from 'three';
import { MOOT, CAR } from '../config.js';
import { makeNameTexture } from '../nameTexture.js';

// ---------------------------------------------------------------------------
// Armed-moot projectile system
// ---------------------------------------------------------------------------

// Active bullet records: { mesh, vx, vz, life }
const projectiles = [];

/** Mark ~`fraction` of the supplied handles as armed.  Called once after
 * buildMoot populates the handles array.  Randomisation uses Math.random so
 * each session is different.  A handle gets `armed:true` and
 * `gunCooldown:number` (staggered so the first volley isn't simultaneous). */
export function initArmed(handles, fraction) {
  for (const h of handles) {
    h.armed = false;
    h.gunCooldown = 0;
  }
  // Shuffle index list then pick first round(N*fraction).
  const indices = handles.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const count = Math.round(handles.length * fraction);
  for (let k = 0; k < count; k++) {
    const h = handles[indices[k]];
    h.armed = true;
    // Stagger initial cooldowns so moots don't all fire at once on game start.
    h.gunCooldown = Math.random() * MOOT.armedCooldownSec;
  }
}

/** Create one bullet mesh aimed from moot `origin` toward `target` in XZ. */
function spawnProjectile(scene, origin, target) {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 0.01) return;
  const nx = dx / dist;
  const nz = dz / dist;

  const geo = new THREE.SphereGeometry(MOOT.projectileRadius, 6, 6);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff3300 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(
    origin.x + nx * 0.6,
    MOOT.projectileSpawnHeight,
    origin.z + nz * 0.6,
  );
  scene.add(mesh);
  projectiles.push({
    mesh,
    vx: nx * MOOT.projectileSpeed,
    vz: nz * MOOT.projectileSpeed,
    life: MOOT.projectileMaxLifetime,
  });
}

/** Tick armed moots: countdown, fire when in range; move bullets; detect hits.
 * `onHit` is called (no args) for each bullet that strikes the car. */
export function updateMootGunfire(dt, handles, carPos, scene, onHit) {
  const engageSq = MOOT.armedEngageRange * MOOT.armedEngageRange;
  const hitSq = MOOT.projectileHitRadius * MOOT.projectileHitRadius;

  // Tick each armed moot's cooldown and fire when ready and in range.
  for (const h of handles) {
    if (!h.alive || !h.armed) continue;
    const dx = h.group.position.x - carPos.x;
    const dz = h.group.position.z - carPos.z;
    const dSq = dx * dx + dz * dz;
    if (dSq > engageSq) {
      // Out of range — reset cooldown so they don't burst on re-entry.
      h.gunCooldown = MOOT.armedCooldownSec;
      continue;
    }
    h.gunCooldown -= dt;
    if (h.gunCooldown <= 0) {
      spawnProjectile(scene, h.group.position, carPos);
      h.gunCooldown = MOOT.armedCooldownSec;
    }
  }

  // Move bullets and check for car hit or lifetime expiry.
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.life -= dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.z += p.vz * dt;

    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      projectiles.splice(i, 1);
      continue;
    }

    const cx = p.mesh.position.x - carPos.x;
    const cz = p.mesh.position.z - carPos.z;
    if (cx * cx + cz * cz < hitSq) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      projectiles.splice(i, 1);
      onHit();
    }
  }
}

/** Read-only view of live projectiles for the state recorder. */
export function getProjectiles() { return projectiles; }

/** Remove every active projectile from the scene (e.g. on game restart). */
export function clearMootProjectiles(scene) {
  for (const p of projectiles) {
    scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    p.mesh.material.dispose();
  }
  projectiles.length = 0;
}

// ---------------------------------------------------------------------------
// buildMoot — construct a Three.js Group for one moot row and add it to scene.
// ---------------------------------------------------------------------------

/**
 * Build a moot Group (avatar sprite + name label) and add it to `scene`.
 * Returns a moot handle used throughout the game loop.
 *
 * @param {import('../data/mootLoader.js').MootRow} row
 * @param {import('three').Scene} scene
 * @returns {{ group: import('three').Group, avatarMat: import('three').SpriteMaterial, alive: boolean, mootRow: import('../data/mootLoader.js').MootRow }}
 */
export function buildMoot(row, scene) {
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

  scene.add(group);
  // mootRow stored on the handle so postKill can reference the username/handle.
  const handle = { group, avatarMat, alive: true, mootRow: row };
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
