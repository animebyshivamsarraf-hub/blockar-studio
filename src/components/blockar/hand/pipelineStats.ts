/**
 * Live-pipeline counters + liveness policy for the MediaPipe hand path.
 *
 * Why this exists (root cause, 2026-10-21 round 2): the hand pipeline could
 * reach TRACKING on a phone with a READY worker and then produce NOTHING
 * forever — permanently "HAND: LOST · Looking for hand…". Every failure
 * link in the frame chain was silent: the no-result watchdog was armed only
 * for the XR frame source, worker DETECT_ERROR replies were stored but
 * never escalated or shown, createImageBitmap failures were swallowed, and
 * the video stall watchdog was blind until the first frame advanced. With
 * zero counters there was no way — on the device or in a screenshot of the
 * Dev Test Logs — to tell WHICH link was broken.
 *
 * This module is pure + time-injected (same pattern as frameArrival.ts /
 * workerPolicy.ts) so the counting and the escalation policy are unit
 * tested; HandSystemRuntime only wires it to the real worker/video.
 */

export interface PipelineSnapshot {
  /** Frames actually posted to the worker (bitmap resolved / pixels pushed). */
  framesSubmitted: number;
  /** createImageBitmap() rejections — frames that never reached the worker. */
  bitmapFailures: number;
  /** RESULT replies consumed (current token only). */
  resultsReceived: number;
  /** Consumed RESULTs whose landmarks array was non-empty. */
  resultsWithLandmarks: number;
  /** DROPPED replies from the worker (busy / not ready / empty frame). */
  droppedFrames: number;
  /** DETECT_ERROR replies from the worker. */
  detectErrors: number;
  /** video.play() failures (startup, rebind, stall retry). */
  playFailures: number;
  /** Worker restarts triggered since the current session started. */
  workerRestarts: number;
  /** Milliseconds since the last consumed RESULT, or null if none ever. */
  msSinceLastResult: number | null;
  /** Milliseconds since the last RESULT with landmarks, or null if none ever. */
  msSinceLastLandmark: number | null;
}

export class PipelineStatsTracker {
  private framesSubmitted = 0;
  private bitmapFailures = 0;
  private resultsReceived = 0;
  private resultsWithLandmarks = 0;
  private droppedFrames = 0;
  private detectErrors = 0;
  private consecutiveDetectErrors = 0;
  private playFailures = 0;
  private workerRestarts = 0;
  private lastResultAt: number | null = null;
  private lastLandmarkAt: number | null = null;

  reset() {
    this.framesSubmitted = 0;
    this.bitmapFailures = 0;
    this.resultsReceived = 0;
    this.resultsWithLandmarks = 0;
    this.droppedFrames = 0;
    this.detectErrors = 0;
    this.consecutiveDetectErrors = 0;
    this.playFailures = 0;
    this.workerRestarts = 0;
    this.lastResultAt = null;
    this.lastLandmarkAt = null;
  }

  frameSubmitted() { this.framesSubmitted++; }
  bitmapFailed() { this.bitmapFailures++; }
  dropped() { this.droppedFrames++; }
  playFailed() { this.playFailures++; }
  workerRestarted() { this.workerRestarts++; }

  /** A RESULT was consumed. landmarkCount = hands in the result (0 = empty). */
  result(now: number, landmarkCount: number) {
    this.resultsReceived++;
    this.consecutiveDetectErrors = 0;
    this.lastResultAt = now;
    if (landmarkCount > 0) {
      this.resultsWithLandmarks++;
      this.lastLandmarkAt = now;
    }
  }

  detectError() {
    this.detectErrors++;
    this.consecutiveDetectErrors++;
  }

  get consecutiveErrors(): number { return this.consecutiveDetectErrors; }

  /** Clear the consecutive-error run after an escalation has been triggered. */
  clearConsecutiveErrors() { this.consecutiveDetectErrors = 0; }

  snapshot(now: number): PipelineSnapshot {
    return {
      framesSubmitted: this.framesSubmitted,
      bitmapFailures: this.bitmapFailures,
      resultsReceived: this.resultsReceived,
      resultsWithLandmarks: this.resultsWithLandmarks,
      droppedFrames: this.droppedFrames,
      detectErrors: this.detectErrors,
      playFailures: this.playFailures,
      workerRestarts: this.workerRestarts,
      msSinceLastResult: this.lastResultAt == null ? null : Math.max(0, Math.round(now - this.lastResultAt)),
      msSinceLastLandmark: this.lastLandmarkAt == null ? null : Math.max(0, Math.round(now - this.lastLandmarkAt)),
    };
  }
}

/**
 * Results-with-no-landmarks threshold for the framing hint (round 3).
 *
 * The round-3 machine harness proved a failure mode the counters could
 * already count but the user could not act on: the pipeline runs perfectly
 * (worker READY, results arriving 1:1, zero errors) while the model finds
 * no hand in ANY frame — because the hand is framed so close/cropped that
 * no recognisable hand is in the picture (an extreme palm close-up was
 * reproduced in-app: 797 results, 0 with landmarks, and the same content
 * scored 0/8 through the bare worker). That is a USER-correctable framing
 * problem, not a pipeline fault — but the HUD only ever said "Looking for
 * hand…". After this many consecutive result-bearing seconds with zero
 * landmark results, the host shows an actionable framing hint instead.
 * 30 results ≈ 3 s of worker replies at the phone's 10 fps CPU rate.
 */
export const FRAMING_HINT_MIN_RESULTS = 30;

export function shouldShowFramingHint(snap: PipelineSnapshot): boolean {
  return snap.resultsReceived >= FRAMING_HINT_MIN_RESULTS && snap.resultsWithLandmarks === 0;
}

/** Consecutive DETECT_ERROR replies that trigger a worker restart. */
export const DETECT_ERROR_ESCALATION_THRESHOLD = 5;

export function shouldEscalateDetectErrors(consecutive: number): boolean {
  return consecutive >= DETECT_ERROR_ESCALATION_THRESHOLD;
}

export type NoResultAction = "handoff" | "restart-worker" | "rearm" | "error" | "none";

/**
 * What to do when the pipeline is TRACKING but no inference result has
 * arrived within the watchdog window:
 *  - XR source: hand the camera back to the DOM fallback (host handoff).
 *  - Video source with a restartable worker, first strike: restart the
 *    worker once — a wedged worker/WASM instance is the most likely cause.
 *  - Video source without a worker (main-thread landmarker), first strike:
 *    re-arm once — a transient hiccup must not kill a working session.
 *  - Any later strike: surface a real, retryable ERROR instead of waiting
 *    forever in "LOST".
 */
export function noResultAction(
  source: "video" | "xr" | "none",
  strikes: number,
  canRestartWorker: boolean,
): NoResultAction {
  if (source === "xr") return "handoff";
  if (source !== "video") return "none";
  if (strikes <= 0) return canRestartWorker ? "restart-worker" : "rearm";
  return "error";
}
