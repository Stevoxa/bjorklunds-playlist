const MAX_LINES = 80;
/** @type {string[]} */
const buffer = [];
/** @type {Set<(line: string | null) => void>} */
const listeners = new Set();

/** Nycklar som aldrig får skrivas ut (tokens, client secret, client id, lösenord). */
const SENSITIVE_KEY =
  /^(access[_-]?token|refresh[_-]?token|client[_-]?secret|client[_-]?id|password|passphrase|authorization|code[_-]?verifier)$/i;

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function redactForLog(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((x) => redactForLog(x));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = '[dolt]';
    } else if (v && typeof v === 'object') {
      out[k] = redactForLog(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * @param {unknown} entry Objekt strängifieras som JSON på en rad, eller sträng direkt.
 * Känsliga nycklar (t.ex. access_token) maskeras alltid — logga aldrig hemligheter manuellt i strängar.
 */
export function logSpotify(entry) {
  let line;
  try {
    const safe = typeof entry === 'string' ? entry : redactForLog(entry);
    line =
      typeof safe === 'string' ? safe : JSON.stringify(safe, (_, v) => (typeof v === 'bigint' ? String(v) : v));
  } catch (e) {
    line = JSON.stringify({
      t: new Date().toISOString(),
      kind: 'log_format_error',
      message: String(e?.message ?? e),
    });
  }
  buffer.push(line);
  while (buffer.length > MAX_LINES) buffer.shift();
  console.log('[Spotify API]', line);
  listeners.forEach((fn) => {
    try {
      fn(line);
    } catch {
      /* åhörare får inte stoppa logg */
    }
  });
}

export function clearSpotifyLog() {
  buffer.length = 0;
  listeners.forEach((fn) => fn(null));
}

/**
 * @param {(line: string | null) => void} fn null = rensa visning
 * @returns {() => void} avprenumerera
 */
export function subscribeSpotifyLog(fn) {
  listeners.add(fn);
  try {
    for (const line of buffer) fn(line);
  } catch {
    /* samma som vid notify */
  }
  return () => listeners.delete(fn);
}
