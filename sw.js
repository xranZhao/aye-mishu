const CACHE = 'weijin-v7';
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.json', './fonts/weijin-brand.woff2', './icons/icon-192.png', './icons/icon-512.png'];

function offlineCoreAsset(pathname) {
  if (pathname.endsWith('/') || pathname.endsWith('/index.html')) return './index.html';
  if (pathname.endsWith('/app.js')) return './app.js';
  if (pathname.endsWith('/style.css')) return './style.css';
  if (pathname.endsWith('/manifest.json')) return './manifest.json';
  return './index.html';
}

self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
));
self.addEventListener('activate', event => event.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim())
));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const isAppFile = url.origin === self.location.origin &&
    (url.pathname.endsWith('/') || /\/(index\.html|style\.css|app\.js|manifest\.json)$/.test(url.pathname));

  if (isAppFile) {
    event.respondWith(fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request).then(hit => hit || caches.match(offlineCoreAsset(url.pathname)))));
    return;
  }

  event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match('./index.html'))));
});
