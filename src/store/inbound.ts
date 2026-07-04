// Inbound — messages arriving for the symbiot, tracked only long enough to show each one once.
//
// This is the receiving channel, and it is deliberately NOT a mirror of the outbox.
// The outbox holds a line until it's delivered; this holds no line at all.
// It keeps only kernel message ids — the handles /answers is asked about —
// and nothing about what the symbiot said: no copy of the sent words, no referent.
// An arriving message is shown on its own terms; the line it answers, if any, is not kept to quote back.
//
// Its one job is that an inbound message surfaces exactly once:
// on open the shell walks these ids and asks /answers about each,
// and a push, when it arrives, only surfaces one sooner.
// Once shown, the id is dropped — there's nothing left to reconcile.
//
// It lives in the shared database (idb.ts).
// Delivery records an id here (sw.ts, on a real COPY);
// showing its answer drops it (capture.ts).

import { INBOUND_STORE as STORE, openDb, tx } from "./idb";

export interface Inbound {
  // The kernel message id — the handle /answers is asked about. Keyed on this.
  id: number;
  // When the id was recorded, ISO — for surfacing oldest first.
  // Nothing here describes the message's content; only when we started expecting it.
  ts: string;
}

// Track an inbound message we're owed a look at, by the id the kernel handed back on COPY.
export async function track(id: number, ts: string): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, STORE, "readwrite", (store) => store.put({ id, ts } as Inbound));
  } finally {
    db.close();
  }
}

// Everything still to be surfaced, oldest first — what the shell reconciles on open.
export async function allInbound(): Promise<Inbound[]> {
  const db = await openDb();
  try {
    const all = await tx<Inbound[]>(db, STORE, "readonly", (store) => store.getAll());
    return all.sort((a, b) => a.ts.localeCompare(b.ts));
  } finally {
    db.close();
  }
}

// Whether an id is still tracked, i.e. not yet surfaced —
// the dedup a push checks before rendering, so a reconcile and a push never show the same one twice.
export async function isTracked(id: number): Promise<boolean> {
  const db = await openDb();
  try {
    const row = await tx<Inbound | undefined>(db, STORE, "readonly", (store) => store.get(id));
    return row !== undefined;
  } finally {
    db.close();
  }
}

// Stop tracking one — its message has been shown, so it has no reason to surface again.
export async function forget(id: number): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, STORE, "readwrite", (store) => store.delete(id));
  } finally {
    db.close();
  }
}
