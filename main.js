import * as THREE from 'three';
import { loadDb } from './lib/data/mootLoader.js';
import { Vehicle } from './lib/car/vehicle.js';
import {
  resolveBuildingCollisions,
  resolveNpcVehicleBodyCollision,
  resolveMapBounds,
} from './lib/car/collision.js';
import { Pistol } from './lib/weapons/pistol.js';
import { clearMootProjectiles, updateFlingMoots } from './lib/entities/moots.js';
import { createRecorder } from './lib/rewind/recorder.js';
import { createPlayback } from './lib/rewind/playback.js';
import {
  createHud,
  updateHud,
  hideLoginPrompt,
  registerHudSlot,
  setHudSlot,
  removeHudSlot,
  updateTargetHud,
  setGameOverVisible,
} from './lib/hud/overlays.js';
import { getMe, postQueue } from './lib/api.js';
import {
  createMirror,
  setFace,
  setReactionImage,
  setReactionImages,
  getMirrorCanvas,
  getMirrorSize,
} from './lib/hud/mirror.js';
import { createSpeedLines, setSpeedLinesActive } from './lib/hud/speedLines.js';
import { setupDebugPanel } from './lib/debug/panel.js';
import { Mouse } from './lib/mouse.js';
import { TouchInput } from './lib/input/touch.js';
import { Bindings } from './lib/input/bindings.js';
import { PauseMenu } from './lib/ui/pauseMenu.js';
import {
  SKYBOX,
  MOOT,
  GAME,
  CITY,
  WORLD,
  HIGHWAY,
  NPC_VEHICLE,
  TARGET,
  BOOST,
  MIRROR,
  SCORING,
  DEBUG,
} from './lib/config.js';
import { buildZoneMap, buildZoneMapFromSnapshot } from './lib/world/zones/zoneMap.js';
import { buildTerrain } from './lib/world/terrain/heightmap.js';
import { buildOcean } from './lib/world/terrain/ocean.js';
import { buildHighwaySpline } from './lib/world/highway/spline.js';
import { buildHighwayMesh } from './lib/world/highway/highwayMesh.js';
import { buildParkAssets } from './lib/world/park/parkGenerator.js';
import { createChunkManager } from './lib/world/chunks/chunkManager.js';
import { loadAllVehicleTextures } from './lib/assets/vehicleTextures.js';
import { createPlayerSprite } from './lib/car/playerSprite.js';
import { createImpactSystem } from './lib/game/impacts.js';
import { createGameState } from './lib/game/state.js';
import {
  generateCity,
  generateCityLayout,
  hydrateCityLayout,
  serializeCityLayout,
} from './lib/world/city/generator.js';
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

function resolveSkyboxMode() {
  const requestedMode = new URLSearchParams(location.search).get('skybox');
  if (requestedMode && Object.prototype.hasOwnProperty.call(SKYBOX.presets, requestedMode)) {
    return requestedMode;
  }
  return SKYBOX.defaultMode;
}

function createProceduralSkybox(preset) {
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 16;
  skyCanvas.height = 256;
  const ctx = skyCanvas.getContext('2d');
  if (!ctx) {
    console.warn('[vxm] Canvas 2D context unavailable; falling back to flat skybox color');
    return new THREE.Color(preset.clearColor);
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, skyCanvas.height);
  gradient.addColorStop(0, `#${preset.palette.top.toString(16).padStart(6, '0')}`);
  gradient.addColorStop(0.58, `#${preset.palette.horizon.toString(16).padStart(6, '0')}`);
  gradient.addColorStop(1, `#${preset.palette.bottom.toString(16).padStart(6, '0')}`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, skyCanvas.width, skyCanvas.height);

  const texture = new THREE.CanvasTexture(skyCanvas);
  texture.needsUpdate = true;
  return texture;
}

function resolveRendererColorSpace(value) {
  if (value === 'srgb') return THREE.SRGBColorSpace ?? 'srgb';
  if (value === 'linear-srgb') return THREE.LinearSRGBColorSpace ?? value;
  return value ?? THREE.SRGBColorSpace ?? 'srgb';
}

function resolveRendererOutputEncoding(value) {
  if (value === 'srgb') return THREE.sRGBEncoding ?? value;
  if (value === 'linear') return THREE.LinearEncoding ?? value;
  return value ?? THREE.sRGBEncoding ?? 'srgb';
}

function resolveToneMapping(value) {
  if (value === 'none') return THREE.NoToneMapping;
  if (value === 'linear') return THREE.LinearToneMapping;
  if (value === 'reinhard') return THREE.ReinhardToneMapping;
  if (value === 'cineon') return THREE.CineonToneMapping;
  if (value === 'aces') return THREE.ACESFilmicToneMapping;
  return THREE.NoToneMapping;
}

function applyHighVisibilityRendererSettings(targetRenderer) {
  const rendererSettings = SKYBOX.highVisibilityRenderer;
  if (!rendererSettings) return;

  // Explicit color/tone settings keep emergency full-bright colors out of
  // renderer defaults that can vary across Three.js revisions.
  if (
    Object.prototype.hasOwnProperty.call(rendererSettings, 'outputColorSpace') &&
    'outputColorSpace' in targetRenderer
  ) {
    targetRenderer.outputColorSpace = resolveRendererColorSpace(rendererSettings.outputColorSpace);
  }
  if (
    Object.prototype.hasOwnProperty.call(rendererSettings, 'outputEncoding') &&
    'outputEncoding' in targetRenderer
  ) {
    targetRenderer.outputEncoding = resolveRendererOutputEncoding(rendererSettings.outputEncoding);
  }
  targetRenderer.toneMapping = resolveToneMapping(rendererSettings.toneMapping);
  if (Number.isFinite(rendererSettings.toneMappingExposure)) {
    targetRenderer.toneMappingExposure = rendererSettings.toneMappingExposure;
  }
}

function createVisibilitySafeFog(preset) {
  const emergencyFog = SKYBOX.emergencyFog ?? {};
  const requestedNear = Number.isFinite(emergencyFog.near) ? emergencyFog.near : preset.fog.near;
  const requestedFar = Number.isFinite(emergencyFog.far) ? emergencyFog.far : preset.fog.far;
  const safeNear = Math.max(0, requestedNear);
  const safeFar = Math.max(safeNear + 1, requestedFar);
  return new THREE.Fog(
    preset.fog.color ?? preset.clearColor ?? WORLD.clearColor,
    safeNear,
    safeFar,
  );
}

// ── Scene setup ───────────────────────────────────────────────────────────────

const overlay = document.getElementById('overlay');
const canvas = document.getElementById('c');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
applyHighVisibilityRendererSettings(renderer);
const selectedSkyboxMode = resolveSkyboxMode();
const selectedSkyboxPreset =
  SKYBOX.presets[selectedSkyboxMode] || SKYBOX.presets[SKYBOX.defaultMode];
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(selectedSkyboxPreset.clearColor, 1);

const scene = new THREE.Scene();
scene.background = createProceduralSkybox(selectedSkyboxPreset);
scene.fog = createVisibilitySafeFog(selectedSkyboxPreset);

// Lights use the selected skybox preset so URL-selected skybox modes still
// choose their palette. restoreSkyboxLights() is also called after each world
// rebuild so scene cleanup preserves the active lighting setup.
const ambientLight = new THREE.AmbientLight(0xffffff, 1);
ambientLight.name = 'vxm-skybox-ambient-light';
ambientLight.userData.vxmDiagnosticCategory = 'visibility-light';
ambientLight.userData.vxmMaterialRole = 'ambient';
const fillLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
fillLight.name = 'vxm-skybox-fill-light';
fillLight.userData.vxmDiagnosticCategory = 'visibility-light';
fillLight.userData.vxmMaterialRole = 'fill';
const sunLight = new THREE.DirectionalLight(0xffffff, 1);
sunLight.name = 'vxm-skybox-sun-light';
sunLight.userData.vxmDiagnosticCategory = 'visibility-light';
sunLight.userData.vxmMaterialRole = 'sun';

function restoreSkyboxLights() {
  ambientLight.color.set(selectedSkyboxPreset.ambientLight?.color ?? 0xdde8ff);
  ambientLight.intensity = Number.isFinite(selectedSkyboxPreset.ambientLight?.intensity)
    ? selectedSkyboxPreset.ambientLight.intensity
    : 0.85;
  fillLight.color.set(selectedSkyboxPreset.fillLight?.skyColor ?? 0xb8dcff);
  fillLight.groundColor.set(selectedSkyboxPreset.fillLight?.groundColor ?? 0x7c8794);
  fillLight.intensity = Number.isFinite(selectedSkyboxPreset.fillLight?.intensity)
    ? selectedSkyboxPreset.fillLight.intensity
    : 0.7;
  sunLight.color.set(selectedSkyboxPreset.sunLight?.color ?? 0xfff3d0);
  sunLight.intensity = Number.isFinite(selectedSkyboxPreset.sunLight?.intensity)
    ? selectedSkyboxPreset.sunLight.intensity
    : 1.8;
  sunLight.position.set(...(selectedSkyboxPreset.sunLight?.position ?? [0.45, 1.0, 0.25]));

  for (const light of [ambientLight, fillLight, sunLight]) {
    light.visible = true;
    if (light.parent !== scene) scene.add(light);
  }
}
restoreSkyboxLights();

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.rotation.order = 'YXZ';
scene.add(camera);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ── Core objects ──────────────────────────────────────────────────────────────

const vehicle = new Vehicle();
const pistol = new Pistol(camera);
const recorder = createRecorder();
const impactSystem = createImpactSystem(scene);

let buildingAABBs = [];
let buildingGrid = null;
let navGrid = null;
let interestPoints = [];
let population = null;
let _levelManager = null;
let db = null;
let worldCacheUserKey = 'guest';
let cityBounds = null; // { minX, maxX, minZ, maxZ } — set after each buildCity call for spawn/minimap data
let currentPlayerSpawn = null; // spawn reused by in-world restarts so the world is not regenerated
// World systems — rebuilt on each buildCity call.
let zoneMap = null;
let terrainSystem = null; // { mesh, getTerrainY, dispose }
let oceanSystem = null; // { mesh, dispose }
let highwaySystem = null; // { meshes, rampAABBs, dispose }
let parkSystem = null; // { treeAABBs, dispose }
let chunkManager = createChunkManager();

let isBuilding = false; // guard against concurrent buildCity calls
let playerSprite = null; // player car sprite (third-person)
let npcVehiclePool = null; // pool of NPC vehicles
let targetMarker = null; // ground ring under the current target moot
let minimap = null; // minimap replacing the old radar

let playback = null;
let radio = null; // radio system (3 channels)
const paused = false;
let noclip = false;
let lastTime = 0;
let wasBoosting = false;

// Rearview mirror renderer/camera — populated by setupRearview() once the
// mirror DOM exists. The mirror camera sits just above the player and looks
// in the opposite direction the vehicle is facing.
let rearRenderer = null;
let rearCamera = null;
const _rearLook = new THREE.Vector3();
let rearFrameModulo = 0;

function setupRearview() {
  const mc = getMirrorCanvas();
  if (!mc) return;
  rearRenderer = new THREE.WebGLRenderer({ canvas: mc, antialias: true });
  applyHighVisibilityRendererSettings(rearRenderer);
  const pixelRatioCap = Math.max(0.25, MIRROR.rearviewPixelRatioCap ?? 1);
  rearRenderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap));
  const ms = getMirrorSize();
  rearRenderer.setSize(ms.width, ms.height, false);
  rearRenderer.setClearColor(selectedSkyboxPreset.clearColor, 1);
  rearCamera = new THREE.PerspectiveCamera(60, ms.width / ms.height, 0.1, 1000);
  rearCamera.rotation.order = 'YXZ';
  scene.add(rearCamera);
}

function renderRearview() {
  if (!rearRenderer || !rearCamera) return;
  const frameInterval = Math.max(1, Math.floor(MIRROR.rearviewRenderEveryFrames ?? 1));
  if (frameInterval > 1) {
    if (rearFrameModulo !== 0) {
      rearFrameModulo = (rearFrameModulo + 1) % frameInterval;
      return;
    }
    rearFrameModulo = (rearFrameModulo + 1) % frameInterval;
  }
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

function updatePistolAimAndShoot() {
  window.__vxmMouse = Mouse;
  pistol.aimAt();
  if (Mouse.consumeClick() || TouchInput.consumeTap()) {
    tryShoot(impactSystem.pickAimPoint(camera, Mouse));
  }
}

// ── Shared context fed to all AI tick functions each frame ────────────────────

// Updated every frame before AI dispatch.
const aiCtx = {
  navGrid: null,
  buildingAABBs: [],
  buildingGrid: null,
  interestPoints: [], // set once per city-build, not per frame
  truckPos: { x: 0, z: 0 },
  truckVelX: 0,
  truckVelZ: 0,
  now: 0,
  recentKills: [], // [{x,z,at}] — filled by splatMoot callback
  recentShots: [], // [{x,z,at}] — filled by tryShoot
  recentKillsCursor: 0, // start-index cursor for O(1) pruning
  recentShotsCursor: 0, // start-index cursor for O(1) pruning
  spawnProjectile: null, // bound after scene is available
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
    mesh.userData.isBullet = true; // prevent _clearCityMeshes from disposing shared geometry/material
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

function pickMapWideObjectivePoint() {
  const points = interestPoints.length > 0 ? interestPoints : navGrid?.interestPoints || [];
  if (points.length === 0) return null;

  for (let i = 0; i < 20; i++) {
    const pt = points[Math.floor(Math.random() * points.length)];
    if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.z)) return pt;
  }
  return null;
}

function spawnMapWideObjectiveTarget() {
  if (!population) return null;
  const pt = pickMapWideObjectivePoint();
  if (!pt || !population.spawnObjectiveTarget) return null;
  return population.spawnObjectiveTarget(pt);
}

// ── Game state machine ────────────────────────────────────────────────────────

const gs = createGameState({
  scene,
  camera,
  vehicle,
  recorder,
  getPlayback: () => playback,
  getMootHandles: () => (population ? population.getHandles() : []),
  getSessionMoots: () => [], // unused in new pipeline
  impactSystem,
  pistol,
  updateHud,
  spawnObjectiveTarget: spawnMapWideObjectiveTarget,
  releaseObjectiveTarget(handle) {
    if (population?.releaseObjectiveTarget) {
      population.releaseObjectiveTarget(handle);
    }
  },
  onSplatMoot(handle, _weapon) {
    if (population) population.notifyDeath(handle);
    // Record kill event for perception system (recentKills).
    const pos = handle.group ? handle.group.position : null;
    if (pos) {
      aiCtx.recentKills.push({ x: pos.x, z: pos.z, at: performance.now() });
    }
    // onTargetHit() handles normal target reassignment after ram/shot kills.
    // If this path ever sees the current target first, just clear the marker so
    // the dead target does not keep a ring during the same frame.
    if (handle === game.targetHandle && targetMarker) {
      targetMarker.detach();
    }
  },
  onVictoryTimeout(_id) {
    // Boss system removed — no-op.
  },
  onVictory(_carry) {
    // Boss system removed — no-op.
  },
  onRestart() {
    restartCurrentRun();
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

const {
  game,
  ramMoots,
  tryShoot: _legacyTryShoot,
  tickCrashCooldown,
  tickTimer,
  designateNewTarget,
  onRewindDone,
  onMootBulletHit,
  toggleSessionTimer,
  resetRunState,
  setCurrentPlayer,
} = gs;

// Wrap tryShoot to also record the shot event for perception (recentShots).
function tryShoot(aim) {
  const fired = _legacyTryShoot(aim);
  if (fired) {
    // Record the truck's actual position as the shot origin so nearby moots hear it.
    aiCtx.recentShots.push({ x: vehicle.position.x, z: vehicle.position.z, at: performance.now() });
  }
}

// Live diagnostics exposed through window.__vxm after startup. Keep this data
// cheap and serializable so browser/headless checks can inspect blackout causes.
function formatHexColor(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof THREE.Color) return `#${value.getHexString()}`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `#${Math.max(0, Math.min(0xffffff, value)).toString(16).padStart(6, '0')}`;
  }
  return String(value);
}

function describeMaterial(material, sourceMesh) {
  if (!material) {
    return {
      type: 'none',
      role: sourceMesh.userData?.vxmMaterialRole ?? null,
      color: null,
      emissive: null,
      visible: sourceMesh.visible,
    };
  }

  return {
    name: material.name || null,
    type: material.type,
    role: sourceMesh.userData?.vxmMaterialRole ?? null,
    boundaryType: sourceMesh.userData?.boundaryType ?? null,
    color: formatHexColor(material.color),
    emissive: formatHexColor(material.emissive),
    map: material.map
      ? {
          uuid: material.map.uuid,
          name: material.map.name || null,
          source: material.map.source?.data?.src || null,
        }
      : null,
    transparent: Boolean(material.transparent),
    opacity: material.opacity,
    toneMapped: material.toneMapped ?? null,
    wireframe: material.wireframe ?? false,
    side: material.side,
    visible: sourceMesh.visible,
    instanceCount: sourceMesh.isInstancedMesh ? sourceMesh.count : null,
  };
}

function summarizeMaterial(material, sourceMesh, summary) {
  const materials = Array.isArray(material) ? material : [material];
  for (const mat of materials) {
    const description = describeMaterial(mat, sourceMesh);
    const key = JSON.stringify({
      type: description.type,
      role: description.role,
      boundaryType: description.boundaryType,
      color: description.color,
      emissive: description.emissive,
      toneMapped: description.toneMapped,
      visible: description.visible,
    });
    const existing = summary.materials.find((entry) => entry.key === key);
    if (existing) {
      existing.meshes += 1;
      existing.instances += sourceMesh.isInstancedMesh ? sourceMesh.count : 0;
    } else {
      summary.materials.push({
        key,
        meshes: 1,
        instances: sourceMesh.isInstancedMesh ? sourceMesh.count : 0,
        material: description,
      });
    }
  }
}

function getDiagnosticCategory(object) {
  const data = object.userData || {};
  if (data.isBuildingInstanced || data.vxmDiagnosticCategory === 'building') return 'building';
  if (data.isTerrain || data.vxmDiagnosticCategory === 'terrain') return 'terrain';
  if (data.isParksAsset || data.vxmDiagnosticCategory === 'park') return 'park';
  if (data.isHighway || data.vxmDiagnosticCategory === 'highway') return 'highway';
  return null;
}

function createEmptyMeshSummary() {
  return {
    meshCount: 0,
    instancedMeshCount: 0,
    instanceCount: 0,
    visibleMeshCount: 0,
    invisibleMeshCount: 0,
    materialRoles: {},
    materials: [],
  };
}

function summarizeSceneMeshes() {
  const categories = {
    building: createEmptyMeshSummary(),
    terrain: createEmptyMeshSummary(),
    park: createEmptyMeshSummary(),
    highway: createEmptyMeshSummary(),
  };

  scene.traverse((object) => {
    if (!object.isMesh) return;
    const category = getDiagnosticCategory(object);
    if (!category) return;

    const summary = categories[category];
    const role = object.userData?.vxmMaterialRole || object.userData?.boundaryType || 'unlabeled';
    summary.meshCount += 1;
    summary.visibleMeshCount += object.visible ? 1 : 0;
    summary.invisibleMeshCount += object.visible ? 0 : 1;
    summary.materialRoles[role] = (summary.materialRoles[role] || 0) + 1;
    if (object.isInstancedMesh) {
      summary.instancedMeshCount += 1;
      summary.instanceCount += object.count;
    }
    summarizeMaterial(object.material, object, summary);
  });

  for (const summary of Object.values(categories)) {
    summary.materials = summary.materials.map(({ key: _key, ...entry }) => entry);
  }

  return categories;
}

function describeRenderer(targetRenderer) {
  if (!targetRenderer) return null;
  return {
    outputColorSpace: targetRenderer.outputColorSpace ?? null,
    outputEncoding: targetRenderer.outputEncoding ?? null,
    toneMapping: targetRenderer.toneMapping,
    toneMappingExposure: targetRenderer.toneMappingExposure,
    physicallyCorrectLights: targetRenderer.physicallyCorrectLights ?? null,
    useLegacyLights: targetRenderer.useLegacyLights ?? null,
    clearColor: formatHexColor(targetRenderer.getClearColor(new THREE.Color())),
    pixelRatio: targetRenderer.getPixelRatio(),
    size: targetRenderer.getSize(new THREE.Vector2()).toArray(),
  };
}

function describeFog(fog) {
  if (!fog) return null;
  return {
    type: fog.type,
    color: formatHexColor(fog.color),
    near: fog.near ?? null,
    far: fog.far ?? null,
    density: fog.density ?? null,
  };
}

function describeLights() {
  const lights = [];
  scene.traverse((object) => {
    if (!object.isLight) return;
    lights.push({
      name: object.name || null,
      type: object.type,
      uuid: object.uuid,
      visible: object.visible,
      intensity: object.intensity ?? null,
      color: formatHexColor(object.color),
      groundColor: formatHexColor(object.groundColor),
      position: object.position ? object.position.toArray() : null,
    });
  });
  return lights;
}

function getVisibilityDiagnostics() {
  return {
    generatedAt: new Date().toISOString(),
    skyboxMode: selectedSkyboxMode,
    renderer: describeRenderer(renderer),
    rearRenderer: describeRenderer(rearRenderer),
    fog: describeFog(scene.fog),
    background:
      scene.background instanceof THREE.Color
        ? formatHexColor(scene.background)
        : { type: scene.background?.type ?? null, uuid: scene.background?.uuid ?? null },
    lights: describeLights(),
    worldSystems: {
      hasTerrain: Boolean(terrainSystem),
      hasOcean: Boolean(oceanSystem),
      hasHighway: Boolean(highwaySystem),
      hasPark: Boolean(parkSystem),
      buildingAabbCount: buildingAABBs.length,
    },
    meshes: summarizeSceneMeshes(),
  };
}

// ── City initialisation ───────────────────────────────────────────────────────

function resolveWorldCacheUserKey(player) {
  if (!player) return 'guest';
  const rawKey = player.id ?? player.handle ?? player.username ?? player.name ?? 'guest';
  return (
    String(rawKey)
      .replace(/[^a-z0-9_-]/gi, '_')
      .slice(0, 80) || 'guest'
  );
}

function getWorldLayoutCacheSchema() {
  const cacheSchema = WORLD.cache?.layoutSchema ?? 'default-layout';
  const plannedRoads = CITY.voronoiRoads ?? {};
  const signature = {
    schema: cacheSchema,
    city: {
      width: CITY.width,
      length: CITY.length,
      streetSpacing: CITY.streetSpacing,
      streetSpacingJitter: CITY.streetSpacingJitter,
      plannedHierarchicalRoads: {
        enabled: Boolean(plannedRoads.enabled),
        seedOffset: plannedRoads.seedOffset ?? 0,
        snapGrid: plannedRoads.snapGrid ?? 0,
        minSegmentLength: plannedRoads.minSegmentLength ?? 0,
        minIntersectionSpacing: plannedRoads.minIntersectionSpacing ?? 0,
        minIntersectionAngleDeg: plannedRoads.minIntersectionAngleDeg ?? 0,
        backboneSnapDistance: plannedRoads.backboneSnapDistance ?? 0,
        waterfrontCollectorSpacing: plannedRoads.waterfrontCollectorSpacing ?? 0,
        waterfrontCollectorOffset: plannedRoads.waterfrontCollectorOffset ?? 0,
        circuitCollectorSpacing: plannedRoads.circuitCollectorSpacing ?? 0,
        circuitCollectorOffset: plannedRoads.circuitCollectorOffset ?? 0,
        radialConnectorCount: plannedRoads.radialConnectorCount ?? 0,
        localGridSpacing: plannedRoads.localGridSpacing ?? 0,
        localJitter: plannedRoads.localJitter ?? 0,
        urbanLocalSpacing: plannedRoads.urbanLocalSpacing ?? 0,
        suburbanLocalSpacing: plannedRoads.suburbanLocalSpacing ?? 0,
        ruralLocalSpacing: plannedRoads.ruralLocalSpacing ?? 0,
        urbanLocalDensity: plannedRoads.urbanLocalDensity ?? 0,
        suburbanLocalDensity: plannedRoads.suburbanLocalDensity ?? 0,
        ruralLocalDensity: plannedRoads.ruralLocalDensity ?? 0,
        arterialWidth: plannedRoads.arterialWidth ?? 0,
        collectorWidth: plannedRoads.collectorWidth ?? 0,
        localWidth: plannedRoads.localWidth ?? 0,
        feederWidth: plannedRoads.feederWidth ?? 0,
        feederSearchRadius: plannedRoads.feederSearchRadius ?? 0,
        plotClearance: plannedRoads.plotClearance ?? 0,
      },
    },
    highway: {
      expresswayHalfWidth: HIGHWAY.expresswayHalfWidth ?? HIGHWAY.roadHalfWidth,
      deckHeight: HIGHWAY.deckHeight ?? HIGHWAY.overpassHeight,
      corridorHalfWidth: HIGHWAY.corridorHalfWidth,
      circuitInset: HIGHWAY.circuitInset,
      circuitWaterInset: HIGHWAY.circuitWaterInset,
      circuitJitter: HIGHWAY.circuitJitter,
      circuitControlPoints: HIGHWAY.circuitControlPoints,
      centerlineJitter: HIGHWAY.centerlineJitter,
      controlPoints: HIGHWAY.controlPoints,
      loopInset: HIGHWAY.loopInset,
      splineSteps: HIGHWAY.splineSteps,
      interchangeCountMin: HIGHWAY.interchangeCountMin,
      interchangeCountMax: HIGHWAY.interchangeCountMax,
      interchangeSeedOffset: HIGHWAY.interchangeSeedOffset,
      interchangeSpacingJitter: HIGHWAY.interchangeSpacingJitter,
      rampHalfWidth: HIGHWAY.rampHalfWidth,
      rampShoulderWidth: HIGHWAY.rampShoulderWidth,
      rampLength: HIGHWAY.rampLength,
      rampMergeLength: HIGHWAY.rampMergeLength,
      rampSideOffset: HIGHWAY.rampSideOffset,
      rampMaxGrade: HIGHWAY.rampMaxGrade,
      rampCurveOffset: HIGHWAY.rampCurveOffset,
      rampReservationHalfWidth: HIGHWAY.rampReservationHalfWidth,
    },
  };
  return JSON.stringify(signature);
}

function getWorldCacheKey(seed) {
  const cacheVersion = WORLD.cache?.version ?? 1;
  const layoutSchema = encodeURIComponent(getWorldLayoutCacheSchema());
  return `v${cacheVersion}:schema:${layoutSchema}:user:${worldCacheUserKey}:seed:${seed}:size:${CITY.width}x${CITY.length}`;
}

function openWorldCacheDb() {
  const cacheConfig = WORLD.cache;
  const indexedDb = globalThis.indexedDB;
  if (!cacheConfig || !indexedDb) return Promise.resolve(null);

  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDb.open(cacheConfig.dbName, 1);
    } catch (err) {
      console.warn('[vxm] IndexedDB world cache unavailable; generating world data normally', err);
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const cacheDb = request.result;
      if (!cacheDb.objectStoreNames.contains(cacheConfig.storeName)) {
        cacheDb.createObjectStore(cacheConfig.storeName, { keyPath: 'key' });
      }
    };
    request.onerror = () => {
      console.warn(
        '[vxm] IndexedDB world cache open failed; generating world data normally',
        request.error,
      );
      resolve(null);
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function readWorldCacheRecord(cacheDb, key) {
  const storeName = WORLD.cache?.storeName;
  if (!cacheDb || !storeName) return Promise.resolve(null);

  return new Promise((resolve) => {
    let request;
    try {
      request = cacheDb.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    } catch (err) {
      console.warn('[vxm] IndexedDB world cache read failed; generating world data normally', err);
      resolve(null);
      return;
    }
    request.onerror = () => {
      console.warn(
        '[vxm] IndexedDB world cache read failed; generating world data normally',
        request.error,
      );
      resolve(null);
    };
    request.onsuccess = () => resolve(request.result || null);
  });
}

function writeWorldCacheRecord(cacheDb, record) {
  const storeName = WORLD.cache?.storeName;
  if (!cacheDb || !storeName) return Promise.resolve(false);

  return new Promise((resolve) => {
    let request;
    try {
      request = cacheDb.transaction(storeName, 'readwrite').objectStore(storeName).put(record);
    } catch (err) {
      console.warn(
        '[vxm] IndexedDB world cache write failed; continuing without persisted world data',
        err,
      );
      resolve(false);
      return;
    }
    request.onerror = () => {
      console.warn(
        '[vxm] IndexedDB world cache write failed; continuing without persisted world data',
        request.error,
      );
      resolve(false);
    };
    request.onsuccess = () => resolve(true);
  });
}

function hydrateHighwayPoint(point) {
  if (!point || typeof point !== 'object') return null;
  const x = Number(point.x);
  const z = Number(point.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const hydrated = { x, z };
  const y = Number(point.y);
  if (Number.isFinite(y)) hydrated.y = y;
  return hydrated;
}

function serializeHighwayPoint(point) {
  const serialized = { x: point.x, z: point.z };
  if (Number.isFinite(point.y)) serialized.y = point.y;
  return serialized;
}

function hydrateHighwayPolyline(polyline, fallbackId = 'polyline') {
  if (!polyline || typeof polyline !== 'object' || !Array.isArray(polyline.points)) return null;
  const points = polyline.points.map(hydrateHighwayPoint).filter(Boolean);
  if (points.length < 2) return null;
  return {
    id: String(polyline.id || fallbackId),
    kind: String(polyline.kind || 'highway'),
    halfWidth: Number.isFinite(Number(polyline.halfWidth)) ? Number(polyline.halfWidth) : undefined,
    points,
  };
}

function serializeHighwayPolyline(polyline) {
  return {
    id: polyline.id,
    kind: polyline.kind,
    halfWidth: polyline.halfWidth,
    points: polyline.points.map(serializeHighwayPoint),
  };
}

function hydrateHighwayRamp(ramp, index) {
  if (!ramp || typeof ramp !== 'object' || !Array.isArray(ramp.points)) return null;
  const points = ramp.points.map(hydrateHighwayPoint).filter(Boolean);
  if (points.length < 2) return null;
  const controlPts = Array.isArray(ramp.controlPts)
    ? ramp.controlPts.map(hydrateHighwayPoint).filter(Boolean)
    : [];
  return {
    id: String(ramp.id || `ramp-${index + 1}`),
    type: String(ramp.type || 'ramp'),
    side: Number.isFinite(Number(ramp.side)) ? Number(ramp.side) : 1,
    direction: Number.isFinite(Number(ramp.direction)) ? Number(ramp.direction) : 1,
    attachIndex: Number.isFinite(Number(ramp.attachIndex)) ? Number(ramp.attachIndex) : 0,
    halfWidth: Number.isFinite(Number(ramp.halfWidth))
      ? Number(ramp.halfWidth)
      : HIGHWAY.rampHalfWidth,
    points,
    controlPts,
    touchdown: hydrateHighwayPoint(ramp.touchdown) || points[points.length - 1],
  };
}

function serializeHighwayRamp(ramp) {
  return {
    id: ramp.id,
    type: ramp.type,
    side: ramp.side,
    direction: ramp.direction,
    attachIndex: ramp.attachIndex,
    halfWidth: ramp.halfWidth,
    points: ramp.points.map(serializeHighwayPoint),
    controlPts: Array.isArray(ramp.controlPts) ? ramp.controlPts.map(serializeHighwayPoint) : [],
    touchdown: ramp.touchdown ? serializeHighwayPoint(ramp.touchdown) : null,
  };
}

function hydrateHighwayLayout(highway) {
  if (
    !highway ||
    typeof highway !== 'object' ||
    !Array.isArray(highway.points) ||
    !Array.isArray(highway.rampIndices)
  ) {
    return null;
  }
  const points = highway.points.map(hydrateHighwayPoint).filter(Boolean);
  const rampIndices = highway.rampIndices.map((i) => Number(i)).filter(Number.isFinite);
  if (points.length < 2 || rampIndices.length < 3 || rampIndices.length > 4) return null;

  const controlPts = Array.isArray(highway.controlPts)
    ? highway.controlPts.map(hydrateHighwayPoint).filter(Boolean)
    : [];
  const ramps = Array.isArray(highway.ramps)
    ? highway.ramps.map(hydrateHighwayRamp).filter(Boolean)
    : [];
  const reservationPolylines = Array.isArray(highway.reservationPolylines)
    ? highway.reservationPolylines.map(hydrateHighwayPolyline).filter(Boolean)
    : [
        {
          id: 'expressway-main',
          kind: 'expressway',
          halfWidth: HIGHWAY.corridorHalfWidth,
          points,
        },
        ...ramps.map((ramp) => ({
          id: ramp.id,
          kind: 'ramp',
          halfWidth: HIGHWAY.rampReservationHalfWidth,
          points: ramp.points,
        })),
      ];

  if (ramps.length !== rampIndices.length || reservationPolylines.length < 1 + ramps.length)
    return null;
  return {
    points,
    controlPts,
    rampIndices,
    ramps,
    reservationPolylines,
    isCircuit: Boolean(highway.isCircuit),
  };
}

function serializeHighwayLayout(highway) {
  return {
    isCircuit: Boolean(highway.isCircuit),
    points: highway.points.map(serializeHighwayPoint),
    controlPts: Array.isArray(highway.controlPts)
      ? highway.controlPts.map(serializeHighwayPoint)
      : [],
    rampIndices: highway.rampIndices.slice(),
    ramps: Array.isArray(highway.ramps) ? highway.ramps.map(serializeHighwayRamp) : [],
    reservationPolylines: Array.isArray(highway.reservationPolylines)
      ? highway.reservationPolylines.map(serializeHighwayPolyline)
      : [],
  };
}

async function loadCachedWorldData(seed) {
  const cacheDb = await openWorldCacheDb();
  if (!cacheDb) return null;

  try {
    const key = getWorldCacheKey(seed);
    const record = await readWorldCacheRecord(cacheDb, key);
    cacheDb.close();
    const expectedLayoutSchema = getWorldLayoutCacheSchema();
    if (
      !record ||
      record.version !== (WORLD.cache?.version ?? 1) ||
      record.layoutSchema !== expectedLayoutSchema ||
      record.seed !== seed
    ) {
      return null;
    }

    const cachedZoneMap = buildZoneMapFromSnapshot(record.zoneMap);
    const cachedLayout = hydrateCityLayout(record.cityLayout, seed);
    const cachedHighway = hydrateHighwayLayout(record.highway);
    if (!cachedZoneMap || !cachedLayout || !cachedHighway) {
      return null;
    }

    console.log('[vxm] Hydrated cached world data from IndexedDB');
    return {
      zoneMap: cachedZoneMap,
      cityLayout: cachedLayout,
      highway: cachedHighway,
    };
  } catch (err) {
    console.warn('[vxm] IndexedDB world cache hydrate failed; generating world data normally', err);
    try {
      cacheDb.close();
    } catch {}
    return null;
  }
}

async function saveWorldDataToCache(seed, zoneMapRef, cityLayout, highway) {
  const cacheDb = await openWorldCacheDb();
  if (!cacheDb) return false;

  try {
    const key = getWorldCacheKey(seed);
    const record = {
      key,
      version: WORLD.cache?.version ?? 1,
      layoutSchema: getWorldLayoutCacheSchema(),
      user: worldCacheUserKey,
      seed,
      savedAt: Date.now(),
      zoneMap: zoneMapRef.serialize(),
      cityLayout: serializeCityLayout(cityLayout),
      highway: serializeHighwayLayout(highway),
    };
    const saved = await writeWorldCacheRecord(cacheDb, record);
    cacheDb.close();
    if (saved) console.log('[vxm] Saved generated world data to IndexedDB');
    return saved;
  } catch (err) {
    console.warn(
      '[vxm] IndexedDB world cache save failed; continuing without persisted world data',
      err,
    );
    try {
      cacheDb.close();
    } catch {}
    return false;
  }
}

/**
 * Build / rebuild the city for a given seed.
 * Disposes previous city geometry and population.
 *
 * @param {number} seed
 */
async function buildCity(seed) {
  if (isBuilding) return; // drop concurrent calls
  isBuilding = true;

  // Dispose previous world systems before clearing scene.
  if (terrainSystem) {
    terrainSystem.dispose();
    terrainSystem = null;
  }
  if (oceanSystem) {
    oceanSystem.dispose();
    oceanSystem = null;
  }
  if (highwaySystem) {
    highwaySystem.dispose();
    highwaySystem = null;
  }
  if (parkSystem) {
    parkSystem.dispose();
    parkSystem = null;
  }
  chunkManager.dispose();
  chunkManager = createChunkManager(); // fresh manager for new world

  // Destroy previous player sprite (it will be re-created below after scene clear).
  if (playerSprite) {
    playerSprite.destroy();
    playerSprite = null;
  }

  overlay.classList.remove('hidden');
  overlay.textContent = 'Generating city…';

  // Dispose old population.
  if (population) population.destroyAll();
  // Destroy old NPC vehicles.
  if (npcVehiclePool) npcVehiclePool.destroyAll();
  // Destroy old target marker.
  if (targetMarker) {
    targetMarker.destroy();
    targetMarker = null;
  }
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
  restoreSkyboxLights();

  const cachedWorldData = await loadCachedWorldData(seed);
  let highwayLayout;
  let hwPoints;
  let rampIndices;
  let cityLayout;

  if (cachedWorldData) {
    zoneMap = cachedWorldData.zoneMap;
    highwayLayout = cachedWorldData.highway;
    hwPoints = highwayLayout.points;
    rampIndices = highwayLayout.rampIndices;
    cityLayout = cachedWorldData.cityLayout;
  } else {
    // ── Build zone map (pure data, no THREE) ──────────────────────────────────
    zoneMap = buildZoneMap({ seed });

    // ── Build highway route + reserve its zone corridor before city sampling ────
    // The elevated bridge mesh is built after terrain exists, but the zone map must
    // already know the highway corridor so city roads/buildings do not occupy it.
    highwayLayout = buildHighwaySpline({ seed });
    hwPoints = highwayLayout.points;
    rampIndices = highwayLayout.rampIndices;
    if (typeof zoneMap.markHighwayReservations === 'function') {
      zoneMap.markHighwayReservations(highwayLayout.reservationPolylines);
    } else {
      zoneMap.markHighway(hwPoints);
      for (const ramp of highwayLayout.ramps || [])
        zoneMap.markHighway(ramp.points, { halfWidth: HIGHWAY.rampReservationHalfWidth });
    }

    // ── Precompute city layout (pure data, no THREE) ────────────────────────────
    // Roads, alleys, buildable plots, bounds, and sidewalk interest data must be
    // known before terrain creation so terrain can bake visible city surfaces. The
    // highway corridor is already marked above so layout sampling avoids it.
    cityLayout = generateCityLayout({ seed, zoneMap, highwayLayout });

    await saveWorldDataToCache(seed, zoneMap, cityLayout, highwayLayout);
  }

  // ── Build terrain mesh ──────────────────────────────────────────────────────
  terrainSystem = buildTerrain({ scene, zoneMap, cityLayout });

  // ── Build ocean plane ──────────────────────────────────────────────────────
  oceanSystem = buildOcean({ scene, zoneMap });

  // ── Build visible elevated highway bridge/overpass mesh ─────────────────────
  highwaySystem = buildHighwayMesh({
    scene,
    splinePoints: hwPoints,
    rampIndices,
    ramps: highwayLayout?.ramps || [],
    reservationPolylines: highwayLayout?.reservationPolylines || [],
    getTerrainY: terrainSystem.getTerrainY,
    zoneMap,
  });
  // Register highway meshes with chunk manager for visibility culling.
  for (const m of highwaySystem.meshes) chunkManager.register(m);

  // ── Generate city from the precomputed layout (terrain-elevated meshes) ─────
  const city = generateCity({
    scene,
    seed,
    zoneMap,
    highwayLayout,
    getTerrainY: terrainSystem.getTerrainY,
    layout: cityLayout,
  });
  buildingAABBs = city.buildingAABBs;
  buildingGrid = city.buildingGrid;
  interestPoints = city.interestPoints;
  navGrid = city.navGrid;
  cityBounds = city.bounds; // store per-level for spawn/minimap data

  // Ramp AABBs are metadata only; do not feed them into vehicle-stopping
  // collision. The highway mesh is elevated/curved visible geometry, while a
  // coarse ground-plane AABB would behave like an invisible wall around ramps.

  // ── Build park assets ──────────────────────────────────────────────────────
  parkSystem = buildParkAssets({
    scene,
    zoneMap,
    getTerrainY: terrainSystem.getTerrainY,
  });
  // Park tree/bench meshes are decorative and deliberately do not become
  // vehicle-stopping blockers. Tiny trunk AABBs made the truck stop against
  // objects that read as visually too small for gameplay collision.
  // Register all scene objects that were just added (buildings and park assets; city roads/sidewalks are baked into terrain).
  // We iterate scene.children snapshot: everything added by generateCity + parkSystem.
  for (const obj of scene.children) {
    if (obj === camera) continue;
    if (obj === ambientLight || obj === fillLight || obj === sunLight) continue;
    if (
      obj.userData &&
      (obj.userData.isTerrain || obj.userData.isOcean || obj.userData.isHighway) // already registered above
    )
      continue;
    if (
      obj.userData &&
      (obj.userData.isPlayerSprite || obj.userData.isNpcVehicle || obj.userData.isTargetMarker)
    )
      continue;
    if (obj === rearCamera) continue;
    chunkManager.register(obj);
  }

  // Wire terrain/highway support query into vehicle so hills, elevated ramps, and
  // freeway-side drop-offs use the same physical surface the player can see.
  const getPlayerSurface = (x, z, referenceY) => {
    const terrainY = terrainSystem.getTerrainY(x, z);
    const highwaySurface =
      highwaySystem && typeof highwaySystem.sampleSurface === 'function'
        ? highwaySystem.sampleSurface(x, z, referenceY)
        : null;
    if (highwaySurface && highwaySurface.height >= terrainY) return highwaySurface;
    return terrainY;
  };
  vehicle.setTerrainQuery(getPlayerSurface);

  aiCtx.navGrid = navGrid;
  aiCtx.buildingAABBs = buildingAABBs;
  aiCtx.buildingGrid = buildingGrid;
  aiCtx.interestPoints = city.interestPoints;
  aiCtx.spawnProjectile = makeSpawnProjectile(scene);

  // Pick player spawn.
  const playerSpawn = pickPlayerSpawn(city.bounds, interestPoints);
  currentPlayerSpawn = { x: playerSpawn.x, z: playerSpawn.z };

  // Place vehicle at player spawn (setPositionYaw snaps Y to terrain).
  vehicle.reset();
  vehicle.setPositionYaw(currentPlayerSpawn.x, currentPlayerSpawn.z, 0);

  // Re-create player sprite for the new city.
  playerSprite = createPlayerSprite(scene);

  // Re-create target marker.
  targetMarker = createTargetMarker(scene, { getTerrainY: terrainSystem.getTerrainY });

  // Create population manager.
  population = createPopulation({
    scene,
    db,
    navGrid,
    buildingAABBs,
    // onSplatMoot is not wired here; the gameState dep handles death events.
  });

  overlay.textContent = 'Warming moot textures…';
  // Texture warmup must not block entering play; active moots use placeholders
  // until each texture finishes loading in the background.
  population.loadTextures().catch((err) => console.warn('[vxm] moot texture warmup failed', err));

  // Boot population in ring around player (fire-and-forget — not async).
  population.boot(currentPlayerSpawn);

  // Spawn NPC vehicle fleet on road waypoints.
  npcVehiclePool = createNpcVehiclePool({ scene, navGrid });

  game.charge = GAME.startAmmo;
  game.capacitors = 0;
  game.health = 0; // truck is invincible
  game.state = 'playing';
  game.score = 0;
  game.timeRemaining = TARGET.startTimeS;
  game.targetCountdown = TARGET.targetCountdownS;
  game.combo = 1;
  game.mootsAlive = POP_STANDING_COUNT;
  game.mootsTotal = POP_STANDING_COUNT;

  // Update playback with new vehicle reference (no moot handles needed).
  if (playback) {
    playback = createPlayback(scene, vehicle);
  }

  recorder.reset();
  impactSystem.clearImpacts();

  isBuilding = false; // release guard
  overlay.classList.add('hidden');
  setGameOverVisible(false);
  setFace('neutral');
  updateHud(game);
  // Update minimap city layer now that bounds and road data are available.
  if (minimap)
    minimap.buildCityLayer(
      city.bounds,
      city.roadSegments,
      city.buildingAABBs,
      highwayLayout,
      zoneMap,
    );
  // Designate the first target.
  designateNewTarget();
}

function restartCurrentRun() {
  if (isBuilding) return;
  if (!terrainSystem || !navGrid || !cityBounds) {
    console.warn('[vxm] restart requested before world was ready');
    return;
  }

  overlay.classList.add('hidden');
  setGameOverVisible(false);

  if (targetMarker) targetMarker.detach();
  resetRunState();

  clearAiProjectiles();
  clearMootProjectiles(scene);
  aiCtx.recentKills.length = 0;
  aiCtx.recentShots.length = 0;
  aiCtx.recentKillsCursor = 0;
  aiCtx.recentShotsCursor = 0;
  impactSystem.clearImpacts();

  const spawn = currentPlayerSpawn || pickPlayerSpawn(cityBounds, interestPoints);
  currentPlayerSpawn = { x: spawn.x, z: spawn.z };
  vehicle.reset();
  vehicle.setPositionYaw(currentPlayerSpawn.x, currentPlayerSpawn.z, 0);

  if (population) population.destroyAll();
  population = createPopulation({
    scene,
    db,
    navGrid,
    buildingAABBs,
  });
  population
    .loadTextures()
    .catch((err) => console.warn('[vxm] moot texture warmup failed after restart', err));
  population.boot(currentPlayerSpawn);

  if (npcVehiclePool) npcVehiclePool.destroyAll();
  npcVehiclePool = createNpcVehiclePool({ scene, navGrid });

  game.mootsAlive = population.activeCount;
  game.mootsTotal = POP_STANDING_COUNT;
  recorder.reset();
  if (playback) playback = createPlayback(scene, vehicle);
  if (!targetMarker)
    targetMarker = createTargetMarker(scene, { getTerrainY: terrainSystem.getTerrainY });

  setFace('neutral');
  updateHud(game);
  designateNewTarget();
}

// Approximate constant for moot counter (not critical after population takes over).
const POP_STANDING_COUNT = 60;

// startNextLevel removed — no boss, no level transitions.

/** Remove all city-generated Mesh/Group children from the scene.
 * Disposes geometry and materials on all Mesh descendants to free GPU memory.
 * Pistol is parented to camera (userData.isPistol=true) — not touched.
 * Impact sprites are short-lived and managed by impactSystem — skip.
 * Park/terrain/ocean/highway assets are managed by their own dispose() and skipped here.
 */
function _clearCityMeshes() {
  const toRemove = [];
  for (const obj of scene.children) {
    if (obj === camera || obj === rearCamera || obj.isLight) continue;
    if (
      obj.userData &&
      (obj.userData.isPistol ||
        obj.userData.isImpact ||
        obj.userData.isBullet ||
        obj.userData.isPlayerSprite ||
        obj.userData.isNpcVehicle ||
        obj.userData.isTargetMarker ||
        obj.userData.isTerrain ||
        obj.userData.isOcean ||
        obj.userData.isHighway ||
        obj.userData.isParksAsset ||
        obj.userData.isBuildingInstanced)
    )
      continue;
    toRemove.push(obj);
  }
  for (const o of toRemove) {
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
      worldCacheUserKey = resolveWorldCacheUserKey(player);
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
  const urlSeed = Number.parseInt(new URLSearchParams(location.search).get('seed') || '0', 10);
  const initialSeed = urlSeed || CITY.seed;

  _levelManager = createLevelManager(initialSeed);

  // Create HUD components.
  createHud();
  createMirror();
  createSpeedLines();
  setupDebugPanel({ pistol, moot: MOOT });

  // Set up the rearview mirror's WebGL renderer and camera.
  setupRearview();

  // Create minimap (replaces old radar).
  minimap = createMinimap();
  // No boss portrait.

  // Create radio. Discover music files asynchronously; playback starts on the
  // first user gesture (browsers block autoplay until then).
  radio = createRadio();
  radio.loadAll().catch(console.error);

  // Build first city.
  await buildCity(initialSeed);

  playback = createPlayback(scene, vehicle);

  window.__vxm = {
    scene,
    camera,
    renderer,
    vehicle,
    pistol,
    game,
    recorder,
    playback,
    get diagnostics() {
      return getVisibilityDiagnostics();
    },
    getVisibilityDiagnostics,
    get mootHandles() {
      return population ? population.getHandles() : [];
    },
    get population() {
      return population;
    },
    get navGrid() {
      return navGrid;
    },
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
  while (
    aiCtx.recentKillsCursor < aiCtx.recentKills.length &&
    aiCtx.recentKills[aiCtx.recentKillsCursor].at < staleKill
  ) {
    aiCtx.recentKillsCursor++;
  }
  while (
    aiCtx.recentShotsCursor < aiCtx.recentShots.length &&
    aiCtx.recentShots[aiCtx.recentShotsCursor].at < staleShot
  ) {
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
  aiCtx.truckVelX = truckVelX;
  aiCtx.truckVelZ = truckVelZ;
  aiCtx.now = now;

  const handles = population.getHandles(true);

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

    // Resync Y to terrain after horizontal movement (AI ticks only update x/z).
    if (terrainSystem) {
      m.group.position.y = terrainSystem.getTerrainY(m.group.position.x, m.group.position.z);
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
    minimap.update(truckPos, vehicle.yaw, handles, npcHandles, game.targetHandle, dt);
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
        if (playerSprite) playerSprite.update(vehicle);
        vehicle.applyChaseCamera(camera);
      }

      window.__vxmMouse = Mouse;
      camera.updateMatrixWorld(true);
      updatePistolAimAndShoot();
      pistol.update(dt);
      impactSystem.updateImpacts(dt);
      updateFlingMoots(dt, scene);
      updateHud(game);
      renderer.render(scene, camera);
      renderRearview();
      if (done) onRewindDone();
    }
    return;
  }

  // ── Victory / gameover: only render, don't tick AI ───────────────────────
  if (paused || PauseMenu.isOpen || game.state !== 'playing') {
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
    const hasAmmo = game.charge > BOOST.minAmmo;
    game.boosting = wantBoost && hasAmmo;
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
  if (!noclip) resolveMapBounds(vehicle, cityBounds);
  const hit = noclip ? null : resolveBuildingCollisions(vehicle, buildingGrid ?? buildingAABBs);

  // Update chunk visibility based on player position.
  chunkManager.update(vehicle.position.x, vehicle.position.z);

  // Check jump scoring.
  if (vehicle.jumpScored) {
    vehicle.jumpScored = false;
    game.score = (game.score || 0) + SCORING.jumpScore;
    updateHud(game);
  }
  tickCrashCooldown(dt, hit, preSpeed);
  // Tick the game timer (ends game at 0).
  tickTimer(dt);

  // Check NPC vehicle ram/body collisions.
  if (!noclip && npcVehiclePool && Math.abs(vehicle.speed) >= NPC_VEHICLE.ramMinSpeed) {
    const npcHandles = npcVehiclePool.getHandles();
    const boostRadius = NPC_VEHICLE.ramRadius + 1.8;
    const boostRadiusSq = boostRadius * boostRadius;
    for (const nh of npcHandles) {
      if (!nh.alive || nh.spinning) continue;
      const dx = nh.position.x - vehicle.position.x;
      const dz = nh.position.z - vehicle.position.z;
      if (game.boosting) {
        if (dx * dx + dz * dz >= boostRadiusSq) continue;
        // ── Boost collision: instant destroy + spin-away + ammo reward ──
        const dist = Math.sqrt(dx * dx + dz * dz) || 1;
        startNpcSpin(nh, dx / dist, dz / dist);
        game.charge = Math.min(GAME.maxAmmo, game.charge + BOOST.ammoOnDestroy);
        game.score += NPC_VEHICLE.scoreRam;
        npcVehiclePool.respawnAfterDelay(nh, NPC_VEHICLE.respawnDelayMs);
        // Player keeps full speed while boosting — no slowdown.
        updateHud(game);
      } else {
        // ── Body collision: player slows, NPC survives and receives shove/spin ──
        const bodyHit = resolveNpcVehicleBodyCollision(vehicle, nh);
        if (!bodyHit) continue;
        setFace('angry', MIRROR.angryMs);
        updateHud(game);
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

  updatePistolAimAndShoot();

  pistol.update(dt);
  impactSystem.updateImpacts(dt);
  updateFlingMoots(dt, scene);
  updateHud(game);
  // Update directional arrow / target countdown HUD each frame.
  if (game.targetHandle?.group) {
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

  if (e.code === DEBUG.devTimerShiftAltToggleCode && e.shiftKey && e.altKey && !e.ctrlKey) {
    e.preventDefault();
    const enabled = toggleSessionTimer();
    console.log(`[vxm] session timer ${enabled ? 'ON' : 'OFF'}`);
    return;
  }

  if (Bindings.matches('restart', e.code)) {
    restartCurrentRun();
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
  overlay.textContent = `Error: ${err.message}`;
});
