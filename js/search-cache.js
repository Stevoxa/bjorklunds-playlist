import { APP_STORAGE_ID } from './config.js';

const STORAGE_KEY = `${APP_STORAGE_ID}-search-cache-v1`;
export const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 400;

/**
 * Stabil nyckel för exakt samma sökintention som skickas till searchTracks (limit 5).
 * @param {string} query
 * @param {string | undefined} artist
 * @param {string | undefined} title
 */
export function makeSearchCacheKey(query, artist, title) {
  return JSON.stringify({
    q: String(query ?? '').trim(),
    a: String(artist ?? '').trim(),
    t: String(title ?? '').trim(),
    limit: 5,
  });
}

/** @returns {Record<string, { exp: number, tracks: unknown[], savedAt: number }>} */
function readStore() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function writeStore(map) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    const keys = Object.keys(map);
    keys.sort((a, b) => (map[a].savedAt || 0) - (map[b].savedAt || 0));
    for (let i = 0; i < Math.min(80, keys.length); i++) delete map[keys[i]];
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {
      /* ignorera */
    }
  }
}

function pruneExpired(map, now) {
  for (const k of Object.keys(map)) {
    if (map[k].exp < now) delete map[k];
  }
}

/**
 * @param {string} cacheKey
 * @returns {object[] | null} Kopia av träfflista eller null
 */
export function getSearchCache(cacheKey) {
  const now = Date.now();
  const map = readStore();
  const n0 = Object.keys(map).length;
  pruneExpired(map, now);
  if (Object.keys(map).length !== n0) writeStore(map);
  const entry = map[cacheKey];
  if (!entry || typeof entry.exp !== 'number' || !Array.isArray(entry.tracks)) return null;
  if (entry.exp < now) {
    delete map[cacheKey];
    writeStore(map);
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(entry.tracks));
  } catch {
    return null;
  }
}

/**
 * @param {string} cacheKey
 * @param {object[]} tracks
 */
export function setSearchCache(cacheKey, tracks) {
  const now = Date.now();
  const map = readStore();
  pruneExpired(map, now);
  map[cacheKey] = {
    exp: now + SEARCH_CACHE_TTL_MS,
    savedAt: now,
    tracks: JSON.parse(JSON.stringify(tracks)),
  };
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (map[a].savedAt || 0) - (map[b].savedAt || 0));
    for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete map[keys[i]];
  }
  writeStore(map);
}

export function clearSearchCache() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ok */
  }
}

/**
 * Sammanställer statistik för visning i Inställningar → Sökcache:
 *   - entries: antal cachade sökningar (efter TTL-prune)
 *   - bytes:   storlek som JSON i sessionStorage (approx. — ren ASCII + UTF-16-värden)
 *   - oldestAt/newestAt: tidsstämplar för äldsta/nyaste träff (null om tom)
 *
 * Kör TTL-prune i läsläge (men skriver inte tillbaka om ingenting ändrades) så att
 * utgångna poster inte räknas som aktiva. Returnerar alltid ett komplett objekt.
 * @returns {{ entries: number, bytes: number, oldestAt: number | null, newestAt: number | null }}
 */
export function getSearchCacheStats() {
  const now = Date.now();
  const map = readStore();
  const n0 = Object.keys(map).length;
  pruneExpired(map, now);
  const pruned = Object.keys(map).length !== n0;
  if (pruned) writeStore(map);
  const keys = Object.keys(map);
  const entries = keys.length;
  let oldestAt = null;
  let newestAt = null;
  for (const k of keys) {
    const t = Number(map[k]?.savedAt ?? 0);
    if (!Number.isFinite(t) || t <= 0) continue;
    if (oldestAt === null || t < oldestAt) oldestAt = t;
    if (newestAt === null || t > newestAt) newestAt = t;
  }
  let bytes = 0;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (typeof raw === 'string') bytes = raw.length;
  } catch {
    /* ignorera */
  }
  return { entries, bytes, oldestAt, newestAt };
}
