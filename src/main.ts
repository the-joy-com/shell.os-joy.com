import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

import {
  BANNER_WIDE,
  BANNER_NARROW,
  TAGLINE_WIDE,
  TAGLINE_NARROW,
  VERSION,
  WIDE_MIN_COLS,
} from "./banner";
import { COMMANDS, findCommand, writeLine } from "./commands";
import { registerServiceWorker } from "./pwa";

const PROMPT = "joy \x1b[32m❯\x1b[0m "; // green chevron

// Pin the running version to the bottom-right corner,
// present from the moment the shell opens.
// It lives outside the terminal so it never scrolls with the log,
// and reads from the same build-time VERSION the banner uses.
document.getElementById("version")!.textContent = VERSION;

// Mirror it on the bottom-left with a connectivity status —
// a coloured dot and the word to match: green "online", red "offline".
// It reflects navigator.onLine, repainted on the browser's online / offline events —
// purely client-side, the same connectivity the outbox will later drain on.
// Painted once now so it's correct from first frame.
const connection = document.getElementById("connection")!;
function paintConnection(): void {
  const online = navigator.onLine;
  connection.classList.toggle("online", online);
  connection.classList.toggle("offline", !online);
  connection.textContent = online ? "online" : "offline";
}
paintConnection();
window.addEventListener("online", paintConnection);
window.addEventListener("offline", paintConnection);

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

// Pick the banner that fits the terminal we actually got
// (phones can't hold the wide one-liner, so they get the stacked cut).
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

// Make the shell installable and offline-capable.
// Last, and off to the side — it must never delay or break the terminal that just drew above.
registerServiceWorker();

// --- line editing ---------------------------------------------------------

// xterm hands us raw keystrokes, not lines —
// so we keep our own buffer and echo as we go.
// Minimal but enough to *feel* like a shell.
let line = "";

term.onData((data) => {
  switch (data) {
    case "\r": // Enter
      term.write("\x1b[K\r\n"); // drop any inline suggestion, then newline
      handle(line);
      line = "";
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
      prompt();
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
      // Printable input only; swallow other control sequences for now.
      if (data >= " ") {
        line += data;
        term.write("\x1b[K" + data); // erase the stale ghost, then echo the char
        drawGhost();
      }
  }
});

// --- dispatch -------------------------------------------------------------

function handle(raw: string): void {
  const input = raw.trim();
  if (input === "") {
    prompt();
    return;
  }

  // Bare keywords carry no slash (e.g. `reset`);
  // check them before the slash-only gate below.
  const bareCmd = findCommand(input);
  if (bareCmd?.bare) {
    bareCmd.run?.(term, []);
    prompt();
    return;
  }

  if (!input.startsWith("/")) {
    writeLine(term, `\x1b[2mthis slice only knows /commands — try /help\x1b[0m`);
    prompt();
    return;
  }

  const [verb, ...args] = input.slice(1).split(/\s+/);

  const cmd = findCommand(verb);
  if (!cmd || !cmd.run) {
    writeLine(term, `unknown command: /${verb} — try /help`);
    prompt();
    return;
  }

  cmd.run(term, args);
  prompt();
}

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
// Cheap by design: only the tail of the line is ever touched —
// the prompt is never repainted — so typing stays snappy.
function drawGhost(): void {
  const ghost = ghostFor(line);
  if (ghost) term.write(`\x1b[2m${ghost}\x1b[0m\x1b[${ghost.length}D`);
}
