import {
  ICON_DISPLAY_MODE,
  ICON_RASTER_BASE,
  ICON_SPRITE_MODE,
  ICON_SPRITE_EXTERNAL_HREF,
} from './config.js';

let queryOverridesApplied = false;

/**
 * ?icons=raster | png | bild8 → PNG från designblad
 * ?icons=svg | inline → SVG-sprite (inline eller se nedan)
 * ?icons=external → SVG från product-icons.svg
 */
function applyQueryOverridesOnce() {
  if (queryOverridesApplied) return;
  queryOverridesApplied = true;
  try {
    const q = new URLSearchParams(window.location.search).get('icons');
    if (q === 'raster' || q === 'png' || q === 'bild8') sessionStorage.setItem('iconDisplayMode', 'raster');
    if (q === 'svg' || q === 'inline') {
      sessionStorage.setItem('iconDisplayMode', 'svg');
      if (q === 'inline') sessionStorage.setItem('iconSpriteMode', 'inline');
    }
    if (q === 'external') {
      sessionStorage.setItem('iconDisplayMode', 'svg');
      sessionStorage.setItem('iconSpriteMode', 'external');
    }
  } catch {
    /* */
  }
}

/** @returns {'svg' | 'raster'} */
export function getIconDisplayMode() {
  applyQueryOverridesOnce();
  try {
    const s = sessionStorage.getItem('iconDisplayMode');
    if (s === 'raster' || s === 'svg') return s;
  } catch {
    /* */
  }
  return ICON_DISPLAY_MODE === 'raster' ? 'raster' : 'svg';
}

/** @returns {'inline' | 'external'} — endast när display är svg */
export function getIconSpriteMode() {
  applyQueryOverridesOnce();
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
 * @param {string} slug t.ex. "clipboard" (utan .png)
 * @returns {string}
 */
export function rasterIconSrc(slug) {
  const clean = slug.replace(/^sym-/, '').replace(/^\//, '');
  return `${ICON_RASTER_BASE}${clean}.png`;
}

/**
 * @param {string} fragment t.ex. '#sym-eye' eller 'sym-eye'
 * @returns {string} href för <use>
 */
export function resolveIconHref(fragment) {
  const id = fragment.startsWith('#') ? fragment : `#${fragment}`;
  if (getIconDisplayMode() === 'raster') return id;
  if (getIconSpriteMode() !== 'external') return id;
  return `${ICON_SPRITE_EXTERNAL_HREF}${id}`;
}

/**
 * Byter <svg><use href="#sym-…"> mot <img> (raster) eller uppdaterar <use> för extern SVG.
 * Kör först i boot().
 */
export function applyIconDisplay() {
  const display = getIconDisplayMode();
  document.documentElement.setAttribute('data-icon-display', display);

  if (display === 'raster') {
    document.documentElement.setAttribute('data-icon-sprite', 'none');
    document.querySelectorAll('use[href^="#sym-"]').forEach((use) => {
      const href = use.getAttribute('href');
      if (!href?.startsWith('#sym-')) return;
      const slug = href.slice(5);
      const svg = use.closest('svg');
      if (!svg) return;

      const w = parseInt(svg.getAttribute('width') || '', 10) || parseInt(svg.getAttribute('height') || '', 10) || 24;
      const h = parseInt(svg.getAttribute('height') || '', 10) || parseInt(svg.getAttribute('width') || '', 10) || w;

      const img = document.createElement('img');
      const cls = (svg.getAttribute('class') || '').trim();
      img.className = cls ? `ui-icon ${cls}` : 'ui-icon';
      if (slug === 'spotify' || slug === 'spotify-mark') img.classList.add('ui-icon--spotify');
      img.src = rasterIconSrc(slug);
      img.width = w;
      img.height = h;
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.decoding = 'async';
      svg.replaceWith(img);
    });
    return;
  }

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

/** @deprecated använd applyIconDisplay */
export function applyIconSpriteMode() {
  applyIconDisplay();
}
