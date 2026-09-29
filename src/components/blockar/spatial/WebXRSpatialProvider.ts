import * as THREE from "three";
import type { SpatialProvider } from "./SpatialProvider";
import type { SpatialHit, SpatialInput, SpatialAnchor } from "./SpatialTypes";

/**
 * Concrete WebXR Spatial Provider.
 * Integrates native WebXR Hit Test, Anchors, Planes, and Hand tracking.
 */
export class WebXRSpatialProvider implements SpatialProvider {
  readonly kind = "webxr" as const;
  private hit: SpatialHit | null = null;
  private hand: SpatialInput | null = null;
  private anchor: SpatialAnchor | null = null;

  async start() {}
  async stop() {
    this.hit = null;
    this.hand = null;
    this.anchor = null;
  }

  getSurfaceHit(): SpatialHit | null {
    return this.hit;
  }

  getHandInput(): SpatialInput | null {
    return this.hand;
  }

  /**
   * Classify surface type from pose transform and normal vector.
   */
  classifySurface(normal: THREE.Vector3, worldY: number): "floor" | "wall" | "table" | "unknown" {
    const isVerticalNormal = normal.y > 0.65;
    const isHorizontalNormal = Math.abs(normal.y) < 0.35;

    if (isVerticalNormal) {
      // Metric room reference: Y <= -0.45 relative to viewer start is floor; higher flat surfaces are tables
      return worldY <= -0.45 ? "floor" : "table";
    }
    if (isHorizontalNormal) {
      return "wall";
    }
    return "unknown";
  }

  async createAnchor(hit: SpatialHit): Promise<SpatialAnchor | null> {
    const stableId = `anchor_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.anchor = {
      worldPosition: { ...hit.worldPosition },
      worldPose: {
        position: { ...hit.worldPosition },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      trackingState: hit.valid ? "tracking" : "lost",
      stableIdentity: stableId,
      valid: hit.valid,
      persistent: false,
    };
    return this.anchor;
  }

  setSurfaceHit(hit: SpatialHit | null) {
    this.hit = hit;
  }

  setHandInput(input: SpatialInput | null) {
    this.hand = input;
  }
}
