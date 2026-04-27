import * as THREE from 'three';
import { CAR } from '../config.js';
import { Input } from '../input.js';

// Arcade car. Signed `speed` along the car's facing direction. Turning rate is
// scaled by |speed|/maxSpeed so you can't spin in place — per the brief.
// Reversing inverts steering feel (wheel-left while reversing pivots the nose right).
export class Vehicle {
  constructor() {
    this.position = new THREE.Vector3(...CAR.startPos);
    this.yaw = CAR.startYaw;
    this.speed = 0;
    this.forward = new THREE.Vector3(0, 0, -1);
  }

  reset() {
    this.position.set(...CAR.startPos);
    this.yaw = CAR.startYaw;
    this.speed = 0;
  }

  /** Snap to a recorded position/yaw without affecting speed (used by rewind). */
  setPositionYaw(x, z, yaw) {
    this.position.x = x;
    this.position.z = z;
    this.yaw = yaw;
    this.forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  }

  update(dt) {
    const accelInput =
      (Input.any('KeyW', 'ArrowUp') ? 1 : 0) -
      (Input.any('KeyS', 'ArrowDown') ? 1 : 0);
    const steerInput =
      (Input.any('KeyA', 'ArrowLeft') ? 1 : 0) -
      (Input.any('KeyD', 'ArrowRight') ? 1 : 0);

    if (accelInput !== 0) {
      // Input opposing current velocity brakes harder than it accelerates.
      const opposing = (accelInput > 0 && this.speed < 0) || (accelInput < 0 && this.speed > 0);
      const rate = opposing ? CAR.brake : CAR.accel;
      this.speed += accelInput * rate * dt;
    } else {
      const drag = CAR.coastFriction * dt;
      if (Math.abs(this.speed) < drag) this.speed = 0;
      else this.speed -= Math.sign(this.speed) * drag;
    }
    this.speed = Math.max(-CAR.reverseMaxSpeed, Math.min(CAR.maxSpeed, this.speed));

    const speedFraction = Math.min(Math.abs(this.speed) / CAR.maxSpeed, 1);
    const reverseFactor = this.speed < 0 ? -1 : 1;
    this.yaw += steerInput * CAR.turnRate * speedFraction * reverseFactor * dt;

    // Three.js right-handed, Y-up: yaw=0 faces -Z. Rotating Y by θ of (0,0,-1) → (-sin θ, 0, -cos θ).
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.position.addScaledVector(this.forward, this.speed * dt);
  }

  applyToCamera(camera) {
    camera.position.set(this.position.x, CAR.cameraHeight, this.position.z);
    camera.rotation.set(0, this.yaw, 0);
  }
}
