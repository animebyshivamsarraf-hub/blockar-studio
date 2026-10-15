import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { computeStrictTimestamp } from "./workerPolicy";

// WASM is bundled with the app (public/wasm/) instead of CDN — eliminates
// CDN/version-mismatch failures ("ModuleFactory not set") entirely.
const getWasmUrl = () => `${self.location.origin}/wasm`;
// Model is bundled with the app (public/models/) — zero runtime CDN dependency.
const getModelUrl = () => `${self.location.origin}/models/hand_landmarker.task`;

let landmarker: HandLandmarker | null = null;
let cachedFileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let generation = 0;
let busy = false;
let activeDelegate: "GPU" | "CPU" | null = null;
let cpuFallbackAttempted = false;
let lastTimestamp = -1;

/**
 * Module workers have no working importScripts, so MediaPipe can't load its
 * classic WASM loader script and fails with "ModuleFactory not set". Load the
 * loader ourselves (global-scope eval defines self.ModuleFactory) and make
 * importScripts a no-op so MediaPipe's own loading step is skipped.
 */
async function ensureModuleFactory(loaderPath: string) {
  const g = self as unknown as { ModuleFactory?: unknown; importScripts?: unknown };
  if (!g.ModuleFactory) {
    const res = await fetch(loaderPath);
    if (!res.ok) throw new Error(`WASM loader fetch failed (${res.status})`);
    const code = await res.text();
    (0, eval)(`${code}\n;self.ModuleFactory = self.ModuleFactory || (typeof ModuleFactory !== "undefined" ? ModuleFactory : undefined);`);
  }
  if (!g.ModuleFactory) throw new Error("ModuleFactory not set after loading WASM loader");
  try { g.importScripts = () => {}; } catch { /* ignore */ }
}

async function getFileset() {
  if (!cachedFileset) {
    const fs = await FilesetResolver.forVisionTasks(getWasmUrl());
    await ensureModuleFactory(fs.wasmLoaderPath);
    cachedFileset = fs;
  }
  return cachedFileset;
}

const makeLandmarker = async (
  fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
  delegate: "GPU" | "CPU",
) =>
  HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: getModelUrl(), delegate },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

const init = async (g: number, preferred: "GPU" | "CPU") => {
  const fileset = await getFileset();
  let task: HandLandmarker;
  let delegate = preferred;
  try {
    task = await makeLandmarker(fileset, preferred);
  } catch (e) {
    if (preferred !== "GPU") throw e;
    task = await makeLandmarker(fileset, "CPU");
    delegate = "CPU";
  }
  if (g !== generation) { task.close(); return; }
  try { landmarker?.close(); } catch { /* ignore */ }
  landmarker = task;
  activeDelegate = delegate;
  if (delegate === "CPU") cpuFallbackAttempted = true;
  self.postMessage({ type: "READY", delegate });
};

function closeBitmap(b: unknown) {
  try { (b as ImageBitmap | undefined)?.close?.(); } catch { /* ignore */ }
}

self.onmessage = async (event: MessageEvent) => {
  const data = event.data ?? {};

  if (data.type === "INIT") {
    const g = ++generation;
    busy = false;
    activeDelegate = null;
    cpuFallbackAttempted = false;
    lastTimestamp = -1;
    try {
      await init(g, data.delegate === "CPU" ? "CPU" : "GPU");
    } catch (e) {
      if (g === generation) self.postMessage({ type: "ERROR", error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  if (data.type === "STOP") {
    generation++;
    try { landmarker?.close(); } catch { /* ignore */ }
    landmarker = null;
    activeDelegate = null;
    busy = false;
    lastTimestamp = -1;
    return;
  }

  if (data.type !== "FRAME") return;
  const frameId = data.frameId;

  // Every FRAME gets exactly one reply (RESULT / DROPPED / DETECT_ERROR) so the
  // main thread never waits on a frame the worker silently discarded.
  if (!landmarker || busy) {
    closeBitmap(data.bitmap);
    self.postMessage({ type: "DROPPED", frameId, reason: landmarker ? "busy" : "not ready" });
    return;
  }

  let image: ImageBitmap | ImageData;
  if (data.bitmap) image = data.bitmap as ImageBitmap;
  else if (data.pixels && data.width && data.height) {
    image = new ImageData(new Uint8ClampedArray(data.pixels as ArrayBuffer), data.width, data.height);
  } else {
    self.postMessage({ type: "DROPPED", frameId, reason: "empty frame" });
    return;
  }

  busy = true;
  try {
    const rawTs = typeof data.timestampMs === "number" ? data.timestampMs : performance.now();
    const currentTs = computeStrictTimestamp(lastTimestamp, rawTs);
    lastTimestamp = currentTs;
    const result = landmarker.detectForVideo(image, currentTs);
    self.postMessage({ type: "RESULT", frameId, result: { landmarks: result.landmarks, handedness: result.handedness } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (activeDelegate === "GPU" && !cpuFallbackAttempted) {
      cpuFallbackAttempted = true;
      try {
        await init(generation, "CPU");
        self.postMessage({ type: "RUNTIME_FALLBACK", frameId, from: "GPU", to: "CPU" });
      } catch (fallbackError) {
        self.postMessage({
          type: "DETECT_ERROR", frameId,
          error: `GPU inference failed (${message}); CPU fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        });
      }
    } else {
      self.postMessage({ type: "DETECT_ERROR", frameId, error: message });
    }
  } finally {
    if (data.bitmap) closeBitmap(data.bitmap);
    busy = false;
  }
};
