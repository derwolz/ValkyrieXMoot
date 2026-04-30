/**
 * lib/input/bindings.js — User-configurable keybindings with localStorage persistence.
 *
 * Defaults use e.code (physical key position) so WASD works regardless of layout.
 * Overrides are stored under 'vxm_bindings' in localStorage as a JSON object
 * mapping action name → primary key code string.
 *
 * Public API (all on the exported Bindings object):
 *   Bindings.isAction(action)        → bool   (true if any bound key is currently held)
 *   Bindings.codesFor(action)        → string[] ([primary] or [primary, alt])
 *   Bindings.primaryFor(action)      → string  (current primary code)
 *   Bindings.labelFor(action)        → string  (human-readable label, e.g. 'W', '↑')
 *   Bindings.matches(action, code)   → bool   (true if code is bound to action)
 *   Bindings.rebind(action, code)    → void   (set primary override + persist)
 *   Bindings.resetAction(action)     → void   (remove override for action)
 *   Bindings.resetAll()              → void   (clear all overrides)
 *   Bindings.actions                 → string[] (all action names)
 */

/** Default binding definitions. */
export const DEFAULT_BINDINGS = {
  // Movement
  accel:      { label: 'Accelerate',  primary: 'KeyW',      alt: 'ArrowUp',    group: 'movement' },
  brake:      { label: 'Brake/Rev',   primary: 'KeyS',      alt: 'ArrowDown',  group: 'movement' },
  steerLeft:  { label: 'Steer Left',  primary: 'KeyA',      alt: 'ArrowLeft',  group: 'movement' },
  steerRight: { label: 'Steer Right', primary: 'KeyD',      alt: 'ArrowRight', group: 'movement' },
  // Hotkeys
  restart:    { label: 'Restart',     primary: 'KeyR',      alt: null,         group: 'hotkey' },
  rewind:     { label: 'Rewind',      primary: 'KeyQ',      alt: null,         group: 'hotkey' },
  eBrake:     { label: 'E-Brake',     primary: 'Space',     alt: null,         group: 'hotkey' },
  boost:      { label: 'Boost',       primary: 'ShiftLeft', alt: 'ShiftRight', group: 'hotkey' },
  radio:      { label: 'Radio',       primary: 'KeyT',      alt: null,         group: 'hotkey' },
  menu:       { label: 'Menu',        primary: 'Escape',    alt: null,         group: 'hotkey' },
};

const STORAGE_KEY = 'vxm_bindings';

/** Load overrides from localStorage (primary code overrides only). */
function loadOverrides() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Persist overrides to localStorage. */
function saveOverrides(overrides) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch { /* storage unavailable — silently ignore */ }
}

// Mutable overrides map (action → primary code string).
let _overrides = loadOverrides();

// Currently-held key codes.
const _held = new Set();

window.addEventListener('keydown', (e) => { _held.add(e.code); });
window.addEventListener('keyup',   (e) => { _held.delete(e.code); });
window.addEventListener('blur',    ()  => { _held.clear(); });

/** Map e.code to a short human-readable label. */
function codeToLabel(code) {
  if (!code) return '';
  // Arrow keys
  if (code === 'ArrowUp')    return '↑';
  if (code === 'ArrowDown')  return '↓';
  if (code === 'ArrowLeft')  return '←';
  if (code === 'ArrowRight') return '→';
  if (code === 'Space')      return 'Space';
  if (code === 'Escape')     return 'Esc';
  if (code === 'Enter')      return 'Enter';
  if (code === 'Backspace')  return 'Bksp';
  if (code === 'Tab')        return 'Tab';
  if (code === 'ShiftLeft' || code === 'ShiftRight')   return 'Shift';
  if (code === 'ControlLeft'|| code === 'ControlRight') return 'Ctrl';
  if (code === 'AltLeft'    || code === 'AltRight')     return 'Alt';
  // Key[A-Z]
  const keyMatch = code.match(/^Key([A-Z])$/);
  if (keyMatch) return keyMatch[1];
  // Digit[0-9]
  const digitMatch = code.match(/^Digit(\d)$/);
  if (digitMatch) return digitMatch[1];
  // Numpad
  const numpadMatch = code.match(/^Numpad(.+)$/);
  if (numpadMatch) return 'Num' + numpadMatch[1];
  // Fkeys
  const fMatch = code.match(/^(F\d+)$/);
  if (fMatch) return fMatch[1];
  return code;
}

export const Bindings = {
  /** All action names defined in DEFAULT_BINDINGS. */
  get actions() { return Object.keys(DEFAULT_BINDINGS); },

  /** Returns [primary, alt?] codes currently in effect for an action. */
  codesFor(action) {
    const def = DEFAULT_BINDINGS[action];
    if (!def) return [];
    const primary = _overrides[action] ?? def.primary;
    return def.alt ? [primary, def.alt] : [primary];
  },

  /** Current primary code for an action (possibly overridden). */
  primaryFor(action) {
    const def = DEFAULT_BINDINGS[action];
    if (!def) return null;
    return _overrides[action] ?? def.primary;
  },

  /** Human-readable label for the current primary binding. */
  labelFor(action) {
    return codeToLabel(this.primaryFor(action));
  },

  /** True if any bound key for this action is currently held. */
  isAction(action) {
    for (const code of this.codesFor(action)) {
      if (_held.has(code)) return true;
    }
    return false;
  },

  /** True if the specific code is bound to this action (primary or alt). */
  matches(action, code) {
    return this.codesFor(action).includes(code);
  },

  /** Override the primary binding for an action and persist. */
  rebind(action, code) {
    if (!DEFAULT_BINDINGS[action]) return;
    _overrides[action] = code;
    saveOverrides(_overrides);
  },

  /** Reset a single action to its default primary. */
  resetAction(action) {
    delete _overrides[action];
    saveOverrides(_overrides);
  },

  /** Clear all overrides (restore all defaults). */
  resetAll() {
    _overrides = {};
    saveOverrides(_overrides);
  },

  /** Default binding definition for an action (label, group, alt). */
  def(action) {
    return DEFAULT_BINDINGS[action] ?? null;
  },
};
