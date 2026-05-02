/**
 * lib/nav/collision.js — moot ↔ building wall collision helper.
 *
 * moveWithCollision(pos, vx, vz, dt, buildingAABBs, radius, out?)
 *   → out  new world position after sliding along any walls.
 *
 * Pass `out` to avoid allocating a fresh {x,z} result on AI hot paths. `out`
 * may be the same object as `pos` because all calculations are done before the
 * final write.
 *
 * Slides the circle of `radius` along AABBs using the same approach as the
 * truck's resolveBuildingCollisions but simplified for point + radius:
 *   1. Try full step.
 *   2. If penetrating any AABB, compute MTD (minimum translation vector).
 *   3. Project velocity onto the wall tangent and retry (slide).
 */

import { queryRegion } from '../world/spatialGrid.js';

/** Reused penetration result so collision checks don't allocate on AI ticks. */
const _penResult = { px: 0, pz: 0, nx: 0, nz: 0 };

/**
 * @param {{x:number,z:number}} pos  world position before this step
 * @param {number} vx
 * @param {number} vz
 * @param {number} dt
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}[]} aabbs
 * @param {number} radius
 * @param {{x:number,z:number}} [out]
 * @returns {{x:number,z:number}}
 */
export function moveWithCollision(pos, vx, vz, dt, aabbs, radius, out = { x: 0, z: 0 }) {
  let nx = pos.x + vx * dt;
  let nz = pos.z + vz * dt;

  // Two passes: push-out on first collision, then slide on remainder.
  for (let pass = 0; pass < 2; pass++) {
    const pen = deepestPenetration(pos.x, pos.z, nx, nz, aabbs, radius, _penResult);
    if (!pen) break;

    nx += pen.px;
    nz += pen.pz;

    if (pass === 0) {
      // Project velocity onto wall tangent (slide).
      const dot = vx * pen.nx + vz * pen.nz;
      vx -= dot * pen.nx;
      vz -= dot * pen.nz;
    }
  }

  out.x = nx;
  out.z = nz;
  return out;
}

/**
 * Returns the shallowest-approach penetration record { px,pz,nx,nz } or null.
 * `ox,oz` is the *previous* position so we can determine which face was hit.
 */
function deepestPenetration(ox, oz, cx, cz, aabbs, r, out) {
  let bestDepth = 0;
  let bestNx = 0;
  let bestNz = 0;

  // Narrow candidates to the local area around the new position.
  const candidates = queryRegion(aabbs, cx - r, cx + r, cz - r, cz + r);

  for (const aabb of candidates) {
    // Nearest point on AABB to candidate centre.
    const npx = Math.max(aabb.minX, Math.min(cx, aabb.maxX));
    const npz = Math.max(aabb.minZ, Math.min(cz, aabb.maxZ));
    const dx = cx - npx;
    const dz = cz - npz;
    const distSq = dx * dx + dz * dz;

    if (distSq >= r * r) continue; // no overlap

    let nx, nz, depth;
    if (distSq < 1e-10) {
      // Centre is inside AABB — use approach direction to pick exit face.
      const movX = cx - ox;
      const movZ = cz - oz;
      if (Math.abs(movX) >= Math.abs(movZ)) {
        nx = movX >= 0 ? -1 : 1;  // entered from left or right
        nz = 0;
        depth = (nx < 0 ? cx - aabb.minX : aabb.maxX - cx) + r;
      } else {
        nx = 0;
        nz = movZ >= 0 ? -1 : 1;
        depth = (nz < 0 ? cz - aabb.minZ : aabb.maxZ - cz) + r;
      }
      depth = Math.max(depth, 0);
    } else {
      const dist = Math.sqrt(distSq);
      nx = dx / dist;
      nz = dz / dist;
      depth = r - dist;
    }

    if (depth > bestDepth) {
      bestDepth = depth;
      bestNx = nx;
      bestNz = nz;
    }
  }
  if (bestDepth <= 0) return null;
  out.nx = bestNx;
  out.nz = bestNz;
  out.px = bestNx * bestDepth;
  out.pz = bestNz * bestDepth;
  return out;
}
