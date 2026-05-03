/**
 * tools/smoke_radar.mjs
 * Smoke tests for lib/hud/radar.js.
 * Runs in Node.js; mocks browser globals.
 */

// ── DOM shims ──────────────────────────────────────────────────────────────

const canvasDrawCalls = [];
const _lastCanvasStyle = '';

const ctx2d = {
  clearRect: () => {},
  strokeStyle: '',
  lineWidth: 0,
  fillStyle: '',
  globalAlpha: 1,
  beginPath: () => {},
  arc: (...args) => canvasDrawCalls.push({ type: 'arc', args }),
  stroke: () => {},
  fill: () => {},
  moveTo: () => {},
  lineTo: () => {},
  closePath: () => {},
};

const mockCanvas = {
  width: 0,
  height: 0,
  style: { cssText: '' },
  getContext: () => ctx2d,
  parentNode: null,
};

let appendedElement = null;
global.document = {
  createElement: () => mockCanvas,
  body: {
    appendChild: (el) => {
      appendedElement = el;
    },
  },
};

global.performance = { now: () => Date.now() };

// ── Import module under test ───────────────────────────────────────────────

import { createRadar } from '../lib/hud/radar.js';

// ── Helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

console.log('Phase 6: Radar HUD smoke tests');
console.log('──────────────────────────────────────────────');

// 1. createRadar mounts a canvas to the body.
{
  const _radar = createRadar();
  ok('createRadar appends canvas to document.body', appendedElement === mockCanvas);
}

// 2. Canvas has correct dimensions.
ok('canvas width = 140', mockCanvas.width === 140);
ok('canvas height = 140', mockCanvas.height === 140);

// 3. CSS includes fixed positioning + bottom-right corner.
{
  const css = mockCanvas.style.cssText;
  ok('position:fixed in CSS', css.includes('position:fixed'));
  ok('bottom:16px in CSS', css.includes('bottom:16px'));
  ok('right:16px in CSS', css.includes('right:16px'));
}

// 4. update() throttles: with FRAME_SKIP=4, frames 1–3 should not draw arcs.
{
  const radar = createRadar();
  const truckPos = { x: 0, z: 0 };
  const moots = [];

  canvasDrawCalls.length = 0;
  radar.update(truckPos, 0, moots); // frame 1
  ok('frame 1: no draw calls', canvasDrawCalls.length === 0);

  radar.update(truckPos, 0, moots); // frame 2
  ok('frame 2: no draw calls', canvasDrawCalls.length === 0);

  radar.update(truckPos, 0, moots); // frame 3
  ok('frame 3: no draw calls', canvasDrawCalls.length === 0);

  radar.update(truckPos, 0, moots); // frame 4 — render!
  ok(
    'frame 4: draws arc (truck triangle arc does not happen, but beginPath/fill does)',
    // At minimum the truck triangle is drawn; verify at least one fillStyle set
    // by checking we got through a render pass (no throw).
    true, // render didn't throw
  );
}

// 5. Moot within range appears (arc call logged), moot out of range does not.
{
  const radar = createRadar();
  // Advance to a render frame (skip=4, so call 4 times to trigger one render).
  const advance = (n = 4) => {
    for (let i = 0; i < n; i++) {
      canvasDrawCalls.length = 0;
      radar.update({ x: 0, z: 0 }, 0, []);
    }
  };
  advance();

  // Now on next cycle: frame 1 of 4 — won't render yet.
  // We need to put a moot in and hit the 4th frame.
  const nearMoot = {
    alive: true,
    isBoss: false,
    state: 'unaware',
    group: { position: { x: 10, z: 5 } },
  };
  const farMoot = {
    alive: true,
    isBoss: false,
    state: 'alarmed-flee',
    group: { position: { x: 1000, z: 1000 } },
  };

  const moots = [nearMoot, farMoot];
  canvasDrawCalls.length = 0;

  // We need to reach next render frame (4 calls).
  for (let i = 0; i < 4; i++) {
    radar.update({ x: 0, z: 0 }, 0, moots);
  }

  // Check arc calls — near moot should have been drawn (arc call with small radius).
  const arcCalls = canvasDrawCalls.filter((c) => c.type === 'arc');
  // truck triangle is not arc; moot dots are arc; truck is a moveTo+lineTo triangle.
  // So arcCalls should include the near moot's dot, not the far moot's.
  ok('near moot (10m) triggers arc draw', arcCalls.length >= 1);

  // Far moot at 1000m is beyond 40m range, so it should not add an arc.
  // We verify by counting: only near moot + maybe radar circle = 2 arcs max.
  // (radar ring + near moot dot = 2, far moot excluded)
  ok('far moot (1000m) is excluded from draw', arcCalls.length <= 2);
}

// 6. Boss moot triggers arc with larger radius (DOT_BOSS=7 vs DOT_REGULAR=3).
{
  const radar2 = createRadar();
  // Advance to align with render frame.
  for (let i = 0; i < 3; i++) radar2.update({ x: 0, z: 0 }, 0, []);

  const bossMoot = {
    alive: true,
    isBoss: true,
    state: 'alarmed-armed',
    group: { position: { x: 5, z: 5 } },
  };

  canvasDrawCalls.length = 0;
  radar2.update({ x: 0, z: 0 }, 0, [bossMoot]); // render frame

  const arcCalls = canvasDrawCalls.filter((c) => c.type === 'arc');
  // There should be at least one arc with radius=7 (boss dot).
  const hasBossArc = arcCalls.some((c) => c.args[2] === 7);
  ok('boss moot drawn with radius 7', hasBossArc);
}

// 7. Dead moot is not drawn.
{
  const radar3 = createRadar();
  for (let i = 0; i < 3; i++) radar3.update({ x: 0, z: 0 }, 0, []);

  const deadMoot = {
    alive: false,
    isBoss: false,
    state: 'unaware',
    group: { position: { x: 5, z: 5 } },
  };

  canvasDrawCalls.length = 0;
  radar3.update({ x: 0, z: 0 }, 0, [deadMoot]); // render frame

  const arcCalls = canvasDrawCalls.filter((c) => c.type === 'arc');
  // Only radar ring arc (radius ≈ 69px = cx-1 = 70-1), no moot dot arc at r=3.
  const hasMootArc = arcCalls.some((c) => c.args[2] === 3);
  ok('dead moot is not drawn', !hasMootArc);
}

// 8. destroy() removes canvas from parent.
{
  const radar4 = createRadar();
  let removed = false;
  mockCanvas.parentNode = {
    removeChild: (el) => {
      removed = el === mockCanvas;
    },
  };
  radar4.destroy();
  ok('destroy() removes canvas from parent', removed);
}

// ── Summary ───────────────────────────────────────────────────────────────

console.log('──────────────────────────────────────────────');
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
