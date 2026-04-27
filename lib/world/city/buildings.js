import * as THREE from 'three';
import { makeBuildingTexture } from '../../buildingTexture.js';
import { BUILDING, CITY } from '../../config.js';

// Place one building mesh per plot, inset by plotSetback. Returns the AABB
// list the truck collision system uses.
export function placeBuildings(scene, plots, rand) {
  const aabbs = [];
  const topMat = new THREE.MeshBasicMaterial({ color: BUILDING.roofColor });

  for (const plot of plots) {
    const minX = plot.minX + CITY.plotSetback;
    const maxX = plot.maxX - CITY.plotSetback;
    const minZ = plot.minZ + CITY.plotSetback;
    const maxZ = plot.maxZ - CITY.plotSetback;
    const w = maxX - minX;
    const d = maxZ - minZ;
    if (w < 4 || d < 4) continue;

    const h = CITY.buildingMinHeight + rand() * (CITY.buildingMaxHeight - CITY.buildingMinHeight);
    const tex = makeBuildingTexture(rand);
    const sideMat = new THREE.MeshBasicMaterial({ map: tex });
    const materials = [sideMat, sideMat, topMat, topMat, sideMat, sideMat];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials);
    mesh.position.set((minX + maxX) / 2, h / 2, (minZ + maxZ) / 2);
    scene.add(mesh);

    aabbs.push({ minX, maxX, minZ, maxZ });
  }
  return aabbs;
}
