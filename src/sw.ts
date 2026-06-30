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
// Two jobs live here: cache the app shell so it opens offline, and drain the outbox —
// which is why this file is on the full TS toolchain.
// The page enqueues a line and asks the worker to flush; the worker is what actually reaches the kernel,
// so a line still goes up after the network returns, even with no page open, woken by Background Sync.

import { type Envelope, isCopy } from "./kernel";
import { allPending, formatBatch, markDelivered, SYNC_TAG } from "./outbox";

// In a service worker `self` is a ServiceWorkerGlobalScope, not a Window.
// Narrow it once here, so the events and methods below type-check.
const worker = self as unknown as ServiceWorkerGlobalScope;

// Injected from package.json's version by vite.sw.config.ts.
// The cache name carries it,
// so each release rotates to a fresh cache and the activate handler evicts the stale ones.
declare const __SW_VERSION__: string;
const CACHE = `joy-shell-${__SW_VERSION__}`;

// Baked in at build time (vite.sw.config.ts) — a local kernel in dev,
// the production kernel otherwise. The worker can't read import.meta.env,
// so this is the worker's mirror of the app's KERNEL_URL.
declare const __KERNEL_URL__: string;
const KERNEL_URL = __KERNEL_URL__;

// The entry points we can name up front.
// Vite's hashed JS/CSS bundles aren't listed —
// they're cached at runtime on first online load (see the fetch handler).
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-maskable-512.png",
];

// --- outbox delivery ------------------------------------------------------

// Let the open terminal know how a send went,
// so it can update the marker under each line the symbiot typed.
//
// We send the worker's verdict — "delivered" or "requeued" —
// along with the ids of the lines it applies to.
// The page matches those ids back to the lines on screen and updates them:
// "delivered" turns the marker into a bright COPY,
// "requeued" puts it back to a waiting ⋯ queued.
//
// Sometimes there's no terminal open to tell —
// for example the network came back while the app was fully closed,
// and the browser woke this worker on its own to deliver.
// In that case the list of open terminals below is empty,
// so the loop has nothing to send to and simply does nothing.
// That's fine, and nothing is lost: by then the lines have already been sent
// and cleared out of the outbox, so the only thing skipped is a screen update
// for a screen that isn't there.
async function notify(type: "delivered" | "requeued", ids: number[]): Promise<void> {
  // The open terminal windows this worker can talk to.
  // Empty when the app is closed — then the loop below runs zero times.
  const clients = await worker.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of clients) client.postMessage({ type, ids });
}

// Drain the whole outbox in one transmission.
// Everything queued goes up as a single timestamped, separator-formatted POST,
// so a reconnect reads as one coherent batch, not N context-free pings.
// On a real `copy` ack the batch is cleared and the pages told to print COPY;
// on anything else the lines stay queued (the page shows them as such) and we throw,
// so a Background Sync retries when the network is back.
const SEND_TIMEOUT_MS = 6_000; // a send that hangs this long counts as failed

async function drainOutbox(): Promise<void> {
  const pending = await allPending();
  if (pending.length === 0) return;
  const ids = pending.map((e) => e.id);
  let delivered = false;
  // Abort a hung send so the drain always settles — otherwise the in-flight lock
  // below would stick and block every later drain.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${KERNEL_URL}/intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line: formatBatch(pending) }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const body: Envelope | null = res.ok ? await res.json().catch(() => null) : null;
    // COPY only on a real receipt — a 200 with the wrong shape,
    // a CORS-blocked read,
    // or any network error all mean the kernel didn't receive it.
    delivered = isCopy(body);
  } catch {
    delivered = false;
  } finally {
    clearTimeout(timer);
  }
  if (!delivered) {
    await notify("requeued", ids);
    throw new Error("outbox drain failed — will retry on sync");
  }
  await markDelivered(ids);
  await notify("delivered", ids);
}

// Coalesce overlapping triggers (a flush message and a sync event firing at once)
// onto a single in-flight drain, so the batch can't be sent twice.
let draining: Promise<void> | null = null;
function drain(): Promise<void> {
  if (!draining) draining = drainOutbox().finally(() => (draining = null));
  return draining;
}

worker.addEventListener("install", (event) => {
  // Precache the shell, then take over without waiting for old tabs to close.
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => worker.skipWaiting()),
  );
});

worker.addEventListener("activate", (event) => {
  // Drop caches left by older versions, control open pages right away, then try a drain —
  // both to flush anything a previous version left queued, and as the fallback path
  // for browsers without Background Sync. A failure here is fine:
  // the sync registration (or the next online flush) will retry.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => worker.clients.claim())
      .then(() => drain().catch(() => {})),
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

// Background Sync: the browser fires this when connectivity is back — even if
// the app was closed when the line was queued. This is the durable delivery guarantee.
// Its types aren't in the standard lib, so we describe the slice we use;
// rejecting the waitUntil tells the browser to retry the sync later.
interface SyncEventLike extends ExtendableEvent {
  readonly tag: string;
}
worker.addEventListener("sync", (event: Event) => {
  const sync = event as unknown as SyncEventLike;
  if (sync.tag === SYNC_TAG) sync.waitUntil(drain());
});

// The page's immediate "try now" nudge, sent right after it enqueues a line —
// so a line typed online goes up at once instead of waiting for a sync event.
// Background Sync is the safety net; this is the fast path.
worker.addEventListener("message", (event) => {
  if (event.data?.type === "flush") event.waitUntil(drain().catch(() => {}));
});

export {};
