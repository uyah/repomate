const CACHE_VERSION = 'v2';

// Activate immediately — don't wait for old tabs to close
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('push', (event) => {
  const data = event.data?.json() || { title: 'Dashboard', body: 'タスク更新' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.svg',
      badge: '/icon-192.svg',
      tag: data.tag || 'task-update',
      data: { url: data.url || '/', threadId: data.threadId || null },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  const threadId = event.notification.data?.threadId;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Find an existing dashboard window and navigate it
      for (const client of windowClients) {
        if ('focus' in client) {
          return client.focus().then(() => {
            client.postMessage({ type: 'open-thread', threadId, url });
            return client;
          });
        }
      }
      // No existing window — open new one
      return clients.openWindow(url);
    })
  );
});
