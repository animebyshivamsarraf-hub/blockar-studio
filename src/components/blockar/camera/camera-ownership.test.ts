import { describe, expect, it } from "vitest";
import { cameraReducer, frameSourceFor, handsPausedByXR, initialCameraState, type CameraEvent } from "./CameraOwnership";

const run = (...evs: CameraEvent[]) => evs.reduce(cameraReducer, initialCameraState);

describe("Camera ownership state machine", () => {
  it("hands on without XR → MediaPipe reads the DOM video", () => {
    const s = run({ type: "HANDS_ON" });
    expect(s.owner).toBe("CAMERA_MEDIAPIPE");
    expect(frameSourceFor(s)).toBe("video");
  });
  it("XR with raw camera → XR frames feed hands, never stale video", () => {
    const s = run({ type: "HANDS_ON" }, { type: "XR_STARTED", rawCamera: true });
    expect(s.owner).toBe("CAMERA_XR_RAW_CAMERA");
    expect(frameSourceFor(s)).toBe("xr");
  });
  it("XR without raw camera → hands paused (safe mode), not competing streams", () => {
    const s = run({ type: "HANDS_ON" }, { type: "XR_STARTED", rawCamera: false });
    expect(s.owner).toBe("CAMERA_XR");
    expect(frameSourceFor(s)).toBe("none");
    expect(handsPausedByXR(s)).toBe(true);
  });
  it("XR end restores the MediaPipe pipeline", () => {
    const s = run({ type: "HANDS_ON" }, { type: "XR_STARTED", rawCamera: false }, { type: "XR_ENDED" });
    expect(s.owner).toBe("CAMERA_MEDIAPIPE");
    expect(frameSourceFor(s)).toBe("video");
  });
  it("camera loss and restore are recoverable (no terminal state)", () => {
    const lost = run({ type: "HANDS_ON" }, { type: "CAMERA_LOST" });
    expect(frameSourceFor(lost)).toBe("none");
    expect(cameraReducer(lost, { type: "CAMERA_RESTORED" }).owner).toBe("CAMERA_MEDIAPIPE");
  });
  it("every state can reach idle", () => {
    for (const raw of [true, false]) {
      const s = run({ type: "HANDS_ON" }, { type: "XR_STARTED", rawCamera: raw }, { type: "XR_ENDED" }, { type: "HANDS_OFF" });
      expect(s.owner).toBe("CAMERA_IDLE");
    }
  });
  it("switching AR ↔ hand modes repeatedly stays consistent", () => {
    let s = run({ type: "HANDS_ON" });
    for (let i = 0; i < 5; i++) {
      s = cameraReducer(s, { type: "XR_STARTED", rawCamera: i % 2 === 0 });
      s = cameraReducer(s, { type: "XR_ENDED" });
    }
    expect(s.owner).toBe("CAMERA_MEDIAPIPE");
  });
});
