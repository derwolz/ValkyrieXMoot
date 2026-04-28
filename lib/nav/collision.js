/**
 * lib/nav/collision.js — moot ↔ building wall collision helper.
 *
 * moveWithCollision(pos, vx, vz, dt, buildingAABBs, radius)
 *   → { x, z }  new world position after sliding along any walls.
 *
 * Slides the circle of `radius` along AABBs using the same approach as the
 * truck's resolveBuildingCollisions but simplified for point + radius:
 *   1. Try full step.
 *   2. If penetrating any AABB, compute MTD (minimum translation vector).
 *   3. Project velocity onto the wall tangent and retry (slide).
 */

/**
 * @param {{x:number,z:number}} pos  world position before this step
 * @param {number} vx
 * @param {number} vz
 * @param {number} dt
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}[]} aabbs
 * @param {number} radius
 * @returns {{x:number,z:number}}
 */
export function moveWithCollision(pos, vx, vz, dt, aabbs, radius) {
  let nx = pos.x + vx * dt;
  let nz = pos.z + vz * dt;

  // Two passes: push-out on first collision, then slide on remainder.
  for (let pass = 0; pass < 2; pass++) {
    const pen = deepestPenetration(pos.x, pos.z, nx, nz, aabbs, radius);
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

  return { x: nx, z: nz };
}

/**
 * Returns the shallowest-approach penetration record { px,pz,nx,nz } or null.
 * `ox,oz` is the *previous* position so we can determine which face was hit.
 */
function deepestPenetration(ox, oz, cx, cz, aabbs, r) {
  let bestDepth = 0;
  let best = null;

  for (const aabb of aabbs) {
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
      best = { px: nx * depth, pz: nz * depth, nx, nz };
    }
  }
  return best;
}
