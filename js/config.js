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
].join(' ');

export const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

/** PKCE verifier length (bytes) → ~43+ chars when base64url. */
export const PKCE_VERIFIER_LENGTH = 64;
