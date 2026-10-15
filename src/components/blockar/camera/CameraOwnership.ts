/**
 * Camera / frame ownership state machine.
 *
 * Exactly one producer owns the camera frames that feed hand tracking:
 *  - CAMERA_IDLE           nobody (hands off, no XR)
 *  - CAMERA_MEDIAPIPE      the DOM <video> rear-camera stream
 *  - CAMERA_XR             an immersive-ar session WITHOUT raw camera access
 *                          (hand tracking is paused — never fed stale video)
 *  - CAMERA_XR_RAW_CAMERA  an immersive-ar session WITH raw camera access
 *                          (XR camera frames are routed to the hand worker)
 *
 * Every state has a path back to CAMERA_IDLE / CAMERA_MEDIAPIPE: no terminal states.
 */
export type CameraOwner = "CAMERA_IDLE" | "CAMERA_MEDIAPIPE" | "CAMERA_XR" | "CAMERA_XR_RAW_CAMERA";
export type FrameSource = "none" | "video" | "xr";

export type CameraEvent =
  | { type: "HANDS_ON" }
  | { type: "HANDS_OFF" }
  | { type: "XR_STARTED"; rawCamera: boolean }
  | { type: "XR_ENDED" }
  | { type: "CAMERA_LOST" }
  | { type: "CAMERA_RESTORED" };

export interface CameraState {
  owner: CameraOwner;
  handsWanted: boolean;
  xr: boolean;
  rawCamera: boolean;
}

export const initialCameraState: CameraState = { owner: "CAMERA_IDLE", handsWanted: false, xr: false, rawCamera: false };

function ownerFor(s: Omit<CameraState, "owner">, cameraLive = true): CameraOwner {
  if (s.xr) return s.rawCamera ? "CAMERA_XR_RAW_CAMERA" : "CAMERA_XR";
  if (s.handsWanted && cameraLive) return "CAMERA_MEDIAPIPE";
  return "CAMERA_IDLE";
}

export function cameraReducer(state: CameraState, ev: CameraEvent): CameraState {
  switch (ev.type) {
    case "HANDS_ON": { const n = { ...state, handsWanted: true }; return { ...n, owner: ownerFor(n) }; }
    case "HANDS_OFF": { const n = { ...state, handsWanted: false }; return { ...n, owner: ownerFor(n) }; }
    case "XR_STARTED": { const n = { ...state, xr: true, rawCamera: ev.rawCamera }; return { ...n, owner: ownerFor(n) }; }
    case "XR_ENDED": { const n = { ...state, xr: false, rawCamera: false }; return { ...n, owner: ownerFor(n) }; }
    case "CAMERA_LOST": return state.xr ? state : { ...state, owner: "CAMERA_IDLE" };
    case "CAMERA_RESTORED": return { ...state, owner: ownerFor(state) };
  }
}

/** Which frame source the hand pipeline must read in a given ownership state. */
export function frameSourceFor(s: CameraState): FrameSource {
  if (!s.handsWanted) return "none";
  if (s.owner === "CAMERA_MEDIAPIPE") return "video";
  if (s.owner === "CAMERA_XR_RAW_CAMERA") return "xr";
  return "none";
}

/** True when hands were requested but the current owner cannot feed them (AR without raw camera). */
export function handsPausedByXR(s: CameraState): boolean {
  return s.handsWanted && s.owner === "CAMERA_XR";
}

/**
 * What to do when AR is active but cannot feed hand tracking (no Raw Camera Access).
 * Phones can't run immersive AR and a second camera stream together, so when hands
 * are wanted we leave AR (anchor kept) and hand the camera back to MediaPipe.
 * While raw-camera support is still being probed we wait.
 */
export function xrHandoffAction(s: CameraState, probing: boolean): "none" | "exit-xr-for-hands" {
  return !probing && handsPausedByXR(s) ? "exit-xr-for-hands" : "none";
}

/** A DOM camera stream must be reopened after XR held the camera or when frames stalled. */
export function needsFreshStream(reason: string, track: { readyState: string; muted?: boolean } | null | undefined): boolean {
  if (reason === "xr-ended" || reason === "stalled") return true;
  return !track || track.readyState !== "live" || !!track.muted;
}
