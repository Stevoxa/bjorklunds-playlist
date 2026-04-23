/* eslint-disable no-restricted-globals */
/** Måste matcha APP_STORAGE_ID i js/config.js */
const APP_STORAGE_ID = 'stevoxa-io-bjorklunds-playlist-pwa';
const CACHE = `${APP_STORAGE_ID}-cache-v183`;
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './css/shell.css',
  './js/config.js',
  './js/db.js',
  './js/local-settings.js',
  './js/auth.js',
  './js/spotify-log.js',
  './js/search-cache.js',
  './js/playlist-list-cache.js',
  './js/playlist-tracks-cache.js',
  './js/artist-bank.js',
  './js/spotify-api.js',
  './js/parser.js',
  './js/token-session.js',
  './js/row-spotify-playback.js',
  './js/app.js',
  './vendor/sortable.min.js',
  './manifest.webmanifest',
  './icons/favicon-16.png',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './media/bjorklunds_playlist_start.png',
  './media/bjorklunds_playlist_start_wide.png',
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
  /** Nätverk först så index.html/js inte fastnar i gammal cache; offline faller tillbaka till cache. */
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.ok) {
          const copy = networkResponse.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return networkResponse;
      })
      .catch(() => caches.match(request)),
  );
});
