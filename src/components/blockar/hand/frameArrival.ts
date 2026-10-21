/**
 * Detects a hand pipeline that reached TRACKING but never receives a single
 * inference result — e.g. the XR raw-camera sink was never installed, the
 * engine stopped feeding frames, or getCameraImage silently yields nothing
 * after the probe. Pure + time-injected so it is unit-testable — same
 * pattern as RawFrameWatchdog / FrameProgressTracker.
 *
 * Arm it when the pipeline enters TRACKING on a frame source whose frames
 * arrive asynchronously (XR raw camera). Feed it on every consumed result.
 * check() is true exactly when the deadline has passed with no result fed
 * since arming; the caller disarms when it fires (one-shot per arming).
 */
export class FrameArrivalWatchdog {
  private armed = false;
  private armedAt = 0;
  private fedSinceArm = false;

  constructor(private readonly limitMs = 6000) {}

  arm(now: number) {
    this.armed = true;
    this.armedAt = now;
    this.fedSinceArm = false;
  }

  disarm() {
    this.armed = false;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  /** A result was consumed at/after arming — the pipeline is being fed. */
  fed(now: number) {
    if (this.armed && now >= this.armedAt) this.fedSinceArm = true;
  }

  /** True = armed, past the limit, and no result has arrived since arming. */
  check(now: number): boolean {
    return this.armed && !this.fedSinceArm && now - this.armedAt >= this.limitMs;
  }
}
