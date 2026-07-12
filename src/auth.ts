// The identity flows behind /login, /logout and /status.
//
// These are the shell half of identity:
// the kernel already issues codes, spends them for sessions, and reads or revokes those sessions —
// this module just drives that exchange from the terminal and remembers the token it earns.
//
// /login is modal: it reads the email, then the code, on the lines the symbiot types next.
// main.ts owns the keyboard, so it hands us a small AuthIo — read a line, print a line —
// rather than us reaching into the terminal ourselves.
// That keeps the prompt in one place and this file free of the terminal itself.
//
// The kernel is the authority on a session's life (a day, then it's gone),
// so we never second-guess it:
// a token is sent on every privileged call,
// and the moment the kernel answers "not authed" the local token is dropped.
// The shell never claims a login the kernel wouldn't honour.

import { looksLikeEmail } from "./commands";
import { type Envelope, KERNEL_LINE, KERNEL_MSG } from "./kernel";
import { clearToken, getToken, setToken } from "./session";

// What the flows are allowed to do to the terminal — nothing more.
// readLine prompts and resolves with the next line entered, or null if the symbiot abandons it (Ctrl-C);
// print writes a line above the prompt.
export interface AuthIo {
  readLine: (prompt: string) => Promise<string | null>;
  print: (text: string) => void;
}

// The data the identity routes carry back inside the envelope.
interface SessionData {
  authed: boolean;
  email: string | null;
}
interface VerifiedData {
  token: string;
  email: string;
}

// The outcome of a kernel request, split two ways the flows must not confuse:
// `reached` is whether the kernel answered at all (any HTTP status), as opposed to a network or CORS failure;
// `envelope` is the parsed body when that answer was a 2xx carrying JSON, else null.
// A reached-but-refused request (a 422 on a malformed code, say) is reached:true, envelope:null —
// which must read very differently from "couldn't reach the kernel".
interface Reply {
  reached: boolean;
  envelope: Envelope | null;
}

// Dim and yellow helpers, so the flows read as intent, not escape codes.
const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const warn = (text: string): string => `\x1b[33m${text}\x1b[0m`;
const good = (text: string): string => `\x1b[92m${text}\x1b[0m`;

const UNREACHABLE = dim("couldn't reach the kernel — try again when it's back.");

// Reached, but the request itself was refused —
// rate-limited, or carrying a body the kernel wouldn't accept.
// Distinct from never reaching it at all.
const TURNED_AWAY = dim("the kernel turned that request away — give it a moment.");

// The kernel reached but turned the code down — a wrong guess, an expired code,
// or one malformed enough that validation refused it outright.
// One wording for all three, so a blank code can't be told apart from a bad one.
const BAD_CODE = KERNEL_LINE.loginFailed;

// A request to the kernel.
// Resolves to reached:false only when the fetch itself fails (network down, CORS, timeout);
// any HTTP answer — 2xx or not — is reached:true, with the parsed envelope when it was a 2xx.
async function call(url: string, init: RequestInit, token?: string | null): Promise<Reply> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      cache: "no-store",
    });
    return { reached: true, envelope: res.ok ? await res.json().catch(() => null) : null };
  } catch {
    return { reached: false, envelope: null };
  }
}

function postJson(url: string, body: unknown, token?: string | null): Promise<Reply> {
  return call(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    token,
  );
}

// Route a verb to its flow.
// main.ts dispatches here for the three identity commands;
// the prompt is restored by the caller once the returned promise settles.
export function runAuth(
  verb: string,
  args: string[],
  kernelUrl: string,
  io: AuthIo,
): Promise<void> {
  if (verb === "login") return login(args, kernelUrl, io);
  if (verb === "logout") return logout(kernelUrl, io);
  return status(kernelUrl, io);
}

async function login(args: string[], kernelUrl: string, io: AuthIo): Promise<void> {
  // Already authed? /login just reports who you are and does nothing else —
  // re-issuing a code over a live session would be noise.
  const existing = getToken();
  if (existing) {
    const probe = await call(`${kernelUrl}/status`, { method: "GET" }, existing);
    const data = probe.envelope?.data as SessionData | undefined;
    if (data?.authed) {
      io.print(`already ${KERNEL_MSG.loggedIn} as ${data.email}.`);
      return;
    }
    // The kernel answered and it isn't a live session — the stored token is spent
    // (a day passed, or it was revoked), so drop it and start fresh.
    // If the kernel never answered, keep the token; we can't judge it from here.
    if (probe.reached) await clearToken();
  }

  // The address: from the command if given (e.g. `/login me@x.com`), else asked.
  let address = args.join(" ").trim();
  if (!address) {
    const entered = await io.readLine("email: ");
    if (entered === null) return; // abandoned
    address = entered.trim();
  }
  if (!address) return;

  // The typo nudge, local and lenient, before anything leaves.
  // The kernel can't warn about a malformed address without becoming an enumeration oracle,
  // so the courtesy lives here — and nothing is sent on an obvious slip.
  if (!looksLikeEmail(address)) {
    io.print(warn(`hmm — “${address}” doesn't look like an email address.`));
    io.print(dim("check for a typo and try again; nothing was sent."));
    return;
  }

  const sent = await postJson(`${kernelUrl}/login`, { address });
  if (!sent.reached) {
    io.print(UNREACHABLE);
    return;
  }
  if (!sent.envelope) {
    io.print(TURNED_AWAY);
    return;
  }
  // Echo the kernel's own deliberately-bland line —
  // identical for a known address, an unknown one, or garbage, so it leaks nothing about who's registered.
  io.print(sent.envelope.msg);

  const code = await io.readLine("code: ");
  if (code === null) return;

  const verified = await postJson(`${kernelUrl}/login/verify`, { address, code: code.trim() });
  if (!verified.reached) {
    io.print(UNREACHABLE);
    return;
  }
  const data = verified.envelope?.data as VerifiedData | null;
  if (!data?.token) {
    // Reached but no token: a wrong code (a 200 with the kernel's own wording),
    // or one its validation refused outright (a 422, no envelope).
    // Both read the same, so a blank code can't be distinguished from a bad one.
    io.print(verified.envelope?.msg ?? BAD_CODE);
    return;
  }
  await setToken(data.token);
  io.print(`${good(KERNEL_MSG.loggedIn)} as ${data.email}.`);
}

async function logout(kernelUrl: string, io: AuthIo): Promise<void> {
  const token = getToken();
  if (!token) {
    io.print(KERNEL_MSG.notAuthed);
    return;
  }
  // Tell the kernel to revoke, then forget it locally.
  // The local forget is unconditional — a kernel we can't reach still logs you out of this shell,
  // and the token expires on its own server-side anyway.
  await postJson(`${kernelUrl}/logout`, {}, token);
  await clearToken();
  io.print(KERNEL_MSG.loggedOut);
}

async function status(kernelUrl: string, io: AuthIo): Promise<void> {
  const token = getToken();
  const st = await call(`${kernelUrl}/status`, { method: "GET" }, token);
  if (!st.reached) {
    // No answer — the kernel is unreachable.
    // Report that and stay silent on the session, since we can't confirm it from here.
    io.print(`kernel: ${warn("offline")}`);
    return;
  }
  io.print(`kernel: ${good("online")}`);
  const data = st.envelope?.data as SessionData | null;
  if (data?.authed) {
    io.print(`session: ${KERNEL_MSG.authed} as ${data.email}`);
  } else {
    io.print(`session: ${KERNEL_MSG.notAuthed}`);
    // The kernel says this token buys nothing —
    // drop it so the shell stops carrying a dead credential.
    if (token) await clearToken();
  }
}
