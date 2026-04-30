import * as THREE from 'three';
import { loadDb } from './lib/data/mootLoader.js';
import { Vehicle } from './lib/car/vehicle.js';
import { resolveBuildingCollisions, resolveMapBounds } from './lib/car/collision.js';
import { Pistol } from './lib/weapons/pistol.js';
import { clearMootProjectiles } from './lib/entities/moots.js';
import { createRecorder } from './lib/rewind/recorder.js';
import { createPlayback } from './lib/rewind/playback.js';
import { createHud, updateHud, hideLoginPrompt, registerHudSlot, setHudSlot, removeHudSlot, updateTargetHud, setGameOverVisible } from './lib/hud/overlays.js';
import { getMe, postQueue } from './lib/api.js';
import { createMirror, setFace, setReactionImage, setReactionImages, getMirrorCanvas, getMirrorSize } from './lib/hud/mirror.js';
import { createSpeedLines, setSpeedLinesActive } from './lib/hud/speedLines.js';
import { setupDebugPanel } from './lib/debug/panel.js';
import { Mouse } from './lib/mouse.js';
import { TouchInput } from './lib/input/touch.js';
import { Bindings } from './lib/input/bindings.js';
import { PauseMenu } from './lib/ui/pauseMenu.js';
import { WORLD, MOOT, GAME, CITY, NPC_VEHICLE, TARGET, BOOST, MIRROR } from './lib/config.js';
import { loadAllVehicleTextures } from './lib/assets/vehicleTextures.js';
import { createPlayerSprite } from './lib/car/playerSprite.js';
import { createImpactSystem } from './lib/game/impacts.js';
import { createGameState } from './lib/game/state.js';
import { generateCity } from './lib/world/city/generator.js';
import { createPopulation } from './lib/world/population.js';
import { createMinimap } from './lib/hud/minimap.js';
import { createTargetMarker } from './lib/entities/targetMarker.js';
import { createNpcVehiclePool } from './lib/entities/npcVehiclePool.js';
import { destroyNpcVehicle, startNpcSpin } from './lib/entities/npcVehicle.js';
import { createLevelManager, pickPlayerSpawn } from './lib/game/levels.js';
import { tickPerception } from './lib/ai/perception.js';
import { tickUnaware } from './lib/ai/ambient.js';
import { tickFlee } from './lib/ai/flee.js';
import { tickArmed } from './lib/ai/armed.js';
import { tickRecovery } from './lib/ai/recovery.js';
import { createRadio } from './lib/hud/radio.js';

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
let buildingGrid  = null;
let navGrid       = null;
let interestPoints = [];
let population    = null;
let levelManager  = null;
let db            = null;
let cityBounds    = null;  // { minX, maxX, minZ, maxZ } — set after each buildCity call

let isBuilding       = false;  // guard against concurrent buildCity calls
let playerSprite     = null;   // player car sprite (third-person)
let npcVehiclePool   = null;   // pool of NPC vehicles
let targetMarker     = null;   // ground ring under the current target moot
let minimap          = null;   // minimap replacing the old radar

let playback      = null;
let radio         = null;  // radio system (3 channels)
let paused        = false;
let noclip        = false;
let lastTime      = 0;
let wasBoosting   = false;

// Rearview mirror renderer/camera — populated by setupRearview() once the
// mirror DOM exists. The mirror camera sits just above the player and looks
// in the opposite direction the vehicle is facing.
let rearRenderer = null;
let rearCamera   = null;
const _rearLook  = new THREE.Vector3();

function setupRearview() {
  const mc = getMirrorCanvas();
  if (!mc) return;
  rearRenderer = new THREE.WebGLRenderer({ canvas: mc, antialias: true });
  rearRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const ms = getMirrorSize();
  rearRenderer.setSize(ms.width, ms.height, false);
  rearRenderer.setClearColor(WORLD.clearColor, 1);
  rearCamera = new THREE.PerspectiveCamera(60, ms.width / ms.height, 0.1, 1000);
  rearCamera.rotation.order = 'YXZ';
  scene.add(rearCamera);
}

function renderRearview() {
  if (!rearRenderer || !rearCamera) return;
  // Position: at the vehicle, slightly elevated.
  rearCamera.position.set(vehicle.position.x, vehicle.position.y + 2.2, vehicle.position.z);
  // Look opposite the vehicle's forward — i.e. behind the truck.
  _rearLook.set(
    vehicle.position.x - vehicle.forward.x * 30,
    vehicle.position.y + 1.5,
    vehicle.position.z - vehicle.forward.z * 30,
  );
  rearCamera.lookAt(_rearLook);
  rearRenderer.render(scene, rearCamera);
}

// ── Shared context fed to all AI tick functions each frame ────────────────────

// Updated every frame before AI dispatch.
let aiCtx = {
  navGrid:        null,
  buildingAABBs:  [],
  buildingGrid:   null,
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
  camera,
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
    // If the target was killed by a non-targeting path (e.g. direct shot without
    // wasTarget tracking), ensure the target ring is immediately cleared.
    // designateNewTarget() is called from onTargetHit, which is the main path;
    // this handles any edge-case where targetHandle went stale but wasn't reassigned.
    if (handle === game.targetHandle) {
      game.targetHandle = null;
      if (targetMarker) targetMarker.detach();
      designateNewTarget();
    }
  },
  onVictoryTimeout(_id) {
    // Boss system removed — no-op.
  },
  onVictory(_carry) {
    // Boss system removed — no-op.
  },
  onRestart() {
    // Gameover "Press R" button: rebuild from same seed.
    buildCity(levelManager.currentSeed).catch(console.error);
  },
  onTargetChanged(handle) {
    // Reattach the ground ring to the new target.
    if (targetMarker) {
      if (handle) targetMarker.attach(handle);
      else targetMarker.detach();
    }
  },
  onNpcVehicleShot(npcHandle) {
    // Shoot-to-delete NPC vehicle: destroy it, award score, and grant ammo.
    if (!npcHandle.alive) return;
    destroyNpcVehicle(npcHandle);
    game.score += NPC_VEHICLE.scoreShot;
    // Shooting an NPC grants the same ammo as a boost-ram destroy.
    game.charge = Math.min(GAME.maxAmmo, game.charge + BOOST.ammoOnDestroy);
    updateHud(game);
    if (npcVehiclePool) npcVehiclePool.respawnAfterDelay(npcHandle, NPC_VEHICLE.respawnDelayMs);
  },
});

const { game, ramMoots, tryShoot: _legacyTryShoot,
        tickCrashCooldown, tickTimer, designateNewTarget,
        onRewindDone, onMootBulletHit,
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
 */
async function buildCity(seed) {
  if (isBuilding) return;   // drop concurrent calls
  isBuilding = true;

  // Destroy previous player sprite (it will be re-created below after scene clear).
  if (playerSprite) { playerSprite.destroy(); playerSprite = null; }

  overlay.classList.remove('hidden');
  overlay.textContent = 'Generating city…';

  // Dispose old population.
  if (population) population.destroyAll();
  // Destroy old NPC vehicles.
  if (npcVehiclePool) npcVehiclePool.destroyAll();
  // Destroy old target marker.
  if (targetMarker) { targetMarker.destroy(); targetMarker = null; }
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
  buildingGrid   = city.buildingGrid;
  interestPoints = city.interestPoints;
  navGrid        = city.navGrid;
  cityBounds     = city.bounds;        // store per-level; used by resolveMapBounds each frame

  aiCtx.navGrid        = navGrid;
  aiCtx.buildingAABBs  = buildingAABBs;
  aiCtx.buildingGrid   = buildingGrid;
  aiCtx.interestPoints = city.interestPoints;
  aiCtx.spawnProjectile = makeSpawnProjectile(scene);

  // Pick player spawn.
  const playerSpawn = pickPlayerSpawn(city.bounds, interestPoints);

  // Place vehicle at player spawn.
  vehicle.reset();
  vehicle.setPositionYaw(playerSpawn.x, playerSpawn.z, 0);

  // Re-create player sprite for the new city.
  playerSprite = createPlayerSprite(scene);

  // Re-create target marker.
  targetMarker = createTargetMarker(scene);

  // Create population manager.
  population = createPopulation({
    scene,
    db,
    navGrid,
    buildingAABBs,
    // onSplatMoot is not wired here; the gameState dep handles death events.
  });

  overlay.textContent = 'Loading moot textures…';
  // Hard cap: never hang more than 15 s waiting for textures. Any still-loading
  // video will fall back to a placeholder when it eventually resolves.
  await Promise.race([
    population.loadTextures(),
    new Promise(r => setTimeout(r, 15000)),
  ]);

  // Boot population in ring around player (fire-and-forget — not async).
  population.boot(playerSpawn);

  // Spawn NPC vehicle fleet on road waypoints.
  npcVehiclePool = createNpcVehiclePool({ scene, navGrid });

  game.charge     = GAME.startAmmo;
  game.capacitors = 0;
  game.health     = 0;          // truck is invincible
  game.state      = 'playing';
  game.score      = 0;
  game.timeRemaining    = TARGET.startTimeS;
  game.targetCountdown  = TARGET.targetCountdownS;
  game.combo      = 1;
  game.mootsAlive = POP_STANDING_COUNT;
  game.mootsTotal = POP_STANDING_COUNT;

  // Update playback with new vehicle reference (no moot handles needed).
  if (playback) {
    playback = createPlayback(scene, vehicle);
  }

  recorder.reset();
  impactSystem.clearImpacts();

  isBuilding = false;  // release guard
  overlay.classList.add('hidden');
  setGameOverVisible(false);
  updateHud(game);
  // Update minimap city layer now that bounds and road data are available.
  if (minimap) minimap.buildCityLayer(city.bounds, city.roadSegments, city.buildingAABBs);
  // Designate the first target.
  designateNewTarget();
}

// Approximate constant for moot counter (not critical after population takes over).
const POP_STANDING_COUNT = 60;

// startNextLevel removed — no boss, no level transitions.


/** Remove all city-generated Mesh/Group children from the scene.
 * Disposes geometry and materials on all Mesh descendants to free GPU memory.
 * Pistol is parented to camera (userData.isPistol=true) — not touched.
 * Impact sprites are short-lived and managed by impactSystem — skip.
 */
function _clearCityMeshes() {
  const toRemove = [];
  for (const obj of scene.children) {
    if (obj === camera) continue;
    if (obj.userData && (obj.userData.isPistol || obj.userData.isImpact || obj.userData.isBullet || obj.userData.isPlayerSprite || obj.userData.isNpcVehicle || obj.userData.isTargetMarker)) continue;
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
    loadAllVehicleTextures(),
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
  createSpeedLines();
  setupDebugPanel({ pistol, moot: MOOT });

  // Set up the rearview mirror's WebGL renderer and camera.
  setupRearview();

  // Create minimap (replaces old radar).
  minimap  = createMinimap();
  // No boss portrait.

  // Create radio. Discover music files asynchronously; playback starts on the
  // first user gesture (browsers block autoplay until then).
  radio = createRadio();
  radio.loadAll().catch(console.error);

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
    // Reaction-panel image helpers (bottom-right face widget).
    setReactionImage,
    setReactionImages,
    // Radio (cycle channels, set volume, reload track lists).
    radio,
  };

  lastTime = performance.now();
  requestAnimationFrame(tick);
}

// ── Per-frame AI dispatch ─────────────────────────────────────────────────────

function tickAI(dt) {
  if (!population || !navGrid) return null;

  const now = performance.now();
  // Mutate the shared truckPos object instead of allocating a new {x,z} every frame.
  aiCtx.truckPos.x = vehicle.position.x;
  aiCtx.truckPos.z = vehicle.position.z;
  const truckPos = aiCtx.truckPos;
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
  // truckPos is already updated above (in-place mutation of aiCtx.truckPos).
  aiCtx.truckVelX  = truckVelX;
  aiCtx.truckVelZ  = truckVelZ;
  aiCtx.now        = now;

  const handles = population.getHandles();

  for (const m of handles) {
    if (!m.alive) continue;

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

  // Keep game.mootsAlive in sync with the actual live count.
  game.mootsAlive = population.activeCount;

  // Update minimap (replaces old radar).
  if (minimap) {
    const npcHandles = npcVehiclePool ? npcVehiclePool.getHandles() : [];
    minimap.update(
      truckPos, vehicle.yaw,
      handles,
      npcHandles,
      game.targetHandle,
      dt,
    );
  }

  // Tick NPC vehicles.
  if (npcVehiclePool) {
    // camera.rotation.order = 'YXZ' (set at scene init), so .y is the horizontal yaw
    // after applyChaseCamera's lookAt() call — use this for directional sprite selection.
    npcVehiclePool.tick(dt, camera.rotation.y);
  }

  // Tick target marker animation.
  if (targetMarker) targetMarker.tick(dt);

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
        // Rewind scrub: camera tracks vehicle in first-person mode (no control).
        vehicle.applyToCamera(camera);
      } else {
        vehicle.update(dt, game);
        if (!noclip) resolveBuildingCollisions(vehicle, buildingGrid ?? buildingAABBs);
        if (!noclip) resolveMapBounds(vehicle, cityBounds);
        if (playerSprite) playerSprite.update(vehicle);
        vehicle.applyChaseCamera(camera);
      }

      window.__vxmMouse = Mouse;
      camera.updateMatrixWorld(true);
      const aim = impactSystem.pickAimPoint(camera, Mouse);
      pistol.aimAt(aim.point);
      if (Mouse.consumeClick() || TouchInput.consumeTap()) tryShoot(aim);
      pistol.update(dt);
      impactSystem.updateImpacts(dt);
      updateHud(game);
      renderer.render(scene, camera);
      renderRearview();
      if (done) onRewindDone();
    }
    return;
  }

  // ── Victory / gameover: only render, don't tick AI ───────────────────────
  if (paused || PauseMenu.isOpen || (game.state !== 'playing')) {
    Mouse.consumeClick();
    TouchInput.consumeTap();
    renderer.render(scene, camera);
    renderRearview();
    return;
  }

  // ── Normal playing tick ───────────────────────────────────────────────────

  // (PauseMenu.isOpen check above covers the frozen-menu case)

  // ── Boost state: Shift + ammo ─────────────────────────────────────────────
  // Computed before vehicle.update so the speed cap is already correct this frame.
  {
    const wantBoost = Bindings.isAction('boost');
    const hasAmmo   = game.charge > BOOST.minAmmo;
    game.boosting   = wantBoost && hasAmmo;
    if (game.boosting) {
      game.charge = Math.max(0, game.charge - BOOST.costPerSec * dt);
      // If draining to zero, immediately deactivate
      if (game.charge <= 0) game.boosting = false;
    }
    if (game.boosting !== wasBoosting) {
      if (game.boosting) {
        setFace('turbo');
        setSpeedLinesActive(true);
      } else {
        setFace('neutral');
        setSpeedLinesActive(false);
      }
      wasBoosting = game.boosting;
    }
  }

  vehicle.update(dt, game);
  const preSpeed = Math.abs(vehicle.speed);
  const hit = noclip ? null : resolveBuildingCollisions(vehicle, buildingGrid ?? buildingAABBs);
  if (!noclip) resolveMapBounds(vehicle, cityBounds);
  tickCrashCooldown(dt, hit, preSpeed);
  // Tick the game timer (ends game at 0).
  tickTimer(dt);

  // Check NPC vehicle ram collisions.
  if (npcVehiclePool) {
    const npcHandles = npcVehiclePool.getHandles();
    const rSq = (NPC_VEHICLE.ramRadius + 1.8) * (NPC_VEHICLE.ramRadius + 1.8);
    if (Math.abs(vehicle.speed) >= NPC_VEHICLE.ramMinSpeed) {
      for (const nh of npcHandles) {
        if (!nh.alive || nh.spinning) continue;
        const dx = nh.position.x - vehicle.position.x;
        const dz = nh.position.z - vehicle.position.z;
        if (dx * dx + dz * dz < rSq) {
          if (game.boosting) {
            // ── Boost collision: instant destroy + spin-away + ammo reward ──
            const dist = Math.sqrt(dx * dx + dz * dz) || 1;
            startNpcSpin(nh, dx / dist, dz / dist);
            game.charge = Math.min(GAME.maxAmmo, game.charge + BOOST.ammoOnDestroy);
            game.score += NPC_VEHICLE.scoreRam;
            npcVehiclePool.respawnAfterDelay(nh, NPC_VEHICLE.respawnDelayMs);
            // Player keeps full speed while boosting — no slowdown.
          } else {
            // ── Smash collision: player slows, NPC survives ──
            vehicle.speed *= BOOST.smashSpeedMult;
            setFace('angry', MIRROR.angryMs);
            // NPC vehicle just bounces slightly — stays alive.
          }
          updateHud(game);
        }
      }
    }
  }

  // Update player sprite position / frame (must happen before applyChaseCamera
  // so the sprite position is set before the camera moves to look at it).
  if (playerSprite) playerSprite.update(vehicle);

  // Third-person chase camera (after sprite update so lookAt is stable).
  vehicle.applyChaseCamera(camera);

  // ── matrix must be updated before AI tick so raycasts and AI using camera
  //    world-pos get consistent values. One call per frame (after applyChaseCamera).
  camera.updateMatrixWorld(true);

  // AI dispatch (perception, behaviors, boss, bullets, population, HUD).
  // Returns the handles array so ramMoots can reuse it without a second getHandles() call.
  const aiHandles = tickAI(dt);

  // Collision: ram moots (pass pre-computed handles to avoid second allocation).
  if (aiHandles) ramMoots(aiHandles);

  // Record frame state.
  recorder.tick(dt, vehicle);

  window.__vxmMouse = Mouse;
  // camera.updateMatrixWorld already called above; pick aim from current state.
  const aim = impactSystem.pickAimPoint(camera, Mouse);
  pistol.aimAt(aim.point);
  if (Mouse.consumeClick() || TouchInput.consumeTap()) tryShoot(aim);

  pistol.update(dt);
  impactSystem.updateImpacts(dt);
  updateHud(game);
  // Update directional arrow / target countdown HUD each frame.
  if (game.targetHandle && game.targetHandle.group) {
    updateTargetHud(game, camera, game.targetHandle.group.position);
  } else {
    updateTargetHud(game, camera, null);
  }
  if (radio) radio.tick(dt);
  renderer.render(scene, camera);
  renderRearview();
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  // Escape / menu key: delegate to PauseMenu (it handles both open and close).
  if (Bindings.matches('menu', e.code)) {
    e.preventDefault();
    if (!PauseMenu.isOpen && game.state === 'playing') {
      PauseMenu.open();
    }
    // Close is handled inside pauseMenu.js capture-phase listener.
    return;
  }

  // Block game hotkeys while the menu is open.
  if (PauseMenu.isOpen) return;

  if (Bindings.matches('restart', e.code)) {
    if (game.state === 'gameover' || game.state === 'victory') {
      buildCity(levelManager.currentSeed).catch(console.error);
    } else {
      vehicle.reset();
    }
  } else if (Bindings.matches('radio', e.code)) {
    if (radio) radio.cycleChannel();
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
