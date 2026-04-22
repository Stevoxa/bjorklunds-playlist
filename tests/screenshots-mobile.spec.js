import { test, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'artifacts', 'screenshots-mobile');

function ensureOut() {
  mkdirSync(outDir, { recursive: true });
}

/** Mobile viewport. Pixel 5 körs via Chromium så vi slipper installera Webkit. */
test.use({
  ...devices['Pixel 5'],
  viewport: { width: 390, height: 800 },
});

test.describe('Mobile screenshots (<=720px breakpoint)', () => {
  test('steg 0 — startsida', async ({ page }) => {
    ensureOut();
    await page.goto('/');
    await page.locator('#flow-step-0').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, '01-step-0.png'), fullPage: false });
    await page.screenshot({ path: join(outDir, '01-step-0-full.png'), fullPage: true });
  });

  test('inställningar', async ({ page }) => {
    ensureOut();
    await page.goto('/');
    await page.getByRole('button', { name: /Inställningar/i }).click();
    await page.locator('#flow-step-settings').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '02-settings-top.png'), fullPage: false });
    await page.screenshot({ path: join(outDir, '02-settings-full.png'), fullPage: true });

    /* Scrolla till botten så vi ser sista kortet + sticky "Tillbaka till flödet". */
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(outDir, '02-settings-bottom.png'), fullPage: false });
  });
});
