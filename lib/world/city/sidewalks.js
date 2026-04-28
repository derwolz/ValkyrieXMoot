import * as THREE from 'three';
import { CITY } from '../../config.js';

// Render the city ground: base plane, road planes per grid line, sidewalk
// strips on each side of every street, and alley planes. All planes are at
// y ≈ 0 with small offsets so road > base, sidewalk > road, etc., reads
// cleanly without z-fighting.
//
// Also returns a flat list of `interestPoints` sampled along sidewalks every
// ~12 m and along alleys every ~10 m. Phase 3+ uses these as ambient
// pedestrian destinations.
export function buildCityGround(scene, bounds, xLines, zLines, alleys) {
  const baseW = bounds.maxX - bounds.minX;
  const baseD = bounds.maxZ - bounds.minZ;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;

  const baseMat = new THREE.MeshBasicMaterial({ color: CITY.groundColor });
  const roadMat = new THREE.MeshBasicMaterial({ color: CITY.roadColor });
  const sidewalkMat = new THREE.MeshBasicMaterial({ color: CITY.sidewalkColor });
  const alleyMat = new THREE.MeshBasicMaterial({ color: CITY.alleyColor });

  // Base ground plane covers everything, dimmest.
  const base = new THREE.Mesh(new THREE.PlaneGeometry(baseW, baseD), baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.set(cx, 0, cz);
  scene.add(base);

  const interestPoints = [];

  // Vertical streets (run along z) + flanking sidewalks.
  for (const xL of xLines) {
    const road = new THREE.Mesh(new THREE.PlaneGeometry(xL.width, baseD), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(xL.x, 0.01, cz);
    scene.add(road);

    for (const side of [-1, 1]) {
      const sw = new THREE.Mesh(
        new THREE.PlaneGeometry(CITY.sidewalkWidth, baseD),
        sidewalkMat,
      );
      sw.rotation.x = -Math.PI / 2;
      const swX = xL.x + side * (xL.width / 2 + CITY.sidewalkWidth / 2);
      sw.position.set(swX, 0.02, cz);
      scene.add(sw);

      // Sample interest points along this sidewalk every ~12 m.
      for (let z = bounds.minZ + 6; z < bounds.maxZ - 6; z += 12) {
        interestPoints.push({ x: swX, z, kind: 'sidewalk' });
      }
    }
  }

  // Horizontal streets (run along x) + flanking sidewalks.
  for (const zL of zLines) {
    const road = new THREE.Mesh(new THREE.PlaneGeometry(baseW, zL.width), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(cx, 0.01, zL.z);
    scene.add(road);

    for (const side of [-1, 1]) {
      const sw = new THREE.Mesh(
        new THREE.PlaneGeometry(baseW, CITY.sidewalkWidth),
        sidewalkMat,
      );
      sw.rotation.x = -Math.PI / 2;
      const swZ = zL.z + side * (zL.width / 2 + CITY.sidewalkWidth / 2);
      sw.position.set(cx, 0.02, swZ);
      scene.add(sw);

      for (let x = bounds.minX + 6; x < bounds.maxX - 6; x += 12) {
        interestPoints.push({ x, z: swZ, kind: 'sidewalk' });
      }
    }
  }

  // Alleys — single plane each, no flanking sidewalks.
  // Sample interest points along alley centreline every ~10 m.
  for (const a of alleys) {
    if (a.a.x === a.b.x) {
      const len = Math.abs(a.b.z - a.a.z);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(a.width, len), alleyMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(a.a.x, 0.015, (a.a.z + a.b.z) / 2);
      scene.add(m);
      const zFrom = Math.min(a.a.z, a.b.z);
      const zTo   = Math.max(a.a.z, a.b.z);
      for (let z = zFrom + 5; z < zTo - 5; z += 10) {
        interestPoints.push({ x: a.a.x, z, kind: 'alley' });
      }
    } else {
      const len = Math.abs(a.b.x - a.a.x);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, a.width), alleyMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set((a.a.x + a.b.x) / 2, 0.015, a.a.z);
      scene.add(m);
      const xFrom = Math.min(a.a.x, a.b.x);
      const xTo   = Math.max(a.a.x, a.b.x);
      for (let x = xFrom + 5; x < xTo - 5; x += 10) {
        interestPoints.push({ x, z: a.a.z, kind: 'alley' });
      }
    }
  }

  return interestPoints;
}
