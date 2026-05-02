/**
 * lib/car/playerSprite.js — Player car sprite with directional frames.
 *
 * Creates a THREE.Sprite at the vehicle position. Each frame the texture
 * is swapped based on lateral vehicle movement:
 *   straight       → player_straight.png
 *   drifting right → player_right.png
 *   drifting left  → player_right.png horizontally mirrored (separate CanvasTexture)
 *
 * Ordinary steering keeps the straight frame; side frames are reserved for
 * high lateral velocity with hysteresis/hold to avoid flicker.
 * The sprite follows vehicle.position each frame. THREE.Sprite always
 * billboards toward the camera, which is correct for the chase cam.
 *
 * Usage:
 *   const ps = createPlayerSprite(scene);
 *   ps.update(vehicle);   // call every frame before render
 *   ps.destroy();         // on city rebuild / cleanup
 */

import * as THREE from 'three';
import { PLAYER_TEXTURES } from '../assets/vehicleTextures.js';
import { CAR } from '../config.js';

const FRAME_STRAIGHT = 0;
const FRAME_RIGHT = 1;
const FRAME_LEFT = -1;
const UNINITIALIZED_FRAME = Symbol('uninitialized-player-frame');

/**
 * Build a horizontally-mirrored copy of a THREE.Texture using Canvas2D.
 * @param {THREE.Texture} src
 * @returns {THREE.CanvasTexture}
 */
function buildMirroredTexture(src) {
  // Wait until the image is available; if it's a CanvasTexture the image is
  // already a canvas element.
  const img = src.image;
  const w = img.width  || img.videoWidth  || 128;
  const h = img.height || img.videoHeight || 128;

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Flip horizontally: translate to right edge, scale X by -1, draw.
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(img, 0, 0, w, h);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * @param {import('three').Scene} scene
 * @returns {{ update: (vehicle: import('./vehicle.js').Vehicle) => void, destroy: () => void, sprite: import('three').Sprite, getActiveTexture: () => import('three').Texture }}
 */
export function createPlayerSprite(scene) {
  // Build the mirrored left-turn texture once from the right texture.
  // PLAYER_TEXTURES is already loaded by the time createPlayerSprite is called
  // (loadAllVehicleTextures() is awaited in main()).
  const leftTexture = buildMirroredTexture(PLAYER_TEXTURES.right);

  // One shared material — we swap .map each frame, no extra alloc.
  const mat = new THREE.SpriteMaterial({
    map: PLAYER_TEXTURES.straight,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });

  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(CAR.spriteScale, CAR.spriteScale, 1);
  sprite.userData.isPlayerSprite = true;
  scene.add(sprite);

  // Cached last frame so we only mutate the material when the frame changes.
  // 0=straight, 1=right, -1=left
  let _lastFrame = UNINITIALIZED_FRAME; // force first update
  let _sideFrame = FRAME_STRAIGHT;
  let _sideHoldUntil = 0;

  function _nowSeconds() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now() / 1000
      : Date.now() / 1000;
  }

  function _chooseSideFrame(lateralVelocity, nowSeconds) {
    const absLateralVelocity = Math.abs(lateralVelocity);
    const desiredSideFrame = lateralVelocity >= 0 ? FRAME_RIGHT : FRAME_LEFT;

    if (absLateralVelocity >= CAR.sideFrameEnterLateralSpeed) {
      _sideFrame = desiredSideFrame;
      _sideHoldUntil = nowSeconds + CAR.sideFrameHoldSeconds;
      return _sideFrame;
    }

    if (_sideFrame !== FRAME_STRAIGHT && absLateralVelocity >= CAR.sideFrameExitLateralSpeed) {
      _sideHoldUntil = nowSeconds + CAR.sideFrameHoldSeconds;
      return _sideFrame;
    }

    if (_sideFrame !== FRAME_STRAIGHT && nowSeconds < _sideHoldUntil) {
      return _sideFrame;
    }

    _sideFrame = FRAME_STRAIGHT;
    return _sideFrame;
  }

  function _applyFrame(frame) {
    if (frame === _lastFrame) return;
    _lastFrame = frame;

    if (frame === FRAME_RIGHT) {
      mat.map = PLAYER_TEXTURES.right;
    } else if (frame === FRAME_LEFT) {
      mat.map = leftTexture;
    } else {
      mat.map = PLAYER_TEXTURES.straight;
    }
    mat.needsUpdate = true;
  }

  /**
   * Call every game frame. Syncs sprite position to vehicle and picks frame.
   * @param {import('./vehicle.js').Vehicle} vehicle
   */
  function update(vehicle) {
    sprite.position.set(
      vehicle.position.x,
      vehicle.position.y + CAR.spriteScale / 2,
      vehicle.position.z,
    );

    // Side frame selection is drift-based: ordinary steering alone keeps the
    // straight sprite, while strong lateral velocity flips to the side frames.
    const lateralVelocity = Number.isFinite(vehicle.lateralVelocity) ? vehicle.lateralVelocity : 0;
    const frame = _chooseSideFrame(lateralVelocity, _nowSeconds());

    _applyFrame(frame);
  }

  function destroy() {
    scene.remove(sprite);
    mat.dispose();
    leftTexture.dispose();
  }

  /** Return the currently active texture (straight / right / left). */
  function getActiveTexture() {
    return mat.map;
  }

  return { update, destroy, sprite, getActiveTexture };
}
