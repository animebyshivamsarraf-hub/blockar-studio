import type { HandLandmarker } from "@mediapipe/tasks-vision";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export interface HandFrame { points: { x: number; y: number }[]; cursor: { x: number; y: number }; pinching: boolean }

/** Starts MediaPipe hand tracking on a <video>; returns a stop function. Coordinates are screen pixels. */
export async function startHands(video: HTMLVideoElement, onFrame: (f: HandFrame | null) => void) {
  const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const lm: HandLandmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    numHands: 1,
  });
  let stopped = false, raf = 0, pinching = false, lastT = -1;
  let sx = -1, sy = -1;
  const loop = () => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2 || video.currentTime === lastT) return;
    lastT = video.currentTime;
    const res = lm.detectForVideo(video, performance.now());
    const hand = res.landmarks?.[0];
    if (!hand) { onFrame(null); return; }
    // map normalized video coords to screen (object-cover)
    const W = window.innerWidth, H = window.innerHeight, vw = video.videoWidth, vh = video.videoHeight;
    const sc = Math.max(W / vw, H / vh), ox = (vw * sc - W) / 2, oy = (vh * sc - H) / 2;
    const pts = hand.map((p) => ({ x: p.x * vw * sc - ox, y: p.y * vh * sc - oy }));
    const t = hand[4]!, i = hand[8]!, w = hand[0]!, m = hand[9]!;
    const size = Math.hypot(w.x - m.x, w.y - m.y) || 0.1; // hand scale
    const d = Math.hypot(t.x - i.x, t.y - i.y) / size;
    pinching = pinching ? d < 0.55 : d < 0.35;
    const cx = (pts[4]!.x + pts[8]!.x) / 2, cy = (pts[4]!.y + pts[8]!.y) / 2;
    if (sx < 0) { sx = cx; sy = cy; }
    sx += (cx - sx) * 0.45; sy += (cy - sy) * 0.45;
    onFrame({ points: pts, cursor: { x: sx, y: sy }, pinching });
  };
  loop();
  return () => { stopped = true; cancelAnimationFrame(raf); lm.close(); };
}
