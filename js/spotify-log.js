const MAX_LINES = 80;
/** @type {string[]} */
const buffer = [];
/** @type {Set<(line: string | null) => void>} */
const listeners = new Set();

/**
 * @param {unknown} entry Objekt strängifieras som JSON på en rad, eller sträng direkt.
 */
export function logSpotify(entry) {
  const line =
    typeof entry === 'string' ? entry : JSON.stringify(entry, (_, v) => (typeof v === 'bigint' ? String(v) : v));
  buffer.push(line);
  while (buffer.length > MAX_LINES) buffer.shift();
  console.log('[Spotify API]', entry);
  listeners.forEach((fn) => fn(line));
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
  return () => listeners.delete(fn);
}
