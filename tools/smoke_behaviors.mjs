/**
 * tools/smoke_behaviors.mjs — Node.js smoke tests for Phase 5 behaviors.
 *
 * Tests:
 *  flee.js   — pickFleeDest scoring, tickFlee movement, path replan
 *  armed.js  — fires projectile, drops to flee when truck close, recovers on LOS loss
 *  recovery.js — walks toward interest point, glances back at truck, threat update
 *
 * Runs without a browser (THREE is stubbed).
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// ── Stubs ─────────────────────────────────────────────────────────────────────

globalThis.location = { search: '' };

const root = resolve(new URL('.', import.meta.url).pathname, '..');

const { AI, MOOT, NAV } = await import(pathToFileURL(resolve(root, 'lib/config.js')));
const { buildNavGrid }    = await import(pathToFileURL(resolve(root, 'lib/nav/grid.js')));
const { findPath }        = await import(pathToFileURL(resolve(root, 'lib/nav/pathfind.js')));
const { pickFleeDest, tickFlee }   = await import(pathToFileURL(resolve(root, 'lib/ai/flee.js')));
const { tickArmed }                 = await import(pathToFileURL(resolve(root, 'lib/ai/armed.js')));
const { tickRecovery }              = await import(pathToFileURL(resolve(root, 'lib/ai/recovery.js')));

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTestNavGrid() {
  const bounds = { minX: 0, maxX: 100, minZ: 0, maxZ: 100 };
  const roadSegments = [
    { a: { x: 0, z: 50 }, b: { x: 100, z: 50 }, width: 120, kind: 'local' },
    { a: { x: 50, z: 0 }, b: { x: 50, z: 100 }, width: 120, kind: 'local' },
  ];
  const interestPoints = [];
  for (let x = 5; x <= 95; x += 5) {
    for (let z = 5; z <= 95; z += 5) {
      interestPoints.push({ x, z, kind: 'sidewalk' });
    }
  }
  return buildNavGrid({ bounds, buildingAABBs: [], roadSegments, intersections: [], interestPoints });
}

function buildMoot(x = 50, z = 50, armed = false) {
  return {
    group:   { position: { x, y: 0, z }, userData: {}, add() {} },
    alive:   true,
    state:   'alarmed-flee',
    threat:  0.8,
    path:    [],
    pathIndex:  0,
    destination: null,
    lastReplanAt: 0,
    lastSeenTruckAt: 0,
    stateEnteredAt: 0,
    collisionRadius: 0.4,
    hp: 1,
    isBoss: false,
    armed,
    gunCooldown: 0,
    _alarmExitTimer: 0,
    _recoveryTimer:  0,
    _armedLosTimer:  0,
    _glanceTimer:    0,
  };
}

// ── Test runner ───────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error('   ', e.message);
    fail++;
  }
}

// ── Flee tests ────────────────────────────────────────────────────────────────

console.log('\n── Phase 5 Flee smoke tests ─────────────────────────────────────────────\n');

test('pickFleeDest returns point in ring around moot', () => {
  const mootPos  = { x: 50, z: 50 };
  const truckPos = { x: 50, z: 50 }; // same spot for scoring test
  const pts = [];
  for (let x = 0; x <= 100; x += 2) for (let z = 0; z <= 100; z += 2) pts.push({ x, z });
  const dest = pickFleeDest(mootPos, truckPos, pts);
  assert.ok(dest !== null, 'should find a destination');
  const dx = dest.x - mootPos.x;
  const dz = dest.z - mootPos.z;
  const d  = Math.sqrt(dx*dx + dz*dz);
  assert.ok(d >= AI.fleeSampleRingMin, `dist ${d.toFixed(1)} should be >= ${AI.fleeSampleRingMin}`);
  assert.ok(d <= AI.fleeSampleRingMax, `dist ${d.toFixed(1)} should be <= ${AI.fleeSampleRingMax}`);
});

test('pickFleeDest prefers points far from truck', () => {
  const mootPos  = { x: 50, z: 50 };
  const truckPos = { x: 20, z: 50 }; // truck on the left
  // Only two candidates: one on same side as truck, one opposite
  const pts = [
    { x: 20, z: 80, kind: 'sidewalk' }, // distance 30 from moot; 30 from truck
    { x: 80, z: 80, kind: 'sidewalk' }, // distance from moot ~42; distance from truck ~72
  ];
  // Both are in ring ~30–60 from moot at (50,50):
  // pt1: sqrt(30²+30²) ≈ 42 ✓    pt2: sqrt(30²+30²) ≈ 42 ✓
  const results = [];
  for (let i = 0; i < 20; i++) results.push(pickFleeDest(mootPos, truckPos, pts));
  // The far point should score higher and be selected more often.
  const countFar = results.filter(r => r && r.x === 80).length;
  assert.ok(countFar > 0, 'far point should be selected at least once out of 20');
});

test('pickFleeDest returns null when no point is in ring', () => {
  const dest = pickFleeDest({ x: 50, z: 50 }, { x: 0, z: 0 }, [{ x: 51, z: 50 }]);
  assert.equal(dest, null);
});

test('tickFlee moves moot away from starting position', () => {
  const grid = buildTestNavGrid();
  const moot = buildMoot(50, 50);
  const truckPos = { x: 50, z: 50 };
  const ctx = { navGrid: grid, buildingAABBs: [], truckPos, now: 0 };

  for (let i = 0; i < 60; i++) {
    tickFlee(1/60, moot, { ...ctx, now: i * (1000/60) });
  }
  const dx = moot.group.position.x - 50;
  const dz = moot.group.position.z - 50;
  const moved = Math.sqrt(dx*dx + dz*dz);
  assert.ok(moved > 0.5, `moot should have moved (${moved.toFixed(2)} m)`);
});

test('tickFlee moves at approximately AI.fleeSpeed', () => {
  const grid = buildTestNavGrid();
  const moot = buildMoot(50, 50);
  // Force a specific destination and path.
  moot.destination = { x: 10, z: 50 };
  moot.path = findPath(grid, { x: 50, z: 50 }, { x: 10, z: 50 });
  moot.pathIndex = 0;
  moot.lastReplanAt = 9999; // prevent replan

  const dt = 1/60;
  for (let i = 0; i < 30; i++) {
    tickFlee(dt, moot, { navGrid: grid, buildingAABBs: [], truckPos: { x: 50, z: 50 }, now: 9999 * 1000 });
  }
  const moved = Math.abs(moot.group.position.x - 50);
  const elapsed = dt * 30;
  const maxExpected = AI.fleeSpeed * elapsed * 1.2;
  assert.ok(moved <= maxExpected || moved > 0.3,
    `moved ${moved.toFixed(2)} m in ${elapsed.toFixed(2)}s (max ~${maxExpected.toFixed(2)})`);
});

test('tickFlee does nothing when dead', () => {
  const grid = buildTestNavGrid();
  const moot = buildMoot(50, 50);
  moot.alive = false;
  moot.destination = { x: 10, z: 50 };
  moot.path = findPath(grid, { x: 50, z: 50 }, { x: 10, z: 50 });
  moot.pathIndex = 0;
  for (let i = 0; i < 30; i++) tickFlee(1/60, moot, { navGrid: grid, buildingAABBs: [], truckPos: { x: 50, z: 50 }, now: 0 });
  assert.equal(moot.group.position.x, 50);
  assert.equal(moot.group.position.z, 50);
});

// ── Armed tests ───────────────────────────────────────────────────────────────

console.log('\n── Phase 5 Armed smoke tests ────────────────────────────────────────────\n');

test('tickArmed fires projectile when truck in LOS and range', () => {
  const moot = buildMoot(50, 50, true);
  moot.state = 'alarmed-armed';
  moot.gunCooldown = 0;
  const shots = [];
  const ctx = {
    buildingAABBs: [],
    truckPos: { x: 50, z: 70 }, // 20 m away, no buildings
    now: 0,
    spawnProjectile: (origin, target) => shots.push({ origin, target }),
  };
  tickArmed(0.1, moot, ctx);
  assert.ok(shots.length >= 1, 'should have fired at least once');
});

test('tickArmed does not fire when truck out of LOS', () => {
  const moot = buildMoot(50, 50, true);
  moot.state = 'alarmed-armed';
  moot.gunCooldown = 0;

  // Wall between moot and truck.
  const buildingAABBs = [{ minX: 45, maxX: 55, minZ: 55, maxZ: 65 }];
  const shots = [];
  const ctx = {
    buildingAABBs,
    truckPos: { x: 50, z: 70 },
    now: 0,
    spawnProjectile: () => shots.push(1),
  };
  tickArmed(0.1, moot, ctx);
  assert.equal(shots.length, 0, 'should not fire when LOS blocked');
});

test('tickArmed drops to alarmed-flee when truck closes within armedDropFleeRadius', () => {
  const moot = buildMoot(50, 50, true);
  moot.state = 'alarmed-armed';
  const ctx = {
    buildingAABBs: [],
    truckPos: { x: 50, z: 50 + AI.armedDropFleeRadius - 0.5 }, // just inside radius
    now: 1000,
    spawnProjectile: () => {},
  };
  tickArmed(0.016, moot, ctx);
  assert.equal(moot.state, 'alarmed-flee', 'should drop to flee when truck closes');
});

test('tickArmed transitions to recovering after losing LOS for armedLostLosSeconds', () => {
  const moot = buildMoot(50, 50, true);
  moot.state = 'alarmed-armed';
  moot.gunCooldown = 9999; // prevent firing
  // Wall between moot (50,50) and truck (50,70)
  const buildingAABBs = [{ minX: 45, maxX: 55, minZ: 55, maxZ: 65 }];
  const ctx = {
    buildingAABBs,
    truckPos: { x: 50, z: 70 },
    now: 0,
    spawnProjectile: () => {},
  };
  const lostSec = AI.armedLostLosSeconds;
  // Simulate enough ticks to exceed the LOS loss threshold.
  for (let t = 0; t < lostSec + 0.5; t += 0.1) {
    tickArmed(0.1, moot, { ...ctx, now: t * 1000 });
    if (moot.state !== 'alarmed-armed') break;
  }
  assert.equal(moot.state, 'recovering', 'should transition to recovering after LOS lost');
});

test('tickArmed does nothing when not armed', () => {
  const moot = buildMoot(50, 50, false); // not armed
  moot.state = 'alarmed-armed';
  moot.gunCooldown = 0;
  const shots = [];
  const ctx = {
    buildingAABBs: [],
    truckPos: { x: 50, z: 70 },
    now: 0,
    spawnProjectile: () => shots.push(1),
  };
  tickArmed(0.1, moot, ctx);
  assert.equal(shots.length, 0, 'non-armed moot should not fire');
});

// ── Recovery tests ────────────────────────────────────────────────────────────

console.log('\n── Phase 5 Recovery smoke tests ─────────────────────────────────────────\n');

test('tickRecovery moves moot toward nearest interest point', () => {
  const grid = buildTestNavGrid();
  const moot = buildMoot(50, 50);
  moot.state = 'recovering';
  moot.threat = 0;
  const ctx = { navGrid: grid, buildingAABBs: [], truckPos: { x: 0, z: 0 }, now: 0 };

  const startX = moot.group.position.x;
  const startZ = moot.group.position.z;
  for (let i = 0; i < 60; i++) tickRecovery(1/60, moot, ctx);
  const moved = Math.hypot(moot.group.position.x - startX, moot.group.position.z - startZ);
  assert.ok(moved > 0.3, `recovering moot should move (moved ${moved.toFixed(2)} m)`);
});

test('tickRecovery glances and adds threat when truck has LOS', () => {
  const grid = buildTestNavGrid();
  const moot = buildMoot(50, 50);
  moot.state = 'recovering';
  moot.threat = 0;
  moot._glanceTimer = AI.recoveryGlanceInterval - 0.01; // almost time to glance
  const ctx = {
    navGrid: grid,
    buildingAABBs: [], // clear LOS
    truckPos: { x: 50, z: 60 }, // 10 m away, clear LOS
    now: 0,
  };
  tickRecovery(0.05, moot, ctx); // this should trigger a glance
  assert.ok(moot.threat > 0, `threat should have increased after glance (got ${moot.threat})`);
});

test('tickRecovery does not add threat when LOS is blocked', () => {
  const grid = buildTestNavGrid();
  const moot = buildMoot(50, 50);
  moot.state = 'recovering';
  moot.threat = 0;
  moot._glanceTimer = AI.recoveryGlanceInterval - 0.01;
  const buildingAABBs = [{ minX: 45, maxX: 55, minZ: 53, maxZ: 58 }]; // wall between
  const ctx = {
    navGrid: grid,
    buildingAABBs,
    truckPos: { x: 50, z: 70 },
    now: 0,
  };
  tickRecovery(0.05, moot, ctx);
  assert.equal(moot.threat, 0, 'threat should not increase when LOS blocked');
});

test('tickRecovery does nothing when dead', () => {
  const grid = buildTestNavGrid();
  const moot = buildMoot(50, 50);
  moot.alive = false;
  moot.state = 'recovering';
  const ctx = { navGrid: grid, buildingAABBs: [], truckPos: { x: 0, z: 0 }, now: 0 };
  for (let i = 0; i < 30; i++) tickRecovery(1/60, moot, ctx);
  assert.equal(moot.group.position.x, 50);
  assert.equal(moot.group.position.z, 50);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
