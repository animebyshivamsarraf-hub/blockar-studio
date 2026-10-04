import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let landmarker: HandLandmarker | null = null;
let generation = 0;
let busy = false;

self.onmessage = async (event: MessageEvent) => {
  const data = event.data ?? {};

  if (data.type === "INIT") {
    const g = ++generation;
    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      const make = async (delegate: "GPU" | "CPU") => HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      let task: HandLandmarker;
      try { task = await make("GPU"); }
      catch { task = await make("CPU"); }
      if (g !== generation) { task.close(); return; }
      landmarker?.close();
      landmarker = task;
      self.postMessage({ type: "READY" });
    } catch (e) {
      if (g === generation) self.postMessage({ type: "ERROR", error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  if (data.type === "STOP") {
    generation++;
    try { landmarker?.close(); } catch {}
    landmarker = null;
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
    self.postMessage({ type: "DETECT_ERROR", error: e instanceof Error ? e.message : String(e) });
  } finally {
    bitmap.close();
    busy = false;
  }
};
