/**
 * tools/smoke_state.mjs — smoke tests for Phase 9b ammo economy + damage rules.
 *
 * Tests:
 *   - ramming a regular moot gives charge
 *   - ramming the boss does NOT give charge
 *   - pistol shot decrements boss HP
 *   - boss dies after 10 pistol shots (BOSS.pistolDamage = 10)
 *   - boss ram deals BOSS.ramDamage
 *   - ram refund only applies to regular moots
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

globalThis.location = { search: '' };

const root = resolve(new URL('.', import.meta.url).pathname, '..');
const { GAME, BOSS, MOOT, AMMO } = await import(pathToFileURL(resolve(root, 'lib/config.js')));

// ── Test runner ───────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
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

console.log('\n── Phase 9b Ammo economy + damage rules smoke tests ─────────────────────\n');

// ── Mock helpers to mirror state.js logic without THREE imports ───────────────

/**
 * Mirror of splatMoot from state.js (extracted pure logic).
 * Returns { died, deltaCharge, deltaCapacitors }
 */
function splatMootLogic(handle, weapon, game) {
  if (!handle.alive) return { died: false };

  if (handle.isBoss) {
    const dmg = weapon === 'shot' ? BOSS.pistolDamage : BOSS.ramDamage;
    handle.hp = (handle.hp ?? BOSS.hp) - dmg;
    if (handle.hp > 0) {
      return { died: false };
    }
    // Boss dies
    handle.alive = false;
    game.mootsAlive--;
    return { died: true, isBoss: true };
  }

  handle.alive = false;
  game.mootsAlive--;
  return { died: true, isBoss: false };
}

/**
 * Mirror of ramMoots from state.js (pure logic only).
 */
function ramMootsLogic(rammed, game) {
  for (const h of rammed) {
    const result = splatMootLogic(h, 'ram', game);
    if (!h.isBoss && !h.alive && result.died) {
      // Charge refund for regular moots only.
      if (game.charge >= GAME.maxCharge) {
        if (game.capacitors < GAME.maxCapacitors) {
          game.capacitors++;
          game.charge = 0;
        }
      } else {
        game.charge = Math.min(GAME.maxCharge, game.charge + GAME.chargePerRam);
      }
    }
    // Boss ram: no charge refund.
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// 1. Ram regular gives charge
test('ramming a regular moot gives GAME.chargePerRam charge', () => {
  const handle = { isBoss: false, alive: true, hp: 1, mootRow: { id: 'r1' } };
  const game = { charge: 50, capacitors: 0, mootsAlive: 5 };
  ramMootsLogic([handle], game);
  assert.ok(!handle.alive, 'moot should be dead');
  assert.equal(game.charge, 50 + GAME.chargePerRam, 'charge should increase by chargePerRam');
});

// 2. Ram boss does NOT give charge
test('ramming the boss does not give charge', () => {
  const boss = { isBoss: true, alive: true, hp: BOSS.hp, mootRow: { id: 'boss' } };
  const game = { charge: 50, capacitors: 0, mootsAlive: 5 };
  ramMootsLogic([boss], game);
  // Boss takes damage but should not refund charge.
  assert.equal(game.charge, 50, 'charge should NOT change when ramming boss');
});

// 3. Ram boss decrements boss HP by BOSS.ramDamage
test('ramming boss decrements boss HP by BOSS.ramDamage', () => {
  const boss = { isBoss: true, alive: true, hp: BOSS.hp };
  const game = { charge: 50, capacitors: 0, mootsAlive: 5 };
  splatMootLogic(boss, 'ram', game);
  assert.equal(boss.hp, BOSS.hp - BOSS.ramDamage, 'boss HP should decrease by ramDamage');
});

// 4. Pistol shot decrements boss HP by BOSS.pistolDamage
test('pistol shot decrements boss HP by BOSS.pistolDamage', () => {
  const boss = { isBoss: true, alive: true, hp: BOSS.hp };
  const game = { charge: 50, capacitors: 0, mootsAlive: 5 };
  splatMootLogic(boss, 'shot', game);
  assert.equal(boss.hp, BOSS.hp - BOSS.pistolDamage, 'boss HP should decrease by pistolDamage');
});

// 5. Boss dies after 10 pistol shots (BOSS.pistolDamage = 10, BOSS.hp = 100)
test('boss dies after exactly 10 pistol shots', () => {
  const boss = { isBoss: true, alive: true, hp: BOSS.hp };
  const game = { charge: 50, capacitors: 0, mootsAlive: 1 };
  const shotsNeeded = BOSS.hp / BOSS.pistolDamage;

  for (let i = 0; i < shotsNeeded - 1; i++) {
    const _result = splatMootLogic(boss, 'shot', game);
    assert.ok(boss.alive, `boss should survive shot ${i + 1}`);
  }
  // Final shot
  splatMootLogic(boss, 'shot', game);
  assert.ok(!boss.alive, `boss should die after ${shotsNeeded} shots`);
  assert.equal(boss.hp, 0, 'boss hp should be 0');
  assert.equal(game.mootsAlive, 0, 'mootsAlive should decrement on boss death');
});

// 6. Boss does NOT die from 1 ram (ramDamage = 30, boss hp = 100)
test('boss does not die from a single ram (ramDamage < hp)', () => {
  const boss = { isBoss: true, alive: true, hp: BOSS.hp };
  const game = { charge: 50, capacitors: 0, mootsAlive: 1 };
  assert.ok(BOSS.ramDamage < BOSS.hp, 'ramDamage should not one-shot boss');
  splatMootLogic(boss, 'ram', game);
  assert.ok(boss.alive, 'boss should survive a single ram');
});

// 7. Ram refund only for regular moots (not boss)
test('charge refund is skipped when ramming boss that survives', () => {
  const boss = { isBoss: true, alive: true, hp: BOSS.hp };
  const game = { charge: 50, capacitors: 0, mootsAlive: 5 };
  const prevCharge = game.charge;
  ramMootsLogic([boss], game);
  assert.equal(
    game.charge,
    prevCharge,
    'charge should be unchanged after boss ram that does not kill',
  );
});

// 8. Regular moot ram adds capacitor when charge is full
test('ramming regular when charge is full banks a capacitor', () => {
  const handle = { isBoss: false, alive: true, hp: 1, mootRow: { id: 'r2' } };
  const game = { charge: GAME.maxCharge, capacitors: 0, mootsAlive: 5 };
  ramMootsLogic([handle], game);
  assert.equal(game.capacitors, 1, 'capacitor should increment when charge was full');
  assert.equal(game.charge, 0, 'charge should reset to 0 after capacitor bank');
});

// 9. BOSS.pistolDamage = 10 is in config
test('BOSS.pistolDamage === 10', () => {
  assert.equal(BOSS.pistolDamage, 10, 'BOSS.pistolDamage should be 10');
});

// 10. BOSS.hp = 100 is in config
test('BOSS.hp === 100', () => {
  assert.equal(BOSS.hp, 100, 'BOSS.hp should be 100');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
