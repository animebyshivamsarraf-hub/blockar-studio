import { describe, it, expect } from "vitest";
import { cameraReducer, initialCameraState, needsFreshStream } from "./CameraOwnership";

describe("freeze recovery: camera state machine", () => {
  it("XR_ENDED returns to IDLE when hands not wanted", () => {
    const s1 = cameraReducer(initialCameraState, { type: "XR_STARTED", rawCamera: false });
    expect(s1.owner).toBe("CAMERA_XR");
    const s2 = cameraReducer(s1, { type: "XR_ENDED" });
    expect(s2.owner).toBe("CAMERA_IDLE");
    expect(s2.xr).toBe(false);
  });

  it("XR_ENDED returns to MEDIAPIPE when hands wanted", () => {
    let s = cameraReducer(initialCameraState, { type: "HANDS_ON" });
    s = cameraReducer(s, { type: "XR_STARTED", rawCamera: false });
    expect(s.owner).toBe("CAMERA_XR");
    s = cameraReducer(s, { type: "XR_ENDED" });
    expect(s.owner).toBe("CAMERA_MEDIAPIPE");
  });

  it("CAMERA_LOST during XR does not change owner (XR owns camera)", () => {
    let s = cameraReducer(initialCameraState, { type: "XR_STARTED", rawCamera: true });
    expect(s.owner).toBe("CAMERA_XR_RAW_CAMERA");
    s = cameraReducer(s, { type: "CAMERA_LOST" });
    expect(s.owner).toBe("CAMERA_XR_RAW_CAMERA");
  });

  it("CAMERA_LOST without XR goes to IDLE", () => {
    let s = cameraReducer(initialCameraState, { type: "HANDS_ON" });
    expect(s.owner).toBe("CAMERA_MEDIAPIPE");
    s = cameraReducer(s, { type: "CAMERA_LOST" });
    expect(s.owner).toBe("CAMERA_IDLE");
  });

  it("CAMERA_RESTORED recovers to MEDIAPIPE", () => {
    let s = cameraReducer(initialCameraState, { type: "HANDS_ON" });
    s = cameraReducer(s, { type: "CAMERA_LOST" });
    expect(s.owner).toBe("CAMERA_IDLE");
    s = cameraReducer(s, { type: "CAMERA_RESTORED" });
    expect(s.owner).toBe("CAMERA_MEDIAPIPE");
  });
});

describe("freeze recovery: needsFreshStream", () => {
  it("requires fresh stream after xr-ended", () => {
    expect(needsFreshStream("xr-ended", { readyState: "live" })).toBe(true);
  });

  it("requires fresh stream after stalled", () => {
    expect(needsFreshStream("stalled", { readyState: "live" })).toBe(true);
  });

  it("requires fresh stream when track ended", () => {
    expect(needsFreshStream("other", { readyState: "ended" })).toBe(true);
  });

  it("requires fresh stream when track muted", () => {
    expect(needsFreshStream("other", { readyState: "live", muted: true })).toBe(true);
  });

  it("no fresh stream needed when track live and unmuted", () => {
    expect(needsFreshStream("other", { readyState: "live", muted: false })).toBe(false);
  });

  it("requires fresh stream when no track", () => {
    expect(needsFreshStream("other", null)).toBe(true);
  });
});
