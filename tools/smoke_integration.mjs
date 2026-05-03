/**
 * tools/smoke_integration.mjs
 *
 * Integration smoke tests for Phase integration — main.js wiring.
 *
 * These verify the structural correctness of the new main.js without a browser:
 *   - main.js no longer imports updateMootFlee or updateMootGunfire
 *   - main.js imports active AI modules (tickPerception, tickFlee, tickArmed,
 *     tickRecovery, tickUnaware); legacy boss AI is deprecated and not wired
 *   - main.js imports createPopulation (population manager)
 *   - main.js imports createMinimap/createRadio HUD systems
 *   - main.js imports createLevelManager for city rebuilds
 *   - lib/hud/overlays.js exports setGameOverVisible (regression guard)
 *   - lib/game/state.js exports triggerVictory (regression guard)
 *   - lib/game/levels.js exports createLevelManager, pickPlayerSpawn,
 *     pickBossRow/pickBossSpawn legacy helpers, snapToWalkable
 *   - lib/world/population.js exports createPopulation
 *   - tickAI function exists in main.js source (dispatches all AI states)
 *   - updateMootFlee / updateMootGunfire are NOT called in main.js tick path
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readSrc(relPath) {
  return readFileSync(path.join(ROOT, relPath), 'utf8');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

console.log('\n── Phase Integration smoke tests ─────────────────────────────────\n');

const mainSrc = readSrc('main.js');

// ── main.js import checks ─────────────────────────────────────────────────

test('main.js does NOT import updateMootFlee', () => {
  assert(!mainSrc.includes('updateMootFlee'), 'updateMootFlee still imported');
});

test('main.js does NOT import updateMootGunfire', () => {
  assert(!mainSrc.includes('updateMootGunfire'), 'updateMootGunfire still imported');
});

test('main.js does NOT call updateMootFlee(', () => {
  assert(!mainSrc.includes('updateMootFlee('), 'updateMootFlee() still called');
});

test('main.js does NOT call updateMootGunfire(', () => {
  assert(!mainSrc.includes('updateMootGunfire('), 'updateMootGunfire() still called');
});

test('main.js imports tickPerception', () => {
  assert(mainSrc.includes('tickPerception'), 'tickPerception not imported');
});

test('main.js imports tickFlee', () => {
  assert(mainSrc.includes('tickFlee'), 'tickFlee not imported');
});

test('main.js imports tickArmed', () => {
  assert(mainSrc.includes('tickArmed'), 'tickArmed not imported');
});

test('main.js imports tickRecovery', () => {
  assert(mainSrc.includes('tickRecovery'), 'tickRecovery not imported');
});

test('main.js does NOT import deprecated tickBoss', () => {
  assert(!mainSrc.includes('tickBoss'), 'tickBoss should not be wired in timer-target mode');
});

test('main.js imports tickUnaware', () => {
  assert(mainSrc.includes('tickUnaware'), 'tickUnaware not imported');
});

test('main.js imports createPopulation', () => {
  assert(mainSrc.includes('createPopulation'), 'createPopulation not imported');
});

test('main.js imports createMinimap', () => {
  assert(mainSrc.includes('createMinimap'), 'createMinimap not imported');
});

test('main.js imports createRadio', () => {
  assert(mainSrc.includes('createRadio'), 'createRadio not imported');
});

test('main.js imports createLevelManager', () => {
  assert(mainSrc.includes('createLevelManager'), 'createLevelManager not imported');
});

test('main.js does NOT import deprecated pickBossRow', () => {
  assert(
    !mainSrc.includes('pickBossRow'),
    'pickBossRow should not be imported by timer-target mode',
  );
});

test('main.js defines tickAI function', () => {
  assert(mainSrc.includes('function tickAI'), 'tickAI function not defined');
});

test('main.js calls tickAI in game loop', () => {
  assert(mainSrc.includes('tickAI(dt)'), 'tickAI not called in game loop');
});

test('main.js dispatches unaware state via tickUnaware', () => {
  assert(
    mainSrc.includes("case 'unaware':") && mainSrc.includes('tickUnaware(dt, m'),
    'unaware dispatch missing',
  );
});

test('main.js dispatches alarmed-flee state via tickFlee', () => {
  assert(
    mainSrc.includes("case 'alarmed-flee':") && mainSrc.includes('tickFlee(dt, m'),
    'alarmed-flee dispatch missing',
  );
});

test('main.js dispatches alarmed-armed state via tickArmed', () => {
  assert(
    mainSrc.includes("case 'alarmed-armed':") && mainSrc.includes('tickArmed(dt, m'),
    'alarmed-armed dispatch missing',
  );
});

test('main.js dispatches recovering state via tickRecovery', () => {
  assert(
    mainSrc.includes("case 'recovering':") && mainSrc.includes('tickRecovery(dt, m'),
    'recovering dispatch missing',
  );
});

test('main.js does NOT dispatch deprecated boss via tickBoss', () => {
  assert(!mainSrc.includes('tickBoss(dt, m'), 'boss dispatch should not be wired');
});

test('main.js calls population.tick for despawn/respawn', () => {
  assert(mainSrc.includes('population.tick('), 'population.tick not called');
});

test('main.js calls ramMoots(aiHandles) in game loop', () => {
  assert(mainSrc.includes('ramMoots(aiHandles)'), 'ramMoots(aiHandles) not called');
});

test('main.js calls minimap.update in tickAI', () => {
  assert(mainSrc.includes('minimap.update('), 'minimap.update not called');
});

test('main.js ticks radio in game loop', () => {
  assert(mainSrc.includes('radio.tick('), 'radio.tick not called');
});

test('main.js calls resolveBuildingCollisions in game loop', () => {
  assert(
    mainSrc.includes('resolveBuildingCollisions('),
    'resolveBuildingCollisions not in game loop',
  );
});

test('main.js handles victory state (no AI tick during victory)', () => {
  // The game loop should stop AI dispatch when state !== 'playing'.
  assert(mainSrc.includes("game.state !== 'playing'"), 'victory guard missing in game loop');
});

test('main.js handles rewinding state', () => {
  assert(mainSrc.includes("game.state === 'rewinding'"), 'rewinding check missing');
});

// ── skybox config/main wiring checks ─────────────────────────────────────────

const configSrc = readSrc('lib/config.js');

test('config.js exposes day/night SKYBOX presets', () => {
  assert(configSrc.includes('export const SKYBOX'), 'SKYBOX config not exported');
  assert(configSrc.includes('defaultMode'), 'SKYBOX defaultMode missing');
  assert(configSrc.includes('day:'), 'SKYBOX day preset missing');
  assert(configSrc.includes('night:'), 'SKYBOX night preset missing');
  assert(
    configSrc.includes('palette') && configSrc.includes('fog'),
    'SKYBOX palette/fog values missing',
  );
  assert(
    configSrc.includes('ambientLight') && configSrc.includes('sunLight'),
    'SKYBOX light values missing',
  );
});

test('main.js parses skybox URL parameter and falls back through SKYBOX presets', () => {
  assert(mainSrc.includes('resolveSkyboxMode'), 'resolveSkyboxMode not defined/called');
  assert(mainSrc.includes("get('skybox')"), 'skybox URL parameter not parsed');
  assert(mainSrc.includes('SKYBOX.presets'), 'SKYBOX presets not consulted');
  assert(mainSrc.includes('SKYBOX.defaultMode'), 'SKYBOX default mode fallback missing');
});

test('main.js applies selected skybox to background, fog, and clear colors', () => {
  assert(
    mainSrc.includes('scene.background') && mainSrc.includes('createProceduralSkybox'),
    'scene.background skybox assignment missing',
  );
  assert(
    mainSrc.includes('scene.fog =') && mainSrc.includes('THREE.Fog'),
    'scene fog assignment missing',
  );
  assert(
    mainSrc.includes('renderer.setClearColor(selectedSkyboxPreset.clearColor'),
    'renderer skybox clear color missing',
  );
  assert(
    mainSrc.includes('rearRenderer.setClearColor(selectedSkyboxPreset.clearColor'),
    'rear renderer skybox clear color missing',
  );
});

// ── overlays.js structural check ─────────────────────────────────────────────

const overlaySrc = readSrc('lib/hud/overlays.js');

test('overlays.js exports setGameOverVisible', () => {
  assert(
    overlaySrc.includes('export function setGameOverVisible'),
    'setGameOverVisible not exported',
  );
});

test('overlays.js exports setVictoryVisible', () => {
  assert(
    overlaySrc.includes('export function setVictoryVisible'),
    'setVictoryVisible not exported',
  );
});

// ── state.js structural check ─────────────────────────────────────────────────

const stateSrc = readSrc('lib/game/state.js');

test('state.js keeps triggerVictory deprecated', () => {
  assert(stateSrc.includes('triggerVictory deprecated'), 'triggerVictory deprecation note missing');
});

test('state.js handles timer game-over queue flow', () => {
  assert(
    stateSrc.includes('handleGameOver') && stateSrc.includes('postQueue'),
    'timer game-over queue flow missing',
  );
});

test('state.js prioritizes objective ram reactions including turboCelebrating', () => {
  assert(stateSrc.includes('objectiveRammed'), 'objective ram tracking flag missing');
  assert(
    stateSrc.includes('game.boosting') && stateSrc.includes('turboCelebrating'),
    'boosted objective ram turboCelebrating branch missing',
  );
  assert(stateSrc.includes("'celebrating'"), 'non-boost objective ram celebrating branch missing');
});

test('state.js prioritizes objective shot reaction to shootCelebrating', () => {
  assert(stateSrc.includes('objectiveShot'), 'objective shot tracking flag missing');
  assert(
    stateSrc.includes("setFace('shootCelebrating'"),
    'objective shot shootCelebrating face missing',
  );
});

// ── mirror.js reaction/base-face checks ──────────────────────────────────────

const mirrorSrc = readSrc('lib/hud/mirror.js');

test('mirror.js maps boost-aware objective reaction images', () => {
  assert(mirrorSrc.includes('turboCelebrating'), 'turboCelebrating reaction state missing');
  assert(
    mirrorSrc.includes('/data/reactions/turbo-celebrating.png'),
    'turboCelebrating image path missing',
  );
  assert(mirrorSrc.includes('shootCelebrating'), 'shootCelebrating reaction state missing');
  assert(
    mirrorSrc.includes('/data/reactions/shoot-celebrate.png'),
    'shootCelebrating image path missing',
  );
});

test('mirror.js timed reactions revert to current base face, not hardcoded neutral', () => {
  assert(mirrorSrc.includes("let _baseState = 'neutral'"), 'base face state tracking missing');
  assert(mirrorSrc.includes('revertAfterMs > 0'), 'timed reaction detection missing');
  assert(
    mirrorSrc.includes("_baseState = next === 'neutral' ? 'neutral' : next"),
    'untimed face calls do not update/reset base face',
  );
  const timerStart = mirrorSrc.indexOf('if (isTimedReaction)');
  const timerEnd = mirrorSrc.indexOf('}, revertAfterMs)', timerStart);
  assert(timerStart >= 0 && timerEnd > timerStart, 'timed revert block missing');
  const timerBlock = mirrorSrc.slice(timerStart, timerEnd);
  assert(timerBlock.includes('_baseState'), 'timed revert block does not consult base face');
  assert(timerBlock.includes('revertState'), 'timed revert block does not compute a revert state');
  assert(
    !timerBlock.includes("_currentState = 'neutral'"),
    'timed revert hardcodes _currentState to neutral',
  );
  assert(
    !timerBlock.includes("setFace('neutral'") && !timerBlock.includes('setFace("neutral"'),
    'timed revert hardcodes setFace(neutral)',
  );
});

// ── levels.js structural check ────────────────────────────────────────────────

const levelsSrc = readSrc('lib/game/levels.js');

test('levels.js exports createLevelManager', () => {
  assert(
    levelsSrc.includes('export function createLevelManager'),
    'createLevelManager not exported',
  );
});

test('levels.js exports pickBossRow', () => {
  assert(levelsSrc.includes('export function pickBossRow'), 'pickBossRow not exported');
});

test('levels.js exports pickPlayerSpawn', () => {
  assert(levelsSrc.includes('export function pickPlayerSpawn'), 'pickPlayerSpawn not exported');
});

test('levels.js exports pickBossSpawn', () => {
  assert(levelsSrc.includes('export function pickBossSpawn'), 'pickBossSpawn not exported');
});

// ── population.js structural check ───────────────────────────────────────────

const popSrc = readSrc('lib/world/population.js');

test('population.js exports createPopulation', () => {
  assert(popSrc.includes('export function createPopulation'), 'createPopulation not exported');
});

test('createPopulation has notifyDeath', () => {
  assert(popSrc.includes('function notifyDeath'), 'notifyDeath not in population.js');
});

test('createPopulation has spawnBoss', () => {
  assert(popSrc.includes('function spawnBoss'), 'spawnBoss not in population.js');
});

test('createPopulation has destroyAll', () => {
  assert(popSrc.includes('function destroyAll'), 'destroyAll not in population.js');
});

// ── collision.js structural checks ──────────────────────────────────────────

const collisionSrc = readSrc('lib/car/collision.js');

test('collision.js exports resolveMapBounds', () => {
  assert(
    collisionSrc.includes('export function resolveMapBounds'),
    'resolveMapBounds not exported from collision.js',
  );
});

test('main.js imports resolveMapBounds', () => {
  assert(mainSrc.includes('resolveMapBounds'), 'resolveMapBounds not imported in main.js');
});

test('main.js calls resolveMapBounds in game loop', () => {
  assert(mainSrc.includes('resolveMapBounds('), 'resolveMapBounds not called in main.js game loop');
});

test('main.js stores cityBounds after generateCity', () => {
  assert(mainSrc.includes('cityBounds'), 'cityBounds variable not present in main.js');
});

// ── playerSprite.js structural checks ────────────────────────────────────────

const playerSpriteSrc = readSrc('lib/car/playerSprite.js');

test('playerSprite.js selects side frames from lateral velocity, not steer input', () => {
  assert(
    playerSpriteSrc.includes('vehicle.lateralVelocity'),
    'playerSprite.js should read vehicle.lateralVelocity',
  );
  assert(
    !playerSpriteSrc.includes('steerInput'),
    'playerSprite.js should not read steerInput for side frames',
  );
  assert(
    playerSpriteSrc.includes('sideFrameEnterLateralSpeed'),
    'side-frame enter lateral-speed threshold missing',
  );
  assert(
    playerSpriteSrc.includes('sideFrameExitLateralSpeed'),
    'side-frame exit lateral-speed threshold missing',
  );
  assert(playerSpriteSrc.includes('sideFrameHoldSeconds'), 'side-frame hold timing missing');
});

// ── resolveMapBounds logic tests ──────────────────────────────────────────────
// Run the function directly without a browser by dynamically importing it.
// config.js references browser globals (location, window) so we stub them
// before the dynamic import chain resolves.
if (typeof globalThis.location === 'undefined') {
  globalThis.location = { search: '' };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

const collisionMod = await import(path.join(ROOT, 'lib/car/collision.js'));
const { resolveMapBounds, resolveNpcVehicleBodyCollision } = collisionMod;
const configMod = await import(path.join(ROOT, 'lib/config.js'));
const { CAR, NPC_VEHICLE } = configMod;

// Helper: build a minimal fake vehicle.
function makeVehicle({ x, z, speed = 10 }) {
  return {
    position: { x, z },
    forward: { x: 1, z: 0 }, // heading +X / +Z for tests
    speed,
  };
}

const BOUNDS = { minX: 0, maxX: 100, minZ: 0, maxZ: 100 };
// CAR.collisionRadius as used in collision.js (1.8 per config.js)
const R = 1.8;

test('resolveMapBounds: null bounds returns null (safe during load)', () => {
  const v = makeVehicle({ x: 999, z: 999 });
  const result = resolveMapBounds(v, null);
  assert(result === null, `expected null, got ${result}`);
  assert(v.position.x === 999, 'position.x should be unchanged when bounds is null');
});

test('resolveMapBounds: vehicle in bounds returns null (no clamp)', () => {
  const v = makeVehicle({ x: 50, z: 50, speed: 5 });
  const result = resolveMapBounds(v, BOUNDS);
  assert(result === null, `expected null for in-bounds vehicle, got ${JSON.stringify(result)}`);
  assert(v.position.x === 50, 'position should be unchanged');
  assert(v.speed === 5, 'speed should be unchanged');
});

test('resolveMapBounds: vehicle past maxX is clamped to maxX-r', () => {
  const v = makeVehicle({ x: 105, z: 50, speed: 8 });
  const result = resolveMapBounds(v, BOUNDS);
  assert(
    result !== null && result.axis === 'maxX',
    `expected axis=maxX, got ${JSON.stringify(result)}`,
  );
  assert(
    Math.abs(v.position.x - (BOUNDS.maxX - R)) < 1e-9,
    `position.x should be ${BOUNDS.maxX - R}, got ${v.position.x}`,
  );
  assert(v.speed < 8, `speed should be reduced from 8, got ${v.speed}`);
});

test('resolveMapBounds: vehicle past minZ is clamped to minZ+r', () => {
  const v = makeVehicle({ x: 50, z: -5, speed: 6 });
  // forward.z < 0 so vehicle is heading into the minZ wall
  v.forward = { x: 0, z: -1 };
  const result = resolveMapBounds(v, BOUNDS);
  assert(
    result !== null && result.axis === 'minZ',
    `expected axis=minZ, got ${JSON.stringify(result)}`,
  );
  assert(
    Math.abs(v.position.z - (BOUNDS.minZ + R)) < 1e-9,
    `position.z should be ${BOUNDS.minZ + R}, got ${v.position.z}`,
  );
  assert(v.speed < 6, `speed should be reduced from 6, got ${v.speed}`);
});

test('resolveMapBounds: vehicle past minX is clamped to minX+r', () => {
  const v = makeVehicle({ x: -3, z: 50, speed: -7 });
  v.forward = { x: -1, z: 0 };
  const result = resolveMapBounds(v, BOUNDS);
  assert(
    result !== null && result.axis === 'minX',
    `expected axis=minX, got ${JSON.stringify(result)}`,
  );
  assert(
    Math.abs(v.position.x - (BOUNDS.minX + R)) < 1e-9,
    `position.x should be ${BOUNDS.minX + R}, got ${v.position.x}`,
  );
  assert(v.speed > -7, `speed magnitude should be reduced from -7, got ${v.speed}`);
});

test('resolveMapBounds: vehicle past maxZ is clamped to maxZ-r', () => {
  const v = makeVehicle({ x: 50, z: 110, speed: 9 });
  v.forward = { x: 0, z: 1 };
  const result = resolveMapBounds(v, BOUNDS);
  assert(
    result !== null && result.axis === 'maxZ',
    `expected axis=maxZ, got ${JSON.stringify(result)}`,
  );
  assert(
    Math.abs(v.position.z - (BOUNDS.maxZ - R)) < 1e-9,
    `position.z should be ${BOUNDS.maxZ - R}, got ${v.position.z}`,
  );
  assert(v.speed < 9, `speed should be reduced from 9, got ${v.speed}`);
});

// ── resolveNpcVehicleBodyCollision logic tests ───────────────────────────────

function makeTestVector3(x, y, z) {
  return {
    x,
    y,
    z,
    add(delta) {
      this.x += delta?.x ?? 0;
      this.y += delta?.y ?? 0;
      this.z += delta?.z ?? 0;
      return this;
    },
  };
}

function vectorXZLength(vector) {
  return Math.hypot(vector?.x ?? 0, vector?.z ?? 0);
}

test('resolveNpcVehicleBodyCollision pushes/spins NPC while reducing player speed', () => {
  const playerVelocity = makeTestVector3(0, 0, -24);
  const player = {
    position: makeTestVector3(0, 0, 0),
    velocity: playerVelocity,
    yaw: 0,
    angularVelocityY: 0,
    lateralVelocity: 6,
    get speed() {
      return -this.velocity.z;
    },
    getBodyDescriptor() {
      return {
        center: this.position,
        yaw: this.yaw,
        velocity: this.velocity,
        angularVelocityY: this.angularVelocityY,
        halfExtents: makeTestVector3(CAR.bodyHalfWidth, CAR.bodyHalfHeight, CAR.bodyHalfLength),
        mass: CAR.bodyMass,
        restitution: CAR.bodyRestitution,
      };
    },
  };

  const npc = {
    position: makeTestVector3(0, 0, -(CAR.bodyHalfLength + NPC_VEHICLE.bodyHalfLength - 0.45)),
    velocity: makeTestVector3(0, 0, 0),
    yaw: 0,
    angularVelocityY: 0,
    appliedImpact: null,
    getBodyDescriptor() {
      return {
        center: this.position,
        yaw: this.yaw,
        velocity: this.velocity,
        angularVelocityY: this.angularVelocityY,
        halfExtents: makeTestVector3(
          NPC_VEHICLE.bodyHalfWidth,
          NPC_VEHICLE.bodyHalfHeight,
          NPC_VEHICLE.bodyHalfLength,
        ),
        mass: NPC_VEHICLE.bodyMass,
        restitution: NPC_VEHICLE.bodyRestitution,
      };
    },
    applyBodyImpact(linearVelocityDelta, angularVelocityDeltaY) {
      this.appliedImpact = { linearVelocityDelta, angularVelocityDeltaY };
      this.velocity.add(linearVelocityDelta);
      this.angularVelocityY += angularVelocityDeltaY;
    },
  };

  const beforeSpeed = player.speed;
  const result = resolveNpcVehicleBodyCollision(player, npc);

  assert(result !== null, 'expected overlapping oriented vehicle bodies to collide');
  assert(
    player.speed < beforeSpeed,
    `expected player speed below ${beforeSpeed}, got ${player.speed}`,
  );
  assert(npc.appliedImpact !== null, 'expected NPC applyBodyImpact to be called');
  assert(
    vectorXZLength(npc.appliedImpact.linearVelocityDelta) > 0,
    'expected non-zero NPC push velocity',
  );
  assert(
    Math.abs(npc.appliedImpact.angularVelocityDeltaY) > 0,
    'expected non-zero NPC angular spin',
  );
  assert(vectorXZLength(npc.velocity) > 0, 'expected NPC velocity to receive push');
  assert(Math.abs(npc.angularVelocityY) > 0, 'expected NPC angular velocity to receive spin');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
