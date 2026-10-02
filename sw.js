// Service worker — רשת קודם, ואם אין אינטרנט: הגרסה השמורה.
// כשמעלים גרסה חדשה של האתר, מעלים את מספר הגרסה כאן.
const CACHE_NAME = "mk-site-v2";
const CORE = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/config.js",
  "./js/products.js",
  "./js/app.js",
  "./manifest.json",
  "./img/logo-160.webp",
  "./img/logo-720.webp",
  "./img/icon-192.png",
  "./img/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200 && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
