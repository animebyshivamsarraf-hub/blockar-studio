export type TrackingState = "tracking" | "pinching" | "grabbing" | "lost" | "frozen" | "reacquiring";

export interface SpatialHit {
  worldPosition: { x: number; y: number; z: number };
  surfaceNormal: { x: number; y: number; z: number };
  distance: number;
  confidence: number;
  surfaceType: "floor" | "wall" | "table" | "unknown";
  valid: boolean;
}

export interface SpatialAnchor {
  worldPosition: { x: number; y: number; z: number };
  worldPose?: {
    position: { x: number; y: number; z: number };
    orientation: { x: number; y: number; z: number; w: number };
  };
  orientation: { x: number; y: number; z: number; w: number };
  rotation?: { x: number; y: number; z: number; w: number };
  trackingState: "tracking" | "paused" | "lost";
  stableIdentity: string;
  valid: boolean;
  persistent?: boolean;
}

export interface SpatialInput {
  worldPosition: { x: number; y: number; z: number };
  orientation?: { x: number; y: number; z: number; w: number };
  pinching: boolean;
  pressed: boolean;
  confidence: number;
  trackingState: TrackingState;
  trackingType?: "true_3d" | "planar_fallback";
}
