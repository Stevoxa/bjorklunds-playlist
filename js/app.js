import {
  DEFAULT_PLAYLIST_DESCRIPTION,
  DEFAULT_PLAYLIST_NAME_PREFIX,
  FEATURE_ROW_FULL_PLAYBACK,
  PLAYLIST_LIST_CACHE_TTL_MS,
  PLAYLIST_LIST_STALE_IF_ERROR_MS,
  PLAYLIST_TRACKS_CACHE_TTL_MS,
  PLAYLIST_TRACKS_STALE_IF_ERROR_MS,
  EDIT_COMMIT_STEP_GAP_MS,
  EDIT_COMMIT_STEP_JITTER_MS,
  EDIT_REMOVE_BATCH_SIZE,
  EDIT_COMMIT_HEAVY_WARN_THRESHOLD,
} from './config.js';
import { getRedirectUri, beginLogin, consumeOAuthCallback } from './auth.js';
import { readLocalSettings, writeLocalSettings } from './local-settings.js';
import { idbGet } from './db.js';
import { parseTrackList } from './parser.js';
import { createSpotifyClient, parsePlaylistIdFromInput } from './spotify-api.js';
import { subscribeSpotifyLog, clearSpotifyLog, logSpotify } from './spotify-log.js';
import {
  makeSearchCacheKey,
  getSearchCache,
  setSearchCache,
  clearSearchCache,
  getSearchCacheStats,
} from './search-cache.js';
import {
  readPlaylistListCache,
  writePlaylistListCache,
  deletePlaylistListCache,
  readAllPlaylistsCache,
  writeAllPlaylistsCache,
  deleteAllPlaylistsCache,
} from './playlist-list-cache.js';
import {
  readPlaylistTracksCache,
  writePlaylistTracksCache,
  deletePlaylistTracksCache,
} from './playlist-tracks-cache.js';
import { readArtistBank, addArtistsToBank, deleteArtistBank } from './artist-bank.js';
import { readSpotifySession, writeSpotifySession, clearSpotifySession } from './token-session.js';
import {
  bindRowPlaybackControls,
  stopRowPlayback,
  notifyRowPlaybackTrackChanged,
  afterRenderRowPlayback,
  destroyRowPlayback,
  resetWebPlaybackSession,
} from './row-spotify-playback.js';

/** @type {ReturnType<createSpotifyClient> | null} */
let spotifyClient = null;

/** Visningsnamn eller e-post från GET /me (tom tills hämtat). */
let spotifyUserDisplay = '';

/** @type {object | null} */
let vaultData = null;

/**
 * tracks: null = Spotify-sökning ej körd, [] = sökt men inget, annars träfflista
 * @type {{ raw: string, query: string, artist?: string, title?: string, tracks: object[] | null, selectedUri: string | null, includedInPlaylist?: boolean }[]}
 */
let resultRows = [];

/** När true: rader utan `tracks` visar ”Söker…” i stället för inaktiv hjälptext */
let searchInProgress = false;

/** @type {AbortController | null} */
let searchAbortController = null;

const SPOTIFY_CHUNK = 100;

/** Paus mellan rader efter svar (ms), med liten jitter — minskar risk för 429 i rullande 30 s-fönster */
const SEARCH_ROW_GAP_MS = 3000;
const SEARCH_ROW_JITTER_MS = 1000;

/** Debounce: hämta om spellistor när prefix ändras under ”Mina listor med prefix” */
let playlistPrefixDebounceTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

/** @type {{ prefix: string, at: number, list: { id: string, name: string }[], truncated: boolean, userId: string } | null} */
let existingPlaylistListCache = null;

/**
 * @param {{ persistent?: boolean, userId?: string | null }} [opts]
 *   persistent: om true, rensa även IDB-cachen (t.ex. vid logout). Default: bara in-memory.
 */
function invalidateExistingPlaylistListCache(opts = {}) {
  const prevUserId = existingPlaylistListCache?.userId ?? null;
  existingPlaylistListCache = null;
  updatePlaylistListUpdatedAt(null, false);
  updatePlaylistListTruncatedWarning(false);
  if (opts.persistent) {
    const uid = opts.userId ?? prevUserId;
    if (uid) void deletePlaylistListCache(uid);
  }
}

/**
 * Efter ett finalt 429 på /me/playlists: pausa all **automatisk** refresh i detta fönster.
 * Manuell ”Hämta om lista” (klick av användaren) får fortfarande försöka.
 */
const PLAYLIST_LIST_429_COOLDOWN_MS = 5 * 60 * 1000;
let existingPlaylistListRateLimitUntil = 0;

function isExistingPlaylistListAutoFetchInCooldown() {
  return Date.now() < existingPlaylistListRateLimitUntil;
}

function remainingExistingPlaylistListCooldownMs() {
  return Math.max(0, existingPlaylistListRateLimitUntil - Date.now());
}

/** @type {AbortController | null} */
let playlistResultDialogEscapeAbort = null;

/** Efter lyckad Genomför på Spotify: lås knappen tills användaren ändrar data. */
let playlistApplyPostSuccess = false;

/** Programmatiska liständringar (t.ex. efter ny spellista) ska inte räknas som användarändring. */
let suppressPlaylistApplyDirty = false;

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

function defaultVault() {
  return {
    v: 1,
    clientId: '',
    tokens: null,
    settings: { theme: 'system', playlistNamePrefix: DEFAULT_PLAYLIST_NAME_PREFIX },
  };
}

/** Sparar aktuella, icke-känsliga inställningar (client-id, tema, prefix) till localStorage.
 *  Hämtar värdena direkt från formuläret så att auto-save alltid speglar UI-tillståndet.
 *  Tokens lagras aldrig här — de hanteras via sessionStorage i token-session.js. */
function persistLocalSettings() {
  writeLocalSettings({
    clientId: $('client-id').value.trim(),
    theme: /** @type {'system' | 'light' | 'dark'} */ ($('pref-theme').value),
    playlistNamePrefix: $('playlist-prefix').value,
    developerMode: /** @type {HTMLInputElement} */ ($('pref-developer-mode')).checked,
  });
}

/** Reflekterar utvecklarläget på <body> så CSS kan visa/dölja t.ex. Spotify API-loggen.
 *  Hålls separat från persistLocalSettings så vi även kan anropa den direkt vid hydrering. */
function applyDeveloperMode(on) {
  document.body.setAttribute('data-developer-mode', on ? 'on' : 'off');
}

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

/** Spellisteläge från steg 2 (radiogruppen pl-mode — enda gruppen i dokumentet). */
function getPlaylistMode() {
  const el = document.querySelector('input[name="pl-mode"]:checked');
  return el?.value === 'existing' ? 'existing' : 'new';
}

function spotifyOpenPlaylistUrl(playlistId) {
  const id = String(playlistId ?? '').trim();
  if (!id) return '#';
  return `https://open.spotify.com/playlist/${encodeURIComponent(id)}`;
}

/**
 * @param {{ ok: boolean, title: string, message: string, playlistId?: string, playlistName?: string, playlistOpenUrl?: string }} opts
 */
function showPlaylistResultDialog(opts) {
  const dlg = document.getElementById('playlist-result-dialog');
  const titleEl = document.getElementById('playlist-result-dialog-title');
  const msgEl = document.getElementById('playlist-result-dialog-message');
  const linkWrap = document.getElementById('playlist-result-dialog-link-wrap');
  const linkEl = document.getElementById('playlist-result-dialog-link');
  const iconUse = document.getElementById('playlist-result-dialog-icon-use');
  if (!dlg || !titleEl || !msgEl || !linkWrap || !linkEl || !iconUse) return;

  playlistResultDialogEscapeAbort?.abort();
  playlistResultDialogEscapeAbort = new AbortController();
  const { signal } = playlistResultDialogEscapeAbort;
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') hidePlaylistResultDialog();
    },
    { signal },
  );

  dlg.classList.toggle('playlist-result-dialog--error', !opts.ok);
  iconUse.setAttribute('href', opts.ok ? '#sym-check-circle' : '#sym-help');

  titleEl.textContent = opts.title;
  msgEl.textContent = opts.message;

  if (opts.ok && opts.playlistId) {
    const ext =
      (opts.playlistOpenUrl && String(opts.playlistOpenUrl).trim()) || spotifyOpenPlaylistUrl(opts.playlistId);
    linkEl.href = ext;
    linkEl.textContent = opts.playlistName
      ? `Öppna spellistan ”${opts.playlistName}” i Spotify`
      : 'Öppna spellistan i Spotify';
    linkWrap.hidden = false;
  } else {
    linkWrap.hidden = true;
    linkEl.removeAttribute('href');
    linkEl.textContent = '';
  }

  dlg.hidden = false;
  const panel = dlg.querySelector('.playlist-result-dialog__panel');
  requestAnimationFrame(() => panel?.focus({ preventScroll: true }));
}

function hidePlaylistResultDialog() {
  playlistResultDialogEscapeAbort?.abort();
  playlistResultDialogEscapeAbort = null;
  const dlg = document.getElementById('playlist-result-dialog');
  if (dlg) {
    dlg.hidden = true;
    dlg.classList.remove('playlist-result-dialog--error');
  }
}

function hideStep3ApplyResultUi() {
  const card = document.getElementById('step3-apply-result-card');
  if (card) {
    card.hidden = true;
    card.classList.remove('step3-apply-result-card--error');
  }
  playlistApplyPostSuccess = false;
}

/**
 * Resultat från Genomför på Spotify — visas i högerspalten (steg 3), inte som modal.
 * @param {{ ok: boolean, title: string, message: string, playlistId?: string, playlistName?: string, playlistOpenUrl?: string }} opts
 */
function showStep3PlaylistApplyResult(opts) {
  const card = document.getElementById('step3-apply-result-card');
  const titleEl = document.getElementById('step3-apply-result-title');
  const msgEl = document.getElementById('step3-apply-result-message');
  const linkWrap = document.getElementById('step3-apply-result-link-wrap');
  const linkEl = document.getElementById('step3-apply-result-link');
  const iconUse = document.getElementById('step3-apply-result-icon-use');
  if (!card || !titleEl || !msgEl || !linkWrap || !linkEl || !iconUse) return;

  card.classList.toggle('step3-apply-result-card--error', !opts.ok);
  iconUse.setAttribute('href', opts.ok ? '#sym-check-circle' : '#sym-help');

  titleEl.textContent = opts.title;
  msgEl.textContent = opts.message;

  if (opts.ok && opts.playlistId) {
    const ext =
      (opts.playlistOpenUrl && String(opts.playlistOpenUrl).trim()) || spotifyOpenPlaylistUrl(opts.playlistId);
    linkEl.href = ext;
    linkEl.textContent = opts.playlistName
      ? `Öppna spellistan ”${opts.playlistName}” i Spotify`
      : 'Öppna spellistan i Spotify';
    linkWrap.hidden = false;
  } else {
    linkWrap.hidden = true;
    linkEl.removeAttribute('href');
    linkEl.textContent = '';
  }

  playlistApplyPostSuccess = Boolean(opts.ok);
  card.hidden = false;
  refreshSummary();

  /* Scrolla responsmeddelandet in i vy och flytta focus dit — både för seende
   * användare (som annars kan tro att inget hände, särskilt på desktop där
   * kortet dyker upp i höger spalt) och för skärmläsare. requestAnimationFrame
   * ger layouten en frame att räkna om position efter att vi tog bort `hidden`. */
  requestAnimationFrame(() => {
    if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');
    try {
      card.focus({ preventScroll: true });
    } catch {
      /* fokus kan kastas i vissa edge-cases (t.ex. element redan borttaget) */
    }
    try {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      card.scrollIntoView();
    }
  });
}

/** Rensar lyckat resultat + lås när användaren ändrar låtar, sökning eller spellista. */
function touchPlaylistApplyPostSuccessDirty() {
  if (suppressPlaylistApplyDirty) return;
  hideStep3ApplyResultUi();
  hidePlaylistResultDialog();
  refreshSummary();
}

function showToast(message, isError = false) {
  const t = $('toast');
  clearTimeout(showToast._timer);
  if (showToast._abort) {
    showToast._abort.abort();
    showToast._abort = null;
  }
  t.textContent = message;
  t.hidden = false;
  if (isError) {
    t.style.background = '#c62828';
    t.classList.add('toast--error');
    t.style.cursor = 'pointer';
    t.title = 'Tryck här för att stänga meddelandet';
    const longHelp =
      message.length > 100 ||
      /scope|behörighet|Forbidden|403|401|Dashboard|Logga ut|privat spellista/i.test(message);
    showToast._durationMs = longHelp ? 26_000 : 12_000;
    const dismiss = () => {
      clearTimeout(showToast._timer);
      showToast._abort?.abort();
      showToast._abort = null;
      t.hidden = true;
    };
    showToast._abort = new AbortController();
    t.addEventListener('click', dismiss, { signal: showToast._abort.signal });
    showToast._timer = setTimeout(dismiss, showToast._durationMs);
  } else {
    t.style.background = '';
    t.classList.remove('toast--error');
    t.style.cursor = 'default';
    t.removeAttribute('title');
    showToast._durationMs = 5000;
    showToast._timer = setTimeout(() => {
      t.hidden = true;
    }, showToast._durationMs);
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    root.setAttribute('data-theme', theme);
  } else {
    root.removeAttribute('data-theme');
  }
}

function getClientId() {
  return $('client-id').value.trim();
}

/** Synkar Spotify-token till sessionStorage så omladdning i samma flik behåller inloggning. */
function syncSpotifySessionToStorage() {
  if (!vaultData?.tokens?.accessToken) {
    clearSpotifySession();
    return;
  }
  const cid = (vaultData.clientId || '').trim() || getClientId().trim();
  if (!cid) return;
  writeSpotifySession(cid, vaultData.tokens);
}

/** Återställer inloggning från sessionStorage efter sidladdning (samma webbläsarflik). */
function restoreSpotifySessionIfAny() {
  const snap = readSpotifySession();
  if (!snap) return false;
  vaultData = vaultData ?? defaultVault();
  vaultData.clientId = snap.clientId;
  vaultData.tokens = snap.tokens;
  $('client-id').value = snap.clientId;
  return true;
}

/** Håller valvets Client ID i synk med fältet (t.ex. efter navigering Inställningar ↔ flöde). */
function syncClientIdFromFormIntoVault() {
  if (!vaultData) return;
  const cid = getClientId().trim();
  if (cid) vaultData.clientId = cid;
}

function persistTokensFromClient() {
  if (!spotifyClient || !vaultData) return;
  vaultData.tokens = spotifyClient.getTokens();
}

/** Återställer icke-känsliga inställningar från localStorage in i formuläret och tillämpar tema.
 *  Körs vid boot så att användaren slipper ange Client ID igen mellan sessioner. */
function hydrateLocalSettingsIntoUI() {
  const s = readLocalSettings();
  if (s.clientId) $('client-id').value = s.clientId;
  $('pref-theme').value = s.theme;
  $('playlist-prefix').value = s.playlistNamePrefix;
  /** @type {HTMLInputElement} */ ($('pref-developer-mode')).checked = s.developerMode === true;
  applyDeveloperMode(s.developerMode === true);
  vaultData = vaultData ?? defaultVault();
  vaultData.clientId = s.clientId;
  vaultData.settings = {
    ...defaultVault().settings,
    theme: s.theme,
    playlistNamePrefix: s.playlistNamePrefix,
  };
  applyTheme(s.theme);
}

/** Formatterar bytes som en kort, läsbar storlek för statistikraderna i Inställningar. */
function formatBytesShort(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Relativ tidsangivelse på svenska för statistikraderna (t.ex. "för 3 min sedan"). */
function formatRelativeSv(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'nyss';
  const s = Math.round(ms / 1000);
  if (s < 45) return 'nyss';
  const m = Math.round(s / 60);
  if (m < 60) return `för ${m} min sedan`;
  const h = Math.round(m / 60);
  if (h < 24) return `för ${h} timme${h === 1 ? '' : 'r'} sedan`;
  const d = Math.round(h / 24);
  return `för ${d} dag${d === 1 ? '' : 'ar'} sedan`;
}

/** Skriver/uppdaterar sökcache- och artist-bank-stats i Inställningar.
 *  Säker att kalla när som helst — elementen ligger alltid i DOM:en. */
async function refreshSettingsStats() {
  const cacheEl = document.getElementById('search-cache-stats');
  if (cacheEl) {
    const { entries, bytes, newestAt } = getSearchCacheStats();
    if (entries <= 0) {
      cacheEl.textContent = 'Tom cache.';
    } else {
      const parts = [`${entries} sökning${entries === 1 ? '' : 'ar'}`, formatBytesShort(bytes)];
      if (newestAt) parts.push(`senast uppdaterad ${formatRelativeSv(Date.now() - newestAt)}`);
      cacheEl.textContent = parts.join(' · ');
    }
  }

  const bankEl = document.getElementById('artist-bank-stats');
  if (!bankEl) return;
  const uid = spotifyClient?.getCachedUserId?.() ?? null;
  if (!uid) {
    bankEl.textContent = 'Ingen artist-bank för det aktuella kontot (kräver inloggning på Spotify).';
    return;
  }
  try {
    const bank = await readArtistBank(uid);
    if (!bank || bank.artists.length === 0) {
      bankEl.textContent = 'Banken är tom för det här kontot — fylls på av framtida sökningar.';
      return;
    }
    const count = bank.artists.length;
    const parts = [`${count} artist${count === 1 ? '' : 'er'} lärda`];
    if (typeof bank.at === 'number' && bank.at > 0) {
      parts.push(`senast uppdaterad ${formatRelativeSv(Date.now() - bank.at)}`);
    }
    bankEl.textContent = parts.join(' · ');
  } catch {
    bankEl.textContent = 'Kunde inte läsa artist-banken.';
  }
}

function initSpotifyClient() {
  if (FEATURE_ROW_FULL_PLAYBACK) destroyRowPlayback();
  if (spotifyClient && vaultData) {
    try {
      vaultData.tokens = spotifyClient.getTokens();
    } catch {
      /* ignorera */
    }
  }
  syncClientIdFromFormIntoVault();
  spotifyClient = null;
  spotifyUserDisplay = '';
  if (!vaultData?.tokens?.accessToken) return;
  const cid = (vaultData.clientId || '').trim() || getClientId().trim();
  if (!cid) return;
  vaultData.clientId = cid;
  spotifyClient = createSpotifyClient(vaultData.tokens, cid, (t) => {
    vaultData.tokens = t;
    syncSpotifySessionToStorage();
  });
  syncSpotifySessionToStorage();
}

/**
 * @param {string} symbolId t.ex. "#sym-info"
 * @param {number} [size]
 */
function svgUseEl(symbolId, size = 24) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', symbolId.startsWith('#') ? symbolId : `#${symbolId}`);
  svg.append(use);
  return svg;
}

/**
 * @param {HTMLElement} container
 * @param {string} gs
 */
function appendScopePills(container, gs) {
  const parts = String(gs).trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return;
  const wrap = document.createElement('div');
  wrap.className = 'scope-pills';
  for (const p of parts) {
    const span = document.createElement('span');
    span.className = 'scope-pill';
    span.textContent = p;
    wrap.append(span);
  }
  container.append(wrap);
}

async function refreshSpotifyUserDisplay() {
  spotifyUserDisplay = '';
  if (!spotifyClient) return;
  try {
    const me = await spotifyClient.me();
    const raw = me && (me.email || me.display_name);
    spotifyUserDisplay = raw ? String(raw).trim() : '';
  } catch {
    spotifyUserDisplay = '';
  }
}

/**
 * Gemensam Spotify-session i UI: återskapa klient från valv, GET /me för visning, statuskort.
 * Access token förnyas bara centralt i spotify-api (ensureAccess) när utgång närmar sig.
 * @param {string} [extraHint] till setAuthStatus (t.ex. vid kallstart utan token i minnet).
 */
async function syncSpotifySessionToUi(extraHint = '') {
  initSpotifyClient();
  await refreshSpotifyUserDisplay();
  setAuthStatus(extraHint);
}

const SPOTIFY_DASHBOARD_URL = 'https://developer.spotify.com/dashboard';

/**
 * Lägger till avsnittet om Client ID + PKCE (samma som i Spotify-kortets ingress + statusrutan).
 * @param {HTMLElement} parent
 */
function appendSpotifyClientSetupExplainer(parent) {
  const p = document.createElement('p');
  p.className = 'auth-status-card__expl';
  const a = document.createElement('a');
  a.href = SPOTIFY_DASHBOARD_URL;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'Spotify Developer Dashboard';
  p.append(
    document.createTextNode('Ange ditt eget Client ID från '),
    a,
    document.createTextNode(
      '. PKCE används för säker autentisering, så inget Client Secret behövs.',
    ),
  );
  parent.append(p);
}

/**
 * @param {string} [extraHint] Extra rad när valv finns men ingen session (vid första laddning).
 */
function setAuthStatus(extraHint = '') {
  const host = $('auth-status');
  host.replaceChildren();

  if (!vaultData?.tokens?.accessToken) {
    const card = document.createElement('div');
    card.className = 'auth-status-card auth-status-card--muted';
    const icon = document.createElement('div');
    icon.className = 'auth-status-card__icon';
    icon.append(svgUseEl('#sym-info', 26));
    const body = document.createElement('div');
    body.className = 'auth-status-card__body';
    const title = document.createElement('p');
    title.className = 'auth-status-card__title';
    title.textContent = 'Du är inte inloggad på Spotify.';
    body.append(title);
    appendSpotifyClientSetupExplainer(body);
    if (extraHint) {
      const note = document.createElement('p');
      note.className = 'auth-status-card__note';
      note.textContent = extraHint;
      body.append(note);
    }
    card.append(icon, body);
    host.append(card);
    refreshSummary();
    return;
  }

  const cid = (vaultData.clientId || '').trim() || getClientId().trim();
  if (!cid) {
    const card = document.createElement('div');
    card.className = 'auth-status-card auth-status-card--warning';
    const icon = document.createElement('div');
    icon.className = 'auth-status-card__icon';
    icon.append(svgUseEl('#sym-info', 26));
    const body = document.createElement('div');
    body.className = 'auth-status-card__body';
    const title = document.createElement('p');
    title.className = 'auth-status-card__title';
    title.textContent = 'Token finns, men Client ID saknas';
    const note = document.createElement('p');
    note.className = 'auth-status-card__note';
    note.textContent =
      'Det här kan hända efter omdirigering. Ange Client ID i fältet ovan och logga in igen.';
    body.append(title, note);
    card.append(icon, body);
    host.append(card);
    refreshSummary();
    return;
  }

  const exp = new Date(vaultData.tokens.expiresAt).toLocaleString('sv-SE');
  const gs = (vaultData.tokens.grantedScopeRaw || '').trim();
  const hasPlaylistScope =
    gs.includes('playlist-modify-public') || gs.includes('playlist-modify-private');

  const card = document.createElement('div');
  card.className = 'auth-status-card auth-status-card--success';
  const iconWrap = document.createElement('div');
  iconWrap.className = 'auth-status-card__icon';
  iconWrap.append(svgUseEl('#sym-check-circle', 28));

  const body = document.createElement('div');
  body.className = 'auth-status-card__body';

  const title = document.createElement('p');
  title.className = 'auth-status-card__title';
  title.textContent = spotifyUserDisplay ? `Inloggad som ${spotifyUserDisplay}` : 'Du är inloggad på Spotify.';

  const meta = document.createElement('p');
  meta.className = 'auth-status-card__meta';
  meta.textContent = `Spotify-token giltig till ${exp}.`;

  body.append(title, meta);
  if (gs) {
    appendScopePills(body, gs);
  } else {
    const alert = document.createElement('p');
    alert.className = 'auth-status-card__alert';
    alert.textContent =
      'Spotify skickade ingen lista över behörigheter i tokensvaret. Om spellistor nekas, koppla bort appen och logga in igen. Se instruktionerna gällande Forbidden (403) nedan.';
    body.append(alert);
  }
  if (gs && !hasPlaylistScope) {
    const alert = document.createElement('p');
    alert.className = 'auth-status-card__alert';
    alert.textContent =
      'Din token saknar behörigheten playlist-modify-public eller playlist-modify-private. Koppla bort appen på spotify.com/account/apps, kontrollera att du finns under User management i Spotify Developer Dashboard och logga sedan in igen.';
    body.append(alert);
  }

  const foot = document.createElement('p');
  foot.className = 'auth-status-card__note';
  foot.textContent =
    'Spotify-token förnyas automatiskt tills webbläsarsidan stängs eller att du klickar på knappen Logga ut.';
  body.append(foot);

  card.append(iconWrap, body);
  host.append(card);
  refreshSummary();
}

/**
 * @param {object} tokens
 * @param {string} [clientIdFromOAuth] Client ID från OAuth-rundan (formuläret är tomt efter sidladdning).
 */
function mergeOAuthTokens(tokens, clientIdFromOAuth) {
  if (!tokens) return;
  vaultData = vaultData ?? defaultVault();
  vaultData.tokens = tokens;
  const cid = (clientIdFromOAuth || '').trim() || getClientId().trim() || (vaultData.clientId || '').trim();
  vaultData.clientId = cid;
  $('client-id').value = cid;
  vaultData.settings = { ...defaultVault().settings, ...vaultData.settings };
  updateNewPlaylistPreview();
  updateApplyEnabled();
  void syncSpotifySessionToUi();
}

async function handleOAuthReturn() {
  const result = await consumeOAuthCallback();
  if (!result) return;
  if ('error' in result) {
    showToast(`Inloggningen avbröts: ${result.error}`, true);
    return;
  }
  mergeOAuthTokens(result.tokens, result.clientId);
}

/** Alla vyer i flödet. 'landing' är startsidan där användaren väljer flöde.
 * '0'–'3' används av Skapa-flödet; 'select-playlist'/'edit-playlist' av Redigera-flödet.
 * @typedef {'landing' | '0' | '1' | '2' | '3' | 'select-playlist' | 'edit-playlist' | 'settings'} FlowStep
 */

/** @type {FlowStep} */
let currentFlowStep = 'landing';

/** Senaste icke-settings-steg — används av toolbar__settings-knappen för att återvända till
 * det steg man kom från när man klickar retur-pilen på inställningssidan. */
/** @type {Exclude<FlowStep, 'settings'>} */
let lastFlowStepBeforeSettings = 'landing';

/** Vilket flöde användaren valt på landningssidan. null = landning aktiv / inget val. */
/** @type {'create' | 'edit' | null} */
let currentFlowMode = null;

const FLOW_MODE_STORAGE_KEY = 'bjorklunds-playlist-flow-mode';

/** Läs sparat flöde från sessionStorage (överlever sidomladdning men inte flik-stängning). */
function readStoredFlowMode() {
  try {
    const v = sessionStorage.getItem(FLOW_MODE_STORAGE_KEY);
    return v === 'create' || v === 'edit' ? v : null;
  } catch {
    return null;
  }
}

/** @param {'create' | 'edit' | null} mode */
function setFlowMode(mode) {
  currentFlowMode = mode;
  try {
    if (mode) sessionStorage.setItem(FLOW_MODE_STORAGE_KEY, mode);
    else sessionStorage.removeItem(FLOW_MODE_STORAGE_KEY);
  } catch {
    /* sessionStorage kan vara blockerat (inkognito i vissa webbläsare) — best-effort. */
  }
}

/** Breadcrumb-spec: steg-ID → synlig text. Två uppsättningar, en per flöde.
 *  Alla flöden har alltid "Start" som första crumb (landningssidan). */
const BREADCRUMB_SPECS = {
  create: /** @type {{ step: FlowStep, label: string, compactExtra?: string }[]} */ ([
    { step: 'landing', label: 'Start' },
    { step: '0', label: 'Logga in', compactExtra: ' på Spotify' },
    { step: '1', label: 'Välj musik' },
    { step: '2', label: 'Välj spellista' },
    { step: '3', label: 'Genomför' },
  ]),
  edit: /** @type {{ step: FlowStep, label: string, compactExtra?: string }[]} */ ([
    { step: 'landing', label: 'Start' },
    { step: '0', label: 'Logga in', compactExtra: ' på Spotify' },
    { step: 'select-playlist', label: 'Välj playlist' },
    { step: 'edit-playlist', label: 'Redigera playlist' },
  ]),
  /** När användaren står på landningssidan (inget flöde valt än) — bara Start. */
  none: /** @type {{ step: FlowStep, label: string, compactExtra?: string }[]} */ ([
    { step: 'landing', label: 'Start' },
  ]),
};

/**
 * Bygg om breadcrumb-listan utifrån aktivt flöde. Kallas från setFlowStep så varje
 * stegbyte återspeglas i knapparna. Vi återanvänder befintlig CSS (.flow-breadcrumbs__crumb).
 * @param {FlowStep} activeStep
 */
function renderBreadcrumbs(activeStep) {
  const list = document.getElementById('flow-breadcrumbs-list');
  if (!list) return;
  /* Inställningar har ingen egen plats i brödsmulorna — döljs via #flow-breadcrumbs-wrap. */
  const spec = currentFlowMode ? BREADCRUMB_SPECS[currentFlowMode] : BREADCRUMB_SPECS.none;
  list.innerHTML = '';
  for (const entry of spec) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'flow-breadcrumbs__crumb';
    btn.setAttribute('data-flow-step', entry.step);
    btn.setAttribute('aria-controls', `flow-step-${entry.step}`);
    if (entry.step === activeStep) {
      btn.classList.add('is-active');
      btn.setAttribute('aria-current', 'location');
    }
    /* Kompaktläge (mobil) kortar t.ex. "Logga in på Spotify" → "Logga in" via .compact-extra. */
    btn.appendChild(document.createTextNode(entry.label));
    if (entry.compactExtra) {
      const span = document.createElement('span');
      span.className = 'compact-extra';
      span.textContent = entry.compactExtra;
      btn.appendChild(span);
    }
    btn.addEventListener('click', () => {
      setFlowStep(entry.step, { focusPanel: true });
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function syncPageLeadStep3() {
  const lead = document.getElementById('app-page-lead');
  if (!lead) return;
  if (currentFlowStep === '2') {
    const mode = getPlaylistMode();
    lead.textContent =
      mode === 'new'
        ? 'Ange ett namn på den nya spellistan och välj om den ska vara publik.'
        : 'Välj hur du hittar spellistan och hur låtarna ska läggas till.';
    return;
  }
  if (currentFlowStep === '3') {
    lead.textContent = 'Kontrollera dina val och klicka på Genomför på Spotify när allt är klart.';
  }
}

/** Rubrik i kortet för spelliste-val (nu steg 2) växlar mellan ny / befintlig spellista. */
function syncStep3CardHeadings() {
  const title = document.getElementById('heading-playlist');
  const sub = document.getElementById('heading-playlist-sub');
  if (!title || !sub) return;
  const mode = getPlaylistMode();
  if (mode === 'new') {
    title.textContent = 'Skapa ny spellista';
    sub.textContent = 'Ange ett namn och välj om spellistan ska vara publik.';
  } else {
    title.textContent = 'Uppdatera befintlig spellista';
    sub.textContent = 'Välj hur du hittar spellistan som ska uppdateras och hur låtarna ska läggas till.';
  }
}

/** Scrolla fönstret till toppen så stegbyte inte landar mitt i sidan (t.ex. Välj musik). */
function scrollAppToTop() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

/**
 * @param {FlowStep} step
 * @param {{ focusPanel?: boolean, skipSpotifyWarmup?: boolean, fromPopstate?: boolean }} [opts]
 *   focusPanel: flytta fokus till aktivt steg (t.ex. efter klick i steglisten), inte vid sidladdning.
 *   skipSpotifyWarmup: vid steg 0 undvik dublett av init + /me när boot() redan kört syncSpotifySessionToUi.
 *   fromPopstate: anropet kommer från popstate-listenern (Android back / bakåtknapp) —
 *     då ska vi INTE pusha en ny history-entry (det vore en loop och skulle också göra
 *     att back-knappen inte längre kan stega tillbaka).
 */
function setFlowStep(step, opts = {}) {
  const { focusPanel = false, skipSpotifyWarmup = false, fromPopstate = false } = opts;
  syncClientIdFromFormIntoVault();
  /* Kom ihåg vilket flow-steg användaren var på innan inställningar öppnades, så att
   * retur-pilen i toolbaren kan ta hen tillbaka till samma vy vid stängning. */
  if (step === 'settings' && currentFlowStep !== 'settings') {
    lastFlowStepBeforeSettings = /** @type {Exclude<FlowStep, 'settings'>} */ (currentFlowStep);
  }
  /* När användaren går tillbaka till landningssidan nollställs flödesvalet så
   * nästa val kan bli antingen Skapa eller Redigera utan att gammal state hänger kvar. */
  if (step === 'landing') {
    setFlowMode(null);
  }
  const prevStep = currentFlowStep;
  currentFlowStep = step;
  if (FEATURE_ROW_FULL_PLAYBACK && step !== '1') {
    void resetWebPlaybackSession();
  }
  /* Spotify-accent på Logga in-vyn och Inställningar; navy på övriga. */
  const accent = step === '0' || step === 'settings' ? 'spotify' : 'navy';
  document.documentElement.setAttribute('data-flow-accent', accent);
  document.querySelectorAll('.flow-step').forEach((el) => {
    const p = el.getAttribute('data-flow-panel');
    el.classList.toggle('is-active', p === step);
  });
  const head = document.getElementById('app-page-head');
  if (head) head.setAttribute('data-flow-head', step);
  const bcWrap = document.getElementById('flow-breadcrumbs-wrap');
  if (bcWrap) bcWrap.hidden = step === 'settings';
  renderBreadcrumbs(step);
  /** @type {Record<FlowStep, string>} */
  const leads = {
    /* Landningssidan: låt kortets egen rubrik + subtitle bära introduktionen,
     * annars blir texten dubblerad. */
    landing: '',
    '0': 'För att använda appen behöver du först ange ditt Client ID och logga in på Spotify.',
    '1': 'Klistra in låtar, hitta rätt spår på Spotify och välj vilka som ska läggas till i spellistan.',
    '2': '',
    '3': '',
    'select-playlist': 'Välj en av dina spellistor för att redigera den.',
    'edit-playlist': 'Sortera, ta bort eller kopiera låtar. Ändringar skickas när du klickar Genomför.',
    settings: 'Anpassa hur appen fungerar lokalt på din enhet.',
  };
  const lead = document.getElementById('app-page-lead');
  if (lead) {
    if (step === '2' || step === '3') {
      syncPageLeadStep3();
      syncStep3CardHeadings();
    } else {
      /* Tom lead-text betyder att steget inte behöver en ingress ovanför kortet. */
      lead.textContent = leads[step] ?? '';
    }
  }
  document.body.setAttribute('data-flow-step', step);
  /* Toolbar-knappen är dubbelfunktion: öppna Inställningar (kugghjul) eller återvända
   * till flödet (retur-pil). Uppdatera tooltip/aria-label så skärmläsare och tooltips
   * reflekterar rätt avsikt. */
  document.querySelectorAll('.flow-toolbar__settings').forEach((el) => {
    const isSettings = step === 'settings';
    const label = isSettings ? 'Tillbaka' : 'Inställningar';
    el.setAttribute('aria-label', label);
    el.setAttribute('title', label);
    const labelSpan = el.querySelector('.flow-toolbar__settings-label');
    if (labelSpan) labelSpan.textContent = label;
  });
  if (step === '0' && !skipSpotifyWarmup) {
    void syncSpotifySessionToUi();
  }
  if (step === '1') {
    /** me() cachas i spotifyClient (5 min) — denna synk blir normalt utan nytt nätverksanrop. */
    void syncSpotifySessionToUi();
    updateApplyEnabled();
    updateNewPlaylistPreview();
    if (resultRows.length > 0) renderResults();
  }
  if (step === 'settings') {
    /* Rendera stats varje gång användaren öppnar Inställningar — sökcache växer under tiden
     * i fliken och artist-banken kan ha uppdaterats efter en sökning. */
    void refreshSettingsStats();
  }
  if (step === 'select-playlist') {
    enterSelectPlaylistStep();
  }
  if (step === 'edit-playlist') {
    enterEditPlaylistStep();
  } else if (prevStep === 'edit-playlist') {
    /* Lämnar Redigera-vyn: städa Sortable-instansen + ev. pågående tracks-fetch.
     * Vi behåller editPlaylistState så att snabb tillbakanavigering visar listan direkt. */
    exitEditPlaylistStep();
  }
  updateSummarySubtitle(step);
  updateSummaryTip(step);
  syncPlaylistModeBlocks();
  refreshSummary();
  scrollAppToTop();
  if (focusPanel) {
    const panelId = step === 'settings' ? 'flow-step-settings' : `flow-step-${step}`;
    const panel = document.getElementById(panelId);
    requestAnimationFrame(() => {
      scrollAppToTop();
      if (panel) panel.focus({ preventScroll: true });
      requestAnimationFrame(scrollAppToTop);
    });
  } else {
    requestAnimationFrame(() => scrollAppToTop());
  }
  /* Spara varje vy-byte i historiken så att Android/back-knappen stegar bakåt i
   * appen istället för att lämna sidan direkt. Vi rör inte URL:en (tredje arg
   * utelämnas) så OAuth-redirecten och andra URL-antaganden påverkas inte. */
  if (!fromPopstate && step !== prevStep) {
    try {
      history.pushState({ step }, '');
    } catch {
      /* ignorera — vissa WebView-konfigurationer kan strypa pushState */
    }
  }
}

function updateSummarySubtitle(step) {
  const el = document.getElementById('summary-card-subtitle');
  if (!el) return;
  const lines = {
    landing: 'Välj ett flöde för att komma igång.',
    '0': 'Status för inloggning och nästa steg.',
    '1': 'Kontrollera dina val innan du går vidare till spellistan.',
    '2': 'Kontrollera dina val innan du fortsätter.',
    '3': 'Kontrollera dina val innan du genomför.',
    'select-playlist': 'Välj en spellista att redigera.',
    'edit-playlist': 'Sortera, ta bort eller kopiera låtar i listan.',
    settings: 'Kontrollera dina val innan du fortsätter.',
  };
  el.textContent = lines[step] ?? '';
}

function updateSummaryTip(step) {
  const tip = document.getElementById('sum-tip-text');
  if (!tip) return;
  const plMode = getPlaylistMode();
  if (step === '2' && plMode === 'existing') {
    const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
    tip.textContent =
      src === 'from-link'
        ? 'Du kan klistra in en vanlig spellistelänk från Spotify, eller en Spotify-URI i formatet spotify:playlist:.... Båda pekar på samma spellista. Enklast hämtar du länken i Spotify via Dela och Kopiera spellistelänk.'
        : 'Listan visar bara spellistor du själv äger och vars namn börjar med ditt prefix. Prefixet kan ändras i Inställningar och används för att göra appens spellistor lättare att hitta och skilja från andra listor i Spotify.';
    return;
  }
  if (step === '2' && plMode === 'new') {
    tip.textContent =
      'Prefixet hämtas från Inställningar och läggs till automatiskt när du skapar en ny spellista. Det gör spellistor från appen lättare att hitta och hjälper till att skilja dem från andra spellistor i Spotify.';
    return;
  }
  const tips = {
    landing:
      'Välj ”Skapa spellista” för att bygga en ny lista från en låtlista, eller ”Redigera spellista” för att justera en befintlig lista på Spotify.',
    '0':
      'Du loggar in direkt hos Spotify, så appen får aldrig tillgång till ditt lösenord. Client ID används bara för att identifiera appen och inloggningen skyddas med PKCE med tidsbegränsad åtkomst.',
    '1':
      'Sökningar sparas i 60 minuter, vilket gör upprepade sökningar snabbare och minskar onödiga anrop till Spotify. Om du vill kan du rensa sökcachen i Inställningar.',
    '2': 'Du behöver vara inloggad på Spotify för att fortsätta.',
    '3': 'Kontrollera sammanfattningen och klicka på Genomför på Spotify när allt är klart.',
    'select-playlist':
      'Dina spellistor hämtas från Spotify med skydd mot snabba upprepade anrop. Du kan söka/filtrera listan ovanför träffarna när funktionen är klar.',
    'edit-playlist':
      'Ändringar (sortering, bortval, bortagning) buffras lokalt och skickas först när du klickar på Genomför på Spotify.',
    settings: 'Prefixet används när du skapar nya spellistor och för att filtrera dina spellistor.',
  };
  tip.textContent = tips[step] ?? tips.landing;
}

function refreshSummary() {
  const sumSpotify = document.getElementById('sum-spotify');
  const sumTracks = document.getElementById('sum-tracks');
  const sumPlaylist = document.getElementById('sum-playlist');
  const sumAction = document.getElementById('sum-action');
  const sumFoot = document.getElementById('sum-foot');
  const sumRowExtra = document.getElementById('sum-row-extra');
  const sumExtra = document.getElementById('sum-extra');
  const sumExtraLabel = document.getElementById('sum-extra-label');
  if (!sumSpotify || !sumTracks || !sumPlaylist || !sumAction || !sumFoot) return;

  const hasToken = Boolean(vaultData?.tokens?.accessToken);
  const cid = (vaultData?.clientId || '').trim() || getClientId().trim();
  const expiresAt = vaultData?.tokens?.expiresAt;
  if (hasToken && spotifyClient && expiresAt) {
    const t = new Date(expiresAt);
    const timeStr = t.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    sumSpotify.textContent = `Spotify-token giltig till ${timeStr}`;
    sumSpotify.classList.add('summary-list__value--ok');
  } else if (hasToken && spotifyClient) {
    sumSpotify.textContent = 'Inloggad';
    sumSpotify.classList.add('summary-list__value--ok');
  } else if (hasToken && !cid) {
    sumSpotify.textContent = 'Token finns, men Client ID saknas';
    sumSpotify.classList.remove('summary-list__value--ok');
  } else {
    sumSpotify.textContent = 'Inte inloggad';
    sumSpotify.classList.remove('summary-list__value--ok');
  }

  let trackCount = 0;
  try {
    trackCount = selectedUrisForPlaylist().length;
  } catch {
    trackCount = 0;
  }
  sumTracks.textContent = trackCount === 0 ? '—' : String(trackCount);

  const mode = getPlaylistMode();
  if (mode === 'new') {
    const suf = $('new-pl-name').value.trim();
    sumPlaylist.textContent = suf ? `${getPlaylistPrefixFromInput()}${suf}` : '—';
  } else {
    const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
    if (src === 'from-list') {
      const sel = $('existing-pl-select');
      sumPlaylist.textContent = sel.value
        ? (sel.selectedOptions[0]?.textContent?.trim() ?? sel.value)
        : '—';
    } else {
      const raw = $('existing-pl-id').value.trim();
      sumPlaylist.textContent = raw || '—';
    }
  }

  const sumActionIcon = document.getElementById('sum-action-icon-use');
  if (mode === 'new') {
    sumAction.textContent = 'Skapa ny spellista';
    sumActionIcon?.setAttribute('href', '#sym-file-earmark-plus');
  } else {
    sumAction.textContent = 'Uppdatera en befintlig spellista';
    sumActionIcon?.setAttribute('href', '#sym-recycle');
  }

  const sumRowPublish = document.getElementById('sum-row-publish');
  const sumPublishStatus = document.getElementById('sum-publish-status');
  const sumPublishIconUse = document.getElementById('sum-publish-icon-use');
  if (sumRowPublish && sumPublishStatus && sumPublishIconUse) {
    if (mode === 'new') {
      sumRowPublish.hidden = false;
      sumRowPublish.removeAttribute('aria-hidden');
      const v = $('new-pl-visibility').value;
      const visLabels = { private: 'Privat', public: 'Publik', collaborative: 'Samarbete' };
      sumPublishStatus.textContent = visLabels[v] ?? '—';
      sumPublishIconUse.setAttribute('href', v === 'private' ? '#sym-lock-closed' : '#sym-unlock-open');
    } else {
      sumRowPublish.hidden = true;
      sumRowPublish.setAttribute('aria-hidden', 'true');
    }
  }

  if (mode === 'new') {
    if (sumRowExtra) {
      sumRowExtra.hidden = true;
      sumRowExtra.setAttribute('aria-hidden', 'true');
    }
    if (sumExtra) sumExtra.textContent = '';
    if (sumExtraLabel) sumExtraLabel.textContent = 'Källa';
  } else if (sumRowExtra && sumExtra && sumExtraLabel) {
    sumRowExtra.hidden = false;
    sumRowExtra.removeAttribute('aria-hidden');
    const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
    sumExtraLabel.textContent = 'Källa';
    sumExtra.textContent = src === 'from-list' ? 'Vald från mina spellistor på Spotify' : 'Spotify-länk';
    document
      .getElementById('sum-extra-icon-use')
      ?.setAttribute('href', src === 'from-list' ? '#sym-list' : '#sym-link');
  }

  const sumRowUpdate = document.getElementById('sum-row-update-method');
  const sumUpdateMethod = document.getElementById('sum-update-method');
  const sumUpdateIcon = document.getElementById('sum-update-method-icon-use');
  if (sumRowUpdate && sumUpdateMethod && sumUpdateIcon) {
    if (mode === 'existing') {
      sumRowUpdate.hidden = false;
      sumRowUpdate.removeAttribute('aria-hidden');
      const um = document.querySelector('input[name="pl-update"]:checked')?.value ?? 'append';
      if (um === 'replace') {
        sumUpdateMethod.textContent =
          'Alla befintliga låtar tas bort och ersätts med de valda låtarna.';
        sumUpdateIcon.setAttribute('href', '#sym-arrow-repeat');
      } else {
        sumUpdateMethod.textContent =
          'Befintliga låtar behålls och de valda låtarna läggs till i slutet av spellistan.';
        sumUpdateIcon.setAttribute('href', '#sym-plus-circle');
      }
    } else {
      sumRowUpdate.hidden = true;
      sumRowUpdate.setAttribute('aria-hidden', 'true');
    }
  }

  if (!hasToken) {
    sumFoot.textContent = 'Du behöver logga in på Spotify för att fortsätta.';
  } else if (mode === 'existing') {
    const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
    if (src === 'from-list' && !$('existing-pl-select').value) {
      sumFoot.textContent = 'Välj en spellista för att fortsätta.';
    } else if (src === 'from-link' && !$('existing-pl-id').value.trim()) {
      sumFoot.textContent = 'Ange en Spotify-länk eller ett spellist-ID.';
    } else if (trackCount === 0) {
      sumFoot.textContent = 'Välj minst en låt under steg 1.';
    } else {
      sumFoot.textContent = 'Redo att uppdatera spellistan på Spotify.';
    }
  } else if (trackCount === 0) {
    sumFoot.textContent = 'Välj minst en låt för att fortsätta.';
  } else if (!$('new-pl-name').value.trim()) {
    sumFoot.textContent = 'Ange ett namn på den nya spellistan.';
  } else {
    sumFoot.textContent = 'Redo att skapa spellistan på Spotify.';
  }

  refreshStep3SummaryCard();
  updateSummaryTip(currentFlowStep);
  updateApplyEnabled();
}

/** Speglar sammanfattningen till steg 3:s huvudkort (Spotify-Token / Valda låtar / …). */
function refreshStep3SummaryCard() {
  const spotify = document.getElementById('step3-sum-spotify');
  const tracks = document.getElementById('step3-sum-tracks');
  const playlist = document.getElementById('step3-sum-playlist');
  const action = document.getElementById('step3-sum-action');
  const rowExtra = document.getElementById('step3-sum-row-extra');
  const extraLabel = document.getElementById('step3-sum-extra-label');
  const extra = document.getElementById('step3-sum-extra');
  const rowUpdate = document.getElementById('step3-sum-row-update-method');
  const updateMethod = document.getElementById('step3-sum-update-method');
  if (!tracks || !playlist || !action) return;
  const asideSpotify = document.getElementById('sum-spotify');
  const asideTracks = document.getElementById('sum-tracks');
  const asidePlaylist = document.getElementById('sum-playlist');
  const asideAction = document.getElementById('sum-action');
  const asideRowExtra = document.getElementById('sum-row-extra');
  const asideExtraLabel = document.getElementById('sum-extra-label');
  const asideExtra = document.getElementById('sum-extra');
  const asideRowUpdate = document.getElementById('sum-row-update-method');
  const asideUpdateMethod = document.getElementById('sum-update-method');
  if (spotify && asideSpotify) {
    spotify.textContent = asideSpotify.textContent ?? '—';
    spotify.classList.toggle('step3-summary-list__value--ok', asideSpotify.classList.contains('summary-list__value--ok'));
  }
  if (asideTracks) tracks.textContent = asideTracks.textContent ?? '—';
  if (asidePlaylist) playlist.textContent = asidePlaylist.textContent ?? '—';
  if (asideAction) action.textContent = asideAction.textContent ?? '—';
  const asideActionIcon = document.getElementById('sum-action-icon-use');
  const step3ActionIcon = document.getElementById('step3-sum-action-icon-use');
  const actionHref = asideActionIcon?.getAttribute('href');
  if (actionHref && step3ActionIcon) step3ActionIcon.setAttribute('href', actionHref);

  const rowPublish = document.getElementById('step3-sum-row-publish');
  const asideRowPublish = document.getElementById('sum-row-publish');
  const publishStatus = document.getElementById('step3-sum-publish-status');
  const asidePublishStatus = document.getElementById('sum-publish-status');
  const publishIconUse = document.getElementById('step3-sum-publish-icon-use');
  const asidePublishIconUse = document.getElementById('sum-publish-icon-use');
  if (rowPublish && asideRowPublish && publishStatus && asidePublishStatus && publishIconUse && asidePublishIconUse) {
    rowPublish.hidden = asideRowPublish.hidden;
    if (asideRowPublish.hasAttribute('aria-hidden')) {
      rowPublish.setAttribute('aria-hidden', asideRowPublish.getAttribute('aria-hidden') ?? 'true');
    } else {
      rowPublish.removeAttribute('aria-hidden');
    }
    publishStatus.textContent = asidePublishStatus.textContent ?? '—';
    const ph = asidePublishIconUse.getAttribute('href');
    if (ph) publishIconUse.setAttribute('href', ph);
  }
  if (rowExtra && asideRowExtra) {
    rowExtra.hidden = asideRowExtra.hidden;
    if (asideRowExtra.hasAttribute('aria-hidden')) {
      rowExtra.setAttribute('aria-hidden', asideRowExtra.getAttribute('aria-hidden') ?? 'true');
    } else {
      rowExtra.removeAttribute('aria-hidden');
    }
    if (extraLabel && asideExtraLabel) extraLabel.textContent = asideExtraLabel.textContent ?? 'Källa';
    if (extra && asideExtra) extra.textContent = asideExtra.textContent ?? '—';
    const asideExtraIcon = document.getElementById('sum-extra-icon-use');
    const step3ExtraIcon = document.getElementById('step3-sum-extra-icon-use');
    const extraHref = asideExtraIcon?.getAttribute('href');
    if (extraHref && step3ExtraIcon) step3ExtraIcon.setAttribute('href', extraHref);
  }
  if (rowUpdate && asideRowUpdate && updateMethod && asideUpdateMethod) {
    rowUpdate.hidden = asideRowUpdate.hidden;
    if (asideRowUpdate.hasAttribute('aria-hidden')) {
      rowUpdate.setAttribute('aria-hidden', asideRowUpdate.getAttribute('aria-hidden') ?? 'true');
    } else {
      rowUpdate.removeAttribute('aria-hidden');
    }
    updateMethod.textContent = asideUpdateMethod.textContent ?? '—';
    const asideUpIcon = document.getElementById('sum-update-method-icon-use');
    const step3UpIcon = document.getElementById('step3-sum-update-method-icon-use');
    const upHref = asideUpIcon?.getAttribute('href');
    if (upHref && step3UpIcon) step3UpIcon.setAttribute('href', upHref);
  }
  syncStep3LockedTip();
}

/** På steg 3: visa tipskort där högerpanelen normalt ligger när Genomför är låst. Göms när knappen är aktiv. */
function syncStep3LockedTip() {
  const wrap = document.getElementById('step3-locked-tip');
  const text = document.getElementById('step3-locked-tip-text');
  if (!wrap || !text) return;
  const resultCard = document.getElementById('step3-apply-result-card');
  if (resultCard && !resultCard.hidden) {
    wrap.hidden = true;
    return;
  }
  const onStep3 = currentFlowStep === '3';
  const ready = isStep3ApplyReady();
  if (!onStep3 || ready) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  if (!spotifyClient) {
    text.textContent = 'Logga in på Spotify för att kunna genomföra.';
    return;
  }
  if (resultRows.length === 0) {
    text.textContent = 'Sök efter låtar och välj minst en under Välj musik innan du genomför.';
    return;
  }
  if (selectedUrisForPlaylist().length === 0) {
    text.textContent = 'Välj minst en låt under Välj musik innan du genomför.';
    return;
  }
  const mode = getPlaylistMode();
  if (mode === 'new') {
    text.textContent = 'Ange ett namn på den nya spellistan under Välj spellista innan du genomför.';
    return;
  }
  const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
  if (src === 'from-list') {
    text.textContent = 'Välj en befintlig spellista under Välj spellista innan du genomför.';
    return;
  }
  text.textContent = 'Ange en giltig Spotify-länk eller ett giltigt spellist-ID under Välj spellista innan du genomför.';
}

function wireFlow() {
  document.querySelectorAll('[data-flow-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = btn.getAttribute('data-flow-step');
      if (s) setFlowStep(/** @type {FlowStep} */ (s), { focusPanel: true });
    });
  });
  document.querySelectorAll('[data-flow-goto]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = btn.getAttribute('data-flow-goto');
      if (s) setFlowStep(/** @type {FlowStep} */ (s), { focusPanel: true });
    });
  });
  /* Landningssidans val-kort: sätter flöde och går vidare till login (eller hoppar
   * över login om en aktiv Spotify-token redan finns — fast den går alltid att nå
   * via breadcrumben "Logga in" om man vill logga ut). */
  document.querySelectorAll('[data-flow-goto-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = btn.getAttribute('data-flow-goto-mode');
      if (m !== 'create' && m !== 'edit') return;
      setFlowMode(m);
      const hasToken = Boolean(vaultData?.tokens?.accessToken) && spotifyClient;
      if (hasToken) {
        /* Giltig token — hoppa direkt till flödets första inre steg. */
        setFlowStep(m === 'create' ? '1' : 'select-playlist', { focusPanel: true });
      } else {
        setFlowStep('0', { focusPanel: true });
      }
    });
  });
  /* Dynamisk "Nästa" på inloggningsvyn: destination beror på valt flöde. Om inget
   * flöde är valt (användaren har landat på '0' via breadcrumb/direktlänk) defaultar
   * vi till Skapa-flödet som tidigare beteende. */
  const step0Next = document.getElementById('btn-step-0-next');
  if (step0Next) {
    step0Next.addEventListener('click', () => {
      const target = currentFlowMode === 'edit' ? 'select-playlist' : '1';
      if (!currentFlowMode) setFlowMode('create');
      setFlowStep(target, { focusPanel: true });
    });
  }
  /* Toolbar-knappen: toggla mellan att öppna Inställningar och att återvända till
   * det flöde man kom från. Byter ikon via CSS (body[data-flow-step='settings']). */
  document.querySelectorAll('.flow-toolbar__settings').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (currentFlowStep === 'settings') {
        setFlowStep(lastFlowStepBeforeSettings, { focusPanel: true });
      } else {
        setFlowStep('settings', { focusPanel: true });
      }
    });
  });
  /* "Tillbaka till flödet"-knappen längst ner på inställningssidan ska återvända
   * till den vy användaren kom ifrån — samma beteende som retur-pilen i toolbaren.
   * (Tidigare hårdkodad till steg 0 via data-flow-goto.) */
  const backFromSettings = document.getElementById('btn-settings-back-to-flow');
  if (backFromSettings) {
    backFromSettings.addEventListener('click', () => {
      setFlowStep(lastFlowStepBeforeSettings, { focusPanel: true });
    });
  }
  /* Android/browser back-knappen: istället för att lämna PWA:n direkt, stegar
   * vi tillbaka en vy i flödet. setFlowStep pushar en entry vid varje byte och
   * popstate läser tillbaka det föregående step-värdet här. fromPopstate ser
   * till att vi inte pushar en ny entry i svar på ett bakåt-steg. */
  try {
    history.replaceState({ step: currentFlowStep }, '');
  } catch {
    /* best-effort */
  }
  window.addEventListener('popstate', (ev) => {
    const s = ev.state && typeof ev.state.step === 'string' ? ev.state.step : null;
    if (!s) return;
    setFlowStep(/** @type {FlowStep} */ (s), { focusPanel: true, fromPopstate: true });
  });
}

function getPlaylistPrefixFromInput() {
  const raw = $('playlist-prefix').value;
  return raw.length > 0 ? raw : DEFAULT_PLAYLIST_NAME_PREFIX;
}

function updateNewPlaylistPreview() {
  const pre = getPlaylistPrefixFromInput();
  const suf = $('new-pl-name').value.trim() || '…';
  $('new-pl-preview').textContent = `${pre}${suf}`;
  syncExistingPlSelectHelpPrefix();
}

/** Visar aktuellt prefix som länk till Inställningar (spelliste-prefix). */
function syncExistingPlSelectHelpPrefix() {
  const link = document.getElementById('existing-pl-prefix-link');
  if (!link) return;
  const raw = getPlaylistPrefixFromInput();
  link.textContent = raw;
  link.setAttribute('aria-label', `Gå till Inställningar och redigera prefix: ${raw}`);
}

function updateExistingPlaylistSourceUi() {
  if (getPlaylistMode() !== 'existing') return;
  const fromList = document.querySelector('input[name="pl-existing-source"]:checked')?.value === 'from-list';
  $('block-existing-from-list').hidden = !fromList;
  $('block-existing-from-link').hidden = fromList;
}

/** Avbryter föregående spelliste-hämtning — annars kan två parallella körningar ge dubbletter i spellistelistan. */
let existingPlSelectRefreshAbort = /** @type {AbortController | null} */ (null);

/** Single-flight för ”Mina listor”-hämtning. Pågående jobb delas av alla nya auto-triggers. */
let existingPlSelectInFlight = /** @type {Promise<void> | null} */ (null);

/**
 * @param {HTMLSelectElement} sel
 * @param {{ id: string, name: string }[]} list
 * @param {string} preserveId
 * @param {string | undefined} selectPlaylistId
 */
function populateExistingPlaylistSelectFromList(sel, list, preserveId, selectPlaylistId) {
  sel.replaceChildren();
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = 'Välj en spellista';
  sel.append(ph);
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.append(opt);
  }
  const explicit =
    selectPlaylistId != null && String(selectPlaylistId).trim() !== '' ? String(selectPlaylistId).trim() : '';
  const idToRestore = explicit || preserveId;
  if (idToRestore && list.some((p) => p.id === idToRestore)) {
    sel.value = idToRestore;
  }
}

/**
 * @param {{ quiet?: boolean, selectPlaylistId?: string, force?: boolean, manual?: boolean, reason?: string }} [opts]
 *   quiet: ingen toast vid nätverkshämtning. selectPlaylistId: välj detta id efter laddning.
 *   force: kringgå cache (t.ex. ”Hämta om lista”, ny skapad spellista).
 *   manual: användaren tryckte Hämta om lista — kringgå cooldown.
 *   reason: spåras i API-loggen ('step-enter' | 'source-change' | 'prefix-change' | 'manual-refresh' | 'post-create' | 'unknown').
 */
async function refreshExistingPlaylistSelect(opts = {}) {
  const { quiet = false, selectPlaylistId, force = false, manual = false, reason = 'unknown' } = opts;
  if (!spotifyClient) {
    showToast('Du behöver logga in på Spotify först.', true);
    return;
  }
  const prefixNow = getPlaylistPrefixFromInput();
  const selNow = $('existing-pl-select');
  /** Id som ska återställas efter omladdning (t.ex. val innan stegbyte — syncPlaylistModeBlocks kör refresh utan id). */
  const preserveNow = selNow.value.trim();

  /** Ingen in-memory cache ännu? Försök ladda från IDB (gratis, ingen nätverk). */
  if (!existingPlaylistListCache) {
    const userIdKnown = typeof spotifyClient.getCachedUserId === 'function' ? spotifyClient.getCachedUserId() : null;
    if (userIdKnown) {
      const persisted = await readPlaylistListCache(userIdKnown);
      if (persisted && persisted.prefix === prefixNow) {
        existingPlaylistListCache = {
          prefix: persisted.prefix,
          at: persisted.at,
          list: persisted.list,
          truncated: persisted.truncated,
          userId: persisted.userId,
        };
      }
    }
  }

  const cacheFresh =
    !force &&
    existingPlaylistListCache &&
    existingPlaylistListCache.prefix === prefixNow &&
    Date.now() - existingPlaylistListCache.at < PLAYLIST_LIST_CACHE_TTL_MS;

  logSpotify({
    t: new Date().toISOString(),
    kind: 'ui',
    phase: 'refreshPlaylistList',
    reason,
    cacheHit: Boolean(cacheFresh),
    inFlight: Boolean(existingPlSelectInFlight),
    inCooldown: isExistingPlaylistListAutoFetchInCooldown(),
    manual,
    force,
    prefix: prefixNow,
  });

  if (cacheFresh) {
    populateExistingPlaylistSelectFromList(selNow, existingPlaylistListCache.list, preserveNow, selectPlaylistId);
    updatePlaylistListTruncatedWarning(existingPlaylistListCache.truncated);
    updatePlaylistListUpdatedAt(existingPlaylistListCache.at, /* stale */ false);
    refreshSummary();
    return;
  }

  /** Nätverkspaus efter 429: blockera automatiska refreshes; manuellt klick får ändå försöka. */
  if (!manual && isExistingPlaylistListAutoFetchInCooldown()) {
    const leftSec = Math.max(1, Math.ceil(remainingExistingPlaylistListCooldownMs() / 1000));
    if (!quiet) {
      showToast(
        `Spotify har pausat vidare anrop. Försök igen om cirka ${leftSec} sekunder eller klicka på Hämta om lista.`,
        true,
      );
    }
    /** Stale-if-error: om vi har en någorlunda färsk cache (inom STALE_IF_ERROR-fönstret) — visa den trots cooldown. */
    maybePopulateFromStaleCache(selNow, prefixNow, preserveNow, selectPlaylistId);
    return;
  }

  /** Single-flight: om ett jobb redan kör (stegbyte, pl-mode, pl-existing-source, prefix-debounce) återanvänds dess Promise.
   *  Manuell ”Hämta om lista” får också dela samma pågående jobb — annars dubbelanrop mot Spotify. */
  if (existingPlSelectInFlight) return existingPlSelectInFlight;

  const ac = new AbortController();
  existingPlSelectRefreshAbort = ac;
  const { signal } = ac;

  const job = (async () => {
    try {
      const prefix = getPlaylistPrefixFromInput();
      const sel = $('existing-pl-select');
      const preserveId = sel.value.trim();
      const { list, truncated, userId } = await spotifyClient.listMyPlaylistsByPrefix(prefix, signal);
      const at = Date.now();
      existingPlaylistListCache = {
        prefix,
        at,
        list: list.map((p) => ({ id: p.id, name: p.name })),
        truncated,
        userId,
      };
      /** Skriv till IDB i bakgrunden — fel där ska inte störa UI. */
      void writePlaylistListCache(userId, prefix, list, truncated);
      populateExistingPlaylistSelectFromList(sel, list, preserveId, selectPlaylistId);
      updatePlaylistListTruncatedWarning(truncated);
      updatePlaylistListUpdatedAt(at, /* stale */ false);
      refreshSummary();
      if (!quiet) {
        showToast(list.length ? `${list.length} spellistor matchar prefixet.` : 'Inga spellistor matchar prefixet.');
      }
    } catch (e) {
      if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      /** Stale-if-error: låt användaren få ut något vid nätverks-/429-fel. */
      const fellBack = maybePopulateFromStaleCache(selNow, prefixNow, preserveNow, selectPlaylistId);
      if (fellBack && !quiet) {
        showToast('Kunde inte uppdatera listan från Spotify just nu — visar senast kända lista.', true);
      }
      throw e;
    } finally {
      if (existingPlSelectRefreshAbort === ac) existingPlSelectRefreshAbort = null;
      existingPlSelectInFlight = null;
    }
  })();
  existingPlSelectInFlight = job;
  return job;
}

/**
 * Om `existingPlaylistListCache` är inom STALE_IF_ERROR-fönstret men utanför färsk-TTL,
 * fyll dropdown ändå så att användaren kan välja — markera UI som "möjligen inaktuell".
 * @param {HTMLSelectElement} sel
 * @param {string} prefixNow
 * @param {string} preserveNow
 * @param {string | undefined} selectPlaylistId
 */
function maybePopulateFromStaleCache(sel, prefixNow, preserveNow, selectPlaylistId) {
  const c = existingPlaylistListCache;
  if (!c || c.prefix !== prefixNow) return false;
  const age = Date.now() - c.at;
  if (age < 0 || age > PLAYLIST_LIST_STALE_IF_ERROR_MS) return false;
  populateExistingPlaylistSelectFromList(sel, c.list, preserveNow, selectPlaylistId);
  updatePlaylistListTruncatedWarning(c.truncated);
  updatePlaylistListUpdatedAt(c.at, /* stale */ true);
  refreshSummary();
  return true;
}

/**
 * Visa/göm varning när paginering hit MAX_PAGES (truncated=true).
 * @param {boolean} truncated
 */
function updatePlaylistListTruncatedWarning(truncated) {
  const el = document.getElementById('existing-pl-truncated-warning');
  if (!el) return;
  el.hidden = !truncated;
}

/**
 * Visar "Uppdaterad för X min sedan" intill Hämta om lista.
 * Uppdateras live var 30:e sekund så texten inte fastnar.
 * @param {number | null} at Epok-ms eller null för att dölja.
 * @param {boolean} stale Om cachen är hämtad som stale-if-error-fallback.
 */
/** @type {ReturnType<typeof setInterval> | null} */
let playlistListUpdatedAtTicker = null;
/** @type {{ at: number, stale: boolean } | null} */
let playlistListUpdatedAtState = null;

function updatePlaylistListUpdatedAt(at, stale) {
  const el = document.getElementById('existing-pl-updated-at');
  if (!el) return;
  if (at == null) {
    playlistListUpdatedAtState = null;
    el.hidden = true;
    el.textContent = '';
    if (playlistListUpdatedAtTicker) {
      clearInterval(playlistListUpdatedAtTicker);
      playlistListUpdatedAtTicker = null;
    }
    return;
  }
  playlistListUpdatedAtState = { at, stale };
  renderPlaylistListUpdatedAtText();
  if (!playlistListUpdatedAtTicker) {
    playlistListUpdatedAtTicker = setInterval(renderPlaylistListUpdatedAtText, 30_000);
  }
}

function renderPlaylistListUpdatedAtText() {
  const el = document.getElementById('existing-pl-updated-at');
  if (!el || !playlistListUpdatedAtState) return;
  const { at, stale } = playlistListUpdatedAtState;
  const ageMs = Math.max(0, Date.now() - at);
  const ageMin = Math.floor(ageMs / 60_000);
  let rel;
  if (ageMs < 60_000) rel = 'nu nyss';
  else if (ageMin < 60) rel = `för ${ageMin} min sedan`;
  else if (ageMin < 60 * 24) rel = `för ${Math.floor(ageMin / 60)} tim sedan`;
  else rel = `för ${Math.floor(ageMin / (60 * 24))} dag(ar) sedan`;
  el.textContent = stale ? `Senast uppdaterad ${rel} (ej verifierad mot Spotify just nu).` : `Uppdaterad ${rel}.`;
  el.classList.toggle('help--warning', stale);
  el.hidden = false;
}

/** Synkar steg 3: ny vs befintlig spellista (måste köras vid stegbyte, inte bara vid pl-mode change). */
function syncPlaylistModeBlocks() {
  const v = getPlaylistMode();
  const isNew = v === 'new';
  const step2 = document.getElementById('flow-step-2');
  if (step2) step2.setAttribute('data-playlist-mode', v);
  const step3 = document.getElementById('flow-step-3');
  if (step3) step3.setAttribute('data-playlist-mode', v);
  $('block-new-playlist').hidden = !isNew;
  $('block-existing-playlist').hidden = isNew;
  if (!isNew) {
    updateExistingPlaylistSourceUi();
    /**
     * Medvetet INGEN auto-refresh här: visning av step 2 eller återställning av "befintlig" via BFCache
     * ska inte trigga anrop mot /me/playlists. Refresh sker endast vid explicita användaråtgärder:
     * pl-mode change → existing, pl-existing-source change → from-list, prefix-change, manuellt klick,
     * samt direkt efter att en ny spellista skapats (force=true).
     */
  }
}

function wirePlaylistMode() {
  const modes = document.querySelectorAll('#flow-step-2 input[name="pl-mode"]');
  const update = () => {
    syncPlaylistModeBlocks();
    syncPageLeadStep3();
    syncStep3CardHeadings();
    touchPlaylistApplyPostSuccessDirty();
  };
  modes.forEach((r) => r.addEventListener('change', () => {
    update();
    /** Användaren bytte till befintlig spellista — hämta listan om källan är "Mina spellistor". */
    const mode = getPlaylistMode();
    const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
    if (mode === 'existing' && src === 'from-list' && spotifyClient && currentFlowStep === '2') {
      refreshExistingPlaylistSelect({ quiet: true, reason: 'mode-change' })
        .catch((e) => showToast(String(e?.message ?? e), true));
    }
  }));
  document.querySelectorAll('input[name="pl-update"]').forEach((r) => {
    r.addEventListener('change', () => {
      touchPlaylistApplyPostSuccessDirty();
    });
  });
  document.querySelectorAll('input[name="pl-existing-source"]').forEach((r) => {
    r.addEventListener('change', () => {
      updateExistingPlaylistSourceUi();
      if (r.value === 'from-list' && spotifyClient && currentFlowStep === '2') {
        refreshExistingPlaylistSelect({ quiet: true, reason: 'source-change' })
          .catch((e) => showToast(String(e?.message ?? e), true));
      }
      touchPlaylistApplyPostSuccessDirty();
    });
  });
  $('btn-refresh-pl-list').addEventListener('click', () => {
    refreshExistingPlaylistSelect({ quiet: false, force: true, manual: true, reason: 'manual-refresh' })
      .catch((e) => showToast(String(e?.message ?? e), true));
  });
  /** Spotify rate-limitade oss på /me/playlists — pausa auto-refresh en stund, informera användaren. */
  window.addEventListener('bjorklund-playlist-list-rate-limited', (ev) => {
    const detail = /** @type {CustomEvent<{ retryAfterParsedMs?: number | null }>} */ (ev).detail || {};
    const fromHeaderMs = typeof detail.retryAfterParsedMs === 'number' && detail.retryAfterParsedMs > 0
      ? detail.retryAfterParsedMs
      : 0;
    const cooldown = Math.max(PLAYLIST_LIST_429_COOLDOWN_MS, fromHeaderMs);
    existingPlaylistListRateLimitUntil = Date.now() + cooldown;
    const min = Math.max(1, Math.round(cooldown / 60_000));
    showToast(
      `Spotify har pausat vidare anrop. Vänta cirka ${min} minut(er) och klicka sedan på Hämta om lista.`,
      true,
    );
  });
  update();
}

/* =============================================================================
 * Redigera-flödet: "Välj playlist"-vy
 *
 * Återanvänder hela cache/single-flight/cooldown/stale-if-error-mönstret från
 * Skapa-flödets "Mina listor" (steg 2). Skillnad: vi hämtar *alla* listor och
 * filtrerar klientside, samt visar omslagsbild + ägare per rad.
 * ============================================================================= */

/** @typedef {{ id: string, name: string, ownerId: string, ownerName: string, imageUrl: string | null }} SelectPlaylistRow */

/** @type {{ at: number, list: SelectPlaylistRow[], truncated: boolean, userId: string } | null} */
let selectPlaylistListCache = null;

/** @type {Promise<void> | null} */
let selectPlaylistListInFlight = null;

/** @type {AbortController | null} */
let selectPlaylistListRefreshAbort = null;

let selectPlaylistFilterText = '';
let selectPlaylistShowPrefixedOnly = false;

/** @type {ReturnType<typeof setTimeout> | null} */
let selectPlaylistFilterDebounce = null;

/** Persisterat val av spellista för redigering (överlever reload i samma session). */
/** @type {{ id: string, name: string, ownerId: string, ownerName: string, imageUrl: string | null } | null} */
let selectedEditPlaylist = null;

const SELECT_PLAYLIST_EDIT_STORAGE_KEY = 'bjorklund-edit-playlist';

function readStoredSelectedEditPlaylist() {
  try {
    const raw = sessionStorage.getItem(SELECT_PLAYLIST_EDIT_STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o.id !== 'string' || typeof o.name !== 'string') return null;
    return {
      id: o.id,
      name: o.name,
      ownerId: typeof o.ownerId === 'string' ? o.ownerId : '',
      ownerName: typeof o.ownerName === 'string' ? o.ownerName : '',
      imageUrl: typeof o.imageUrl === 'string' ? o.imageUrl : null,
    };
  } catch {
    return null;
  }
}

function writeStoredSelectedEditPlaylist(v) {
  try {
    if (v) sessionStorage.setItem(SELECT_PLAYLIST_EDIT_STORAGE_KEY, JSON.stringify(v));
    else sessionStorage.removeItem(SELECT_PLAYLIST_EDIT_STORAGE_KEY);
  } catch {
    /* sessionStorage kan vara blockerat (t.ex. inbäddat) — val förloras vid reload då. */
  }
}

/** @type {{ at: number, stale: boolean } | null} */
let selectPlaylistUpdatedAtState = null;
/** @type {ReturnType<typeof setInterval> | null} */
let selectPlaylistUpdatedAtTicker = null;

function updateSelectPlaylistUpdatedAt(at, stale) {
  const el = document.getElementById('select-playlist-updated');
  if (!el) return;
  if (at == null) {
    selectPlaylistUpdatedAtState = null;
    el.hidden = true;
    el.textContent = '';
    if (selectPlaylistUpdatedAtTicker) {
      clearInterval(selectPlaylistUpdatedAtTicker);
      selectPlaylistUpdatedAtTicker = null;
    }
    return;
  }
  selectPlaylistUpdatedAtState = { at, stale };
  renderSelectPlaylistUpdatedAtText();
  if (!selectPlaylistUpdatedAtTicker) {
    selectPlaylistUpdatedAtTicker = setInterval(renderSelectPlaylistUpdatedAtText, 30_000);
  }
}

function renderSelectPlaylistUpdatedAtText() {
  const el = document.getElementById('select-playlist-updated');
  if (!el || !selectPlaylistUpdatedAtState) return;
  const { at, stale } = selectPlaylistUpdatedAtState;
  const ageMs = Math.max(0, Date.now() - at);
  const ageMin = Math.floor(ageMs / 60_000);
  let rel;
  if (ageMs < 60_000) rel = 'nu nyss';
  else if (ageMin < 60) rel = `för ${ageMin} min sedan`;
  else if (ageMin < 60 * 24) rel = `för ${Math.floor(ageMin / 60)} tim sedan`;
  else rel = `för ${Math.floor(ageMin / (60 * 24))} dag(ar) sedan`;
  el.textContent = stale
    ? `Senast uppdaterad ${rel} (ej verifierad mot Spotify just nu).`
    : `Uppdaterad ${rel}.`;
  el.classList.toggle('help--warning', stale);
  el.hidden = false;
}

function updateSelectPlaylistTruncatedWarning(truncated) {
  const el = document.getElementById('select-playlist-truncated-warning');
  if (!el) return;
  el.hidden = !truncated;
}

function setSelectPlaylistSpinnerVisible(visible) {
  const el = document.getElementById('select-playlist-spinner');
  if (el) el.hidden = !visible;
}

function invalidateSelectPlaylistCache(opts = {}) {
  const prevUserId = selectPlaylistListCache?.userId ?? null;
  selectPlaylistListCache = null;
  updateSelectPlaylistUpdatedAt(null, false);
  updateSelectPlaylistTruncatedWarning(false);
  if (opts.persistent) {
    const uid = opts.userId ?? prevUserId;
    if (uid) void deleteAllPlaylistsCache(uid);
  }
}

/**
 * Ta bort en enskild rad ur Välj playlist-cachen utan att invalidera hela cachen.
 * Används efter lyckad DELETE /playlists/{id}/followers så vi slipper ett extra
 * GET /me/playlists direkt efteråt — vi vet ju redan exakt vad som ändrats.
 * Cache-timestampen sätts till nu så TTL-fönstret förlängs (listan är fortfarande
 * korrekt eftersom vi kontrollerar ändringen själva).
 * @param {string} playlistId
 * @param {string | null} userId  Inloggad users id för att skriva IDB-cachen.
 */
function removeFromSelectPlaylistCache(playlistId, userId) {
  const c = selectPlaylistListCache;
  if (!c) {
    /* Ingen in-memory cache — då finns inget att plocka ur. Lämna IDB orörd så nästa
     * enterSelectPlaylistStep antingen läser IDB (om den har raden) eller fetchar fresh. */
    return;
  }
  const nextList = c.list.filter((p) => p.id !== playlistId);
  if (nextList.length === c.list.length) return;
  const now = Date.now();
  selectPlaylistListCache = {
    at: now,
    list: nextList,
    truncated: c.truncated,
    userId: c.userId,
  };
  const uid = userId ?? c.userId ?? null;
  if (uid) void writeAllPlaylistsCache(uid, nextList, c.truncated);
  updateSelectPlaylistUpdatedAt(now, /* stale */ false);
  renderSelectPlaylistList();
}

function computeFilteredSelectPlaylistRows() {
  const cache = selectPlaylistListCache;
  if (!cache) return [];
  const prefix = getPlaylistPrefixFromInput();
  const needle = selectPlaylistFilterText.trim().toLowerCase();
  return cache.list.filter((p) => {
    if (selectPlaylistShowPrefixedOnly && prefix && !p.name.startsWith(prefix)) return false;
    if (needle && !p.name.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function renderSelectPlaylistList() {
  const listEl = document.getElementById('select-playlist-list');
  const emptyEl = document.getElementById('select-playlist-empty');
  if (!listEl || !emptyEl) return;
  if (!selectPlaylistListCache) {
    listEl.replaceChildren();
    emptyEl.hidden = true;
    return;
  }
  const rows = computeFilteredSelectPlaylistRows();
  if (rows.length === 0) {
    listEl.replaceChildren();
    emptyEl.hidden = false;
    emptyEl.textContent = selectPlaylistListCache.list.length === 0
      ? 'Du har inga spellistor på Spotify än.'
      : 'Inga spellistor matchar filtret.';
    return;
  }
  emptyEl.hidden = true;
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'select-playlist-item';
    btn.dataset.playlistId = row.id;
    btn.setAttribute(
      'aria-label',
      `${row.name}${row.ownerName ? ` (ägare: ${row.ownerName})` : ''}`,
    );
    if (row.imageUrl) {
      const img = document.createElement('img');
      img.className = 'select-playlist-item__art';
      img.src = row.imageUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        const fallback = document.createElement('span');
        fallback.className = 'select-playlist-item__art-fallback';
        fallback.setAttribute('aria-hidden', 'true');
        fallback.innerHTML = '<svg><use href="#sym-playlist" /></svg>';
        img.replaceWith(fallback);
      }, { once: true });
      btn.append(img);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'select-playlist-item__art-fallback';
      fallback.setAttribute('aria-hidden', 'true');
      fallback.innerHTML = '<svg><use href="#sym-playlist" /></svg>';
      btn.append(fallback);
    }
    const body = document.createElement('span');
    body.className = 'select-playlist-item__body';
    const name = document.createElement('span');
    name.className = 'select-playlist-item__name';
    name.textContent = row.name;
    const owner = document.createElement('span');
    owner.className = 'select-playlist-item__owner';
    owner.textContent = row.ownerName ? `Ägare: ${row.ownerName}` : '';
    body.append(name, owner);
    btn.append(body);
    const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chev.setAttribute('class', 'select-playlist-item__chevron');
    chev.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#sym-chevron-right');
    chev.appendChild(use);
    btn.append(chev);
    btn.addEventListener('click', () => handleSelectPlaylistRowClick(row));
    li.append(btn);
    frag.append(li);
  }
  listEl.replaceChildren(frag);
}

function handleSelectPlaylistRowClick(row) {
  selectedEditPlaylist = {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    imageUrl: row.imageUrl,
  };
  writeStoredSelectedEditPlaylist(selectedEditPlaylist);
  setFlowStep('edit-playlist', { focusPanel: true });
}

function maybePopulateSelectPlaylistFromStaleCache() {
  const c = selectPlaylistListCache;
  if (!c) return false;
  const age = Date.now() - c.at;
  if (age < 0 || age > PLAYLIST_LIST_STALE_IF_ERROR_MS) return false;
  updateSelectPlaylistTruncatedWarning(c.truncated);
  updateSelectPlaylistUpdatedAt(c.at, /* stale */ true);
  renderSelectPlaylistList();
  return true;
}

/**
 * @param {{ force?: boolean, manual?: boolean, quiet?: boolean, reason?: string }} [opts]
 *   force: kringgå cache-TTL. manual: kringgå 429-cooldown (användaren tryckte "Hämta om lista").
 *   quiet: ingen toast vid felaktig nätverksväg. reason: loggas i Spotify-loggen.
 */
async function loadSelectPlaylistList(opts = {}) {
  const { force = false, manual = false, quiet = false, reason = 'unknown' } = opts;
  if (!spotifyClient) {
    if (!quiet) showToast('Du behöver logga in på Spotify först.', true);
    return;
  }

  /* Försök fylla in-memory-cachen från IDB innan vi resonerar om färskhet. */
  if (!selectPlaylistListCache) {
    const userIdKnown =
      typeof spotifyClient.getCachedUserId === 'function' ? spotifyClient.getCachedUserId() : null;
    if (userIdKnown) {
      const persisted = await readAllPlaylistsCache(userIdKnown);
      if (persisted) {
        selectPlaylistListCache = {
          at: persisted.at,
          list: persisted.list,
          truncated: persisted.truncated,
          userId: persisted.userId,
        };
      }
    }
  }

  const cacheFresh =
    !force &&
    selectPlaylistListCache &&
    Date.now() - selectPlaylistListCache.at < PLAYLIST_LIST_CACHE_TTL_MS;

  logSpotify({
    t: new Date().toISOString(),
    kind: 'ui',
    phase: 'refreshPlaylistList',
    reason: `select-playlist/${reason}`,
    cacheHit: Boolean(cacheFresh),
    inFlight: Boolean(selectPlaylistListInFlight),
    inCooldown: isExistingPlaylistListAutoFetchInCooldown(),
    manual,
    force,
  });

  if (cacheFresh) {
    updateSelectPlaylistTruncatedWarning(selectPlaylistListCache.truncated);
    updateSelectPlaylistUpdatedAt(selectPlaylistListCache.at, /* stale */ false);
    setSelectPlaylistSpinnerVisible(false);
    renderSelectPlaylistList();
    return;
  }

  /* Cooldown: delas med Skapa-flödets /me/playlists-kö. Manuell knapp får ändå försöka. */
  if (!manual && isExistingPlaylistListAutoFetchInCooldown()) {
    const leftSec = Math.max(1, Math.ceil(remainingExistingPlaylistListCooldownMs() / 1000));
    if (!quiet) {
      showToast(
        `Spotify har pausat vidare anrop. Försök igen om cirka ${leftSec} sekunder eller klicka på Hämta om lista.`,
        true,
      );
    }
    setSelectPlaylistSpinnerVisible(false);
    maybePopulateSelectPlaylistFromStaleCache();
    return;
  }

  if (selectPlaylistListInFlight) return selectPlaylistListInFlight;

  const ac = new AbortController();
  selectPlaylistListRefreshAbort = ac;
  const { signal } = ac;
  setSelectPlaylistSpinnerVisible(!selectPlaylistListCache);

  const job = (async () => {
    try {
      const { list, truncated, userId } = await spotifyClient.listMyPlaylistsAll(signal);
      const at = Date.now();
      selectPlaylistListCache = {
        at,
        list: list.map((p) => ({ ...p })),
        truncated,
        userId,
      };
      void writeAllPlaylistsCache(userId, list, truncated);
      updateSelectPlaylistTruncatedWarning(truncated);
      updateSelectPlaylistUpdatedAt(at, /* stale */ false);
      renderSelectPlaylistList();
      if (!quiet && manual) {
        showToast(
          list.length ? `${list.length} spellistor hämtade.` : 'Du har inga spellistor på Spotify.',
        );
      }
    } catch (e) {
      if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      const fellBack = maybePopulateSelectPlaylistFromStaleCache();
      if (!quiet) {
        showToast(
          fellBack
            ? 'Kunde inte uppdatera listan från Spotify just nu — visar senast kända lista.'
            : String(e?.message ?? e),
          true,
        );
      }
      throw e;
    } finally {
      setSelectPlaylistSpinnerVisible(false);
      if (selectPlaylistListRefreshAbort === ac) selectPlaylistListRefreshAbort = null;
      selectPlaylistListInFlight = null;
    }
  })();
  selectPlaylistListInFlight = job;
  return job;
}

function syncSelectPlaylistPrefixLabel() {
  const el = document.getElementById('select-playlist-prefix-label');
  if (!el) return;
  const prefix = getPlaylistPrefixFromInput();
  el.textContent = prefix;
}

function wireSelectPlaylist() {
  syncSelectPlaylistPrefixLabel();

  const toggle = /** @type {HTMLInputElement | null} */ (
    document.getElementById('select-playlist-prefix-toggle')
  );
  if (toggle) {
    try {
      selectPlaylistShowPrefixedOnly =
        localStorage.getItem('bjorklund-select-playlist-prefix-only') === '1';
    } catch {
      selectPlaylistShowPrefixedOnly = false;
    }
    toggle.checked = selectPlaylistShowPrefixedOnly;
    toggle.addEventListener('change', () => {
      selectPlaylistShowPrefixedOnly = toggle.checked;
      try {
        localStorage.setItem(
          'bjorklund-select-playlist-prefix-only',
          selectPlaylistShowPrefixedOnly ? '1' : '0',
        );
      } catch {
        /* ignore */
      }
      renderSelectPlaylistList();
    });
  }

  const input = /** @type {HTMLInputElement | null} */ (
    document.getElementById('select-playlist-filter-input')
  );
  if (input) {
    input.addEventListener('input', () => {
      if (selectPlaylistFilterDebounce) clearTimeout(selectPlaylistFilterDebounce);
      selectPlaylistFilterDebounce = setTimeout(() => {
        selectPlaylistFilterText = input.value;
        renderSelectPlaylistList();
      }, 150);
    });
  }

  const refreshBtn = document.getElementById('select-playlist-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadSelectPlaylistList({
        force: true,
        manual: true,
        reason: 'manual-refresh',
      }).catch(() => {
        /* fel visas redan som toast i loadSelectPlaylistList */
      });
    });
  }

  /* Prefixet kan ändras i Inställningar — uppdatera label så toggle visar rätt värde.
   * Lyssnar på samma input-händelse som debounce-loopen för Skapa-flödet. */
  const prefixInput = document.getElementById('playlist-prefix');
  if (prefixInput) {
    prefixInput.addEventListener('input', () => {
      syncSelectPlaylistPrefixLabel();
      if (currentFlowStep === 'select-playlist' && selectPlaylistShowPrefixedOnly) {
        renderSelectPlaylistList();
      }
    });
  }
}

function enterSelectPlaylistStep() {
  syncSelectPlaylistPrefixLabel();
  /* Rendera direkt från eventuell in-memory-cache så användaren ser något innan fetch. */
  if (selectPlaylistListCache) {
    updateSelectPlaylistTruncatedWarning(selectPlaylistListCache.truncated);
    updateSelectPlaylistUpdatedAt(selectPlaylistListCache.at, /* stale */ false);
    renderSelectPlaylistList();
  } else {
    setSelectPlaylistSpinnerVisible(true);
  }
  loadSelectPlaylistList({ reason: 'step-enter', quiet: true }).catch(() => {
    /* Toast hanteras internt. */
  });
}

/* --------------------------------------------------------------------------
 * Redigera playlist — state, render, DnD, bulk, radera och Genomför-på-Spotify.
 * Hålls nära select-playlist-mönstret: in-memory + IDB-cache, single-flight,
 * stale-if-error. Genomför körs med egen pacing och 429-retry via api-wrappern.
 * -------------------------------------------------------------------------- */

/** @typedef {import('./playlist-tracks-cache.js').CachedTrackRow} EditTrackRow */

/**
 * @type {{
 *   playlistId: string,
 *   meta: { id: string, name: string, description: string, ownerId: string, ownerName: string, imageUrl: string | null, snapshotId: string, total: number, isPublic: boolean, collaborative: boolean },
 *   original: EditTrackRow[],
 *   workingOrder: string[],
 *   pendingRemovals: Set<string>,
 *   selection: Set<string>,
 *   snapshotId: string,
 *   at: number,
 *   truncated: boolean,
 *   userId: string,
 * } | null}
 */
let editPlaylistState = null;

/** @type {Promise<void> | null} */
let editPlaylistTracksInFlight = null;

/** @type {AbortController | null} */
let editPlaylistTracksAbort = null;

/** @type {{ destroy: () => void } | null} */
let editPlaylistSortable = null;

/** @type {AbortController | null} */
let editPlaylistCommitAbort = null;

/** @type {{ at: number, stale: boolean } | null} */
let editPlaylistUpdatedAtState = null;
/** @type {ReturnType<typeof setInterval> | null} */
let editPlaylistUpdatedAtTicker = null;

function updateEditPlaylistUpdatedAt(at, stale) {
  const el = document.getElementById('edit-playlist-updated');
  if (!el) return;
  if (at == null) {
    editPlaylistUpdatedAtState = null;
    el.hidden = true;
    el.textContent = '';
    if (editPlaylistUpdatedAtTicker) {
      clearInterval(editPlaylistUpdatedAtTicker);
      editPlaylistUpdatedAtTicker = null;
    }
    return;
  }
  editPlaylistUpdatedAtState = { at, stale };
  renderEditPlaylistUpdatedAtText();
  if (!editPlaylistUpdatedAtTicker) {
    editPlaylistUpdatedAtTicker = setInterval(renderEditPlaylistUpdatedAtText, 30_000);
  }
}

function renderEditPlaylistUpdatedAtText() {
  const el = document.getElementById('edit-playlist-updated');
  if (!el || !editPlaylistUpdatedAtState) return;
  const { at, stale } = editPlaylistUpdatedAtState;
  const ageMs = Math.max(0, Date.now() - at);
  const ageMin = Math.floor(ageMs / 60_000);
  let rel;
  if (ageMs < 60_000) rel = 'nu nyss';
  else if (ageMin < 60) rel = `för ${ageMin} min sedan`;
  else if (ageMin < 60 * 24) rel = `för ${Math.floor(ageMin / 60)} tim sedan`;
  else rel = `för ${Math.floor(ageMin / (60 * 24))} dag(ar) sedan`;
  el.textContent = stale
    ? `Senast uppdaterad ${rel} (ej verifierad mot Spotify just nu).`
    : `Uppdaterad ${rel}.`;
  el.classList.toggle('help--warning', stale);
  el.hidden = false;
}

function setEditPlaylistSpinnerVisible(visible) {
  const el = document.getElementById('edit-playlist-spinner');
  if (el) el.hidden = !visible;
}

function updateEditPlaylistTruncatedWarning(truncated) {
  const el = document.getElementById('edit-playlist-truncated-warning');
  if (el) el.hidden = !truncated;
}

/**
 * Visa/dölj "den här listan kan inte läsas av tredjepartsappar"-banner.
 * När blocked=true applicerar vi även read-only-reglerna så alla redigerings-element
 * döljs konsekvent. Delete-knappen döljs också eftersom användaren inte kan göra
 * något meningsfullt här — hen får ta sig tillbaka via "Tillbaka"-navet.
 */
function setEditPlaylistBlocked(blocked) {
  const banner = document.getElementById('edit-playlist-blocked');
  if (banner) banner.hidden = !blocked;
  if (blocked) {
    setEditPlaylistReadOnly(true);
    const deleteBtn = document.getElementById('btn-edit-playlist-delete');
    if (deleteBtn) deleteBtn.hidden = true;
    /* readonly-noten handlar om "du äger inte listan" — felmeddelandet här är annorlunda. */
    const note = document.getElementById('edit-playlist-readonly-note');
    if (note) note.hidden = true;
  }
}

/**
 * Read-only-läge för spellistor användaren inte äger: /items kommer ge 403 (eller så kan
 * vi ändå inte spara ändringar), så vi hoppar över items-anropet och döljer allt som rör
 * trackredigering. Kvar blir headern (art/namn/ägare) och "Ta bort från biblioteket"-knappen.
 *
 * Viktigt: när readOnly=false får vi INTE tvinga hidden=false på element som normalt styrs
 * villkorligt (progress, spinner, bulk-bar, dirty-block, empty-state, truncated-warning).
 * Dessa kontrolleras av andra funktioner och ska få behålla sin state när vi lämnar read-only.
 * Vi återställer bara de element som alltid ska vara synliga i editerbar vy (total, status-row,
 * apply-knappen och själva <ol>-listan).
 * @param {boolean} readOnly
 */
function setEditPlaylistReadOnly(readOnly) {
  const hideInReadOnly = [
    'edit-playlist-total-row',
    'edit-playlist-status-row',
    'edit-playlist-truncated-warning',
    'edit-playlist-spinner',
    'edit-playlist-empty',
    'edit-playlist-bulk-bar',
    'edit-playlist-list',
    'edit-playlist-progress',
    'edit-playlist-dirty-block',
    'btn-edit-playlist-apply',
  ];
  const restoreWhenEditable = [
    'edit-playlist-total-row',
    'edit-playlist-status-row',
    'edit-playlist-list',
    'btn-edit-playlist-apply',
  ];
  if (readOnly) {
    for (const id of hideInReadOnly) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
  } else {
    for (const id of restoreWhenEditable) {
      const el = document.getElementById(id);
      if (el) el.hidden = false;
    }
  }
  const note = document.getElementById('edit-playlist-readonly-note');
  if (note) note.hidden = !readOnly;
}

/**
 * Returnerar true om vi vet upfront att användaren inte äger spellistan, dvs vi kan
 * hoppa över både getPlaylistMeta och getPlaylistTracksAll. Ownership bestäms från
 * selectedEditPlaylist.ownerId (satt när raden klickades i Välj playlist) jämfört med
 * inloggad users id. Om någon del är okänd returnerar vi false (då kör vi normalt flöde).
 */
function isEditPlaylistReadOnlyUpfront() {
  const ownerId = selectedEditPlaylist?.ownerId;
  if (!ownerId) return false;
  const uid =
    typeof spotifyClient?.getCachedUserId === 'function' ? spotifyClient.getCachedUserId() : null;
  if (!uid) return false;
  return String(ownerId) !== String(uid);
}

function renderEditPlaylistHeader() {
  const state = editPlaylistState;
  const meta = state?.meta;
  const nameEl = document.getElementById('edit-playlist-selected-name');
  if (nameEl) nameEl.textContent = meta?.name || selectedEditPlaylist?.name || '–';
  const ownerEl = document.getElementById('edit-playlist-owner');
  if (ownerEl) ownerEl.textContent = meta?.ownerName || selectedEditPlaylist?.ownerName || '–';
  const totalEl = document.getElementById('edit-playlist-total');
  if (totalEl) {
    if (state) {
      /** `totalOnSpotify` ska vara stabilt = det antal som faktiskt finns i Spotifys spellista
       *  just nu (= state.original.length). Det ändras först när Genomför har körts och vi
       *  skrivit om state.original. `kept` är vad som kommer att finnas kvar när användaren
       *  trycker Genomför — alltså workingOrder.length, vilken alltid är filtrerad för
       *  pendingRemovals (redan hanterat av bulk-remove-handlern).
       *
       *  Visningsmönster (matchar Spotifys "X av Y"):
       *    Inga lokala ändringar: "14"
       *    Pending borttagningar: "13 av 14"
       */
      const totalOnSpotify = state.original.length;
      const kept = state.workingOrder.length;
      totalEl.textContent = kept === totalOnSpotify ? String(totalOnSpotify) : `${kept} av ${totalOnSpotify}`;
    } else {
      totalEl.textContent = meta?.total != null ? String(meta.total) : '–';
    }
  }
  const img = /** @type {HTMLImageElement | null} */ (document.getElementById('edit-playlist-art'));
  const fallback = document.getElementById('edit-playlist-art-fallback');
  const imageUrl = meta?.imageUrl ?? selectedEditPlaylist?.imageUrl ?? null;
  if (img && fallback) {
    if (imageUrl) {
      img.src = imageUrl;
      img.alt = `Omslag för ${meta?.name || selectedEditPlaylist?.name || 'spellistan'}`;
      img.hidden = false;
      fallback.hidden = true;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
      fallback.hidden = false;
    }
  }
  const deleteBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-edit-playlist-delete'));
  if (deleteBtn) {
    deleteBtn.hidden = false;
    /** Knappen agerar olika beroende på ägarskap: för ägarens egen spellista är det en destruktiv
     *  "radera"-åtgärd (röd), för följda spellistor är det en icke-destruktiv "sluta följa" (neutral).
     *  Spotifys API-anrop är samma (DELETE /playlists/{id}/followers) — det är Spotifys egen semantik
     *  som avgör om följaren unfollowar eller ägaren faktiskt tar bort listan. */
    const isOwner = isEditPlaylistOwnedByUser();
    const labelEl = deleteBtn.querySelector('span:not(.btn__icon-wrap)');
    if (isOwner) {
      deleteBtn.classList.add('btn--danger');
      deleteBtn.title = 'Radera spellistan';
      if (labelEl) labelEl.textContent = 'Radera spellistan';
    } else {
      deleteBtn.classList.remove('btn--danger');
      deleteBtn.title = 'Ta bort från biblioteket';
      if (labelEl) labelEl.textContent = 'Ta bort från biblioteket';
    }
  }
}

/**
 * Returnerar true om inloggad användare är ägare till spellistan vi redigerar just nu.
 * Vi läser i första hand ownerId från state.meta (färskast, från /playlists/{id}) och faller
 * tillbaka till selectedEditPlaylist.ownerId (satt när användaren klickade raden i Välj playlist).
 * Vid helt okänt ägarskap eller okänt uid returnerar vi false — det är säkrare att visa den
 * neutrala "Ta bort från biblioteket"-etiketten än den destruktiva "Radera" för en följd lista.
 */
function isEditPlaylistOwnedByUser() {
  const ownerId =
    editPlaylistState?.meta?.ownerId ||
    selectedEditPlaylist?.ownerId ||
    '';
  if (!ownerId) return false;
  const uid =
    typeof spotifyClient?.getCachedUserId === 'function' ? spotifyClient.getCachedUserId() : null;
  if (!uid) return false;
  return String(ownerId) === String(uid);
}

function destroyEditPlaylistSortable() {
  try {
    editPlaylistSortable?.destroy();
  } catch {
    /* ignore */
  }
  editPlaylistSortable = null;
}

function isEditPlaylistDirty() {
  const s = editPlaylistState;
  if (!s) return false;
  if (s.pendingRemovals.size > 0) return true;
  if (s.workingOrder.length !== s.original.length) return true;
  for (let i = 0; i < s.workingOrder.length; i += 1) {
    if (s.workingOrder[i] !== s.original[i].uri) return true;
  }
  return false;
}

function updateEditPlaylistDirtyUi() {
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-edit-playlist-apply'));
  /** "Det finns ändringar"-rubrik + hjälptext ligger i ett gemensamt block ovanför
   *  tracklistan. Rubriken gör det extra tydligt att det finns osparat arbete. */
  const dirtyBlock = document.getElementById('edit-playlist-dirty-block');
  const dirty = isEditPlaylistDirty();
  if (btn) {
    btn.disabled = !dirty;
    btn.setAttribute('aria-disabled', dirty ? 'false' : 'true');
  }
  if (dirtyBlock) dirtyBlock.hidden = !dirty;
}

function updateEditPlaylistBulkBar() {
  const bar = document.getElementById('edit-playlist-bulk-bar');
  const countEl = document.getElementById('edit-playlist-bulk-count');
  const state = editPlaylistState;
  const count = state ? state.selection.size : 0;
  if (bar) bar.hidden = count === 0;
  if (countEl) countEl.textContent = `${count} markerade`;
}

function renderEditPlaylistTracks() {
  const listEl = document.getElementById('edit-playlist-list');
  const emptyEl = document.getElementById('edit-playlist-empty');
  if (!listEl || !emptyEl) return;
  const state = editPlaylistState;
  if (!state) {
    listEl.replaceChildren();
    emptyEl.hidden = true;
    return;
  }
  if (state.workingOrder.length === 0) {
    listEl.replaceChildren();
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  /** @type {Map<string, EditTrackRow>} */
  const byUri = new Map(state.original.map((r) => [r.uri, r]));
  const frag = document.createDocumentFragment();
  for (const uri of state.workingOrder) {
    const row = byUri.get(uri);
    if (!row) continue;
    frag.append(buildEditPlaylistTrackNode(row, state));
  }
  listEl.replaceChildren(frag);
}

/**
 * @param {EditTrackRow} row
 * @param {NonNullable<typeof editPlaylistState>} state
 */
function buildEditPlaylistTrackNode(row, state) {
  const li = document.createElement('li');
  li.className = 'edit-playlist-track';
  li.dataset.uri = row.uri;
  if (state.pendingRemovals.has(row.uri)) li.classList.add('edit-playlist-track--pending-remove');
  if (row.isLocal) li.classList.add('edit-playlist-track--local');
  if (row.isEpisode) li.classList.add('edit-playlist-track--episode');

  const drag = document.createElement('span');
  drag.className = 'edit-playlist-track__drag';
  drag.setAttribute('aria-label', 'Dra för att ändra ordning');
  drag.title = 'Dra för att ändra ordning';
  drag.innerHTML = '<svg width="18" height="18" aria-hidden="true"><use href="#sym-grip" /></svg>';
  if (row.isLocal) {
    drag.setAttribute('aria-disabled', 'true');
    drag.title = 'Lokala filer kan inte flyttas via Spotify Web API';
  }
  li.append(drag);

  const cbWrap = document.createElement('span');
  cbWrap.className = 'edit-playlist-track__checkbox-wrap';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'edit-playlist-track__checkbox';
  cb.checked = state.selection.has(row.uri);
  cb.setAttribute('aria-label', `Markera ${row.name}`);
  cb.addEventListener('change', () => {
    if (cb.checked) state.selection.add(row.uri);
    else state.selection.delete(row.uri);
    updateEditPlaylistBulkBar();
  });
  cbWrap.append(cb);
  li.append(cbWrap);

  if (row.albumImageUrl) {
    const img = document.createElement('img');
    img.className = 'edit-playlist-track__art';
    img.src = row.albumImageUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener(
      'error',
      () => {
        const fb = document.createElement('span');
        fb.className = 'edit-playlist-track__art-fallback';
        fb.innerHTML = '<svg aria-hidden="true"><use href="#sym-note" /></svg>';
        img.replaceWith(fb);
      },
      { once: true },
    );
    li.append(img);
  } else {
    const fb = document.createElement('span');
    fb.className = 'edit-playlist-track__art-fallback';
    fb.innerHTML = '<svg aria-hidden="true"><use href="#sym-note" /></svg>';
    li.append(fb);
  }

  const body = document.createElement('div');
  body.className = 'edit-playlist-track__body';
  const nameEl = document.createElement('span');
  nameEl.className = 'edit-playlist-track__name';
  nameEl.textContent = row.name || '(utan namn)';
  const artistEl = document.createElement('span');
  artistEl.className = 'edit-playlist-track__artist';
  artistEl.textContent = row.artists.join(', ') || (row.isEpisode ? 'Podcast-avsnitt' : row.isLocal ? 'Lokal fil' : '—');
  body.append(nameEl, artistEl);
  li.append(body);

  return li;
}

function initEditPlaylistSortable() {
  destroyEditPlaylistSortable();
  const listEl = document.getElementById('edit-playlist-list');
  const Sortable = /** @type {any} */ (window).Sortable;
  if (!listEl || !Sortable) return;
  editPlaylistSortable = new Sortable(listEl, {
    handle: '.edit-playlist-track__drag',
    animation: 140,
    forceFallback: true,
    fallbackOnBody: true,
    ghostClass: 'edit-playlist-track--ghost',
    chosenClass: 'edit-playlist-track--chosen',
    dragClass: 'edit-playlist-track--dragging',
    filter: '[aria-disabled="true"]',
    preventOnFilter: true,
    onEnd: onEditPlaylistSortableEnd,
  });
}

function onEditPlaylistSortableEnd(evt) {
  const state = editPlaylistState;
  if (!state) return;
  const oldIndex = Number(evt?.oldIndex);
  const newIndex = Number(evt?.newIndex);
  if (!Number.isFinite(oldIndex) || !Number.isFinite(newIndex) || oldIndex === newIndex) return;
  const next = state.workingOrder.slice();
  const [moved] = next.splice(oldIndex, 1);
  if (!moved) return;
  next.splice(newIndex, 0, moved);
  state.workingOrder = next;
  updateEditPlaylistDirtyUi();
  renderEditPlaylistHeader();
}

function handleEditPlaylistSelectAllVisible() {
  const state = editPlaylistState;
  if (!state) return;
  for (const uri of state.workingOrder) {
    if (!state.pendingRemovals.has(uri)) state.selection.add(uri);
  }
  /* Uppdatera bara kryssrutorna i DOM, slipper full re-render. */
  const listEl = document.getElementById('edit-playlist-list');
  if (listEl) {
    for (const li of listEl.querySelectorAll('li[data-uri]')) {
      const cb = /** @type {HTMLInputElement | null} */ (li.querySelector('.edit-playlist-track__checkbox'));
      if (cb) cb.checked = state.selection.has(li.getAttribute('data-uri') ?? '');
    }
  }
  updateEditPlaylistBulkBar();
}

function handleEditPlaylistClearSelection() {
  const state = editPlaylistState;
  if (!state) return;
  state.selection.clear();
  const listEl = document.getElementById('edit-playlist-list');
  if (listEl) {
    for (const cb of listEl.querySelectorAll('.edit-playlist-track__checkbox')) {
      /** @type {HTMLInputElement} */ (cb).checked = false;
    }
  }
  updateEditPlaylistBulkBar();
}

function handleEditPlaylistBulkRemove() {
  const state = editPlaylistState;
  if (!state || state.selection.size === 0) return;
  /** Lägg urvalet i pendingRemovals — men ta bort dem från workingOrder OCH selection
   *  så listan inte visar dubbletter och "markerade"-räknaren nollställs. */
  for (const uri of state.selection) {
    state.pendingRemovals.add(uri);
  }
  state.workingOrder = state.workingOrder.filter((u) => !state.pendingRemovals.has(u));
  state.selection.clear();
  renderEditPlaylistTracks();
  renderEditPlaylistHeader();
  updateEditPlaylistBulkBar();
  updateEditPlaylistDirtyUi();
}

async function handleEditPlaylistBulkCopyAsText() {
  const state = editPlaylistState;
  if (!state || state.selection.size === 0) return;
  /** @type {Map<string, EditTrackRow>} */
  const byUri = new Map(state.original.map((r) => [r.uri, r]));
  const lines = [];
  /* Använd listans nuvarande ordning för att ge naturligt klistrings-resultat. */
  for (const uri of state.workingOrder) {
    if (!state.selection.has(uri)) continue;
    const row = byUri.get(uri);
    if (!row) continue;
    const artist = (row.artists || []).map((a) => a.trim()).filter(Boolean).join(', ');
    const title = (row.name || '').trim();
    /* parseTrackList tolkar "Artist - Title"; hoppa rader utan minst en sida så vi inte
     * klistrar in tomma "—". Lokala filer/episod utan artist → "(Lokal fil) - Title". */
    if (!artist && !title) continue;
    const left = artist || (row.isEpisode ? 'Podcast' : row.isLocal ? 'Lokal fil' : 'Okänd');
    const right = title || '(utan namn)';
    lines.push(`${left} - ${right}`);
  }
  if (lines.length === 0) {
    showToast('Inget att kopiera.', true);
    return;
  }
  const text = lines.join('\n');
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    /* clipboard-API kan vara blockerat i vissa mobila webbvyer — prova textarea-fallback. */
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
    } catch {
      ok = false;
    }
  }
  if (ok) showToast(`Kopierat ${lines.length} rader.`);
  else showToast('Kunde inte kopiera automatiskt.', true);
}

async function loadEditPlaylistTracks(opts = {}) {
  const { force = false, manual = false, quiet = false, reason = 'unknown' } = opts;
  if (!spotifyClient || !selectedEditPlaylist) {
    if (!quiet) showToast('Välj en spellista först.', true);
    return;
  }
  const playlistId = selectedEditPlaylist.id;

  const userIdKnown =
    typeof spotifyClient.getCachedUserId === 'function' ? spotifyClient.getCachedUserId() : null;

  /* Read-only-läge: äger användaren inte listan så slipper vi både getPlaylistMeta och
   * getPlaylistTracksAll (det senare ger ändå 403 för Spotifys algoritmiska listor).
   * Kvar blir bara "Ta bort från biblioteket". Headern renderas från selectedEditPlaylist
   * som redan har namn, ägare och omslag. */
  if (isEditPlaylistReadOnlyUpfront()) {
    setEditPlaylistReadOnly(true);
    setEditPlaylistBlocked(false);
    renderEditPlaylistHeader();
    logSpotify({
      t: new Date().toISOString(),
      kind: 'ui',
      phase: 'refreshEditPlaylist',
      reason: `edit-playlist/${reason}`,
      playlistId,
      readOnly: true,
      skipped: ['getPlaylistMeta', 'getPlaylistTracksAll'],
      manual,
      force,
    });
    return;
  }
  setEditPlaylistReadOnly(false);

  /* In-memory → annars IDB. Rendera direkt om vi hittar något så användaren ser listan
   * medan nätverket hämtar färsk data. */
  if (!force && editPlaylistState?.playlistId === playlistId) {
    const ageMs = Date.now() - editPlaylistState.at;
    if (ageMs < PLAYLIST_TRACKS_CACHE_TTL_MS) {
      renderEditPlaylistHeader();
      renderEditPlaylistTracks();
      updateEditPlaylistTruncatedWarning(editPlaylistState.truncated);
      updateEditPlaylistUpdatedAt(editPlaylistState.at, /* stale */ false);
      setEditPlaylistSpinnerVisible(false);
      updateEditPlaylistDirtyUi();
      return;
    }
  }
  if (!editPlaylistState || editPlaylistState.playlistId !== playlistId) {
    if (userIdKnown) {
      const persisted = await readPlaylistTracksCache(userIdKnown, playlistId);
      if (persisted) {
        editPlaylistState = {
          playlistId,
          meta: {
            id: playlistId,
            name: selectedEditPlaylist.name,
            description: '',
            ownerId: selectedEditPlaylist.ownerId ?? '',
            ownerName: selectedEditPlaylist.ownerName ?? '',
            imageUrl: selectedEditPlaylist.imageUrl ?? null,
            snapshotId: persisted.snapshotId ?? '',
            total: persisted.total,
            isPublic: false,
            collaborative: false,
          },
          original: persisted.tracks.map((r) => ({ ...r })),
          workingOrder: persisted.tracks.map((r) => r.uri),
          pendingRemovals: new Set(),
          selection: new Set(),
          snapshotId: persisted.snapshotId ?? '',
          at: persisted.at,
          truncated: persisted.truncated,
          userId: userIdKnown,
        };
        renderEditPlaylistHeader();
        renderEditPlaylistTracks();
        updateEditPlaylistTruncatedWarning(persisted.truncated);
        updateEditPlaylistUpdatedAt(persisted.at, /* stale */ false);
        setEditPlaylistSpinnerVisible(false);
        updateEditPlaylistDirtyUi();
      }
    }
  }

  logSpotify({
    t: new Date().toISOString(),
    kind: 'ui',
    phase: 'refreshEditPlaylist',
    reason: `edit-playlist/${reason}`,
    playlistId,
    cacheHit: Boolean(editPlaylistState?.playlistId === playlistId && !force),
    inFlight: Boolean(editPlaylistTracksInFlight),
    manual,
    force,
  });

  if (editPlaylistTracksInFlight) return editPlaylistTracksInFlight;

  const ac = new AbortController();
  editPlaylistTracksAbort = ac;
  const { signal } = ac;
  setEditPlaylistSpinnerVisible(!(editPlaylistState?.playlistId === playlistId));
  const job = (async () => {
    try {
      const [meta, tracksResult] = await Promise.all([
        spotifyClient.getPlaylistMeta(playlistId, signal),
        spotifyClient.getPlaylistTracksAll(playlistId, signal),
      ]);
      const uid =
        userIdKnown ??
        (typeof spotifyClient.getCachedUserId === 'function' ? spotifyClient.getCachedUserId() : null) ??
        '';
      const nowAt = Date.now();
      /* Om användaren hunnit ändra lokalt (dirty) sparar vi workingOrder/pendingRemovals.
       * Annars skapar vi en helt ny state från färskt svar. */
      const prev = editPlaylistState;
      const dirty = prev?.playlistId === playlistId && isEditPlaylistDirty();
      /** @type {NonNullable<typeof editPlaylistState>} */
      const next = {
        playlistId,
        meta,
        original: tracksResult.tracks.map((r) => ({ ...r })),
        workingOrder: dirty && prev ? prev.workingOrder.slice() : tracksResult.tracks.map((r) => r.uri),
        pendingRemovals: dirty && prev ? new Set(prev.pendingRemovals) : new Set(),
        selection: dirty && prev ? new Set(prev.selection) : new Set(),
        snapshotId: meta.snapshotId || tracksResult.snapshotId || '',
        at: nowAt,
        truncated: tracksResult.truncated,
        userId: uid,
      };
      editPlaylistState = next;
      if (uid) {
        void writePlaylistTracksCache(uid, playlistId, {
          tracks: next.original,
          truncated: next.truncated,
          snapshotId: next.snapshotId,
          total: meta.total,
        });
      }
      /* Håll selectedEditPlaylist uppdaterad med senaste imageUrl/ownerName från meta. */
      if (selectedEditPlaylist && selectedEditPlaylist.id === playlistId) {
        selectedEditPlaylist = {
          id: playlistId,
          name: meta.name || selectedEditPlaylist.name,
          ownerId: meta.ownerId || selectedEditPlaylist.ownerId || '',
          ownerName: meta.ownerName || selectedEditPlaylist.ownerName,
          imageUrl: meta.imageUrl ?? selectedEditPlaylist.imageUrl,
        };
        writeStoredSelectedEditPlaylist(selectedEditPlaylist);
      }
      renderEditPlaylistHeader();
      renderEditPlaylistTracks();
      updateEditPlaylistTruncatedWarning(next.truncated);
      updateEditPlaylistUpdatedAt(next.at, /* stale */ false);
      updateEditPlaylistDirtyUi();
      updateEditPlaylistBulkBar();
      initEditPlaylistSortable();
      if (manual && !quiet) {
        showToast(`${next.workingOrder.length} spår hämtade.`);
      }
    } catch (e) {
      if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      /** Spotifys 403 på /playlists/{id}/items = algoritmisk/editorial spellista som tredjepartsappar
       *  inte längre får läsa (Nov 2024-policyn). Vi visar en dedikerad banner i stället för bara
       *  en röd toast så användaren förstår att felet är permanent för listan. */
      const msg = String(e?.message ?? e);
      const isForbidden = /\b403\b/.test(msg) || /Forbidden/i.test(msg);
      if (isForbidden) {
        setEditPlaylistBlocked(true);
        return;
      }
      const fellBack = Boolean(editPlaylistState?.playlistId === playlistId);
      if (fellBack) {
        const ageMs = Date.now() - editPlaylistState.at;
        updateEditPlaylistUpdatedAt(editPlaylistState.at, ageMs < PLAYLIST_TRACKS_STALE_IF_ERROR_MS);
      }
      if (!quiet) {
        showToast(
          fellBack
            ? 'Kunde inte uppdatera spåren just nu — visar senast kända lista.'
            : msg,
          true,
        );
      }
      throw e;
    } finally {
      setEditPlaylistSpinnerVisible(false);
      if (editPlaylistTracksAbort === ac) editPlaylistTracksAbort = null;
      editPlaylistTracksInFlight = null;
    }
  })();
  editPlaylistTracksInFlight = job;
  return job;
}

/* --------------------------------------------------------------------------
 * Genomför på Spotify — diff + pacing + progress.
 * computeIncrementalOps räknar ut minimala skrivningar (DELETE batchar + PUT move).
 * commitEdits exekverar dem med paus mellan varje steg.
 * -------------------------------------------------------------------------- */

/**
 * @param {EditTrackRow[]} original
 * @param {string[]} workingOrder
 * @param {Set<string>} pendingRemovals
 */
function computeIncrementalOps(original, workingOrder, pendingRemovals) {
  /** Först: bygg DELETE-batcher med exakt positions[] enligt originalListan (Spotify kräver detta
   *  för att hantera dubbletter korrekt). Gruppera per unik uri; sedan batcha uri-grupper om
   *  upp till `EDIT_REMOVE_BATCH_SIZE`. */
  /** @type {Map<string, number[]>} */
  const posByUri = new Map();
  original.forEach((row, idx) => {
    if (!pendingRemovals.has(row.uri)) return;
    const arr = posByUri.get(row.uri);
    if (arr) arr.push(idx);
    else posByUri.set(row.uri, [idx]);
  });
  /** @type {{ uri: string, positions: number[] }[][]} */
  const removeBatches = [];
  /** @type {{ uri: string, positions: number[] }[]} */
  let cur = [];
  for (const [uri, positions] of posByUri.entries()) {
    cur.push({ uri, positions });
    if (cur.length >= EDIT_REMOVE_BATCH_SIZE) {
      removeBatches.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) removeBatches.push(cur);

  /** Bygg target-ordningen (efter removes) och simulera den steg-för-steg för att producera
   *  minsta möjliga PUT /tracks-reorder-kedja. Greedy: gå från vänster till höger och flytta
   *  det första felplacerade itemet till korrekt plats. O(n²) worst case men n ≤ 4000. */
  const targetSeq = workingOrder.filter((u) => !pendingRemovals.has(u));
  const currentSeq = original.map((r) => r.uri).filter((u) => !pendingRemovals.has(u));
  /** @type {{ rangeStart: number, insertBefore: number, rangeLength: number }[]} */
  const moves = [];
  for (let i = 0; i < targetSeq.length; i += 1) {
    if (currentSeq[i] === targetSeq[i]) continue;
    /** Hitta target[i] i current från position i och framåt; om ej hittad (udda fall — dubbletter),
     *  ta första träffen från början av listan. */
    let from = -1;
    for (let j = i; j < currentSeq.length; j += 1) {
      if (currentSeq[j] === targetSeq[i]) {
        from = j;
        break;
      }
    }
    if (from < 0) {
      for (let j = 0; j < currentSeq.length; j += 1) {
        if (currentSeq[j] === targetSeq[i]) {
          from = j;
          break;
        }
      }
    }
    if (from < 0 || from === i) continue;
    /** Spotifys semantik: insert_before tas *innan* flytten händer. För att flytta ett item
     *  bakifrån till position `i` använder vi insert_before = i (giltigt när from > i). */
    moves.push({ rangeStart: from, insertBefore: i, rangeLength: 1 });
    /** Simulera flytten i current-listan. */
    const [moved] = currentSeq.splice(from, 1);
    currentSeq.splice(i, 0, moved);
  }
  return { removeBatches, moves };
}

function setEditPlaylistProgress(visible, text, ratio) {
  const wrap = document.getElementById('edit-playlist-progress');
  const label = document.getElementById('edit-playlist-progress-label');
  const fill = document.getElementById('edit-playlist-progress-fill');
  if (!wrap || !label || !fill) return;
  wrap.hidden = !visible;
  if (!visible) return;
  if (text) label.textContent = text;
  const pct = Math.max(0, Math.min(100, Math.round((ratio ?? 0) * 100)));
  fill.style.width = `${pct}%`;
}

async function confirmEditPlaylistHeavy() {
  const dlg = /** @type {HTMLDialogElement | null} */ (document.getElementById('edit-playlist-heavy-dialog'));
  if (!dlg || typeof dlg.showModal !== 'function') return true;
  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'confirm');
    };
    dlg.addEventListener('close', onClose);
    dlg.returnValue = 'cancel';
    try {
      dlg.showModal();
    } catch {
      dlg.removeEventListener('close', onClose);
      resolve(true);
    }
  });
}

async function commitEditPlaylistChanges() {
  const state = editPlaylistState;
  if (!state || !spotifyClient || !selectedEditPlaylist) return;
  if (!isEditPlaylistDirty()) {
    showToast('Inga ändringar att spara.');
    return;
  }
  const ops = computeIncrementalOps(state.original, state.workingOrder, state.pendingRemovals);
  const totalSteps = ops.removeBatches.length + ops.moves.length;
  if (totalSteps === 0) {
    showToast('Inga ändringar att spara.');
    return;
  }
  if (totalSteps >= EDIT_COMMIT_HEAVY_WARN_THRESHOLD) {
    const ok = await confirmEditPlaylistHeavy();
    if (!ok) return;
  }
  const ac = new AbortController();
  editPlaylistCommitAbort = ac;
  const { signal } = ac;
  const applyBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-edit-playlist-apply'));
  const deleteBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-edit-playlist-delete'));
  const refreshBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('edit-playlist-refresh'));
  if (applyBtn) applyBtn.disabled = true;
  if (deleteBtn) deleteBtn.disabled = true;
  if (refreshBtn) refreshBtn.disabled = true;

  let done = 0;
  let snapshotId = state.snapshotId || '';
  const expectedMsPerStep = EDIT_COMMIT_STEP_GAP_MS + EDIT_COMMIT_STEP_JITTER_MS / 2;
  const estimateRemainingText = () => {
    const remainingMs = (totalSteps - done) * expectedMsPerStep;
    const sec = Math.max(1, Math.ceil(remainingMs / 1000));
    return `Skickar ${Math.min(done + 1, totalSteps)} av ${totalSteps} — kvarstår ~${sec} sek`;
  };

  setEditPlaylistProgress(true, `Förbereder ${totalSteps} ändring(ar)…`, 0);
  try {
    /* 1) Först: DELETE-batcherna. De tar bort spår *från originalpositionerna* så moves blir
     *    meningsfulla mot den post-remove-listan vi räknade ut i computeIncrementalOps. */
    for (const batch of ops.removeBatches) {
      signal.throwIfAborted();
      setEditPlaylistProgress(true, estimateRemainingText(), done / totalSteps);
      const res = await spotifyClient.removePlaylistTracksBatch(
        selectedEditPlaylist.id,
        batch,
        snapshotId,
        { signal },
      );
      snapshotId = res.snapshotId || snapshotId;
      done += 1;
      setEditPlaylistProgress(true, estimateRemainingText(), done / totalSteps);
      if (done < totalSteps) {
        const gap = EDIT_COMMIT_STEP_GAP_MS + Math.floor(Math.random() * EDIT_COMMIT_STEP_JITTER_MS);
        await new Promise((r) => setTimeout(r, gap));
      }
    }
    /* 2) Sedan: flytt-operationerna (PUT /tracks). De räknas mot den nya, post-remove-listan. */
    for (const mv of ops.moves) {
      signal.throwIfAborted();
      setEditPlaylistProgress(true, estimateRemainingText(), done / totalSteps);
      const res = await spotifyClient.reorderPlaylistItem(
        selectedEditPlaylist.id,
        { ...mv, snapshotId },
        { signal },
      );
      snapshotId = res.snapshotId || snapshotId;
      done += 1;
      setEditPlaylistProgress(true, estimateRemainingText(), done / totalSteps);
      if (done < totalSteps) {
        const gap = EDIT_COMMIT_STEP_GAP_MS + Math.floor(Math.random() * EDIT_COMMIT_STEP_JITTER_MS);
        await new Promise((r) => setTimeout(r, gap));
      }
    }
    /* Färdigt — invalidera cachen, markera state:n som i-synk (snapshot), förhindra
     *  dubbelskrivningar, och nolla pendingRemovals. Hämta om listan för verifikation. */
    state.snapshotId = snapshotId;
    /* Uppdatera original till senaste kända post-commit-state så dirty-check ger false. */
    const keptUris = new Set(state.workingOrder);
    state.original = state.workingOrder
      .map((uri) => state.original.find((r) => r.uri === uri))
      .filter((r) => r && keptUris.has(r.uri));
    state.pendingRemovals = new Set();
    state.selection = new Set();
    if (state.userId) {
      void writePlaylistTracksCache(state.userId, selectedEditPlaylist.id, {
        tracks: state.original,
        truncated: state.truncated,
        snapshotId,
        total: state.original.length,
      });
    }
    /* Välj-listans cache påverkas (total-antal och cover-art bevaras) — invalidera så nästa
     *  visit hämtar om utan att bli blockerad av en stale färsk TTL. */
    invalidateSelectPlaylistCache({ persistent: false });
    renderEditPlaylistHeader();
    renderEditPlaylistTracks();
    updateEditPlaylistDirtyUi();
    updateEditPlaylistBulkBar();
    initEditPlaylistSortable();
    setEditPlaylistProgress(false, '', 1);
    showToast(`Klart! ${totalSteps} ändring(ar) sparade.`);
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
      setEditPlaylistProgress(false, '', 0);
      showToast('Avbrutet. Redan skickade ändringar finns kvar i Spotify.', true);
    } else {
      setEditPlaylistProgress(false, '', 0);
      showToast(String(e?.message ?? e), true);
    }
  } finally {
    if (editPlaylistCommitAbort === ac) editPlaylistCommitAbort = null;
    if (applyBtn) applyBtn.disabled = !isEditPlaylistDirty();
    if (deleteBtn) deleteBtn.disabled = false;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

/* --------------------------------------------------------------------------
 * Radera spellistan — bekräftelse-dialog + API-anrop + cache-invalidering.
 * -------------------------------------------------------------------------- */
async function deleteEditPlaylistFlow() {
  const state = editPlaylistState;
  const sel = selectedEditPlaylist;
  if (!spotifyClient || !sel) return;
  const dlg = /** @type {HTMLDialogElement | null} */ (document.getElementById('edit-playlist-delete-dialog'));
  const titleEl = document.getElementById('edit-playlist-delete-dialog-title');
  const textEl = document.getElementById('edit-playlist-delete-dialog-text');
  const nameEl = document.getElementById('edit-playlist-delete-dialog-name');
  const errEl = document.getElementById('edit-playlist-delete-dialog-error');
  const confirmBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-edit-playlist-delete-confirm'));
  const cancelBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-edit-playlist-delete-cancel'));
  if (!dlg || !nameEl) return;
  const playlistName = state?.meta?.name || sel.name || '(utan namn)';
  nameEl.textContent = playlistName;
  /** Anpassa dialog och bekräftelseknapp efter ägarskap. `isEditPlaylistOwnedByUser()` ger
   *  true om meta saknas för att vara safe — men här kallas den alltid efter att meta laddats. */
  const isOwner = isEditPlaylistOwnedByUser();
  if (titleEl) {
    titleEl.textContent = isOwner ? 'Ta bort spellistan?' : 'Ta bort från biblioteket?';
  }
  if (textEl) {
    /** Bygg om texten: "Du håller på att X spellistan <strong>Namn</strong>. Är du säker?" */
    textEl.textContent = '';
    textEl.append(
      document.createTextNode(
        isOwner
          ? 'Du håller på att ta bort spellistan '
          : 'Du håller på att ta bort spellistan från ditt bibliotek: ',
      ),
    );
    const strong = document.createElement('strong');
    strong.id = 'edit-playlist-delete-dialog-name';
    strong.textContent = playlistName;
    textEl.append(strong);
    textEl.append(document.createTextNode('. Är du säker?'));
  }
  if (confirmBtn) {
    confirmBtn.textContent = isOwner ? 'Ta bort' : 'Ta bort från bibliotek';
    confirmBtn.classList.toggle('btn--danger', isOwner);
  }
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = '';
  }
  if (typeof dlg.showModal !== 'function') {
    /* Extremt gammal browser — fallback: confirm(). */
    const confirmMsg = isOwner
      ? `Du håller på att ta bort spellistan '${sel.name}'. Är du säker?`
      : `Du håller på att ta bort spellistan '${sel.name}' från ditt bibliotek. Är du säker?`;
    const ok = window.confirm(confirmMsg);
    if (!ok) return;
    await performDeletePlaylist(sel, { isOwner });
    return;
  }
  dlg.returnValue = 'cancel';
  try {
    dlg.showModal();
  } catch {
    return;
  }
  /* Bekräfta via submit-event i stället för close-event, så att vi kan visa fel
   * utan att dialogen stängs. Vi hanterar stängning själva. */
  const form = /** @type {HTMLFormElement | null} */ (dlg.querySelector('form'));
  if (!form) return;

  const handler = async (ev) => {
    const submitter = /** @type {HTMLButtonElement | null} */ (ev.submitter);
    const confirmed = submitter?.value === 'confirm';
    if (!confirmed) return;
    ev.preventDefault();
    if (errEl) errEl.hidden = true;
    if (confirmBtn) confirmBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    try {
      await performDeletePlaylist(sel, { isOwner });
      form.removeEventListener('submit', handler);
      dlg.close('confirm');
    } catch (e) {
      if (errEl) {
        errEl.textContent = String(e?.message ?? e);
        errEl.hidden = false;
      }
    } finally {
      if (confirmBtn) confirmBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
    }
  };
  form.addEventListener('submit', handler);
  /* Städa lyssnaren om användaren stänger via ESC / avbryt-knapp. */
  dlg.addEventListener(
    'close',
    () => {
      form.removeEventListener('submit', handler);
    },
    { once: true },
  );
}

/**
 * Utför den faktiska borttagningen. Spotifys endpoint (DELETE /playlists/{id}/followers)
 * är samma oavsett ägarskap — men för ägaren "tas listan bort" medan för en följare
 * "slutar den följa". Vi skiljer bara på toast-texten.
 * @param {{ id: string, name?: string }} sel
 * @param {{ isOwner?: boolean }} [opts]
 */
async function performDeletePlaylist(sel, opts = {}) {
  const isOwner = opts.isOwner !== false;
  await spotifyClient.unfollowPlaylist(sel.id);
  const uid =
    typeof spotifyClient.getCachedUserId === 'function' ? spotifyClient.getCachedUserId() : null;
  if (uid) {
    void deletePlaylistTracksCache(uid, sel.id);
  }
  /* Plocka bort raden från Välj playlist-cachen istället för att invalidera hela cachen.
   * Resultat: inget extra GET /me/playlists-anrop när användaren navigeras tillbaka till
   * Välj playlist — cache-TTL:n (60 min) förlängs från nu. Vi vet ju exakt vad som
   * ändrats, så listan är korrekt utan omfetch. */
  removeFromSelectPlaylistCache(sel.id, uid);
  /* Nollställ edit-state och vald spellista så användaren inte landar i trasig vy vid tillbakanavigering. */
  editPlaylistState = null;
  destroyEditPlaylistSortable();
  selectedEditPlaylist = null;
  writeStoredSelectedEditPlaylist(null);
  setFlowStep('select-playlist', { focusPanel: true });
  showToast(isOwner ? 'Spellistan togs bort.' : 'Spellistan togs bort från ditt bibliotek.');
}

/* --------------------------------------------------------------------------
 * Wire + step-enter/exit-hooks.
 * -------------------------------------------------------------------------- */

function wireEditPlaylist() {
  const refresh = document.getElementById('edit-playlist-refresh');
  if (refresh) {
    refresh.addEventListener('click', () => {
      loadEditPlaylistTracks({ force: true, manual: true, reason: 'manual-refresh' }).catch(() => {});
    });
  }
  const deleteBtn = document.getElementById('btn-edit-playlist-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      deleteEditPlaylistFlow().catch((e) => showToast(String(e?.message ?? e), true));
    });
  }
  const selectAllBtn = document.getElementById('btn-edit-playlist-select-all');
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => handleEditPlaylistSelectAllVisible());
  }
  const clearSelBtn = document.getElementById('btn-edit-playlist-clear-selection');
  if (clearSelBtn) {
    clearSelBtn.addEventListener('click', () => handleEditPlaylistClearSelection());
  }
  const removeBtn = document.getElementById('btn-edit-playlist-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => handleEditPlaylistBulkRemove());
  }
  const copyBtn = document.getElementById('btn-edit-playlist-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      handleEditPlaylistBulkCopyAsText().catch((e) => showToast(String(e?.message ?? e), true));
    });
  }
  const applyBtn = document.getElementById('btn-edit-playlist-apply');
  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      commitEditPlaylistChanges().catch((e) => showToast(String(e?.message ?? e), true));
    });
  }
  const cancelProgress = document.getElementById('btn-edit-playlist-progress-cancel');
  if (cancelProgress) {
    cancelProgress.addEventListener('click', () => {
      try {
        editPlaylistCommitAbort?.abort();
      } catch {
        /* ignore */
      }
    });
  }
}

function exitEditPlaylistStep() {
  /* Avbryt ev. pågående fetch — men inte commit:en (den ska få köra klart). */
  try {
    editPlaylistTracksAbort?.abort();
  } catch {
    /* ignore */
  }
  destroyEditPlaylistSortable();
}

function enterEditPlaylistStep() {
  if (!selectedEditPlaylist) {
    selectedEditPlaylist = readStoredSelectedEditPlaylist();
  }
  if (!selectedEditPlaylist) {
    /* Ingen spellista vald — skicka användaren till val-vyn så hen kan välja en. */
    setFlowStep('select-playlist', { focusPanel: false });
    return;
  }
  /* Om state redan är laddad för denna spellista, rendera direkt. */
  if (editPlaylistState?.playlistId === selectedEditPlaylist.id) {
    renderEditPlaylistHeader();
    renderEditPlaylistTracks();
    updateEditPlaylistTruncatedWarning(editPlaylistState.truncated);
    updateEditPlaylistUpdatedAt(editPlaylistState.at, /* stale */ false);
    updateEditPlaylistDirtyUi();
    updateEditPlaylistBulkBar();
    initEditPlaylistSortable();
  } else {
    /* Nytt val: städa gammal state innan vi laddar ny spellista. */
    editPlaylistState = null;
    destroyEditPlaylistSortable();
    renderEditPlaylistHeader();
    renderEditPlaylistTracks();
    updateEditPlaylistDirtyUi();
    updateEditPlaylistBulkBar();
    setEditPlaylistSpinnerVisible(true);
  }
  /* Nollställ ev. "blocked"-banner från en tidigare spellista. */
  setEditPlaylistBlocked(false);
  /* Nollställ progressbaren — den kan hänga kvar om föregående commit avbröts på ett
   * sätt som inte körde finally-blocket (t.ex. navigering via brödsmulor). */
  setEditPlaylistProgress(false, '', 0);
  /* Applicera read-only-läget omedelbart om vi redan vet att användaren inte äger listan,
   * så vi slipper blinka fram redigerings-UI som genast döljs av loadEditPlaylistTracks. */
  setEditPlaylistReadOnly(isEditPlaylistReadOnlyUpfront());
  loadEditPlaylistTracks({ reason: 'step-enter', quiet: true }).catch(() => {
    /* Toast hanteras internt. */
  });
}

/** @param {number | undefined} ms */
function formatTrackDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** @param {object} track Spotify track-objekt från sökning */
function formatTrackTitleLine(track) {
  const artists = (track.artists || []).map((a) => a.name).join(', ');
  return `${track.name ?? ''} — ${artists}`;
}

/** Album + år på egen rad (utan parentes). */
function formatTrackMetaLine(track) {
  const album = track.album?.name ?? '';
  const rawDate = track.album?.release_date || '';
  const year = rawDate.length >= 4 ? rawDate.slice(0, 4) : '';
  return [album, year].filter(Boolean).join(', ');
}


function setSearchProgress(visible) {
  $('search-progress-wrap').hidden = !visible;
  $('results-summary').hidden = visible;
  if (!visible) {
    $('search-progress-line').textContent = '';
  }
}

function finalizeResultsSummary() {
  const n = resultRows.length;
  if (n === 0) {
    $('results-summary').textContent = '';
    return;
  }
  const matched = resultRows.filter((r) => r.tracks && r.tracks.length > 0).length;
  const pending = resultRows.some((r) => r.tracks === null);
  if (pending) {
    $('results-summary').textContent = `${n} sökningar. ${matched} har träff hittills, resten har inte sökts ännu.`;
  } else {
    $('results-summary').textContent = `${n} sökningar. ${matched} har minst en träff.`;
  }
}

function renderResults() {
  const blocks = $('results-body');
  blocks.replaceChildren();
  if (resultRows.length === 0) {
    if (FEATURE_ROW_FULL_PLAYBACK) void stopRowPlayback();
    $('results-section').hidden = true;
    $('results-summary').textContent = '';
    $('results-summary').hidden = false;
    $('search-progress-line').textContent = '';
    $('search-progress-wrap').hidden = true;
    updateApplyEnabled();
    refreshSummary();
    return;
  }
  $('results-section').hidden = false;
  blocks.classList.toggle('results-body--searching', searchInProgress);

  resultRows.forEach((row, idx) => {
    if (idx > 0) {
      const hrBetween = document.createElement('hr');
      hrBetween.className = 'results-list__rule results-list__rule--between';
      hrBetween.setAttribute('aria-hidden', 'true');
      blocks.append(hrBetween);
    }

    const article = document.createElement('article');
    article.className = 'match-block';
    article.dataset.rowIndex = String(idx);
    article.setAttribute('aria-label', `Sökning ${idx + 1}: ${row.query}`);

    const queryRow = document.createElement('div');
    queryRow.className = 'match-block__query-row';
    const queryEl = document.createElement('div');
    queryEl.className = 'match-block__query';
    queryEl.textContent = row.query;
    const pickCell = document.createElement('div');
    pickCell.className = 'match-block__pick';
    const switchLabel = document.createElement('label');
    switchLabel.className = 'row-switch';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    const hasHits = row.tracks !== null && row.tracks.length > 0;
    const included = row.includedInPlaylist !== false;
    chk.checked = hasHits && included;
    chk.disabled = !hasHits || searchInProgress;
    chk.dataset.rowIndex = String(idx);
    chk.classList.add('row-select');
    chk.setAttribute('aria-label', `Ta med sökning ${idx + 1} i spellistan`);
    const track = document.createElement('span');
    track.className = 'row-switch__track';
    track.setAttribute('aria-hidden', 'true');
    const mark = document.createElement('span');
    mark.className = 'row-switch__mark';
    const thumb = document.createElement('span');
    thumb.className = 'row-switch__thumb';
    track.append(mark, thumb);
    switchLabel.append(chk, track);
    pickCell.append(switchLabel);
    queryRow.classList.toggle('match-block__query-row--with-audio', hasHits && FEATURE_ROW_FULL_PLAYBACK);
    if (hasHits && FEATURE_ROW_FULL_PLAYBACK) {
      const previewWrap = document.createElement('div');
      previewWrap.className = 'match-block__preview';
      previewWrap.setAttribute('role', 'group');
      previewWrap.setAttribute('aria-label', 'Förhandslyssning för vald träff');

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'row-preview__btn row-preview__play';
      playBtn.setAttribute('aria-label', 'Spela');
      playBtn.innerHTML = '<svg width="14" height="14" aria-hidden="true"><use href="#sym-play" /></svg>';

      const scrub = document.createElement('div');
      scrub.className = 'row-preview__scrub';
      const range = document.createElement('input');
      range.type = 'range';
      range.className = 'row-preview__range';
      range.min = '0';
      range.max = '1';
      range.step = '0.001';
      range.value = '0';
      range.setAttribute('aria-label', 'Spola i uppspelning');
      scrub.append(range);

      previewWrap.append(playBtn, scrub);
      queryRow.append(queryEl, previewWrap, pickCell);
    } else {
      queryRow.append(queryEl, pickCell);
    }
    article.classList.toggle('match-block--excluded', hasHits && row.includedInPlaylist === false);
    chk.addEventListener('change', () => {
      row.includedInPlaylist = chk.checked;
      article.classList.toggle('match-block--excluded', hasHits && !chk.checked);
      touchPlaylistApplyPostSuccessDirty();
    });

    const hrUnder = document.createElement('hr');
    hrUnder.className = 'results-list__rule';
    hrUnder.setAttribute('aria-hidden', 'true');

    const optionsWrap = document.createElement('div');
    optionsWrap.className = 'match-block__options';

    if (row.tracks === null) {
      const wait = document.createElement('p');
      wait.className = 'match-block__status row-muted';
      wait.textContent = searchInProgress ? 'Söker…' : 'Klicka på Sök på Spotify för att fortsätta.';
      optionsWrap.append(wait);
    } else if (row.tracks.length === 0) {
      const none = document.createElement('p');
      none.className = 'match-block__status row-muted';
      none.textContent = 'Ingen träff hittades';
      optionsWrap.append(none);
    } else {
      const pickId = `pick-${idx}`;
      row.tracks.forEach((t, ti) => {
        const label = document.createElement('label');
        label.className = 'match-option';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = pickId;
        radio.value = t.uri;
        radio.checked = row.selectedUri === t.uri || (row.selectedUri === null && ti === 0);
        radio.disabled = searchInProgress;
        radio.addEventListener('change', () => {
          row.selectedUri = t.uri;
          notifyRowPlaybackTrackChanged(idx);
          touchPlaylistApplyPostSuccessDirty();
        });
        const main = document.createElement('div');
        main.className = 'match-option__main';
        const titleEl = document.createElement('div');
        titleEl.className = 'match-option__title';
        titleEl.textContent = formatTrackTitleLine(t);
        main.append(titleEl);
        const metaLine = formatTrackMetaLine(t);
        if (metaLine) {
          const metaEl = document.createElement('div');
          metaEl.className = 'match-option__meta';
          metaEl.textContent = metaLine;
          main.append(metaEl);
        }
        const durEl = document.createElement('div');
        durEl.className = 'match-option__dur';
        const durText = formatTrackDuration(t.duration_ms) || '–';
        durEl.textContent = durText;
        const sr = document.createElement('span');
        sr.className = 'visually-hidden';
        sr.textContent = ` Längd ${durText}.`;
        label.append(radio, main, durEl, sr);
        optionsWrap.append(label);
      });
      if (row.selectedUri === null && row.tracks[0]) row.selectedUri = row.tracks[0].uri;
    }

    article.append(queryRow, hrUnder, optionsWrap);
    blocks.append(article);
  });

  if (!searchInProgress) finalizeResultsSummary();
  updateApplyEnabled();
  refreshSummary();
  if (FEATURE_ROW_FULL_PLAYBACK) afterRenderRowPlayback();
}

function syncApplyHint() {
  const el = document.getElementById('apply-hint');
  if (!el) return;
  if (playlistApplyPostSuccess) {
    el.textContent = 'Spellistan är redan uppdaterad. Ändra låtar eller spellista i tidigare steg för att genomföra igen.';
    return;
  }
  if (!spotifyClient) {
    el.textContent = 'Du behöver logga in på Spotify innan du kan genomföra.';
    return;
  }
  if (resultRows.length === 0) {
    el.textContent = 'Du behöver först välja minst en låt under Välj musik.';
    return;
  }
  if (selectedUrisForPlaylist().length === 0) {
    el.textContent = 'Välj minst en låt under Välj musik innan du genomför.';
    return;
  }
  const mode = getPlaylistMode();
  if (mode === 'new') {
    if (!$('new-pl-name').value.trim()) {
      el.textContent = 'Ange ett namn på den nya spellistan innan du genomför.';
      return;
    }
    el.textContent = 'En ny spellista skapas på ditt Spotify-konto med ditt prefix och valda namn.';
    return;
  }
  const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
  if (src === 'from-list' && !$('existing-pl-select').value.trim()) {
    el.textContent = 'Välj en befintlig spellista under Välj spellista innan du genomför.';
    return;
  }
  if (src === 'from-link' && !parsePlaylistIdFromInput($('existing-pl-id').value)) {
    el.textContent = 'Ange en giltig Spotify-länk eller ett giltigt spellist-ID under Välj spellista innan du genomför.';
    return;
  }
  const um = document.querySelector('input[name="pl-update"]:checked')?.value ?? 'append';
  el.textContent =
    um === 'replace'
      ? 'Alla låtar i den valda spellistan ersätts med de låtar du har valt.'
      : 'De valda låtarna läggs till sist i den valda spellistan på Spotify.';
}

function isStep3ApplyReady() {
  if (!spotifyClient || resultRows.length === 0) return false;
  if (selectedUrisForPlaylist().length === 0) return false;
  const mode = getPlaylistMode();
  if (mode === 'new') {
    return $('new-pl-name').value.trim().length > 0;
  }
  const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
  if (src === 'from-list') return Boolean($('existing-pl-select').value.trim());
  return Boolean(parsePlaylistIdFromInput($('existing-pl-id').value));
}

/** Steg 2: tillåt ”Nästa: Genomför” när spelliste-val är komplett (namn / vald lista / giltig länk). */
function isStep2PlaylistConfigReady() {
  const mode = getPlaylistMode();
  if (mode === 'new') {
    return $('new-pl-name').value.trim().length > 0;
  }
  const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
  if (src === 'from-list') return Boolean($('existing-pl-select').value.trim());
  return Boolean(parsePlaylistIdFromInput($('existing-pl-id').value));
}

function updateStep2StickyNav() {
  const btn = document.getElementById('btn-flow-step-2-next');
  const hint = document.getElementById('flow-step-2-sticky-hint');
  if (!btn || !hint) return;
  const ready = isStep2PlaylistConfigReady();
  btn.disabled = !ready;
  btn.setAttribute('aria-disabled', ready ? 'false' : 'true');
  const mode = getPlaylistMode();
  if (mode === 'new') {
    hint.textContent = $('new-pl-name').value.trim()
      ? 'Du kan gå vidare och granska innan du genomför.'
      : 'Ange ett namn på den nya spellistan.';
    return;
  }
  const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
  if (src === 'from-list') {
    hint.textContent = $('existing-pl-select').value.trim()
      ? 'Du kan gå vidare och granska innan du genomför.'
      : 'Välj en spellista från listan.';
    return;
  }
  hint.textContent = parsePlaylistIdFromInput($('existing-pl-id').value)
    ? 'Du kan gå vidare och granska innan du genomför.'
    : 'Ange en giltig Spotify-länk eller ett giltigt spellist-ID.';
}

function updateStep1StickyNav() {
  const btn = document.getElementById('btn-flow-step-1-next');
  const hint = document.getElementById('flow-step-1-sticky-hint');
  if (!btn || !hint) return;

  const busy = searchInProgress;
  const pendingSearch = resultRows.some((r) => r.tracks === null);
  const ready =
    !busy &&
    resultRows.length > 0 &&
    !pendingSearch &&
    selectedUrisForPlaylist().length > 0;

  btn.disabled = !ready;
  btn.setAttribute('aria-disabled', ready ? 'false' : 'true');

  if (busy) {
    hint.textContent = 'Sökning pågår. Vänta tills alla rader är klara.';
  } else if (resultRows.length === 0) {
    hint.textContent = 'Klistra in en låtlista och sök på Spotify för att gå vidare.';
  } else if (pendingSearch) {
    hint.textContent = 'Vänta tills sökningen är klar.';
  } else if (selectedUrisForPlaylist().length === 0) {
    hint.textContent = 'Välj minst en låt för att gå vidare.';
  } else {
    hint.textContent = 'När du är nöjd med urvalet kan du gå vidare.';
  }
}

function updateApplyEnabled() {
  $('btn-apply-playlist').disabled = playlistApplyPostSuccess || !isStep3ApplyReady();
  const busy = searchInProgress;
  $('btn-search').disabled = !spotifyClient || busy;
  $('btn-clear-paste').disabled = busy;
  syncApplyHint();
  updateStep1StickyNav();
  updateStep2StickyNav();
}

function selectedUrisForPlaylist() {
  /** @type {string[]} */
  const uris = [];
  document.querySelectorAll('.row-select:checked').forEach((el) => {
    const idx = Number(el.dataset.rowIndex);
    const row = resultRows[idx];
    if (!row || !row.selectedUri) return;
    uris.push(row.selectedUri);
  });
  return uris;
}

async function runSearch() {
  if (!spotifyClient) {
    showToast('Du behöver logga in på Spotify först.', true);
    return;
  }
  if (searchInProgress) {
    showToast('En sökning pågår redan. Vänta eller klicka på Avbryt sökning.', true);
    return;
  }
  const parsed = parseTrackList($('paste-area').value);
  if (parsed.length === 0) {
    showToast('Det finns inga rader att söka på. Klistra in en låtlista först.', true);
    return;
  }
  if (FEATURE_ROW_FULL_PLAYBACK) void stopRowPlayback();
  touchPlaylistApplyPostSuccessDirty();
  resultRows = parsed.map((p) => ({ ...p, tracks: null, selectedUri: null, includedInPlaylist: true }));
  searchInProgress = true;
  searchAbortController = new AbortController();
  const signal = searchAbortController.signal;
  renderResults();
  setSearchProgress(true);
  /** Artist-bank (in-memory, per körning): artistnamn (lowercased) från tidigare träffar i denna batch.
   *  Seedas också från persistent IDB-bank (per user-id) så tidigare sessioners träffar hjälper
   *  suspectSwap-detektering. Används för att tvinga suspectSwap när en senare rads "title"-slot är
   *  en känd artist men dess "artist"-slot inte är det — typiskt fall: "Levitating - Dua Lipa"
   *  efter att vi sett Dua Lipa som artist. */
  /** @type {Set<string>} */
  const knownArtistsLc = new Set();
  /** Behåll en kopia av initialstorleken så vi kan logga hur mycket banken växte under körningen. */
  const artistBankUserId = spotifyClient?.getCachedUserId?.() ?? null;
  let persistentBankSeedSize = 0;
  if (artistBankUserId) {
    try {
      const persistent = await readArtistBank(artistBankUserId);
      if (persistent && Array.isArray(persistent.artists)) {
        for (const a of persistent.artists) knownArtistsLc.add(a);
        persistentBankSeedSize = knownArtistsLc.size;
        logSpotify({
          t: new Date().toISOString(),
          kind: 'ui',
          phase: 'runSearch',
          reason: 'artist-bank-seed',
          bankSize: persistentBankSeedSize,
        });
      }
    } catch {
      /* best-effort — körningen fortsätter utan seed */
    }
  }
  /** Junk-mönster som inte ska förorena artist-banken: karaoke, tribute, cover-band,
   *  "in the style of"-varianter. Samma tanke som precision-filtret i spotify-api.js —
   *  men replikerad här eftersom denna absorb-sida körs även på cache-hits (som redan
   *  passerat filtret vid första hämtningen) och det är en billig extra säkerhetslina. */
  const JUNK_TRACK_NAME_RE = /\b(karaoke|tribute to|originally performed|in the style of|instrumental only|performance track)\b/i;
  const JUNK_ARTIST_NAME_RE = /\b(karaoke|cover band)\b/i;

  /** @param {{ name?: string, artists?: { name?: string }[] }[] | null | undefined} tracks */
  const absorbArtistsFromTracks = (tracks) => {
    if (!Array.isArray(tracks)) return;
    for (const t of tracks) {
      if (t && typeof t.name === 'string' && JUNK_TRACK_NAME_RE.test(t.name)) continue;
      const arr = Array.isArray(t?.artists) ? t.artists : [];
      for (const a of arr) {
        const nm = (a?.name ?? '').trim().toLowerCase();
        if (nm.length < 2) continue;
        if (JUNK_ARTIST_NAME_RE.test(nm)) continue;
        knownArtistsLc.add(nm);
      }
    }
  };
  try {
    for (let i = 0; i < resultRows.length; i += 1) {
      if (signal.aborted) break;
      $('search-progress-line').textContent = `Söker rad ${i + 1} av ${resultRows.length} …`;
      const row = resultRows[i];

      /** Artist-bank-override: behåll freeTextOnly/suspectSwap; uppgradera bara 'normal' om datan pekar på swap. */
      let effectiveRowClass = row.rowClass;
      let artistBankHit = false;
      if (
        row.rowClass === 'normal' &&
        row.artist &&
        row.title &&
        knownArtistsLc.has(row.title.trim().toLowerCase()) &&
        !knownArtistsLc.has(row.artist.trim().toLowerCase())
      ) {
        effectiveRowClass = 'suspectSwap';
        artistBankHit = true;
      }
      if (artistBankHit) {
        logSpotify({
          t: new Date().toISOString(),
          kind: 'ui',
          phase: 'runSearch',
          reason: 'artist-bank-override',
          rowIndex: i + 1,
          parsedArtist: row.artist,
          parsedTitle: row.title,
          originalRowClass: row.rowClass,
          effectiveRowClass,
        });
      }

      const cacheKey = makeSearchCacheKey(row.query, row.artist, row.title);
      const cached = getSearchCache(cacheKey);
      /** Paus mellan rader ska bara följa efter Spotify-anrop — cache är lokalt och ska inte fördröja nästa rad */
      let rowFetchedFromSpotify = false;
      if (cached != null) {
        row.tracks = cached;
        absorbArtistsFromTracks(cached);
        logSpotify({
          t: new Date().toISOString(),
          endpoint: 'GET /v1/search',
          source: 'cache',
          q: row.query,
          itemsReturned: cached.length,
        });
      } else {
        rowFetchedFromSpotify = true;
        row.tracks = await spotifyClient.searchTracks(row.query, 5, {
          artist: row.artist,
          title: row.title,
          rowClass: effectiveRowClass,
          signal,
        });
        absorbArtistsFromTracks(row.tracks);
        if (!signal.aborted) setSearchCache(cacheKey, row.tracks);
      }
      if (signal.aborted) break;
      row.selectedUri = row.tracks[0]?.uri ?? null;
      renderResults();
      if (i < resultRows.length - 1 && rowFetchedFromSpotify) {
        await sleepAbortable(SEARCH_ROW_GAP_MS + Math.random() * SEARCH_ROW_JITTER_MS, signal);
      }
    }
  } catch (e) {
    if (!signal.aborted) {
      const msg = String(e?.message ?? e);
      showToast(msg, true);
      logSpotify({
        t: new Date().toISOString(),
        kind: 'client',
        phase: 'runSearch',
        message: msg,
        name: e?.name,
      });
    }
  } finally {
    searchInProgress = false;
    searchAbortController = null;
    setSearchProgress(false);
    renderResults();
    updateApplyEnabled();
    /** Persistera eventuella nya artister i bankens IDB-kopia — fire-and-forget, blockerar inte UI.
     *  Diff mot seed-storleken så vi inte skriver i onödan om inga nya namn dök upp. */
    if (artistBankUserId && knownArtistsLc.size > persistentBankSeedSize) {
      void addArtistsToBank(artistBankUserId, knownArtistsLc).then((added) => {
        if (added > 0) {
          logSpotify({
            t: new Date().toISOString(),
            kind: 'ui',
            phase: 'runSearch',
            reason: 'artist-bank-persist',
            addedCount: added,
            totalBatchSize: knownArtistsLc.size,
          });
        }
      });
    }
    if (signal.aborted) {
      const done = resultRows.filter((r) => r.tracks !== null).length;
      showToast(`Sökningen avbröts. ${done} av ${resultRows.length} rader hann sökas.`);
    }
    refreshSummary();
    /* Sökcachen och artist-banken har typiskt växt under körningen — uppdatera stats
     * i bakgrunden så raderna är rätt nästa gång användaren öppnar Inställningar. */
    void refreshSettingsStats();
  }
}

async function applyPlaylist() {
  if (!spotifyClient || !vaultData) {
    showToast('Inloggning saknas.', true);
    return;
  }
  const uris = selectedUrisForPlaylist();
  if (uris.length === 0) {
    showToast('Välj minst en låt.', true);
    return;
  }
  const mode = getPlaylistMode();
  if (mode === 'new' && !$('new-pl-name').value.trim()) {
    showToast('Ange ett namn på den nya spellistan.', true);
    return;
  }
  hidePlaylistResultDialog();
  hideStep3ApplyResultUi();
  $('btn-apply-playlist').disabled = true;
  suppressPlaylistApplyDirty = true;
  try {
    if (mode === 'new') {
      const suffix = $('new-pl-name').value.trim();
      const name = `${getPlaylistPrefixFromInput()}${suffix}`;
      const visibility = $('new-pl-visibility').value;
      const isPublic = visibility === 'public';
      const collaborative = visibility === 'collaborative';
      const gs = (vaultData.tokens?.grantedScopeRaw || '').trim();
      if (gs) {
        const hasPub = gs.includes('playlist-modify-public');
        const hasPriv = gs.includes('playlist-modify-private');
        if (isPublic && !hasPub) {
          showToast(
            'Din token saknar behörighet att skapa publika spellistor. Välj Privat eller Samarbete, eller logga in igen med rätt behörigheter.',
            true,
          );
          return;
        }
        if (!isPublic && !hasPriv) {
          showToast(
            'Din token saknar behörighet att skapa privata spellistor. Logga in igen med rätt behörigheter.',
            true,
          );
          return;
        }
      }
      const descRaw = $('new-pl-description').value;
      const description = (typeof descRaw === 'string' ? descRaw.trim() : '') || DEFAULT_PLAYLIST_DESCRIPTION;
      const pl = await spotifyClient.createPlaylist({ name, isPublic, collaborative, description });
      for (let i = 0; i < uris.length; i += SPOTIFY_CHUNK) {
        await spotifyClient.appendPlaylistTracks(pl.id, uris.slice(i, i + SPOTIFY_CHUNK));
      }
      const openUrl =
        typeof pl.external_urls?.spotify === 'string' && pl.external_urls.spotify.trim()
          ? pl.external_urls.spotify.trim()
          : undefined;
      showStep3PlaylistApplyResult({
        ok: true,
        title: 'Klart',
        message: `Spellistan ”${pl.name}” skapades med ${uris.length} låtar på Spotify.`,
        playlistId: pl.id,
        playlistName: typeof pl.name === 'string' ? pl.name : suffix,
        playlistOpenUrl: openUrl,
      });
      await refreshExistingPlaylistSelect({ quiet: true, selectPlaylistId: pl.id, force: true, reason: 'post-create' }).catch(() => {});
    } else {
      const source =
        document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
      let plId = null;
      if (source === 'from-list') {
        plId = $('existing-pl-select').value.trim();
        if (!plId) {
          showToast('Välj en spellista från listan.', true);
          return;
        }
      } else {
        const rawId = $('existing-pl-id').value;
        plId = parsePlaylistIdFromInput(rawId);
        if (!plId) {
          showToast('Ogiltigt spellist-ID.', true);
          return;
        }
      }
      const updateMode = document.querySelector('input[name="pl-update"]:checked')?.value;
      if (updateMode === 'replace' && uris.length > SPOTIFY_CHUNK) {
        showToast(`Läget Ersätt stöder högst ${SPOTIFY_CHUNK} låtar åt gången.`, true);
        return;
      }
      if (updateMode === 'replace') {
        await spotifyClient.replacePlaylistTracks(plId, uris);
      } else {
        for (let i = 0; i < uris.length; i += SPOTIFY_CHUNK) {
          await spotifyClient.appendPlaylistTracks(plId, uris.slice(i, i + SPOTIFY_CHUNK));
        }
      }
      const plLabel =
        source === 'from-list'
          ? ($('existing-pl-select').selectedOptions[0]?.textContent ?? plId)
          : plId;
      showStep3PlaylistApplyResult({
        ok: true,
        title: 'Klart',
        message:
          updateMode === 'replace'
            ? `Spellistan är uppdaterad. Tidigare låtar ersattes med ${uris.length} valda låtar.`
            : `${uris.length} låtar lades till i spellistan på Spotify.`,
        playlistId: plId,
        playlistName: typeof plLabel === 'string' ? plLabel : undefined,
      });
    }
  } catch (e) {
    showStep3PlaylistApplyResult({
      ok: false,
      title: 'Något gick fel',
      message: String(e?.message ?? e),
    });
  } finally {
    suppressPlaylistApplyDirty = false;
    refreshSummary();
  }
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const url = new URL('sw.js', window.location.href);
    await navigator.serviceWorker.register(url.href, { scope: new URL('./', window.location.href).href });
  } catch {
    /* tyst: lokalt file:// eller blockerad SW */
  }
}

/**
 * App-splash: visas som helskärms-overlay (CSS) direkt när DOM renderas och
 * fadas ut efter en kort stund så användaren ser en lugn startbild innan appen
 * tar över. Minsta synliga tid är ~1,5 s; transitionen läggs till ~0,45 s så
 * total tid är innanför användarens "1–3 sekunder". Respekterar
 * prefers-reduced-motion (ingen fade, bara klipp bort).
 */
function initAppSplash() {
  const splash = document.getElementById('app-splash');
  if (!splash) return;
  const MIN_VISIBLE_MS = 1500;
  const FADE_MS = 600;
  const remove = () => {
    if (splash.isConnected) splash.remove();
  };
  setTimeout(() => {
    splash.classList.add('is-leaving');
    /* transitionend triggar när opacity har nått 0 — fallback om eventet
     * aldrig kommer (t.ex. reduced-motion eller layout-glitch). */
    let removed = false;
    const onEnd = () => {
      if (removed) return;
      removed = true;
      remove();
    };
    splash.addEventListener('transitionend', onEnd, { once: true });
    setTimeout(onEnd, FADE_MS + 200);
  }, MIN_VISIBLE_MS);
}

async function boot() {
  initAppSplash();
  $('redirect-uri-display').textContent = getRedirectUri();

  /* Återställ icke-känsliga inställningar från localStorage innan OAuth/return-flödet
   * körs, så att t.ex. Client ID finns på plats om vi kommer tillbaka från Spotify. */
  hydrateLocalSettingsIntoUI();

  const logPre = $('spotify-log-pre');
  subscribeSpotifyLog((line) => {
    if (line === null) {
      logPre.textContent = '';
      return;
    }
    logPre.textContent = logPre.textContent ? `${logPre.textContent}\n${line}` : line;
    logPre.scrollTop = logPre.scrollHeight;
  });
  $('btn-clear-spotify-log').addEventListener('click', () => {
    clearSpotifyLog();
  });

  $('btn-clear-search-cache').addEventListener('click', () => {
    clearSearchCache();
    showToast('Sökcachen är rensad.');
    void refreshSettingsStats();
  });

  $('btn-clear-artist-bank').addEventListener('click', async () => {
    const uid = spotifyClient?.getCachedUserId?.() ?? null;
    if (!uid) {
      showToast('Du behöver vara inloggad för att rensa artist-banken.', true);
      return;
    }
    await deleteArtistBank(uid);
    showToast('Artist-banken är rensad. Nästa sökning börjar bygga upp den igen.');
    logSpotify({
      t: new Date().toISOString(),
      kind: 'ui',
      phase: 'artistBank',
      reason: 'manual-clear',
    });
    void refreshSettingsStats();
  });

  $('btn-abort-search').addEventListener('click', () => {
    if (FEATURE_ROW_FULL_PLAYBACK) void stopRowPlayback();
    searchAbortController?.abort();
  });

  window.addEventListener('bjorklund-spotify-wait', (ev) => {
    if (!searchInProgress) return;
    const d = /** @type {CustomEvent} */ (ev).detail;
    if (!d || typeof d.waitSec !== 'number') return;
    const line = $('search-progress-line');
    const base = line.textContent?.replace(/\s*—.*$/, '') ?? '';
    line.textContent = `${base} — Spotify har pausat vidare anrop. Försöker igen om ${d.waitSec} sekunder (försök ${d.attempt}/${d.maxAttempts}).`;
  });

  /** Nedräkning under API-loggen vid lång Retry-After (429), styrs från spotify-api.js */
  let retryAfterCountdownTimer = /** @type {ReturnType<typeof setInterval> | null} */ (null);
  function clearRetryAfterCountdown() {
    if (retryAfterCountdownTimer != null) {
      clearInterval(retryAfterCountdownTimer);
      retryAfterCountdownTimer = null;
    }
    const wrap = $('rate-limit-countdown-wrap');
    const text = $('rate-limit-countdown-text');
    wrap.hidden = true;
    text.textContent = '';
  }
  window.addEventListener('bjorklund-retry-after-countdown', (ev) => {
    const d = /** @type {CustomEvent} */ (ev).detail;
    if (!d || d.mode === 'clear') {
      clearRetryAfterCountdown();
      return;
    }
    if (d.mode !== 'start' || typeof d.endAt !== 'number') return;
    clearRetryAfterCountdown();
    const wrap = $('rate-limit-countdown-wrap');
    const text = $('rate-limit-countdown-text');
    wrap.hidden = false;
    const tick = () => {
      const leftMs = d.endAt - Date.now();
      if (leftMs <= 0) {
        clearRetryAfterCountdown();
        return;
      }
      const leftSec = Math.max(1, Math.ceil(leftMs / 1000));
      text.textContent = `Spotify har pausat vidare anrop. Försöker igen om ${leftSec} sekunder.`;
    };
    tick();
    retryAfterCountdownTimer = setInterval(tick, 1000);
  });

  $('btn-copy-redirect').addEventListener('click', async () => {
    const text = getRedirectUri();
    $('redirect-uri-display').textContent = text;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Omdirigerings-URI:n är kopierad. Klistra in den under Redirect URIs i Spotify Dashboard.');
    } catch {
      showToast('Kunde inte kopiera automatiskt. Markera URI-adressen manuellt.', true);
    }
  });

  wireFlow();
  wirePlaylistMode();
  wireSelectPlaylist();
  wireEditPlaylist();
  if (FEATURE_ROW_FULL_PLAYBACK) {
    bindRowPlaybackControls($('results-body'), {
      getRows: () => resultRows,
      showMessage: (text, isError) => showToast(text, Boolean(isError)),
      getSpotifyClient: () => spotifyClient,
      getIsSearching: () => searchInProgress,
      getAccessToken: async () => {
        const c = spotifyClient;
        if (!c || typeof c.getAccessToken !== 'function') throw new Error('Inte inloggad');
        return c.getAccessToken();
      },
    });
  }
  $('new-pl-name').addEventListener('input', () => {
    updateNewPlaylistPreview();
    touchPlaylistApplyPostSuccessDirty();
  });
  $('new-pl-visibility').addEventListener('change', () => touchPlaylistApplyPostSuccessDirty());
  $('new-pl-description').addEventListener('input', () => touchPlaylistApplyPostSuccessDirty());
  $('existing-pl-id').addEventListener('input', () => touchPlaylistApplyPostSuccessDirty());
  $('existing-pl-select').addEventListener('change', () => touchPlaylistApplyPostSuccessDirty());
  $('paste-area').addEventListener('input', () => touchPlaylistApplyPostSuccessDirty());
  $('playlist-prefix').addEventListener('input', () => {
    updateNewPlaylistPreview();
    if (playlistPrefixDebounceTimer) clearTimeout(playlistPrefixDebounceTimer);
    playlistPrefixDebounceTimer = setTimeout(() => {
      playlistPrefixDebounceTimer = null;
      const mode = getPlaylistMode();
      const fromList = document.querySelector('input[name="pl-existing-source"]:checked')?.value === 'from-list';
      if (mode === 'existing' && fromList && spotifyClient && currentFlowStep === '2') {
        refreshExistingPlaylistSelect({ quiet: true, reason: 'prefix-change' }).catch(() => {});
      }
      touchPlaylistApplyPostSuccessDirty();
    }, 650);
  });
  $('btn-reset-playlist-prefix').addEventListener('click', () => {
    $('playlist-prefix').value = DEFAULT_PLAYLIST_NAME_PREFIX;
    updateNewPlaylistPreview();
    showToast('Prefixet är återställt.');
    const mode = getPlaylistMode();
    const fromList = document.querySelector('input[name="pl-existing-source"]:checked')?.value === 'from-list';
    if (mode === 'existing' && fromList && spotifyClient && currentFlowStep === '2') {
      refreshExistingPlaylistSelect({ quiet: true, reason: 'prefix-reset' }).catch(() => {});
    }
    touchPlaylistApplyPostSuccessDirty();
  });

  $('pref-theme').addEventListener('change', () => {
    applyTheme($('pref-theme').value);
    persistLocalSettings();
  });

  /* Utvecklarläge: togglar body[data-developer-mode] så Spotify API-logg-kortet
   * visas/döljs via CSS i alla vyer samt sparar valet direkt i localStorage. */
  $('pref-developer-mode').addEventListener('change', (ev) => {
    const on = /** @type {HTMLInputElement} */ (ev.currentTarget).checked;
    applyDeveloperMode(on);
    persistLocalSettings();
  });

  /* Auto-save av prefix vid ändring — återanvänder samma debounce-timer som
   * prefixfilter-uppdateringen och skriver localStorage när användaren slutar
   * knappa. (Se även input-hanteraren ovan där timern sätts.) */
  $('playlist-prefix').addEventListener('blur', () => persistLocalSettings());
  $('btn-reset-playlist-prefix').addEventListener('click', () => persistLocalSettings());

  $('client-id').addEventListener('blur', () => {
    const cid = getClientId().trim();
    vaultData = vaultData ?? defaultVault();
    vaultData.clientId = cid;
    persistLocalSettings();
    if (!vaultData?.tokens?.accessToken) return;
    if (!cid) return;
    updateApplyEnabled();
    void syncSpotifySessionToUi().then(() => {
      if (resultRows.length > 0) renderResults();
    });
  });

  $('btn-spotify-login').addEventListener('click', async () => {
    const cid = getClientId();
    if (!cid) {
      showToast('Ange ett Client ID först.', true);
      return;
    }
    try {
      await beginLogin(cid);
    } catch (e) {
      showToast(String(e?.message ?? e), true);
    }
  });

  $('btn-logout').addEventListener('click', async () => {
    if (FEATURE_ROW_FULL_PLAYBACK) void stopRowPlayback();
    vaultData = vaultData ?? defaultVault();
    vaultData.clientId = getClientId();
    vaultData.settings = {
      ...defaultVault().settings,
      ...vaultData.settings,
      theme: $('pref-theme').value,
      playlistNamePrefix: $('playlist-prefix').value,
    };
    vaultData.tokens = null;
    const uidForCacheWipe = spotifyClient?.getCachedUserId?.() ?? null;
    spotifyClient = null;
    spotifyUserDisplay = '';
    invalidateExistingPlaylistListCache({ persistent: true, userId: uidForCacheWipe });
    invalidateSelectPlaylistCache({ persistent: true, userId: uidForCacheWipe });
    /** Nollställ valet för Redigera-flödet — annars skulle nästa inloggade användare
     *  få en stale vald spellista i Redigera-vyn. */
    selectedEditPlaylist = null;
    writeStoredSelectedEditPlaylist(null);
    editPlaylistState = null;
    destroyEditPlaylistSortable();
    /** Artist-banken behålls med flit vid logout — den är samlad söklärdom per user-id
     *  (endast publika artistnamn, ingen token/profilinfo) och ska hjälpa framtida sessioner.
     *  Manuell rensning finns under Inställningar via knappen "Rensa artist-bank". */
    clearSpotifySession();
    persistLocalSettings();
    showToast('Du är utloggad från Spotify. Klient-ID och inställningar är kvar.');
    setAuthStatus();
    touchPlaylistApplyPostSuccessDirty();
  });

  $('btn-search').addEventListener('click', () => runSearch());

  $('btn-clear-paste').addEventListener('click', () => {
    if (FEATURE_ROW_FULL_PLAYBACK) void stopRowPlayback();
    if (searchInProgress && searchAbortController) {
      try {
        searchAbortController.abort();
      } catch {
        /* ok */
      }
    }
    $('paste-area').value = '';
    resultRows = [];
    searchInProgress = false;
    searchAbortController = null;
    setSearchProgress(false);
    touchPlaylistApplyPostSuccessDirty();
    renderResults();
  });

  $('btn-apply-playlist').addEventListener('click', () => applyPlaylist());

  document.querySelectorAll('[data-playlist-result-close]').forEach((el) => {
    el.addEventListener('click', () => hidePlaylistResultDialog());
  });
  const prCloseBtn = document.getElementById('btn-playlist-result-close');
  if (prCloseBtn) prCloseBtn.addEventListener('click', () => hidePlaylistResultDialog());

  await handleOAuthReturn();

  if (!vaultData?.tokens?.accessToken) {
    restoreSpotifySessionIfAny();
  }

  await syncSpotifySessionToUi();

  applyTheme($('pref-theme').value);
  updateNewPlaylistPreview();
  updateApplyEnabled();
  /* Starta alltid på landningssidan. Om användaren hade valt ett flöde tidigare i
   * samma session (sessionStorage) och har en giltig Spotify-token, hoppa direkt
   * till flödets första inre steg så upplevelsen blir snabb vid reload. Logga in-
   * vyn når man alltid via breadcrumben "Logga in" (t.ex. för att logga ut). */
  const storedMode = readStoredFlowMode();
  const hasToken = Boolean(vaultData?.tokens?.accessToken) && spotifyClient;
  if (storedMode && hasToken) {
    setFlowMode(storedMode);
    setFlowStep(storedMode === 'create' ? '1' : 'select-playlist', {
      focusPanel: false,
      skipSpotifyWarmup: true,
    });
  } else if (storedMode) {
    /* Flöde valt i tidigare session men token har gått ut — visa login-vyn som
     * startpunkt så användaren kan logga in igen utan att klicka landningssidan. */
    setFlowMode(storedMode);
    setFlowStep('0', { focusPanel: false, skipSpotifyWarmup: true });
  } else {
    setFlowStep('landing', { focusPanel: false, skipSpotifyWarmup: true });
  }
  /* Fyll stats-raderna så att de är uppdaterade även om användaren hoppar direkt till
   * Inställningar utan att passera flödet (setFlowStep('settings') triggar en ny uppdatering). */
  void refreshSettingsStats();
  await registerServiceWorker();
}

boot().catch((e) => showToast(String(e?.message ?? e), true));
