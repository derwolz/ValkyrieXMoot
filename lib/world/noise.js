/**
 * lib/world/noise.js
 *
 * Self-contained Perlin noise implementation.  No external dependencies.
 *
 * Exports:
 *   perlin2(x, y, seed?)  → float in roughly [-1, 1]
 *   fbm(x, y, seed?, octaves?, lacunarity?, gain?)  → float normalised to [0, 1]
 */

// ── Gradient table ────────────────────────────────────────────────────────────

/** 8 cardinal + diagonal 2-D gradient vectors (unit length). */
const GRADS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [-0.7071, 0.7071],
  [0.7071, -0.7071], [-0.7071, -0.7071],
];

// ── Permutation table (seeded) ────────────────────────────────────────────────

/** Build a 512-entry permutation table from a 32-bit integer seed. */
function buildPerm(seed) {
  // LCG shuffle of 0..255 using the seed.
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = seed >>> 0;
  for (let i = 255; i > 0; i--) {
    // xorshift32
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const j = (s >>> 0) % (i + 1);
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}

// Cache last-used perm so repeated calls with the same seed are free.
let _cacheSeed = null;
let _cachePerm = null;

function getPerm(seed) {
  const s = seed === undefined ? 0 : seed >>> 0;
  if (s !== _cacheSeed) {
    _cachePerm = buildPerm(s);
    _cacheSeed = s;
  }
  return _cachePerm;
}

// ── Fade / dot helpers ────────────────────────────────────────────────────────

/** Quintic fade: 6t^5 − 15t^4 + 10t^3  (C2 continuity). */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + t * (b - a);
}

function grad2(perm, ix, iy, dx, dy) {
  const g = GRADS[perm[(ix + perm[iy & 255]) & 255] & 7];
  return g[0] * dx + g[1] * dy;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classic Perlin noise at (x, y).
 *
 * @param {number} x
 * @param {number} y
 * @param {number} [seed=0]  32-bit integer seed
 * @returns {number}  Approximate range [-1, 1]
 */
export function perlin2(x, y, seed = 0) {
  const perm = getPerm(seed);

  const ix = Math.floor(x) & 255;
  const iy = Math.floor(y) & 255;
  const fx = x - Math.floor(x);
  const fy = y - Math.floor(y);

  const u = fade(fx);
  const v = fade(fy);

  const n00 = grad2(perm, ix,     iy,     fx,     fy);
  const n10 = grad2(perm, ix + 1, iy,     fx - 1, fy);
  const n01 = grad2(perm, ix,     iy + 1, fx,     fy - 1);
  const n11 = grad2(perm, ix + 1, iy + 1, fx - 1, fy - 1);

  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
}

/**
 * Fractional Brownian Motion — sums multiple octaves of Perlin noise and
 * normalises the result to [0, 1].
 *
 * @param {number} x
 * @param {number} y
 * @param {number} [seed=0]
 * @param {number} [octaves=5]
 * @param {number} [lacunarity=2.0]   frequency multiplier per octave
 * @param {number} [gain=0.5]         amplitude multiplier per octave
 * @returns {number}  Always in [0, 1]
 */
export function fbm(x, y, seed = 0, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let value = 0;
  let amplitude = 1.0;
  let frequency = 1.0;
  let maxVal = 0;  // tracks maximum possible value for normalisation

  for (let o = 0; o < octaves; o++) {
    value    += perlin2(x * frequency, y * frequency, seed + o * 127) * amplitude;
    maxVal   += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  // Normalise from [-maxVal, maxVal] to [0, 1].
  return (value / maxVal) * 0.5 + 0.5;
}
