import * as THREE from 'three';
import { BUILDING, CITY } from '../../config.js';
import { KITS, cloneAsset, naturalFootprint, aabbOf } from './prefabs.js';

// Density / scale tuning.
const SCALE_MIN = 6;
const SCALE_MAX = 14;
const FILL_FACTOR = 0.95;

// Lazy-built index, sorted by tallness so we can pick by zone.
//   tier 0 = skyscrapers + tallest buildings  (downtown core)
//   tier 1 = mid-rise buildings               (mid ring)
//   tier 2 = lowest, squat buildings          (outer ring)
let _prefabIndex = null;
let _tiers = null;
function ensureIndex() {
  if (_prefabIndex) return _prefabIndex;
  const all = [];
  const buildings = KITS.commercial.buildings;
  const skyscrapers = KITS.commercial.skyscrapers;
  for (const name of buildings.concat(skyscrapers)) {
    const fp = naturalFootprint('commercial', name);
    if (!fp) continue;
    all.push({
      name,
      w: fp.width,
      d: fp.depth,
      h: fp.height,
      tallness: fp.height / Math.max(fp.width, fp.depth),
      skyscraper: skyscrapers.includes(name),
    });
  }
  _prefabIndex = all;

  // Build the 3 height tiers. Skyscrapers always go in tier 0. The other
  // buildings split into tier 1 / tier 2 by tallness median.
  const ladder = all.filter(p => !p.skyscraper).slice().sort((a, b) => b.tallness - a.tallness);
  const half = Math.ceil(ladder.length / 2);
  _tiers = [
    [...all.filter(p => p.skyscraper), ...ladder.slice(0, Math.max(2, Math.floor(ladder.length / 4)))],
    ladder.slice(0, half),
    ladder.slice(half),
  ];
  return all;
}

/**
 * Map a normalised radial distance (0 = city centre, 1 = edge) to a building
 * pool weighted toward the right height tier.
 *   r < 0.30 → 75% skyscrapers + tall, 25% mid
 *   r < 0.65 → 50% mid, 25% tall, 25% short
 *   r ≥ 0.65 → 80% short, 20% mid (no skyscrapers)
 */
function poolForRadius(r, rand) {
  if (r < 0.30) return rand() < 0.75 ? _tiers[0] : _tiers[1];
  if (r < 0.65) {
    const u = rand();
    if (u < 0.25) return _tiers[0];
    if (u < 0.75) return _tiers[1];
    return _tiers[2];
  }
  return rand() < 0.20 ? _tiers[1] : _tiers[2];
}

/**
 * Place one prefab per plot. Selection process:
 *   1. Compute the plot's aspect ratio (max side / min side).
 *   2. Pick prefabs with similar aspect (within ±0.4 of plot aspect),
 *      so wide plots get wide buildings and square plots get square ones.
 *   3. For square-ish plots, ~30% chance of preferring a tall (skyscraper-y)
 *      prefab so the skyline isn't flat.
 *   4. Compute uniform scale so the prefab fits the plot at FILL_FACTOR
 *      of the smaller dimension, clamped to [SCALE_MIN, SCALE_MAX].
 *
 * Falls back to a textured box if no prefab is loaded.
 *
 * @returns {{minX:number,maxX:number,minZ:number,maxZ:number}[]}
 */
export function placeBuildings(scene, plots, rand, bounds) {
  const aabbs = [];
  const index = ensureIndex();

  // City centre + half-extents for radial zoning.
  const ccx = (bounds.minX + bounds.maxX) / 2;
  const ccz = (bounds.minZ + bounds.maxZ) / 2;
  const halfX = (bounds.maxX - bounds.minX) / 2;
  const halfZ = (bounds.maxZ - bounds.minZ) / 2;

  for (const plot of plots) {
    const minX = plot.minX + CITY.plotSetback;
    const maxX = plot.maxX - CITY.plotSetback;
    const minZ = plot.minZ + CITY.plotSetback;
    const maxZ = plot.maxZ - CITY.plotSetback;
    const plotW = maxX - minX;
    const plotD = maxZ - minZ;
    if (plotW < 4 || plotD < 4) continue;

    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    plot.district = 'commercial';

    // Radial distance from city centre, with mild noise so tiers blur into
    // each other rather than forming hard concentric rings.
    const radial = Math.max(Math.abs(cx - ccx) / halfX, Math.abs(cz - ccz) / halfZ);
    const r = Math.max(0, Math.min(1, radial + (rand() - 0.5) * 0.2));
    const pool = poolForRadius(r, rand);

    const placed = pickAndPlace(scene, pool, plotW, plotD, cx, cz, rand);
    if (placed) {
      aabbs.push(placed);
    } else if (index.length === 0) {
      // No prefabs loaded at all — degrade to a textured box.
      aabbs.push(boxFallback(scene, minX, maxX, minZ, maxZ, rand));
    }
  }
  return aabbs;
}

function pickAndPlace(scene, index, plotW, plotD, cx, cz, rand) {
  if (!index || index.length === 0) return null;

  const plotMax = Math.max(plotW, plotD);
  const plotMin = Math.min(plotW, plotD);
  const plotAspect = plotMax / plotMin;
  const plotIsSquare = plotAspect < 1.3;

  // Two rotations to try per prefab. After a 90° turn, the prefab's local-X
  // aligns with world-Z, so swap fitW/fitD.
  // Score = abs(prefab_aspect - plot_aspect). Lower is better.
  const candidates = [];
  for (const p of index) {
    for (const swap of [false, true]) {
      const fitW = swap ? p.d : p.w;
      const fitD = swap ? p.w : p.d;
      const prefabMax = Math.max(fitW, fitD);
      const prefabMin = Math.min(fitW, fitD);
      const prefabAspect = prefabMax / prefabMin;
      // Aspect direction: does prefab's long side align with plot's long side?
      const longSideMatch =
        (fitW >= fitD) === (plotW >= plotD);
      const aspectScore = Math.abs(prefabAspect - plotAspect);
      const orientationPenalty = longSideMatch ? 0 : 0.6;
      candidates.push({
        prefab: p,
        rotSteps: swap ? 1 : 0,
        fitW, fitD,
        score: aspectScore + orientationPenalty,
      });
    }
  }

  // Take the best 25% of candidates by aspect match, then pick randomly
  // within them so the city doesn't look repetitive.
  candidates.sort((a, b) => a.score - b.score);
  const cutCount = Math.max(1, Math.floor(candidates.length * 0.25));
  let pool = candidates.slice(0, cutCount);

  // For square-ish plots, 35% chance to bias toward skyscrapers if any are
  // in the top pool; otherwise keep the regular pool.
  if (plotIsSquare && rand() < 0.35) {
    const sky = pool.filter(c => c.prefab.skyscraper);
    if (sky.length > 0) pool = sky;
  }

  const choice = pool[Math.floor(rand() * pool.length)];
  const { prefab, rotSteps, fitW, fitD } = choice;

  // Uniform scale to fill the plot (preserves authored proportions).
  const scale = clamp(
    Math.min(plotW / fitW, plotD / fitD) * FILL_FACTOR,
    SCALE_MIN, SCALE_MAX,
  );

  const inst = cloneAsset('commercial', prefab.name);
  if (!inst) return null;
  inst.scale.setScalar(scale);
  inst.position.set(cx, 0, cz);
  inst.rotation.y = rotSteps * (Math.PI / 2);
  scene.add(inst);
  return aabbOf(inst);
}

const FALLBACK_TOP = new THREE.MeshBasicMaterial({ color: BUILDING.roofColor });
const FALLBACK_SIDE = new THREE.MeshBasicMaterial({ color: 0x4a4d55 });
function boxFallback(scene, minX, maxX, minZ, maxZ, rand) {
  const w = maxX - minX, d = maxZ - minZ;
  const h = CITY.buildingMinHeight + rand() * (CITY.buildingMaxHeight - CITY.buildingMinHeight);
  const materials = [FALLBACK_SIDE, FALLBACK_SIDE, FALLBACK_TOP, FALLBACK_TOP, FALLBACK_SIDE, FALLBACK_SIDE];
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials);
  mesh.position.set((minX + maxX) / 2, h / 2, (minZ + maxZ) / 2);
  scene.add(mesh);
  return { minX, maxX, minZ, maxZ };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
