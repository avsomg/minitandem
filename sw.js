const CACHE = 'minitandem-shell-2026-10-21-daycare-2';
const SHELL = [
  '/', '/index.html', '/styles.css', '/manifest.webmanifest',
  '/features.js', '/strings-en.js', '/strings-de.js', '/strings-fr.js', '/i18n.js',
  '/data.js', '/data-reviewed.js', '/data-practical.js', '/regions.js', '/data-geo.js', '/data-towns.js',
  '/planning.js', '/exchange.js', '/storage-migration.js', '/catalogue.js', '/catalogue-i18n.js', '/childcare.js', '/format.js', '/store.js', '/sync.js', '/exports.js', '/category-icons.js', '/views.js', '/childcare-views.js',
  '/toast.js', '/map.js', '/app.js',
  '/assets/favicon.svg', '/assets/icon-512.png', '/assets/apple-touch-icon.png',
  '/assets/leaflet.js', '/assets/leaflet.css', '/assets/leaflet.markercluster.js', '/assets/MarkerCluster.css'
];
// The German and French card texts and the places of the Daycare tab are not in the shell: each is cached the first time it is loaded, so a
// visitor keeps only the language they use (and the places once they opened the tab), offline included.
const ON_USE = ['/data-de.js', '/data-fr.js', '/data-childcare.js', '/data-childcare-de.js', '/data-childcare-fr.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
// Every cache of this origin belongs to this app: drop all but the current one, including those of earlier versions.
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))),
    self.clients.claim()
  ]));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (!SHELL.includes(url.pathname) && !ON_USE.includes(url.pathname)) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
    }
    return response;
  // Offline: the cached copy; a page falls back to the shell, a card-text file that was never loaded fails (the app then shows English).
  }).catch(async () => (await caches.match(request)) || (ON_USE.includes(url.pathname) ? Response.error() : await caches.match('/index.html'))));
});
