// Copies MediaPipe WASM files from node_modules to public/wasm at build time.
// This bundles WASM with the app instead of loading from CDN, eliminating
// CDN/version-mismatch failures ("ModuleFactory not set").
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const dest = join(root, "public", "wasm");

if (!existsSync(src)) {
  console.warn("[copy-wasm] WASM source not found:", src);
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log("[copy-wasm] Copied WASM files to public/wasm");
