/**
 * lib/nav/pathfind.js — A* pathfinder over a NavGrid.
 *
 * findPath(grid, startWorld, goalWorld)
 *   → [{x,z}, …] world-space waypoints from start to goal (inclusive),
 *     or [] if no path exists.
 *
 * Uses an octile heuristic (diagonal-allowed), walks 8 neighbours.
 * Open set is a binary min-heap stored as parallel typed arrays.
 *
 * The path is smoothed with a simple string-pull (funnel-lite): consecutive
 * collinear waypoints are removed.
 *
 * Per-grid scratch buffers (g, parent, closed, gen, heap) are allocated once
 * and stashed on the NavGrid via grid._astar. A monotonically-increasing
 * generation counter (gen) makes "untouched cell" detection O(1) — we never
 * re-zero the buffers per call. This avoids ~5 MB of typed-array allocation
 * per pathfind on a 800×800 m / 1 m-cell grid.
 */

import { NAV } from '../config.js';

const SQRT2 = Math.SQRT2;

// ── Per-grid scratch ─────────────────────────────────────────────────────────

function getScratch(grid) {
  if (grid._astar) return grid._astar;
  const n = grid.cols * grid.rows;
  const s = {
    gen: new Uint32Array(n),
    currentGen: 0,
    g: new Float32Array(n),
    parent: new Int32Array(n),
    closed: new Uint8Array(n),
    heapI: new Int32Array(1024),
    heapF: new Float32Array(1024),
    heapSize: 0,
  };
  grid._astar = s;
  return s;
}

function bumpGen(s) {
  s.currentGen++;
  if (s.currentGen === 0) {
    // Wrap (after 2^32 calls): re-zero so stale entries don't masquerade as fresh.
    s.gen.fill(0);
    s.currentGen = 1;
  }
  s.heapSize = 0;
}

// ── Min-heap on parallel typed arrays (no per-push object alloc) ─────────────

function heapGrow(s, needed) {
  let cap = s.heapI.length;
  while (cap < needed) cap *= 2;
  const ni = new Int32Array(cap);
  const nf = new Float32Array(cap);
  ni.set(s.heapI);
  nf.set(s.heapF);
  s.heapI = ni;
  s.heapF = nf;
}

function heapPush(s, i, f) {
  if (s.heapSize === s.heapI.length) heapGrow(s, s.heapSize + 1);
  const heapI = s.heapI, heapF = s.heapF;
  let pos = s.heapSize++;
  heapI[pos] = i;
  heapF[pos] = f;
  while (pos > 0) {
    const par = (pos - 1) >> 1;
    if (heapF[par] <= heapF[pos]) break;
    const ti = heapI[pos], tf = heapF[pos];
    heapI[pos] = heapI[par]; heapF[pos] = heapF[par];
    heapI[par] = ti;         heapF[par] = tf;
    pos = par;
  }
}

function heapPop(s) {
  const heapI = s.heapI, heapF = s.heapF;
  const topI = heapI[0];
  const n = --s.heapSize;
  if (n > 0) {
    heapI[0] = heapI[n];
    heapF[0] = heapF[n];
    let pos = 0;
    while (true) {
      const l = (pos << 1) + 1, r = l + 1;
      let m = pos;
      if (l < n && heapF[l] < heapF[m]) m = l;
      if (r < n && heapF[r] < heapF[m]) m = r;
      if (m === pos) break;
      const ti = heapI[pos], tf = heapF[pos];
      heapI[pos] = heapI[m]; heapF[pos] = heapF[m];
      heapI[m] = ti;         heapF[m] = tf;
      pos = m;
    }
  }
  return topI;
}

// ── A* core ──────────────────────────────────────────────────────────────────

/**
 * @param {ReturnType<import('./grid.js').buildNavGrid>} grid
 * @param {{x:number,z:number}} startWorld
 * @param {{x:number,z:number}} goalWorld
 * @returns {{x:number,z:number}[]}
 */
export function findPath(grid, startWorld, goalWorld) {
  const { cols, rows, walkable, costMul, worldToCell, cellToWorld } = grid;
  const s = getScratch(grid);
  bumpGen(s);
  const gen = s.currentGen;
  const cellGen = s.gen;
  const g = s.g;
  const parent = s.parent;
  const closed = s.closed;

  const sc = worldToCell(startWorld.x, startWorld.z);
  const gc = worldToCell(goalWorld.x,  goalWorld.z);

  const siRaw = sc.row * cols + sc.col;
  const giRaw = gc.row * cols + gc.col;

  const startIdx = walkable[siRaw] ? siRaw : nearestWalkable(grid, sc.col, sc.row);
  const goalIdx  = walkable[giRaw] ? giRaw : nearestWalkable(grid, gc.col, gc.row);

  if (startIdx === -1 || goalIdx === -1) return [];
  if (startIdx === goalIdx) {
    const c = startIdx % cols;
    const r = (startIdx - c) / cols;
    const w = cellToWorld(c, r);
    return [{ x: w.x, z: w.z }];
  }

  const goalCol = goalIdx % cols;
  const goalRow = (goalIdx - goalCol) / cols;
  const startCol = startIdx % cols;
  const startRow = (startIdx - startCol) / cols;

  cellGen[startIdx] = gen;
  g[startIdx]       = 0;
  parent[startIdx]  = -1;
  closed[startIdx]  = 0;
  heapPush(s, startIdx, heuristic(startCol, startRow, goalCol, goalRow));

  const maxIter = NAV.aStarMaxCells;
  let iter = 0;

  while (s.heapSize > 0 && iter++ < maxIter) {
    const ci = heapPop(s);
    // Stale heap entry guard: a cell can be in the heap multiple times if it
    // was reached via a cheaper path after the original push. The first pop
    // marks it closed; subsequent pops bail here.
    if (closed[ci]) continue;
    closed[ci] = 1;

    if (ci === goalIdx) {
      return reconstructPath(parent, goalIdx, cols, cellToWorld);
    }

    const cCol = ci % cols;
    const cRow = (ci - cCol) / cols;
    const curG = g[ci];

    for (let dr = -1; dr <= 1; dr++) {
      const nr = cRow + dr;
      if (nr < 0 || nr >= rows) continue;
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nc = cCol + dc;
        if (nc < 0 || nc >= cols) continue;
        const ni = nr * cols + nc;
        if (!walkable[ni]) continue;
        if (cellGen[ni] === gen && closed[ni]) continue;

        if (dr !== 0 && dc !== 0) {
          // Don't cut corners through walls.
          const n1 = cRow * cols + nc;
          const n2 = nr   * cols + cCol;
          if (!walkable[n1] || !walkable[n2]) continue;
        }

        const moveCost = (dr !== 0 && dc !== 0) ? SQRT2 : 1.0;
        const ng = curG + moveCost * costMul[ni];
        const oldG = (cellGen[ni] === gen) ? g[ni] : Infinity;

        if (ng < oldG) {
          cellGen[ni] = gen;
          g[ni]       = ng;
          parent[ni]  = ci;
          closed[ni]  = 0;
          const h = heuristic(nc, nr, goalCol, goalRow);
          heapPush(s, ni, ng + h);
        }
      }
    }
  }

  return [];
}

// ── helpers ──────────────────────────────────────────────────────────────────

function heuristic(c1, r1, c2, r2) {
  const dx = c1 < c2 ? c2 - c1 : c1 - c2;
  const dz = r1 < r2 ? r2 - r1 : r1 - r2;
  return (dx + dz) + (SQRT2 - 2) * (dx < dz ? dx : dz);
}

function reconstructPath(parent, goalIdx, cols, cellToWorld) {
  const indices = [];
  let cur = goalIdx;
  while (cur !== -1) {
    indices.push(cur);
    cur = parent[cur];
  }
  indices.reverse();
  const path = indices.map(i => {
    const col = i % cols;
    const row = (i - col) / cols;
    return cellToWorld(col, row);
  });
  return smoothPath(path);
}

/**
 * Remove collinear middle waypoints to reduce path node count.
 */
function smoothPath(path) {
  if (path.length <= 2) return path;
  const out = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur  = path[i];
    const next = path[i + 1];
    const cx = (next.x - prev.x);
    const cz = (next.z - prev.z);
    const ex = (cur.x  - prev.x);
    const ez = (cur.z  - prev.z);
    if (Math.abs(cx * ez - cz * ex) > 0.01) {
      out.push(cur);
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

/**
 * BFS outward from (col,row) to find nearest walkable cell.
 * Returns flat index or -1 if none found within search radius.
 */
function nearestWalkable(grid, col, row) {
  const { cols, rows, walkable } = grid;
  const maxR = 20;
  for (let r = 1; r <= maxR; r++) {
    for (let dc = -r; dc <= r; dc++) {
      for (let dr = -r; dr <= r; dr++) {
        if (Math.abs(dc) !== r && Math.abs(dr) !== r) continue;
        const nc = col + dc, nr = row + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const ni = nr * cols + nc;
        if (walkable[ni]) return ni;
      }
    }
  }
  return -1;
}
