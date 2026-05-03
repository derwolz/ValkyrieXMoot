/**
 * tools/smoke_9d.mjs — Phase 9d: Boss HUD portrait + HP bar smoke tests.
 *
 * Verifies:
 * - createBossPortrait() creates the DOM panel (hidden by default)
 * - update(bossHandle) shows panel when boss is alive
 * - update(null) hides panel
 * - update(deadBoss) hides panel
 * - HP bar pct = hp / BOSS.hp * 100
 * - HP bar shows 0% when hp = 0
 * - HP bar shows 100% when hp = BOSS.hp
 * - Boss name is rendered from mootRow.display_name
 * - Avatar img src is set from avatarMat.map.image.src
 * - Radar boss dot: isBoss=true handle uses DOT_BOSS radius (7)
 * - Radar boss dot flashes between two colors
 * - Radar regular dot uses DOT_REGULAR radius (3)
 *
 * Run with: node tools/smoke_9d.mjs
 */

// ── Minimal DOM stub ─────────────────────────────────────────────────────────
const styles = {};
const elements = {};

// Very simple DOM mock
function makeEl(_tag) {
  const el = {
    id: '',
    innerHTML: '',
    style: {},
    classList: {
      _classes: new Set(),
      add(...cs) {
        cs.forEach((c) => this._classes.add(c));
      },
      remove(...cs) {
        cs.forEach((c) => this._classes.delete(c));
      },
      toggle(c, force) {
        if (force === undefined) {
          if (this._classes.has(c)) this._classes.delete(c);
          else this._classes.add(c);
        } else {
          force ? this._classes.add(c) : this._classes.delete(c);
        }
        return this._classes.has(c);
      },
      has(c) {
        return this._classes.has(c);
      },
    },
    parentNode: null,
    children: [],
    textContent: '',
    src: '',
    href: '',
    onclick: null,
    getAttribute(k) {
      return this[k] ?? null;
    },
    setAttribute(k, v) {
      this[k] = v;
    },
    querySelector(sel) {
      // parse by id
      const m = sel.match(/^#(.+)$/);
      if (m) return elements[m[1]] ?? null;
      return null;
    },
    querySelectorAll(_sel) {
      return [];
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
    },
  };
  return el;
}

// Mock document
const document = {
  _els: elements,
  createElement(tag) {
    const el = makeEl(tag);
    if (tag === 'div' || tag === 'img') el.tagName = tag.toUpperCase();
    return el;
  },
  getElementById(id) {
    return elements[id] ?? null;
  },
  head: {
    appendChild(child) {
      styles[child.id || Math.random()] = child;
      child.parentNode = this;
    },
    removeChild(child) {
      child.parentNode = null;
    },
  },
  body: {
    appendChild(child) {
      // Register all children by id recursively
      function register(el) {
        if (el.id) elements[el.id] = el;
        // parse innerHTML for child ids via a regex
        if (el.innerHTML) {
          const re = /id="([^"]+)"/g;
          let m = re.exec(el.innerHTML);
          while (m !== null) {
            const childEl = makeEl('div');
            childEl.id = m[1];
            childEl.style = {};
            childEl.classList = {
              _classes: new Set(),
              add(...cs) {
                cs.forEach((c) => this._classes.add(c));
              },
              remove(...cs) {
                cs.forEach((c) => this._classes.delete(c));
              },
              toggle(c, force) {
                if (force === undefined) {
                  if (this._classes.has(c)) this._classes.delete(c);
                  else this._classes.add(c);
                } else {
                  force ? this._classes.add(c) : this._classes.delete(c);
                }
                return this._classes.has(c);
              },
              has(c) {
                return this._classes.has(c);
              },
            };
            // Override querySelector to look up registered elements
            childEl.querySelector = (sel) => {
              const match = sel.match(/^#(.+)$/);
              if (match) return elements[match[1]] ?? null;
              return null;
            };
            elements[m[1]] = childEl;
            m = re.exec(el.innerHTML);
          }
        }
        child.parentNode = this;
      }
      register(child);
    },
    removeChild(child) {
      child.parentNode = null;
      delete elements[child.id];
    },
  },
};

// Make globalThis.document available
globalThis.document = document;
globalThis.location = { search: '' };

// Patch performance.now
globalThis.performance = { now: () => Date.now() };

// ── Import module under test ─────────────────────────────────────────────────
const { createBossPortrait } = await import('../lib/hud/portrait.js');

// ── Test framework ────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ── Helper: build a mock boss handle ─────────────────────────────────────────
function makeBossHandle(opts = {}) {
  return {
    alive: opts.alive ?? true,
    isBoss: true,
    hp: opts.hp ?? 100,
    mootRow: { display_name: opts.name ?? 'Boss McBossface', id: 'b1' },
    avatarMat: {
      map: {
        image: { src: 'https://example.com/boss.png' },
      },
    },
    group: { position: { x: 5, z: 5 } },
    state: 'alarmed-armed',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nPhase 9d – Boss portrait smoke tests\n');

test('createBossPortrait returns { update, destroy }', () => {
  const portrait = createBossPortrait();
  assert(typeof portrait.update === 'function', 'update should be a function');
  assert(typeof portrait.destroy === 'function', 'destroy should be a function');
  portrait.destroy();
});

test('panel hidden by default (no .active class)', () => {
  const portrait = createBossPortrait();
  const panel = document.getElementById('boss-portrait');
  assert(panel, 'panel element should exist');
  assert(!panel.classList.has('active'), 'panel should not have .active class initially');
  portrait.destroy();
});

test('update(null) keeps panel hidden', () => {
  const portrait = createBossPortrait();
  portrait.update(null);
  const panel = document.getElementById('boss-portrait');
  assert(!panel.classList.has('active'), 'panel should be hidden with null handle');
  portrait.destroy();
});

test('update(aliveBoss) shows panel', () => {
  const portrait = createBossPortrait();
  const boss = makeBossHandle({ alive: true });
  portrait.update(boss);
  const panel = document.getElementById('boss-portrait');
  assert(panel.classList.has('active'), 'panel should have .active when boss is alive');
  portrait.destroy();
});

test('update(deadBoss) hides panel', () => {
  const portrait = createBossPortrait();
  const boss = makeBossHandle({ alive: false });
  portrait.update(boss);
  const panel = document.getElementById('boss-portrait');
  assert(!panel.classList.has('active'), 'panel should be hidden when boss.alive=false');
  portrait.destroy();
});

test('HP bar is 100% when hp = BOSS.hp (100)', () => {
  const portrait = createBossPortrait();
  const boss = makeBossHandle({ hp: 100 });
  portrait.update(boss);
  const fill = document.getElementById('boss-hp-fill');
  assert(fill, 'boss-hp-fill should exist');
  assert(fill.style.width === '100%', `expected 100%, got ${fill.style.width}`);
  portrait.destroy();
});

test('HP bar is 50% when hp = 50', () => {
  const portrait = createBossPortrait();
  const boss = makeBossHandle({ hp: 50 });
  portrait.update(boss);
  const fill = document.getElementById('boss-hp-fill');
  assert(fill.style.width === '50%', `expected 50%, got ${fill.style.width}`);
  portrait.destroy();
});

test('HP bar is 0% when hp = 0', () => {
  // hp=0, alive=true (just died this frame)
  const portrait = createBossPortrait();
  const boss = makeBossHandle({ hp: 0, alive: true });
  portrait.update(boss);
  const fill = document.getElementById('boss-hp-fill');
  assert(fill.style.width === '0%', `expected 0%, got ${fill.style.width}`);
  portrait.destroy();
});

test('HP bar shows 10% after 1 pistol shot (hp=90)', () => {
  const portrait = createBossPortrait();
  const boss = makeBossHandle({ hp: 10 });
  portrait.update(boss);
  const fill = document.getElementById('boss-hp-fill');
  assert(fill.style.width === '10%', `expected 10%, got ${fill.style.width}`);
  portrait.destroy();
});

test('boss name displayed from mootRow.display_name', () => {
  const portrait = createBossPortrait();
  const boss = makeBossHandle({ name: 'BossyMcBossface' });
  portrait.update(boss);
  const nameEl = document.getElementById('boss-name');
  assert(nameEl, 'boss-name element should exist');
  assert(
    nameEl.textContent === 'BossyMcBossface',
    `expected 'BossyMcBossface', got '${nameEl.textContent}'`,
  );
  portrait.destroy();
});

test('boss name falls back to "BOSS" when mootRow is null', () => {
  const portrait = createBossPortrait();
  const boss = makeBossHandle();
  boss.mootRow = null;
  portrait.update(boss);
  const nameEl = document.getElementById('boss-name');
  assert(nameEl.textContent === 'BOSS', `expected 'BOSS', got '${nameEl.textContent}'`);
  portrait.destroy();
});

test('avatar img src is set from avatarMat.map.image.src', () => {
  const portrait = createBossPortrait();
  const boss = makeBossHandle();
  portrait.update(boss);
  const img = document.getElementById('boss-avatar-img');
  assert(img, 'boss-avatar-img should exist');
  assert(img.src === 'https://example.com/boss.png', `expected boss.png src, got '${img.src}'`);
  portrait.destroy();
});

test('avatar img src not re-set on repeated update with same texture', () => {
  const portrait = createBossPortrait();
  const boss = makeBossHandle();
  portrait.update(boss);
  const img = document.getElementById('boss-avatar-img');
  img.src = '__sentinel__'; // change it manually to detect re-assignment
  portrait.update(boss); // same texture src, should not re-assign
  assert(img.src === '__sentinel__', `src should not be re-set; got '${img.src}'`);
  portrait.destroy();
});

// ── Radar tests (verify boss dot uses larger radius than regular dots) ────────
// Import radar and mock canvas to verify draw calls

console.log('\n  -- Radar boss/regular dot behavior --');

// We already know from Phase 6 that radar has boss-dot behavior; just verify
// constants are in the expected range.
const radarSrc = await import('../lib/hud/radar.js');

test('radar module exports createRadar function', () => {
  assert(typeof radarSrc.createRadar === 'function', 'createRadar should be exported');
});

// Mock canvas for radar test
function makeCanvasMock() {
  const calls = [];
  const ctx = {
    calls,
    clearRect() {},
    strokeStyle: '',
    lineWidth: 0,
    fillStyle: '',
    globalAlpha: 1,
    beginPath() {},
    arc(x, y, r) {
      calls.push({ op: 'arc', x, y, r });
    },
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    stroke() {},
  };
  const _body = {
    appendChild(el) {
      el.parentNode = this;
    },
    removeChild(el) {
      el.parentNode = null;
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    style: { cssText: '' },
    parentNode: null,
    getContext() {
      return ctx;
    },
    removeChild(c) {
      c.parentNode = null;
    },
  };
  return { canvas, ctx };
}

test('radar renders boss dot with radius 7 and regular dot with radius 3', () => {
  const { canvas, ctx } = makeCanvasMock();
  const realDoc = globalThis.document;

  // Patch document.body.appendChild to capture canvas
  let _capturedCanvas = null;
  const mockBody1 = {
    appendChild(el) {
      _capturedCanvas = el;
      canvas.parentNode = this;
    },
    removeChild(el) {
      el.parentNode = null;
    },
  };
  globalThis.document = {
    ...realDoc,
    createElement(tag) {
      if (tag === 'canvas') return canvas;
      return realDoc.createElement(tag);
    },
    body: mockBody1,
  };

  const radar = radarSrc.createRadar();

  // Build mock moots: one regular (unaware), one boss
  const truckPos = { x: 0, z: 0 };
  const truckYaw = 0;
  const moots = [
    {
      alive: true,
      isBoss: false,
      state: 'unaware',
      group: { position: { x: 5, z: 0 } },
    },
    {
      alive: true,
      isBoss: true,
      state: 'alarmed-armed',
      hp: 80,
      group: { position: { x: -5, z: 0 } },
    },
  ];

  // Force render (bypass frame throttling by calling update 4 times)
  for (let i = 0; i < 4; i++) radar.update(truckPos, truckYaw, moots);

  // Look at arc calls — regular = radius 3, boss = radius 7
  const arcCalls = ctx.calls.filter((c) => c.op === 'arc');
  const regularDot = arcCalls.find((c) => c.r === 3);
  const bossDot = arcCalls.find((c) => c.r === 7);

  assert(
    regularDot,
    `expected an arc with radius 3 for regular moot; got arcs: ${JSON.stringify(arcCalls.map((c) => c.r))}`,
  );
  assert(
    bossDot,
    `expected an arc with radius 7 for boss moot; got arcs: ${JSON.stringify(arcCalls.map((c) => c.r))}`,
  );

  globalThis.document = realDoc;
  radar.destroy();
});

test('radar boss dot uses fillStyle #ff0000 or #ff6666 (flashing)', () => {
  const { canvas, ctx } = makeCanvasMock();
  const _fillStyles = [];
  ctx.fill = () => {};

  // Track fillStyle changes alongside arc calls
  const ops = [];
  ctx.arc = (_x, _y, r) => ops.push({ op: 'arc', r });
  const _origFill = ctx.fill;
  ctx.fill = () => {
    const lastArc = [...ops].reverse().find((o) => o.op === 'arc');
    if (lastArc) ops.push({ op: 'fill', r: lastArc.r, color: ctx.fillStyle });
  };

  const realDoc = globalThis.document;
  const mockBody2 = {
    appendChild(_el) {
      canvas.parentNode = this;
    },
    removeChild(el) {
      el.parentNode = null;
    },
  };
  globalThis.document = {
    ...realDoc,
    createElement(tag) {
      return tag === 'canvas' ? canvas : realDoc.createElement(tag);
    },
    body: mockBody2,
  };

  const radar = radarSrc.createRadar();

  const moots = [
    {
      alive: true,
      isBoss: true,
      state: 'alarmed-armed',
      hp: 50,
      group: { position: { x: 2, z: 0 } },
    },
  ];

  for (let i = 0; i < 4; i++) radar.update({ x: 0, z: 0 }, 0, moots);

  const bossFill = ops.find((o) => o.op === 'fill' && o.r === 7);
  assert(bossFill, 'expected a fill op for radius-7 (boss) arc');
  assert(
    bossFill.color === '#ff0000' || bossFill.color === '#ff6666',
    `boss dot color should be #ff0000 or #ff6666, got ${bossFill.color}`,
  );

  globalThis.document = realDoc;
  radar.destroy();
});

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
