import type { Terminal } from "@xterm/xterm";
import { enqueue, SYNC_TAG } from "./outbox";

// The capture loop: take a line the symbiot typed, get it to the kernel,
// and keep the little marker under it honest about where it is.
//
// The page never sends anything itself anymore — it writes the line to the outbox
// and asks the service worker to deliver. The worker is what reaches the kernel
// (so a line still goes up after the network returns, even with the app closed),
// and it reports back here, by id, so each marker can be updated:
//   • delivered → a bright COPY
//   • requeued  → back to a waiting ⋯ queued
//
// Two things are deliberately kept out of this file: the prompt and the in-progress input line.
// Those belong to the terminal, so the caller hands us two small functions —
// one to draw a fresh prompt, one to redraw the line the symbiot is currently typing —
// and we call them when delivery output has to share the screen with live typing.

// Marker text. Dim while waiting, bright once the kernel has it.
const SENDING = "\x1b[2m⋯ sending…\x1b[0m"; // online, an attempt is in flight
const QUEUED = "\x1b[2m⋯ queued\x1b[0m"; // offline, held until the network returns
const COPY = "\x1b[92mCOPY\x1b[0m"; // received, repainted in place
// Printed fresh when the markers are gone — the screen was wiped by a
// reload/reopen, or the lines scrolled off — so there's nothing to repaint.
// One summary for the whole drained batch, not one identical notice per line.
function copyFresh(n: number): string {
  const tail = n === 1 ? "queued line delivered" : `${n} queued lines delivered`;
  return `\x1b[92mCOPY\x1b[0m \x1b[2m(${tail})\x1b[0m`;
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
  // The marker and a fresh prompt are drawn at once; persist + delivery happen in the background.
  submit(text: string): void;
  // Apply a worker verdict to the markers it names.
  applyVerdict(data: unknown): void;
  // Nudge the worker to drain the outbox now — used at startup and on reconnect.
  // Also the fallback for browsers without Background Sync.
  flushNow(): void;
}

export function createCapture(
  term: Terminal,
  hooks: { prompt: () => void; redrawInput: () => void },
): Capture {
  // Each queued line's marker row, by outbox id.
  // A row holder (not a bare number) so the value can be filled in by the marker's async write callback,
  // even after the outbox write that gave us the id has already resolved.
  const rows = new Map<number, { row: number }>();

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
    // Draw the marker and hand the prompt straight back — synchronously —
    // so the symbiot is never made to wait on storage or the network to say the next thing.
    // The marker's row is captured in the write callback.
    const slot = { row: -1 };
    term.write(navigator.onLine ? SENDING : QUEUED, () => {
      const buf = term.buffer.active;
      slot.row = buf.baseY + buf.cursorY;
    });
    term.write("\r\n");
    hooks.prompt();
    // Persist and hand off to the worker in the background.
    void (async () => {
      const entry = await enqueue(text);
      rows.set(entry.id, slot);
      await requestFlush();
    })();
  }

  // Repaint a marker's row in place, leaving the line being typed untouched.
  // Returns false if the row is gone (scrolled off, or wiped by a reopen), so
  // the caller can fall back to printing fresh.
  function repaint(row: number, text: string): boolean {
    const buf = term.buffer.active;
    const rowsUp = buf.baseY + buf.cursorY - row;
    if (row < 0 || row < buf.baseY || rowsUp <= 0) return false;
    // save cursor · up to the row · col 0 · wipe it · text · restore cursor.
    term.write(`\x1b7\x1b[${rowsUp}A\r\x1b[2K${text}\x1b8`);
    return true;
  }

  // Print a COPY notice as a new line above the prompt, then put the symbiot's in-progress line back.
  // For deliveries whose marker no longer exists — most often lines that were queued,
  // the app closed, and the worker delivered them after a reopen onto a blank screen.
  function printFresh(text: string): void {
    term.write("\r\x1b[2K"); // wipe the current prompt+input line
    term.write(`${text}\r\n`); // the notice
    hooks.redrawInput(); // prompt + whatever was being typed
  }

  function applyVerdict(data: unknown): void {
    if (!isVerdict(data)) return;
    if (data.type === "delivered") {
      // Repaint each marker still on screen in place. Tally the ones whose
      // marker is gone (reload/reopen, or scrolled off) and announce them with
      // a single fresh summary — so a drained queue of N lines reads as one
      // notice, not N identical ones.
      let gone = 0;
      for (const id of data.ids) {
        const slot = rows.get(id);
        if (!slot || !repaint(slot.row, COPY)) gone++;
        rows.delete(id);
      }
      if (gone > 0) printFresh(copyFresh(gone));
    } else {
      // Requeued: show each waiting again if its marker is still on screen.
      // If it's gone, there's nothing to show now — it stays in the outbox,
      // and a later delivery prints fresh.
      for (const id of data.ids) {
        const slot = rows.get(id);
        if (slot) repaint(slot.row, QUEUED);
      }
    }
  }

  function flushNow(): void {
    void requestFlush();
  }

  return { submit, applyVerdict, flushNow };
}
