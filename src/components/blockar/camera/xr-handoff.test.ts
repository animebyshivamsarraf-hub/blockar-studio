import { describe, expect, it } from "vitest";
import { cameraReducer, frameSourceFor, initialCameraState, needsFreshStream, xrHandoffAction, type CameraEvent } from "./CameraOwnership";
import { RawFrameWatchdog } from "./RawFrameWatchdog";

const run = (...evs: CameraEvent[]) => evs.reduce(cameraReducer, initialCameraState);

describe("XR -> DOM camera handoff", () => {
  it("AR without raw camera + hands on → automatically exit AR for hands", () => {
    const s = run({ type: "HANDS_ON" }, { type: "XR_STARTED", rawCamera: false });
    expect(xrHandoffAction(s, false)).toBe("exit-xr-for-hands");
  });
  it("waits while raw camera support is still being probed", () => {
    const s = run({ type: "HANDS_ON" }, { type: "XR_STARTED", rawCamera: false });
    expect(xrHandoffAction(s, true)).toBe("none");
  });
  it("raw camera works → AR stays, frames come from XR", () => {
    const s = run({ type: "HANDS_ON" }, { type: "XR_STARTED", rawCamera: true });
    expect(xrHandoffAction(s, false)).toBe("none");
    expect(frameSourceFor(s)).toBe("xr");
  });
  it("hands off → AR is never interrupted", () => {
    const s = run({ type: "XR_STARTED", rawCamera: false });
    expect(xrHandoffAction(s, false)).toBe("none");
  });
  it("raw camera lost mid-session → handoff, then XR end restores video", () => {
    let s = run({ type: "HANDS_ON" }, { type: "XR_STARTED", rawCamera: true });
    s = cameraReducer(s, { type: "XR_STARTED", rawCamera: false });
    expect(xrHandoffAction(s, false)).toBe("exit-xr-for-hands");
    s = cameraReducer(s, { type: "XR_ENDED" });
    expect(s.owner).toBe("CAMERA_MEDIAPIPE");
    expect(frameSourceFor(s)).toBe("video");
    expect(xrHandoffAction(s, false)).toBe("none");
  });
  it("after XR or a stall the DOM stream is always reopened", () => {
    const live = { readyState: "live", muted: false };
    expect(needsFreshStream("xr-ended", live)).toBe(true);
    expect(needsFreshStream("stalled", live)).toBe(true);
    expect(needsFreshStream("restore", live)).toBe(false);
    expect(needsFreshStream("restore", { readyState: "live", muted: true })).toBe(true);
    expect(needsFreshStream("restore", { readyState: "ended" })).toBe(true);
    expect(needsFreshStream("restore", null)).toBe(true);
  });
});

describe("Raw camera frame watchdog (stalled-frame recovery)", () => {
  it("fires only when frames are wanted but none arrive", () => {
    const w = new RawFrameWatchdog(2500);
    w.reset(0);
    expect(w.check(1000, true)).toBe(false);
    expect(w.check(3400, true)).toBe(false); // wanting since 1000 → 2400ms
    expect(w.check(3600, true)).toBe(true);
  });
  it("steady frames keep it quiet", () => {
    const w = new RawFrameWatchdog(2500);
    w.reset(0);
    for (let t = 0; t < 10000; t += 66) { expect(w.check(t, true)).toBe(false); w.fed(t); }
  });
  it("pipeline busy (not wanting) never counts as a stall", () => {
    const w = new RawFrameWatchdog(2500);
    w.reset(0);
    for (let t = 0; t < 10000; t += 500) expect(w.check(t, false)).toBe(false);
  });
});
