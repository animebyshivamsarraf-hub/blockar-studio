import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { computeStrictTimestamp } from "./workerPolicy";

// WASM is bundled with the app (public/wasm/) instead of CDN — eliminates
// CDN/version-mismatch failures ("ModuleFactory not set") entirely.
const getWasmUrl = () => `${self.location.origin}/wasm`;
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Bounds an async step so a hung GPU delegate (never resolves, never throws —
// seen on some Android GPUs) can't wedge init forever. The caller falls back
// to CPU or surfaces a labeled error instead.
const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — check network`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });

let landmarker: HandLandmarker | null = null;
let cachedFileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let generation = 0;
let busy = false;
let activeDelegate: "GPU" | "CPU" | null = null;
let cpuFallbackAttempted = false;
let lastTimestamp = -1;

async function getFileset() {
  if (!cachedFileset) {
    cachedFileset = await FilesetResolver.forVisionTasks(getWasmUrl());
  }
  return cachedFileset;
}

const makeLandmarker = async (
  fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
  delegate: "GPU" | "CPU",
) =>
  HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

const init = async (
  g: number,
  preferred: "GPU" | "CPU",
) => {
  const fileset = await withTimeout(getFileset(), 20000, "MediaPipe WASM download");
  let task: HandLandmarker;
  let delegate = preferred;
  try {
    task = await withTimeout(makeLandmarker(fileset, preferred), 15000, `MediaPipe ${preferred} init`);
  } catch (e) {
    if (preferred !== "GPU") throw e;
    // GPU delegate failed or hung — fall back to CPU rather than erroring out.
    task = await withTimeout(makeLandmarker(fileset, "CPU"), 30000, "MediaPipe CPU init");
    delegate = "CPU";
  }
  if (g !== generation) {
    task.close();
    return;
  }
  try {
    landmarker?.close();
  } catch {}
  landmarker = task;
  activeDelegate = delegate;
  lastTimestamp = -1;
  self.postMessage({ type: "READY", delegate });
};

self.onmessage = async (event: MessageEvent) => {
  const data = event.data ?? {};

  if (data.type === "INIT") {
    const g = ++generation;
    busy = false;
    activeDelegate = null;
    cpuFallbackAttempted = false;
    lastTimestamp = -1;
    try {
      await init(g, "GPU");
    } catch (e) {
      if (g === generation) {
        self.postMessage({
          type: "ERROR",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return;
  }

  if (data.type === "STOP") {
    generation++;
    try {
      landmarker?.close();
    } catch {}
    landmarker = null;
    activeDelegate = null;
    busy = false;
    lastTimestamp = -1;
    return;
  }

  if (data.type !== "FRAME" || !landmarker || busy) {
    if (data.bitmap) {
      try {
        data.bitmap.close();
      } catch {}
    }
    return;
  }

  const bitmap = data.bitmap as ImageBitmap;
  busy = true;

  try {
    // Strictly monotonic timestamp required by MediaPipe detectForVideo
    const rawTs = typeof data.timestampMs === "number" ? data.timestampMs : performance.now();
    const currentTs = computeStrictTimestamp(lastTimestamp, rawTs);
    lastTimestamp = currentTs;

    const result = landmarker.detectForVideo(bitmap, currentTs);
    self.postMessage({
      type: "RESULT",
      result: {
        landmarks: result.landmarks,
        handedness: result.handedness,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);

    if (activeDelegate === "GPU" && !cpuFallbackAttempted) {
      cpuFallbackAttempted = true;
      const g = generation;
      try {
        await init(g, "CPU");
        self.postMessage({ type: "RUNTIME_FALLBACK", from: "GPU", to: "CPU" });
      } catch (fallbackError) {
        self.postMessage({
          type: "DETECT_ERROR",
          error: `GPU inference failed (${message}); CPU fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        });
      }
    } else {
      self.postMessage({ type: "DETECT_ERROR", error: message });
    }
  } finally {
    try {
      bitmap.close();
    } catch {}
    busy = false;
  }
};
