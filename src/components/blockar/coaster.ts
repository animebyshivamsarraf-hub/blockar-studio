// @ts-nocheck -- imperative three.js coaster system (spline track, supports, gravity train)
import * as THREE from "three";
import { TRACK_METRICS } from "./build/TrackMetrics";

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

  const TM = TRACK_METRICS;
  const TARGET_SAMPLE = TM.SAMPLE_SPACING;
  const RAIL_RADIUS = TM.RAIL_RADIUS;
  const SPINE_RADIUS = TM.SPINE_RADIUS;
  const TIE_SPACING = TM.TIE_SPACING;

  const railMat = new THREE.MeshStandardMaterial({ color: "#f1fbff", roughness: 0.3, metalness: 0.4, emissive: "#2fd8ff", emissiveIntensity: 0.25 }); // white rail, subtle cyan glow
  const activeStrokeMat = new THREE.MeshStandardMaterial({ color: "#00e676", roughness: 0.3, emissive: "#00703c", emissiveIntensity: 0.4 }); // luminous green
  const tieMat = new THREE.MeshStandardMaterial({ color: "#e2e8f0", roughness: 0.5 }); // light steel / white
  const supMat = new THREE.MeshStandardMaterial({ color: "#00897b", roughness: 0.4, metalness: 0.3 }); // teal
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

  // Hand-drawn stroke sampling (world-space, construction-root local coords).
  // Path resolution ~0.05 m is kept separate from the 0.10 m voxel grid:
  // stroke samples are NEVER snapped to voxels.
  const MIN_STEP = TM.SAMPLE_SPACING;        // target sample spacing (m)
  const MAX_STEP = TM.MAX_STEP;        // larger single-step = tracking glitch → reject
  const MAX_SPEED = TM.MAX_SPEED;        // m/s — faster than a hand realistically draws
  const MAX_JOIN = TM.MAX_JOIN;         // new stroke must start within this of the track end
  const stats = { samples: 0, rejected: 0, maxStep: 0, lastStep: 0, lastReject: "" };
  let strokeState: null | { smoothed: THREE.Vector3; lastDir: THREE.Vector3 | null; lastT: number; sinceRebuild: number } = null;

  function rebuild() {
    clear(group); clear(markers);
    // endpoint markers only — one sphere per 5 cm sample was visual noise
    if (pts.length) {
      for (const p of pts.length > 1 ? [pts[0], pts[pts.length - 1]] : [pts[0]]) { const m = new THREE.Mesh(markGeo, markMat); m.position.copy(p); markers.add(m); }
    }
    curve = null; length = 0;
    if (pts.length < 2) return;
    const closed = loop && pts.length > 2;
    curve = new THREE.CatmullRomCurve3(pts, closed, "centripetal", 0.5);
    length = curve.getLength();
    const segs = Math.max(12, Math.round(length / TARGET_SAMPLE));
    const up = new THREE.Vector3(0, 1, 0);
    const offs = TM.GAUGE * 0.5; // constant 0.12 m gauge
    const left: THREE.Vector3[] = [], right: THREE.Vector3[] = [];
    let prevSide: THREE.Vector3 | null = null; let prevTan: THREE.Vector3 | null = null;
    let lastTieD = -Infinity, lastSupD = -Infinity;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).normalize();
      // True parallel transport: rotate the previous frame by the tangent change so
      // the rails can never flip/cross; gently re-level toward world-up when possible.
      let side: THREE.Vector3;
      if (!prevSide || !prevTan) {
        side = new THREE.Vector3().crossVectors(tan, up);
        if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
      } else {
        side = prevSide.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(prevTan, tan));
        const level = new THREE.Vector3().crossVectors(tan, up);
        if (level.lengthSq() > 0.09) { level.normalize(); if (level.dot(side) < 0) level.negate(); side.lerp(level, 0.15); }
      }
      side.sub(tan.clone().multiplyScalar(side.dot(tan))).normalize();
      prevSide = side.clone(); prevTan = tan.clone();
      side.multiplyScalar(offs);
      left.push(p.clone().add(side)); right.push(p.clone().sub(side));
      const d = t * length;
      if (d - lastTieD >= TIE_SPACING) {
        lastTieD = d;
        const tie = new THREE.Mesh(new THREE.BoxGeometry(offs * 2.4, voxel * 0.05, voxel * 0.08), tieMat);
        tie.position.copy(p);
        tie.lookAt(p.clone().add(tan));
        group.add(tie);
      }
      if (d - lastSupD >= 0.3 && p.y > voxel * 0.3) {
        lastSupD = d;
        const h = p.y - voxel * 0.03;
        const s = new THREE.Mesh(new THREE.CylinderGeometry(voxel * 0.06, voxel * 0.08, h, 8), supMat);
        s.position.set(p.x, h / 2, p.z);
        group.add(s);
        const base = new THREE.Mesh(new THREE.CylinderGeometry(voxel * 0.14, voxel * 0.16, voxel * 0.03, 12), supMat);
        base.position.set(p.x, voxel * 0.015, p.z);
        group.add(base);
      }
    }
    const currentRailMat = strokeState ? activeStrokeMat : railMat;
    for (const side of [left, right]) {
      const c = new THREE.CatmullRomCurve3(side, closed, "centripetal");
      group.add(new THREE.Mesh(new THREE.TubeGeometry(c, segs, RAIL_RADIUS, 6, closed), currentRailMat));
    }
    group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, segs, SPINE_RADIUS, 6, closed), tieMat));
  }

  function pushPoint(p: THREE.Vector3) {
    const last = pts[pts.length - 1];
    if (last && last.distanceTo(p) < 0.02) return false; // duplicate filter
    pts.push(p);
    return true;
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
      if (pushPoint(new THREE.Vector3(x * voxel, y * voxel, z * voxel))) rebuild();
      return pts.length;
    },
    raiseLast(dy: number) {
      const p = pts[pts.length - 1]; if (!p) return;
      p.y += dy * voxel; rebuild();
    },
    /** Pinch start: begin a continuous world-space stroke (local coords, metres). */
    beginStroke(p: THREE.Vector3, now = performance.now(), allowNewBranch = false) {
      const q = p.clone();
      const last = pts[pts.length - 1];
      if (!allowNewBranch && last && last.distanceTo(q) > MAX_JOIN) {
        stats.rejected++; stats.lastReject = "start too far from track end";
        strokeState = null; return false;
      }
      strokeState = { smoothed: q.clone(), lastDir: null, lastT: now, sinceRebuild: 0, runStart: last && pts.length >= 2 ? null : (last ? last.clone() : q.clone()) };
      if (!last) {
        pushPoint(q); stats.samples++; rebuild();
      } else if (allowNewBranch && last.distanceTo(q) > MAX_JOIN) {
        // Disconnected new stroke: start fresh track path to prevent runaway Catmull-Rom bridging
        pts.length = 0;
        pushPoint(q); stats.samples++; rebuild();
      }
      return true;
    },
    /** Stabilize and rebase stroke after hand loss to prevent runaway leaps or bridging */
    rebaseStroke(p: THREE.Vector3, now = performance.now()) {
      if (strokeState) {
        strokeState.smoothed.copy(p);
        strokeState.lastT = now;
        strokeState.runStart = p.clone();
      }
    },
    /** Pinch + move: sample at ~5 cm, smoothing jitter and rejecting glitches. */
    extendStroke(p: THREE.Vector3, now = performance.now()) {
      const st = strokeState; if (!st) return false;
      const raw = p.clone();
      if (raw.distanceTo(st.smoothed) > MAX_STEP * 1.6) { stats.rejected++; stats.lastReject = "tracking jump"; return false; }
      st.smoothed.lerp(raw, 0.5); // light smoothing: removes tremor without lagging corners
      const last = pts[pts.length - 1]!;
      const d = st.smoothed.distanceTo(last);
      if (d < MIN_STEP) return false;
      const dt = Math.max(1, now - st.lastT) / 1000;
      if (d > MAX_STEP || d / dt > MAX_SPEED) { stats.rejected++; stats.lastReject = "impossible velocity"; st.lastT = now; return false; }
      const next = st.smoothed.clone();
      const dir = next.clone().sub(last).normalize();
      // Straight-run merge: if the hand keeps going the same way, slide the run's
      // end point forward instead of adding a new control point. A straight hand
      // path therefore yields collinear control points → a genuinely straight spline
      // (jittery 5 cm Catmull-Rom points were what made "straight" track wavy).
      const prev = pts.length >= 2 ? pts[pts.length - 2]! : null;
      if (prev && st.runStart) {
        const runDir = last.clone().sub(st.runStart).normalize();
        const ang = THREE.MathUtils.radToDeg(runDir.angleTo(dir));
        const axis = next.clone().sub(st.runStart);
        const along = axis.length();
        const dev = along > 0 ? last.clone().sub(st.runStart).cross(axis.clone().normalize()).length() : 0;
        if (ang < TM.STRAIGHT_ANGLE_DEG && dev < TM.STRAIGHT_TOLERANCE) {
          last.copy(next);
          stats.samples++; stats.lastStep = d; st.lastDir = dir; st.lastT = now;
          if (++st.sinceRebuild >= 2) { st.sinceRebuild = 0; rebuild(); }
          return true;
        }
      }
      st.runStart = last.clone();
      pts.push(next);
      stats.samples++; stats.maxStep = Math.max(stats.maxStep, d); stats.lastStep = d;
      st.lastDir = dir; st.lastT = now;
      if (++st.sinceRebuild >= 2) { st.sinceRebuild = 0; rebuild(); }
      return true;
    },
    endStroke() { if (strokeState) { strokeState = null; rebuild(); } },
    stats: () => ({ ...stats, points: pts.length, length }),
    removeLast() { pts.pop(); rebuild(); },
    clear() { pts.length = 0; strokeState = null; stats.samples = 0; stats.rejected = 0; stats.maxStep = 0; this.stop(); rebuild(); },
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
      for (const p of list) pts.push(new THREE.Vector3(p.x * voxel, p.y * voxel, p.z * voxel));
      rebuild();
    },
  };
}
export type Coaster = ReturnType<typeof createCoaster>;
