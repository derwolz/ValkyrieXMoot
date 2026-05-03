/**
 * smoke_nav.mjs — Quick smoke test for lib/nav/grid.js and lib/nav/pathfind.js
 *
 * Run from the ValkyrieXMoot directory:
 *   node tools/smoke_nav.mjs
 *
 * Stubs out the Three.js dependency so we can test pure logic in Node.
 */

// ── Stub config so we don't need the full import chain ────────────────────────
const NAV = {
  cellSize: 1.0,
  mootRadius: 0.4,
  costAlley: 0.7,
  costIntersection: 1.3,
  aStarMaxCells: 50000,
};
const CITY = { sidewalkWidth: 5 };

// We patch the module cache trick with inline re-implementations to avoid
// needing a bundler. We test the logic by inlining the module code with
// the config values substituted.

// ── Inline buildNavGrid (mirrors lib/nav/grid.js exactly) ─────────────────────

function isOnRoad(wx, wz, segs, swHalf) {
  for (const s of segs) {
    const half = s.width / 2 + swHalf;
    if (s.a.x === s.b.x) {
      const zMin = Math.min(s.a.z, s.b.z);
      const zMax = Math.max(s.a.z, s.b.z);
      if (Math.abs(wx - s.a.x) <= half && wz >= zMin && wz <= zMax) return true;
    } else {
      const xMin = Math.min(s.a.x, s.b.x);
      const xMax = Math.max(s.a.x, s.b.x);
      if (Math.abs(wz - s.a.z) <= half && wx >= xMin && wx <= xMax) return true;
    }
  }
  return false;
}

function isOnAlley(wx, wz, segs) {
  for (const s of segs) {
    const half = s.width / 2;
    if (s.a.x === s.b.x) {
      const zMin = Math.min(s.a.z, s.b.z);
      const zMax = Math.max(s.a.z, s.b.z);
      if (Math.abs(wx - s.a.x) <= half && wz >= zMin && wz <= zMax) return true;
    } else {
      const xMin = Math.min(s.a.x, s.b.x);
      const xMax = Math.max(s.a.x, s.b.x);
      if (Math.abs(wz - s.a.z) <= half && wx >= xMin && wx <= xMax) return true;
    }
  }
  return false;
}

function isIntersectionCell(wx, wz, intersections) {
  for (const it of intersections) {
    const hx = it.widthX / 2;
    const hz = it.widthZ / 2;
    if (wx >= it.pos.x - hx && wx <= it.pos.x + hx && wz >= it.pos.z - hz && wz <= it.pos.z + hz)
      return true;
  }
  return false;
}

function isInsideAny(wx, wz, aabbs) {
  for (const a of aabbs) {
    if (wx >= a.minX && wx <= a.maxX && wz >= a.minZ && wz <= a.maxZ) return true;
  }
  return false;
}

function buildNavGrid({ bounds, buildingAABBs, roadSegments, intersections, interestPoints }) {
  const cs = NAV.cellSize;
  const originX = bounds.minX;
  const originZ = bounds.minZ;
  const cols = Math.ceil((bounds.maxX - bounds.minX) / cs) + 1;
  const rows = Math.ceil((bounds.maxZ - bounds.minZ) / cs) + 1;

  const walkable = new Uint8Array(cols * rows);
  const costMul = new Float32Array(cols * rows).fill(1.0);
  const mootR = NAV.mootRadius;
  const swHalf = CITY.sidewalkWidth / 2;

  const inflatedAABBs = buildingAABBs.map((a) => ({
    minX: a.minX - mootR,
    maxX: a.maxX + mootR,
    minZ: a.minZ - mootR,
    maxZ: a.maxZ + mootR,
  }));

  const alleySegs = roadSegments.filter((s) => s.kind === 'alley');
  const roadSegs = roadSegments.filter((s) => s.kind !== 'alley');

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const wx = originX + col * cs;
      const wz = originZ + row * cs;
      const fi = row * cols + col;

      const onRoad = isOnRoad(wx, wz, roadSegs, swHalf);
      const onAlley = isOnAlley(wx, wz, alleySegs);
      if (!onRoad && !onAlley) continue;
      if (isInsideAny(wx, wz, inflatedAABBs)) continue;

      walkable[fi] = 1;
      if (onAlley) costMul[fi] = NAV.costAlley;
      else if (isIntersectionCell(wx, wz, intersections)) costMul[fi] = NAV.costIntersection;
    }
  }

  function worldToCell(x, z) {
    return {
      col: Math.max(0, Math.min(cols - 1, Math.round((x - originX) / cs))),
      row: Math.max(0, Math.min(rows - 1, Math.round((z - originZ) / cs))),
    };
  }
  function cellToWorld(col, row) {
    return { x: originX + col * cs, z: originZ + row * cs };
  }
  function idx(col, row) {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return -1;
    return row * cols + col;
  }

  return {
    cellSize: cs,
    cols,
    rows,
    origin: { x: originX, z: originZ },
    walkable,
    costMul,
    interestPoints,
    worldToCell,
    cellToWorld,
    idx,
  };
}

// ── Inline findPath (mirrors lib/nav/pathfind.js) ─────────────────────────────

const SQRT2 = Math.SQRT2;
class MinHeap {
  constructor() {
    this._data = [];
  }
  push(n) {
    this._data.push(n);
    this._bubbleUp(this._data.length - 1);
  }
  pop() {
    const t = this._data[0];
    const l = this._data.pop();
    if (this._data.length) {
      this._data[0] = l;
      this._siftDown(0);
    }
    return t;
  }
  get size() {
    return this._data.length;
  }
  _bubbleUp(i) {
    let cur = i;
    while (cur > 0) {
      const p = (cur - 1) >> 1;
      if (this._data[p].f <= this._data[cur].f) break;
      [this._data[p], this._data[cur]] = [this._data[cur], this._data[p]];
      cur = p;
    }
  }
  _siftDown(i) {
    const n = this._data.length;
    let cur = i;
    while (true) {
      let m = cur;
      const l = 2 * cur + 1;
      const r = 2 * cur + 2;
      if (l < n && this._data[l].f < this._data[m].f) m = l;
      if (r < n && this._data[r].f < this._data[m].f) m = r;
      if (m === cur) break;
      [this._data[m], this._data[cur]] = [this._data[cur], this._data[m]];
      cur = m;
    }
  }
}

function heuristic(c1, r1, c2, r2) {
  const dx = Math.abs(c1 - c2);
  const dz = Math.abs(r1 - r2);
  return dx + dz + (SQRT2 - 2) * Math.min(dx, dz);
}
function idxToColRow(i, cols) {
  return { col: i % cols, row: Math.floor(i / cols) };
}

function nearestWalkable(grid, col, row) {
  const { walkable, idx } = grid;
  for (let r = 1; r <= 20; r++) {
    for (let dc = -r; dc <= r; dc++)
      for (let dr = -r; dr <= r; dr++) {
        if (Math.abs(dc) !== r && Math.abs(dr) !== r) continue;
        const ni = idx(col + dc, row + dr);
        if (ni >= 0 && walkable[ni]) return ni;
      }
  }
  return -1;
}

function smoothPath(path) {
  if (path.length <= 2) return path;
  const out = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = path[i];
    const next = path[i + 1];
    const cx = next.x - prev.x;
    const cz = next.z - prev.z;
    const ex = cur.x - prev.x;
    const ez = cur.z - prev.z;
    if (Math.abs(cx * ez - cz * ex) > 0.01) out.push(cur);
  }
  out.push(path[path.length - 1]);
  return out;
}

function reconstructPath(parent, goalIdx, cols, cellToWorld) {
  const indices = [];
  let cur = goalIdx;
  while (cur !== -1) {
    indices.push(cur);
    cur = parent[cur];
  }
  indices.reverse();
  const path = indices.map((i) => {
    const { col, row } = idxToColRow(i, cols);
    return cellToWorld(col, row);
  });
  return smoothPath(path);
}

function findPath(grid, startWorld, goalWorld) {
  const { cols, rows, walkable, costMul, worldToCell, cellToWorld, idx } = grid;
  const sc = worldToCell(startWorld.x, startWorld.z);
  const gc = worldToCell(goalWorld.x, goalWorld.z);
  const si = idx(sc.col, sc.row);
  const gi = idx(gc.col, gc.row);
  const startIdx = walkable[si] ? si : nearestWalkable(grid, sc.col, sc.row);
  const goalIdx = walkable[gi] ? gi : nearestWalkable(grid, gc.col, gc.row);
  if (startIdx === -1 || goalIdx === -1) return [];
  if (startIdx === goalIdx) {
    const s = idxToColRow(startIdx, cols);
    return [cellToWorld(s.col, s.row)];
  }

  const g = new Float32Array(cols * rows).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  g[startIdx] = 0;
  const sc_ = idxToColRow(startIdx, cols);
  const gc_ = idxToColRow(goalIdx, cols);
  const open = new MinHeap();
  open.push({ i: startIdx, f: heuristic(sc_.col, sc_.row, gc_.col, gc_.row) });
  let iter = 0;
  while (open.size > 0 && iter++ < NAV.aStarMaxCells) {
    const { i: ci } = open.pop();
    if (closed[ci]) continue;
    closed[ci] = 1;
    if (ci === goalIdx) return reconstructPath(parent, goalIdx, cols, cellToWorld);
    const cur = idxToColRow(ci, cols);
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nc = cur.col + dc;
        const nr = cur.row + dr;
        const ni = idx(nc, nr);
        if (ni < 0 || !walkable[ni] || closed[ni]) continue;
        if (dr !== 0 && dc !== 0) {
          const n1 = idx(cur.col + dc, cur.row);
          const n2 = idx(cur.col, cur.row + dr);
          if (n1 < 0 || !walkable[n1] || n2 < 0 || !walkable[n2]) continue;
        }
        const moveCost = dr !== 0 && dc !== 0 ? SQRT2 : 1.0;
        const ng = g[ci] + moveCost * costMul[ni];
        if (ng < g[ni]) {
          g[ni] = ng;
          parent[ni] = ci;
          open.push({ i: ni, f: ng + heuristic(nc, nr, gc_.col, gc_.row) });
        }
      }
  }
  return [];
}

// ── Inline moveWithCollision (mirrors lib/nav/collision.js) ───────────────────

function deepestPenetration(ox, oz, cx, cz, aabbs, r) {
  let bestDepth = 0;
  let best = null;
  for (const aabb of aabbs) {
    const npx = Math.max(aabb.minX, Math.min(cx, aabb.maxX));
    const npz = Math.max(aabb.minZ, Math.min(cz, aabb.maxZ));
    const dx = cx - npx;
    const dz = cz - npz;
    const distSq = dx * dx + dz * dz;
    if (distSq >= r * r) continue;
    let nx;
    let nz;
    let depth;
    if (distSq < 1e-10) {
      const movX = cx - ox;
      const movZ = cz - oz;
      if (Math.abs(movX) >= Math.abs(movZ)) {
        nx = movX >= 0 ? -1 : 1;
        nz = 0;
        depth = Math.max(0, (nx < 0 ? cx - aabb.minX : aabb.maxX - cx) + r);
      } else {
        nx = 0;
        nz = movZ >= 0 ? -1 : 1;
        depth = Math.max(0, (nz < 0 ? cz - aabb.minZ : aabb.maxZ - cz) + r);
      }
    } else {
      const dist = Math.sqrt(distSq);
      nx = dx / dist;
      nz = dz / dist;
      depth = r - dist;
    }
    if (depth > bestDepth) {
      bestDepth = depth;
      best = { px: nx * depth, pz: nz * depth, nx, nz };
    }
  }
  return best;
}

function moveWithCollision(pos, vx, vz, dt, aabbs, radius) {
  let nx = pos.x + vx * dt;
  let nz = pos.z + vz * dt;
  let svx = vx;
  let svz = vz;
  for (let pass = 0; pass < 2; pass++) {
    const pen = deepestPenetration(pos.x, pos.z, nx, nz, aabbs, radius);
    if (!pen) break;
    nx += pen.px;
    nz += pen.pz;
    if (pass === 0) {
      const dot = svx * pen.nx + svz * pen.nz;
      svx = svx - dot * pen.nx;
      svz = svz - dot * pen.nz;
    }
  }
  return { x: nx, z: nz };
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

// ── Test 1: buildNavGrid — basic grid construction ────────────────────────────

console.log('\n[Test 1] buildNavGrid basics');
{
  // Simple 50×50 city with one road at x=0 and one road at z=0.
  const bounds = { minX: -25, maxX: 25, minZ: -25, maxZ: 25 };
  const roadSegments = [
    { a: { x: 0, z: -25 }, b: { x: 0, z: 25 }, width: 10, kind: 'local' },
    { a: { x: -25, z: 0 }, b: { x: 25, z: 0 }, width: 10, kind: 'local' },
  ];
  const intersections = [{ pos: { x: 0, z: 0 }, widthX: 10, widthZ: 10 }];
  const alleySegs = [];

  const grid = buildNavGrid({
    bounds,
    buildingAABBs: [],
    roadSegments: [...roadSegments, ...alleySegs],
    intersections,
    interestPoints: [],
    alleys: alleySegs,
  });

  assert('cols and rows are positive', grid.cols > 0 && grid.rows > 0);
  assert('walkable is Uint8Array', grid.walkable instanceof Uint8Array);
  assert('costMul is Float32Array', grid.costMul instanceof Float32Array);
  assert('walkable has correct length', grid.walkable.length === grid.cols * grid.rows);

  // Cell at road centre should be walkable.
  const c = grid.worldToCell(0, 0);
  const i = grid.idx(c.col, c.row);
  assert('road centre cell walkable', grid.walkable[i] === 1);

  // Cell far off any road shouldn't be walkable.
  const c2 = grid.worldToCell(-20, -20);
  const i2 = grid.idx(c2.col, c2.row);
  assert('off-road cell not walkable', grid.walkable[i2] === 0);

  // Check cost at intersection.
  assert('intersection cost is 1.3', Math.abs(grid.costMul[i] - 1.3) < 0.01);

  // Alley test.
  const alley = { a: { x: 10, z: -25 }, b: { x: 10, z: 25 }, width: 4, kind: 'alley' };
  const grid2 = buildNavGrid({
    bounds,
    buildingAABBs: [],
    roadSegments: [...roadSegments, alley],
    intersections,
    interestPoints: [],
    alleys: [alley],
  });
  const ca = grid2.worldToCell(10, 0);
  const ia = grid2.idx(ca.col, ca.row);
  assert('alley cell is walkable', grid2.walkable[ia] === 1);
  assert('alley cost is 0.7', Math.abs(grid2.costMul[ia] - 0.7) < 0.01);

  // Building blocks a cell.
  const grid3 = buildNavGrid({
    bounds,
    buildingAABBs: [{ minX: -1, maxX: 1, minZ: -1, maxZ: 1 }],
    roadSegments,
    intersections,
    interestPoints: [],
    alleys: [],
  });
  const cb = grid3.worldToCell(0, 0);
  const ib = grid3.idx(cb.col, cb.row);
  assert('building-blocked cell not walkable', grid3.walkable[ib] === 0);

  // worldToCell / cellToWorld round-trip.
  const wc = grid.worldToCell(5, 3);
  const world = grid.cellToWorld(wc.col, wc.row);
  assert(
    'worldToCell/cellToWorld round-trips within 1 m',
    Math.abs(world.x - 5) < 1.01 && Math.abs(world.z - 3) < 1.01,
  );
}

// ── Test 2: findPath — basic pathfinding ──────────────────────────────────────

console.log('\n[Test 2] findPath');
{
  // Open road along z-axis, no buildings.
  const bounds = { minX: -20, maxX: 20, minZ: -50, maxZ: 50 };
  const roadSegments = [{ a: { x: 0, z: -50 }, b: { x: 0, z: 50 }, width: 10, kind: 'local' }];
  const grid = buildNavGrid({
    bounds,
    buildingAABBs: [],
    roadSegments,
    intersections: [],
    interestPoints: [],
    alleys: [],
  });

  // Walkable count > 0.
  const wcount = grid.walkable.reduce((s, v) => s + v, 0);
  assert('at least some walkable cells', wcount > 0);

  const path = findPath(grid, { x: 0, z: -30 }, { x: 0, z: 30 });
  assert('findPath returns non-empty array', path.length > 0);
  assert('path starts near start', Math.abs(path[0].x) < 2 && Math.abs(path[0].z - -30) < 2);
  assert(
    'path ends near goal',
    Math.abs(path[path.length - 1].x) < 2 && Math.abs(path[path.length - 1].z - 30) < 2,
  );
  assert('path has reasonable length', path.length < 200);

  // No path when start and goal are in completely different disconnected regions.
  // Use a wide building that blocks the full sidewalk + road corridor.
  const bounds2 = { minX: -10, maxX: 10, minZ: -50, maxZ: 50 };
  const segs2 = [{ a: { x: 0, z: -50 }, b: { x: 0, z: 50 }, width: 10, kind: 'local' }];
  // Building is wider than road + sidewalk (half=5+2.5=7.5) → blocks everything at z=0 band.
  const wallAABB = [{ minX: -20, maxX: 20, minZ: -2, maxZ: 2 }];
  const gridBlocked = buildNavGrid({
    bounds: bounds2,
    buildingAABBs: wallAABB,
    roadSegments: segs2,
    intersections: [],
    interestPoints: [],
    alleys: [],
  });
  const pathBlocked = findPath(gridBlocked, { x: 0, z: -30 }, { x: 0, z: 30 });
  // The wall divides the corridor into north and south — path cannot cross.
  // Either length is 0 OR (if nearestWalkable snaps to same side) it is very short
  // and does not reach within 5 m of goal z.
  const blocked =
    pathBlocked.length === 0 || Math.abs(pathBlocked[pathBlocked.length - 1].z - 30) > 5;
  assert('wall-divided path cannot reach goal', blocked);

  // ── Test 3: directed road graph ───────────────────────────────────────────────
  console.log('\n[Test 3] directed road graph');
  {
    const { buildRoadGraph, findRoadPath } = await import('../lib/nav/roadGraph.js');
    const graph = buildRoadGraph([
      { a: { x: 0, z: 0 }, b: { x: 10, z: 0 }, width: 4, kind: 'roundabout', oneWay: true },
    ]);
    const forward = findRoadPath(graph, { x: 0, z: 0 }, { x: 10, z: 0 });
    const backward = findRoadPath(graph, { x: 10, z: 0 }, { x: 0, z: 0 });
    assert('one-way segment routes forward', forward.length > 0);
    assert('one-way segment blocks reverse route', backward.length === 0);
  }
}

// ── Test 3: moveWithCollision ─────────────────────────────────────────────────

console.log('\n[Test 3] moveWithCollision');
{
  const aabb = { minX: 5, maxX: 15, minZ: -5, maxZ: 5 };
  const r = 0.4;

  // Moving directly into wall should stop before penetrating.
  const pos = { x: 3.0, z: 0 };
  const result = moveWithCollision(pos, 10, 0, 1.0, [aabb], r);
  assert('no penetration after collision', result.x <= aabb.minX - r + 0.01);

  // Moving parallel to wall (along z) should not be deflected on x.
  const pos2 = { x: 3.0, z: -10 };
  const result2 = moveWithCollision(pos2, 0, 5, 1.0, [aabb], r);
  assert('parallel move unchanged on x', Math.abs(result2.x - pos2.x) < 0.01);
  assert('parallel move advances on z', result2.z > pos2.z);

  // No building: straight-through move.
  const pos3 = { x: 0, z: 0 };
  const result3 = moveWithCollision(pos3, 3, 4, 1.0, [], r);
  assert('free move: correct x', Math.abs(result3.x - 3) < 0.001);
  assert('free move: correct z', Math.abs(result3.z - 4) < 0.001);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
if (failed > 0) process.exit(1);
