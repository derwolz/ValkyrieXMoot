// Mouse state: NDC coords (-1..+1) + one-shot click flag.
// Intentionally independent from the keyboard input module — the mouse only
// drives the pistol, not the camera or car.
// Touch taps (outside the joystick) set clickQueued via TouchInput.consumeTap();
// that is polled in main.js alongside Mouse.consumeClick() so a single tap
// fires the gun on mobile exactly like a left mouse button click.

const state = {
  ndcX: 0,
  ndcY: 0,
  clientX: 0,
  clientY: 0,
  clickQueued: false,
};

window.addEventListener('mousemove', (e) => {
  state.clientX = e.clientX;
  state.clientY = e.clientY;
  state.ndcX = (e.clientX / window.innerWidth) * 2 - 1;
  state.ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
});

window.addEventListener('mousedown', (e) => {
  if (e.button === 0) state.clickQueued = true;
});

export const Mouse = {
  get ndcX() { return state.ndcX; },
  get ndcY() { return state.ndcY; },
  get clientX() { return state.clientX; },
  get clientY() { return state.clientY; },
  // Returns true at most once per actual click; resets internally.
  consumeClick() {
    if (!state.clickQueued) return false;
    state.clickQueued = false;
    return true;
  },
};
