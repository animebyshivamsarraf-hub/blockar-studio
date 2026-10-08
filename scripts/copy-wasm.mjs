// Copies MediaPipe WASM files from node_modules to public/wasm at build time,
// and downloads the hand landmarker model to public/models/.
// This bundles WASM + model with the app instead of loading from CDN,
// eliminating CDN/version-mismatch failures ("ModuleFactory not set").
import { cpSync, mkdirSync, existsSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const wasmDest = join(root, "public", "wasm");

if (!existsSync(src)) {
  console.warn("[copy-wasm] WASM source not found:", src);
  process.exit(0);
}
mkdirSync(wasmDest, { recursive: true });
cpSync(src, wasmDest, { recursive: true });
console.log("[copy-wasm] Copied WASM files to public/wasm");

// Hand landmarker model (~8MB) — downloaded once at build time so the app
// has zero runtime CDN dependencies for hand tracking.
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
const modelDest = join(root, "public", "models", "hand_landmarker.task");
if (!existsSync(modelDest)) {
  mkdirSync(dirname(modelDest), { recursive: true });
  console.log("[copy-wasm] Downloading hand landmarker model...");
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`Model download failed: ${res.status}`);
  await pipeline(res.body, createWriteStream(modelDest));
  console.log("[copy-wasm] Model saved to public/models/hand_landmarker.task");
} else {
  console.log("[copy-wasm] Model already present, skipping download");
}
