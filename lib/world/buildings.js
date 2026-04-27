import { generateCity } from './city/generator.js';

// Adapter kept so main.js doesn't need to change in lockstep with the
// generator. corridorLength is ignored — the city sizes itself from CITY config.
export function buildBuildings(scene, _corridorLength) {
  const city = generateCity({ scene });
  return city.buildingAABBs;
}
