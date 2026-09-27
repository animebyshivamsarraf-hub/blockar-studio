import * as THREE from "three";
import { GestureDetector, HandTrackingStatus } from "./GestureDetector";
import { HandModelManager } from "./HandModel";

export interface XRHandSample {
  localPoint: THREE.Vector3;
  worldPoint: THREE.Vector3;
  isPinching: boolean;
  status: HandTrackingStatus;
}

export class HandController3D {
  private detector = new GestureDetector();
  private handModelManager: HandModelManager;
  private currentStatus: HandTrackingStatus = "lost";
  private lastSeenAt = 0;
  private readonly LOST_GRACE_MS = 250;
  private frozenLocalPoint: THREE.Vector3 | null = null;

  constructor(
    private scene: THREE.Scene,
    private constructionRoot: THREE.Object3D
  ) {
    this.handModelManager = new HandModelManager(scene);
  }

  get modelManager() {
    return this.handModelManager;
  }

  get status(): HandTrackingStatus {
    return this.currentStatus;
  }

  processFrame(
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
    handSpace: THREE.XRHandSpace
  ): XRHandSample | null {
    const rawHand = (handSpace as any)?.jointSpace;
    const xrHand = (handSpace as any)?.children?.[0]?.xrHand || (handSpace as any)?.hand;
    const now = performance.now();

    const thumbJoint = xrHand?.get?.(4) || xrHand?.[4];
    const indexJoint = xrHand?.get?.(9) || xrHand?.[9];

    if (!thumbJoint || !indexJoint || !frame.getJointPose) {
      if (this.currentStatus === "pinching" || this.currentStatus === "grabbing") {
        if (now - this.lastSeenAt > this.LOST_GRACE_MS) {
          this.currentStatus = "frozen";
        }
      } else {
        this.currentStatus = "lost";
      }
      this.handModelManager.updatePinchMarker(null, false);
      return null;
    }

    const thumbPose = frame.getJointPose(thumbJoint, referenceSpace);
    const indexPose = frame.getJointPose(indexJoint, referenceSpace);

    if (!thumbPose || !indexPose) {
      if (this.currentStatus === "pinching" || this.currentStatus === "grabbing") {
        this.currentStatus = "frozen";
      } else {
        this.currentStatus = "lost";
      }
      this.handModelManager.updatePinchMarker(null, false);
      return null;
    }

    this.lastSeenAt = now;
    if (this.currentStatus === "frozen" || this.currentStatus === "lost") {
      this.currentStatus = "reacquiring";
    }

    const tp = thumbPose.transform.position;
    const ip = indexPose.transform.position;
    const thumbWorld = new THREE.Vector3(tp.x, tp.y, tp.z);
    const indexWorld = new THREE.Vector3(ip.x, ip.y, ip.z);

    const pinchResult = this.detector.evaluatePinch(thumbWorld, indexWorld);
    const localPinch = this.constructionRoot.worldToLocal(pinchResult.pinchPoint.clone());

    if (this.currentStatus === "reacquiring") {
      this.currentStatus = pinchResult.isPinching ? "pinching" : "tracking";
    } else {
      this.currentStatus = pinchResult.isPinching ? "pinching" : "tracking";
    }

    this.handModelManager.updatePinchMarker(pinchResult.pinchPoint, pinchResult.isPinching);

    return {
      localPoint: localPinch,
      worldPoint: pinchResult.pinchPoint,
      isPinching: pinchResult.isPinching,
      status: this.currentStatus,
    };
  }

  freeze() {
    this.currentStatus = "frozen";
    this.handModelManager.updatePinchMarker(null, false);
  }

  reset() {
    this.detector.reset();
    this.currentStatus = "lost";
    this.handModelManager.updatePinchMarker(null, false);
  }

  dispose() {
    this.handModelManager.dispose();
  }
}
