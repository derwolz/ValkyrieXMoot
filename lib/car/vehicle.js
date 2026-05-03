import * as THREE from 'three';
import { CAR, BOOST, SCORING } from '../config.js';
import { TouchInput } from '../input/touch.js';
import { Bindings } from '../input/bindings.js';

// Arcade car with world-space velocity.
// `this.velocity` is a THREE.Vector3 in world space.
// `speed` (getter/setter) is the signed forward component.
// Lateral velocity bleeds off via exponential decay — slow during drift (preserves
// slide) and fast in grip (snaps back to straight driving).
//
// Terrain physics (added):
//   - this.velY       — vertical velocity (m/s), positive = up
//   - this.isAirborne — true when the car is above the terrain surface
//   - this.jumpScored — set to true when airtime > SCORING.jumpMinAirtime; reset on land
//   - setTerrainQuery(fn) — supply a getTerrainY(x,z)→number function each frame
export class Vehicle {
  constructor() {
    this.position = new THREE.Vector3(...CAR.startPos);
    this.yaw = CAR.startYaw;
    this.velocity = new THREE.Vector3(0, 0, 0); // world-space XZ velocity
    this.velY = 0; // vertical velocity (m/s)
    this.isAirborne = false;
    this.jumpScored = false;
    this._airtime = 0; // accumulated airborne seconds
    this.steerInput = 0; // last frame steer input, exposed for playerSprite
    this.angularVelocityY = 0; // yaw angular velocity (rad/s), exposed for body collisions
    this.impactVelocity = new THREE.Vector3(0, 0, 0); // reserved world-space impact state
    this.forward = new THREE.Vector3(0, 0, -1);
    this._right = new THREE.Vector3(1, 0, 0); // kept in sync with yaw
    this._wasDrifting = false;
    this._lastSupportNormal = new THREE.Vector3(0, 1, 0);
    this._getTerrainY = null; // set via setTerrainQuery()
  }

  /**
   * Supply a terrain height function.  Call once after buildTerrain().
   * @param {(x:number,z:number,referenceY?:number)=>number|{y?:number,height?:number,normal?:THREE.Vector3|{x:number,y:number,z:number}}|null} fn
   */
  setTerrainQuery(fn) {
    this._getTerrainY = fn;
  }

  /**
   * Convert terrain/surface query output into a normalized support descriptor.
   * Legacy callers may still return a number; newer surface queries can return
   * { y|height, normal } without changing the vehicle controller API.
   * @param {number|{y?:number,height?:number,normal?:THREE.Vector3|{x:number,y:number,z:number}}} sample
   * @returns {{height:number,normal:THREE.Vector3}|null}
   */
  _readSurfaceSample(sample) {
    if (typeof sample === 'number' && Number.isFinite(sample)) {
      return { height: sample, normal: new THREE.Vector3(0, 1, 0) };
    }
    if (!sample || typeof sample !== 'object') return null;

    const height = Number.isFinite(sample.y) ? sample.y : sample.height;
    if (!Number.isFinite(height)) return null;

    const normal = sample.normal
      ? new THREE.Vector3(sample.normal.x, sample.normal.y, sample.normal.z)
      : new THREE.Vector3(0, 1, 0);
    if (normal.lengthSq() < CAR.supportNormalMinLengthSq || normal.y <= CAR.supportNormalMinY) {
      normal.set(0, 1, 0);
    } else {
      normal.normalize();
    }
    return { height, normal };
  }

  /**
   * @param {number} x
   * @param {number} z
   * @param {number} [referenceY]
   * @returns {{height:number,normal:THREE.Vector3}|null}
   */
  _sampleSurface(x, z, referenceY = this.position.y) {
    if (!this._getTerrainY) return null;
    const direct = this._readSurfaceSample(this._getTerrainY(x, z, referenceY));
    if (!direct) return null;

    // Numeric terrain queries do not provide normals, so estimate one from the
    // local height field. Object samples can provide an exact normal (used by
    // highway ribbon support surfaces).
    if (direct.normal.y === 1 && direct.normal.x === 0 && direct.normal.z === 0) {
      direct.normal.copy(this._estimateSurfaceNormal(x, z, referenceY));
    }
    return direct;
  }

  /** @param {number} x @param {number} z @param {number} [referenceY] */
  _estimateSurfaceNormal(x, z, referenceY = this.position.y) {
    if (!this._getTerrainY) return new THREE.Vector3(0, 1, 0);
    const d = CAR.slopeSampleDistance;
    const left = this._readSurfaceSample(this._getTerrainY(x - d, z, referenceY));
    const right = this._readSurfaceSample(this._getTerrainY(x + d, z, referenceY));
    const back = this._readSurfaceSample(this._getTerrainY(x, z - d, referenceY));
    const front = this._readSurfaceSample(this._getTerrainY(x, z + d, referenceY));
    if (!left || !right || !back || !front) return new THREE.Vector3(0, 1, 0);

    const dhdx = (right.height - left.height) / (2 * d);
    const dhdz = (front.height - back.height) / (2 * d);
    return new THREE.Vector3(-dhdx, 1, -dhdz).normalize();
  }

  /** @param {number} dt */
  _groundSnapDistance(dt) {
    const speedDistance = this.velocity.length() * Math.max(0, dt) * CAR.groundedStickSpeedScale;
    return CAR.groundedStickDistance + speedDistance;
  }

  /** @param {THREE.Vector3} normal */
  _projectVelocityOntoSurface(normal) {
    const projected = this._getSurfaceProjectedVelocity(normal, this.velY);
    this.velocity.x = projected.x;
    this.velocity.z = projected.z;
    this.velY = projected.y;
  }

  /**
   * Return the current 3D velocity constrained to a support plane without mutating
   * controller state.  Crest launch detection uses this to notice when a newly
   * flatter support would abruptly erase upward ramp momentum.
   * @param {THREE.Vector3} normal
   * @param {number} verticalVelocity
   */
  _getSurfaceProjectedVelocity(normal, verticalVelocity) {
    const surfaceNormal = normal.y > CAR.supportNormalMinY ? normal : new THREE.Vector3(0, 1, 0);
    const velocity3 = new THREE.Vector3(this.velocity.x, verticalVelocity, this.velocity.z);
    velocity3.addScaledVector(surfaceNormal, -velocity3.dot(surfaceNormal));
    return velocity3;
  }

  // ── speed getter/setter ───────────────────────────────────────────────────
  /** Signed speed along the car's facing direction (m/s). */
  get speed() {
    return this.velocity.dot(this.forward);
  }

  /**
   * Set forward speed while preserving any lateral component.
   * @param {number} v
   */
  set speed(v) {
    // Decompose current velocity into lateral component, then reconstruct.
    const lat = this.velocity.dot(this._right);
    this.velocity.copy(this.forward).multiplyScalar(v);
    this.velocity.addScaledVector(this._right, lat);
  }

  /** Signed lateral speed along the car's right vector (m/s). */
  get lateralVelocity() {
    return this.velocity.dot(this._right);
  }

  /**
   * 3D-ready body descriptor for vehicle-vs-vehicle collision.
   * The X/Z half-extents represent the oriented footprint; Y is included so this
   * can be promoted to full 3D collision later without changing callers.
   */
  getBodyDescriptor() {
    return {
      center: this.position.clone(),
      yaw: this.yaw,
      velocity: new THREE.Vector3(this.velocity.x, this.velY, this.velocity.z),
      angularVelocityY: this.angularVelocityY,
      halfExtents: {
        x: CAR.bodyHalfWidth,
        y: CAR.bodyHalfHeight,
        z: CAR.bodyHalfLength,
      },
      mass: CAR.bodyMass,
      restitution: CAR.bodyRestitution,
    };
  }

  /**
   * Lowest player-truck point considered for building side collisions.
   * position.y tracks the support/contact pivot, so this configurable offset keeps
   * roof-clearance checks aligned with the player controller without hardcoding
   * sprite or body-shape assumptions in collision resolution.
   */
  getBuildingCollisionBottomY() {
    return this.position.y + CAR.buildingCollisionBodyBottomOffset;
  }

  reset() {
    this.position.set(...CAR.startPos);
    this.yaw = CAR.startYaw;
    this.velocity.set(0, 0, 0);
    this.velY = 0;
    this.isAirborne = false;
    this.jumpScored = false;
    this._airtime = 0;
    this.angularVelocityY = 0;
    this.impactVelocity.set(0, 0, 0);
    this._wasDrifting = false;
    this._lastSupportNormal.set(0, 1, 0);
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  /** Snap to a recorded position/yaw without affecting speed (used by rewind). */
  setPositionYaw(x, z, yaw) {
    this.position.x = x;
    this.position.z = z;
    this.yaw = yaw;
    this.velocity.set(0, 0, 0); // rewind clears any active slide
    this.velY = 0;
    this.isAirborne = false;
    this._airtime = 0;
    this.angularVelocityY = 0;
    this.impactVelocity.set(0, 0, 0);
    this._wasDrifting = false;
    this._lastSupportNormal.set(0, 1, 0);
    this.forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    // Snap Y to terrain immediately if we have a terrain query.
    const surface = this._sampleSurface(x, z);
    if (surface) {
      this.position.y = surface.height;
    }
  }

  /** @param {number} dt
   *  @param {{ charge: number, boosting: boolean }|null} [game] */
  update(dt, game = null) {
    const kbAccel = (Bindings.isAction('accel') ? 1 : 0) - (Bindings.isAction('brake') ? 1 : 0);
    const kbSteer =
      (Bindings.isAction('steerLeft') ? 1 : 0) - (Bindings.isAction('steerRight') ? 1 : 0);

    const accelInput = kbAccel !== 0 ? kbAccel : TouchInput.accel;
    const steerInput = kbSteer !== 0 ? kbSteer : -TouchInput.steer;

    if (this._getTerrainY && !this.isAirborne) {
      const support = this._sampleSurface(this.position.x, this.position.z);
      if (support) this.position.y = support.height;
    }

    // ── E-brake / drift ──────────────────────────────────────────────────────
    const eBrake = Bindings.isAction('eBrake');
    // Decompose velocity into signed forward (spd) and lateral (lat) scalars.
    let spd = this.velocity.dot(this.forward);
    let lat = this.velocity.dot(this._right);

    const aboveMinSpeed = Math.abs(spd) >= CAR.driftMinSpeed;
    const drifting = !this.isAirborne && eBrake && aboveMinSpeed;

    // Detect drift entry/exit transitions.
    const justEntered = drifting && !this._wasDrifting;
    const justExited = !drifting && this._wasDrifting;
    this._wasDrifting = drifting;

    // ── Slope gravity (hill physics) ─────────────────────────────────────────
    // Project gravity onto the current support plane. Uphill travel loses speed;
    // downhill travel gains speed. This uses the surface normal rather than a
    // one-frame height-drop heuristic, so it cannot create artificial launches.
    if (this._getTerrainY && !this.isAirborne) {
      const support = this._sampleSurface(this.position.x, this.position.z);
      if (support) {
        const forwardTangent = this.forward.clone().projectOnPlane(support.normal);
        if (forwardTangent.lengthSq() > CAR.slopeTangentMinLengthSq) {
          forwardTangent.normalize();
          spd += -CAR.gravity * forwardTangent.y * dt;
        }
      }
    }

    // ── Longitudinal acceleration ─────────────────────────────────────────
    const accelerationScale = this.isAirborne ? CAR.airborneAccelScale : 1;
    if (accelInput !== 0) {
      const opposing = (accelInput > 0 && spd < 0) || (accelInput < 0 && spd > 0);
      const rate = opposing ? CAR.brake : CAR.accel;
      spd += accelInput * rate * accelerationScale * dt;
    } else {
      const drag = CAR.coastFriction * dt;
      if (Math.abs(spd) < drag) spd = 0;
      else spd -= Math.sign(spd) * drag;
    }

    // E-brake bleeds longitudinal speed.
    if (drifting) {
      const longDrag = CAR.eBrakeLongFriction * Math.abs(spd) * dt;
      if (Math.abs(spd) < longDrag) spd = 0;
      else spd -= Math.sign(spd) * longDrag;
    }

    // Boost overrides forward speed cap.
    const fwdCap = game?.boosting ? CAR.maxSpeed * BOOST.speedMult : CAR.maxSpeed;
    spd = Math.max(-CAR.reverseMaxSpeed, Math.min(fwdCap, spd));

    // Record steer input for playerSprite frame selection.
    this.steerInput = steerInput;

    // ── Drift entry: lateral kick ─────────────────────────────────────────
    // On the first frame we enter drift, inject a sideways impulse proportional
    // to speed and steer so the rear "kicks out".
    if (justEntered && steerInput !== 0) {
      // -steerInput: steer-left (positive) should kick rightward (positive lat).
      lat += -steerInput * Math.abs(spd) * CAR.driftLateralKick;
    }

    // ── Drift exit: forward boost ─────────────────────────────────────────
    // Convert lingering lateral speed into a burst of forward speed.
    if (justExited && Math.abs(lat) > 0.5) {
      const boost = Math.abs(lat) * CAR.driftExitBoostFrac;
      spd = Math.min(fwdCap, spd + boost);
    }

    // ── Yaw ───────────────────────────────────────────────────────────────
    const prevYaw = this.yaw;
    const reverseFactor = spd < 0 ? -1 : 1;
    const steeringScale = this.isAirborne ? CAR.airborneSteerScale : 1;
    if (drifting) {
      // Speed-independent yaw while drifting — allows nose to swing freely.
      this.yaw += steerInput * CAR.turnRate * CAR.driftYawMult * steeringScale * dt;
    } else {
      const speedFraction = Math.min(Math.abs(spd) / CAR.maxSpeed, 1);
      this.yaw += steerInput * CAR.turnRate * speedFraction * reverseFactor * steeringScale * dt;
    }

    if (dt > 0) {
      this.angularVelocityY = (this.yaw - prevYaw) / dt;
    } else {
      this.angularVelocityY = 0;
    }

    // Rebuild basis vectors after yaw change.
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    // ── Lateral exponential decay ─────────────────────────────────────────
    // Exponential decay is frame-rate independent: lat *= e^(-decayRate * dt).
    // Drifting uses a slow decay (slide preserved); grip snaps lateral to zero.
    const decayRate = this.isAirborne
      ? CAR.airborneLateralDecay
      : drifting
        ? CAR.driftLateralDecay
        : CAR.gripLateralDecay;
    lat *= Math.exp(-decayRate * dt);

    // Clamp lateral speed.
    const maxLat = CAR.maxSpeed * CAR.driftMaxLateralFrac;
    lat = Math.max(-maxLat, Math.min(maxLat, lat));

    // ── Reconstruct world-space XZ velocity ──────────────────────────────
    this.velocity.copy(this.forward).multiplyScalar(spd);
    this.velocity.addScaledVector(this._right, lat);

    const prevY = this.position.y;
    const prevVelY = this.velY;

    // ── Integrate XZ position ─────────────────────────────────────────────
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // ── Vertical / surface physics ─────────────────────────────────────────
    if (this._getTerrainY) {
      const support = this._sampleSurface(this.position.x, this.position.z);
      const groundY = support ? support.height : 0;

      if (this.isAirborne) {
        // Airborne: integrate vertical velocity under gravity only. No terrain
        // deltas or edge heuristics can add upward speed while unsupported.
        this.velY -= CAR.gravity * dt;
        this.position.y += this.velY * dt;

        // Track jump airtime.
        this._airtime += dt;
        if (!this.jumpScored && this._airtime >= SCORING.jumpMinAirtime) {
          this.jumpScored = true;
        }

        // Landing check: did we reach or pass below the support surface?
        if (support && this.position.y <= groundY && this.velY <= 0) {
          const impactSpeed = -this.velY;
          this.position.y = groundY;
          this.velY = 0;
          this.isAirborne = false;
          this._airtime = 0;
          if (impactSpeed >= CAR.hardLandingSpeed) {
            this.velocity.multiplyScalar(CAR.hardLandingHorizontalDamping);
          }
          this._projectVelocityOntoSurface(support.normal);
          this._lastSupportNormal.copy(support.normal);
          // jumpScored stays true so caller can read it; caller resets it.
        }
      } else if (support) {
        const predictedVelY = prevVelY - CAR.gravity * dt;
        const ballisticY = prevY + prevVelY * dt - 0.5 * CAR.gravity * dt * dt;
        const clearance = ballisticY - groundY;
        const supportFellAway = prevY - groundY > this._groundSnapDistance(dt);
        const projectedOnNewSupport = this._getSurfaceProjectedVelocity(support.normal, prevVelY);
        const newSupportWouldKillUpwardMomentum =
          prevVelY > CAR.minLaunchUpVelocity &&
          projectedOnNewSupport.y < prevVelY - CAR.crestLaunchVelocityDrop &&
          predictedVelY > 0;
        const upwardMomentumCarriesOffSurface =
          prevVelY > CAR.minLaunchUpVelocity && clearance > CAR.surfaceDetachClearance;
        const crestLaunch =
          newSupportWouldKillUpwardMomentum && clearance > -CAR.crestLaunchPenetrationTolerance;

        if (supportFellAway || upwardMomentumCarriesOffSurface || crestLaunch) {
          this.position.y = crestLaunch
            ? Math.max(ballisticY, groundY + CAR.crestLaunchLift)
            : ballisticY;
          this.velY = predictedVelY;
          this.isAirborne = true;
          this._airtime = 0;
          this.jumpScored = false;
          this._lastSupportNormal.set(0, 1, 0);
        } else {
          // Grounded contact constrains the truck to the support plane. The
          // resulting vertical velocity comes from the surface tangent under the
          // current X/Z momentum, not from a one-frame terrain drop boost.
          this.position.y = groundY;
          this._projectVelocityOntoSurface(support.normal);
          this._lastSupportNormal.copy(support.normal);
        }
      }
    } else {
      // No terrain query — keep flat (legacy behaviour).
      this.position.y = 0;
      this.velY = 0;
    }
  }

  /**
   * First-person camera (legacy / for rewind scrub).
   */
  applyToCamera(camera) {
    camera.position.set(this.position.x, this.position.y + CAR.cameraHeight, this.position.z);
    camera.rotation.set(0, this.yaw, 0);
  }

  /**
   * Third-person chase camera — sits behind and above the car.
   * Follows vehicle Y so camera tracks hills and jumps correctly.
   * @param {import('three').Camera} camera
   * @param {number} [chaseDist]
   * @param {number} [chaseHeight]
   */
  applyChaseCamera(camera, chaseDist = CAR.chaseDistance, chaseHeight = CAR.chaseHeight) {
    const ox = Math.sin(this.yaw) * chaseDist;
    const oz = Math.cos(this.yaw) * chaseDist;
    camera.position.set(this.position.x + ox, this.position.y + chaseHeight, this.position.z + oz);
    const lookX = this.position.x - Math.sin(this.yaw) * CAR.chaseLookAhead;
    const lookZ = this.position.z - Math.cos(this.yaw) * CAR.chaseLookAhead;
    camera.lookAt(lookX, this.position.y + CAR.chaseLookHeight, lookZ);
  }
}
