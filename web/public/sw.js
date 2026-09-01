// Lazybutts service worker: caches the app shell for offline/instant load,
// and turns web-push payloads into notifications that open the app.

const CACHE_NAME = 'lazybutts-shell-v1';
const SHELL_URLS = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Network-first for page navigations: fetch fresh, cache a copy, and fall
// back to whatever shell is cached when the network is unavailable. Other
// requests (API calls, media, hashed build assets) pass straight through —
// this worker is not a general-purpose asset cache.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  // /farm/* and /mahjong/* are sibling games served by their own services
  // behind the same host (each with its own service worker) — let them hit
  // the network untouched (and never overwrite the cached chat shell).
  const { pathname } = new URL(event.request.url);
  if (pathname.startsWith('/farm') || pathname.startsWith('/mahjong')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put('/', copy));
        return response;
      })
      .catch(() => caches.match('/').then((cached) => cached || caches.match(event.request))),
  );
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'Lazybutts', body: event.data.text() };
  }

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // App already on screen? Don't double-notify — the WS message is
        // rendering live right now.
        const visible = clientList.some((c) => c.visibilityState === 'visible');
        if (visible) return undefined;
        return self.registration.showNotification(data.title, {
          body: data.body,
          data: { url: data.url || '/' },
        });
      }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const existing = clientList.find((client) => 'focus' in client);
      if (existing) {
        return existing.focus();
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
      return undefined;
    }),
  );
});
