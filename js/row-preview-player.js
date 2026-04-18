/**
 * Förhandslyssning på match-rader (Spotify preview_url + HTML5 Audio).
 * Ingen extra Web API-trafik vid uppspelning — URL kommer från befintligt sök-/cache-svar.
 * Stäng av med FEATURE_ROW_PREVIEW_PLAYER i config.js.
 *
 * Om vi senare lägger till GET /tracks för saknad preview: kör anropet via
 * enqueueAfterSpotifySearchChain från spotify-api.js så det inte parallellkörs med /search.
 */
import { FEATURE_ROW_PREVIEW_PLAYER } from './config.js';

/** Mjuk spärr mellan uppspelningsstart från olika rader (undvik dubbelklick / burst). */
const PLAY_INTENT_GAP_MS = 650;

let wired = false;
/** @type {HTMLElement | null} */
let container = null;
/** @type {() => unknown[]} */
let getRows = () => [];

/** @type {(msg: string, isError?: boolean) => void} */
let showMessage = () => {};

/** @type {HTMLAudioElement | null} */
let audioEl = null;

/** @type {number | null} */
let activeRowIndex = null;

/** @type {string | null} */
let activeSrc = null;

let lastPlayIntentMs = 0;

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
function extractPreviewUrl(track) {
  if (!track || typeof track !== 'object') return null;
  const u = /** @type {{ preview_url?: unknown }} */ (track).preview_url;
  return typeof u === 'string' && u.trim() ? u.trim() : null;
}

function ensureAudio() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'none';
    audioEl.addEventListener('timeupdate', () => {
      syncProgressBars();
      refreshRowPreviewUi();
    });
    audioEl.addEventListener('loadedmetadata', () => {
      syncProgressBars();
      refreshRowPreviewUi();
    });
    audioEl.addEventListener('ended', () => {
      syncProgressBars();
      refreshRowPreviewUi();
    });
    audioEl.addEventListener('play', () => refreshRowPreviewUi());
    audioEl.addEventListener('pause', () => refreshRowPreviewUi());
    audioEl.addEventListener('error', () => {
      if (activeRowIndex == null) return;
      showMessage(
        'Uppspelningen misslyckades (nätverk eller ogiltig förhandslänk). Prova igen eller öppna spåret i Spotify.',
        true,
      );
      stopRowPreview();
    });
  }
  return audioEl;
}

function syncProgressBars() {
  if (!container) return;
  container.querySelectorAll('.match-block').forEach((article) => {
    const idx = Number(article.dataset.rowIndex);
    const range = article.querySelector('.row-preview__range');
    if (!(range instanceof HTMLInputElement)) return;
    if (idx === activeRowIndex && audioEl && Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
      range.value = String(Math.min(1, Math.max(0, audioEl.currentTime / audioEl.duration)));
    } else if (idx !== activeRowIndex) {
      range.value = '0';
    }
  });
}

function refreshRowPreviewUi() {
  if (!FEATURE_ROW_PREVIEW_PLAYER || !container) return;
  const rows = /** @type {unknown[]} */ (getRows());
  const playing = Boolean(audioEl && !audioEl.paused && !audioEl.ended && activeRowIndex !== null);

  container.querySelectorAll('.match-block').forEach((article) => {
    const idx = Number(article.dataset.rowIndex);
    const row = rows[idx];
    const track = getSelectedTrackFromRow(row);
    const url = extractPreviewUrl(track);
    const playBtn = article.querySelector('.row-preview__play');
    const range = article.querySelector('.row-preview__range');
    const isActive = activeRowIndex === idx;
    const durOk = Boolean(audioEl && Number.isFinite(audioEl.duration) && audioEl.duration > 0);

    if (playBtn instanceof HTMLButtonElement) {
      playBtn.disabled = !url;
      playBtn.title = url
        ? 'Spela förhandslyssning för vald träff (kort klipp från Spotify)'
        : 'Ingen förhandslyssning från Spotify för den här träffen — välj annan version eller öppna i Spotify.';
      const on = playing && isActive;
      playBtn.classList.toggle('row-preview__play--on', on);
      playBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (range instanceof HTMLInputElement) {
      range.disabled = !url || !isActive || !durOk;
    }
  });
}

/**
 * @param {HTMLElement} resultsBody
 * @param {{ getRows: () => unknown[], showMessage: (msg: string, isError?: boolean) => void }} opts
 */
export function bindRowPreviewControls(resultsBody, opts) {
  if (!FEATURE_ROW_PREVIEW_PLAYER || wired) return;
  wired = true;
  container = resultsBody;
  getRows = opts.getRows;
  showMessage = opts.showMessage;
  resultsBody.addEventListener('click', onResultsClick);
  resultsBody.addEventListener('input', onRangeInput);
}

/** @param {Event} e */
function onResultsClick(e) {
  if (!FEATURE_ROW_PREVIEW_PLAYER) return;
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.closest('.row-preview__stop')) {
    e.preventDefault();
    stopRowPreview();
    return;
  }
  const playBtn = t.closest('.row-preview__play');
  if (!playBtn) return;
  e.preventDefault();
  const article = playBtn.closest('.match-block');
  if (!article) return;
  const rowIndex = Number(article.dataset.rowIndex);
  if (Number.isNaN(rowIndex)) return;

  const rows = /** @type {unknown[]} */ (getRows());
  const row = rows[rowIndex];
  const track = getSelectedTrackFromRow(row);
  const url = extractPreviewUrl(track);
  if (!url) {
    showMessage(
      'Spotify skickade ingen förhandslyssning för valt spår (vanligt). Välj en annan träff eller öppna låten i Spotify.',
      true,
    );
    return;
  }

  const a = ensureAudio();
  const needNewSrc = activeSrc !== url || activeRowIndex !== rowIndex;
  const now = Date.now();
  if (needNewSrc && activeRowIndex !== null && activeRowIndex !== rowIndex && now - lastPlayIntentMs < PLAY_INTENT_GAP_MS) {
    showMessage('Vänta en kort stund innan du byter rad.', false);
    return;
  }
  if (needNewSrc) lastPlayIntentMs = now;

  void (async () => {
    if (needNewSrc) {
      activeRowIndex = rowIndex;
      activeSrc = url;
      a.src = url;
      try {
        a.currentTime = 0;
      } catch {
        /* vissa webbläsare före loadedmetadata */
      }
    } else {
      activeRowIndex = rowIndex;
    }
    try {
      await a.play();
    } catch {
      showMessage(
        'Kunde inte starta uppspelningen (webbläsaren kan kräva ett nytt klick efter sidladdning).',
        true,
      );
      stopRowPreview();
    }
    refreshRowPreviewUi();
    syncProgressBars();
  })();
}

/** @param {Event} e */
function onRangeInput(e) {
  if (!FEATURE_ROW_PREVIEW_PLAYER || !audioEl) return;
  const r = /** @type {HTMLElement} */ (e.target).closest('.row-preview__range');
  if (!(r instanceof HTMLInputElement)) return;
  const article = r.closest('.match-block');
  if (!article) return;
  const idx = Number(article.dataset.rowIndex);
  if (idx !== activeRowIndex) return;
  const dur = audioEl.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;
  const frac = Number(r.value);
  if (!Number.isFinite(frac)) return;
  audioEl.currentTime = Math.min(dur, Math.max(0, frac * dur));
}

export function stopRowPreview() {
  activeRowIndex = null;
  activeSrc = null;
  if (!audioEl) return;
  audioEl.pause();
  audioEl.removeAttribute('src');
  try {
    audioEl.load();
  } catch {
    /* ok */
  }
  syncProgressBars();
  refreshRowPreviewUi();
}

/** Anrop när användaren byter vald träff på en rad (radio). */
export function notifyRowPreviewTrackChanged(rowIndex) {
  if (!FEATURE_ROW_PREVIEW_PLAYER) return;
  if (activeRowIndex === rowIndex) stopRowPreview();
}

/** Efter renderResults när DOM för listan byggts om. */
export function afterRenderRowPreview() {
  if (!FEATURE_ROW_PREVIEW_PLAYER) return;
  syncProgressBars();
  refreshRowPreviewUi();
}
