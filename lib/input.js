// Thin keyboard state abstraction. Mouse/pistol aiming will live in its own module
// (weapons/pistol.js) once we wire up the gun — intentionally kept separate from
// keyboard to avoid tangling driving input with weapon aiming.
//
// We track TWO key sets:
//   keys     — by e.key (logical character, layout-aware). Used for hotkeys tied
//              to a label (e.g. R = restart, Q = rewind).
//   keyCodes — by e.code (physical position). Used for WASD movement and arrow
//              keys so that the keys at those physical positions always drive the
//              car, regardless of layout (Dvorak, AZERTY, Colemak, etc.).
//
// NOTE: e.key values are normalised to lowercase so callers don't have to worry
// about shift state changing the lookup key (e.g. 'W' vs 'w').

const keys = new Set(); // e.key (logical, lowercased)
const keyCodes = new Set(); // e.code (physical position)

window.addEventListener('keydown', (e) => {
  keys.add(e.key.toLowerCase());
  keyCodes.add(e.code);
  // Prevent browser scroll when Space is used as e-brake.
  if (e.code === 'Space') e.preventDefault();
  // Suppress browser Ctrl shortcuts (Save, Find, Print, Reload, Select-All, …).
  // Skip when Shift/Alt are also held so Ctrl+Shift+I devtools etc. still work.
  if (e.ctrlKey && !e.shiftKey && !e.altKey) e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.key.toLowerCase());
  keyCodes.delete(e.code);
});
window.addEventListener('blur', () => {
  keys.clear();
  keyCodes.clear();
});

export const Input = {
  /** Check by logical character (e.key, lowercased). Use for label-based hotkeys (R, Q, etc.). */
  isDown(key) {
    return keys.has(key.toLowerCase());
  },
  any(...keys_) {
    return keys_.some((k) => keys.has(k.toLowerCase()));
  },

  /** Check by physical key code (e.code). Use for movement keys and any position-dependent hotkeys. */
  isCode(code) {
    return keyCodes.has(code);
  },
  anyCode(...codes) {
    return codes.some((c) => keyCodes.has(c));
  },
};
