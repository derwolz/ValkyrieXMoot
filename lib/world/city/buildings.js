/**
 * lib/world/city/buildings.js
 *
 * InstancedMesh building renderer.
 *
 * placeBuildings(scene, plots, rand, getTerrainY?)
 *   → { aabbs, disposeBuildingMeshes }
 *
 * Buildings are bucketed by approximate height into N size buckets. Each bucket
 * gets exactly one InstancedMesh — so the maximum number of draw calls for all
 * buildings is equal to the number of buckets (≤ 10).
 *
 * Each instance matrix encodes the building's world position (with terrain Y)
 * and scale (width × height × depth). The top face uses a flat dark roof color
 * via a second InstancedMesh using a different material.
 *
 * AABBs keep the existing X/Z fields and now also include optional vertical
 * extents (`minY`/`maxY`) so height-aware collision can distinguish side hits
 * from jumps over the roof without affecting callers that only read X/Z.
 *
 * disposeBuildingMeshes() removes all instanced meshes and frees GPU resources.
 */

import * as THREE from 'three';
import { BUILDING, CITY } from '../../config.js';
import { getBuildingTexture } from '../../buildingTexture.js';
import { KITS, aabbOf, cloneAsset, naturalFootprint } from './prefabs.js';

// ── Bucket definitions ────────────────────────────────────────────────────────
// We split buildings into height buckets so each bucket can share one geometry.
// Within a bucket all buildings get the same BoxGeometry (1×1×1 unit cube)
// and a per-instance matrix that scales to the actual dimensions.

const ROOF_COLOR = BUILDING.roofColor ?? 0x4e5663;
const MOUNTAIN_RIDGE_COLOR = 0x5f6670;
const BOUNDARY_ROOF_COLOR = ROOF_COLOR;
const BUCKET_THRESHOLDS = [12, 20, 28]; // heights in metres

function getBucket(h) {
  for (let i = 0; i < BUCKET_THRESHOLDS.length; i++) {
    if (h < BUCKET_THRESHOLDS[i]) return i;
  }
  return BUCKET_THRESHOLDS.length; // last bucket
}

const NUM_BUCKETS = BUCKET_THRESHOLDS.length + 1; // 4
const BOUNDARY_BUILDING_TEXTURE_INDEX = NUM_BUCKETS;
const PREFAB_SCALE_MIN = 6;
const PREFAB_SCALE_MAX = 14;
const PREFAB_FILL_FACTOR = 0.95;

function getBuildProfile(zone) {
  return CITY.zoneBuildProfiles?.[zone] ?? CITY.zoneBuildProfiles?.urban ?? {};
}

// Shared unit-cube geometry — one per bucket so we can dispose independently.
// (In practice they are all 1×1×1, but isolated so disposal is clean.)
const _unitGeo = new THREE.BoxGeometry(1, 1, 1);
const _ridgeGeo = new THREE.ConeGeometry(0.5, 1, 4, 1);

function createFacadeMaterial({ textureIndex, name }) {
  return new THREE.MeshLambertMaterial({
    map: getBuildingTexture(textureIndex),
    name,
  });
}

function createRoofMaterial({ name, color = ROOF_COLOR }) {
  return new THREE.MeshLambertMaterial({
    color,
    name,
  });
}

// ── Module state ──────────────────────────────────────────────────────────────

/** @type {{ meshes: THREE.InstancedMesh[], scene: THREE.Scene } | null} */
let _current = null;
let _prefabIndex = null;
let _prefabTiers = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Place buildings via InstancedMesh — one mesh per height bucket.
 *
 * @param {THREE.Scene} scene
 * @param {object[]} plots — array of { minX, maxX, minZ, maxZ, zone? }
 * @param {() => number} rand — seeded PRNG
 * @param {((x:number,z:number)=>number)|null} [getTerrainY]
 * @returns {{
 *   aabbs: {minX:number,maxX:number,minZ:number,maxZ:number,minY:number,maxY:number}[],
 *   disposeBuildingMeshes: ()=>void,
 * }}
 */
export function placeBuildings(scene, plots, rand, getTerrainY = null, bounds = null) {
  // Dispose any previously created instanced meshes.
  disposeBuildingMeshes();

  const prefabIndex = ensurePrefabIndex();
  if (prefabIndex.length > 0 && bounds) {
    return placePrefabBuildings(scene, plots, rand, getTerrainY, bounds, prefabIndex);
  }

  // ── Pass 1: collect all instance data grouped by bucket ───────────────────
  /** @type {{ cx:number, cy:number, cz:number, w:number, h:number, d:number }[][]} */
  const buckets = Array.from({ length: NUM_BUCKETS }, () => []);
  const aabbs = [];

  for (const plot of plots) {
    const profile = getBuildProfile(plot.zone);
    const setback = profile.plotSetback ?? CITY.plotSetback;
    const minFootprint = profile.minBuildingFootprint ?? 4;
    const minHeight = profile.buildingMinHeight ?? CITY.buildingMinHeight;
    const maxHeight = profile.buildingMaxHeight ?? CITY.buildingMaxHeight;

    const minX = plot.minX + setback;
    const maxX = plot.maxX - setback;
    const minZ = plot.minZ + setback;
    const maxZ = plot.maxZ - setback;
    const w = maxX - minX;
    const d = maxZ - minZ;
    if (w < minFootprint || d < minFootprint) continue;

    const h = minHeight + rand() * (maxHeight - minHeight);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const baseY = getTerrainY ? getTerrainY(cx, cz) : 0;
    const cy = baseY + h / 2; // centre Y of the box

    const minY = baseY;
    const maxY = baseY + h;

    buckets[getBucket(h)].push({ cx, cy, cz, w, h, d });
    aabbs.push({ minX, maxX, minZ, maxZ, minY, maxY });
  }

  // ── Pass 2: create InstancedMesh per bucket ───────────────────────────────
  const dummy = new THREE.Object3D();
  const meshes = [];

  for (let bi = 0; bi < NUM_BUCKETS; bi++) {
    const instances = buckets[bi];
    if (instances.length === 0) continue;

    const sideMat = createFacadeMaterial({ textureIndex: bi, name: `building-side-bucket-${bi}` });
    const roofMat = createRoofMaterial({ name: `building-roof-bucket-${bi}` });

    // These city-wide InstancedMeshes are intentionally handled as always-visible
    // global batches by chunkManager. Chunking by their Object3D origin would
    // incorrectly hide every building at once when the origin chunk is culled;
    // keeping ≤8 draw-call batches visible is cheaper than splitting every
    // height bucket into many spatial meshes.
    const sideMesh = new THREE.InstancedMesh(_unitGeo, sideMat, instances.length);
    Object.assign(sideMesh.userData, {
      isBuildingInstanced: true,
      vxmDiagnosticCategory: 'building',
      vxmMaterialRole: 'side',
      vxmHeightBucket: bi,
      vxmInstanceCount: instances.length,
    });
    sideMesh.count = instances.length;

    // Roof instanced mesh (same count, same positions, but covers only top face
    // via a thin slab placed at the top of each building).
    const roofMesh = new THREE.InstancedMesh(_unitGeo, roofMat, instances.length);
    Object.assign(roofMesh.userData, {
      isBuildingInstanced: true,
      vxmDiagnosticCategory: 'building',
      vxmMaterialRole: 'roof',
      vxmHeightBucket: bi,
      vxmInstanceCount: instances.length,
    });
    roofMesh.count = instances.length;

    for (let ii = 0; ii < instances.length; ii++) {
      const { cx, cy, cz, w, h, d } = instances[ii];

      // Side building box.
      dummy.position.set(cx, cy, cz);
      dummy.scale.set(w, h, d);
      dummy.updateMatrix();
      sideMesh.setMatrixAt(ii, dummy.matrix);

      // Roof slab — 0.25 m thick, placed on top of the building.
      dummy.position.set(cx, cy + h / 2 + 0.125, cz);
      dummy.scale.set(w + 0.05, 0.25, d + 0.05); // slight overhang
      dummy.updateMatrix();
      roofMesh.setMatrixAt(ii, dummy.matrix);
    }

    sideMesh.instanceMatrix.needsUpdate = true;
    roofMesh.instanceMatrix.needsUpdate = true;

    scene.add(sideMesh);
    scene.add(roofMesh);
    meshes.push(sideMesh, roofMesh);
  }

  // ── Store reference for disposal ──────────────────────────────────────────
  _current = { meshes, scene };

  return { aabbs, disposeBuildingMeshes };
}

function ensurePrefabIndex() {
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

  const ladder = all
    .filter((p) => !p.skyscraper)
    .slice()
    .sort((a, b) => b.tallness - a.tallness);
  const half = Math.ceil(ladder.length / 2);
  _prefabTiers = [
    [
      ...all.filter((p) => p.skyscraper),
      ...ladder.slice(0, Math.max(2, Math.floor(ladder.length / 4))),
    ],
    ladder.slice(0, half),
    ladder.slice(half),
  ];
  _prefabIndex = all;
  return all;
}

function poolForRadius(r, rand) {
  if (r < 0.3) return rand() < 0.75 ? _prefabTiers[0] : _prefabTiers[1];
  if (r < 0.65) {
    const u = rand();
    if (u < 0.25) return _prefabTiers[0];
    if (u < 0.75) return _prefabTiers[1];
    return _prefabTiers[2];
  }
  return rand() < 0.2 ? _prefabTiers[1] : _prefabTiers[2];
}

function placePrefabBuildings(scene, plots, rand, getTerrainY, bounds, prefabIndex) {
  const aabbs = [];
  const objects = [];
  const ccx = (bounds.minX + bounds.maxX) / 2;
  const ccz = (bounds.minZ + bounds.maxZ) / 2;
  const halfX = Math.max(1, (bounds.maxX - bounds.minX) / 2);
  const halfZ = Math.max(1, (bounds.maxZ - bounds.minZ) / 2);

  for (const plot of plots) {
    const profile = getBuildProfile(plot.zone);
    const setback = profile.plotSetback ?? CITY.plotSetback;
    const minFootprint = profile.minBuildingFootprint ?? 4;
    const minX = plot.minX + setback;
    const maxX = plot.maxX - setback;
    const minZ = plot.minZ + setback;
    const maxZ = plot.maxZ - setback;
    const plotW = maxX - minX;
    const plotD = maxZ - minZ;
    if (plotW < minFootprint || plotD < minFootprint) continue;

    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    plot.district = plot.zone === 'suburban' || plot.zone === 'rural' ? 'suburban' : 'commercial';

    const radial = Math.max(Math.abs(cx - ccx) / halfX, Math.abs(cz - ccz) / halfZ);
    const r = Math.max(0, Math.min(1, radial + (rand() - 0.5) * 0.2));
    const pool = poolForRadius(r, rand);
    const baseY = getTerrainBaseY(getTerrainY, cx, cz);

    const placed = pickAndPlacePrefab(scene, pool, plotW, plotD, cx, baseY, cz, rand);
    if (placed) {
      aabbs.push(placed.aabb);
      objects.push(placed.object);
    } else if (prefabIndex.length === 0) {
      const fallback = boxFallback(scene, minX, maxX, minZ, maxZ, rand, getTerrainY);
      aabbs.push(fallback.aabb);
      objects.push(fallback.object);
    }
  }

  _current = { meshes: objects, scene };
  return { aabbs, disposeBuildingMeshes };
}

function pickAndPlacePrefab(scene, index, plotW, plotD, cx, baseY, cz, rand) {
  if (!index || index.length === 0) return null;

  const plotMax = Math.max(plotW, plotD);
  const plotMin = Math.min(plotW, plotD);
  const plotAspect = plotMax / plotMin;
  const plotIsSquare = plotAspect < 1.3;
  const candidates = [];

  for (const prefab of index) {
    for (const swap of [false, true]) {
      const fitW = swap ? prefab.d : prefab.w;
      const fitD = swap ? prefab.w : prefab.d;
      const prefabMax = Math.max(fitW, fitD);
      const prefabMin = Math.min(fitW, fitD);
      const prefabAspect = prefabMax / prefabMin;
      const longSideMatch = fitW >= fitD === plotW >= plotD;
      candidates.push({
        prefab,
        rotSteps: swap ? 1 : 0,
        fitW,
        fitD,
        score: Math.abs(prefabAspect - plotAspect) + (longSideMatch ? 0 : 0.6),
      });
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  const cutCount = Math.max(1, Math.floor(candidates.length * 0.25));
  let pool = candidates.slice(0, cutCount);
  if (plotIsSquare && rand() < 0.35) {
    const sky = pool.filter((c) => c.prefab.skyscraper);
    if (sky.length > 0) pool = sky;
  }

  const choice = pool[Math.floor(rand() * pool.length)];
  const scale = clamp(
    Math.min(plotW / choice.fitW, plotD / choice.fitD) * PREFAB_FILL_FACTOR,
    PREFAB_SCALE_MIN,
    PREFAB_SCALE_MAX,
  );
  const inst = cloneAsset('commercial', choice.prefab.name);
  if (!inst) return null;

  inst.scale.setScalar(scale);
  inst.position.set(cx, baseY, cz);
  inst.rotation.y = choice.rotSteps * (Math.PI / 2);
  inst.userData.isBuildingInstanced = true;
  inst.userData.vxmDiagnosticCategory = 'building';
  scene.add(inst);
  return { aabb: aabbOf(inst), object: inst };
}

const FALLBACK_TOP = new THREE.MeshBasicMaterial({ color: BUILDING.roofColor });
const FALLBACK_SIDE = new THREE.MeshBasicMaterial({ color: 0x4a4d55 });

function boxFallback(scene, minX, maxX, minZ, maxZ, rand, getTerrainY) {
  const w = maxX - minX;
  const d = maxZ - minZ;
  const h = CITY.buildingMinHeight + rand() * (CITY.buildingMaxHeight - CITY.buildingMinHeight);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const baseY = getTerrainBaseY(getTerrainY, cx, cz);
  const materials = [
    FALLBACK_SIDE,
    FALLBACK_SIDE,
    FALLBACK_TOP,
    FALLBACK_TOP,
    FALLBACK_SIDE,
    FALLBACK_SIDE,
  ];
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials);
  mesh.position.set(cx, baseY + h / 2, cz);
  mesh.userData.isBuildingInstanced = true;
  mesh.userData.vxmDiagnosticCategory = 'building';
  scene.add(mesh);
  return {
    aabb: { minX, maxX, minZ, maxZ, minY: baseY, maxY: baseY + h },
    object: mesh,
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function getTerrainBaseY(getTerrainY, x, z) {
  return typeof getTerrainY === 'function' ? getTerrainY(x, z) : 0;
}

function pushAabbForInstance(aabbs, cx, cz, w, d, inset = 0, minY = 0, maxY = minY) {
  const halfW = Math.max(0, w / 2 - inset);
  const halfD = Math.max(0, d / 2 - inset);
  aabbs.push({
    minX: cx - halfW,
    maxX: cx + halfW,
    minZ: cz - halfD,
    maxZ: cz + halfD,
    minY,
    maxY,
  });
}

function addInstancedBoundaryMesh(scene, geometry, material, instances, userData = {}) {
  if (instances.length === 0) return null;

  const mesh = new THREE.InstancedMesh(geometry, material, instances.length);
  mesh.userData.isBuildingInstanced = true;
  mesh.userData.isBoundaryBlocker = true;
  mesh.userData.vxmDiagnosticCategory = 'building';
  mesh.userData.vxmMaterialRole = 'boundary';
  mesh.userData.vxmInstanceCount = instances.length;
  Object.assign(mesh.userData, userData);
  mesh.count = instances.length;

  const dummy = new THREE.Object3D();
  for (let i = 0; i < instances.length; i++) {
    const { cx, cy, cz, w, h, d, yaw = 0 } = instances[i];
    dummy.position.set(cx, cy, cz);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(w, h, d);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;

  scene.add(mesh);
  if (!_current) _current = { meshes: [], scene };
  _current.meshes.push(mesh);
  return mesh;
}

function getSolidBoundaryEdges() {
  const oceanEdge = CITY.boundaries?.ocean?.edge ?? 'negativeZ';
  return ['negativeX', 'positiveX', 'positiveZ', 'negativeZ'].filter((edge) => edge !== oceanEdge);
}

function addBoundaryRow({
  edge,
  bounds,
  ridgeCfg,
  buildingCfg,
  getTerrainY,
  zoneMap,
  ridgeInstances,
  buildingInstances,
  roofInstances,
  aabbs,
}) {
  const alongZ = edge === 'negativeX' || edge === 'positiveX';
  const negativeSide = edge === 'negativeX' || edge === 'negativeZ';
  const start = alongZ ? bounds.minZ : bounds.minX;
  const end = alongZ ? bounds.maxZ : bounds.maxX;
  const length = Math.max(1, end - start);

  const ridgeDepth = ridgeCfg.collisionDepth;
  const ridgeCount = Math.max(1, Math.ceil(length / Math.max(1, ridgeCfg.width)));
  const ridgeSlot = length / ridgeCount;
  for (let i = 0; i < ridgeCount; i++) {
    const alongCenter = start + ridgeSlot * (i + 0.5);
    const overlap = Math.min(8, ridgeSlot * 0.12);
    const cx = alongZ
      ? negativeSide
        ? bounds.minX - ridgeDepth / 2
        : bounds.maxX + ridgeDepth / 2
      : alongCenter;
    const cz = alongZ
      ? alongCenter
      : negativeSide
        ? bounds.minZ - ridgeDepth / 2
        : bounds.maxZ + ridgeDepth / 2;
    const w = alongZ ? ridgeDepth : ridgeSlot + overlap;
    const d = alongZ ? ridgeSlot + overlap : ridgeDepth;
    if (rectTouchesReservedZone(cx, cz, w, d, zoneMap)) continue;
    const baseY = getTerrainBaseY(getTerrainY, cx, cz);
    const h = ridgeCfg.height;
    const minY = baseY;
    const maxY = baseY + h;
    ridgeInstances.push({ cx, cy: baseY + h / 2, cz, w, h, d, yaw: Math.PI / 4 });
    pushAabbForInstance(aabbs, cx, cz, w, d, 0, minY, maxY);
  }

  const buildingDepth = buildingCfg.depth;
  const buildingCount = Math.max(1, Math.ceil(length / Math.max(1, buildingCfg.spacing)));
  const buildingSlot = length / buildingCount;
  for (let i = 0; i < buildingCount; i++) {
    const alongCenter = start + buildingSlot * (i + 0.5);
    const alongSize = Math.min(buildingCfg.width, buildingSlot * 0.92);
    const heightScale = 0.88 + (i % 3) * 0.08;
    const h = buildingCfg.height * heightScale;
    const cx = alongZ
      ? negativeSide
        ? bounds.minX - buildingDepth / 2
        : bounds.maxX + buildingDepth / 2
      : alongCenter;
    const cz = alongZ
      ? alongCenter
      : negativeSide
        ? bounds.minZ - buildingDepth / 2
        : bounds.maxZ + buildingDepth / 2;
    const w = alongZ ? buildingDepth : alongSize;
    const d = alongZ ? alongSize : buildingDepth;
    if (rectTouchesReservedZone(cx, cz, w, d, zoneMap)) continue;
    const baseY = getTerrainBaseY(getTerrainY, cx, cz);
    const minY = baseY;
    const maxY = baseY + h;
    buildingInstances.push({ cx, cy: baseY + h / 2, cz, w, h, d });
    roofInstances.push({ cx, cy: baseY + h + 0.125, cz, w: w + 0.05, h: 0.25, d: d + 0.05 });
    pushAabbForInstance(aabbs, cx, cz, w, d, buildingCfg.collisionInset ?? 0, minY, maxY);
  }
}

function rectTouchesReservedZone(cx, cz, w, d, zoneMap) {
  if (!zoneMap) return false;
  const hx = Math.max(0, w / 2);
  const hz = Math.max(0, d / 2);
  const sampleX = [cx - hx, cx, cx + hx];
  const sampleZ = [cz - hz, cz, cz + hz];
  for (const x of sampleX) {
    for (const z of sampleZ) {
      if (isReservedZone(x, z, zoneMap)) return true;
    }
  }
  return false;
}

function isReservedZone(x, z, zoneMap) {
  if (!zoneMap) return false;
  if (typeof zoneMap.getWaterInfo === 'function' && zoneMap.getWaterInfo(x, z)?.isWater)
    return true;
  if (typeof zoneMap.isWater === 'function' && zoneMap.isWater(x, z)) return true;
  if (typeof zoneMap.getZone !== 'function') return false;
  const zone = zoneMap.getZone(x, z);
  return zone === 'water' || zone === 'highway';
}

/**
 * Adds visible perimeter blockers for non-ocean city edges.
 *
 * The ocean edge is deliberately skipped: the water treatment is the boundary,
 * with no upward wall and no standalone ocean-edge collision AABB. Every AABB
 * returned here belongs to a visible mountain-ridge or oversized-building mesh.
 *
 * @param {THREE.Scene} scene
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} bounds
 * @param {((x:number,z:number)=>number)|null} [getTerrainY]
 * @returns {{ aabbs: {minX:number,maxX:number,minZ:number,maxZ:number,minY:number,maxY:number}[] }}

 */
export function placeBoundaryBlockers(scene, bounds, getTerrainY = null, zoneMap = null) {
  const ridgeCfg = CITY.boundaries?.mountainRidges;
  const buildingCfg = CITY.boundaries?.oversizedBuildings;
  if (!ridgeCfg || !buildingCfg) return { aabbs: [] };

  const ridgeInstances = [];
  const buildingInstances = [];
  const roofInstances = [];
  const aabbs = [];

  for (const edge of getSolidBoundaryEdges()) {
    addBoundaryRow({
      edge,
      bounds,
      ridgeCfg,
      buildingCfg,
      getTerrainY,
      zoneMap,
      ridgeInstances,
      buildingInstances,
      roofInstances,
      aabbs,
    });
  }

  addInstancedBoundaryMesh(
    scene,
    _ridgeGeo,
    createRoofMaterial({ color: MOUNTAIN_RIDGE_COLOR, name: 'building-boundary-mountain-ridges' }),
    ridgeInstances,
    { boundaryType: 'mountainRidges', vxmMaterialRole: 'boundary-ridge' },
  );
  addInstancedBoundaryMesh(
    scene,
    _unitGeo,
    createFacadeMaterial({
      textureIndex: BOUNDARY_BUILDING_TEXTURE_INDEX,
      name: 'building-boundary-oversized-sides',
    }),
    buildingInstances,
    { boundaryType: 'oversizedBuildings', vxmMaterialRole: 'boundary-side' },
  );
  addInstancedBoundaryMesh(
    scene,
    _unitGeo,
    createRoofMaterial({ color: BOUNDARY_ROOF_COLOR, name: 'building-boundary-oversized-roofs' }),
    roofInstances,
    { boundaryType: 'oversizedBuildingRoofs', vxmMaterialRole: 'boundary-roof' },
  );

  return { aabbs };
}

/**
 * Remove all instanced building meshes from the scene and free GPU memory.
 * Safe to call even if no buildings have been placed.
 */
export function disposeBuildingMeshes() {
  if (!_current) return;
  const { meshes, scene } = _current;
  for (const m of meshes) {
    scene.remove(m);
    m.traverse?.((child) => {
      if (!child.isMesh || child.userData?.sharedAsset) return;
      if (child.geometry && child.geometry !== _unitGeo && child.geometry !== _ridgeGeo) {
        child.geometry.dispose();
      }
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((mat) => mat.dispose());
        else child.material.dispose();
      }
    });
  }
  _current = null;
}
