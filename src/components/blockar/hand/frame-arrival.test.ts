import { describe, expect, it } from "vitest";
import { FrameArrivalWatchdog } from "./frameArrival";

/**
 * Regression tests for the frame-starvation hole found 2026-10-21:
 * the hand pipeline can reach TRACKING on the XR frame source while no
 * frame is ever fed (sink never installed / engine stops feeding), and
 * nothing errored — the video stall watchdog covered only "video".
 * FrameArrivalWatchdog must fire exactly when armed + starved + past the
 * limit, and never otherwise.
 */
describe("FrameArrivalWatchdog", () => {
  it("does not fire before arming", () => {
    const w = new FrameArrivalWatchdog(6000);
    expect(w.check(100000)).toBe(false);
  });

  it("does not fire before the limit elapses", () => {
    const w = new FrameArrivalWatchdog(6000);
    w.arm(1000);
    expect(w.check(1000)).toBe(false);
    expect(w.check(6999)).toBe(false);
  });

  it("fires at the limit when no result ever arrived", () => {
    const w = new FrameArrivalWatchdog(6000);
    w.arm(1000);
    expect(w.check(7000)).toBe(true);
    expect(w.check(60000)).toBe(true);
  });

  it("a result fed after arming satisfies it permanently", () => {
    const w = new FrameArrivalWatchdog(6000);
    w.arm(1000);
    w.fed(2500);
    expect(w.check(7000)).toBe(false);
    expect(w.check(600000)).toBe(false);
  });

  it("a result fed BEFORE arming does not count", () => {
    const w = new FrameArrivalWatchdog(6000);
    w.fed(500);
    w.arm(1000);
    expect(w.check(7000)).toBe(true);
  });

  it("disarm silences it", () => {
    const w = new FrameArrivalWatchdog(6000);
    w.arm(1000);
    w.disarm();
    expect(w.isArmed).toBe(false);
    expect(w.check(60000)).toBe(false);
  });

  it("re-arming resets the fed state (fresh starvation window)", () => {
    const w = new FrameArrivalWatchdog(6000);
    w.arm(1000);
    w.fed(2000);
    expect(w.check(9000)).toBe(false);
    w.arm(10000);
    expect(w.check(15999)).toBe(false);
    expect(w.check(16000)).toBe(true);
  });
});
