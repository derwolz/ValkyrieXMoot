import * as THREE from 'three';
import { getBuildingTexture } from '../../buildingTexture.js';
import { BUILDING, CITY } from '../../config.js';

/**
 * Place one building mesh per plot, inset by plotSetback.
 * Returns the AABB list the truck collision system uses.
 *
 * Textures are drawn from the shared pool initialised by initBuildingTexturePool()
 * — no new CanvasTexture is allocated here.
 *
 * @param {import('three').Scene} scene
 * @param {object[]} plots
 * @param {() => number} rand — seeded PRNG
 * @returns {{minX:number,maxX:number,minZ:number,maxZ:number}[]}
 */
export function placeBuildings(scene, plots, rand) {
  const aabbs = [];

  // Fresh material each call — never reuse across city rebuilds to avoid
  // referencing a disposed material from _clearCityMeshes.
  const _topMat = new THREE.MeshBasicMaterial({ color: BUILDING.roofColor });

  let plotIndex = 0;
  for (const plot of plots) {
    const minX = plot.minX + CITY.plotSetback;
    const maxX = plot.maxX - CITY.plotSetback;
    const minZ = plot.minZ + CITY.plotSetback;
    const maxZ = plot.maxZ - CITY.plotSetback;
    const w = maxX - minX;
    const d = maxZ - minZ;
    if (w < 4 || d < 4) { plotIndex++; continue; }

    const h = CITY.buildingMinHeight + rand() * (CITY.buildingMaxHeight - CITY.buildingMinHeight);
    const tex = getBuildingTexture(plotIndex);
    const sideMat = new THREE.MeshBasicMaterial({ map: tex });
    const materials = [sideMat, sideMat, _topMat, _topMat, sideMat, sideMat];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials);
    mesh.position.set((minX + maxX) / 2, h / 2, (minZ + maxZ) / 2);
    scene.add(mesh);

    aabbs.push({ minX, maxX, minZ, maxZ });
    plotIndex++;
  }
  return aabbs;
}
