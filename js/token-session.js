import { APP_STORAGE_ID } from './config.js';

const KEY = `${APP_STORAGE_ID}:spotify_session`;

/**
 * @returns {{ clientId: string, tokens: object } | null}
 */
export function readSpotifySession() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    const clientId = typeof data.clientId === 'string' ? data.clientId.trim() : '';
    const tokens = data.tokens;
    if (!clientId || !tokens || typeof tokens !== 'object') return null;
    if (typeof tokens.accessToken !== 'string' || !tokens.accessToken) return null;
    if (typeof tokens.expiresAt !== 'number' || !Number.isFinite(tokens.expiresAt)) return null;
    return {
      clientId,
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        expiresAt: tokens.expiresAt,
        grantedScopeRaw: typeof tokens.grantedScopeRaw === 'string' ? tokens.grantedScopeRaw : '',
      },
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} clientId
 * @param {{ accessToken: string, refreshToken?: string | null, expiresAt: number, grantedScopeRaw?: string }} tokens
 */
export function writeSpotifySession(clientId, tokens) {
  if (!clientId?.trim() || !tokens?.accessToken) {
    clearSpotifySession();
    return;
  }
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        clientId: clientId.trim(),
        tokens: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt,
          grantedScopeRaw: typeof tokens.grantedScopeRaw === 'string' ? tokens.grantedScopeRaw : '',
        },
      }),
    );
  } catch {
    /* privat surfning / lagringskvot */
  }
}

export function clearSpotifySession() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* */
  }
}
