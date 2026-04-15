/**
 * @typedef {{ raw: string, query: string, artist?: string, title?: string }} ParsedLine
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
    /** @type {string | undefined} */
    let artist;
    /** @type {string | undefined} */
    let title;

    const avMatch = raw.match(/^(.+?)\s+av\s+(.+)$/i);
    if (avMatch) {
      title = avMatch[1].trim();
      artist = avMatch[2].trim();
      query = `${artist} ${title}`;
    } else if (DASHES.test(raw)) {
      const parts = raw.split(DASHES).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        artist = parts[0];
        title = parts.slice(1).join(' ');
        query = `${artist} ${title}`;
      }
    } else {
      const comma = raw.match(/^([^,]+),\s*(.+)$/);
      if (comma) {
        artist = comma[1].trim();
        title = comma[2].trim();
        if (artist && title) {
          query = `${artist} ${title}`;
        }
      }
    }

    const lineObj = { raw, query };
    if (artist && title) {
      lineObj.artist = artist;
      lineObj.title = title;
    }
    out.push(lineObj);
  }
  return out;
}
