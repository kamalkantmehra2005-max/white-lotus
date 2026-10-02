/*
 * WHITE-LOTUS service worker — makes the web app installable and shows a friendly page when your computer is
 * unreachable. PRIVACY: it never caches pages or API responses (they contain your data). It caches only the app's
 * own static build files, icons and the offline page.
 */
const VERSION = "wl-static-v1";
const PRECACHE = ["/offline.html", "/icons/icon-192.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Pages: always from your computer; if it can't be reached, show the offline page (never a stale copy of your data).
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }
  // Immutable build assets and icons: cache-first.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
  // Everything else (/api/*, files, downloads) goes straight to the network and is never stored.
});
