import { CITY } from '../../config.js';

function zoneAt(zoneMap, x, z) {
  return zoneMap ? zoneMap.getZone(x, z) : 'urban';
}

function forSegments(start, end, maxLength, visit) {
  const direction = end >= start ? 1 : -1;
  let cursor = start;
  while ((direction > 0 && cursor < end) || (direction < 0 && cursor > end)) {
    const next = direction > 0
      ? Math.min(cursor + maxLength, end)
      : Math.max(cursor - maxLength, end);
    const center = (cursor + next) / 2;
    const length = Math.abs(next - cursor);
    if (length > 0) visit(center, length);
    cursor = next;
  }
}

function rectanglePoly(x, z, width, depth, kind) {
  return {
    kind,
    minX: x - width / 2,
    maxX: x + width / 2,
    minZ: z - depth / 2,
    maxZ: z + depth / 2,
    x,
    z,
    width,
    depth,
  };
}

function segmentPoly(a, b, width, kind) {
  const minX = Math.min(a.x, b.x) - width / 2;
  const maxX = Math.max(a.x, b.x) + width / 2;
  const minZ = Math.min(a.z, b.z) - width / 2;
  const maxZ = Math.max(a.z, b.z) + width / 2;
  return {
    kind,
    a,
    b,
    width,
    minX,
    maxX,
    minZ,
    maxZ,
    organic: true,
  };
}

export function buildSidewalkLayout(bounds, xLines, zLines, alleys, zoneMap = null, organicRoadSegments = []) {
  const infraSegmentLength = CITY.infrastructureSegmentLength ?? 40;
  const interestPoints = [];
  const sidewalkPolys = [];

  // Vertical streets (run along z) + flanking sidewalks.
  for (const xL of xLines) {
    for (const side of [-1, 1]) {
      const swX = xL.x + side * (xL.width / 2 + CITY.sidewalkWidth / 2);

      forSegments(bounds.minZ, bounds.maxZ, infraSegmentLength, (segZ, segD) => {
        const zone = zoneAt(zoneMap, swX, segZ);
        if (zone === 'beach' || zone === 'highway' || zone === 'water') return;
        sidewalkPolys.push(rectanglePoly(swX, segZ, CITY.sidewalkWidth, segD, 'sidewalk'));
      });

      // Sample interest points along this sidewalk every ~12 m.
      for (let z = bounds.minZ + 6; z < bounds.maxZ - 6; z += 12) {
        const ptZone = zoneAt(zoneMap, swX, z);
        if (ptZone !== 'beach' && ptZone !== 'highway' && ptZone !== 'water') {
          interestPoints.push({ x: swX, z, kind: 'sidewalk' });
        }
      }
    }
  }

  // Horizontal streets (run along x) + flanking sidewalks.
  for (const zL of zLines) {
    for (const side of [-1, 1]) {
      const swZ = zL.z + side * (zL.width / 2 + CITY.sidewalkWidth / 2);

      forSegments(bounds.minX, bounds.maxX, infraSegmentLength, (segX, segW) => {
        const zone = zoneAt(zoneMap, segX, swZ);
        if (zone === 'beach' || zone === 'highway' || zone === 'water') return;
        sidewalkPolys.push(rectanglePoly(segX, swZ, segW, CITY.sidewalkWidth, 'sidewalk'));
      });

      for (let x = bounds.minX + 6; x < bounds.maxX - 6; x += 12) {
        const ptZone = zoneAt(zoneMap, x, swZ);
        if (ptZone !== 'beach' && ptZone !== 'highway' && ptZone !== 'water') {
          interestPoints.push({ x, z: swZ, kind: 'sidewalk' });
        }
      }
    }
  }

  // Alleys — no flanking sidewalks, but they are pedestrian interest corridors.
  appendAlleyInterestPoints(alleys, interestPoints);
  appendOrganicSidewalks(organicRoadSegments, sidewalkPolys, interestPoints, zoneMap);

  return { sidewalkPolys, interestPoints };
}

function appendOrganicSidewalks(roadSegments, sidewalkPolys, interestPoints, zoneMap) {
  if (!Array.isArray(roadSegments)) return;
  const sidewalkWidth = CITY.sidewalkWidth;

  for (const road of roadSegments) {
    if (!isPointLike(road?.a) || !isPointLike(road?.b)) continue;
    const dx = road.b.x - road.a.x;
    const dz = road.b.z - road.a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1) continue;

    const nx = -dz / len;
    const nz = dx / len;
    const offset = (Number(road.width) || CITY.tiers.local || 10) / 2 + sidewalkWidth / 2;
    for (const side of [-1, 1]) {
      const a = {
        x: road.a.x + nx * offset * side,
        z: road.a.z + nz * offset * side,
      };
      const b = {
        x: road.b.x + nx * offset * side,
        z: road.b.z + nz * offset * side,
      };
      const mid = { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 };
      const zone = zoneAt(zoneMap, mid.x, mid.z);
      if (zone === 'beach' || zone === 'highway' || zone === 'water') continue;
      sidewalkPolys.push(segmentPoly(a, b, sidewalkWidth, 'sidewalk'));
    }

    const step = 12;
    for (let dist = 6; dist < len - 6; dist += step) {
      const t = dist / len;
      const x = road.a.x + dx * t;
      const z = road.a.z + dz * t;
      const zone = zoneAt(zoneMap, x, z);
      if (zone !== 'beach' && zone !== 'highway' && zone !== 'water') {
        interestPoints.push({ x, z, kind: road.kind === 'feeder' ? 'ramp-feeder' : 'organic-road' });
      }
    }
  }
}

function appendAlleyInterestPoints(alleys, interestPoints) {
  for (const a of alleys) {
    if (a.a.x === a.b.x) {
      const zFrom = Math.min(a.a.z, a.b.z);
      const zTo = Math.max(a.a.z, a.b.z);
      for (let z = zFrom + 5; z < zTo - 5; z += 10) {
        interestPoints.push({ x: a.a.x, z, kind: 'alley' });
      }
    } else {
      const xFrom = Math.min(a.a.x, a.b.x);
      const xTo = Math.max(a.a.x, a.b.x);
      for (let x = xFrom + 5; x < xTo - 5; x += 10) {
        interestPoints.push({ x, z: a.a.z, kind: 'alley' });
      }
    }
  }
}

// Terrain-level city surfaces are baked into lib/world/terrain/heightmap.js.
// This helper is kept as the non-render interest-point bridge used by the nav
// grid. It intentionally does not add ground, road, sidewalk, or alley meshes.
export function buildCityGround(_scene, bounds, xLines, zLines, alleys, zoneMap = null, _getTerrainY = null, layout = null) {
  if (Array.isArray(layout?.interestPoints)) {
    return [...layout.interestPoints];
  }

  const interestPoints = [];

  function cityZoneAt(x, z) {
    return zoneAt(zoneMap, x, z);
  }

  // Vertical street sidewalks.
  for (const xL of xLines) {
    for (const side of [-1, 1]) {
      const swX = xL.x + side * (xL.width / 2 + CITY.sidewalkWidth / 2);
      for (let z = bounds.minZ + 6; z < bounds.maxZ - 6; z += 12) {
        const ptZone = cityZoneAt(swX, z);
        if (ptZone !== 'beach' && ptZone !== 'highway' && ptZone !== 'water') {
          interestPoints.push({ x: swX, z, kind: 'sidewalk' });
        }
      }
    }
  }

  // Horizontal street sidewalks.
  for (const zL of zLines) {
    for (const side of [-1, 1]) {
      const swZ = zL.z + side * (zL.width / 2 + CITY.sidewalkWidth / 2);
      for (let x = bounds.minX + 6; x < bounds.maxX - 6; x += 12) {
        const ptZone = cityZoneAt(x, swZ);
        if (ptZone !== 'beach' && ptZone !== 'highway' && ptZone !== 'water') {
          interestPoints.push({ x, z: swZ, kind: 'sidewalk' });
        }
      }
    }
  }

  appendAlleyInterestPoints(alleys, interestPoints);
  appendOrganicSidewalks(layout?.organicRoadSegments, [], interestPoints, zoneMap);

  return interestPoints;
}

function isPointLike(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.z);
}
