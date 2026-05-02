/**
 * lib/world/park/parkGenerator.js
 *
 * buildParkAssets({ scene, zoneMap, getTerrainY, seed? })
 *   → { treeAABBs, dispose }
 *
 * Scans the zone map for PARK cells and places:
 *   - Trees: CylinderGeometry trunk + SphereGeometry canopy, both InstancedMesh.
 *   - Benches: BoxGeometry, InstancedMesh.
 *   - Paths: a series of flat PlaneGeometry strips along park zone rows.
 *
 * All trees/benches use InstancedMesh — zero individual scene.add calls per
 * tree or bench.  Paths are thin flat planes grouped into one mesh per row.
 *
 * treeAABBs is kept for API compatibility but is intentionally empty: park
 * trees/benches are decorative and should not stop the vehicle with tiny
 * collision footprints that are hard to read while driving.
 *
 * dispose() removes all meshes and frees GPU memory.
 */

import * as THREE from 'three';
import { CITY, PARK } from '../../config.js';
import { PARK as PARK_ZONE } from '../zones/zoneTypes.js';

// ── geometry shared per-type (allocated once) ─────────────────────────────────
const _trunkGeo  = new THREE.CylinderGeometry(PARK.trunkRadius, PARK.trunkRadius * 1.1, PARK.trunkHeight, 6);
const _canopyGeo = new THREE.SphereGeometry(PARK.canopyRadius, 7, 6);
const _benchGeo  = new THREE.BoxGeometry(2.0, 0.45, 0.6);

// ── simple seeded PRNG ────────────────────────────────────────────────────────
function makeRand(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) & 0x7fffffff) / 0x7fffffff; };
}

/**
 * @param {{
 *   scene:       THREE.Scene,
 *   zoneMap:     { getZone:(x:number,z:number)=>string, width:number, length:number },
 *   getTerrainY: (x:number,z:number)=>number,
 *   seed?:       number,
 * }} opts
 * @returns {{ treeAABBs: object[], dispose: ()=>void }}
 */
export function buildParkAssets({ scene, zoneMap, getTerrainY, seed = CITY.seed }) {
  const rand = makeRand(seed ^ 0xba5eba11);

  const halfW = zoneMap.width  / 2;
  const halfL = zoneMap.length / 2;

  // Scan interval — we sample on a grid with PARK.treeSpacing to find park cells.
  const spacing  = PARK.treeSpacing;
  const jFrac    = PARK.treeSpacingJitter;

  // ── Collect tree and bench positions ─────────────────────────────────────
  /** @type {{ x:number, y:number, z:number }[]} */
  const treePositions  = [];
  /** @type {{ x:number, y:number, z:number }[]} */
  const benchPositions = [];

  function terrainYAt(x, z) {
    const y = typeof getTerrainY === 'function'
      ? getTerrainY(x, z)
      : (typeof zoneMap.getHeight === 'function' ? zoneMap.getHeight(x, z) : 0);
    return Number.isFinite(y) ? y : 0;
  }

  function isParkAt(x, z) {
    return zoneMap.getZone(x, z) === PARK_ZONE;
  }

  function parkConfinedPoint(preferredX, preferredZ, fallbackX, fallbackZ) {
    if (isParkAt(preferredX, preferredZ)) return { x: preferredX, z: preferredZ };
    if (isParkAt(fallbackX, fallbackZ)) return { x: fallbackX, z: fallbackZ };
    return null;
  }

  // Sample park zones on a regular grid with jitter. The final jittered asset
  // position is re-checked so trees/benches cannot spill into adjacent visible
  // non-park ground tiles near Perlin district edges.
  // Only consider every N-th row for benches (approximate bench spacing).
  let benchRowCounter = 0;

  for (let wz = -halfL + spacing / 2; wz < halfL; wz += spacing) {
    benchRowCounter++;
    for (let wx = -halfW + spacing / 2; wx < halfW; wx += spacing) {
      if (!isParkAt(wx, wz)) continue;

      // Jitter position, falling back to the sampled park cell centre if the
      // jitter crosses a zone boundary.
      const jx = wx + (rand() - 0.5) * spacing * jFrac;
      const jz = wz + (rand() - 0.5) * spacing * jFrac;
      const treePoint = parkConfinedPoint(jx, jz, wx, wz);
      if (!treePoint) continue;

      const baseY = terrainYAt(treePoint.x, treePoint.z);
      treePositions.push({ x: treePoint.x, y: baseY, z: treePoint.z });

      // Place a bench roughly every benchSpacing metres along the path, but
      // keep the bench's own offset position inside a park zone and sample its
      // terrain height independently from the nearby tree.
      if (benchRowCounter % Math.max(1, Math.round(PARK.benchSpacing / spacing)) === 0) {
        const bx = treePoint.x + rand() * 4 - 2;
        const bz = treePoint.z + 2.5;
        if (isParkAt(bx, bz)) {
          benchPositions.push({ x: bx, y: terrainYAt(bx, bz), z: bz });
        }
      }
    }
  }

  const meshes = [];

  // ── Tree InstancedMesh (trunk + canopy) ───────────────────────────────────
  const trunkMat = new THREE.MeshLambertMaterial({
    color: PARK.trunkColor,
  });
  trunkMat.name = 'park-trunk';
  const canopyMat = new THREE.MeshLambertMaterial({
    color: PARK.canopyColor,
  });
  canopyMat.name = 'park-canopy';

  const trunkCount  = treePositions.length;
  const canopyCount = treePositions.length;

  if (trunkCount > 0) {
    const trunkMesh  = new THREE.InstancedMesh(_trunkGeo,  trunkMat,  trunkCount);
    const canopyMesh = new THREE.InstancedMesh(_canopyGeo, canopyMat, canopyCount);
    trunkMesh.userData.isParksAsset  = true;
    canopyMesh.userData.isParksAsset = true;
    trunkMesh.userData.vxmDiagnosticCategory = 'park';
    canopyMesh.userData.vxmDiagnosticCategory = 'park';
    trunkMesh.userData.vxmMaterialRole = 'trunk';
    canopyMesh.userData.vxmMaterialRole = 'canopy';
    trunkMesh.userData.vxmInstanceCount = trunkCount;
    canopyMesh.userData.vxmInstanceCount = canopyCount;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < treePositions.length; i++) {
      const { x, y, z } = treePositions[i];

      // Trunk — base sits at terrain Y, centred at y + trunkHeight/2.
      dummy.position.set(x, y + PARK.trunkHeight / 2, z);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      trunkMesh.setMatrixAt(i, dummy.matrix);

      // Canopy — float above trunk top.
      dummy.position.set(x, y + PARK.trunkHeight + PARK.canopyRadius * 0.6, z);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      canopyMesh.setMatrixAt(i, dummy.matrix);
    }

    trunkMesh.instanceMatrix.needsUpdate  = true;
    canopyMesh.instanceMatrix.needsUpdate = true;

    scene.add(trunkMesh);
    scene.add(canopyMesh);
    meshes.push(trunkMesh, canopyMesh);
  }

  // ── Bench InstancedMesh ───────────────────────────────────────────────────
  if (benchPositions.length > 0) {
    const benchMat = new THREE.MeshLambertMaterial({
      color: PARK.benchColor,
    });
    benchMat.name = 'park-bench';
    const benchMesh = new THREE.InstancedMesh(_benchGeo, benchMat, benchPositions.length);
    benchMesh.userData.isParksAsset = true;
    benchMesh.userData.vxmDiagnosticCategory = 'park';
    benchMesh.userData.vxmMaterialRole = 'bench';
    benchMesh.userData.vxmInstanceCount = benchPositions.length;

    const dummy2 = new THREE.Object3D();
    for (let i = 0; i < benchPositions.length; i++) {
      const { x, y, z } = benchPositions[i];
      dummy2.position.set(x, y + 0.225, z);
      dummy2.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy2.scale.set(1, 1, 1);
      dummy2.updateMatrix();
      benchMesh.setMatrixAt(i, dummy2.matrix);
    }
    benchMesh.instanceMatrix.needsUpdate = true;
    scene.add(benchMesh);
    meshes.push(benchMesh);
  }

  // ── Path strips ───────────────────────────────────────────────────────────
  // Draw a path along every 4th row of park zone cells as a lighter strip.
  // We scan each row (at path row intervals) and build a flat PlaneGeometry
  // spanning the consecutive park cells.
  const pathMat = new THREE.MeshLambertMaterial({
    color: PARK.pathColor,
    transparent: PARK.pathOpacity < 1,
    opacity: PARK.pathOpacity,
  });
  pathMat.name = 'park-path';
  let rowIdx = 0;
  for (let wz = -halfL + spacing / 2; wz < halfL; wz += spacing) {
    rowIdx++;
    if (rowIdx % 4 !== 0) continue;

    // Find contiguous runs of park cells in this row.
    let runStart = null;
    let runEnd   = null;

    for (let wx = -halfW + spacing / 2; wx <= halfW + spacing / 2; wx += spacing / 2) {
      const inPark = isParkAt(wx, wz);
      if (inPark && runStart === null) {
        runStart = wx;
        runEnd   = wx;
      } else if (inPark && runStart !== null) {
        runEnd = wx;
      } else if (!inPark && runStart !== null) {
        // End of run — emit a path strip.
        emitPath(runStart, runEnd, wz);
        runStart = null; runEnd = null;
      }
    }
    if (runStart !== null) emitPath(runStart, runEnd, wz);
  }

  function pathSegmentFitsPark(cx, cz, len) {
    const halfLen = len / 2;
    const halfPathW = PARK.pathWidth / 2;
    const samples = [
      [cx, cz],
      [cx - halfLen, cz],
      [cx + halfLen, cz],
      [cx, cz - halfPathW],
      [cx, cz + halfPathW],
    ];
    return samples.every(([sx, sz]) => isParkAt(sx, sz));
  }

  function emitPath(fromX, toX, wz) {
    const totalLen = toX - fromX;
    if (totalLen < spacing / 2) return;

    const segmentLenMax = Math.max(PARK.pathWidth, PARK.pathSegmentLength || CITY.infrastructureSegmentLength || totalLen);
    for (let startX = fromX; startX < toX; startX += segmentLenMax) {
      const endX = Math.min(toX, startX + segmentLenMax);
      const len = endX - startX;
      if (len < spacing / 2) continue;

      const midX = (startX + endX) / 2;
      if (!pathSegmentFitsPark(midX, wz, len)) continue;

      const baseY = terrainYAt(midX, wz) + PARK.pathYOffset;
      const geo   = new THREE.PlaneGeometry(len, PARK.pathWidth);
      const mesh  = new THREE.Mesh(geo, pathMat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(midX, baseY, wz);
      mesh.userData.isParksAsset = true;
      mesh.userData.vxmDiagnosticCategory = 'park';
      mesh.userData.vxmMaterialRole = 'path';
      scene.add(mesh);
      meshes.push(mesh);
    }
  }

  // ── Decorative park assets do not block the vehicle ───────────────────────
  // Keep the returned property for callers, but do not silently add tiny trunk
  // collision boxes that read as invisible/small blockers during driving.
  const treeAABBs = [];

  // ── dispose ───────────────────────────────────────────────────────────────
  function dispose() {
    for (const m of meshes) {
      scene.remove(m);
      if (m.geometry && m.geometry !== _trunkGeo && m.geometry !== _canopyGeo && m.geometry !== _benchGeo) {
        m.geometry.dispose();
      }
      if (m.material) {
        if (Array.isArray(m.material)) m.material.forEach(mat => mat.dispose());
        else m.material.dispose();
      }
    }
    meshes.length = 0;
  }

  return { treeAABBs, dispose };
}
