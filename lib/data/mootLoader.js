/**
 * Runtime database module. Loads moots.json and provides helpers used by
 * main.js during session setup.
 *
 * Exports:
 *   loadDb()            → Promise<MootRow[]>
 *   selectRandom(db, n) → MootRow[]   (shuffled copy, first n)
 *   avatarSource(row)   → { kind: 'static'|'animated', file: string|null }
 */

/** @typedef {{ id: string, username: string, display_name: string,
 *              pfp_file: string|null, chibi_file: string|null,
 *              animated_file: string|null, match_distance: number|null,
 *              rank: number }} MootRow */

/**
 * Fetch and parse data/moots.json relative to the document root.
 * Throws if the fetch fails or the response is not valid JSON.
 * @returns {Promise<MootRow[]>}
 */
export async function loadDb() {
  const res = await fetch('data/moots.json');
  if (!res.ok) {
    throw new Error(`Failed to load moots.json: ${res.status} ${res.statusText}`);
  }
  return /** @type {MootRow[]} */ (await res.json());
}

/**
 * Fisher-Yates shuffle on a shallow copy, then return the first n entries.
 * If n >= db.length, returns all rows in shuffled order.
 * @param {MootRow[]} db
 * @param {number} n
 * @returns {MootRow[]}
 */
export function selectRandom(db, n) {
  const arr = db.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, Math.min(n, arr.length));
}

/**
 * Inspect a moot row and return a discriminated union describing which texture
 * source to use.
 *
 *   kind:'animated' → animated_file is non-null; caller should use VideoTexture
 *   kind:'static'   → fall back to chibi_file (may itself be null → placeholder)
 *
 * @param {MootRow} row
 * @returns {{ kind: 'animated', file: string } | { kind: 'static', file: string|null }}
 */
export function avatarSource(row) {
  if (row.animated_file) {
    return { kind: 'animated', file: row.animated_file };
  }
  return { kind: 'static', file: row.chibi_file ?? null };
}
