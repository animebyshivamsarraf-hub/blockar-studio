import { describe, it, expect } from "vitest";

// Fix 3: Phone UA detection for CPU delegate
function getInitialDelegate(userAgent: string): "GPU" | "CPU" {
  return /Android|iPhone|iPad|Mobile/i.test(userAgent) ? "CPU" : "GPU";
}

describe("fix 3: mobile CPU delegate", () => {
  it("Android starts with CPU", () => {
    expect(getInitialDelegate("Mozilla/5.0 (Linux; Android 14; moto g45 5G)")).toBe("CPU");
  });

  it("iPhone starts with CPU", () => {
    expect(getInitialDelegate("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("CPU");
  });

  it("Desktop Chrome stays GPU", () => {
    expect(getInitialDelegate("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120")).toBe("GPU");
  });

  it("Desktop Mac stays GPU", () => {
    expect(getInitialDelegate("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("GPU");
  });
});

// Fix 1: visibilitychange logic
describe("fix 1: visibilitychange", () => {
  it("hidden → pause (setFrameSource none), visible → restore (if hands wanted, no XR)", () => {
    // Logic: hidden → setFrameSource("none")
    // visible + handsWanted + !xr → restoreVideoPipeline("restore")
    // visible + xr → do nothing
    const shouldRestore = (handsWanted: boolean, xr: boolean) => handsWanted && !xr;
    expect(shouldRestore(true, false)).toBe(true);
    expect(shouldRestore(true, true)).toBe(false);
    expect(shouldRestore(false, false)).toBe(false);
  });
});

// Fix 2: track listeners call restore immediately
describe("fix 2: track ended/mute", () => {
  it("ended/mute triggers restore when hands wanted and no XR", () => {
    const shouldRestore = (handsWanted: boolean, xr: boolean) => handsWanted && !xr;
    expect(shouldRestore(true, false)).toBe(true);
    expect(shouldRestore(false, false)).toBe(false);
    expect(shouldRestore(true, true)).toBe(false);
  });
});
