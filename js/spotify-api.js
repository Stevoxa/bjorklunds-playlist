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

/**
 * Spotify sök-svar: vanligast `tracks.items`. Undvik `tracks ?? items` om `tracks` finns men är tomt
 * medan träffar ligger i `items` (API-/migreringskantfall).
 * @param {Record<string, unknown>} data
 * @returns {{ items: object[], tracksTotal?: number }}
 */
function pickTrackSearchResults(data) {
  const tracks = data?.tracks;
  const itemsRoot = data?.items;
  const fromTracks = Array.isArray(tracks?.items) ? tracks.items : null;
  const fromItemsPaging =
    itemsRoot && typeof itemsRoot === 'object' && !Array.isArray(itemsRoot) && Array.isArray(itemsRoot.items)
      ? itemsRoot.items
      : null;
  const fromItemsArray = Array.isArray(itemsRoot) ? itemsRoot : null;

  if (fromTracks?.length) {
    return { items: fromTracks, tracksTotal: typeof tracks.total === 'number' ? tracks.total : undefined };
  }
  if (fromItemsPaging?.length) {
    return {
      items: fromItemsPaging,
      tracksTotal: typeof itemsRoot.total === 'number' ? itemsRoot.total : undefined,
    };
  }
  if (fromItemsArray?.length) {
    return { items: fromItemsArray, tracksTotal: fromItemsArray.length };
  }
  if (fromTracks) {
    return { items: fromTracks, tracksTotal: typeof tracks.total === 'number' ? tracks.total : undefined };
  }
  if (fromItemsPaging) {
    return {
      items: fromItemsPaging,
      tracksTotal: typeof itemsRoot.total === 'number' ? itemsRoot.total : undefined,
    };
  }
  if (fromItemsArray) {
    return { items: fromItemsArray, tracksTotal: fromItemsArray.length };
  }
  return { items: [], tracksTotal: undefined };
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

/** Om nätverket hänger: annars kan sök-kön + searchInProgress låsa tills sidladdning */
const API_FETCH_TIMEOUT_MS = 45_000;

/**
 * @param {string} accessToken
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function api(accessToken, path, init = {}) {
  const { signal: userSignal, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);
  const onUserAbort = () => {
    clearTimeout(timer);
    controller.abort();
  };
  if (userSignal) {
    if (userSignal.aborted) {
      clearTimeout(timer);
      throw new DOMException('Aborted', 'AbortError');
    }
    userSignal.addEventListener('abort', onUserAbort, { once: true });
  }
  try {
    return await fetch(`${SPOTIFY_API_BASE}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(rest.body && typeof rest.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...rest.headers,
      },
    });
  } finally {
    clearTimeout(timer);
    if (userSignal) userSignal.removeEventListener('abort', onUserAbort);
  }
}

/** Max väntan per 429 (ms) — Spotify kan skicka stora Retry-After; annars känns UI “fryst”. */
const RATE_LIMIT_WAIT_CAP_MS = 45_000;
const RATE_LIMIT_WAIT_MIN_MS = 900;
/** Max total väntetid för alla 429 på samma GET innan vi ger upp */
const RATE_LIMIT_TOTAL_WAIT_CAP_MS = 120_000;

/** Min tid mellan två /search-anrop (olika query/market) — undvik burst inom Spotifys rullande fönster */
const SEARCH_INTERNAL_GAP_MS = 800;
const SEARCH_INTERNAL_JITTER_MS = 280;

/** Endast en /search-GET-kedja (inkl. 429-retries) åt gången — undviker överlapp mellan flikar eller dubbelklick */
let searchGetChain = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function scheduleSearchGetChain(fn) {
  const next = searchGetChain.then(() => fn());
  searchGetChain = next.catch(() => {});
  return next;
}

/**
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 */
function sleepAbortable(ms, signal) {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * @param {AbortSignal | undefined} signal
 */
async function sleepBetweenSearchTries(signal) {
  const ms = SEARCH_INTERNAL_GAP_MS + Math.floor(Math.random() * SEARCH_INTERNAL_JITTER_MS);
  await sleepAbortable(ms, signal);
}

/**
 * Tolka Retry-After som sekunder (tal, t.ex. 9 eller 0.5). Ignorar HTTP-datumformat här.
 * @param {string | null} raw
 */
function parseRetryAfterMs(raw) {
  if (raw == null || raw === '') return null;
  const t = String(raw).trim();
  const sec = Number.parseFloat(t);
  if (!Number.isFinite(sec) || sec < 0) return null;
  return Math.ceil(sec * 1000);
}

/**
 * GET med 429-retry. Använder Retry-After om siffra (cappad), annars kort exponentiell backoff — aldrig minuter långa väntor per runda.
 * @param {string} accessToken
 * @param {string} path
 * @param {number} [maxRetries]
 * @param {AbortSignal | undefined} [signal]
 */
async function apiGetWith429Retry(accessToken, path, maxRetries = 5, signal) {
  const isSearch = path.startsWith('/search?');
  const run = async () => {
    let lastRes = /** @type {Response | null} */ (null);
    let totalWaited = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      signal?.throwIfAborted();
      const res = await api(accessToken, path, { method: 'GET', signal });
      lastRes = res;
      if (res.status !== 429) return res;
      if (attempt === maxRetries) return res;

      const fromHeader = parseRetryAfterMs(res.headers.get('Retry-After'));
      /** Utan header: kort backoff (2.5s, 5s, … cappad) */
      const fallbackMs = Math.min(RATE_LIMIT_WAIT_CAP_MS, 2500 * 2 ** attempt);
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
      waitMs += Math.floor(Math.random() * 400);
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
      await sleepAbortable(waitMs, signal);
    }
    signal?.throwIfAborted();
    return lastRes ?? (await api(accessToken, path, { method: 'GET', signal }));
  };
  if (isSearch) return scheduleSearchGetChain(run);
  return run();
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
     * Spellistor som ägs av inloggad användare och vars namn börjar med prefix (GET /me/playlists, paginerat).
     * @param {string} prefix
     * @param {AbortSignal} [signal]
     * @returns {Promise<{ id: string, name: string }[]>}
     */
    async listMyPlaylistsByPrefix(prefix, signal) {
      const me = await this.me();
      const myId = me.id;
      const pref = String(prefix ?? '');
      /** @type {{ id: string, name: string }[]} */
      const out = [];
      let offset = 0;
      const page = 50;
      while (true) {
        const access = await ensureAccess();
        const path = `/me/playlists?limit=${page}&offset=${offset}`;
        const res = await apiGetWith429Retry(access, path, 5, signal);
        const bodyText = await res.text();
        if (!res.ok) throw new Error(formatSpotifyApiError(res.status, bodyText));
        let data;
        try {
          data = bodyText ? JSON.parse(bodyText) : {};
        } catch {
          throw new Error('Ogiltigt JSON-svar från Spotify (spellistor)');
        }
        const items = data.items ?? [];
        for (const item of items) {
          if (item?.owner?.id === myId && typeof item.name === 'string' && item.name.startsWith(pref)) {
            out.push({ id: item.id, name: item.name });
          }
        }
        if (items.length < page) break;
        offset += page;
      }
      out.sort((a, b) => a.name.localeCompare(b.name, 'sv'));
      return out;
    },

    /**
     * @param {string} q
     * @param {number} [limit]
     * @param {{ artist?: string, title?: string, signal?: AbortSignal }} [hints] Om satta: prova fält-sökningar först (bättre träffar). signal avbryter nätverksanrop.
     */
    async searchTracks(q, limit = 5, hints = {}) {
      const { signal, ...hintRest } = hints || {};
      const access = await ensureAccess();
      const queries = buildSearchQueries(q, hintRest.artist, hintRest.title);
      /** @type {('from_token' | null)[]} */
      const markets = ['from_token', null];
      let firstSearchGet = true;
      for (const query of queries) {
        for (const market of markets) {
          if (!firstSearchGet) await sleepBetweenSearchTries(signal);
          firstSearchGet = false;
          const params = new URLSearchParams({
            q: query,
            type: 'track',
            limit: String(limit),
          });
          if (market) params.set('market', market);
          const path = `/search?${params.toString()}`;
          const res = await apiGetWith429Retry(access, path, 5, signal);
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
          const { items, tracksTotal } = pickTrackSearchResults(data);
          logSpotify({
            t: new Date().toISOString(),
            endpoint: 'GET /v1/search',
            q: query,
            market: market ?? '(ingen)',
            httpStatus: res.status,
            ok: res.ok,
            tracksTotal,
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
