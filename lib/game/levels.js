/**
 * lib/game/levels.js — Level progression: seed management, boss spawn placement.
 *
 * Exports:
 *   createLevelManager(navGrid, bounds, interestPoints)
 *     → { currentSeed, nextSeed, pickBossSpawn, pickPlayerSpawn,
 *           markBossRow, avoidsBossRow }
 *
 * Boss spawn rule (from the plan):
 *   - Player spawns near a map edge (random sidewalk interest point within
 *     LEVEL.bossSnapRadius of the edge).
 *   - Boss spawns halfway from player spawn toward the nearest opposite edge,
 *     then snapped to nearest walkable nav cell.
 *   - "Nearest opposite edge" means: whichever of the four map edges is the
 *     farthest from the player spawn (i.e. in the general opposite direction).
 *
 * Same-boss prevention:
 *   - We keep a rolling list of the last LEVEL.bossRecentDepth boss row IDs in
 *     localStorage (key: 'vxm_recentBossRows'). pickBossRow() skips them.
 */

import { CITY, LEVEL } from '../config.js';

// ── localStorage helpers ───────────────────────────────────────────────────────

const STORAGE_KEY = 'vxm_recentBossRows';

function loadRecentBossRows() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveRecentBossRows(rows) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch { /* storage disabled */ }
}

// ── Boss spawn point computation ──────────────────────────────────────────────

/**
 * Pick a player spawn position: random sidewalk interest point within
 * bossSnapRadius of any map edge.
 *
 * @param {{ minX:number, maxX:number, minZ:number, maxZ:number }} bounds
 * @param {{ x:number, z:number, kind:string }[]} interestPoints
 * @returns {{ x:number, z:number }}
 */
export function pickPlayerSpawn(bounds, interestPoints) {
  const edgeDist = LEVEL.bossSnapRadius;
  const candidates = interestPoints.filter(p => {
    return (
      p.x <= bounds.minX + edgeDist ||
      p.x >= bounds.maxX - edgeDist ||
      p.z <= bounds.minZ + edgeDist ||
      p.z >= bounds.maxZ - edgeDist
    );
  });

  if (candidates.length === 0) {
    // Fallback: first interest point or city centre
    return interestPoints[0] || { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 };
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Pick a boss spawn position: halfway from playerSpawn toward the nearest
 * opposite edge, snapped to the nearest walkable nav cell.
 *
 * "Opposite edge" = pick the edge that the vector from the city centre through
 * the player spawn exits from, then find the edge centroid on that side, and
 * lerp playerSpawn → edge centroid by LEVEL.bossMidpointFrac.
 *
 * @param {{ x:number, z:number }} playerSpawn
 * @param {{ minX:number, maxX:number, minZ:number, maxZ:number }} bounds
 * @param {object} navGrid
 * @returns {{ x:number, z:number }}
 */
export function pickBossSpawn(playerSpawn, bounds, navGrid) {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;

  // Vector from city centre to player.
  const dx = playerSpawn.x - cx;
  const dz = playerSpawn.z - cz;

  // Opposite edge centroid = far edge from player's side.
  // If player is on the +x side, opposite is -x edge, etc.
  let edgePt;
  if (Math.abs(dx) > Math.abs(dz)) {
    // East/west dominant.
    edgePt = {
      x: dx > 0 ? bounds.minX : bounds.maxX,
      z: cz,
    };
  } else {
    // North/south dominant.
    edgePt = {
      x: cx,
      z: dz > 0 ? bounds.minZ : bounds.maxZ,
    };
  }

  // Lerp from playerSpawn toward opposite edge at LEVEL.bossMidpointFrac.
  const t = LEVEL.bossMidpointFrac;
  const rawX = playerSpawn.x + (edgePt.x - playerSpawn.x) * t;
  const rawZ = playerSpawn.z + (edgePt.z - playerSpawn.z) * t;

  // Snap to nearest walkable cell within bossSnapRadius.
  return snapToWalkable({ x: rawX, z: rawZ }, navGrid, LEVEL.bossSnapRadius) ||
         { x: rawX, z: rawZ };
}

/**
 * Find the nearest walkable cell within `maxRadius` of `pos`.
 * Searches in expanding rings of nav cells. Returns world coords or null.
 *
 * @param {{ x:number, z:number }} pos
 * @param {object} navGrid
 * @param {number} maxRadius  world metres
 * @returns {{ x:number, z:number } | null}
 */
export function snapToWalkable(pos, navGrid, maxRadius) {
  const { worldToCell, cellToWorld, idx, walkable, cols, rows, cellSize } = navGrid;
  const { col: sc, row: sr } = worldToCell(pos.x, pos.z);
  const maxCells = Math.ceil(maxRadius / cellSize);

  // Check cell itself first.
  const selfIdx = idx(sc, sr);
  if (selfIdx >= 0 && walkable[selfIdx]) return cellToWorld(sc, sr);

  // Expand ring by ring.
  for (let r = 1; r <= maxCells; r++) {
    let best = null;
    let bestDistSq = Infinity;
    for (let dc = -r; dc <= r; dc++) {
      for (let dr = -r; dr <= r; dr++) {
        if (Math.abs(dc) !== r && Math.abs(dr) !== r) continue; // ring only
        const c = sc + dc;
        const ro = sr + dr;
        const fi = idx(c, ro);
        if (fi < 0 || !walkable[fi]) continue;
        const wp = cellToWorld(c, ro);
        const dx = wp.x - pos.x;
        const dz = wp.z - pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < bestDistSq) { bestDistSq = dSq; best = wp; }
      }
    }
    if (best) return best;
  }
  return null;
}

// ── Level manager ──────────────────────────────────────────────────────────────

/**
 * Create a level manager that tracks the current city seed and recent boss rows.
 *
 * @param {number} initialSeed
 * @returns {{
 *   currentSeed: number,
 *   nextSeed: () => number,
 *   markBossRow: (rowId: string) => void,
 *   avoidsBossRow: (rowId: string) => boolean,
 *   getRecentBossRows: () => string[],
 * }}
 */
export function createLevelManager(initialSeed) {
  let seed = initialSeed;
  let recentBossRows = loadRecentBossRows();

  function nextSeed() {
    seed = (seed + 1) >>> 0;  // unsigned 32-bit increment
    return seed;
  }

  function markBossRow(rowId) {
    recentBossRows = [rowId, ...recentBossRows].slice(0, LEVEL.bossRecentDepth);
    saveRecentBossRows(recentBossRows);
  }

  function avoidsBossRow(rowId) {
    return recentBossRows.includes(rowId);
  }

  function getRecentBossRows() {
    return recentBossRows.slice();
  }

  return {
    get currentSeed() { return seed; },
    nextSeed,
    markBossRow,
    avoidsBossRow,
    getRecentBossRows,
  };
}

/**
 * Pick a boss row from db, avoiding recent boss rows.
 *
 * @param {object[]} db           — full moot db array
 * @param {function} avoidsFn     — (rowId: string) => boolean
 * @returns {object}              — a MootRow
 */
export function pickBossRow(db, avoidsFn) {
  // Prefer a row not recently used as boss.
  const eligible = db.filter(r => !avoidsFn(String(r.id)));
  const pool = eligible.length > 0 ? eligible : db;
  return pool[Math.floor(Math.random() * pool.length)];
}
