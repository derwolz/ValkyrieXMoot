/**
 * lib/world/population.js — Standing population manager.
 *
 * Maintains POP.standing (60) active moots at all times around the player.
 *
 * Key responsibilities:
 *   - Pre-allocate a pool of (POP.standing + 8) moot handles at init time. *   - Boot: spawn POP.standing moots in the [spawnRingMin, spawnRingMax] ring.
 *   - Objective target: spawned explicitly at a map-wide interest point and protected from distance despawn.
 *   - Tick (at POP.tickHz): despawn moots beyond despawnRadius; refill to standing.
 *   - Death: mark moot inactive and queue a respawn on the next tick pass.
 *   - Boss: spawned separately, never enters the pool, never despawned automatically.
 *
 * Resource pool design:
 *   - Every handle is built via buildMoot at init; geometry is never created/destroyed
 *     after that point.
 *   - On despawn: scene.remove, alive=false, state reset to 'unaware', returned to freePool.
 *   - On spawn: pulled from freePool, avatar swapped, placed at world pos, scene.add.
 *
 * Usage:
 *   const pop = createPopulation({ scene, db, navGrid, buildingAABBs, onSplatMoot });
 *   await pop.loadTextures();         // concurrent texture loading
 *   pop.spawnBoss(bossRow, bossPos);  // place the boss
 *   // game loop:
 *   pop.tick(truckPos, now);          // call at POP.tickHz
 *   const moots = pop.getHandles();   // all active moots (includes boss)
 *   pop.notifyDeath(handle);          // call when a moot's hp drops to 0
 *
 * @module population
 */

import * as THREE from 'three';
import { POP, MOOT, AI, BOSS } from '../config.js';
import { buildMoot } from '../entities/moots.js';
import { avatarSource } from '../data/mootLoader.js';
import { loadChibiTexture } from '../chibiTexture.js';
import { loadVideoTexture } from '../videoTexture.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import { getTerrainY } from './terrain/heightmap.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick a random interest point in the spawn ring around truckPos.
 * Returns null if no eligible point found after maxTries.
 *
 * @param {{ x: number, z: number }} truckPos
 * @param {{ x: number, z: number, kind: string }[]} interestPoints
 * @param {number} maxTries
 * @returns {{ x: number, z: number } | null}
 */
function pickSpawnPoint(truckPos, interestPoints, maxTries = 60) {
  const rMin = POP.spawnRingMin;
  const rMax = POP.spawnRingMax;
  const rMinSq = rMin * rMin;
  const rMaxSq = rMax * rMax;

  if (interestPoints.length === 0) return null;

  for (let i = 0; i < maxTries; i++) {
    const pt = interestPoints[Math.floor(Math.random() * interestPoints.length)];
    const dx = pt.x - truckPos.x;
    const dz = pt.z - truckPos.z;
    const dSq = dx * dx + dz * dz;
    if (dSq >= rMinSq && dSq <= rMaxSq) return pt;
  }
  return null;
}

/**
 * Reset a moot handle's AI state to unaware/idle for reuse.
 * Does NOT touch geometry; just clears gameplay fields.
 *
 * @param {object} handle
 */
function resetHandleState(handle) {
  handle.alive = true;
  handle.state = 'unaware';
  handle.threat = 0;
  handle.path = [];
  handle.pathIndex = 0;
  handle.destination = null;
  handle.lastReplanAt = 0;
  handle.lastSeenTruckAt = 0;
  handle.stateEnteredAt = 0;
  handle.gunCooldown = Math.random() * MOOT.armedCooldownSec;
  handle._alarmExitTimer = 0;
  handle._recoveryTimer = 0;
  handle._glanceTimer = 0;
  handle._perceptionHasLos = undefined;
  handle._perceptionLosTimer = AI.perceptionLosInterval;
  handle._armedHasLos = undefined;
  handle._armedLosTimer = 0;
  handle._armedLosCheckTimer = AI.armedLosInterval;
  handle._ambientReplanTimer = Math.random() * AI.ambientInitialReplanJitter;
  handle._fleeReplanDelay =
    AI.fleeReplanMin + Math.random() * Math.max(0, AI.fleeReplanMax - AI.fleeReplanMin);
  handle.avatarMat.rotation = 0;
  handle._fling = undefined;
  handle._onFlingComplete = undefined;
  handle.bossAggro = false;
  handle.bossMode = null;
  handle.bossLastKnownPos = null;
  handle._bossReplanTimer = 0;
  handle.isObjectiveTarget = false;
}

// ---------------------------------------------------------------------------
// createPopulation
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   scene:          import('three').Scene,
 *   db:             import('../data/mootLoader.js').MootRow[],
 *   navGrid:        object,
 *   buildingAABBs:  object[],
 *   onSplatMoot?:   (handle: object, weapon: string) => void,
 * }} opts
 */
export function createPopulation({
  scene,
  db,
  navGrid,
  buildingAABBs: _buildingAABBs,
  onSplatMoot: _onSplatMoot,
}) {
  // Partition db into boss pool and regular pool.
  // Boss eligibility: any row works; we'll separate at spawnBoss call time.
  const regularPool = db.slice(); // shuffled copy — used as a round-robin source

  // Pre-allocate pool size.
  const POOL_SIZE = POP.standing + 8;

  // Pre-built handle records in free pool (not yet / no longer active).
  const freePool = /** @type {object[]} */ ([]);

  // Active regular moots (not boss).
  const activeRegulars = /** @type {Set<object>} */ (new Set());

  // Reused live-handle buffer for per-frame callers that don't need ownership.
  const liveHandlesBuffer = /** @type {object[]} */ ([]);

  // Boss handle (null until spawnBoss is called).
  let bossHandle = null;

  // Row cursor for round-robin regular spawning.
  let rowCursor = 0;

  // Tick accumulator.
  let tickTimer = 0;
  const tickInterval = 1 / POP.tickHz;

  // ---------------------------------------------------------------------------
  // Initialise pool handles (no textures yet — just geometry)
  // ---------------------------------------------------------------------------
  for (let i = 0; i < POOL_SIZE; i++) {
    // Use a placeholder row — texture gets applied on first activation.
    const row = regularPool[i % regularPool.length];
    // addToScene: false — pool handles live off-scene until _activate places them.
    const handle = buildMoot(row, scene, { addToScene: false });
    handle.alive = false;
    handle.activationStamp = 0; // incremented on each _activate call
    freePool.push(handle);
  }

  // ---------------------------------------------------------------------------
  // Texture cache (row id → THREE.Texture)
  // ---------------------------------------------------------------------------
  const texCache = /** @type {Map<string, import('three').Texture>} */ (new Map());

  async function loadTex(row) {
    const key = row.id;
    if (texCache.has(key)) return texCache.get(key);
    const src = avatarSource(row);
    let tex;
    try {
      if (src.kind === 'animated') {
        tex = await loadVideoTexture(src.file);
      } else {
        tex = await loadChibiTexture(src.file);
      }
    } catch {
      // Animated load failed (including timeout) — fall back to static chibi.
      try {
        tex = await loadChibiTexture(row.chibi_file ?? null);
      } catch {
        // Both failed — use whatever loadChibiTexture returns as a placeholder
        // so this moot still gets something and we never hang.
        tex = await loadChibiTexture(null).catch(() => ({ isPlaceholder: true }));
      }
    }
    // Only cache real textures.  A placeholder means the image failed to load;
    // leave the cache empty so the next loadTex call retries the real URL.
    if (!tex.isPlaceholder) {
      texCache.set(key, tex);
    }
    return tex;
  }

  /**
   * Warm the texture cache for the first POP.standing rows.
   * Call once after createPopulation.
   */
  async function loadTextures() {
    const rows = regularPool.slice(0, POP.standing);
    await runWithConcurrency(rows, MOOT.loadConcurrency, async (row) => {
      await loadTex(row);
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: activate a free handle at a given world position for a given row.
  // ---------------------------------------------------------------------------
  async function _activate(handle, row, pos, opts = {}) {
    // Stamp this activation so stale async callbacks can be discarded.
    handle.activationStamp = (handle.activationStamp || 0) + 1;
    const stamp = handle.activationStamp;

    handle.mootRow = row;
    resetHandleState(handle);
    handle.isBoss = false;
    handle.isObjectiveTarget = !!opts.isObjectiveTarget;
    handle.armed = Math.random() < MOOT.armedFraction;
    handle.hp = 1;
    handle.group.position.set(pos.x, getTerrainY(pos.x, pos.z), pos.z);
    scene.add(handle.group);
    activeRegulars.add(handle);

    // Apply texture (from cache if available, else async).
    // Only write if the stamp still matches — guards against despawn-then-reuse races.
    const tex = await loadTex(row);
    if (handle.activationStamp === stamp && handle.alive) {
      handle.avatarMat.map = tex;
      handle.avatarMat.needsUpdate = true;
    }
  }

  function _releaseToFreePool(handle) {
    handle.alive = false;
    handle.isObjectiveTarget = false;
    handle.avatarMat.rotation = 0;
    handle._fling = undefined;
    handle._onFlingComplete = undefined;
    if (!freePool.includes(handle)) freePool.push(handle);
  }

  // ---------------------------------------------------------------------------
  // Internal: despawn a regular handle (remove from scene, return to pool).
  // ---------------------------------------------------------------------------
  function _despawn(handle) {
    if (!activeRegulars.has(handle)) return;
    activeRegulars.delete(handle);
    handle.alive = false;

    if (handle._fling) {
      // A killed moot must stay owned by its fling animation until the flight
      // completes. Returning it to freePool here lets _activate recycle the same
      // handle while updateFlingMoots is still spinning/moving it.
      handle._onFlingComplete = _releaseToFreePool;
      return;
    }

    scene.remove(handle.group);
    _releaseToFreePool(handle);
  }

  // ---------------------------------------------------------------------------
  // Internal: next row from the round-robin pool (skip boss row if set).
  // Returns undefined (not null) if the pool is empty — callers must guard.
  // ---------------------------------------------------------------------------
  function _nextRow(excludeId) {
    if (regularPool.length === 0) return undefined;
    let row;
    for (let attempts = 0; attempts < regularPool.length; attempts++) {
      row = regularPool[rowCursor % regularPool.length];
      rowCursor++;
      if (row.id !== excludeId) break;
    }
    return row;
  }

  // ---------------------------------------------------------------------------
  // Boot: spawn POP.standing moots in the ring.
  // Not async — _activate is fire-and-forget; callers must not await boot().
  // ---------------------------------------------------------------------------
  function boot(truckPos) {
    const spawnCount = Math.min(POP.standing, POOL_SIZE);
    for (let i = 0; i < spawnCount; i++) {
      const pt =
        pickSpawnPoint(truckPos, navGrid.interestPoints) ||
        navGrid.interestPoints[i % navGrid.interestPoints.length];
      if (!pt) continue;
      const handle = freePool.pop();
      if (!handle) break;
      const row = _nextRow(bossHandle?.mootRow?.id);
      _activate(handle, row, pt); // fire-and-forget texture load
    }
  }

  // ---------------------------------------------------------------------------
  // spawnObjectiveTarget: place a protected objective moot at a chosen map point.
  // ---------------------------------------------------------------------------
  function spawnObjectiveTarget(pos) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return null;

    let handle = freePool.pop();
    if (!handle) {
      // Prefer guaranteeing the objective over preserving one ambient pedestrian.
      for (const h of activeRegulars) {
        if (!h.isObjectiveTarget) {
          _despawn(h);
          handle = freePool.pop();
          break;
        }
      }
    }
    if (!handle) return null;

    const row = _nextRow(bossHandle?.mootRow?.id);
    if (!row) {
      freePool.push(handle);
      return null;
    }

    _activate(handle, row, pos, { isObjectiveTarget: true });
    return handle;
  }

  function releaseObjectiveTarget(handle) {
    if (handle && activeRegulars.has(handle)) {
      handle.isObjectiveTarget = false;
    }
  }

  // ---------------------------------------------------------------------------
  // spawnBoss: place the boss moot at bossPos.
  // ---------------------------------------------------------------------------
  function spawnBoss(bossRow, bossPos) {
    if (bossHandle) return bossHandle; // already spawned

    // Build off-scene so it doesn't flash at (0,0,0) before positioning.
    const handle = buildMoot(bossRow, scene, { addToScene: false });
    resetHandleState(handle);
    handle.isBoss = true;
    handle.armed = true;
    handle.hp = BOSS.hp;
    handle.bossAggro = false;
    handle.bossMode = null;
    handle.bossLastKnownPos = null;
    handle._bossReplanTimer = 0;
    // Ensure boss doesn't fire on frame-0; give it a full cooldown stagger.
    handle.gunCooldown = MOOT.armedCooldownSec;

    // Set position, scale, and tint BEFORE adding to scene.
    handle.group.position.set(bossPos.x, getTerrainY(bossPos.x, bossPos.z), bossPos.z);
    handle.group.scale.setScalar(BOSS.scale);
    handle.avatarMat.color = new THREE.Color(1.0, 0.35, 0.35); // red tint

    // Now add to scene — already positioned, no frame-0 flash at origin.
    scene.add(handle.group);

    // Load texture async.
    loadTex(bossRow).then((tex) => {
      if (handle.alive) {
        handle.avatarMat.map = tex;
        handle.avatarMat.needsUpdate = true;
      }
    });

    bossHandle = handle;
    return handle;
  }

  // ---------------------------------------------------------------------------
  // notifyDeath: called externally when a moot is killed (hp → 0).
  // ---------------------------------------------------------------------------
  function notifyDeath(handle) {
    if (handle.isBoss) return; // boss death = victory, handled by caller
    _despawn(handle);
    // No pendingSpawns counter needed — tick() derives deficit from activeRegulars.size.
  }

  // ---------------------------------------------------------------------------
  // tick: called from game loop at POP.tickHz cadence.
  // ---------------------------------------------------------------------------
  function tick(dt, truckPos) {
    tickTimer += dt;
    if (tickTimer < tickInterval) return;
    // Use modulo so multiple elapsed intervals are consumed on a large dt spike,
    // preventing the tick from running many times in rapid succession.
    tickTimer %= tickInterval;

    const despawnSq = POP.despawnRadius * POP.despawnRadius;

    // 1. Despawn far moots.
    // Set iteration tolerates deleting the current entry; avoid Array.from() so
    // the population tick doesn't allocate a throwaway snapshot.
    for (const h of activeRegulars) {
      if (h.isObjectiveTarget) continue;
      const dx = h.group.position.x - truckPos.x;
      const dz = h.group.position.z - truckPos.z;
      if (dx * dx + dz * dz > despawnSq) {
        _despawn(h);
      }
    }

    // 2. Compute deficit: how many below the standing count.
    const deficit = POP.standing - activeRegulars.size;

    // 3. Spawn up to deficit moots.
    for (let i = 0; i < deficit; i++) {
      if (freePool.length === 0) break;
      const pt = pickSpawnPoint(truckPos, navGrid.interestPoints);
      // null means no valid spawn point found this attempt — try again next
      // iteration rather than breaking so other deficit slots can still fill.
      if (!pt) continue;
      const handle = freePool.pop();
      const row = _nextRow(bossHandle?.mootRow?.id);
      if (!row) {
        freePool.push(handle);
        break;
      } // empty pool — shouldn't happen
      _activate(handle, row, pt);
    }
  }

  // ---------------------------------------------------------------------------
  // getHandles: all live moots (regulars + boss) for use in the game loop.
  // ---------------------------------------------------------------------------
  function getHandles(reuseBuffer = false) {
    if (!reuseBuffer) {
      // Default preserves the historical API: callers receive an owned snapshot.
      const result = Array.from(activeRegulars);
      if (bossHandle?.alive) result.push(bossHandle);
      return result;
    }

    liveHandlesBuffer.length = 0;
    for (const h of activeRegulars) liveHandlesBuffer.push(h);
    if (bossHandle?.alive) liveHandlesBuffer.push(bossHandle);
    return liveHandlesBuffer;
  }

  function getBossHandle() {
    return bossHandle;
  }

  function getActiveRegulars() {
    return Array.from(activeRegulars);
  }

  // ---------------------------------------------------------------------------
  // _disposeHandle: free GPU memory for a moot handle's group.
  // ---------------------------------------------------------------------------
  function _disposeHandle(handle) {
    handle.group.traverse((obj) => {
      if (obj.isMesh) {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            for (const m of obj.material) m.dispose();
          } else {
            obj.material.dispose();
          }
        }
      } else if (obj.isSprite) {
        // SpriteMaterial + its texture (avatarMat, nameMat) must be freed.
        if (obj.material) {
          obj.material.map?.dispose();
          obj.material.dispose();
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // destroyAll: dispose geometry and remove from scene (level transition).
  // Only removes objects that are actually in the scene (activeRegulars + boss).
  // freePool handles are NOT in the scene — they are only disposed, not removed.
  // ---------------------------------------------------------------------------
  function destroyAll() {
    // Remove + dispose active regulars (they are in the scene).
    for (const h of activeRegulars) {
      scene.remove(h.group);
      _disposeHandle(h);
    }
    activeRegulars.clear();

    // Remove + dispose boss (in scene).
    if (bossHandle) {
      scene.remove(bossHandle.group);
      _disposeHandle(bossHandle);
      bossHandle = null;
    }

    // Dispose free-pool handles (NOT in scene — just free GPU memory).
    for (const h of freePool) {
      _disposeHandle(h);
    }
    freePool.length = 0;

    // Pause and dispose all cached textures before clearing the cache.
    // VideoTexture-backed <video> elements keep playing (and emitting audio)
    // until explicitly paused — failing to do so causes audio leaks.
    for (const tex of texCache.values()) {
      // THREE.VideoTexture exposes the source as tex.image (an HTMLVideoElement).
      if (tex.image && typeof tex.image.pause === 'function') {
        tex.image.pause();
        tex.image.src = ''; // release the media resource
      }
      tex.dispose();
    }
    texCache.clear();
  }

  return {
    boot,
    tick,
    loadTextures,
    spawnObjectiveTarget,
    releaseObjectiveTarget,
    spawnBoss,
    notifyDeath,
    getHandles,
    getBossHandle,
    getActiveRegulars,
    destroyAll,
    get freePoolSize() {
      return freePool.length;
    },
    get activeCount() {
      return activeRegulars.size;
    },
  };
}
