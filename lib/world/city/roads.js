import { CITY } from '../../config.js';

// Generate a perturbed axis-aligned grid of streets.
// One vertical line is anchored at x=0 so the existing moot corridor lands on
// a real street. Each line is then assigned a tier (thoroughfare4 /
// thoroughfare2 / local) which determines its road width. Alleys that split
// blocks come from the alley pass in blocks.js, not from this grid.
//
// Now zone-aware: spacing is tighter in urban areas, normal in suburban areas,
// and wider in rural/park/beach areas. Candidate road lines sample across the
// actual 2D zone field instead of only along the world axes. zoneMap is optional
// — if null, uses uniform spacing (legacy behaviour).
//
// Returns { xLines, zLines } where each entry is { x|z, width, tier },
// sorted ascending.
export function generateRoadGrid(rand, zoneMap = null) {
  const halfW = CITY.width / 2;
  const halfL = CITY.length / 2;

  // Base step from config; adjust per zone.
  const baseSpacing = CITY.streetSpacing;
  const jitter = CITY.streetSpacingJitter;

  const stepRand = (cx, axis) => {
    const zoneSpacingMult = getLineZoneSpacingMult(cx, axis, zoneMap, halfW, halfL);
    return baseSpacing * zoneSpacingMult *
      (1 - jitter + rand() * 2 * jitter);
  };

  const localW = CITY.tiers.local;

  // Vertical streets — start at x=0 (anchor), walk outward.
  const xLines = [{
    x: 0,
    width: CITY.tiers[CITY.startTier],
    tier: CITY.startTier,
    locked: true,
  }];
  for (let x = stepRand(halfW / 2, 'vertical'); x < halfW; x += stepRand(x, 'vertical')) {
    xLines.push({ x, width: localW, tier: 'local' });
  }
  for (let x = -stepRand(-halfW / 2, 'vertical'); x > -halfW; x -= stepRand(x, 'vertical')) {
    xLines.push({ x, width: localW, tier: 'local' });
  }
  xLines.sort((a, b) => a.x - b.x);

  // Horizontal streets.
  const zLines = [{ z: halfL, width: localW, tier: 'local' }];
  let zCur = halfL;
  while (zCur > -halfL + baseSpacing * 0.5) {
    zCur -= stepRand(zCur, 'horizontal');
    if (zCur > -halfL) zLines.push({ z: zCur, width: localW, tier: 'local' });
  }
  zLines.push({ z: -halfL, width: localW, tier: 'local' });
  zLines.sort((a, b) => a.z - b.z);

  promoteTiers(xLines, rand);
  promoteTiers(zLines, rand);

  return { xLines, zLines };
}

/**
 * Returns a spacing multiplier for a candidate full-axis road line.
 * Vertical lines sample multiple z positions at the candidate x; horizontal
 * lines sample multiple x positions at the candidate z. This keeps spacing
 * driven only by zone type while using the actual 2D zone field instead of the
 * legacy z=0 / x=0 cross-sections.
 */
function getLineZoneSpacingMult(coord, axis, zoneMap, halfW, halfL) {
  if (!zoneMap || typeof zoneMap.getZone !== 'function') return 1.0;

  const sampleCount = Math.max(1, Math.floor(CITY.roadZoneSampleCount ?? 9));
  const sampleMax = sampleCount - 1;
  let total = 0;

  for (let i = 0; i < sampleCount; i++) {
    const t = sampleMax === 0 ? 0.5 : i / sampleMax;
    const sampleX = axis === 'vertical' ? coord : -halfW + t * halfW * 2;
    const sampleZ = axis === 'vertical' ? -halfL + t * halfL * 2 : coord;
    total += getZoneSpacingMult(sampleX, sampleZ, zoneMap);
  }

  return total / sampleCount;
}

/**
 * Returns a spacing multiplier based on zone type.
 * Urban = tight, suburban = normal, rural = wide, beach/park/highway = sparse.
 */
function getZoneSpacingMult(cx, cz, zoneMap) {
  const zone = zoneMap.getZone(cx, cz);
  const spacing = CITY.roadZoneSpacingMult?.[zone];
  return Number.isFinite(spacing) ? spacing : 1.0;
}

// Pick `thoroughfare4PerAxis` random non-locked lines and promote them to
// thoroughfare4, then pick `thoroughfare2PerAxis` more for thoroughfare2.
function promoteTiers(lines, rand) {
  const candidates = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => !l.locked);

  // Fisher-Yates shuffle
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  let idx = 0;
  for (let n = 0; n < CITY.thoroughfare4PerAxis && idx < candidates.length; n++, idx++) {
    candidates[idx].l.tier = 'thoroughfare4';
    candidates[idx].l.width = CITY.tiers.thoroughfare4;
  }
  for (let n = 0; n < CITY.thoroughfare2PerAxis && idx < candidates.length; n++, idx++) {
    candidates[idx].l.tier = 'thoroughfare2';
    candidates[idx].l.width = CITY.tiers.thoroughfare2;
  }
}

// Convert grid lines into the road segment + intersection records the bundle
// expects. Each grid line spans the full opposite extent.
export function gridToSegments(xLines, zLines) {
  const segments = [];
  const intersections = [];
  const zMin = zLines[0].z;
  const zMax = zLines[zLines.length - 1].z;
  const xMin = xLines[0].x;
  const xMax = xLines[xLines.length - 1].x;

  for (const xL of xLines) {
    segments.push({
      a: { x: xL.x, z: zMin },
      b: { x: xL.x, z: zMax },
      width: xL.width,
      kind: xL.tier,
    });
  }
  for (const zL of zLines) {
    segments.push({
      a: { x: xMin, z: zL.z },
      b: { x: xMax, z: zL.z },
      width: zL.width,
      kind: zL.tier,
    });
  }
  for (const xL of xLines) {
    for (const zL of zLines) {
      intersections.push({
        pos: { x: xL.x, z: zL.z },
        widthX: xL.width,
        widthZ: zL.width,
      });
    }
  }
  return { segments, intersections };
}

/**
 * Generate deterministic non-axis-aligned roads as a planned hierarchy rather
 * than raw Voronoi bisectors. The retained config key is historical; output is
 * now composed of snapped waterfront collectors, an inner circuit collector,
 * radial arterials, and district-scaled local streets. Endpoints are snapped to
 * a coarse grid/backbone, intersections are spacing/angle checked, and all
 * segments avoid water/highway reservation zones.
 */
export function generateHierarchicalRoadSegments(rand, zoneMap = null, highwayLayout = null, backboneSegments = []) {
  const cfg = CITY.voronoiRoads ?? {};
  if (cfg.enabled === false) return [];

  const halfW = CITY.width / 2;
  const halfL = CITY.length / 2;
  const snapGrid = Math.max(5, Number(cfg.snapGrid) || 20);
  const minSegmentLength = Math.max(35, Number(cfg.minSegmentLength) || 75);
  const minIntersectionSpacing = Math.max(20, Number(cfg.minIntersectionSpacing) || 55);
  const minIntersectionAngle = Math.max(12, Number(cfg.minIntersectionAngleDeg) || 32) * Math.PI / 180;
  const backboneSnapDistance = Math.max(0, Number(cfg.backboneSnapDistance) || 0);
  const arterialWidth = Math.max(6, Number(cfg.arterialWidth) || CITY.tiers.thoroughfare2 || 20);
  const collectorWidth = Math.max(5, Number(cfg.collectorWidth) || CITY.tiers.local || 12);
  const localWidth = Math.max(4, Number(cfg.localWidth) || CITY.tiers.local || 10);

  const segments = [];
  const nodes = [];

  const normalizeEndpoint = (point) => {
    const snapped = snapPoint(point, snapGrid, halfW, halfL);
    const existing = findNearbyNode(snapped, nodes, snapGrid * 0.75);
    if (existing) return { x: existing.x, z: existing.z };
    const attached = snapToBackbone(snapped, backboneSegments, backboneSnapDistance);
    return attached ? snapPoint(attached, snapGrid, halfW, halfL) : snapped;
  };

  const addPlannedSegment = (rawA, rawB, kind, width, source, hierarchy) => {
    if (!isPointLike(rawA) || !isPointLike(rawB)) return null;
    const a = normalizeEndpoint(rawA);
    const b = normalizeEndpoint(rawB);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < minSegmentLength) return null;
    if (isReservedRoadZone(a.x, a.z, zoneMap) || isReservedRoadZone(b.x, b.z, zoneMap)) return null;
    if (segmentTouchesReservedRoadZone(a, b, zoneMap)) return null;
    if (!hasControlledIntersections(a, b, segments, nodes, minIntersectionSpacing, minIntersectionAngle)) return null;

    const segment = {
      a,
      b,
      width,
      kind,
      organic: true,
      planned: true,
      hierarchy,
      source,
    };
    segments.push(segment);
    registerNode(nodes, a);
    registerNode(nodes, b);
    return segment;
  };

  const waterfrontPoints = buildWaterfrontCollectorPoints(zoneMap, cfg, snapGrid, halfW, halfL);
  for (let i = 0; i < waterfrontPoints.length - 1; i++) {
    addPlannedSegment(
      waterfrontPoints[i],
      waterfrontPoints[i + 1],
      'collector',
      collectorWidth,
      'planned-waterfront-collector',
      'waterfront-collector',
    );
  }

  const circuitPoints = buildCircuitCollectorPoints(highwayLayout, cfg, snapGrid, halfW, halfL);
  for (let i = 0; i < circuitPoints.length - 1; i++) {
    addPlannedSegment(
      circuitPoints[i],
      circuitPoints[i + 1],
      'collector',
      collectorWidth,
      'planned-circuit-collector',
      'circuit-collector',
    );
  }
  if (highwayLayout?.isCircuit && circuitPoints.length > 2) {
    addPlannedSegment(
      circuitPoints[circuitPoints.length - 1],
      circuitPoints[0],
      'collector',
      collectorWidth,
      'planned-circuit-collector',
      'circuit-collector',
    );
  }

  const radialConnectorCount = Math.max(0, Math.floor(Number(cfg.radialConnectorCount) || 0));
  for (const connector of buildRadialConnectorPairs(waterfrontPoints, circuitPoints, radialConnectorCount)) {
    addPlannedSegment(
      connector.a,
      connector.b,
      'arterial',
      arterialWidth,
      'planned-radial-arterial',
      'radial-arterial',
    );
  }

  const localSeeds = buildDistrictLocalSeeds(rand, zoneMap, cfg, snapGrid, halfW, halfL);
  for (const seed of localSeeds) {
    const directions = getDistrictLocalDirections(seed.zone, rand);
    for (const direction of directions) {
      const target = {
        x: seed.x + Math.cos(direction) * seed.spacing,
        z: seed.z + Math.sin(direction) * seed.spacing,
      };
      addPlannedSegment(
        seed,
        target,
        'local',
        localWidth,
        `planned-${seed.zone || 'mixed'}-local`,
        'district-local',
      );
    }
  }

  return segments;
}

// Backwards-compatible export name for older callers/tests. It now returns the
// planned hierarchy above; it does not emit raw Voronoi street wedges.
export function generateVoronoiRoadSegments(rand, zoneMap = null, highwayLayout = null, backboneSegments = []) {
  return generateHierarchicalRoadSegments(rand, zoneMap, highwayLayout, backboneSegments);
}

function buildWaterfrontCollectorPoints(zoneMap, cfg, snapGrid, halfW, halfL) {
  const samples = typeof zoneMap?.getShorelineSamples === 'function' ? zoneMap.getShorelineSamples() : [];
  if (!Array.isArray(samples) || samples.length < 2) return [];

  const spacing = Math.max(80, Number(cfg.waterfrontCollectorSpacing) || 170);
  const offset = Math.max(25, Number(cfg.waterfrontCollectorOffset) || 72);
  const approxSampleStep = CITY.width / Math.max(1, samples.length - 1);
  const stride = Math.max(1, Math.round(spacing / Math.max(1, approxSampleStep)));
  const points = [];
  for (let i = 0; i < samples.length; i += stride) {
    const sample = samples[i];
    if (!isPointLike(sample)) continue;
    points.push(snapPoint({ x: sample.x, z: sample.z + offset }, snapGrid, halfW, halfL));
  }
  const last = samples[samples.length - 1];
  if (isPointLike(last)) points.push(snapPoint({ x: last.x, z: last.z + offset }, snapGrid, halfW, halfL));
  return dedupeConsecutivePoints(points);
}

function buildCircuitCollectorPoints(highwayLayout, cfg, snapGrid, halfW, halfL) {
  const points = Array.isArray(highwayLayout?.points) ? highwayLayout.points : [];
  if (points.length < 2) return [];

  const spacing = Math.max(90, Number(cfg.circuitCollectorSpacing) || 190);
  const offset = Math.max(60, Number(cfg.circuitCollectorOffset) || 145);
  const out = [];
  let distanceSincePick = Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!isPointLike(p)) continue;
    if (i > 0 && isPointLike(points[i - 1])) distanceSincePick += Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z);
    if (distanceSincePick < spacing && i !== points.length - 1) continue;
    distanceSincePick = 0;
    const inward = normalizeVector(-p.x, -p.z);
    out.push(snapPoint({ x: p.x + inward.x * offset, z: p.z + inward.z * offset }, snapGrid, halfW, halfL));
  }
  return dedupeConsecutivePoints(out);
}

function buildRadialConnectorPairs(waterfrontPoints, circuitPoints, count) {
  if (!count || circuitPoints.length < 2) return [];
  const pairs = [];
  const sortedCircuit = [...circuitPoints].sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x));
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const a = sortedCircuit[Math.min(sortedCircuit.length - 1, Math.max(0, Math.round(t * (sortedCircuit.length - 1))))];
    if (!a) continue;
    const inward = normalizeVector(-a.x, -a.z);
    const radialLength = clamp(Math.hypot(a.x, a.z) * 0.42, 260, 720);
    const b = { x: a.x + inward.x * radialLength, z: a.z + inward.z * radialLength };
    pairs.push({ a, b });
  }

  // A few short waterfront spurs are attempted after the core radials. They are
  // optional because the highway reservation can legitimately sit between the
  // shore and the city core in some seeds.
  if (waterfrontPoints.length >= 2) {
    const sortedWaterfront = [...waterfrontPoints].sort((a, b) => a.x - b.x);
    for (let i = 1; i < count; i += 3) {
      const t = i / Math.max(1, count - 1);
      const waterIndex = Math.min(sortedWaterfront.length - 1, Math.max(0, Math.round(t * (sortedWaterfront.length - 1))));
      const a = sortedWaterfront[waterIndex];
      const b = findNearestByX(a, circuitPoints);
      if (a && b) pairs.push({ a, b });
    }
  }

  return pairs;
}

function buildDistrictLocalSeeds(rand, zoneMap, cfg, snapGrid, halfW, halfL) {
  const base = Math.max(120, Number(cfg.localGridSpacing) || 240);
  const jitter = Math.max(0, Math.min(0.45, Number(cfg.localJitter) || 0));
  const seeds = [];
  for (let x = -halfW + base * 0.5; x < halfW; x += base) {
    for (let z = -halfL + base * 0.5; z < halfL; z += base) {
      const px = x + (rand() * 2 - 1) * base * jitter;
      const pz = z + (rand() * 2 - 1) * base * jitter;
      if (isReservedRoadZone(px, pz, zoneMap)) continue;
      const zone = typeof zoneMap?.getZone === 'function' ? zoneMap.getZone(px, pz) : 'urban';
      const spacing = getDistrictLocalSpacing(zone, cfg);
      if (!spacing) continue;
      if (rand() > getDistrictLocalDensity(zone, cfg)) continue;
      seeds.push({ ...snapPoint({ x: px, z: pz }, snapGrid, halfW, halfL), zone, spacing });
    }
  }
  return seeds;
}

function getDistrictLocalSpacing(zone, cfg) {
  if (zone === 'urban') return Math.max(80, Number(cfg.urbanLocalSpacing) || 145);
  if (zone === 'suburban') return Math.max(110, Number(cfg.suburbanLocalSpacing) || 210);
  if (zone === 'rural') return Math.max(150, Number(cfg.ruralLocalSpacing) || 310);
  return 0;
}

function getDistrictLocalDensity(zone, cfg) {
  if (zone === 'urban') return clamp01(Number(cfg.urbanLocalDensity) || 0.78);
  if (zone === 'suburban') return clamp01(Number(cfg.suburbanLocalDensity) || 0.52);
  if (zone === 'rural') return clamp01(Number(cfg.ruralLocalDensity) || 0.30);
  return 0;
}

function getDistrictLocalDirections(zone, rand) {
  const cardinal = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const diagonal = [Math.PI / 4, -Math.PI / 4, 3 * Math.PI / 4, -3 * Math.PI / 4];
  const pool = zone === 'urban' ? [...cardinal, ...diagonal] : zone === 'suburban' ? [...cardinal, Math.PI / 4, -3 * Math.PI / 4] : cardinal;
  const count = zone === 'urban' ? 2 : 1;
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

function snapPoint(point, snapGrid, halfW, halfL) {
  return {
    x: clamp(Math.round(point.x / snapGrid) * snapGrid, -halfW, halfW),
    z: clamp(Math.round(point.z / snapGrid) * snapGrid, -halfL, halfL),
  };
}

function findNearbyNode(point, nodes, radius) {
  let best = null;
  let bestD2 = radius * radius;
  for (const node of nodes) {
    const d2 = distanceSq(point, node);
    if (d2 <= bestD2) {
      best = node;
      bestD2 = d2;
    }
  }
  return best;
}

function registerNode(nodes, point) {
  if (!findNearbyNode(point, nodes, 1e-3)) nodes.push({ x: point.x, z: point.z });
}

function snapToBackbone(point, backboneSegments, maxDistance) {
  if (!maxDistance || !Array.isArray(backboneSegments)) return null;
  let best = null;
  for (const segment of backboneSegments) {
    if (!isPointLike(segment?.a) || !isPointLike(segment?.b)) continue;
    const projected = projectPointToSegment(point, segment.a, segment.b);
    if (projected.distance <= maxDistance && (!best || projected.distance < best.distance)) best = projected;
  }
  return best?.point ?? null;
}

function hasControlledIntersections(a, b, segments, nodes, minSpacing, minAngle) {
  for (const segment of segments) {
    const shared = sharedEndpoint(a, b, segment.a, segment.b);
    if (shared) {
      if (angleAtSharedEndpoint(shared, a, b, segment.a, segment.b) < minAngle) return false;
      continue;
    }

    const intersection = segmentIntersectionPoint(a, b, segment.a, segment.b);
    if (!intersection) continue;
    const angle = segmentAngleBetween(a, b, segment.a, segment.b);
    if (angle < minAngle) return false;
    if (distanceToAnyNode(intersection, nodes) < minSpacing) return false;
    if (distanceToSegmentEndpoint(intersection, a, b) < minSpacing * 0.5) return false;
    if (distanceToSegmentEndpoint(intersection, segment.a, segment.b) < minSpacing * 0.5) return false;
  }
  return true;
}

function sharedEndpoint(a, b, c, d) {
  const eps = 1e-3;
  if (distanceSq(a, c) <= eps) return a;
  if (distanceSq(a, d) <= eps) return a;
  if (distanceSq(b, c) <= eps) return b;
  if (distanceSq(b, d) <= eps) return b;
  return null;
}

function angleAtSharedEndpoint(shared, a, b, c, d) {
  const p1 = distanceSq(shared, a) <= 1e-3 ? b : a;
  const p2 = distanceSq(shared, c) <= 1e-3 ? d : c;
  return angleBetweenVectors(p1.x - shared.x, p1.z - shared.z, p2.x - shared.x, p2.z - shared.z);
}

function segmentAngleBetween(a, b, c, d) {
  const angle = angleBetweenVectors(b.x - a.x, b.z - a.z, d.x - c.x, d.z - c.z);
  return Math.min(angle, Math.PI - angle);
}

function angleBetweenVectors(ax, az, bx, bz) {
  const al = Math.hypot(ax, az);
  const bl = Math.hypot(bx, bz);
  if (al < 1e-6 || bl < 1e-6) return Math.PI;
  return Math.acos(clamp((ax * bx + az * bz) / (al * bl), -1, 1));
}

function segmentIntersectionPoint(a, b, c, d) {
  const r = { x: b.x - a.x, z: b.z - a.z };
  const s = { x: d.x - c.x, z: d.z - c.z };
  const denom = cross2(r, s);
  if (Math.abs(denom) < 1e-6) return null;
  const ac = { x: c.x - a.x, z: c.z - a.z };
  const t = cross2(ac, s) / denom;
  const u = cross2(ac, r) / denom;
  if (t <= 1e-4 || t >= 1 - 1e-4 || u <= 1e-4 || u >= 1 - 1e-4) return null;
  return { x: a.x + r.x * t, z: a.z + r.z * t };
}

function cross2(a, b) {
  return a.x * b.z - a.z * b.x;
}

function distanceToAnyNode(point, nodes) {
  if (!nodes.length) return Infinity;
  let best = Infinity;
  for (const node of nodes) best = Math.min(best, Math.hypot(point.x - node.x, point.z - node.z));
  return best;
}

function distanceToSegmentEndpoint(point, a, b) {
  return Math.min(Math.hypot(point.x - a.x, point.z - a.z), Math.hypot(point.x - b.x, point.z - b.z));
}

function findNearestByX(point, points) {
  let best = null;
  let bestScore = Infinity;
  for (const candidate of points) {
    const score = Math.abs(candidate.x - point.x) + Math.abs(candidate.z - point.z) * 0.15;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function dedupeConsecutivePoints(points) {
  const out = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || distanceSq(last, point) > 1) out.push(point);
  }
  return out;
}

function normalizeVector(x, z) {
  const len = Math.hypot(x, z);
  if (len < 1e-6) return { x: 0, z: 1 };
  return { x: x / len, z: z / len };
}

export function splitRoadSegmentsByReservedZones(roadSegments, zoneMap, reservationSegments = []) {
  if (!Array.isArray(roadSegments)) return [];
  if (!zoneMap && (!Array.isArray(reservationSegments) || reservationSegments.length === 0)) return roadSegments;
  const out = [];
  for (const segment of roadSegments) {
    out.push(...splitRoadSegmentByReservedZones(segment, zoneMap, reservationSegments));
  }
  return out;
}

export function filterIntersectionsByReservedZones(intersections, zoneMap, reservationSegments = []) {
  if (!Array.isArray(intersections)) return [];
  if (!zoneMap && (!Array.isArray(reservationSegments) || reservationSegments.length === 0)) return intersections;
  return intersections.filter((intersection) => {
    const pos = intersection?.pos;
    const halfWidth = Math.max(Number(intersection?.widthX) || 0, Number(intersection?.widthZ) || 0) * 0.5;
    return isPointLike(pos) && !isReservedRoadZone(pos.x, pos.z, zoneMap, reservationSegments, halfWidth);
  });
}

function splitRoadSegmentByReservedZones(segment, zoneMap, reservationSegments = []) {
  if (!isPointLike(segment?.a) || !isPointLike(segment?.b)) return [];
  const dx = segment.b.x - segment.a.x;
  const dz = segment.b.z - segment.a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return [];

  const segmentHalfWidth = Math.max(0, (Number(segment.width) || 0) * 0.5);
  const sampleStep = Math.max(5, Math.min(12, (Number(segment.width) || CITY.tiers.local || 10) * 0.75));
  const sampleCount = Math.max(1, Math.ceil(len / sampleStep));
  const points = [];
  for (let i = 0; i <= sampleCount; i++) {
    const t = i / sampleCount;
    const point = {
      x: segment.a.x + dx * t,
      z: segment.a.z + dz * t,
      t,
      allowed: !isReservedRoadZone(segment.a.x + dx * t, segment.a.z + dz * t, zoneMap, reservationSegments, segmentHalfWidth),
    };
    points.push(point);
  }

  const minLen = Math.max(20, (Number(segment.width) || 0) * 2);
  const chunks = [];
  let start = null;
  for (let i = 0; i < points.length; i++) {
    if (points[i].allowed && start === null) start = points[i];
    const closesChunk = start && (!points[i].allowed || i === points.length - 1);
    if (!closesChunk) continue;
    const end = points[i].allowed ? points[i] : points[Math.max(0, i - 1)];
    if (end && Math.hypot(end.x - start.x, end.z - start.z) >= minLen) {
      chunks.push({
        ...segment,
        a: { x: start.x, z: start.z },
        b: { x: end.x, z: end.z },
        clippedByReservation: true,
      });
    }
    start = points[i].allowed ? null : null;
  }

  return chunks;
}

export function generateRampFeederSegments(highwayLayout, roadSegments = [], zoneMap = null) {
  const cfg = CITY.voronoiRoads ?? {};
  const ramps = Array.isArray(highwayLayout?.ramps) ? highwayLayout.ramps : [];
  if (!ramps.length || !roadSegments.length) return [];

  const feederWidth = Math.max(4, Number(cfg.feederWidth) || CITY.tiers.thoroughfare2 || 16);
  const feeders = [];

  for (let i = 0; i < ramps.length; i++) {
    const touchdown = getRampTouchdown(ramps[i]);
    if (!touchdown) continue;

    const nearest = findNearestRoadProjection(touchdown, roadSegments);
    if (!nearest) continue;
    if (nearest.distance < feederWidth * 0.5) continue;
    if (segmentTouchesWater(touchdown, nearest.point, zoneMap)) continue;

    feeders.push({
      a: { x: touchdown.x, z: touchdown.z },
      b: nearest.point,
      width: feederWidth,
      kind: 'feeder',
      organic: true,
      streetLevel: true,
      source: 'ramp-feeder',
      rampIndex: i,
    });
  }

  return feeders;
}

function findNearestSiteIndices(sites, siteIndex, count, maxDist) {
  const site = sites[siteIndex];
  return sites
    .map((candidate, index) => ({
      index,
      d2: index === siteIndex ? Infinity : distanceSq(site, candidate),
    }))
    .filter(({ d2 }) => d2 <= maxDist * maxDist)
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, count)
    .map(({ index }) => index);
}

function getRampTouchdown(ramp) {
  if (isPointLike(ramp?.touchdown)) return { x: ramp.touchdown.x, z: ramp.touchdown.z };
  const points = Array.isArray(ramp?.points) ? ramp.points : [];
  if (!points.length) return null;
  let best = points[0];
  for (const point of points) {
    if ((Number(point?.y) || 0) < (Number(best?.y) || 0)) best = point;
  }
  return isPointLike(best) ? { x: best.x, z: best.z } : null;
}

function findNearestRoadProjection(point, roadSegments) {
  let best = null;
  for (const segment of roadSegments) {
    if (!isPointLike(segment?.a) || !isPointLike(segment?.b)) continue;
    if (segment.kind === 'feeder') continue;
    const projected = projectPointToSegment(point, segment.a, segment.b);
    if (!best || projected.distance < best.distance) best = projected;
  }
  return best;
}

function projectPointToSegment(point, a, b) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lenSq = abx * abx + abz * abz;
  const t = lenSq > 1e-6
    ? clamp(((point.x - a.x) * abx + (point.z - a.z) * abz) / lenSq, 0, 1)
    : 0;
  const px = a.x + abx * t;
  const pz = a.z + abz * t;
  return {
    point: { x: px, z: pz },
    distance: Math.hypot(point.x - px, point.z - pz),
  };
}

function clipSegmentToBounds(a, b, halfW, halfL) {
  const clippedA = { x: clamp(a.x, -halfW, halfW), z: clamp(a.z, -halfL, halfL) };
  const clippedB = { x: clamp(b.x, -halfW, halfW), z: clamp(b.z, -halfL, halfL) };
  if (Math.hypot(clippedB.x - clippedA.x, clippedB.z - clippedA.z) < 20) return null;
  return { a: clippedA, b: clippedB };
}

function isReservedRoadZone(x, z, zoneMap, reservationSegments = [], margin = 0) {
  if (Array.isArray(reservationSegments) && reservationSegments.length > 0 && pointTouchesReservation(x, z, reservationSegments, margin)) return true;
  if (!zoneMap) return false;
  if (typeof zoneMap.getWaterInfo === 'function' && zoneMap.getWaterInfo(x, z)?.isWater) return true;
  if (typeof zoneMap.isWater === 'function' && zoneMap.isWater(x, z)) return true;
  if (typeof zoneMap.getZone !== 'function') return false;
  const zone = zoneMap.getZone(x, z);
  return zone === 'highway' || zone === 'water';
}

function pointTouchesReservation(x, z, reservationSegments, margin = 0) {
  const point = { x, z };
  for (const reservation of reservationSegments) {
    if (!isPointLike(reservation?.a) || !isPointLike(reservation?.b)) continue;
    const halfWidth = Math.max(0, Number(reservation.halfWidth) || (Number(reservation.width) || 0) * 0.5);
    if (projectPointToSegment(point, reservation.a, reservation.b).distance <= halfWidth + Math.max(0, margin)) return true;
  }
  return false;
}

function segmentTouchesReservedRoadZone(a, b, zoneMap, reservationSegments = [], margin = 0) {
  if (segmentTouchesReservation(a, b, reservationSegments, margin)) return true;
  return segmentTouchesZone(a, b, zoneMap, isReservedRoadZone);
}

function segmentTouchesReservation(a, b, reservationSegments, margin = 0) {
  if (!Array.isArray(reservationSegments) || reservationSegments.length === 0 || !isPointLike(a) || !isPointLike(b)) return false;
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(len / 8));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    if (pointTouchesReservation(x, z, reservationSegments, margin)) return true;
  }
  return false;
}

function segmentTouchesWater(a, b, zoneMap) {
  return segmentTouchesZone(a, b, zoneMap, (x, z, map) => {
    if (!map) return false;
    if (typeof map.getWaterInfo === 'function') return !!map.getWaterInfo(x, z)?.isWater;
    if (typeof map.isWater === 'function') return map.isWater(x, z);
    return typeof map.getZone === 'function' && map.getZone(x, z) === 'water';
  });
}

function segmentTouchesZone(a, b, zoneMap, predicate) {
  if (!zoneMap || !isPointLike(a) || !isPointLike(b)) return false;
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(len / 18));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    if (predicate(x, z, zoneMap)) return true;
  }
  return false;
}

function isHighwayZone(x, z, zoneMap) {
  if (!zoneMap || typeof zoneMap.getZone !== 'function') return false;
  return zoneMap.getZone(x, z) === 'highway';
}

function isPointLike(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.z);
}

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function clamp01(v) {
  return clamp(v, 0, 1);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
