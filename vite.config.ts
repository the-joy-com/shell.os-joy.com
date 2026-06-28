import { defineConfig } from "vite";
import pkg from "./package.json";

// Static build: `vite build` emits a plain `dist/` of assets, no runtime backend.
// Relative base so the bundle works wherever nginx serves the document root from.
export default defineConfig({
  base: "./",
  // Single-source the app version from package.json — substituted at build time
  // so the banner can never drift from the real version.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
