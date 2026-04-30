/**
 * lib/hud/mirror.js — rearview mirror HUD with reaction overlay.
 *
 * Layout (top-right):
 *   - /data/hud/mirror.png is the visible frame (mounting bracket + chrome).
 *   - <canvas id="mirror-canvas"> sits in the reflective glass area and is the
 *     surface main.js renders the rear-camera into.
 *   - <div id="mirror-face"> sits on top of the canvas in the same glass area
 *     and shows the reaction PNG (chroma-keyed) or emoji fallback.
 *
 * Public API:
 *   createMirror()                              — call once after DOM ready
 *   getMirrorCanvas()                           — canvas main.js renders into
 *   getMirrorSize()                             — { width, height } in CSS px
 *   setFace(state, revertAfterMs?)              — set reaction + auto-revert
 *   setReactionImage(state, src|null)           — swap one state image
 *   setReactionImages({ state: src, … })        — bulk version
 *   updateMirrorSprite(_)                       — kept for API compat; no-op
 */

const REACTIONS = {
  neutral:     { label: '😐', image: "/data/reactions/neutral.png" },
  happy:       { label: '😊', image: "/data/reactions/happy.png" },
  celebrating: { label: '🥳', image: "/data/reactions/celebrate.png" },
  smug:        { label: '😏', image: "/data/reactions/smug.png" },
  angry:       { label: '😠', image: "/data/reactions/angry.png" },
  pained:      { label: '😖', image: "/data/reactions/pained.png" },
  panicked:    { label: '😱', image: "/data/reactions/panicked.png" },
  turbo:       { label: '😤', image: "/data/reactions/turbo.png" },
};

// mirror.png is 1064×476 with a mounting bracket at the top. The reflective
// glass area sits inside the chrome frame. Adjust the GLASS_*_PCT inset
// constants to fine-tune the fit if needed.
const FRAME_W = 450;
const FRAME_H = Math.round(FRAME_W * 476 / 1064);  // ~201
const GLASS_LEFT_PCT   = 0.015;
const GLASS_RIGHT_PCT  = 0.017;
const GLASS_TOP_PCT    = 0.38;
const GLASS_BOTTOM_PCT = 0.07;

// Rearview canvas dimensions = the glass-area subset of the frame, in CSS px.
const PANEL_W = Math.round(FRAME_W * (1 - GLASS_LEFT_PCT - GLASS_RIGHT_PCT));
const PANEL_H = Math.round(FRAME_H * (1 - GLASS_TOP_PCT  - GLASS_BOTTOM_PCT));
const EMOJI_SIZE = Math.min(PANEL_W, PANEL_H);

// Glass shape: hex top (corners drop ~62% of height, beveling up to a flat
// center) + rounded bottom corners. The 4 upper vertices (side-bevel and
// flat-top joints) are softened by a quadratic curve of radius TOP_CORNER_R.
const TOP_DROP_PCT  = 0.62;
const BEVEL_X_PCT   = 0.08;
const CORNER_R      = 10;   // bottom-corner radius
const TOP_CORNER_R  = 8;    // top-corner softening radius
const _td  = Math.round(PANEL_H * TOP_DROP_PCT);
const _bx  = Math.round(PANEL_W * BEVEL_X_PCT);
const _W   = PANEL_W, _H = PANEL_H, _R = CORNER_R, _r = TOP_CORNER_R;
const _hyp = Math.hypot(_bx, _td);
const _ox  = Math.round(_r * _bx / _hyp);   // bevel-direction offset, X
const _oy  = Math.round(_r * _td / _hyp);   // bevel-direction offset, Y
const GLASS_CLIP_PATH = `path("M 0 ${_td + _r} \
Q 0 ${_td} ${_ox} ${_td - _oy} \
L ${_bx - _ox} ${_oy} \
Q ${_bx} 0 ${_bx + _r} 0 \
L ${_W - _bx - _r} 0 \
Q ${_W - _bx} 0 ${_W - _bx + _ox} ${_oy} \
L ${_W - _ox} ${_td - _oy} \
Q ${_W} ${_td} ${_W} ${_td + _r} \
L ${_W} ${_H - _R} \
A ${_R} ${_R} 0 0 1 ${_W - _R} ${_H} \
L ${_R} ${_H} \
A ${_R} ${_R} 0 0 1 0 ${_H - _R} Z")`;

let els = null;
let revertTimer = null;
let _currentState = 'neutral';
const _chromaCache = new Map();

function processImageWithChromaKey(src) {
  if (_chromaCache.has(src)) return _chromaCache.get(src);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        if (g > 90 && g > r * 1.2 && g > b * 1.2) px[i + 3] = 0;
      }
      ctx.putImageData(data, 0, 0);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = src;
  });
  _chromaCache.set(src, p);
  return p;
}

export function createMirror() {
  const style = document.createElement('style');
  style.textContent = `
    #mirror {
      position: fixed; top: 14px; right: 14px;
      width: ${FRAME_W}px; height: ${FRAME_H}px;
      z-index: 8; pointer-events: none;
    }
    /* Glass shape: hex top + rounded bottom corners. Path is in CSS px and
       sized to PANEL_W × PANEL_H so the canvas/face must use exact px. */
    #mirror-canvas, #mirror-face {
      clip-path: ${GLASS_CLIP_PATH};
    }
    #mirror-canvas {
      position: absolute;
      left: ${Math.round(FRAME_W * GLASS_LEFT_PCT)}px;
      top:  ${Math.round(FRAME_H * GLASS_TOP_PCT)}px;
      width:  ${PANEL_W}px;
      height: ${PANEL_H}px;
      z-index: 0;
    }
    #mirror-face {
      position: absolute;
      left: ${Math.round(FRAME_W * GLASS_LEFT_PCT)}px;
      top:  ${Math.round(FRAME_H * GLASS_TOP_PCT)}px;
      width:  ${PANEL_W}px;
      height: ${PANEL_H}px;
      z-index: 1;
      display: flex; align-items: center; justify-content: center;
      font-size: ${Math.round(EMOJI_SIZE * 0.7)}px; line-height: 1;
      user-select: none;
      pointer-events: none;
    }
    /* Frame sits on top so the chrome occludes the canvas/face edges. */
    #mirror-frame-img {
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      pointer-events: none; user-select: none;
      z-index: 2;
    }
    #mirror-face img {
      width: 100%; height: 100%;
      object-fit: cover;
      pointer-events: none;
      user-select: none;
      -webkit-user-drag: none;
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'mirror';
  root.innerHTML = `
    <img id="mirror-frame-img" src="/data/hud/mirror.png" alt="">
    <canvas id="mirror-canvas"></canvas>
    <div id="mirror-face"></div>
  `;
  document.body.appendChild(root);

  const canvas = document.getElementById('mirror-canvas');
  // Set internal canvas resolution to match CSS px × DPR for sharpness.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width  = PANEL_W * dpr;
  canvas.height = PANEL_H * dpr;

  els = {
    root,
    canvas,
    face: document.getElementById('mirror-face'),
  };
  _applyReaction(REACTIONS.neutral);
}
function _applyReaction(r) {
  if (!els) return;

  const face = els.face;

  if (r.image) {
    // Process with chroma key
    processImageWithChromaKey(r.image).then(processedSrc => {
      let img = face.querySelector('img');
      if (!img) {
        face.textContent = '';
        img = document.createElement('img');
        img.draggable = false;
        face.appendChild(img);
      }
      img.src = processedSrc;
    });
  } else {
    face.textContent = r.label ?? '';
  }
}

export function getMirrorCanvas() {
  return els ? els.canvas : null;
}

export function getMirrorSize() {
  return { width: PANEL_W, height: PANEL_H };
}

/**
 * @param {'neutral'|'happy'|'celebrating'|'smug'|'angry'|'pained'|'panicked'} state
 * @param {number} [revertAfterMs=0]
 */
export function setFace(state, revertAfterMs = 0) {
  if (!els) return;
  const next = REACTIONS[state] ? state : 'neutral';
  // Skip redundant re-apply when the state and timer setup haven't changed.
  if (next === _currentState && revertAfterMs === 0 && !revertTimer) return;
  const r = REACTIONS[next];
  _currentState = next;
  _applyReaction(r);
  if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
  if (revertAfterMs > 0) {
    revertTimer = setTimeout(() => {
      _currentState = 'neutral';
      _applyReaction(REACTIONS.neutral);
      revertTimer = null;
    }, revertAfterMs);
  }
}

export function setReactionImage(state, src) {
  if (!REACTIONS[state]) return;
  REACTIONS[state].image = src || null;
  if (_currentState === state) _applyReaction(REACTIONS[state]);
}

export function setReactionImages(map) {
  for (const [state, src] of Object.entries(map)) setReactionImage(state, src);
}

export function updateMirrorSprite(_texture) {}
