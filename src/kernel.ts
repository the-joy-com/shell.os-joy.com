// The kernel's reply contract, described from the shell's side.
//
// Every kernel response wears one envelope — { msg, data } —
// where `msg` is a fixed protocol token, not free-form text.
// The shell decides what happened by matching that token exactly (a healthy probe, a received line),
// so the tokens must be named in one place rather than sprinkled as bare strings across the call sites:
// one definition to match against, one place to change if the contract ever moves.
//
// Shared by the page and the worker, so it stays free of import.meta.env and anything else that only one side can see.

// Every kernel reply, parsed.
// `data` is whatever the route carries (or null);
// the shell reads `msg` to know what happened and `data` to act on it.
export interface Envelope<T = unknown> {
  readonly msg: string;
  readonly data: T;
}

// The `msg` tokens the shell checks for.
// `as const` pins each to its exact string literal,
// so a comparison is checked against the real token, not a loose string.
export const KERNEL_MSG = {
  ok: "ok", // /health answered — the kernel is alive
  copy: "copy", // /intake received the line
} as const;

// True only when the kernel really acked receipt of a line —
// the one signal allowed to turn a marker into COPY.
// Anything else (wrong shape, a CORS-blocked read, a network error, or a null body) is not a receipt.
export function isCopy(body: Envelope | null): boolean {
  return body?.msg === KERNEL_MSG.copy;
}

// True only when the kernel's health probe answered with the alive token.
export function isOk(body: Envelope | null): boolean {
  return body?.msg === KERNEL_MSG.ok;
}
