/// <reference lib="webworker" />

// The Joy's service worker — a script the browser runs in the background, off the page,
// between the app and the network.
// Registering one is what lets Chrome offer "Install" and lets the shell open with no network.
//
// Compiled to dist/sw.js by vite.sw.config.ts on its own build pass,
// so it lands at the site root with a stable, un-hashed name —
// that's what gives it whole-app scope.
// It is type-checked by tsconfig.sw.json (WebWorker lib).
//
// Two jobs live here: cache the app shell so it opens offline, and drain the outbox.
// The page enqueues a line and asks the worker to flush;
// the worker is what actually reaches the kernel,
// so a line still goes up after the network returns, even with no page open, woken by Background Sync.
//
// This file is only the wiring: it registers each event and owns the event-lifecycle glue
// (waitUntil, respondWith, and the guards that read an event's own fields). What each event
// actually does lives in sw-handlers.ts — the listeners below delegate to it.

import { SYNC_TAG } from "./store/outbox";
import { cleanupAndClaim, drain, focusOrOpen, handlePush, precacheShell, respondTo } from "./sw-handlers";

// In a service worker `self` is a ServiceWorkerGlobalScope, not a Window.
// Narrow it once here, so addEventListener and its events type-check.
const worker = self as unknown as ServiceWorkerGlobalScope;

worker.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(cleanupAndClaim());
});

worker.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return; // only reads are cacheable
  event.respondWith(respondTo(event.request));
});

// Background Sync: the browser fires this when connectivity is back — even if the app was closed when the line was queued.
// This is the durable delivery guarantee.
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

// A kernel push: a content-free nudge that there's something to read. handlePush tells the
// two kinds apart (a reply to the symbiot's own line vs. a missive the kernel raised) and,
// either way, produces the visible notification a userVisibleOnly subscription must.
worker.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

// Clicking that notification brings the terminal forward, where the message is waiting.
worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(focusOrOpen());
});

export {};
