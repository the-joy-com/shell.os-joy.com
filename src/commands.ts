import type { Terminal } from "@xterm/xterm";

// A command is a verb typed at the prompt. `run` writes its own output to the
// terminal. `clear` is handled specially in the dispatcher (it needs the raw
// terminal control), so it carries no `run` here.
export interface Command {
  name: string;
  summary: string;
  // Bare keywords are typed without a leading slash (e.g. `reset`).
  bare?: boolean;
  run?: (term: Terminal, args: string[]) => void;
}

// Stubs for this slice: listed by /help and acknowledged, but the real
// behaviour (auth, session) lands in later slices.
const stub = (what: string): Command["run"] => (term) => {
  writeLine(term, `${what} is not wired up yet — coming in a later slice.`);
};

// Both /clear and the bare `reset` keyword wipe the screen.
const clearScreen: Command["run"] = (term) => term.clear();

export const COMMANDS: Command[] = [
  {
    name: "help",
    summary: "list the available commands",
    run: (term) => {
      writeLine(term, "commands:");
      for (const cmd of COMMANDS) {
        const label = cmd.bare ? cmd.name : `/${cmd.name}`;
        writeLine(term, `  ${label.padEnd(8)} ${cmd.summary}`);
      }
    },
  },
  { name: "clear", summary: "wipe the screen", run: clearScreen },
  { name: "reset", summary: "clear the screen (no slash)", bare: true, run: clearScreen },
  { name: "login", summary: "request a sign-in code", run: stub("login") },
  { name: "logout", summary: "end the session", run: stub("logout") },
  { name: "status", summary: "show connection state", run: stub("status") },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

// xterm needs CRLF — carriage return (\r, back to column 0) plus line feed
// (\n, down a row) — for a real newline; \n alone only drops a row, leaving the
// cursor in the same column. `writeln` appends the \r\n for us.
export function writeLine(term: Terminal, text = ""): void {
  term.writeln(text);
}
