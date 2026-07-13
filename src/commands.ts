import type { Term } from "./term";
import { VERSION } from "./banner";
import { getToken } from "./session";

// A command is a verb typed at the prompt.
// Most carry a `run` that writes their own output to the terminal.
// The identity verbs (login/logout/status) carry no `run`:
// they're modal — they read the email and then the code on the lines that follow —
// so the dispatcher routes them to the async auth flow instead.
export interface Command {
  name: string;
  summary: string;
  // Bare keywords are typed without a leading slash (e.g. `reset`).
  bare?: boolean;
  // Advertised only to a symbiot with a session — hidden from /help and autocomplete for a visitor.
  // The command acts on something that belongs to a particular symbiot (e.g. its timezone),
  // so there's nothing to offer a caller the kernel can't name; the flow itself refuses without a session too.
  authedOnly?: boolean;
  run?: (term: Term, args: string[]) => void;
}

// Whether an authed-only command should surface right now — the local read of "is there a session".
// The kernel is the real authority on a session's life, so this is only about what to *advertise*:
// the command still runs (and is refused server-side) if a visitor types it in full.
export function isVisible(cmd: Command): boolean {
  return !cmd.authedOnly || getToken() !== null;
}

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
        // Authed-only verbs stay off the list until there's a session — a visitor isn't shown what it can't use.
        if (!isVisible(cmd)) continue;
        const label = cmd.bare ? cmd.name : `/${cmd.name}`;
        writeLine(term, `  ${label.padEnd(8)} ${cmd.summary}`);
      }
    },
  },
  { name: "clear", summary: "wipe the screen", run: clearScreen },
  { name: "reset", summary: "clear the screen (no slash)", bare: true, run: clearScreen },
  // Identity verbs carry no run — they're modal, dispatched to the auth flow by main.ts.
  { name: "login", summary: "sign in with an email code" },
  { name: "logout", summary: "end the session" },
  // Carries no run either — dispatched to its async flow by main.ts, like the identity verbs.
  { name: "notify", summary: "get a nudge when The Joy answers" },
  { name: "status", summary: "show connection + session state" },
  // Modal and authed-only — dispatched to its flow by main.ts, and hidden from a visitor (see isVisible).
  { name: "timezone", summary: "tell The Joy where you are, so it keeps your local time", authedOnly: true },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

// A thin pass-through kept so callers read as "write a line" rather than reaching into the terminal.
// The terminal appends the line to the log and colours any ANSI it carries.
export function writeLine(term: Term, text = ""): void {
  term.writeLine(text);
}
