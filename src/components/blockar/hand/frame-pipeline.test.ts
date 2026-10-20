import { describe, expect, it } from "vitest";
import { FrameGate } from "./frameGate";
import { createWorkerSupervisorState, handleWorkerCrash, handleRuntimeGpuError } from "./workerPolicy";

describe("FrameGate — one frame in flight with generation tokens", () => {
  it("allows only one frame in flight", () => {
    const g = new FrameGate();
    const a = g.begin(0);
    expect(a).not.toBeNull();
    expect(g.begin(1)).toBeNull();
    expect(g.finish(a!)).toBe(true);
    expect(g.begin(2)).not.toBeNull();
  });

  it("a createImageBitmap that resolves after its timeout is discarded permanently", () => {
    const g = new FrameGate();
    const id = g.begin(0)!;
    expect(g.expire(1300, 1200, 3500)).toBe("bitmap");
    // late resolution: token dead, must not be sent and must not revive busy state
    expect(g.toWorker(id, 1400)).toBe(false);
    expect(g.busy()).toBe(false);
    const next = g.begin(1500)!;
    expect(g.toWorker(id, 1501)).toBe(false); // old token still dead
    expect(g.isCurrent(next)).toBe(true);
  });

  it("stale worker results never clear a newer frame", () => {
    const g = new FrameGate();
    const old = g.begin(0)!; g.toWorker(old, 1);
    expect(g.expire(4000, 1200, 3500)).toBe("worker");
    const fresh = g.begin(4001)!;
    expect(g.finish(old)).toBe(false);
    expect(g.isCurrent(fresh)).toBe(true);
  });

  it("worker stage uses the longer inference timeout", () => {
    const g = new FrameGate();
    const id = g.begin(0)!; g.toWorker(id, 0);
    expect(g.expire(2000, 1200, 3500)).toBeNull();
    expect(g.expire(3600, 1200, 3500)).toBe("worker");
  });

  it("reset (worker restart / source switch) invalidates the in-flight frame", () => {
    const g = new FrameGate();
    const id = g.begin(0)!;
    g.reset();
    expect(g.toWorker(id, 1)).toBe(false);
    expect(g.begin(2)).not.toBeNull();
  });
});

describe("Worker recovery policy", () => {
  it("bounds restarts to 3", () => {
    let s = createWorkerSupervisorState();
    for (let i = 0; i < 3; i++) { const r = handleWorkerCrash(s); expect(r.canRestart).toBe(true); s = r.nextState; }
    expect(handleWorkerCrash(s).canRestart).toBe(false);
  });
  it("falls back GPU → CPU once", () => {
    const s = createWorkerSupervisorState();
    const r = handleRuntimeGpuError(s);
    expect(r.fallbackToCpu).toBe(true);
    expect(handleRuntimeGpuError(r.nextState).fallbackToCpu).toBe(false);
  });
});
