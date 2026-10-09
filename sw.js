const CACHE_NAME = "ri-camera-shell-v6";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) =>
      c.addAll([
        "./", "./index.html", "./styles.css?v=6", "./overlay-utils.js?v=6",
        "./media-utils.js?v=6", "./subtitle-utils.js?v=6", "./media-processor.js?v=6",
        "./speech-recognizer.js?v=6", "./server-subtitle-client.js?v=6",
        "./server-subtitle-pipeline.js?v=6", "./subtitle-module.js?v=6", "./recording-pipeline.js?v=6", "./app.js?v=6",
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
