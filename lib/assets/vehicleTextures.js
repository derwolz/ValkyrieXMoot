/**
 * lib/assets/vehicleTextures.js — Vehicle sprite texture loader.
 *
 * Authored frames per NPC vehicle type (5 source PNGs):
 *   <type>_front.png       — viewed from the front (vehicle facing the camera)
 *   <type>_back.png        — viewed from behind  (vehicle facing away)
 *   <type>_frontRight.png  — 3/4 front view, showing the right side
 *   <type>_backRight.png   — 3/4 back  view, showing the right side
 *   <type>_sideRight.png   — pure right-side profile (vehicle 90° to camera)
 * Left-side variants (frontLeft, backLeft, sideLeft) are produced at load
 * time by horizontal mirroring.
 *
 * Player frames (unchanged):
 *   /data/vehicles/player_straight.png
 *   /data/vehicles/player_right.png   (left = mirrored at runtime)
 *
 * Vehicle types: civCar, civTruck, civBus, civCar2, civTruck2.
 * Missing files fall back to procedural placeholders.
 */

import * as THREE from 'three';

/** @typedef {'civCar'|'civTruck'|'civBus'|'civCar2'|'civTruck2'} VehicleType */
/** @typedef {'front'|'back'|'frontRight'|'backRight'|'sideRight'|'frontLeft'|'backLeft'|'sideLeft'} ViewKey */

/** Distinct placeholder colors per vehicle type for easy debug identification */
const PLACEHOLDER_COLORS = {
  civCar: '#3a7fd5', // blue
  civTruck: '#c06a20', // orange
  civBus: '#e0cc22', // yellow
  civCar2: '#5ac070', // green
  civTruck2: '#a040c0', // purple
};

/** Authored view names → file suffix. Left views are mirrored from the right ones. */
const AUTHORED_VIEWS = /** @type {const} */ ([
  'front',
  'back',
  'frontRight',
  'backRight',
  'sideRight',
]);

// ── Texture cache (path → THREE.Texture) ─────────────────────────────────────

/** @type {Map<string, THREE.Texture>} */
const _cache = new Map();

/** RGB distance under which a pixel is treated as the chroma-key color. */
const CHROMA_TOLERANCE = 29;

/**
 * Auto chroma-key an image: sample the top-left pixel; if it's fully opaque,
 * convert all pixels within CHROMA_TOLERANCE of that color to alpha=0.
 * Returns the keyed canvas, or null if the image was already keyed (corner alpha < 255).
 */
function chromaKey(img) {
  const w = img.width || img.videoWidth || 128;
  const h = img.height || img.videoHeight || 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  // Corner pixel = key color. If already transparent, image is pre-keyed.
  if (d[3] < 255) return null;
  const kr = d[0];
  const kg = d[1];
  const kb = d[2];
  const tolSq = CHROMA_TOLERANCE * CHROMA_TOLERANCE;
  for (let i = 0; i < d.length; i += 4) {
    const dr = d[i] - kr;
    const dg = d[i + 1] - kg;
    const db = d[i + 2] - kb;
    if (dr * dr + dg * dg + db * db <= tolSq) d[i + 3] = 0;
  }
  ctx.putImageData(id, 0, 0);
  return canvas;
}

async function loadTex(path) {
  if (_cache.has(path)) return _cache.get(path);
  return new Promise((resolve) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      path,
      (tex) => {
        // Apply auto chroma key. If the source already had transparency,
        // chromaKey returns null and we keep the original texture.
        const keyedCanvas = chromaKey(tex.image);
        let outTex = tex;
        if (keyedCanvas) {
          outTex = new THREE.CanvasTexture(keyedCanvas);
        }
        outTex.colorSpace = THREE.SRGBColorSpace;
        _cache.set(path, outTex);
        resolve(outTex);
      },
      undefined,
      () => resolve(null), // 404 / load error → null
    );
  });
}

/** Horizontally-mirror a THREE.Texture using Canvas2D. */
function mirrorTexture(src) {
  const img = src.image;
  const w = img.width || img.videoWidth || 128;
  const h = img.height || img.videoHeight || 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(img, 0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makePlaceholder(color, label) {
  const SIZE = 128;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = color;
  ctx.fillRect(0, 0, SIZE, SIZE);

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(SIZE * 0.2, SIZE * 0.25, SIZE * 0.6, SIZE * 0.5);
  ctx.fillRect(SIZE * 0.3, SIZE * 0.1, SIZE * 0.4, SIZE * 0.25);

  ctx.fillStyle = '#111';
  ctx.fillRect(SIZE * 0.1, SIZE * 0.55, SIZE * 0.2, SIZE * 0.2);
  ctx.fillRect(SIZE * 0.7, SIZE * 0.55, SIZE * 0.2, SIZE * 0.2);

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  for (const [i, line] of label.split('\n').entries()) {
    ctx.fillText(line, SIZE / 2, SIZE - 8 - (label.split('\n').length - 1 - i) * 14);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ── Loaded texture sets ───────────────────────────────────────────────────────

/**
 * Per-type texture set keyed by view.
 * Populated by loadAllVehicleTextures().
 * @type {Record<VehicleType, Record<ViewKey, THREE.Texture>>}
 */
export const NPC_TEXTURES = {
  civCar: /** @type {any} */ ({}),
  civTruck: /** @type {any} */ ({}),
  civBus: /** @type {any} */ ({}),
  civCar2: /** @type {any} */ ({}),
  civTruck2: /** @type {any} */ ({}),
};

/** Player sprite textures: { straight, right }. left = mirror of right at use site. */
export const PLAYER_TEXTURES = { straight: null, right: null };

let _loaded = false;

/**
 * Load all vehicle textures. Call once before city build; safe to await.
 * Missing files silently fall back to placeholders.
 */
export async function loadAllVehicleTextures() {
  if (_loaded) return;

  const BASE = '/data/vehicles/';

  const typeKeys = /** @type {VehicleType[]} */ (Object.keys(NPC_TEXTURES));

  await Promise.all(
    typeKeys.map(async (type) => {
      const color = PLACEHOLDER_COLORS[type];
      const set = /** @type {Record<ViewKey, THREE.Texture>} */ ({});

      // Load the 4 authored views.
      await Promise.all(
        AUTHORED_VIEWS.map(async (view) => {
          const tex = await loadTex(`${BASE}${type}_${view}.png`);
          set[view] = tex ?? makePlaceholder(color, `${type}\n${view}`);
        }),
      );

      // Derive left-side views by mirroring the right ones.
      set.frontLeft = mirrorTexture(set.frontRight);
      set.backLeft = mirrorTexture(set.backRight);
      set.sideLeft = mirrorTexture(set.sideRight);

      NPC_TEXTURES[type] = set;
    }),
  );

  // Player sprites — unchanged.
  const [straight, right] = await Promise.all([
    loadTex(`${BASE}player_straight.png`),
    loadTex(`${BASE}player_right.png`),
  ]);
  PLAYER_TEXTURES.straight = straight ?? makePlaceholder('#e0e0e0', 'player\nstraight');
  PLAYER_TEXTURES.right = right ?? makePlaceholder('#e0e0e0', 'player\nright');

  _loaded = true;
}

/**
 * Pick a directional frame for an NPC vehicle.
 *
 * rel = vehicleYaw - cameraYaw, normalised to (-π, π].
 *   |rel| ≈ 0   → vehicle faces same way as camera  → we see its BACK
 *   |rel| ≈ π   → vehicle faces toward camera        → we see its FRONT
 *   sign(rel) > 0 → vehicle's right side is closer  → use *Right view
 *   sign(rel) < 0 → vehicle's left  side is closer  → use *Left  (mirrored) view
 *
 * Bucket boundaries (by |rel|, π split into 5 equal zones):
 *   0…π/5     = back
 *   π/5…2π/5  = 3/4 back
 *   2π/5…3π/5 = side
 *   3π/5…4π/5 = 3/4 front
 *   4π/5…π    = front
 *
 * @param {VehicleType} type
 * @param {number} vehicleYaw
 * @param {number} cameraYaw
 * @returns {THREE.Texture}
 */
export function getNpcDirectionalTexture(type, vehicleYaw, cameraYaw) {
  const set = NPC_TEXTURES[type];
  if (!set || !set.front) return makePlaceholder(PLACEHOLDER_COLORS[type] ?? '#888', type);

  // Normalise rel to (-π, π].
  let rel = vehicleYaw - cameraYaw;
  rel = ((((rel + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;

  const abs = Math.abs(rel);
  const right = rel >= 0;

  const fifth = Math.PI / 5;
  if (abs < fifth) return set.back;
  if (abs < fifth * 2) return right ? set.backRight : set.backLeft;
  if (abs < fifth * 3) return right ? set.sideRight : set.sideLeft;
  if (abs < fifth * 4) return right ? set.frontRight : set.frontLeft;
  return set.front;
}
