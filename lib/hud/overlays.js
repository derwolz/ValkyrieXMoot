import { GAME, DEBUG } from '../config.js';

// DOM HUD: moot count, hearts, charge bar, game-over overlay. All created in
// JS so index.html stays small. Game-over overlay is part of the HUD root so
// it shares stacking/z-index with the other panels.

let els = null;

export function createHud() {
  const style = document.createElement('style');
  style.textContent = `
    #hud { position: fixed; inset: 0; pointer-events: none; font-family: monospace; z-index: 7; }
    #moot-count {
      position: absolute; top: 56px; left: 12px;
      font-size: 22px; color: #fff;
      text-shadow: 0 0 4px #000, 0 0 8px #000;
      letter-spacing: 1px;
    }
    #hearts {
      position: absolute; top: 92px; left: 12px;
      font-size: 28px; letter-spacing: 6px;
      text-shadow: 0 0 4px #000, 0 0 6px #000;
    }
    #hearts .on  { color: #e04848; }
    #hearts .off { color: #3a3a40; }
    #capacitors {
      position: absolute; top: 130px; left: 12px;
      font-size: 26px; letter-spacing: 6px;
      text-shadow: 0 0 4px #000, 0 0 6px #000;
    }
    #capacitors .cap-on  { color: #4ae0ff; text-shadow: 0 0 8px #4ae0ff, 0 0 14px #2ab8e0; }
    #capacitors .cap-off { color: #1a2a30; }
    #charge-wrap {
      position: absolute; bottom: 36px; left: 50%; transform: translateX(-50%);
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      min-width: 360px;
    }
    #charge-label { font-size: 11px; color: #bbb; letter-spacing: 3px; }
    #charge-bar {
      width: 100%; height: 14px; border: 1px solid #444;
      background: rgba(0, 0, 0, 0.55); border-radius: 2px; overflow: hidden;
    }
    #charge-fill {
      height: 100%; width: 0%;
      background: linear-gradient(90deg, #3ee07a, #e8d44a 60%, #e05c3a);
      transition: width 120ms ease;
    }
    #charge-text { font-size: 12px; color: #ddd; letter-spacing: 1px; }
    #gameover {
      position: absolute; inset: 0;
      display: none; flex-direction: column;
      align-items: center; justify-content: center; gap: 18px;
      background: rgba(8, 8, 12, 0.82);
      cursor: default;
    }
    #gameover.show { display: flex; pointer-events: auto; }
    #gameover-title {
      font-size: 64px; color: #e04848;
      letter-spacing: 10px; font-weight: 700;
      text-shadow: 0 0 12px rgba(224, 72, 72, 0.4);
    }
    #gameover-sub { color: #bbb; font-size: 13px; letter-spacing: 2px; }
    #victory {
      position: absolute; inset: 0;
      display: none; flex-direction: column;
      align-items: center; justify-content: center; gap: 18px;
      background: rgba(8, 8, 12, 0.82);
      pointer-events: none;
    }
    #victory.show { display: flex; }
    #victory-title {
      font-size: 64px; color: #4ae0ff;
      letter-spacing: 10px; font-weight: 700;
      text-shadow: 0 0 12px rgba(74,224,255,0.5);
    }
    #victory-sub { color: #bbb; font-size: 13px; letter-spacing: 2px; }
    #gameover-btn {
      padding: 10px 24px; font: 14px monospace;
      background: #2a2a30; color: #eee; border: 1px solid #555;
      cursor: pointer; letter-spacing: 2px;
    }
    #gameover-btn:hover { background: #3a3a40; }
    #login-prompt {
      display: none; flex-direction: column;
      align-items: center; gap: 12px;
      border-top: 1px solid #333; padding-top: 16px; margin-top: 4px;
    }
    #login-prompt.show { display: flex; }
    #login-prompt-text { color: #aaa; font-size: 12px; letter-spacing: 2px; text-align: center; max-width: 320px; line-height: 1.6; }
    #login-x-btn {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 22px; font: 13px monospace;
      background: #000; color: #fff; border: 1px solid #555;
      cursor: pointer; letter-spacing: 1px; text-decoration: none;
    }
    #login-x-btn:hover { background: #1a1a1a; border-color: #888; }
    #login-x-btn svg { flex-shrink: 0; }
    #queue-success {
      display: none; flex-direction: column; align-items: center; gap: 6px;
    }
    #queue-success.show { display: flex; }
    #queue-success-text { color: #4ae0ff; font-size: 12px; letter-spacing: 2px; text-align: center; }
    #view-kills-btn {
      padding: 8px 18px; font: 12px monospace;
      background: #0a1a20; color: #4ae0ff; border: 1px solid #4ae0ff;
      cursor: pointer; letter-spacing: 2px; text-decoration: none;
    }
    #view-kills-btn:hover { background: #0d2530; }
    #rewind-flash {
      position: absolute; inset: 0;
      background: radial-gradient(ellipse at center, rgba(180,230,255,0.95) 0%, rgba(60,160,255,0.85) 50%, rgba(20,80,200,0.7) 100%);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.5s ease-out;
    }
    #rewind-flash.flash-in  { opacity: 1; transition: none; }
    #rewind-flash.flash-out { opacity: 0; transition: opacity 0.6s ease-out; }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'hud';
  root.innerHTML = `
    <div id="moot-count">Moots: 0 / 0</div>
    <div id="hearts"></div>
    <div id="capacitors"></div>
    <div id="charge-wrap">
      <div id="charge-label">CHARGE</div>
      <div id="charge-bar"><div id="charge-fill"></div></div>
      <div id="charge-text">0%</div>
    </div>
    <div id="rewind-flash"></div>
    <div id="victory">
      <div id="victory-title">WRECKED THE BOSS</div>
      <div id="victory-sub">Next city loading…</div>
    </div>
    <div id="gameover">
      <div id="gameover-title">WRECKED</div>
      <div id="gameover-sub">Press R or click below to restart</div>
      <button id="gameover-btn" type="button">RESTART</button>
      <div id="login-prompt">
        <div id="login-prompt-text">Log in with X to save your kills &amp; join the moot roster</div>
        <a id="login-x-btn" href="/auth/x">
          <svg width="16" height="16" viewBox="0 0 1200 1227" fill="white" xmlns="http://www.w3.org/2000/svg"><path d="M714.163 519.284L1160.89 0H1055.03L667.137 450.887L357.328 0H0L468.492 681.821L0 1226.37H105.866L515.491 750.218L842.672 1226.37H1200L714.137 519.284H714.163ZM569.165 687.828L521.697 619.934L144.011 79.6944H306.615L611.412 515.685L658.88 583.579L1055.08 1150.3H892.476L569.165 687.854V687.828Z"/></svg>
          Sign in with X
        </a>
      </div>
      <div id="queue-success">
        <div id="queue-success-text">✓ Added to the moot queue!</div>
        <a id="view-kills-btn" href="#" target="_blank">VIEW YOUR KILLS →</a>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  els = {
    count: document.getElementById('moot-count'),
    hearts: document.getElementById('hearts'),
    capacitors: document.getElementById('capacitors'),
    fill: document.getElementById('charge-fill'),
    text: document.getElementById('charge-text'),
    gameover: document.getElementById('gameover'),
    gameoverBtn: document.getElementById('gameover-btn'),
    rewindFlash: document.getElementById('rewind-flash'),
    loginPrompt: document.getElementById('login-prompt'),
    loginXBtn: document.getElementById('login-x-btn'),
    queueSuccess: document.getElementById('queue-success'),
    viewKillsBtn: document.getElementById('view-kills-btn'),
    victory: document.getElementById('victory'),
    victorySub: document.getElementById('victory-sub'),
  };
}

export function updateHud(game) {
  if (!els) return;
  els.count.textContent = `Moots: ${game.mootsAlive} / ${game.mootsTotal}`;
  const pct = Math.round((game.charge / GAME.maxCharge) * 100);
  els.fill.style.width = pct + '%';
  els.text.textContent = pct + '%';
  const pieces = [];
  for (let i = 0; i < GAME.maxHealth; i++) {
    pieces.push(`<span class="${i < game.health ? 'on' : 'off'}">♥</span>`);
  }
  els.hearts.innerHTML = pieces.join('');
  const caps = [];
  const capCount = game.capacitors ?? 0;
  for (let i = 0; i < GAME.maxCapacitors; i++) {
    caps.push(`<span class="${i < capCount ? 'cap-on' : 'cap-off'}">⚡</span>`);
  }
  els.capacitors.innerHTML = caps.join('');
}

/** Fire the rewind flash effect. Instant white-blue burst that fades out. */
export function showRewindFlash() {
  if (!els) return;
  const el = els.rewindFlash;
  // Remove both classes to reset, force reflow, then trigger flash-in → flash-out.
  el.classList.remove('flash-in', 'flash-out');
  // eslint-disable-next-line no-unused-expressions
  el.offsetWidth; // force reflow so removing classes is seen
  el.classList.add('flash-in');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.remove('flash-in');
      el.classList.add('flash-out');
    });
  });
}

/**
 * Show/hide the victory overlay.
 * @param {boolean} visible
 * @param {string}  [subText]  — optional subtitle (defaults to 'Next city loading…')
 */
export function setVictoryVisible(visible, subText) {
  if (!els) return;
  els.victory.classList.toggle('show', visible);
  if (subText && els.victorySub) els.victorySub.textContent = subText;
}

/**
 * Show/hide the game-over overlay.
 * @param {boolean} visible
 * @param {Function} [onRestart]  — callback bound to the RESTART button
 */
export function setGameOverVisible(visible, onRestart) {
  if (!els) return;
  els.gameover.classList.toggle('show', visible);
  // Re-bind each time so the closure captures the latest restart fn.
  els.gameoverBtn.onclick = visible && onRestart ? () => onRestart() : null;
  // Hide sub-panels when game-over is dismissed.
  if (!visible) {
    els.loginPrompt.classList.remove('show');
    els.queueSuccess.classList.remove('show');
  }
}

/**
 * Show the X login prompt inside the game-over screen.
 * Pass returnHandle to pre-fill the "view kills" link once logged in.
 * @param {string} [returnHandle]
 */
export function showLoginPrompt(returnHandle) {
  if (!els) return;
  els.loginPrompt.classList.add('show');
  els.queueSuccess.classList.remove('show');
  // After OAuth redirect, /?login=success is returned — no extra state needed.
  if (returnHandle) {
    els.viewKillsBtn.href = `/player/${encodeURIComponent(returnHandle)}`;
  }
}

/**
 * Hide the login prompt (e.g. after the player logs in mid-session).
 */
export function hideLoginPrompt() {
  if (!els) return;
  els.loginPrompt.classList.remove('show');
}

/**
 * Show the queue-enqueue success message and link to the kill-screen.
 * @param {string} handle  — the player's X handle
 */
export function showQueueSuccess(handle) {
  if (!els) return;
  els.queueSuccess.classList.add('show');
  els.loginPrompt.classList.remove('show');
  els.viewKillsBtn.href = `/player/${encodeURIComponent(handle)}`;
  els.viewKillsBtn.textContent = `VIEW @${handle}'S KILLS →`;
}

// ── HUD image slot system ─────────────────────────────────────────────────────
// Slots are lightweight <img> elements pinned by absolute CSS coordinates
// inside #hud (which is already position:fixed, pointer-events:none).
// In ?debug mode every slot gets pointer-events:auto so it can be dragged;
// on mouseup the current position is logged to the console.

/** @type {Map<string, HTMLElement>} */
const _slots = new Map();

/**
 * Register (or replace) a named HUD image slot.
 *
 * @param {string} id  — unique slot name, e.g. 'crosshair'
 * @param {{ src: string, x: number, y: number, width: number, height: number }} opts
 *   x / y are in CSS pixels from the top-left of the viewport.
 */
export function registerHudSlot(id, opts) {
  // Remove previous element for this id if it already exists.
  removeHudSlot(id);

  const hud = document.getElementById('hud');
  if (!hud) return;   // createHud hasn't been called yet — caller must retry after

  const img = document.createElement('img');
  img.id           = `hud-slot-${id}`;
  img.src          = opts.src;
  img.draggable    = false;   // prevent browser native drag-ghost
  img.style.cssText = [
    'position:absolute',
    `left:${opts.x}px`,
    `top:${opts.y}px`,
    `width:${opts.width}px`,
    `height:${opts.height}px`,
    'object-fit:contain',
    'pointer-events:none',
    'user-select:none',
  ].join(';');

  if (DEBUG.enabled) {
    _makeSlotDraggable(img, id);
  }

  hud.appendChild(img);
  _slots.set(id, img);
}

/**
 * Update one or more properties of an already-registered slot.
 * Missing keys are left unchanged.
 *
 * @param {string} id
 * @param {{ src?: string, x?: number, y?: number, width?: number, height?: number }} patch
 */
export function setHudSlot(id, patch) {
  const img = _slots.get(id);
  if (!img) return;
  if (patch.src    !== undefined) img.src               = patch.src;
  if (patch.x      !== undefined) img.style.left        = patch.x      + 'px';
  if (patch.y      !== undefined) img.style.top         = patch.y      + 'px';
  if (patch.width  !== undefined) img.style.width       = patch.width  + 'px';
  if (patch.height !== undefined) img.style.height      = patch.height + 'px';
}

/**
 * Remove a registered slot from the DOM.
 * @param {string} id
 */
export function removeHudSlot(id) {
  const img = _slots.get(id);
  if (!img) return;
  img.parentNode && img.parentNode.removeChild(img);
  _slots.delete(id);
}

// ── Debug drag helper ─────────────────────────────────────────────────────────

function _makeSlotDraggable(img, id) {
  img.style.pointerEvents = 'auto';
  img.style.cursor        = 'move';
  img.style.outline       = '1px dashed rgba(74,224,255,0.6)';

  let dragging = false;
  let startMouseX = 0, startMouseY = 0;
  let startLeft   = 0, startTop    = 0;

  img.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging   = true;
    startMouseX = e.clientX;
    startMouseY = e.clientY;
    startLeft   = parseFloat(img.style.left)  || 0;
    startTop    = parseFloat(img.style.top)   || 0;

    function onMove(ev) {
      if (!dragging) return;
      const dx = ev.clientX - startMouseX;
      const dy = ev.clientY - startMouseY;
      img.style.left = (startLeft + dx) + 'px';
      img.style.top  = (startTop  + dy) + 'px';
    }

    function onUp(ev) {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
      const finalX = Math.round(parseFloat(img.style.left));
      const finalY = Math.round(parseFloat(img.style.top));
      console.log(`[vxm] hud-slot "${id}" → x:${finalX} y:${finalY}`);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  });
}
