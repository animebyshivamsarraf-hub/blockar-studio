import { describe, expect, it } from "vitest";
import {
  PipelineStatsTracker,
  DETECT_ERROR_ESCALATION_THRESHOLD,
  FRAMING_HINT_MIN_RESULTS,
  noResultAction,
  shouldEscalateDetectErrors,
  shouldShowFramingHint,
} from "./pipelineStats";
import { PinchStateMachine } from "./PinchStateMachine";

/**
 * Regression tests for the round-2 root cause (2026-10-21): on the owner's
 * Android phone the hand pipeline reached TRACKING with a READY worker and
 * then produced nothing forever — "HAND: LOST · MEDIAPIPE FALLBACK ·
 * Looking for hand…". The frame chain had no counters and no liveness
 * supervision on the video source, so every possible break (frames never
 * submitted, bitmap failures, worker DROPPED loops, per-frame DETECT_ERROR
 * loops, empty results) looked identical and silent.
 *
 * These are MACHINE tests of the counting + escalation policy. They are
 * NOT Android device verification.
 */
describe("PipelineStatsTracker — frame-chain counters", () => {
  it("starts empty: no result ever → msSince fields are null, not 0", () => {
    const s = new PipelineStatsTracker();
    const snap = s.snapshot(10000);
    expect(snap.framesSubmitted).toBe(0);
    expect(snap.resultsReceived).toBe(0);
    expect(snap.resultsWithLandmarks).toBe(0);
    expect(snap.msSinceLastResult).toBeNull();
    expect(snap.msSinceLastLandmark).toBeNull();
  });

  it("counts submissions, bitmap failures, drops and play failures independently", () => {
    const s = new PipelineStatsTracker();
    s.frameSubmitted(); s.frameSubmitted(); s.frameSubmitted();
    s.bitmapFailed();
    s.dropped(); s.dropped();
    s.playFailed();
    const snap = s.snapshot(5000);
    expect(snap.framesSubmitted).toBe(3);
    expect(snap.bitmapFailures).toBe(1);
    expect(snap.droppedFrames).toBe(2);
    expect(snap.playFailures).toBe(1);
    expect(snap.resultsReceived).toBe(0);
  });

  it("distinguishes empty results from landmark results (the decisive phone evidence)", () => {
    const s = new PipelineStatsTracker();
    s.result(1000, 0); // worker alive, no hand in frame
    s.result(1100, 0);
    let snap = s.snapshot(1600);
    expect(snap.resultsReceived).toBe(2);
    expect(snap.resultsWithLandmarks).toBe(0);
    expect(snap.msSinceLastResult).toBe(500);
    expect(snap.msSinceLastLandmark).toBeNull();
    s.result(2000, 1); // a hand was actually detected
    snap = s.snapshot(2300);
    expect(snap.resultsWithLandmarks).toBe(1);
    expect(snap.msSinceLastLandmark).toBe(300);
  });

  it("reset() zeroes everything for a fresh hand session", () => {
    const s = new PipelineStatsTracker();
    s.frameSubmitted(); s.result(100, 2); s.detectError(); s.workerRestarted();
    s.reset();
    const snap = s.snapshot(9999);
    expect(snap.framesSubmitted).toBe(0);
    expect(snap.resultsReceived).toBe(0);
    expect(snap.workerRestarts).toBe(0);
    expect(snap.msSinceLastResult).toBeNull();
    expect(s.consecutiveErrors).toBe(0);
  });

  it("worker restarts are counted", () => {
    const s = new PipelineStatsTracker();
    s.workerRestarted(); s.workerRestarted();
    expect(s.snapshot(0).workerRestarts).toBe(2);
  });
});

describe("DETECT_ERROR escalation policy", () => {
  it("does not escalate below the threshold", () => {
    const s = new PipelineStatsTracker();
    for (let i = 0; i < DETECT_ERROR_ESCALATION_THRESHOLD - 1; i++) s.detectError();
    expect(s.consecutiveErrors).toBe(DETECT_ERROR_ESCALATION_THRESHOLD - 1);
    expect(shouldEscalateDetectErrors(s.consecutiveErrors)).toBe(false);
  });

  it("escalates at the threshold (a per-frame failure loop is a wedged detector)", () => {
    const s = new PipelineStatsTracker();
    for (let i = 0; i < DETECT_ERROR_ESCALATION_THRESHOLD; i++) s.detectError();
    expect(shouldEscalateDetectErrors(s.consecutiveErrors)).toBe(true);
  });

  it("any consumed RESULT clears the consecutive-error run", () => {
    const s = new PipelineStatsTracker();
    for (let i = 0; i < DETECT_ERROR_ESCALATION_THRESHOLD - 1; i++) s.detectError();
    s.result(1000, 0);
    expect(s.consecutiveErrors).toBe(0);
    s.detectError();
    expect(shouldEscalateDetectErrors(s.consecutiveErrors)).toBe(false);
  });

  it("clearConsecutiveErrors() re-arms the policy after an escalation fired", () => {
    const s = new PipelineStatsTracker();
    for (let i = 0; i < DETECT_ERROR_ESCALATION_THRESHOLD; i++) s.detectError();
    s.clearConsecutiveErrors();
    expect(s.consecutiveErrors).toBe(0);
    expect(s.snapshot(0).detectErrors).toBe(DETECT_ERROR_ESCALATION_THRESHOLD); // total kept
  });
});

describe("noResultAction — TRACKING with zero results must never wait silently", () => {
  it("XR source always hands the camera back, regardless of strikes", () => {
    expect(noResultAction("xr", 0, true)).toBe("handoff");
    expect(noResultAction("xr", 3, false)).toBe("handoff");
  });

  it("video + worker, first strike → restart the worker once", () => {
    expect(noResultAction("video", 0, true)).toBe("restart-worker");
  });

  it("video + worker, second strike → surface a retryable ERROR", () => {
    expect(noResultAction("video", 1, true)).toBe("error");
    expect(noResultAction("video", 5, true)).toBe("error");
  });

  it("video without a worker (main-thread landmarker), first strike → re-arm once", () => {
    expect(noResultAction("video", 0, false)).toBe("rearm");
  });

  it("video without a worker, second strike → ERROR", () => {
    expect(noResultAction("video", 1, false)).toBe("error");
  });

  it("no frame source → no action", () => {
    expect(noResultAction("none", 0, true)).toBe("none");
    expect(noResultAction("none", 2, false)).toBe("none");
  });
});

describe("PinchStateMachine — pinch detection from landmark ratios", () => {
  it("open hand stays OPEN; a closing ratio debounces into PINCHED and holds", () => {
    const p = new PinchStateMachine();
    expect(p.update(0.9)).toBe("OPEN");
    expect(p.update(0.2)).toBe("PINCHING");
    expect(p.held).toBe(false);
    expect(p.update(0.18)).toBe("PINCHED"); // confirmFrames reached
    expect(p.held).toBe(true);
    expect(p.update(0.15)).toBe("PINCHED");
  });

  it("an aborted pinch (ratio recovers during PINCHING) returns to OPEN", () => {
    const p = new PinchStateMachine();
    expect(p.update(0.2)).toBe("PINCHING");
    expect(p.update(0.9)).toBe("OPEN");
    expect(p.held).toBe(false);
  });

  it("release requires sustained open ratio, then RELEASED fires once", () => {
    const p = new PinchStateMachine();
    p.update(0.2); p.update(0.18); // PINCHED
    expect(p.update(0.9)).toBe("RELEASING");
    expect(p.held).toBe(true); // still held during release debounce
    expect(p.update(0.9)).toBe("RELEASING");
    expect(p.update(0.9)).toBe("RELEASED");
    expect(p.held).toBe(false);
  });

  it("reset() returns to OPEN (hand lost mid-pinch cannot stick)", () => {
    const p = new PinchStateMachine();
    p.update(0.2); p.update(0.18);
    expect(p.phase).toBe("PINCHED");
    p.reset();
    expect(p.phase).toBe("OPEN");
    expect(p.held).toBe(false);
  });
});

describe("framing hint (round 3) — results flowing, hand never recognisable", () => {
  // The round-3 harness reproduced candidate (e) in-app on this machine:
  // 797 worker results, 0 with landmarks, because the "camera" frame was
  // an extreme palm close-up with no hand outline. The pipeline was
  // healthy; only the framing was wrong — and the user got no actionable
  // signal. The hint policy turns that counter pattern into one.
  function trackerWith(results: number, landmarkResults: number): PipelineStatsTracker {
    const t = new PipelineStatsTracker();
    for (let i = 0; i < results; i++) t.result(1000 + i * 100, i < landmarkResults ? 1 : 0);
    return t;
  }

  it("stays quiet below the results threshold", () => {
    const t = trackerWith(FRAMING_HINT_MIN_RESULTS - 1, 0);
    expect(shouldShowFramingHint(t.snapshot(100000))).toBe(false);
  });

  it("fires when many results arrived and none contained landmarks", () => {
    const t = trackerWith(FRAMING_HINT_MIN_RESULTS, 0);
    expect(shouldShowFramingHint(t.snapshot(100000))).toBe(true);
  });

  it("never fires once any result contained landmarks", () => {
    const t = trackerWith(FRAMING_HINT_MIN_RESULTS + 10, 1);
    expect(shouldShowFramingHint(t.snapshot(100000))).toBe(false);
  });

  it("reset clears the condition (new hand session starts clean)", () => {
    const t = trackerWith(FRAMING_HINT_MIN_RESULTS, 0);
    expect(shouldShowFramingHint(t.snapshot(100000))).toBe(true);
    t.reset();
    expect(shouldShowFramingHint(t.snapshot(100000))).toBe(false);
  });
});
