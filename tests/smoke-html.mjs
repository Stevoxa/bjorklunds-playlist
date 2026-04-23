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
  'auth-status',
  'btn-apply-playlist',
  'new-pl-name',
  'new-pl-description',
  'new-pl-visibility',
  'existing-pl-id',
  'existing-pl-select',
  'existing-pl-truncated-warning',
  'existing-pl-updated-at',
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
  'flow-step-landing',
  'flow-step-0',
  'flow-step-1',
  'flow-step-2',
  'flow-step-3',
  'flow-step-select-playlist',
  'flow-step-edit-playlist',
  'flow-step-settings',
  'flow-breadcrumbs-list',
  'btn-step-0-next',
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
  'pref-developer-mode',
  'btn-settings-back-to-flow',
  'select-playlist-list',
  'select-playlist-filter-input',
  'select-playlist-prefix-toggle',
  'select-playlist-prefix-label',
  'select-playlist-refresh',
  'select-playlist-updated',
  'select-playlist-truncated-warning',
  'select-playlist-spinner',
  'select-playlist-empty',
  'edit-playlist-selected-name',
  'edit-playlist-refresh',
  'edit-playlist-spinner',
  'edit-playlist-empty',
  'edit-playlist-truncated-warning',
  'edit-playlist-blocked',
  'btn-edit-playlist-blocked-back',
  'edit-playlist-total-row',
  'edit-playlist-status-row',
  'edit-playlist-readonly-note',
  'edit-playlist-dirty-block',
  'edit-playlist-updated',
  'edit-playlist-list',
  'edit-playlist-art',
  'edit-playlist-art-fallback',
  'edit-playlist-owner',
  'edit-playlist-total',
  'edit-playlist-bulk-bar',
  'edit-playlist-bulk-count',
  'btn-edit-playlist-remove',
  'btn-edit-playlist-copy',
  'btn-edit-playlist-select-all',
  'btn-edit-playlist-clear-selection',
  'btn-edit-playlist-delete',
  'btn-edit-playlist-apply',
  'edit-playlist-progress',
  'edit-playlist-progress-label',
  'edit-playlist-progress-fill',
  'btn-edit-playlist-progress-cancel',
  'edit-playlist-dirty-hint',
  'edit-playlist-delete-dialog',
  'edit-playlist-delete-dialog-title',
  'edit-playlist-delete-dialog-text',
  'edit-playlist-delete-dialog-name',
  'edit-playlist-delete-dialog-error',
  'btn-edit-playlist-delete-cancel',
  'btn-edit-playlist-delete-confirm',
  'edit-playlist-heavy-dialog',
  'edit-playlist-heavy-dialog-text',
  'btn-edit-playlist-heavy-cancel',
  'btn-edit-playlist-heavy-confirm',
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
  if (!sw.includes("'./vendor/sortable.min.js'")) {
    console.error('smoke-html: sw.js saknar vendor/sortable.min.js i ASSETS');
    process.exit(1);
  }
  if (!sw.includes("'./js/playlist-tracks-cache.js'")) {
    console.error('smoke-html: sw.js saknar js/playlist-tracks-cache.js i ASSETS');
    process.exit(1);
  }
  const sortablePath = join(root, 'vendor', 'sortable.min.js');
  if (!existsSync(sortablePath)) {
    console.error('smoke-html: saknar vendor/sortable.min.js lokalt');
    process.exit(1);
  }

  console.log('smoke-html: OK (', REQUIRED_IDS.length, 'id + shell.css + sw + sortable)');
}

main();
