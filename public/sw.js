// Service worker aplikace Kruh — jen pro push upozornění (žádné offline cache).
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = typeof data.title === 'string' ? data.title : 'Kruh';
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : 'kruh',
      renotify: true,
      icon: '/assets/icon-192.png',
      badge: '/assets/badge-96.png',
      lang: 'cs',
      data: { url: '/' },
    }),
    // Otevřená aplikace si hned načte nový stav.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => clients.forEach(client => client.postMessage({ type: 'kruh-refresh' }))),
  ]));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
