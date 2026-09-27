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
  async function startXR(overlay: HTMLElement) {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) throw new Error("WebXR not available");
    const session = await xr.requestSession("immersive-ar", { requiredFeatures: ["hit-test"], optionalFeatures: ["dom-overlay"], domOverlay: { root: overlay } } as XRSessionInit);
    xrSession = session;
    renderer.xr.setReferenceSpaceType("local");
    await renderer.xr.setSession(session);
    const viewer = await session.requestReferenceSpace("viewer");
    hitSource = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
    grid.visible = false; anchored = false;
    session.addEventListener("select", () => {
      if (!reticle.visible) return;
      if (!anchored) {
        root.position.copy(reticle.getWorldPosition(new THREE.Vector3()));
        reticle.position.set(0, 0, 0);
        anchored = true; grid.visible = true;
      }
      // center-screen ray: face adjacency first
      const h = hitFrom(new THREE.Vector2(0, 0));
      const mode = o.getMode();
      if (mode === "track" && h.add) coaster.addPoint(...h.add); else if (mode === "build" && h.add) place(h.add); else if (mode !== "build") applyTool(h);
    });
    session.addEventListener("end", () => { hitSource = null; xrSession = null; root.position.set(0, 0, 0); grid.visible = true; placeCam(); });
  }

  // ---- loop ----
  const tmpM = new THREE.Matrix4();
  renderer.setAnimationLoop((_t, frame?: XRFrame) => {
    const mode = o.getMode();
    const now = performance.now(); const dt = Math.min((now - lastT) / 1000, 0.05); lastT = now;
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
        if (pose) { tmpM.fromArray(pose.transform.matrix); reticle.position.setFromMatrixPosition(tmpM); reticle.visible = true; }
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
    setPOV(on: boolean) { pov = on; if (!on) placeCam(); },
    _cam: camera,
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
