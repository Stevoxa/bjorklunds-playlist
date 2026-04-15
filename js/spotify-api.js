import { SPOTIFY_API_BASE } from './config.js';
import { refreshAccessToken } from './auth.js';

/**
 * @param {string} accessToken
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function api(accessToken, path, init = {}) {
  const res = await fetch(`${SPOTIFY_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  return res;
}

/**
 * @param {{ accessToken: string, refreshToken: string | null, expiresAt: number }} tokens
 * @param {string} clientId
 * @param {(t: object) => void} [onTokensUpdate]
 */
export function createSpotifyClient(tokens, clientId, onTokensUpdate) {
  let t = { ...tokens };

  async function ensureAccess() {
    if (Date.now() < t.expiresAt - 60_000) return t.accessToken;
    if (!t.refreshToken) throw new Error('Ingen refresh token');
    const next = await refreshAccessToken(t.refreshToken, clientId);
    t = { ...t, ...next };
    if (onTokensUpdate) onTokensUpdate(t);
    return t.accessToken;
  }

  return {
    getTokens: () => ({ ...t }),

    async me() {
      const access = await ensureAccess();
      const res = await api(access, '/me');
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },

    /**
     * @param {string} q
     * @param {number} [limit]
     */
    async searchTracks(q, limit = 5) {
      const access = await ensureAccess();
      const params = new URLSearchParams({ q, type: 'track', limit: String(limit) });
      const res = await api(access, `/search?${params.toString()}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      return data.tracks?.items ?? [];
    },

    /**
     * @param {string} userId
     * @param {{ name: string, isPublic: boolean }} opts
     */
    async createPlaylist(userId, opts) {
      const access = await ensureAccess();
      const res = await api(access, `/users/${encodeURIComponent(userId)}/playlists`, {
        method: 'POST',
        body: JSON.stringify({ name: opts.name, public: opts.isPublic }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },

    /**
     * @param {string} playlistId
     * @param {string[]} uris
     */
    async replacePlaylistTracks(playlistId, uris) {
      const access = await ensureAccess();
      const res = await api(access, `/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        method: 'PUT',
        body: JSON.stringify({ uris }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },

    /**
     * @param {string} playlistId
     * @param {string[]} uris
     */
    async appendPlaylistTracks(playlistId, uris) {
      const access = await ensureAccess();
      const res = await api(access, `/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        method: 'POST',
        body: JSON.stringify({ uris }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  };
}

/** @param {string} input */
export function parsePlaylistIdFromInput(input) {
  const s = input.trim();
  const uri = s.match(/spotify:playlist:([a-zA-Z0-9]+)/);
  if (uri) return uri[1];
  const url = s.match(/playlist\/([a-zA-Z0-9]+)/);
  if (url) return url[1];
  if (/^[a-zA-Z0-9]+$/.test(s)) return s;
  return null;
}
