/**
 * lib/world/zones/zoneTypes.js
 *
 * Zone type constants.  Imported by zoneMap.js, city generator, park generator,
 * nav grid, etc.  No THREE.js imports — pure constants.
 */

export const URBAN    = 'urban';
export const SUBURBAN = 'suburban';
export const RURAL    = 'rural';
export const PARK     = 'park';
export const BEACH    = 'beach';
export const WATER    = 'water';
export const HIGHWAY  = 'highway';

/** All zone type strings in one array (useful for iteration / validation). */
export const ALL_ZONES = [URBAN, SUBURBAN, RURAL, PARK, BEACH, WATER, HIGHWAY];

/**
 * Returns true if the zone supports building placement.
 * Beach, water, park, and highway zones are building-free.
 */
export function isBuildable(zone) {
  return zone === URBAN || zone === SUBURBAN || zone === RURAL;
}

/**
 * Returns true if moots can walk in this zone (used by nav grid).
 * Park zones are walkable open space; highway, beach, and water are not navigable.
 */
export function isNavWalkable(zone) {
  return zone === URBAN || zone === SUBURBAN || zone === RURAL || zone === PARK;
}
