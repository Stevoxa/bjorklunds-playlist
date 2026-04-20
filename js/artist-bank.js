/**
 * Persistent artist-bank (per Spotify user-id) för att stärka `suspectSwap`-detektering
 * över sessioner. Samlar artistnamn (lowercased, trimmade) från tidigare träffar så att
 * framtida sökbatcher kan:
 *   1) Börja körningen med en förseedad knownArtistsLc-set i `runSearch`.
 *   2) Klassa en rad som `suspectSwap` även om den innehåller en artist vi sett förra
 *      sessionen (t.ex. "Levitating - Dua Lipa" efter att Dua Lipa loggats som artist).
 *
 * Säkerhet / integritet:
 *   - Endast publika artistnamn lagras (samma namn Spotify visar i alla sökträffar).
 *   - Inga access-tokens, inga användaruppgifter, inget personligt innehåll utöver detta.
 *   - Lagras per Spotify user-id i IDB (samma mekanism som vault-store / playlist-list-cache)
 *     så att olika konton på samma enhet inte blandas.
 *   - Rensas vid logout via `deleteArtistBank`.
 *
 * Storleksbegränsning:
 *   - Högst MAX_ARTISTS (FIFO-evict, oldest first).
 *   - Artister kortare än 2 tecken hoppas över (hanterar tomma/ogiltiga namn).
 *
 * Format (v: 1):
 *   { v: 1, userId: string, at: number, artists: string[] }   // artists: lowercased, unika
 */
import { APP_STORAGE_ID } from './config.js';
import { idbGet, idbPut, idbDelete } from './db.js';

const CACHE_VERSION = 1;

/** Soft cap för persistent bank — tillräckligt för långa sessioner, men håller IDB-storlek låg. */
const MAX_ARTISTS = 2000;

/** @param {string} userId */
function keyFor(userId) {
  return `${APP_STORAGE_ID}-artistbank-${userId}`;
}

/** @param {unknown} v @returns {string} */
function normalize(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * @param {string} userId
 * @returns {Promise<{ v: 1, userId: string, at: number, artists: string[] } | null>}
 */
export async function readArtistBank(userId) {
  if (!userId) return null;
  try {
    const raw = await idbGet(keyFor(userId));
    if (!raw || typeof raw !== 'object') return null;
    const o = /** @type {any} */ (raw);
    if (o.v !== CACHE_VERSION) return null;
    if (typeof o.userId !== 'string' || o.userId !== userId) return null;
    if (typeof o.at !== 'number') return null;
    if (!Array.isArray(o.artists)) return null;
    const artists = o.artists
      .map((x) => normalize(x))
      .filter((x) => x.length >= 2);
    /** Deduplicera vid läsning om äldre skrivningar råkat innehålla dubletter. */
    const uniq = Array.from(new Set(artists));
    return { v: CACHE_VERSION, userId: o.userId, at: o.at, artists: uniq };
  } catch {
    return null;
  }
}

/**
 * Lägger till nya artistnamn i användarens bank (FIFO-evict vid överskridande cap).
 * Läser befintlig bank, merge:ar, och skriver tillbaka. Idempotent om inga nya namn.
 *
 * @param {string} userId
 * @param {Iterable<string>} artists  Råa artistnamn; normaliseras här.
 * @returns {Promise<number>} Antal nya artister som lades till (0 = ingen skrivning behövdes).
 */
export async function addArtistsToBank(userId, artists) {
  if (!userId) return 0;
  try {
    const existing = await readArtistBank(userId);
    /** @type {string[]} */
    const arr = existing ? [...existing.artists] : [];
    const set = new Set(arr);
    let added = 0;
    for (const raw of artists) {
      const lc = normalize(raw);
      if (lc.length < 2 || set.has(lc)) continue;
      set.add(lc);
      arr.push(lc);
      added += 1;
    }
    if (added === 0) return 0;
    while (arr.length > MAX_ARTISTS) {
      const dropped = arr.shift();
      if (dropped) set.delete(dropped);
    }
    await idbPut(keyFor(userId), {
      v: CACHE_VERSION,
      userId,
      at: Date.now(),
      artists: arr,
    });
    return added;
  } catch {
    return 0;
  }
}

/** @param {string} userId */
export async function deleteArtistBank(userId) {
  if (!userId) return;
  try {
    await idbDelete(keyFor(userId));
  } catch {
    /* ignorera — ingen kritisk sidoeffekt */
  }
}
