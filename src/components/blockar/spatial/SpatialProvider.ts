import type { SpatialHit, SpatialInput, SpatialAnchor } from "./SpatialTypes";

export interface SpatialProvider {
  readonly kind: "webxr" | "fallback";
  start(): Promise<void>;
  stop(): Promise<void>;
  getSurfaceHit(): SpatialHit | null;
  getHandInput(): SpatialInput | null;
  createAnchor(hit: SpatialHit): Promise<SpatialAnchor | null>;
}