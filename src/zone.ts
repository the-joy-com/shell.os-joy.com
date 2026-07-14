// The flow behind /timezone: tell the kernel where you are, so The Joy reasons about time in your day.
//
// This is the shell half of the timezone feature. The kernel owns the hard part —
// it reads the place out of plain words and infers the IANA zone (services/zone.py) —
// so this module only drives the exchange from the terminal: read a location, POST it, show what was set.
//
// Authed only, and deliberately so: a timezone belongs to a particular symbiot's perception of time,
// so there is nothing to offer a visitor. The command is hidden from /help until there's a session
// (see commands.ts), and if it is typed without one anyway, this refuses before reaching the kernel.
// The session token rides on the request the same way the identity flows send it.

import type { AuthIo } from "./auth";
import { type Envelope, KERNEL_MSG } from "./kernel";
import { clearToken, getToken } from "./session";

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const warn = (text: string): string => `\x1b[33m${text}\x1b[0m`;
const good = (text: string): string => `\x1b[92m${text}\x1b[0m`;

// The place the symbiot named, turned into a stored zone — the shape /timezone carries back in data.
interface TimezoneData {
  timezone: string;
}

// The zone the kernel currently has stored for this symbiot, or null when it can't be read.
// A silent best-effort GET: a failure just means the command opens without showing a current value,
// never that it breaks — the write path below is the point of the command.
async function readCurrentZone(kernelUrl: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${kernelUrl}/timezone`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body: Envelope | null = await res.json().catch(() => null);
    const tz = (body?.data as TimezoneData | null)?.timezone;
    return typeof tz === "string" ? tz : null;
  } catch {
    return null;
  }
}

export async function runTimezone(kernelUrl: string, io: AuthIo): Promise<void> {
  // Not advertised to visitors, and refused for one who types it anyway —
  // the kernel would turn it away regardless, so we spare the round trip and say why plainly.
  const token = getToken();
  if (!token) {
    io.print(dim("/timezone needs a session — /login first, then tell me where you are."));
    return;
  }

  // Open on the zone already set, so the command shows the current value rather than prompting into the void.
  // A failed read is silent — we simply prompt without the preamble; the write below is what matters.
  const current = await readCurrentZone(kernelUrl, token);
  if (current) io.print(dim(`your local time is currently ${current}.`));

  const entered = await io.readLine(
    current
      ? "where are you now? (a city or country — or leave blank to keep it) "
      : "where are you? (a city or country) ",
  );
  if (entered === null) return; // abandoned (Ctrl-C)
  const location = entered.trim();
  if (!location) return; // blank — keep the zone as it is

  let reached = false;
  let body: Envelope | null = null;
  try {
    const res = await fetch(`${kernelUrl}/timezone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ location }),
      cache: "no-store",
    });
    reached = true;
    body = res.ok ? await res.json().catch(() => null) : null;
  } catch {
    reached = false;
  }

  if (!reached) {
    io.print(dim("couldn't reach the kernel — try again when it's back."));
    return;
  }

  const data = body?.data as TimezoneData | null;
  if (body?.msg === KERNEL_MSG.timezoneSet && data?.timezone) {
    io.print(good(`local time set — ${data.timezone}.`));
    return;
  }
  // Reached but nothing was set. Two cases the msg tells apart:
  // the session went stale between /login and now (drop the dead token, like the identity flows do),
  // or the place named no zone the kernel could resolve (say again — try a clearer place name).
  if (body?.msg === KERNEL_MSG.notAuthed) {
    await clearToken();
    io.print(dim("your session expired — /login again, then set your timezone."));
    return;
  }
  if (body?.msg === KERNEL_MSG.timezoneUnclear) {
    io.print(warn(KERNEL_MSG.timezoneUnclear));
    return;
  }
  io.print(warn(body?.msg ?? "the kernel turned that request away — give it a moment."));
}
