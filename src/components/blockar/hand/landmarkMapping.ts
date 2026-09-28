import * as THREE from "three";

/** WebXR joint names in MediaPipe 21-landmark order */
export const XR_TO_MP_JOINTS: XRHandJoint[] = [
  "wrist",
  "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip",
  "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip",
  "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip",
  "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip",
  "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip",
];

export interface ScreenLandmark { x: number; y: number; z: number } // x,y in CSS px, z relative (MediaPipe units)

const PALM_METERS = 0.09; // wrist -> middle MCP, adult average

/**
 * Lift MediaPipe screen-space landmarks into 3D camera-space using palm size as a
 * depth cue. Depth is estimated (not metric); the result feeds the same pipeline
 * as WebXR joints.
 */
export function liftLandmarks(
  pts: ScreenLandmark[],
  camera: THREE.PerspectiveCamera,
  W: number,
  H: number,
  prevDepth: number | null,
  imgWidthPx: number,
): { points: THREE.Vector3[]; depth: number } {
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const perPxAt1 = (2 * tanHalf) / H; // world units per CSS px at 1m
  const w = pts[0]!, m = pts[9]!;
  const palmPx = Math.max(8, Math.hypot(w.x - m.x, w.y - m.y));
  let depth = THREE.MathUtils.clamp(PALM_METERS / (palmPx * perPxAt1), 0.18, 1.6);
  if (prevDepth != null) depth = prevDepth + (depth - prevDepth) * 0.25;
  const perPx = perPxAt1 * depth;
  const aspect = W / H;
  const points = pts.map((p) => {
    const ndcX = (p.x / W) * 2 - 1;
    const ndcY = -((p.y / H) * 2 - 1);
    const d = depth + p.z * imgWidthPx * perPx;
    const v = new THREE.Vector3(ndcX * tanHalf * aspect * d, ndcY * tanHalf * d, -d);
    return v.applyMatrix4(camera.matrixWorld);
  });
  return { points, depth };
}

/** Synthetic open/pinch hand pose (for mouse demo mode) in normalized offsets, y-down */
const OPEN: [number, number][] = [
  [0, 0], [-0.22, -0.12], [-0.36, -0.28], [-0.44, -0.42], [-0.5, -0.54],
  [-0.14, -0.5], [-0.16, -0.72], [-0.17, -0.86], [-0.18, -0.98],
  [0, -0.53], [0, -0.78], [0, -0.93], [0, -1.06],
  [0.13, -0.5], [0.14, -0.72], [0.15, -0.86], [0.16, -0.97],
  [0.25, -0.44], [0.28, -0.6], [0.3, -0.71], [0.31, -0.8],
];

export function syntheticHand(cx: number, cy: number, sizePx: number, pinch: number): ScreenLandmark[] {
  // anchor so the pinch midpoint lands on the cursor
  const pts = OPEN.map(([x, y]) => ({ x, y }));
  const t = pts[4]!, i = pts[8]!;
  const mid = { x: (t.x + i.x) / 2 + 0.06, y: (t.y + i.y) / 2 + 0.1 };
  const lerp = (p: { x: number; y: number }, k: number) => { p.x += (mid.x - p.x) * k; p.y += (mid.y - p.y) * k; };
  lerp(pts[4]!, pinch); lerp(pts[3]!, pinch * 0.5);
  lerp(pts[8]!, pinch); lerp(pts[7]!, pinch * 0.6); lerp(pts[6]!, pinch * 0.3);
  const t2 = pts[4]!, i2 = pts[8]!;
  const ax = (t2.x + i2.x) / 2, ay = (t2.y + i2.y) / 2;
  return pts.map((p) => ({ x: cx + (p.x - ax) * sizePx, y: cy + (p.y - ay) * sizePx, z: 0 }));
}
