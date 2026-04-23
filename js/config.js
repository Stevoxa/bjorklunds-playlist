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
  'playlist-read-collaborative',
  'user-read-private',
  'user-read-email',
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

export const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

/** Förnya access token när så här många ms återstår (proaktivt, före varje API-anrop). */
export const SPOTIFY_TOKEN_REFRESH_LEEWAY_MS = 10 * 60 * 1000;

/** Standardprefix för nya spellistor (användaren skriver bara suffix i appen). */
export const DEFAULT_PLAYLIST_NAME_PREFIX = 'Björklunds playlist - ';

/** Standardbeskrivning när användaren inte fyller i något — Spotify sparar annars `null`. */
export const DEFAULT_PLAYLIST_DESCRIPTION = 'Skapad av Björklunds playlist app';

/** Rad-uppspelning i webbläsaren (Spotify Web Playback SDK, Premium + streaming-scope). */
export const FEATURE_ROW_FULL_PLAYBACK = true;

/** PKCE verifier length (bytes) → ~43+ chars when base64url. */
export const PKCE_VERIFIER_LENGTH = 64;

/**
 * Säkerhetsventil: avbryt paginering av GET /me/playlists efter så här många sidor (50 per sida).
 * 20 × 50 = 1000 spellistor. Förhindrar worst-case-konton från att spamma endpointen.
 */
export const PLAYLIST_LIST_MAX_PAGES = 20;

/** Färsk (in-memory + IndexedDB) cache-TTL för GET /me/playlists — prefixfiltrerad lista. */
export const PLAYLIST_LIST_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Stale-if-error-fönster: om vi har en gammal cache men nya anrop misslyckas (429 eller annat nätverksfel),
 * använd cachen upp till så här lång tid tillbaka. Ger användaren tillgång till "senast kända" lista
 * även under långa Spotify-pauser (kan vara flera timmar till över 24 h).
 */
export const PLAYLIST_LIST_STALE_IF_ERROR_MS = 7 * 24 * 60 * 60 * 1000;

/** Färsk TTL för cachad playlist-innehållslista (spår). Kortare än listan — innehåll ändras oftare. */
export const PLAYLIST_TRACKS_CACHE_TTL_MS = 15 * 60 * 1000;

/** Stale-if-error-fönster för playlist-tracks-cachen (7 dagar). */
export const PLAYLIST_TRACKS_STALE_IF_ERROR_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Säkerhetsventil: avbryt track-paginering efter så här många sidor (100 per sida).
 * 40 × 100 = 4000 spår. Skyddar mot worst-case-spellistor.
 */
export const PLAYLIST_TRACKS_MAX_PAGES = 40;

/** Paus (+ jitter) mellan varje skriv-steg i Genomför-på-Spotify (429-skydd). */
export const EDIT_COMMIT_STEP_GAP_MS = 1500;
export const EDIT_COMMIT_STEP_JITTER_MS = 500;

/** Max antal uri:er per DELETE /playlists/{id}/tracks (Spotify-gräns = 100). */
export const EDIT_REMOVE_BATCH_SIZE = 100;

/** Antal planerade skrivningar som triggar "det här kommer ta lång tid"-varning. */
export const EDIT_COMMIT_HEAVY_WARN_THRESHOLD = 200;
