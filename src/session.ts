// The session token — the one piece of identity the shell carries across a reload.
//
// Everything else a fresh open forgets:
// the terminal comes up blank, no scrollback, no history (that's the no-resume rule).
// Identity is the deliberate exception, and a narrow one.
// Logging in again on every refresh is friction the symbiot shouldn't have to pay,
// so the opaque bearer token the kernel mints is kept here,
// reused until /logout drops it or the kernel rejects it.
//
// Only the token is stored — never the code, never the email.
// The kernel holds just its hash and the token carries a TTL,
// so at rest this is a short-lived bearer credential, not a standing secret.
//
// localStorage is the page's home of record, but the service worker — the one that actually
// POSTs /intake — can't read it, so setToken/clearToken also mirror the token into the shared
// IndexedDB meta store, which the worker can read. That mirror is what lets the kernel see whose
// line each one is. A mirror write that fails degrades safely: the worker just sends the line
// unauthed, which under-claims identity rather than misclaiming it, and never breaks the session.

import { clearSessionToken, setSessionToken } from "./store/meta";

const KEY = "joy.session.token";

// A mirror of the stored token,
// so a session still works for the life of the tab
// even when localStorage is unavailable (private mode, storage disabled) —
// there it just won't survive a reload, which is the honest degradation, not a crash.
let memory: string | null = null;

// The current token, or null when logged out.
export function getToken(): string | null {
  if (memory !== null) return memory;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

// Remember a freshly minted token, for this tab and across reloads.
// Awaited by callers so the worker-visible mirror is in place before the "logged in" line prints —
// by the time the symbiot can type, the worker can already read the token to authenticate the line.
export async function setToken(token: string): Promise<void> {
  memory = token;
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // Storage blocked — the in-memory mirror still carries the session for this tab;
    // only its survival across a reload is lost.
  }
  try {
    await setSessionToken(token);
  } catch {
    // The worker-visible mirror didn't land — the worker will send lines unauthed until the next write;
    // that under-claims identity, the safe direction, and never breaks the page's own session.
  }
}

// Forget the token — on /logout, or when the kernel says it buys nothing.
export async function clearToken(): Promise<void> {
  memory = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing persisted to clear.
  }
  try {
    await clearSessionToken();
  } catch {
    // The mirror couldn't be cleared — the worker may briefly still hold a token the page has dropped.
    // It's a spent or revoked credential the kernel will reject anyway, so no authority outlives the logout.
  }
}
