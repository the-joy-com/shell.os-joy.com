# shell.os-joy.com

The input shell for **The Joy** — a terminal that lives in the browser. An ASCII banner, a prompt, and a set of commands: `/help` and `/clear` do their work, `reset` clears the screen without a slash, and `/login`, `/logout`, `/status` are listed and acknowledged but not wired to a backend.

Built with [Vite](https://vite.dev/), TypeScript, and [xterm.js](https://xtermjs.org/). It's a **static** app — `yarn build` emits a plain `dist/` of assets with no runtime backend, which is what gets served from `shell.os-joy.com`.

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

A line you type that **isn't** a `/command` is *content* — it gets sent to the [kernel](../kernel.os-joy.com). On Enter it echoes, then a dim `⋯ sending…` marker appears beneath it while the line is in flight to the kernel's `POST /intake`. On a real acknowledgement (`{ "msg": "copy" }`) that marker is rewritten **in place** to a full-brightness `COPY` — no second line is added. If the send fails for any reason — network error, a CORS-blocked read, a timeout, or a `200` with the wrong shape — the marker becomes `✗ not delivered` instead. **`COPY` only ever appears when the kernel actually received the line**, the same honesty rule the connectivity dot follows.

**Input is never blocked on the network.** The prompt comes back the instant you hit Enter, so you can keep typing — and submitting — while earlier lines are still in flight. Each pending line remembers the terminal row its marker sits on and repaints just that row when its own ack lands, so several sends can be outstanding at once and resolve independently, in whatever order the kernel answers.

There's no offline queue: a line that fails to send is marked `✗ not delivered` rather than held for retry. Queuing lines offline and draining them on reconnect — including repainting markers that have scrolled out of view — is a separate capability built on top of this. Submission is deliberately **not** gated on being logged in: the right to submit is never gated; whether identity changes the *reply* is the kernel's decision.

It sends to the same `VITE_KERNEL_URL` the dot probes — so the `.env.local` recipe above points both at your local kernel in dev.

## build & preview the production bundle

```bash
yarn build        # type-check, then emit the static site to dist/
yarn preview      # serve an already-built dist/ to sanity-check the artifact
yarn serve        # build, then serve dist/ in one step (build + preview)
```

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
