import type { SpatialProvider } from "./SpatialProvider";
import type { SpatialHit, SpatialInput, SpatialAnchor } from "./SpatialTypes";

/**
 * Thin capability contract for genuine WebXR spatial data.
 * The renderer/engine owns the XR session because Three.js needs the frame.
 */
export class WebXRSpatialProvider implements SpatialProvider {
  readonly kind = "webxr" as const;
  private hit: SpatialHit | null = null;
  private hand: SpatialInput | null = null;
  private anchor: SpatialAnchor | null = null;

  async start() {}
  async stop() { this.hit = null; this.hand = null; this.anchor = null; }
  getSurfaceHit() { return this.hit; }
  getHandInput() { return this.hand; }
  async createAnchor(hit: SpatialHit) {
    this.anchor = {
      worldPosition: { ...hit.worldPosition },
      rotation: { x:0, y:0, z:0, w:1 },
      valid: hit.valid,
      persistent: false,
    };
    return this.anchor;
  }

  setSurfaceHit(hit: SpatialHit | null) { this.hit = hit; }
  setHandInput(input: SpatialInput | null) { this.hand = input; }
}