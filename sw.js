/* eslint-disable no-restricted-globals */
/** Måste matcha APP_STORAGE_ID i js/config.js */
const APP_STORAGE_ID = 'stevoxa-io-bjorklunds-playlist-pwa';
const CACHE = `${APP_STORAGE_ID}-cache-v75`;
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './css/shell.css',
  './js/config.js',
  './js/db.js',
  './js/crypto.js',
  './js/vault.js',
  './js/auth.js',
  './js/spotify-log.js',
  './js/search-cache.js',
  './js/spotify-api.js',
  './js/parser.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});
