import * as THREE from 'three';

const FONT_PX = 64;
const FONT = `700 ${FONT_PX}px -apple-system, "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif`;
const STROKE_PX = 6;
const PAD_X = 24;
const PAD_Y = 12;
const MAX_CANVAS_WIDTH = 2048;

// Render a display name to a transparent canvas with white fill + black stroke,
// sized to the text. Returns { texture, aspect } so the caller can scale the sprite.
export function makeNameTexture(displayName) {
  // measuring canvas
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = FONT;
  const textWidth = Math.min(measure.measureText(displayName || ' ').width, MAX_CANVAS_WIDTH - PAD_X * 2);

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(textWidth + PAD_X * 2);
  canvas.height = FONT_PX + PAD_Y * 2;

  const ctx = canvas.getContext('2d');
  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = STROKE_PX;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#fff';

  const x = canvas.width / 2;
  const y = canvas.height / 2;
  ctx.strokeText(displayName || '', x, y);
  ctx.fillText(displayName || '', x, y);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { texture, aspect: canvas.width / canvas.height };
}
