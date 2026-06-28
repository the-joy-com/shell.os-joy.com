/// <reference lib="webworker" />

// The Joy's service worker — a script the browser runs in the background,
// off the page, between the app and the network.
// Registering one is what lets Chrome offer "Install" and lets the shell open with no network.
//
// Compiled to dist/sw.js by vite.sw.config.ts on its own build pass,
// so it lands at the site root with a stable, un-hashed name —
// that's what gives it whole-app scope.
// It is type-checked by tsconfig.sw.json (WebWorker lib).
//
// This slice keeps the logic small: cache the app shell, serve from cache when the network is gone.
// The outbox + Background Sync the capture loop needs will grow inside this same worker —
// which is why it's on the full TS toolchain now.

// In a service worker `self` is a ServiceWorkerGlobalScope, not a Window.
// Narrow it once here, so the events and methods below type-check.
const worker = self as unknown as ServiceWorkerGlobalScope;

// Injected from package.json's version by vite.sw.config.ts.
// The cache name carries it,
// so each release rotates to a fresh cache and the activate handler evicts the stale ones.
declare const __SW_VERSION__: string;
const CACHE = `joy-shell-${__SW_VERSION__}`;

// The entry points we can name up front.
// Vite's hashed JS/CSS bundles aren't listed —
// they're cached at runtime on first online load (see the fetch handler).
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-maskable-512.png",
];

worker.addEventListener("install", (event) => {
  // Precache the shell, then take over without waiting for old tabs to close.
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => worker.skipWaiting()),
  );
});

worker.addEventListener("activate", (event) => {
  // Drop caches left by older versions, then control open pages right away.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => worker.clients.claim()),
  );
});

worker.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // only reads are cacheable

  // Network-first: online, take the fresh copy and stash it;
  // offline, fall back to whatever we have (the shell, and any bundle from a previous visit).
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
        return response;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        // A navigation we've never cached still gets the app shell —
        // all this single-page terminal needs to boot.
        if (request.mode === "navigate") {
          const shell = await caches.match("./index.html");
          if (shell) return shell;
        }
        return new Response("offline and not cached", {
          status: 503,
          statusText: "offline",
        });
      }),
  );
});

export {};
