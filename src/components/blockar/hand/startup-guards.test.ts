import { describe, expect, it, vi } from "vitest";
import { resolveXRHandoff, settleWithin, startStartupDeadline, isStaleSessionEnd, type XRHandoffEngine } from "./startupGuards";

/**
 * Regression tests for the LIVE phone bug (2026-10-20, build f40f05c):
 * with AR active, tapping Hand left the UI at "HAND: STARTING — MEDIAPIPE
 * FALLBACK — Please wait…" forever and pinch never worked.
 *
 * Root cause: toggleHands awaited engine.stopXR() — i.e. XRSession.end() —
 * with NO timeout. On Android Chrome that promise can wedge while the
 * session is presenting; every later startup step (and the whole MediaPipe
 * worker path) sat behind it, and the hand button is disabled while
 * starting, so the user could not even retry.
 *
 * These tests pin the bounded behavior of resolveXRHandoff/settleWithin:
 * every path must settle — progress or an honest "stuck" — never a hang.
 */

const immediateSleep = () => Promise.resolve();

function fakeEngine(state: { xr: boolean; raw: "pending" | "yes" | "no" }, stopXR: () => Promise<void>) {
  const engine: XRHandoffEngine & { stopXR: ReturnType<typeof vi.fn> } = {
    isXR: () => state.xr,
    rawCameraState: () => state.raw,
    stopXR: vi.fn(stopXR),
  };
  return engine;
}

describe("settleWithin", () => {
  it("resolves with the value when the promise settles in time", async () => {
    const out = await settleWithin(Promise.resolve(42), 1000);
    expect(out).toEqual({ settled: true, value: 42 });
  });

  it("resolves { settled: false } when the promise never settles", async () => {
    const out = await settleWithin(new Promise<number>(() => {}), 30);
    expect(out).toEqual({ settled: false });
  });

  it("propagates rejections instead of swallowing them", async () => {
    await expect(settleWithin(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom");
  });
});

describe("resolveXRHandoff", () => {
  it("no XR session → none, stopXR untouched", async () => {
    const engine = fakeEngine({ xr: false, raw: "no" }, () => Promise.resolve());
    const out = await resolveXRHandoff(engine, { sleep: immediateSleep });
    expect(out).toEqual({ kind: "none" });
    expect(engine.stopXR).not.toHaveBeenCalled();
  });

  it("raw camera becomes available during probe → raw, AR stays on", async () => {
    const state: { xr: boolean; raw: "pending" | "yes" | "no" } = { xr: true, raw: "pending" };
    const engine = fakeEngine(state, () => Promise.resolve());
    let polls = 0;
    const sleep = () => { polls++; if (polls >= 2) state.raw = "yes"; return Promise.resolve(); };
    const out = await resolveXRHandoff(engine, { sleep });
    expect(out).toEqual({ kind: "raw" });
    expect(engine.stopXR).not.toHaveBeenCalled();
  });

  it("no raw camera, stopXR ends the session → exited (stoppedByUs)", async () => {
    const state = { xr: true, raw: "no" as const };
    const engine = fakeEngine(state, () => { state.xr = false; return Promise.resolve(); });
    const onSwitching = vi.fn();
    const out = await resolveXRHandoff(engine, { sleep: immediateSleep, onSwitching });
    expect(out).toEqual({ kind: "exited", stoppedByUs: true });
    expect(engine.stopXR).toHaveBeenCalledTimes(1);
    expect(engine.stopXR).toHaveBeenCalledWith(true);
    expect(onSwitching).toHaveBeenCalledTimes(1);
  });

  it("stopXR promise hangs but session ends during exit poll → exited, not stuck", async () => {
    const state = { xr: true, raw: "no" as const };
    // XRSession.end() never resolves, yet the 'end' event lands a bit later —
    // exactly the wedged-promise case from the phone. Startup must proceed.
    const engine = fakeEngine(state, () => new Promise<void>(() => {}));
    let polls = 0;
    const sleep = () => { polls++; if (polls >= 3) state.xr = false; return Promise.resolve(); };
    const out = await resolveXRHandoff(engine, { sleep, stopTimeoutMs: 30 });
    expect(out).toEqual({ kind: "exited", stoppedByUs: true });
  });

  it("stopXR hangs and session never ends → stuck (bounded), never a hang", async () => {
    const state = { xr: true, raw: "no" as const };
    const engine = fakeEngine(state, () => new Promise<void>(() => {}));
    const out = await resolveXRHandoff(engine, { sleep: immediateSleep, stopTimeoutMs: 30, exitPolls: 5 });
    expect(out).toEqual({ kind: "stuck" });
    expect(engine.stopXR).toHaveBeenCalledTimes(1);
  });

  it("session ends on its own during probe → exited (not stoppedByUs), stopXR untouched", async () => {
    const state: { xr: boolean; raw: "pending" | "yes" | "no" } = { xr: true, raw: "pending" };
    const engine = fakeEngine(state, () => Promise.resolve());
    const sleep = () => { state.xr = false; state.raw = "no"; return Promise.resolve(); };
    const out = await resolveXRHandoff(engine, { sleep });
    expect(out).toEqual({ kind: "exited", stoppedByUs: false });
    expect(engine.stopXR).not.toHaveBeenCalled();
  });
});

/**
 * Regression tests for the SECOND phone failure (2026-10-21, build 9371c01):
 * startup STILL stuck at STARTING despite the bounded handoff. Per-step
 * timeouts stack to ~69 s and the handoff await sat OUTSIDE toggleHands'
 * try/catch, so one unmodelled hang/rejection stranded the UI forever.
 * The overall deadline + attempt token guarantee a terminal state.
 */
describe("startStartupDeadline", () => {
  function fakeTimers() {
    const pending = new Map<number, () => void>();
    let nextId = 1;
    return {
      timers: {
        setTimeout: (fn: () => void, _ms: number) => { const id = nextId++; pending.set(id, fn); return id; },
        clearTimeout: (id: unknown) => { pending.delete(id as number); },
      },
      fireAll() { const fns = [...pending.values()]; pending.clear(); fns.forEach((f) => f()); },
      get pendingCount() { return pending.size; },
    };
  }

  it("fires onTimeout exactly once when the deadline elapses", () => {
    const t = fakeTimers();
    const onTimeout = vi.fn();
    const d = startStartupDeadline(75000, onTimeout, t.timers);
    expect(d.fired).toBe(false);
    t.fireAll();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(d.fired).toBe(true);
    t.fireAll(); // nothing left scheduled — must not fire again
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("cancel() before the deadline prevents firing", () => {
    const t = fakeTimers();
    const onTimeout = vi.fn();
    const d = startStartupDeadline(75000, onTimeout, t.timers);
    d.cancel();
    expect(t.pendingCount).toBe(0);
    t.fireAll();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(d.fired).toBe(false);
  });

  it("cancel() after firing is a harmless no-op", () => {
    const t = fakeTimers();
    const onTimeout = vi.fn();
    const d = startStartupDeadline(75000, onTimeout, t.timers);
    t.fireAll();
    d.cancel();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(d.fired).toBe(true);
  });
});

describe("isStaleSessionEnd", () => {
  it("a different session ending is stale (must be ignored)", () => {
    const live = { id: 2 };
    const old = { id: 1 };
    expect(isStaleSessionEnd(live, old)).toBe(true);
  });

  it("the current session ending is not stale", () => {
    const live = { id: 1 };
    expect(isStaleSessionEnd(live, live)).toBe(false);
  });

  it("an end with no current session is stale (already torn down)", () => {
    expect(isStaleSessionEnd(null, { id: 1 })).toBe(true);
  });
});
