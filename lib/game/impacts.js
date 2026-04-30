/**
 * lib/game/impacts.js — impact sprite pool.
 *
 * createImpactSystem(scene) returns an object with:
 *   spawnImpact(pos, color?, scale?)  — add a new fade-out sprite at `pos`
 *   updateImpacts(dt)                 — advance all active sprites
 *   clearImpacts()                    — remove all sprites immediately
 *   pickAimPoint(camera, mouse)       — raycast scene for a shoot target
 */

import * as THREE from 'three';
import { PISTOL } from '../config.js';

/**
 * @param {THREE.Scene} scene
 */
export function createImpactSystem(scene) {
  const raycaster   = new THREE.Raycaster();
  raycaster.near    = PISTOL.shootNear;
  const ndc         = new THREE.Vector2();
  const fallbackAim = new THREE.Vector3();

  /** @type {{ sprite: THREE.Sprite, life: number }[]} */
  const impacts = [];

  /**
   * Spawn a short-lived additive sprite at world position `pos`.
   * @param {THREE.Vector3} pos
   * @param {number} [color=0xffaa55]
   * @param {number} [scale=1.4]
   */
  function spawnImpact(pos, color = 0xffaa55, scale = 1.4) {
    const mat = new THREE.SpriteMaterial({
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
    });
    const s = new THREE.Sprite(mat);
    s.userData.isImpact = true;
    s.position.copy(pos);
    s.scale.set(scale, scale, 1);
    scene.add(s);
    impacts.push({ sprite: s, life: PISTOL.impactLifetime });
  }

  /**
   * Advance all impact sprites by `dt` seconds; remove expired ones.
   * @param {number} dt
   */
  function updateImpacts(dt) {
    for (let i = impacts.length - 1; i >= 0; i--) {
      const it = impacts[i];
      it.life -= dt;
      it.sprite.material.opacity = Math.max(0, it.life / PISTOL.impactLifetime);
      if (it.life <= 0) {
        scene.remove(it.sprite);
        it.sprite.material.dispose();
        impacts.splice(i, 1);
      }
    }
  }

  /** Remove all active impact sprites immediately. */
  function clearImpacts() {
    for (const it of impacts) {
      scene.remove(it.sprite);
      it.sprite.material.dispose();
    }
    impacts.length = 0;
  }

  /**
   * Raycast from the camera through the mouse NDC position.
   * Returns the first non-pistol hit point (or a far fallback point) plus the
   * hit object so the caller can walk ancestry for mootHandle.
   *
   * @param {THREE.Camera} camera
   * @param {{ ndcX: number, ndcY: number }} mouse
   * @returns {{ point: THREE.Vector3, object: THREE.Object3D|null }}
   */
  function pickAimPoint(camera, mouse) {
    ndc.set(mouse.ndcX, mouse.ndcY);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(scene.children, true);
    for (const h of hits) {
      let o = h.object, skip = false;
      while (o) {
        if (o.userData && (
          o.userData.isPistol ||
          o.userData.isPlayerSprite ||
          o.userData.isImpact ||
          o.userData.isBullet ||
          o.userData.isTargetMarker
        )) { skip = true; break; }
        o = o.parent;
      }
      if (!skip) return { point: h.point.clone(), object: h.object };
    }
    fallbackAim.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, 200);
    return { point: fallbackAim.clone(), object: null };
  }

  return { spawnImpact, updateImpacts, clearImpacts, pickAimPoint };
}
