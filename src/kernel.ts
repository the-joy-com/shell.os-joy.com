// The kernel's reply contract, described from the shell's side.
//
// Every kernel response wears one envelope — { msg, data } —
// where `msg` is a fixed protocol token, not free-form text.
// The shell decides what happened by matching that token exactly (a healthy probe, a received line),
// so the tokens must be named in one place rather than sprinkled as bare strings across the call sites:
// one definition to match against, one place to change if the contract ever moves.
//
// Shared by the page and the worker,
// so it stays free of import.meta.env and anything else that only one side can see.

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
// Mirrored from protocol.py — grouped by round trip, alphabetical within each group.
export const KERNEL_MSG = {
  // health
  greeting: "the ghost in the shell", // GET / — a legible name on the door
  ok: "loud and clear", // GET /health — radio check: the kernel is up and reading you
  // intake / answers
  abandoned: "abandoned", // /answers — the kernel gave up on the message
  answer: "answer", // /answers — the message is answered; data.answer holds the reply
  copy: "roger", // /intake — received all your last, durably written down
  pending: "wait out", // /answers — still in flight, no outcome yet
  reply: "reply", // push nudge kind — a reply to the symbiot's own message; its outcome rides in status
  unknown: "unknown", // /answers — no message with that id
  // traffic waiting
  trafficWaiting: "traffic waiting", // GET /inbox — the symbiot's unseen inbound
  // identity
  authed: "authenticated", // GET /status — a live session
  loggedIn: "logged in", // POST /login/verify — the code was good
  loggedOut: "out", // POST /logout — signing off; session revoked
  notAuthed: "not authenticated", // GET /status — no live session
  // notifications
  notifications: "notifications", // GET/POST /notifications — per-channel enable/disable state in data.channels
  // observe
  observeMachineEchoes: "observe echoes", // GET /observe/echoes — scored redundancy in data (clusters, singles, scored)
  // models
  models: "models", // GET /models and a successful POST — catalog, roles, assignable_roles in data
  modelRefused: "that model change didn't take", // POST /models — refused; data.reason says why, state alongside
  // timezone
  timezoneSet: "time hack", // POST /timezone — place placed; IANA zone in data.timezone
  timezoneUnclear: "say again", // POST /timezone — couldn't resolve; nothing stored
  // push
  pushKey: "push key", // GET /push/key — the public app-server key
  subscribed: "subscribed", // POST /push/subscribe — channel registered
} as const;

// Human-legible lines the protocol defines for the shell to show.
// Mirrored from protocol.py so a vocabulary drift fails loudly in tests.
export const KERNEL_LINE = {
  abandonedNotice: "no joy", // shown when a message is abandoned — retry budget spent
  loginFailed: "that code didn't work — try again", // POST /login/verify — wrong or spent code
  loginSent: "if that address is registered, a login code is on its way", // POST /login
  standinAnswerAnon: "authenticate", // placeholder reply to an unauthed line — the caller isn't recognized
  standinAnswerAuthed: "good copy", // placeholder reply to a recognized symbiot's line; the kernel picks which, by session
} as const;

// True only when the kernel really acked receipt of a line —
// the one signal allowed to turn a marker into COPY.
// Anything else (wrong shape, a CORS-blocked read, a network error, or a null body) is not a receipt.
export function isCopy(body: Envelope | null): boolean {
  return body?.msg === KERNEL_MSG.copy;
}

// The kernel message id carried on a COPY ack (data.id), or null if this wasn't a receipt.
// This is the handle the shell keeps to ask /answers what became of the message.
export function copyId(body: Envelope | null): number | null {
  if (!isCopy(body)) return null;
  const id = (body?.data as { id?: unknown } | null)?.id;
  return typeof id === "number" ? id : null;
}

// True only when the kernel's health probe answered with the alive token.
export function isOk(body: Envelope | null): boolean {
  return body?.msg === KERNEL_MSG.ok;
}

// A message's outcome as /answers reports it, parsed into what the shell renders.
// `answer` is the reply text when settled with one; null for every other outcome.
export interface Outcome {
  status: "answer" | "abandoned" | "pending" | "unknown";
  answer: string | null;
}

// Parse a /answers reply.
// Anything unrecognised (a wrong shape, a null body, a token we don't know) reads as "pending" —
// the safe default: keep tracking it rather than declare an outcome we can't stand behind,
// so a garbled read never drops a message on the floor.
export function readOutcome(body: Envelope | null): Outcome {
  if (body?.msg === KERNEL_MSG.answer) {
    const answer = (body.data as { answer?: unknown } | null)?.answer;
    return { status: "answer", answer: typeof answer === "string" ? answer : "" };
  }
  if (body?.msg === KERNEL_MSG.abandoned) return { status: "abandoned", answer: null };
  if (body?.msg === KERNEL_MSG.unknown) return { status: "unknown", answer: null };
  return { status: "pending", answer: null };
}
