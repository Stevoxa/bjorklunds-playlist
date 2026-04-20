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
  'btn-flow-step-1-next',
  'btn-flow-step-2-next',
  'flow-step-1-sticky-hint',
  'flow-step-2-sticky-hint',
  'results-body',
  'spotify-log-pre',
  'client-id',
  'crypto-pass',
  'auth-status',
  'btn-apply-playlist',
  'new-pl-name',
  'new-pl-description',
  'new-pl-visibility',
  'existing-pl-id',
  'existing-pl-select',
  'redirect-uri-display',
  'btn-copy-redirect',
  'sum-spotify',
  'sum-tracks',
  'sum-playlist',
  'sum-action',
  'sum-row-update-method',
  'sum-update-method',
  'step3-sum-spotify',
  'step3-sum-row-update-method',
  'step3-sum-update-method',
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
  'apply-hint',
  'playlist-result-dialog',
  'playlist-result-dialog-title',
  'playlist-result-dialog-message',
  'playlist-result-dialog-link',
  'btn-playlist-result-close',
  'step3-apply-result-card',
  'step3-apply-result-title',
  'step3-apply-result-message',
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

  console.log('smoke-html: OK (', REQUIRED_IDS.length, 'id + shell.css + sw)');
}

main();
