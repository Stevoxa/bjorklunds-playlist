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

/** @type {object | null} */
let vaultData = null;

/**
 * tracks: null = Spotify-sökning ej körd, [] = sökt men inget, annars träfflista
 * @type {{ raw: string, query: string, artist?: string, title?: string, tracks: object[] | null, selectedUri: string | null }[]}
 */
let resultRows = [];

/** När true: rader utan `tracks` visar ”Söker…” i stället för inaktiv hjälptext */
let searchInProgress = false;

/** @type {AbortController | null} */
let searchAbortController = null;

const SPOTIFY_CHUNK = 100;

/** Paus mellan rader efter svar (ms), med liten jitter — minskar risk för 429 i rullande 30 s-fönster */
const SEARCH_ROW_GAP_MS = 750;
const SEARCH_ROW_JITTER_MS = 300;

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
    showToast('Data läst in.');
    setAuthStatus();
    updateApplyEnabled();
  } catch {
    showToast('Kunde inte läsa valvet. Fel lösenfras?', true);
  }
}

function initSpotifyClient() {
  spotifyClient = null;
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

function setAuthStatus() {
  const el = $('auth-status');
  if (!vaultData?.tokens?.accessToken) {
    el.textContent = 'Inte inloggad på Spotify.';
    return;
  }
  const cid = (vaultData.clientId || '').trim() || getClientId().trim();
  if (!cid) {
    el.textContent =
      'Tokens finns men Client ID saknas i minnet (vanligt efter omdirigering). Ange Client ID i fältet ovan — det fylls i automatiskt nästa gång du sparar.';
    return;
  }
  const exp = new Date(vaultData.tokens.expiresAt).toLocaleString('sv-SE');
  const gs = (vaultData.tokens.grantedScopeRaw || '').trim();
  const hasPlaylistScope =
    gs.includes('playlist-modify-public') || gs.includes('playlist-modify-private');
  let lines = `Inloggad. Access token giltig till cirka ${exp}.`;
  if (gs) {
    lines += `\nBeviljade rättigheter (från Spotify): ${gs}`;
  } else {
    lines +=
      '\nOBS: Spotify skickade ingen scope-lista i token-svaret (ovanligt). Om spellistor nekas, logga in igen efter att du återkallat appen (länk i checklistan nedan).';
  }
  if (gs && !hasPlaylistScope) {
    lines +=
      '\nOBS: Denna token saknar playlist-modify-public/private — spellistor kan inte skapas eller ändras. Återkalla appen under spotify.com/account/apps och logga in igen i denna app.';
  }
  el.textContent = lines;
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
  setAuthStatus();
  updateApplyEnabled();
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

function setTab(name) {
  const tracksTab = $('tab-tracks');
  const settingsTab = $('tab-settings');
  const tracksPanel = $('panel-tracks');
  const settingsPanel = $('panel-settings');
  const isTracks = name === 'tracks';
  tracksTab.classList.toggle('is-active', isTracks);
  settingsTab.classList.toggle('is-active', !isTracks);
  tracksTab.setAttribute('aria-selected', String(isTracks));
  settingsTab.setAttribute('aria-selected', String(!isTracks));
  tracksPanel.classList.toggle('is-visible', isTracks);
  tracksPanel.hidden = !isTracks;
  settingsPanel.classList.toggle('is-visible', !isTracks);
  settingsPanel.hidden = isTracks;
}

function wireTabs() {
  document.querySelectorAll('.tabs__tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-tab') ?? 'tracks';
      setTab(name);
      if (name === 'tracks') {
        initSpotifyClient();
        updateApplyEnabled();
        updateNewPlaylistPreview();
        if (resultRows.length > 0) renderResults();
      }
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

async function refreshExistingPlaylistSelect() {
  if (!spotifyClient) {
    showToast('Logga in på Spotify under Inställningar först.', true);
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
  showToast(list.length ? `${list.length} spellistor med prefix.` : 'Inga spellistor matchar prefixet.');
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
    }
  };
  modes.forEach((r) => r.addEventListener('change', update));
  document.querySelectorAll('input[name="pl-existing-source"]').forEach((r) => {
    r.addEventListener('change', () => {
      updateExistingPlaylistSourceUi();
      if (r.value === 'from-list' && spotifyClient) {
        refreshExistingPlaylistSelect().catch((e) => showToast(String(e?.message ?? e), true));
      }
    });
  });
  $('btn-refresh-pl-list').addEventListener('click', () => {
    refreshExistingPlaylistSelect().catch((e) => showToast(String(e?.message ?? e), true));
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
    chk.checked = hasHits;
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
}

function updateApplyEnabled() {
  $('btn-apply-playlist').disabled = resultRows.length === 0 || !spotifyClient;
  const busy = searchInProgress;
  $('btn-search').disabled = !spotifyClient || busy;
  $('btn-clear-paste').disabled = busy;
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
    showToast('Logga in på Spotify under Inställningar först.', true);
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
  resultRows = parsed.map((p) => ({ ...p, tracks: null, selectedUri: null }));
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
      if (i < resultRows.length - 1) {
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
      showToast(String(e?.message ?? e), true);
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

  wireTabs();
  wirePlaylistMode();
  $('new-pl-name').addEventListener('input', updateNewPlaylistPreview);
  $('playlist-prefix').addEventListener('input', updateNewPlaylistPreview);
  $('btn-reset-playlist-prefix').addEventListener('click', () => {
    $('playlist-prefix').value = DEFAULT_PLAYLIST_NAME_PREFIX;
    updateNewPlaylistPreview();
    showToast('Prefix återställt. Spara lokalt om det ska sparas i valvet.');
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
    setAuthStatus();
    updateApplyEnabled();
    if (resultRows.length > 0) renderResults();
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
      if (!c.disabled) c.checked = true;
    });
  });
  $('btn-clear-selection').addEventListener('click', () => {
    document.querySelectorAll('.row-select').forEach((c) => {
      c.checked = false;
    });
  });

  $('btn-apply-playlist').addEventListener('click', () => applyPlaylist());

  await handleOAuthReturn();

  const exists = await idbGet(VAULT_KEY);
  setAuthStatus();
  if (exists && !vaultData?.tokens?.accessToken) {
    $('auth-status').textContent +=
      ' Det finns sparad krypterad data. Ange lösenfras och klicka ”Läs in sparad data”.';
  }

  applyTheme($('pref-theme').value);
  updateNewPlaylistPreview();
  updateApplyEnabled();
  await registerServiceWorker();
}

boot().catch((e) => showToast(String(e?.message ?? e), true));
