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
  if (status === 429) {
    return `${prefix}\n\n→ Rate limit: Spotify begränsar antal anrop per tidsfönster. Vänta en stund och prova igen; appen pausar och försöker om automatiskt vid tillfälliga 429-svar.`;
  }
  return prefix;
}

/**
 * Strukturerad logg för spelliste-skrivning (samma kö som sökning). Ingen Authorization-header loggas.
 * @param {string} method
 * @param {string} path Som skickas till api() (t.ex. /me/playlists eller /playlists/{id}/items)
 * @param {Record<string, unknown>} requestMeta
 */
function logPlaylistWrite(method, path, requestMeta, res, bodyText) {
  let parsed = null;
  let parseErr = false;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parseErr = true;
  }
  /** @type {Record<string, unknown>} */
  const entry = {
    t: new Date().toISOString(),
    kind: 'playlist_write',
    method,
    path,
    request: requestMeta,
    httpStatus: res.status,
    ok: res.ok,
  };
  if (parseErr) {
    entry.responseParse = 'non_json';
    entry.bodyPreview = bodyText.slice(0, 500);
  } else if (parsed && typeof parsed === 'object') {
    if (parsed.error != null) entry.spotifyError = parsed.error;
    if (parsed.snapshot_id != null) entry.snapshotId = parsed.snapshot_id;
    if (parsed.id != null) entry.playlistId = parsed.id;
    if (parsed.name != null) entry.playlistName = parsed.name;
    if (parsed.href != null) entry.playlistHref = parsed.href;
  }
  logSpotify(entry);
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

/** Max väntan per 429 (ms) — Spotify kan skicka stora Retry-After; annars känns UI “fryst”. */
const RATE_LIMIT_WAIT_CAP_MS = 45_000;
const RATE_LIMIT_WAIT_MIN_MS = 900;
/** Max total väntetid för alla 429 på samma GET innan vi ger upp */
const RATE_LIMIT_TOTAL_WAIT_CAP_MS = 120_000;

/** Min tid mellan två /search-anrop (olika query/market) — undvik burst inom Spotifys rullande fönster */
const SEARCH_INTERNAL_GAP_MS = 550;
const SEARCH_INTERNAL_JITTER_MS = 220;

async function sleepBetweenSearchTries() {
  await new Promise((r) => setTimeout(r, SEARCH_INTERNAL_GAP_MS + Math.floor(Math.random() * SEARCH_INTERNAL_JITTER_MS)));
}

/**
 * Tolka Retry-After (sekunder som heltal). Ignorar HTTP-datumformat här.
 * @param {string | null} raw
 */
function parseRetryAfterMs(raw) {
  if (raw == null || raw === '') return null;
  const t = String(raw).trim();
  const sec = Number.parseInt(t, 10);
  if (Number.isNaN(sec) || sec < 0) return null;
  return sec * 1000;
}

/**
 * GET med 429-retry. Använder Retry-After om siffra (cappad), annars kort exponentiell backoff — aldrig minuter långa väntor per runda.
 * @param {string} accessToken
 * @param {string} path
 * @param {number} [maxRetries]
 */
async function apiGetWith429Retry(accessToken, path, maxRetries = 5) {
  let lastRes = /** @type {Response | null} */ (null);
  let totalWaited = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const res = await api(accessToken, path, { method: 'GET' });
    lastRes = res;
    if (res.status !== 429) return res;
    if (attempt === maxRetries) return res;

    const fromHeader = parseRetryAfterMs(res.headers.get('Retry-After'));
    /** Utan header: kort backoff (2s, 4s, … cappad), inte 1.5s·2^n som snabbt blir minuter */
    const fallbackMs = Math.min(RATE_LIMIT_WAIT_CAP_MS, 2000 * 2 ** attempt);
    let waitMs =
      fromHeader != null
        ? Math.min(RATE_LIMIT_WAIT_CAP_MS, Math.max(RATE_LIMIT_WAIT_MIN_MS, fromHeader))
        : Math.max(RATE_LIMIT_WAIT_MIN_MS, fallbackMs);

    const remaining = RATE_LIMIT_TOTAL_WAIT_CAP_MS - totalWaited;
    if (remaining <= 0) {
      await res.text().catch(() => {});
      return res;
    }
    waitMs = Math.min(waitMs, remaining);
    waitMs += Math.floor(Math.random() * 350);
    totalWaited += waitMs;

    window.dispatchEvent(
      new CustomEvent('bjorklund-spotify-wait', {
        detail: {
          waitSec: Math.max(1, Math.ceil(waitMs / 1000)),
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
        },
      }),
    );

    await res.text().catch(() => {});
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return lastRes ?? (await api(accessToken, path, { method: 'GET' }));
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
      let firstSearchGet = true;
      for (const query of queries) {
        for (const market of markets) {
          if (!firstSearchGet) await sleepBetweenSearchTries();
          firstSearchGet = false;
          const params = new URLSearchParams({
            q: query,
            type: 'track',
            limit: String(limit),
          });
          if (market) params.set('market', market);
          const path = `/search?${params.toString()}`;
          const res = await apiGetWith429Retry(access, path);
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
            throw new Error(formatSpotifyApiError(res.status, bodyText));
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
      const path = '/me/playlists';
      const body = {
        name: opts.name,
        public: opts.isPublic,
        collaborative: false,
      };
      const res = await api(access, path, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const text = await res.text();
      logPlaylistWrite('POST', path, { name: opts.name, public: opts.isPublic, collaborative: false }, res, text);
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
      const path = `/playlists/${encodeURIComponent(playlistId)}/items`;
      const requestMeta = {
        playlistId,
        uriCount: uris.length,
        uriSample: uris.slice(0, 8),
      };
      const res = await api(access, path, {
        method: 'PUT',
        body: JSON.stringify({ uris }),
      });
      const text = await res.text();
      logPlaylistWrite('PUT', path, requestMeta, res, text);
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
      const path = `/playlists/${encodeURIComponent(playlistId)}/items`;
      const requestMeta = {
        playlistId,
        uriCount: uris.length,
        uriSample: uris.slice(0, 8),
      };
      const res = await api(access, path, {
        method: 'POST',
        body: JSON.stringify({ uris }),
      });
      const text = await res.text();
      logPlaylistWrite('POST', path, requestMeta, res, text);
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
