/* sw.js
   Simple offline caching for GitHub Pages static app.

   Strategy:
   - Precache core app shell (index, css, js, sw itself)
   - Cache-first for same-origin requests
   - Network fallback for navigation with cached index fallback
   - Versioned cache name; bump SW_VERSION to force refresh
*/

const SW_VERSION = 'v1.0.0';
const CACHE_NAME = `gtp-cache-${SW_VERSION}`;

// IMPORTANT: keep this list small and stable (app shell)
const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './sw.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Clean up old caches
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('gtp-cache-') && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Allow page to ask the SW to activate immediately
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Only cache same-origin resources
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin) return;

  // Navigation requests: try network first, fallback to cached index
  const isNavigation =
    req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isNavigation) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        // Update cache with latest index if possible
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('./index.html')) || (await cache.match('./')) || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // Static assets: cache-first, then network + cache
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      const fresh = await fetch(req);
      // Cache successful, basic responses
      if (fresh && fresh.status === 200 && fresh.type === 'basic') {
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      // As a fallback, try app shell
      return cached || new Response('Offline', { status: 503 });
    }
  })());
});
