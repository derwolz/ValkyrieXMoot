import * as THREE from 'three';
import { loadDb, selectRandom, avatarSource } from './lib/data/mootLoader.js';
import { loadChibiTexture } from './lib/chibiTexture.js';
import { loadVideoTexture } from './lib/videoTexture.js';
import { buildBuildings } from './lib/world/buildings.js';
import { Vehicle } from './lib/car/vehicle.js';
import { resolveBuildingCollisions } from './lib/car/collision.js';
import { Pistol } from './lib/weapons/pistol.js';
import { buildMoot, updateMootFlee, initArmed, updateMootGunfire, getProjectiles } from './lib/entities/moots.js';
import { createRecorder } from './lib/rewind/recorder.js';
import { createPlayback } from './lib/rewind/playback.js';
import { createHud, updateHud, hideLoginPrompt } from './lib/hud/overlays.js';
import { getMe, postQueue } from './lib/api.js';
import { createMirror, setFace } from './lib/hud/mirror.js';
import { setupDebugPanel } from './lib/debug/panel.js';
import { Mouse } from './lib/mouse.js';
import { WORLD, MOOT, GAME, MIRROR } from './lib/config.js';
import { createImpactSystem } from './lib/game/impacts.js';
import { applySort } from './lib/game/sorter.js';
import { createGameState } from './lib/game/state.js';
import { runWithConcurrency } from './lib/utils/concurrency.js';

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
let mootHandles   = [];
let sessionMoots  = [];
let playback      = null;
let paused        = false;
let noclip        = false;
let lastTime      = 0;

// ── Game state machine ────────────────────────────────────────────────────────

const gs = createGameState({
  scene,
  vehicle,
  recorder,
  getPlayback:      () => playback,
  getMootHandles:   () => mootHandles,
  getSessionMoots:  () => sessionMoots,
  impactSystem,
  pistol,
  updateHud,
});
const { game, triggerRewind, restartGame, ramMoots, tryShoot,
        tickCrashCooldown, onRewindDone, onMootBulletHit,
        setCurrentPlayer } = gs;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main() {
  const [db] = await Promise.all([
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

  sessionMoots = selectRandom(db, GAME.sessionMoots);
  const N = sessionMoots.length;
  const corridorLength = N * MOOT.spacing + WORLD.corridorEndPadding;

  buildingAABBs = buildBuildings(scene, corridorLength);

  overlay.textContent = `Loading 0 / ${N} moots…`;
  mootHandles = sessionMoots.map((row) => buildMoot(row, scene));
  applySort('rank', sessionMoots, mootHandles);
  game.mootsTotal = N;
  game.mootsAlive = N;
  initArmed(mootHandles, MOOT.armedFraction);

  let loaded = 0;
  await runWithConcurrency(sessionMoots, MOOT.loadConcurrency, async (row, i) => {
    const src = avatarSource(row);
    let tex;
    if (src.kind === 'animated') {
      try {
        tex = await loadVideoTexture(src.file);
      } catch {
        tex = await loadChibiTexture(row.chibi_file);
      }
    } else {
      tex = await loadChibiTexture(src.file);
    }
    mootHandles[i].avatarMat.map = tex;
    mootHandles[i].avatarMat.needsUpdate = true;
    loaded++;
    if (loaded % 10 === 0 || loaded === N) overlay.textContent = `Loading ${loaded} / ${N} moots…`;
  });

  overlay.classList.add('hidden');

  createHud();
  updateHud(game);
  createMirror();
  setupDebugPanel({ pistol, moot: MOOT });

  const sortEl = document.getElementById('sort');
  sortEl.addEventListener('change', () => {
    applySort(sortEl.value, sessionMoots, mootHandles);
    vehicle.reset();
  });

  playback = createPlayback(scene, vehicle, mootHandles);

  window.__vxm = { scene, camera, renderer, vehicle, pistol, sessionMoots, mootHandles, game, recorder, playback };

  lastTime = performance.now();
  requestAnimationFrame(tick);
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
        vehicle.applyToCamera(camera);
      }

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

  if (paused || game.state !== 'playing') {
    Mouse.consumeClick();
    renderer.render(scene, camera);
    return;
  }

  vehicle.update(dt);
  const preSpeed = Math.abs(vehicle.speed);
  const hit = noclip ? null : resolveBuildingCollisions(vehicle, buildingAABBs);
  tickCrashCooldown(dt, hit, preSpeed);
  vehicle.applyToCamera(camera);

  updateMootFlee(dt, mootHandles, vehicle.position);
  ramMoots();
  updateMootGunfire(dt, mootHandles, vehicle.position, scene, onMootBulletHit);
  recorder.tick(dt, vehicle, mootHandles, getProjectiles());

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
    if (game.state === 'gameover') restartGame();
    else vehicle.reset();
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
