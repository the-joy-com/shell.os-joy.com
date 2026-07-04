import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { type AuthIo, runAuth } from "./auth";
import {
  BANNER_WIDE,
  BANNER_NARROW,
  TAGLINE_WIDE,
  TAGLINE_NARROW,
  VERSION,
  WIDE_MIN_COLS,
} from "./banner";
import { createCapture } from "./capture";
import { COMMANDS, findCommand, writeLine } from "./commands";
import { type Envelope, isOk, KERNEL_MSG } from "./kernel";
import { runNotify } from "./notify";
import { registerServiceWorker } from "./pwa";

const PROMPT = "joy \x1b[32m❯\x1b[0m "; // green chevron

// Pin the running version to the bottom-right corner, present from the moment the shell opens.
// It lives outside the terminal so it never scrolls with the log,
// and reads from the same build-time VERSION the banner uses.
document.getElementById("version")!.textContent = VERSION;

// Mirror it on the bottom-left with a connectivity status —
// a coloured dot and the word to match: green "online", red "offline".
//
// "online" here means the *kernel answered*, not merely that the browser has a network:
// a live Wi-Fi behind a dead kernel must read offline,
// because the shell is nothing without the core behind it.
// So we probe the kernel's /health and flip green only on a real { msg: "loud and clear" } round trip.
//
// navigator.onLine stays as a cheap pre-check —
// if the browser already knows it's offline we skip the fetch and paint red at once.
const connection = document.getElementById("connection")!;
const KERNEL_URL = import.meta.env.VITE_KERNEL_URL ?? "https://kernel.os-joy.com";
const PROBE_INTERVAL_MS = 15_000; // gentle background poll; events cover the rest
const PROBE_TIMEOUT_MS = 4_000; // a probe that hangs this long counts as offline

let probing = false; // guard so overlapping triggers don't stack fetches

function paintConnection(online: boolean): void {
  connection.classList.toggle("online", online);
  connection.classList.toggle("offline", !online);
  connection.textContent = online ? "online" : "offline";
}

async function probeKernel(): Promise<void> {
  // No network at all — don't bother the kernel, just paint red.
  if (!navigator.onLine) {
    paintConnection(false);
    return;
  }
  if (probing) return;
  probing = true;
  // Abort a probe that hangs so a stalled socket can't freeze the dot.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${KERNEL_URL}/health`, { signal: ctrl.signal, cache: "no-store" });
    const body: Envelope | null = res.ok ? await res.json().catch(() => null) : null;
    // Green only on a real healthy envelope —
    // a 200 with the wrong shape, a CORS-blocked read, or any other status all read offline.
    paintConnection(isOk(body));
  } catch {
    // Network error, CORS rejection, or timeout abort — kernel unreachable.
    paintConnection(false);
  } finally {
    clearTimeout(timer);
    probing = false;
  }
}

// Probe now, on a gentle interval, and immediately whenever connectivity or visibility changes —
// so the dot is correct from first frame and snaps back the moment the network returns or a backgrounded tab refocuses.
probeKernel();
setInterval(probeKernel, PROBE_INTERVAL_MS);
window.addEventListener("online", probeKernel);
window.addEventListener("offline", () => paintConnection(false));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") probeKernel();
});

const term = new Terminal({
  cursorBlink: true,
  fontFamily: '"Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
  fontSize: 14,
  theme: {
    background: "#0b0e0d",
    foreground: "#cfe8d8",
    cursor: "#6ee7a8",
  },
});

const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal")!);
// Canvas renderer instead of xterm's default DOM renderer —
// far faster to paint, and unlike WebGL it has no GPU-context-loss cliff on mobile.
// Must be loaded after open().
term.loadAddon(new CanvasAddon());
fit.fit();
window.addEventListener("resize", () => fit.fit());

// --- launch ---------------------------------------------------------------

// Pick the banner that fits the terminal we actually got (phones can't hold the wide one-liner, so they get the stacked cut).
const wide = term.cols >= WIDE_MIN_COLS;
const banner = wide ? BANNER_WIDE : BANNER_NARROW;
const tagline = wide ? TAGLINE_WIDE : TAGLINE_NARROW;

for (const row of banner.split("\n")) {
  writeLine(term, `\x1b[92m${row}\x1b[0m`);
}
writeLine(term, `\x1b[2m${tagline}\x1b[0m`);
writeLine(term);
writeLine(term, "type \x1b[1m/help\x1b[0m to see what's here — \x1b[1mTab\x1b[0m autocompletes.");
writeLine(term);
prompt();

// Make the shell installable and offline-capable. Last, and off to the side — it must never delay or break the terminal that just drew above.
registerServiceWorker();

// --- line editing ---------------------------------------------------------

// xterm hands us raw keystrokes, not lines — so we keep our own buffer and echo as we go. Minimal but enough to *feel* like a shell.
let line = "";

// When a flow (login) needs the line the symbiot types next — the email, then the code —
// it parks a resolver here. While one is set, Enter feeds the line to it instead of the dispatcher,
// so the terminal is modal for the length of that read.
let pending: ((line: string | null) => void) | null = null;

// Prompt, then resolve with the next line entered — or null if it's abandoned with Ctrl-C.
function readLine(promptText: string): Promise<string | null> {
  term.write(promptText);
  return new Promise((resolve) => (pending = resolve));
}

term.onData((data) => {
  switch (data) {
    case "\r": // Enter
      term.write("\x1b[K\r\n"); // drop any inline suggestion, then newline
      if (pending) {
        // A flow is waiting on this line — hand it over and stay out of the dispatcher.
        const resolve = pending;
        pending = null;
        const entered = line;
        line = "";
        resolve(entered);
      } else {
        handle(line);
        line = "";
      }
      break;
    case "\x7f": // Backspace
      if (line.length > 0) {
        line = line.slice(0, -1);
        term.write("\b\x1b[K"); // step back over the char, erase it + the ghost
        drawGhost();
      }
      break;
    case "\x03": // Ctrl-C — abandon the current line
      term.write("\x1b[K^C\r\n");
      line = "";
      if (pending) {
        // Abandon a flow's pending read; the flow bails and restores the prompt itself.
        const resolve = pending;
        pending = null;
        resolve(null);
      } else {
        prompt();
      }
      break;
    case "\t": // Tab — accept the inline suggestion
    case "\x1b[C": { // Right arrow — same, fish-style
      const ghost = ghostFor(line);
      if (ghost) {
        line += ghost;
        term.write(`\x1b[0m${ghost}\x1b[K`); // promote the dim ghost to real text
        drawGhost();
      }
      break;
    }
    default:
      // Printable input only; swallow other control sequences.
      if (data >= " ") {
        line += data;
        term.write("\x1b[K" + data); // erase the stale ghost, then echo the char
        drawGhost();
      }
  }
});

// --- dispatch -------------------------------------------------------------

// The identity verbs run as modal async flows (see the auth-verb branch in handle),
// not one-shot cmd.run handlers, because they read the email and the code on the lines that follow.
const AUTH_VERBS = new Set(["login", "logout", "status"]);

// The narrow surface the auth flows get on the terminal: read the next line, print a line.
const io: AuthIo = {
  readLine,
  print: (text) => writeLine(term, text),
};

function handle(raw: string): void {
  const input = raw.trim();
  if (input === "") {
    prompt();
    return;
  }

  // Bare keywords carry no slash (e.g. `reset`); check them before the slash-only gate below.
  const bareCmd = findCommand(input);
  if (bareCmd?.bare) {
    bareCmd.run?.(term, []);
    prompt();
    return;
  }

  if (!input.startsWith("/")) {
    // Not a command — it's content for The Joy.
    // Hand it to the capture loop: it draws the pending marker,
    // gives the prompt straight back, and delivers in the background.
    // No auth gate on purpose — the right to submit is never gated.
    // Identity is the server's call.
    capture.submit(input);
    return;
  }

  const [verb, ...args] = input.slice(1).split(/\s+/);

  // Identity verbs own the screen for a modal exchange (email, then code),
  // so they run as their own async flow; the prompt is restored once it settles.
  if (AUTH_VERBS.has(verb)) {
    // After the flow settles, discover any inbox waiting on a fresh session —
    // a no-op when the verb wasn't a login, or left us logged out.
    void runAuth(verb, args, KERNEL_URL, io).finally(() => {
      prompt();
      capture.flushInbox();
    });
    return;
  }

  // /notify is async too (permission, subscribe, register), and reaches the kernel —
  // same shape as the auth verbs: run the flow, restore the prompt when it settles.
  if (verb === "notify") {
    void runNotify(KERNEL_URL, io).finally(prompt);
    return;
  }

  const cmd = findCommand(verb);
  if (!cmd || !cmd.run) {
    writeLine(term, `unknown command: /${verb} — try /help`);
    prompt();
    return;
  }

  cmd.run(term, args);
  prompt();
}

// --- capture & delivery ---------------------------------------------------

// The capture loop owns getting a typed line to the kernel and keeping its marker honest.
// It needs two things from the terminal: a fresh prompt after a captured line,
// and a way to redraw the line being typed when a delivery notice has to print above it.
const capture = createCapture(term, {
  prompt,
  redrawInput: () => {
    term.write(PROMPT + line);
    drawGhost();
  },
  kernelUrl: KERNEL_URL,
});

// The worker reports back here:
// a queued line's delivery fate (→ the markers),
// an answer it received on a push (→ rendered as a fresh line, and stopped being awaited),
// or a missive nudge (→ pull traffic waiting now, since the worker can't read the authed /inbox itself).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "answer") capture.applyAnswer(event.data);
    else if (event.data?.type === KERNEL_MSG.trafficWaiting) capture.flushInbox();
    else capture.applyVerdict(event.data);
  });
}

// On open: drain any lines a previous visit left queued,
// reconcile the inbound store (surfacing anything the kernel settled while we were gone),
// and discover any unsolicited inbound the kernel raised for us on its own (needs a session).
// All three again when the network returns;
// the two reconciles also on refocus, since a message may have landed meanwhile.
// (flushAnswers is the backbone of the reply channel — a push only surfaces one sooner.)
// startAnswerPoll keeps that backbone running while a reply is still owed and the tab is watched,
// so an answer lands live on the page without a push or a reload; it self-terminates when none is in flight.
capture.flushNow();
capture.flushAnswers();
capture.flushInbox();
capture.startAnswerPoll();
window.addEventListener("online", () => {
  capture.flushNow();
  capture.flushAnswers();
  capture.flushInbox();
  capture.startAnswerPoll();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    capture.flushAnswers();
    capture.flushInbox();
    capture.startAnswerPoll();
  }
});

function prompt(): void {
  term.write(PROMPT);
}

// The best command the current input is a prefix of — the part still untyped.
// Empty unless the line is a lone "/verb" fragment that uniquely extends one.
function ghostFor(input: string): string {
  if (!input.startsWith("/") || input.includes(" ")) return "";
  const typed = input.slice(1);
  if (typed === "") return "";
  const match = COMMANDS.find((c) => c.name.startsWith(typed) && c.name !== typed);
  return match ? match.name.slice(typed.length) : "";
}

// Draw the inline suggestion (if any) in dim grey to the right of the cursor,
// then park the cursor back at the typing position.
// Cheap by design:
// only the tail of the line is ever touched — the prompt is never repainted —
// so typing stays snappy.
function drawGhost(): void {
  const ghost = ghostFor(line);
  if (ghost) term.write(`\x1b[2m${ghost}\x1b[0m\x1b[${ghost.length}D`);
}
