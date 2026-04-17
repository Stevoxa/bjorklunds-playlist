import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const start = html.indexOf('<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true"');
const end = html.indexOf('</svg>', start);
if (start === -1 || end === -1) throw new Error('sprite block not found');
const openTagEnd = html.indexOf('>', start) + 1;
const inner = html.slice(openTagEnd, end);
const out = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${inner}</svg>`;
mkdirSync(join(root, 'icons', 'bild8'), { recursive: true });
writeFileSync(join(root, 'icons', 'ui-sprite-backup.svg'), out);
writeFileSync(join(root, 'icons', 'bild8', 'product-icons.svg'), out);
console.log('OK:', out.length, 'bytes');
