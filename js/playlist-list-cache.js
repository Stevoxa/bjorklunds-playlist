/**
 * Persistent cache för GET /me/playlists (prefixfiltrerad lista).
 *
 * Lagras per Spotify user-id så att olika konton på samma enhet inte blandar listor.
 * Innehåller endast id + name — ingen access token, inget personligt innehåll
 * utöver vad användaren själv ser i sin egen Spotify. Samma risknivå som vault-store
 * i IDB (redan etablerad) men behöver aldrig krypteras.
 *
 * Format (v: 1):
 *   { v: 1, userId, prefix, at, truncated, list: [{ id, name }, ...] }
 */
import { APP_STORAGE_ID } from './config.js';
import { idbGet, idbPut, idbDelete } from './db.js';

const CACHE_VERSION = 1;

/** @param {string} userId */
function keyFor(userId) {
  return `${APP_STORAGE_ID}-plcache-${userId}`;
}

/**
 * @param {string} userId
 * @returns {Promise<{ v: 1, userId: string, prefix: string, at: number, truncated: boolean, list: { id: string, name: string }[] } | null>}
 */
export async function readPlaylistListCache(userId) {
  if (!userId) return null;
  try {
    const raw = await idbGet(keyFor(userId));
    if (!raw || typeof raw !== 'object') return null;
    const o = /** @type {any} */ (raw);
    if (o.v !== CACHE_VERSION) return null;
    if (typeof o.userId !== 'string' || o.userId !== userId) return null;
    if (typeof o.prefix !== 'string' || typeof o.at !== 'number') return null;
    if (!Array.isArray(o.list)) return null;
    const list = o.list
      .filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string')
      .map((x) => ({ id: x.id, name: x.name }));
    return {
      v: CACHE_VERSION,
      userId: o.userId,
      prefix: o.prefix,
      at: o.at,
      truncated: Boolean(o.truncated),
      list,
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} userId
 * @param {string} prefix
 * @param {{ id: string, name: string }[]} list
 * @param {boolean} truncated
 */
export async function writePlaylistListCache(userId, prefix, list, truncated) {
  if (!userId) return;
  try {
    await idbPut(keyFor(userId), {
      v: CACHE_VERSION,
      userId,
      prefix,
      at: Date.now(),
      truncated: Boolean(truncated),
      list: list.map((x) => ({ id: x.id, name: x.name })),
    });
  } catch {
    /* persistens är best-effort — in-memory-cachen räcker som fallback */
  }
}

/** @param {string} userId */
export async function deletePlaylistListCache(userId) {
  if (!userId) return;
  try {
    await idbDelete(keyFor(userId));
  } catch {
    /* ignorera — ingen kritisk sidoeffekt */
  }
}
