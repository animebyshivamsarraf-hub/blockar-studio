// @ts-nocheck -- imperative three.js coaster system (spline track, supports, gravity train)
import * as THREE from "three";

const G = 9.81;
export interface TrackPoint { x: number; y: number; z: number }

/** Mini roller-coaster: Catmull-Rom spline through tapped points, procedural rails/ties/supports, energy-based train. */
export function createCoaster(root: THREE.Group, voxel: number) {
  const group = new THREE.Group();
  root.add(group);
  const pts: THREE.Vector3[] = [];
  const markers = new THREE.Group();
  root.add(markers);
  let curve: THREE.CatmullRomCurve3 | null = null;
  let length = 0;
  let loop = false;

  const TARGET_SAMPLE = 0.05;\n  const RAIL_RADIUS = 0.012;\n  const SPINE_RADIUS = 0.016;\n  const TIE_SPACING = 0.15;\n\n  const railMat = new THREE.MeshStandardMaterial({ color: "#ff3b4a", roughness: 0.35, metalness: 0.5 });
  const tieMat = new THREE.MeshStandardMaterial({ color: "#3a3f4a", roughness: 0.7 });
  const supMat = new THREE.MeshStandardMaterial({ color: "#ffc22e", roughness: 0.5, metalness: 0.2 });
  const markMat = new THREE.MeshBasicMaterial({ color: "#4dff88" });
  const markGeo = new THREE.SphereGeometry(voxel * 0.18, 12, 8);

  // train: 3 cars
  const train = new THREE.Group();
  const cars: THREE.Group[] = [];
  const carColors = ["#ff3b4a", "#2f8cff", "#ff3b4a"];
  for (let i = 0; i < 3; i++) {
    const car = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(voxel * 0.7, voxel * 0.3, voxel * 0.9), new THREE.MeshStandardMaterial({ color: carColors[i], roughness: 0.3, metalness: 0.3 }));
    body.position.y = voxel * 0.22;
    const seat = new THREE.Mesh(new THREE.BoxGeometry(voxel * 0.55, voxel * 0.25, voxel * 0.2), new THREE.MeshStandardMaterial({ color: "#1b1f27" }));
    seat.position.set(0, voxel * 0.45, voxel * 0.25);
    car.add(body, seat);
    cars.push(car); train.add(car);
  }
  train.visible = false;
  root.add(train);

  function clear(obj: THREE.Object3D) {
    for (const c of [...obj.children]) {
      obj.remove(c);
      c.traverse((m) => { if ((m as THREE.Mesh).geometry && (m as THREE.Mesh).geometry !== markGeo) (m as THREE.Mesh).geometry.dispose(); });
    }
  }

  function rebuild() {
    clear(group); clear(markers);
    for (const p of pts) { const m = new THREE.Mesh(markGeo, markMat); m.position.copy(p); markers.add(m); }
    curve = null; length = 0;
    if (pts.length < 2) return;
    curve = new THREE.CatmullRomCurve3(pts, loop && pts.length > 2, "centripetal", 0.5);
    length = curve.getLength();
    const segs = Math.max(20, Math.ceil(length / TARGET_SAMPLE));
    const frames = curve.computeFrenetFrames(segs, loop);
    const up = new THREE.Vector3(0, 1, 0);
    const gauge = 0.12;\n    const offs = gauge * 0.5;
    const left: THREE.Vector3[] = [], right: THREE.Vector3[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      const side = new THREE.Vector3().crossVectors(tan, up);
      if (side.lengthSq() < 1e-4) side.copy(frames.binormals[i]);
      side.normalize().multiplyScalar(offs);
      left.push(p.clone().add(side)); right.push(p.clone().sub(side));
      if (Math.floor(i * (length / Math.max(1,segs)) / TIE_SPACING) !== Math.floor((i-1) * (length / Math.max(1,segs)) / TIE_SPACING)) {
        const tie = new THREE.Mesh(new THREE.BoxGeometry(offs * 2.4, voxel * 0.05, voxel * 0.08), tieMat);
        tie.position.copy(p);
        tie.lookAt(p.clone().add(tan));
        group.add(tie);
      }
      if (i % 8 === 0 && p.y > voxel * 0.3) {
        const h = p.y - voxel * 0.03;
        const s = new THREE.Mesh(new THREE.CylinderGeometry(voxel * 0.06, voxel * 0.08, h, 8), supMat);
        s.position.set(p.x, h / 2, p.z);
        group.add(s);
      }
    }
    for (const side of [left, right]) {
      const c = new THREE.CatmullRomCurve3(side, loop && pts.length > 2);
      group.add(new THREE.Mesh(new THREE.TubeGeometry(c, segs, RAIL_RADIUS, 6, loop && pts.length > 2), railMat));
    }
    const spine = new THREE.TubeGeometry(curve, segs, SPINE_RADIUS, 6, loop && pts.length > 2);
    group.add(new THREE.Mesh(spine, tieMat));
  }

  // ride state
  let riding = false;
  let s = 0; // distance along track (meters, local)
  let v = 0;
  let speedFactor = 1;
  const liftSpeed = 0.5; // m/s chain lift in local units, scaled
  const scaleRef = () => root.scale.x || 1;

  function place(t: number, i: number) {
    const tt = ((t % 1) + 1) % 1;
    const p = curve!.getPointAt(tt);
    const tan = curve!.getTangentAt(tt);
    const car = cars[i];
    car.position.copy(p).add(new THREE.Vector3(0, voxel * 0.08, 0));
    car.lookAt(p.clone().add(tan));
  }

  function step(dt: number) {
    if (!riding || !curve) return;
    const sc = scaleRef();
    const t = s / length;
    const tan = curve.getTangentAt(Math.min(Math.max(loop ? ((t % 1) + 1) % 1 : t, 0), 1));
    // gravity along slope, real-world meters use sc (voxels scaled)
    const a = -G * tan.y * 0.35 - 0.08 * v - 0.02 * Math.sign(v);
    v += a * dt * speedFactor;
    const minV = liftSpeed * speedFactor;
    if (v < minV) v = minV; // chain lift keeps it moving
    s += v * dt / sc * sc; // local units
    if (!loop && s >= length) { s = 0; v = minV; }
    if (loop) s = ((s % length) + length) % length;
    for (let i = 0; i < cars.length; i++) {
      const gap = voxel * 1.0 * i;
      const d = loop ? s - gap : Math.max(s - gap, 0);
      place(d / length, i);
    }
  }

  return {
    addPoint(x: number, y: number, z: number) {
      pts.push(new THREE.Vector3(x * voxel, y * voxel + voxel * 0.35, z * voxel));
      rebuild();
      return pts.length;
    },
    raiseLast(dy: number) {
      const p = pts[pts.length - 1]; if (!p) return;
      p.y = Math.max(voxel * 0.35, p.y + dy * voxel); rebuild();
    },
    removeLast() { pts.pop(); rebuild(); },
    clear() { pts.length = 0; this.stop(); rebuild(); },
    setLoop(l: boolean) { loop = l; rebuild(); },
    isLoop: () => loop,
    count: () => pts.length,
    hasTrack: () => !!curve,
    setSpeed(f: number) { speedFactor = f; },
    speedKmh: () => Math.round(v * 3.6 * 10), // toy scale ×10 for fun
    start() { if (!curve) return false; riding = true; s = 0; v = liftSpeed; train.visible = true; markers.visible = false; step(0); return true; },
    stop() { riding = false; cars[0].visible = true; train.visible = false; markers.visible = true; },
    isRiding: () => riding,
    showFront() { cars[0].visible = true; },
    step,
    /** first-person camera pose in world space */
    povPose(out: { pos: THREE.Vector3; look: THREE.Vector3 }) {
      const w = (d: number) => { const t = d / length; return curve!.getPointAt(loop ? ((t % 1) + 1) % 1 : Math.min(Math.max(t, 0), 1)); };
      cars[0].visible = false;
      const p = w(s), f = w(s + voxel * 4);
      out.pos.copy(p).add(new THREE.Vector3(0, voxel * 0.9, 0));
      out.look.copy(f); out.look.y = out.pos.y + THREE.MathUtils.clamp(f.y - p.y, -voxel * 2, voxel * 1.2) - voxel * 0.5;
      root.localToWorld(out.pos); root.localToWorld(out.look);
    },
    serialize: () => ({ loop, pts: pts.map((p) => ({ x: p.x, y: p.y, z: p.z })) }),
    load(d?: { loop?: boolean; pts?: TrackPoint[] }) {
      pts.length = 0; loop = !!d?.loop;
      for (const p of d?.pts ?? []) pts.push(new THREE.Vector3(p.x, p.y, p.z));
      rebuild();
    },
    /** preset: generate a fun coaster from grid-space points */
    loadGrid(list: TrackPoint[], l = true) {
      pts.length = 0; loop = l;
      for (const p of list) pts.push(new THREE.Vector3(p.x * voxel, p.y * voxel + voxel * 0.35, p.z * voxel));
      rebuild();
    },
  };
}
export type Coaster = ReturnType<typeof createCoaster>;
