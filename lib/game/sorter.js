/**
 * lib/game/sorter.js — moot sort keys and layout applicator.
 *
 * SORTERS   — map of sort key → comparator for moot rows.
 * applySort — reposition moot groups in world-space order.
 */

import { MOOT } from '../config.js';
import { hashRandom } from '../rand.js';

/**
 * Comparator map keyed by the value of the #sort <select> element.
 * Each function compares two MootRow objects.
 *
 * @type {Record<string, (a: import('../data/mootLoader.js').MootRow, b: import('../data/mootLoader.js').MootRow) => number>}
 */
export const SORTERS = {
  rank: (a, b) => (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY),
  username: (a, b) =>
    (a.username || '').toLowerCase().localeCompare((b.username || '').toLowerCase()),
  display_name: (a, b) =>
    (a.display_name || '').toLowerCase().localeCompare((b.display_name || '').toLowerCase()),
  match_distance: (a, b) =>
    (a.match_distance ?? Number.POSITIVE_INFINITY) - (b.match_distance ?? Number.POSITIVE_INFINITY),
  has_chibi: (a, b) => {
    const av = a.chibi_file ? 0 : 1;
    const bv = b.chibi_file ? 0 : 1;
    if (av !== bv) return av - bv;
    return (a.username || '').localeCompare(b.username || '');
  },
};

/**
 * Sort `moots` by `key`, then reposition each moot group along the Z corridor.
 *
 * @param {string} key — one of the keys in SORTERS (falls back to 'rank')
 * @param {import('../data/mootLoader.js').MootRow[]} moots
 * @param {{ group: import('three').Group }[]} handles
 */
export function applySort(key, moots, handles) {
  const cmp = SORTERS[key] || SORTERS.rank;
  const order = moots.map((_, i) => i);
  order.sort((ia, ib) => cmp(moots[ia], moots[ib]));
  for (let pos = 0; pos < order.length; pos++) {
    const h = handles[order[pos]];
    h.group.position.set((hashRandom(pos) * 2 - 1) * MOOT.jitterX, 0, -pos * MOOT.spacing);
  }
}
