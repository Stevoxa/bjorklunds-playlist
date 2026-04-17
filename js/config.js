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

/** Standardprefix för nya spellistor (användaren skriver bara suffix i appen). */
export const DEFAULT_PLAYLIST_NAME_PREFIX = 'Björklunds playlist - ';

/**
 * Ikoner: 'raster' = PNG ur icons/bild8/raster (klippta från designblad, npm run icons:sheet).
 * 'svg' = vektor: inline-sprite i index.html, ev. extern fil nedan.
 * Tillbaka till vektor: sätt 'svg' här eller sessionStorage iconDisplayMode = 'svg' + reload.
 */
export const ICON_DISPLAY_MODE = 'raster';

/** Baskatalog för PNG (filnamn = sym-id utan prefix, t.ex. clipboard.png för #sym-clipboard). */
export const ICON_RASTER_BASE = './icons/bild8/raster/';

/**
 * När ICON_DISPLAY_MODE === 'svg': 'inline' = sprite i index.html.
 * 'external' = <use> laddar från ICON_SPRITE_EXTERNAL_HREF.
 */
export const ICON_SPRITE_MODE = 'inline';

/** Måste innehålla samma <symbol id="sym-…"> som inline-spriten. */
export const ICON_SPRITE_EXTERNAL_HREF = './icons/bild8/product-icons.svg';

/** PKCE verifier length (bytes) → ~43+ chars when base64url. */
export const PKCE_VERIFIER_LENGTH = 64;
