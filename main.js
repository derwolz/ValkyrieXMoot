import * as THREE from 'three';
import { loadDb } from './lib/data/mootLoader.js';
import { Vehicle } from './lib/car/vehicle.js';
import { resolveBuildingCollisions, resolveMapBounds } from './lib/car/collision.js';
import { Pistol } from './lib/weapons/pistol.js';
import { clearMootProjectiles } from './lib/entities/moots.js';
import { createRecorder } from './lib/rewind/recorder.js';
import { createPlayback } from './lib/rewind/playback.js';
import { createHud, updateHud, hideLoginPrompt, registerHudSlot, setHudSlot, removeHudSlot } from './lib/hud/overlays.js';
import { getMe, postQueue } from './lib/api.js';
import { createMirror, setFace } from './lib/hud/mirror.js';
import { setupDebugPanel } from './lib/debug/panel.js';
import { Mouse } from './lib/mouse.js';
import { WORLD, MOOT, GAME, MIRROR, CITY } from './lib/config.js';
import { createImpactSystem } from './lib/game/impacts.js';
import { createGameState } from './lib/game/state.js';
import { generateCity } from './lib/world/city/generator.js';
import { createPopulation } from './lib/world/population.js';
import { createRadar } from './lib/hud/radar.js';
import { createBossPortrait } from './lib/hud/portrait.js';
import { createLevelManager, pickPlayerSpawn, pickBossSpawn, pickBossRow } from './lib/game/levels.js';
import { tickPerception } from './lib/ai/perception.js';
import { tickUnaware } from './lib/ai/ambient.js';
import { tickFlee } from './lib/ai/flee.js';
import { tickArmed } from './lib/ai/armed.js';
import { tickRecovery } from './lib/ai/recovery.js';
import { tickBoss } from './lib/ai/boss.js';

// ── Scene setup ───────────────────────────────────────────────────────────────

const overlay = document.getElementById('overlay');
const canvas  = document.getElementById('c');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(WORLD.clearColor, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(WORLD.clearColor, WORLD.fogNear, WORLD.fogFar);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.rotation.order = 'YXZ';
scene.add(camera);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ── Core objects ──────────────────────────────────────────────────────────────

const vehicle      = new Vehicle();
const pistol       = new Pistol(camera);
const recorder     = createRecorder();
const impactSystem = createImpactSystem(scene);

let buildingAABBs = [];
let navGrid       = null;
let interestPoints = [];
let population    = null;
let levelManager  = null;
let db            = null;
let cityBounds    = null;  // { minX, maxX, minZ, maxZ } — set after each buildCity call

let isBuilding       = false;  // guard against concurrent buildCity calls
let victoryTimeoutId = null;   // pending level-transition timeout (so R-key can cancel it)

let radar         = null;
let portrait      = null;
let playback      = null;
let paused        = false;
let noclip        = false;
let lastTime      = 0;

// ── Shared context fed to all AI tick functions each frame ────────────────────

// Updated every frame before AI dispatch.
let aiCtx = {
  navGrid:       null,
  buildingAABBs: [],
  interestPoints: [],  // set once per city-build, not per frame
  truckPos:      { x: 0, z: 0 },
  truckVelX:     0,
  truckVelZ:     0,
  now:           0,
  recentKills:   [],  // [{x,z,at}] — filled by splatMoot callback
  recentShots:   [],  // [{x,z,at}] — filled by tryShoot
  recentKillsCursor: 0,  // start-index cursor for O(1) pruning
  recentShotsCursor: 0,  // start-index cursor for O(1) pruning
  spawnProjectile: null,  // bound after scene is available
};

// Shared bullet geometry and material — created once, never disposed per-bullet.
const bulletGeo = new THREE.SphereGeometry(MOOT.projectileRadius, 6, 6);
const bulletMat = new THREE.MeshBasicMaterial({ color: 0xff3300 });

/** Projectile spawner used by armed.js and boss.js via ctx.spawnProjectile */
function makeSpawnProjectile(sceneRef) {
  return function spawnProjectile(origin, target) {
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) return;
    const nx = dx / dist;
    const nz = dz / dist;

    const mesh = new THREE.Mesh(bulletGeo, bulletMat);
    mesh.userData.isBullet = true;  // prevent _clearCityMeshes from disposing shared geometry/material
    mesh.position.set(
      origin.x + nx * 0.6,
      origin.y !== undefined ? origin.y : MOOT.projectileSpawnHeight,
      origin.z + nz * 0.6,
    );
    sceneRef.add(mesh);
    _projectiles.push({
      mesh,
      vx: nx * MOOT.projectileSpeed,
      vz: nz * MOOT.projectileSpeed,
      life: MOOT.projectileMaxLifetime,
    });
  };
}

// Projectiles spawned by AI armed moots and the boss.
// Bullet hit detection runs in tickBullets() below.
const _projectiles = [];

function tickBullets(dt, truckPos, onHit) {
  const hitSq = MOOT.projectileHitRadius * MOOT.projectileHitRadius;
  for (let i = _projectiles.length - 1; i >= 0; i--) {
    const p = _projectiles[i];
    p.life -= dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.z += p.vz * dt;
    if (p.life <= 0) {
      scene.remove(p.mesh);
      _projectiles.splice(i, 1);
      continue;
    }
    const cx = p.mesh.position.x - truckPos.x;
    const cz = p.mesh.position.z - truckPos.z;
    if (cx * cx + cz * cz < hitSq) {
      scene.remove(p.mesh);
      _projectiles.splice(i, 1);
      onHit();
    }
  }
}

function clearAiProjectiles() {
  for (const p of _projectiles) {
    scene.remove(p.mesh);
    // Do NOT dispose bulletGeo/bulletMat — they are shared.
  }
  _projectiles.length = 0;
}

// ── Game state machine ────────────────────────────────────────────────────────

const gs = createGameState({
  scene,
  vehicle,
  recorder,
  getPlayback:      () => playback,
  getMootHandles:   () => population ? population.getHandles() : [],
  getSessionMoots:  () => [],       // unused in new pipeline
  impactSystem,
  pistol,
  updateHud,
  onSplatMoot(handle, _weapon) {
    if (population) population.notifyDeath(handle);
    // Record kill event for perception system (recentKills).
    const pos = handle.group ? handle.group.position : null;
    if (pos) {
      aiCtx.recentKills.push({ x: pos.x, z: pos.z, at: performance.now() });
    }
  },
  onVictoryTimeout(id) {
    // Store so buildCity can clearTimeout before it fires.
    victoryTimeoutId = id;
  },
  onVictory({ charge, capacitors }) {
    // Level transition: rebuild city with incremented seed.
    startNextLevel(charge, capacitors);
  },
  onRestart() {
    // Gameover "Press R" button: rebuild from same seed.
    buildCity(levelManager.currentSeed).catch(console.error);
  },
});

const { game, triggerRewind, ramMoots, tryShoot: _legacyTryShoot,
        tickCrashCooldown, onRewindDone, onMootBulletHit,
        setCurrentPlayer } = gs;

// Wrap tryShoot to also record the shot event for perception (recentShots).
function tryShoot(aim) {
  const fired = _legacyTryShoot(aim);
  if (fired) {
    // Record the truck's actual position as the shot origin so nearby moots hear it.
    aiCtx.recentShots.push({ x: vehicle.position.x, z: vehicle.position.z, at: performance.now() });
  }
}

// ── City initialisation ───────────────────────────────────────────────────────

/**
 * Build / rebuild the city for a given seed.
 * Disposes previous city geometry and population.
 *
 * @param {number} seed
 * @param {{ charge: number, capacitors: number } | null} carryOver — ammo to preserve
 */
async function buildCity(seed, carryOver = null) {
  if (isBuilding) return;   // drop concurrent calls
  isBuilding = true;

  // Cancel any pending victory-timeout level transition.
  if (victoryTimeoutId !== null) {
    clearTimeout(victoryTimeoutId);
    victoryTimeoutId = null;
  }

  overlay.classList.remove('hidden');
  overlay.textContent = 'Generating city…';

  // Dispose old population.
  if (population) population.destroyAll();
  clearAiProjectiles();
  clearMootProjectiles(scene);
  aiCtx.recentKills.length = 0;
  aiCtx.recentShots.length = 0;

  // Remove existing city geometry by purging scene children that aren't camera
  // or UI (keep camera, vehicle, pistol objects).
  // Simplest safe approach: dispose all Mesh children added by generator.
  // The generator adds Mesh / Group objects; the scene also holds camera and
  // vehicle parts. We tag generator meshes and remove only those.
  // Since we rebuild from scratch we clear non-essential mesh children.
  _clearCityMeshes();

  // Generate city (navGrid is built inside generateCity).
  const city = generateCity({ scene, seed });
  buildingAABBs  = city.buildingAABBs;
  interestPoints = city.interestPoints;
  navGrid        = city.navGrid;
  cityBounds     = city.bounds;        // store per-level; used by resolveMapBounds each frame

  aiCtx.navGrid        = navGrid;
  aiCtx.buildingAABBs  = buildingAABBs;
  aiCtx.interestPoints = city.interestPoints;
  aiCtx.spawnProjectile = makeSpawnProjectile(scene);

  // Pick spawn positions.
  const playerSpawn = pickPlayerSpawn(city.bounds, interestPoints);
  const bossSpawnPt = pickBossSpawn(playerSpawn, city.bounds, navGrid);

  // Place vehicle at player spawn.
  vehicle.reset();
  vehicle.setPositionYaw(playerSpawn.x, playerSpawn.z, 0);

  // Pick boss row (avoiding recent).
  const bossRow = pickBossRow(db, (id) => levelManager.avoidsBossRow(String(id)));
  levelManager.markBossRow(String(bossRow.id));

  // Create population manager.
  population = createPopulation({
    scene,
    db,
    navGrid,
    buildingAABBs,
    // onSplatMoot is not wired here; the gameState dep handles death events.
  });

  overlay.textContent = 'Loading moot textures…';
  await population.loadTextures();

  // Boot population in ring around player (fire-and-forget — not async).
  population.boot(playerSpawn);

  // Spawn boss.
  const bossHandle = population.spawnBoss(bossRow, bossSpawnPt);

  // Carry over ammo / capacitors from previous level.
  if (carryOver) {
    game.charge     = carryOver.charge;
    game.capacitors = carryOver.capacitors;
  } else {
    game.charge     = GAME.startCharge;
    game.capacitors = 0;
  }
  game.health    = GAME.maxHealth;
  game.state     = 'playing';
  game.mootsAlive = POP_STANDING_COUNT;
  game.mootsTotal = POP_STANDING_COUNT;

  // Update playback with new vehicle reference (no moot handles needed).
  if (playback) {
    playback = createPlayback(scene, vehicle);
  }

  // Update the debug __vxm handle.
  if (window.__vxm) {
    window.__vxm.mootHandles = population.getHandles();
  }

  recorder.reset();
  impactSystem.clearImpacts();

  isBuilding = false;  // release guard
  overlay.classList.add('hidden');
  updateHud(game);
  if (portrait) portrait.update(population.getBossHandle());
}

// Approximate constant for moot counter (not critical after population takes over).
const POP_STANDING_COUNT = 60;

async function startNextLevel(charge, capacitors) {
  const newSeed = levelManager.nextSeed();
  await buildCity(newSeed, { charge, capacitors });
}

/** Remove all city-generated Mesh/Group children from the scene.
 * Disposes geometry and materials on all Mesh descendants to free GPU memory.
 * Pistol is parented to camera (userData.isPistol=true) — not touched.
 * Impact sprites are short-lived and managed by impactSystem — skip.
 */
function _clearCityMeshes() {
  const toRemove = [];
  for (const obj of scene.children) {
    if (obj === camera) continue;
    if (obj.userData && (obj.userData.isPistol || obj.userData.isImpact || obj.userData.isBullet)) continue;
    toRemove.push(obj);
  }
  for (const o of toRemove) {
    // Recursively dispose geometry and material on all Mesh descendants.
    o.traverse((child) => {
      if (child.isMesh) {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            for (const m of child.material) m.dispose();
          } else {
            child.material.dispose();
          }
        }
      }
    });
    scene.remove(o);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main() {
  const [dbResult] = await Promise.all([
    (async () => {
      overlay.textContent = 'Loading moot db…';
      return await loadDb();
    })(),
    (async () => {
      const player = await getMe();
      setCurrentPlayer(player);
      if (player) {
        console.log(`[vxm] Logged in as @${player.handle}`);
        hideLoginPrompt();
      }
      if (new URLSearchParams(location.search).has('login') && player) {
        const queued = await postQueue();
        if (queued) console.log('[vxm] Player enqueued for moot conversion');
      }
    })(),
  ]);

  db = dbResult;

  // Seed from URL param, else CITY default seed.
  const urlSeed = parseInt(new URLSearchParams(location.search).get('seed') || '0', 10);
  const initialSeed = urlSeed || CITY.seed;

  levelManager = createLevelManager(initialSeed);

  // Create HUD components.
  createHud();
  createMirror();
  setupDebugPanel({ pistol, moot: MOOT });

  // Create radar and portrait.
  radar    = createRadar();
  portrait = createBossPortrait();

  // Build first city.
  await buildCity(initialSeed);

  playback = createPlayback(scene, vehicle);

  window.__vxm = {
    scene, camera, renderer, vehicle, pistol, game,
    recorder, playback,
    get mootHandles() { return population ? population.getHandles() : []; },
    get population()  { return population; },
    get navGrid()     { return navGrid; },
    // HUD slot helpers exposed so callers can manage image slots after createHud().
    registerHudSlot,
    setHudSlot,
    removeHudSlot,
  };

  lastTime = performance.now();
  requestAnimationFrame(tick);
}

// ── Per-frame AI dispatch ─────────────────────────────────────────────────────

function tickAI(dt) {
  if (!population || !navGrid) return null;

  const now = performance.now();
  const truckPos = { x: vehicle.position.x, z: vehicle.position.z };
  const truckVelX = vehicle.speed * Math.sin(vehicle.yaw);
  const truckVelZ = vehicle.speed * Math.cos(vehicle.yaw);

  // Prune stale recent-kill / recent-shot events (> 4 s old) using cursors.
  const staleKill = now - 4000;
  const staleShot = now - 2000;
  while (aiCtx.recentKillsCursor < aiCtx.recentKills.length &&
         aiCtx.recentKills[aiCtx.recentKillsCursor].at < staleKill) {
    aiCtx.recentKillsCursor++;
  }
  while (aiCtx.recentShotsCursor < aiCtx.recentShots.length &&
         aiCtx.recentShots[aiCtx.recentShotsCursor].at < staleShot) {
    aiCtx.recentShotsCursor++;
  }
  // Compact arrays once the cursor is deep enough to avoid unbounded growth.
  if (aiCtx.recentKillsCursor > 64) {
    aiCtx.recentKills.splice(0, aiCtx.recentKillsCursor);
    aiCtx.recentKillsCursor = 0;
  }
  if (aiCtx.recentShotsCursor > 64) {
    aiCtx.recentShots.splice(0, aiCtx.recentShotsCursor);
    aiCtx.recentShotsCursor = 0;
  }

  // Update shared context (per-frame fields only — navGrid, buildingAABBs,
  // interestPoints and spawnProjectile are set once per city-build in buildCity).
  aiCtx.truckPos   = truckPos;
  aiCtx.truckVelX  = truckVelX;
  aiCtx.truckVelZ  = truckVelZ;
  aiCtx.now        = now;

  const handles = population.getHandles();

  for (const m of handles) {
    if (!m.alive) continue;

    if (m.isBoss) {
      // Boss AI — distinct pipeline.
      tickBoss(dt, m, aiCtx);
      continue;
    }

    // Regular moot pipeline: perception → behavior tick.
    tickPerception(dt, m, aiCtx);

    switch (m.state) {
      case 'unaware':
        tickUnaware(dt, m, aiCtx);
        break;
      case 'alarmed-flee':
        tickFlee(dt, m, aiCtx);
        break;
      case 'alarmed-armed':
        tickArmed(dt, m, aiCtx);
        break;
      case 'recovering':
        tickRecovery(dt, m, aiCtx);
        break;
    }
  }

  // Advance bullets spawned by AI.
  tickBullets(dt, truckPos, onMootBulletHit);

  // Population manager tick (despawn/respawn at POP.tickHz).
  population.tick(dt, truckPos);

  // Keep game.mootsAlive in sync with the actual live count (includes boss).
  // This ensures the HUD doesn't decay to 0 as moots respawn.
  game.mootsAlive = population.activeCount + (population.getBossHandle()?.alive ? 1 : 0);

  // Update radar.
  if (radar) {
    radar.update(truckPos, vehicle.yaw, handles);
  }

  // Update boss portrait.
  if (portrait) {
    portrait.update(population.getBossHandle());
  }

  // Return the handles array so the caller can pass it to ramMoots,
  // avoiding a second getMootHandles() allocation.
  return handles;
}

// ── Game loop ─────────────────────────────────────────────────────────────────

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  // ── Rewind playback tick ──────────────────────────────────────────────────
  if (game.state === 'rewinding') {
    if (playback && !playback.isActive()) {
      game.state = 'playing';
    } else if (playback) {
      const done = playback.update(dt);

      if (playback.isScrubbing()) {
        vehicle.applyToCamera(camera);
      } else {
        vehicle.update(dt);
        if (!noclip) resolveBuildingCollisions(vehicle, buildingAABBs);
        if (!noclip) resolveMapBounds(vehicle, cityBounds);
        vehicle.applyToCamera(camera);
      }

      window.__vxmMouse = Mouse;
      camera.updateMatrixWorld(true);
      const aim = impactSystem.pickAimPoint(camera, Mouse);
      pistol.aimAt(aim.point);
      if (Mouse.consumeClick()) tryShoot(aim);
      pistol.update(dt);
      impactSystem.updateImpacts(dt);
      updateHud(game);
      renderer.render(scene, camera);
      if (done) onRewindDone();
    }
    return;
  }

  // ── Victory / gameover: only render, don't tick AI ───────────────────────
  if (paused || (game.state !== 'playing')) {
    Mouse.consumeClick();
    renderer.render(scene, camera);
    return;
  }

  // ── Normal playing tick ───────────────────────────────────────────────────

  vehicle.update(dt);
  const preSpeed = Math.abs(vehicle.speed);
  const hit = noclip ? null : resolveBuildingCollisions(vehicle, buildingAABBs);
  if (!noclip) resolveMapBounds(vehicle, cityBounds);
  tickCrashCooldown(dt, hit, preSpeed);
  vehicle.applyToCamera(camera);

  // AI dispatch (perception, behaviors, boss, bullets, population, HUD).
  // Returns the handles array so ramMoots can reuse it without a second getHandles() call.
  const aiHandles = tickAI(dt);

  // Collision: ram moots (pass pre-computed handles to avoid second allocation).
  if (aiHandles) ramMoots(aiHandles);

  // Record frame state.
  recorder.tick(dt, vehicle);

  window.__vxmMouse = Mouse;
  camera.updateMatrixWorld(true);
  const aim = impactSystem.pickAimPoint(camera, Mouse);
  pistol.aimAt(aim.point);
  if (Mouse.consumeClick()) tryShoot(aim);

  pistol.update(dt);
  impactSystem.updateImpacts(dt);
  updateHud(game);
  renderer.render(scene, camera);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') {
    if (game.state === 'gameover' || game.state === 'victory') {
      // Restart: full rebuild from same seed (resets all AI, positions, population).
      buildCity(levelManager.currentSeed).catch(console.error);
    } else {
      vehicle.reset();
    }
  } else if (e.code === 'KeyQ' && game.state === 'playing') {
    if (game.capacitors > 0) {
      triggerRewind();
    } else {
      setFace('angry', MIRROR.angryMs);
    }
  } else if (e.code === 'Space' && game.state === 'playing') {
    paused = !paused;
  } else if (e.code === 'KeyG' && e.ctrlKey) {
    e.preventDefault();
    noclip = !noclip;
    console.log(`[vxm] noclip ${noclip ? 'ON' : 'OFF'}`);
  }
});

main().catch((err) => {
  console.error(err);
  overlay.textContent = 'Error: ' + err.message;
});
