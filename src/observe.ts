// The flow behind /observe: a hub of observability lenses, each its own card.
//
// /observe opens a set of bordered cards — today one, echoes — and each card loads its own data
// behind an in-card spinner the moment the hub appears, independently, so no card waits on another
// (the same "one slow unit must never freeze the whole" the kernel's worker pool lives by).
// Open a card and its lens is drawn below.
//
// Read-only by construction: every lens reports what The Joy has already said and changes nothing,
// so the whole surface is safe to open at any time. Authed-only like /timezone and /models —
// a symbiot's own output is not an anonymous thing to show — hidden from /help until there's a session
// (see commands.ts), and refused before the round trip if typed without one.
// The session token rides on the request the way the other authed flows send it.
//
// The surface comes in two halves: the hub and its self-loading cards, and the echoes lens itself —
// a chronological mirror of my recent output, grouped into clusters where lines say more or less the same thing.

import type { AuthIo } from "./auth";
import { type Envelope, KERNEL_MSG } from "./kernel";
import { clearToken, getToken } from "./session";

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const green = (text: string): string => `\x1b[92m${text}\x1b[0m`;
// A one-line label for a mechanism, so the header reads in words rather than the wire's slugs.
const MECHANISM: Record<string, string> = {
  quick: "quick reply",
  deep: "deep follow-up",
  note: "note",
};
const mechanism = (m: string): string => MECHANISM[m] ?? m;
const warn = (text: string): string => `\x1b[33m${text}\x1b[0m`;

// One machine utterance as the echoes lens carries it back: what was said, which part of the loop said it
// ('quick' fast reply, 'deep' follow-up, 'note' kernel-raised line), the human line it answered when there was one,
// and a ready local-time label the kernel already stamped in the symbiot's own zone.
interface MachineUtterance {
  mechanism: string;
  text: string;
  trigger: string | null;
  when: string;
}

// The echoes lens's answer: the clusters of near-duplicates, strongest first, each with its similarity score,
// the lines that echoed nothing left as singles,
// whether scoring ran at all (scored is false when the embedder was unreachable and the kernel fell back to the plain mirror),
// and held_back — how many deep follow-ups the echo guard suppressed as near-duplicates before sending, all-time:
// the clusters are the redundancy that got through, this is the redundancy that was stopped.
interface MachineEchoesData {
  scored: boolean;
  clusters: Array<{ similarity: number; members: MachineUtterance[] }>;
  singles: MachineUtterance[];
  held_back: number;
}

// GET /observe/echoes, returning the scored echoes, or null when the kernel wasn't reached
// or turned the request away. A stale session (notAuthed) drops the dead token, the way the other authed flows do.
async function fetchMachineEchoes(kernelUrl: string, token: string): Promise<MachineEchoesData | null> {
  let body: Envelope | null = null;
  try {
    const res = await fetch(`${kernelUrl}/observe/echoes`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    body = res.ok ? await res.json().catch(() => null) : null;
  } catch {
    return null;
  }
  if (body?.msg === KERNEL_MSG.notAuthed) {
    await clearToken();
    return null;
  }
  if (body?.msg !== KERNEL_MSG.observeMachineEchoes) return null;
  return body.data as MachineEchoesData;
}

// One utterance under a dim header naming how it was said, when, and — for a reply — the line it answered,
// then its text folded onto one flowing block the terminal wraps at the box edge on its own.
function printMachineUtterance(io: AuthIo, u: MachineUtterance): void {
  const trigger = u.trigger ? ` · re: ${u.trigger.length > 48 ? `${u.trigger.slice(0, 47)}…` : u.trigger}` : "";
  io.print(dim(`   ${mechanism(u.mechanism)} · ${u.when}${trigger}`));
  io.print(`     ${u.text.replace(/\s*\n\s*/g, " ")}`);
}

// The clustered view: the near-duplicates grouped under an echo heading with their similarity, strongest first,
// then everything that stood alone below. When scoring couldn't run (the embedder was down),
// it says so and falls back to the plain list rather than pretending nothing repeated — the mirror still works.
function renderMachineEchoes(io: AuthIo, data: MachineEchoesData): void {
  const total = data.clusters.reduce((n, c) => n + c.members.length, 0) + data.singles.length;
  if (total === 0) {
    io.print(dim("I haven't said anything yet — nothing to observe."));
    return;
  }

  // The guard's tally: deep follow-ups I composed but held back as near-duplicates before ever sending them.
  // Shown first, above the lens, because it is the redundancy that never reached you — the count the guard stopped.
  if (data.held_back > 0) {
    io.print(dim(`guard · held back ${data.held_back} deep repeat${data.held_back === 1 ? "" : "s"} before sending`));
    io.print("");
  }

  if (!data.scored) {
    io.print(warn("couldn't measure similarity right now — showing recent output plainly."));
    io.print("");
    for (const u of data.singles) printMachineUtterance(io, u);
    io.print("");
    return;
  }

  const repeats = data.clusters.length;
  io.print(
    dim(
      repeats === 0
        ? `echoes · nothing repeated across ${total} recent line${total === 1 ? "" : "s"}`
        : `echoes · ${repeats} possible repeat${repeats === 1 ? "" : "s"} across ${total} recent line${total === 1 ? "" : "s"}`,
    ),
  );
  io.print("");

  for (const c of data.clusters) {
    io.print(green(`  ═ echo · ${c.similarity.toFixed(2)} ${"═".repeat(22)}`));
    for (const u of c.members) printMachineUtterance(io, u);
    io.print("");
  }

  if (data.singles.length > 0) {
    // A divider before the lone lines, but only when there were clusters above to divide them from.
    if (repeats > 0) io.print(dim(`  ─ said once ${"─".repeat(22)}`));
    for (const u of data.singles) printMachineUtterance(io, u);
    io.print("");
  }
}

export async function runObserve(kernelUrl: string, io: AuthIo): Promise<void> {
  // Not advertised to visitors, and refused for one who types it anyway —
  // the kernel would turn it away regardless, so we spare the round trip and say why plainly.
  const token = getToken();
  if (!token) {
    io.print(dim("/observe needs a session — /login first."));
    return;
  }

  // The card loads its own data; we keep the promise so opening the card renders from the same fetch
  // rather than asking twice, and so selecting it mid-spin waits on the one read already in flight.
  let echoes: Promise<MachineEchoesData | null> = Promise.resolve(null);
  const chosen = await io.cards({
    title: "observe · pick a lens",
    items: [
      {
        key: "echoes",
        title: "echoes",
        description: "where I said more or less the same thing twice",
        load: async () => {
          echoes = fetchMachineEchoes(kernelUrl, token);
          const data = await echoes;
          if (data === null) throw new Error("unreachable"); // the card shows its own error line
          if (!data.scored) return "couldn't score — plain list";
          const n = data.clusters.length;
          return n === 0 ? "no repeats found" : `${n} possible echo${n === 1 ? "" : "es"}`;
        },
      },
    ],
  });

  if (chosen === null) {
    io.print(dim("closed."));
    return;
  }
  if (chosen === "echoes") {
    const data = await echoes;
    if (data === null) {
      io.print(warn("couldn't read the echoes lens — if this keeps up, try /login again."));
      return;
    }
    renderMachineEchoes(io, data);
  }
}
