/// <reference lib="webworker" />

// The service worker's behaviours — everything the worker actually *does* when an event
// fires. The event wiring itself lives in sw.ts: that file registers the listeners and owns
// the event-lifecycle glue (waitUntil, respondWith, the guards that read an event's fields);
// this file is the work those listeners delegate to.
//
// Three concerns live here: draining the outbox to the kernel, caching the app shell so it
// opens offline, and handling a kernel push. They share the worker global and the build-time
// constants below, which is why they sit in one module rather than three.

import { type Envelope, type Outcome, KERNEL_LINE, KERNEL_MSG, copyId, isCopy, readOutcome } from "./kernel";
import { track } from "./store/inbound";
import { getReplyChannelId } from "./store/meta";
import { allPending, formatBatch, markDelivered } from "./store/outbox";

// In a service worker `self` is a ServiceWorkerGlobalScope, not a Window.
// Narrow it once here, so the methods below type-check.
const worker = self as unknown as ServiceWorkerGlobalScope;

// Injected from package.json's version by vite.sw.config.ts.
// The cache name carries it,
// so each release rotates to a fresh cache and the activate handler evicts the stale ones.
declare const __SW_VERSION__: string;
const CACHE = `joy-shell-${__SW_VERSION__}`;

// Baked in at build time (vite.sw.config.ts) — a local kernel in dev, the production kernel otherwise.
// The worker can't read import.meta.env,
// so this is the worker's mirror of the app's KERNEL_URL.
declare const __KERNEL_URL__: string;
const KERNEL_URL = __KERNEL_URL__;

// The entry points we can name up front.
// Vite's hashed JS/CSS bundles aren't listed —
// they're cached at runtime on first online load (see respondTo).
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
// That's fine, and nothing is lost: by then the lines have already been sent and cleared out of the outbox,
// so the only thing skipped is a screen update for a screen that isn't there.
async function notify(type: "delivered" | "requeued", ids: number[]): Promise<void> {
  await postToClients({ type, ids });
}

// Post a message to every open terminal window this worker can talk to.
// Empty when the app is closed — then the loop runs zero times and nothing is sent, which is fine:
// the durable stores (outbox, inbound) carry the state, and the next open reads it.
async function postToClients(message: unknown): Promise<void> {
  const clients = await worker.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of clients) client.postMessage(message);
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
  // The reply channel to notify when this message settles, if this browser has one.
  // Sent with the batch so the kernel ties the answer's nudge to the right channel.
  const replyChannelId = await getReplyChannelId();
  let body: Envelope | null = null;
  // Abort a hung send so the drain always settles —
  // otherwise the in-flight lock below would stick and block every later drain.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${KERNEL_URL}/intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        line: formatBatch(pending),
        ...(replyChannelId !== null ? { reply_channel_id: replyChannelId } : {}),
      }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    body = res.ok ? await res.json().catch(() => null) : null;
  } catch {
    // COPY only on a real receipt — a 200 with the wrong shape, a CORS-blocked read,
    // or any network error all mean the kernel didn't receive it. Leave body null.
    body = null;
  } finally {
    clearTimeout(timer);
  }
  if (!isCopy(body)) {
    await notify("requeued", ids);
    throw new Error("outbox drain failed — will retry on sync");
  }
  // Delivered. Before clearing the outbox, start tracking this message as inbound —
  // keyed by the id the ack handed back, and by that alone: no copy of the lines we sent,
  // so an inbound message produced later (even with the app shut) has a handle to surface against,
  // and is shown on its own terms rather than quoted back against what we said.
  // If the ack carried no id we still clear (the line *is* delivered),
  // just with no inbound entry to reconcile later.
  const kernelId = copyId(body);
  if (kernelId !== null) {
    await track(kernelId, new Date().toISOString());
  }
  await markDelivered(ids);
  await notify("delivered", ids);
}

// Coalesce overlapping triggers (a flush message and a sync event firing at once)
// onto a single in-flight drain, so the batch can't be sent twice.
let draining: Promise<void> | null = null;
export function drain(): Promise<void> {
  if (!draining) draining = drainOutbox().finally(() => (draining = null));
  return draining;
}

// --- cache lifecycle ------------------------------------------------------

// Precache the shell, then take over without waiting for old tabs to close.
export async function precacheShell(): Promise<void> {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  await worker.skipWaiting();
}

// Drop caches left by older versions, control open pages right away, then try a drain —
// both to flush anything a previous version left queued, and as the fallback path for browsers without Background Sync.
// A failure of that drain is fine: the sync registration (or the next online flush) will retry.
export async function cleanupAndClaim(): Promise<void> {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
  await worker.clients.claim();
  await drain().catch(() => {});
}

// Answer a GET the network-first way: online, take the fresh copy and stash it;
// offline, fall back to whatever we have (the shell, and any bundle from a previous visit).
export async function respondTo(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    const copy = response.clone();
    caches.open(CACHE).then((c) => c.put(request, copy));
    return response;
  } catch {
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
  }
}

// --- the reply channel: a kernel push says there's something to read -------

// A push carries only a nudge, never any content — nothing private rides a third-party
// push service. Every payload names its family in a `kind`, and the two are told apart on
// that one field:
//
//   • a reply nudge — {kind: "reply", id, status} — for an answer to a line the symbiot sent.
//     We fetch the real reply from /answers, hand it to any open terminal to render inline,
//     and show a notification. We deliberately do NOT drop the inbound entry here: an open
//     terminal drops it once it has rendered; if none is open, it stays for the next open's
//     reconcile, so a missed render never loses the message.
//
//   • a missive nudge — {kind: "traffic waiting"} — for a message the kernel raised on its own.
//     It carries no id and no body: the message is discovered through the *authed* /inbox,
//     which the worker can't call (it holds no session token). So the worker's whole job
//     here is to tell any open page to reconcile its traffic waiting, and to show a notification. If
//     no page is open, opening one from the notification runs the same reconcile at
//     launch — so the missive surfaces either way.
//
// A kind we don't recognise (or an unreadable payload) still owes a notification —
// a subscription is userVisibleOnly — so it falls through to a generic one rather than acting.
export async function handlePush(event: PushEvent): Promise<void> {
  let payload: { id?: unknown; kind?: unknown } | undefined;
  try {
    payload = event.data?.json();
  } catch {
    // Unreadable payload — we can't act on it, but still surface the generic notification below.
  }

  // A missive nudge: no content to fetch, just ask any open page to pull traffic waiting.
  if (payload?.kind === KERNEL_MSG.trafficWaiting) {
    await postToClients({ type: KERNEL_MSG.trafficWaiting });
    await worker.registration.showNotification("The Joy", {
      body: "The Joy has something for you.",
      tag: "traffic-waiting", // coalesce repeated missive nudges into one notification
    });
    return;
  }

  // A reply nudge for the symbiot's own message.
  if (payload?.kind === KERNEL_MSG.reply) {
    const id = typeof payload.id === "number" ? payload.id : null;
    let outcome: Outcome = { status: "pending", answer: null };
    if (id !== null) {
      try {
        const res = await fetch(`${KERNEL_URL}/answers?id=${id}`, { cache: "no-store" });
        outcome = readOutcome(res.ok ? await res.json().catch(() => null) : null);
      } catch {
        // Couldn't reach /answers — leave it pending; the notification still says to look,
        // and the next open reconciles from the inbound store.
      }
    }
    await postToClients({ type: "answer", id, status: outcome.status, answer: outcome.answer });
    await worker.registration.showNotification("The Joy", {
      body: _notificationBody(outcome),
      tag: id !== null ? `answer-${id}` : undefined, // one message, one notification, replaced not stacked
      data: { id },
    });
    return;
  }

  // An unknown kind: nothing to act on, but the subscription still owes a visible notification.
  await worker.registration.showNotification("The Joy", {
    body: "there's an update on your message.",
  });
}

function _notificationBody(outcome: Outcome): string {
  if (outcome.status === "answer") return outcome.answer || "your message has an answer.";
  if (outcome.status === "abandoned") return KERNEL_LINE.abandonedNotice;
  return "there's an update on your message.";
}

// Clicking the notification brings the terminal forward —
// focusing an open one, or opening a fresh one — where the answer is waiting to be shown.
export async function focusOrOpen(): Promise<void> {
  const clients = await worker.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of clients) {
    if ("focus" in client) {
      await (client as WindowClient).focus();
      return;
    }
  }
  await worker.clients.openWindow?.("./");
}
