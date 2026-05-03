/**
 * api.js — thin client for the ValkyrieXMoot backend API.
 *
 * All requests are fire-and-forget safe: errors are swallowed and logged so
 * that a backend outage never crashes or stalls the game loop.
 *
 * The backend is assumed to be at /api (same origin, proxied by nginx).
 * Override API_BASE if needed (e.g. for local dev without the proxy).
 */

const API_BASE = '/api';
const AUTH_BASE = '/auth';

/**
 * GET /auth/me — returns the logged-in player row or null if not authed.
 * @returns {Promise<{id:number, handle:string, display_name:string, avatar_url:string|null}|null>}
 */
export async function getMe() {
  try {
    const res = await fetch(`${AUTH_BASE}/me`, { credentials: 'include' });
    if (res.status === 401) return null;
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn('[api] getMe failed:', err.message);
    return null;
  }
}

/**
 * POST /api/kills — record a kill event for the logged-in player.
 * Silently swallowed if the player is not logged in (401) or backend is down.
 *
 * @param {{ username?: string, handle?: string, id?: number }} mootRow
 * @param {'ram'|'shot'} weapon
 * @param {{ x?: number, z?: number }} [pos]
 * @param {string} [sessionId]
 */
export async function postKill(mootRow, weapon, pos = {}, sessionId = '') {
  try {
    const body = {
      weapon,
      session_id: sessionId || undefined,
    };
    // Prefer handle (username field in moots.json) for resolution on the backend.
    if (mootRow.username) body.moot_handle = mootRow.username;
    else if (mootRow.handle) body.moot_handle = mootRow.handle;
    else if (mootRow.id) body.moot_id = mootRow.id;

    if (pos.x != null) body.pos_x = pos.x;
    if (pos.z != null) body.pos_z = pos.z;

    const res = await fetch(`${API_BASE}/kills`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 401) {
      console.warn('[api] postKill non-ok:', res.status);
    }
  } catch (err) {
    console.warn('[api] postKill failed:', err.message);
  }
}

/**
 * POST /api/queue — enqueue the logged-in player for pfp→moot conversion.
 * Safe to call multiple times — backend returns 409 on duplicate, which is fine.
 * @returns {Promise<boolean>} true if enqueued (201), false otherwise
 */
export async function postQueue() {
  try {
    const res = await fetch(`${API_BASE}/queue`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return res.status === 201;
  } catch (err) {
    console.warn('[api] postQueue failed:', err.message);
    return false;
  }
}
