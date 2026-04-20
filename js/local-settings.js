/**
 * Lätt, okrypterad persistens för användarens icke-känsliga inställningar:
 *   - clientId (publik information från Spotifys Dashboard — inte ett hemligt värde)
 *   - theme (tema-val i UI)
 *   - playlistNamePrefix (styr både nyskapning och prefixfilter mot /me/playlists)
 *
 * Känslig data (access/refresh-token) sparas aldrig här — de hanteras via
 * sessionStorage i token-session.js och dör när fliken stängs. Då OAuth-flödet
 * (Authorization Code + PKCE) är snabbt att köra om, är det en bättre säkerhetsmodell
 * än det tidigare krypterade valvet som krävde att användaren återanvände en 8+
 * teckens lösenfras för att låsa upp.
 *
 * Sparas i localStorage (synkront, enkelt) under en enda JSON-nyckel per APP_STORAGE_ID
 * så olika appar på samma domän inte krockar.
 */
import { APP_STORAGE_ID, DEFAULT_PLAYLIST_NAME_PREFIX } from './config.js';

const KEY = `${APP_STORAGE_ID}-settings`;

/** @typedef {{ clientId: string, theme: 'system' | 'light' | 'dark', playlistNamePrefix: string }} LocalSettings */

/** @returns {LocalSettings} */
function defaults() {
  return {
    clientId: '',
    theme: 'system',
    playlistNamePrefix: DEFAULT_PLAYLIST_NAME_PREFIX,
  };
}

/** @param {unknown} v @returns {'system' | 'light' | 'dark'} */
function normalizeTheme(v) {
  return v === 'light' || v === 'dark' ? v : 'system';
}

/**
 * Läser aktuella inställningar. Saknade fält fylls från defaults så att
 * anroparen alltid får ett komplett objekt.
 * @returns {LocalSettings}
 */
export function readLocalSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return defaults();
    const d = defaults();
    return {
      clientId: typeof obj.clientId === 'string' ? obj.clientId : d.clientId,
      theme: normalizeTheme(obj.theme),
      playlistNamePrefix:
        typeof obj.playlistNamePrefix === 'string' && obj.playlistNamePrefix.length > 0
          ? obj.playlistNamePrefix
          : d.playlistNamePrefix,
    };
  } catch {
    return defaults();
  }
}

/**
 * Skriver ett delpatch över befintliga inställningar (merge).
 * @param {Partial<LocalSettings>} patch
 */
export function writeLocalSettings(patch) {
  try {
    const current = readLocalSettings();
    const next = { ...current, ...patch };
    if (patch.theme !== undefined) next.theme = normalizeTheme(patch.theme);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* best-effort — localStorage kan vara blockerad i privat läge/edge cases */
  }
}

/** Rensar inställningarna helt (t.ex. om användaren vill "starta om"). */
export function clearLocalSettings() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignorera */
  }
}
