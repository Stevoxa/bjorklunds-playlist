/**
 * Statisk röktest: kritiska element-id i index.html + service worker tillgångar.
 * Kör: node tests/smoke-html.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_IDS = [
  'main',
  'paste-area',
  'btn-search',
  'results-section',
  'results-body',
  'spotify-log-pre',
  'client-id',
  'crypto-pass',
  'auth-status',
  'btn-apply-playlist',
  'new-pl-name',
  'existing-pl-id',
  'existing-pl-select',
  'redirect-uri-display',
  'btn-copy-redirect',
  'sum-spotify',
  'sum-tracks',
  'sum-playlist',
  'sum-action',
  'sum-token',
  'sum-foot',
  'sum-tip-text',
  'rate-limit-countdown-wrap',
  'rate-limit-countdown-text',
  'app-page-lead',
  'flow-step-0',
  'flow-step-1',
  'flow-step-2',
  'flow-step-3',
  'flow-step-settings',
  'summary-card-subtitle',
  'sum-foot-token',
  'summary-cta',
  'summary-cta-btn',
  'apply-hint',
];

function main() {
  const indexPath = join(root, 'index.html');
  const swPath = join(root, 'sw.js');
  if (!existsSync(indexPath)) throw new Error(`Saknas: ${indexPath}`);
  const html = readFileSync(indexPath, 'utf8');
  const missing = REQUIRED_IDS.filter((id) => !html.includes(`id="${id}"`));
  if (missing.length) {
    console.error('smoke-html: saknade id i index.html:', missing.join(', '));
    process.exit(1);
  }
  if (!html.includes('css/shell.css')) {
    console.error('smoke-html: index.html länkar inte shell.css');
    process.exit(1);
  }

  const sw = readFileSync(swPath, 'utf8');
  if (!sw.includes("'./css/shell.css'")) {
    console.error('smoke-html: sw.js saknar shell.css i ASSETS');
    process.exit(1);
  }
  if (!sw.includes("'./js/icon-sprite.js'")) {
    console.error('smoke-html: sw.js saknar icon-sprite.js i ASSETS');
    process.exit(1);
  }

  const raster = join(root, 'icons/bild8/raster/clipboard.png');
  if (!existsSync(raster)) {
    console.error('smoke-html: kör npm run icons:sheet (saknas', raster, ')');
    process.exit(1);
  }

  console.log('smoke-html: OK (', REQUIRED_IDS.length, 'id + shell.css + sw + raster)');
}

main();
