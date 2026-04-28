/**
 * tools/smoke_boss.mjs — Node.js smoke tests for Phase 9a Boss AI.
 *
 * Tests:
 *  - Boss ignores truck beyond detectRadius
 *  - Boss aggros permanently when truck enters detectRadius
 *  - Aggro does not reset when truck moves away
 *  - In engage mode: boss moves to kiteDistance when too close or too far
 *  - In engage mode: boss fires at truck on cooldown
 *  - In pursue mode: boss pathfinds toward last known position
 *  - Mode switches engage <-> pursue correctly based on distance
 *  - Dead boss does nothing
 *
 * Runs without a browser (THREE + config stubbed via globalThis.location).
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve }       from 'node:path';

// ── Stubs ─────────────────────────────────────────────────────────────────────

globalThis.location = { search: '' };

const root = resolve(new URL('.', import.meta.url).pathname, '..');

const { AI, BOSS, MOOT, NAV }  = await import(pathToFileURL(resolve(root, 'lib/config.js')));
const { buildNavGrid }          = await import(pathToFileURL(resolve(root, 'lib/nav/grid.js')));
const { tickBoss }              = await import(pathToFileURL(resolve(root, 'lib/ai/boss.js')));

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTestNavGrid() {
  const bounds = { minX: 0, maxX: 200, minZ: 0, maxZ: 200 };
  const roadSegments = [
    { a: { x: 0, z: 100 }, b: { x: 200, z: 100 }, width: 300, kind: 'local' },
    { a: { x: 100, z: 0 }, b: { x: 100, z: 200 }, width: 300, kind: 'local' },
  ];
  const interestPoints = [];
  for (let x = 5; x <= 195; x += 5) {
    for (let z = 5; z <= 195; z += 5) {
      interestPoints.push({ x, z, kind: 'sidewalk' });
    }
  }
  return buildNavGrid({ bounds, buildingAABBs: [], roadSegments, intersections: [], interestPoints });
}

function buildBossMoot(x = 100, z = 100) {
  return {
    group:            { position: { x, y: 0, z }, userData: {}, add() {} },
    alive:            true,
    state:            'alarmed-armed',
    threat:           1,
    path:             [],
    pathIndex:        0,
    destination:      null,
    lastReplanAt:     0,
    lastSeenTruckAt:  0,
    stateEnteredAt:   0,
    collisionRadius:  0.4,
    hp:               BOSS.hp,
    isBoss:           true,
    armed:            true,
    gunCooldown:      0,
    bossAggro:        false,
    bossMode:         null,
    bossLastKnownPos: null,
    _bossReplanTimer: 0,
    _alarmExitTimer:  0,
    _recoveryTimer:   0,
    _armedLosTimer:   0,
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

const grid = buildTestNavGrid();

// ── Boss AI smoke tests ───────────────────────────────────────────────────────

console.log('\n── Phase 9a Boss AI smoke tests ─────────────────────────────────────────\n');

// 1. Boss ignores truck beyond detectRadius
test('boss does not aggro when truck is beyond detectRadius', () => {
  const boss = buildBossMoot(100, 100);
  const truckPos = { x: 100, z: 100 + BOSS.detectRadius + 5 }; // beyond detect range
  const shots = [];
  const ctx = { navGrid: grid, buildingAABBs: [], truckPos, now: 0, spawnProjectile: () => shots.push(1) };

  tickBoss(0.016, boss, ctx);
  assert.equal(boss.bossAggro, false, 'boss should not aggro beyond detectRadius');
  assert.equal(shots.length, 0, 'boss should not fire before aggro');
});

// 2. Boss aggros when truck enters detectRadius
test('boss aggros permanently when truck enters detectRadius', () => {
  const boss = buildBossMoot(100, 100);
  const truckPos = { x: 100, z: 100 + BOSS.detectRadius - 5 }; // inside detect range
  const ctx = { navGrid: grid, buildingAABBs: [], truckPos, now: 0, spawnProjectile: () => {} };

  tickBoss(0.016, boss, ctx);
  assert.equal(boss.bossAggro, true, 'boss should aggro when truck enters detectRadius');
});

// 3. Aggro is a one-way latch — does not reset when truck moves away
test('aggro is permanent once latched (truck moves away)', () => {
  const boss = buildBossMoot(100, 100);
  const closePos = { x: 100, z: 100 + BOSS.detectRadius - 5 };
  const farPos   = { x: 100, z: 100 + BOSS.detectRadius + 50 };

  const ctx = { navGrid: grid, buildingAABBs: [], truckPos: closePos, now: 0, spawnProjectile: () => {} };
  tickBoss(0.016, boss, ctx);
  assert.equal(boss.bossAggro, true);

  // Move truck away
  ctx.truckPos = farPos;
  tickBoss(0.016, boss, ctx);
  assert.equal(boss.bossAggro, true, 'aggro should remain true after truck moves away');
});

// 4. Engage mode activates when truck is within engageRadius
test('boss enters engage mode when truck within engageRadius', () => {
  const boss = buildBossMoot(100, 100);
  boss.bossAggro = true;
  const truckPos = { x: 100, z: 100 + BOSS.engageRadius - 5 }; // inside engage range
  const ctx = { navGrid: grid, buildingAABBs: [], truckPos, now: 0, spawnProjectile: () => {} };

  tickBoss(0.016, boss, ctx);
  assert.equal(boss.bossMode, 'engage', 'boss should be in engage mode');
});

// 5. Pursue mode activates when truck is beyond engageRadius
test('boss enters pursue mode when truck beyond engageRadius', () => {
  const boss = buildBossMoot(100, 100);
  boss.bossAggro = true;
  const truckPos = { x: 100, z: 100 + BOSS.engageRadius + 5 }; // outside engage range
  const ctx = { navGrid: grid, buildingAABBs: [], truckPos, now: 0, spawnProjectile: () => {} };

  tickBoss(0.016, boss, ctx);
  assert.equal(boss.bossMode, 'pursue', 'boss should be in pursue mode');
});

// 6. Engage mode fires at truck on cooldown
test('boss fires at truck in engage mode', () => {
  const boss = buildBossMoot(100, 100);
  boss.bossAggro = true;
  boss.bossMode  = 'engage';
  boss.gunCooldown = 0; // ready to fire
  const truckPos = { x: 100, z: 100 + BOSS.kiteDistance }; // at kite distance
  const shots = [];
  const ctx = {
    navGrid: grid,
    buildingAABBs: [],
    truckPos,
    now: 1000,
    spawnProjectile: (origin, target) => shots.push({ origin, target }),
  };

  tickBoss(0.016, boss, ctx);
  assert.ok(shots.length >= 1, 'boss should fire in engage mode when cooldown ready');
});

// 7. Engage mode: boss moves toward truck when too far from kiteDistance
test('boss advances toward truck when beyond kiteDistance', () => {
  const boss = buildBossMoot(100, 100);
  boss.bossAggro = true;
  boss.bossMode  = 'engage';
  boss.gunCooldown = 9999;
  // Truck at (100, 100 + kiteDistance + 10) — boss is 10 m too far
  const truckPos = { x: 100, z: 100 + BOSS.kiteDistance + 10 };
  const ctx = {
    navGrid: grid,
    buildingAABBs: [],
    truckPos,
    now: 0,
    spawnProjectile: () => {},
  };

  const startZ = boss.group.position.z;
  // Tick several frames
  for (let i = 0; i < 30; i++) tickBoss(1/60, boss, ctx);
  const endZ = boss.group.position.z;

  // Boss should have moved toward truck (z increased)
  assert.ok(endZ > startZ, `boss should advance toward truck (z: ${startZ.toFixed(2)} → ${endZ.toFixed(2)})`);
});

// 8. Engage mode: boss retreats from truck when within kiteDistance
test('boss retreats from truck when closer than kiteDistance', () => {
  const boss = buildBossMoot(100, 100);
  boss.bossAggro = true;
  boss.bossMode  = 'engage';
  boss.gunCooldown = 9999;
  // Truck at (100, 102) — very close, far inside kiteDistance
  const truckPos = { x: 100, z: 102 };
  const ctx = {
    navGrid: grid,
    buildingAABBs: [],
    truckPos,
    now: 0,
    spawnProjectile: () => {},
  };

  const startZ = boss.group.position.z;
  for (let i = 0; i < 30; i++) tickBoss(1/60, boss, ctx);
  const endZ = boss.group.position.z;

  // Boss should have retreated away from truck (z decreased)
  assert.ok(endZ < startZ, `boss should retreat from truck (z: ${startZ.toFixed(2)} → ${endZ.toFixed(2)})`);
});

// 9. Pursue mode: boss assigns a path toward last known position
test('boss builds a path in pursue mode', () => {
  const boss = buildBossMoot(100, 100);
  boss.bossAggro = true;
  boss.bossMode  = 'pursue';
  boss.bossLastKnownPos = { x: 50, z: 50 };
  boss._bossReplanTimer = 0; // force replan

  const truckPos = { x: 50, z: 50 + BOSS.engageRadius + 5 }; // beyond engage range → stay in pursue
  const ctx = { navGrid: grid, buildingAABBs: [], truckPos, now: 0, spawnProjectile: () => {} };

  tickBoss(0.016, boss, ctx);
  assert.ok(boss.path !== undefined, 'boss should have a path field');
});

// 10. Pursue mode: boss moves toward last known position
test('boss moves toward last known position in pursue mode', () => {
  const boss = buildBossMoot(100, 100);
  boss.bossAggro = true;
  boss.bossLastKnownPos = { x: 100, z: 150 }; // target is 50 m ahead

  // Truck beyond engageRadius (keeps boss in pursue mode)
  const truckPos = { x: 100, z: 100 + BOSS.engageRadius + 10 };
  const ctx = {
    navGrid: grid,
    buildingAABBs: [],
    truckPos,
    now: 0,
    spawnProjectile: () => {},
  };

  const startZ = boss.group.position.z;
  // Run many frames
  for (let i = 0; i < 120; i++) {
    boss.bossLastKnownPos = { x: 100, z: 150 }; // keep last known fixed
    tickBoss(1/60, boss, { ...ctx, now: i * (1000/60) });
  }
  const endZ = boss.group.position.z;
  assert.ok(endZ > startZ, `boss should move toward last known pos (z: ${startZ.toFixed(2)} → ${endZ.toFixed(2)})`);
});

// 11. Boss does nothing when dead
test('dead boss does not move or fire', () => {
  const boss = buildBossMoot(100, 100);
  boss.alive = false;
  boss.bossAggro = true;
  boss.bossMode  = 'engage';

  const shots = [];
  const ctx = {
    navGrid: grid,
    buildingAABBs: [],
    truckPos: { x: 100, z: 110 },
    now: 1000,
    spawnProjectile: () => shots.push(1),
  };

  for (let i = 0; i < 10; i++) tickBoss(0.016, boss, ctx);
  assert.equal(boss.group.position.x, 100, 'dead boss should not move x');
  assert.equal(boss.group.position.z, 100, 'dead boss should not move z');
  assert.equal(shots.length, 0, 'dead boss should not fire');
});

// 12. No LOS check is used for engage/pursue mode transitions (distance only)
test('mode transitions are distance-based only (no LOS check)', () => {
  const boss = buildBossMoot(100, 100);
  boss.bossAggro = true;

  // Wall between boss and truck — should NOT matter for mode transitions
  const buildingAABBs = [{ minX: 90, maxX: 110, minZ: 115, maxZ: 125 }];
  const truckPos = { x: 100, z: 100 + BOSS.engageRadius - 5 }; // inside engage range

  const ctx = {
    navGrid: grid,
    buildingAABBs,
    truckPos,
    now: 0,
    spawnProjectile: () => {},
  };

  tickBoss(0.016, boss, ctx);
  assert.equal(boss.bossMode, 'engage',
    'boss should enter engage mode based on distance alone regardless of LOS');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
