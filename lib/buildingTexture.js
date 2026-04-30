import * as THREE from 'three';

const PALETTE = [
  '#3a3f4b', '#4a3a3a', '#5c4e3a', '#3e4a4a', '#554a5c',
  '#2e343d', '#4a4640', '#46504a', '#3d3645', '#5c513e',
];

// Maximum number of unique building textures to generate per city.
// All buildings pick from this shared pool by index — no per-building allocation.
const POOL_SIZE = 16;

/**
 * Builds one canvas texture variant.
 * `rand` is an injected PRNG (`() => [0,1)`) so layouts are stable per seed.
 *
 * @param {() => number} rand
 * @param {number} widthPx
 * @param {number} heightPx
 * @returns {THREE.CanvasTexture}
 */
function buildTexture(rand, widthPx = 256, heightPx = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');

  // Facade base
  ctx.fillStyle = PALETTE[Math.floor(rand() * PALETTE.length)];
  ctx.fillRect(0, 0, widthPx, heightPx);

  // Roof band
  ctx.fillStyle = '#15181d';
  ctx.fillRect(0, 0, widthPx, 18);

  // Entrance strip at bottom
  ctx.fillStyle = '#1c1f25';
  ctx.fillRect(0, heightPx - 28, widthPx, 28);

  // Window grid
  const cols = 3 + Math.floor(rand() * 3);
  const winW = Math.floor((widthPx / cols) * 0.55);
  const winH = 24;
  const gapY = 38;
  const startY = 32;
  const litProb = 0.25 + rand() * 0.35;
  for (let y = startY; y < heightPx - 40; y += gapY) {
    for (let c = 0; c < cols; c++) {
      const x = Math.floor((widthPx / cols) * (c + 0.5) - winW / 2);
      const lit = rand() < litProb;
      ctx.fillStyle = lit ? '#ffd66b' : '#10131a';
      ctx.fillRect(x, y, winW, winH);
      if (lit) {
        // subtle inner glow
        ctx.fillStyle = 'rgba(255, 214, 107, 0.18)';
        ctx.fillRect(x - 2, y - 2, winW + 4, winH + 4);
        ctx.fillStyle = '#ffd66b';
        ctx.fillRect(x, y, winW, winH);
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

// Current pool of pre-built textures for the active city.
// Replaced wholesale on each city rebuild via initBuildingTexturePool().
let _pool = /** @type {THREE.CanvasTexture[]} */ ([]);

/**
 * (Re-)build the shared texture pool using the city's seeded PRNG.
 * Must be called once per city generation (before placeBuildings).
 * Disposes any previously allocated CanvasTextures to free GPU memory.
 *
 * @param {() => number} rand — seeded PRNG; same instance used for layout so
 *   textures remain deterministic per seed.
 */
export function initBuildingTexturePool(rand) {
  // Dispose old textures before replacing them.
  for (const t of _pool) t.dispose();
  _pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    _pool.push(buildTexture(rand));
  }
}

/**
 * Pick a texture from the shared pool by integer index.
 * Callers should pass a seeded index to keep layout deterministic.
 *
 * @param {number} idx — any integer; wrapped via modulo into [0, POOL_SIZE).
 * @returns {THREE.CanvasTexture}
 */
export function getBuildingTexture(idx) {
  return _pool[((idx | 0) % POOL_SIZE + POOL_SIZE) % POOL_SIZE];
}
