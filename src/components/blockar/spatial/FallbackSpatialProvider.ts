import type { SpatialProvider } from "./SpatialProvider";
import type { SpatialHit, SpatialInput, SpatialAnchor } from "./SpatialTypes";

/**
 * Honest mobile camera fallback provider.
 * Strictly labels 2D/optical projection tracking as planar fallback and does not invent fake 3D depth.
 */
export class FallbackSpatialProvider implements SpatialProvider {
  readonly kind = "fallback" as const;
  private hand: SpatialInput | null = null;

  async start() {}
  async stop() {
    this.hand = null;
  }

  getSurfaceHit(): SpatialHit | null {
    return null;
  }

  getHandInput(): SpatialInput | null {
    return this.hand;
  }

  setHandInput(input: SpatialInput | null) {
    if (input) {
      this.hand = {
        ...input,
        trackingType: "planar_fallback",
      };
    } else {
      this.hand = null;
    }
  }

  async createAnchor(): Promise<SpatialAnchor | null> {
    return null;
  }
}
