import * as THREE from "three";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";

export interface HandVisualOptions {
  pinchColor?: number;
  grabColor?: number;
  trackColor?: number;
}

export class HandModelManager {
  private factory: XRHandModelFactory;
  private leftPinchMarker: THREE.Mesh;
  private rightPinchMarker: THREE.Mesh;
  private leftHandModel: THREE.Object3D | null = null;
  private rightHandModel: THREE.Object3D | null = null;

  constructor(private scene: THREE.Scene, options?: HandVisualOptions) {
    this.factory = new XRHandModelFactory();

    const pinchMat = new THREE.MeshBasicMaterial({
      color: options?.pinchColor ?? 0x4df0ff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const rightMat = new THREE.MeshBasicMaterial({
      color: options?.pinchColor ?? 0x4dff88,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });

    this.leftPinchMarker = new THREE.Mesh(new THREE.SphereGeometry(0.016, 16, 12), pinchMat);
    this.leftPinchMarker.visible = false;
    this.scene.add(this.leftPinchMarker);

    this.rightPinchMarker = new THREE.Mesh(new THREE.SphereGeometry(0.016, 16, 12), rightMat);
    this.rightPinchMarker.visible = false;
    this.scene.add(this.rightPinchMarker);
  }

  attachHand(controller: THREE.XRHandSpace, handedness: "left" | "right"): THREE.Object3D {
    const model = this.factory.createHandModel(controller, "mesh");
    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of materials) {
          mat.transparent = true;
          mat.opacity = 0.92;
          if ("roughness" in mat) (mat as THREE.MeshStandardMaterial).roughness = 0.45;
        }
      }
    });

    controller.add(model);
    if (handedness === "left") this.leftHandModel = model;
    else this.rightHandModel = model;
    return model;
  }

  updatePinchMarker(
    handedness: "left" | "right",
    position: THREE.Vector3 | null,
    isPinching: boolean,
    isGrabbing: boolean = false
  ) {
    const marker = handedness === "left" ? this.leftPinchMarker : this.rightPinchMarker;
    if (position && (isPinching || isGrabbing)) {
      marker.position.copy(position);
      marker.visible = true;
      const mat = marker.material as THREE.MeshBasicMaterial;
      mat.color.setHex(isGrabbing ? 0xff4d88 : 0x4df0ff);
    } else {
      marker.visible = false;
    }
  }

  hideAllMarkers() {
    this.leftPinchMarker.visible = false;
    this.rightPinchMarker.visible = false;
  }

  dispose() {
    if (this.leftPinchMarker.parent) this.leftPinchMarker.parent.remove(this.leftPinchMarker);
    if (this.rightPinchMarker.parent) this.rightPinchMarker.parent.remove(this.rightPinchMarker);
  }
}
