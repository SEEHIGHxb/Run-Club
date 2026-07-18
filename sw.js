// ============================================================================
//  Runaway · Service Worker
//  Two jobs:
//  1. Receive activity files shared from other apps via the Android share
//     sheet ("Share · Runaway"). Garmin Connect / Strava / a file manager
//     POST the file here; we stash it in a cache and redirect the page to
//     ./?share-target=1, where app.js picks it up and imports it automatically.
//  2. Network-first runtime caching of same-origin assets and Google Fonts,
//     used only as an offline fallback. Network-first means the ?v= cache-
//     busting in index.html keeps working normally — fresh code always wins
//     when online. There is deliberately no install-time precache: the page
//     requests versioned URLs (./app.js?v=N), so precached unversioned URLs
//     would never match and just waste storage.
// ============================================================================

const CACHE_NAME = 'runaway-assets-v2';
const SHARE_CACHE = 'runclub-shared';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== SHARE_CACHE) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Intercept the share-target POST
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(event.request));
    return;
  }

  // Only handle GET requests for caching
  if (event.request.method !== 'GET') return;

  // Network-First strategy for local/fonts assets, falling back to cache
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse.status === 200 && (url.origin === self.location.origin || url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com')) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // Offline fallback. ignoreSearch lets a request for ./app.js?v=10
        // fall back to a cached ./app.js?v=9 — stale beats nothing offline.
        return caches.match(event.request, { ignoreSearch: true });
      })
  );
});

async function handleShare(request) {
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (file && file.name) {
      const cache = await caches.open(SHARE_CACHE);
      // Store the raw bytes; remember the original filename so the page can
      // rebuild a File with the right extension for the parser to detect.
      await cache.put(
        'shared-activity',
        new Response(file, { headers: { 'x-filename': file.name } }),
      );
    }
  } catch (_) {
    // Even if extraction fails, still redirect so the user lands in the app.
  }
  const target = new URL('./?share-target=1', self.registration.scope);
  return Response.redirect(target.href, 303);
}

// ---------------------------------------------------------------------------
//  Push Notifications
// ---------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const payload = event.data.json();
    const title = payload.title || 'Runaway';
    const options = {
      body: payload.body || 'Something happened!',
      icon: './icons/runorlose.png',
      badge: './icons/runorlose.png',
      vibrate: [100, 50, 100],
      data: {
        url: payload.url || './'
      }
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.error('Failed to parse push notification payload:', err);
    const text = event.data.text();
    event.waitUntil(
      self.registration.showNotification('Runaway', {
        body: text,
        icon: './icons/runorlose.png',
        badge: './icons/runorlose.png',
        data: { url: './' }
      })
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = new URL(event.notification.data?.url || './', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        const clientUrl = new URL(client.url, self.location.origin).href;
        if (clientUrl === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

