// Rearview mirror DOM overlay. Placeholder faces are emoji for now — swap the
// `content` field to an image path + change the render path in `apply()` to
// an <img src> assignment when animated WebPs are ready. The public API
// (`setFace(state, ms)`) stays the same so callers don't need to change.

const FACES = {
  neutral:     { content: '😐', bg: '#2a2a30' },
  happy:       { content: '😄', bg: '#3a5a40' },
  celebrating: { content: '🥳', bg: '#5a3a5a' },
  smug:        { content: '😏', bg: '#4a3a5a' },
  angry:       { content: '😠', bg: '#5a3a3a' },
  pained:      { content: '😖', bg: '#3a3a5a' },
  panicked:    { content: '😱', bg: '#5a5a3a' },
};

let els = null;
let revertTimer = null;

export function createMirror() {
  const style = document.createElement('style');
  style.textContent = `
    #mirror {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
      width: 200px; height: 108px;
      border: 3px solid #8b7c52;
      border-radius: 14px;
      background: #1a1a20;
      box-shadow: 0 0 0 2px #0a0a10, 0 4px 12px rgba(0, 0, 0, 0.6);
      overflow: hidden;
      z-index: 8; pointer-events: none;
      transition: background 180ms ease;
    }
    #mirror::before {
      content: '';
      position: absolute; inset: 0;
      background: linear-gradient(120deg,
        rgba(255,255,255,0.06) 0%,
        rgba(255,255,255,0.02) 40%,
        transparent 70%);
      pointer-events: none;
    }
    #mirror-face {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 60px; line-height: 1;
      user-select: none;
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'mirror';
  root.innerHTML = `<div id="mirror-face"></div>`;
  document.body.appendChild(root);

  els = { root, face: document.getElementById('mirror-face') };
  apply('neutral');
}

function apply(state) {
  const f = FACES[state] || FACES.neutral;
  els.face.textContent = f.content;
  els.root.style.background = f.bg;
}

// Show `state`; if `revertAfterMs` is provided, revert to neutral afterward.
// A new setFace call clears any pending revert — the most recent expression wins.
export function setFace(state, revertAfterMs = 0) {
  if (!els) return;
  apply(state);
  if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
  if (revertAfterMs > 0) {
    revertTimer = setTimeout(() => { apply('neutral'); revertTimer = null; }, revertAfterMs);
  }
}
