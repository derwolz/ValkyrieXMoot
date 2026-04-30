/**
 * lib/car/playerSprite.js — Player car sprite with directional frames.
 *
 * Creates a THREE.Sprite at the vehicle position. Each frame the texture
 * is swapped based on steer input:
 *   straight      → player_straight.png
 *   turning right → player_right.png
 *   turning left  → player_right.png horizontally mirrored (separate CanvasTexture)
 *
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

// Steer threshold below which we show the straight frame.
const STEER_THRESHOLD = 0.15;

// Height above ground at which the sprite centre sits.
const SPRITE_HALF_HEIGHT = CAR.spriteScale / 2;

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
 * @returns {{ update: (vehicle: import('./vehicle.js').Vehicle) => void, destroy: () => void, sprite: import('three').Sprite }}
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
  let _lastFrame = 999; // force first update

  function _applyFrame(frame) {
    if (frame === _lastFrame) return;
    _lastFrame = frame;

    if (frame === 1) {
      mat.map = PLAYER_TEXTURES.right;
    } else if (frame === -1) {
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
      SPRITE_HALF_HEIGHT,
      vehicle.position.z,
    );

    // steerInput: +1=left, -1=right, 0=straight (set by Vehicle.update()).
    const si = vehicle.steerInput;
    let frame = 0;
    if (si < -STEER_THRESHOLD)     frame = 1;   // turning right
    else if (si > STEER_THRESHOLD) frame = -1;  // turning left

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
