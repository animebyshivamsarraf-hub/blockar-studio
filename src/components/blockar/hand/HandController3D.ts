import * as THREE from "three";
import {
  GestureDetector,
  GestureDetectorConfig,
  HandTrackingStatus,
  PinchState,
} from "./GestureDetector";
import { HandModelManager } from "./HandModel";

export interface XRHandSample {
  handedness: "left" | "right" | "none";
  localPoint: THREE.Vector3;
  worldPoint: THREE.Vector3;
  isPinching: boolean;
  pinchDistance: number;
  confidence: number;
  status: HandTrackingStatus;
}

export class HandController3D {
  private detector: GestureDetector;
  private handModelManager: HandModelManager;
  private currentStatus: HandTrackingStatus = "lost";
  private lastSeenAt = 0;
  private readonly LOST_GRACE_MS = 180;
  private reacquireFrames = 0;
  private readonly REQUIRED_REACQUIRE_FRAMES = 3;

  constructor(
    private scene: THREE.Scene,
    private constructionRoot: THREE.Object3D,
    gestureOptions?: Partial<GestureDetectorConfig>
  ) {
    this.detector = new GestureDetector(gestureOptions);
    this.handModelManager = new HandModelManager(scene);
  }

  get modelManager(): HandModelManager {
    return this.handModelManager;
  }

  get status(): HandTrackingStatus {
    return this.currentStatus;
  }

  setStatus(status: HandTrackingStatus) {
    this.currentStatus = status;
  }

  configureDetector(options: Partial<GestureDetectorConfig>) {
    this.detector.configure(options);
  }

  getDetector(): GestureDetector {
    return this.detector;
  }

  processFrame(
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
    inputSource: XRInputSource
  ): XRHandSample | null {
    const hand = inputSource.hand;
    const handedness = (inputSource.handedness as "left" | "right") || "none";
    const now = performance.now();

    if (!hand || !(frame as any).getJointPose) {
      this.handleTrackingLoss(now);
      return null;
    }

    // Standard WebXR joints
    const thumbJoint = hand.get("thumb-tip") || (hand as any).get?.(4) || (hand as any)[4];
    const indexJoint = hand.get("index-finger-tip") || (hand as any).get?.(9) || (hand as any)[9];

    if (!thumbJoint || !indexJoint) {
      this.handleTrackingLoss(now);
      return null;
    }

    const thumbPose = (frame as any).getJointPose(thumbJoint, referenceSpace);
    const indexPose = (frame as any).getJointPose(indexJoint, referenceSpace);

    if (!thumbPose?.transform?.position || !indexPose?.transform?.position) {
      this.handleTrackingLoss(now);
      return null;
    }

    const tp = thumbPose.transform.position;
    const ip = indexPose.transform.position;
    const thumbWorld = new THREE.Vector3(tp.x, tp.y, tp.z);
    const indexWorld = new THREE.Vector3(ip.x, ip.y, ip.z);

    this.lastSeenAt = now;

    // Check reacquisition from frozen or lost state
    if (this.currentStatus === "frozen" || this.currentStatus === "lost") {
      this.currentStatus = "reacquiring";
      this.reacquireFrames = 1;
    } else if (this.currentStatus === "reacquiring") {
      this.reacquireFrames++;
      if (this.reacquireFrames < this.REQUIRED_REACQUIRE_FRAMES) {
        // Suppress actions while confirming stable tracking
        return null;
      }
      this.reacquireFrames = 0;
    }

    const pinchResult: PinchState = this.detector.evaluatePinch(thumbWorld, indexWorld, now);
    const localPinch = this.constructionRoot.worldToLocal(pinchResult.pinchPoint.clone());

    if (this.currentStatus !== "grabbing") {
      this.currentStatus = pinchResult.isPinching ? "pinching" : "tracking";
    }

    this.handModelManager.updatePinchMarker(pinchResult.pinchPoint, pinchResult.isPinching);

    return {
      handedness,
      localPoint: localPinch,
      worldPoint: pinchResult.pinchPoint,
      isPinching: pinchResult.isPinching,
      pinchDistance: pinchResult.pinchDistance,
      confidence: pinchResult.confidence,
      status: this.currentStatus,
    };
  }

  private handleTrackingLoss(now: number) {
    if (this.currentStatus === "pinching" || this.currentStatus === "grabbing") {
      if (now - this.lastSeenAt > this.LOST_GRACE_MS) {
        this.currentStatus = "frozen";
      }
    } else {
      this.currentStatus = "lost";
    }
    this.handModelManager.updatePinchMarker(null, false);
  }

  freeze() {
    this.currentStatus = "frozen";
    this.handModelManager.updatePinchMarker(null, false);
  }

  reset() {
    this.detector.reset();
    this.currentStatus = "lost";
    this.reacquireFrames = 0;
    this.handModelManager.updatePinchMarker(null, false);
  }

  dispose() {
    this.handModelManager.dispose();
  }
}
