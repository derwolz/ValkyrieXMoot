/**
 * tools/smoke_perception.mjs — Phase 4 smoke tests
 *
 * Tests:
 *  1.  hasLOS returns true when no buildings block the path.
 *  2.  hasLOS returns false when a building AABB blocks the path.
 *  3.  Boss moots are skipped (state unchanged, threat unchanged).
 *  4.  Dead moots are skipped.
 *  5.  Truck within 8 m raises threat regardless of LOS.
 *  6.  Truck at 12 m with clear LOS raises threat.
 *  7.  Truck behind building: threat decays, does NOT rise.
 *  8.  Threat decays passively when truck is far away.
 *  9.  Threat is clamped to 1 at maximum.
 * 10.  unaware → alarmed-flee when threat ≥ 0.5 (unarmed moot).
 * 11.  unaware → alarmed-armed when threat ≥ 0.5 (armed moot).
 * 12.  alarmed-flee resets _alarmExitTimer when conditions aren't met.
 * 13.  alarmed-flee → recovering after alarmExitSeconds of low threat + far truck.
 * 14.  recovering → unaware after recoverySeconds.
 * 15.  recovering → alarmed-flee immediately on re-alarm.
 * 16.  Truck velocity toward moot adds +0.3 threat.
 * 17.  Recent kill within 15 m adds +0.5 threat.
 * 18.  Recent gunshot within 30 m adds +0.3 threat.
 * 19.  State transition clears path, destination, pathIndex.
 * 20.  _alarmExitTimer accumulates only while conditions are met.
 */

// ---------------------------------------------------------------------------
// Bootstrap: stub browser globals before any module imports.
// ---------------------------------------------------------------------------
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// config.js references `location.search` — provide a stub.
globalThis.location = { search: '' };

const root = resolve(new URL('.', import.meta.url).pathname, '..');

const { tickPerception, hasLOS } = await import(
  pathToFileURL(resolve(root, 'lib/ai/perception.js'))
);

const { AI } = await import(pathToFileURL(resolve(root, 'lib/config.js')));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

function assertApprox(a, b, eps, name) {
  assert(Math.abs(a - b) <= eps, `${name} (got ${a.toFixed(4)}, expected ~${b.toFixed(4)})`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMoot({ armed = false, state = 'unaware', threat = 0, isBoss = false } = {}) {
  return {
    group: { position: { x: 0, z: 0 } },
    alive: true,
    isBoss,
    armed,
    state,
    threat,
    stateEnteredAt: 0,
    _alarmExitTimer: 0,
    _recoveryTimer: 0,
    path: [],
    pathIndex: 0,
    destination: null,
  };
}

// A building from x=10..20, z=-5..5 — blocks line from (0,0) to (30,0)
const blockingAABB = [{ minX: 10, maxX: 20, minZ: -5, maxZ: 5 }];
const noAABBs = [];

const FAR_TRUCK = { x: 200, z: 200 }; // definitely far and no threat
const NEAR_TRUCK_LOS = { x: 12, z: 0 }; // within 25 m with LOS

function makeCtx({
  truckPos = FAR_TRUCK,
  truckVelX = 0,
  truckVelZ = 0,
  aabbs = noAABBs,
  recentKills = [],
  recentShots = [],
  now = 0,
} = {}) {
  return { truckPos, truckVelX, truckVelZ, buildingAABBs: aabbs, now, recentKills, recentShots };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\nPhase 4 – Perception smoke tests\n');

// 1. hasLOS returns true with no buildings.
assert(hasLOS({ x: 0, z: 0 }, { x: 30, z: 0 }, noAABBs), 'hasLOS: clear path returns true');

// 2. hasLOS returns false when building blocks the path.
assert(!hasLOS({ x: 0, z: 0 }, { x: 30, z: 0 }, blockingAABB), 'hasLOS: blocked path returns false');

// 3. Boss moots are skipped.
{
  const boss = makeMoot({ isBoss: true, state: 'unaware', threat: 0 });
  tickPerception(1.0, boss, makeCtx({ truckPos: { x: 3, z: 0 } }));
  assert(boss.state === 'unaware' && boss.threat === 0, 'Boss moot skipped (state/threat unchanged)');
}

// 4. Dead moots are skipped.
{
  const dead = makeMoot({ state: 'unaware', threat: 0 });
  dead.alive = false;
  tickPerception(1.0, dead, makeCtx({ truckPos: { x: 3, z: 0 } }));
  assert(dead.state === 'unaware' && dead.threat === 0, 'Dead moot skipped');
}

// 5. Truck within 8 m raises threat (no LOS needed).
{
  const moot = makeMoot({ threat: 0 });
  tickPerception(0.016, moot, makeCtx({ truckPos: { x: 3, z: 0 }, aabbs: blockingAABB }));
  assert(moot.threat > 0, 'Truck < 8 m raises threat regardless of LOS');
}

// 6. Truck at 12 m with clear LOS raises threat.
{
  const moot = makeMoot({ threat: 0 });
  tickPerception(0.016, moot, makeCtx({ truckPos: { x: 12, z: 0 }, aabbs: noAABBs }));
  assert(moot.threat > 0, 'Truck 12 m clear LOS raises threat');
}

// 7. Truck at 15 m behind building: threat decays, not rises.
// blockingAABB covers x=10..20, z=-5..5. Moot at (0,0), truck at (15,0).
// The segment (0,0)→(15,0) passes through x=10..15 inside the AABB. LOS blocked.
{
  const moot = makeMoot({ threat: 0.2 });
  tickPerception(0.016, moot, makeCtx({ truckPos: { x: 15, z: 0 }, aabbs: blockingAABB }));
  assert(moot.threat < 0.2, 'Truck behind building: threat decays, not rises');
}

// 8. Passive decay when truck is far.
{
  const moot = makeMoot({ threat: 0.8 });
  tickPerception(1.0, moot, makeCtx({ truckPos: FAR_TRUCK }));
  assertApprox(moot.threat, 0.4, 0.05, 'Passive decay: 0.8 → ~0.4 after 1s');
}

// 9. Threat clamped to 1.
{
  const moot = makeMoot({ threat: 0.95 });
  tickPerception(0.016, moot, makeCtx({ truckPos: { x: 3, z: 0 } }));
  assert(moot.threat <= 1.0, 'Threat clamped to 1.0');
}

// 10. unaware → alarmed-flee (unarmed moot).
{
  const moot = makeMoot({ threat: 0.45, armed: false });
  // Single big tick with truck very close to push threat over 0.5.
  tickPerception(0.016, moot, makeCtx({ truckPos: { x: 3, z: 0 }, now: 1000 }));
  assert(moot.state === 'alarmed-flee', 'unaware unarmed → alarmed-flee');
}

// 11. unaware → alarmed-armed (armed moot).
{
  const moot = makeMoot({ threat: 0.45, armed: true });
  tickPerception(0.016, moot, makeCtx({ truckPos: { x: 3, z: 0 }, now: 1000 }));
  assert(moot.state === 'alarmed-armed', 'unaware armed → alarmed-armed');
}

// 12. alarmed-flee: _alarmExitTimer does NOT accumulate when conditions not met.
{
  const moot = makeMoot({ state: 'alarmed-flee', threat: 0.5, _alarmExitTimer: 2.0 });
  moot._alarmExitTimer = 2.0; // explicitly set after makeMoot
  // Truck close (dist < 50 m): condition not met.
  tickPerception(1.0, moot, makeCtx({ truckPos: { x: 10, z: 0 } }));
  assert(moot._alarmExitTimer === 0, 'alarmed-flee: _alarmExitTimer reset when conditions not met');
}

// 13. alarmed-flee → recovering after alarmExitSeconds.
{
  const moot = makeMoot({ state: 'alarmed-flee', threat: 0.0 });
  moot._alarmExitTimer = 4.99;
  // Truck far (dist > 50 m), threat already 0 → timer accumulates past 5 s.
  tickPerception(0.1, moot, makeCtx({ truckPos: { x: 0, z: 100 } }));
  assert(moot.state === 'recovering', 'alarmed-flee → recovering after alarmExitSeconds');
}

// 14. recovering → unaware after recoverySeconds.
{
  const moot = makeMoot({ state: 'recovering', threat: 0.0 });
  moot._recoveryTimer = 7.99;
  tickPerception(0.1, moot, makeCtx({ truckPos: FAR_TRUCK }));
  assert(moot.state === 'unaware', 'recovering → unaware after recoverySeconds');
}

// 15. recovering → alarmed-flee on re-alarm.
{
  const moot = makeMoot({ state: 'recovering', threat: 0.45 });
  tickPerception(0.016, moot, makeCtx({ truckPos: { x: 3, z: 0 }, now: 1000 }));
  assert(moot.state === 'alarmed-flee', 'recovering → alarmed-flee on re-alarm');
}

// 16. Truck velocity toward moot adds +0.3 threat.
{
  const moot = makeMoot({ threat: 0.0 });
  // Truck at (100,0), moving toward moot (0,0) at 10 m/s.
  const truck = { x: 100, z: 0 };
  const vx = -10; // toward moot (negative x direction)
  tickPerception(0.016, moot, makeCtx({ truckPos: truck, truckVelX: vx, truckVelZ: 0 }));
  // Truck > 25 m away so no proximity bonus. Only velocity bonus of 0.3 minus decay.
  // dt=0.016: decay = 0.4*0.016 = 0.0064, gain = 0.3 → net +0.2936
  assert(moot.threat > 0.25, 'Truck velocity toward moot: +0.3 threat applied');
}

// 17. Recent kill within 15 m adds +0.5 threat.
{
  const moot = makeMoot({ threat: 0.0 });
  const kills = [{ x: 5, z: 0, at: 0 }]; // 5 m away, just happened
  tickPerception(0.016, moot, makeCtx({ truckPos: FAR_TRUCK, now: 100, recentKills: kills }));
  assert(moot.threat > 0.4, 'Recent kill within 15 m: +0.5 threat applied');
}

// 18. Recent gunshot within 30 m adds +0.3 threat.
{
  const moot = makeMoot({ threat: 0.0 });
  const shots = [{ x: 10, z: 0, at: 0 }]; // 10 m away, just happened
  tickPerception(0.016, moot, makeCtx({ truckPos: FAR_TRUCK, now: 100, recentShots: shots }));
  assert(moot.threat > 0.25, 'Recent gunshot within 30 m: +0.3 threat applied');
}

// 19. State transition to alarmed-flee clears path and destination.
{
  const moot = makeMoot({ threat: 0.45 });
  moot.path        = [{ x: 10, z: 10 }];
  moot.pathIndex   = 0;
  moot.destination = { x: 10, z: 10 };
  tickPerception(0.016, moot, makeCtx({ truckPos: { x: 3, z: 0 }, now: 1000 }));
  assert(
    moot.path.length === 0 && moot.destination === null && moot.pathIndex === 0,
    'Transition to alarmed-flee clears path/destination',
  );
}

// 20. _alarmExitTimer accumulates only while conditions are met.
{
  const moot = makeMoot({ state: 'alarmed-flee', threat: 0.0 });
  moot._alarmExitTimer = 0;
  // Far truck: conditions met → timer accumulates.
  tickPerception(1.0, moot, makeCtx({ truckPos: { x: 0, z: 100 } }));
  const timerAfterFirstTick = moot._alarmExitTimer;
  assert(timerAfterFirstTick > 0, '_alarmExitTimer increments when conditions met');
  // Close truck: conditions not met → timer resets.
  tickPerception(1.0, moot, makeCtx({ truckPos: { x: 0, z: 10 } }));
  assert(moot._alarmExitTimer === 0, '_alarmExitTimer resets when conditions broken');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
