// Tag each plot with a district so the building/prop/parking placers can pick
// from the appropriate Kenney kit.
//
// Districting rule: concentric rings around city centre with seeded jitter.
//   centre → commercial   (skyscrapers + dense buildings)
//   middle → suburban     (houses, trees)
//   outer  → industrial   (warehouses, chimneys, tanks)
//
// Jitter (~25%) breaks the perfectly concentric look so districts feel patchy.

/** @typedef {'suburban'|'commercial'|'industrial'} District */

/**
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} plot
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} bounds
 * @param {() => number} rand
 * @returns {District}
 */
export function classifyPlot(_plot, _bounds, _rand) {
  // Uniform downtown: every plot uses the commercial kit. Building variant
  // (regular vs skyscraper) is selected per-plot in buildings.js.
  return 'commercial';
}
