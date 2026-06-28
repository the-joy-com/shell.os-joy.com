# shell.os-joy.com

The input shell for **The Joy** — a terminal that lives in the browser. An ASCII banner, a prompt, and a set of commands: `/help` and `/clear` do their work, `reset` clears the screen without a slash, and `/login`, `/logout`, `/status` are listed and acknowledged but not yet wired to a backend.

Built with [Vite](https://vite.dev/), TypeScript, and [xterm.js](https://xtermjs.org/). It's a **static** app — `yarn build` emits a plain `dist/` of assets with no runtime backend, which is what gets served from `shell.os-joy.com`.

It's also an installable **PWA**: added to a phone's home screen it launches standalone — no browser chrome — and a service worker caches the shell so it opens even with no network.

## run it locally

You need [Node.js](https://nodejs.org/) 18+ and [Yarn](https://yarnpkg.com/) (classic, 1.x).

```bash
yarn install      # install dependencies (first time only)
yarn dev          # start the dev server with hot reload
```

`yarn dev` prints a local URL (usually <http://localhost:5173>) — open it and you'll get the terminal. Type `/help` to see the commands.

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
