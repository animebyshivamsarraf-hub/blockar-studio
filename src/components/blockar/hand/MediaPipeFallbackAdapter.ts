import * as THREE from "three";
import { GestureDetector, GestureDetectorConfig, HandTrackingStatus, PinchState } from "./GestureDetector";
import { GrabController3D } from "../interaction/GrabController3D";

/**
 * ARCHITECTURAL CONTRACT:
 * MediaPipe fallback operates in optical camera coordinates without metric 3D depth sensors or SLAM world-locking.
 * Depth is estimated/pseudo-relative; genuine metric 3D MR requires WebXR immersive-ar.
 * This adapter feeds the EXACT SAME GestureDetector interface and GrabController3D as WebXR.
 */
export const FALLBACK_LIMITATION =
  "MediaPipe fallback operates in optical camera coordinates without metric 3D depth sensors or SLAM world-locking. Depth is estimated/pseudo-relative; genuine metric 3D MR requires WebXR immersive-ar.";

export interface FallbackHandLandmark {
  x: number;
  y: number;
  z?: number;
}

export interface FallbackSample {
  screenPoint: THREE.Vector2;
  rayOrigin?: THREE.Vector3;
  rayDirection?: THREE.Vector3;
  pinchState: PinchState;
  isPinching: boolean;
  status: HandTrackingStatus;
  isMetric: false;
}

export class MediaPipeFallbackAdapter {
  private detector: GestureDetector;
  private grabController: GrabController3D;
  private currentStatus: HandTrackingStatus = "lost";

  constructor(
    grabController: GrabController3D,
    options?: Partial<GestureDetectorConfig>
  ) {
    this.grabController = grabController;
    // Scale-relative thresholds for normalized optical hand bounding box
    this.detector = new GestureDetector({
      pinchStartThreshold: 0.035,
      pinchReleaseThreshold: 0.055,
      ...options,
    });
  }

  get status(): HandTrackingStatus {
    return this.currentStatus;
  }

  get isMetric(): false {
    return false;
  }

  /**
   * Adapts MediaPipe 21 landmarks into the same 3D gesture interface.
   * Uses wrist and middle MCP to normalize optical scale into pseudo-metric coordinates.
   */
  processLandmarks(
    landmarks: FallbackHandLandmark[],
    screenWidth: number,
    screenHeight: number,
    timestamp: number = performance.now()
  ): FallbackSample | null {
    if (!landmarks || landmarks.length < 21) {
      if (this.currentStatus === "pinching" || this.currentStatus === "grabbing") {
        this.currentStatus = "frozen";
        this.grabController.freeze();
      } else {
        this.currentStatus = "lost";
      }
      return null;
    }

    const wrist = landmarks[0]!;
    const thumbTip = landmarks[4]!;
    const indexTip = landmarks[8]!;
    const middleMcp = landmarks[9]!;

    // Optical hand scale (normalization factor)
    const opticalScale = Math.hypot(wrist.x - middleMcp.x, wrist.y - middleMcp.y) || 0.15;
    // Normalized baseline scale representing ~18cm average palm-to-wrist span
    const METRIC_SCALE_ESTIMATE = 0.18;
    const factor = METRIC_SCALE_ESTIMATE / opticalScale;

    // Convert to pseudo-metric frame for the standard GestureDetector
    const thumbSim = new THREE.Vector3(
      thumbTip.x * factor,
      thumbTip.y * factor,
      (thumbTip.z || 0) * factor
    );
    const indexSim = new THREE.Vector3(
      indexTip.x * factor,
      indexTip.y * factor,
      (indexTip.z || 0) * factor
    );

    const pinchState = this.detector.evaluatePinch(thumbSim, indexSim, timestamp);

    // Map screen coordinates for viewport raycasting
    const screenX = (thumbTip.x + indexTip.x) * 0.5 * screenWidth;
    const screenY = (thumbTip.y + indexTip.y) * 0.5 * screenHeight;

    if (this.currentStatus === "frozen" || this.currentStatus === "lost") {
      this.currentStatus = "reacquiring";
    } else {
      this.currentStatus = pinchState.isPinching ? "pinching" : "tracking";
    }

    return {
      screenPoint: new THREE.Vector2(screenX, screenY),
      pinchState,
      isPinching: pinchState.isPinching,
      status: this.currentStatus,
      isMetric: false,
    };
  }

  reset() {
    this.detector.reset();
    this.currentStatus = "lost";
  }
}
