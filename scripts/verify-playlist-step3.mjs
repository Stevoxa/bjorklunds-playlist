/**
 * Verifierar att steg 3 visar rätt block för ny vs befintlig spellista.
 * Kör: node scripts/verify-playlist-step3.mjs
 * Kräver: npm-paketet playwright (npx playwright install chromium)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const PORT = 19876;
const base = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttp(url) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) return;
    } catch {
      /* vänta */
    }
    await sleep(250);
  }
  throw new Error(`Kunde inte nå ${url} inom timeout`);
}

async function main() {
  const serve = spawn('npx', ['--yes', 'serve', '-l', String(PORT), '.'], {
    cwd: root,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serveErr = '';
  serve.stderr.on('data', (d) => {
    serveErr += d.toString();
  });
  serve.on('error', (e) => {
    serveErr += String(e);
  });

  try {
    await waitForHttp(`${base}/`);
  } catch (e) {
    serve.kill('SIGTERM');
    throw new Error(`${e.message}\nserve stderr: ${serveErr.slice(-2000)}`);
  }

  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();

  try {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#flow-step-0.is-active', { timeout: 15000 });

    /** Brödsmulor — inte ”Nästa: Spellista” i steg 1 (ligger i dold #results-section tills sökning körts). */
    await page.locator('.flow-breadcrumbs__crumb[data-flow-step="1"]').click();
    await page.locator('#flow-step-1.is-active').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.flow-breadcrumbs__crumb[data-flow-step="2"]').click();
    await page.locator('#flow-step-2.is-active').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#flow-step-2 input[name="pl-mode"][value="new"]').waitFor({ state: 'attached' });

    await page.locator('.flow-breadcrumbs__crumb[data-flow-step="3"]').click();
    await page.locator('#flow-step-3.is-active').waitFor({ state: 'visible', timeout: 10000 });

    const modeNew = await page.locator('#flow-step-3').getAttribute('data-playlist-mode');
    if (modeNew !== 'new') throw new Error(`Förväntade data-playlist-mode="new", fick ${modeNew}`);

    const existingHiddenNew = await page.locator('#block-existing-playlist').isHidden();
    if (!existingHiddenNew) {
      await page.screenshot({ path: path.join(root, 'test-results', 'fail-new-mode.png'), fullPage: true });
      throw new Error('#block-existing-playlist ska vara dold i läget ny spellista');
    }
    const newVisibleNew = await page.locator('#block-new-playlist').isVisible();
    if (!newVisibleNew) throw new Error('#block-new-playlist ska synas i läget ny spellista');

    const updateLabel = page.getByText('Uppdatering', { exact: true });
    if (await updateLabel.isVisible()) {
      await page.screenshot({ path: path.join(root, 'test-results', 'fail-update-visible.png'), fullPage: true });
      throw new Error('"Uppdatering" ska inte synas i läget ny spellista');
    }

    const title = await page.locator('#heading-playlist').textContent();
    if (!title?.includes('Skapa ny spellista')) {
      throw new Error(`Rubrik ska vara "Skapa ny spellista", fick: ${title}`);
    }

    await page.evaluate(() => {
      document.querySelector('#flow-step-2 input[name="pl-mode"][value="existing"]')?.click();
    });
    await page.waitForFunction(
      () => document.getElementById('flow-step-3')?.getAttribute('data-playlist-mode') === 'existing',
      { timeout: 5000 },
    );

    const modeEx = await page.locator('#flow-step-3').getAttribute('data-playlist-mode');
    if (modeEx !== 'existing') throw new Error(`Förväntade data-playlist-mode="existing", fick ${modeEx}`);

    const existingVisible = await page.locator('#block-existing-playlist').isVisible();
    if (!existingVisible) {
      await page.screenshot({ path: path.join(root, 'test-results', 'fail-existing-mode.png'), fullPage: true });
      throw new Error('#block-existing-playlist ska synas i läget befintlig spellista');
    }
    const newHiddenEx = await page.locator('#block-new-playlist').isHidden();
    if (!newHiddenEx) throw new Error('#block-new-playlist ska döljas i läget befintlig spellista');

    if (!(await updateLabel.isVisible())) {
      throw new Error('"Uppdatering" ska synas i läget befintlig spellista');
    }

    const outDir = path.join(root, 'test-results');
    await page.screenshot({ path: path.join(outDir, 'step3-existing-mode.png'), fullPage: true });

    await page.evaluate(() => {
      document.querySelector('#flow-step-2 input[name="pl-mode"][value="new"]')?.click();
    });
    await page.waitForFunction(
      () => document.getElementById('flow-step-3')?.getAttribute('data-playlist-mode') === 'new',
      { timeout: 5000 },
    );
    await page.screenshot({ path: path.join(outDir, 'step3-new-mode.png'), fullPage: true });

    // eslint-disable-next-line no-console
    console.log('OK: steg 3 döljer uppdaterings-UI för ny spellista och visar den för befintlig.');
  } finally {
    await browser.close();
    try {
      if (process.platform === 'win32' && serve.pid) {
        spawn('taskkill', ['/PID', String(serve.pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
      } else {
        serve.kill('SIGTERM');
      }
    } catch {
      /* */
    }
    await sleep(200);
  }
}

await main();
