import type { Terminal } from "@xterm/xterm";
import { VERSION } from "./banner";

// A command is a verb typed at the prompt.
// `run` writes its own output to the terminal.
// `clear` is handled specially in the dispatcher (it needs the raw terminal control),
// so it carries no `run` here.
export interface Command {
  name: string;
  summary: string;
  // Bare keywords are typed without a leading slash (e.g. `reset`).
  bare?: boolean;
  run?: (term: Terminal, args: string[]) => void;
}

// Placeholder commands: listed by /help and acknowledged, but inert —
// the auth/session behaviour behind them isn't implemented.
const stub = (what: string): Command["run"] => (term) => {
  writeLine(term, `${what} isn't available yet.`);
};

// Deliberately lenient:
// this catches the typos that matter — a missing @, no domain, a stray space —
// not RFC-5322 edge cases.
// Validating an address's true shape is a fool's errand (and rejects valid oddities);
// the goal here is only to spare the symbiot an obvious slip.
//
// Why the *shell* carries this at all:
// the kernel never validates an address's shape and, by design, never says one is malformed —
// its /login reply is byte-identical for a known address, an unknown one, or pure garbage,
// so it leaks nothing about who's registered.
// That intentional silence means a typo'd address gets the same reassuring "a code is on its way" as a real one,
// and the symbiot waits on an email that can never arrive.
// The kernel can't warn them without becoming an enumeration oracle —
// so the warning lives here, before the request is ever sent.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function looksLikeEmail(address: string): boolean {
  return EMAIL_SHAPE.test(address.trim());
}

// /login checks the address locally and flags an obvious typo before anything crosses the wire —
// the kernel can't warn about a typo without becoming an enumeration oracle (see the note on EMAIL_SHAPE),
// so that courtesy lives here.
const login: Command["run"] = (term, args) => {
  const address = args.join(" ").trim(); // tolerate an accidental space in the address
  if (!address) {
    writeLine(term, "usage: /login your@email");
    return;
  }
  if (!looksLikeEmail(address)) {
    writeLine(term, `\x1b[33mhmm — “${address}” doesn't look like an email address.\x1b[0m`);
    writeLine(term, "\x1b[2mcheck for a typo and try again; nothing was sent.\x1b[0m");
    return;
  }
  writeLine(term, "login isn't available yet.");
};

// Both /clear and the bare `reset` keyword wipe the screen.
const clearScreen: Command["run"] = (term) => term.clear();

export const COMMANDS: Command[] = [
  {
    name: "help",
    summary: "list the available commands",
    run: (term) => {
      // Lead with the running version —
      // /help is where someone goes to get their bearings,
      // so it's the natural place to surface it in full, not just the dim corner tag.
      writeLine(term, `\x1b[2mthe joy — shell · ${VERSION}\x1b[0m`);
      writeLine(term);
      writeLine(term, "commands:");
      for (const cmd of COMMANDS) {
        const label = cmd.bare ? cmd.name : `/${cmd.name}`;
        writeLine(term, `  ${label.padEnd(8)} ${cmd.summary}`);
      }
    },
  },
  { name: "clear", summary: "wipe the screen", run: clearScreen },
  { name: "reset", summary: "clear the screen (no slash)", bare: true, run: clearScreen },
  { name: "login", summary: "request a sign-in code", run: login },
  { name: "logout", summary: "end the session", run: stub("logout") },
  { name: "status", summary: "show connection state", run: stub("status") },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

// xterm needs CRLF —
// carriage return (\r, back to column 0) plus line feed (\n, down a row) —
// for a real newline;
// \n alone only drops a row, leaving the cursor in the same column.
// `writeln` appends the \r\n for us.
export function writeLine(term: Terminal, text = ""): void {
  term.writeln(text);
}
