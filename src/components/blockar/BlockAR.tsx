import { detectDeviceCapabilities, deviceTelemetry, type CapabilityReport } from "./device/CapabilityDetector";
import { FALLBACK_LIMITATION } from "./hand/MediaPipeFallbackAdapter";
import { useEffect, useRef, useState } from "react";
import { Box, Camera, Check, Circle, Cylinder, Hand, Move, Paintbrush, Redo2, Save, FolderOpen, Trash2, Triangle, Undo2, Group, ScanLine, Pointer } from "lucide-react";
import { COLORS, createEngine, type Engine, type Mode, type Shape } from "./engine";
import { cn } from "@/lib/utils";
import { HandSystemRuntime } from "./hand/HandSystemRuntime";
import { aiBuild } from "@/lib/ai-build.functions";
import { Sparkles, Loader2, X, Spline, Play, Square, ArrowUp, ArrowDown, Repeat, Eye, Wand2 } from "lucide-react";

type Stage = "welcome" | "permission" | "scanning" | "build";
const SAVE_KEY = "blockar:world";

const SHAPES: { id: Shape; label: string; Icon: typeof Box }[] = [
  { id: "cube", label: "Cube", Icon: Box },
  { id: "sphere", label: "Sphere", Icon: Circle },
  { id: "cylinder", label: "Cylinder", Icon: Cylinder },
  { id: "pyramid", label: "Pyramid", Icon: Triangle },
];
const MODES: { id: Mode; label: string; Icon: typeof Box; hint: string }[] = [
  { id: "build", label: "Build", Icon: Box, hint: "Tap to place · drag to extrude a line or wall" },
  { id: "move", label: "Move", Icon: Move, hint: "Drag a block to move it · drag empty space to orbit" },
  { id: "delete", label: "Delete", Icon: Trash2, hint: "Tap or swipe across blocks to delete" },
  { id: "paint", label: "Paint", Icon: Paintbrush, hint: "Tap or swipe blocks to repaint with selected color" },
  { id: "group", label: "Group", Icon: Group, hint: "Drag a structure to move all connected blocks" },
  { id: "track", label: "Track", Icon: Spline, hint: "Tap spots to lay coaster track · tap on blocks for hills" },
];
const DEMO = [
  { x: -6, y: 0, z: 4 }, { x: -2, y: 0, z: 5 }, { x: 3, y: 2, z: 5 }, { x: 6, y: 7, z: 3 }, { x: 7, y: 8, z: -1 },
  { x: 4, y: 3, z: -5 }, { x: 0, y: 1, z: -6 }, { x: -3, y: 4, z: -4 }, { x: -2, y: 5, z: 0 }, { x: -6, y: 2, z: 1 },
];

function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("relative", className)}>
      <div className="absolute inset-0 rotate-45 rounded-lg bg-gradient-to-br from-brand-cyan via-brand-violet to-brand-pink opacity-90 blur-[1px]" />
      <Box className="relative h-full w-full p-[18%] text-foreground" strokeWidth={2.2} />
    </div>
  );
}

export function BlockAR() {
  const [stage, setStage] = useState<Stage>("welcome");
  const [camOk, setCamOk] = useState(false);
  const [camErr, setCamErr] = useState<string | null>(null);
  const [xrOk, setXrOk] = useState(false);
  const [mode, setMode] = useState<Mode>("build");
  const [shape, setShape] = useState<Shape>("cube");
  const [color, setColor] = useState<string>(COLORS[0]!);
  const [info, setInfo] = useState({ count: 0, canUndo: false, canRedo: false });
  const [hint, setHint] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [guide, setGuide] = useState(true);
  const [size, setSize] = useState<"S" | "M" | "L">("M");
  const [hand, setHand] = useState<"off" | "starting" | "initializing" | "on" | "error">("off");
  const [backendType, setBackendType] = useState<"WEBXR HANDS" | "MEDIAPIPE FALLBACK">("MEDIAPIPE FALLBACK");
  const [handError, setHandError] = useState<string | null>(null);
  const [handSeen, setHandSeen] = useState(false);
  const [pinch, setPinch] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [trackN, setTrackN] = useState(0);
  const [loop, setLoop] = useState(false);
  const [riding, setRiding] = useState(false);
  const [pov, setPov] = useState(true);
  const [speed, setSpeed] = useState(0);
  const [handStatus, setHandStatus] = useState<"tracking" | "pinching" | "grabbing" | "lost" | "frozen" | "reacquiring" | "error">("lost");
  const [capability, setCapability] = useState<CapabilityReport | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const lastStatusUpdate = useRef<number>(0);
  const pendingStatus = useRef<string | null>(null);

  // Debounced hand status updater (prevents UI flicker)
  const setDebouncedHandStatus = (status: "tracking" | "pinching" | "grabbing" | "lost" | "frozen" | "reacquiring") => {
    const now = performance.now();
    pendingStatus.current = status;
    if (now - lastStatusUpdate.current > 120 || status === "frozen" || status === "grabbing") {
      lastStatusUpdate.current = now;
      setHandStatus(status);
    } else {
      setTimeout(() => {
        if (pendingStatus.current === status) {
          lastStatusUpdate.current = performance.now();
          setHandStatus(status);
        }
      }, 120);
    }
  };
  const handCanvas = useRef<HTMLCanvasElement>(null);
  const stopHands = useRef<(() => void) | null>(null);
  const handRuntime = useRef<HandSystemRuntime | null>(null);
  const [handLabels, setHandLabels] = useState<{ side: string; x: number; y: number; text: string }[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sel = useRef({ mode, shape, color });
  sel.current = { mode, shape, color };

  useEffect(() => {
    detectDeviceCapabilities().then((cap) => {
      setCapability(cap);
      setXrOk(cap.immersiveArSupported);
    }).catch(() => setXrOk(false));
    return () => streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  useEffect(() => {
    if (stage !== "build" || !canvasRef.current) return;
    const e = createEngine({
      canvas: canvasRef.current,
      getMode: () => sel.current.mode,
      getShape: () => sel.current.shape,
      getColor: () => sel.current.color,
      onChange: setInfo,
      onHint: setHint,
      onHandStatus: (status) => setDebouncedHandStatus(status),
    });
    engine.current = e;
    return () => { e.dispose(); engine.current = null; };
  }, [stage]);

  useEffect(() => {
    if (stage === "build" && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [stage, camOk]);

  useEffect(() => { setHint(null); }, [mode]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 1800); return () => clearTimeout(t); }, [toast]);

  async function allowCamera(): Promise<MediaStream | null> {
    setCamErr(null);
    try {
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: "environment" } }, audio: false });
      } catch {
        try {
          s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        } catch {
          // BlockAR is rear-camera only. Never silently fall back to an arbitrary/front camera.
          throw new Error("Rear camera unavailable. BlockAR requires the environment camera.");
        }
      }
      streamRef.current = s;
      setCamOk(true);
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        await videoRef.current.play().catch(() => {});
      }
      deviceTelemetry.log("fallback_selected", { mode: "rear_camera_video" });
      setStage("scanning");
      setTimeout(() => setStage("build"), 1800);
      return s;
    } catch (err: any) {
      const errMsg = err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError"
        ? "Camera permission denied. Allow camera in browser settings."
        : "Rear camera unavailable. Please check device permissions.";
      setCamErr(errMsg);
      setToast(errMsg);
      throw new Error(errMsg);
    }
  }

  async function enterXR() {
    if (!engine.current || !overlayRef.current) return;
    const handsWereOn = hand === "on" && backendType === "MEDIAPIPE FALLBACK";
    try {
      // Try to start AR while the rear camera (and MediaPipe hand tracking) stay alive.
      await engine.current.startXR(overlayRef.current);
      setToast("AR on — choose a surface, then pinch to build");
    } catch {
      // Some browsers only grant AR when no other camera stream is open: release it once and retry.
      try {
        stopHands.current?.(); stopHands.current = null;
        streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; setCamOk(false);
        await engine.current.startXR(overlayRef.current);
        setToast("AR on — choose a surface, then pinch to build");
      } catch (err) { setToast((err as Error).message || "AR could not start"); }
    }
    // Keep hand control alive: native XR joints if exposed, otherwise re-attach the camera tracker.
    if (handsWereOn && !handRuntime.current) { setHand("off"); setTimeout(() => { void toggleHandsRef.current?.(); }, 300); }
  }
  const toggleHandsRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => { engine.current?.setScale(1); }, [size, stage]);
  useEffect(() => () => stopHands.current?.(), []);

  async function toggleHands() {
    if (hand === "starting" || hand === "initializing") return;

    if (hand === "on") {
      stopHands.current?.();
      stopHands.current = null;
      setHand("off");
      setHandSeen(false);
      setHandError(null);
      clearHandCanvas();
      if (engine.current?.isXR()) {
        engine.current.setHandTrackingEnabled(false);
      }
      setDebouncedHandStatus("lost");
      setToast("Hand tracking turned off");
      return;
    }

    setHand("starting");
    setHandError(null);
    const e0 = engine.current;

    // Primary: WebXR — only when the session really exposes native hand joints (headsets).
    if (e0?.isXR() && e0.xrHandCount() > 0) {
      setBackendType("WEBXR HANDS");
      setHand("initializing");
      e0.setHandTrackingEnabled(true);
      setHand("on");
      setGuide(false);
      setToast("Backend: WEBXR HANDS active · pinch to build");
      return;
    }

    // Phones: WebXR AR exposes no hand joints, so MediaPipe reads the camera.
    // We keep the AR session (and therefore the real-world anchor) alive if the
    // camera can be shared; only if the OS refuses do we leave AR, and even
    // then the anchored construction root keeps its real-world pose.
    setBackendType("MEDIAPIPE FALLBACK");
    try {
      let activeStream = streamRef.current;
      const streamLive = !!activeStream && camOk && activeStream.getVideoTracks().some((t) => t.readyState === "live");
      if (!streamLive) {
        setToast("Requesting camera for hand tracking…");
        try {
          activeStream = await allowCamera();
        } catch {
          if (e0?.isXR()) {
            // The XR session holds the camera exclusively — release it but keep the anchor.
            await e0.stopXR(true);
            activeStream = await allowCamera();
          } else throw new Error("Camera could not be activated");
        }
      }
      if (!activeStream) throw new Error("Camera could not be activated");
      if (!handCanvas.current) throw new Error("Hand layer not mounted");

      setHand("initializing");
      const hv = document.createElement("video");
      hv.muted = true; hv.playsInline = true;
      let anyHand = false;
      const rt = new HandSystemRuntime(handCanvas.current, hv, overlayRef.current ?? document.body, (d) => {
        const l = d.left.status === "tracking" || d.right.status === "tracking";
        anyHand = l;
        setHandSeen(l);
        const grabbing = d.left.grabbing || d.right.grabbing;
        const pinching = [d.left, d.right].some((h) => h.pinch === "PINCHED" || h.pinch === "PINCHING");
        setDebouncedHandStatus(grabbing ? "grabbing" : pinching ? "pinching" : l ? "tracking" : "lost");
        setHandLabels(d.labels);
        // Hand gone → freeze the world construction instead of teleporting it.
        if (!l) { engine.current?.handLost(); setPinch(false); }
        if (d.system === "ERROR" && d.error) { setHand("error"); setHandError(d.error); }
      }, { testCube: false });
      // Feed the tracked pinch into the WORLD-space construction pipeline.
      // x/y are only used to cast a ray through the live AR camera; the object
      // position itself is computed in the anchored world coordinate system.
      rt.onPinchCursor = (_side, x, y, held) => {
        const e = engine.current; if (!e || !anyHand) return;
        const nx = (x / window.innerWidth) * 2 - 1;
        const ny = -(y / window.innerHeight) * 2 + 1;
        e.handSample(nx, ny, held);
        setPinch(held);
      };
      handRuntime.current = rt;
      stopHands.current = () => { rt.dispose(); handRuntime.current = null; setHandLabels([]); engine.current?.handLost(); };
      await rt.start("mediapipe", { stream: activeStream });
      if (rt.getSystem() !== "TRACKING") throw new Error(rt.getError() || "Hand tracking failed to start");
      setHand("on");
      setGuide(false);
      setToast(engine.current?.isXR()
        ? "Hand Control on · room tracking still active"
        : "Hand Control on · show your hand to the camera");

    } catch (err: any) {
      stopHands.current?.(); stopHands.current = null;
      const reason = err?.message || "Hand tracking initialization failed";
      setHand("error");
      setHandError(reason);
      setDebouncedHandStatus("lost");
      setToast(`Error: ${reason}`);
    }
  }
  toggleHandsRef.current = toggleHands;
  function clearHandCanvas() { /* 3D hand layer clears itself on stop */ }

  async function runAI() {
    if (!aiText.trim() || aiBusy) return;
    setAiBusy(true);
    try {
      const blocks = await aiBuild({ data: { prompt: aiText.trim() } });
      if (!blocks.length) setToast("AI couldn't design that — try other words");
      else { engine.current?.addMany(blocks); setToast(`Built ${blocks.length} blocks`); setAiOpen(false); setAiText(""); }
    } catch (err) { setToast((err as Error).message || "AI build failed"); }
    setAiBusy(false);
  }

  const co = () => engine.current?.coaster;
  const syncTrack = () => setTrackN(co()?.count() ?? 0);
  useEffect(() => {
    if (!riding) return;
    const id = setInterval(() => setSpeed(co()?.speedKmh() ?? 0), 200);
    return () => clearInterval(id);
  }, [riding]);
  useEffect(() => {
    if (stage !== "build" || !canvasRef.current) return;
    const c = canvasRef.current; const f = () => setTimeout(syncTrack, 0);
    c.addEventListener("pointerup", f); return () => c.removeEventListener("pointerup", f);
  }, [stage]);
  useEffect(() => { co()?.setLoop(loop); }, [loop, stage]);
  function ride() {
    const c = co(); if (!c) return;
    if (riding) { c.stop(); engine.current?.setPOV(false); setRiding(false); return; }
    if (!c.start()) return setToast("Lay at least 2 track points first");
    engine.current?.setPOV(pov); setRiding(true); setGuide(false);
  }
  function togglePov() { const n = !pov; setPov(n); if (riding) { engine.current?.setPOV(n); } }

  const save = () => { localStorage.setItem(SAVE_KEY, JSON.stringify({ blocks: engine.current?.serialize() ?? [], track: co()?.serialize() })); setToast("World saved"); };
  const load = () => {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return setToast("No saved world yet");
    const d = JSON.parse(raw);
    engine.current?.load(Array.isArray(d) ? d : d.blocks ?? []);
    if (!Array.isArray(d) && d.track) { co()?.load(d.track); setLoop(!!d.track.loop); }
    syncTrack(); setToast("World loaded");
  };

  const activeMode = MODES.find((m) => m.id === mode)!;

  if (stage === "welcome" || stage === "permission") {
    return (
      <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-background px-6 text-center">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_30%,var(--glow),transparent_60%)]" />
        {stage === "welcome" ? (
          <div className="relative flex max-w-sm flex-col items-center">
            <Logo className="h-24 w-24" />
            <h1 className="mt-6 font-display text-5xl font-bold tracking-tight">Block<span className="text-brand-cyan">AR</span></h1>
            <p className="mt-1 text-lg text-muted-foreground">3D Builder</p>
            <p className="mt-6 text-foreground/80">Build anything in your real world — 10 cm voxels that snap together like bricks.</p>
            <button onClick={() => setStage("permission")} className="mt-10 w-full rounded-2xl bg-primary py-4 font-display text-lg font-semibold text-primary-foreground shadow-[0_0_30px_var(--glow)] active:scale-[.98]">Get Started</button>
            <p className="mt-6 text-xs tracking-widest text-muted-foreground">AR · TOUCH BUILD · VOXELS</p>
          </div>
        ) : (
          <div className="relative w-full max-w-sm rounded-3xl border border-border bg-card/80 p-6 text-left backdrop-blur">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/20 text-primary"><Camera /></div>
            <h2 className="mt-4 text-center font-display text-xl font-semibold">Camera permission</h2>
            <p className="mt-2 text-center text-sm text-muted-foreground">BlockAR uses your rear camera to place blocks in your room.</p>
            <ul className="mt-5 space-y-3 text-sm">
              {["Back camera (environment)", xrOk ? "WebXR AR supported on this device" : "Rear-camera preview mode (room-locked AR requires WebXR)", "Touch building — tap & drag"].map((t) => (
                <li key={t} className="flex items-center gap-3"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-success text-background"><Check className="h-3 w-3" /></span>{t}</li>
              ))}
            </ul>
            {xrOk ? (
              <>
                <button onClick={() => { setStage("build"); setTimeout(() => { void enterXR(); }, 400); }} className="mt-6 w-full rounded-2xl bg-primary py-3.5 font-semibold text-primary-foreground">Start Room AR</button>
                <button onClick={allowCamera} className="mt-2 w-full rounded-2xl border border-border py-3 text-sm font-medium">Camera preview only</button>
              </>
            ) : (
              <button onClick={allowCamera} className="mt-6 w-full rounded-2xl bg-primary py-3.5 font-semibold text-primary-foreground">Allow Camera</button>
            )}
            <button onClick={() => { setStage("scanning"); setTimeout(() => setStage("build"), 1200); }} className="mt-2 w-full py-2 text-sm text-muted-foreground">Continue without camera</button>
          </div>
        )}
      </main>
    );
  }

  return (
    <main ref={overlayRef} className="fixed inset-0 overflow-hidden bg-background text-foreground select-none">
      {camOk && <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />}
      {!camOk && <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_70%,var(--glow),transparent_65%)]" />}
      {stage === "build" && <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />}
      <canvas ref={handCanvas} className="pointer-events-none absolute inset-0 h-full w-full" />
      {handLabels.map((l) => (
        <div key={l.side} className="pointer-events-none absolute -translate-x-1/2 rounded-full border border-success/60 bg-background/60 px-2 py-0.5 text-[10px] font-bold tracking-wider text-success" style={{ left: l.x, top: l.y - 38 }}>{l.text}</div>
      ))}

      {stage === "scanning" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-background/40">
          <div className="rounded-full border border-border bg-card/70 px-4 py-2 text-sm backdrop-blur">Scanning for surface…</div>
          <div className="relative h-40 w-40"><div className="absolute inset-0 animate-ping rounded-full border-2 border-brand-cyan/60" /><ScanLine className="absolute inset-0 m-auto h-12 w-12 text-brand-cyan" /></div>
          {camErr && <p className="max-w-xs text-center text-sm text-muted-foreground">{camErr}</p>}
        </div>
      )}

      {stage === "build" && (
        <div className="pointer-events-none absolute inset-0 flex flex-col p-3 pt-[max(env(safe-area-inset-top),12px)] pb-[max(env(safe-area-inset-bottom),12px)]">
          {/* top */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2"><Logo className="h-9 w-9" /><div><div className="font-display text-xl font-bold leading-none">Block<span className="text-brand-cyan">AR</span></div><div className="text-[11px] text-muted-foreground">{info.count} blocks</div></div></div>
              {guide && (
                <button onClick={() => setGuide(false)} className="pointer-events-auto hud max-w-[210px] p-3 text-left">
                  <div className="flex items-center gap-2 font-display text-sm font-semibold"><Pointer className="h-4 w-4 text-brand-cyan" />How to play</div>
                  <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-xs text-foreground/80">
                    <li>Aim the green marker</li><li>Tap to place a block</li><li>Drag to build lines & walls</li><li>Pinch/drag or touch to build</li>
                  </ol>
                  <div className="mt-1 text-[10px] text-muted-foreground">tap to hide</div>
                </button>
              )}
              {/* Hand Status & HUD */}
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={toggleHands}
                  disabled={hand === "starting" || hand === "initializing"}
                  className={cn(
                    "hud pointer-events-auto flex w-[116px] flex-col items-start gap-1 p-2 text-[10px] select-none transition-all active:scale-95 border",
                    hand === "on" ? "border-brand-cyan bg-card/95 shadow-md" : hand === "error" ? "border-destructive bg-destructive/10" : "border-border/60 hover:border-brand-cyan/50",
                    (hand === "starting" || hand === "initializing") && "cursor-wait opacity-70"
                  )}
                >
                  <div className="flex w-full items-center justify-between gap-1 font-semibold uppercase tracking-wider">
                    <div className="flex items-center gap-1.5">
                      <Hand className={cn("h-3.5 w-3.5", hand === "on" ? "text-brand-cyan" : "text-muted-foreground")} />
                      <span>{hand === "off" ? "Hand: OFF" : hand === "starting" ? "Hand: STARTING" : hand === "initializing" ? "Hand: INIT" : hand === "error" ? "Hand: ERROR" : `Hand: ${handStatus.toUpperCase()}`}</span>
                    </div>
                    <span className={cn("h-2 w-2 rounded-full", {
                      "bg-success animate-pulse": hand === "on" && handStatus === "tracking",
                      "bg-brand-cyan animate-ping": hand === "on" && handStatus === "pinching",
                      "bg-brand-pink": hand === "on" && handStatus === "grabbing",
                      "bg-amber-400": hand === "on" && handStatus === "frozen",
                      "bg-yellow-400 animate-spin": hand === "on" && handStatus === "reacquiring",
                      "bg-destructive": hand === "error",
                      "bg-muted-foreground": hand === "off" || handStatus === "lost",
                    })} />
                  </div>
                  <div className="flex flex-col text-[8.5px] leading-tight text-muted-foreground">
                    <span className="font-semibold text-foreground/90">
                      {backendType}
                    </span>
                    <span>
                      {hand === "off" ? "Tap to enable" : hand === "error" ? (handError?.slice(0, 24) || "Failed") : hand === "on" ? (handSeen ? "Hand detected" : "Looking for hand…") : "Please wait…"}
                    </span>
                  </div>
                </button>
                <a href="/hand-lab" className="hud pointer-events-auto px-1.5 py-0.5 text-center text-[9px] font-semibold text-brand-cyan">Open Hand Lab</a>
                <button onClick={() => setDebugOpen(!debugOpen)} className="hud pointer-events-auto px-1.5 py-0.5 text-[9px] text-muted-foreground hover:text-foreground">
                  {debugOpen ? "Hide Dev Logs" : "Dev Test Logs"}
                </button>
              </div>
              <div className="hud pointer-events-auto flex w-[76px] flex-col items-center gap-1 p-1.5 text-[10px]">
                <span className="text-muted-foreground">Block size</span>
                <div className="flex gap-1">
                  {(["S", "M", "L"] as const).map((z) => (
                    <button key={z} onClick={() => setSize(z)} className={cn("h-6 w-6 rounded-md text-xs font-semibold", size === z ? "bg-primary text-primary-foreground" : "bg-muted")}>{z}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="hud flex items-center gap-2 px-3 py-2 text-xs">
                <Camera className="h-4 w-4" />
                <span>{camOk ? "Back camera" : "Camera off"}</span>
                <span className={cn("h-2 w-2 rounded-full", camOk ? "bg-success" : "bg-muted-foreground")} />
              </div>
              {xrOk && !engine.current?.isXR() && (
                <button onClick={enterXR} className="pointer-events-auto rounded-xl bg-success px-3 py-2 text-xs font-semibold text-background">Start WebXR AR</button>
              )}
              <div className="hud pointer-events-auto flex flex-col p-1">
                {[
                  { l: "Save", I: Save, f: save, c: "text-brand-cyan", ok: true },
                  { l: "Load", I: FolderOpen, f: load, c: "text-brand-violet", ok: true },
                  { l: "Undo", I: Undo2, f: () => engine.current?.undo(), c: "text-brand-orange", ok: info.canUndo },
                  { l: "Redo", I: Redo2, f: () => engine.current?.redo(), c: "text-success", ok: info.canRedo },
                ].map(({ l, I, f, c, ok }) => (
                  <button key={l} onClick={f} disabled={!ok} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs disabled:opacity-35 active:bg-accent"><I className={cn("h-4 w-4", c)} />{l}</button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex-1" />
          {debugOpen && (
            <div className="hud pointer-events-auto mb-2 max-h-40 overflow-y-auto p-2 font-mono text-[10px] text-foreground/80">
              <div className="flex items-center justify-between font-bold text-foreground">
                <span>Developer Test Diagnostics</span>
                <button onClick={() => setDebugOpen(false)}><X className="h-3 w-3" /></button>
              </div>
              <div className="mt-1 space-y-0.5">
                <div>Backend: {capability?.backend || "detecting..."}</div>
                <div>WebXR: {capability?.webxrSupported ? "YES" : "NO"} | AR: {capability?.immersiveArSupported ? "YES" : "NO"} | Hands: {capability?.handTrackingSupported ? "YES" : "NO"}</div>
                <div>Rear Camera: {capability?.rearCameraAvailable ? "YES" : "NO"}</div>
                {capability?.backend === "fallback-rear" && (
                  <div className="text-amber-400">{FALLBACK_LIMITATION}</div>
                )}
                <div className="font-semibold text-brand-cyan mt-1">Telemetry Events:</div>
                {deviceTelemetry.getLogs().slice(-5).map((l, idx) => (
                  <div key={idx} className="text-[9px] text-muted-foreground">[{Math.round(l.timestamp)}ms] {l.event}</div>
                ))}
              </div>
            </div>
          )}
          {riding ? null : aiOpen ? (
            <form onSubmit={(e) => { e.preventDefault(); runAI(); }} className="hud pointer-events-auto mb-2 flex items-center gap-2 p-2">
              <Sparkles className="ml-1 h-5 w-5 shrink-0 text-brand-pink" />
              <input autoFocus value={aiText} onChange={(e) => setAiText(e.target.value)} maxLength={300} placeholder="Type anything… a house, a tree, a car" className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground" />
              <button disabled={aiBusy || !aiText.trim()} className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">{aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Build"}</button>
              <button type="button" aria-label="Close" onClick={() => setAiOpen(false)} className="p-1 text-muted-foreground"><X className="h-4 w-4" /></button>
            </form>
          ) : (
            <button onClick={() => setAiOpen(true)} className="pointer-events-auto mx-auto mb-2 flex items-center gap-2 rounded-full bg-gradient-to-r from-brand-violet to-brand-pink px-4 py-2 text-sm font-semibold text-primary-foreground shadow-lg"><Sparkles className="h-4 w-4" />AI Build</button>
          )}
          {mode === "track" && !riding && (
            <div className="hud pointer-events-auto mb-2 flex items-center justify-between gap-1 p-1.5 text-[10px]">
              {[
                { l: "Hill up", I: ArrowUp, f: () => co()?.raiseLast(1), ok: trackN > 0 },
                { l: "Down", I: ArrowDown, f: () => co()?.raiseLast(-1), ok: trackN > 0 },
                { l: "Undo pt", I: Undo2, f: () => { co()?.removeLast(); syncTrack(); }, ok: trackN > 0 },
                { l: loop ? "Loop on" : "Loop off", I: Repeat, f: () => setLoop(!loop), ok: true },
                { l: "Demo", I: Wand2, f: () => { co()?.loadGrid(DEMO, true); setLoop(true); syncTrack(); setToast("Demo coaster built — press Ride!"); }, ok: true },
                { l: "Clear", I: Trash2, f: () => { co()?.clear(); syncTrack(); }, ok: trackN > 0 },
              ].map(({ l, I, f, ok }) => (
                <button key={l} onClick={f} disabled={!ok} className="flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 disabled:opacity-35 active:bg-accent"><I className="h-4 w-4 text-brand-cyan" />{l}</button>
              ))}
            </div>
          )}
          {(trackN >= 2 || riding) && (
            <div className="pointer-events-auto mx-auto mb-2 flex items-center gap-2">
              <button onClick={ride} className={cn("flex items-center gap-2 rounded-full px-5 py-2.5 font-display text-sm font-semibold shadow-lg", riding ? "bg-destructive text-destructive-foreground" : "bg-success text-background")}>
                {riding ? <><Square className="h-4 w-4" />Stop</> : <><Play className="h-4 w-4" />Ride</>}
              </button>
              <button onClick={togglePov} className="hud flex items-center gap-1.5 px-3 py-2.5 text-xs"><Eye className="h-4 w-4 text-brand-cyan" />{pov ? "First person" : "Watch"}</button>
              {riding && <div className="hud px-3 py-2.5 font-display text-sm font-semibold tabular-nums">{speed} km/h</div>}
            </div>
          )}
          {toast && <div className="mx-auto mb-2 rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground">{toast}</div>}

          {/* bottom */}
          <div className={cn("pointer-events-auto flex flex-col gap-2", riding && pov && "hidden")}>
            <div className={cn("flex gap-2", mode === "track" && "hidden")}>
              <div className="hud flex flex-1 justify-between p-1.5">
                {SHAPES.map(({ id, label, Icon }) => (
                  <button key={id} onClick={() => setShape(id)} className={cn("flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-[10px]", shape === id ? "bg-primary/25 text-foreground ring-1 ring-brand-cyan" : "text-muted-foreground")}>
                    <Icon className="h-5 w-5" />{label}
                  </button>
                ))}
              </div>
              <div className="hud grid grid-cols-3 gap-1.5 p-2">
                {COLORS.map((c) => (
                  <button key={c} aria-label={`Color ${c}`} onClick={() => setColor(c)} style={{ background: c }} className={cn("h-6 w-6 rounded-full", color === c && "ring-2 ring-foreground ring-offset-2 ring-offset-card")} />
                ))}
              </div>
            </div>
            <div className="hud flex items-center gap-3 px-4 py-2.5 text-xs text-foreground/85"><activeMode.Icon className="h-4 w-4 shrink-0 text-brand-cyan" />{hint ?? activeMode.hint}</div>
            <div className="hud flex p-1.5">
              {MODES.map(({ id, label, Icon }) => (
                <button key={id} onClick={() => setMode(id)} className={cn("flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[11px] font-medium", mode === id ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
                  <Icon className="h-5 w-5" />{label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
