export type DeviceBackend = "webxr-hand" | "webxr-ar" | "fallback-rear" | "unsupported";

export interface CapabilityReport {
  backend: DeviceBackend;
  webxrSupported: boolean;
  immersiveArSupported: boolean;
  handTrackingSupported: boolean;
  hitTestSupported: boolean;
  planeDetectionSupported: boolean;
  /** Tri-state: confirmed rear camera, no camera, or unknown/unlabeled. */
  rearCameraAvailable: "yes" | "no" | "unknown";
  nonArFallbackReason?: string;
  details: string[];
}

export interface DeviceTelemetryLog {
  timestamp: number;
  event:
    | "webxr_available"
    | "immersive_ar_available"
    | "hand_tracking_available"
    | "hit_test_available"
    | "plane_detection_available"
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
 * A. WebXR immersive-ar + hand tracking (headset/full spatial MR)
 * B. WebXR AR without hand tracking (reticle hit-test touch building)
 * C. Non-AR fallback: Rear-camera optical tracking with MediaPipe
 * D. Clear unsupported-state UI
 *
 * Strict policy: Never silently switch to the front camera.
 * Strict policy: Clear distinction between room-scale WebXR AR and non-AR optical camera fallback.
 */
export async function detectDeviceCapabilities(): Promise<CapabilityReport> {
  const details: string[] = [];
  const xr = typeof navigator !== "undefined" ? (navigator as any).xr : undefined;

  let webxrSupported = false;
  let immersiveArSupported = false;
  let handTrackingSupported = false;
  let hitTestSupported = false;
  let planeDetectionSupported = false;
  let rearCameraAvailable: "yes" | "no" | "unknown" = "unknown";

  if (xr) {
    webxrSupported = true;
    deviceTelemetry.log("webxr_available");
    try {
      immersiveArSupported = await xr.isSessionSupported("immersive-ar");
      if (immersiveArSupported) {
        deviceTelemetry.log("immersive_ar_available");
        details.push("WebXR immersive-ar supported");

        // 1. Hand Tracking check
        if (typeof window !== "undefined" && ("XRHand" in window || "XRHandSpace" in window)) {
          handTrackingSupported = true;
          deviceTelemetry.log("hand_tracking_available");
          details.push("WebXR Hand Tracking API detected");
        } else {
          details.push("WebXR hand tracking not natively exposed in window globals");
        }

        // 2. Hit-testing check
        if (
          typeof window !== "undefined" &&
          ("XRHitTestSource" in window ||
            (typeof (window as any).XRSession !== "undefined" &&
              "requestHitTestSource" in (window as any).XRSession.prototype))
        ) {
          hitTestSupported = true;
          deviceTelemetry.log("hit_test_available");
          details.push("WebXR Hit-Test API available");
        } else {
          details.push("WebXR Hit-Test API not detected");
        }

        // 3. Plane detection check
        if (
          typeof window !== "undefined" &&
          ("XRPlane" in window ||
            "XRPlaneSet" in window ||
            (typeof (window as any).XRFrame !== "undefined" &&
              "detectedPlanes" in (window as any).XRFrame.prototype))
        ) {
          planeDetectionSupported = true;
          deviceTelemetry.log("plane_detection_available");
          details.push("WebXR Plane Detection API available");
        } else {
          details.push("WebXR Plane Detection API not detected");
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

  // Check rear camera strictly (environment facingMode)
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
  let nonArFallbackReason: string | undefined;

  if (immersiveArSupported && hitTestSupported) {
    backend = handTrackingSupported ? "webxr-hand" : "webxr-ar";
  } else if (immersiveArSupported) {
    // Immersive-AR is supported but hit-testing is absent
    backend = "fallback-rear";
    nonArFallbackReason = "WebXR immersive-ar supported, but spatial hit-testing is unavailable. Using optical camera fallback.";
    details.push(nonArFallbackReason);
    deviceTelemetry.log("fallback_selected", { mode: "rear_camera_mediapipe", reason: "missing_hit_test" });
  } else if (rearCameraAvailable !== "no" || (typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia)) {
    backend = "fallback-rear";
    nonArFallbackReason = !webxrSupported
      ? "WebXR API not available in browser. Optical rear-camera fallback active."
      : "WebXR immersive-ar not supported on device. Optical rear-camera fallback active.";
    details.push(nonArFallbackReason);
    deviceTelemetry.log("fallback_selected", { mode: "rear_camera_mediapipe", reason: "no_immersive_ar" });
  } else {
    backend = "unsupported";
    nonArFallbackReason = "Neither WebXR immersive-ar nor camera access is available.";
  }

  return {
    backend,
    webxrSupported,
    immersiveArSupported,
    handTrackingSupported,
    hitTestSupported,
    planeDetectionSupported,
    rearCameraAvailable,
    nonArFallbackReason,
    details,
  };
}
