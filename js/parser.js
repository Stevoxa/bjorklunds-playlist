/**
 * @typedef {'freeTextOnly' | 'normal' | 'suspectSwap'} RowClass
 * @typedef {{ raw: string, query: string, artist?: string, title?: string, rowClass: RowClass, swapVotes?: number }} ParsedLine
 */

const DASHES = /[–—\-]/;

/**
 * Typiska "låtsuffix" — förekommer i titlar, sällan i artistnamn.
 * Används för att detektera när parsern placerat ett suffix i fel slot.
 */
const SONG_SUFFIX_RE = /\((feat\.?|live|remix|radio|acoustic|demo|cover|karaoke|instrumental|ver\.?|edit|mix|remastered)\b/i;

/**
 * Röstar fram om parsern troligen satt artist/title i omvänd ordning.
 * Minst 2 röster = behandla som suspectSwap (och prova swap-query först).
 * @param {string} artist Vad parsern kallade artist (första delen av raden).
 * @param {string} title Vad parsern kallade title (andra delen av raden).
 * @returns {number} Antal röster (0-4). >= 2 betyder suspectSwap.
 */
function countSwapVotes(artist, title) {
  const votes = [
    /** Låtsuffix ("(Live)", "(Remix)", "feat.") i artist-slot men inte i title-slot →
     *  parsern har satt titel-suffix i fel slot. */
    SONG_SUFFIX_RE.test(artist) && !SONG_SUFFIX_RE.test(title),
    /** Artist-slot börjar med siffra men inte title-slot: t.ex. "800 Grader - Ebba Grön"
     *  (troligen Title-Artist-ordning där första delen är en titel-siffra). */
    /^\d/.test(artist) && !/^\d/.test(title),
    /** TITLE-slot är ALL CAPS men inte artist-slot: t.ex. "Cake By The Ocean - DNCE".
     *  ALL CAPS är typiskt artist-branding → title-slot är troligen artisten. */
    title.length >= 2 && title === title.toUpperCase() && artist !== artist.toUpperCase(),
    /** Artist-slot lång (≥ 4 ord) och title-slot kort (≤ 2 ord): YouTube-stil "Lång titel - Artist". */
    artist.split(/\s+/).filter(Boolean).length >= 4 &&
      title.split(/\s+/).filter(Boolean).length <= 2,
  ];
  return votes.filter(Boolean).length;
}

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

    /** @type {RowClass} */
    let rowClass;
    /** @type {number | undefined} */
    let swapVotes;
    if (artist && title) {
      swapVotes = countSwapVotes(artist, title);
      rowClass = swapVotes >= 2 ? 'suspectSwap' : 'normal';
    } else {
      rowClass = 'freeTextOnly';
    }

    /** @type {ParsedLine} */
    const lineObj = { raw, query, rowClass };
    if (artist && title) {
      lineObj.artist = artist;
      lineObj.title = title;
      if (typeof swapVotes === 'number') lineObj.swapVotes = swapVotes;
    }
    out.push(lineObj);
  }
  return out;
}
