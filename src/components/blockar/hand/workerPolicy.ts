export const MAX_WORKER_RESTARTS = 3;
export const WORKER_INFERENCE_TIMEOUT_MS = 3500;
export const MP_INTERVAL_MS = 1000 / 15;
export const MP_INTERVAL_CPU_MS = 1000 / 10;

/**
 * Ensures frame timestamps passed to MediaPipe detectForVideo are strictly
 * monotonically increasing, preventing MediaPipe WASM runtime exceptions.
 */
export function computeStrictTimestamp(lastTimestamp: number, incomingTimestampMs: number): number {
  const raw = Math.round(incomingTimestampMs);
  return Math.max(lastTimestamp + 1, raw);
}

export type DelegateType = "GPU" | "CPU";

export interface WorkerSupervisorState {
  restartCount: number;
  maxRestarts: number;
  activeDelegate: DelegateType;
  cpuFallbackAttempted: boolean;
  rateMs: number;
}

export function createWorkerSupervisorState(): WorkerSupervisorState {
  return {
    restartCount: 0,
    maxRestarts: MAX_WORKER_RESTARTS,
    activeDelegate: "GPU",
    cpuFallbackAttempted: false,
    rateMs: MP_INTERVAL_MS,
  };
}

export function canRestartWorker(state: WorkerSupervisorState): boolean {
  return state.restartCount < state.maxRestarts;
}

export function handleWorkerCrash(state: WorkerSupervisorState): {
  canRestart: boolean;
  nextState: WorkerSupervisorState;
} {
  if (state.restartCount >= state.maxRestarts) {
    return { canRestart: false, nextState: state };
  }
  return {
    canRestart: true,
    nextState: {
      ...state,
      restartCount: state.restartCount + 1,
    },
  };
}

export function handleRuntimeGpuError(state: WorkerSupervisorState): {
  fallbackToCpu: boolean;
  nextState: WorkerSupervisorState;
} {
  if (state.activeDelegate === "GPU" && !state.cpuFallbackAttempted) {
    return {
      fallbackToCpu: true,
      nextState: {
        ...state,
        activeDelegate: "CPU",
        cpuFallbackAttempted: true,
        rateMs: MP_INTERVAL_CPU_MS,
      },
    };
  }
  return {
    fallbackToCpu: false,
    nextState: state,
  };
}
