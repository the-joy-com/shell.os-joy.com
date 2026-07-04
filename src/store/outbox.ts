// The outbox — a durable queue of captured lines waiting to reach the kernel.
//
// It lives in IndexedDB, not memory, on purpose:
// a line is written here *before* anything is sent,
// so it survives a dropped network, a reload, and a full app close —
// and the service worker can drain it on reconnect even with no page open.
//
// This module is shared by both worlds:
// the page enqueues here, the worker reads and clears here.
// IndexedDB is available in both a Window and a ServiceWorkerGlobalScope,
// so the same code runs on either side.
//
// `id` is the autoincrement key — client-side bookkeeping only.
// It orders the queue (ascending id == submit order) and lets the page map a row to its marker,
// but it NEVER crosses the wire: the batch sent to the kernel carries only timestamps and text
// (see formatBatch).
//
// The database itself (name, version, stores) lives in idb.ts, shared with the inbound and meta stores;
// this module owns only the lines store.

import { OUTBOX_STORE as STORE, openDb, tx } from "./idb";

// The Background Sync tag the page registers and the worker listens for.
// Shared here so the two sides can never drift to different strings.
export const SYNC_TAG = "flush-outbox";

export interface OutboxEntry {
  // Autoincrement primary key. Submit order is ascending id. Local only.
  id: number;
  // The raw line the symbiot typed.
  text: string;
  // ISO timestamp stamped at the moment of capture, not of delivery —
  // so a line queued offline carries when it was *said*, not when it finally lands.
  ts: string;
}

// Append a line to the queue and return the stored entry —
// the page needs the assigned id to tie the row to its marker.
export async function enqueue(text: string): Promise<OutboxEntry> {
  const entry = { text, ts: new Date().toISOString() } as OutboxEntry;
  const db = await openDb();
  try {
    const id = await tx<IDBValidKey>(db, STORE, "readwrite", (store) => store.add(entry));
    entry.id = id as number;
    return entry;
  } finally {
    db.close();
  }
}

// Everything still waiting, in submit order.
// getAll on an autoincrement store returns rows by ascending key == FIFO.
export async function allPending(): Promise<OutboxEntry[]> {
  const db = await openDb();
  try {
    return await tx<OutboxEntry[]>(db, STORE, "readonly", (store) => store.getAll());
  } finally {
    db.close();
  }
}

// Drop delivered entries. Called once the kernel has truly acked the batch —
// there's no server-side dedup and no session resume, so a delivered line has no reason to linger.
// One transaction deletes the whole batch atomically.
export async function markDelivered(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      const store = t.objectStore(STORE);
      for (const id of ids) store.delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

// Render a batch as the single payload the kernel receives.
// Each line is prefixed with its capture timestamp; the lines are joined by newlines —
// so a reconnect arrives as one coherent, ordered transmission rather than N context-free pings.
// Ids are deliberately absent: they're local bookkeeping and never touch the wire.
export function formatBatch(entries: OutboxEntry[]): string {
  return entries.map((e) => `[${e.ts}] ${e.text}`).join("\n");
}
