const CACHE_PREFIX = "shotlab-";
const CACHE_VERSION = `${CACHE_PREFIX}shell-v2`;
const APP_ROOT = self.registration.scope;
const scopedUrl = (path = "") => new URL(path, APP_ROOT).href;
const CORE_ASSETS = [
  APP_ROOT,
  scopedUrl("manifest.webmanifest"),
  scopedUrl("icons/icon-192.png"),
  scopedUrl("icons/icon-512.png"),
  scopedUrl("models/pose_landmarker_lite.task"),
];

const SCOPED_PATHS = {
  api: new URL("api/", APP_ROOT).pathname,
  assets: new URL("_next/", APP_ROOT).pathname,
  icons: new URL("icons/", APP_ROOT).pathname,
  mediapipe: new URL("mediapipe/", APP_ROOT).pathname,
  models: new URL("models/", APP_ROOT).pathname,
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (/\.(mp4|mov|webm|m4v)$/i.test(url.pathname) || url.pathname.startsWith(SCOPED_PATHS.api)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE_VERSION).then((cache) => cache.put(APP_ROOT, copy));
          return response;
        })
        .catch(() => caches.match(APP_ROOT).then((cached) => cached || Response.error())),
    );
    return;
  }

  const cacheFirst =
    url.pathname.startsWith(SCOPED_PATHS.models) ||
    url.pathname.startsWith(SCOPED_PATHS.mediapipe) ||
    url.pathname.startsWith(SCOPED_PATHS.icons);
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && (cacheFirst || url.pathname.startsWith(SCOPED_PATHS.assets))) {
          const copy = response.clone();
          void caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
