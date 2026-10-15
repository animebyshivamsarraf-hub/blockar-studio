/**
 * Strict one-frame-in-flight gate with generation tokens.
 *
 * Each submission gets a unique id. A submission is only "current" while it is
 * the in-flight one; once it times out, is cancelled, or the gate is reset, the
 * id is permanently dead. Late work (e.g. a createImageBitmap that resolves
 * after its timeout) must check `isCurrent(id)` and discard its result.
 */
export type FrameStage = "bitmap" | "worker";

export class FrameGate {
  private nextId = 1;
  private inFlight: { id: number; stage: FrameStage; t: number } | null = null;

  /** Returns a new token, or null when a frame is already in flight. */
  begin(now: number): number | null {
    if (this.inFlight) return null;
    const id = this.nextId++;
    this.inFlight = { id, stage: "bitmap", t: now };
    return id;
  }

  /** Move a still-current submission to the worker stage. False = token dead. */
  toWorker(id: number, now: number): boolean {
    if (!this.isCurrent(id)) return false;
    this.inFlight = { id, stage: "worker", t: now };
    return true;
  }

  isCurrent(id: number): boolean {
    return this.inFlight?.id === id;
  }

  /** Complete a submission. Stale ids are ignored (returns false). */
  finish(id: number): boolean {
    if (!this.isCurrent(id)) return false;
    this.inFlight = null;
    return true;
  }

  /** Expire the in-flight frame if it is older than its stage limit. Returns the expired stage. */
  expire(now: number, bitmapMs: number, workerMs: number): FrameStage | null {
    const f = this.inFlight;
    if (!f) return null;
    const limit = f.stage === "bitmap" ? bitmapMs : workerMs;
    if (now - f.t < limit) return null;
    this.inFlight = null;
    return f.stage;
  }

  reset() { this.inFlight = null; }
  busy() { return !!this.inFlight; }
  stage(): FrameStage | null { return this.inFlight?.stage ?? null; }
}
