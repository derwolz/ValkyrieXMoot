import { mulberry32 } from '../../rand.js';
import { CITY } from '../../config.js';
import {
  generateRoadGrid,
  gridToSegments,
  generateRampFeederSegments,
  generateHierarchicalRoadSegments,
  splitRoadSegmentsByReservedZones,
  filterIntersectionsByReservedZones,
  applyRoundaboutsToRoadSegments,
} from './roads.js';
import {
  extractBlocks,
  insertAlleys,
  subdividePlots,
  filterPlotsNearRoads,
  filterPlotsByZoneMask,
} from './blocks.js';
import { placeBuildings, placeBoundaryBlockers, disposeBuildingMeshes } from './buildings.js';
import { placeParkedCars, placeProps } from './props.js';
import { buildCityGround, buildSidewalkLayout } from './sidewalks.js';
import { buildNavGrid } from '../../nav/grid.js';
import { createSpatialGrid } from '../spatialGrid.js';
import { isBuildable } from '../zones/zoneTypes.js';

/**
 * Generate all non-render city layout data needed before terrain creation.
 * This intentionally does not add meshes to the scene; it only returns road,
 * alley, plot, bounds, and sidewalk/interest-point data so terrain can bake
 * city surfaces before buildings and population sample terrain heights.
 */
export function generateCityLayout({
  seed = CITY.seed,
  zoneMap = null,
  highwayLayout = null,
} = {}) {
  const rand = mulberry32(seed);

  const { xLines, zLines } = generateRoadGrid(rand, zoneMap);
  const { segments: rawGridSegments, intersections: rawIntersections } = gridToSegments(
    xLines,
    zLines,
  );
  const highwayReservationSegments = highwayReservationsToSegments(
    highwayLayout?.reservationPolylines,
  );
  const segments = splitRoadSegmentsByReservedZones(
    rawGridSegments,
    zoneMap,
    highwayReservationSegments,
  );
  const intersections = filterIntersectionsByReservedZones(
    rawIntersections,
    zoneMap,
    highwayReservationSegments,
  );
  const rawPlannedRoadSegments = generateHierarchicalRoadSegments(
    rand,
    zoneMap,
    highwayLayout,
    segments,
  );
  const plannedRoadSegments = splitRoadSegmentsByReservedZones(
    rawPlannedRoadSegments,
    zoneMap,
    highwayReservationSegments,
  );
  const rampFeederSegments = generateRampFeederSegments(
    highwayLayout,
    [...segments, ...plannedRoadSegments],
    zoneMap,
  );
  const roundaboutLayout = applyRoundaboutsToRoadSegments(
    [...segments, ...plannedRoadSegments, ...rampFeederSegments],
    CITY.voronoiRoads,
  );
  const surfaceRoadSegments = roundaboutLayout.roadSegments;
  const organicRoadSegments = surfaceRoadSegments.filter((segment) => segment.organic);

  const blocks = extractBlocks(xLines, zLines);
  const { subBlocks, alleys: rawAlleys } = insertAlleys(blocks, rand);
  const alleys = splitRoadSegmentsByReservedZones(rawAlleys, zoneMap, highwayReservationSegments);

  // Filter sub-blocks: only keep those in buildable zones (urban/suburban/rural).
  // Park, beach, highway blocks get no buildings.
  const buildablePlots = [];
  for (const sb of subBlocks) {
    const cx = (sb.minX + sb.maxX) / 2;
    const cz = (sb.minZ + sb.maxZ) / 2;
    const zone = zoneMap ? zoneMap.getZone(cx, cz) : 'urban';
    if (isBuildable(zone)) {
      const profile = CITY.zoneBuildProfiles?.[zone] ?? CITY.zoneBuildProfiles?.urban ?? {};
      subdividePlots({ ...sb, zone }, rand, 0, buildablePlots, profile);
    }
  }
  const plotClearance = CITY.voronoiRoads?.plotClearance ?? 0;
  const zoneMaskedBuildablePlots = filterPlotsByZoneMask(buildablePlots, zoneMap);
  const filteredBuildablePlots = filterPlotsNearRoads(
    zoneMaskedBuildablePlots,
    [...organicRoadSegments, ...highwayReservationSegments],
    plotClearance,
  );

  const bounds = {
    minX: xLines[0].x - xLines[0].width / 2 - CITY.sidewalkWidth,
    maxX: xLines[xLines.length - 1].x + xLines[xLines.length - 1].width / 2 + CITY.sidewalkWidth,
    minZ: zLines[0].z - zLines[0].width / 2 - CITY.sidewalkWidth,
    maxZ: zLines[zLines.length - 1].z + zLines[zLines.length - 1].width / 2 + CITY.sidewalkWidth,
  };

  const roadSegments = [...surfaceRoadSegments, ...alleys];
  const sidewalkLayout = buildSidewalkLayout(
    bounds,
    xLines,
    zLines,
    alleys,
    zoneMap,
    organicRoadSegments,
  );
  const buildingSeed = Math.floor(rand() * 0xffffffff) >>> 0;

  return {
    seed,
    buildingSeed,
    rand,
    xLines,
    zLines,
    segments,
    roadSegments,
    intersections,
    blocks,
    subBlocks,
    alleys,
    organicRoadSegments,
    plannedRoadSegments,
    roundabouts: roundaboutLayout.roundabouts,
    rampFeederSegments,
    buildablePlots: filteredBuildablePlots,
    bounds,
    sidewalkPolys: sidewalkLayout.sidewalkPolys,
    interestPoints: sidewalkLayout.interestPoints,
  };
}

/**
 * Zone-aware city generator.
 *
 * @param {{
 *   scene:       import('three').Scene,
 *   seed?:       number,
 *   zoneMap?:    { getZone:(x:number,z:number)=>string, getHeight:(x:number,z:number)=>number },
 *   highwayLayout?: { ramps?: Array<object> },
 *   getTerrainY?: (x:number,z:number) => number,
 *   layout?:     ReturnType<typeof generateCityLayout>,
 * }} opts
 */
export function generateCity({
  scene,
  seed = CITY.seed,
  zoneMap = null,
  highwayLayout = null,
  getTerrainY = null,
  layout = null,
}) {
  const cityLayout = layout ?? generateCityLayout({ seed, zoneMap, highwayLayout });
  const rand = mulberry32(cityLayout.buildingSeed ?? seed);
  const {
    xLines,
    zLines,
    alleys,
    buildablePlots,
    bounds,
    roadSegments,
    intersections,
    sidewalkPolys = [],
  } = cityLayout;

  const interestPoints = buildCityGround(
    scene,
    bounds,
    xLines,
    zLines,
    alleys,
    zoneMap,
    getTerrainY,
    cityLayout,
  );
  const { aabbs: plotBuildingAABBs } = placeBuildings(
    scene,
    buildablePlots,
    rand,
    getTerrainY,
    bounds,
  );
  placeProps(scene, buildablePlots, rand);
  const parkedCarAABBs = placeParkedCars(scene, buildablePlots, rand);
  const { aabbs: boundaryAABBs } = placeBoundaryBlockers(scene, bounds, getTerrainY, zoneMap);
  // Building collision records preserve the existing X/Z AABB fields used by
  // nav/spatial grids and additionally carry minY/maxY for height-aware vehicle
  // collision.
  const buildingAABBs = [...plotBuildingAABBs, ...parkedCarAABBs, ...boundaryAABBs];

  const navGrid = buildNavGrid({
    bounds,
    buildingAABBs,
    roadSegments,
    intersections,
    interestPoints,
    alleys,
    zoneMap,
  });

  const buildingGrid = createSpatialGrid(buildingAABBs, 20);

  return {
    roadSegments,
    intersections,
    sidewalkPolys,
    buildingAABBs,
    boundaryAABBs,
    buildingGrid,
    interestPoints,
    bounds,
    navGrid,
    zoneMap,
    layout: cityLayout,
    disposeBuildingMeshes,
  };
}

export function serializeCityLayout(layout) {
  if (!layout || typeof layout !== 'object') return null;
  const { rand: _rand, ...serializable } = layout;
  return JSON.parse(JSON.stringify(serializable));
}

function highwayReservationsToSegments(reservations) {
  if (!Array.isArray(reservations)) return [];
  const segments = [];
  for (const reservation of reservations) {
    const points = Array.isArray(reservation?.points) ? reservation.points : [];
    const halfWidth = Math.max(0, Number(reservation?.halfWidth) || 0);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (!isPointLike(a) || !isPointLike(b)) continue;
      segments.push({
        a: { x: a.x, z: a.z },
        b: { x: b.x, z: b.z },
        width: halfWidth * 2,
        kind: `highway-reservation-${reservation.kind || 'corridor'}`,
        source: 'highway-reservation',
      });
    }
  }
  return segments;
}

function isPointLike(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.z);
}

export function hydrateCityLayout(snapshot, seed = CITY.seed) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const layoutSeed = Number.isFinite(Number(snapshot.seed)) ? Number(snapshot.seed) : seed;
  const buildingSeed = Number.isFinite(Number(snapshot.buildingSeed))
    ? Number(snapshot.buildingSeed)
    : layoutSeed;
  return {
    ...snapshot,
    seed: layoutSeed,
    buildingSeed,
  };
}
