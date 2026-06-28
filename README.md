# shell.os-joy.com

The input shell for **The Joy** — a terminal that lives in the browser. An ASCII banner, a prompt, and a set of commands: `/help` and `/clear` do their work, `reset` clears the screen without a slash, and `/login`, `/logout`, `/status` are listed and acknowledged but not yet wired to a backend.

Built with [Vite](https://vite.dev/), TypeScript, and [xterm.js](https://xtermjs.org/). It's a **static** app — `yarn build` emits a plain `dist/` of assets with no runtime backend, which is what gets served from `shell.os-joy.com`.

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
