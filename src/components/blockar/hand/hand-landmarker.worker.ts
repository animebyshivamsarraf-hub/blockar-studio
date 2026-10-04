import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let landmarker: HandLandmarker | null = null;
let generation = 0;
let busy = false;
let activeDelegate: "GPU" | "CPU" | null = null;
let cpuFallbackAttempted = false;

const makeLandmarker = async (fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>, delegate: "GPU" | "CPU") =>
  HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

const init = async (g: number, fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>, preferred: "GPU" | "CPU") => {
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
  landmarker?.close();
  landmarker = task;
  activeDelegate = delegate;
  self.postMessage({ type: "READY", delegate });
};

self.onmessage = async (event: MessageEvent) => {
  const data = event.data ?? {};

  if (data.type === "INIT") {
    const g = ++generation;
    busy = false;
    activeDelegate = null;
    cpuFallbackAttempted = false;
    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      await init(g, fileset, "GPU");
    } catch (e) {
      if (g === generation) self.postMessage({ type: "ERROR", error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  if (data.type === "STOP") {
    generation++;
    try { landmarker?.close(); } catch {}
    landmarker = null;
    activeDelegate = null;
    busy = false;
    return;
  }

  if (data.type !== "FRAME" || !landmarker || busy) {
    if (data.bitmap) data.bitmap.close();
    return;
  }

  const bitmap = data.bitmap as ImageBitmap;
  busy = true;
  try {
    const result = landmarker.detectForVideo(bitmap, data.timestampMs);
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
        const fileset = await FilesetResolver.forVisionTasks(WASM);
        await init(g, fileset, "CPU");
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
    bitmap.close();
    busy = false;
  }
};