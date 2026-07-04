// The shell's IndexedDB: one database, opened the same way from both the page and the service worker,
// holding the few things that must survive a reload or a full app close.
//
// Three stores, three jobs:
//   • lines    — the outbox: captured lines not yet delivered to the kernel (outbox.ts).
//   • inbound  — the ids of messages the shell is owed a look at,
//                so an inbound message produced while the app was shut still surfaces on open (inbound.ts).
//                It keeps ids only, never anything the symbiot said.
//   • meta     — small key/value bookkeeping the worker needs but can't read from the page
//                 (localStorage is page-only),
//                 namely the reply-channel id (meta.ts).
//
// One database, one version, one place the schema is declared —
// so the page and the worker can never open it at different versions and deadlock.
// Opens are cheap and un-cached: a handle held across a service-worker restart is a footgun,
// so each call reopens.

export const DB_NAME = "joy-outbox";
// Bumped to 2 when the second and third stores were added alongside the original lines store;
// bumped to 3 when the inbound store replaced the earlier one, keyed by id and holding no sent text.
const DB_VERSION = 3;

export const OUTBOX_STORE = "lines";
export const INBOUND_STORE = "inbound";
export const META_STORE = "meta";

// The store this version dropped: its rows carried a copy of the sent text, which inbound no longer keeps.
const RETIRED_STORE = "awaiting";

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Each guarded so the upgrade is safe from any prior version: v1 had lines,
      // v2 added meta and the retired store, v3 adds inbound and drops the retired one;
      // a fresh install creates all three current stores.
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        // Autoincrement key: the store hands out ascending ids == submit order.
        db.createObjectStore(OUTBOX_STORE, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(INBOUND_STORE)) {
        // Keyed by the KERNEL message id (the handle from /intake), not autoincrement —
        // it's the id we ask /answers about, so it has to be the key we store under.
        db.createObjectStore(INBOUND_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
      if (db.objectStoreNames.contains(RETIRED_STORE)) {
        db.deleteObjectStore(RETIRED_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Run one request inside a transaction and resolve on `complete` —
// the point the write is durable — not on the request's success,
// which fires before the transaction commits.
export function tx<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = body(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
