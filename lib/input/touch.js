/**
 * lib/input/touch.js — Virtual joystick + tap-to-shoot for touch screens.
 *
 * Creates a circular joystick in the bottom-left corner that appears only on
 * touch-capable devices (CSS hides it on desktop). Dragging the knob sets
 * accel and steer in [-1, +1]. Tapping anywhere outside the joystick sets a
 * one-shot "tap" flag that the shooting pipeline reads as a click.
 *
 * Usage (import side-effects; read state via TouchInput):
 *
 *   import { TouchInput } from './lib/input/touch.js';
 *
 *   // In update loop:
 *   const accel  = TouchInput.accel;   // [-1 (reverse) .. +1 (forward)]
 *   const steer  = TouchInput.steer;   // [-1 (left)    .. +1 (right)]
 *   const tapped = TouchInput.consumeTap(); // true once per tap outside joystick
 */

// ── DOM: joystick shell + knob ────────────────────────────────────────────────

// Use the elements pre-baked in index.html rather than creating duplicates.
const _shell = document.getElementById('joy-shell');
const _knob = document.getElementById('joy-knob');

// ── State ─────────────────────────────────────────────────────────────────────

// Joystick active touch identifier (null when no finger is on the joystick).
let _joyTouchId = null;
// Shell centre in page coordinates — computed lazily on first touch because the
// element may not be laid out when this module first loads.
let _shellCx = 0;
let _shellCz = 0;

// Joystick output — updated by _updateJoy().
let _accel = 0;
let _steer = 0;

// One-shot tap flag for the shoot pipeline.
let _tapQueued = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Half-width of the shell (the maximum knob travel radius). */
function _shellRadius() {
  return _shell.offsetWidth / 2;
}

/** Refresh the cached shell centre. */
function _refreshCentre() {
  const r = _shell.getBoundingClientRect();
  _shellCx = r.left + r.width / 2;
  _shellCz = r.top + r.height / 2;
}

/**
 * Recompute _accel/_steer from touch coordinates and move the knob.
 * @param {number} px — clientX of the active touch
 * @param {number} py — clientY of the active touch
 */
function _updateJoy(px, py) {
  const maxR = _shellRadius();
  if (maxR === 0) return;

  let dx = px - _shellCx;
  let dy = py - _shellCz;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Clamp to circle.
  if (dist > maxR) {
    dx = (dx / dist) * maxR;
    dy = (dy / dist) * maxR;
  }

  // Map: screen-Y maps to accel (up = forward), screen-X maps to steer.
  _steer = dx / maxR; // right = +1
  _accel = -(dy / maxR); // up on screen = forward = +1

  // Dead-zone: ignore tiny perturbations.
  const DZ = 0.08;
  if (Math.abs(_steer) < DZ) _steer = 0;
  if (Math.abs(_accel) < DZ) _accel = 0;

  // Visual: offset the knob within the shell.
  _knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
}

/** Reset joystick to centre. */
function _resetJoy() {
  _joyTouchId = null;
  _accel = 0;
  _steer = 0;
  _knob.style.transform = 'translate(-50%, -50%)';
}

/**
 * Return true if the point (cx, cy) in page coords is inside the joystick shell.
 */
function _hitShell(cx, cy) {
  const r = _shellRadius();
  const dx = cx - _shellCx;
  const dy = cy - _shellCz;
  return dx * dx + dy * dy <= r * r;
}

// ── Touch event handlers ──────────────────────────────────────────────────────

window.addEventListener(
  'touchstart',
  (e) => {
    _refreshCentre();

    for (const t of e.changedTouches) {
      if (_joyTouchId === null && _hitShell(t.clientX, t.clientY)) {
        // This touch owns the joystick.
        _joyTouchId = t.identifier;
        _updateJoy(t.clientX, t.clientY);
      } else if (!_hitShell(t.clientX, t.clientY)) {
        // Tap outside joystick → queue shoot.
        _tapQueued = true;
      }
    }
  },
  { passive: true },
);

window.addEventListener(
  'touchmove',
  (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === _joyTouchId) {
        _updateJoy(t.clientX, t.clientY);
      }
    }
  },
  { passive: true },
);

window.addEventListener(
  'touchend',
  (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === _joyTouchId) {
        _resetJoy();
      }
    }
  },
  { passive: true },
);

window.addEventListener(
  'touchcancel',
  (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === _joyTouchId) {
        _resetJoy();
      }
    }
  },
  { passive: true },
);

// ── Public API ────────────────────────────────────────────────────────────────

export const TouchInput = {
  /** Forward/reverse input in [-1, +1]. Positive = forward. */
  get accel() {
    return _accel;
  },

  /** Steering input in [-1, +1]. Positive = right / clockwise yaw. */
  get steer() {
    return _steer;
  },

  /**
   * Returns true at most once per tap outside the joystick; resets internally.
   * Mirrors Mouse.consumeClick() semantics so the shoot pipeline is unchanged.
   */
  consumeTap() {
    if (!_tapQueued) return false;
    _tapQueued = false;
    return true;
  },
};
