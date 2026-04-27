import { CAR } from '../config.js';

// Resolves the vehicle against building AABBs. Car is approximated as a circle
// in the XZ plane (radius CAR.collisionRadius). Mutates vehicle.position and
// dampens vehicle.speed when the impact is head-on.
//
// Returns the last collision hit this frame (or null), which gameplay code can
// use later for screen shake / hit FX.
export function resolveBuildingCollisions(vehicle, aabbs) {
  const r = CAR.collisionRadius;
  let lastHit = null;

  for (const b of aabbs) {
    const cx = Math.max(b.minX, Math.min(vehicle.position.x, b.maxX));
    const cz = Math.max(b.minZ, Math.min(vehicle.position.z, b.maxZ));
    const dx = vehicle.position.x - cx;
    const dz = vehicle.position.z - cz;
    const distSq = dx * dx + dz * dz;
    if (distSq >= r * r) continue;

    let nx, nz;
    const dist = Math.sqrt(distSq);
    if (dist < 1e-5) {
      // Car center is inside the AABB — push out along the shortest axis.
      const overlapL = vehicle.position.x - b.minX;
      const overlapR = b.maxX - vehicle.position.x;
      const overlapB = vehicle.position.z - b.minZ;
      const overlapF = b.maxZ - vehicle.position.z;
      const m = Math.min(overlapL, overlapR, overlapB, overlapF);
      if (m === overlapL)      { vehicle.position.x = b.minX - r; nx = -1; nz =  0; }
      else if (m === overlapR) { vehicle.position.x = b.maxX + r; nx =  1; nz =  0; }
      else if (m === overlapB) { vehicle.position.z = b.minZ - r; nx =  0; nz = -1; }
      else                     { vehicle.position.z = b.maxZ + r; nx =  0; nz =  1; }
    } else {
      nx = dx / dist;
      nz = dz / dist;
      const push = r - dist;
      vehicle.position.x += nx * push;
      vehicle.position.z += nz * push;
    }

    // Speed damping based on head-on-ness. forward·normal > 0 means the car
    // is moving away from the wall; < 0 means into it. When reversing, the
    // effective direction is -forward.
    const forwardIntoWall =
      -(vehicle.forward.x * nx + vehicle.forward.z * nz) * Math.sign(vehicle.speed || 1);
    if (forwardIntoWall > 0) {
      vehicle.speed *= Math.max(0, 1 - CAR.wallBounceDamp * forwardIntoWall);
    }

    lastHit = { nx, nz, intensity: Math.max(0, forwardIntoWall) };
  }

  return lastHit;
}
