/**
 * Directed road graph for vehicle routing.
 *
 * Grid A* is still used for pedestrians/moots. NPC vehicles use this graph so
 * road metadata such as one-way roundabout loop segments can affect routing.
 */

function isPointLike(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.z);
}

function pointKey(point) {
  return `${Math.round(point.x * 1000)}:${Math.round(point.z * 1000)}`;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function getOrCreateNode(graph, point) {
  const key = pointKey(point);
  let index = graph.nodeByKey.get(key);
  if (index === undefined) {
    index = graph.nodes.length;
    graph.nodeByKey.set(key, index);
    graph.nodes.push({ x: point.x, z: point.z });
    graph.edges.push([]);
  }
  return index;
}

function addEdge(graph, from, to, segment) {
  const a = graph.nodes[from];
  const b = graph.nodes[to];
  const cost =
    segment?.arc?.points?.length > 1 ? polylineLength(segment.arc.points) : distance(a, b);
  if (cost < 1e-3) return;
  graph.edges[from].push({ to, cost, segment });
}

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

export function buildRoadGraph(roadSegments = []) {
  const graph = {
    nodes: [],
    edges: [],
    nodeByKey: new Map(),
  };

  for (const segment of roadSegments) {
    if (segment?.kind === 'alley') continue;
    if (!isPointLike(segment?.a) || !isPointLike(segment?.b)) continue;

    const a = getOrCreateNode(graph, segment.a);
    const b = getOrCreateNode(graph, segment.b);
    addEdge(graph, a, b, segment);
    if (!segment.oneWay) addEdge(graph, b, a, segment);
  }

  return graph;
}

function nearestNode(graph, point) {
  if (!graph?.nodes?.length || !isPointLike(point)) return -1;
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < graph.nodes.length; i++) {
    const d = distance(point, graph.nodes[i]);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

function reconstructGraphPath(parent, parentEdge, start, goal, nodes) {
  const indices = [];
  let cur = goal;
  while (cur !== -1) {
    indices.push(cur);
    if (cur === start) break;
    cur = parent[cur];
  }
  if (indices[indices.length - 1] !== start) return [];
  indices.reverse();

  const path = [{ x: nodes[indices[0]].x, z: nodes[indices[0]].z }];
  for (let i = 1; i < indices.length; i++) {
    const edge = parentEdge[indices[i]];
    appendEdgePath(path, edge, nodes[indices[i]]);
  }
  return path;
}

function appendEdgePath(path, edge, fallbackPoint) {
  const arcPoints = edge?.segment?.arc?.points;
  if (Array.isArray(arcPoints) && arcPoints.length > 1) {
    const last = path[path.length - 1];
    const forward = distance(last, arcPoints[0]) <= distance(last, arcPoints[arcPoints.length - 1]);
    const points = forward ? arcPoints : [...arcPoints].reverse();
    for (let i = 1; i < points.length; i++) path.push({ x: points[i].x, z: points[i].z });
    return;
  }
  path.push({ x: fallbackPoint.x, z: fallbackPoint.z });
}

export function findRoadPath(graph, startWorld, goalWorld) {
  if (!graph?.nodes?.length) return [];

  const start = nearestNode(graph, startWorld);
  const goal = nearestNode(graph, goalWorld);
  if (start < 0 || goal < 0) return [];
  if (start === goal) return [{ x: goalWorld.x, z: goalWorld.z }];

  const n = graph.nodes.length;
  const g = new Float32Array(n);
  const parent = new Int32Array(n);
  const parentEdge = new Array(n);
  const closed = new Uint8Array(n);
  g.fill(Number.POSITIVE_INFINITY);
  parent.fill(-1);
  g[start] = 0;

  for (let iter = 0; iter < n; iter++) {
    let current = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      if (!closed[i] && g[i] < best) {
        current = i;
        best = g[i];
      }
    }
    if (current < 0) break;
    if (current === goal) {
      const path = reconstructGraphPath(parent, parentEdge, start, goal, graph.nodes);
      path.unshift({ x: startWorld.x, z: startWorld.z });
      path.push({ x: goalWorld.x, z: goalWorld.z });
      return smoothPath(path);
    }

    closed[current] = 1;
    for (const edge of graph.edges[current]) {
      if (closed[edge.to]) continue;
      const ng = g[current] + edge.cost;
      if (ng < g[edge.to]) {
        g[edge.to] = ng;
        parent[edge.to] = current;
        parentEdge[edge.to] = edge;
      }
    }
  }

  return [];
}

function smoothPath(path) {
  if (path.length <= 2) return path;
  const out = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = path[i];
    const next = path[i + 1];
    const ax = cur.x - prev.x;
    const az = cur.z - prev.z;
    const bx = next.x - cur.x;
    const bz = next.z - cur.z;
    if (Math.abs(ax * bz - az * bx) > 0.01) out.push(cur);
  }
  out.push(path[path.length - 1]);
  return out;
}
