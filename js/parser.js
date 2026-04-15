/**
 * @typedef {{ raw: string, query: string }} ParsedLine
 */

const DASHES = /[–—\-]/;

/**
 * @param {string} text
 * @returns {ParsedLine[]}
 */
export function parseTrackList(text) {
  const lines = text.split(/\r?\n/);
  /** @type {ParsedLine[]} */
  const out = [];
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;

    let query = raw;

    const avMatch = raw.match(/^(.+?)\s+av\s+(.+)$/i);
    if (avMatch) {
      const title = avMatch[1].trim();
      const artist = avMatch[2].trim();
      query = `${artist} ${title}`;
    } else if (DASHES.test(raw)) {
      const parts = raw.split(DASHES).map((p) => p.trim());
      if (parts.length >= 2) {
        const [a, b] = [parts[0], parts.slice(1).join(' ')];
        query = `${a} ${b}`;
      }
    }

    out.push({ raw, query });
  }
  return out;
}
