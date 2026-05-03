/**
 * lib/entities/targetMarker.js — Ground ring that highlights the current target moot.
 *
 * createTargetMarker(scene, options?) → { attach(handle), detach(), tick(dt), destroy() }
 *
 * options.getTerrainY(x,z) — optional terrain-height query used to keep the ring
 *                            above hilly ground instead of at world Y=0
 * attach(handle)  — moves the ring under the given moot handle's group
 * detach()        — hides the ring (no current target)
 * tick(dt)        — animates the flash; call every frame
 * destroy()       — removes mesh from scene, disposes geometry/material
 */

import * as THREE from 'three';
import { TARGET } from '../config.js';

/**
 * @param {import('three').Scene} scene
 * @param {{ getTerrainY?: (x:number,z:number)=>number }} [options]
 */
export function createTargetMarker(scene, options = {}) {
  const getTerrainY = typeof options.getTerrainY === 'function' ? options.getTerrainY : null;
  // Flat torus ring lying on the XZ plane (rotated so it's horizontal).
  const geo = new THREE.TorusGeometry(
    TARGET.ringRadius,
    TARGET.ringThickness,
    TARGET.ringTubeSegments ?? 10,
    TARGET.ringSegments,
  );
  const mat = new THREE.MeshBasicMaterial({
    color: TARGET.ringColor,
    transparent: true,
    opacity: TARGET.ringMaxOpacity ?? 1.0,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // Rotate so the ring lies flat on the ground (torus is vertical by default).
  mesh.rotation.x = Math.PI / 2;
  mesh.visible = false;
  mesh.renderOrder = TARGET.ringRenderOrder ?? 50;
  mesh.userData.isTargetMarker = true;
  scene.add(mesh);

  let _handle = null;
  let _time = 0;

  function terrainYFor(x, z, fallbackY = 0) {
    if (getTerrainY) {
      const terrainY = getTerrainY(x, z);
      if (Number.isFinite(terrainY)) return terrainY;
    }
    return Number.isFinite(fallbackY) ? fallbackY : 0;
  }

  function setMarkerPositionFromHandle(handle) {
    if (!handle || !handle.group) return;
    const p = handle.group.position;
    const y = terrainYFor(p.x, p.z, p.y) + (TARGET.ringYOffset ?? 0.35);
    mesh.position.set(p.x, y, p.z);
  }

  function attach(handle) {
    _handle = handle;
    mesh.visible = true;
    setMarkerPositionFromHandle(handle);
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

    // Track the moot's X/Z position while sampling terrain Y so the ring stays
    // visibly above hills instead of being buried at world Y=0.
    setMarkerPositionFromHandle(_handle);

    // Pulsing opacity flash.
    const minOpacity = TARGET.ringMinOpacity ?? 0.72;
    const maxOpacity = TARGET.ringMaxOpacity ?? 1.0;
    const flash01 = 0.5 + 0.5 * Math.sin(_time * Math.PI * 2 * TARGET.ringFlashHz);
    mat.opacity = minOpacity + (maxOpacity - minOpacity) * flash01;
  }

  function destroy() {
    scene.remove(mesh);
    geo.dispose();
    mat.dispose();
  }

  return { attach, detach, tick, destroy };
}
