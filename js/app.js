import { DEFAULT_PLAYLIST_NAME_PREFIX } from './config.js';
import { getRedirectUri, beginLogin, consumeOAuthCallback } from './auth.js';
import { loadVault, saveVault, VAULT_KEY } from './vault.js';
import { idbGet } from './db.js';
import { parseTrackList } from './parser.js';
import { createSpotifyClient, parsePlaylistIdFromInput } from './spotify-api.js';
import { subscribeSpotifyLog, clearSpotifyLog, logSpotify } from './spotify-log.js';
import { makeSearchCacheKey, getSearchCache, setSearchCache, clearSearchCache } from './search-cache.js';

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
    initSpotifyClient();
    await refreshSpotifyUserDisplay();
    showToast('Data läst in.');
    setAuthStatus();
    updateApplyEnabled();
  } catch {
    showToast('Kunde inte läsa valvet. Fel lösenfras?', true);
  }
}

function initSpotifyClient() {
  spotifyClient = null;
  spotifyUserDisplay = '';
  if (!vaultData?.tokens?.accessToken) return;
  const cid = (vaultData.clientId || '').trim() || getClientId().trim();
  if (!cid) return;
  vaultData.clientId = cid;
  spotifyClient = createSpotifyClient(vaultData.tokens, cid, (t) => {
    vaultData.tokens = t;
    const pass = getPassphrase();
    if (pass.length >= 8) {
      saveVault(vaultData, pass).catch(() => {});
    }
  });
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
      'Vanligt efter omdirigering. Ange Client ID i fältet ovan — det sparas nästa gång du klickar Spara lokalt.';
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
    'Token är tidsbegränsad och måste vara giltig för att flödet ska kunna skapa eller uppdatera din spellista.';
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
  initSpotifyClient();
  updateNewPlaylistPreview();
  showToast('Spotify-inloggning klar. Spara lokalt med din lösenfras för att behålla tokens.');
  updateApplyEnabled();
  void refreshSpotifyUserDisplay().then(() => setAuthStatus());
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
  const mode = document.querySelector('input[name="pl-mode"]:checked')?.value ?? 'new';
  lead.textContent =
    mode === 'new'
      ? 'Skapa och publicera din spellista på Spotify. Följ stegen nedan och utför åtgärden när du är redo.'
      : 'Välj hur spellistan ska uppdateras och ange vilken befintlig spellista som ska användas.';
}

/**
 * @param {'0' | '1' | '2' | '3' | 'settings'} step
 * @param {{ focusPanel?: boolean }} [opts] focusPanel: flytta fokus till aktivt steg (t.ex. efter klick i steglisten), inte vid sidladdning.
 */
function setFlowStep(step, opts = {}) {
  const { focusPanel = false } = opts;
  currentFlowStep = /** @type {'0' | '1' | '2' | '3' | 'settings'} */ (step);
  const accent = step === '0' || step === 'settings' ? 'spotify' : 'navy';
  document.documentElement.setAttribute('data-flow-accent', accent);
  document.querySelectorAll('.flow-step').forEach((el) => {
    const p = el.getAttribute('data-flow-panel');
    el.classList.toggle('is-active', p === step);
  });
  document.querySelectorAll('.flow-stepper__btn[data-flow-step]').forEach((btn) => {
    const s = btn.getAttribute('data-flow-step');
    const on = s === step;
    btn.classList.toggle('is-active', on);
    if (on) btn.setAttribute('aria-current', 'step');
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
    } else if (leads[step]) {
      lead.textContent = leads[step];
    }
  }
  if (step === '0') {
    initSpotifyClient();
    void refreshSpotifyUserDisplay().then(() => setAuthStatus());
  }
  if (step === '1') {
    initSpotifyClient();
    updateApplyEnabled();
    updateNewPlaylistPreview();
    if (resultRows.length > 0) renderResults();
    void refreshSpotifyUserDisplay().then(() => setAuthStatus());
  }
  updateSummarySubtitle(step);
  updateSummaryTip(step);
  refreshSummary();
  if (focusPanel) {
    const panelId = step === 'settings' ? 'flow-step-settings' : `flow-step-${step}`;
    const panel = document.getElementById(panelId);
    if (panel) {
      requestAnimationFrame(() => {
        panel.focus({ preventScroll: false });
      });
    }
  }
}

function updateSummarySubtitle(step) {
  const el = document.getElementById('summary-card-subtitle');
  if (!el) return;
  const lines = {
    '0': 'Status för inloggning och nästa steg.',
    '1': 'Kontrollera dina val innan du går vidare till spellista.',
    '2': 'Kontrollera dina val innan du fortsätter.',
    '3': 'Kontrollera dina val innan du utför åtgärden.',
    settings: 'Kontrollera dina val innan du fortsätter.',
  };
  el.textContent = lines[step] ?? '';
}

function updateSummaryTip(step) {
  const tip = document.getElementById('sum-tip-text');
  if (!tip) return;
  const plMode = document.querySelector('input[name="pl-mode"]:checked')?.value;
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
      'Spotify-inloggning: du skriver inte ditt Spotify-lösenord här — du skickas till Spotify. Lösenfrasen är bara för lokal kryptering (IndexedDB).\n\nAnge Client ID, logga in med Spotify och spara lokalt innan du går vidare till låtar.',
    '1':
      'Använd brytarna för att ta med en rad i spellistan och radioknapparna för att välja rätt version av spåret.',
    '2': 'Du måste vara inloggad via Spotify för att fortsätta.',
    '3': 'Kontrollera sammanfattningen till höger innan du klickar Utför.',
    settings: 'Prefixet används när du skapar nya spellistor och när listor filtreras på prefix.',
  };
  tip.textContent = tips[step] ?? tips['0'];
}

function updateSummaryCta() {
  const wrap = document.getElementById('summary-cta');
  const btn = document.getElementById('summary-cta-btn');
  if (!wrap || !btn) return;
  const hasToken = Boolean(vaultData?.tokens?.accessToken);
  const cid = (vaultData?.clientId || '').trim() || getClientId().trim();
  const ok = hasToken && Boolean(spotifyClient) && Boolean(cid);
  const step = currentFlowStep;
  if (step === '0' && ok) {
    wrap.hidden = false;
    btn.textContent = 'Nästa: Låtar';
    btn.setAttribute('data-flow-goto', '1');
    return;
  }
  if (step === 'settings' && ok) {
    wrap.hidden = false;
    btn.textContent = 'Tillbaka till flödet';
    btn.setAttribute('data-flow-goto', '1');
    return;
  }
  wrap.hidden = true;
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

  const mode = document.querySelector('input[name="pl-mode"]:checked')?.value ?? 'new';
  if (mode === 'new') {
    const suf = $('new-pl-name').value.trim();
    sumPlaylist.textContent = suf ? `${getPlaylistPrefixFromInput()}${suf}` : '—';
  } else {
    const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-link';
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
    sumAction.textContent = 'Skapa ny';
  } else {
    const um = document.querySelector('input[name="pl-update"]:checked')?.value ?? 'append';
    sumAction.textContent = um === 'replace' ? 'Uppdatera (ersätt)' : 'Uppdatera (lägg till)';
  }

  if (mode === 'new') {
    if (sumRowExtra) sumRowExtra.hidden = true;
  } else if (sumRowExtra && sumExtra && sumExtraLabel) {
    sumRowExtra.hidden = false;
    const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-link';
    sumExtraLabel.textContent = 'Källa';
    sumExtra.textContent = src === 'from-list' ? 'Mina listor med prefix' : 'ID eller länk';
  }

  if (vaultData?.tokens?.expiresAt) {
    const t = new Date(vaultData.tokens.expiresAt);
    const timeStr = t.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    sumToken.textContent = `Giltig Spotify-token finns fram till ${timeStr}`;
    sumToken.classList.add('summary-list__value--ok');
  } else {
    sumToken.textContent = '—';
    sumToken.classList.remove('summary-list__value--ok');
  }

  if (!hasToken) {
    sumFoot.textContent = 'Logga in under steg 0 för att fortsätta.';
  } else if (mode === 'existing') {
    const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-link';
    if (src === 'from-list' && !$('existing-pl-select').value) {
      sumFoot.textContent = 'Välj en spellista för att kunna fortsätta.';
    } else if (src === 'from-link' && !$('existing-pl-id').value.trim()) {
      sumFoot.textContent = 'Ange spelliste-ID eller URI.';
    } else if (trackCount === 0) {
      sumFoot.textContent = 'Välj minst en låt med träff (steg 1).';
    } else {
      sumFoot.textContent = 'Redo att utföra åtgärden.';
    }
  } else if (trackCount === 0) {
    sumFoot.textContent = 'Välj låtar under steg 1 för att fortsätta.';
  } else {
    sumFoot.textContent = 'Redo att skapa spellista.';
  }

  updateSummaryCta();
  syncApplyHint();
  updateSummaryTip(currentFlowStep);
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

function getPlaylistPrefixFromInput() {
  const raw = $('playlist-prefix').value;
  return raw.length > 0 ? raw : DEFAULT_PLAYLIST_NAME_PREFIX;
}

function updateNewPlaylistPreview() {
  const pre = getPlaylistPrefixFromInput();
  const suf = $('new-pl-name').value.trim() || '…';
  $('new-pl-preview').textContent = `${pre}${suf}`;
}

function updateExistingPlaylistSourceUi() {
  const mode = document.querySelector('input[name="pl-mode"]:checked')?.value;
  if (mode !== 'existing') return;
  const fromList = document.querySelector('input[name="pl-existing-source"]:checked')?.value === 'from-list';
  $('block-existing-from-list').hidden = !fromList;
  $('block-existing-from-link').hidden = fromList;
}

/**
 * @param {{ quiet?: boolean, selectPlaylistId?: string }} [opts] quiet: ingen toast (t.ex. auto-uppdatering). selectPlaylistId: välj detta id efter laddning.
 */
async function refreshExistingPlaylistSelect(opts = {}) {
  const { quiet = false, selectPlaylistId } = opts;
  if (!spotifyClient) {
    showToast('Logga in på Spotify under steg 0 (Logga in) först.', true);
    return;
  }
  const prefix = getPlaylistPrefixFromInput();
  const sel = $('existing-pl-select');
  sel.replaceChildren();
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = '— Välj spellista —';
  sel.append(ph);
  const list = await spotifyClient.listMyPlaylistsByPrefix(prefix);
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
}

/** Undvik för täta Spotify-anrop vid snabba stegbyten */
let lastVisibilityPlaylistRefresh = 0;
const VISIBILITY_PLAYLIST_REFRESH_GAP_MS = 25_000;

function maybeRefreshPlaylistsWhenTabVisible() {
  if (document.visibilityState !== 'visible') return;
  const mode = document.querySelector('input[name="pl-mode"]:checked')?.value;
  const fromList = document.querySelector('input[name="pl-existing-source"]:checked')?.value === 'from-list';
  if (mode !== 'existing' || !fromList || !spotifyClient) return;
  const now = Date.now();
  if (now - lastVisibilityPlaylistRefresh < VISIBILITY_PLAYLIST_REFRESH_GAP_MS) return;
  lastVisibilityPlaylistRefresh = now;
  refreshExistingPlaylistSelect({ quiet: true }).catch(() => {});
}

function wirePlaylistMode() {
  const modes = document.querySelectorAll('input[name="pl-mode"]');
  const blockNew = $('block-new-playlist');
  const blockEx = $('block-existing-playlist');
  const update = () => {
    const v = document.querySelector('input[name="pl-mode"]:checked')?.value;
    const isNew = v === 'new';
    blockNew.hidden = !isNew;
    blockEx.hidden = isNew;
    if (!isNew) {
      updateExistingPlaylistSourceUi();
      const src = document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-link';
      if (src === 'from-list' && spotifyClient) {
        refreshExistingPlaylistSelect({ quiet: true }).catch((e) => showToast(String(e?.message ?? e), true));
      }
    }
    refreshSummary();
    syncPageLeadStep3();
  };
  modes.forEach((r) => r.addEventListener('change', update));
  document.querySelectorAll('input[name="pl-update"]').forEach((r) => {
    r.addEventListener('change', () => refreshSummary());
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
function formatTrackChoiceLine(track) {
  const album = track.album?.name ?? '';
  const rawDate = track.album?.release_date || '';
  const year = rawDate.length >= 4 ? rawDate.slice(0, 4) : '';
  const albumBit = [album, year].filter(Boolean).join(', ');
  const dur = formatTrackDuration(track.duration_ms);
  const extras = [albumBit, dur].filter(Boolean);
  const suffix = extras.length ? ` (${extras.join(' · ')})` : '';
  const artists = (track.artists || []).map((a) => a.name).join(', ');
  return `${track.name ?? ''} — ${artists}${suffix}`;
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
    queryRow.append(queryEl, pickCell);
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
        });
        const line = document.createElement('span');
        line.className = 'match-line';
        line.textContent = formatTrackChoiceLine(t);
        label.append(radio, line);
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
  const mode = document.querySelector('input[name="pl-mode"]:checked')?.value ?? 'new';
  if (mode === 'new') {
    el.textContent = 'Skapar en ny spellista i ditt Spotify-konto med prefix + suffix.';
    return;
  }
  const um = document.querySelector('input[name="pl-update"]:checked')?.value ?? 'append';
  el.textContent =
    um === 'replace'
      ? 'Ersätter alla spår i vald spellista med de valda låtarna.'
      : 'Lägger till valda låtar sist i vald spellista utan att ta bort befintliga.';
}

function updateApplyEnabled() {
  $('btn-apply-playlist').disabled = resultRows.length === 0 || !spotifyClient;
  const busy = searchInProgress;
  $('btn-search').disabled = !spotifyClient || busy;
  $('btn-clear-paste').disabled = busy;
  syncApplyHint();
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
  const mode = document.querySelector('input[name="pl-mode"]:checked')?.value;
  $('btn-apply-playlist').disabled = true;
  try {
    if (mode === 'new') {
      const suffix = $('new-pl-name').value.trim() || 'Ny spellista';
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
      showToast(`Spellistan ”${pl.name}” skapades med ${uris.length} låtar.`);
      await refreshExistingPlaylistSelect({ quiet: true, selectPlaylistId: pl.id }).catch(() => {});
    } else {
      const source =
        document.querySelector('input[name="pl-existing-source"]:checked')?.value ?? 'from-link';
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
      showToast(updateMode === 'replace' ? 'Spellistan ersattes.' : 'Låtar tillagda på spellistan.');
    }
  } catch (e) {
    showToast(String(e?.message ?? e), true);
  } finally {
    $('btn-apply-playlist').disabled = false;
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
  wirePlaylistMode();
  $('new-pl-name').addEventListener('input', () => {
    updateNewPlaylistPreview();
    refreshSummary();
  });
  $('existing-pl-id').addEventListener('input', () => refreshSummary());
  $('existing-pl-select').addEventListener('change', () => refreshSummary());
  $('playlist-prefix').addEventListener('input', () => {
    updateNewPlaylistPreview();
    if (playlistPrefixDebounceTimer) clearTimeout(playlistPrefixDebounceTimer);
    playlistPrefixDebounceTimer = setTimeout(() => {
      playlistPrefixDebounceTimer = null;
      const mode = document.querySelector('input[name="pl-mode"]:checked')?.value;
      const fromList = document.querySelector('input[name="pl-existing-source"]:checked')?.value === 'from-list';
      if (mode === 'existing' && fromList && spotifyClient) {
        refreshExistingPlaylistSelect({ quiet: true }).catch(() => {});
      }
    }, 650);
  });
  $('btn-reset-playlist-prefix').addEventListener('click', () => {
    $('playlist-prefix').value = DEFAULT_PLAYLIST_NAME_PREFIX;
    updateNewPlaylistPreview();
    showToast('Prefix återställt. Spara lokalt om det ska sparas i valvet.');
    const mode = document.querySelector('input[name="pl-mode"]:checked')?.value;
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
    initSpotifyClient();
    updateApplyEnabled();
    void refreshSpotifyUserDisplay().then(() => {
      setAuthStatus();
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
    const pass = getPassphrase();
    if (pass.length >= 8) {
      await saveVault(vaultData, pass);
      showToast('Tokens borttagna från sparad data.');
    } else {
      showToast('Tokens borttagna i minnet. Ange lösenfras och spara för att uppdatera enheten.');
    }
    setAuthStatus();
    updateApplyEnabled();
  });

  $('btn-search').addEventListener('click', () => runSearch());

  $('btn-clear-paste').addEventListener('click', () => {
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

  await handleOAuthReturn();

  const exists = await idbGet(VAULT_KEY);
  initSpotifyClient();
  await refreshSpotifyUserDisplay();
  const vaultHint =
    exists && !vaultData?.tokens?.accessToken
      ? 'Det finns sparad krypterad data. Ange lösenfras och klicka ”Läs in sparad data”.'
      : '';
  setAuthStatus(vaultHint);

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
  setFlowStep('0', { focusPanel: false });
  await registerServiceWorker();
}

boot().catch((e) => showToast(String(e?.message ?? e), true));
