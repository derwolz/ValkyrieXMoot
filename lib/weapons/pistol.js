import * as THREE from 'three';
import { PISTOL } from '../config.js';

// Pistol is a Group parented to the camera so it occupies a fixed screen slot.
// Every frame we call aimAt(worldPoint) to orient the barrel toward the cursor's
// projected world position. lookAt works on children-of-transformed-parents
// provided the parent's matrixWorld is up to date (we ensure this in main.js).
export class Pistol {
  constructor(camera) {
    this.group = new THREE.Group();
    this.group.userData.isPistol = true;

    const bodyMat = new THREE.MeshBasicMaterial({ color: PISTOL.bodyColor });
    const barrelMat = new THREE.MeshBasicMaterial({ color: PISTOL.barrelColor });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.22), bodyMat);
    body.userData.isPistol = true;
    this.group.add(body);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.18, 12), barrelMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0, -0.19);
    barrel.userData.isPistol = true;
    this.group.add(barrel);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.13, 0.055), bodyMat);
    grip.position.set(0, -0.09, 0.05);
    grip.userData.isPistol = true;
    this.group.add(grip);

    const flashMat = new THREE.SpriteMaterial({
      color: 0xffeca0,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
    });
    this.muzzle = new THREE.Sprite(flashMat);
    this.muzzle.scale.set(0.3, 0.3, 1);
    this.muzzle.position.set(0, 0, -0.3);
    this.muzzle.userData.isPistol = true;
    this.group.add(this.muzzle);

    this.group.position.set(PISTOL.anchorX, PISTOL.anchorY, PISTOL.anchorZ);
    camera.add(this.group);

    this._muzzleTimeLeft = 0;
    this._cooldown = 0;
  }

  aimAt(worldTarget) {
    this.group.lookAt(worldTarget);
  }

  tryFire() {
    if (this._cooldown > 0) return false;
    this.muzzle.material.opacity = 1;
    this._muzzleTimeLeft = PISTOL.muzzleFlashLifetime;
    this._cooldown = PISTOL.cooldownSeconds;
    return true;
  }

  update(dt) {
    if (this._muzzleTimeLeft > 0) {
      this._muzzleTimeLeft -= dt;
      this.muzzle.material.opacity = Math.max(0, this._muzzleTimeLeft / PISTOL.muzzleFlashLifetime);
    }
    if (this._cooldown > 0) this._cooldown -= dt;
  }
}
