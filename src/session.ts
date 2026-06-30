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
export function setToken(token: string): void {
  memory = token;
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // Storage blocked — the in-memory mirror still carries the session for this tab;
    // only its survival across a reload is lost.
  }
}

// Forget the token — on /logout, or when the kernel says it buys nothing.
export function clearToken(): void {
  memory = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing persisted to clear.
  }
}
