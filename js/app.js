import { getRedirectUri, beginLogin, consumeOAuthCallback } from './auth.js';
import { loadVault, saveVault, VAULT_KEY } from './vault.js';
import { idbGet } from './db.js';
import { parseTrackList } from './parser.js';
import { createSpotifyClient, parsePlaylistIdFromInput } from './spotify-api.js';

/** @type {ReturnType<createSpotifyClient> | null} */
let spotifyClient = null;

/** @type {object | null} */
let vaultData = null;

/** @type {{ raw: string, query: string, tracks: object[], selectedUri: string | null }[]} */
let resultRows = [];

const SPOTIFY_CHUNK = 100;

function defaultVault() {
  return {
    v: 1,
    clientId: '',
    tokens: null,
    settings: { theme: 'system' },
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
  t.textContent = message;
  t.hidden = false;
  if (isError) t.style.background = '#c62828';
  else t.style.background = '';
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    t.hidden = true;
  }, 5000);
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
  vaultData.settings = { theme: $('pref-theme').value };
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
    $('client-id').value = vaultData.clientId ?? '';
    $('pref-theme').value = vaultData.settings?.theme ?? 'system';
    applyTheme($('pref-theme').value);
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
  if (!vaultData?.tokens?.accessToken || !vaultData?.clientId) return;
  spotifyClient = createSpotifyClient(vaultData.tokens, vaultData.clientId, (t) => {
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
  const exp = new Date(vaultData.tokens.expiresAt).toLocaleString('sv-SE');
  el.textContent = `Inloggad. Access token giltig till cirka ${exp}.`;
}

/**
 * @param {object} tokens
 */
function mergeOAuthTokens(tokens) {
  if (!tokens) return;
  vaultData = vaultData ?? defaultVault();
  vaultData.tokens = tokens;
  vaultData.clientId = getClientId() || vaultData.clientId;
  initSpotifyClient();
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
  mergeOAuthTokens(result.tokens);
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
    btn.addEventListener('click', () => setTab(btn.getAttribute('data-tab') ?? 'tracks'));
  });
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
  };
  modes.forEach((r) => r.addEventListener('change', update));
  update();
}

function renderResults() {
  const tbody = $('results-body');
  tbody.replaceChildren();
  let matched = 0;
  resultRows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    const tdRaw = document.createElement('td');
    tdRaw.textContent = row.raw;
    const tdQ = document.createElement('td');
    tdQ.textContent = row.query;
    const tdMatch = document.createElement('td');
    if (row.tracks.length === 0) {
      tdMatch.textContent = 'Ingen träff';
      tdMatch.classList.add('row-muted');
    } else {
      matched += 1;
      const pickId = `pick-${idx}`;
      const wrap = document.createElement('div');
      wrap.className = 'match-stack';
      row.tracks.forEach((t, ti) => {
        const label = document.createElement('label');
        label.className = 'radio-label';
        label.style.width = '100%';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = pickId;
        radio.value = t.uri;
        radio.checked = row.selectedUri === t.uri || (row.selectedUri === null && ti === 0);
        radio.addEventListener('change', () => {
          row.selectedUri = t.uri;
        });
        const nameSpan = document.createElement('span');
        nameSpan.className = 'match-name';
        nameSpan.textContent = t.name ?? '';
        const metaSpan = document.createElement('span');
        metaSpan.className = 'match-meta';
        metaSpan.textContent = ` — ${(t.artists || []).map((a) => a.name).join(', ')}`;
        const span = document.createElement('span');
        span.append(nameSpan, metaSpan);
        label.append(radio, span);
        wrap.append(label);
      });
      tdMatch.append(wrap);
      if (row.selectedUri === null && row.tracks[0]) row.selectedUri = row.tracks[0].uri;
    }
    const tdChk = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = row.tracks.length > 0;
    chk.disabled = row.tracks.length === 0;
    chk.dataset.rowIndex = String(idx);
    chk.classList.add('row-select');
    tdChk.append(chk);
    tr.append(tdRaw, tdQ, tdMatch, tdChk);
    tbody.append(tr);
  });
  $('results-summary').textContent = `${resultRows.length} rader, ${matched} med minst en träff.`;
  $('results-section').hidden = resultRows.length === 0;
  updateApplyEnabled();
}

function updateApplyEnabled() {
  $('btn-apply-playlist').disabled = resultRows.length === 0 || !spotifyClient;
  $('btn-search').disabled = resultRows.length === 0 || !spotifyClient;
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
  if (resultRows.length === 0) {
    showToast('Inga rader att söka.', true);
    return;
  }
  $('btn-search').disabled = true;
  try {
    for (let i = 0; i < resultRows.length; i += 1) {
      const row = resultRows[i];
      row.tracks = await spotifyClient.searchTracks(row.query, 5);
      row.selectedUri = row.tracks[0]?.uri ?? null;
      await new Promise((r) => setTimeout(r, 350));
    }
    renderResults();
    showToast('Sökning klar.');
  } catch (e) {
    showToast(String(e?.message ?? e), true);
  } finally {
    $('btn-search').disabled = false;
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
    const me = await spotifyClient.me();
    if (mode === 'new') {
      const name = $('new-pl-name').value.trim() || 'Ny spellista';
      const isPublic = $('new-pl-public').checked;
      const pl = await spotifyClient.createPlaylist(me.id, { name, isPublic });
      for (let i = 0; i < uris.length; i += SPOTIFY_CHUNK) {
        await spotifyClient.appendPlaylistTracks(pl.id, uris.slice(i, i + SPOTIFY_CHUNK));
      }
      vaultData.selectedPlaylist = { id: pl.id, name: pl.name };
      const pass = getPassphrase();
      if (pass.length >= 8) await saveVault(vaultData, pass);
      showToast(`Spellistan ”${pl.name}” skapades med ${uris.length} låtar.`);
    } else {
      const rawId = $('existing-pl-id').value;
      const plId = parsePlaylistIdFromInput(rawId);
      if (!plId) {
        showToast('Ogiltigt spelliste-ID.', true);
        return;
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
      vaultData.selectedPlaylist = { id: plId, name: vaultData.selectedPlaylist?.name ?? plId };
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

  wireTabs();
  wirePlaylistMode();

  $('pref-theme').addEventListener('change', () => {
    applyTheme($('pref-theme').value);
  });

  $('btn-save-settings').addEventListener('click', () => saveEncryptedVault());
  $('btn-load-vault').addEventListener('click', () => loadEncryptedVault());

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
    vaultData.settings = { theme: $('pref-theme').value };
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

  $('btn-parse').addEventListener('click', () => {
    const parsed = parseTrackList($('paste-area').value);
    resultRows = parsed.map((p) => ({ ...p, tracks: [], selectedUri: null }));
    $('btn-search').disabled = resultRows.length === 0;
    renderResults();
    showToast(parsed.length ? `${parsed.length} rader klara för sökning.` : 'Inga rader hittades.', !parsed.length);
  });

  $('btn-search').addEventListener('click', () => runSearch());

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
  updateApplyEnabled();
  await registerServiceWorker();
}

boot().catch((e) => showToast(String(e?.message ?? e), true));
