// The /notify flow: turning on the kernel's tap-on-the-shoulder.
//
// Notifications are opt-in, and asked for only when the symbiot asks —
// never on first paint, never as the price of capture.
// Capture stays frictionless and ungated;
// this is a separate, deliberate "yes, reach me" that the symbiot types when they want it.
// That's the whole permission UX: a command, not a popup ambush.
//
// What it does, in order:
// confirm the browser can do push at all, fetch the kernel's public VAPID key,
// ask the browser for notification permission, subscribe through the service worker,
// register that subscription with the kernel, and remember the id the kernel hands back
// so the worker can tag each /intake with it.
// Every failure along the way is reported in plain terms and leaves capture untouched.

import type { AuthIo } from "./auth";
import type { Envelope } from "./kernel";
import { getToken } from "./session";
import { setReplyChannelId } from "./store/meta";

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const warn = (text: string): string => `\x1b[33m${text}\x1b[0m`;
const good = (text: string): string => `\x1b[92m${text}\x1b[0m`;

// The VAPID public key crosses the wire base64url; the browser's subscribe() wants raw
// bytes. Pad, un-url-safe, decode.
function urlB64ToBytes(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function getJson(url: string, init?: RequestInit): Promise<Envelope | null> {
  try {
    const res = await fetch(url, { ...init, cache: "no-store" });
    return res.ok ? await res.json().catch(() => null) : null;
  } catch {
    return null;
  }
}

export async function runNotify(kernelUrl: string, io: AuthIo): Promise<void> {
  // Can this browser do push at all? (Older or locked-down ones can't — say so and stop.)
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    io.print(dim("this browser can't do notifications — nothing to turn on."));
    return;
  }

  // Already blocked at the browser level? Only the symbiot can undo that, in site settings.
  if (Notification.permission === "denied") {
    io.print(warn("notifications are blocked for this site in your browser settings."));
    io.print(dim("unblock them there, then run /notify again."));
    return;
  }

  // The kernel's public key. Null means the kernel has no VAPID key configured — push is off server-side,
  // so there's nothing to subscribe to; answers still arrive on open.
  const keyReply = await getJson(`${kernelUrl}/push/key`);
  if (!keyReply) {
    io.print(dim("couldn't reach the kernel — try /notify again when it's back."));
    return;
  }
  const key = (keyReply.data as { key?: unknown } | null)?.key;
  if (typeof key !== "string" || key === "") {
    io.print(dim("the kernel isn't set up for notifications — answers will still show when you open the shell."));
    return;
  }

  // Ask for permission — the one prompt, and only because /notify was typed.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    io.print(dim("no notifications, then — run /notify anytime to turn them on."));
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    // Reuse an existing browser subscription if there is one;
    // else make one against the kernel's key.
    // userVisibleOnly is required — every push must show a notification.
    const subscription =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // The bytes are a valid BufferSource; the assertion sidesteps a spurious
        // SharedArrayBuffer union in the DOM lib's applicationServerKey type.
        applicationServerKey: urlB64ToBytes(key) as BufferSource,
      }));

    // Register it with the kernel, verbatim from the browser's own serialisation,
    // and keep the id it returns so the worker can tag each /intake with whom to notify.
    const { endpoint, keys } = subscription.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    // Send the session token when there is one, so the kernel ties this channel to the
    // symbiot — that's what lets it push a missive (a message it raises on its own), not
    // only a reply to a line we sent. Logged out, the channel registers anonymously and
    // still gets reply nudges; run /notify again once logged in to link it.
    const token = getToken();
    const reply = await getJson(`${kernelUrl}/push/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ endpoint, keys }),
    });
    const id = (reply?.data as { id?: unknown } | null)?.id;
    if (typeof id !== "number") {
      io.print(dim("couldn't register with the kernel — try /notify again in a moment."));
      return;
    }
    await setReplyChannelId(id);
    io.print(`${good("notifications on")} — The Joy will tap you on the shoulder when it answers.`);
  } catch {
    io.print(dim("couldn't turn on notifications just now — try /notify again in a moment."));
  }
}
