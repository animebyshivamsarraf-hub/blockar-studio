import { describe, expect, it } from "vitest";
import { isEnvironmentStream, resolveCursorOwner, type TrackStatus } from "./HandSystemRuntime";

const hand = (held: boolean, status: TrackStatus = "tracking") => ({ pinch: { held }, status });
const hands = (left: ReturnType<typeof hand>, right: ReturnType<typeof hand>) => ({ left, right });

describe("Phase 1 construction hand ownership", () => {
  it("assigns the first valid pinch", () => {
    expect(resolveCursorOwner(null, hands(hand(true), hand(false)), null)).toBe("left");
  });

  it("uses right hand for a same-frame tie", () => {
    expect(resolveCursorOwner(null, hands(hand(true), hand(true)), null)).toBe("right");
  });

  it("keeps the current owner while both hands pinch", () => {
    expect(resolveCursorOwner("left", hands(hand(true), hand(true)), null)).toBe("left");
  });

  it("reassigns after the owner releases", () => {
    expect(resolveCursorOwner("left", hands(hand(false), hand(true)), null)).toBe("right");
  });

  it("clears a lost owner", () => {
    expect(resolveCursorOwner("left", hands(hand(true, "lost"), hand(false)), null)).toBeNull();
  });

  it("does not assign the hand currently grabbing the test cube", () => {
    expect(resolveCursorOwner(null, hands(hand(true), hand(false)), "left")).toBeNull();
  });

  it("returns no owner when neither hand is pinching", () => {
    expect(resolveCursorOwner(null, hands(hand(false), hand(false)), null)).toBeNull();
  });
});

const streamWith = (track: object | null) =>
  ({ getVideoTracks: () => (track ? [track] : []) }) as unknown as MediaStream;

const liveTrack = (settings: Record<string, unknown>) =>
  ({ readyState: "live", getSettings: () => settings });

describe("Phase 1 strict rear-camera validation", () => {
  it("accepts facingMode environment", async () => {
    expect(await isEnvironmentStream(streamWith(liveTrack({ facingMode: "environment" })))).toBe(true);
  });

  it("rejects facingMode user", async () => {
    expect(await isEnvironmentStream(streamWith(liveTrack({ facingMode: "user" })))).toBe(false);
  });

  it("rejects an unlabeled/unknown camera when facingMode is absent", async () => {
    expect(await isEnvironmentStream(streamWith(liveTrack({})))).toBe(false);
  });

  it("rejects missing or ended video tracks", async () => {
    expect(await isEnvironmentStream(streamWith(null))).toBe(false);
    expect(await isEnvironmentStream(streamWith({
      readyState: "ended",
      getSettings: () => ({ facingMode: "environment" }),
    }))).toBe(false);
  });
});
