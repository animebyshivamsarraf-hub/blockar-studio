import * as THREE from "three";

export type HandTrackingStatus = "tracking" | "pinching" | "grabbing" | "lost" | "frozen" | "reacquiring";

export interface GestureDetectorConfig {
  /** Metric distance (meters) to initiate pinch (default: 0.035m / 35mm) */
  pinchStartThreshold: number;
  /** Metric distance (meters) to release pinch (default: 0.055m / 55mm) */
  pinchReleaseThreshold: number;
  /** Consecutive frames required to confirm pinch initiation (prevents flickers/jitter) */
  pinchConfirmFrames: number;
  /** Consecutive frames required to confirm pinch release (prevents tracking noise drops) */
  releaseConfirmFrames: number;
  /** Maximum allowable hand velocity (m/s) during pinch start (prevents accidental grab on fast swipes) */
  maxVelocityThreshold: number;
  /** Exponential smoothing alpha for pinch center point [0..1] */
  smoothingAlpha: number;
}

export const DEFAULT_GESTURE_CONFIG: GestureDetectorConfig = {
  pinchStartThreshold: 0.035,   // 3.5cm
  pinchReleaseThreshold: 0.055, // 5.5cm
  pinchConfirmFrames: 2,
  releaseConfirmFrames: 2,
  maxVelocityThreshold: 1.8,    // 1.8 m/s
  smoothingAlpha: 0.75,
};

export interface PinchState {
  isPinching: boolean;
  pinchPoint: THREE.Vector3;
  pinchDistance: number;
  status: HandTrackingStatus;
  confidence: number;
}

export class GestureDetector {
  private config: GestureDetectorConfig;
  private pinching = false;
  private pinchCandidateFrames = 0;
  private releaseCandidateFrames = 0;
  private smoothedPinchPoint = new THREE.Vector3();
  private hasSmoothed = false;
  private lastPinchPoint: THREE.Vector3 | null = null;
  private lastTimestamp = 0;

  constructor(options?: Partial<GestureDetectorConfig>) {
    this.config = { ...DEFAULT_GESTURE_CONFIG, ...options };
  }

  configure(options: Partial<GestureDetectorConfig>) {
    this.config = { ...this.config, ...options };
  }

  getConfig(): Readonly<GestureDetectorConfig> {
    return this.config;
  }

  evaluatePinch(
    thumbTip: THREE.Vector3,
    indexTip: THREE.Vector3,
    timestamp: number = performance.now()
  ): PinchState {
    const pinchDistance = thumbTip.distanceTo(indexTip);
    const rawPinchPoint = new THREE.Vector3()
      .addVectors(thumbTip, indexTip)
      .multiplyScalar(0.5);

    // Compute velocity to prevent accidental pinch while swiping rapidly
    let velocity = 0;
    if (this.lastPinchPoint && this.lastTimestamp > 0) {
      const dt = (timestamp - this.lastTimestamp) / 1000;
      if (dt > 0.001) {
        velocity = this.lastPinchPoint.distanceTo(rawPinchPoint) / dt;
      }
    }
    this.lastPinchPoint = rawPinchPoint.clone();
    this.lastTimestamp = timestamp;

    // Apply exponential smoothing to filter sensor micro-jitter
    if (!this.hasSmoothed) {
      this.smoothedPinchPoint.copy(rawPinchPoint);
      this.hasSmoothed = true;
    } else {
      this.smoothedPinchPoint.lerp(rawPinchPoint, this.config.smoothingAlpha);
    }

    // Debounced hysteresis logic
    if (!this.pinching) {
      if (
        pinchDistance < this.config.pinchStartThreshold &&
        velocity <= this.config.maxVelocityThreshold
      ) {
        this.pinchCandidateFrames++;
        if (this.pinchCandidateFrames >= this.config.pinchConfirmFrames) {
          this.pinching = true;
          this.pinchCandidateFrames = 0;
          this.releaseCandidateFrames = 0;
        }
      } else {
        this.pinchCandidateFrames = 0;
      }
    } else {
      if (pinchDistance > this.config.pinchReleaseThreshold) {
        this.releaseCandidateFrames++;
        if (this.releaseCandidateFrames >= this.config.releaseConfirmFrames) {
          this.pinching = false;
          this.releaseCandidateFrames = 0;
          this.pinchCandidateFrames = 0;
        }
      } else {
        this.releaseCandidateFrames = 0;
      }
    }

    // Confidence metric based on distance relative to threshold band
    const range = this.config.pinchReleaseThreshold - this.config.pinchStartThreshold;
    const confidence = this.pinching
      ? Math.max(0, Math.min(1, 1 - (pinchDistance - this.config.pinchStartThreshold) / (range || 0.02)))
      : Math.max(0, Math.min(1, (this.config.pinchReleaseThreshold - pinchDistance) / (range || 0.02)));

    return {
      isPinching: this.pinching,
      pinchPoint: this.smoothedPinchPoint.clone(),
      pinchDistance,
      status: this.pinching ? "pinching" : "tracking",
      confidence,
    };
  }

  reset() {
    this.pinching = false;
    this.pinchCandidateFrames = 0;
    this.releaseCandidateFrames = 0;
    this.hasSmoothed = false;
    this.lastPinchPoint = null;
    this.lastTimestamp = 0;
  }
}
