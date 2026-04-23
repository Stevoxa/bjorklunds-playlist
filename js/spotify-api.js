import {
  SPOTIFY_API_BASE,
  SPOTIFY_TOKEN_REFRESH_LEEWAY_MS,
  PLAYLIST_LIST_MAX_PAGES,
} from './config.js';
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
    return `${prefix}\n\n→ Gå till steg 0 (Logga in) och expandera »403 Forbidden vid spellista — kort hjälp« om du behöver checklista.`;
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

/**
 * Strippar "featuring"-notation för att få huvudartisten inför `artist:`-filter.
 * Spotifys index lagrar featuring-artister som separata poster (artists: [main, featured]),
 * så `artist:"Main feat. Featured"` matchar ingenting. Vi matchar bara
 * `feat.`/`ft.`/`featuring` — INTE `&` eller `,`, eftersom de ofta är legitima
 * delar av artistnamn ("Earth, Wind & Fire", "Simon & Garfunkel", "Crosby, Stills & Nash").
 *
 * @param {string} artist
 * @returns {string} Trimmad huvudartist (eller original om ingen match).
 */
function stripFeaturing(artist) {
  if (!artist) return '';
  const m = artist.match(/^(.*?)\s+(feat\.?|ft\.?|featuring)\s+/i);
  return (m ? m[1] : artist).trim();
}

/**
 * Precision-filter: känner igen "junk"-träffar (karaoke, tribute, covers,
 * "in the style of"-versioner, rent instrumental-covers) som ofta rankas högt
 * på svag free-text och förorenar både sökresultatet och artist-banken.
 *
 * Inte perfekt men fångar de vanliga mönstren vi sett i loggen:
 *   "Just Dance (In the Style of Lady Gaga ...) [Karaoke Version]"
 *   "Rather Be (Originally Performed By Clean Bandit ...) [Karaoke Version]"
 *   "Wake Me Up - Tribute to Avicii" av artisten "Wake Me Up"
 *   "Watermelon sugar (Originally performed by Harry Styles)"
 *
 * @param {{ name?: string, artists?: { name?: string }[] }} item
 * @returns {boolean}
 */
function isJunkTrack(item) {
  const trackName = String(item?.name ?? '');
  if (/\b(karaoke|tribute to|originally performed|in the style of|instrumental only|performance track)\b/i.test(trackName)) {
    return true;
  }
  const artistNames = Array.isArray(item?.artists)
    ? item.artists.map((a) => String(a?.name ?? ''))
    : [];
  return artistNames.some((n) => /\b(karaoke|cover band)\b/i.test(n));
}

/**
 * Kontrollerar att en träff rimligen matchar parsens artist/title — förhindrar
 * att tribute/karaoke-träffar (där parserns ord råkar återfinnas i name/artists
 * men tillsammans pekar på fel låt) accepteras som bästa träff.
 *
 * Kind-medveten:
 *   - field-artist-title (q = `track:T artist:A`) → result.name ≈ T, result.artists ≈ A
 *   - field-title-artist (q = `track:A artist:T`, swap) → result.name ≈ A, result.artists ≈ T
 *   - free-text/raw → svagare kontroll: minst en sida måste finnas i namn eller artists
 *
 * Tomma artist/title → hoppa valideringen (inget att kontrollera mot).
 *
 * @param {{ name?: string, artists?: { name?: string }[] }} item
 * @param {'field-artist-title' | 'field-title-artist' | 'free-text' | 'raw'} kind
 * @param {string | undefined} parsedArtist
 * @param {string | undefined} parsedTitle
 * @returns {boolean}
 */
function matchesParsedRow(item, kind, parsedArtist, parsedTitle) {
  const a = (parsedArtist ?? '').trim().toLowerCase();
  const ti = (parsedTitle ?? '').trim().toLowerCase();
  if (!a && !ti) return true;
  const trackName = String(item?.name ?? '').toLowerCase();
  const artistNamesLc = Array.isArray(item?.artists)
    ? item.artists.map((x) => String(x?.name ?? '').toLowerCase())
    : [];
  const artistJoined = artistNamesLc.join(' | ');
  const nameHas = (needle) => Boolean(needle) && trackName.includes(needle);
  const artistsHas = (needle) => Boolean(needle) && artistJoined.includes(needle);

  if (kind === 'field-artist-title') {
    /** Normal-fall: titel i name, artist i artists[]. */
    return nameHas(ti) && artistsHas(a);
  }
  if (kind === 'field-title-artist') {
    /** Swap: parsens rollbyte → title i artists[], artist i name. */
    return nameHas(a) && artistsHas(ti);
  }
  /** free-text / raw: acceptera om minst artist-sidan finns någonstans (vanligt legitimt fall). */
  const anyHit = a && (artistsHas(a) || nameHas(a));
  const titleHit = ti && nameHas(ti);
  return Boolean(anyHit || titleHit);
}

/**
 * Bygger en ordnad lista av sök-queries anpassad efter radens klass.
 * Minst möjligt anrop (fri text direkt) för rader utan tydlig struktur;
 * dubbelt försök med swap för rader där parsern troligen bytt roll på artist/title.
 *
 * För `normal` (och `suspectSwap` där artisten spelar artist-rollen) används
 * huvudartist i `artist:`-filtret — free-text-fallbacken behåller dock hela
 * strängen inklusive featuring.
 *
 * @param {string} q Rå fri text-query (fallback).
 * @param {string} [artist] Artist enligt parsern.
 * @param {string} [title] Titel enligt parsern.
 * @param {'freeTextOnly' | 'normal' | 'suspectSwap'} [rowClass]
 * @returns {{ q: string, kind: 'field-artist-title' | 'field-title-artist' | 'free-text' | 'raw', artistStripped?: boolean }[]}
 */
function buildSearchQueries(q, artist, title, rowClass = 'normal') {
  /** @type {{ q: string, kind: 'field-artist-title' | 'field-title-artist' | 'free-text' | 'raw', artistStripped?: boolean }[]} */
  const queries = [];
  const a = artist?.trim();
  const ti = title?.trim();
  const rawQ = q.trim();

  /** Ingen artist/title från parsern → bara fri text. Max 1 anrop per rad. */
  if (!a || !ti) {
    if (rawQ) queries.push({ q: rawQ, kind: 'free-text' });
    return queries;
  }

  const aq = spotifyQuoted(a);
  const tq = spotifyQuoted(ti);
  const aPrimary = stripFeaturing(a);
  const aPrimaryQ = spotifyQuoted(aPrimary);
  const artistStripped = aPrimary !== a;
  const freeText = `${a} ${ti}`;

  if (rowClass === 'suspectSwap') {
    /** Parsern satte troligen artist/title i omvänd ordning → prova swap först. */
    queries.push({ q: `track:${aq} artist:${tq}`, kind: 'field-title-artist' });
    queries.push({
      q: `track:${tq} artist:${aPrimaryQ}`,
      kind: 'field-artist-title',
      artistStripped,
    });
    queries.push({ q: freeText, kind: 'free-text' });
  } else {
    /** Normalfall: huvudartist i filtret ökar träffsäkerheten när raden har feat./ft. */
    queries.push({
      q: `track:${tq} artist:${aPrimaryQ}`,
      kind: 'field-artist-title',
      artistStripped,
    });
    queries.push({ q: freeText, kind: 'free-text' });
  }

  /** Rå input som sista utväg om den skiljer sig från tidigare queries (ovanligt). */
  if (rawQ && !queries.some((x) => x.q === rawQ)) {
    queries.push({ q: rawQ, kind: 'raw' });
  }
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
    } catch (err) {
      logSpotify({
        t: new Date().toISOString(),
        kind: 'fetch_error',
        path,
        method: rest.method ?? 'GET',
        name: err?.name,
        message: String(err?.message ?? err),
      });
      throw err;
    }
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

/** Visa nedräkning under API-loggen när Spotify skickar Retry-After (parsad) längre än detta. */
const RETRY_AFTER_COUNTDOWN_MIN_MS = 30_000;

/** Min tid mellan två /search-anrop (olika query/market) — undvik burst inom Spotifys rullande fönster */
const SEARCH_INTERNAL_GAP_MS = 3000;
const SEARCH_INTERNAL_JITTER_MS = 1000;

/** Paus mellan paginerade GET /me/playlists — Spotify rate-limitar hårda bursts (429). */
const PLAYLIST_FETCH_INITIAL_GAP_MS = 450;
const PLAYLIST_PAGE_GAP_MS = 750;
const PLAYLIST_PAGE_JITTER_MS = 500;

/** Endast en kedja för /search + spellisteläsning (inkl. 429-retries) åt gången — undviker parallella GET-bursts */
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
 * Kör arbete efter samma Promise-kedja som serialiserar /search-anrop — undvik parallella Spotify-anrop
 * (t.ex. om vi senare lägger till GET /tracks för preview).
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function enqueueAfterSpotifySearchChain(fn) {
  return scheduleSearchGetChain(fn);
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
  const isPlaylistListPage = path.startsWith('/me/playlists?');
  const run = async () => {
    let lastRes = /** @type {Response | null} */ (null);
    let totalWaited = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      signal?.throwIfAborted();
      const res = await api(accessToken, path, { method: 'GET', signal });
      lastRes = res;
      if (res.status !== 429) return res;
      if (attempt === maxRetries) {
        const retryAfterRawFinal = res.headers.get('Retry-After');
        const retryAfterParsedFinal = parseRetryAfterMs(retryAfterRawFinal);
        logSpotify({
          t: new Date().toISOString(),
          kind: 'http_429',
          path,
          phase: 'max_retries_reached',
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          retryAfterRaw: retryAfterRawFinal,
          retryAfterParsedMs: retryAfterParsedFinal,
        });
        /** Signalera långvarig rate-limit på spellistesidan — UI väljer att pausa auto-refresh. */
        if (isPlaylistListPage) {
          window.dispatchEvent(
            new CustomEvent('bjorklund-playlist-list-rate-limited', {
              detail: {
                path,
                retryAfterRaw: retryAfterRawFinal,
                retryAfterParsedMs: retryAfterParsedFinal,
              },
            }),
          );
        }
        return res;
      }

      const retryAfterRaw = res.headers.get('Retry-After');
      const fromHeader = parseRetryAfterMs(retryAfterRaw);
      /** Utan Retry-After: /search och /me/playlists straffas hårt av snabba omförsök — längre backoff */
      const fallbackBase = isSearch ? 12_000 : isPlaylistListPage ? 20_000 : 2_500;
      const fallbackMs = Math.min(RATE_LIMIT_WAIT_CAP_MS, fallbackBase * 2 ** attempt);
      const minNoHeader = isSearch || isPlaylistListPage ? 2_000 : RATE_LIMIT_WAIT_MIN_MS;
      let waitMs =
        fromHeader != null
          ? Math.min(RATE_LIMIT_WAIT_CAP_MS, Math.max(RATE_LIMIT_WAIT_MIN_MS, fromHeader))
          : Math.max(minNoHeader, fallbackMs);

      const remaining = RATE_LIMIT_TOTAL_WAIT_CAP_MS - totalWaited;
      if (remaining <= 0) {
        await res.text().catch(() => {});
        logSpotify({
          t: new Date().toISOString(),
          kind: 'http_429',
          path,
          phase: 'total_wait_budget_exhausted',
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          totalWaitedBefore: totalWaited,
          retryAfterRaw,
          retryAfterParsedMs: fromHeader,
        });
        return res;
      }
      const waitMsCappedToBudget = Math.min(waitMs, remaining);
      const jitterMs = Math.floor(Math.random() * 400);
      const waitMsApplied = waitMsCappedToBudget + jitterMs;
      totalWaited += waitMsApplied;

      logSpotify({
        t: new Date().toISOString(),
        kind: 'http_429',
        path,
        phase: 'backoff',
        attempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        retryAfterRaw,
        retryAfterParsedMs: fromHeader,
        backoffSource: fromHeader != null ? 'retry-after' : 'fallback',
        fallbackMsSuggested: fromHeader == null ? fallbackMs : undefined,
        waitMsFromPolicy: waitMs,
        remainingBudgetMs: remaining,
        waitMsAfterCap: waitMsCappedToBudget,
        jitterMs,
        waitMsApplied,
        totalWaitedAfter: totalWaited,
      });

      window.dispatchEvent(
        new CustomEvent('bjorklund-spotify-wait', {
          detail: {
            waitSec: Math.max(1, Math.ceil(waitMsApplied / 1000)),
            attempt: attempt + 1,
            maxAttempts: maxRetries + 1,
          },
        }),
      );

      const showLongRetryCountdown = fromHeader != null && fromHeader > RETRY_AFTER_COUNTDOWN_MIN_MS;
      if (showLongRetryCountdown) {
        window.dispatchEvent(
          new CustomEvent('bjorklund-retry-after-countdown', {
            detail: {
              mode: 'start',
              endAt: Date.now() + waitMsApplied,
              retryAfterParsedMs: fromHeader,
              retryAfterRaw,
            },
          }),
        );
      }
      try {
        await res.text().catch(() => {});
        await sleepAbortable(waitMsApplied, signal);
      } finally {
        if (showLongRetryCountdown) {
          window.dispatchEvent(new CustomEvent('bjorklund-retry-after-countdown', { detail: { mode: 'clear' } }));
        }
      }
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

  /** Undviker upprepad GET /me vid varje spelliste-synk (samma användare under klientens livstid). */
  let cachedSpotifyUserId = /** @type {string | null} */ (null);

  /** @type {Promise<void> | null} */
  let refreshCoalesce = null;

  async function forceRefreshAccess() {
    if (!t.refreshToken) throw new Error('Ingen refresh token');
    const next = await refreshAccessToken(t.refreshToken, clientId);
    t = { ...t, ...next };
    if (onTokensUpdate) onTokensUpdate(t);
  }

  /**
   * Ett enda POST /api/token åt gången — parallella anrop (t.ex. många GET) delar samma förnyelse.
   */
  async function refreshAccessCoalesced() {
    if (!refreshCoalesce) {
      refreshCoalesce = forceRefreshAccess().finally(() => {
        refreshCoalesce = null;
      });
    }
    await refreshCoalesce;
  }

  /**
   * Returnerar giltig access token. Förnyar **endast** när utgång närmar sig (SPOTIFY_TOKEN_REFRESH_LEEWAY_MS).
   * All Spotify-trafik i denna klient går hit eller via getAccessToken() — ingen sidoeffekt vid omladdning om token är färsk.
   */
  async function ensureAccess() {
    if (Date.now() < t.expiresAt - SPOTIFY_TOKEN_REFRESH_LEEWAY_MS) return t.accessToken;
    await refreshAccessCoalesced();
    return t.accessToken;
  }

  async function getWith401Retry(path, max429, signal) {
    let access = await ensureAccess();
    let res = await apiGetWith429Retry(access, path, max429, signal);
    if (res.status === 401 && t.refreshToken) {
      await refreshAccessCoalesced();
      access = t.accessToken;
      res = await apiGetWith429Retry(access, path, max429, signal);
    }
    return res;
  }

  async function mutateWith401Retry(path, init) {
    let access = await ensureAccess();
    let res = await api(access, path, init);
    if (res.status === 401 && t.refreshToken) {
      await refreshAccessCoalesced();
      res = await api(t.accessToken, path, init);
    }
    return res;
  }

  /**
   * Gemensam paginerad hämtning av `/me/playlists`. Körs via `scheduleSearchGetChain` för att
   * serialisera mot söktrafiken. Returnerar rå `items` från Spotify (utan filter) så att olika
   * konsumenter (Skapa-flödets prefix-filter resp. Redigera-flödets "alla listor") kan mappa/filtrera
   * efter eget behov. Inga 429-retries på raderna — Retry-After på /me/playlists är ofta 30–60 s,
   * UI-lagret visar cooldown-toast och låter användaren trycka "Hämta om lista" när det passar.
   * @param {AbortSignal} [signal]
   * @param {{ phase?: string }} [opts] phase används i logg för `max_pages_reached`.
   * @returns {Promise<{ rawItems: any[], truncated: boolean, userId: string }>}
   */
  async function fetchAllMePlaylistPages(signal, opts = {}) {
    const phase = opts.phase ?? 'fetchAllMePlaylistPages';
    return scheduleSearchGetChain(async () => {
      signal?.throwIfAborted();
      let myId = cachedSpotifyUserId;
      if (!myId) {
        const access = await ensureAccess();
        let res = await api(access, '/me', { signal });
        if (res.status === 401 && t.refreshToken) {
          await refreshAccessCoalesced();
          res = await api(t.accessToken, '/me', { signal });
        }
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        if (data && typeof data.id === 'string') {
          cachedSpotifyUserId = data.id;
          myId = data.id;
        }
      }
      const rawItems = [];
      let offset = 0;
      const page = 50;
      let pagesFetched = 0;
      let truncated = false;
      await sleepAbortable(PLAYLIST_FETCH_INITIAL_GAP_MS, signal);
      while (true) {
        signal?.throwIfAborted();
        const path = `/me/playlists?limit=${page}&offset=${offset}`;
        const res = await getWith401Retry(path, 0, signal);
        const bodyText = await res.text();
        if (!res.ok) throw new Error(formatSpotifyApiError(res.status, bodyText));
        let data;
        try {
          data = bodyText ? JSON.parse(bodyText) : {};
        } catch {
          throw new Error('Ogiltigt JSON-svar från Spotify (spellistor)');
        }
        const items = Array.isArray(data.items) ? data.items : [];
        for (const item of items) {
          if (item && typeof item.id === 'string') rawItems.push(item);
        }
        pagesFetched += 1;
        if (items.length < page) break;
        if (pagesFetched >= PLAYLIST_LIST_MAX_PAGES) {
          truncated = true;
          logSpotify({
            t: new Date().toISOString(),
            kind: 'ui',
            phase,
            reason: 'max_pages_reached',
            pagesFetched,
            maxPages: PLAYLIST_LIST_MAX_PAGES,
          });
          break;
        }
        offset += page;
        await sleepAbortable(
          PLAYLIST_PAGE_GAP_MS + Math.floor(Math.random() * PLAYLIST_PAGE_JITTER_MS),
          signal,
        );
      }
      return { rawItems, truncated, userId: myId ?? '' };
    });
  }

  return {
    getTokens: () => ({ ...t }),

    /** @returns {Promise<string>} Giltig access token (uppdateras automatiskt vid behov). */
    getAccessToken() {
      return ensureAccess();
    },

    /** @returns {string | null} Senast kända Spotify user-id från /me eller listMyPlaylistsByPrefix (ingen nätverksaktivitet). */
    getCachedUserId() {
      return cachedSpotifyUserId;
    },

    /**
     * Svar på `/me` cachas i klienten — konto-id och display-name/email ändras sällan.
     * Så slipper UI-synk (steg 0 + steg 1) samt spelliste-filtret skicka separata GET /me-anrop.
     * @type {{ at: number, data: any } | null}
     */
    _meCache: null,

    /**
     * @param {AbortSignal} [signal]
     * @param {{ forceRefresh?: boolean, maxAgeMs?: number }} [opts]
     */
    async me(signal, opts = {}) {
      const { forceRefresh = false, maxAgeMs = 5 * 60 * 1000 } = opts;
      if (!forceRefresh && this._meCache && Date.now() - this._meCache.at < maxAgeMs) {
        return this._meCache.data;
      }
      let access = await ensureAccess();
      let res = await api(access, '/me', { signal });
      if (res.status === 401 && t.refreshToken) {
        await refreshAccessCoalesced();
        res = await api(t.accessToken, '/me', { signal });
      }
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      this._meCache = { at: Date.now(), data };
      if (data && typeof data.id === 'string') cachedSpotifyUserId = data.id;
      return data;
    },

    /**
     * Spellistor som ägs av inloggad användare och vars namn börjar med prefix (GET /me/playlists, paginerat).
     * Filtrerar ägarskap + prefix klientside på svaret från gemensamma paginerings-hjälparen.
     * @param {string} prefix
     * @param {AbortSignal} [signal]
     * @returns {Promise<{ list: { id: string, name: string }[], truncated: boolean, userId: string }>}
     *   truncated: true om vi stoppade vid PLAYLIST_LIST_MAX_PAGES (safeguard mot worst-case-konton).
     */
    async listMyPlaylistsByPrefix(prefix, signal) {
      const { rawItems, truncated, userId } = await fetchAllMePlaylistPages(signal, {
        phase: 'listMyPlaylistsByPrefix',
      });
      const pref = String(prefix ?? '');
      /** @type {Map<string, { id: string, name: string }>} */
      const byId = new Map();
      for (const item of rawItems) {
        if (
          item?.owner?.id === userId &&
          typeof item.name === 'string' &&
          item.name.startsWith(pref)
        ) {
          byId.set(item.id, { id: item.id, name: item.name });
        }
      }
      const out = [...byId.values()];
      out.sort((a, b) => a.name.localeCompare(b.name, 'sv'));
      return { list: out, truncated, userId };
    },

    /**
     * Alla spellistor i `GET /me/playlists` (ägda + följda), oavsett prefix. Returnerar rikare
     * radobjekt inklusive ägarnamn och `imageUrl` (första bilden från Spotifys svar; inga extra
     * nätverksanrop). Används av Redigera-flödets "Välj playlist"-vy.
     * @param {AbortSignal} [signal]
     * @returns {Promise<{ list: { id: string, name: string, ownerId: string, ownerName: string, imageUrl: string | null }[], truncated: boolean, userId: string }>}
     */
    async listMyPlaylistsAll(signal) {
      const { rawItems, truncated, userId } = await fetchAllMePlaylistPages(signal, {
        phase: 'listMyPlaylistsAll',
      });
      /** @type {Map<string, { id: string, name: string, ownerId: string, ownerName: string, imageUrl: string | null }>} */
      const byId = new Map();
      for (const item of rawItems) {
        if (!item || typeof item.id !== 'string') continue;
        const name = typeof item.name === 'string' ? item.name : '';
        const ownerId = typeof item?.owner?.id === 'string' ? item.owner.id : '';
        const ownerDisplay =
          typeof item?.owner?.display_name === 'string' && item.owner.display_name.length > 0
            ? item.owner.display_name
            : ownerId;
        const imgArr = Array.isArray(item.images) ? item.images : [];
        const imageUrl =
          imgArr.length > 0 && typeof imgArr[0]?.url === 'string' ? imgArr[0].url : null;
        byId.set(item.id, {
          id: item.id,
          name,
          ownerId,
          ownerName: ownerDisplay,
          imageUrl,
        });
      }
      const out = [...byId.values()];
      out.sort((a, b) => a.name.localeCompare(b.name, 'sv'));
      return { list: out, truncated, userId };
    },

    /**
     * @param {string} q
     * @param {number} [limit]
     * @param {{ artist?: string, title?: string, rowClass?: 'freeTextOnly' | 'normal' | 'suspectSwap', signal?: AbortSignal }} [hints]
     *   rowClass styr query-kedjan (freeTextOnly → 1 anrop, normal → max 2, suspectSwap → max 3).
     *   signal avbryter nätverksanrop.
     */
    async searchTracks(q, limit = 5, hints = {}) {
      const { signal, ...hintRest } = hints || {};
      const rowClass = hintRest.rowClass ?? 'normal';
      const queries = buildSearchQueries(q, hintRest.artist, hintRest.title, rowClass);
      /** Endast from_token: halverar antal /search-anrop per rad (mindre 429-belastning); marknad följer kontot. */
      /** @type {('from_token')[]} */
      const markets = ['from_token'];
      let firstSearchGet = true;
      let qIndex = 0;
      for (const { q: query, kind, artistStripped } of queries) {
        qIndex += 1;
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
          const res = await getWith401Retry(path, 3, signal);
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
            rowClass,
            queryKind: kind,
            queryIndex: qIndex,
            queryTotal: queries.length,
            ...(artistStripped ? { artistStripped: true } : {}),
          });
            throw new Error('Ogiltigt JSON-svar från Spotify');
          }
          const { items, tracksTotal } = pickTrackSearchResults(data);
          /** Precision-filter: avvisa karaoke/tribute/cover-junk och kräv att parsens artist/title
           *  faktiskt matchar träffen enligt queryKind. Om inget item kvarstår efter filtrering
           *  behandlar vi queryn som en miss och går vidare i kedjan. */
          const filteredItems = items.filter(
            (it) => !isJunkTrack(it) && matchesParsedRow(it, kind, hintRest.artist, hintRest.title),
          );
          const rejectedCount = items.length - filteredItems.length;
          const qualityRejected = items.length > 0 && filteredItems.length === 0;
          logSpotify({
            t: new Date().toISOString(),
            endpoint: 'GET /v1/search',
            q: query,
            market: market ?? '(ingen)',
            httpStatus: res.status,
            ok: res.ok,
            tracksTotal,
            itemsReturned: items.length,
            rowClass,
            queryKind: kind,
            queryIndex: qIndex,
            queryTotal: queries.length,
            hit: filteredItems.length > 0,
            ...(artistStripped ? { artistStripped: true } : {}),
            ...(rejectedCount > 0 ? { rejectedCount } : {}),
            ...(qualityRejected ? { qualityRejected: true } : {}),
            sample: filteredItems.slice(0, 5).map((t) => ({
              name: t?.name,
              artists: Array.isArray(t?.artists) ? t.artists.map((a) => a?.name) : [],
              uri: t?.uri,
            })),
          });
          if (!res.ok) {
            throw new Error(formatSpotifyApiError(res.status, bodyText));
          }
          if (filteredItems.length > 0) return filteredItems;
        }
      }
      return [];
    },

    /**
     * Fulla track-objekt för id (GET /tracks, max 50). Köas via samma kedja som /search så vi inte parallellastar API:t.
     * Kan ge `preview_url` när sök-svaret bara hade förenklad data utan klipp.
     * @param {string[]} ids
     * @param {AbortSignal} [signal]
     * @returns {Promise<object[]>}
     */
    async getTracksByIds(ids, signal) {
      const clean = [...new Set((ids || []).map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, 50);
      if (clean.length === 0) return [];
      const idList = clean.map((id) => encodeURIComponent(id)).join(',');
      const path = `/tracks?ids=${idList}&market=from_token`;
      return enqueueAfterSpotifySearchChain(async () => {
        const res = await getWith401Retry(path, 5, signal);
        const bodyText = await res.text();
        logSpotify({
          t: new Date().toISOString(),
          endpoint: 'GET /v1/tracks',
          httpStatus: res.status,
          ok: res.ok,
          idCount: clean.length,
        });
        if (!res.ok) throw new Error(formatSpotifyApiError(res.status, bodyText));
        let data = {};
        try {
          data = bodyText ? JSON.parse(bodyText) : {};
        } catch {
          throw new Error('Ogiltigt JSON-svar från Spotify (tracks)');
        }
        const arr = data.tracks;
        return Array.isArray(arr) ? arr.filter((x) => x != null && typeof x === 'object') : [];
      });
    },

    /**
     * Starta/uppdatera uppspelning på angiven enhet (Web Playback). Köas efter sök-kedjan.
     * @param {string} deviceId
     * @param {{ uris?: string[], context_uri?: string, offset?: object }} body
     * @param {AbortSignal} [signal]
     */
    async startPlaybackOnDevice(deviceId, body, signal) {
      const enc = encodeURIComponent(deviceId);
      const path = `/me/player/play?device_id=${enc}`;
      return enqueueAfterSpotifySearchChain(async () => {
        const res = await mutateWith401Retry(path, {
          method: 'PUT',
          body: JSON.stringify(body && typeof body === 'object' ? body : {}),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(formatSpotifyApiError(res.status, text));
      });
    },

    /**
     * Pausa uppspelning på angiven enhet. Köas efter sök-kedjan.
     * @param {string} deviceId
     * @param {AbortSignal} [signal]
     */
    async pausePlayer(deviceId, signal) {
      const enc = encodeURIComponent(deviceId);
      return enqueueAfterSpotifySearchChain(async () => {
        const res = await mutateWith401Retry(`/me/player/pause?device_id=${enc}`, { method: 'PUT' });
        const text = await res.text();
        if (!res.ok) throw new Error(formatSpotifyApiError(res.status, text));
      });
    },

    /**
     * Skapar spellista för inloggad användare (POST /me/playlists).
     * Spotify: `collaborative` och `public` får inte båda vara true.
     * @param {{ name: string, isPublic: boolean, collaborative?: boolean }} opts
     */
    async createPlaylist(opts) {
      const path = '/me/playlists';
      const isPublic = Boolean(opts.isPublic);
      const collaborative = Boolean(opts.collaborative);
      if (collaborative && isPublic) {
        throw new Error('Samarbetslista kan inte skapas som publik (Spotify Web API).');
      }
      const description = typeof opts.description === 'string' ? opts.description.trim() : '';
      const body = {
        name: opts.name,
        public: isPublic,
        collaborative,
      };
      /** Spotify: skicka bara description när den finns — annars blir tom sträng synlig som ”” i klienterna. */
      if (description) body.description = description;
      const res = await mutateWith401Retry(path, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const text = await res.text();
      logPlaylistWrite(
        'POST',
        path,
        { name: opts.name, public: isPublic, collaborative, hasDescription: Boolean(description) },
        res,
        text,
      );
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
      const path = `/playlists/${encodeURIComponent(playlistId)}/items`;
      const requestMeta = {
        playlistId,
        uriCount: uris.length,
        uriSample: uris.slice(0, 8),
      };
      const res = await mutateWith401Retry(path, {
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
      const path = `/playlists/${encodeURIComponent(playlistId)}/items`;
      const requestMeta = {
        playlistId,
        uriCount: uris.length,
        uriSample: uris.slice(0, 8),
      };
      const res = await mutateWith401Retry(path, {
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
