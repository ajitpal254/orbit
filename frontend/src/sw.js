// Custom service worker — vite-plugin-pwa `injectManifest` strategy.
//
// Why injectManifest instead of the default generateSW: the generated
// service worker is a stock Workbox precache shell with no `push`
// handler, so web pushes were delivered to the browser and silently
// dropped — subscribing returned 200 and the server sent pushes, but
// nothing ever appeared on the device. This file keeps the same
// precaching + SPA navigation fallback generateSW had, and adds the
// push + notificationclick handlers that make push actually work.
//
// The precache manifest is injected by workbox-build at
// `self.__WB_MANIFEST` (see vite.config.js `injectManifest`).
// Vite bundles this file with Rollup before injection, so the
// `workbox-*` imports below are inlined into the single output file.
//
// SKIP_WAITING: the new SW never takes over on its own — registerType
// is 'prompt' and the app only asks it to skip waiting when the user
// taps Update in the toast (pwa.js). An auto-takeover mid-call would
// drop a live voice call.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// SPA fallback for navigations (same as generateSW's navigateFallback).
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// A web push arrives here even when the app is closed. Show it as a
// system notification; the payload is the JSON lib/push.js sends:
// { title, body, tag, data: { url } }. Anything unparseable falls back
// to a generic line instead of breaking the handler.
self.addEventListener('push', (event) => {
  let payload = { title: 'Orbit', body: 'You have a new notification', tag: 'orbit', data: {} };
  if (event.data) {
    try {
      const data = event.data.json();
      if (data && typeof data === 'object') {
        payload = {
          title: typeof data.title === 'string' ? data.title : payload.title,
          body: typeof data.body === 'string' ? data.body : payload.body,
          tag: typeof data.tag === 'string' ? data.tag : payload.tag,
          data: data.data && typeof data.data === 'object' ? data.data : {}
        };
      }
    } catch {
      // Keep the generic fallback above.
    }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: payload.data
    })
  );
});

// Tapping a push opens (or focuses) the app, deep-linking to the
// notification's URL when the payload carried one. An already-open
// tab is navigated in place so no duplicate tab appears; the app
// reads location.hash on boot / hashchange (see App.jsx + deepLink.js).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = event.notification.data && event.notification.data.url;
  const url = rawUrl
    ? new URL(rawUrl, self.location.origin).href
    : `${self.location.origin}/`;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin) {
          return client.navigate(url).then((c) => (c ? c.focus() : clients.openWindow(url)));
        }
      }
      return clients.openWindow(url);
    })
  );
});
