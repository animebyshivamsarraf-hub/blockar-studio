import * as THREE from "three";

export interface GrabbedObject {
  id: string;
  initialLocalPosition: THREE.Vector3;
}

export class GrabController3D {
  private grabOffset: THREE.Vector3 | null = null;
  private grabbedKeys: string[] = [];
  private isGrabbing = false;

  startGrab(
    pinchLocalPoint: THREE.Vector3,
    objectLocalCenter: THREE.Vector3,
    keys: string[]
  ): THREE.Vector3 {
    this.grabOffset = objectLocalCenter.clone().sub(pinchLocalPoint);
    this.grabbedKeys = [...keys];
    this.isGrabbing = true;
    return this.grabOffset.clone();
  }

  updatePosition(currentPinchLocalPoint: THREE.Vector3): THREE.Vector3 | null {
    if (!this.isGrabbing || !this.grabOffset) return null;
    return currentPinchLocalPoint.clone().add(this.grabOffset);
  }

  releaseGrab(): { keys: string[]; finalOffset: THREE.Vector3 | null } {
    const keys = [...this.grabbedKeys];
    const finalOffset = this.grabOffset ? this.grabOffset.clone() : null;
    this.isGrabbing = false;
    this.grabbedKeys = [];
    this.grabOffset = null;
    return { keys, finalOffset };
  }

  get active(): boolean {
    return this.isGrabbing;
  }

  get keys(): string[] {
    return this.grabbedKeys;
  }

  get currentOffset(): THREE.Vector3 | null {
    return this.grabOffset;
  }
}
