/**
 * Unikt id för all klientlagring på samma domän (IndexedDB, valvnyckel,
 * sessionStorage under OAuth, service worker-cache).
 * Byt endast om du medvetet vill bryta befintlig lokal data.
 * Måste hållas i synk med samma värde i ../sw.js (service worker).
 */
export const APP_STORAGE_ID = 'stevoxa-io-bjorklunds-playlist-pwa';

/** Spotify OAuth scopes (space-separated). */
export const SPOTIFY_SCOPES = [
  'playlist-modify-public',
  'playlist-modify-private',
  'playlist-read-private',
  'user-read-private',
  'user-read-email',
].join(' ');

export const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

/** Förnya access token när så här många ms återstår (proaktivt, före varje API-anrop). */
export const SPOTIFY_TOKEN_REFRESH_LEEWAY_MS = 10 * 60 * 1000;

/** Standardprefix för nya spellistor (användaren skriver bara suffix i appen). */
export const DEFAULT_PLAYLIST_NAME_PREFIX = 'Björklunds playlist - ';

/** Rad-förhandslyssning (preview_url + HTML5 audio). Sätt till false för att stänga av UI och logik. */
export const FEATURE_ROW_PREVIEW_PLAYER = true;

/** PKCE verifier length (bytes) → ~43+ chars when base64url. */
export const PKCE_VERIFIER_LENGTH = 64;
