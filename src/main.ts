import "./style.css";

import { type AuthIo, runAuth } from "./auth";
import {
  BANNER_WIDE,
  BANNER_NARROW,
  BANNER_PLAIN,
  TAGLINE_WIDE,
  TAGLINE_NARROW,
  VERSION,
} from "./banner";
import { createCapture } from "./capture";
import { COMMANDS, findCommand, isVisible, writeLine } from "./commands";
import { type Envelope, isOk, KERNEL_MSG } from "./kernel";
import { ensurePushOnLogin, runNotify } from "./notify";
import { runNotifications } from "./notifications";
import { runModels } from "./models";
import { registerServiceWorker } from "./pwa";
import { createTerminal } from "./term";
import { runTimezone } from "./zone";

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

// Probe now, on a gentle interval,
// and immediately whenever connectivity or visibility changes —
// so the dot is correct from first frame
// and snaps back the moment the network returns or a backgrounded tab refocuses.
probeKernel();
setInterval(probeKernel, PROBE_INTERVAL_MS);
window.addEventListener("online", probeKernel);
window.addEventListener("offline", () => paintConnection(false));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") probeKernel();
});

// The terminal — plain DOM, no emulator.
// It owns the scrolling log and the input line;
// this file owns what a line means. See term.ts for why xterm is gone.
const term = createTerminal(document.getElementById("terminal")!, { prompt: PROMPT });

// --- launch ---------------------------------------------------------------

// Draw the launch banner at the widest cut that actually fits the box:
// the wide one-liner, else the stacked two words a phone can hold, else a plain wordmark.
// Two things make this reliable where a width estimate wasn't.
// First, we wait for document.fonts.ready before measuring,
// because the block and box-drawing glyphs can resolve to a fallback font
// that lands late and wider than the primary —
// measure before that and a too-wide cut looks like it fits,
// then clips once the real font paints.
// Second, we test the cut against the rows we just painted
// (scrollWidth past the box means the line is being clipped),
// not against a separate probe that might disagree with what actually rendered;
// a cut that overflows by any amount is torn down and the next narrower one tried.
// The rows carry a class that forbids wrapping,
// so the worst a marginal miss can do is clip, never fold into mush.
async function drawBanner(): Promise<void> {
  await document.fonts.ready;

  const cuts: Array<[string, string]> = [
    [BANNER_WIDE, TAGLINE_WIDE],
    [BANNER_NARROW, TAGLINE_NARROW],
    [BANNER_PLAIN, TAGLINE_NARROW],
  ];

  let tagline = TAGLINE_NARROW;
  for (let i = 0; i < cuts.length; i++) {
    const [banner, tag] = cuts[i];
    tagline = tag;
    const rows = banner.split("\n").map((row) => {
      const node = term.writeLine(`\x1b[92m${row}\x1b[0m`);
      node.classList.add("banner");
      return node;
    });
    // The plain wordmark is the last resort — keep it even if it somehow spills,
    // since there is nothing narrower to fall back to.
    const overflows = rows.some((node) => node.scrollWidth > node.clientWidth);
    if (!overflows || i === cuts.length - 1) break;
    for (const node of rows) node.remove();
  }

  writeLine(term, `\x1b[2m${tagline}\x1b[0m`);
  writeLine(term);
  writeLine(term, "type \x1b[1m/help\x1b[0m to see what's here — \x1b[1mTab\x1b[0m autocompletes.");
  writeLine(term);
}
void drawBanner();

// Make the shell installable and offline-capable.
// Last, and off to the side — it must never delay or break the terminal that just drew above.
registerServiceWorker();

// --- dispatch -------------------------------------------------------------

// The identity verbs run as modal async flows (see the auth-verb branch in handle),
// not one-shot cmd.run handlers,
// because they read the email and the code on the lines that follow.
const AUTH_VERBS = new Set(["login", "logout", "status"]);

// The narrow surface the auth flows get on the terminal:
// read the next line, print a line.
const io: AuthIo = {
  readLine: (prompt) => term.readLine(prompt),
  print: (text) => writeLine(term, text),
  checklist: (opts) => term.checklist(opts),
};

function handle(raw: string): void {
  const input = raw.trim();
  if (input === "") {
    // Blank line — the terminal already echoed a bare prompt; nothing more to do.
    return;
  }

  // Bare keywords carry no slash (e.g. `reset`); check them before the slash-only gate below.
  const bareCmd = findCommand(input);
  if (bareCmd?.bare) {
    bareCmd.run?.(term, []);
    return;
  }

  if (!input.startsWith("/")) {
    // Not a command — it's content for The Joy.
    // Hand it to the capture loop: it draws the pending marker and delivers in the background.
    // No auth gate on purpose — the right to submit is never gated.
    // Identity is the server's call.
    capture.submit(input);
    return;
  }

  const [verb, ...args] = input.slice(1).split(/\s+/);

  // Identity verbs own the screen for a modal exchange (email, then code),
  // so they run as their own async flow;
  // focus returns to the prompt once it settles.
  if (AUTH_VERBS.has(verb)) {
    // After the flow settles, discover any inbox waiting on a fresh session —
    // a no-op when the verb wasn't a login, or left us logged out.
    // And on a login specifically, make sure this browser is tied to the symbiot for push —
    // silently adopting an existing subscription,
    // or inviting one if there's none (ensurePushOnLogin),
    // so the symbiot doesn't have to remember /notify to be reachable.
    // Only after /login, and only if it took.
    void runAuth(verb, args, KERNEL_URL, io)
      .then(() => (verb === "login" ? ensurePushOnLogin(KERNEL_URL, io) : undefined))
      .finally(() => {
        term.focus();
        capture.flushInbox();
      });
    return;
  }

  // /notify is async too (permission, subscribe, register), and reaches the kernel —
  // same shape as the auth verbs: run the flow, refocus the prompt when it settles.
  if (verb === "notify") {
    void runNotify(KERNEL_URL, io).finally(() => term.focus());
    return;
  }

  // /timezone is the same shape:
  // read where you are, tell the kernel, refocus when it settles.
  // Modal and authed-only, so its flow reads the location line and refuses without a session.
  if (verb === "timezone") {
    void runTimezone(KERNEL_URL, io).finally(() => term.focus());
    return;
  }

  // /notifications is the same shape again:
  // show the per-channel state, read one channel to flip,
  // tell the kernel, refocus when it settles.
  // Modal and authed-only, like /timezone.
  if (verb === "notifications") {
    void runNotifications(KERNEL_URL, io).finally(() => term.focus());
    return;
  }

  // /models is the same shape once more:
  // show the catalog and role assignments, read a change, tell the kernel,
  // refocus when it settles.
  // Modal and authed-only, like /timezone —
  // box-level config, operator-gated.
  if (verb === "models") {
    void runModels(KERNEL_URL, io).finally(() => term.focus());
    return;
  }

  const cmd = findCommand(verb);
  if (!cmd || !cmd.run) {
    writeLine(term, `unknown command: /${verb} — try /help`);
    return;
  }

  cmd.run(term, args);
}

// --- capture & delivery ---------------------------------------------------

// The capture loop owns getting a typed line to the kernel and keeping its marker honest.
// It draws each marker as a log line and repaints it in place by holding the line's node,
// so it needs nothing from us but the kernel's address —
// the prompt is the terminal's own now.
const capture = createCapture(term, { kernelUrl: KERNEL_URL });

// Wire the terminal's raw events to the dispatcher and the ghost.
// A bare Ctrl-C needs no handling —
// the terminal already dropped the line and the prompt persists.
term.onLine(handle);
term.onInterrupt(() => {});
term.setGhost(ghostFor);

// The worker reports back here:
// a queued line's delivery fate (→ the markers),
// an answer it received on a push (→ rendered as a fresh line, and stopped being awaited),
// or a missive nudge (→ pull traffic waiting now,
// since the worker can't read the authed /inbox itself).
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
// (flushAnswers is the backbone of the reply channel —
// a push only surfaces one sooner.)
// startAnswerPoll keeps that backbone running while a reply is still owed and the tab is watched,
// so an answer lands live on the page without a push or a reload;
// it self-terminates when none is in flight.
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

// Surface unsolicited inbound (a fired reminder, an enrichment follow-up) live while the tab is open —
// the kernel raises these on its own,
// so nothing local signals their arrival the way an in-flight reply does.
// A gentle background poll is the second channel beside the push nudge
// (which needs a subscription and may be off),
// so staying on the page shows them within a beat
// rather than only on reload, refocus, or reconnect.
// Only while visible, so a backgrounded tab never churns;
// open, refocus, and reconnect already flush on their own.
const INBOX_POLL_MS = 10_000;
setInterval(() => {
  if (document.visibilityState === "visible") capture.flushInbox();
}, INBOX_POLL_MS);

// The best command the current input is a prefix of — the part still untyped.
// Empty unless the line is a lone "/verb" fragment that uniquely extends one.
function ghostFor(input: string): string {
  if (!input.startsWith("/") || input.includes(" ")) return "";
  const typed = input.slice(1);
  if (typed === "") return "";
  // Don't complete toward a command a visitor can't see —
  // the same "not advertised" line /help holds.
  const match = COMMANDS.find((c) => c.name.startsWith(typed) && c.name !== typed && isVisible(c));
  return match ? match.name.slice(typed.length) : "";
}
