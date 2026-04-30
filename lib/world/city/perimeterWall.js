/**
 * lib/world/city/perimeterWall.js
 *
 * Places a dense ring of tall buildings around all 4 edges of the city map.
 * Each wall segment is a single BoxGeometry box — one per "slot" spaced every
 * WALL_STEP metres along the edge.  The boxes are wide enough (with 1 m overlap)
 * that there are no driveable gaps.
 *
 * Returns an array of AABBs that are merged into buildingAABBs so the truck
 * collision system blocks the player from escaping.
 *
 * @param {import('three').Scene} scene
 * @param {{ minX:number, maxX:number, minZ:number, maxZ:number }} bounds
 *   — the city ground bounds (before the wall is placed; wall sits outside/on this edge)
 * @param {(index:number)=>import('three').Texture} getBuildingTexture
 *   — shared texture-pool accessor
 * @returns {{ minX:number, maxX:number, minZ:number, maxZ:number }[]} AABBs
 */

import * as THREE from 'three';
import { BUILDING, CITY } from '../../config.js';

// How wide each wall "tower" is along its axis (metres).  Overlap guarantees no gaps.
const WALL_STEP    = 18;   // slot spacing — towers are placed every 18 m
const TOWER_W      = 20;   // tower footprint along the wall direction (>WALL_STEP → overlap)
const TOWER_D      = 14;   // tower depth (inward, perpendicular to wall)
const WALL_OFFSET  = 0;    // how far outside the city bounds the tower centre sits
                            // 0 = centre sits at the bounds edge

// Tower height range — taller than interior buildings to be visually imposing.
const TOWER_H_MIN  = 40;
const TOWER_H_MAX  = 80;

// Simple seeded hash for deterministic height/texture per tower.
function hash(n) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
}
function seededFloat(seed) { return (hash(seed) & 0xffffff) / 0xffffff; }

/**
 * Build one wall side.
 *
 * @param {import('three').Scene} scene
 * @param {{ axis:'x'|'z', sign:1|-1, boundsMin:number, boundsMax:number, edgeCoord:number }} cfg
 * @param {THREE.Material} topMat
 * @param {(index:number)=>import('three').Texture} getBuildingTexture
 * @param {number} texOffset  — offset into texture pool so each side uses different variants
 * @returns {{ minX:number, maxX:number, minZ:number, maxZ:number }[]}
 */
function buildWallSide(scene, cfg, topMat, getBuildingTexture, texOffset) {
  const aabbs = [];
  const { axis, sign, boundsMin, boundsMax, edgeCoord } = cfg;

  // Wall extends the full span plus one extra step each side to cover corners.
  const span    = boundsMax - boundsMin;
  const nSlots  = Math.ceil(span / WALL_STEP) + 2;
  const startAt = boundsMin - WALL_STEP;   // shift back by one to cover the corner

  for (let i = 0; i < nSlots; i++) {
    const along = startAt + i * WALL_STEP;
    const h     = TOWER_H_MIN + seededFloat(texOffset * 1000 + i) * (TOWER_H_MAX - TOWER_H_MIN);

    // World position of this tower's centre.
    let cx, cz, w, d;
    if (axis === 'z') {
      // North/South walls — towers run along X, edge is at fixed Z.
      cx = along + WALL_STEP / 2;
      cz = edgeCoord + sign * (TOWER_D / 2 + WALL_OFFSET);
      w  = TOWER_W;   // along X
      d  = TOWER_D;   // along Z
    } else {
      // East/West walls — towers run along Z, edge is at fixed X.
      cx = edgeCoord + sign * (TOWER_D / 2 + WALL_OFFSET);
      cz = along + WALL_STEP / 2;
      w  = TOWER_D;   // along X
      d  = TOWER_W;   // along Z
    }

    // Pick texture from pool.
    const texIdx = (texOffset + i) % 16;
    const tex     = getBuildingTexture(texIdx);
    const sideMat = new THREE.MeshBasicMaterial({ map: tex });
    const materials = [sideMat, sideMat, topMat, topMat, sideMat, sideMat];

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials);
    mesh.position.set(cx, h / 2, cz);
    scene.add(mesh);

    // AABB for collision — full footprint of the tower.
    const halfW = w / 2;
    const halfD = d / 2;
    aabbs.push({
      minX: cx - halfW,
      maxX: cx + halfW,
      minZ: cz - halfD,
      maxZ: cz + halfD,
    });
  }

  return aabbs;
}

/**
 * Place perimeter wall buildings around all 4 edges.
 *
 * @param {import('three').Scene} scene
 * @param {{ minX:number, maxX:number, minZ:number, maxZ:number }} bounds
 * @param {(index:number)=>import('three').Texture} getBuildingTexture
 * @returns {{ minX:number, maxX:number, minZ:number, maxZ:number }[]}
 */
export function buildPerimeterWall(scene, bounds, getBuildingTexture) {
  const topMat = new THREE.MeshBasicMaterial({ color: BUILDING.roofColor });
  const aabbs  = [];

  // South wall (minZ edge) — towers sit south of the city, sign=-1 means centres go further south.
  aabbs.push(...buildWallSide(scene, {
    axis:       'z',
    sign:       -1,
    boundsMin:  bounds.minX,
    boundsMax:  bounds.maxX,
    edgeCoord:  bounds.minZ,
  }, topMat, getBuildingTexture, 0));

  // North wall (maxZ edge).
  aabbs.push(...buildWallSide(scene, {
    axis:       'z',
    sign:       +1,
    boundsMin:  bounds.minX,
    boundsMax:  bounds.maxX,
    edgeCoord:  bounds.maxZ,
  }, topMat, getBuildingTexture, 4));

  // West wall (minX edge).
  aabbs.push(...buildWallSide(scene, {
    axis:       'x',
    sign:       -1,
    boundsMin:  bounds.minZ,
    boundsMax:  bounds.maxZ,
    edgeCoord:  bounds.minX,
  }, topMat, getBuildingTexture, 8));

  // East wall (maxX edge).
  aabbs.push(...buildWallSide(scene, {
    axis:       'x',
    sign:       +1,
    boundsMin:  bounds.minZ,
    boundsMax:  bounds.maxZ,
    edgeCoord:  bounds.maxX,
  }, topMat, getBuildingTexture, 12));

  return aabbs;
}
