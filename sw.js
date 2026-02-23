const CACHE = 'bets-v1';

// Install — activate immediately without waiting
self.addEventListener('install', () => self.skipWaiting());

// Activate — take control of all open tabs right away
self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

// Network-first: always try to fetch fresh from network,
// fall back to cache only if offline
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // Skip cross-origin requests (CDN scripts etc)
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
