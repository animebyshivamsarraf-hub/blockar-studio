import * as THREE from "three";

/** MediaPipe 21-landmark bone topology */
export const HAND_BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];
const TIPS = new Set([4, 8, 12, 16, 20]);
const PALM = [0, 1, 5, 9, 13, 17];

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Lightweight glowing hand made of primitives. Meshes are created once and only
 * their transforms are updated per frame. Joint positions are smoothed.
 */
export class HandSkeleton3D {
  readonly group = new THREE.Group();
  private joints: THREE.Mesh[] = [];
  private bones: THREE.Mesh[] = [];
  private palm: THREE.Mesh;
  private palmPos: Float32Array;
  private smoothed: THREE.Vector3[] = [];
  private hasPose = false;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private jointMat: THREE.MeshBasicMaterial;
  private boneMat: THREE.MeshBasicMaterial;

  constructor(color = 0x4de8ff, private smoothing = 0.55) {
    this.jointMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    this.boneMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
    const jointGeo = new THREE.SphereGeometry(1, 12, 8);
    const boneGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    for (let i = 0; i < 21; i++) {
      const m = new THREE.Mesh(jointGeo, this.jointMat);
      const r = i === 0 ? 0.013 : TIPS.has(i) ? 0.0085 : 0.0072;
      m.scale.setScalar(r);
      m.renderOrder = 10;
      this.joints.push(m);
      this.group.add(m);
      this.smoothed.push(new THREE.Vector3());
    }
    for (let i = 0; i < HAND_BONES.length; i++) {
      const b = new THREE.Mesh(boneGeo, this.boneMat);
      b.renderOrder = 9;
      this.bones.push(b);
      this.group.add(b);
    }
    // Palm fan: center + 5 rim vertices
    const geo = new THREE.BufferGeometry();
    this.palmPos = new Float32Array(PALM.length * 3);
    geo.setAttribute("position", new THREE.BufferAttribute(this.palmPos, 3));
    geo.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]);
    this.palm = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.palm.frustumCulled = false;
    this.group.add(this.palm);
    this.group.visible = false;
  }

  update(points: THREE.Vector3[] | null) {
    if (!points || points.length < 21) { this.group.visible = false; this.hasPose = false; return; }
    this.group.visible = true;
    for (let i = 0; i < 21; i++) {
      const p = points[i]!;
      const s = this.smoothed[i]!;
      if (!this.hasPose) s.copy(p); else s.lerp(p, this.smoothing);
      this.joints[i]!.position.copy(s);
    }
    this.hasPose = true;
    for (let i = 0; i < HAND_BONES.length; i++) {
      const [a, b] = HAND_BONES[i]!;
      const A = this.smoothed[a]!, B = this.smoothed[b]!;
      const bone = this.bones[i]!;
      this.tmpA.subVectors(B, A);
      const len = this.tmpA.length();
      bone.position.copy(A).addScaledVector(this.tmpA, 0.5);
      bone.scale.set(0.0042, Math.max(len, 1e-4), 0.0042);
      if (len > 1e-5) bone.quaternion.setFromUnitVectors(UP, this.tmpB.copy(this.tmpA).divideScalar(len));
    }
    PALM.forEach((idx, k) => {
      const p = this.smoothed[idx]!;
      this.palmPos[k * 3] = p.x; this.palmPos[k * 3 + 1] = p.y; this.palmPos[k * 3 + 2] = p.z;
    });
    (this.palm.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  /** smoothed joint position */
  joint(i: number): THREE.Vector3 { return this.smoothed[i]!; }

  setColor(hex: number) { this.jointMat.color.setHex(hex); this.boneMat.color.setHex(hex); }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    });
    this.group.removeFromParent();
  }
}
