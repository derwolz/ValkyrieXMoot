/**
 * lib/world/terrain/ocean.js
 *
 * buildOcean({ scene, zoneMap? })
 *   → { mesh, dispose }
 *
 * Creates a flat, non-colliding ocean surface slightly below sea level. When the
 * zone map exposes shoreline samples, the mesh is cut to the deterministic
 * irregular shoreline/bay mask instead of using a straight rectangular edge.
 *
 * Boundary model: this mesh is only visible water. It must not add a raised or
 * vertical ocean wall, hidden ocean-edge AABB, or any map clamp/collider.
 */

import * as THREE from 'three';
import { CITY, OCEAN } from '../../config.js';

function isFinitePoint2(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.z);
}

function getSortedShorelineSamples(zoneMap) {
  const samples = zoneMap?.getShorelineSamples?.();
  if (!Array.isArray(samples) || samples.length < 2) return [];
  return samples
    .filter(isFinitePoint2)
    .sort((a, b) => a.x - b.x);
}

function buildLegacyOceanGeometry(worldW, worldL, reach) {
  const planeW = worldW + reach * 2;
  const planeD = worldL / 2 + reach;
  const geo = new THREE.PlaneGeometry(planeW, planeD);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -(planeD / 2));
  return geo;
}

function buildShorelineOceanGeometry({ zoneMap, worldW, worldL, reach }) {
  const shoreline = getSortedShorelineSamples(zoneMap);
  if (shoreline.length < 2) return null;

  const halfW = worldW / 2;
  const halfL = worldL / 2;
  const minX = -halfW;
  const maxX = halfW;
  const oceanMinZ = -halfL - reach;

  // Keep enough samples to preserve the bay shape without overfeeding the
  // triangulator on high-resolution zone maps.
  const maxSamples = 256;
  const stride = Math.max(1, Math.ceil(shoreline.length / maxSamples));
  const sampled = [];
  for (let i = 0; i < shoreline.length; i += stride) sampled.push(shoreline[i]);
  const last = shoreline[shoreline.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  if (sampled.length < 2) return null;

  const firstShore = sampled[0];
  const lastShore = sampled[sampled.length - 1];
  const shape = new THREE.Shape();

  // Shape coordinates are authored as (world X, world Z), then rotated into XZ.
  // The polygon covers all seaward space (negative Z) plus a small lateral
  // overreach, and follows the shoreline curve on the inland edge.
  shape.moveTo(minX - reach, oceanMinZ);
  shape.lineTo(maxX + reach, oceanMinZ);
  shape.lineTo(maxX + reach, lastShore.z);
  shape.lineTo(lastShore.x, lastShore.z);
  for (let i = sampled.length - 2; i >= 0; i--) {
    shape.lineTo(sampled[i].x, sampled[i].z);
  }
  shape.lineTo(minX - reach, firstShore.z);
  shape.lineTo(minX - reach, oceanMinZ);

  const geo = new THREE.ShapeGeometry(shape);
  // ShapeGeometry is authored in XY with Y carrying world Z; rotate +90° so
  // negative shoreline/ocean Z stays on the seaward (-Z) side instead of
  // mirroring inland.
  geo.rotateX(Math.PI / 2);
  return geo;
}

/**
 * @param {{ scene: THREE.Scene, zoneMap?: { getShorelineSamples?:()=>Array<{x:number,z:number}> } | null }} opts
 * @returns {{ mesh: THREE.Mesh, dispose: () => void }}
 */
export function buildOcean({ scene, zoneMap = null }) {
  const worldW = zoneMap?.width ?? CITY.width;
  const worldL = zoneMap?.length ?? CITY.length;
  const reach = OCEAN.overreach;

  const geo = buildShorelineOceanGeometry({ zoneMap, worldW, worldL, reach })
    ?? buildLegacyOceanGeometry(worldW, worldL, reach);

  const mat = new THREE.MeshBasicMaterial({
    color: OCEAN.color,
    transparent: true,
    opacity: OCEAN.opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.isOcean = true;
  mesh.renderOrder = -1;
  mesh.position.set(0, OCEAN.y, 0);

  scene.add(mesh);

  function dispose() {
    scene.remove(mesh);
    geo.dispose();
    mat.dispose();
  }

  return { mesh, dispose };
}
