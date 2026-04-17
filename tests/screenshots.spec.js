import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'artifacts', 'screenshots');

function ensureOut() {
  mkdirSync(outDir, { recursive: true });
}

test.describe('UI screenshots (headless)', () => {
  test('steg 0 — startsida', async ({ page }) => {
    ensureOut();
    await page.goto('/');
    await page.locator('#flow-step-0').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, '01-step-0.png'), fullPage: true });
  });

  test('steg 1 — låtar', async ({ page }) => {
    ensureOut();
    await page.goto('/');
    await page.getByRole('button', { name: 'Välj musik' }).click();
    await page.locator('#flow-step-1').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '02-step-1-tracks.png'), fullPage: true });
  });

  test('steg 2 — spellista', async ({ page }) => {
    ensureOut();
    await page.goto('/');
    await page.getByRole('button', { name: 'Välj spellista' }).click();
    await page.locator('#flow-step-2').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '03-step-2-playlist.png'), fullPage: true });
  });

  test('steg 3 — åtgärd', async ({ page }) => {
    ensureOut();
    await page.goto('/');
    await page.getByRole('button', { name: 'Genomför' }).click();
    await page.locator('#flow-step-3').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '04-step-3-action.png'), fullPage: true });
  });

  test('inställningar', async ({ page }) => {
    ensureOut();
    await page.goto('/');
    await page.getByRole('button', { name: /Inställningar/i }).click();
    await page.locator('#flow-step-settings').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '05-settings.png'), fullPage: true });
  });
});
