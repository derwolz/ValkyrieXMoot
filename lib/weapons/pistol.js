// 2-D overlay gun.
// Replaces the old Three.js camera-child meshes with a pure-DOM sprite that
// sits in the bottom-right corner and shifts a fraction of the cursor movement
// so it reads as "aiming" without any perspective distortion.
//
// Public API (unchanged from the 3D version so main.js / state.js are untouched):
//   new Pistol(camera)    — camera arg accepted but ignored
//   pistol.aimAt(worldPt) — drives the parallax offset via mouse NDC
//   pistol.tryFire()      — returns true when a shot is registered; spawns laser beam
//   pistol.update(dt)     — advances cooldown / muzzle flash / laser timers
//   pistol.getScreenPos() — {x, y} px from top-left, muzzle tip centre

import * as THREE from 'three';
import { PISTOL } from '../config.js';

// Reused buffer for projecting the muzzle world point each shot.
const _projTmp = new THREE.Vector3();

// ── SVG gun drawing ────────────────────────────────────────────────────────────
// A minimal side-profile pixel-art style gun drawn as inline SVG so we need
// no external asset.  Replace the <img src> with a real sprite whenever you
// have one — just swap the markup inside _el.
const GUN_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 48" width="80" height="48">
  <!-- barrel -->
  <rect x="4" y="17" width="46" height="10" rx="2" fill="#c8cdd6"/>
  <!-- slide -->
  <rect x="20" y="10" width="30" height="18" rx="3" fill="#8a9099"/>
  <!-- ejection port -->
  <rect x="30" y="12" width="12" height="5" rx="1" fill="#3a3d42"/>
  <!-- front sight -->
  <rect x="8" y="14" width="4" height="5" fill="#4a4d52"/>
  <!-- rear sight -->
  <rect x="44" y="12" width="5" height="4" fill="#4a4d52"/>
  <!-- trigger guard -->
  <path d="M36 28 Q40 36 44 28" stroke="#6a6d72" stroke-width="2.5" fill="none"/>
  <!-- grip -->
  <rect x="34" y="26" width="16" height="20" rx="3" fill="#5a5d62"/>
  <!-- grip texture lines -->
  <line x1="37" y1="30" x2="47" y2="30" stroke="#3a3d42" stroke-width="1.2"/>
  <line x1="37" y1="34" x2="47" y2="34" stroke="#3a3d42" stroke-width="1.2"/>
  <line x1="37" y1="38" x2="47" y2="38" stroke="#3a3d42" stroke-width="1.2"/>
  <!-- muzzle end highlight -->
  <rect x="4" y="17" width="6" height="10" rx="1" fill="#d8dde6"/>
</svg>`;

// Scale applied to the SVG so it renders crisply on high-DPI screens.
const DISPLAY_W = 160;
const DISPLAY_H = 96;

// ── Laser beam canvas ──────────────────────────────────────────────────────────
// A single fullscreen canvas sits above everything, z-index 9.
// Beams are drawn on it and fade via opacity.
let _laserCanvas = null;
let _laserCtx    = null;

function _ensureLaserCanvas() {
  if (_laserCanvas) return;
  _laserCanvas = document.createElement('canvas');
  _laserCanvas.id = 'laser-canvas';
  _laserCanvas.style.cssText = [
    'position:fixed',
    'inset:0',
    'width:100%',
    'height:100%',
    'pointer-events:none',
    'z-index:9',
  ].join(';');
  document.body.appendChild(_laserCanvas);
  _laserCtx = _laserCanvas.getContext('2d');
  _resizeLaserCanvas();
  window.addEventListener('resize', _resizeLaserCanvas);
}

function _resizeLaserCanvas() {
  if (!_laserCanvas) return;
  _laserCanvas.width  = window.innerWidth;
  _laserCanvas.height = window.innerHeight;
}

// Active beam descriptors: { x0, y0, x1, y1, life, maxLife }
const _beams = [];

function _renderBeams() {
  if (!_laserCtx || _beams.length === 0) {
    if (_laserCtx) _laserCtx.clearRect(0, 0, _laserCanvas.width, _laserCanvas.height);
    return;
  }
  _laserCtx.clearRect(0, 0, _laserCanvas.width, _laserCanvas.height);
  for (const b of _beams) {
    const t = Math.max(0, b.life / b.maxLife); // 1→0 as it fades
    // Outer glow
    _laserCtx.save();
    _laserCtx.globalAlpha = t * 0.45;
    _laserCtx.strokeStyle = PISTOL.laserGlowColor;
    _laserCtx.lineWidth   = PISTOL.laserGlowWidth;
    _laserCtx.lineCap     = 'round';
    _laserCtx.shadowBlur  = 18;
    _laserCtx.shadowColor = PISTOL.laserGlowColor;
    _laserCtx.beginPath();
    _laserCtx.moveTo(b.x0, b.y0);
    _laserCtx.lineTo(b.x1, b.y1);
    _laserCtx.stroke();
    _laserCtx.restore();
    // Core beam
    _laserCtx.save();
    _laserCtx.globalAlpha = t;
    _laserCtx.strokeStyle = PISTOL.laserColor;
    _laserCtx.lineWidth   = PISTOL.laserWidth;
    _laserCtx.lineCap     = 'round';
    _laserCtx.shadowBlur  = 8;
    _laserCtx.shadowColor = PISTOL.laserColor;
    _laserCtx.beginPath();
    _laserCtx.moveTo(b.x0, b.y0);
    _laserCtx.lineTo(b.x1, b.y1);
    _laserCtx.stroke();
    _laserCtx.restore();
  }
}

export class Pistol {
  /**
   * @param {*} _camera  — accepted for API compatibility; not used.
   */
  constructor(_camera) {
    _ensureLaserCanvas();

    // ── wrapper ──────────────────────────────────────────────────────────────
    const wrap = document.createElement('div');
    wrap.id = 'pistol-overlay';
    wrap.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      `width:${DISPLAY_W}px`,
      `height:${DISPLAY_H}px`,
      // Anchor: bottom-right corner, no offset yet.
      `bottom:${PISTOL.anchorBottom}px`,
      `right:${PISTOL.anchorRight}px`,
      'z-index:8',           // above HUD (z-index 7) but below laser canvas
      'transform-origin:right bottom',
      'will-change:transform',
    ].join(';');
    wrap.innerHTML = GUN_SVG;
    // Resize the SVG element itself.
    const svg = wrap.querySelector('svg');
    svg.setAttribute('width', String(DISPLAY_W));
    svg.setAttribute('height', String(DISPLAY_H));
    document.body.appendChild(wrap);
    this._el = wrap;

    // Muzzle flash layer — a radial glow div that fades on top of the barrel tip.
    const flash = document.createElement('div');
    flash.style.cssText = [
      'position:absolute',
      'left:-18px',          // centred on barrel tip (SVG x=4 → left of wrap)
      'top:14px',
      'width:36px',
      'height:36px',
      'border-radius:50%',
      'background:radial-gradient(circle,rgba(100,180,255,0.95) 0%,rgba(60,120,255,0.6) 40%,transparent 72%)',
      'opacity:0',
      'pointer-events:none',
      'will-change:opacity',
    ].join(';');
    wrap.appendChild(flash);
    this._flash = flash;

    // Parallax offset (px) applied via transform.
    this._ox = 0;
    this._oy = 0;

    this._muzzleTimeLeft = 0;
    this._cooldown       = 0;
  }

  // ── aimAt ──────────────────────────────────────────────────────────────────
  /**
   * Receive the 3-D aim point (world space).  We don't use the world coords —
   * instead we read the mouse NDC directly to compute a 2-D parallax shift.
   * main.js passes a THREE.Vector3 here; we just ignore it and read Mouse NDC
   * via the global that main.js already tracks.
   *
   * @param {THREE.Vector3 | {x:number,y:number,z:number}} _worldPt
   */
  aimAt(_worldPt) {
    // Read live mouse position from the DOM (avoids importing Mouse here).
    // window.__vxmMouse is written by main.js each frame (see patch below).
    const ndcX = window.__vxmMouse ? window.__vxmMouse.ndcX : 0;
    const ndcY = window.__vxmMouse ? window.__vxmMouse.ndcY : 0;

    // ndcX: -1 (left) → +1 (right).  When the cursor moves right the gun tips
    // slightly right, so parallax offset is positive-x.
    // ndcY: -1 (bottom) → +1 (top).  We want a DOWN shift when cursor is high
    // (gun rises to follow the cross-hair), so offset is -y.
    this._ox = ndcX * PISTOL.aimParallaxX;
    this._oy = -ndcY * PISTOL.aimParallaxY;

    // Tilt the gun slightly: positive ndcY means cursor is above centre →
    // barrel tilts up (negative rotation around the anchor bottom-right).
    const tilt = ndcY * PISTOL.aimTiltDeg;
    this._el.style.transform = `translate(${this._ox}px,${this._oy}px) rotate(${-tilt}deg)`;
  }

  // ── tryFire ────────────────────────────────────────────────────────────────
  /**
   * @param {THREE.Vector3} [originWorld]  — world point to use as beam start.
   *   When provided with `camera`, the beam emits from this projected screen
   *   position instead of the gun-overlay muzzle.
   * @param {THREE.Camera} [camera]
   */
  tryFire(originWorld, camera) {
    if (this._cooldown > 0) return false;
    this._flash.style.opacity = '1';
    this._muzzleTimeLeft = PISTOL.muzzleFlashLifetime;
    this._cooldown       = PISTOL.cooldownSeconds;

    // Beam start: vehicle muzzle in world space (preferred), else gun overlay.
    let x0, y0;
    if (originWorld && camera) {
      _projTmp.copy(originWorld).project(camera);
      x0 = (_projTmp.x * 0.5 + 0.5) * window.innerWidth;
      y0 = (1 - (_projTmp.y * 0.5 + 0.5)) * window.innerHeight;
    } else {
      const muzzle = this.getScreenPos();
      x0 = muzzle.x;
      y0 = muzzle.y;
    }

    // Beam end: extend toward the cursor, past the viewport edge.
    const cx = window.__vxmMouse ? (window.__vxmMouse.ndcX * 0.5 + 0.5) * window.innerWidth  : x0;
    const cy = window.__vxmMouse ? (1 - (window.__vxmMouse.ndcY * 0.5 + 0.5)) * window.innerHeight : y0;
    const dx = cx - x0;
    const dy = cy - y0;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const scale = Math.max(window.innerWidth, window.innerHeight) * 2 / len;
    _beams.push({
      x0, y0,
      x1: x0 + dx * scale,
      y1: y0 + dy * scale,
      life: PISTOL.laserLifetime,
      maxLife: PISTOL.laserLifetime,
    });

    return true;
  }

  // ── update ─────────────────────────────────────────────────────────────────
  update(dt) {
    if (this._muzzleTimeLeft > 0) {
      this._muzzleTimeLeft -= dt;
      const t = Math.max(0, this._muzzleTimeLeft / PISTOL.muzzleFlashLifetime);
      this._flash.style.opacity = String(t);
    }
    if (this._cooldown > 0) this._cooldown -= dt;

    // Tick laser beams; prune expired ones.
    for (let i = _beams.length - 1; i >= 0; i--) {
      _beams[i].life -= dt;
      if (_beams[i].life <= 0) _beams.splice(i, 1);
    }
    _renderBeams();
  }

  // ── getScreenPos ───────────────────────────────────────────────────────────
  /**
   * Returns the approximate screen position of the muzzle tip in CSS pixels
   * from the top-left of the viewport.  Used by the laser-beam effect.
   * @returns {{ x: number, y: number }}
   */
  getScreenPos() {
    const rect = this._el.getBoundingClientRect();
    // Muzzle tip is at the left edge of the SVG, vertically centred on the barrel.
    // SVG barrel centre-y ≈ 22 / 96 of DISPLAY_H.
    return {
      x: rect.left + this._ox,
      y: rect.top  + (DISPLAY_H * 22 / 96) + this._oy,
    };
  }
}
