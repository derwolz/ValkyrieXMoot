/**
 * lib/car/playerMesh.js — 3D player truck.
 *
 * Drop-in replacement for `playerSprite.js`. Loads a GLB once and poses it
 * each frame from the existing Vehicle state (position, yaw, speed,
 * steerInput). Vehicle physics + collision are untouched — issues #2 and #3
 * meet at this seam: this module owns rendering only.
 *
 * Body roll on steer + slight pitch on accel are ported from
 * crazy-cabbie/src/vehicle.js so the truck reads as planted on the road.
 *
 * Usage:
 *   const pm = await createPlayerMesh(scene);
 *   pm.update(vehicle, dt);   // every frame, before render
 *   pm.destroy();             // on city rebuild / cleanup
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CAR } from '../config.js';

const TRUCK_URL = './data/vehicles/player-truck.glb';
const TRUCK_SCALE = 8; // tuned by eye against the city.
const FORWARD_OFFSET_Y = 0; // adjust if the model floats/sinks.
// Authored facing direction. The user's truck model is authored facing -Z
// already (matches valkyrie's vehicle.forward), so no offset is needed.
const MODEL_FACING_OFFSET = 0;

// Body lean / pitch tuning — kept gentle. Lerp factors are per-second.
const ROLL_AMPLITUDE = 0.1; // radians at full steer & speed
const ROLL_LERP_RATE = 9;
const PITCH_AMPLITUDE = 0.045;
const PITCH_LERP_RATE = 6;

const STEER_THRESHOLD = 0.05; // below this, hold neutral roll

// Reused module-cached loader so repeated city rebuilds don't re-parse the GLB.
let _cachedScene = null;
async function loadTruckScene() {
  if (_cachedScene) return _cachedScene;
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(TRUCK_URL);
  _cachedScene = gltf.scene;
  // Mark every mesh so _clearCityMeshes() doesn't dispose shared resources.
  _cachedScene.traverse((n) => {
    if (n.isMesh) {
      n.userData.sharedAsset = true;
      n.castShadow = true;
      n.receiveShadow = false;
    }
  });
  return _cachedScene;
}

/**
 * @param {import('three').Scene} scene
 */
export async function createPlayerMesh(scene) {
  const src = await loadTruckScene();

  // One clone per active player mesh — materials are shared across clones.
  const truck = src.clone(true);
  truck.traverse((n) => {
    if (n.isMesh) n.userData.sharedAsset = true;
  });

  // The "body" group is what we lean / pitch — separate from the outer
  // group so heading rotation around Y is unaffected.
  const body = new THREE.Group();
  body.add(truck);
  truck.scale.setScalar(TRUCK_SCALE);
  truck.rotation.y = MODEL_FACING_OFFSET;

  // Outer group holds world position + heading.
  const root = new THREE.Group();
  root.add(body);
  root.userData.isPlayerSprite = true; // _clearCityMeshes() exclusion flag
  scene.add(root);

  // Detect Kenney-style named wheel nodes. Optional — the user's custom
  // truck likely doesn't have them, in which case `wheels` stays empty
  // and the wheel-spin step is skipped silently.
  const wheels = [];
  truck.traverse((n) => {
    if (n.name && /^wheel[-_]/i.test(n.name)) {
      wheels.push({ node: n, isFront: /front/i.test(n.name) });
    }
  });
  // Wheel radius — guessed; only matters if we found wheels.
  const wheelRadius = 0.35 * TRUCK_SCALE;

  let _roll = 0;
  let _pitch = 0;
  let _lastSpeed = 0;

  /**
   * @param {{ position: THREE.Vector3, yaw: number, speed: number, steerInput: number }} vehicle
   * @param {number} dt
   */
  function update(vehicle, dt = 1 / 60) {
    // Position + heading (Y rotation matches vehicle.yaw — same convention
    // valkyrie uses everywhere else, see vehicle.setPositionYaw).
    root.position.set(
      vehicle.position.x,
      vehicle.position.y + FORWARD_OFFSET_Y,
      vehicle.position.z,
    );
    root.rotation.y = vehicle.yaw;

    // Body lean: positive steerInput in valkyrie = turn left, so roll
    // toward the right (negative Z rotation when looking down +X) feels
    // correct as the chassis rolls outward in a turn.
    const speedFrac = Math.min(1, Math.abs(vehicle.speed) / CAR.maxSpeed);
    const steer = Math.abs(vehicle.steerInput) > STEER_THRESHOLD ? vehicle.steerInput : 0;
    const targetRoll = -steer * ROLL_AMPLITUDE * speedFrac;
    _roll += (targetRoll - _roll) * Math.min(1, dt * ROLL_LERP_RATE);

    // Pitch: nose-down on accel, nose-up on brake. Estimate accel from
    // d(speed)/dt without depending on Vehicle internals.
    const accelEst = (vehicle.speed - _lastSpeed) / Math.max(1e-3, dt);
    _lastSpeed = vehicle.speed;
    const targetPitch = -Math.max(-1, Math.min(1, accelEst / CAR.accel)) * PITCH_AMPLITUDE;
    _pitch += (targetPitch - _pitch) * Math.min(1, dt * PITCH_LERP_RATE);

    body.rotation.z = _roll;
    body.rotation.x = _pitch;

    // Wheel spin (only fires if we matched named wheels above).
    if (wheels.length > 0) {
      const rollSpeed = vehicle.speed / wheelRadius;
      for (const w of wheels) {
        w.node.rotation.x -= rollSpeed * dt;
        // Steering wheels turn slightly with input.
        if (w.isFront) w.node.rotation.y = vehicle.steerInput * 0.4;
      }
    }
  }

  function destroy() {
    scene.remove(root);
    // Materials/geometry are shared via _cachedScene — do NOT dispose.
  }

  /**
   * Stub for parity with the sprite API — the mirror system used to grab
   * the active sprite texture. With a 3D mesh there's no single texture
   * to return, so this returns null and the mirror falls back to whatever
   * default it has.
   */
  function getActiveTexture() {
    return null;
  }

  return { update, destroy, getActiveTexture, root };
}
