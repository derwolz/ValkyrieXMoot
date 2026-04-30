/**
 * lib/entities/targetMarker.js — Ground ring that highlights the current target moot.
 *
 * createTargetMarker(scene) → { attach(handle), detach(), tick(dt), destroy() }
 *
 * attach(handle)  — moves the ring under the given moot handle's group
 * detach()        — hides the ring (no current target)
 * tick(dt)        — animates the flash; call every frame
 * destroy()       — removes mesh from scene, disposes geometry/material
 */

import * as THREE from 'three';
import { TARGET } from '../config.js';

/**
 * @param {import('three').Scene} scene
 */
export function createTargetMarker(scene) {
  // Flat torus ring lying on the XZ plane (rotated so it's horizontal).
  const geo = new THREE.TorusGeometry(
    TARGET.ringRadius,
    TARGET.ringThickness,
    6,              // tube segments (low — it's thin)
    TARGET.ringSegments,
  );
  const mat = new THREE.MeshBasicMaterial({
    color: TARGET.ringColor,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // Rotate so the ring lies flat on the ground (torus is vertical by default).
  mesh.rotation.x = Math.PI / 2;
  mesh.visible = false;
  mesh.userData.isTargetMarker = true;
  scene.add(mesh);

  let _handle = null;
  let _time = 0;

  function attach(handle) {
    _handle = handle;
    mesh.visible = true;
    if (handle && handle.group) {
      const p = handle.group.position;
      mesh.position.set(p.x, 0.05, p.z);  // just above ground
    }
  }

  function detach() {
    _handle = null;
    mesh.visible = false;
  }

  /**
   * Animate the ring and keep it under the target's feet.
   * @param {number} dt seconds
   */
  function tick(dt) {
    if (!_handle) return;
    _time += dt;

    // Track the moot's position.
    if (_handle.group) {
      const p = _handle.group.position;
      mesh.position.set(p.x, 0.05, p.z);
    }

    // Pulsing opacity flash.
    const flash = 0.55 + 0.45 * Math.sin(_time * Math.PI * 2 * TARGET.ringFlashHz);
    mat.opacity = flash;
  }

  function destroy() {
    scene.remove(mesh);
    geo.dispose();
    mat.dispose();
  }

  return { attach, detach, tick, destroy };
}
