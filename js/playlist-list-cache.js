/**
 * Persistent cache för GET /me/playlists.
 *
 * Två varianter i separata IDB-nycklar för att undvika kollision:
 *   - "by-prefix": Skapa-flödets prefixfiltrerade lista, innehåller endast id + name
 *     (nyckel `${APP_STORAGE_ID}-plcache-${userId}`).
 *   - "all": Redigera-flödets hela användarlista, inklusive ägare och omslagsbild
 *     (nyckel `${APP_STORAGE_ID}-plcache-${userId}-all`).
 *
 * Lagras per Spotify user-id så att olika konton på samma enhet inte blandar listor.
 * Innehåller endast id + name (+ ägar/bild-metadata i "all"-varianten) — ingen access token,
 * inget personligt innehåll utöver vad användaren själv ser i sin egen Spotify.
 *
 * Format (v: 2):
 *   { v: 2, userId, kind: 'by-prefix' | 'all', prefix, at, truncated, list }
 * Äldre v:1-poster returneras som null (implicit invalidering — användaren laddar om).
 */
import { APP_STORAGE_ID } from './config.js';
import { idbGet, idbPut, idbDelete } from './db.js';

const CACHE_VERSION = 2;

/** @param {string} userId */
function keyForByPrefix(userId) {
  return `${APP_STORAGE_ID}-plcache-${userId}`;
}

/** @param {string} userId */
function keyForAll(userId) {
  return `${APP_STORAGE_ID}-plcache-${userId}-all`;
}

/**
 * @param {string} userId
 * @returns {Promise<{ v: 2, userId: string, kind: 'by-prefix', prefix: string, at: number, truncated: boolean, list: { id: string, name: string }[] } | null>}
 */
export async function readPlaylistListCache(userId) {
  if (!userId) return null;
  try {
    const raw = await idbGet(keyForByPrefix(userId));
    if (!raw || typeof raw !== 'object') return null;
    const o = /** @type {any} */ (raw);
    if (o.v !== CACHE_VERSION) return null;
    if (o.kind && o.kind !== 'by-prefix') return null;
    if (typeof o.userId !== 'string' || o.userId !== userId) return null;
    if (typeof o.prefix !== 'string' || typeof o.at !== 'number') return null;
    if (!Array.isArray(o.list)) return null;
    const list = o.list
      .filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string')
      .map((x) => ({ id: x.id, name: x.name }));
    return {
      v: CACHE_VERSION,
      userId: o.userId,
      kind: 'by-prefix',
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
    await idbPut(keyForByPrefix(userId), {
      v: CACHE_VERSION,
      userId,
      kind: 'by-prefix',
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
    await idbDelete(keyForByPrefix(userId));
  } catch {
    /* ignorera — ingen kritisk sidoeffekt */
  }
}

/**
 * @param {string} userId
 * @returns {Promise<{ v: 2, userId: string, kind: 'all', at: number, truncated: boolean, list: { id: string, name: string, ownerId: string, ownerName: string, imageUrl: string | null }[] } | null>}
 */
export async function readAllPlaylistsCache(userId) {
  if (!userId) return null;
  try {
    const raw = await idbGet(keyForAll(userId));
    if (!raw || typeof raw !== 'object') return null;
    const o = /** @type {any} */ (raw);
    if (o.v !== CACHE_VERSION) return null;
    if (o.kind !== 'all') return null;
    if (typeof o.userId !== 'string' || o.userId !== userId) return null;
    if (typeof o.at !== 'number') return null;
    if (!Array.isArray(o.list)) return null;
    const list = o.list
      .filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string')
      .map((x) => ({
        id: x.id,
        name: x.name,
        ownerId: typeof x.ownerId === 'string' ? x.ownerId : '',
        ownerName: typeof x.ownerName === 'string' ? x.ownerName : '',
        imageUrl: typeof x.imageUrl === 'string' ? x.imageUrl : null,
      }));
    return {
      v: CACHE_VERSION,
      userId: o.userId,
      kind: 'all',
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
 * @param {{ id: string, name: string, ownerId: string, ownerName: string, imageUrl: string | null }[]} list
 * @param {boolean} truncated
 */
export async function writeAllPlaylistsCache(userId, list, truncated) {
  if (!userId) return;
  try {
    await idbPut(keyForAll(userId), {
      v: CACHE_VERSION,
      userId,
      kind: 'all',
      at: Date.now(),
      truncated: Boolean(truncated),
      list: list.map((x) => ({
        id: x.id,
        name: x.name,
        ownerId: x.ownerId ?? '',
        ownerName: x.ownerName ?? '',
        imageUrl: x.imageUrl ?? null,
      })),
    });
  } catch {
    /* persistens är best-effort — in-memory-cachen räcker som fallback */
  }
}

/** @param {string} userId */
export async function deleteAllPlaylistsCache(userId) {
  if (!userId) return;
  try {
    await idbDelete(keyForAll(userId));
  } catch {
    /* ignorera — ingen kritisk sidoeffekt */
  }
}
