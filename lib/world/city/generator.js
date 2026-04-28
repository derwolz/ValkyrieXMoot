import { mulberry32 } from '../../rand.js';
import { CITY, MOOT } from '../../config.js';
import { generateRoadGrid, gridToSegments } from './roads.js';
import { extractBlocks, insertAlleys, subdividePlots } from './blocks.js';
import { placeBuildings } from './buildings.js';
import { buildCityGround } from './sidewalks.js';
import { buildNavGrid } from '../../nav/grid.js';

// Phase 1: real city. Perturbed grid of streets, alley pass on long blocks,
// BSP plot subdivision, building meshes per plot, ground/road/sidewalk planes.
//
// One vertical street is always anchored at x=0 with mainStreetWidth so the
// existing moot-corridor placement (x ≈ ±jitter, z = -i*spacing) lands on a
// real road. Phase 8 will replace corridor placement with sidewalk-node
// spawning and that anchor can go.
export function generateCity({ scene, seed = CITY.seed }) {
  const rand = mulberry32(seed);

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

  const interestPoints = buildCityGround(scene, bounds, xLines, zLines, alleys);
  const buildingAABBs = placeBuildings(scene, plots, rand);

  const roadSegments = [...segments, ...alleys];

  const navGrid = buildNavGrid({
    bounds,
    buildingAABBs,
    roadSegments,
    intersections,
    interestPoints,
    alleys,
  });

  return {
    roadSegments,
    intersections,
    sidewalkPolys: [],
    buildingAABBs,
    interestPoints,
    bounds,
    navGrid,
  };
}
