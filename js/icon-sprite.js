import { ICON_SPRITE_MODE, ICON_SPRITE_EXTERNAL_HREF } from './config.js';

let queryIconOverrideApplied = false;

/**
 * Läs query ?icons=external | ?icons=inline (sätter sessionStorage) en gång per sidladdning.
 */
function applyQueryIconOverrideOnce() {
  if (queryIconOverrideApplied) return;
  queryIconOverrideApplied = true;
  try {
    const q = new URLSearchParams(window.location.search).get('icons');
    if (q === 'external' || q === 'bild8') sessionStorage.setItem('iconSpriteMode', 'external');
    if (q === 'inline') sessionStorage.setItem('iconSpriteMode', 'inline');
  } catch {
    /* private mode */
  }
}

/** @returns {'inline' | 'external'} */
export function getIconSpriteMode() {
  applyQueryIconOverrideOnce();
  let m = ICON_SPRITE_MODE;
  try {
    const s = sessionStorage.getItem('iconSpriteMode');
    if (s === 'inline' || s === 'external') m = s;
  } catch {
    /* */
  }
  return m === 'external' ? 'external' : 'inline';
}

/**
 * @param {string} fragment t.ex. '#sym-eye' eller 'sym-eye'
 * @returns {string} href för <use>
 */
export function resolveIconHref(fragment) {
  const id = fragment.startsWith('#') ? fragment : `#${fragment}`;
  if (getIconSpriteMode() !== 'external') return id;
  return `${ICON_SPRITE_EXTERNAL_HREF}${id}`;
}

/** Peka alla <use href="#sym-…"> mot extern SVG (bild 8-export med samma symbol-id). */
export function applyIconSpriteMode() {
  const mode = getIconSpriteMode();
  document.documentElement.setAttribute('data-icon-sprite', mode);
  if (mode !== 'external') return;
  const base = ICON_SPRITE_EXTERNAL_HREF;
  document.querySelectorAll('use[href^="#sym-"]').forEach((use) => {
    const href = use.getAttribute('href');
    if (!href?.startsWith('#sym-')) return;
    use.setAttribute('href', `${base}${href}`);
  });
}
