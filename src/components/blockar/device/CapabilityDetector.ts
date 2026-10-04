export type DeviceBackend = "webxr-hand" | "webxr-ar" | "fallback-rear" | "unsupported";

export interface CapabilityReport {
  backend: DeviceBackend;
  webxrSupported: boolean;
  immersiveArSupported: boolean;
  handTrackingSupported: boolean;
  /** Tri-state: confirmed rear camera, no camera, or unknown/unlabeled. */
  rearCameraAvailable: "yes" | "no" | "unknown";
  details: string[];
}

export interface DeviceTelemetryLog {
  timestamp: number;
  event:
    | "webxr_available"
    | "immersive_ar_available"
    | "hand_tracking_available"
    | "left_hand_detected"
    | "right_hand_detected"
    | "pinch_detected"
    | "grab_started"
    | "grab_released"
    | "hand_lost"
    | "hand_reacquired"
    | "fallback_selected";
  meta?: Record<string, any> | undefined;
}

class TelemetryCollector {
  private logs: DeviceTelemetryLog[] = [];
  private maxLogs = 50;

  log(event: DeviceTelemetryLog["event"], meta?: Record<string, any>) {
    const entry: DeviceTelemetryLog = {
      timestamp: performance.now(),
      event,
      meta,
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    if (typeof window !== "undefined" && (window as any).__BLOCKAR_DEBUG__) {
      console.log(`[BlockAR Telemetry] ${event}`, meta || "");
    }
  }

  getLogs(): ReadonlyArray<DeviceTelemetryLog> {
    return this.logs;
  }

  clear() {
    this.logs = [];
  }
}

export const deviceTelemetry = new TelemetryCollector();

/**
 * Clean capability check before selecting the interaction backend.
 * Selection Priority:
 * A. WebXR immersive-ar + hand tracking
 * B. WebXR AR without hand tracking (safe reticle touch fallback)
 * C. Rear-camera fallback with MediaPipe where supported
 * D. Clear unsupported-state UI
 *
 * Strict policy: Never silently switch to the front camera.
 * Strict policy: Never use a fake virtual floor as a replacement for real world tracking.
 */
export async function detectDeviceCapabilities(): Promise<CapabilityReport> {
  const details: string[] = [];
  const xr = typeof navigator !== "undefined" ? (navigator as any).xr : undefined;

  let webxrSupported = false;
  let immersiveArSupported = false;
  let handTrackingSupported = false;
  let rearCameraAvailable: "yes" | "no" | "unknown" = "unknown";

  if (xr) {
    webxrSupported = true;
    deviceTelemetry.log("webxr_available");
    try {
      immersiveArSupported = await xr.isSessionSupported("immersive-ar");
      if (immersiveArSupported) {
        deviceTelemetry.log("immersive_ar_available");
        details.push("WebXR immersive-ar supported");
        if (typeof window !== "undefined" && ("XRHand" in window || "XRHandSpace" in window)) {
          handTrackingSupported = true;
          deviceTelemetry.log("hand_tracking_available");
          details.push("WebXR Hand Tracking API detected");
        } else {
          details.push("WebXR hand tracking not natively exposed in window globals");
        }
      } else {
        details.push("immersive-ar session not supported by this browser");
      }
    } catch (err) {
      details.push(`Error checking immersive-ar support: ${(err as Error).message}`);
    }
  } else {
    details.push("WebXR API (navigator.xr) not present");
  }

  // Check rear camera strictly (exact environment or environment)
  if (typeof navigator !== "undefined" && navigator.mediaDevices?.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter((d) => d.kind === "videoinput");
      if (!videoInputs.length) {
        rearCameraAvailable = "no";
        details.push("No video input devices found");
      } else if (videoInputs.some((d) => /back|rear|environment/i.test(d.label))) {
        rearCameraAvailable = "yes";
        details.push("Rear camera device detected");
      } else {
        rearCameraAvailable = "unknown";
        details.push("Video inputs present but rear camera not confirmed (unlabeled/generic)");
      }
    } catch {
      rearCameraAvailable = "unknown";
      details.push("Media devices query failed — rear camera unconfirmed");
    }
  }

  let backend: DeviceBackend = "unsupported";
  if (immersiveArSupported) {
    backend = handTrackingSupported ? "webxr-hand" : "webxr-ar";
  } else if (rearCameraAvailable !== "no" || (typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia)) {
    backend = "fallback-rear";
    deviceTelemetry.log("fallback_selected", { mode: "rear_camera_mediapipe" });
  } else {
    backend = "unsupported";
  }

  return {
    backend,
    webxrSupported,
    immersiveArSupported,
    handTrackingSupported,
    rearCameraAvailable,
    details,
  };
}
