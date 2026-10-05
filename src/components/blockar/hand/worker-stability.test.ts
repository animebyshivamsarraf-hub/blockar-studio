import { describe, expect, it } from "vitest";
import {
  computeStrictTimestamp,
  createWorkerSupervisorState,
  handleRuntimeGpuError,
  handleWorkerCrash,
  canRestartWorker,
  MAX_WORKER_RESTARTS,
  MP_INTERVAL_MS,
  MP_INTERVAL_CPU_MS,
} from "./workerPolicy";

describe("MediaPipe Worker Stability & Guardrails", () => {
  describe("Strictly increasing frame timestamps", () => {
    it("increments timestamp when raw timestamp is identical to previous", () => {
      const prev = 1000;
      const next = computeStrictTimestamp(prev, 1000);
      expect(next).toBe(1001);
      expect(next).toBeGreaterThan(prev);
    });

    it("increments timestamp when raw timestamp goes backwards (jitter/out of order)", () => {
      const prev = 2500;
      const next = computeStrictTimestamp(prev, 2480);
      expect(next).toBe(2501);
      expect(next).toBeGreaterThan(prev);
    });

    it("uses rounded raw timestamp when it is strictly greater than previous", () => {
      const prev = 1000;
      const next = computeStrictTimestamp(prev, 1066.4);
      expect(next).toBe(1066);
      expect(next).toBeGreaterThan(prev);
    });

    it("handles cold-start / initial timestamp properly", () => {
      const initial = computeStrictTimestamp(-1, 0);
      expect(initial).toBe(0);
      const second = computeStrictTimestamp(initial, 0);
      expect(second).toBe(1);
    });

    it("maintains strict monotonicity across a simulated series of noisy frames", () => {
      const noisyInputs = [100, 100.2, 100.1, 99.8, 120, 120, 115, 133.7, 150];
      let last = -1;
      for (const input of noisyInputs) {
        const next = computeStrictTimestamp(last, input);
        expect(next).toBeGreaterThan(last);
        last = next;
      }
    });
  });

  describe("GPU-to-CPU fallback state machine", () => {
    it("transitions from GPU to CPU on first runtime inference error and throttles rate", () => {
      const state = createWorkerSupervisorState();
      expect(state.activeDelegate).toBe("GPU");
      expect(state.rateMs).toBe(MP_INTERVAL_MS);

      const result = handleRuntimeGpuError(state);
      expect(result.fallbackToCpu).toBe(true);
      expect(result.nextState.activeDelegate).toBe("CPU");
      expect(result.nextState.cpuFallbackAttempted).toBe(true);
      expect(result.nextState.rateMs).toBe(MP_INTERVAL_CPU_MS);
    });

    it("does not re-attempt fallback if CPU inference also errors (avoids infinite loops)", () => {
      const state = createWorkerSupervisorState();
      const firstError = handleRuntimeGpuError(state);
      expect(firstError.fallbackToCpu).toBe(true);

      const secondError = handleRuntimeGpuError(firstError.nextState);
      expect(secondError.fallbackToCpu).toBe(false);
      expect(secondError.nextState.activeDelegate).toBe("CPU");
    });
  });

  describe("Worker restart limits & watchdog bounds", () => {
    it("allows restarts up to MAX_WORKER_RESTARTS", () => {
      let state = createWorkerSupervisorState();
      expect(canRestartWorker(state)).toBe(true);

      for (let i = 1; i <= MAX_WORKER_RESTARTS; i++) {
        const res = handleWorkerCrash(state);
        expect(res.canRestart).toBe(true);
        expect(res.nextState.restartCount).toBe(i);
        state = res.nextState;
      }

      expect(state.restartCount).toBe(MAX_WORKER_RESTARTS);
      expect(canRestartWorker(state)).toBe(false);
    });

    it("blocks further restarts once limit is reached and keeps state bounded", () => {
      let state = createWorkerSupervisorState();
      for (let i = 0; i < MAX_WORKER_RESTARTS; i++) {
        state = handleWorkerCrash(state).nextState;
      }

      // Attempt restart beyond limit
      const blocked = handleWorkerCrash(state);
      expect(blocked.canRestart).toBe(false);
      expect(blocked.nextState.restartCount).toBe(MAX_WORKER_RESTARTS);
    });
  });
});
