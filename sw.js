// Caches the app shell so it opens offline. Rates are cached by app.js in localStorage.
const CACHE = 'cc-v2';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'calc.js', 'currencies.js', 'tz-map.js',
  'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-512.png',
  'fonts/fredoka-latin-600-normal.woff2', 'fonts/fredoka-latin-700-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first for the shell (so updates land), falling back to cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
