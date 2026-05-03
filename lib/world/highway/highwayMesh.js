/**
 * lib/world/highway/highwayMesh.js
 *
 * buildHighwayMesh({ scene, splinePoints, ramps, rampIndices, getTerrainY, zoneMap })
 *   → { meshes: THREE.Mesh[], rampAABBs: AABB[], sampleSurface: (x,z,referenceY?)=>HighwaySurfaceSample|null, dispose: ()=>void }
 *
 * Generates visible elevated expressway geometry and matching drivable surface
 * samples from the same centreline data returned by buildHighwaySpline().  The
 * main deck is an open through-city ribbon; each ramp is its own open ribbon
 * descending from deck height to street level.
 */

import * as THREE from 'three';
import { HIGHWAY } from '../../config.js';

/**
 * @typedef {{ minX:number, maxX:number, minZ:number, maxZ:number, minY:number, maxY:number }} AABB
 * @typedef {{ height:number, y:number, normal:THREE.Vector3, isHighwaySurface:boolean, kind?:string }} HighwaySurfaceSample
 */

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function readHighwayConfigNumber(name, fallback) {
  const value = HIGHWAY[name];
  return Number.isFinite(value) ? value : fallback;
}

function pointElevatedY(point, getTerrainY, fallbackRelativeY) {
  const relativeY = Number.isFinite(point?.y) ? point.y : fallbackRelativeY;
  return getTerrainY(point.x, point.z) + relativeY;
}

/**
 * @param {THREE.Vector3} tangent
 * @param {THREE.Vector3} right
 * @returns {THREE.Vector3}
 */
function makeRoadNormal(tangent, right) {
  const normal = new THREE.Vector3().crossVectors(tangent, right);
  if (normal.lengthSq() < 0.0001) return new THREE.Vector3(0, 1, 0);
  normal.normalize();
  if (normal.y < 0) normal.multiplyScalar(-1);
  if (normal.y <= 0.05) return new THREE.Vector3(0, 1, 0);
  return normal;
}

/**
 * @param {{ x:number, z:number }} a
 * @param {{ x:number, z:number }} b
 * @returns {{ x:number, z:number }}
 */
function normalizedCenterlineRight(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  return { x: dz / len, z: -dx / len };
}

function makeSampleRight(points, index) {
  const n = points.length;
  if (n < 2) return { x: 1, z: 0 };
  const prev = points[Math.max(0, index - 1)];
  const next = points[Math.min(n - 1, index + 1)];
  return normalizedCenterlineRight(prev, next);
}

function expandAABB(bounds, x, y, z) {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxY = Math.max(bounds.maxY, y);
  bounds.minZ = Math.min(bounds.minZ, z);
  bounds.maxZ = Math.max(bounds.maxZ, z);
}

function finishAABB(bounds) {
  if (!Number.isFinite(bounds.minX)) return null;
  return {
    minX: bounds.minX,
    maxX: bounds.maxX,
    minY: bounds.minY,
    maxY: bounds.maxY,
    minZ: bounds.minZ,
    maxZ: bounds.maxZ,
  };
}

/**
 * Build a highway ribbon mesh and matching drivable support samples.
 *
 * @param {{
 *   scene:        THREE.Scene,
 *   splinePoints: { x: number, z: number, y?: number }[],
 *   rampIndices?: number[],
 *   ramps?:       { points?: { x:number, z:number, y?:number }[], kind?:string }[],
 *   reservationPolylines?: { points?: { x:number, z:number, y?:number }[], halfWidth?:number, kind?:string }[],
 *   getTerrainY:  (x:number,z:number) => number,
 *   zoneMap?:     { markHighway?: (pts:{x:number,z:number}[], opts?:{halfWidth?:number})=>void, markHighwayReservations?: (reservations:{ points?:{x:number,z:number}[], halfWidth?:number, kind?:string }[])=>void },
 * }} opts
 * @returns {{
 *   meshes:    THREE.Mesh[],
 *   rampAABBs: AABB[],
 *   sampleSurface: (x:number,z:number,referenceY?:number) => HighwaySurfaceSample|null,
 *   dispose:   () => void,
 * }}
 */
export function buildHighwayMesh({
  scene,
  splinePoints,
  _rampIndices = [],
  ramps = [],
  reservationPolylines = [],
  getTerrainY,
  zoneMap,
}) {
  const deckPoints = Array.isArray(splinePoints) ? splinePoints : [];
  const deckHalfWidth = readHighwayConfigNumber(
    'expresswayHalfWidth',
    readHighwayConfigNumber('roadHalfWidth', 18),
  );
  const rampHalfWidth =
    readHighwayConfigNumber('rampHalfWidth', 7) +
    Math.max(0, readHighwayConfigNumber('rampShoulderWidth', 0));
  const deckHeight = readHighwayConfigNumber(
    'deckHeight',
    readHighwayConfigNumber('overpassHeight', 18),
  );
  const bh = readHighwayConfigNumber('barrierHeight', 1.2);

  const roadMat = new THREE.MeshLambertMaterial({
    color: HIGHWAY.asphaltColor,
    side: THREE.DoubleSide,
  });
  roadMat.name = 'highway-road';
  const barrierMat = new THREE.MeshLambertMaterial({
    color: HIGHWAY.barrierColor,
    side: THREE.DoubleSide,
  });
  barrierMat.name = 'highway-barrier';

  const roadVerts = [];
  const roadIndices = [];
  const barrierVerts = [];
  const barrierIndices = [];
  const surfaceSegments = [];
  /** @type {AABB[]} */
  const rampAABBs = [];
  let roadVertexIndex = 0;
  let barrierVertexIndex = 0;

  function appendRibbon(points, halfWidth, fallbackRelativeY, kind, collectRampAABB) {
    if (!Array.isArray(points) || points.length < 2) return;

    const n = points.length;
    const rights = new Array(n);
    const yValues = new Float32Array(n);
    const bounds = {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    };

    for (let i = 0; i < n; i++) {
      rights[i] = makeSampleRight(points, i);
      yValues[i] = pointElevatedY(points[i], getTerrainY, fallbackRelativeY);
    }

    for (let i = 0; i < n - 1; i++) {
      const j = i + 1;
      const pi = points[i];
      const pj = points[j];
      const ri = rights[i];
      const rj = rights[j];
      const yi = yValues[i];
      const yj = yValues[j];

      const lxi = pi.x + ri.x * halfWidth;
      const lzi = pi.z + ri.z * halfWidth;
      const rxi = pi.x - ri.x * halfWidth;
      const rzi = pi.z - ri.z * halfWidth;
      const lxj = pj.x + rj.x * halfWidth;
      const lzj = pj.z + rj.z * halfWidth;
      const rxj = pj.x - rj.x * halfWidth;
      const rzj = pj.z - rj.z * halfWidth;

      roadVerts.push(lxi, yi, lzi);
      roadVerts.push(rxi, yi, rzi);
      roadVerts.push(lxj, yj, lzj);
      roadVerts.push(rxj, yj, rzj);
      roadIndices.push(roadVertexIndex, roadVertexIndex + 1, roadVertexIndex + 2);
      roadIndices.push(roadVertexIndex + 1, roadVertexIndex + 3, roadVertexIndex + 2);
      roadVertexIndex += 4;

      // Left barrier.
      const leftOffset = halfWidth + 0.3;
      const lx0 = pi.x + ri.x * leftOffset;
      const lz0 = pi.z + ri.z * leftOffset;
      const lx1 = pj.x + rj.x * leftOffset;
      const lz1 = pj.z + rj.z * leftOffset;
      barrierVerts.push(lx0, yi, lz0);
      barrierVerts.push(lx0, yi + bh, lz0);
      barrierVerts.push(lx1, yj, lz1);
      barrierVerts.push(lx1, yj + bh, lz1);
      barrierIndices.push(
        barrierVertexIndex,
        barrierVertexIndex + 1,
        barrierVertexIndex + 2,
        barrierVertexIndex + 1,
        barrierVertexIndex + 3,
        barrierVertexIndex + 2,
      );
      barrierVertexIndex += 4;

      // Right barrier.
      const rx0 = pi.x - ri.x * leftOffset;
      const rz0 = pi.z - ri.z * leftOffset;
      const rx1 = pj.x - rj.x * leftOffset;
      const rz1 = pj.z - rj.z * leftOffset;
      barrierVerts.push(rx0, yi, rz0);
      barrierVerts.push(rx0, yi + bh, rz0);
      barrierVerts.push(rx1, yj, rz1);
      barrierVerts.push(rx1, yj + bh, rz1);
      barrierIndices.push(
        barrierVertexIndex,
        barrierVertexIndex + 2,
        barrierVertexIndex + 1,
        barrierVertexIndex + 1,
        barrierVertexIndex + 2,
        barrierVertexIndex + 3,
      );
      barrierVertexIndex += 4;

      expandAABB(bounds, lxi, yi, lzi);
      expandAABB(bounds, rxi, yi, rzi);
      expandAABB(bounds, lxj, yj + bh, lzj);
      expandAABB(bounds, rxj, yj + bh, rzj);

      const dx = pj.x - pi.x;
      const dz = pj.z - pi.z;
      const lenSq = dx * dx + dz * dz;
      if (lenSq > 0.0001) {
        const right = normalizedCenterlineRight(pi, pj);
        const tangent = new THREE.Vector3(dx, yj - yi, dz).normalize();
        const right3 = new THREE.Vector3(right.x, 0, right.z).normalize();
        const normal = makeRoadNormal(tangent, right3);
        const lateralTolerance = Math.max(
          0,
          readHighwayConfigNumber('surfaceQueryLateralTolerance', 0.15),
        );
        surfaceSegments.push({
          x0: pi.x,
          z0: pi.z,
          x1: pj.x,
          z1: pj.z,
          y0: yi,
          y1: yj,
          dx,
          dz,
          lenSq,
          right,
          normal,
          halfWidth,
          kind,
          minX: Math.min(pi.x, pj.x) - halfWidth - lateralTolerance,
          maxX: Math.max(pi.x, pj.x) + halfWidth + lateralTolerance,
          minZ: Math.min(pi.z, pj.z) - halfWidth - lateralTolerance,
          maxZ: Math.max(pi.z, pj.z) + halfWidth + lateralTolerance,
        });
      }
    }

    if (collectRampAABB) {
      const rampBounds = finishAABB(bounds);
      if (rampBounds) rampAABBs.push(rampBounds);
    }
  }

  appendRibbon(deckPoints, deckHalfWidth, deckHeight, 'deck', false);
  for (const ramp of ramps) {
    appendRibbon(ramp?.points, rampHalfWidth, 0, ramp?.kind || 'ramp', true);
  }

  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadVerts, 3));
  roadGeo.setIndex(roadIndices);
  roadGeo.computeVertexNormals();
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.userData.isHighway = true;
  roadMesh.userData.isGlobalSpanning = true;
  roadMesh.userData.vxmDiagnosticCategory = 'highway';
  roadMesh.userData.vxmMaterialRole = 'road';
  scene.add(roadMesh);

  const barrierGeo = new THREE.BufferGeometry();
  barrierGeo.setAttribute('position', new THREE.Float32BufferAttribute(barrierVerts, 3));
  barrierGeo.setIndex(barrierIndices);
  barrierGeo.computeVertexNormals();
  const barrierMesh = new THREE.Mesh(barrierGeo, barrierMat);
  barrierMesh.userData.isHighway = true;
  barrierMesh.userData.isGlobalSpanning = true;
  barrierMesh.userData.vxmDiagnosticCategory = 'highway';
  barrierMesh.userData.vxmMaterialRole = 'barrier';
  scene.add(barrierMesh);

  // Main build flow reserves the corridor before city layout sampling.  This is a
  // best-effort safety net for direct callers only; it supports the new open
  // reservation polylines and falls back to legacy point marking when needed.
  if (
    zoneMap &&
    Array.isArray(reservationPolylines) &&
    reservationPolylines.length > 0 &&
    typeof zoneMap.markHighwayReservations === 'function'
  ) {
    zoneMap.markHighwayReservations(reservationPolylines);
  } else if (zoneMap && typeof zoneMap.markHighway === 'function') {
    zoneMap.markHighway(deckPoints, { halfWidth: deckHalfWidth });
    for (const ramp of ramps) {
      if (Array.isArray(ramp?.points))
        zoneMap.markHighway(ramp.points, { halfWidth: rampHalfWidth });
    }
  }

  /**
   * Return an elevated deck/ramp support sample only when the query point is over
   * the visible ribbon and not clearly below that top surface.  This prevents
   * street-level underpass traffic from snapping upward, and it returns null once
   * the truck leaves the side of the road so gravity handles the fall naturally.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} [referenceY]
   * @returns {HighwaySurfaceSample|null}
   */
  function sampleSurface(x, z, referenceY = Number.POSITIVE_INFINITY) {
    const lateralTolerance = Math.max(
      0,
      readHighwayConfigNumber('surfaceQueryLateralTolerance', 0.15),
    );
    const belowTolerance = Math.max(0, readHighwayConfigNumber('surfaceQueryBelowTolerance', 1.25));
    let best = null;
    let bestDistSq = Number.POSITIVE_INFINITY;

    for (const seg of surfaceSegments) {
      if (x < seg.minX || x > seg.maxX || z < seg.minZ || z > seg.maxZ) continue;

      const t = clamp01(((x - seg.x0) * seg.dx + (z - seg.z0) * seg.dz) / seg.lenSq);
      const centerX = seg.x0 + seg.dx * t;
      const centerZ = seg.z0 + seg.dz * t;
      const offX = x - centerX;
      const offZ = z - centerZ;
      const lateral = offX * seg.right.x + offZ * seg.right.z;
      if (Math.abs(lateral) > seg.halfWidth + lateralTolerance) continue;

      const height = seg.y0 + (seg.y1 - seg.y0) * t;
      if (Number.isFinite(referenceY) && referenceY < height - belowTolerance) continue;

      const distSq = offX * offX + offZ * offZ;
      if (
        !best ||
        height > best.height + 0.1 ||
        (Math.abs(height - best.height) <= 0.1 && distSq < bestDistSq)
      ) {
        best = {
          height,
          y: height,
          normal: seg.normal,
          isHighwaySurface: true,
          kind: seg.kind,
        };
        bestDistSq = distSq;
      }
    }

    return best;
  }

  const meshes = [roadMesh, barrierMesh];

  function dispose() {
    for (const m of meshes) {
      scene.remove(m);
      m.geometry.dispose();
    }
    roadMat.dispose();
    barrierMat.dispose();
  }

  return { meshes, rampAABBs, sampleSurface, dispose };
}
