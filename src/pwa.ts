// Registers the service worker that makes the shell installable and able to open offline.
// The worker is compiled to dist/sw.js on its own Vite pass (see vite.sw.config.ts),
// so it sits at the site root and its scope covers the whole app.
//
// Registration must never break the terminal:
// if it fails, the app still works — it just won't install or run offline — so we only warn.
// We also wait for `load`, so fetching and parsing the worker never competes with the first paint.
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("service worker registration failed:", err);
    });
  });
}
