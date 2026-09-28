/**
 * Per-hand pinch lifecycle with hysteresis and frame debouncing.
 * Input is a scale-invariant ratio: thumbTip<->indexTip distance / palm length
 * (wrist -> middle MCP). Works identically for WebXR (metric) and MediaPipe (optical).
 */
export type PinchPhase = "OPEN" | "PINCHING" | "PINCHED" | "RELEASING" | "RELEASED";

export interface PinchConfig {
  /** ratio below which a pinch starts */
  startRatio: number;
  /** ratio above which a pinch releases (must be > startRatio) */
  releaseRatio: number;
  confirmFrames: number;
  releaseFrames: number;
}

export const DEFAULT_PINCH_CONFIG: PinchConfig = {
  startRatio: 0.28,
  releaseRatio: 0.42,
  confirmFrames: 2,
  releaseFrames: 3,
};

export class PinchStateMachine {
  phase: PinchPhase = "OPEN";
  private count = 0;
  constructor(private cfg: PinchConfig = DEFAULT_PINCH_CONFIG) {}

  update(ratio: number): PinchPhase {
    const { startRatio, releaseRatio, confirmFrames, releaseFrames } = this.cfg;
    switch (this.phase) {
      case "OPEN":
      case "RELEASED":
        this.count = 0;
        this.phase = ratio < startRatio ? "PINCHING" : "OPEN";
        if (this.phase === "PINCHING") this.count = 1;
        break;
      case "PINCHING":
        if (ratio < startRatio) {
          if (++this.count >= confirmFrames) { this.phase = "PINCHED"; this.count = 0; }
        } else { this.phase = "OPEN"; this.count = 0; }
        break;
      case "PINCHED":
        if (ratio > releaseRatio) { this.phase = "RELEASING"; this.count = 1; }
        break;
      case "RELEASING":
        if (ratio > releaseRatio) {
          if (++this.count >= releaseFrames) { this.phase = "RELEASED"; this.count = 0; }
        } else { this.phase = "PINCHED"; this.count = 0; }
        break;
    }
    return this.phase;
  }

  /** true while a pinch is held (including the release debounce window) */
  get held(): boolean {
    return this.phase === "PINCHED" || this.phase === "RELEASING";
  }

  reset() { this.phase = "OPEN"; this.count = 0; }
}
