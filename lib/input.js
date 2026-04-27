// Thin keyboard state abstraction. Mouse/pistol aiming will live in its own module
// (weapons/pistol.js) once we wire up the gun — intentionally kept separate from
// keyboard to avoid tangling driving input with weapon aiming.

const keys = new Set();

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  // Space toggles pause in main; prevent browser scroll default.
  if (e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

export const Input = {
  isDown(code) { return keys.has(code); },
  any(...codes) { return codes.some((c) => keys.has(c)); },
};
