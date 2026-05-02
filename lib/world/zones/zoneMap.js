/**
 * lib/world/zones/zoneMap.js
 *
 * buildZoneMap({ seed?, width?, length? })
 *   → ZoneMap
 *
 * ZoneMap = {
 *   getZone(x, z)       → zone string (URBAN | SUBURBAN | RURAL | PARK | BEACH | WATER | HIGHWAY)
 *   getWaterInfo(x, z)  → deterministic shoreline/water classification data
 *   getHeight(x, z)     → float in [0, 1]  — terrain height multiplier (0 = sea level)
 *   markHighway(points) → void — reclassifies cells along a polyline as HIGHWAY
 *   serialize()         → structured-clone-safe snapshot for IndexedDB
 *   width, length       — world dimensions in metres (centred at origin)
 * }
 *
 * Layout:
 *   - Negative-Z edge (z ≈ -length/2) is the ocean side.
 *   - A seeded irregular shoreline cuts into that side as bays/coves.
 *   - Cells seaward of that curve are WATER; a finite inland band is BEACH.
 *   - Interior zones are driven by two independent fractal Perlin maps:
 *       density_noise → zone type  (urban / suburban / rural / park)
 *       height_noise  → terrain elevation
 *   - The density map uses a large frequency so blobs are big enough to
 *     be contiguous city districts (several hundred metres across).
 *   - markHighway() overwrites all cells within ±corridorHalfWidth of
 *     each polyline segment as HIGHWAY.
 *
 * No THREE.js imports.
 */

import { fbm } from '../noise.js';
import { CITY, TERRAIN, ZONES, HIGHWAY } from '../../config.js';
import {
  URBAN, SUBURBAN, RURAL, PARK, BEACH, WATER, HIGHWAY as HIGHWAY_ZONE,
} from './zoneTypes.js';

// Normalised height cap for the beach strip ([0,1]).
// TERRAIN.beachMaxElevation is in world units; divide by maxHeight to normalise.
const BEACH_MAX_H_NORM = TERRAIN.beachMaxElevation / TERRAIN.maxHeight;

// ── Internal cell resolution ──────────────────────────────────────────────────
// One cell per 4 m gives 750 × 750 = 562 500 cells for the 3 km world —
// cheap to build and query, fine-grained enough for zone boundaries.
const CELL_SIZE = 4; // metres

// Zone codes stored in the compact cacheable zone buffer.
// 0=URBAN 1=SUBURBAN 2=RURAL 3=PARK 4=BEACH 5=HIGHWAY 6=WATER
const ZONE_CODES = { [URBAN]: 0, [SUBURBAN]: 1, [RURAL]: 2, [PARK]: 3, [BEACH]: 4, [HIGHWAY_ZONE]: 5, [WATER]: 6 };
const ZONE_NAMES = [URBAN, SUBURBAN, RURAL, PARK, BEACH, HIGHWAY_ZONE, WATER];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clamp a numeric value into the normalised height range. */
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smootherstep01(value) {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function createShorelineBuffer({ seed, width, length, cols }) {
  const halfW = width / 2;
  const edgeZ = -length / 2;
  const baseInland = finiteOr(TERRAIN.shorelineBaseInland, TERRAIN.beachStripWidth);
  const noiseAmplitude = finiteOr(TERRAIN.shorelineNoiseAmplitude, 0);
  const noiseFrequency = finiteOr(TERRAIN.shorelineNoiseFrequency, 0.001);
  const bayAmplitude = finiteOr(TERRAIN.shorelineBayAmplitude, 0);
  const shoreSeed = (seed ^ finiteOr(TERRAIN.shorelineSeed, 0x5ea51de)) >>> 0;
  const phase = ((shoreSeed & 0xffff) / 0xffff) * Math.PI * 2;
  const minInland = Math.max(32, finiteOr(TERRAIN.beachStripWidth, 120) * 0.35);
  const maxInland = Math.max(minInland + 1, Math.min(length * 0.42, length - finiteOr(TERRAIN.beachWidth, 95) * 2));
  const shoreline = new Float32Array(cols);

  for (let col = 0; col < cols; col++) {
    const wx = -halfW + col * CELL_SIZE;
    const nx = width > 0 ? wx / width : 0;
    const n = fbm(wx * noiseFrequency, 0.173, shoreSeed, 5, 2.0, 0.5);
    const broadBay = Math.sin(nx * Math.PI * 2.0 + phase) * 0.55
      + Math.sin(nx * Math.PI * 4.7 + phase * 0.37) * 0.30
      + Math.sin(nx * Math.PI * 1.15 - phase * 0.23) * 0.15;
    const inland = Math.max(
      minInland,
      Math.min(maxInland, baseInland + (n - 0.5) * 2 * noiseAmplitude + broadBay * bayAmplitude),
    );
    shoreline[col] = edgeZ + inland;
  }

  return shoreline;
}

/** Map a noise value [0..1] to a zone type based on density thresholds. */
function classifyDensity(density) {
  if (density > ZONES.urbanThreshold)    return URBAN;
  if (density > ZONES.suburbanThreshold) return SUBURBAN;
  if (density > ZONES.ruralThreshold)    return RURAL;
  return PARK;
}

/**
 * Terrain height source: blended fBM layers, still deterministic and normalised.
 * The first layer creates broad landforms; the offset second layer breaks up the
 * old single-mound silhouette without introducing noisy, high-frequency terrain.
 */
function terrainHeight(wx, wz, heightFreq, heightSeed) {
  const broad = fbm(wx * heightFreq, wz * heightFreq, heightSeed, 5, 2.0, 0.5);
  const detailSeed = (heightSeed ^ 0x9e3779b9) >>> 0;
  const detail = fbm(
    (wx + 173.1) * heightFreq * 1.8,
    (wz - 91.7) * heightFreq * 1.8,
    detailSeed,
    4,
    2.0,
    0.5,
  );

  const blended = broad * 0.78 + detail * 0.22;
  const contrasted = clamp01((blended - 0.5) * 1.45 + 0.5);
  return Math.pow(contrasted, 1.25);
}

function createZoneMapFromBuffers({ width, length, cols, rows, zoneBuf, heightBuf, shorelineBuf }) {
  const halfW = width  / 2;
  const halfL = length / 2;

  function worldToIndex(wx, wz) {
    const col = Math.round((wx + halfW) / CELL_SIZE);
    const row = Math.round((wz + halfL) / CELL_SIZE);
    const c   = Math.max(0, Math.min(cols - 1, col));
    const r   = Math.max(0, Math.min(rows - 1, row));
    return { c, r, fi: r * cols + c };
  }

  function shorelineZAtX(wx) {
    if (!shorelineBuf || shorelineBuf.length === 0) return -halfL + TERRAIN.beachStripWidth;
    const fc = (wx + halfW) / CELL_SIZE;
    const c0 = Math.max(0, Math.min(cols - 1, Math.floor(fc)));
    const c1 = Math.max(0, Math.min(cols - 1, c0 + 1));
    const u = clamp01(fc - c0);
    return shorelineBuf[c0] * (1 - u) + shorelineBuf[c1] * u;
  }

  function getWaterInfo(wx, wz) {
    const shorelineZ = shorelineZAtX(wx);
    const distanceToShore = wz - shorelineZ;
    const beachWidth = Math.max(1, finiteOr(TERRAIN.beachWidth, TERRAIN.beachStripWidth));
    const shoreBlendWidth = Math.max(1, finiteOr(TERRAIN.shoreBlendWidth, beachWidth * 0.5));
    return {
      shorelineZ,
      distanceToShore,
      waterDepth: Math.max(0, -distanceToShore),
      isWater: distanceToShore <= 0,
      isBeach: distanceToShore > 0 && distanceToShore <= beachWidth,
      beachFactor: clamp01(distanceToShore / beachWidth),
      shoreBlendFactor: clamp01(distanceToShore / (beachWidth + shoreBlendWidth)),
    };
  }

  function isWater(wx, wz) {
    return getWaterInfo(wx, wz).isWater;
  }

  function getShorelineSamples() {
    const samples = [];
    for (let col = 0; col < cols; col++) {
      samples.push({ x: -halfW + col * CELL_SIZE, z: shorelineBuf[col] });
    }
    return samples;
  }

  /**
   * Zone type at world (x, z).
   * @returns {string}  One of the zone-type constants.
   */
  function getZone(wx, wz) {
    const { fi } = worldToIndex(wx, wz);
    return ZONE_NAMES[zoneBuf[fi]];
  }

  /**
   * Terrain height multiplier at world (x, z).  Always in [0, 1].
   * Multiply by TERRAIN.maxHeight to get world-unit elevation.
   * Uses bilinear interpolation between the four surrounding cells.
   * @returns {number}
   */
  function getHeight(wx, wz) {
    // Convert to fractional cell coords.
    const fc = (wx + halfW) / CELL_SIZE;
    const fr = (wz + halfL) / CELL_SIZE;

    const c0 = Math.max(0, Math.min(cols - 2, Math.floor(fc)));
    const r0 = Math.max(0, Math.min(rows - 2, Math.floor(fr)));
    const c1 = c0 + 1;
    const r1 = r0 + 1;
    const u  = fc - c0;
    const v  = fr - r0;

    const h00 = heightBuf[r0 * cols + c0];
    const h10 = heightBuf[r0 * cols + c1];
    const h01 = heightBuf[r1 * cols + c0];
    const h11 = heightBuf[r1 * cols + c1];

    return h00 * (1 - u) * (1 - v)
         + h10 *      u  * (1 - v)
         + h01 * (1 - u) *      v
         + h11 *      u  *      v;
  }

  function markHighwayPolyline(points, halfWidth) {
    const hw = Number.isFinite(halfWidth) ? halfWidth : HIGHWAY.corridorHalfWidth;
    const hwSq = hw * hw;
    const code = ZONE_CODES[HIGHWAY_ZONE];

    if (!Array.isArray(points) || points.length < 2) return;

    // For each segment, use a bounding-box pre-filter before point-to-segment
    // distance checks.  Through-city expressways and ramps are open polylines;
    // do not connect the last sample back to the first.
    for (let si = 0; si < points.length - 1; si++) {
      const a = points[si];
      const b = points[si + 1];
      if (!a || !b) continue;

      // Axis-aligned bounding box of the segment expanded by hw.
      const minX = Math.min(a.x, b.x) - hw;
      const maxX = Math.max(a.x, b.x) + hw;
      const minZ = Math.min(a.z, b.z) - hw;
      const maxZ = Math.max(a.z, b.z) + hw;

      // Convert to cell ranges.
      const colMin = Math.max(0, Math.floor((minX + halfW) / CELL_SIZE));
      const colMax = Math.min(cols - 1, Math.ceil((maxX + halfW) / CELL_SIZE));
      const rowMin = Math.max(0, Math.floor((minZ + halfL) / CELL_SIZE));
      const rowMax = Math.min(rows - 1, Math.ceil((maxZ + halfL) / CELL_SIZE));

      // Precompute segment vector for point-to-segment distance.
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const abLenSq = abx * abx + abz * abz;
      if (!Number.isFinite(abLenSq) || abLenSq <= 0) continue;

      for (let r = rowMin; r <= rowMax; r++) {
        for (let c = colMin; c <= colMax; c++) {
          const wx = -halfW + c * CELL_SIZE;
          const wz = -halfL + r * CELL_SIZE;

          // Point-to-segment distance (clamped projection).
          let t = ((wx - a.x) * abx + (wz - a.z) * abz) / abLenSq;
          t = Math.max(0, Math.min(1, t));
          const px = a.x + t * abx - wx;
          const pz = a.z + t * abz - wz;
          const dSq = px * px + pz * pz;

          if (dSq <= hwSq) {
            zoneBuf[r * cols + c] = code;
          }
        }
      }
    }
  }

  /**
   * Reclassify cells within ±corridorHalfWidth of each segment in `points`
   * (a flat array of world-space {x,z} objects) as HIGHWAY.
   *
   * @param {{ x: number, z: number }[]} points
   * @param {{ halfWidth?: number }} [opts]
   */
  function markHighway(points, opts = {}) {
    markHighwayPolyline(points, opts.halfWidth);
  }

  /**
   * Reclassify cells for a generated highway layout's reservation polylines.
   * Each reservation may specify its own halfWidth so ramp approaches reserve a
   * narrower corridor than the main elevated deck.
   *
   * @param {{ points: { x: number, z: number }[], halfWidth?: number }[]} reservations
   */
  function markHighwayReservations(reservations) {
    if (!Array.isArray(reservations)) return;
    for (const reservation of reservations) {
      if (!reservation || !Array.isArray(reservation.points)) continue;
      markHighwayPolyline(reservation.points, reservation.halfWidth);
    }
  }

  function serialize() {
    return {
      width,
      length,
      cellSize: CELL_SIZE,
      cols,
      rows,
      zoneCodes: new Uint8Array(zoneBuf),
      heights: new Float32Array(heightBuf),
      shoreline: new Float32Array(shorelineBuf),
    };
  }

  return { getZone, getHeight, getWaterInfo, isWater, getShorelineSamples, markHighway, markHighwayReservations, serialize, width, length, cellSize: CELL_SIZE, cols, rows };
}

function coerceUint8Array(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return null;
}

function coerceFloat32Array(value) {
  if (value instanceof Float32Array) return new Float32Array(value);
  if (Array.isArray(value)) return new Float32Array(value);
  if (value instanceof ArrayBuffer) return new Float32Array(value.slice(0));
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   seed?:   number,   // base seed (default: CITY.seed)
 *   width?:  number,   // world width  in metres (default: CITY.width)
 *   length?: number,   // world length in metres (default: CITY.length)
 * }} [opts]
 */
export function buildZoneMap({ seed = CITY.seed, width = CITY.width, length = CITY.length } = {}) {
  const halfW = width  / 2;
  const halfL = length / 2;

  // Grid dimensions.
  const cols = Math.ceil(width  / CELL_SIZE) + 1;
  const rows = Math.ceil(length / CELL_SIZE) + 1;

  // Flat typed arrays: zones as Uint8 codes, heights as Float32.
  const zoneBuf   = new Uint8Array(cols * rows);
  const heightBuf = new Float32Array(cols * rows);

  // Irregular shoreline: negative-Z side is water until this seeded curve, then
  // an inland beach/shore blend transitions back to ordinary terrain.
  const beachEdgeZ  = -halfL;
  const shorelineBuf = createShorelineBuffer({ seed, width, length, cols });
  const beachWidth = Math.max(1, finiteOr(TERRAIN.beachWidth, TERRAIN.beachStripWidth));
  const shoreBlendWidth = Math.max(1, finiteOr(TERRAIN.shoreBlendWidth, beachWidth * 0.5));

  // Density noise frequency drives blob sizes.
  const densFreq  = ZONES.densityFrequency;
  const densSeed  = (seed ^ ZONES.densitySeed) >>> 0;
  // Height noise.
  const heightFreq = TERRAIN.frequency;
  const heightSeed = (seed ^ TERRAIN.heightSeed) >>> 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const wz = beachEdgeZ + row * CELL_SIZE;  // world Z (−halfL … +halfL)
      const wx = -halfW     + col * CELL_SIZE;  // world X (−halfW … +halfW)
      const fi = row * cols + col;

      // ── Height ────────────────────────────────────────────────────────────
      // Sample blended fBM height [0..1].
      let h = terrainHeight(wx, wz, heightFreq, heightSeed);

      const shorelineZ = shorelineBuf[col];
      const shoreDistance = wz - shorelineZ;

      // ── Zone ──────────────────────────────────────────────────────────────
      let zone;

      // Water and beach follow the seeded, X-varying shoreline instead of a
      // straight strip.  Heights are clamped at sea level in water, then eased
      // up through the sand/shore blend so roads/buildings do not sit below or
      // sharply above the waterfront.
      if (shoreDistance <= 0) {
        h = 0;
        zone = WATER;
      } else if (shoreDistance <= beachWidth) {
        const t = smootherstep01(shoreDistance / beachWidth);
        h = Math.min(h, t * BEACH_MAX_H_NORM);
        zone = BEACH;
      } else {
        if (shoreDistance <= beachWidth + shoreBlendWidth) {
          const t = smootherstep01((shoreDistance - beachWidth) / shoreBlendWidth);
          const shoreCap = BEACH_MAX_H_NORM + t * (1 - BEACH_MAX_H_NORM);
          h = Math.min(h, shoreCap);
        }
        // Interior: classify by density noise.
        const density = fbm(wx * densFreq, wz * densFreq, densSeed, 4, 2.0, 0.5);
        zone = classifyDensity(density);
      }

      zoneBuf[fi]   = ZONE_CODES[zone];
      heightBuf[fi] = h;
    }
  }

  return createZoneMapFromBuffers({ width, length, cols, rows, zoneBuf, heightBuf, shorelineBuf });
}

export function buildZoneMapFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const width = Number(snapshot.width);
  const length = Number(snapshot.length);
  const cols = Number(snapshot.cols);
  const rows = Number(snapshot.rows);
  const cellSize = Number(snapshot.cellSize);
  if (!Number.isFinite(width) || !Number.isFinite(length) || !Number.isInteger(cols) || !Number.isInteger(rows)) {
    return null;
  }
  if (cellSize !== CELL_SIZE) return null;

  const zoneBuf = coerceUint8Array(snapshot.zoneCodes);
  const heightBuf = coerceFloat32Array(snapshot.heights);
  const shorelineBuf = coerceFloat32Array(snapshot.shoreline);
  const expectedLength = cols * rows;
  if (!zoneBuf || !heightBuf || !shorelineBuf || zoneBuf.length !== expectedLength || heightBuf.length !== expectedLength || shorelineBuf.length !== cols) {
    return null;
  }

  return createZoneMapFromBuffers({ width, length, cols, rows, zoneBuf, heightBuf, shorelineBuf });
}
