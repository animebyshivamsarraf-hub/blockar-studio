import type { SpatialProvider } from "./SpatialProvider";
import type { SpatialHit, SpatialInput, SpatialAnchor } from "./SpatialTypes";

export class FallbackSpatialProvider implements SpatialProvider {
  readonly kind = "fallback" as const;
  async start() {}
  async stop() {}
  getSurfaceHit(): SpatialHit | null { return null; }
  getHandInput(): SpatialInput | null { return null; }
  async createAnchor(): Promise<SpatialAnchor | null> { return null; }
}