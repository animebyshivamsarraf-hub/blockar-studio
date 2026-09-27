import * as THREE from "three";

export interface GrabbedEntity {
  id: string;
  initialLocalPosition: THREE.Vector3;
}

export class GrabController3D {
  private grabOffset: THREE.Vector3 | null = null;
  private grabbedKeys: string[] = [];
  private isGrabbing = false;
  private isFrozen = false;
  private lastValidLocalPosition: THREE.Vector3 | null = null;
  private lastValidPinchPoint: THREE.Vector3 | null = null;

  /**
   * Initializes grab maintaining initial object relative position.
   * Formula: grabOffset = objectWorldPosition - pinchWorldPosition
   * Prevents object from jumping to hand when pinch begins.
   */
  startGrab(
    pinchLocalPoint: THREE.Vector3,
    objectLocalCenter: THREE.Vector3,
    keys: string[]
  ): THREE.Vector3 {
    this.grabOffset = objectLocalCenter.clone().sub(pinchLocalPoint);
    this.grabbedKeys = [...keys];
    this.isGrabbing = true;
    this.isFrozen = false;
    this.lastValidPinchPoint = pinchLocalPoint.clone();
    this.lastValidLocalPosition = pinchLocalPoint.clone().add(this.grabOffset);
    return this.grabOffset.clone();
  }

  /**
   * Updates grabbed object position during active tracking.
   * Formula: objectWorldPosition = currentPinchWorldPosition + grabOffset
   * When tracking is frozen, stops extrapolation and returns last valid position.
   */
  updatePosition(currentPinchLocalPoint: THREE.Vector3): THREE.Vector3 | null {
    if (!this.isGrabbing || !this.grabOffset) return null;

    if (this.isFrozen) {
      // Freeze: do not extrapolate with stale or noisy coordinates
      return this.lastValidLocalPosition ? this.lastValidLocalPosition.clone() : null;
    }

    const newPosition = currentPinchLocalPoint.clone().add(this.grabOffset);
    this.lastValidPinchPoint = currentPinchLocalPoint.clone();
    this.lastValidLocalPosition = newPosition.clone();
    return newPosition;
  }

  /**
   * Freezes grabbed position when tracking confidence drops or hand is lost.
   */
  freeze() {
    this.isFrozen = true;
  }

  /**
   * Safely rebases grab offset upon tracking reacquisition to avoid teleportation.
   */
  rebase(newPinchLocalPoint: THREE.Vector3) {
    if (!this.isGrabbing || !this.lastValidLocalPosition) return;
    // Recalculate offset so the object remains at its frozen position
    this.grabOffset = this.lastValidLocalPosition.clone().sub(newPinchLocalPoint);
    this.lastValidPinchPoint = newPinchLocalPoint.clone();
    this.isFrozen = false;
  }

  /**
   * Releases grab and clears tracking state.
   */
  releaseGrab(): { keys: string[]; finalOffset: THREE.Vector3 | null } {
    const keys = [...this.grabbedKeys];
    const finalOffset = this.grabOffset ? this.grabOffset.clone() : null;
    this.isGrabbing = false;
    this.isFrozen = false;
    this.grabbedKeys = [];
    this.grabOffset = null;
    this.lastValidLocalPosition = null;
    this.lastValidPinchPoint = null;
    return { keys, finalOffset };
  }

  get active(): boolean {
    return this.isGrabbing;
  }

  get frozen(): boolean {
    return this.isFrozen;
  }

  get keys(): string[] {
    return this.grabbedKeys;
  }

  get currentOffset(): THREE.Vector3 | null {
    return this.grabOffset ? this.grabOffset.clone() : null;
  }

  get lastKnownPosition(): THREE.Vector3 | null {
    return this.lastValidLocalPosition ? this.lastValidLocalPosition.clone() : null;
  }
}
