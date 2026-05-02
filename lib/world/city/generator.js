import { mulberry32 } from '../../rand.js';
import { CITY } from '../../config.js';
import { generateRoadGrid, gridToSegments } from './roads.js';
import { extractBlocks, insertAlleys, subdividePlots } from './blocks.js';
import { placeBuildings } from './buildings.js';
import { placeProps, placeParkedCars } from './props.js';
import { buildCityGround } from './sidewalks.js';
import { buildRoadMarkings } from './roadMarkings.js';
import { buildNavGrid } from '../../nav/grid.js';
import { initBuildingTexturePool, getBuildingTexture } from '../../buildingTexture.js';
import { buildPerimeterWall } from './perimeterWall.js';
import { createSpatialGrid } from '../spatialGrid.js';
import { loadKits } from './prefabs.js';

// Phase 1: real city. Perturbed grid of streets, alley pass on long blocks,
// BSP plot subdivision, building meshes per plot, ground/road/sidewalk planes.
//
// One vertical street is always anchored at x=0 with mainStreetWidth so the
// existing moot-corridor placement (x ≈ ±jitter, z = -i*spacing) lands on a
// real road. Phase 8 will replace corridor placement with sidewalk-node
// spawning and that anchor can go.
export async function generateCity({ scene, seed = CITY.seed, onProgress }) {
  const rand = mulberry32(seed);

  // Lazy-load Kenney prefab kits the first time a city is built. Subsequent
  // rebuilds short-circuit on the cached scene/texture maps inside prefabs.js.
  await loadKits(onProgress);

  const { xLines, zLines } = generateRoadGrid(rand);
  const { segments, intersections } = gridToSegments(xLines, zLines);

  const blocks = extractBlocks(xLines, zLines);
  const { subBlocks, alleys } = insertAlleys(blocks, rand);

  const plots = [];
  for (const sb of subBlocks) subdividePlots(sb, rand, 0, plots);

  const bounds = {
    minX: xLines[0].x - xLines[0].width / 2 - CITY.sidewalkWidth,
    maxX: xLines[xLines.length - 1].x + xLines[xLines.length - 1].width / 2 + CITY.sidewalkWidth,
    minZ: zLines[0].z - zLines[0].width / 2 - CITY.sidewalkWidth,
    maxZ: zLines[zLines.length - 1].z + zLines[zLines.length - 1].width / 2 + CITY.sidewalkWidth,
  };

  // Build the shared texture pool once per city from the seeded PRNG.
  // Disposes any previously allocated CanvasTextures before generating new ones.
  initBuildingTexturePool(rand);

  const interestPoints = buildCityGround(scene, bounds, xLines, zLines, alleys);
  buildRoadMarkings(scene, xLines, zLines, intersections, bounds);
  const buildingAABBs  = placeBuildings(scene, plots, rand, bounds);

  // District-aware decoration. Trees + chimneys/tanks are visual only;
  // parked cars become solid obstacles via the AABB list.
  placeProps(scene, plots, rand);
  const parkedCarAABBs = placeParkedCars(scene, plots, rand);
  buildingAABBs.push(...parkedCarAABBs);

  // Add perimeter wall towers around all 4 map edges; append AABBs so the
  // truck collision system treats them as solid obstacles.
  const wallAABBs = buildPerimeterWall(scene, bounds, getBuildingTexture);
  buildingAABBs.push(...wallAABBs);

  const roadSegments = [...segments, ...alleys];

  const navGrid = buildNavGrid({
    bounds,
    buildingAABBs,
    roadSegments,
    intersections,
    interestPoints,
    alleys,
  });

  const buildingGrid = createSpatialGrid(buildingAABBs, 20);

  return {
    roadSegments,
    intersections,
    sidewalkPolys: [],
    buildingAABBs,
    buildingGrid,
    interestPoints,
    bounds,
    navGrid,
  };
}
