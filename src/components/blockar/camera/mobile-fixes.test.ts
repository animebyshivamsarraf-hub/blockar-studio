import { describe, it, expect } from "vitest";
import { isMobileUserAgent } from "../hand/HandSystemRuntime";
import { cameraReducer, initialCameraState } from "./CameraOwnership";

// Tests use REAL imported functions, not copies of logic.

describe("isMobileUserAgent (real import)", () => {
  it("Android → true", () => {
    expect(
      isMobileUserAgent("Mozilla/5.0 (Linux; Android 14; moto g45 5G) AppleWebKit/537.36"),
    ).toBe(true);
  });
  it("iPhone → true", () => {
    expect(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(true);
  });
  it("iPad → true", () => {
    expect(isMobileUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe(true);
  });
  it("Desktop Chrome → false", () => {
    expect(isMobileUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120")).toBe(false);
  });
  it("Desktop Mac → false", () => {
    expect(isMobileUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(false);
  });
});

describe("cameraReducer XR guard (real import)", () => {
  it("XR_STARTED then XR_ENDED preserves handsWanted", () => {
    let s = cameraReducer(initialCameraState, { type: "HANDS_ON" });
    s = cameraReducer(s, { type: "XR_STARTED", rawCamera: false });
    expect(s.xr).toBe(true);
    s = cameraReducer(s, { type: "XR_ENDED" });
    expect(s.xr).toBe(false);
    expect(s.handsWanted).toBe(true);
    expect(s.owner).toBe("CAMERA_MEDIAPIPE");
  });
});

// NOT TESTABLE (documented):
// - visibilitychange onVis closure: lives inside React component, needs DOM + component render.
// - scheduleRestore debounce: closure inside component, needs fake timers + DOM.
// - attachTrackListeners: needs real MediaStreamTrack objects.
// These are verified by code review and manual testing.
