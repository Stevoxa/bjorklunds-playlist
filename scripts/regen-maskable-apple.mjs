/**
 * Bygger om maskable- och Apple-touch-ikoner utifrån dina befintliga app-ikoner
 * (t.ex. icon-512.png efter manuell utbyte).
 *
 * Spec (kort):
 * - icon-maskable-*.png: Solid bakgrund = manifest `background_color` (#f4f7f9) så
 *   Android/PWA-masker (cirkel, squircle) inte klipper viktiga delar. Loggan skalas
 *   in i ~62 % av kantlängden (≈19 % marginal per sida = typisk "safe zone").
 * - apple-touch-icon.png: 180×180, vit bakgrund (iOS fyller transparent med svart).
 *   Loggan ~78 % av sidan så iOS-rundning inte tar i kanterna.
 *
 * Källfil: största av icon-674.png, icon-512.png, icon-192.png som finns.
 * Överskriv: ICON_SOURCE=icons/min_master.png node scripts/regen-maskable-apple.mjs
 */
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ICONS_DIR = resolve(ROOT, 'icons');

/** Matchar manifest.webmanifest background_color */
const MASKABLE_BG = '#f4f7f9';
const APPLE_BG = '#ffffff';

/** Andel av canvas där logotypen får plats (contain), resten = luft mot mask */
const MASKABLE_INNER = 0.62;
const APPLE_INNER = 0.78;

function hexToRgba(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    alpha: 1,
  };
}

async function pickSourcePath() {
  const env = process.env.ICON_SOURCE;
  if (env) {
    const p = resolve(ROOT, env);
    if (!existsSync(p)) throw new Error(`ICON_SOURCE saknas: ${p}`);
    return p;
  }
  const candidates = ['icon-674.png', 'icon-512.png', 'icon-192.png'].map((f) => resolve(ICONS_DIR, f));
  let best = null;
  let bestArea = 0;
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const m = await sharp(p).metadata();
    const w = m.width ?? 0;
    const h = m.height ?? 0;
    const area = w * h;
    if (area > bestArea) {
      bestArea = area;
      best = p;
    }
  }
  if (!best) throw new Error('Hittade ingen källikon (icon-512.png / icon-192.png) i icons/');
  return best;
}

/**
 * @param {string} sourcePath
 * @param {number} size
 * @param {string} bgHex
 * @param {number} innerRatio 0–1, logotypens max bbox relativt canvas
 * @param {string} outName
 */
async function renderSquare(sourcePath, size, bgHex, innerRatio, outName) {
  const bg = hexToRgba(bgHex);
  const inner = Math.round(size * innerRatio);
  const resized = await sharp(sourcePath)
    .resize({
      width: inner,
      height: inner,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();
  const meta = await sharp(resized).metadata();
  const w = meta.width ?? inner;
  const h = meta.height ?? inner;
  const left = Math.round((size - w) / 2);
  const top = Math.round((size - h) / 2);
  const outPath = resolve(ICONS_DIR, outName);
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: bg,
    },
  })
    .composite([{ input: resized, left, top }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`  ${outName} (${size}×${size}, inner ${inner}px, bg ${bgHex})`);
}

async function main() {
  const source = await pickSourcePath();
  const sm = await sharp(source).metadata();
  console.log(`Källa: ${source} (${sm.width}×${sm.height})`);
  console.log(`Skriver till ${ICONS_DIR} …`);
  await renderSquare(source, 192, MASKABLE_BG, MASKABLE_INNER, 'icon-maskable-192.png');
  await renderSquare(source, 512, MASKABLE_BG, MASKABLE_INNER, 'icon-maskable-512.png');
  await renderSquare(source, 180, APPLE_BG, APPLE_INNER, 'apple-touch-icon.png');
  console.log('Klart.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
