import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Hand, MousePointer2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { HandSystemRuntime, type HandDiagnostics, type HandInfo } from "./HandSystemRuntime";

const INITIAL: HandDiagnostics = {
  system: "OFF", backend: "NONE", gesture: "—", session: "idle", fps: 0, error: null, labels: [],
  left: { status: "not detected", pinch: "OPEN", ratio: 1, grabbing: false },
  right: { status: "not detected", pinch: "OPEN", ratio: 1, grabbing: false },
};

export function HandLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rt = useRef<HandSystemRuntime | null>(null);
  const [d, setD] = useState<HandDiagnostics>(INITIAL);
  const [xrOk, setXrOk] = useState(false);

  useEffect(() => {
    if (!canvasRef.current || !videoRef.current || !rootRef.current) return;
    const r = new HandSystemRuntime(canvasRef.current, videoRef.current, rootRef.current, setD);
    rt.current = r;
    void HandSystemRuntime.webxrSupported().then(setXrOk);
    return () => { r.dispose(); rt.current = null; };
  }, []);

  const busy = d.system === "STARTING" || d.system === "INITIALIZING";
  const on = d.system === "TRACKING";

  return (
    <div ref={rootRef} className="fixed inset-0 overflow-hidden bg-background text-foreground">
      <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />

      {d.labels.map((l) => (
        <div key={l.side} className="pointer-events-none absolute -translate-x-1/2 rounded-full border border-brand-cyan/60 bg-background/70 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-brand-cyan backdrop-blur" style={{ left: l.x, top: l.y - 44 }}>
          {l.text}
        </div>
      ))}

      <div className="absolute left-3 top-3 flex items-center gap-2">
        <Link to="/" className="flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-card/90 backdrop-blur"><ArrowLeft className="h-4 w-4" /></Link>
        <div className="rounded-full border border-border/60 bg-card/90 px-3 py-1.5 font-display text-sm font-semibold backdrop-blur">Hand Lab</div>
      </div>

      {/* Controls */}
      <div className="absolute inset-x-0 bottom-4 flex flex-wrap items-center justify-center gap-2 px-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => (on || d.system === "ERROR" ? rt.current?.stop() : rt.current?.start("auto"))}
          className={cn("flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-semibold backdrop-blur transition",
            on ? "border-brand-cyan bg-card/95" : d.system === "ERROR" ? "border-destructive bg-destructive/15" : "border-border/60 bg-card/90",
            busy && "cursor-wait opacity-70")}
        >
          <Hand className={cn("h-4 w-4", on ? "text-brand-cyan" : "text-muted-foreground")} />
          Hand Control: {d.system}
        </button>
        {!on && !busy && (
          <>
            <button type="button" onClick={() => rt.current?.start("mediapipe")} className="rounded-full border border-border/60 bg-card/90 px-3 py-2.5 text-xs backdrop-blur">Camera (MediaPipe)</button>
            {xrOk && <button type="button" onClick={() => rt.current?.start("webxr")} className="rounded-full border border-border/60 bg-card/90 px-3 py-2.5 text-xs backdrop-blur">WebXR Hands</button>}
            <button type="button" onClick={() => rt.current?.start("demo")} className="flex items-center gap-1 rounded-full border border-border/60 bg-card/90 px-3 py-2.5 text-xs backdrop-blur"><MousePointer2 className="h-3.5 w-3.5" />Mouse demo</button>
          </>
        )}
        <button type="button" onClick={() => rt.current?.resetCube()} className="flex items-center gap-1 rounded-full border border-border/60 bg-card/90 px-3 py-2.5 text-xs backdrop-blur"><RotateCcw className="h-3.5 w-3.5" />Reset cube</button>
      </div>

      {/* Diagnostics */}
      <div className="pointer-events-none absolute right-3 top-3 w-60 rounded-xl border border-border/60 bg-card/85 p-3 font-mono text-[11px] leading-5 backdrop-blur">
        <div className="mb-1 font-display text-xs font-semibold text-brand-cyan">DIAGNOSTICS</div>
        <Row k="Hand System" v={d.system === "OFF" ? "OFF" : `ON · ${d.system}`} />
        <Row k="Backend" v={d.backend} />
        <HandRow side="Left" h={d.left} />
        <HandRow side="Right" h={d.right} />
        <Row k="Gesture" v={d.gesture} />
        <Row k="Session" v={d.session} />
        <Row k="FPS" v={String(d.fps)} />
        {d.error && <div className="mt-1 break-words text-destructive">Error: {d.error}</div>}
      </div>

      {d.system === "OFF" && (
        <div className="pointer-events-none absolute inset-x-0 top-1/3 mx-auto max-w-xs rounded-xl border border-border/60 bg-card/85 p-4 text-center text-sm backdrop-blur">
          Tap <b>Hand Control</b>, show your hand to the rear camera, then pinch thumb + index near the cube to grab it.
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-2"><span className="text-muted-foreground">{k}</span><span className="truncate text-right">{v}</span></div>;
}

function HandRow({ side, h }: { side: string; h: HandInfo }) {
  const color = h.grabbing ? "text-brand-pink" : h.status === "tracking" ? "text-success" : h.status === "reacquiring" ? "text-brand-cyan" : "text-muted-foreground";
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{side}</span>
      <span className={cn("text-right", color)}>{h.status}{h.status === "tracking" ? ` · ${h.grabbing ? "GRAB" : h.pinch}` : ""}</span>
    </div>
  );
}
