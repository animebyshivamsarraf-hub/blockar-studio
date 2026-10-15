/**
 * Detects XR raw-camera frames that stop arriving while the hand pipeline is
 * ready for them (XR loop wedged, getCameraImage silently failing, …).
 * Pure + time-injected so it is unit-testable.
 */
export class RawFrameWatchdog {
  private lastFed = 0;
  private wantSince = 0;
  constructor(private readonly limitMs = 2500) {}
  reset(now: number) { this.lastFed = now; this.wantSince = 0; }
  fed(now: number) { this.lastFed = now; this.wantSince = 0; }
  /** True when the pipeline has wanted a frame for limitMs and none was fed. */
  check(now: number, wanting: boolean): boolean {
    if (!wanting) { this.wantSince = 0; return false; }
    if (!this.wantSince) this.wantSince = now;
    return now - this.wantSince >= this.limitMs && now - this.lastFed >= this.limitMs;
  }
}
