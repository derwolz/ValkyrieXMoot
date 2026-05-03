import { CAR, NPC_VEHICLE } from '../config.js';
import { queryRegion } from '../world/spatialGrid.js';

const BODY_AXIS_EPSILON = 1e-6;
const BODY_CENTER_EPSILON = 1e-5;
const BODY_INERTIA_DIVISOR = 12;
const _BODY_CORNER_SIGNS = [-1, 1];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function getVehicleBuildingBottomY(vehicle) {
  if (vehicle && typeof vehicle.getBuildingCollisionBottomY === 'function') {
    const bottomY = vehicle.getBuildingCollisionBottomY();
    if (Number.isFinite(bottomY)) return bottomY;
  }
  return finiteNumber(vehicle?.position?.y, 0) + CAR.buildingCollisionBodyBottomOffset;
}

function hasClearedBuildingRoof(vehicle, building) {
  if (!Number.isFinite(building?.maxY)) return false;
  return getVehicleBuildingBottomY(vehicle) > building.maxY + CAR.buildingRoofClearance;
}

function getBodyDescriptor(body) {
  if (!body || typeof body.getBodyDescriptor !== 'function') return null;
  return body.getBodyDescriptor();
}

function getVectorComponent(vector, key) {
  return finiteNumber(vector?.[key], 0);
}

function makeVector3Like(x, y, z) {
  return { x, y, z };
}

function makeYawAxes(yaw) {
  const sin = Math.sin(finiteNumber(yaw, 0));
  const cos = Math.cos(finiteNumber(yaw, 0));
  return {
    right: { x: cos, z: -sin },
    forward: { x: -sin, z: -cos },
  };
}

function normalizeAxis(axis) {
  const length = Math.hypot(axis.x, axis.z);
  if (length <= BODY_AXIS_EPSILON) return null;
  return { x: axis.x / length, z: axis.z / length };
}

function makeBodyFootprint(descriptor) {
  if (!descriptor?.center || !descriptor?.halfExtents) return null;
  const axes = makeYawAxes(descriptor.yaw);
  return {
    center: {
      x: getVectorComponent(descriptor.center, 'x'),
      z: getVectorComponent(descriptor.center, 'z'),
    },
    velocity: {
      x: getVectorComponent(descriptor.velocity, 'x'),
      z: getVectorComponent(descriptor.velocity, 'z'),
    },
    angularVelocityY: finiteNumber(descriptor.angularVelocityY, 0),
    halfExtents: {
      x: Math.max(0, finiteNumber(descriptor.halfExtents.x, 0)),
      y: Math.max(0, finiteNumber(descriptor.halfExtents.y, 0)),
      z: Math.max(0, finiteNumber(descriptor.halfExtents.z, 0)),
    },
    mass: Math.max(BODY_AXIS_EPSILON, finiteNumber(descriptor.mass, 1)),
    restitution: clamp(finiteNumber(descriptor.restitution, 0), 0, 1),
    right: axes.right,
    forward: axes.forward,
  };
}

function projectBodyOnAxis(body, axis) {
  const centerProjection = body.center.x * axis.x + body.center.z * axis.z;
  const rightProjection = Math.abs(body.right.x * axis.x + body.right.z * axis.z);
  const forwardProjection = Math.abs(body.forward.x * axis.x + body.forward.z * axis.z);
  const radius = body.halfExtents.x * rightProjection + body.halfExtents.z * forwardProjection;
  return {
    min: centerProjection - radius,
    max: centerProjection + radius,
  };
}

function findBodyOverlap(playerBody, npcBody) {
  const axes = [playerBody.right, playerBody.forward, npcBody.right, npcBody.forward];
  let bestOverlap = Number.POSITIVE_INFINITY;
  let bestAxis = null;

  for (const rawAxis of axes) {
    const axis = normalizeAxis(rawAxis);
    if (!axis) continue;

    const playerProjection = projectBodyOnAxis(playerBody, axis);
    const npcProjection = projectBodyOnAxis(npcBody, axis);
    const overlap =
      Math.min(playerProjection.max, npcProjection.max) -
      Math.max(playerProjection.min, npcProjection.min);
    if (overlap <= 0) return null;

    if (overlap < bestOverlap) {
      bestOverlap = overlap;
      bestAxis = axis;
    }
  }

  if (!bestAxis) return null;

  const centerDelta = {
    x: playerBody.center.x - npcBody.center.x,
    z: playerBody.center.z - npcBody.center.z,
  };
  if (Math.hypot(centerDelta.x, centerDelta.z) <= BODY_CENTER_EPSILON) {
    bestAxis = { x: -playerBody.forward.x, z: -playerBody.forward.z };
  } else if (centerDelta.x * bestAxis.x + centerDelta.z * bestAxis.z < 0) {
    bestAxis = { x: -bestAxis.x, z: -bestAxis.z };
  }

  return {
    penetration: bestOverlap,
    normal: bestAxis,
  };
}

function getPlayerFrontContactPoint(playerBody, vehicle) {
  const forwardSpeed = finiteNumber(
    vehicle?.speed,
    playerBody.velocity.x * playerBody.forward.x + playerBody.velocity.z * playerBody.forward.z,
  );
  const lateralSpeed = finiteNumber(
    vehicle?.lateralVelocity,
    playerBody.velocity.x * playerBody.right.x + playerBody.velocity.z * playerBody.right.z,
  );
  const lateralDenominator = Math.max(
    Math.abs(forwardSpeed),
    Math.abs(lateralSpeed),
    CAR.impactMinRelativeSpeed,
  );
  const lateralRatio = clamp(lateralSpeed / lateralDenominator, -1, 1);

  return {
    x:
      playerBody.center.x +
      playerBody.forward.x * playerBody.halfExtents.z +
      playerBody.right.x * playerBody.halfExtents.x * lateralRatio,
    z:
      playerBody.center.z +
      playerBody.forward.z * playerBody.halfExtents.z +
      playerBody.right.z * playerBody.halfExtents.x * lateralRatio,
  };
}

function velocityAtPoint(body, point) {
  const rx = point.x - body.center.x;
  const rz = point.z - body.center.z;
  return {
    x: body.velocity.x + body.angularVelocityY * rz,
    z: body.velocity.z - body.angularVelocityY * rx,
  };
}

function applyPlayerBodyImpulse(vehicle, delta) {
  if (vehicle?.velocity && typeof vehicle.velocity.add === 'function') {
    vehicle.velocity.add(delta);
    return;
  }

  if (vehicle && Number.isFinite(vehicle.speed)) {
    vehicle.speed *= Math.max(0, 1 - CAR.impactPlayerDamping);
  }
}

function getYawInertia(body) {
  const width = body.halfExtents.x + body.halfExtents.x;
  const length = body.halfExtents.z + body.halfExtents.z;
  return Math.max(
    BODY_AXIS_EPSILON,
    (body.mass * (width * width + length * length)) / BODY_INERTIA_DIVISOR,
  );
}

/**
 * Clamp the vehicle to the map boundary. Zeroes speed on impact so the player
 * doesn't clip through the perimeter wall.
 *
 * @param {{position:{x:number,z:number}, speed:number}} vehicle
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}|null} bounds
 * @returns {{axis:string}|null}  which wall was hit, or null if no collision
 */
export function resolveMapBounds(vehicle, bounds) {
  if (!bounds) return null;
  const r = CAR.collisionRadius;
  const { x, z } = vehicle.position;
  if (x > bounds.maxX) {
    vehicle.position.x = bounds.maxX - r;
    vehicle.speed = 0;
    return { axis: 'maxX' };
  }
  if (x < bounds.minX) {
    vehicle.position.x = bounds.minX + r;
    vehicle.speed = 0;
    return { axis: 'minX' };
  }
  if (z > bounds.maxZ) {
    vehicle.position.z = bounds.maxZ - r;
    vehicle.speed = 0;
    return { axis: 'maxZ' };
  }
  if (z < bounds.minZ) {
    vehicle.position.z = bounds.minZ + r;
    vehicle.speed = 0;
    return { axis: 'minZ' };
  }
  return null;
}

// Resolves the vehicle against building AABBs. Car is approximated as a circle
// in the XZ plane (radius CAR.collisionRadius). Mutates vehicle.position and
// dampens vehicle.speed when the impact is head-on.
//
// Returns the last collision hit this frame (or null), which gameplay code can
// use later for screen shake / hit FX.
export function resolveBuildingCollisions(vehicle, aabbs) {
  const r = CAR.collisionRadius;
  let lastHit = null;

  // Support plain array or spatial grid (queryRegion narrows candidates).
  const px = vehicle.position.x;
  const pz = vehicle.position.z;
  const candidates = queryRegion(aabbs, px - r, px + r, pz - r, pz + r);

  for (const b of candidates) {
    if (hasClearedBuildingRoof(vehicle, b)) continue;

    const cx = Math.max(b.minX, Math.min(vehicle.position.x, b.maxX));
    const cz = Math.max(b.minZ, Math.min(vehicle.position.z, b.maxZ));
    const dx = vehicle.position.x - cx;
    const dz = vehicle.position.z - cz;
    const distSq = dx * dx + dz * dz;
    if (distSq >= r * r) continue;

    let nx;
    let nz;
    const dist = Math.sqrt(distSq);
    if (dist < 1e-5) {
      // Car center is inside the AABB — push out along the shortest axis.
      const overlapL = vehicle.position.x - b.minX;
      const overlapR = b.maxX - vehicle.position.x;
      const overlapB = vehicle.position.z - b.minZ;
      const overlapF = b.maxZ - vehicle.position.z;
      const m = Math.min(overlapL, overlapR, overlapB, overlapF);
      if (m === overlapL) {
        vehicle.position.x = b.minX - r;
        nx = -1;
        nz = 0;
      } else if (m === overlapR) {
        vehicle.position.x = b.maxX + r;
        nx = 1;
        nz = 0;
      } else if (m === overlapB) {
        vehicle.position.z = b.minZ - r;
        nx = 0;
        nz = -1;
      } else {
        vehicle.position.z = b.maxZ + r;
        nx = 0;
        nz = 1;
      }
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

/**
 * Resolve an oriented player vehicle body against an oriented NPC vehicle body.
 * The descriptors are deliberately 3D-ready, while the current collision math is
 * performed in the XZ plane so it can later be promoted without changing callers.
 *
 * @param {object} vehicle Vehicle instance; mutates position and velocity.
 * @param {object} npcVehicle NPC vehicle handle; receives body impact velocity/spin.
 * @returns {object|null} Collision result or null when the oriented bodies do not overlap.
 */
export function resolveNpcVehicleBodyCollision(vehicle, npcVehicle) {
  const playerDescriptor = getBodyDescriptor(vehicle);
  const npcDescriptor = getBodyDescriptor(npcVehicle);
  const playerBody = makeBodyFootprint(playerDescriptor);
  const npcBody = makeBodyFootprint(npcDescriptor);
  if (!playerBody || !npcBody) return null;

  const overlap = findBodyOverlap(playerBody, npcBody);
  if (!overlap) return null;

  const penetrationCorrection = Math.min(overlap.penetration, CAR.impactMaxPenetrationCorrection);
  if (vehicle?.position) {
    vehicle.position.x += overlap.normal.x * penetrationCorrection;
    vehicle.position.z += overlap.normal.z * penetrationCorrection;
  }

  const contactPoint = getPlayerFrontContactPoint(playerBody, vehicle);
  const playerContactVelocity = velocityAtPoint(playerBody, contactPoint);
  const npcContactVelocity = velocityAtPoint(npcBody, contactPoint);
  const relativeVelocity = {
    x: playerContactVelocity.x - npcContactVelocity.x,
    z: playerContactVelocity.z - npcContactVelocity.z,
  };
  const velocityAlongNormal =
    relativeVelocity.x * overlap.normal.x + relativeVelocity.z * overlap.normal.z;
  const approachingSpeed = Math.max(0, -velocityAlongNormal);
  const impactSpeed = Math.max(approachingSpeed, CAR.impactMinRelativeSpeed);
  const restitution = Math.min(playerBody.restitution, npcBody.restitution);
  const inversePlayerMass = 1 / playerBody.mass;
  const inverseNpcMass = 1 / npcBody.mass;
  const impulseMagnitude = ((1 + restitution) * impactSpeed) / (inversePlayerMass + inverseNpcMass);

  const playerVelocityDelta = makeVector3Like(
    overlap.normal.x * impulseMagnitude * inversePlayerMass * CAR.impactPlayerDamping,
    0,
    overlap.normal.z * impulseMagnitude * inversePlayerMass * CAR.impactPlayerDamping,
  );
  const npcVelocityDelta = makeVector3Like(
    -overlap.normal.x * impulseMagnitude * inverseNpcMass * NPC_VEHICLE.impactPushStrength,
    0,
    -overlap.normal.z * impulseMagnitude * inverseNpcMass * NPC_VEHICLE.impactPushStrength,
  );

  applyPlayerBodyImpulse(vehicle, playerVelocityDelta);

  const npcImpulseX = -overlap.normal.x * impulseMagnitude * NPC_VEHICLE.impactPushStrength;
  const npcImpulseZ = -overlap.normal.z * impulseMagnitude * NPC_VEHICLE.impactPushStrength;
  const npcOffsetX = contactPoint.x - npcBody.center.x;
  const npcOffsetZ = contactPoint.z - npcBody.center.z;
  const torqueImpulseY = npcOffsetX * npcImpulseZ - npcOffsetZ * npcImpulseX;
  const angularVelocityDeltaY =
    (torqueImpulseY / getYawInertia(npcBody)) * NPC_VEHICLE.impactSpinStrength;

  if (typeof npcVehicle?.applyBodyImpact === 'function') {
    npcVehicle.applyBodyImpact(npcVelocityDelta, angularVelocityDeltaY);
  }

  return {
    normal: { x: overlap.normal.x, z: overlap.normal.z },
    penetration: overlap.penetration,
    penetrationCorrection,
    contactPoint: makeVector3Like(
      contactPoint.x,
      getVectorComponent(playerDescriptor.center, 'y'),
      contactPoint.z,
    ),
    impulseMagnitude,
    playerVelocityDelta,
    npcVelocityDelta,
    angularVelocityDeltaY,
  };
}
