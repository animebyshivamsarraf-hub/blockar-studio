import * as THREE from "three";
import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { HandSkeleton3D } from "./HandSkeleton3D";
import { PinchStateMachine, type PinchPhase } from "./PinchStateMachine";
import { liftLandmarks, syntheticHand, XR_TO_MP_JOINTS, type ScreenLandmark } from "./landmarkMapping";
import { GrabController3D } from "../interaction/GrabController3D";
import { FrameGate } from "./frameGate";
import { MAX_WORKER_RESTARTS, WORKER_INFERENCE_TIMEOUT_MS } from "./workerPolicy";
import type { FrameSource } from "../camera/CameraOwnership";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export type SystemState = "OFF" | "STARTING" | "INITIALIZING" | "TRACKING" | "ERROR";
export type Backend = "NONE" | "WEBXR" | "MEDIAPIPE" | "DEMO";
export type Side = "left" | "right";
export type TrackStatus = "not detected" | "tracking" | "lost" | "reacquiring";

export interface HandInfo { status: TrackStatus; pinch: PinchPhase; ratio: number; grabbing: boolean }
export interface HandDiagnostics {
  system: SystemState;
  backend: Backend;
  left: HandInfo;
  right: HandInfo;
  gesture: string;
  session: string;
  fps: number;
  error: string | null;
  labels: { side: Side; x: number; y: number; text: string }[];
}

/**
 * Strict rear-camera validation. Accept only a confirmed environment camera.
 * Never treats an unlabeled/unknown camera as rear.
 */
export async function isEnvironmentStream(s: MediaStream): Promise<boolean> {
  const t = s.getVideoTracks()[0];
  if (!t || t.readyState !== "live") return false;
  const settings = t.getSettings?.() ?? {};
  if (settings.facingMode) return settings.facingMode === "environment";
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const dev = devices.find((d) => d.kind === "videoinput" && d.deviceId === settings.deviceId);
    return !!dev?.label && /back|rear|environment/i.test(dev.label);
  } catch {
    return false;
  }
}

export function resolveCursorOwner(
  current: Side | null,
  hands: Record<Side, { pinch: { held: boolean }; status: TrackStatus }>,
  cubeOwner: Side | null,
): Side | null {
  if (current) {
    const o = hands[current];
    if (o.pinch.held && o.status !== "lost" && o.status !== "not detected") return current;
  }
  const cands = (["left", "right"] as Side[]).filter(
    (s) => hands[s].pinch.held && hands[s].status === "tracking" && cubeOwner !== s,
  );
  return cands.includes("right") ? "right" : cands[0] ?? null;
}

const LOST_GRACE_MS = 500;
const REACQUIRE_FRAMES = 3;
const CUBE_SIZE = 0.08;
// Phone AR must keep the camera/render loop responsive. MediaPipe's
// detectForVideo() is synchronous, so running it on every render frame can
// stall Chrome on mid-range phones. Hand tracking remains responsive at a
// bounded 15 FPS while the camera and 3D scene continue rendering normally.
const MP_INTERVAL_MS = 1000 / 15;
const MP_INTERVAL_CPU_MS = 1000 / 10;
const HAND_RENDER_INTERVAL_MS = 1000 / 30;
// FIX: Phone detection shared by field initializer and reset — phones start with CPU.
// SSR-safe: typeof navigator check so server-side import doesn't crash.
// Exported for unit testing.
export function isMobileUserAgent(ua: string): boolean {
  return /Android|iPhone|iPad|Mobile/i.test(ua);
}
const DEFAULT_DELEGATE: "GPU" | "CPU" = (typeof navigator !== "undefined" && isMobileUserAgent(navigator.userAgent)) ? "CPU" : "GPU";
const HAND_COLORS: Record<Side, number> = { left: 0x7fb8ff, right: 0x4de8ff };

interface HandState {
  side: Side;
  skeleton: HandSkeleton3D;
  ring: THREE.Mesh;
  pinch: PinchStateMachine;
  status: TrackStatus;
  lastSeen: number;
  reacquire: number;
  ratio: number;
  depth: number | null;
  pinchPoint: THREE.Vector3;
}

export class HandSystemRuntime {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private cube: THREE.Mesh;
  private cubeMat: THREE.MeshStandardMaterial;
  private hands: Record<Side, HandState>;
  private grab = new GrabController3D();
  private owner: Side | null = null;

  private system: SystemState = "OFF";
  private backend: Backend = "NONE";
  private session = "idle";
  private error: string | null = null;
  private gesture = "—";

  private stream: MediaStream | null = null;
  private landmarker: HandLandmarker | null = null;
  private handWorker: Worker | null = null;
  private workerReady = false;
  /** Strict one-frame-in-flight gate with generation tokens. */
  private gate = new FrameGate();
  private lastVideoTime = -1;
  private lastVideoAdvanceT = 0;
  private lastMpDetectT = 0;
  private mpIntervalMs = MP_INTERVAL_MS;
  private lastHandRenderT = 0;
  private workerRestarting = false;
  private workerRestartCount = 0;
  // FIX 3: Phones (Android/iPhone/Mobile) start with CPU — GPU delegate hangs on mobile.
  // Desktop keeps GPU for performance. Uses DEFAULT_DELEGATE so reset() stays consistent.
  private workerDelegate: "GPU" | "CPU" = DEFAULT_DELEGATE;
  private lastResultT = 0;
  private recoveryTimer: number | null = null;
  private static readonly MAX_WORKER_RESTARTS = MAX_WORKER_RESTARTS;
  private static readonly WORKER_INFERENCE_TIMEOUT_MS = WORKER_INFERENCE_TIMEOUT_MS;
  private static readonly BITMAP_TIMEOUT_MS = 1200;
  private static readonly RECOVERY_COOLDOWN_MS = 8000;
  private lastSentTimestamp = 0;
  private mpFrame: Partial<Record<Side, ScreenLandmark[]>> = {};
  private mpGeneration = 0;
  /** Which producer feeds hand frames: DOM video, XR raw camera, or nothing (paused). */
  private frameSource: FrameSource = "video";
  private srcW = 640;
  private srcH = 480;
  /** Fired when the DOM video stream stalls/ends so the host can reacquire the camera. */
  onCameraStalled: ((reason: string) => void) | null = null;
  private stallReported = false;
  private xrSession: XRSession | null = null;
  private externalStream = false;
  private xrStartT = 0;
  /** screen-space pinch cursor per hand (XR fallback path) */
  onPinchCursor: ((side: Side, x: number, y: number, held: boolean, point3D?: THREE.Vector3) => void) | null = null;
  /** Lifted MediaPipe pinch point, already in world space. */
  onPinchWorld: ((side: Side, world: THREE.Vector3, held: boolean) => void) | null = null;
  private cursorOwner: Side | null = null;
  /** Fired once when the active construction hand is lost beyond grace. */
  onOwnerLost: (() => void) | null = null;
  private mouse = { x: 0, y: 0, down: false, pinch: 0, inside: false };

  private fps = 0;
  private fpsFrames = 0;
  private fpsT = performance.now();
  private lastEmit = 0;
  private tmp = new THREE.Vector3();

  constructor(
    private canvas: HTMLCanvasElement,
    private video: HTMLVideoElement,
    private overlayRoot: HTMLElement,
    private onDiag: (d: HandDiagnostics) => void,
    private opts: { testCube?: boolean; camera?: THREE.PerspectiveCamera } = {},
  ) {
    const isPhone = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: !isPhone });
    // The hand layer is an overlay; on phones a 2x/3x backing buffer wastes
    // GPU time and competes with the camera + main BlockAR renderer.
    this.renderer.setPixelRatio(isPhone ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.xr.enabled = true;
    // BlockAR can provide its construction camera so MediaPipe lifting, hand
    // rendering, and the pinch-to-world transform all share one camera.
    this.camera = this.opts.camera ?? new THREE.PerspectiveCamera(60, 1, 0.01, 50);

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x334455, 1.4));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(0.5, 1, 0.8);
    this.scene.add(dir);

    this.cubeMat = new THREE.MeshStandardMaterial({ color: 0x2f8cff, roughness: 0.35, metalness: 0.1, emissive: 0x000000 });
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE), this.cubeMat);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial({ color: 0xbfeeff }));
    this.cube.add(edges);
    this.resetCube();
    // The grab-test cube only exists in the Hand Lab; the main builder never spawns it.
    this.cube.visible = this.opts.testCube !== false;
    if (this.cube.visible) this.scene.add(this.cube);

    const mk = (side: Side): HandState => {
      const skeleton = new HandSkeleton3D(HAND_COLORS[side]);
      this.scene.add(skeleton.group);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.018, 0.003, 10, 48),
        new THREE.MeshBasicMaterial({ color: 0x4de8ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      ring.visible = false;
      ring.renderOrder = 11;
      this.scene.add(ring);
      return { side, skeleton, ring, pinch: new PinchStateMachine(), status: "not detected", lastSeen: 0, reacquire: 0, ratio: 1, depth: null, pinchPoint: new THREE.Vector3() };
    };
    this.hands = { left: mk("left"), right: mk("right") };

    this.resize();
    window.addEventListener("resize", this.resize);
    canvas.addEventListener("pointermove", this.onPointer);
    canvas.addEventListener("pointerdown", this.onPointer);
    canvas.addEventListener("pointerup", this.onPointer);
    canvas.addEventListener("pointerleave", this.onPointer);
    this.renderer.setAnimationLoop(this.frame);
    this.emit(true);
  }

  // ---------- lifecycle ----------
  async start(mode: "auto" | "webxr" | "mediapipe" | "demo", opts: { stream?: MediaStream; frameSource?: FrameSource } = {}) {
    if (this.system === "STARTING" || this.system === "INITIALIZING") return;
    await this.stop();
    this.error = null;
    try {
      let chosen = mode;
      if (mode === "auto") chosen = (await HandSystemRuntime.webxrSupported()) ? "webxr" : "mediapipe";
      if (chosen === "webxr") await this.startWebXR();
      else if (chosen === "mediapipe") await this.startMediaPipe(opts.stream, opts.frameSource ?? "video");
      else this.startDemo();
      this.set("TRACKING");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error = msg;
      await this.teardown();
      this.set("ERROR");
    }
  }

  static async webxrSupported(): Promise<boolean> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    // Phones (Chrome Android, iOS) can open immersive-ar but never expose XRInputSource.hand —
    // only headsets do. So phones always use MediaPipe on the camera feed.
    const ua = navigator.userAgent;
    const headset = /OculusBrowser|Quest|Pico|Wolvic|VisionOS/i.test(ua);
    if (!headset && /Android|iPhone|iPad|Mobile/i.test(ua)) return false;
    try { return !!xr && (await xr.isSessionSupported("immersive-ar")); } catch { return false; }
  }

  private async startWebXR() {
    this.backend = "WEBXR"; this.set("STARTING"); this.session = "requesting immersive-ar";
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) throw new Error("WebXR not available in this browser");
    const session = await xr.requestSession("immersive-ar", {
      optionalFeatures: ["hand-tracking", "dom-overlay", "local-floor"],
      domOverlay: { root: this.overlayRoot },
    } as XRSessionInit);
    this.set("INITIALIZING"); this.session = "starting session";
    this.renderer.xr.setReferenceSpaceType("local");
    await this.renderer.xr.setSession(session);
    this.xrSession = session;
    session.addEventListener("end", () => { if (this.xrSession === session) void this.stop(); });
    // place the test cube 45cm in front of the viewer
    const xrCam = this.renderer.xr.getCamera();
    xrCam.getWorldPosition(this.tmp);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.getWorldQuaternion(new THREE.Quaternion()));
    this.cube.position.copy(this.tmp).addScaledVector(fwd, 0.45);
    this.session = "XR session active";
    this.xrStartT = performance.now();
  }

  private async startMediaPipe(external?: MediaStream, frameSource: FrameSource = "video") {
    this.backend = "MEDIAPIPE"; this.set("STARTING");
    this.frameSource = frameSource;
    if (frameSource !== "video") {
      // XR raw-camera (or paused) mode: the XR session owns the camera, so we
      // must not open a competing getUserMedia stream. Frames arrive via submitPixels().
      this.session = frameSource === "xr" ? "XR raw camera frames" : "paused (camera owned by AR)";
      this.set("INITIALIZING");
      const generation = ++this.mpGeneration;
      this.workerRestartCount = 0;
      this.mpIntervalMs = MP_INTERVAL_CPU_MS;
      await this.startMediaPipeWorker(generation);
      this.resetCube();
      return;
    }
    this.session = "requesting rear camera";
    let s: MediaStream;
    if (external && external.getVideoTracks().some((t) => t.readyState === "live")) {
      s = external; this.externalStream = true;
    } else try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera API not available (needs HTTPS)");
      // Rear camera only: do not silently switch to front/unspecified camera.
      try {
        s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: "environment" }, width: { ideal: 960, max: 960 }, height: { ideal: 540, max: 540 } }, audio: false });
      } catch {
        s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 960, max: 960 }, height: { ideal: 540, max: 540 } }, audio: false });
      }
    } catch (e: unknown) {
      const name = e instanceof Error ? e.name : "";
      throw new Error(name === "NotAllowedError" ? "Camera permission denied — allow camera access in browser settings" : name === "NotFoundError" ? "No camera found on this device" : `Camera failed: ${e instanceof Error ? e.message : e}`);
    }
    // Strict rear-camera check: never silently accept a front/unknown camera.
    if (!(await isEnvironmentStream(s))) {
      if (!this.externalStream) s.getTracks().forEach((t) => t.stop());
      throw new Error("Rear camera required — the opened camera is not the environment camera. BlockAR never uses the front camera.");
    }
    this.stream = s;
    // FIX: Don't reassign srcObject or restart playback if video already shows this stream.
    // On Android, re-setting the same stream can freeze the video element.
    if (this.video.srcObject !== s) {
      this.video.srcObject = s;
    }
    if (this.video.paused) {
      await this.video.play().catch(() => {});
    }
    this.session = "camera live";
    this.set("INITIALIZING");
    const isPhone = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    const generation = ++this.mpGeneration;
    this.workerRestartCount = 0;

    // Official MediaPipe web samples isolate vision inference in a Worker.
    // On phones this keeps WASM/GPU inference away from the camera + Three.js
    // main thread, which is the important difference from detectAsync alone.
    if (isPhone) {
      this.mpIntervalMs = MP_INTERVAL_CPU_MS;
      await this.startMediaPipeWorker(generation);
      this.resetCube();
      return;
    }

    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    const init = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      const opts = (delegate: "GPU" | "CPU") => ({
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: "LIVE_STREAM" as const,
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        resultCallback: (res: any) => {
          if (generation !== this.mpGeneration || !this.stream) return;
          this.consumeMediaPipeResult(res);
        },
      });
      try {
        this.mpIntervalMs = MP_INTERVAL_MS;
        return await HandLandmarker.createFromOptions(fileset, opts("GPU") as any);
      } catch {
        this.mpIntervalMs = MP_INTERVAL_CPU_MS;
        this.session = "camera live · CPU delegate · reduced rate";
        return await HandLandmarker.createFromOptions(fileset, opts("CPU") as any);
      }
    })();
    const timeout = new Promise<never>((_, r) => setTimeout(() => r(new Error("MediaPipe model load timed out (20s) — check network")), 20000));
    this.landmarker = await Promise.race([init, timeout]);
    this.resetCube();
  }

  private async startMediaPipeWorker(generation: number) {
    try { this.handWorker?.terminate(); } catch { /* ignore */ }
    const worker = new Worker(new URL("./hand-landmarker.worker.ts", import.meta.url), { type: "module" });
    this.handWorker = worker;
    this.workerReady = false;
    this.gate.reset();

    const ready = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("MediaPipe worker timed out (20s) — check network")), 20000);
      worker.onmessage = (event: MessageEvent) => {
        const data = event.data ?? {};
        // Ignore anything from a superseded worker or session generation.
        if (generation !== this.mpGeneration || worker !== this.handWorker) return;
        if (data.type === "READY") {
          window.clearTimeout(timer);
          this.workerReady = true;
          this.workerRestarting = false;
          this.workerDelegate = data.delegate === "CPU" ? "CPU" : "GPU";
          if (this.workerDelegate === "CPU") this.mpIntervalMs = MP_INTERVAL_CPU_MS;
          this.lastResultT = performance.now();
          this.session = `${this.sourceLabel()} · MediaPipe worker · ${this.workerDelegate}`;
          resolve();
          return;
        }
        if (data.type === "ERROR") { window.clearTimeout(timer); reject(new Error(data.error ?? "MediaPipe worker failed")); return; }
        // Frame replies: only the current token may clear the in-flight slot.
        const current = typeof data.frameId === "number" && this.gate.finish(data.frameId);
        if (data.type === "RESULT") {
          if (!current) return; // stale result from a timed-out frame
          this.lastResultT = performance.now();
          if (this.workerRestartCount && this.lastResultT - this.lastWorkerRestartT > 30000) this.workerRestartCount = 0;
          this.consumeMediaPipeResult(data.result);
        } else if (data.type === "RUNTIME_FALLBACK") {
          this.workerDelegate = "CPU";
          this.mpIntervalMs = MP_INTERVAL_CPU_MS;
          this.error = null;
          this.session = `${this.sourceLabel()} · MediaPipe worker · CPU fallback`;
        } else if (data.type === "DETECT_ERROR") {
          this.error = data.error ?? "MediaPipe worker detection failed";
        }
        // DROPPED: slot already freed above; nothing else to do.
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        window.clearTimeout(timer);
        if (generation !== this.mpGeneration || worker !== this.handWorker) return;
        if (this.workerReady) { this.restartWorker(`crash: ${event.message || "worker crashed"}`); return; }
        reject(new Error(event.message || "MediaPipe worker crashed"));
      };
    });

    worker.postMessage({ type: "INIT", delegate: this.workerDelegate });
    await ready;
  }

  private lastWorkerRestartT = 0;

  /** Bounded worker restart. Never blocks the render loop; never leaves a terminal state. */
  private restartWorker(reason: string) {
    if (this.backend !== "MEDIAPIPE" || this.workerRestarting) return;
    const old = this.handWorker;
    this.handWorker = null;
    this.workerReady = false;
    this.gate.reset();
    try { old?.terminate(); } catch { /* already stopped */ }

    if (this.workerRestartCount >= HandSystemRuntime.MAX_WORKER_RESTARTS) {
      // Limit reached: pause hand tracking, keep everything else alive, and
      // schedule a cooled-down recovery on the CPU delegate.
      this.error = `Hand tracking paused (${reason}). Retrying shortly — touch building remains active.`;
      this.session = "MediaPipe worker paused · cooling down";
      this.set("ERROR");
      this.scheduleRecovery();
      return;
    }
    this.workerRestartCount++;
    this.lastWorkerRestartT = performance.now();
    // Restore the last working backend; after any GPU trouble prefer CPU.
    if (/timeout|crash/i.test(reason) && this.workerRestartCount >= 2) this.workerDelegate = "CPU";
    this.workerRestarting = true;
    this.session = `RESTARTING · MediaPipe worker (${this.workerRestartCount}/${HandSystemRuntime.MAX_WORKER_RESTARTS}) · ${reason}`;
    this.error = null;
    const generation = this.mpGeneration;
    void this.startMediaPipeWorker(generation).then(() => {
      if (generation !== this.mpGeneration || this.backend !== "MEDIAPIPE") return;
      this.workerRestarting = false;
      this.session = `${this.sourceLabel()} · MediaPipe worker · recovered`;
      if (this.system !== "TRACKING") this.set("TRACKING");
    }).catch((e: unknown) => {
      if (generation !== this.mpGeneration || this.backend !== "MEDIAPIPE") return;
      this.workerRestarting = false;
      this.error = e instanceof Error ? e.message : String(e);
      this.restartWorker("init failed");
    });
  }

  private scheduleRecovery() {
    if (this.recoveryTimer != null) return;
    const generation = this.mpGeneration;
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null;
      if (generation !== this.mpGeneration || this.backend !== "MEDIAPIPE") return;
      this.workerRestartCount = 0;
      this.workerDelegate = "CPU";
      this.mpIntervalMs = MP_INTERVAL_CPU_MS;
      this.set("TRACKING");
      this.restartWorker("recovery");
    }, HandSystemRuntime.RECOVERY_COOLDOWN_MS);
  }

  private sourceLabel() {
    return this.frameSource === "xr" ? "XR raw camera" : this.frameSource === "video" ? "camera live" : "paused";
  }

  // ---------- frame ownership ----------
  /** Switch frame producer. Resets stale timestamps / in-flight frames. */
  setFrameSource(src: FrameSource, stream?: MediaStream | null) {
    if (stream !== undefined) this.rebindStream(stream);
    this.frameSource = src;
    this.gate.reset();
    this.lastVideoTime = -1;
    this.lastVideoAdvanceT = performance.now();
    this.lastMpDetectT = 0;
    this.stallReported = false;
    this.mpFrame = {};
    if (this.backend === "MEDIAPIPE") this.session = `${this.sourceLabel()} · MediaPipe worker · ${this.workerDelegate}`;
    this.emit(true);
  }
  getFrameSource(): FrameSource { return this.frameSource; }

  /** Attach a (new) DOM camera stream after XR ends or permissions change. */
  rebindStream(stream: MediaStream | null) {
    if (this.stream && this.stream !== stream && !this.externalStream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.externalStream = !!stream;
    if (stream) {
      if (this.video.srcObject !== stream) this.video.srcObject = stream;
      void this.video.play().catch(() => {});
    }
  }

  /** True when the hand pipeline is ready to accept another external frame. */
  wantsExternalFrame(now = performance.now()): boolean {
    return this.system === "TRACKING" && this.backend === "MEDIAPIPE" && this.frameSource === "xr"
      && !!this.handWorker && this.workerReady && !this.gate.busy() && now - this.lastMpDetectT >= this.mpIntervalMs;
  }

  /** Feed one RGBA frame from the XR raw camera. Buffer ownership transfers to the worker. */
  submitPixels(pixels: Uint8Array, width: number, height: number, now = performance.now()): boolean {
    if (!this.wantsExternalFrame(now)) return false;
    const id = this.gate.begin(now);
    if (id == null) return false;
    this.lastMpDetectT = now;
    this.srcW = width; this.srcH = height;
    this.gate.toWorker(id, now);
    try {
      const ts = Math.max(this.lastSentTimestamp + 1, Math.round(now));
      this.lastSentTimestamp = ts;
      const buf = pixels.buffer as ArrayBuffer;
      this.handWorker!.postMessage({ type: "FRAME", frameId: id, pixels: buf, width, height, timestampMs: ts }, [buf]);
      return true;
    } catch {
      this.gate.finish(id);
      return false;
    }
  }

  private startDemo() {
    this.backend = "DEMO"; this.session = "mouse demo (move = hand, hold click = pinch)";
    this.resetCube();
  }

  async stop() {
    await this.teardown();
    this.set("OFF");
  }

  private async teardown() {
    this.mpGeneration++;
    const s = this.xrSession; this.xrSession = null;
    if (s) { try { await s.end(); } catch { /* already ended */ } }
    const keepExternalVideo = this.externalStream;
    if (!keepExternalVideo) this.stream?.getTracks().forEach((t) => t.stop());
    this.externalStream = false;
    this.stream = null;
    if (!keepExternalVideo) this.video.srcObject = null;
    try { this.landmarker?.close(); } catch { /* ignore */ }
    this.landmarker = null;
    if (this.handWorker) {
      try { this.handWorker.postMessage({ type: "STOP" }); } catch { /* ignore */ }
      this.handWorker.terminate();
      this.handWorker = null;
    }
    if (this.recoveryTimer != null) { window.clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
    this.workerReady = false;
    this.gate.reset();
    this.workerRestarting = false;
    this.workerRestartCount = 0;
    this.workerDelegate = DEFAULT_DELEGATE;
    this.frameSource = "video";
    this.stallReported = false;
    this.mpFrame = {};
    this.lastVideoTime = -1;
    this.lastMpDetectT = 0;
    this.lastSentTimestamp = 0;
    this.mpIntervalMs = MP_INTERVAL_MS;
    this.lastHandRenderT = 0;
    this.backend = "NONE";
    this.session = "idle";
    if (this.grab.active) this.grab.releaseGrab();
    this.owner = null;
    for (const h of Object.values(this.hands)) {
      h.pinch.reset(); h.status = "not detected"; h.skeleton.update(null); h.ring.visible = false; h.depth = null;
    }
  }

  resetCube() {
    if (this.grab.active) this.grab.releaseGrab();
    this.owner = null;
    this.camera.updateMatrixWorld();
    this.cube.position.set(0.05, -0.03, -0.5);
    this.cube.rotation.set(0.4, 0.6, 0);
  }

  dispose() {
    void this.teardown();
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("resize", this.resize);
    this.canvas.removeEventListener("pointermove", this.onPointer);
    this.canvas.removeEventListener("pointerdown", this.onPointer);
    this.canvas.removeEventListener("pointerup", this.onPointer);
    this.canvas.removeEventListener("pointerleave", this.onPointer);
    Object.values(this.hands).forEach((h) => h.skeleton.dispose());
    this.renderer.dispose();
  }

  getSystem(): SystemState { return this.system; }
  getError(): string | null { return this.error; }

  private set(s: SystemState) { this.system = s; this.emit(true); }

  private resize = () => {
    const W = window.innerWidth, H = window.innerHeight;
    this.camera.aspect = W / H;
    this.camera.updateProjectionMatrix();
    if (!this.renderer.xr.isPresenting) this.renderer.setSize(W, H, false);
  };

  private onPointer = (e: PointerEvent) => {
    this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    if (e.type === "pointerdown") this.mouse.down = true;
    if (e.type === "pointerup") this.mouse.down = false;
    this.mouse.inside = e.type !== "pointerleave";
  };

  // ---------- per-frame pipeline ----------
  private frame = (_t: number, xrFrame?: XRFrame) => {
    const now = performance.now();
    this.fpsFrames++;
    if (now - this.fpsT >= 500) { this.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsT)); this.fpsFrames = 0; this.fpsT = now; }

    const samples: Partial<Record<Side, THREE.Vector3[]>> = {};
    if (this.system === "TRACKING") {
      this.checkWorkerWatchdog(now);
      this.checkVideoStall(now);
      if (this.backend === "WEBXR" && xrFrame) this.sampleXR(xrFrame, samples);
      else if (this.backend === "MEDIAPIPE") this.sampleMediaPipe(now, samples);
      else if (this.backend === "DEMO") this.sampleDemo(samples);
    }
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    for (const side of ["left", "right"] as Side[]) this.processHand(this.hands[side], samples[side] ?? null, now, cam);

    // Only one hand may feed construction. Same-frame pinch ties go to right.
    this.cursorOwner = resolveCursorOwner(this.cursorOwner, this.hands, this.owner);

    // cube hover feedback
    const near = (["left", "right"] as Side[]).some((s) => this.hands[s].status === "tracking" && this.isNearCube(this.hands[s], cam));
    this.cubeMat.emissive.setHex(this.owner ? 0x5a1040 : near ? 0x0c3550 : 0x000000);
    if (!this.owner) this.cube.rotation.y += 0.004;

    const shouldRender = this.renderer.xr.isPresenting || now - this.lastHandRenderT >= HAND_RENDER_INTERVAL_MS;
    if (shouldRender) {
      this.lastHandRenderT = now;
      this.renderer.render(this.scene, this.camera);
    }
    this.emit(false, cam);
  };

  private sampleXR(frame: XRFrame, out: Partial<Record<Side, THREE.Vector3[]>>) {
    const ref = this.renderer.xr.getReferenceSpace();
    const session = this.xrSession;
    if (!ref || !session || !frame.getJointPose) return;
    for (const src of Array.from(session.inputSources)) {
      if (!src.hand || (src.handedness !== "left" && src.handedness !== "right")) continue;
      const pts: THREE.Vector3[] = [];
      for (const name of XR_TO_MP_JOINTS) {
        const space = src.hand.get(name);
        const pose = space ? frame.getJointPose(space, ref) : undefined;
        if (!pose) { pts.length = 0; break; }
        const p = pose.transform.position;
        pts.push(new THREE.Vector3(p.x, p.y, p.z));
      }
      if (pts.length === 21) out[src.handedness] = pts;
    }
    const n = Array.from(session.inputSources).filter((s) => s.hand).length;
    this.session = n ? `XR session active · ${n} hand input(s)` : "XR session active · no native hands — switching to MediaPipe…";
    if (!n) this.session = "XR session active · LIMITED: no native 3D hand joints on this device";
  }

  private checkWorkerWatchdog(now: number) {
    if (this.backend !== "MEDIAPIPE" || !this.handWorker || this.workerRestarting) return;
    // A frame stuck in createImageBitmap is simply invalidated (its token dies);
    // a frame stuck inside the worker means inference hung → restart the worker.
    const expired = this.gate.expire(now, HandSystemRuntime.BITMAP_TIMEOUT_MS, HandSystemRuntime.WORKER_INFERENCE_TIMEOUT_MS);
    if (expired === "worker") this.restartWorker("inference timeout");
  }

  /** Detect a DOM camera stream that stopped producing frames (XR grabbed it, permission revoked, track ended). */
  private checkVideoStall(now: number) {
    if (this.backend !== "MEDIAPIPE" || this.frameSource !== "video" || this.stallReported) return;
    const track = this.stream?.getVideoTracks()[0];
    const ended = !track || track.readyState === "ended";
    const stalled = this.lastVideoAdvanceT > 0 && now - this.lastVideoAdvanceT > 2500;
    if (!ended && !stalled) return;
    if (!ended && this.video.paused) { void this.video.play().catch(() => {}); this.lastVideoAdvanceT = now; return; }
    this.stallReported = true;
    this.mpFrame = {};
    this.session = ended ? "camera stream ended · waiting for camera" : "camera stalled · waiting for frames";
    this.onCameraStalled?.(ended ? "ended" : "stalled");
  }

  private sampleMediaPipe(now: number, out: Partial<Record<Side, THREE.Vector3[]>>) {
    const lm = this.landmarker, v = this.video;
    if (this.frameSource === "video" && (lm || this.handWorker) && v.readyState >= 2) {
      const advanced = v.currentTime !== this.lastVideoTime;
      if (advanced) { this.lastVideoTime = v.currentTime; this.lastVideoAdvanceT = now; if (this.stallReported) { this.stallReported = false; } }
      // Don't depend exclusively on currentTime advancing (some devices report a
      // frozen clock); a slow refresh of a repeated frame is harmless.
      const due = now - this.lastMpDetectT >= (advanced ? this.mpIntervalMs : Math.max(this.mpIntervalMs, 400));
      if (due) {
        if (this.handWorker) {
          if (this.workerReady) this.submitVideoFrame(v, now);
        } else if (lm) {
          this.lastMpDetectT = now;
          this.srcW = v.videoWidth || 640; this.srcH = v.videoHeight || 480;
          try { (lm as any).detectAsync(v, now); } catch { /* transient detector error must never stop the loop */ }
        }
      }
    }

    const W = window.innerWidth, H = window.innerHeight;
    const sc = Math.max(W / this.srcW, H / this.srcH);
    const imgW = this.srcW * sc;
    for (const side of ["left", "right"] as Side[]) {
      const pts = this.mpFrame[side];
      if (!pts) continue;
      const h = this.hands[side];
      const lifted = liftLandmarks(pts, this.camera, W, H, h.depth, imgW);
      h.depth = lifted.depth;
      out[side] = lifted.points;
    }
  }

  /** One-in-flight video submission guarded by a generation token. */
  private submitVideoFrame(v: HTMLVideoElement, now: number) {
    const id = this.gate.begin(now);
    if (id == null) return;
    this.lastMpDetectT = now;
    const vw = v.videoWidth || 640, vh = v.videoHeight || 480;
    createImageBitmap(v, { resizeWidth: 480, resizeHeight: 270, resizeQuality: "low" }).then((bitmap) => {
      // Token dead (timed out, reset, source switched) → discard permanently.
      const worker = this.handWorker;
      if (!worker || !this.workerReady || this.frameSource !== "video" || !this.gate.toWorker(id, performance.now())) {
        try { bitmap.close(); } catch { /* ignore */ }
        return;
      }
      this.srcW = vw; this.srcH = vh;
      try {
        const ts = Math.max(this.lastSentTimestamp + 1, Math.round(now));
        this.lastSentTimestamp = ts;
        worker.postMessage({ type: "FRAME", frameId: id, bitmap, timestampMs: ts }, [bitmap]);
      } catch {
        try { bitmap.close(); } catch { /* ignore */ }
        this.gate.finish(id);
      }
    }).catch(() => { this.gate.finish(id); });
  }

  private consumeMediaPipeResult(res: any) {
    const W = window.innerWidth, H = window.innerHeight;
    const vw = this.srcW, vh = this.srcH;
    const sc = Math.max(W / vw, H / vh);
    const ox = (vw * sc - W) / 2, oy = (vh * sc - H) / 2;
    const mirrored = !this.isRearCamera();
    const next: Partial<Record<Side, ScreenLandmark[]>> = {};

    res?.landmarks?.forEach((hand: Array<{ x: number; y: number; z: number }>, i: number) => {
      const label = res?.handedness?.[i]?.[0]?.categoryName?.toLowerCase();
      let side: Side = label === "left" ? "left" : "right";
      if (!mirrored) side = side === "left" ? "right" : "left";
      if (next[side]) side = side === "left" ? "right" : "left";
      next[side] = hand.map((p) => ({
        x: (mirrored ? 1 - p.x : p.x) * vw * sc - ox,
        y: p.y * vh * sc - oy,
        z: p.z,
      }));
    });

    if (Object.keys(next).length) this.mpFrame = next;
    else this.mpFrame = {};
  }

  private isRearCamera(): boolean {
    if (this.frameSource === "xr") return true;
    const t = this.stream?.getVideoTracks()[0];
    const fm = t?.getSettings().facingMode;
    return fm ? fm === "environment" : false;
  }

  private sampleDemo(out: Partial<Record<Side, THREE.Vector3[]>>) {
    if (!this.mouse.inside) return;
    this.mouse.pinch += ((this.mouse.down ? 1 : 0) - this.mouse.pinch) * 0.35;
    const W = window.innerWidth, H = window.innerHeight;
    const pts = syntheticHand(this.mouse.x, this.mouse.y, 150, this.mouse.pinch);
    const h = this.hands.right;
    const lifted = liftLandmarks(pts, this.camera, W, H, h.depth, W);
    h.depth = lifted.depth;
    out.right = lifted.points;
  }

  private processHand(h: HandState, pts: THREE.Vector3[] | null, now: number, cam: THREE.Camera) {
    const owns = this.owner === h.side;
    if (!pts) {
      if (h.status === "tracking" || h.status === "reacquiring") {
        if (now - h.lastSeen > LOST_GRACE_MS) {
          h.status = "lost";
          h.skeleton.update(null);
          h.ring.visible = false;
          if (owns) { this.grab.freeze(); this.gesture = `${h.side} lost — cube frozen`; }
          else h.pinch.reset();
          if (this.cursorOwner === h.side) this.onOwnerLost?.();
        }
      }
      return;
    }

    h.lastSeen = now;
    h.skeleton.update(pts);
    h.pinchPoint.addVectors(h.skeleton.joint(4), h.skeleton.joint(8)).multiplyScalar(0.5);

    if (h.status === "lost" || h.status === "not detected") {
      h.status = h.status === "lost" ? "reacquiring" : "tracking";
      h.reacquire = 0;
    }
    if (h.status === "reacquiring") {
      if (++h.reacquire < REACQUIRE_FRAMES) return;
      h.status = "tracking";
      if (owns) { this.grab.rebase(h.pinchPoint); this.gesture = `${h.side} reacquired — resumed`; }
    }

    const palm = pts[0]!.distanceTo(pts[9]!) || 1e-3;
    h.ratio = pts[4]!.distanceTo(pts[8]!) / palm;
    const prev = h.pinch.phase;
    const phase = h.pinch.update(h.ratio);

    if (phase === "PINCHED" && prev === "PINCHING") {
      if (!this.owner && this.isNearCube(h, cam)) {
        this.grab.startGrab(h.pinchPoint, this.cube.position, ["cube"], h.side);
        this.owner = h.side;
        this.gesture = `${h.side} GRAB cube`;
      } else this.gesture = `${h.side} pinch (no target)`;
    }
    if (this.owner === h.side && h.pinch.held) {
      const p = this.grab.updatePosition(h.pinchPoint);
      if (p) this.cube.position.lerp(p, 0.7);
    }
    if (phase === "RELEASED") {
      if (this.owner === h.side) { this.grab.releaseGrab(); this.owner = null; this.gesture = `${h.side} released — cube dropped`; }
      else this.gesture = `${h.side} released`;
    }

    // pinch ring
    const showRing = phase === "PINCHING" || phase === "PINCHED" || phase === "RELEASING";
    h.ring.visible = showRing;
    if (showRing) {
      h.ring.position.copy(h.pinchPoint);
      cam.getWorldPosition(this.tmp);
      h.ring.lookAt(this.tmp);
      const grabbing = this.owner === h.side;
      (h.ring.material as THREE.MeshBasicMaterial).color.setHex(grabbing ? 0x4dff88 : phase === "PINCHING" ? 0x9ff6ff : 0x4dffd2);
      h.ring.scale.setScalar(phase === "PINCHING" ? 1.4 : grabbing ? 1.15 : 1);
    }
    h.skeleton.setColor(this.owner === h.side ? 0x7dffb0 : HAND_COLORS[h.side]);

    const active: Side | null = this.cursorOwner
      ?? (this.hands.right.status === "tracking" ? "right" : this.hands.left.status === "tracking" ? "left" : null);
    if (this.owner !== h.side && active === h.side) {
      this.onPinchWorld?.(h.side, h.pinchPoint.clone(), h.pinch.held);
      if (this.onPinchCursor) {
        const sp = h.pinchPoint.clone().project(cam);
        this.onPinchCursor(
          h.side,
          (sp.x + 1) / 2 * window.innerWidth,
          (1 - sp.y) / 2 * window.innerHeight,
          h.pinch.held,
          h.pinchPoint.clone(),
        );
      }
    }
  }

  private isNearCube(h: HandState, cam: THREE.Camera): boolean {
    if (this.opts.testCube === false) return false;
    const d = h.pinchPoint.distanceTo(this.cube.position);
    if (d < CUBE_SIZE * 0.9 + 0.03) return true;
    if (this.backend === "WEBXR") return false;
    // optical backends: depth is estimated, so also accept screen-space overlap
    const a = h.pinchPoint.clone().project(cam), b = this.cube.position.clone().project(cam);
    const W = window.innerWidth, H = window.innerHeight;
    const px = Math.hypot((a.x - b.x) * W / 2, (a.y - b.y) * H / 2);
    const camPos = new THREE.Vector3(); cam.getWorldPosition(camPos);
    const dist = camPos.distanceTo(this.cube.position);
    const radiusPx = (CUBE_SIZE / (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)))) * H;
    return px < radiusPx * 1.3 + 12;
  }

  private emit(force: boolean, cam: THREE.Camera = this.camera) {
    const now = performance.now();
    if (!force && now - this.lastEmit < 100) return;
    this.lastEmit = now;
    const info = (h: HandState): HandInfo => ({ status: h.status, pinch: h.pinch.phase, ratio: h.ratio, grabbing: this.owner === h.side });
    const labels: HandDiagnostics["labels"] = [];
    if (!this.renderer.xr.isPresenting) {
      for (const h of Object.values(this.hands)) {
        if (!h.ring.visible) continue;
        const p = h.pinchPoint.clone().project(cam);
        labels.push({ side: h.side, x: (p.x + 1) / 2 * window.innerWidth, y: (1 - p.y) / 2 * window.innerHeight, text: this.owner === h.side ? "PINCH - GRAB" : h.pinch.phase === "PINCHING" ? "PINCH…" : "PINCH" });
      }
    }
    this.onDiag({
      system: this.system, backend: this.backend, left: info(this.hands.left), right: info(this.hands.right),
      gesture: this.gesture, session: this.session, fps: this.fps, error: this.error, labels,
    });
  }
}
