/**
 * Full uppspelning av vald träff via Spotify Web Playback SDK + Web API.
 * Kräver Spotify Premium, scopes streaming + user-modify-playback-state (+ user-read-playback-state),
 * och ny inloggning om token saknar dessa scopes.
 *
 * Stäng av med FEATURE_ROW_FULL_PLAYBACK i config.js.
 * Spelar-API (PUT /me/player/*) köas via enqueueAfterSpotifySearchChain i spotify-api.js.
 */
import { FEATURE_ROW_FULL_PLAYBACK } from './config.js';

/** @typedef {{ Player: new (opts: object) => SpotifyPlayer }} SpotifyRoot */
/** @typedef {{ connect: () => Promise<boolean>, disconnect: () => void, addListener: (ev: string, fn: Function) => void, removeListener: (ev: string, fn: Function) => void, pause: () => Promise<void>, resume: () => Promise<void>, seek: (ms: number) => Promise<void>, getCurrentState: () => Promise<object | null> }} SpotifyPlayer */

const PLAY_INTENT_GAP_MS = 650;

let wired = false;
/** @type {HTMLElement | null} */
let container = null;
/** @type {() => unknown[]} */
let getRows = () => [];
/** @type {(msg: string, isError?: boolean) => void} */
let showMessage = () => {};
/** @type {() => unknown} */
let getSpotifyClient = () => null;
/** @type {() => Promise<string>} */
let getAccessToken = async () => '';

/** @type {SpotifyPlayer | null} */
let webPlayer = null;
/** @type {string | null} */
let webDeviceId = null;
/** @type {object | null} */
let lastPlayerState = null;

/** @type {number | null} */
let activeRowIndex = null;
/** @type {string | null} */
let activeUri = null;
let lastPlayIntentMs = 0;

let loadSdkPromise = /** @type {Promise<void> | null} */ (null);

/** @type {ReturnType<typeof setInterval> | null} */
let playbackPollTimer = null;

function loadWebPlaybackSdk() {
  if (loadSdkPromise) return loadSdkPromise;
  loadSdkPromise = new Promise((resolve, reject) => {
    const root = /** @type {Window & { Spotify?: SpotifyRoot, onSpotifyWebPlaybackSDKReady?: () => void }} */ (window);
    if (root.Spotify?.Player) {
      resolve();
      return;
    }
    const prev = root.onSpotifyWebPlaybackSDKReady;
    root.onSpotifyWebPlaybackSDKReady = () => {
      try {
        if (typeof prev === 'function') prev();
      } catch {
        /* ok */
      }
      resolve();
    };
    const existing = document.querySelector('script[data-bjorklund-spotify-sdk]');
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Kunde inte ladda Spotify Web Playback SDK')), {
        once: true,
      });
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.async = true;
    s.setAttribute('data-bjorklund-spotify-sdk', '1');
    s.onload = () => {
      /* onSpotifyWebPlaybackSDKReady anropas av SDK */
    };
    s.onerror = () => reject(new Error('Kunde inte ladda Spotify Web Playback SDK'));
    document.head.appendChild(s);
  });
  return loadSdkPromise;
}

/**
 * @param {unknown} row
 * @returns {object | null}
 */
function getSelectedTrackFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  const r = /** @type {{ tracks?: unknown[], selectedUri?: string | null }} */ (row);
  const tracks = r.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const uri = r.selectedUri;
  const t = uri ? tracks.find((x) => x && typeof x === 'object' && /** @type {{uri?:string}} */ (x).uri === uri) : null;
  return /** @type {object | null} */ (t ?? tracks[0] ?? null);
}

/**
 * @param {unknown} track
 * @returns {string | null}
 */
function extractTrackUri(track) {
  if (!track || typeof track !== 'object') return null;
  const u = /** @type {{ uri?: unknown }} */ (track).uri;
  return typeof u === 'string' && u.startsWith('spotify:track:') ? u : null;
}

function resetPlaybackUiState() {
  activeRowIndex = null;
  activeUri = null;
  lastPlayerState = null;
}

async function ensureWebPlayerConnected() {
  await loadWebPlaybackSdk();
  const Spotify = /** @type {Window & { Spotify?: SpotifyRoot }} */ (window).Spotify;
  if (!Spotify?.Player) throw new Error('Spotify Web Playback SDK är inte tillgänglig');

  if (webPlayer && webDeviceId) {
    return { player: webPlayer, deviceId: webDeviceId };
  }

  if (webPlayer && !webDeviceId) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Spotify-spelaren svarade inte med enhet.')), 20000);
      const onReady = ({ device_id }) => {
        webDeviceId = device_id;
        clearTimeout(t);
        webPlayer?.removeListener('ready', onReady);
        resolve();
      };
      webPlayer.addListener('ready', onReady);
    });
    return { player: webPlayer, deviceId: /** @type {string} */ (webDeviceId) };
  }

  const player = new Spotify.Player({
    name: 'Bjorklunds Playlist (webb)',
    getOAuthToken: (cb) => {
      void getAccessToken()
        .then((tok) => cb(tok))
        .catch(() => cb(''));
    },
    volume: 0.88,
  });

  player.addListener('not_ready', () => {
    webDeviceId = null;
  });

  player.addListener('authentication_error', ({ message }) => {
    showMessage(
      `Spotify Web Player — autentisering misslyckades: ${message ?? ''}. Logga in igen under steg 0 (nya scopes: streaming).`,
      true,
    );
    try {
      player.disconnect();
    } catch {
      /* ok */
    }
    webPlayer = null;
    webDeviceId = null;
    resetPlaybackUiState();
    syncProgressBars();
    refreshPlaybackUi();
  });

  player.addListener('account_error', ({ message }) => {
    showMessage(`Spotify Web Player kräver Premium: ${message ?? 'Kontrollera abonnemang.'}`, true);
    try {
      player.disconnect();
    } catch {
      /* ok */
    }
    webPlayer = null;
    webDeviceId = null;
    resetPlaybackUiState();
    syncProgressBars();
    refreshPlaybackUi();
  });

  player.addListener('playback_error', ({ message }) => {
    showMessage(`Uppspelningsfel: ${message ?? 'Okänt'}`, true);
  });

  player.addListener('player_state_changed', (state) => {
    lastPlayerState = state;
    if (state === null && activeUri) {
      showMessage(
        'Webbuppspelningen avslutades (Premium krävs, eller aktiv enhet byttes). Logga in på nytt om du nyligen lade till scopes.',
        true,
      );
      resetPlaybackUiState();
    }
    syncProgressBars();
    refreshPlaybackUi();
  });

  let cancelReady = () => {};
  const readyPromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Spotify-spelaren startade inte i tid (ingen enhet).')), 25000);
    const onReady = ({ device_id }) => {
      webDeviceId = device_id;
      clearTimeout(t);
      player.removeListener('ready', onReady);
      resolve();
    };
    cancelReady = () => {
      clearTimeout(t);
      player.removeListener('ready', onReady);
    };
    player.addListener('ready', onReady);
  });

  webPlayer = player;
  try {
    const ok = await player.connect();
    if (!ok) {
      cancelReady();
      try {
        player.disconnect();
      } catch {
        /* ok */
      }
      webPlayer = null;
      webDeviceId = null;
      throw new Error('Webbläsaren tillät inte anslutning till Spotify Web Player.');
    }
    await readyPromise;
  } catch (e) {
    cancelReady();
    try {
      player.disconnect();
    } catch {
      /* ok */
    }
    webPlayer = null;
    webDeviceId = null;
    throw e;
  }
  return { player, deviceId: /** @type {string} */ (webDeviceId) };
}

function syncProgressBars() {
  if (!container) return;
  container.querySelectorAll('.match-block').forEach((article) => {
    const idx = Number(article.dataset.rowIndex);
    const range = article.querySelector('.row-preview__range');
    if (!(range instanceof HTMLInputElement)) return;
    const st = /** @type {{ paused?: boolean, position?: number, duration?: number, track_window?: { current_track?: { uri?: string } } } } | null> */ (
      lastPlayerState
    );
    const curUri = st?.track_window?.current_track?.uri;
    const dur = typeof st?.duration === 'number' ? st.duration : 0;
    const pos = typeof st?.position === 'number' ? st.position : 0;
    if (idx === activeRowIndex && activeUri && curUri === activeUri && dur > 0) {
      range.value = String(Math.min(1, Math.max(0, pos / dur)));
    } else if (idx !== activeRowIndex) {
      range.value = '0';
    }
  });
}

function refreshPlaybackUi() {
  if (!FEATURE_ROW_FULL_PLAYBACK || !container) return;
  const rows = /** @type {unknown[]} */ (getRows());
  const st = /** @type {{ paused?: boolean, track_window?: { current_track?: { uri?: string } } } | null> */ (lastPlayerState);
  const curUri = st?.track_window?.current_track?.uri;
  const playing = Boolean(st && !st.paused && curUri && activeUri && curUri === activeUri && activeRowIndex !== null);
  const durOk =
    Boolean(st && typeof st.duration === 'number' && st.duration > 0 && curUri === activeUri && activeRowIndex !== null);

  container.querySelectorAll('.match-block').forEach((article) => {
    const idx = Number(article.dataset.rowIndex);
    const row = rows[idx];
    const track = getSelectedTrackFromRow(row);
    const uri = extractTrackUri(track);
    const playBtn = article.querySelector('.row-preview__play');
    const range = article.querySelector('.row-preview__range');
    const isActive = activeRowIndex === idx;
    const client = getSpotifyClient();
    const hasClient =
      client != null &&
      typeof /** @type {{ startPlaybackOnDevice?: unknown }} */ (client).startPlaybackOnDevice === 'function';

    if (playBtn instanceof HTMLButtonElement) {
      const canPlay = Boolean(uri && hasClient);
      playBtn.disabled = !canPlay;
      playBtn.title = uri
        ? 'Spela hela låten i webbläsaren (Spotify Premium + scope streaming)'
        : 'Saknar Spotify-URI för träffen.';
      const on = playing && isActive;
      playBtn.classList.toggle('row-preview__play--on', on);
      playBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (range instanceof HTMLInputElement) {
      range.disabled = !(isActive && activeUri && uri === activeUri && durOk);
    }
  });
}

/**
 * @param {HTMLElement} resultsBody
 * @param {{
 *   getRows: () => unknown[],
 *   showMessage: (msg: string, isError?: boolean) => void,
 *   getSpotifyClient?: () => unknown,
 *   getAccessToken: () => Promise<string>,
 * }} opts
 */
export function bindRowPlaybackControls(resultsBody, opts) {
  if (!FEATURE_ROW_FULL_PLAYBACK || wired) return;
  wired = true;
  container = resultsBody;
  getRows = opts.getRows;
  showMessage = opts.showMessage;
  getSpotifyClient = opts.getSpotifyClient ?? (() => null);
  getAccessToken = opts.getAccessToken;
  resultsBody.addEventListener('click', onResultsClick);
  resultsBody.addEventListener('input', onRangeInput);
  playbackPollTimer = window.setInterval(() => {
    if (!FEATURE_ROW_FULL_PLAYBACK || !webPlayer || activeRowIndex == null || !activeUri) return;
    void webPlayer.getCurrentState().then((s) => {
      if (s) {
        lastPlayerState = s;
        syncProgressBars();
        refreshPlaybackUi();
      }
    });
  }, 750);
}

/** @param {Event} e */
function onResultsClick(e) {
  if (!FEATURE_ROW_FULL_PLAYBACK) return;
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.closest('.row-preview__stop')) {
    e.preventDefault();
    void stopRowPlayback();
    return;
  }
  const playBtn = t.closest('.row-preview__play');
  if (!playBtn || !(playBtn instanceof HTMLButtonElement)) return;
  e.preventDefault();
  if (playBtn.classList.contains('row-preview__play--busy')) return;
  const article = playBtn.closest('.match-block');
  if (!article) return;
  const rowIndex = Number(article.dataset.rowIndex);
  if (Number.isNaN(rowIndex)) return;

  const rows = /** @type {unknown[]} */ (getRows());
  const row = rows[rowIndex];
  const track = getSelectedTrackFromRow(row);
  const uri = extractTrackUri(track);
  if (!uri) {
    showMessage('Saknar Spotify-URI för vald träff.', true);
    return;
  }

  const client = getSpotifyClient();
  if (!client || typeof /** @type {{ startPlaybackOnDevice: (d: string, b: object, s?: AbortSignal) => Promise<void> }} */ (client).startPlaybackOnDevice !== 'function') {
    showMessage('Logga in under steg 0 för att spela upp.', true);
    return;
  }

  void (async () => {
    playBtn.classList.add('row-preview__play--busy');
    try {
      const { deviceId } = await ensureWebPlayerConnected();

      const st = /** @type {{ paused?: boolean, track_window?: { current_track?: { uri?: string } } } | null> */ (
        lastPlayerState
      );
      const sameTrackPaused =
        activeRowIndex === rowIndex &&
        activeUri === uri &&
        st?.paused &&
        st?.track_window?.current_track?.uri === uri;

      if (sameTrackPaused && webPlayer) {
        await webPlayer.resume();
        activeRowIndex = rowIndex;
        activeUri = uri;
        lastPlayerState = await webPlayer.getCurrentState();
        syncProgressBars();
        refreshPlaybackUi();
        return;
      }

      const now = Date.now();
      if (activeRowIndex !== null && activeRowIndex !== rowIndex && now - lastPlayIntentMs < PLAY_INTENT_GAP_MS) {
        showMessage('Vänta en kort stund innan du byter rad.', false);
        return;
      }
      lastPlayIntentMs = now;

      await /** @type {{ startPlaybackOnDevice: (d: string, b: { uris: string[] }, s?: AbortSignal) => Promise<void> }} */ (
        client
      ).startPlaybackOnDevice(deviceId, { uris: [uri] });

      activeRowIndex = rowIndex;
      activeUri = uri;
      if (webPlayer) {
        lastPlayerState = await webPlayer.getCurrentState();
      }
      syncProgressBars();
      refreshPlaybackUi();
    } catch (err) {
      showMessage(String(err instanceof Error ? err.message : err), true);
    } finally {
      playBtn.classList.remove('row-preview__play--busy');
      refreshPlaybackUi();
      syncProgressBars();
    }
  })();
}

/** @param {Event} e */
function onRangeInput(e) {
  if (!FEATURE_ROW_FULL_PLAYBACK || !webPlayer) return;
  const r = /** @type {HTMLElement} */ (e.target).closest('.row-preview__range');
  if (!(r instanceof HTMLInputElement)) return;
  const article = r.closest('.match-block');
  if (!article) return;
  const idx = Number(article.dataset.rowIndex);
  if (idx !== activeRowIndex) return;
  const st = /** @type {{ duration?: number } | null} */ (lastPlayerState);
  const dur = typeof st?.duration === 'number' ? st.duration : 0;
  if (!Number.isFinite(dur) || dur <= 0) return;
  const frac = Number(r.value);
  if (!Number.isFinite(frac)) return;
  const ms = Math.floor(Math.min(1, Math.max(0, frac)) * dur);
  void webPlayer.seek(ms).catch(() => {
    showMessage('Kunde inte spola. Försök igen.', true);
  });
}

export async function stopRowPlayback() {
  try {
    if (webPlayer) await webPlayer.pause();
  } catch {
    /* ok */
  }
  const client = getSpotifyClient();
  const did = webDeviceId;
  if (client && did && typeof /** @type {{ pausePlayer: (d: string) => Promise<void> }} */ (client).pausePlayer === 'function') {
    try {
      await client.pausePlayer(did);
    } catch {
      /* ok */
    }
  }
  resetPlaybackUiState();
  syncProgressBars();
  refreshPlaybackUi();
}

export function destroyRowPlayback() {
  if (playbackPollTimer != null) {
    clearInterval(playbackPollTimer);
    playbackPollTimer = null;
  }
  resetPlaybackUiState();
  try {
    webPlayer?.disconnect();
  } catch {
    /* ok */
  }
  webPlayer = null;
  webDeviceId = null;
  lastPlayerState = null;
  syncProgressBars();
  refreshPlaybackUi();
}

export function notifyRowPlaybackTrackChanged(rowIndex) {
  if (!FEATURE_ROW_FULL_PLAYBACK) return;
  if (activeRowIndex === rowIndex) void stopRowPlayback();
}

export function afterRenderRowPlayback() {
  if (!FEATURE_ROW_FULL_PLAYBACK) return;
  syncProgressBars();
  refreshPlaybackUi();
}
