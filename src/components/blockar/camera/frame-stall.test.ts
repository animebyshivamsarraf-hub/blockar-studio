import { describe, expect, it } from "vitest";
import { FrameProgressTracker } from "./frameStall";

describe("FrameProgressTracker (preview camera freeze watchdog)", () => {
  it("never fires while the video clock keeps advancing", () => {
    const t = new FrameProgressTracker(2500);
    t.reset(0);
    expect(t.observe(0, 0)).toBe(false);
    expect(t.observe(1000, 1)).toBe(false);
    expect(t.observe(5000, 5)).toBe(false);
    expect(t.observe(9000, 9)).toBe(false);
  });

  it("does not fire before the limit on a frozen clock", () => {
    const t = new FrameProgressTracker(2500);
    t.reset(0);
    expect(t.observe(0, 3.2)).toBe(false);
    expect(t.observe(1000, 3.2)).toBe(false);
    expect(t.observe(2499, 3.2)).toBe(false);
  });

  it("fires once the clock has been frozen for the full limit", () => {
    const t = new FrameProgressTracker(2500);
    t.reset(0);
    expect(t.observe(0, 3.2)).toBe(false);
    expect(t.observe(2500, 3.2)).toBe(true);
  });

  it("an advance fully resets the episode (no stale trigger afterwards)", () => {
    const t = new FrameProgressTracker(2500);
    t.reset(0);
    expect(t.observe(0, 1)).toBe(false);
    expect(t.observe(2500, 1)).toBe(true); // stall episode fires
    expect(t.observe(2600, 1.1)).toBe(false); // frames moving again
    expect(t.observe(5000, 1.1)).toBe(false); // only 2.4s into the new freeze
    expect(t.observe(5101, 1.1)).toBe(true); // new episode, full limit elapsed
  });

  it("reset() clears any in-progress freeze", () => {
    const t = new FrameProgressTracker(2500);
    t.reset(0);
    expect(t.observe(0, 7)).toBe(false);
    t.reset(2000);
    expect(t.observe(2000, 7)).toBe(false);
    expect(t.observe(4499, 7)).toBe(false);
  });
});
