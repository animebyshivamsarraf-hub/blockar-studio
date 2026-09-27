import * as THREE from "three";

/** Explicit coordinate-space bridge. No hidden camera-relative offsets. */
export class CoordinateBridge {
  constructor(private readonly constructionRoot: THREE.Object3D) {}

  screenToNdc(x:number,y:number,rect:DOMRect) {
    return new THREE.Vector2(((x-rect.left)/rect.width)*2-1, -((y-rect.top)/rect.height)*2+1);
  }
  cameraToWorld(point: THREE.Vector3, camera: THREE.Camera) {
    return camera.localToWorld(point.clone());
  }
  worldToLocal(point: THREE.Vector3) {
    this.constructionRoot.updateMatrixWorld(true);
    return this.constructionRoot.worldToLocal(point.clone());
  }
  localToWorld(point: THREE.Vector3) {
    this.constructionRoot.updateMatrixWorld(true);
    return this.constructionRoot.localToWorld(point.clone());
  }
}