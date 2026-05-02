/**
 * lib/world/chunks/chunkManager.js
 *
 * ChunkManager — spatial visibility toggle for world meshes.
 *
 * update() is intentionally cheap in the hot path: it only rescans chunks after
 * the player crosses into a different chunk or moves farther than
 * CHUNKS.updateMoveThreshold inside the same chunk. Keep CHUNKS.activeRadius far
 * enough beyond the camera fog distance to cover that skipped movement.
 *
 * Usage:
 *   const cm = createChunkManager(scene);
 *   cm.register(mesh);                // call after adding each mesh to scene
 *   cm.update(playerX, playerZ);      // call once per frame (< 1 ms)
 *   cm.dispose();                     // on rebuild
 *
 * Each registered mesh is assigned to the chunk that contains its XZ position
 * (from mesh.position or the AABB centre for InstancedMesh).  A chunk is a
 * square region of CHUNKS.size × CHUNKS.size metres.
 *
 * On update(), all chunks whose centre is within CHUNKS.activeRadius of the
 * player are made visible; all others are hidden.  At 3km × 3km with a 64m
 * chunk size and 750m active radius, only ~(1500/64)^2 × π * (750/1500)^2
 * ≈ 28% of chunks are visible at once.
 *
 * Instanced building batches and explicitly global-spanning meshes intentionally
 * opt out of chunk assignment. They are global batches spread across a broad
 * area, so assigning them to their Object3D origin chunk would make the entire
 * object blink when that origin chunk is hidden. The tradeoff is a small fixed
 * set of global draw calls stays visible instead of being chunk-culled.
 *
 * No per-frame allocation: chunk assignment is computed once at register time.
 */

import { CHUNKS } from '../../config.js';

/**
 * @typedef {{ cx: number, cz: number, visible: boolean, objects: THREE.Object3D[] }} Chunk
 */

/**
 * Create a ChunkManager for the given scene.
 * @returns {{ register:(obj:import('three').Object3D)=>void, update:(px:number,pz:number)=>void, dispose:()=>void }}
 */
export function createChunkManager() {
  const size   = CHUNKS.size;
  const rSq    = CHUNKS.activeRadius * CHUNKS.activeRadius;
  const moveThresholdSq = (CHUNKS.updateMoveThreshold ?? 0) * (CHUNKS.updateMoveThreshold ?? 0);

  /** @type {Map<string, Chunk>} */
  const chunks = new Map();
  let lastPlayerChunkX = NaN;
  let lastPlayerChunkZ = NaN;
  let lastUpdateX = NaN;
  let lastUpdateZ = NaN;

  function chunkKey(cx, cz) {
    return `${cx},${cz}`;
  }

  function getOrCreateChunk(cx, cz) {
    const k = chunkKey(cx, cz);
    if (!chunks.has(k)) {
      chunks.set(k, { cx: cx * size + size / 2, cz: cz * size + size / 2, visible: true, objects: [] });
    }
    return chunks.get(k);
  }

  /**
   * Register a Three.js Object3D with the chunk manager.
   * The object's world XZ position is used to assign it to a chunk.
   * @param {import('three').Object3D} obj
   */
  function register(obj) {
    if (obj.userData?.isBuildingInstanced || obj.userData?.isHighway || obj.userData?.isGlobalSpanning) {
      // City-wide/global batches and highway ribbons span many chunks. Leaving
      // them always visible avoids incorrectly culling the full object by its
      // Object3D origin chunk while normal local decor still uses chunks.
      obj.visible = true;
      return;
    }

    const x = obj.position ? obj.position.x : 0;
    const z = obj.position ? obj.position.z : 0;
    // Convert world position to chunk grid coords.
    const cx = Math.floor(x / size);
    const cz = Math.floor(z / size);
    getOrCreateChunk(cx, cz).objects.push(obj);
  }

  /**
   * Update visibility for all chunks based on player position.
   * Called once per frame — pure distance check, no raycasting.
   * @param {number} px  player world X
   * @param {number} pz  player world Z
   */
  function update(px, pz) {
    const playerChunkX = Math.floor(px / size);
    const playerChunkZ = Math.floor(pz / size);
    if (playerChunkX === lastPlayerChunkX && playerChunkZ === lastPlayerChunkZ) {
      const dxMoved = px - lastUpdateX;
      const dzMoved = pz - lastUpdateZ;
      if ((dxMoved * dxMoved + dzMoved * dzMoved) < moveThresholdSq) return;
    }

    lastPlayerChunkX = playerChunkX;
    lastPlayerChunkZ = playerChunkZ;
    lastUpdateX = px;
    lastUpdateZ = pz;

    for (const chunk of chunks.values()) {
      const dx = chunk.cx - px;
      const dz = chunk.cz - pz;
      const shouldBeVisible = (dx * dx + dz * dz) <= rSq;
      if (chunk.visible !== shouldBeVisible) {
        chunk.visible = shouldBeVisible;
        for (const obj of chunk.objects) {
          obj.visible = shouldBeVisible;
        }
      }
    }
  }

  /**
   * Remove all chunk data.  Does NOT remove objects from scene — caller does that.
   */
  function dispose() {
    chunks.clear();
  }

  /**
   * Return the number of currently visible chunks (useful for diagnostics).
   * @returns {number}
   */
  function visibleCount() {
    let n = 0;
    for (const chunk of chunks.values()) {
      if (chunk.visible) n++;
    }
    return n;
  }

  return { register, update, dispose, visibleCount };
}
