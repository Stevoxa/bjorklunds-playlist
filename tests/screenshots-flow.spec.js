/**
 * README-skärmbilder av hela flödet mot ett mockat Spotify.
 *
 * Inloggningen sås direkt i sessionStorage (samma format som js/token-session.js skriver)
 * och alla anrop till api.spotify.com besvaras av page.route() nedan. Inget riktigt konto
 * eller Client ID behövs, så specen går att köra i CI.
 *
 * Kör: npx playwright test tests/screenshots-flow.spec.js
 * Bilderna hamnar i docs/screenshots/ (spåras i git, används av README.md).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs', 'screenshots');

/** Måste matcha APP_STORAGE_ID i js/config.js */
const APP_STORAGE_ID = 'stevoxa-io-bjorklunds-playlist-pwa';
const CLIENT_ID = 'demo-client-id';

const PASTE = [
  'ABBA – Dancing Queen',
  'Waterloo av ABBA',
  'Cake By The Ocean - DNCE',
  'Håkan Hellström – Känn ingen sorg för mig Göteborg',
  'Ebba Grön, 800 grader',
].join('\n');

/** Omslagsbilder som data-URI så att inga externa bilder behövs. */
function cover(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

let trackSeq = 0;
function track(name, artist, album, year, color, durationMs = 215_000) {
  trackSeq += 1;
  const id = `demo${String(trackSeq).padStart(4, '0')}`;
  return {
    id,
    uri: `spotify:track:${id}`,
    name,
    duration_ms: durationMs,
    explicit: false,
    popularity: 70,
    preview_url: null,
    is_playable: true,
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    artists: [{ id: `a-${artist}`, name: artist, uri: `spotify:artist:${artist}` }],
    album: {
      id: `al-${album}`,
      name: album,
      release_date: String(year),
      release_date_precision: 'year',
      images: [{ url: cover(color), width: 64, height: 64 }],
    },
  };
}

/** Katalog per titel (gemener). Flera versioner av samma låt ger en tvetydig träff. */
const CATALOG = {
  'dancing queen': [
    track('Dancing Queen', 'ABBA', 'Arrival', 1976, '#1d4ed8', 231_000),
    track('Dancing Queen - Live', 'ABBA', 'ABBA Live at Wembley Arena', 2014, '#7c3aed', 245_000),
    track('Dancing Queen - Remastered 2001', 'ABBA', 'Arrival (Remastered)', 2001, '#0891b2', 231_000),
  ],
  waterloo: [
    track('Waterloo', 'ABBA', 'Waterloo', 1974, '#b45309', 168_000),
    track('Waterloo - Swedish Version', 'ABBA', 'Waterloo (Deluxe Edition)', 2014, '#a16207', 167_000),
  ],
  'cake by the ocean': [track('Cake By The Ocean', 'DNCE', 'DNCE', 2016, '#db2777', 219_000)],
  'känn ingen sorg för mig göteborg': [
    track('Känn ingen sorg för mig Göteborg', 'Håkan Hellström', 'Känn ingen sorg för mig Göteborg', 2000, '#15803d', 268_000),
  ],
  '800 grader': [track('800 grader', 'Ebba Grön', 'Kärlek & Uppror', 1981, '#b91c1c', 186_000)],
};

/** Plockar ut titel/artist ur Spotifys fältsyntax (`track:T artist:A`) eller fritext. */
function lookup(q) {
  const t = /track:("([^"]+)"|(.+?))(\s+artist:|$)/i.exec(q);
  const key = (t ? t[2] || t[3] : q).trim().toLowerCase();
  if (CATALOG[key]) return CATALOG[key];
  const hit = Object.keys(CATALOG).find((k) => key.includes(k));
  return hit ? CATALOG[hit] : [];
}

const ME = {
  id: 'demo-user',
  display_name: 'Demo',
  email: 'demo@example.com',
  product: 'premium',
  country: 'SE',
};

const PLAYLISTS = [
  { id: 'pl-fest', name: 'Björklunds playlist - Midsommar', tracks: 42 },
  { id: 'pl-bil', name: 'Björklunds playlist - Bilresa', tracks: 118 },
  { id: 'pl-trana', name: 'Björklunds playlist - Träning', tracks: 64 },
].map((p) => ({
  id: p.id,
  name: p.name,
  description: 'Skapad av Björklunds playlist app',
  public: false,
  collaborative: false,
  snapshot_id: `snap-${p.id}`,
  owner: { id: ME.id, display_name: ME.display_name },
  images: [{ url: cover('#16a34a'), width: 64, height: 64 }],
  tracks: { total: p.tracks },
  items: { total: p.tracks },
}));

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockSpotify(page) {
  await page.route('https://sdk.scdn.co/**', (route) => route.abort());
  await page.route('https://accounts.spotify.com/**', (route) => route.abort());
  await page.route('https://api.spotify.com/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/v1/, '');
    const method = route.request().method();

    if (path === '/me') return json(route, ME);
    if (path === '/search') {
      const items = lookup(url.searchParams.get('q') || '');
      const limit = Number(url.searchParams.get('limit') || 5);
      return json(route, { tracks: { items: items.slice(0, limit), total: items.length } });
    }
    if (path === '/tracks') {
      const ids = (url.searchParams.get('ids') || '').split(',');
      const all = Object.values(CATALOG).flat();
      return json(route, { tracks: ids.map((id) => all.find((t) => t.id === id) ?? null) });
    }
    if (path === '/me/playlists' || path === `/users/${ME.id}/playlists`) {
      if (method === 'POST') {
        return json(route, { ...PLAYLISTS[0], id: 'pl-new', name: 'Björklunds playlist - Ny', snapshot_id: 'snap-new' }, 201);
      }
      return json(route, { items: PLAYLISTS, total: PLAYLISTS.length, limit: 50, offset: 0, next: null });
    }
    const pl = /^\/playlists\/([^/]+)(\/items|\/tracks)?$/.exec(path);
    if (pl) {
      if (pl[2]) {
        if (method !== 'GET') return json(route, { snapshot_id: 'snap-after' }, method === 'POST' ? 201 : 200);
        const items = Object.values(CATALOG).map((list) => ({
          added_at: '2026-04-20T18:00:00Z',
          is_local: false,
          item: { ...list[0], type: 'track', is_local: false },
        }));
        return json(route, { items, total: items.length, limit: 100, offset: 0, next: null });
      }
      return json(route, PLAYLISTS.find((p) => p.id === pl[1]) ?? PLAYLISTS[0]);
    }
    return json(route, {});
  });
}

/** Startbilden ligger som overlay i ~1,5 s efter laddning. */
async function gotoApp(page) {
  await page.goto('/');
  await page.locator('#app-splash').waitFor({ state: 'detached' });
}

async function seedLogin(page) {
  await page.addInitScript(
    ({ id, clientId }) => {
      sessionStorage.setItem(
        `${id}:spotify_session`,
        JSON.stringify({
          clientId,
          tokens: {
            accessToken: 'demo-access-token',
            refreshToken: 'demo-refresh-token',
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            grantedScopeRaw:
              'playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative user-read-private user-read-email',
          },
        }),
      );
    },
    { id: APP_STORAGE_ID, clientId: CLIENT_ID },
  );
}

// Fast höjd i stället för fullPage: stegens klistrade knappfält hamnar annars mitt i bilden.
test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });

test.describe('README-skärmbilder (mockat Spotify)', () => {
  test.beforeEach(async ({ page }) => {
    mkdirSync(outDir, { recursive: true });
    await mockSpotify(page);
    await seedLogin(page);
  });

  test('klistra in → matchningar', async ({ page }) => {
    await gotoApp(page);
    await page.locator('#flow-step-landing').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(outDir, '00-start.png') });
    await page.getByRole('button', { name: 'Skapa en ny spellista på Spotify' }).click();
    await page.locator('#flow-step-1').waitFor({ state: 'visible' });
    await page.locator('#paste-area').fill(PASTE);
    await page.screenshot({ path: join(outDir, '01-klistra-in.png') });

    await page.locator('#btn-search').click();
    await expect(page.locator('#results-body article')).toHaveCount(5, { timeout: 30_000 });
    // Välj liveversionen på den tvetydiga raden så att bilden visar att man kan byta träff.
    await page.getByRole('radio', { name: /^Dancing Queen - Live/ }).check();
    await page.waitForTimeout(300);
    await page
      .getByRole('region', { name: 'Resultatlista' })
      // Den klistrade navigeringsraden ligger annars över listans nederkant.
      .screenshot({ path: join(outDir, '02-matchningar.png'), style: '.flow-step-1-sticky-nav { display: none !important; }' });

    await page.locator('#btn-flow-step-1-next').click();
    await page.locator('#flow-step-2').waitFor({ state: 'visible' });
    await page.locator('#new-pl-name').fill('Sommarfest 2026');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '03-spellista.png'), });

    await page.locator('#btn-flow-step-2-next').click();
    await page.locator('#flow-step-3').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '04-sammanfattning.png') });
  });

  test('redigera befintlig spellista', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: 'Redigera en befintlig spellista på Spotify' }).click();
    await page.locator('#flow-step-select-playlist').waitFor({ state: 'visible' });
    const list = page.locator('#select-playlist-list');
    await expect(list).toContainText('Midsommar');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '05-valj-spellista.png') });

    await list.getByText('Midsommar').first().click();
    const edit = page.locator('#flow-step-edit-playlist');
    await edit.waitFor({ state: 'visible' });
    await expect(edit).toContainText('Dancing Queen');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '06-redigera.png') });
  });
});
