const CACHE_NAME = "ri-camera-shell-v4";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) =>
      c.addAll([
        "./", "./index.html", "./styles.css?v=4", "./overlay-utils.js?v=4",
        "./media-utils.js?v=4", "./subtitle-utils.js?v=4", "./media-processor.js?v=4",
        "./speech-recognizer.js?v=4", "./recording-pipeline.js?v=4", "./app.js?v=4",
        "./subtitle-worker.js", "./vendor/ffmpeg/ffmpeg.js", "./vendor/ffmpeg/814.ffmpeg.js",
        "./assets/subtitles-font.ttf", "./manifest.json", "./assets/logo.png", "./assets/site.png"
      ])
    )
  );
});
self.addEventListener("activate", (e) => {
  // Keep the downloaded speech models and media engine: only replace our shell.
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) =>
    key !== CACHE_NAME && (key.startsWith("ri-camera-shell-") || /^ri-camera-v\d+$/.test(key))
  ).map((key) => caches.delete(key)))));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match(e.request)).then((r) => r || fetch(e.request)));
});
