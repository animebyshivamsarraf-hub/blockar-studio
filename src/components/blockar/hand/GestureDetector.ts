import * as THREE from "three";

export type HandTrackingStatus = "tracking" | "pinching" | "grabbing" | "lost" | "frozen" | "reacquiring";

export interface PinchState {
  isPinching: boolean;
  pinchPoint: THREE.Vector3;
  pinchDistance: number;
  status: HandTrackingStatus;
}

export class GestureDetector {
  private pinching = false;
  private readonly PINCH_START_THRESHOLD = 0.035; // 3.5cm
  private readonly PINCH_RELEASE_THRESHOLD = 0.055; // 5.5cm

  evaluatePinch(thumbTip: THREE.Vector3, indexTip: THREE.Vector3): PinchState {
    const pinchDistance = thumbTip.distanceTo(indexTip);
    const pinchPoint = new THREE.Vector3()
      .addVectors(thumbTip, indexTip)
      .multiplyScalar(0.5);

    if (!this.pinching && pinchDistance < this.PINCH_START_THRESHOLD) {
      this.pinching = true;
    } else if (this.pinching && pinchDistance > this.PINCH_RELEASE_THRESHOLD) {
      this.pinching = false;
    }

    return {
      isPinching: this.pinching,
      pinchPoint,
      pinchDistance,
      status: this.pinching ? "pinching" : "tracking",
    };
  }

  reset() {
    this.pinching = false;
  }
}
