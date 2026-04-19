import { DEFAULT_PLAYLIST_NAME_PREFIX, FEATURE_ROW_FULL_PLAYBACK } from './config.js';
import { getRedirectUri, beginLogin, consumeOAuthCallback } from './auth.js';
import { loadVault, saveVault, VAULT_KEY } from './vault.js';
import { idbGet } from './db.js';
import { parseTrackList } from './parser.js';
import { createSpotifyClient, parsePlaylistIdFromInput } from './spotify-api.js';
import { subscribeSpotifyLog, clearSpotifyLog, logSpotify } from './spotify-log.js';
import { makeSearchCacheKey, getSearchCache, setSearchCache, clearSearchCache } from './search-cache.js';
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

/** @type {AbortController | null} */
let playlistResultDialogEscapeAbort = null;

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
    selectedPlaylist: null,
  };
}

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

/** Spellisteläge från steg 2 (radiogruppen pl-mode). */
function getPlaylistMode() {
  const el = document.querySelector('#flow-step-2 input[name="pl-mode"]:checked');
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
      ? `Öppna spellistan ”${opts.playlistName}” på Spotify`
      : 'Öppna spellistan på Spotify';
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
      /scope|behörighet|Forbidden|403|401|Dashboard|Rensa session|privat spellista/i.test(message);
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

function getPassphrase() {
  return $('crypto-pass').value;
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

async function saveEncryptedVault() {
  const pass = getPassphrase();
  if (pass.length < 8) {
    showToast('Lösenfras måste vara minst 8 tecken.', true);
    return;
  }
  const cid = getClientId();
  if (!cid) {
    showToast('Ange Client ID.', true);
    return;
  }
  vaultData = vaultData ?? defaultVault();
  vaultData.clientId = cid;
  vaultData.settings = {
    ...defaultVault().settings,
    ...vaultData.settings,
    theme: $('pref-theme').value,
    playlistNamePrefix: $('playlist-prefix').value,
  };
  persistTokensFromClient();
  await saveVault(vaultData, pass);
  syncSpotifySessionToStorage();
  showToast('Sparat krypterat i IndexedDB.');
  setAuthStatus();
  updateApplyEnabled();
}

async function loadEncryptedVault() {
  const pass = getPassphrase();
  if (pass.length < 8) {
    showToast('Ange samma lösenfras som vid sparande (minst 8 tecken).', true);
    return;
  }
  try {
    const data = await loadVault(pass);
    if (!data) {
      showToast('Ingen sparad data hittades.', true);
      return;
    }
    vaultData = { ...defaultVault(), ...data };
    vaultData.settings = { ...defaultVault().settings, ...vaultData.settings };
    $('client-id').value = vaultData.clientId ?? '';
    $('pref-theme').value = vaultData.settings?.theme ?? 'system';
    $('playlist-prefix').value =
      vaultData.settings?.playlistNamePrefix != null && String(vaultData.settings.playlistNamePrefix).length > 0
        ? String(vaultData.settings.playlistNamePrefix)
        : DEFAULT_PLAYLIST_NAME_PREFIX;
    applyTheme($('pref-theme').value);
    updateNewPlaylistPreview();
    await syncSpotifySessionToUi();
    showToast('Data läst in.');
    syncSpotifySessionToStorage();
    updateApplyEnabled();
  } catch {
    showToast('Kunde inte läsa valvet. Fel lösenfras?', true);
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
    const pass = getPassphrase();
    if (pass.length >= 8) {
      saveVault(vaultData, pass).catch(() => {});
    }
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
    title.textContent = 'Inte inloggad på Spotify.';
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
    title.textContent = 'Tokens finns men Client ID saknas';
    const note = document.createElement('p');
    note.className = 'auth-status-card__note';
    note.textContent =
      'Vanligt efter omdirigering. Ange Client ID i fältet ovan — spara under Inställningar när du klickar Spara lokalt.';
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
  title.textContent = spotifyUserDisplay ? `Inloggad som ${spotifyUserDisplay}` : 'Inloggad på Spotify.';

  const meta = document.createElement('p');
  meta.className = 'auth-status-card__meta';
  meta.textContent = `Access token giltig till ${exp}.`;

  body.append(title, meta);
  if (gs) {
    appendScopePills(body, gs);
  } else {
    const alert = document.createElement('p');
    alert.className = 'auth-status-card__alert';
    alert.textContent =
      'Spotify skickade ingen scope-lista i token-svaret (ovanligt). Om spellistor nekas: logga in igen efter att du återkallat appen (403-hjälpen nedan).';
    body.append(alert);
  }
  if (gs && !hasPlaylistScope) {
    const alert = document.createElement('p');
    alert.className = 'auth-status-card__alert';
    alert.textContent =
      'Denna token saknar playlist-modify-public/private — spellistor kan inte skapas eller ändras. Återkalla appen på spotify.com/account/apps och logga in igen.';
    body.append(alert);
  }

  const foot = document.createElement('p');
  foot.className = 'auth-status-card__note';
  foot.textContent =
    'Access token förnyas automatiskt i god tid via refresh token. Omladdning av sidan behåller inloggning i samma webbläsarflik; stäng fliken eller tryck Rensa session för att logga ut lokalt.';
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
  showToast(
    'Spotify-inloggning klar. Du kan ladda om sidan utan ny inloggning (samma flik). Under Inställningar: Spara lokalt med lösenfras för att behålla tokens efter stängd flik.',
  );
  updateApplyEnabled();
  void syncSpotifySessionToUi();
}

async function handleOAuthReturn() {
  const result = await consumeOAuthCallback();
  if (!result) return;
  if ('error' in result) {
    showToast(`Inloggning avbruten: ${result.error}`, true);
    return;
  }
  mergeOAuthTokens(result.tokens, result.clientId);
}

/** @type {'0' | '1' | '2' | '3' | 'settings'} */
let currentFlowStep = '0';

function syncPageLeadStep3() {
  const lead = document.getElementById('app-page-lead');
  if (!lead || currentFlowStep !== '3') return;
  const mode = getPlaylistMode();
  lead.textContent =
    mode === 'new'
      ? 'Skapa och publicera din spellista på Spotify. Följ stegen nedan och utför åtgärden när du är redo.'
      : 'Välj hur du hittar spellistan och hur låtarna ska läggas till innan du kör Genomför på Spotify.';
}

/** Rubrik i kortet steg 3 växlar mellan ny / befintlig spellista. */
function syncStep3CardHeadings() {
  const title = document.getElementById('heading-playlist');
  const sub = document.getElementById('heading-playlist-sub');
  if (!title || !sub) return;
  const mode = getPlaylistMode();
  if (mode === 'new') {
    title.textContent = 'Skapa ny spellista';
    sub.textContent = 'Ange namn och välj om spellistan skall vara publik.';
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
 * @param {'0' | '1' | '2' | '3' | 'settings'} step
 * @param {{ focusPanel?: boolean, skipSpotifyWarmup?: boolean }} [opts] focusPanel: flytta fokus till aktivt steg (t.ex. efter klick i steglisten), inte vid sidladdning.
 *   skipSpotifyWarmup: vid steg 0 undvik dublett av init + /me när boot() redan kört syncSpotifySessionToUi.
 */
function setFlowStep(step, opts = {}) {
  const { focusPanel = false, skipSpotifyWarmup = false } = opts;
  syncClientIdFromFormIntoVault();
  currentFlowStep = /** @type {'0' | '1' | '2' | '3' | 'settings'} */ (step);
  if (FEATURE_ROW_FULL_PLAYBACK && step !== '1') {
    void resetWebPlaybackSession();
  }
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
  document.querySelectorAll('.flow-breadcrumbs__crumb[data-flow-step]').forEach((btn) => {
    const s = btn.getAttribute('data-flow-step');
    const on = s === step;
    btn.classList.toggle('is-active', on);
    if (on) btn.setAttribute('aria-current', 'location');
    else btn.removeAttribute('aria-current');
  });
  const leads = {
    '0': 'Konfigurera och logga in på Spotify så att flödet kan skapa eller uppdatera din spellista.',
    '1': 'Klistra in låtar, hitta rätt spår på Spotify och välj vilka som ska läggas till i spellistan.',
    '2': 'Välj hur låtarna ska sparas och ange vilken befintlig spellista som ska användas.',
    '3': '',
    settings: 'Konfigurera hur appen beter sig lokalt på din enhet.',
  };
  const lead = document.getElementById('app-page-lead');
  if (lead) {
    if (step === '3') {
      syncPageLeadStep3();
      syncStep3CardHeadings();
    } else if (leads[step]) {
      lead.textContent = leads[step];
    }
  }
  if (step === '0' && !skipSpotifyWarmup) {
    void syncSpotifySessionToUi();
  }
  if (step === '1') {
    void syncSpotifySessionToUi();
    updateApplyEnabled();
    updateNewPlaylistPreview();
    if (resultRows.length > 0) renderResults();
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
}

function updateSummarySubtitle(step) {
  const el = document.getElementById('summary-card-subtitle');
  if (!el) return;
  const lines = {
    '0': 'Status för inloggning och nästa steg.',
    '1': 'Kontrollera dina val innan du går vidare till spellista.',
    '2': 'Kontrollera dina val innan du fortsätter.',
    '3': 'Kontrollera dina val innan du klickar Genomför på Spotify.',
    settings: 'Kontrollera dina val innan du fortsätter.',
  };
  el.textContent = lines[step] ?? '';
}

function updateSummaryTip(step) {
  const tip = document.getElementById('sum-tip-text');
  if (!tip) return;
  const plMode = getPlaylistMode();
  if ((step === '2' || step === '3') && plMode === 'existing') {
    tip.textContent = 'Listan visar bara spellistor du äger och som matchar ditt prefix.';
    return;
  }
  if (step === '3' && plMode === 'new') {
    tip.textContent = 'Prefixet hämtas från Inställningar och läggs till automatiskt.';
    return;
  }
  const tips = {
    '0':
      'Spotify-inloggning: du skriver inte ditt Spotify-lösenord här — du skickas till Spotify. Lösenfrasen är bara för lokal kryptering (IndexedDB).\n\nAnge Client ID, logga in med Spotify och spara valvet under Inställningar innan du går vidare till låtar.',
    '1':
      'Använd brytarna för att ta med en rad i spellistan och radioknapparna för att välja rätt version av spåret.',
    '2': 'Du måste vara inloggad via Spotify för att fortsätta.',
    '3': 'Kontrollera sammanfattningen till höger innan du klickar Genomför på Spotify.',
    settings: 'Prefixet används när du skapar nya spellistor och när listor filtreras på prefix.',
  };
  tip.textContent = tips[step] ?? tips['0'];
}

function refreshSummary() {
  const sumSpotify = document.getElementById('sum-spotify');
  const sumTracks = document.getElementById('sum-tracks');
  const sumPlaylist = document.getElementById('sum-playlist');
  const sumAction = document.getElementById('sum-action');
  const sumToken = document.getElementById('sum-token');
  const sumFoot = document.getElementById('sum-foot');
  const sumRowExtra = document.getElementById('sum-row-extra');
  const sumExtra = document.getElementById('sum-extra');
  const sumExtraLabel = document.getElementById('sum-extra-label');
  if (!sumSpotify || !sumTracks || !sumPlaylist || !sumAction || !sumToken || !sumFoot) return;

  const hasToken = Boolean(vaultData?.tokens?.accessToken);
  const cid = (vaultData?.clientId || '').trim() || getClientId().trim();
  if (hasToken && spotifyClient) {
    sumSpotify.textContent = 'Inloggad';
    sumSpotify.classList.add('summary-list__value--ok');
  } else if (hasToken && !cid) {
    sumSpotify.textContent = 'Token finns · ange Client ID';
    sumSpotify.classList.remove('summary-list__value--ok');
  } else {
    sumSpotify.textContent = 'Ej inloggad';
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

  if (trackCount === 0) {
    sumAction.textContent = '—';
  } else if (mode === 'new') {
    sumAction.textContent = 'Genomför (ny)';
  } else {
    const um = document.querySelector('input[name="pl-update"]:checked')?.value ?? 'append';
    sumAction.textContent = um === 'replace' ? 'Uppdatera (ersätt)' : 'Uppdatera (lägg till)';
  }

  if (mode === 'new') {
    if (sumRowExtra) sumRowExtra.hidden = true;
  } else if (sumRowExtra && sumExtra && sumExtraLabel) {
    sumRowExtra.hidden = false;
    const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
    sumExtraLabel.textContent = 'Källa';
    sumExtra.textContent = src === 'from-list' ? 'Mina listor med prefix' : 'Spotify-länk';
  }

  if (vaultData?.tokens?.expiresAt) {
    const t = new Date(vaultData.tokens.expiresAt);
    const timeStr = t.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    sumToken.textContent = `Giltig Spotify-token finns till ${timeStr}`;
    sumToken.classList.add('summary-list__value--ok');
  } else {
    sumToken.textContent = '—';
    sumToken.classList.remove('summary-list__value--ok');
  }

  if (!hasToken) {
    sumFoot.textContent = 'Logga in under steg 0 för att fortsätta.';
  } else if (mode === 'existing') {
    const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
    if (src === 'from-list' && !$('existing-pl-select').value) {
      sumFoot.textContent = 'Välj en spellista för att kunna fortsätta.';
    } else if (src === 'from-link' && !$('existing-pl-id').value.trim()) {
      sumFoot.textContent = 'Ange Spotify-länk eller spelliste-ID.';
    } else if (trackCount === 0) {
      sumFoot.textContent = 'Välj minst en låt med träff (steg 1).';
    } else {
      sumFoot.textContent = 'Redo att utföra åtgärden.';
    }
  } else if (trackCount === 0) {
    sumFoot.textContent = 'Välj låtar under steg 1 för att fortsätta.';
  } else if (!$('new-pl-name').value.trim()) {
    sumFoot.textContent = 'Ange ett namn (suffix) för den nya spellistan.';
  } else {
    sumFoot.textContent = 'Redo att genomföra på Spotify.';
  }

  updateSummaryTip(currentFlowStep);
  updateApplyEnabled();
}

function wireFlow() {
  document.querySelectorAll('[data-flow-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = btn.getAttribute('data-flow-step');
      if (s) setFlowStep(/** @type {'0' | '1' | '2' | '3' | 'settings'} */ (s), { focusPanel: true });
    });
  });
  document.querySelectorAll('[data-flow-goto]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = btn.getAttribute('data-flow-goto');
      if (s) setFlowStep(/** @type {'0' | '1' | '2' | '3' | 'settings'} */ (s), { focusPanel: true });
    });
  });
}

function setCreateModeNavActive() {
  document.querySelectorAll('.flow-mode-nav__btn[data-flow-mode]').forEach((b) => {
    const m = b.getAttribute('data-flow-mode');
    const on = m === 'create';
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

/** Skapa playlists: markera läge och gå till flödets första steg (t.ex. från Inställningar). */
function wireFlowModeNav() {
  document.querySelectorAll('[data-flow-mode="create"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setCreateModeNavActive();
      setFlowStep('0', { focusPanel: true });
    });
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

/**
 * @param {{ quiet?: boolean, selectPlaylistId?: string }} [opts] quiet: ingen toast (t.ex. auto-uppdatering). selectPlaylistId: välj detta id efter laddning.
 */
async function refreshExistingPlaylistSelect(opts = {}) {
  const { quiet = false, selectPlaylistId } = opts;
  if (!spotifyClient) {
    showToast('Logga in på Spotify under steg 0 (Logga in) först.', true);
    return;
  }
  existingPlSelectRefreshAbort?.abort();
  const ac = new AbortController();
  existingPlSelectRefreshAbort = ac;
  const { signal } = ac;
  try {
    const prefix = getPlaylistPrefixFromInput();
    const sel = $('existing-pl-select');
    sel.replaceChildren();
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '- Välj spellista -';
    sel.append(ph);
    const list = await spotifyClient.listMyPlaylistsByPrefix(prefix, signal);
    for (const p of list) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      sel.append(opt);
    }
    if (selectPlaylistId && list.some((p) => p.id === selectPlaylistId)) {
      sel.value = selectPlaylistId;
    }
    if (!quiet) {
      showToast(list.length ? `${list.length} spellistor med prefix.` : 'Inga spellistor matchar prefixet.');
    }
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
    throw e;
  } finally {
    if (existingPlSelectRefreshAbort === ac) existingPlSelectRefreshAbort = null;
  }
}

/** Undvik för täta Spotify-anrop vid snabba stegbyten */
let lastVisibilityPlaylistRefresh = 0;
const VISIBILITY_PLAYLIST_REFRESH_GAP_MS = 25_000;

function maybeRefreshPlaylistsWhenTabVisible() {
  if (document.visibilityState !== 'visible') return;
  const mode = getPlaylistMode();
  const fromList = document.querySelector('input[name="pl-existing-source"]:checked')?.value === 'from-list';
  if (mode !== 'existing' || !fromList || !spotifyClient) return;
  const now = Date.now();
  if (now - lastVisibilityPlaylistRefresh < VISIBILITY_PLAYLIST_REFRESH_GAP_MS) return;
  lastVisibilityPlaylistRefresh = now;
  refreshExistingPlaylistSelect({ quiet: true }).catch(() => {});
}

/** Synkar steg 3: ny vs befintlig spellista (måste köras vid stegbyte, inte bara vid pl-mode change). */
function syncPlaylistModeBlocks() {
  const v = getPlaylistMode();
  const isNew = v === 'new';
  const step3 = document.getElementById('flow-step-3');
  if (step3) step3.setAttribute('data-playlist-mode', v);
  $('block-new-playlist').hidden = !isNew;
  $('block-existing-playlist').hidden = isNew;
  if (!isNew) {
    updateExistingPlaylistSourceUi();
    const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
    if (src === 'from-list' && spotifyClient) {
      refreshExistingPlaylistSelect({ quiet: true }).catch((e) => showToast(String(e?.message ?? e), true));
    }
  }
}

function wirePlaylistMode() {
  const modes = document.querySelectorAll('#flow-step-2 input[name="pl-mode"]');
  const update = () => {
    syncPlaylistModeBlocks();
    refreshSummary();
    syncPageLeadStep3();
    syncStep3CardHeadings();
  };
  modes.forEach((r) => r.addEventListener('change', update));
  document.querySelectorAll('input[name="pl-update"]').forEach((r) => {
    r.addEventListener('change', () => {
      refreshSummary();
      updateApplyEnabled();
    });
  });
  document.querySelectorAll('input[name="pl-existing-source"]').forEach((r) => {
    r.addEventListener('change', () => {
      updateExistingPlaylistSourceUi();
      if (r.value === 'from-list' && spotifyClient) {
        refreshExistingPlaylistSelect().catch((e) => showToast(String(e?.message ?? e), true));
      }
      refreshSummary();
    });
  });
  $('btn-refresh-pl-list').addEventListener('click', () => {
    refreshExistingPlaylistSelect({ quiet: false }).catch((e) => showToast(String(e?.message ?? e), true));
  });
  document.addEventListener('visibilitychange', () => {
    maybeRefreshPlaylistsWhenTabVisible();
  });
  update();
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
    $('results-summary').textContent = `${n} sökningar — ${matched} med träff hittills, resten ej sökta ännu.`;
  } else {
    $('results-summary').textContent = `${n} sökningar, ${matched} med minst en träff.`;
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
    chk.disabled = !hasHits;
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
      updateApplyEnabled();
    });

    const hrUnder = document.createElement('hr');
    hrUnder.className = 'results-list__rule';
    hrUnder.setAttribute('aria-hidden', 'true');

    const optionsWrap = document.createElement('div');
    optionsWrap.className = 'match-block__options';

    if (row.tracks === null) {
      const wait = document.createElement('p');
      wait.className = 'match-block__status row-muted';
      wait.textContent = searchInProgress ? 'Söker…' : 'Kör ”Sök på Spotify” för att hämta träffar.';
      optionsWrap.append(wait);
    } else if (row.tracks.length === 0) {
      const none = document.createElement('p');
      none.className = 'match-block__status row-muted';
      none.textContent = 'Ingen träff';
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
        radio.addEventListener('change', () => {
          row.selectedUri = t.uri;
          notifyRowPlaybackTrackChanged(idx);
          updateApplyEnabled();
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
  if (!spotifyClient) {
    el.textContent = 'Logga in under steg 0 för att kunna utföra åtgärden.';
    return;
  }
  if (resultRows.length === 0) {
    el.textContent = 'Välj låtar med träff under steg 1 först.';
    return;
  }
  if (selectedUrisForPlaylist().length === 0) {
    el.textContent = 'Slå på Välj och välj version för minst en rad med träff innan du kör Genomför på Spotify.';
    return;
  }
  const mode = getPlaylistMode();
  if (mode === 'new') {
    if (!$('new-pl-name').value.trim()) {
      el.textContent = 'Ange suffixnamn för spellistan (obligatoriskt) innan du kör Genomför på Spotify.';
      return;
    }
    el.textContent = 'Skapar en ny spellista i ditt Spotify-konto med prefix + suffix.';
    return;
  }
  const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
  if (src === 'from-list' && !$('existing-pl-select').value.trim()) {
    el.textContent = 'Välj en spellista i listan innan du kör Genomför på Spotify.';
    return;
  }
  if (src === 'from-link' && !parsePlaylistIdFromInput($('existing-pl-id').value)) {
    el.textContent = 'Ange en giltig Spotify-länk eller spelliste-ID innan du kör Genomför på Spotify.';
    return;
  }
  const um = document.querySelector('input[name="pl-update"]:checked')?.value ?? 'append';
  el.textContent =
    um === 'replace'
      ? 'Alla befintliga låtar i vald spellista ersätts med de valda låtarna.'
      : 'Låtarna läggs till i vald spellista på Spotify.';
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
    hint.textContent = 'Sökning pågår — vänta tills alla rader har svarats.';
  } else if (resultRows.length === 0) {
    hint.textContent = 'Klistra in en låtlista och kör Sök på Spotify — därefter kan du gå vidare.';
  } else if (pendingSearch) {
    hint.textContent = 'Vänta tills sökningen är klar för alla rader.';
  } else if (selectedUrisForPlaylist().length === 0) {
    hint.textContent = 'Slå på Välj för minst en rad med träff, eller välj en version av spåret, för att gå vidare.';
  } else {
    hint.textContent = 'När träffarna ser rätt ut — fortsätt till spellista.';
  }
}

function updateApplyEnabled() {
  $('btn-apply-playlist').disabled = !isStep3ApplyReady();
  const busy = searchInProgress;
  $('btn-search').disabled = !spotifyClient || busy;
  $('btn-clear-paste').disabled = busy;
  syncApplyHint();
  updateStep1StickyNav();
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
    showToast('Logga in på Spotify under steg 0 (Logga in) först.', true);
    return;
  }
  if (searchInProgress) {
    showToast('En sökning pågår redan — vänta eller tryck ”Avbryt sökning”.', true);
    return;
  }
  const parsed = parseTrackList($('paste-area').value);
  if (parsed.length === 0) {
    showToast('Inga rader att söka. Klistra in en låtlista först.', true);
    return;
  }
  if (FEATURE_ROW_FULL_PLAYBACK) void stopRowPlayback();
  resultRows = parsed.map((p) => ({ ...p, tracks: null, selectedUri: null, includedInPlaylist: true }));
  searchInProgress = true;
  searchAbortController = new AbortController();
  const signal = searchAbortController.signal;
  renderResults();
  setSearchProgress(true);
  try {
    let cacheHits = 0;
    for (let i = 0; i < resultRows.length; i += 1) {
      if (signal.aborted) break;
      $('search-progress-line').textContent = `Söker ${i + 1} av ${resultRows.length} …`;
      const row = resultRows[i];
      const cacheKey = makeSearchCacheKey(row.query, row.artist, row.title);
      const cached = getSearchCache(cacheKey);
      /** Paus mellan rader ska bara följa efter Spotify-anrop — cache är lokalt och ska inte fördröja nästa rad */
      let rowFetchedFromSpotify = false;
      if (cached != null) {
        cacheHits += 1;
        row.tracks = cached;
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
          signal,
        });
        if (!signal.aborted) setSearchCache(cacheKey, row.tracks);
      }
      if (signal.aborted) break;
      row.selectedUri = row.tracks[0]?.uri ?? null;
      renderResults();
      if (i < resultRows.length - 1 && rowFetchedFromSpotify) {
        await sleepAbortable(SEARCH_ROW_GAP_MS + Math.random() * SEARCH_ROW_JITTER_MS, signal);
      }
    }
    if (!signal.aborted) {
      showToast(
        cacheHits > 0
          ? `Sökning klar. ${cacheHits} av ${resultRows.length} rader från cache, övriga från Spotify.`
          : 'Sökning klar.',
      );
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
    if (signal.aborted) {
      const done = resultRows.filter((r) => r.tracks !== null).length;
      showToast(`Sökning avbruten. ${done} av ${resultRows.length} rader hann sökas.`);
    }
    refreshSummary();
  }
}

async function applyPlaylist() {
  if (!spotifyClient || !vaultData) {
    showToast('Saknar inloggning eller valv.', true);
    return;
  }
  const uris = selectedUrisForPlaylist();
  if (uris.length === 0) {
    showToast('Välj minst en låt med träff.', true);
    return;
  }
  const mode = getPlaylistMode();
  if (mode === 'new' && !$('new-pl-name').value.trim()) {
    showToast('Ange namn (suffix) för den nya spellistan.', true);
    return;
  }
  hidePlaylistResultDialog();
  $('btn-apply-playlist').disabled = true;
  try {
    if (mode === 'new') {
      const suffix = $('new-pl-name').value.trim();
      const name = `${getPlaylistPrefixFromInput()}${suffix}`;
      const isPublic = $('new-pl-public').checked;
      const gs = (vaultData.tokens?.grantedScopeRaw || '').trim();
      if (gs) {
        const hasPub = gs.includes('playlist-modify-public');
        const hasPriv = gs.includes('playlist-modify-private');
        if (isPublic && !hasPub) {
          showToast(
            'Din token saknar playlist-modify-public (Spotify gav andra scopes). Lämna ”Publik spellista” urkryssad, eller återkalla appen på spotify.com/account/apps och logga in igen.',
            true,
          );
          return;
        }
        if (!isPublic && !hasPriv) {
          showToast(
            'Din token saknar playlist-modify-private. Återkalla appen på spotify.com/account/apps och logga in igen, eller kontrollera att ditt konto finns under User management i Dashboard.',
            true,
          );
          return;
        }
      }
      const pl = await spotifyClient.createPlaylist({ name, isPublic });
      for (let i = 0; i < uris.length; i += SPOTIFY_CHUNK) {
        await spotifyClient.appendPlaylistTracks(pl.id, uris.slice(i, i + SPOTIFY_CHUNK));
      }
      vaultData.selectedPlaylist = { id: pl.id, name: pl.name };
      const pass = getPassphrase();
      if (pass.length >= 8) await saveVault(vaultData, pass);
      const openUrl =
        typeof pl.external_urls?.spotify === 'string' && pl.external_urls.spotify.trim()
          ? pl.external_urls.spotify.trim()
          : undefined;
      showPlaylistResultDialog({
        ok: true,
        title: 'Det gick bra',
        message: `Spellistan ”${pl.name}” skapades med ${uris.length} låtar på Spotify.`,
        playlistId: pl.id,
        playlistName: typeof pl.name === 'string' ? pl.name : suffix,
        playlistOpenUrl: openUrl,
      });
      await refreshExistingPlaylistSelect({ quiet: true, selectPlaylistId: pl.id }).catch(() => {});
    } else {
      const source =
        document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-list';
      let plId = null;
      if (source === 'from-list') {
        plId = $('existing-pl-select').value.trim();
        if (!plId) {
          showToast('Välj en spellista i listan (eller byt till ID/länk).', true);
          return;
        }
      } else {
        const rawId = $('existing-pl-id').value;
        plId = parsePlaylistIdFromInput(rawId);
        if (!plId) {
          showToast('Ogiltigt spelliste-ID.', true);
          return;
        }
      }
      const updateMode = document.querySelector('input[name="pl-update"]:checked')?.value;
      if (updateMode === 'replace' && uris.length > SPOTIFY_CHUNK) {
        showToast(`Ersätt läge stödjer högst ${SPOTIFY_CHUNK} låtar åt gången.`, true);
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
      vaultData.selectedPlaylist = { id: plId, name: plLabel };
      const pass = getPassphrase();
      if (pass.length >= 8) await saveVault(vaultData, pass);
      showPlaylistResultDialog({
        ok: true,
        title: 'Det gick bra',
        message:
          updateMode === 'replace'
            ? `Spellistan uppdaterades: tidigare låtar ersattes med ${uris.length} valda låtar.`
            : `${uris.length} låtar lades till i spellistan på Spotify.`,
        playlistId: plId,
        playlistName: typeof plLabel === 'string' ? plLabel : undefined,
      });
    }
  } catch (e) {
    showPlaylistResultDialog({
      ok: false,
      title: 'Något gick fel',
      message: String(e?.message ?? e),
    });
  } finally {
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

async function boot() {
  $('redirect-uri-display').textContent = getRedirectUri();

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
    showToast('Sökcache rensad.');
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
    line.textContent = `${base} — väntar ${d.waitSec}s (rate limit, försök ${d.attempt}/${d.maxAttempts})`;
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
    const retrySec = typeof d.retryAfterParsedMs === 'number' ? Math.round(d.retryAfterParsedMs / 1000) : null;
    const raw = typeof d.retryAfterRaw === 'string' ? d.retryAfterRaw.trim() : '';
    wrap.hidden = false;
    const tick = () => {
      const leftMs = d.endAt - Date.now();
      if (leftMs <= 0) {
        clearRetryAfterCountdown();
        return;
      }
      const leftSec = Math.max(1, Math.ceil(leftMs / 1000));
      const hdr =
        retrySec != null
          ? `Spotify Retry-After: ${retrySec} s (header ”${raw || '?'}”). `
          : '';
      text.textContent = `${hdr}Kvar av denna paus: ${leftSec} s.`;
    };
    tick();
    retryAfterCountdownTimer = setInterval(tick, 1000);
  });

  $('btn-copy-redirect').addEventListener('click', async () => {
    const text = getRedirectUri();
    $('redirect-uri-display').textContent = text;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Omdirigerings-URI kopierad. Klistra in den under Redirect URIs i Spotify Dashboard.');
    } catch {
      showToast('Kunde inte kopiera automatiskt. Markera URI:n manuellt.', true);
    }
  });

  wireFlow();
  wireFlowModeNav();
  wirePlaylistMode();
  if (FEATURE_ROW_FULL_PLAYBACK) {
    bindRowPlaybackControls($('results-body'), {
      getRows: () => resultRows,
      showMessage: (text, isError) => showToast(text, Boolean(isError)),
      getSpotifyClient: () => spotifyClient,
      getAccessToken: async () => {
        const c = spotifyClient;
        if (!c || typeof c.getAccessToken !== 'function') throw new Error('Ej inloggad');
        return c.getAccessToken();
      },
    });
  }
  $('new-pl-name').addEventListener('input', () => {
    updateNewPlaylistPreview();
    refreshSummary();
  });
  $('new-pl-public').addEventListener('change', () => refreshSummary());
  $('existing-pl-id').addEventListener('input', () => refreshSummary());
  $('existing-pl-select').addEventListener('change', () => refreshSummary());
  $('playlist-prefix').addEventListener('input', () => {
    updateNewPlaylistPreview();
    if (playlistPrefixDebounceTimer) clearTimeout(playlistPrefixDebounceTimer);
    playlistPrefixDebounceTimer = setTimeout(() => {
      playlistPrefixDebounceTimer = null;
      const mode = getPlaylistMode();
      const fromList = document.querySelector('input[name="pl-existing-source"]:checked')?.value === 'from-list';
      if (mode === 'existing' && fromList && spotifyClient) {
        refreshExistingPlaylistSelect({ quiet: true }).catch(() => {});
      }
    }, 650);
  });
  $('btn-reset-playlist-prefix').addEventListener('click', () => {
    $('playlist-prefix').value = DEFAULT_PLAYLIST_NAME_PREFIX;
    updateNewPlaylistPreview();
    showToast('Prefix återställt. Spara under Inställningar om det ska in i valvet.');
    const mode = getPlaylistMode();
    const fromList = document.querySelector('input[name="pl-existing-source"]:checked')?.value === 'from-list';
    if (mode === 'existing' && fromList && spotifyClient) {
      refreshExistingPlaylistSelect({ quiet: true }).catch(() => {});
    }
  });

  $('pref-theme').addEventListener('change', () => {
    applyTheme($('pref-theme').value);
  });

  $('btn-save-settings').addEventListener('click', () => saveEncryptedVault());
  $('btn-load-vault').addEventListener('click', () => loadEncryptedVault());

  $('client-id').addEventListener('blur', () => {
    if (!vaultData?.tokens?.accessToken) return;
    const cid = getClientId().trim();
    if (!cid) return;
    vaultData.clientId = cid;
    updateApplyEnabled();
    void syncSpotifySessionToUi().then(() => {
      if (resultRows.length > 0) renderResults();
    });
  });

  $('btn-spotify-login').addEventListener('click', async () => {
    const cid = getClientId();
    if (!cid) {
      showToast('Ange Client ID först.', true);
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
    spotifyClient = null;
    spotifyUserDisplay = '';
    clearSpotifySession();
    const pass = getPassphrase();
    if (pass.length >= 8) {
      await saveVault(vaultData, pass);
      showToast('Tokens borttagna från sparad data.');
    } else {
      showToast('Tokens borttagna i minnet. Under Inställningar: ange lösenfras och Spara lokalt för att uppdatera enheten.');
    }
    setAuthStatus();
    updateApplyEnabled();
  });

  $('btn-search').addEventListener('click', () => runSearch());

  $('btn-clear-paste').addEventListener('click', () => {
    if (FEATURE_ROW_FULL_PLAYBACK) void stopRowPlayback();
    $('paste-area').value = '';
    resultRows = [];
    searchInProgress = false;
    setSearchProgress(false);
    renderResults();
    updateApplyEnabled();
  });

  $('btn-select-all').addEventListener('click', () => {
    document.querySelectorAll('.row-select').forEach((c) => {
      if (c.disabled) return;
      c.checked = true;
      const idx = Number(c.dataset.rowIndex);
      if (!Number.isNaN(idx) && resultRows[idx]) resultRows[idx].includedInPlaylist = true;
      c.closest('.match-block')?.classList.remove('match-block--excluded');
    });
    updateApplyEnabled();
  });
  $('btn-clear-selection').addEventListener('click', () => {
    document.querySelectorAll('.row-select').forEach((c) => {
      if (c.disabled) return;
      c.checked = false;
      const idx = Number(c.dataset.rowIndex);
      if (!Number.isNaN(idx) && resultRows[idx]) resultRows[idx].includedInPlaylist = false;
      c.closest('.match-block')?.classList.add('match-block--excluded');
    });
    updateApplyEnabled();
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

  const exists = await idbGet(VAULT_KEY);
  const vaultHint =
    exists && !vaultData?.tokens?.accessToken
      ? 'Det finns sparad krypterad data. Under Inställningar: ange lösenfras och klicka ”Läs in sparad data”.'
      : '';
  await syncSpotifySessionToUi(vaultHint);

  const passInp = $('crypto-pass');
  const passTog = $('btn-toggle-pass-visibility');
  const passUse = passTog.querySelector('use');
  if (passUse) {
    passTog.addEventListener('click', () => {
      const show = passInp.type === 'password';
      passInp.type = show ? 'text' : 'password';
      passTog.setAttribute('aria-pressed', show ? 'true' : 'false');
      passTog.setAttribute('aria-label', show ? 'Dölj lösenfras' : 'Visa lösenfras');
      passUse.setAttribute('href', show ? '#sym-eye-off' : '#sym-eye');
    });
  }

  applyTheme($('pref-theme').value);
  updateNewPlaylistPreview();
  updateApplyEnabled();
  setFlowStep('0', { focusPanel: false, skipSpotifyWarmup: true });
  await registerServiceWorker();
}

boot().catch((e) => showToast(String(e?.message ?? e), true));
