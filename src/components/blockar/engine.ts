// @ts-nocheck -- strict index checks are noisy for this imperative three.js engine
import * as THREE from "three";
import { createCoaster } from "./coaster";

export const VOXEL = 0.1; // 10 cm
export type Shape = "cube" | "sphere" | "cylinder" | "pyramid";
export type Mode = "build" | "move" | "delete" | "paint" | "group" | "track";
export interface Cell { x: number; y: number; z: number; shape: Shape; color: string }
interface Change { key: string; prev: Cell | null; next: Cell | null }

export const COLORS = ["#2f8cff", "#3ee8ff", "#c04dff", "#ff4fb8", "#ff8a2b", "#b8c2cc"];
const k = (x: number, y: number, z: number) => `${x},${y},${z}`;

export interface EngineOpts {
  canvas: HTMLCanvasElement;
  getMode: () => Mode;
  getShape: () => Shape;
  getColor: () => string;
  onChange: (info: { count: number; canUndo: boolean; canRedo: boolean }) => void;
  onHint: (h: string) => void;
}

export function createEngine(o: EngineOpts) {
  const renderer = new THREE.WebGLRenderer({ canvas: o.canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.xr.enabled = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 50);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1, 3, 2);
  scene.add(sun);

  const root = new THREE.Group();
  scene.add(root);
  const grid = new THREE.GridHelper(4, 40, 0x3ee8ff, 0x2a6a80);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.35;
  root.add(grid);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ visible: false }));
  root.add(floor);

  // reticle: glowing square
  const reticle = new THREE.Group();
  const sq = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(VOXEL, VOXEL).rotateX(-Math.PI / 2)),
    new THREE.LineBasicMaterial({ color: 0x4dff88 }),
  );
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(VOXEL, VOXEL).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: 0.25, depthWrite: false }));
  reticle.add(sq, fill);
  root.add(reticle);
  const selBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(VOXEL * 1.06, VOXEL * 1.06, VOXEL * 1.06)), new THREE.LineBasicMaterial({ color: 0x9ff6ff }));
  selBox.visible = false;
  root.add(selBox);

  const geos: Record<Shape, THREE.BufferGeometry> = {
    cube: new THREE.BoxGeometry(VOXEL * 0.96, VOXEL * 0.96, VOXEL * 0.96),
    sphere: new THREE.SphereGeometry(VOXEL * 0.48, 20, 14),
    cylinder: new THREE.CylinderGeometry(VOXEL * 0.45, VOXEL * 0.45, VOXEL * 0.96, 20),
    pyramid: new THREE.ConeGeometry(VOXEL * 0.6, VOXEL * 0.96, 4).rotateY(Math.PI / 4),
  };
  const mats = new Map<string, THREE.Material>();
  const mat = (c: string) => {
    if (!mats.has(c)) mats.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: 0.35, metalness: 0.15, emissive: c, emissiveIntensity: 0.12 }));
    return mats.get(c)!;
  };

  const coaster = createCoaster(root, VOXEL);
  let pov = false;
  const povPose = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  let lastT = performance.now();
  const cells = new Map<string, Cell>();
  const meshes = new Map<string, THREE.Mesh>();
  const undo: Change[][] = [];
  const redo: Change[][] = [];
  const emit = () => o.onChange({ count: cells.size, canUndo: undo.length > 0, canRedo: redo.length > 0 });

  function setCell(key: string, c: Cell | null) {
    const m = meshes.get(key);
    if (m) { root.remove(m); meshes.delete(key); }
    if (!c) { cells.delete(key); return; }
    cells.set(key, c);
    const mesh = new THREE.Mesh(geos[c.shape], mat(c.color));
    mesh.position.set(c.x * VOXEL, c.y * VOXEL + VOXEL / 2, c.z * VOXEL);
    mesh.userData.key = key;
    root.add(mesh);
    meshes.set(key, mesh);
  }
  function apply(changes: Change[], dir: "next" | "prev") {
    const list = dir === "next" ? changes : [...changes].reverse();
    for (const ch of list) setCell(ch.key, ch[dir]);
  }
  let stroke: Change[] | null = null;
  function change(key: string, next: Cell | null) {
    const ch = { key, prev: cells.get(key) ?? null, next };
    setCell(key, next);
    if (stroke) stroke.push(ch); else commit([ch]);
  }
  function commit(chs: Change[]) {
    if (!chs.length) return;
    undo.push(chs); redo.length = 0; emit();
  }

  // ---- camera (fallback orbit) ----
  const orbit = { yaw: 0.6, pitch: 0.7, r: 2.4 };
  function placeCam() {
    camera.position.set(Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * orbit.r, Math.sin(orbit.pitch) * orbit.r, Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * orbit.r);
    camera.lookAt(0, 0.1, 0);
  }
  placeCam();

  // ---- raycast ----
  const ray = new THREE.Raycaster();
  type Hit = { add: [number, number, number] | null; block: string | null; floorPt: THREE.Vector3 | null };
  function hitFrom(ndc: THREE.Vector2): Hit {
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects([...meshes.values(), floor], false);
    for (const h of hits) {
      const local = root.worldToLocal(h.point.clone());
      if (h.object === floor) {
        return { add: [Math.round(local.x / VOXEL), 0, Math.round(local.z / VOXEL)], block: null, floorPt: local };
      }
      const c = cells.get(h.object.userData.key)!;
      const n = h.face ? h.face.normal.clone() : new THREE.Vector3(0, 1, 0);
      // snap normal to dominant axis
      const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
      const d: [number, number, number] = ax > ay && ax > az ? [Math.sign(n.x), 0, 0] : ay > az ? [0, Math.sign(n.y), 0] : [0, 0, Math.sign(n.z)];
      const t: [number, number, number] = [c.x + d[0], c.y + d[1], c.z + d[2]];
      return { add: t[1] >= 0 ? t : null, block: h.object.userData.key, floorPt: local };
    }
    return { add: null, block: null, floorPt: null };
  }
  const toNdc = (e: { clientX: number; clientY: number }) => {
    const r = o.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };

  function place(t: [number, number, number]) {
    const key = k(...t);
    if (cells.has(key)) return;
    change(key, { x: t[0], y: t[1], z: t[2], shape: o.getShape(), color: o.getColor() });
  }
  function connected(start: string) {
    const out = new Set<string>([start]); const q = [start];
    while (q.length) {
      const [x, y, z] = q.pop()!.split(",").map(Number);
      for (const [a, b, c] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const nk = k(x + a, y + b, z + c);
        if (cells.has(nk) && !out.has(nk)) { out.add(nk); q.push(nk); }
      }
    }
    return [...out];
  }

  // ---- pointer ----
  let drag: null | { kind: "stroke" | "orbit" | "move"; x: number; y: number; keys?: string[]; start?: THREE.Vector3; dx?: number; dz?: number; lastAdd?: string } = null;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;

  function down(e: PointerEvent) {
    try { o.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      if (stroke) { commit(stroke); stroke = null; }
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      drag = { kind: "orbit", x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return;
    }
    const mode = o.getMode();
    const h = hitFrom(toNdc(e));
    if (coaster.isRiding() && pov) { drag = { kind: "orbit", x: e.clientX, y: e.clientY }; return; }
    if (mode === "track") {
      if (h.add) { const n = coaster.addPoint(...h.add); o.onHint(n < 2 ? "Start point set — tap more spots to lay track" : `${n} track points · stack blocks to make hills`); }
      drag = null; return;
    }
    if (mode === "build") {
      stroke = [];
      if (h.add) place(h.add);
      drag = { kind: "stroke", x: e.clientX, y: e.clientY, lastAdd: h.add ? k(...h.add) : undefined };
    } else if (mode === "delete" || mode === "paint") {
      stroke = [];
      drag = { kind: "stroke", x: e.clientX, y: e.clientY };
      applyTool(h);
    } else {
      if (h.block && h.floorPt) {
        const keys = mode === "group" ? connected(h.block) : [h.block];
        drag = { kind: "move", x: e.clientX, y: e.clientY, keys, start: h.floorPt, dx: 0, dz: 0 };
        o.onHint(mode === "group" ? `Group of ${keys.length} grabbed — drag to move` : "Block grabbed — drag to move");
      } else drag = { kind: "orbit", x: e.clientX, y: e.clientY };
    }
  }
  function applyTool(h: Hit) {
    if (!h.block) return;
    const mode = o.getMode();
    if (mode === "delete") change(h.block, null);
    else if (mode === "paint") {
      const c = cells.get(h.block)!;
      if (c.color !== o.getColor()) change(h.block, { ...c, color: o.getColor() });
    }
  }
  const movePlane = new THREE.Plane();
  function move(e: PointerEvent) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) return;
    if (pointers.size === 2 && drag.kind === "orbit") {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      orbit.r = THREE.MathUtils.clamp(orbit.r * (pinchDist / d), 0.4, 4);
      pinchDist = d;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      orbit.yaw -= (cx - drag.x) * 0.008; orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + (cy - drag.y) * 0.006, 0.15, 1.45);
      drag.x = cx; drag.y = cy; placeCam();
      return;
    }
    if (drag.kind === "orbit") {
      orbit.yaw -= (e.clientX - drag.x) * 0.008;
      orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + (e.clientY - drag.y) * 0.006, 0.15, 1.45);
      drag.x = e.clientX; drag.y = e.clientY; placeCam();
    } else if (drag.kind === "stroke") {
      const h = hitFrom(toNdc(e));
      if (o.getMode() === "build") {
        if (h.add && k(...h.add) !== drag.lastAdd && !(h.block && drag.lastAdd === h.block && false)) {
          place(h.add); drag.lastAdd = k(...h.add);
        }
      } else applyTool(h);
    } else if (drag.kind === "move" && drag.start) {
      movePlane.set(new THREE.Vector3(0, 1, 0), -drag.start.y);
      ray.setFromCamera(toNdc(e), camera);
      const p = new THREE.Vector3();
      if (!ray.ray.intersectPlane(movePlane, p)) return;
      const lp = root.worldToLocal(p);
      drag.dx = Math.round((lp.x - drag.start.x) / VOXEL);
      drag.dz = Math.round((lp.z - drag.start.z) / VOXEL);
      for (const key of drag.keys!) {
        const c = cells.get(key)!; const m = meshes.get(key)!;
        m.position.set((c.x + drag.dx) * VOXEL, c.y * VOXEL + VOXEL / 2, (c.z + drag.dz) * VOXEL);
      }
    }
  }
  function up(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (!drag) return;
    if (drag.kind === "move" && drag.keys) {
      const { dx = 0, dz = 0, keys } = drag;
      const set = new Set(keys);
      const moved = keys.map((key) => { const c = cells.get(key)!; return { ...c, x: c.x + dx, z: c.z + dz }; });
      const blocked = moved.some((c) => { const nk = k(c.x, c.y, c.z); return cells.has(nk) && !set.has(nk); });
      if ((dx || dz) && !blocked) {
        const chs: Change[] = keys.map((key) => ({ key, prev: cells.get(key)!, next: null }));
        apply(chs, "next");
        const adds: Change[] = moved.map((c) => { const nk = k(c.x, c.y, c.z); return { key: nk, prev: null, next: c }; });
        apply(adds, "next");
        commit([...chs, ...adds]);
      } else {
        for (const key of keys) setCell(key, cells.get(key)!);
        if (blocked) o.onHint("Can't drop there — space is occupied");
      }
    }
    if (stroke) { commit(stroke); stroke = null; }
    if (pointers.size === 0) drag = null;
  }
  o.canvas.addEventListener("pointerdown", down);
  o.canvas.addEventListener("pointermove", move);
  o.canvas.addEventListener("pointerup", up);
  o.canvas.addEventListener("pointercancel", up);

  // ---- WebXR ----
  let hitSource: XRHitTestSource | null = null;
  let anchored = false;
  let xrSession: XRSession | null = null;
  let xrReferenceSpace: XRReferenceSpace | null = null;

  // Genuine WebXR articulated-hand state. This is only active inside an XR session
  // that actually exposes hand-tracking; MediaPipe remains a separate fallback.
  const xrHand = {
    seen: false,
    pinching: false,
    frozen: false,
    reacquireFrames: 0,
    lastLocal: null as THREE.Vector3 | null,
    grabOffset: null as THREE.Vector3 | null,
    grabKeys: [] as string[],
  };
  const XR_HAND_LOST_GRACE_MS = 140;
  let handSeenAt = 0;
  const TRACK_SAMPLE = 0.05;

  function snapLocal(p: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(
      Math.round(p.x / VOXEL),
      Math.round(p.y / VOXEL),
      Math.round(p.z / VOXEL),
    );
  }

  function extrudeCells(from: THREE.Vector3, to: THREE.Vector3) {
    const distance = from.distanceTo(to);
    const steps = Math.max(1, Math.ceil(distance / TRACK_SAMPLE));
    for (let i = 1; i <= steps; i++) {
      const p = from.clone().lerp(to, i / steps);
      const q = snapLocal(p);
      if (q.y < 0) continue;
      place([q.x, q.y, q.z]);
    }
  }

  function nearestBlock(local: THREE.Vector3, radius = VOXEL * 1.5): string | null {
    let best: string | null = null;
    let bestD = radius;
    for (const [key, c] of cells) {
      const p = new THREE.Vector3(c.x * VOXEL, c.y * VOXEL + VOXEL / 2, c.z * VOXEL);
      const d = p.distanceTo(local);
      if (d < bestD) { bestD = d; best = key; }
    }
    return best;
  }

  function xrHandFrame(frame: XRFrame): { local: THREE.Vector3; pinch: boolean } | null {
    if (!xrReferenceSpace || !xrSession) return null;
    for (const input of xrSession.inputSources) {
      const hand = (input as XRInputSource & { hand?: XRHand }).hand;
      if (!hand) continue;
      const thumb = hand.get("thumb-tip");
      const index = hand.get("index-finger-tip");
      if (!thumb || !index) continue;
      const thumbPose = (frame as XRFrame & { getJointPose?: (joint: XRJointSpace, base: XRSpace) => XRJointPose | undefined }).getJointPose?.(thumb, xrReferenceSpace);
      const indexPose = (frame as XRFrame & { getJointPose?: (joint: XRJointSpace, base: XRSpace) => XRJointPose | undefined }).getJointPose?.(index, xrReferenceSpace);
      if (!thumbPose?.transform?.position || !indexPose?.transform?.position) continue;
      const tp = thumbPose.transform.position;
      const ip = indexPose.transform.position;
      const pinchPoint = new THREE.Vector3((tp.x + ip.x) / 2, (tp.y + ip.y) / 2, (tp.z + ip.z) / 2);
      const distance = Math.hypot(tp.x - ip.x, tp.y - ip.y, tp.z - ip.z);
      const pinch = xrHand.pinching ? distance < 0.055 : distance < 0.035;
      return { local: root.worldToLocal(pinchPoint), pinch };
    }
    return null;
  }

  function updateXRHand(frame: XRFrame) {
    if (!xrSession || !xrReferenceSpace) return;
    const now = performance.now();
    const sample = xrHandFrame(frame);
    if (!sample) {
      xrHand.seen = false;
      if (xrHand.pinching && now - (handSeenAt || 0) > XR_HAND_LOST_GRACE_MS) {
        xrHand.frozen = true;
        o.onHint("HAND LOST — CONSTRUCTION FROZEN");
      }
      return;
    }

    const wasFrozen = xrHand.frozen;
    xrHand.seen = true;
    handSeenAt = now;
    if (wasFrozen) {
      xrHand.reacquireFrames++;
      xrHand.lastLocal = sample.local.clone();
      if (xrHand.reacquireFrames < 3) return;
      xrHand.frozen = false;
      xrHand.reacquireFrames = 0;
      o.onHint("Hand recovered — rebased");
      return;
    }

    const wasPinching = xrHand.pinching;
    xrHand.pinching = sample.pinch;

    if (sample.pinch && !wasPinching) {
      xrHand.grabOffset = null;
      xrHand.lastLocal = sample.local.clone();
      if (o.getMode() === "track") {
        const q = snapLocal(sample.local);
        if (q.y >= 0) coaster.addPoint(q.x, q.y, q.z);
        o.onHint("Pinch started — move your hand to extend the track");
      } else if (o.getMode() === "build") {
        stroke = [];
        const q = snapLocal(sample.local);
        if (q.y >= 0) place([q.x, q.y, q.z]);
        o.onHint("Pinch started — move your hand to build");
      } else if (o.getMode() === "move" || o.getMode() === "group") {
        const key = nearestBlock(sample.local);
        if (key) {
          const c = cells.get(key)!;
          const objectLocal = new THREE.Vector3(c.x * VOXEL, c.y * VOXEL + VOXEL / 2, c.z * VOXEL);
          xrHand.grabOffset = objectLocal.sub(sample.local);
          xrHand.grabKeys = o.getMode() === "group" ? connected(key) : [key];
          o.onHint("Grabbed — move your hand in 3D");
        }
      } else {
        const key = nearestBlock(sample.local);
        if (key) {
          const h: Hit = { add: null, block: key, floorPt: sample.local.clone() };
          applyTool(h);
        }
      }
    } else if (sample.pinch && wasPinching && !xrHand.frozen) {
      const previous = xrHand.lastLocal;
      xrHand.lastLocal = sample.local.clone();
      if (!previous) return;
      if (o.getMode() === "track") {
        const a = snapLocal(previous), b = snapLocal(sample.local);
        if (a.distanceTo(b) > 0) {
          const dist = previous.distanceTo(sample.local);
          const steps = Math.max(1, Math.ceil(dist / TRACK_SAMPLE));
          for (let i = 1; i <= steps; i++) {
            const p = previous.clone().lerp(sample.local, i / steps);
            const q = snapLocal(p);
            if (q.y >= 0) {
              const last = coaster.count() ? null : null;
              // addPoint itself is grid-space and rebuilds the metric track.
              const serialized = coaster.serialize();
              const lastPt = serialized.pts?.[serialized.pts.length - 1];
              if (!lastPt || Math.hypot(lastPt.x - q.x * VOXEL, lastPt.y - (q.y * VOXEL + VOXEL * 0.35), lastPt.z - q.z * VOXEL) > VOXEL * 0.45) {
                coaster.addPoint(q.x, q.y, q.z);
              }
            }
          }
        }
      } else if (o.getMode() === "build") {
        extrudeCells(previous, sample.local);
      } else if ((o.getMode() === "move" || o.getMode() === "group") && xrHand.grabKeys.length && xrHand.grabOffset) {
        const target = sample.local.clone().add(xrHand.grabOffset);
        const base = cells.get(xrHand.grabKeys[0]!);
        if (base) {
          const q = snapLocal(target);
          const dx = q.x - base.x, dy = q.y - base.y, dz = q.z - base.z;
          const set = new Set(xrHand.grabKeys);
          const moved = xrHand.grabKeys.map(key => {
            const c = cells.get(key)!;
            return { ...c, x:c.x+dx, y:Math.max(0,c.y+dy), z:c.z+dz };
          });
          const blocked = moved.some(c => { const nk=k(c.x,c.y,c.z); return cells.has(nk) && !set.has(nk); });
          if (!blocked) {
            for (const key of xrHand.grabKeys) {
              const c=cells.get(key)!; const m=meshes.get(key)!;
              m.position.set((c.x+dx)*VOXEL,(c.y+dy)*VOXEL+VOXEL/2,(c.z+dz)*VOXEL);
            }
          }
        }
      }
    } else if (!sample.pinch && wasPinching) {
      if (o.getMode() === "build" && stroke) {
        commit(stroke);
        stroke = null;
      } else if ((o.getMode() === "move" || o.getMode() === "group") && xrHand.grabKeys.length && xrHand.lastLocal && xrHand.grabOffset) {
        const base = cells.get(xrHand.grabKeys[0]!);
        if (base) {
          const target = xrHand.lastLocal.clone().add(xrHand.grabOffset);
          const q = snapLocal(target);
          const dx = q.x - base.x, dy = q.y - base.y, dz = q.z - base.z;
          const set = new Set(xrHand.grabKeys);
          const moved = xrHand.grabKeys.map(key => {
            const c = cells.get(key)!;
            return { ...c, x:c.x+dx, y:Math.max(0,c.y+dy), z:c.z+dz };
          });
          const blocked = moved.some(c => { const nk=k(c.x,c.y,c.z); return cells.has(nk) && !set.has(nk); });
          if ((dx || dy || dz) && !blocked) {
            const removes: Change[] = xrHand.grabKeys.map(key => ({ key, prev: cells.get(key)!, next: null }));
            const adds: Change[] = moved.map(c => ({ key:k(c.x,c.y,c.z), prev:null, next:c }));
            apply(removes, "next");
            apply(adds, "next");
            commit([...removes, ...adds]);
          }
        }
      }
      xrHand.pinching = false;
      xrHand.grabOffset = null;
      xrHand.grabKeys = [];
      xrHand.lastLocal = null;
      xrHand.frozen = false;
      xrHand.reacquireFrames = 0;
      o.onHint("Released — structure stays in place");
    }
  }
  async function startXR(overlay: HTMLElement) {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) throw new Error("WebXR not available");
    const session = await xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay", "anchors", "hand-tracking", "local-floor"],
      domOverlay: { root: overlay },
    } as XRSessionInit);
    xrSession = session;
    renderer.xr.setReferenceSpaceType("local");
    await renderer.xr.setSession(session);
    xrReferenceSpace = renderer.xr.getReferenceSpace() ?? await session.requestReferenceSpace("local");
    const viewer = await session.requestReferenceSpace("viewer");
    hitSource = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
    grid.visible = false; anchored = false;
    session.addEventListener("select", () => {
      if (!reticle.visible) return;
      if (!anchored) {
        const anchorPos = reticle.getWorldPosition(new THREE.Vector3());
        const anchorQuat = reticle.getWorldQuaternion(new THREE.Quaternion());
        root.position.copy(anchorPos);
        root.quaternion.copy(anchorQuat);
        reticle.position.set(0, 0, 0);
        reticle.quaternion.identity();
        anchored = true; grid.visible = true;
        o.onHint("START ANCHOR LOCKED — move your hand to build");
      }
      // center-screen ray: face adjacency first
      const h = hitFrom(new THREE.Vector2(0, 0));
      const mode = o.getMode();
      if (mode === "track" && h.add) coaster.addPoint(...h.add); else if (mode === "build" && h.add) place(h.add); else if (mode !== "build") applyTool(h);
    });
    session.addEventListener("end", () => {
      hitSource = null; xrSession = null; xrReferenceSpace = null;
      anchored = false;
      xrHand.seen = false; xrHand.pinching = false; xrHand.frozen = false; xrHand.lastLocal = null;
      root.position.set(0, 0, 0); root.quaternion.identity(); grid.visible = true; placeCam();
    });
  }

  // ---- loop ----
  const tmpM = new THREE.Matrix4();
  renderer.setAnimationLoop((_t, frame?: XRFrame) => {
    const mode = o.getMode();
    const now = performance.now();
    if (frame && xrSession) updateXRHand(frame); const dt = Math.min((now - lastT) / 1000, 0.05); lastT = now;
    coaster.step(dt);
    if (coaster.isRiding() && pov && !renderer.xr.isPresenting) {
      coaster.povPose(povPose);
      camera.position.lerp(povPose.pos, 0.5); camera.lookAt(povPose.look);
      reticle.visible = false; selBox.visible = false;
      renderer.render(scene, camera); return;
    }
    if (frame && hitSource && !anchored) {
      const res = frame.getHitTestResults(hitSource);
      const ref = renderer.xr.getReferenceSpace();
      if (res.length && ref) {
        const pose = res[0].getPose(ref);
        if (pose) {
          tmpM.fromArray(pose.transform.matrix);
          reticle.position.setFromMatrixPosition(tmpM);
          reticle.quaternion.setFromRotationMatrix(tmpM);
          reticle.visible = true;
        }
      } else reticle.visible = false;
    } else {
      const h = hitFrom(new THREE.Vector2(0, 0));
      if ((mode === "build" || mode === "track") && h.add) {
        reticle.visible = true;
        reticle.position.set(h.add[0] * VOXEL, h.add[1] * VOXEL + 0.002, h.add[2] * VOXEL);
      } else reticle.visible = false;
      if (h.block && mode !== "build" && mode !== "track") {
        selBox.visible = true; selBox.position.copy(meshes.get(h.block)!.position);
      } else selBox.visible = false;
    }
    renderer.render(scene, camera);
  });

  function resize() {
    const w = o.canvas.clientWidth, h = o.canvas.clientHeight;
    if (renderer.xr.isPresenting) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener("resize", resize);

  const fake = (x: number, y: number) => ({ pointerId: 999, clientX: x, clientY: y } as PointerEvent);
  return {
    resize,
    synth(type: "down" | "move" | "up", x: number, y: number) {
      if (type === "down") down(fake(x, y)); else if (type === "move") move(fake(x, y)); else up(fake(x, y));
    },
    setScale(sc: number) { root.scale.setScalar(sc); },
    addMany(list: Cell[]) {
      const chs: Change[] = [];
      for (const c of list) { const key = k(c.x, c.y, c.z); if (cells.has(key)) continue; chs.push({ key, prev: null, next: c }); }
      apply(chs, "next"); commit(chs);
    },
    startXR,
    coaster,
    setPOV(on: boolean) { pov = on; if (!on) { coaster.showFront(); placeCam(); } },
    undo() { const a = undo.pop(); if (a) { apply(a, "prev"); redo.push(a); emit(); } },
    redo() { const a = redo.pop(); if (a) { apply(a, "next"); undo.push(a); emit(); } },
    clear() { commit([...cells.keys()].map((key) => { const ch = { key, prev: cells.get(key)!, next: null }; setCell(key, null); return ch; })); },
    serialize: () => [...cells.values()],
    load(list: Cell[]) {
      const chs: Change[] = [...cells.keys()].map((key) => ({ key, prev: cells.get(key)!, next: null }));
      apply(chs, "next");
      const adds = list.map((c) => ({ key: k(c.x, c.y, c.z), prev: null, next: c }));
      apply(adds, "next"); commit([...chs, ...adds]);
    },
    view: () => orbit,
    isXR: () => !!xrSession,
    dispose() {
      renderer.setAnimationLoop(null);
      xrSession?.end().catch(() => {});
      window.removeEventListener("resize", resize);
      o.canvas.removeEventListener("pointerdown", down);
      o.canvas.removeEventListener("pointermove", move);
      o.canvas.removeEventListener("pointerup", up);
      o.canvas.removeEventListener("pointercancel", up);
      renderer.dispose();
    },
  };
}
export type Engine = ReturnType<typeof createEngine>;
