// The /notify flow: turning on the kernel's tap-on-the-shoulder,
// and keeping it tied to you across logins.
//
// Notifications are opt-in,
// and the browser's permission prompt is only ever fired on an explicit gesture —
// never on first paint, never as the price of capture.
// That gesture is normally typing /notify.
// It is also answering "yes" to the one terminal question ensurePushOnLogin asks after a fresh login (see below):
// a y/n in the log is not a browser popup,
// and the real permission prompt still only fires once you say yes.
// So the principle holds — a command (or a plain yes), never a popup ambush.
//
// What /notify does, in order:
// confirm the browser can do push at all,
// fetch the kernel's public VAPID key,
// ask the browser for notification permission,
// subscribe through the service worker,
// register that subscription with the kernel,
// and remember the id the kernel hands back,
// so the worker can tag each /intake with it.
// Every failure along the way is reported in plain terms and leaves capture untouched.

import type { AuthIo } from "./auth";
import type { Envelope } from "./kernel";
import { getToken } from "./session";
import { setReplyChannelId } from "./store/meta";

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const warn = (text: string): string => `\x1b[33m${text}\x1b[0m`;
const good = (text: string): string => `\x1b[92m${text}\x1b[0m`;

// The VAPID public key crosses the wire base64url;
// the browser's subscribe() wants raw bytes. Pad, un-url-safe, decode.
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

// Register a browser subscription with the kernel and remember the id it returns,
// so the worker can tag each /intake with whom to notify.
// Sends the session token when there is one,
// so the kernel ties this channel to the symbiot —
// that's what lets it push a missive (a message it raises on its own),
// not only a reply to a line we sent.
// Logged out, the channel registers anonymously and still gets reply nudges.
// The kernel's COALESCE means this only ever *links* a channel to an identity, never unlinks it,
// so it is safe to call again on any login: a channel already tied to you stays tied.
// Returns the channel id, or null if the kernel didn't take it.
async function registerSubscription(kernelUrl: string, subscription: PushSubscription): Promise<number | null> {
  const { endpoint, keys } = subscription.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
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
  if (typeof id !== "number") return null;
  await setReplyChannelId(id);
  return id;
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

  // The kernel's public key.
  // Null means the kernel has no VAPID key configured — push is off server-side,
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

  // Ask for permission — the one prompt, and only because /notify was typed (or a login "yes" led here).
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
        // The bytes are a valid BufferSource;
        // the assertion sidesteps a spurious SharedArrayBuffer union in the DOM lib's applicationServerKey type.
        applicationServerKey: urlB64ToBytes(key) as BufferSource,
      }));

    const id = await registerSubscription(kernelUrl, subscription);
    if (id === null) {
      io.print(dim("couldn't register with the kernel — try /notify again in a moment."));
      return;
    }
    io.print(`${good("notifications on")} — The Joy will tap you on the shoulder when it answers.`);
  } catch {
    io.print(dim("couldn't turn on notifications just now — try /notify again in a moment."));
  }
}

// Called after a fresh login (see main.ts) to close the gap where a browser is reachable
// but the kernel doesn't know to reach it as *you*.
// Two cases, both quiet where they can be:
//   • already subscribed on this browser —
//     silently (re)register with the new token,
//     so a subscription first made while logged out (an anonymous channel) is adopted under your identity.
//     Idempotent; the kernel's COALESCE only links, never unlinks,
//     so a channel already tied to you is untouched. No prompt, no output.
//   • not subscribed on this device — invite, don't ambush:
//     one terminal y/n, and only a "yes" runs the full /notify flow
//     (which fires the browser's real permission prompt).
//     Decline and nothing is nagged; /notify is always there on demand.
// Silent and harmless when there's no session, when the browser can't do push, or when it's been blocked —
// none of which is worth a word on a login.
export async function ensurePushOnLogin(kernelUrl: string, io: AuthIo): Promise<void> {
  const token = getToken();
  if (!token) return; // the login didn't take — nothing to link
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  if (Notification.permission === "denied") return; // blocked — never nag; the symbiot undoes that themselves

  let subscription: PushSubscription | null = null;
  try {
    const reg = await navigator.serviceWorker.ready;
    subscription = await reg.pushManager.getSubscription();
  } catch {
    return; // the service worker isn't ready — leave it; /notify still works on demand
  }

  if (subscription) {
    await registerSubscription(kernelUrl, subscription); // silent adopt/relink
    return;
  }

  const answer = await io.readLine("turn on notifications on this device, so I can reach you? (y/n) ");
  if (answer === null) return; // abandoned (Ctrl-C)
  if (/^y(es)?$/i.test(answer.trim())) {
    await runNotify(kernelUrl, io);
  } else {
    io.print(dim("no worries — run /notify anytime to turn them on."));
  }
}
