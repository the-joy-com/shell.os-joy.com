/// <reference types="vite/client" />

// Injected by Vite's `define` from package.json's version at build time.
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  // Base URL of the kernel the connectivity dot probes. 
  // Unset in normal builds (defaults to the production kernel); 
  // set in a gitignored .env.local to point dev at a locally running kernel, 
  // e.g. VITE_KERNEL_URL=http://127.0.0.1:9713.
  readonly VITE_KERNEL_URL?: string;
}
