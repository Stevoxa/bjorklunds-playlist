/**
 * Persistent cache för playlistens spårinnehåll (GET /playlists/{id}/tracks).
 *
 * En cache-post per (user, playlist). Förvaras i samma IDB-store som playlist-list-cache
 * men med egen nyckel: `${APP_STORAGE_ID}-pltracks-${userId}-${playlistId}`.
 *
 * Rationalen är densamma som för `playlist-list-cache`: undvik onödiga /playlists-tracks-anrop
 * när användaren rör sig fram och tillbaka i Redigera-flödet, och ge stale-if-error-fallback
 * när Spotify rate-limitar oss.
 *
 * Format (v: 1):
 *   { v: 1, userId, playlistId, at, truncated, snapshotId, total, tracks }
 * Där `tracks` är redan-normaliserade rader från `spotify-api.js#getPlaylistTracksAll`.
 * Äldre/okända versioner returneras som null (implicit invalidering).
 */
import { APP_STORAGE_ID } from './config.js';
import { idbGet, idbPut, idbDelete } from './db.js';

const CACHE_VERSION = 1;

/**
 * @param {string} userId
 * @param {string} playlistId
 */
function keyFor(userId, playlistId) {
  return `${APP_STORAGE_ID}-pltracks-${userId}-${playlistId}`;
}

/**
 * @typedef {Object} CachedTrackRow
 * @property {string} uri Spotify-URI (`spotify:track:...` eller `spotify:episode:...`).
 * @property {string} id Spotify-id (utan prefix); tom sträng för lokala filer.
 * @property {string} name
 * @property {string[]} artists Lista av artistnamn (kan vara tom för lokala filer).
 * @property {string} albumName
 * @property {string | null} albumImageUrl
 * @property {number} durationMs
 * @property {string} addedAt ISO-tid från Spotify (eller "" om saknas).
 * @property {boolean} isLocal
 * @property {boolean} isEpisode
 */

/**
 * @param {string} userId
 * @param {string} playlistId
 * @returns {Promise<{
 *   v: 1,
 *   userId: string,
 *   playlistId: string,
 *   at: number,
 *   truncated: boolean,
 *   snapshotId: string,
 *   total: number,
 *   tracks: CachedTrackRow[]
 * } | null>}
 */
export async function readPlaylistTracksCache(userId, playlistId) {
  if (!userId || !playlistId) return null;
  try {
    const raw = await idbGet(keyFor(userId, playlistId));
    if (!raw || typeof raw !== 'object') return null;
    const o = /** @type {any} */ (raw);
    if (o.v !== CACHE_VERSION) return null;
    if (typeof o.userId !== 'string' || o.userId !== userId) return null;
    if (typeof o.playlistId !== 'string' || o.playlistId !== playlistId) return null;
    if (typeof o.at !== 'number') return null;
    if (!Array.isArray(o.tracks)) return null;
    const tracks = o.tracks
      .filter((x) => x && typeof x.uri === 'string' && typeof x.name === 'string')
      .map((x) => ({
        uri: x.uri,
        id: typeof x.id === 'string' ? x.id : '',
        name: x.name,
        artists: Array.isArray(x.artists) ? x.artists.filter((a) => typeof a === 'string') : [],
        albumName: typeof x.albumName === 'string' ? x.albumName : '',
        albumImageUrl: typeof x.albumImageUrl === 'string' ? x.albumImageUrl : null,
        durationMs: Number.isFinite(x.durationMs) ? x.durationMs : 0,
        addedAt: typeof x.addedAt === 'string' ? x.addedAt : '',
        isLocal: Boolean(x.isLocal),
        isEpisode: Boolean(x.isEpisode),
      }));
    return {
      v: CACHE_VERSION,
      userId: o.userId,
      playlistId: o.playlistId,
      at: o.at,
      truncated: Boolean(o.truncated),
      snapshotId: typeof o.snapshotId === 'string' ? o.snapshotId : '',
      total: Number.isFinite(o.total) ? o.total : tracks.length,
      tracks,
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} userId
 * @param {string} playlistId
 * @param {{ tracks: CachedTrackRow[], truncated: boolean, snapshotId: string, total: number }} payload
 */
export async function writePlaylistTracksCache(userId, playlistId, payload) {
  if (!userId || !playlistId) return;
  try {
    await idbPut(keyFor(userId, playlistId), {
      v: CACHE_VERSION,
      userId,
      playlistId,
      at: Date.now(),
      truncated: Boolean(payload.truncated),
      snapshotId: typeof payload.snapshotId === 'string' ? payload.snapshotId : '',
      total: Number.isFinite(payload.total) ? payload.total : payload.tracks.length,
      tracks: payload.tracks.map((x) => ({
        uri: x.uri,
        id: x.id ?? '',
        name: x.name,
        artists: Array.isArray(x.artists) ? x.artists.slice() : [],
        albumName: x.albumName ?? '',
        albumImageUrl: x.albumImageUrl ?? null,
        durationMs: Number.isFinite(x.durationMs) ? x.durationMs : 0,
        addedAt: x.addedAt ?? '',
        isLocal: Boolean(x.isLocal),
        isEpisode: Boolean(x.isEpisode),
      })),
    });
  } catch {
    /* persistens är best-effort */
  }
}

/**
 * @param {string} userId
 * @param {string} playlistId
 */
export async function deletePlaylistTracksCache(userId, playlistId) {
  if (!userId || !playlistId) return;
  try {
    await idbDelete(keyFor(userId, playlistId));
  } catch {
    /* ignorera — ingen kritisk sidoeffekt */
  }
}
