import type { Term } from "./term";
import { type Envelope, KERNEL_LINE, readOutcome } from "./kernel";
import { getToken } from "./session";
import { allInbound, forget, isTracked } from "./store/inbound";
import { enqueue, SYNC_TAG } from "./store/outbox";

// The capture loop: take a line the symbiot typed, get it to the kernel,
// and keep the little marker under it honest about where it is.
//
// The page never sends anything itself anymore —
// it writes the line to the outbox and asks the service worker to deliver.
// The worker is what reaches the kernel (so a line still goes up after the network returns, even with the app closed),
// and it reports back here, by id, so each marker can be updated:
//   • delivered → a bright COPY
//   • requeued  → back to a waiting ⋯ queued
//
// A marker is just a log line the terminal handed back as a node,
// so repainting it is setting that node's text —
// no cursor to move, no row to find, and it reads as "gone" precisely when the node has left the document (a /clear, say).

// Marker text. Dim while waiting, bright once the kernel has it.
const SENDING = "\x1b[2m⋯ sending…\x1b[0m"; // online, an attempt is in flight
const QUEUED = "\x1b[2m⋯ queued\x1b[0m"; // offline, held until the network returns
const COPY = "\x1b[92mCOPY\x1b[0m"; // received, repainted in place
// Printed fresh when the marker's node is gone —
// the log was wiped by a /clear, or the line never had a marker (a queued line delivered after a reopen) —
// so there's nothing to repaint.
// One summary for the whole drained batch, not one identical notice per line.
function copyFresh(n: number): string {
  const tail = n === 1 ? "queued line delivered" : `${n} queued lines delivered`;
  return `\x1b[92mCOPY\x1b[0m \x1b[2m(${tail})\x1b[0m`;
}

// A kernel answer, printed as a fresh line that stands on its own terms.
// `❮ joy` mirrors the prompt's `joy ❯` — a reply coming back where a line went out.
// Green when answered, red when the kernel gave up.
// It does not name or quote what it answers: inbound is decoupled from the sender,
// so the shell keeps no copy of the line it once sent, and the answer is shown as itself.
const JOY_IN = "\x1b[92m❮ joy\x1b[0m"; // an answer arriving
const JOY_GAVE_UP = "\x1b[31m❮ joy\x1b[0m"; // the kernel abandoned the message

// The line shown for a settled message,
// or null when there's nothing to show (still pending, or an id the kernel disowns —
// those are handled by forgetting, not printing).
function answerLine(status: string, answer: string): string | null {
  if (status === "answer") return `${JOY_IN} ${answer}`;
  if (status === "abandoned") return `${JOY_GAVE_UP} ${KERNEL_LINE.abandonedNotice}`;
  return null;
}

// Background Sync isn't in the standard DOM lib, so describe the slice we use.
interface SyncManagerLike {
  register(tag: string): Promise<void>;
}
interface RegistrationWithSync extends ServiceWorkerRegistration {
  readonly sync?: SyncManagerLike;
}

// What the worker posts back to the page (see sw.ts notify()).
interface Verdict {
  type: "delivered" | "requeued";
  ids: number[];
}

function isVerdict(data: unknown): data is Verdict {
  const v = data as Verdict;
  return (
    !!v &&
    (v.type === "delivered" || v.type === "requeued") &&
    Array.isArray(v.ids)
  );
}

export interface Capture {
  // Capture a typed line. Never blocks.
  // The marker is drawn at once; persist + delivery happen in the background.
  submit(text: string): void;
  // Apply a worker verdict to the markers it names.
  applyVerdict(data: unknown): void;
  // Apply an inbound message the worker pushed (from a kernel push): render it and stop tracking it.
  applyAnswer(data: unknown): void;
  // Nudge the worker to drain the outbox now — used at startup and on reconnect.
  // Also the fallback for browsers without Background Sync.
  flushNow(): void;
  // Reconcile the inbound store against the kernel:
  // surface anything inbound we haven't seen yet (including messages settled while the app was shut),
  // then stop tracking it.
  // The backbone of the reply channel — a push only surfaces one sooner;
  // this is what guarantees none is lost.
  flushAnswers(): void;
  // Start (or re-arm) the on-page poll that surfaces an in-flight reply live, without a push.
  // Called on open/refocus; self-terminating when nothing is in-flight or the tab is hidden.
  startAnswerPoll(): void;
  // Discover and surface messages the kernel raised for the symbiot on its own —
  // ones this shell never sent, so there's no local id to reconcile from.
  // Identity-gated: a no-op without a session. Shown once, then acknowledged so they don't return.
  flushInbox(): void;
}

export function createCapture(term: Term, hooks: { kernelUrl: string }): Capture {
  // Each queued line's marker node, by outbox id.
  // The node is the log line the terminal handed back at submit;
  // a delivery verdict repaints it, and a /clear that removes it is read as "gone" via isConnected.
  const markers = new Map<number, HTMLElement>();

  // Ask the worker to deliver: register a Background Sync (the durable retry-on-reconnect,
  // fires even with the app closed) and post a "flush" so a line typed online goes up at once.
  // If Background Sync is missing, the post and the worker's activate-time flush still cover it.
  async function requestFlush(): Promise<void> {
    if (!("serviceWorker" in navigator)) return;
    const reg = (await navigator.serviceWorker.ready) as RegistrationWithSync;
    try {
      await reg.sync?.register(SYNC_TAG);
    } catch {
      // Background Sync unsupported or blocked — the flush below is the fallback.
    }
    reg.active?.postMessage({ type: "flush" });
  }

  function submit(text: string): void {
    // Draw the marker as its own log line right away —
    // the terminal already echoed the typed line and the prompt is still live below,
    // so the symbiot is never made to wait on storage or the network to say the next thing.
    const node = term.writeLine(navigator.onLine ? SENDING : QUEUED);
    // Persist and hand off to the worker in the background.
    void (async () => {
      const entry = await enqueue(text);
      markers.set(entry.id, node);
      await requestFlush();
    })();
  }

  // Repaint a marker's node in place, leaving the input untouched.
  // Returns false if the node is gone (removed by a /clear), so the caller can fall back to printing fresh.
  function repaint(node: HTMLElement, text: string): boolean {
    if (!node.isConnected) return false;
    term.restyle(node, text);
    return true;
  }

  // Print a notice as a new line above the input.
  // For deliveries whose marker no longer exists — most often lines that were queued,
  // the app closed, and the worker delivered them after a reopen onto a fresh log.
  function printFresh(text: string): void {
    term.writeLine(text);
  }

  function applyVerdict(data: unknown): void {
    if (!isVerdict(data)) return;
    if (data.type === "delivered") {
      // Repaint each marker still on screen in place.
      // Tally the ones whose node is gone (a /clear) and announce them with a single fresh summary —
      // so a drained queue of N lines reads as one notice, not N identical ones.
      let gone = 0;
      for (const id of data.ids) {
        const node = markers.get(id);
        if (!node || !repaint(node, COPY)) gone++;
        markers.delete(id);
      }
      if (gone > 0) printFresh(copyFresh(gone));
      // The line is now durably in-flight; watch for its answer while the symbiot is here.
      startAnswerPoll();
    } else {
      // Requeued: show each waiting again if its node is still on screen.
      // If it's gone, there's nothing to show now — it stays in the outbox,
      // and a later delivery prints fresh.
      for (const id of data.ids) {
        const node = markers.get(id);
        if (node) repaint(node, QUEUED);
      }
    }
  }

  function flushNow(): void {
    void requestFlush();
  }

  // Render an inbound message and stop tracking it.
  // Shared by the push path and the reconcile path,
  // so both surface a message the same way and neither shows it twice.
  async function surface(id: number, status: string, answer: string): Promise<void> {
    const line = answerLine(status, answer);
    if (line) printFresh(line);
    // Forget it once shown, or if the kernel disowns the id (unknown) — either way it will never need surfacing again.
    // A still-pending message returns no line and is left be.
    if (line || status === "unknown") await forget(id);
    // Once the outcome is actually on screen, tell the kernel it's out.
    // This is the reply's counterpart to the outbox's COPY:
    // the kernel marks it delivered on a real showing, never on a hopeful guess.
    if (line) void ackDelivered(id);
  }

  // Confirm to the kernel that a message's outcome has been shown, so it can mark the reply truly out.
  // Unauthed like /answers itself — the id is the capability — and fire-and-forget:
  // a lost ack is harmless, the outcome was shown, only the kernel's delivered_at stays unset.
  async function ackDelivered(id: number): Promise<void> {
    try {
      await fetch(`${hooks.kernelUrl}/answers/delivered`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
    } catch {
      // Ack didn't land — harmless; the reply was shown, only delivered_at stays unset.
    }
  }

  function applyAnswer(data: unknown): void {
    // The worker forwards a kernel push as { type: "answer", id, status, answer }.
    const msg = data as { type?: string; id?: number; status?: string; answer?: string | null };
    if (msg?.type !== "answer" || typeof msg.id !== "number") return;
    void (async () => {
      // Dedup by id: if it's no longer tracked, a reconcile already surfaced it.
      if (!(await isTracked(msg.id!))) return;
      await surface(msg.id!, msg.status ?? "", msg.answer ?? "");
    })();
  }

  // Reconcile every tracked in-flight id against the kernel, surfacing whatever has settled.
  // The awaitable core behind flushAnswers and the live-reply poll below.
  async function reconcileAnswers(): Promise<void> {
    for (const entry of await allInbound()) {
      let body: Envelope | null = null;
      try {
        const res = await fetch(`${hooks.kernelUrl}/answers?id=${entry.id}`, { cache: "no-store" });
        body = res.ok ? await res.json().catch(() => null) : null;
      } catch {
        body = null; // couldn't reach the kernel — leave it tracked, try again next open
      }
      const outcome = readOutcome(body); // a null body reads as pending, so nothing is dropped
      await surface(entry.id, outcome.status, outcome.answer ?? "");
    }
  }

  function flushAnswers(): void {
    void reconcileAnswers();
  }

  // --- live reply: surface an in-flight answer on the page, without a push and without a reload ---
  // Push is for when the app is closed; this is the on-page path, and a visitor gets it for free —
  // no subscription, no login. After a line is delivered (COPY), the worker takes a moment to answer,
  // so we keep reconciling until it lands, then stop. The poll runs only while something is in-flight
  // and the tab is actually being watched; it stops itself the instant the tracked set empties or the
  // tab is hidden (a refocus restarts it, see main.ts), so it never churns in the background.
  // Snappy at first, then easing off, so a slow or hung message doesn't hammer the kernel.
  const POLL_BACKOFF_MS = [900, 900, 1500, 2500, 4000]; // step delays; the last repeats until settled
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollStep = 0;

  async function pollTick(): Promise<void> {
    pollTimer = null;
    if (document.hidden) return; // not being watched — a refocus will restart the poll
    if ((await allInbound()).length === 0) return; // nothing in-flight — nothing to wait for
    await reconcileAnswers(); // render whatever is ready; surface() drops each shown id from the tracked set
    if ((await allInbound()).length === 0) return; // all surfaced — done until the next line
    const delay = POLL_BACKOFF_MS[Math.min(pollStep, POLL_BACKOFF_MS.length - 1)];
    pollStep += 1;
    pollTimer = setTimeout(() => void pollTick(), delay);
  }

  // Start (or re-arm) the live-reply poll: on a fresh delivery, and on open/refocus in case a reply
  // is still owed from before. Resets the cadence so a new line always gets the snappy first tick.
  // A no-op in effect when nothing is tracked — the first tick sees an empty set and stops.
  function startAnswerPoll(): void {
    pollStep = 0;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void pollTick(), POLL_BACKOFF_MS[0]);
  }

  // Discover unsolicited inbound: messages the kernel raised for the symbiot that this
  // shell never sent, so nothing local points at them. /answers can't reach them (it's
  // unauthed, keyed by an id we'd have to already hold); /inbox is the authed discovery.
  // Surface each, then acknowledge so the kernel stops offering it.
  function flushInbox(): void {
    // These messages are addressed to a symbiot, so there's nothing to fetch without a session.
    const token = getToken();
    if (!token) return;
    void (async () => {
      let messages: { id: number; body: string }[] = [];
      try {
        const res = await fetch(`${hooks.kernelUrl}/inbox`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const body: Envelope | null = res.ok ? await res.json().catch(() => null) : null;
        const list = (body?.data as { messages?: unknown } | null)?.messages;
        if (Array.isArray(list)) {
          messages = list.filter(
            (m): m is { id: number; body: string } =>
              !!m &&
              typeof (m as { id?: unknown }).id === "number" &&
              typeof (m as { body?: unknown }).body === "string",
          );
        }
      } catch {
        return; // couldn't reach the kernel — try again next open
      }
      if (messages.length === 0) return;
      for (const m of messages) {
        const line = answerLine("answer", m.body);
        if (line) printFresh(line);
      }
      // Acknowledge only once they're shown. An ack that never lands just surfaces them
      // again next time — the safe direction (at-least-once), never a message dropped silently.
      try {
        await fetch(`${hooks.kernelUrl}/inbox/seen`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ ids: messages.map((m) => m.id) }),
        });
      } catch {
        // Ack didn't land — harmless; they'll be offered again and shown once more.
      }
    })();
  }

  return { submit, applyVerdict, applyAnswer, flushNow, flushAnswers, flushInbox, startAnswerPoll };
}
