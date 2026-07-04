// Meta — the scrap of state the page and the service worker have to share.
//
// The shell runs in two separate JavaScript worlds that can't see each other's memory:
// the page (the terminal the symbiot types into) and the service worker
// (the background script that actually delivers lines to the kernel and wakes on a push).
// The usual bridge between page-side code, localStorage, is page-only — the worker can't read it —
// so IndexedDB is the one store both sides can open,
// and anything one side produces for the other to consume has to pass through it.
//
// Today there is exactly one such thing: the reply-channel id.
//   • The page mints it: /notify subscribes the browser to push and registers that with the
//     kernel (POST /push/subscribe), which returns an id naming this browser's reply channel;
//     the page writes it here (setReplyChannelId, see notify.ts).
//   • The worker spends it: when it delivers a batch of lines to /intake it tags the batch
//     with that id (getReplyChannelId, see sw.ts), so the kernel knows which channel to nudge
//     once the message is answered or abandoned.
// Without this hand-off the kernel would still store the answer, but have no channel to nudge —
// the reply would wait silently for the next open instead of tapping the symbiot on the shoulder.
//
// Deliberately small and untyped-by-key: it holds this one value and shouldn't grow into a junk drawer.
// Anything durable and structured enough to deserve its own shape earns its own store,
// the way the outbox (lines) and inbound stores do.

import { META_STORE as STORE, openDb, tx } from "./idb";

const REPLY_CHANNEL_ID = "replyChannelId";

interface MetaRow {
  key: string;
  value: unknown;
}

async function get(key: string): Promise<unknown> {
  const db = await openDb();
  try {
    const row = await tx<MetaRow | undefined>(db, STORE, "readonly", (store) => store.get(key));
    return row?.value;
  } finally {
    db.close();
  }
}

async function set(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, STORE, "readwrite", (store) => store.put({ key, value } as MetaRow));
  } finally {
    db.close();
  }
}

// The kernel-assigned reply-channel id, or null if this browser hasn't registered one.
// The worker reads it to tag /intake; the page writes it after /push/subscribe.
export async function getReplyChannelId(): Promise<number | null> {
  const value = await get(REPLY_CHANNEL_ID);
  return typeof value === "number" ? value : null;
}

export async function setReplyChannelId(id: number): Promise<void> {
  await set(REPLY_CHANNEL_ID, id);
}
