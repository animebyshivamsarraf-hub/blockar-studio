import * as THREE from "three";
import {
  GestureDetector,
  GestureDetectorConfig,
  HandTrackingStatus,
  PinchState,
} from "./GestureDetector";
import { HandModelManager } from "./HandModel";

export interface XRHandSample {
  handedness: "left" | "right";
  localPoint: THREE.Vector3;
  worldPoint: THREE.Vector3;
  isPinching: boolean;
  pinchDistance: number;
  confidence: number;
  status: HandTrackingStatus;
}

export interface TwoHandGestureState {
  bothPinching: boolean;
  distance: number;
  centerWorld: THREE.Vector3;
  centerLocal: THREE.Vector3;
  angleRad: number;
}

export class HandController3D {
  private leftDetector: GestureDetector;
  private rightDetector: GestureDetector;
  private handModelManager: HandModelManager;

  private leftStatus: HandTrackingStatus = "lost";
  private rightStatus: HandTrackingStatus = "lost";

  private leftSeenAt = 0;
  private rightSeenAt = 0;
  private readonly LOST_GRACE_MS = 180;

  private leftReacquireFrames = 0;
  private rightReacquireFrames = 0;
  private readonly REQUIRED_REACQUIRE_FRAMES = 2;

  // Reusable vectors for zero-allocation frame processing
  private tmpThumb = new THREE.Vector3();
  private tmpIndex = new THREE.Vector3();
  private tmpLocal = new THREE.Vector3();
  private lastLeftSample: XRHandSample | null = null;
  private lastRightSample: XRHandSample | null = null;

  constructor(
    private scene: THREE.Scene,
    private constructionRoot: THREE.Object3D,
    gestureOptions?: Partial<GestureDetectorConfig>
  ) {
    this.leftDetector = new GestureDetector(gestureOptions);
    this.rightDetector = new GestureDetector(gestureOptions);
    this.handModelManager = new HandModelManager(scene);
  }

  get modelManager(): HandModelManager {
    return this.handModelManager;
  }

  getStatus(handedness: "left" | "right"): HandTrackingStatus {
    return handedness === "left" ? this.leftStatus : this.rightStatus;
  }

  setStatus(handedness: "left" | "right", status: HandTrackingStatus) {
    if (handedness === "left") this.leftStatus = status;
    else this.rightStatus = status;
  }

  configureDetectors(options: Partial<GestureDetectorConfig>) {
    this.leftDetector.configure(options);
    this.rightDetector.configure(options);
  }

  processSource(
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
    inputSource: XRInputSource
  ): XRHandSample | null {
    const hand = inputSource.hand;
    const handedness = (inputSource.handedness as "left" | "right") || "right";
    const now = performance.now();

    if (!hand || !(frame as any).getJointPose) {
      this.handleLoss(handedness, now);
      return null;
    }

    const thumbJoint = hand.get("thumb-tip") || (hand as any).get?.(4) || (hand as any)[4];
    const indexJoint = hand.get("index-finger-tip") || (hand as any).get?.(9) || (hand as any)[9];

    if (!thumbJoint || !indexJoint) {
      this.handleLoss(handedness, now);
      return null;
    }

    const thumbPose = (frame as any).getJointPose(thumbJoint, referenceSpace);
    const indexPose = (frame as any).getJointPose(indexJoint, referenceSpace);

    if (!thumbPose?.transform?.position || !indexPose?.transform?.position) {
      this.handleLoss(handedness, now);
      return null;
    }

    const tp = thumbPose.transform.position;
    const ip = indexPose.transform.position;
    this.tmpThumb.set(tp.x, tp.y, tp.z);
    this.tmpIndex.set(ip.x, ip.y, ip.z);

    if (handedness === "left") this.leftSeenAt = now;
    else this.rightSeenAt = now;

    // Check reacquisition state
    let curStatus = handedness === "left" ? this.leftStatus : this.rightStatus;
    if (curStatus === "frozen" || curStatus === "lost") {
      if (handedness === "left") {
        this.leftStatus = "reacquiring";
        this.leftReacquireFrames = 1;
      } else {
        this.rightStatus = "reacquiring";
        this.rightReacquireFrames = 1;
      }
      return null;
    } else if (curStatus === "reacquiring") {
      if (handedness === "left") {
        this.leftReacquireFrames++;
        if (this.leftReacquireFrames < this.REQUIRED_REACQUIRE_FRAMES) return null;
        this.leftReacquireFrames = 0;
      } else {
        this.rightReacquireFrames++;
        if (this.rightReacquireFrames < this.REQUIRED_REACQUIRE_FRAMES) return null;
        this.rightReacquireFrames = 0;
      }
    }

    const detector = handedness === "left" ? this.leftDetector : this.rightDetector;
    const pinchResult: PinchState = detector.evaluatePinch(this.tmpThumb, this.tmpIndex, now);
    
    this.tmpLocal.copy(pinchResult.pinchPoint);
    this.constructionRoot.worldToLocal(this.tmpLocal);

    if (curStatus !== "grabbing") {
      curStatus = pinchResult.isPinching ? "pinching" : "tracking";
      if (handedness === "left") this.leftStatus = curStatus;
      else this.rightStatus = curStatus;
    }

    this.handModelManager.updatePinchMarker(
      handedness,
      pinchResult.pinchPoint,
      pinchResult.isPinching,
      curStatus === "grabbing"
    );

    const sample: XRHandSample = {
      handedness,
      localPoint: this.tmpLocal.clone(),
      worldPoint: pinchResult.pinchPoint.clone(),
      isPinching: pinchResult.isPinching,
      pinchDistance: pinchResult.pinchDistance,
      confidence: pinchResult.confidence,
      status: curStatus,
    };

    if (handedness === "left") this.lastLeftSample = sample;
    else this.lastRightSample = sample;

    return sample;
  }

  getTwoHandState(): TwoHandGestureState | null {
    if (!this.lastLeftSample || !this.lastRightSample) return null;
    const now = performance.now();
    if (now - this.leftSeenAt > this.LOST_GRACE_MS || now - this.rightSeenAt > this.LOST_GRACE_MS) {
      return null;
    }

    const bothPinching = this.lastLeftSample.isPinching && this.lastRightSample.isPinching;
    const dist = this.lastLeftSample.worldPoint.distanceTo(this.lastRightSample.worldPoint);
    const centerWorld = new THREE.Vector3()
      .addVectors(this.lastLeftSample.worldPoint, this.lastRightSample.worldPoint)
      .multiplyScalar(0.5);
    const centerLocal = this.constructionRoot.worldToLocal(centerWorld.clone());
    const dx = this.lastRightSample.worldPoint.x - this.lastLeftSample.worldPoint.x;
    const dz = this.lastRightSample.worldPoint.z - this.lastLeftSample.worldPoint.z;
    const angleRad = Math.atan2(dz, dx);

    return {
      bothPinching,
      distance: dist,
      centerWorld,
      centerLocal,
      angleRad,
    };
  }

  private handleLoss(handedness: "left" | "right", now: number) {
    const seenAt = handedness === "left" ? this.leftSeenAt : this.rightSeenAt;
    const curStatus = handedness === "left" ? this.leftStatus : this.rightStatus;

    if (curStatus === "pinching" || curStatus === "grabbing") {
      if (now - seenAt > this.LOST_GRACE_MS) {
        if (handedness === "left") this.leftStatus = "frozen";
        else this.rightStatus = "frozen";
      }
    } else {
      if (handedness === "left") this.leftStatus = "lost";
      else this.rightStatus = "lost";
    }
    this.handModelManager.updatePinchMarker(handedness, null, false);
  }

  freeze(handedness?: "left" | "right") {
    if (!handedness || handedness === "left") this.leftStatus = "frozen";
    if (!handedness || handedness === "right") this.rightStatus = "frozen";
    this.handModelManager.hideAllMarkers();
  }

  reset() {
    this.leftDetector.reset();
    this.rightDetector.reset();
    this.leftStatus = "lost";
    this.rightStatus = "lost";
    this.leftReacquireFrames = 0;
    this.rightReacquireFrames = 0;
    this.lastLeftSample = null;
    this.lastRightSample = null;
    this.handModelManager.hideAllMarkers();
  }

  dispose() {
    this.handModelManager.dispose();
  }
}
