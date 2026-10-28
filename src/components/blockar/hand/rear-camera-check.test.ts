import { describe, expect, it } from "vitest";
import { checkEnvironmentStream, isEnvironmentStream } from "./HandSystemRuntime";

const streamWith = (track: object | null) =>
  ({ getVideoTracks: () => (track ? [track] : []) }) as unknown as MediaStream;
const liveTrack = (settings: Record<string, unknown>) =>
  ({ readyState: "live", getSettings: () => settings });

describe("P0/P1 rear-camera rejection reasons (branch fix/blockar-p0-handoff)", () => {
  it("accepts facingMode environment", async () => {
    expect(await checkEnvironmentStream(streamWith(liveTrack({ facingMode: "environment" })))).toEqual({ ok: true, reason: "ok" });
    expect(await isEnvironmentStream(streamWith(liveTrack({ facingMode: "environment" })))).toBe(true);
  });
  it("names facingMode-not-environment instead of a generic failure", async () => {
    expect(await checkEnvironmentStream(streamWith(liveTrack({ facingMode: "user" })))).toEqual({ ok: false, reason: "facingMode-not-environment" });
  });
  it("names no-track and track-not-live", async () => {
    expect(await checkEnvironmentStream(streamWith(null))).toEqual({ ok: false, reason: "no-track" });
    expect(await checkEnvironmentStream(streamWith({ readyState: "ended", getSettings: () => ({ facingMode: "environment" }) }))).toEqual({ ok: false, reason: "track-not-live" });
  });
  it("fails closed on an unlabeled camera (no front-camera fallback)", async () => {
    // No facingMode and no enumerateDevices in this test env -> timeout path.
    const r = await checkEnvironmentStream(streamWith(liveTrack({})));
    expect(r.ok).toBe(false);
    expect(["label-no-match", "enumerate-timeout"]).toContain(r.reason);
  });
});
