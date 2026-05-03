import * as THREE from 'three';
import { GAME, DEBUG, TARGET } from '../config.js';

// DOM HUD: moot count, hearts, charge bar, game-over overlay. All created in
// JS so index.html stays small. Game-over overlay is part of the HUD root so
// it shares stacking/z-index with the other panels.

let els = null;
const targetProjection = new THREE.Vector3();
const hudCache = {
  score: null,
  scoreValue: null,
  timerSecs: null,
  timerText: null,
  timerWarning: null,
  comboValue: null,
  comboText: null,
  comboShow: null,
  countAlive: null,
  countTotal: null,
  countText: null,
  ammoPct: null,
  boosting: null,
  targetActive: null,
  targetText: null,
  targetUrgent: null,
  targetAngle: null,
  targetDistance: null,
  targetDistanceMeters: null,
};

function setText(el, value, key) {
  if (!el || hudCache[key] === value) return;
  el.textContent = value;
  hudCache[key] = value;
}

function setClass(el, className, active, key) {
  if (!el || hudCache[key] === active) return;
  el.classList.toggle(className, active);
  hudCache[key] = active;
}

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
    #hearts { display: none; }
    #capacitors { display: none; }
    #moot-count { display: none; }
    #target-info {
      position: absolute; top: 80px; left: 50%; transform: translateX(-50%);
      display: flex; flex-direction: column; align-items: center; gap: 6px;
      pointer-events: none;
    }
    #target-arrow {
      font-size: 38px; color: #ffee00;
      text-shadow: 0 0 8px rgba(255,238,0,0.8), 0 0 14px #000;
      transition: transform 0.05s linear;
      display: none;
    }
    #target-arrow.active { display: block; }
    #target-distance {
      font-size: 13px; color: #ffee00; letter-spacing: 2px;
      text-shadow: 0 0 4px rgba(255,238,0,0.6), 0 0 8px #000;
      display: none;
    }
    #target-distance.active { display: block; }
    #target-countdown {
      position: absolute; top: 230px; right: 14px;
      font-size: 22px; color: #fff;
      text-shadow: 0 0 4px #000, 0 0 8px #000;
      letter-spacing: 1px;
      display: none;
    }
    #target-countdown.active { display: block; }
    #target-countdown.urgent { color: #ff4444; animation: timer-pulse 0.4s ease-in-out infinite alternate; }
    #ammo-wrap {
      position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%);
      display: flex; flex-direction: column; align-items: center; gap: 4px;
    }
    #ammo-frame {
      position: relative;
      width: 480px;
      aspect-ratio: 1190 / 460;
    }
    #ammo-frame-img {
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      pointer-events: none; user-select: none;
      z-index: 2;
    }
    /* Workable area inside the meter glass tube — meter is 1190x460,
       inner tube is roughly 800x200 centered → ~16.4% / ~28.3% insets. */
    #ammo-fill-area {
      position: absolute;
      left: 16.4%; right: 16.4%;
      top: 28.3%;  bottom: 28.3%;
      z-index: 1;
      overflow: hidden;
      border-radius: 6px;
    }
    #ammo-fill {
      width: 0%; height: 100%;
      background: linear-gradient(90deg, #b88a2a, #f5c542 55%, #ffe88a);
      transition: width 120ms ease, background 180ms ease;
    }
    #ammo-fill.boosting {
      background: #00eeff;
      animation: ammo-boost-pulse 0.4s ease-in-out infinite alternate;
    }
    @keyframes ammo-boost-pulse { from { opacity: 1; } to { opacity: 0.6; } }
    #ammo-text {
      font-size: 12px; color: #ddd; letter-spacing: 1px;
      text-shadow: 0 0 4px #000;
    }
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
    #score-display {
      position: absolute; top: 14px; left: 210px;
      font-size: 28px; color: #ffee00; font-weight: 700;
      text-shadow: 0 0 6px rgba(255,238,0,0.5), 0 0 12px #000;
      letter-spacing: 2px;
    }
    #timer-display {
      position: absolute; top: 46px; left: 210px;
      font-size: 22px; color: #fff;
      text-shadow: 0 0 4px #000, 0 0 8px #000;
      letter-spacing: 1px;
    }
    #timer-display.warning { color: #ff4444; animation: timer-pulse 0.5s ease-in-out infinite alternate; }
    @keyframes timer-pulse { from { opacity: 1; } to { opacity: 0.55; } }
    #combo-display {
      position: absolute; top: 72px; left: 210px;
      font-size: 18px; color: #ff8844;
      text-shadow: 0 0 6px rgba(255,136,68,0.6), 0 0 10px #000;
      letter-spacing: 1px;
      opacity: 0; transition: opacity 0.3s;
    }
    #combo-display.show { opacity: 1; }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'hud';
  root.innerHTML = `
    <div id="score-display">0</div>
    <div id="timer-display">60s</div>
    <div id="combo-display">x1</div>
    <div id="moot-count">Moots: 0 / 0</div>
    <div id="hearts"></div>
    <div id="capacitors"></div>
    <div id="target-countdown"></div>
    <div id="target-info">
      <div id="target-arrow">↑</div>
      <div id="target-distance"></div>
    </div>
    <div id="ammo-wrap">
      <div id="ammo-frame">
        <div id="ammo-fill-area"><div id="ammo-fill"></div></div>
        <img id="ammo-frame-img" src="/data/hud/meter.png" alt="">
      </div>
      <div id="ammo-text">0%</div>
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
    fill: document.getElementById('ammo-fill'),
    text: document.getElementById('ammo-text'),
    gameover: document.getElementById('gameover'),
    gameoverBtn: document.getElementById('gameover-btn'),
    gameoverTitle: document.getElementById('gameover-title'),
    gameoverSub: document.getElementById('gameover-sub'),
    rewindFlash: document.getElementById('rewind-flash'),
    loginPrompt: document.getElementById('login-prompt'),
    loginXBtn: document.getElementById('login-x-btn'),
    queueSuccess: document.getElementById('queue-success'),
    viewKillsBtn: document.getElementById('view-kills-btn'),
    victory: document.getElementById('victory'),
    victorySub: document.getElementById('victory-sub'),
    scoreDisplay: document.getElementById('score-display'),
    timerDisplay: document.getElementById('timer-display'),
    comboDisplay: document.getElementById('combo-display'),
    targetCountdown: document.getElementById('target-countdown'),
    targetArrow: document.getElementById('target-arrow'),
    targetDistance: document.getElementById('target-distance'),
  };
}

export function updateHud(game) {
  if (!els) return;

  // ── Score & Timer ──────────────────────────────────────────────────────
  const scoreValue = game.score ?? 0;
  if (hudCache.scoreValue !== scoreValue) {
    setText(els.scoreDisplay, String(scoreValue), 'score');
    hudCache.scoreValue = scoreValue;
  }

  if (els.timerDisplay && game.timeRemaining != null) {
    if (game.sessionTimerEnabled === false) {
      setText(els.timerDisplay, 'TIMER OFF', 'timerText');
      hudCache.timerSecs = null;
      setClass(els.timerDisplay, 'warning', false, 'timerWarning');
    } else {
      const secs = Math.ceil(game.timeRemaining);
      if (hudCache.timerSecs !== secs) {
        setText(els.timerDisplay, `${secs}s`, 'timerText');
        hudCache.timerSecs = secs;
      }
      setClass(els.timerDisplay, 'warning', secs <= TARGET.timeWarningS, 'timerWarning');
    }
  }

  if (els.comboDisplay && game.combo != null) {
    const show = game.combo > 1;
    setClass(els.comboDisplay, 'show', show, 'comboShow');
    if (show && hudCache.comboValue !== game.combo) {
      setText(els.comboDisplay, `×${game.combo} COMBO`, 'comboText');
      hudCache.comboValue = game.combo;
    }
  }

  if (hudCache.countAlive !== game.mootsAlive || hudCache.countTotal !== game.mootsTotal) {
    setText(els.count, `Moots: ${game.mootsAlive} / ${game.mootsTotal}`, 'countText');
    hudCache.countAlive = game.mootsAlive;
    hudCache.countTotal = game.mootsTotal;
  }

  const ammo = game.ammo ?? game.charge ?? 0;
  const pct = Math.round((ammo / GAME.maxAmmo) * 100);
  if (hudCache.ammoPct !== pct) {
    if (els.fill) els.fill.style.width = `${pct}%`;
    if (els.text) els.text.textContent = `${pct}%`;
    hudCache.ammoPct = pct;
  }
  setClass(els.fill, 'boosting', !!game.boosting, 'boosting');
  // Hearts and capacitors are hidden via CSS (truck is invincible).
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
/**
 * Show/hide the game-over overlay.
 * @param {boolean} visible
 * @param {Function} [onRestart]  — callback bound to the RESTART button
 * @param {{ title?: string, sub?: string }} [opts]  — optional override text
 */
export function setGameOverVisible(visible, onRestart, opts) {
  if (!els) return;
  els.gameover.classList.toggle('show', visible);
  // Re-bind each time so the closure captures the latest restart fn.
  els.gameoverBtn.onclick = visible && onRestart ? () => onRestart() : null;
  if (opts?.title && els.gameoverTitle) els.gameoverTitle.textContent = opts.title;
  if (opts?.sub && els.gameoverSub) els.gameoverSub.textContent = opts.sub;
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

/**
 * Update the directional target arrow and per-target countdown each frame.
 *
 * @param {import('../game/state.js').GameState} game
 * @param {import('three').Camera} camera  — used for world-to-screen projection
 * @param {import('three').Vector3|null} targetPos  — world position of current target, or null
 */
export function updateTargetHud(game, camera, targetPos) {
  if (!els) return;
  const playing = game.state === 'playing';
  const hasTarget = playing && targetPos != null;

  // Per-target countdown
  if (els.targetCountdown) {
    setClass(els.targetCountdown, 'active', hasTarget, 'targetActive');
    if (hasTarget) {
      const secs = Math.ceil(game.targetCountdown ?? 0);
      setText(els.targetCountdown, `TARGET  ${secs}s`, 'targetText');
      setClass(els.targetCountdown, 'urgent', secs <= (TARGET.targetWarningS ?? 5), 'targetUrgent');
    } else {
      setClass(els.targetCountdown, 'urgent', false, 'targetUrgent');
    }
  }

  // Directional arrow
  if (els.targetArrow && els.targetDistance) {
    setClass(els.targetArrow, 'active', hasTarget, 'targetActiveArrow');
    setClass(els.targetDistance, 'active', hasTarget, 'targetActiveDistance');
    if (hasTarget) {
      // Project target world position to NDC without cloning each frame.
      targetProjection.copy(targetPos).project(camera);
      // Angle from screen center toward the projected point.
      const angle = Math.atan2(targetProjection.x, -targetProjection.y); // atan2(dx, -dy) → CSS rotation angle
      if (hudCache.targetAngle !== angle) {
        els.targetArrow.style.transform = `rotate(${angle}rad)`;
        hudCache.targetAngle = angle;
      }

      // Distance label (world units ≈ metres).
      const dx = targetPos.x - camera.position.x;
      const dz = targetPos.z - camera.position.z;
      const dist = Math.round(Math.sqrt(dx * dx + dz * dz));
      if (hudCache.targetDistanceMeters !== dist) {
        setText(els.targetDistance, `${dist}m`, 'targetDistance');
        hudCache.targetDistanceMeters = dist;
      }
    }
  }
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
  if (!hud) return; // createHud hasn't been called yet — caller must retry after

  const img = document.createElement('img');
  img.id = `hud-slot-${id}`;
  img.src = opts.src;
  img.draggable = false; // prevent browser native drag-ghost
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
  if (patch.src !== undefined) img.src = patch.src;
  if (patch.x !== undefined) img.style.left = `${patch.x}px`;
  if (patch.y !== undefined) img.style.top = `${patch.y}px`;
  if (patch.width !== undefined) img.style.width = `${patch.width}px`;
  if (patch.height !== undefined) img.style.height = `${patch.height}px`;
}

/**
 * Remove a registered slot from the DOM.
 * @param {string} id
 */
export function removeHudSlot(id) {
  const img = _slots.get(id);
  if (!img) return;
  img.parentNode?.removeChild(img);
  _slots.delete(id);
}

// ── Debug drag helper ─────────────────────────────────────────────────────────

function _makeSlotDraggable(img, id) {
  img.style.pointerEvents = 'auto';
  img.style.cursor = 'move';
  img.style.outline = '1px dashed rgba(74,224,255,0.6)';

  let dragging = false;
  let startMouseX = 0;
  let startMouseY = 0;
  let startLeft = 0;
  let startTop = 0;

  img.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startMouseX = e.clientX;
    startMouseY = e.clientY;
    startLeft = Number.parseFloat(img.style.left) || 0;
    startTop = Number.parseFloat(img.style.top) || 0;

    function onMove(ev) {
      if (!dragging) return;
      const dx = ev.clientX - startMouseX;
      const dy = ev.clientY - startMouseY;
      img.style.left = `${startLeft + dx}px`;
      img.style.top = `${startTop + dy}px`;
    }

    function onUp(_ev) {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const finalX = Math.round(Number.parseFloat(img.style.left));
      const finalY = Math.round(Number.parseFloat(img.style.top));
      console.log(`[vxm] hud-slot "${id}" → x:${finalX} y:${finalY}`);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}
