import * as THREE from 'three';
import { CITY } from '../../config.js';
import { KITS, getAsset, cloneAsset, aabbOf } from './prefabs.js';

const TREE_SCALE        = 12;
const PROP_SCALE        = 12;
const PARKED_CAR_SCALE  = 2.0;

const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];

/**
 * Walk every plot, drop trees on suburban/commercial plots and chimneys/tanks
 * on industrial plots. Trees are gathered then drawn via InstancedMesh from
 * the suburban tree templates so we don't pay one draw call per tree.
 *
 * Returns nothing — props are decorative and not added to the AABB list.
 *
 * Plots must already have their `district` field set by placeBuildings.
 */
export function placeProps(scene, plots, rand) {
  const trees = []; // { x, z, large }

  for (const plot of plots) {
    const district = plot.district;
    if (!district) continue;
    const cx = (plot.minX + plot.maxX) / 2;
    const cz = (plot.minZ + plot.maxZ) / 2;
    const w  = plot.maxX - plot.minX;
    const d  = plot.maxZ - plot.minZ;
    const margin = 1.5;

    if (district === 'suburban') {
      // Dense trees scattered around the building footprint.
      const n = 2 + Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) {
        trees.push({
          x: cx + (rand() - 0.5) * Math.max(0, w - margin * 2),
          z: cz + (rand() - 0.5) * Math.max(0, d - margin * 2),
          large: rand() > 0.5,
        });
      }
    } else if (district === 'commercial') {
      // Sparse small tree, perimeter only.
      if (rand() < 0.5) {
        const a = rand() * Math.PI * 2;
        const r = Math.min(w, d) * 0.45;
        trees.push({
          x: cx + Math.cos(a) * r,
          z: cz + Math.sin(a) * r,
          large: false,
        });
      }
    } else if (district === 'industrial') {
      // Chimneys and tanks scatter on the plot.
      if (rand() < 0.45) {
        const cm = cloneAsset('industrial', pick(['chimney-medium','chimney-large','chimney-small'], rand));
        if (cm) {
          cm.scale.setScalar(PROP_SCALE);
          cm.position.set(
            cx + (rand() - 0.5) * Math.max(0, w * 0.5),
            0,
            cz + (rand() - 0.5) * Math.max(0, d * 0.5),
          );
          scene.add(cm);
        }
      }
      if (rand() < 0.2) {
        const tank = cloneAsset('industrial', 'detail-tank');
        if (tank) {
          tank.scale.setScalar(PROP_SCALE * 0.7);
          tank.position.set(
            cx + (rand() - 0.5) * Math.max(0, w * 0.4),
            0,
            cz + (rand() - 0.5) * Math.max(0, d * 0.4),
          );
          scene.add(tank);
        }
      }
    }
  }

  buildTreesInstanced(scene, trees, rand);
}

/**
 * Place parked car prefabs on the curb of every plot, picking models from
 * the district's pool. Parked cars become solid obstacles by appending to
 * the AABB list returned to the caller.
 *
 * @returns {{minX:number,maxX:number,minZ:number,maxZ:number}[]} new AABBs
 */
export function placeParkedCars(scene, plots, rand) {
  const newAABBs = [];
  for (const plot of plots) {
    const district = plot.district;
    if (!district) continue;
    const w  = plot.maxX - plot.minX;
    const d  = plot.maxZ - plot.minZ;
    if (w < 8 || d < 8) continue;

    const carCount = rand() < 0.55 ? 1 : 0;
    for (let i = 0; i < carCount; i++) {
      const pool = pickCarPool(district, rand);
      const name = pick(pool, rand);
      const inst = cloneAsset('cars', name);
      if (!inst) continue;
      inst.scale.setScalar(PARKED_CAR_SCALE);

      const side = Math.floor(rand() * 4);
      const inset = 1.6;
      const along = (rand() - 0.5);
      let px, pz, heading;
      switch (side) {
        case 0:
          px = plot.minX + w / 2 + along * (w * 0.6);
          pz = plot.minZ + inset;
          heading = 0;
          break;
        case 1:
          px = plot.maxX - inset;
          pz = plot.minZ + d / 2 + along * (d * 0.6);
          heading = Math.PI / 2;
          break;
        case 2:
          px = plot.minX + w / 2 + along * (w * 0.6);
          pz = plot.maxZ - inset;
          heading = Math.PI;
          break;
        default:
          px = plot.minX + inset;
          pz = plot.minZ + d / 2 + along * (d * 0.6);
          heading = -Math.PI / 2;
          break;
      }
      if (rand() < 0.5) heading += Math.PI;

      inst.position.set(px, 0, pz);
      inst.rotation.y = heading;
      scene.add(inst);
      newAABBs.push(aabbOf(inst));
    }
  }
  return newAABBs;
}

function pickCarPool(district, rand) {
  // 4% chance of a special vehicle (police/ambulance/firetruck) regardless.
  if (rand() < 0.04) return KITS.cars.special;
  return KITS.cars[district] ?? KITS.cars.suburban;
}

// ---- Instanced trees ----
// Port of the crazy-cabbie tree pattern: traverse the source mesh once,
// build one InstancedMesh per (geometry, material) pair, then place every
// tree by composing a per-instance matrix with the source's local matrix.
function buildTreesInstanced(scene, list, rand) {
  if (list.length === 0) return;

  const groups = { large: [], small: [] };
  for (const t of list) groups[t.large ? 'large' : 'small'].push(t);

  for (const [size, items] of Object.entries(groups)) {
    if (items.length === 0) continue;
    const src = getAsset('suburban', `tree-${size}`);
    if (!src) continue;

    src.updateMatrixWorld(true);
    const meshDefs = [];
    src.traverse((n) => {
      if (n.isMesh) {
        meshDefs.push({
          geom: n.geometry,
          mat: n.material,
          localMat: n.matrixWorld.clone(),
        });
      }
    });

    for (const { geom, mat, localMat } of meshDefs) {
      const inst = new THREE.InstancedMesh(geom, mat, items.length);
      const out = new THREE.Matrix4();
      const placement = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3(TREE_SCALE, TREE_SCALE, TREE_SCALE);
      const p = new THREE.Vector3();
      const axisY = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < items.length; i++) {
        q.setFromAxisAngle(axisY, rand() * Math.PI * 2);
        p.set(items[i].x, 0, items[i].z);
        placement.compose(p, q, s);
        out.multiplyMatrices(placement, localMat);
        inst.setMatrixAt(i, out);
      }
      inst.castShadow = true;
      inst.receiveShadow = false;
      inst.frustumCulled = false;
      inst.instanceMatrix.needsUpdate = true;
      // Shared geometry/material with the GLB cache — must survive _clearCityMeshes.
      inst.userData.sharedAsset = true;
      scene.add(inst);
    }
  }
}
