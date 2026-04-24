/**
 * Regenererar app- och favicon-ikoner från media/bjorklunds_playlist_logo_source.png.
 *
 * Källbilden har ~30% transparent padding runt själva Bj-logon, vilket gör att
 * favicon-16/32 blir helt oläsbara (Bj krymper till några pixlar). Vi trimmar bort
 * den transparenta ramen med sharp.trim() och lägger därefter till en liten
 * luftmarginal (%) innan vi skalar ner till varje målstorlek.
 *
 * Körs manuellt vid behov: `node scripts/regen-icons.mjs`
 */
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SOURCE = resolve(ROOT, 'media/bjorklunds_playlist_logo_source.png');
const ICONS_DIR = resolve(ROOT, 'icons');

/**
 * Vanliga icons: 8% inre marginal runt trimmad logga. Maskable-icons:
 * 20% eftersom Android-launchers beskär bort hörn för "safe zone".
 * @typedef {{ name: string, size: number, marginPct: number }} Target
 */
/** @type {Target[]} */
const TARGETS = [
  /* Favicons: 0% margin — logon är redan ~1.37:1 bredare än tall, så den bäddas in
   * i kvadraten med luft top/botten ändå. Ingen anledning att lägga till mer padding. */
  { name: 'favicon-16.png', size: 16, marginPct: 0 },
  { name: 'favicon-32.png', size: 32, marginPct: 0 },
  { name: 'apple-touch-icon.png', size: 180, marginPct: 0.04 },
  { name: 'icon-192.png', size: 192, marginPct: 0.04 },
  { name: 'icon-512.png', size: 512, marginPct: 0.04 },
  /* Maskable-icons behöver 20% safe-zone eftersom Android beskär hörnen. */
  { name: 'icon-maskable-192.png', size: 192, marginPct: 0.2 },
  { name: 'icon-maskable-512.png', size: 512, marginPct: 0.2 },
];

async function trimmedBuffer() {
  /* trim() beskär alla kanter som matchar pixel(0,0). På vår transparenta bakgrund
   * blir det alla helt genomskinliga pixlar — kvar är bbox för själva logon. */
  return sharp(SOURCE).trim().toBuffer();
}

/**
 * @param {Buffer} trimmed
 * @param {Target} target
 */
async function renderOne(trimmed, target) {
  const { name, size, marginPct } = target;
  const inner = Math.round(size * (1 - marginPct * 2));
  const resized = await sharp(trimmed)
    .resize({ width: inner, height: inner, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const pad = Math.round((size - inner) / 2);
  const outPath = resolve(ICONS_DIR, name);
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: resized, top: pad, left: pad }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`  ${name} (${size}x${size}, ${Math.round(marginPct * 100)}% margin)`);
}

async function main() {
  console.log(`Trimming ${SOURCE} …`);
  const trimmed = await trimmedBuffer();
  const meta = await sharp(trimmed).metadata();
  console.log(`  trimmed bbox: ${meta.width}x${meta.height}`);
  console.log(`Writing ${TARGETS.length} icons to ${ICONS_DIR} …`);
  for (const t of TARGETS) {
    await renderOne(trimmed, t);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
