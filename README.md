# shell.os-joy.com

The input shell for **The Joy** — a terminal that lives in the browser. An ASCII banner, a prompt, and a set of commands (see [the commands](#the-commands) below): the screen verbs `/help`, `/clear`, and the bare `reset`; the identity verbs `/login`, `/logout`, `/status`, wired end-to-end to the kernel's session machinery; and the personal settings `/timezone`, `/notify`, and `/notifications`. Anything typed that *isn't* a command is content, sent to the kernel — that's [the capture loop](#the-capture-loop).

Built with [Vite](https://vite.dev/) and TypeScript, its terminal hand-rolled in plain DOM and CSS — no emulator dependency, because the shell wants a terminal *feel*, not the fidelity of a real one. It's a **static** app — `yarn build` emits a plain `dist/` of assets with no runtime backend, which is what gets served from `shell.os-joy.com`.

It's also an installable **PWA**: added to a phone's home screen it launches standalone — no browser chrome — and a service worker caches the shell so it opens even with no network.

## the three repos

The Joy is built in the open across three repositories — the same three linked bottom-center in the shell itself:

- **shell** (this repo) — the browser terminal: <https://github.com/the-joy-com/shell.os-joy.com>
- **kernel** — the core the shell talks to: <https://github.com/the-joy-com/kernel.os-joy.com>
- **build** — the build log, written session by session: <https://github.com/the-joy-com/build.os-joy.com>

## run it locally

You need [Node.js](https://nodejs.org/) 18+ and [Yarn](https://yarnpkg.com/) (classic, 1.x).

```bash
yarn install      # install dependencies (first time only)
yarn dev          # start the dev server with hot reload
```

`yarn dev` prints a local URL (usually <http://localhost:5173>) — open it and you'll get the terminal. Type `/help` to see the commands.

> **Before you try to `/login`, point the shell at the right kernel.** With no config the shell talks to the **production** kernel `https://kernel.os-joy.com` — fine for looking around, but you can only log in against a kernel where *your* address is a registered symbiot. If you're running your own kernel locally, you **must** tell the shell so, or `/login` silently goes nowhere: the kernel deliberately answers *"if that address is registered, a login code is on its way"* whether or not it knows you, so pointing at the wrong kernel doesn't look like an error — it looks like success, and then no code ever arrives.
>
> To point dev at your local kernel, create a **gitignored** `.env.local` next to `package.json` **before** starting `yarn dev` — copy the checked-in template, which already holds the local-kernel value:
>
> ```bash
> cp .env.local.example .env.local
> ```
>
> Vite reads env vars only at startup, so if `yarn dev` is already running, **restart it** — a hot reload won't pick this up. Then open the shell at `localhost:5173` or `127.0.0.1:5173` (both are in the kernel's CORS allow-list; any other host or port the browser will block, and the connection dot reads offline even with the kernel up). The [connectivity dot](#the-connectivity-dot) section below has the full picture.

## the commands

Type `/help` to list them — it leads with the running version, then prints the verbs. A **visitor** (no session) sees only what they can use; the authed-only settings stay hidden until there's a login. The surface is defined in one place, `src/commands.ts`:

| command | what it does | notes |
| --- | --- | --- |
| `/help` | list the available commands | leads with the running version |
| `/clear` | wipe the screen | |
| `reset` | clear the screen | the one bare keyword — no leading slash |
| `/login` | sign in with an email code | modal: reads the email, then the code, on the lines that follow |
| `/logout` | end the session | |
| `/status` | show connection + session state | |
| `/timezone` | tell The Joy where you are, so it keeps your local time | authed-only |
| `/notify` | get a nudge when The Joy answers | registers **this browser** for web push |
| `/notifications` | choose which channels The Joy may reach you on | authed-only |

### identity: `/login`, `/logout`, `/status`

The kernel is the authority on a session's life — it issues one-time codes, spends them for tokens, and expires those tokens on its own clock (a day, then they're gone). The shell only drives that exchange from the terminal and remembers the token it earns, sending it on every privileged call. The moment the kernel answers *not authed*, the local token is dropped: the shell never claims a login the kernel wouldn't honour. `/login` is modal — it reads the email, then the code, on the lines the symbiot types next — and a lenient client-side email-shape check spares an obvious typo before anything is sent, because the kernel's reply is deliberately identical for a known address, an unknown one, or garbage (it never becomes an enumeration oracle). This is all `src/auth.ts`.

### reaching you: `/notify` vs `/notifications`

These two look alike and are not. **`/notify`** registers *this browser* for web push — a per-device subscription, so a nudge can reach a sleeping phone (`src/notify.ts`, backed by the service worker in `src/sw*.ts`). **`/notifications`** sets a standing preference tied to *your identity*, not a device: which channels The Joy may reach you on *at all* — web push, email, and whatever the kernel grows next. A channel switched off here is never fired for you, on any device, whichever tool reached for it. Because it's identity-scoped, it's authed-only, and it opens on the kernel's current answer (a read before the write) rendered as a **checklist** — arrow keys and space to tick, Enter to save, Esc to cancel, and every row tappable so a phone with no space bar drives it too. The checklist itself is a terminal primitive (`term.checklist`, beside `readLine`), so the notifications flow just hands it the channels as data and reads back the final set — the same division of labour that keeps every command out of the raw DOM (`src/notifications.ts`).

### `/timezone`

Tells the kernel where you are so it renders your local time — "remind me at nine" needs to know whose nine. Authed-only, and it too reads its current value before prompting, so it opens on the timezone it already holds rather than asking blind (`src/zone.ts`).

## the source

A map of `src/`, so a contributor knows where a thing lives. Every module carries a header comment explaining its own contract; this is just the index.

- `main.ts` — the entry point and the keyboard's owner: it boots the terminal, dispatches commands, and hands the modal flows (auth, timezone, notifications) a small IO so they never touch the DOM themselves.
- `term.ts` — the hand-built terminal: the log, the contenteditable prompt, `readLine`, and the `checklist` primitive. Owns the surface and the raw key handling; the app above owns what a line *means*.
- `commands.ts` — the command registry: the one place the verb surface is defined, plus visitor-vs-authed visibility and the lenient email-shape check.
- `capture.ts` — the capture loop and the reply channel: queueing typed lines to the outbox, applying the worker's delivery verdicts to the markers on screen, and surfacing the kernel's answers (poll, push, and inbox).
- `auth.ts` — the identity flows behind `/login`, `/logout`, `/status`.
- `notify.ts` — web push: subscribing *this browser* and mirroring the subscription to the kernel.
- `sw.ts` / `sw-handlers.ts` — the service worker: draining the outbox to the kernel (even with the app closed), caching the app shell for offline open, and handling a kernel push. `sw.ts` wires the events; `sw-handlers.ts` is the work they delegate to.
- `notifications.ts` — the `/notifications` channel-preference flow, built on `term.checklist`.
- `zone.ts` — the `/timezone` flow.
- `kernel.ts` — the kernel's wire vocabulary: the envelope shape and the message constants the shell matches on.
- `session.ts` — the session token: reading, setting, and clearing it. It and the shell's other durable state live under `store/` — `outbox.ts` (lines waiting to send), `inbound.ts` (ids of answers still owed), and the shared IndexedDB plumbing.
- `banner.ts` — the ASCII banner and the `VERSION` string.
- `pwa.ts` — service-worker registration for the installable app.
- `style.css` — the terminal's look, the corner furniture, and the tappable checklist rows.

## the connectivity dot

The dot in the bottom-left corner is a live probe of the [kernel](../kernel.os-joy.com), not a `navigator.onLine` mirror: it polls the kernel's `GET /health` and flips **green only on a real `{ "msg": "ok" }` round trip**. A network that's up behind a dead kernel reads **offline** — the shell is nothing without the core behind it. (`navigator.onLine` is still used as a cheap pre-check: if the browser already knows it's offline, the fetch is skipped and the dot paints red at once.)

Which kernel it probes is read from `import.meta.env.VITE_KERNEL_URL`, **defaulting to the production kernel** `https://kernel.os-joy.com` when unset — so a plain clone and every production build need zero config.

To point dev at a kernel you're running locally, drop a **gitignored** `.env.local` next to `package.json`:

```bash
echo 'VITE_KERNEL_URL=http://127.0.0.1:9713' > .env.local
```

then restart `yarn dev` (Vite reads env vars at startup — a hot reload won't pick it up). `.env.local` is a per-machine override and intentionally uncommitted: committing `localhost` would make every clone and prod build probe your dev box. Open the shell at `localhost:5173` or `127.0.0.1:5173` — both are in the kernel's CORS allow-list; any other host or port the browser will block, and the dot will read offline even with the kernel up.

> The browser can only *read* the kernel's cross-origin response if the kernel sends a matching CORS header. The kernel allows the shell's origins (`shell.os-joy.com` plus the two localhost dev origins); that allow-list ships with the kernel, so the green dot at `shell.os-joy.com` only lights up once a kernel carrying it has been deployed.

## the capture loop

A line you type that **isn't** a `/command` is *content* — it goes to the [kernel](../kernel.os-joy.com). On Enter it echoes, then a marker appears beneath it: a dim `⋯ sending…` if you're online, or `⋯ queued` if you're not. On a real acknowledgement (`{ "msg": "copy" }`) that marker is rewritten **in place** to a full-brightness `COPY` — no second line is added. **`COPY` only ever appears when the kernel actually received the line**, the same honesty rule the connectivity dot follows: a send that fails for any reason — network error, a CORS-blocked read, a timeout, or a `200` with the wrong shape — leaves the line queued and shows `⋯ queued`, never a false `COPY`.

The page itself **never touches the network for this**. A typed line is written to a durable **outbox** in IndexedDB *before* anything is sent (`src/store/outbox.ts`), and the **service worker** is what reaches the kernel (`src/sw-handlers.ts`). That indirection is the whole point: because the queue is durable and the worker runs independently of any open tab, a line still goes up when the network returns **even with the app fully closed** — carried by [Background Sync](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API), with an activate-time and on-reconnect flush as the fallback for browsers without it. The worker drains the whole outbox as a **single timestamped batch** to `POST /intake`, so a reconnect arrives as one coherent, ordered transmission rather than N context-free pings — and each line carries the timestamp of when it was *said*, not when it finally lands. If a session token is present it rides along as a Bearer credential (the page mirrors it to the worker, which can't read `localStorage`); logged out, the line simply goes up unauthed, which the input layer accepts by design.

**Input is never blocked on the network.** The prompt comes back the instant you hit Enter, so you can keep typing — and submitting — while earlier lines are still in flight. Each queued line remembers its marker node; the worker reports back by id, and the page repaints just that node — to `COPY` on delivery, back to `⋯ queued` if the batch was requeued — so several sends can be outstanding at once and resolve independently. If the marker's node is gone (a `/clear` wiped it, or the line was queued offline and delivered onto a fresh log after a reopen), the delivery is announced instead as a single fresh `COPY (N queued lines delivered)` summary rather than N repaints of rows that no longer exist.

Submission is deliberately **not** gated on being logged in: the right to submit is never gated; whether identity changes the *reply* is the kernel's decision. It all rides the same `VITE_KERNEL_URL` the dot probes — so the `.env.local` recipe above points the whole loop at your local kernel in dev.

## the reply channel

The kernel can answer — and when it does, the answer comes back on its own terms. The shell keeps **no copy of what it sent**: the inbound store (`src/store/inbound.ts`) holds only the kernel message id the `copy` ack handed back, never the words. So a reply isn't quoted against the line it answers; it's shown as itself, a fresh line `❮ joy …` (green) mirroring the prompt's `joy ❯`, or a red `❮ joy` when the kernel gave the message up. Inbound is decoupled from the sender by design — which is also why a message the kernel raises **unprompted** fits the same channel.

An answer surfaces through whichever path reaches it first, and never twice:

- **The on-page poll** — after a line is delivered, and on every open or refocus, the shell reconciles its tracked ids against `GET /answers?id=…` and renders whatever has settled, easing off its cadence so a slow message doesn't hammer the kernel and stopping the moment nothing is in-flight. This path needs no push and no login — **a visitor gets replies for free**.
- **A push** (see `/notify`) only surfaces one *sooner*, for when the app is closed: the worker fetches the real reply and hands it to any open tab, or, if none is open, leaves the id for the next open's reconcile. A push carries only a nudge, never content — nothing private rides a third-party push service.
- **The authed inbox** — a message the kernel raised on its own, that this shell never sent, has no local id to reconcile from, so it's discovered through `GET /inbox` (identity-gated) and acknowledged via `/inbox/seen` once shown.

Every path ends the same way: once an answer is actually on screen, its id is forgotten locally and the kernel is told (`/answers/delivered`, or `/inbox/seen`), so it's marked delivered on a real showing — never on a hopeful guess — and never surfaces again. The acknowledgement always follows the render, so the failure direction is at-least-once (shown twice at worst), never a message dropped silently.

## build & preview the production bundle

```bash
yarn build        # type-check, then emit the static site to dist/
yarn preview      # serve an already-built dist/ to sanity-check the artifact
yarn serve        # build, then serve dist/ in one step (build + preview)
```

`yarn dev` and `yarn serve` are not two ways to do the same thing — they serve different artifacts. **`yarn dev`** is [Vite](https://vite.dev/)'s dev server: it serves the TypeScript in `src/` directly, transformed on the fly, with hot reload — fast to iterate on, but it never runs the production build, and in particular it does **not** emit the service worker. Since the worker is registered from `./sw.js` (see [the source](#the-source)) and that file only exists after a build, dev-mode registration simply fails and is swallowed with a warning. So everything the worker carries — PWA install, offline open, and the [capture loop](#the-capture-loop)'s durable outbox drain — is *absent* under `yarn dev`; the terminal itself works, but that whole layer is dark. **`yarn serve`** is the opposite: it runs the full `yarn build` (both type-checks and both Vite passes, including the un-hashed `dist/sw.js`), then `vite preview` serves the real `dist/` — byte-for-byte what deploys. Reach for `yarn dev` while shaping the UI; reach for `yarn serve` whenever the thing you're testing touches the service worker, offline behaviour, or anything that must match production exactly.

The contents of `dist/` are what land on the server's document root.

## deploy

Deployment is done by hand from the server — no CI pipeline. The box keeps a clone of this repo, builds it locally (`dist/` is gitignored, so the artifact is never pulled, only rebuilt), and the built `dist/` is mirrored into nginx's document root at `/var/www/shell.os-joy.com/html`.

**The Joy's apps all live under `~/apps` on the server** — clone this repo to `~/apps/shell.os-joy.com`, the shared home for every Joy app on the box.

One-time, on the server, with [Node.js](https://nodejs.org/) 18+ and Yarn installed:

```bash
mkdir -p ~/apps && cd ~/apps
git clone git@github.com:the-joy-com/shell.os-joy.com.git
cd shell.os-joy.com
```

Every deploy after that is a single command from the clone:

```bash
./deploy.sh
```

`deploy.sh` pulls the latest `main`, installs dependencies against `yarn.lock`, runs `yarn build`, then `rsync`s `dist/` into the document root (with `--delete`, so Vite's content-hashed bundles don't accumulate across deploys) and hands the files to `www-data`. It runs under `set -euo pipefail`, so a failed type-check or build aborts before the live site is touched.

The script is committed with its executable bit set — git tracks that bit, so `./deploy.sh` works straight off a fresh clone. It does still `sudo chown` the document root itself: file ownership isn't something git can carry, so it's set on the server each deploy.

No nginx reload is needed — only the files under an already-served root change.
