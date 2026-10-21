import { describe, expect, it, vi } from "vitest";
import {
  cameraReducer,
  frameSourceFor,
  initialCameraState,
  xrHandoffAction,
  type CameraEvent,
  type CameraState,
} from "../camera/CameraOwnership";
import { resolveXRHandoff, type XRHandoffEngine } from "./startupGuards";

/**
 * DEPLOYED-COMBINATION contract tests (2026-10-21 final investigation).
 *
 * The production build pairs the host (BlockAR.tsx + these modules) with the
 * GitHub-lineage engine (DEPLOYED_ENGINE_CURRENT.ts @ main a39269e), whose
 * raw-camera surface is:
 *   rawCameraState: () => "no"                       (engine line ~962)
 *   markRawCameraFailed: () => {}                    (no raw pipeline exists)
 *   setXRCameraSink: store-only, no frame producer   (engine line ~968)
 *   onXRStateChange start: { active: true,  rawCamera: false, pending: false }
 *   onXRStateChange end:   { active: false, rawCamera: false }
 *
 * These tests pin the combination's behaviour so the stub-shaped surface can
 * never silently become a path the host waits on: the fallback must complete
 * end-to-end (XR exit → DOM camera → frameSource "video") and frameSource
 * "xr" must stay unreachable. They are unit tests of the state machine —
 * NOT device proof.
 */

/** Faithful stand-in for the deployed engine's hand/camera contract. */
function makeDeployedEngine() {
  let xr = false;
  let sink: { want: (now: number) => boolean; push: (px: Uint8Array, w: number, h: number, now: number) => void } | null = null;
  const pushSpy = vi.fn();
  const engine = {
    isXR: () => xr,
    rawCameraState: () => "no" as const,
    markRawCameraFailed: vi.fn(() => {}),
    setXRCameraSink: (s: typeof sink) => { sink = s; },
    stopXR: vi.fn(async () => { xr = false; }),
    // Test-only helpers mirroring the engine's own session lifecycle.
    _startXR() { xr = true; },
    _sink: () => sink,
    _pushSpy: pushSpy,
  };
  return engine;
}

/** The exact event the deployed engine's start payload maps to in the host
 *  (BlockAR.tsx engine onXRStateChange → dispatchCamera). */
const DEPLOYED_XR_STARTED: CameraEvent = { type: "XR_STARTED", rawCamera: false };

describe("deployed combination (GitHub engine + host)", () => {
  it("XR start with the deployed payload (rawCamera:false, pending:false) + hands on → host exits AR for hands immediately, no probing grace", () => {
    let s: CameraState = cameraReducer(initialCameraState, { type: "HANDS_ON" });
    s = cameraReducer(s, DEPLOYED_XR_STARTED);
    expect(s.owner).toBe("CAMERA_XR");
    // Raw frames are not the frame source in this state…
    expect(frameSourceFor(s)).toBe("none");
    // …and because the deployed rawCameraState() is never "pending", the
    // host's probing flag is false, so the designed action fires at once:
    // leave AR and use the rear-camera fallback.
    expect(xrHandoffAction(s, /* probing */ false)).toBe("exit-xr-for-hands");
  });

  it("full fallback sequence: handoff exits XR, then HANDS_ON lands on CAMERA_MEDIAPIPE with frameSource 'video'", async () => {
    const engine = makeDeployedEngine();
    engine._startXR();
    const onSwitching = vi.fn();

    const handoff = await resolveXRHandoff(engine as unknown as XRHandoffEngine, {
      onSwitching,
      releaseDelayMs: 0,
      exitPollIntervalMs: 1,
    });

    expect(handoff).toEqual({ kind: "exited", stoppedByUs: true });
    expect(onSwitching).toHaveBeenCalledTimes(1);
    expect(engine.stopXR).toHaveBeenCalledWith(true);
    expect(engine.isXR()).toBe(false);

    // Host state after the engine's 'end' event and the runtime start:
    let s: CameraState = cameraReducer(initialCameraState, { type: "HANDS_ON" });
    s = cameraReducer(s, DEPLOYED_XR_STARTED);
    s = cameraReducer(s, { type: "XR_ENDED" });
    s = cameraReducer(s, { type: "HANDS_ON" });
    expect(s.owner).toBe("CAMERA_MEDIAPIPE");
    expect(frameSourceFor(s)).toBe("video");

    // The no-op raw-failure hook is never needed on the fallback path, and
    // no frame was ever pushed into a sink (there is no producer).
    expect(engine.markRawCameraFailed).not.toHaveBeenCalled();
    expect(engine._pushSpy).not.toHaveBeenCalled();
  });

  it("frameSource 'xr' is unreachable: no event sequence built from deployed-engine payloads ever selects it", () => {
    // XR_STARTED with rawCamera:true is deliberately excluded: only an
    // engine reporting rawCamera:true can emit it, and the deployed engine
    // never does (its start/end payloads always carry rawCamera:false).
    const events: CameraEvent[] = [
      { type: "HANDS_ON" },
      { type: "HANDS_OFF" },
      DEPLOYED_XR_STARTED,
      { type: "XR_ENDED" },
      { type: "CAMERA_LOST" },
      { type: "CAMERA_RESTORED" },
    ];
    const seen = new Set<CameraState>();
    const walk = (s: CameraState, depth: number) => {
      expect(frameSourceFor(s)).not.toBe("xr");
      expect(s.owner).not.toBe("CAMERA_XR_RAW_CAMERA");
      if (depth === 0 || seen.has(s)) return;
      seen.add(s);
      for (const ev of events) walk(cameraReducer(s, ev), depth - 1);
    };
    walk(initialCameraState, 3);
  });

  it("the host's sink-install rule (install only when frameSource is 'xr') never installs a sink in this build", () => {
    const engine = makeDeployedEngine();
    // Mirror of dispatchCamera (BlockAR.tsx): src = frameSourceFor(next);
    // src === "xr" → setXRCameraSink({...}) else setXRCameraSink(null).
    const applyHostRule = (s: CameraState) => {
      if (frameSourceFor(s) === "xr") {
        engine.setXRCameraSink({ want: () => true, push: engine._pushSpy });
      } else {
        engine.setXRCameraSink(null);
      }
    };
    let s: CameraState = cameraReducer(initialCameraState, { type: "HANDS_ON" });
    applyHostRule(s);
    s = cameraReducer(s, DEPLOYED_XR_STARTED);
    applyHostRule(s);
    s = cameraReducer(s, { type: "XR_ENDED" });
    applyHostRule(s);
    expect(engine._sink()).toBeNull();
    expect(engine._pushSpy).not.toHaveBeenCalled();
  });

  it("handoff stays bounded even if stopXR rejects: startup gets 'exited', never a hang", async () => {
    let xr = true;
    const engine: XRHandoffEngine = {
      isXR: () => xr,
      rawCameraState: () => "no",
      stopXR: async () => { xr = false; throw new Error("session.end failed"); },
    };
    const handoff = await resolveXRHandoff(engine, { releaseDelayMs: 0, exitPollIntervalMs: 1 });
    expect(handoff).toEqual({ kind: "exited", stoppedByUs: true });
  });
});
