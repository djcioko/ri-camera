const CACHE_NAME = "ri-camera-v3";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) =>
      c.addAll(["./", "./index.html", "./styles.css?v=3", "./overlay-utils.js?v=3", "./media-utils.js?v=3", "./app.js?v=3", "./manifest.json", "./assets/logo.png", "./assets/site.png"])
    )
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
});
self.addEventListener("fetch", (e) => {
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
