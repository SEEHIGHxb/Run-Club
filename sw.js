// ============================================================================
//  Run or Lose Club · Service Worker
//  Sole job: receive activity files shared from other apps via the Android
//  share sheet ("Share · Run or Lose Club"). Garmin Connect / Strava / a file manager
//  POST the file here; we stash it in a cache and redirect the page to
//  ./?share-target=1, where app.js picks it up and imports it automatically.
//  No asset caching is done, so the ?v= cache-busting in index.html keeps
//  working normally.
// ============================================================================

const SHARE_CACHE = 'runclub-shared';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Intercept ONLY the share-target POST. Everything else falls through to the
  // network (we don't call respondWith), so normal loading is untouched.
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(event.request));
  }
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
