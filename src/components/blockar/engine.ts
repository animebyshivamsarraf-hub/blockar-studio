// @ts-nocheck -- strict index checks are noisy for this imperative three.js engine
import * as THREE from "three";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";
import { GestureDetector } from "./hand/GestureDetector";
import { HandController3D } from "./hand/HandController3D";
import { GrabController3D } from "./interaction/GrabController3D";
import { deviceTelemetry } from "./device/CapabilityDetector";
import { createCoaster } from "./coaster";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

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
  onHandStatus?: (status: "tracking" | "pinching" | "grabbing" | "lost" | "frozen" | "reacquiring", details?: any) => void;
}

export function createEngine(o: EngineOpts) {
  const isPhone = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  // BlockAR renders a main 3D scene plus a separate hand-tracking overlay.
  // On phones, avoid a 2x/3x backing buffer and MSAA on both renderers;
  // otherwise GPU pressure can make the live AR camera visibly freeze.
  const renderer = new THREE.WebGLRenderer({ canvas: o.canvas, alpha: true, antialias: !isPhone });
  renderer.setPixelRatio(isPhone ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.xr.enabled = true;
  // WebXR hand visuals are a separate 3D layer from construction/selection.
  // Three.js uses the public WebXR Input Profiles generic-hand assets for the mesh profile.
  const handModelFactory = new XRHandModelFactory();
  const xrHandVisuals: THREE.Group[] = [];
  let pinchMarker: THREE.Mesh | null = null;

  function ensureXRHandVisuals() {
    if (xrHandVisuals.length) return;
    for (let i = 0; i < 2; i++) {
      const hand = renderer.xr.getHand(i);
      const model = handModelFactory.createHandModel(hand, "mesh");
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          material.transparent = true;
          material.opacity = 0.94;
          if ("roughness" in material) (material as THREE.MeshStandardMaterial).roughness = 0.48;
        }
      });
      hand.add(model);
      scene.add(hand);
      xrHandVisuals.push(hand);
    }
    const markerMaterial = new THREE.MeshBasicMaterial({
      color: 0x4dff88,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    pinchMarker = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), markerMaterial);
    pinchMarker.visible = false;
    scene.add(pinchMarker);
  }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 50);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1, 3, 2);
  scene.add(sun);

  // Optional real-world depth scan. WebXR depth is device/browser dependent;
  // these samples are a visual spatial guide, not a substitute for plane anchors.
  const depthCloudGeometry = new THREE.BufferGeometry();
  const depthCloudMaterial = new THREE.PointsMaterial({
    color: 0x35eaff, size: 0.012, transparent: true, opacity: 0.62,
    depthWrite: false, sizeAttenuation: true,
  });
  const depthCloud = new THREE.Points(depthCloudGeometry, depthCloudMaterial);
  depthCloud.visible = false;
  scene.add(depthCloud);
  let depthSupported = false;
  let lastDepthScan = 0;
  let latestRoomDepth = 0;
  let depthSampleCount = 0;
  function scanXRDepth(frame: XRFrame) {
    if (!xrSession || !xrReferenceSpace || !depthSupported) return;
    const now = performance.now();
    if (now - lastDepthScan < 180) return;
    lastDepthScan = now;
    try {
      const viewerPose = frame.getViewerPose(xrReferenceSpace);
      const view = viewerPose?.views?.[0];
      if (!view || typeof (frame as any).getDepthInformation !== "function") return;
      const info = (frame as any).getDepthInformation(view);
      if (!info || typeof info.getDepthInMeters !== "function") return;
      const points: number[] = [];
      const projection = view.projectionMatrix;
      const viewToWorld = new THREE.Matrix4().fromArray(view.transform.matrix);
      // Coarse depth point cloud (9x9) to keep mobile GPU/CPU cost low.
      for (let gy = 0; gy < 9; gy++) {
        for (let gx = 0; gx < 9; gx++) {
          const px = Math.min(info.width - 1, Math.max(0, Math.round((gx / 8) * (info.width - 1))));
          const py = Math.min(info.height - 1, Math.max(0, Math.round((gy / 8) * (info.height - 1))));
          const d = info.getDepthInMeters(px, py);
          if (!Number.isFinite(d) || d < 0.15 || d > 8) continue;
          const nx = (gx / 8) * 2 - 1;
          const ny = 1 - (gy / 8) * 2;
          const local = new THREE.Vector3(nx * d / projection[0]!, ny * d / projection[5]!, -d);
          local.applyMatrix4(viewToWorld);
          points.push(local.x, local.y, local.z);
        }
      }
      if (points.length >= 3) {
        depthCloudGeometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
        depthCloudGeometry.computeBoundingSphere();
        depthCloud.visible = true;
        depthSampleCount = points.length / 3;
        const center = info.getDepthInMeters(Math.floor(info.width / 2), Math.floor(info.height / 2));
        if (Number.isFinite(center) && center > 0) latestRoomDepth = center;
      }
    } catch {
      // Unsupported frame formats should never interrupt AR rendering/building.
    }
  }

  const root = new THREE.Group();
  scene.add(root);
  const grid = new THREE.GridHelper(4, 40, 0x3ee8ff, 0x2a6a80);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.35;
  // No fake room grid: the real camera/room stays visible. Placement uses the reticle.
  grid.visible = false;
  root.add(grid);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ visible: false }));
  root.add(floor);

  // Spatial depth ruler: during a pinch/grab, show a true 3D drop line from
  // the hand/pinch point down to the construction floor. The ruler is part of
  // the anchored world (never camera-relative), so its length is meaningful in
  // the same meter-scale coordinate system as the coaster.
  const spatialGuide = new THREE.Group();
  spatialGuide.visible = false;
  root.add(spatialGuide);
  const spatialLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x20e8ff, transparent: true, opacity: 0.95 }),
  );
  spatialGuide.add(spatialLine);

  const spatialTop = new THREE.Mesh(
    new THREE.SphereGeometry(0.012, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: 0.95 }),
  );
  spatialGuide.add(spatialTop);

  const spatialGround = new THREE.Mesh(
    new THREE.RingGeometry(0.018, 0.032, 32),
    new THREE.MeshBasicMaterial({ color: 0x20e8ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  );
  spatialGround.rotation.x = -Math.PI / 2;
  spatialGuide.add(spatialGround);

  const spatialTicks = new THREE.Group();
  spatialGuide.add(spatialTicks);
  const tickMaterial = new THREE.LineBasicMaterial({ color: 0x20e8ff, transparent: true, opacity: 0.8 });
  const tickLines: THREE.Line[] = [];
  for (let i = 0; i < 32; i++) {
    const tick = new THREE.Line(new THREE.BufferGeometry(), tickMaterial);
    tickLines.push(tick);
    spatialTicks.add(tick);
  }

  let spatialDistance = 0;
  function updateSpatialGuide(local: THREE.Vector3 | null, active: boolean) {
    if (!local || !active) {
      spatialGuide.visible = false;
      return;
    }
    const top = local.clone();
    const bottomY = 0.004;
    const height = Math.abs(top.y - bottomY);
    if (!Number.isFinite(height) || height < 0.015) {
      spatialGuide.visible = false;
      return;
    }
    const bottom = new THREE.Vector3(top.x, bottomY, top.z);
    const linePos = new Float32Array([
      top.x, top.y, top.z,
      bottom.x, bottom.y, bottom.z,
    ]);
    spatialLine.geometry.setAttribute("position", new THREE.Float32BufferAttribute(linePos, 3));
    spatialLine.geometry.computeBoundingSphere();
    spatialTop.position.copy(top);
    spatialGround.position.copy(bottom);

    const tickCount = Math.min(32, Math.max(1, Math.floor(height / 0.1)));
    for (let i = 0; i < tickLines.length; i++) {
      const tick = tickLines[i]!;
      if (i >= tickCount) {
        tick.visible = false;
        continue;
      }
      const y = bottomY + (i + 1) * 0.1;
      if (y >= top.y - 0.015) {
        tick.visible = false;
        continue;
      }
      const half = i % 5 === 4 ? 0.035 : 0.022;
      const p = new Float32Array([
        top.x - half, y, top.z,
        top.x + half, y, top.z,
      ]);
      tick.geometry.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
      tick.geometry.computeBoundingSphere();
      tick.visible = true;
    }
    spatialDistance = height;
    spatialGuide.visible = true;
  }

  function hideSpatialGuide() {
    spatialGuide.visible = false;
  }

  // reticle: glowing square
  const reticle = new THREE.Group();
  const sq = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(VOXEL, VOXEL).rotateX(-Math.PI / 2)),
    new THREE.LineBasicMaterial({ color: 0x4dff88 }),
  );
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(VOXEL, VOXEL).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: 0.25, depthWrite: false }));
  reticle.add(sq, fill);
  // The reticle reports a REAL-WORLD (scene) pose coming from WebXR hit-test.
  // It must never live inside the construction root, otherwise the root's own
  // transform gets applied twice when we anchor and the whole build drifts
  // with the phone. Keep it as a sibling of the construction root.
  scene.add(reticle);
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
    // Inside an AR session the real view matrix lives on the XR camera; using the
    // fallback orbit camera here is what made picks follow the screen, not the room.
    ray.setFromCamera(ndc, activeCamera() as THREE.PerspectiveCamera);
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
  type SpatialHit = {
    worldPosition: THREE.Vector3;
    surfaceNormal: THREE.Vector3;
    distance: number;
    confidence: number;
    surfaceType: "floor" | "wall" | "table" | "unknown";
    valid: boolean;
  };
  let surfaceHit: SpatialHit | null = null;
  // When we end an XR session on purpose (e.g. to free the camera for
  // MediaPipe hands) the real-world anchor pose of the construction root must
  // survive, otherwise every placed object jumps back to the origin.
  let preserveAnchorOnEnd = false;

  let xrSession: XRSession | null = null;
  let xrReferenceSpace: XRReferenceSpace | null = null;
  // Persistent WebXR world anchor. When the browser/device supports anchors,
  // this is the authoritative pose for the construction root. The root is
  // never re-created from the camera after placement.
  let xrAnchor: XRAnchor | null = null;
  let lastHitResult: XRHitTestResult | null = null;

  // Genuine WebXR articulated-hand state. This is only active inside an XR session
  // that actually exposes hand-tracking; MediaPipe remains a separate fallback.
  const gestureDetector = new GestureDetector();
  const grabController = new GrabController3D();
  let xrHandSeen = false;
  let xrHandFrozen = false;
  let xrHandTrackingEnabled = true;
  let xrReacquireFrames = 0;
  let xrLastLocal: THREE.Vector3 | null = null;
  const XR_HAND_LOST_GRACE_MS = 180;
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

  function nearestBlock(local: THREE.Vector3, radius = VOXEL * 1.8): string | null {
    let best: string | null = null;
    let bestD = radius;
    for (const [key, c] of cells) {
      const p = new THREE.Vector3(c.x * VOXEL, c.y * VOXEL + VOXEL / 2, c.z * VOXEL);
      const d = p.distanceTo(local);
      if (d < bestD) { bestD = d; best = key; }
    }
    return best;
  }

  function xrHandFrame(frame: XRFrame): { local: THREE.Vector3; pinch: boolean; pinchDist: number; thumbWorld: THREE.Vector3; indexWorld: THREE.Vector3 } | null {
    if (!xrReferenceSpace || !xrSession) return null;
    for (const input of xrSession.inputSources) {
      const hand = (input as XRInputSource & { hand?: XRHand }).hand;
      if (!hand) continue;
      const thumb = hand.get("thumb-tip") || (hand as any).get?.(4) || (hand as any)[4];
      const index = hand.get("index-finger-tip") || (hand as any).get?.(9) || (hand as any)[9];
      if (!thumb || !index) continue;
      const thumbPose = (frame as XRFrame & { getJointPose?: (joint: XRJointSpace, base: XRSpace) => XRJointPose | undefined }).getJointPose?.(thumb, xrReferenceSpace);
      const indexPose = (frame as XRFrame & { getJointPose?: (joint: XRJointSpace, base: XRSpace) => XRJointPose | undefined }).getJointPose?.(index, xrReferenceSpace);
      if (!thumbPose?.transform?.position || !indexPose?.transform?.position) continue;
      const tp = thumbPose.transform.position;
      const ip = indexPose.transform.position;
      const thumbWorld = new THREE.Vector3(tp.x, tp.y, tp.z);
      const indexWorld = new THREE.Vector3(ip.x, ip.y, ip.z);
      const pinchResult = gestureDetector.evaluatePinch(thumbWorld, indexWorld, performance.now());
      const local = root.worldToLocal(pinchResult.pinchPoint.clone());
      return {
        local,
        pinch: pinchResult.isPinching,
        pinchDist: pinchResult.pinchDistance,
        thumbWorld,
        indexWorld,
      };
    }
    return null;
  }

  // Shared world-space hand pipeline. `local` is ALWAYS expressed in the
  // construction root's coordinate system (the anchored real-world space),
  // never in screen space and never relative to the camera.
  //
  // A pinch stroke is a first-class interaction: in Track mode it feeds the
  // coaster's continuous stroke builder; in Build mode it extrudes blocks.
  // This is deliberately independent from the reticle so the user can pinch
  // wherever the tracked hand is visible and draw from that point.
  let handWasPinching = false;
  let activeHandStroke: "track" | "build" | null = null;

  function processHandSample(local: THREE.Vector3 | null, pinching: boolean) {
    const now = performance.now();

    if (!local) {
      xrHandSeen = false;
      hideSpatialGuide();

      if ((grabController.active || activeHandStroke) && now - (handSeenAt || 0) > XR_HAND_LOST_GRACE_MS) {
        xrHandFrozen = true;
        grabController.freeze();
        o.onHandStatus?.("frozen");
        o.onHint("HAND LOST — CONSTRUCTION FROZEN");
        deviceTelemetry.log("hand_lost", { time: now });
      } else if (!grabController.active) {
        o.onHandStatus?.("lost");
      }
      return;
    }

    const wasFrozen = xrHandFrozen;
    xrHandSeen = true;
    if (pinchMarker) {
      pinchMarker.position.copy(root.localToWorld(local.clone()));
      pinchMarker.visible = pinching;
    }
    // This is the spatial cue from the reference: while the user pinches/grabs,
    // drop a measured vertical guide to the anchored floor so the renderer has
    // an explicit depth relationship instead of relying on a 2D cursor.
    updateSpatialGuide(local, pinching || grabController.active || activeHandStroke !== null);
    handSeenAt = now;

    if (wasFrozen) {
      xrReacquireFrames++;
      xrLastLocal = local.clone();
      handWasPinching = pinching;
      if (xrReacquireFrames < 3) {
        o.onHandStatus?.("reacquiring");
        return;
      }
      xrHandFrozen = false;
      xrReacquireFrames = 0;
      if (grabController.active) grabController.rebase(local);
      if (activeHandStroke === "track") coaster.rebaseStroke(local, now);
      // Build strokes use the last local pinch point directly; resetting it here
      // prevents a hand-loss gap from being interpreted as a giant extrusion.
      xrLastLocal = local.clone();
      deviceTelemetry.log("hand_reacquired", { point: local.toArray(), stroke: activeHandStroke });
      o.onHint("Hand recovered — rebased");
      return;
    }

    const wasPinching = handWasPinching;
    const isPinching = pinching;
    handWasPinching = pinching;


    if (isPinching && !grabController.active) {
      o.onHandStatus?.("pinching");
    } else if (grabController.active) {
      o.onHandStatus?.("grabbing");
    } else if (!xrHandFrozen) {
      o.onHandStatus?.("tracking");
    }

    if (isPinching && !wasPinching) {
      deviceTelemetry.log("pinch_detected", { point: local.toArray() });
      xrLastLocal = local.clone();
      if (o.getMode() === "track") {
        const started = coaster.beginStroke(local, now, false);
        if (started) {
          activeHandStroke = "track";
          o.onHint("PINCH — move your hand to draw the track");
        } else {
          activeHandStroke = null;
          o.onHint("Pinch near the last track point to continue");
        }
      } else if (o.getMode() === "build") {
        stroke = [];
        activeHandStroke = "build";
        const q = snapLocal(local);
        if (q.y >= 0) place([q.x, q.y, q.z]);
        o.onHint("PINCH — move your hand to build");
      } else if (o.getMode() === "move" || o.getMode() === "group") {
        const key = nearestBlock(local);
        if (key) {
          const c = cells.get(key)!;
          const objectLocal = new THREE.Vector3(c.x * VOXEL, c.y * VOXEL + VOXEL / 2, c.z * VOXEL);
          const keys = o.getMode() === "group" ? connected(key) : [key];
          grabController.startGrab(local, objectLocal, keys);
          deviceTelemetry.log("grab_started", { keys, objectLocal: objectLocal.toArray() });
          o.onHandStatus?.("grabbing");
          o.onHint("Grabbed — move your hand in 3D");
        }
      } else {
        const key = nearestBlock(local);
        if (key) {
          const h: Hit = { add: null, block: key, floorPt: local.clone() };
          applyTool(h);
        }
      }
    } else if (isPinching && wasPinching && !xrHandFrozen) {
      const previous = xrLastLocal;
      xrLastLocal = local.clone();
      if (!previous) return;
      if (o.getMode() === "track" && activeHandStroke === "track") {
        // Continuous 3D stroke path. The coaster owns smoothing, sample spacing,
        // straight-run merging and impossible-jump rejection, so the visible
        // green "draw" follows the pinch without voxel snapping or teleporting.
        coaster.extendStroke(local, now);
      } else if (o.getMode() === "build") {
        extrudeCells(previous, local);
      } else if ((o.getMode() === "move" || o.getMode() === "group") && grabController.active) {
        const target = grabController.updatePosition(local);
        if (target) {
          const grabKeys = grabController.keys;
          const base = cells.get(grabKeys[0]!);
          if (base) {
            // During an active grab, keep the visual object at the exact hand
            // delta. Do NOT snap every frame: voxel snapping here caused
            // jitter, micro-teleports and made the hand feel disconnected.
            // Cell coordinates remain unchanged until release, when the final
            // position is snapped exactly once.
            const baseCenter = new THREE.Vector3(
              base.x * VOXEL,
              base.y * VOXEL + VOXEL / 2,
              base.z * VOXEL,
            );
            const delta = target.clone().sub(baseCenter);
            for (const key of grabKeys) {
              const c = cells.get(key)!;
              const m = meshes.get(key)!;
              m.position.set(
                c.x * VOXEL + delta.x,
                c.y * VOXEL + VOXEL / 2 + delta.y,
                c.z * VOXEL + delta.z,
              );
            }
          }
        }
      }
    } else if (!isPinching && wasPinching) {
      if (o.getMode() === "track" && activeHandStroke === "track") {
        coaster.endStroke();
        activeHandStroke = null;
      } else if (o.getMode() === "build" && stroke) {
        commit(stroke);
        stroke = null;
        activeHandStroke = null;
      } else if ((o.getMode() === "move" || o.getMode() === "group") && grabController.active && xrLastLocal) {
        const target = grabController.updatePosition(xrLastLocal);
        const { keys } = grabController.releaseGrab();
        deviceTelemetry.log("grab_released", { keys });
        if (keys.length && target) {
          const base = cells.get(keys[0]!);
          if (base) {
            // Snap only once, on release. This keeps the grid contract while
            // preserving smooth hand-following during the grab.
            const q = snapLocal(target);
            const dx = q.x - base.x, dy = q.y - base.y, dz = q.z - base.z;
            const set = new Set(keys);
            const moved = keys.map(key => {
              const c = cells.get(key)!;
              return { ...c, x: c.x + dx, y: Math.max(0, c.y + dy), z: c.z + dz };
            });
            const blocked = moved.some(c => { const nk = k(c.x, c.y, c.z); return cells.has(nk) && !set.has(nk); });
            if ((dx || dy || dz) && !blocked) {
              const removes: Change[] = keys.map(key => ({ key, prev: cells.get(key)!, next: null }));
              const adds: Change[] = moved.map(c => ({ key: k(c.x, c.y, c.z), prev: null, next: c }));
              apply(removes, "next");
              apply(adds, "next");
              commit([...removes, ...adds]);
            } else {
              // Restore the exact logical positions when release is blocked or
              // the final snapped delta is zero. setCell rebuilds the meshes
              // from canonical cell coordinates and removes any sub-voxel
              // preview offset from the active grab.
              for (const key of keys) {
                const c = cells.get(key);
                if (c) setCell(key, c);
              }
              if (blocked) o.onHint("Can't drop there — space is occupied");
            }
          }
        }
      }
      if (pinchMarker) pinchMarker.visible = false;
      hideSpatialGuide();
      xrLastLocal = null;
      xrHandFrozen = false;
      xrReacquireFrames = 0;
      o.onHint("Released — structure stays in place");
    }
  }

  // Native WebXR articulated hands (headsets): joints already arrive in the
  // XR reference space, so they are true world coordinates.
  function updateXRHand(frame: XRFrame) {
    if (!xrSession || !xrReferenceSpace || !xrHandTrackingEnabled) return;
    const sample = xrHandFrame(frame);
    processHandSample(sample ? sample.local : null, sample ? sample.pinch : false);
  }

  // Camera-based hands (MediaPipe on phones): the pinch arrives as a point on
  // the camera image. We cast that through the live AR camera into the scene
  // and use the real intersection with the anchored surface / existing blocks.
  // The result is a WORLD point in the construction root's space — never a
  // screen coordinate and never parented to the camera.
  const handRay = new THREE.Raycaster();
  function activeCamera(): THREE.Camera {
    if (renderer.xr.isPresenting) {
      const xrCam = renderer.xr.getCamera() as THREE.ArrayCamera;
      if (xrCam?.cameras?.length) return xrCam.cameras[0]!;
      return xrCam ?? camera;
    }
    return camera;
  }

  function worldFromScreen(nx: number, ny: number): THREE.Vector3 | null {
    const cam = activeCamera();
    handRay.setFromCamera(new THREE.Vector2(nx, ny), cam as THREE.PerspectiveCamera);
    const hits = handRay.intersectObjects([...meshes.values(), floor], false);
    if (hits.length) return hits[0]!.point.clone();
    // No surface under the ray: fall back to the anchored construction plane.
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0).applyMatrix4(root.matrixWorld);
    const p = new THREE.Vector3();
    if (handRay.ray.intersectPlane(plane, p)) return p;
    return null;
  }


  async function startXR(overlay: HTMLElement) {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) throw new Error("WebXR not available");
    const session = await xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay", "anchors", "hand-tracking", "local-floor", "depth-sensing"],
      depthSensing: {
        usagePreference: ["cpu-optimized", "gpu-optimized"],
        dataFormatPreference: ["luminance-alpha", "float32"],
      },
      domOverlay: { root: overlay },
    } as XRSessionInit);
    xrSession = session;
    depthSupported = Boolean((session as any).depthUsage);
    depthCloud.visible = false;
    depthSampleCount = 0;
    latestRoomDepth = 0;
    ensureXRHandVisuals();
    if (depthSupported) o.onHint("ROOM DEPTH SCAN AVAILABLE — move phone slowly to scan");
    else o.onHint("Room depth sensor unavailable — using AR surface tracking");
    // "local-floor" keeps y = 0 on the REAL floor. Plain "local" floats the
    // origin at wherever the phone happened to be when AR started.
    try { renderer.xr.setReferenceSpaceType("local-floor"); } catch { renderer.xr.setReferenceSpaceType("local"); }
    await renderer.xr.setSession(session);
    xrReferenceSpace = renderer.xr.getReferenceSpace()
      ?? await session.requestReferenceSpace("local-floor").catch(() => session.requestReferenceSpace("local"));
    const viewer = await session.requestReferenceSpace("viewer");
    hitSource = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
    grid.visible = false; anchored = false;
    session.addEventListener("select", async () => {
      if (!reticle.visible) return;
      if (!anchored) {
        // The reticle already carries the real surface pose in scene/world space.
        const anchorPos = reticle.getWorldPosition(new THREE.Vector3());
        const anchorQuat = reticle.getWorldQuaternion(new THREE.Quaternion());
        // Classify the detected surface from its normal so we know what we
        // anchored to (floor / table / wall) and keep the build upright on
        // horizontal surfaces instead of inheriting any yaw wobble.
        const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(anchorQuat);
        const horizontal = normal.y > 0.8;
        surfaceHit = {
          worldPosition: anchorPos.clone(),
          surfaceNormal: normal.clone(),
          distance: anchorPos.distanceTo(activeCamera().getWorldPosition(new THREE.Vector3())),
          confidence: horizontal ? 0.9 : 0.6,
          surfaceType: horizontal ? (anchorPos.y > 0.35 ? "table" : "floor") : (Math.abs(normal.y) < 0.3 ? "wall" : "unknown"),
          valid: true,
        };
        root.position.copy(anchorPos);
        if (horizontal) {
          // Keep only the heading; the construction stays level with the room.
          const e = new THREE.Euler().setFromQuaternion(anchorQuat, "YXZ");
          root.quaternion.setFromEuler(new THREE.Euler(0, e.y, 0, "YXZ"));
        } else {
          root.quaternion.copy(anchorQuat);
        }
        root.updateMatrixWorld(true);
        // Prefer a real XRAnchor when the AR implementation exposes it. The
        // anchor is tied to the hit-test pose, not to the viewer/camera, so
        // camera motion produces natural parallax while the coaster remains
        // fixed to the same physical location.
        xrAnchor = null;
        try {
          const candidate = lastHitResult as any;
          if (candidate?.createAnchor) xrAnchor = await candidate.createAnchor();
        } catch {
          // Hit-test + local-floor is still a stable fallback when anchors are
          // unavailable; never fake stability by moving the root with camera pose.
          xrAnchor = null;
        }
        reticle.visible = false;
        anchored = true; grid.visible = false;
        o.onHint(`${xrAnchor ? "WORLD ANCHOR LOCKED" : "WORLD SPACE LOCKED"} — ${surfaceHit.surfaceType.toUpperCase()}`);
      }
      // center-screen ray: face adjacency first
      const h = hitFrom(new THREE.Vector2(0, 0));
      const mode = o.getMode();
      if (mode === "track" && h.add) coaster.addPoint(...h.add); else if (mode === "build" && h.add) place(h.add); else if (mode !== "build") applyTool(h);
    });
    session.addEventListener("end", () => {
      try { xrAnchor?.delete?.(); } catch {}
      xrAnchor = null;
      lastHitResult = null;
      hitSource = null; xrSession = null; xrReferenceSpace = null; depthSupported = false; depthCloud.visible = false;
      xrHandSeen = false; xrHandFrozen = false; xrLastLocal = null; handWasPinching = false;
      if (pinchMarker) pinchMarker.visible = false;
      if (!preserveAnchorOnEnd) {
        anchored = false;
        root.position.set(0, 0, 0); root.quaternion.identity();
      }
      preserveAnchorOnEnd = false;
      grid.visible = false; placeCam();
    });

  }

  async function addGLBFromUrl(url: string) {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    const model = gltf.scene;
    model.traverse((obj: any) => {
      if (!obj.isMesh) return;
      obj.castShadow = false;
      obj.receiveShadow = false;
    });

    // Keep generated assets mobile-friendly and consistent with BlockAR's
    // 1 unit = 1 meter world scale. Normalize the largest dimension to 0.8 m.
    const before = new THREE.Box3().setFromObject(model);
    const size = before.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    model.scale.setScalar(Math.min(1, 0.8 / maxDim));

    root.add(model);
    model.updateMatrixWorld(true);

    // Place at the current AR reticle when available; otherwise use the
    // construction origin. Lift the model so its lowest point sits on the
    // placement surface.
    const target = new THREE.Vector3();
    if (reticle.visible) {
      reticle.getWorldPosition(target);
      root.worldToLocal(target);
    }
    const box = new THREE.Box3().setFromObject(model);
    model.position.y += target.y - box.min.y;
    model.position.x += target.x;
    model.position.z += target.z;
    model.userData.blockarRodinAsset = true;
    emit();
    return model;
  }

  // ---- loop ----
  const tmpM = new THREE.Matrix4();
  renderer.setAnimationLoop((_t, frame?: XRFrame) => {
    const mode = o.getMode();
    const now = performance.now();
    if (frame && xrSession) {
      updateXRHand(frame);
      scanXRDepth(frame);
    }
    const dt = Math.min((now - lastT) / 1000, 0.05); lastT = now;
    coaster.step(dt);
    if (coaster.isRiding() && pov && !renderer.xr.isPresenting) {
      coaster.povPose(povPose);
      camera.position.lerp(povPose.pos, 0.5); camera.lookAt(povPose.look);
      reticle.visible = false; selBox.visible = false;
      renderer.render(scene, camera); return;
    }
    if (frame && hitSource && !anchored) {
      const res = frame.getHitTestResults(hitSource);
      lastHitResult = res.length ? res[0] : null;
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
    } else if (frame && xrAnchor && xrReferenceSpace) {
      // Once placed, follow ONLY the persistent XR anchor pose. Never derive
      // the world root from the current viewer/camera pose.
      const anchorPose = frame.getPose(xrAnchor.anchorSpace, xrReferenceSpace);
      if (anchorPose) {
        tmpM.fromArray(anchorPose.transform.matrix);
        root.position.setFromMatrixPosition(tmpM);
        root.quaternion.setFromRotationMatrix(tmpM);
        root.updateMatrixWorld(true);
      }
      reticle.visible = false;
      selBox.visible = false;
    } else {
      const h = hitFrom(new THREE.Vector2(0, 0));
      if ((mode === "build" || mode === "track") && h.add) {
        reticle.visible = true;
        // The reticle lives in world space now, so convert the voxel cell
        // (construction-root coords) into the room's coordinate system.
        reticle.position.copy(root.localToWorld(
          new THREE.Vector3(h.add[0] * VOXEL, h.add[1] * VOXEL + 0.002, h.add[2] * VOXEL),
        ));
        reticle.quaternion.copy(root.getWorldQuaternion(new THREE.Quaternion()));
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
    // Hand tracking must use the same active XR camera when immersive AR is
    // presenting. Returning the fallback orbit camera here makes lifted
    // MediaPipe points appear in the wrong 3D location even though the 2D hand
    // skeleton looks correct over the rear-camera video.
    getCamera() { return activeCamera() as THREE.PerspectiveCamera; },
    synth(type: "down" | "move" | "up", x: number, y: number) {
      if (type === "down") down(fake(x, y)); else if (type === "move") move(fake(x, y)); else up(fake(x, y));
    },
    setScale(sc: number) { root.scale.setScalar(sc); },
    addGLBFromUrl,
    addMany(list: Cell[]) {
      const chs: Change[] = [];
      for (const c of list) { const key = k(c.x, c.y, c.z); if (cells.has(key)) continue; chs.push({ key, prev: null, next: c }); }
      apply(chs, "next"); commit(chs);
    },
    startXR,
    getRoomDepthStatus() {
      return { supported: depthSupported, nearestMeters: latestRoomDepth, sampleCount: depthSampleCount };
    },
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
    xrHandCount: () => (xrSession ? Array.from(xrSession.inputSources).filter((s) => !!s.hand).length : 0),
    async stopXR(preserveAnchor = true) {
      preserveAnchorOnEnd = preserveAnchor;
      try { await xrSession?.end(); } catch { /* already ended */ }
    },
    isAnchored: () => anchored,
    spatialHit: () => surfaceHit,
    // Last measured hand-to-floor distance in meters (construction space).
    spatialDistance: () => spatialDistance,
    // Screen-space fallback: used when no lifted world point is available.
    // If point3D is supplied, it is already WORLD SPACE and must never be
    // passed through camera.localToWorld() again.
    handSample(nx: number, ny: number, pinching: boolean, point3D?: THREE.Vector3) {
      if (!xrHandTrackingEnabled) return;
      if (xrSession && Array.from(xrSession.inputSources).some((s) => !!s.hand)) return;

      if (point3D) {
        processHandSample(root.worldToLocal(point3D.clone()), pinching);
        return;
      }

      const world = worldFromScreen(nx, ny);
      processHandSample(world ? root.worldToLocal(world) : null, pinching);
    },

    // World-space pinch point from the lifted MediaPipe hand skeleton.
    // Contract: input is already WORLD SPACE; convert to ConstructionRoot-local
    // exactly once and never re-project through the camera.
    handSamplePoint(world: THREE.Vector3 | null, pinching: boolean) {
      if (!xrHandTrackingEnabled) return;
      if (xrSession && Array.from(xrSession.inputSources).some((s) => !!s.hand)) return;
      processHandSample(world ? root.worldToLocal(world.clone()) : null, pinching);
    },
    handLost() {
      if (!xrHandTrackingEnabled) return;
      if (xrSession && Array.from(xrSession.inputSources).some((s) => !!s.hand)) return;
      processHandSample(null, false);
    },

    setHandTrackingEnabled(enabled: boolean) {
      xrHandTrackingEnabled = enabled;
      if (!enabled) {
        xrHandVisuals.forEach(h => { h.visible = false; });
        if (pinchMarker) pinchMarker.visible = false;
        o.onHandStatus?.("lost");
      }
    },
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