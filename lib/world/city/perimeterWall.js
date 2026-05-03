/**
 * lib/world/city/perimeterWall.js
 *
 * With the 3km zone-aware world the perimeter is no longer a wall of buildings —
 * the world edge is handled by the map boundary clamping in collision.js and the
 * terrain/ocean geometry.  This module is kept so existing imports don't break
 * but it now returns an empty array and adds no meshes to the scene.
 */

/**
 * @param {import('three').Scene} _scene
 * @param {{ minX:number, maxX:number, minZ:number, maxZ:number }} _bounds
 * @param {(index:number)=>import('three').Texture} _getBuildingTexture
 * @returns {{ minX:number, maxX:number, minZ:number, maxZ:number }[]}
 */
export function buildPerimeterWall(_scene, _bounds, _getBuildingTexture) {
  // No wall in the zone-aware world — boundary is enforced by resolveMapBounds().
  return [];
}
