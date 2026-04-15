import { SPOTIFY_API_BASE } from './config.js';
import { refreshAccessToken } from './auth.js';
import { logSpotify } from './spotify-log.js';

/**
 * Spotify sök-q stödjer filter track: / artist: . Citat runt värden med mellanslag.
 * @param {string} s
 */
function spotifyQuoted(s) {
  const t = s.trim().replace(/"/g, '');
  if (!t) return '';
  return /\s/.test(t) ? `"${t}"` : t;
}

/**
 * @param {number} status
 * @param {string} bodyText
 */
export function formatSpotifyApiError(status, bodyText) {
  let spotifyMsg = '';
  try {
    const j = JSON.parse(bodyText);
    if (j?.error?.message) spotifyMsg = j.error.message;
    else if (typeof j?.error === 'string') spotifyMsg = j.error;
  } catch {
    /* ok */
  }
  const prefix = spotifyMsg || bodyText?.slice(0, 200)?.trim() || `HTTP ${status}`;
  if (status === 401 || status === 403) {
    return `${prefix}\n\n→ Öppna fliken Inställningar och expandera: »Om du får Forbidden (403)…« (checklista steg för steg).`;
  }
  return prefix;
}

function buildSearchQueries(q, artist, title) {
  const queries = [];
  const a = artist?.trim();
  const ti = title?.trim();
  if (a && ti) {
    const aq = spotifyQuoted(a);
    const tq = spotifyQuoted(ti);
    queries.push(`track:${tq} artist:${aq}`);
    queries.push(`artist:${aq} track:${tq}`);
    queries.push(`${a} ${ti}`);
  }
  if (!queries.includes(q.trim())) queries.push(q.trim());
  return queries;
}

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
     * @param {{ artist?: string, title?: string }} [hints] Om satta: prova fält-sökningar först (bättre träffar).
     */
    async searchTracks(q, limit = 5, hints = {}) {
      const access = await ensureAccess();
      const queries = buildSearchQueries(q, hints.artist, hints.title);
      /** @type {('from_token' | null)[]} */
      const markets = ['from_token', null];
      for (const query of queries) {
        for (const market of markets) {
          const params = new URLSearchParams({
            q: query,
            type: 'track',
            limit: String(limit),
          });
          if (market) params.set('market', market);
          const path = `/search?${params.toString()}`;
          const res = await api(access, path);
          const bodyText = await res.text();
          let data;
          try {
            data = bodyText ? JSON.parse(bodyText) : {};
          } catch {
            logSpotify({
              t: new Date().toISOString(),
              endpoint: 'GET /v1/search',
              q: query,
              market: market ?? '(ingen)',
              httpStatus: res.status,
              parseError: 'Svar var inte JSON',
              bodyPreview: bodyText.slice(0, 400),
            });
            throw new Error('Ogiltigt JSON-svar från Spotify');
          }
          const items = data.tracks?.items ?? [];
          logSpotify({
            t: new Date().toISOString(),
            endpoint: 'GET /v1/search',
            q: query,
            market: market ?? '(ingen)',
            httpStatus: res.status,
            ok: res.ok,
            tracksTotal: data.tracks?.total,
            itemsReturned: items.length,
            sample: items.slice(0, 5).map((t) => ({
              name: t.name,
              artists: (t.artists || []).map((a) => a.name),
              uri: t.uri,
            })),
          });
          if (!res.ok) {
            throw new Error(bodyText || `HTTP ${res.status}`);
          }
          if (items.length > 0) return items;
        }
      }
      return [];
    },

    /**
     * Skapar spellista för inloggad användare (POST /me/playlists).
     * @param {{ name: string, isPublic: boolean }} opts
     */
    async createPlaylist(opts) {
      const access = await ensureAccess();
      const body = {
        name: opts.name,
        public: opts.isPublic,
        collaborative: false,
      };
      const res = await api(access, '/me/playlists', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(formatSpotifyApiError(res.status, text));
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return {};
      }
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
      const text = await res.text();
      if (!res.ok) throw new Error(formatSpotifyApiError(res.status, text));
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return {};
      }
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
      const text = await res.text();
      if (!res.ok) throw new Error(formatSpotifyApiError(res.status, text));
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return {};
      }
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
