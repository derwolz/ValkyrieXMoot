// GLB prefab kit loader for the city. Loads Kenney-style kits (suburban,
// commercial, industrial, cars) once, shares a single colormap texture per
// kit, and hands out cheap clones at placement time.
//
// Usage:
//   await loadKits(({ kit, loaded, total }) => updateUi(...));
//   const inst = cloneAsset('suburban', 'building-type-a');  // or null if absent
//
// All meshes in cached scenes are pre-flagged castShadow/receiveShadow.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

THREE.Cache.enabled = true;

const KIT_BASE = './data/city-kits';

// Curated lists — one per kit. Names match GLB filenames (without .glb).
export const KITS = {
  suburban: {
    buildings: [
      'building-type-a',
      'building-type-b',
      'building-type-c',
      'building-type-d',
      'building-type-e',
      'building-type-f',
      'building-type-g',
      'building-type-h',
      'building-type-i',
      'building-type-j',
      'building-type-k',
      'building-type-l',
      'building-type-m',
      'building-type-n',
    ],
    props: ['tree-large', 'tree-small', 'fence-1x3', 'fence-2x2', 'planter'],
  },
  commercial: {
    buildings: [
      'building-a',
      'building-b',
      'building-c',
      'building-d',
      'building-e',
      'building-f',
      'building-g',
      'building-h',
      'building-i',
      'building-j',
      'building-k',
      'building-l',
      'building-m',
      'building-n',
    ],
    skyscrapers: [
      'building-skyscraper-a',
      'building-skyscraper-b',
      'building-skyscraper-c',
      'building-skyscraper-d',
      'building-skyscraper-e',
    ],
  },
  industrial: {
    buildings: [
      'building-a',
      'building-b',
      'building-c',
      'building-d',
      'building-e',
      'building-f',
      'building-g',
      'building-h',
      'building-i',
      'building-j',
      'building-k',
      'building-l',
      'building-m',
      'building-n',
      'building-o',
      'building-p',
      'building-q',
      'building-r',
      'building-s',
      'building-t',
    ],
    props: ['chimney-large', 'chimney-medium', 'chimney-small', 'detail-tank'],
  },
  cars: {
    suburban: ['sedan', 'suv', 'hatchback-sports', 'suv-luxury'],
    commercial: ['sedan-sports', 'hatchback-sports', 'suv-luxury', 'sedan', 'taxi'],
    industrial: [
      'truck',
      'truck-flat',
      'van',
      'delivery',
      'delivery-flat',
      'garbage-truck',
      'tractor',
    ],
    special: ['police', 'ambulance', 'firetruck'],
  },
};

const loader = new GLTFLoader();
const sceneCache = new Map(); // path -> THREE.Group (gltf.scene)
const sharedTextures = new Map(); // url  -> THREE.Texture

async function getSharedTexture(url) {
  if (sharedTextures.has(url)) return sharedTextures.get(url);
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  sharedTextures.set(url, tex);
  return tex;
}

// Replace every material on the loaded scene with an unlit MeshBasicMaterial
// that samples the shared colormap. Two reasons:
//   1) The Kenney colormap is a baked palette — the buildings have UVs that
//      sample colored regions, so MeshBasic gets the right look without
//      depending on the scene's lighting being tuned to match.
//   2) Authored MeshStandardMaterial mixes metalness/vertex colors that
//      came back black in valkyrie's renderer setup; flat-shading is the
//      consistent fallback that matches existing road/ground meshes.
//
// Issues #2 / #3 introduce 3D vehicle models, but those are loaded by their
// own pipeline — not through this kit loader — so they remain free to use
// MeshStandardMaterial + the scene lights kept in main.js.
function rebindToSharedTexture(scene, sharedTex) {
  const replacement = new THREE.MeshBasicMaterial({ map: sharedTex });
  scene.traverse((n) => {
    if (n.isMesh) {
      n.castShadow = false;
      n.receiveShadow = false;
      n.material = Array.isArray(n.material) ? n.material.map(() => replacement) : replacement;
    }
  });
}

async function loadGlb(path, sharedTex) {
  if (sceneCache.has(path)) return sceneCache.get(path);
  const gltf = await loader.loadAsync(path);
  if (sharedTex) rebindToSharedTexture(gltf.scene, sharedTex);
  sceneCache.set(path, gltf.scene);
  return gltf.scene;
}

function flatten(kit) {
  const set = new Set();
  for (const arr of Object.values(kit)) for (const n of arr) set.add(n);
  return [...set];
}

/**
 * Preload every named GLB across all kits, sharing one colormap texture per kit.
 * @param {(progress: {kit:string, loaded:number, total:number}) => void} [onProgress]
 */
export async function loadKits(onProgress) {
  const kitNames = Object.keys(KITS);
  for (const kitName of kitNames) {
    const baseUrl = `${KIT_BASE}/${kitName}/`;
    const sharedTex = await getSharedTexture(`${baseUrl}Textures/colormap.png`);
    const names = flatten(KITS[kitName]);

    let loaded = 0;
    await Promise.all(
      names.map(async (n) => {
        try {
          await loadGlb(`${baseUrl}${n}.glb`, sharedTex);
        } catch (err) {
          console.warn(`[prefabs] failed to load ${kitName}/${n}.glb`, err);
        }
        loaded++;
        onProgress?.({ kit: kitName, loaded, total: names.length });
      }),
    );
  }
}

/** Returns the cached gltf.scene for a kit asset, or null if missing. */
export function getAsset(kitName, name) {
  return sceneCache.get(`${KIT_BASE}/${kitName}/${name}.glb`) ?? null;
}

/** Deep-clone a kit asset. Materials are shared across clones (cheap).
 *
 * Every Mesh descendant is tagged userData.sharedAsset = true so the
 * scene-clearing pass in main.js doesn't dispose geometry/materials that
 * still belong to the module-level cache.
 */
export function cloneAsset(kitName, name) {
  const src = getAsset(kitName, name);
  if (!src) return null;
  const clone = src.clone(true);
  clone.traverse((n) => {
    if (n.isMesh) n.userData.sharedAsset = true;
  });
  return clone;
}

/** Compute world-space AABB of an Object3D after its transform is set. */
const _box = new THREE.Box3();
export function aabbOf(object3d) {
  object3d.updateMatrixWorld(true);
  _box.setFromObject(object3d);
  return {
    minX: _box.min.x,
    maxX: _box.max.x,
    minZ: _box.min.z,
    maxZ: _box.max.z,
    minY: _box.min.y,
    maxY: _box.max.y,
  };
}

/**
 * Cached natural footprint of a kit asset at scale 1, in local axes
 * (so width = X extent, depth = Z extent, height = Y extent of the
 * untransformed source mesh). Returns null if the asset isn't loaded.
 */
const footprintCache = new Map();
export function naturalFootprint(kitName, name) {
  const key = `${kitName}/${name}`;
  if (footprintCache.has(key)) return footprintCache.get(key);
  const src = getAsset(kitName, name);
  if (!src) return null;
  src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src);
  const fp = {
    width: Math.max(1e-3, box.max.x - box.min.x),
    depth: Math.max(1e-3, box.max.z - box.min.z),
    height: Math.max(1e-3, box.max.y - box.min.y),
  };
  footprintCache.set(key, fp);
  return fp;
}
