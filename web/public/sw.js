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

  const url = data.url || '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Already looking at the very conversation this is about? Don't
        // double-notify — the WS event is rendering live right now. Any
        // other visible page (home, another chat, the farm) still gets the
        // banner, otherwise a mention or a reaction in chat B goes unseen
        // while chat A is open.
        const onIt = clientList.some((c) => {
          if (c.visibilityState !== 'visible') return false;
          try {
            return new URL(c.url).pathname === url;
          } catch {
            return false;
          }
        });
        if (onIt) return undefined;
        return self.registration.showNotification(data.title, {
          body: data.body,
          tag: url,
          renotify: true,
          data: { url },
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
        // Land on the conversation the notification is about, not wherever
        // the tab happened to be left.
        return existing.focus().then((c) => (c && 'navigate' in c ? c.navigate(url).catch(() => c) : c));
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
      return undefined;
    }),
  );
});
