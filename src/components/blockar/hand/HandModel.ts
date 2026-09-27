import * as THREE from "three";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";

export class HandModelManager {
  private factory: XRHandModelFactory;
  private pinchMarker: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    this.factory = new XRHandModelFactory();

    const markerMaterial = new THREE.MeshBasicMaterial({
      color: 0x4df0ff,
      transparent: true,
      opacity: 0.85,
      wireframe: true,
    });
    this.pinchMarker = new THREE.Mesh(new THREE.SphereGeometry(0.016, 16, 12), markerMaterial);
    this.pinchMarker.visible = false;
    scene.add(this.pinchMarker);
  }

  createHandMesh(controller: THREE.XRHandSpace): THREE.Object3D {
    return this.factory.createHandModel(controller, "mesh");
  }

  updatePinchMarker(position: THREE.Vector3 | null, visible: boolean) {
    if (position && visible) {
      this.pinchMarker.position.copy(position);
      this.pinchMarker.visible = true;
    } else {
      this.pinchMarker.visible = false;
    }
  }

  dispose() {
    if (this.pinchMarker.parent) {
      this.pinchMarker.parent.remove(this.pinchMarker);
    }
  }
}
