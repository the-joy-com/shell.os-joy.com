import { defineConfig } from "vite";
import pkg from "./package.json";

// Second build pass, just for the service worker.
// It exists so the worker lands at dist/sw.js — a stable, un-hashed name at the site root —
// which is what gives it whole-app scope.
// The main `vite build` runs first and empties dist/;
// this one keeps emptyOutDir off, so it adds sw.js without wiping that output.
//
// `iife` — an Immediately Invoked Function Expression, the whole worker wrapped in `(function(){ … })()` that runs the moment it loads —
// keeps sw.js a self-contained classic script with no top-level import/export,
// so it registers without the `{ type: "module" }` dance and runs on every Chromium the phone might have.
export default defineConfig({
  base: "./",
  define: {
    // Single-sourced from package.json, like the app's version —
    // the worker names its cache after it, so releases rotate cleanly.
    __SW_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    emptyOutDir: false,
    lib: {
      entry: "src/sw.ts",
      formats: ["iife"],
      name: "sw",
      fileName: () => "sw.js",
    },
  },
});
