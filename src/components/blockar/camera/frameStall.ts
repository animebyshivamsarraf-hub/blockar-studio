/**
 * Watches a <video> element's currentTime clock and reports when it stops
 * advancing (decoder wedged, camera taken by another client, …) even though
 * the track still claims to be live. Pure + time-injected so it is
 * unit-testable — same pattern as RawFrameWatchdog.
 *
 * Triggers at most once per limit window while the clock stays frozen;
 * any observed advance fully resets the episode.
 */
export class FrameProgressTracker {
  private lastCt = -1;
  private lastAdvance = 0;
  constructor(private readonly limitMs = 2500) {}

  reset(now: number) {
    this.lastCt = -1;
    this.lastAdvance = now;
  }

  /** Observe the video clock. True = frozen for at least limitMs. */
  observe(now: number, currentTime: number): boolean {
    if (this.lastCt < 0 || currentTime !== this.lastCt) {
      this.lastCt = currentTime;
      this.lastAdvance = now;
      return false;
    }
    if (now - this.lastAdvance >= this.limitMs) {
      this.lastAdvance = now;
      return true;
    }
    return false;
  }
}
