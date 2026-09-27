export type TrackingState = "tracking" | "pinching" | "lost" | "frozen" | "reacquiring";

export interface SpatialHit {
  worldPosition: { x:number; y:number; z:number };
  surfaceNormal: { x:number; y:number; z:number };
  distance: number;
  confidence: number;
  surfaceType: "plane" | "mesh" | "unknown";
  valid: boolean;
}

export interface SpatialInput {
  worldPosition: { x:number; y:number; z:number };
  orientation?: { x:number; y:number; z:number; w:number };
  pinching: boolean;
  pressed: boolean;
  confidence: number;
  trackingState: TrackingState;
}

export interface SpatialAnchor {
  worldPosition: { x:number; y:number; z:number };
  rotation: { x:number; y:number; z:number; w:number };
  valid: boolean;
  persistent: boolean;
}