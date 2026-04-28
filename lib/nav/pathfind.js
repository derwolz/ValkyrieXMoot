/**
 * lib/nav/pathfind.js — A* pathfinder over a NavGrid.
 *
 * findPath(grid, startWorld, goalWorld)
 *   → [{x,z}, …] world-space waypoints from start to goal (inclusive),
 *     or [] if no path exists.
 *
 * Uses an octile heuristic (diagonal-allowed), walks 8 neighbours.
 * Open set is a simple min-heap backed array; adequate for the cell counts
 * we're targeting (800m city → ~200k cells at 1m, far fewer walkable).
 *
 * The path is smoothed with a simple string-pull (funnel-lite): consecutive
 * collinear waypoints are removed.
 */

import { NAV } from '../config.js';

const SQRT2 = Math.SQRT2;

// ── Min-heap (keyed on f-score) ───────────────────────────────────────────────

class MinHeap {
  constructor() { this._data = []; }
  push(node) {
    this._data.push(node);
    this._bubbleUp(this._data.length - 1);
  }
  pop() {
    const top = this._data[0];
    const last = this._data.pop();
    if (this._data.length > 0) { this._data[0] = last; this._siftDown(0); }
    return top;
  }
  get size() { return this._data.length; }
  _bubbleUp(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._data[p].f <= this._data[i].f) break;
      [this._data[p], this._data[i]] = [this._data[i], this._data[p]];
      i = p;
    }
  }
  _siftDown(i) {
    const n = this._data.length;
    while (true) {
      let min = i, l = 2*i+1, r = 2*i+2;
      if (l < n && this._data[l].f < this._data[min].f) min = l;
      if (r < n && this._data[r].f < this._data[min].f) min = r;
      if (min === i) break;
      [this._data[min], this._data[i]] = [this._data[i], this._data[min]];
      i = min;
    }
  }
}

// ── A* core ───────────────────────────────────────────────────────────────────

/**
 * @param {ReturnType<import('./grid.js').buildNavGrid>} grid
 * @param {{x:number,z:number}} startWorld
 * @param {{x:number,z:number}} goalWorld
 * @returns {{x:number,z:number}[]}
 */
export function findPath(grid, startWorld, goalWorld) {
  const { cols, rows, walkable, costMul, worldToCell, cellToWorld, idx } = grid;

  const sc = worldToCell(startWorld.x, startWorld.z);
  const gc = worldToCell(goalWorld.x,  goalWorld.z);

  const si = idx(sc.col, sc.row);
  const gi = idx(gc.col, gc.row);

  // Snap start/goal to nearest walkable cell if they land on blocked cells.
  const startIdx = walkable[si] ? si : nearestWalkable(grid, sc.col, sc.row);
  const goalIdx  = walkable[gi] ? gi : nearestWalkable(grid, gc.col, gc.row);

  if (startIdx === -1 || goalIdx === -1) return [];
  if (startIdx === goalIdx) {
    const s = idxToColRow(startIdx, cols);
    const w = cellToWorld(s.col, s.row);
    return [{ x: w.x, z: w.z }];
  }

  // g-scores (Float32Array default = Infinity via initial very-large values)
  const g = new Float32Array(cols * rows).fill(Infinity);
  const parent = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);

  g[startIdx] = 0;

  const sc_ = idxToColRow(startIdx, cols);
  const gc_ = idxToColRow(goalIdx, cols);

  const open = new MinHeap();
  open.push({ i: startIdx, f: heuristic(sc_.col, sc_.row, gc_.col, gc_.row) });

  const maxIter = NAV.aStarMaxCells;
  let iter = 0;

  while (open.size > 0 && iter++ < maxIter) {
    const { i: ci } = open.pop();
    if (closed[ci]) continue;
    closed[ci] = 1;

    if (ci === goalIdx) {
      return reconstructPath(parent, goalIdx, cols, cellToWorld);
    }

    const cur = idxToColRow(ci, cols);

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nc = cur.col + dc;
        const nr = cur.row + dr;
        const ni = idx(nc, nr);
        if (ni < 0 || !walkable[ni] || closed[ni]) continue;

        // Diagonal movement: both cardinal neighbours must also be walkable
        // to avoid cutting corners through walls.
        if (dr !== 0 && dc !== 0) {
          const n1 = idx(cur.col + dc, cur.row);
          const n2 = idx(cur.col, cur.row + dr);
          if ((n1 < 0 || !walkable[n1]) || (n2 < 0 || !walkable[n2])) continue;
        }

        const moveCost = (dr !== 0 && dc !== 0) ? SQRT2 : 1.0;
        const ng = g[ci] + moveCost * costMul[ni];

        if (ng < g[ni]) {
          g[ni] = ng;
          parent[ni] = ci;
          const h = heuristic(nc, nr, gc_.col, gc_.row);
          open.push({ i: ni, f: ng + h });
        }
      }
    }
  }

  return []; // no path found
}

// ── helpers ───────────────────────────────────────────────────────────────────

function heuristic(c1, r1, c2, r2) {
  const dx = Math.abs(c1 - c2);
  const dz = Math.abs(r1 - r2);
  return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz);
}

function idxToColRow(i, cols) {
  return { col: i % cols, row: Math.floor(i / cols) };
}

function reconstructPath(parent, goalIdx, cols, cellToWorld) {
  const indices = [];
  let cur = goalIdx;
  while (cur !== -1) {
    indices.push(cur);
    cur = parent[cur];
  }
  indices.reverse();
  // Convert to world coords.
  const path = indices.map(i => {
    const { col, row } = idxToColRow(i, cols);
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
    // Cross-product magnitude (if nearly 0, cur is collinear → skip).
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
  const { cols, rows, walkable, idx } = grid;
  const maxR = 20;
  for (let r = 1; r <= maxR; r++) {
    for (let dc = -r; dc <= r; dc++) {
      for (let dr = -r; dr <= r; dr++) {
        if (Math.abs(dc) !== r && Math.abs(dr) !== r) continue; // only shell
        const ni = idx(col + dc, row + dr);
        if (ni >= 0 && walkable[ni]) return ni;
      }
    }
  }
  return -1;
}
