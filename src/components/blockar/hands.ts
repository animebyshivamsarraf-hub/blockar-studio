import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { MediaPipeFallbackAdapter, type FallbackSample } from "./hand/MediaPipeFallbackAdapter";
import { GrabController3D } from "./interaction/GrabController3D";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export interface HandFrame {
  points: { x: number; y: number }[];
  cursor: { x: number; y: number };
  pinching: boolean;
  status: "tracking" | "pinching" | "grabbing" | "lost" | "frozen" | "reacquiring";
  sample?: FallbackSample;
}

/**
 * Robust MediaPipe hand tracking runtime with GPU -> CPU fallback,
 * timeout handling, and connection to MediaPipeFallbackAdapter & GestureDetector.
 */
export async function startHands(
  video: HTMLVideoElement,
  onFrame: (f: HandFrame | null) => void,
  grabController?: GrabController3D
): Promise<() => void> {
  const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("MediaPipe initialization timed out (15s)")), 15000)
  );

  const initPromise = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    let lm: HandLandmarker;
    try {
      // Primary: GPU delegate
      lm = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 1,
      });
    } catch {
      // Fallback: CPU delegate if WebGL/GPU fails
      lm = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
        runningMode: "VIDEO",
        numHands: 1,
      });
    }
    return lm;
  })();

  const lm = await Promise.race([initPromise, timeoutPromise]);
  const adapter = new MediaPipeFallbackAdapter(grabController || new GrabController3D());

  let stopped = false;
  let raf = 0;
  let lastT = -1;
  let sx = -1;
  let sy = -1;

  const loop = () => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);

    if (video.readyState < 2 || video.currentTime === lastT) return;
    lastT = video.currentTime;

    let res;
    try {
      res = lm.detectForVideo(video, performance.now());
    } catch {
      return;
    }

    const hand = res.landmarks?.[0];
    if (!hand) {
      adapter.reset();
      onFrame(null);
      return;
    }

    const W = window.innerWidth;
    const H = window.innerHeight;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    const sc = Math.max(W / vw, H / vh);
    const ox = (vw * sc - W) / 2;
    const oy = (vh * sc - H) / 2;

    const pts = hand.map((p) => ({
      x: p.x * vw * sc - ox,
      y: p.y * vh * sc - oy,
    }));

    const sample = adapter.processLandmarks(hand, W, H, performance.now());

    const cx = (pts[4]!.x + pts[8]!.x) / 2;
    const cy = (pts[4]!.y + pts[8]!.y) / 2;
    if (sx < 0) { sx = cx; sy = cy; }
    sx += (cx - sx) * 0.45;
    sy += (cy - sy) * 0.45;

    onFrame({
      points: pts,
      cursor: { x: sx, y: sy },
      pinching: sample?.isPinching ?? false,
      status: sample?.status ?? "tracking",
      ...(sample ? { sample } : {}),
    });
  };

  loop();

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    adapter.reset();
    try {
      lm.close();
    } catch {
      // ignore close errors
    }
  };
}
