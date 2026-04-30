/**
 * lib/entities/npcVehiclePool.js — Pool of NPC vehicles.
 *
 * Manages NPC_VEHICLE.count vehicles (default 20).
 * Provides:
 *   create(scene, navGrid)     — spawn all NPCs, call once per city build
 *   tick(dt, cameraYaw)        — update all living NPCs
 *   destroyAll()               — remove all from scene (city rebuild)
 *   getHandles()               — all NpcVehicleHandle objects (for collision/minimap)
 *   respawnAfterDelay(h, ms)   — schedule respawn of a destroyed vehicle
 */

import { createNpcVehicle, updateNpcVehicle, destroyNpcVehicle } from './npcVehicle.js';
import { NPC_VEHICLE } from '../config.js';

/**
 * @typedef {import('./npcVehicle.js').NpcVehicleHandle} NpcVehicleHandle
 */

/**
 * @param {{
 *   scene:   import('three').Scene,
 *   navGrid: object,
 * }} opts
 */
export function createNpcVehiclePool({ scene, navGrid }) {
  /** @type {NpcVehicleHandle[]} */
  const handles = [];
  let _scene = scene;
  let _navGrid = navGrid;

  // Spawn initial fleet.
  for (let i = 0; i < NPC_VEHICLE.count; i++) {
    handles.push(createNpcVehicle({ scene, navGrid }));
  }

  /**
   * Update all living NPC vehicles.
   * @param {number} dt
   * @param {number} cameraYaw
   */
  function tick(dt, cameraYaw) {
    for (const h of handles) {
      // Update alive NPCs AND spinning ones (spinning NPCs are still alive until timer expires).
      if (h.alive) updateNpcVehicle(h, dt, cameraYaw);
    }
  }

  /**
   * Immediately remove all NPC vehicles from the scene.
   * Frees GPU memory (sprite materials).
   */
  function destroyAll() {
    for (const h of handles) {
      if (h.alive) destroyNpcVehicle(h);
    }
    handles.length = 0;
  }

  /**
   * Return all handle objects (alive and dead) for external queries.
   * Callers should check h.alive before using.
   * @returns {NpcVehicleHandle[]}
   */
  function getHandles() {
    return handles;
  }

  /**
   * Schedule a respawn for a destroyed vehicle after `delayMs` milliseconds.
   * Picks a new random road point and type.
   * @param {NpcVehicleHandle} h
   * @param {number} delayMs
   */
  function respawnAfterDelay(h, delayMs) {
    setTimeout(() => {
      // If city was rebuilt in the meantime the scene ref is stale — only
      // respawn if this handle is still in the pool (its index is still valid).
      if (!handles.includes(h)) return;

      const idx = handles.indexOf(h);
      if (idx === -1) return;

      const newHandle = createNpcVehicle({ scene: _scene, navGrid: _navGrid });
      handles[idx] = newHandle;
    }, delayMs);
  }

  /**
   * Update scene/navGrid references on city rebuild.
   * Called by main.js immediately after a new city is generated.
   * @param {import('three').Scene} newScene
   * @param {object} newNavGrid
   */
  function setRefs(newScene, newNavGrid) {
    _scene = newScene;
    _navGrid = newNavGrid;
  }

  return { tick, destroyAll, getHandles, respawnAfterDelay, setRefs };
}
