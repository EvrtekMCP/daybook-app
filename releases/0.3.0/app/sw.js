// DAYBOOK — service worker. Network first, so an update always shows; the last
// good copy of each file when the network (or the local server) is not there,
// so the app still opens offline. Same-origin GETs only: the Apps Script calls
// and the settings save pass straight through, untouched.

const CACHE = 'daybook-0.3.0';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req, { cache: 'no-store' });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: false }) || await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw new Error('offline and not cached');
    }
  })());
});

// A tap on a notification brings the app forward.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) return all[0].focus();
    return self.clients.openWindow('./');
  })());
});
