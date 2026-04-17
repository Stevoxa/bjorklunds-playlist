/**
 * Klipper ut ikoner från designblad (ljust tema, vänster halva).
 * Kör: node scripts/extract-sheet-icons.mjs
 *
 * Källa: icons/bild8/kalla/ikoner-och-grafiska-element.png (1024×768, två kolumner).
 */
import sharp from 'sharp';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'icons/bild8/kalla/ikoner-och-grafiska-element.png');
const OUT_DIR = join(root, 'icons/bild8/raster');

/** Ordning = PRODUKTIKONER vänster → höger, rad för rad (5+5+5) enligt bladet */
const PRODUCT_KEYS = [
  'spotify',
  'clipboard',
  'copy',
  'mag',
  'playlist',
  'lightning',
  'link',
  'plus',
  'pencil',
  'tag',
  'gear',
  'mag-refresh',
  'lock',
  'info',
  'check-circle',
];

/** Toppbar (vänster kolumn, under produktblock) */
const TOPBAR_KEYS = ['back', 'bell', 'help'];

/** Synlighet */
const VIS_KEYS = ['eye', 'eye-off'];

async function main() {
  const img = sharp(SRC);
  const { width: W, height: H } = await img.metadata();
  if (!W || !H) throw new Error('Saknar dimensioner');

  const half = Math.floor(W / 2);
  const raw = await img.extract({ left: 0, top: 0, width: half, height: H }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const { data, info } = raw;
  const w = info.width;
  const h = info.height;
  const ch = info.channels;

  /** Horisontell kantenergi per rad (hitta rader med cirkelkonturer) */
  const rowScore = new Float64Array(h);
  for (let y = 1; y < h - 1; y++) {
    let s = 0;
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * ch;
      const cur = data[i];
      const gx = Math.abs(cur - data[i - ch]) + Math.abs(cur - data[i + ch]);
      const gy = Math.abs(cur - data[i - w * ch]) + Math.abs(cur - data[i + w * ch]);
      s += gx + gy;
    }
    rowScore[y] = s / (w - 2);
  }

  /** Finna topp-3 lokala max i mellersta vertikalband (undvik titel längst upp) */
  const y0 = Math.floor(h * 0.12);
  const y1 = Math.floor(h * 0.55);
  let bestY = y0;
  let bestV = 0;
  for (let y = y0; y < y1; y++) {
    if (rowScore[y] > bestV) {
      bestV = rowScore[y];
      bestY = y;
    }
  }
  /** Medel av starka rader ≈ mitten av första ikonraden */
  const strong = [];
  for (let y = y0; y < y1; y++) if (rowScore[y] > bestV * 0.45) strong.push(y);
  const rowCenterY =
    strong.length > 0 ? Math.floor(strong.reduce((a, b) => a + b, 0) / strong.length) : Math.floor(h * 0.28);

  const cell = 86;
  const gutter = 6;
  const cols = 5;
  const rows = 3;
  const gridW = cols * cell + (cols - 1) * gutter;
  const startX = Math.max(8, Math.floor((w - gridW) / 2));
  const startY = Math.max(24, rowCenterY - Math.floor(cell * 0.55));

  mkdirSync(OUT_DIR, { recursive: true });

  const panel = sharp(SRC).extract({ left: 0, top: 0, width: half, height: H });

  let idx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (idx >= PRODUCT_KEYS.length) break;
      const key = PRODUCT_KEYS[idx];
      const left = startX + c * (cell + gutter);
      const top = startY + r * (cell + gutter);
      const out = join(OUT_DIR, `${key}.png`);
      await panel
        .clone()
        .extract({ left, top, width: cell, height: cell })
        .png()
        .toFile(out);
      idx++;
    }
  }

  /** Toppbar-rad: under produktgrid */
  const tbY = startY + rows * (cell + gutter) + 28;
  const tbCell = 52;
  const tbGutter = 16;
  const tbStartX = startX + 20;
  for (let i = 0; i < TOPBAR_KEYS.length; i++) {
    const left = tbStartX + i * (tbCell + tbGutter);
    const top = tbY;
    await panel
      .clone()
      .extract({ left, top, width: tbCell, height: tbCell })
      .png()
      .toFile(join(OUT_DIR, `${TOPBAR_KEYS[i]}.png`));
  }

  /** Öga (synlighet) — plocka från sektion under; grov position */
  const visY = Math.min(h - 70, tbY + tbCell + 120);
  const visCell = 56;
  for (let i = 0; i < VIS_KEYS.length; i++) {
    await panel
      .clone()
      .extract({
        left: tbStartX + i * (visCell + 20),
        top: visY,
        width: visCell,
        height: visCell,
      })
      .png()
      .toFile(join(OUT_DIR, `${VIS_KEYS[i]}.png`));
  }

  /** Övriga symboler: återanvänd närmaste visuellt lika PNG tills manuellt byts */
  const alias = {
    'spotify-mark': 'spotify',
    clock: 'lock',
    bulb: 'info',
    'chevron-down': 'mag',
    list: 'playlist',
    note: 'playlist',
    refresh: 'mag-refresh',
  };
  for (const [to, from] of Object.entries(alias)) {
    const buf = readFileSync(join(OUT_DIR, `${from}.png`));
    writeFileSync(join(OUT_DIR, `${to}.png`), buf);
  }

  const manifest = {
    source: 'icons/bild8/kalla/ikoner-och-grafiska-element.png',
    size: { w: W, h: H },
    lightHalfWidth: half,
    productGrid: { cell, gutter, cols, rows, startX, startY, rowCenterY },
    topbar: { y: tbY, cell: tbCell },
    visibility: { y: visY },
  };
  writeFileSync(join(OUT_DIR, '_extract-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Klart:', OUT_DIR, PRODUCT_KEYS.length + TOPBAR_KEYS.length + VIS_KEYS.length, 'unika + alias');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
