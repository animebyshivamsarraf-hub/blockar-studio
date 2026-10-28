import { useEffect, useRef, useState } from "react";
import type { CameraOwner, FrameSource } from "./camera/CameraOwnership";

export interface DiagnosticsData {
  cameraOwner: CameraOwner;
  frameSource: FrameSource;
  videoReadyState: number;
  videoCurrentTime: number;
  videoTimeChanging: boolean;
  trackReadyState: string;
  trackMuted: boolean;
  renderFps: number;
  handFps: number;
  workerState: string;
  delegate: string;
  restartCount: number;
  frameGateInFlight: boolean;
  frameGateStage: string | null;
  lastFrameId: number;
  rawCameraProbe: string;
  xrActive: boolean;
  lastError: string | null;
  lastErrorTime: string | null;
  // P1 (?debug=cam) fields, fed by BlockAR from the runtime diagnostics
  // callback. Values are -1 / "" when not yet reported — never fabricated.
  framesSubmitted: number;
  resultsReceived: number;
  resultsWithLandmarks: number;
  droppedFrames: number;
  detectErrors: number;
  pinchRatio: number;
  pinchPhase: string;
  // Live nearest-block distance is NOT exposed by the engine, so this
  // field deliberately stays as the engine's radius constant, not a fake
  // live measurement. See the overlay row label.
  nearestBlockRadius: string;
}

const initialData: DiagnosticsData = {
  cameraOwner: "CAMERA_IDLE",
  frameSource: "none",
  videoReadyState: 0,
  videoCurrentTime: 0,
  videoTimeChanging: false,
  trackReadyState: "none",
  trackMuted: false,
  renderFps: 0,
  handFps: 0,
  workerState: "idle",
  delegate: "GPU",
  restartCount: 0,
  frameGateInFlight: false,
  frameGateStage: null,
  lastFrameId: 0,
  rawCameraProbe: "pending",
  xrActive: false,
  lastError: null,
  lastErrorTime: null,
  framesSubmitted: -1,
  resultsReceived: -1,
  resultsWithLandmarks: -1,
  droppedFrames: -1,
  detectErrors: -1,
  pinchRatio: -1,
  pinchPhase: "",
  nearestBlockRadius: "0.18 m (engine radius; live distance not exposed)",
};

// Singleton store for diagnostics data - updated by engine, runtime, and UI
class DiagnosticsStore {
  private data: DiagnosticsData = { ...initialData };
  private listeners: Set<() => void> = new Set();

  update(patch: Partial<DiagnosticsData>) {
    Object.assign(this.data, patch);
    this.listeners.forEach((l) => l());
  }

  get(): DiagnosticsData {
    return { ...this.data };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setError(text: string) {
    this.update({
      lastError: text,
      lastErrorTime: new Date().toLocaleTimeString(),
    });
  }
}

export const diagnosticsStore = new DiagnosticsStore();

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", fontSize: 11 }}>
      <span style={{ color: "#8faec8" }}>{label}:</span>
      <span style={{ color: warn ? "#ff6b6b" : "#fff", fontWeight: 600, fontFamily: "monospace" }}>
        {value}
      </span>
    </div>
  );
}

export function DiagnosticsOverlay({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<DiagnosticsData>(() => diagnosticsStore.get());
  const lastTimeRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const unsub = diagnosticsStore.subscribe(() => setData(diagnosticsStore.get()));
    // Poll video.currentTime to detect stalls
    const iv = setInterval(() => {
      const d = diagnosticsStore.get();
      const changing = d.videoCurrentTime !== lastTimeRef.current;
      lastTimeRef.current = d.videoCurrentTime;
      if (d.videoTimeChanging !== changing) {
        diagnosticsStore.update({ videoTimeChanging: changing });
      }
    }, 1000);
    return () => {
      unsub();
      clearInterval(iv);
    };
  }, [open ]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: 50,
          background: "rgba(10,22,38,0.9)",
          border: "1px solid rgba(77,232,255,0.4)",
          color: "#4de8ff",
          fontSize: 11,
          padding: "6px 10px",
          borderRadius: 8,
          cursor: "pointer",
        }}
      >
        🔧 DIAG
      </button>
    );
  }

  const stalled = !data.videoTimeChanging && data.cameraOwner === "CAMERA_MEDIAPIPE";

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 50,
        width: 280,
        maxHeight: "70vh",
        overflowY: "auto",
        background: "rgba(5,12,22,0.95)",
        border: "1px solid rgba(77,232,255,0.4)",
        borderRadius: 12,
        padding: 12,
        fontFamily: "monospace",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ color: "#4de8ff", fontWeight: 700, fontSize: 12 }}>DIAGNOSTICS</span>
        <button
          onClick={() => setOpen(false)}
          style={{
            background: "transparent",
            border: "1px solid #4de8ff",
            color: "#4de8ff",
            borderRadius: 6,
            padding: "2px 8px",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ color: "#ffd93d", fontSize: 11, fontWeight: 700, marginBottom: 4 }}>📷 CAMERA</div>
      <Row label="owner" value={data.cameraOwner} warn={data.cameraOwner === "CAMERA_IDLE" && data.frameSource !== "none"} />
      <Row label="frameSource" value={data.frameSource} />
      <Row label="video.readyState" value={String(data.videoReadyState)} warn={data.videoReadyState < 2} />
      <Row label="video.currentTime" value={data.videoCurrentTime.toFixed(2)} />
      <Row label="time changing" value={data.videoTimeChanging ? "YES" : "NO"} warn={stalled} />
      <Row label="track.readyState" value={data.trackReadyState} warn={data.trackReadyState !== "live"} />
      <Row label="track.muted" value={String(data.trackMuted)} warn={data.trackMuted} />

      <div style={{ color: "#ffd93d", fontSize: 11, fontWeight: 700, margin: "8px 0 4px" }}>⚡ PERF</div>
      <Row label="render fps" value={String(data.renderFps)} warn={data.renderFps < 20 && data.renderFps > 0} />
      <Row label="hand fps" value={String(data.handFps)} warn={data.handFps < 5 && data.handFps > 0} />

      <div style={{ color: "#ffd93d", fontSize: 11, fontWeight: 700, margin: "8px 0 4px" }}>🤖 WORKER</div>
      <Row label="framesSubmitted" value={data.framesSubmitted < 0 ? "-" : String(data.framesSubmitted)} />
      <Row label="resultsReceived" value={data.resultsReceived < 0 ? "-" : String(data.resultsReceived)} />
      <Row label="resultsWithLandmarks" value={data.resultsWithLandmarks < 0 ? "-" : String(data.resultsWithLandmarks)} />
      <Row label="droppedFrames" value={data.droppedFrames < 0 ? "-" : String(data.droppedFrames)} />
      <Row label="detectErrors" value={data.detectErrors < 0 ? "-" : String(data.detectErrors)} />
      <Row label="pinchRatio" value={data.pinchRatio < 0 ? "-" : data.pinchRatio.toFixed(2)} />
      <Row label="pinchPhase" value={data.pinchPhase || "-"} />
      <Row label="nearestBlockRadius" value={data.nearestBlockRadius} />
      <Row label="workerState" value={data.workerState} warn={data.workerState === "error"} />
      <Row label="delegate" value={data.delegate} />
      <Row label="restarts" value={String(data.restartCount)} warn={data.restartCount >= 3} />
      <Row label="gate in-flight" value={data.frameGateInFlight ? "YES" : "NO"} warn={data.frameGateInFlight} />
      <Row label="gate stage" value={data.frameGateStage ?? "-"} />
      <Row label="last frameId" value={String(data.lastFrameId)} />

      <div style={{ color: "#ffd93d", fontSize: 11, fontWeight: 700, margin: "8px 0 4px" }}>🥽 XR</div>
      <Row label="rawCameraProbe" value={data.rawCameraProbe} />
      <Row label="xrActive" value={data.xrActive ? "YES" : "NO"} />

      <div style={{ color: "#ff6b6b", fontSize: 11, fontWeight: 700, margin: "8px 0 4px" }}>⚠️ LAST ERROR</div>
      <div style={{ fontSize: 11, color: "#fff", wordBreak: "break-word" }}>
        {data.lastError ?? "none"}
      </div>
      {data.lastErrorTime && (
        <div style={{ fontSize: 10, color: "#8faec8" }}>{data.lastErrorTime}</div>
      )}
    </div>
  );
}
