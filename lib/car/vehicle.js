import * as THREE from 'three';
import { CAR, BOOST } from '../config.js';
import { TouchInput } from '../input/touch.js';
import { Bindings } from '../input/bindings.js';

// Arcade car. Signed `speed` along the car's facing direction. Turning rate is
// scaled by |speed|/maxSpeed so you can't spin in place — per the brief.
// Reversing inverts steering feel (wheel-left while reversing pivots the nose right).
//
// E-brake / drift: holding Space transfers longitudinal momentum into lateral (sideways)
// velocity, letting the car slide. lateralSpeed is clamped and bleeds off every frame.
export class Vehicle {
  constructor() {
    this.position = new THREE.Vector3(...CAR.startPos);
    this.yaw = CAR.startYaw;
    this.speed = 0;
    this.lateralSpeed = 0;  // sideways slide component (right = positive)
    this.steerInput = 0;   // last frame steer input, exposed for playerSprite
    this.forward = new THREE.Vector3(0, 0, -1);
    this._right = new THREE.Vector3(1, 0, 0);  // kept in sync with yaw
  }

  reset() {
    this.position.set(...CAR.startPos);
    this.yaw = CAR.startYaw;
    this.speed = 0;
    this.lateralSpeed = 0;
  }

  /** Snap to a recorded position/yaw without affecting speed (used by rewind). */
  setPositionYaw(x, z, yaw) {
    this.position.x = x;
    this.position.z = z;
    this.yaw = yaw;
    this.lateralSpeed = 0;  // rewind clears any active slide
    this.forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));
  }

  /** @param {number} dt
   *  @param {{ charge: number, boosting: boolean }|null} [game] */
  update(dt, game = null) {
    // Movement uses e.code (physical key position) for WASD so the keys at the
    // WASD positions always drive the car, regardless of keyboard layout
    // (Dvorak, AZERTY, Colemak, etc. all use the same physical spots).
    // Arrow keys also use e.code (already positional).
    const kbAccel =
      (Bindings.isAction('accel')      ? 1 : 0) -
      (Bindings.isAction('brake')      ? 1 : 0);
    const kbSteer =
      (Bindings.isAction('steerLeft')  ? 1 : 0) -
      (Bindings.isAction('steerRight') ? 1 : 0);

    // Blend keyboard and touch joystick — keyboard wins when any key is held;
    // otherwise fall through to the touch joystick values.
    // steerInput: +1 = turn left (A key), -1 = turn right (D key).
    // TouchInput.steer: +1 = right, so negate to match steerInput polarity.
    const accelInput = kbAccel !== 0 ? kbAccel : TouchInput.accel;
    const steerInput = kbSteer !== 0 ? kbSteer : -TouchInput.steer;

    // ── E-brake / drift ──────────────────────────────────────────────────────
    // Drifting is active when Space is held AND the car is moving fast enough.
    const eBrake = Bindings.isAction('eBrake');
    const aboveMinSpeed = Math.abs(this.speed) >= CAR.driftMinSpeed;
    const drifting = eBrake && aboveMinSpeed;

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

    // While drifting, bleed longitudinal speed (e-brake slows the car down).
    if (drifting) {
      const longDrag = CAR.eBrakeLongFriction * Math.abs(this.speed) * dt;
      if (Math.abs(this.speed) < longDrag) this.speed = 0;
      else this.speed -= Math.sign(this.speed) * longDrag;
    }

    // Boost overrides forward speed cap when game.boosting is active.
    const fwdCap = (game && game.boosting) ? CAR.maxSpeed * BOOST.speedMult : CAR.maxSpeed;
    this.speed = Math.max(-CAR.reverseMaxSpeed, Math.min(fwdCap, this.speed));

    // Record steer input for playerSprite frame selection.
    this.steerInput = steerInput;

    const speedFraction = Math.min(Math.abs(this.speed) / CAR.maxSpeed, 1);
    const reverseFactor = this.speed < 0 ? -1 : 1;

    // Drifting boosts turn rate so the nose swings faster during a slide.
    const turnMultiplier = drifting ? CAR.driftSteerBoost : 1;
    this.yaw += steerInput * CAR.turnRate * turnMultiplier * speedFraction * reverseFactor * dt;

    // Three.js right-handed, Y-up: yaw=0 faces -Z. Rotating Y by θ of (0,0,-1) → (-sin θ, 0, -cos θ).
    // Right vector is 90° CW from forward: (cos θ, 0, -sin θ) — but easier to cross with up.
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    // ── Lateral (slide) velocity ──────────────────────────────────────────────
    // When drifting, steer input pushes the car sideways (opposite to steer so
    // turning left slides right — typical oversteer feel).
    if (drifting && steerInput !== 0) {
      // Lateral kick proportional to current speed and steer input.
      // -steerInput because steer-left (positive) should slide right (positive right).
      this.lateralSpeed -= steerInput * Math.abs(this.speed) * CAR.eBrakeLateralFriction * dt * 8;
    }

    // Bleed lateral speed every frame. Slower bleed while drifting (preserves slide),
    // faster bleed when released (snaps back to normal driving).
    const lateralDragRate = drifting
      ? CAR.eBrakeLateralFriction
      : CAR.coastFriction * 2.5;  // snap back quickly on release
    const lateralDrag = lateralDragRate * dt * Math.abs(this.lateralSpeed);
    if (Math.abs(this.lateralSpeed) < lateralDrag + 0.01) {
      this.lateralSpeed = 0;
    } else {
      this.lateralSpeed -= Math.sign(this.lateralSpeed) * lateralDrag;
    }

    // Clamp lateral speed to a fraction of forward max speed.
    const maxLateral = CAR.maxSpeed * 0.7;
    this.lateralSpeed = Math.max(-maxLateral, Math.min(maxLateral, this.lateralSpeed));

    // ── Integrate position ────────────────────────────────────────────────────
    // Total velocity = forward component + lateral (strafe) component.
    this.position.addScaledVector(this.forward, this.speed * dt);
    this.position.addScaledVector(this._right, this.lateralSpeed * dt);
  }

  /**
   * First-person camera (legacy / for rewind scrub).
   * Camera sits at the vehicle position at eye height, looking forward.
   */
  applyToCamera(camera) {
    camera.position.set(this.position.x, CAR.cameraHeight, this.position.z);
    camera.rotation.set(0, this.yaw, 0);
  }

  /**
   * Third-person chase camera — sits behind and above the car.
   * The camera lags slightly in yaw so fast turns feel cinematic.
   * @param {import('three').Camera} camera
   * @param {number} [chaseDist]  metres behind the car (default CAR.chaseDistance)
   * @param {number} [chaseHeight] metres above the car (default CAR.chaseHeight)
   */
  applyChaseCamera(camera, chaseDist = CAR.chaseDistance, chaseHeight = CAR.chaseHeight) {
    // Forward at yaw=0 is (0,0,-1); behind the car is +sin/+cos · dist negated below.
    const ox = Math.sin(this.yaw) * chaseDist;
    const oz = Math.cos(this.yaw) * chaseDist;
    camera.position.set(
      this.position.x + ox,
      this.position.y + chaseHeight,
      this.position.z + oz,
    );
    const lookX = this.position.x - Math.sin(this.yaw) * CAR.chaseLookAhead;
    const lookZ = this.position.z - Math.cos(this.yaw) * CAR.chaseLookAhead;
    camera.lookAt(lookX, this.position.y + CAR.chaseLookHeight, lookZ);
  }
}
