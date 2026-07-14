// The flow behind /notifications: choose which channels The Joy may reach you on.
//
// This is the shell half of the notification-preferences feature. The kernel owns the truth —
// every channel is on by default, and it fans a reminder or a missive across the ones you allow
// (services/loop/notify.py) — so this module only drives the exchange from the terminal:
// read the current state, offer it as a checklist to tick and untick, tell the kernel each change, show what moved.
//
// Distinct from /notify, which registers *this browser* for web push. This is a standing preference
// tied to your identity, not to a device: a channel switched off here is never fired for you, on any
// device, whichever tool reached for it. So, like /timezone, it is authed-only — there is nothing to
// offer a visitor — hidden from /help until there's a session (see commands.ts), and refused before the
// round trip if typed without one. The session token rides on the request the way the identity flows send it.

import type { AuthIo } from "./auth";
import { type Envelope, KERNEL_MSG } from "./kernel";
import { clearToken, getToken } from "./session";

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const warn = (text: string): string => `\x1b[33m${text}\x1b[0m`;
const good = (text: string): string => `\x1b[92m${text}\x1b[0m`;

// The per-channel enable state — the shape /notifications carries back in data, on both the read and the write.
interface NotificationsData {
  channels: Record<string, boolean>;
}

// The channel slugs the kernel speaks, rendered for a human to read. An unknown slug falls back to
// itself with underscores softened, so a channel added kernel-side still shows legibly before this map learns it.
const LABELS: Record<string, string> = { web_push: "web push", email: "email" };
const label = (channel: string): string => LABELS[channel] ?? channel.replace(/_/g, " ");

// GET or POST /notifications, returning the parsed channels map, or null when the kernel wasn't reached
// or turned the request away. A stale session (notAuthed) drops the dead token and says so, like the
// identity and timezone flows do; anything else unreachable is reported plainly.
async function exchange(
  kernelUrl: string,
  token: string,
  io: AuthIo,
  init?: RequestInit,
): Promise<Record<string, boolean> | null> {
  let body: Envelope | null = null;
  try {
    const res = await fetch(`${kernelUrl}/notifications`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
      ...init,
    });
    body = res.ok ? await res.json().catch(() => null) : null;
  } catch {
    io.print(dim("couldn't reach the kernel — try again when it's back."));
    return null;
  }
  if (body?.msg === KERNEL_MSG.notAuthed) {
    await clearToken();
    io.print(dim("your session expired — /login again, then set your notifications."));
    return null;
  }
  if (body?.msg !== KERNEL_MSG.notifications) {
    io.print(warn(body?.msg ?? "the kernel turned that request away — give it a moment."));
    return null;
  }
  return (body.data as NotificationsData | null)?.channels ?? null;
}

export async function runNotifications(kernelUrl: string, io: AuthIo): Promise<void> {
  // Not advertised to visitors, and refused for one who types it anyway —
  // the kernel would turn it away regardless, so we spare the round trip and say why plainly.
  const token = getToken();
  if (!token) {
    io.print(dim("/notifications needs a session — /login first."));
    return;
  }

  const channels = await exchange(kernelUrl, token, io);
  if (channels === null) return;
  const keys = Object.keys(channels);
  if (keys.length === 0) {
    io.print(dim("no channels to set."));
    return;
  }

  // The checklist is the state display and the editor both — it opens on the kernel's current answer,
  // so the screen is the truth before a single key is pressed.
  const chosen = await io.checklist({
    title: "channels The Joy may reach you on:",
    items: keys.map((c) => ({ key: c, label: label(c), checked: channels[c] })),
  });
  if (chosen === null) {
    io.print(dim("left as they were."));
    return;
  }

  const changed = keys.filter((c) => chosen[c] !== channels[c]);
  if (changed.length === 0) {
    io.print(dim("nothing changed."));
    return;
  }

  // The kernel takes one channel per write, so walk the diffs.
  // Each POST returns the full state, so the last one is the kernel's final word —
  // report from that, not from what we ticked, so the screen can't claim a flip the kernel didn't take.
  let latest = channels;
  for (const c of changed) {
    const updated = await exchange(kernelUrl, token, io, {
      method: "POST",
      body: JSON.stringify({ channel: c, enabled: chosen[c] }),
    });
    if (updated === null) return; // exchange already said why
    latest = updated;
  }
  for (const c of changed) {
    io.print(good(`${label(c)} is now ${latest[c] ? "on" : "off"}.`));
  }
}
