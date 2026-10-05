import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let landmarker: HandLandmarker | null = null;
let cachedFileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let generation = 0;
let busy = false;
let activeDelegate: "GPU" | "CPU" | null = null;
let cpuFallbackAttempted = false;
let lastTimestamp = -1;

async function getFileset() {
  if (!cachedFileset) {
    cachedFileset = await FilesetResolver.forVisionTasks(WASM);
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
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

const init = async (
  g: number,
  preferred: "GPU" | "CPU",
) => {
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
    const rawTs = typeof data.timestampMs === "number" ? Math.round(data.timestampMs) : performance.now();
    const currentTs = Math.max(lastTimestamp + 1, rawTs);
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
