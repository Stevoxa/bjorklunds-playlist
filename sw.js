/* eslint-disable no-restricted-globals */
/** Måste matcha APP_STORAGE_ID i js/config.js */
const APP_STORAGE_ID = 'stevoxa-io-bjorklunds-playlist-pwa';
const CACHE = `${APP_STORAGE_ID}-cache-v49`;
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './css/shell.css',
  './js/config.js',
  './js/icon-sprite.js',
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
  './icons/ui-sprite-backup.svg',
  './icons/bild8/product-icons.svg',
  './icons/bild8/kalla/ikoner-och-grafiska-element.png',
  './icons/bild8/raster/back.png',
  './icons/bild8/raster/bell.png',
  './icons/bild8/raster/bulb.png',
  './icons/bild8/raster/check-circle.png',
  './icons/bild8/raster/chevron-down.png',
  './icons/bild8/raster/clipboard.png',
  './icons/bild8/raster/clock.png',
  './icons/bild8/raster/copy.png',
  './icons/bild8/raster/eye-off.png',
  './icons/bild8/raster/eye.png',
  './icons/bild8/raster/gear.png',
  './icons/bild8/raster/help.png',
  './icons/bild8/raster/info.png',
  './icons/bild8/raster/lightning.png',
  './icons/bild8/raster/link.png',
  './icons/bild8/raster/list.png',
  './icons/bild8/raster/lock.png',
  './icons/bild8/raster/mag-refresh.png',
  './icons/bild8/raster/mag.png',
  './icons/bild8/raster/note.png',
  './icons/bild8/raster/pencil.png',
  './icons/bild8/raster/plus.png',
  './icons/bild8/raster/playlist.png',
  './icons/bild8/raster/refresh.png',
  './icons/bild8/raster/spotify-mark.png',
  './icons/bild8/raster/spotify.png',
  './icons/bild8/raster/tag.png',
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
