/**
 * Bounded startup guards for the hand-tracking startup path.
 *
 * Every await in startup must settle in bounded time: a promise that never
 * resolves (a wedged XRSession.end(), a getUserMedia that never answers)
 * otherwise leaves the UI at "Hand: STARTING" forever with the button
 * disabled — the user cannot even retry. These helpers convert every such
 * hang into either progress or an honest, retryable error.
 */

export type SettleOutcome<T> = { settled: true; value: T } | { settled: false };

/**
 * Race a promise against a timeout WITHOUT rejecting on timeout: resolves
 * { settled: false } when the step hangs. Rejections of the promise itself
 * still propagate, so callers keep their existing error handling.
 */
export function settleWithin<T>(p: Promise<T>, ms: number): Promise<SettleOutcome<T>> {
  return new Promise<SettleOutcome<T>>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ settled: false }), ms);
    p.then(
      (value) => { clearTimeout(timer); resolve({ settled: true, value }); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/** Minimal engine surface the XR handoff decision needs (structural — the real Engine satisfies it). */
export interface XRHandoffEngine {
  isXR(): boolean;
  rawCameraState(): "pending" | "yes" | "no";
  stopXR(preserveAnchor?: boolean): Promise<void>;
}

export type XRHandHandoff =
  /** No XR session — proceed with the plain DOM-camera path. */
  | { kind: "none" }
  /** XR session exposes Raw Camera Access — AR stays on and feeds the hand worker. */
  | { kind: "raw" }
  /** AR is gone. stoppedByUs=true when we ended it (the old stream is unusable and the camera needs a release delay). */
  | { kind: "exited"; stoppedByUs: boolean }
  /** AR refused to end within the bounded wait — startup must surface an error, never hang. */
  | { kind: "stuck" };

export interface XRHandoffOptions {
  /** Raw-camera probe: polls × interval (matches the historical 25 × 100ms). */
  probePolls?: number;
  probeIntervalMs?: number;
  /** Max wait for stopXR()'s own promise — XRSession.end() can wedge on Android Chrome. */
  stopTimeoutMs?: number;
  /** After stopXR, poll isXR() this long for the 'end' event to land (30 × 100ms historically). */
  exitPolls?: number;
  exitPollIntervalMs?: number;
  /** Let Android release the camera from the AR session before reopening it. */
  releaseDelayMs?: number;
  /** Fired once when we are about to leave AR because it cannot share its camera. */
  onSwitching?: () => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Decide how hand startup proceeds while an AR session may be active.
 *
 * Mirrors the historical toggleHands flow exactly (probe raw camera → keep AR
 * if raw works → otherwise leave AR, wait for the camera release, reopen the
 * DOM camera) except that NO step can hang forever: stopXR is raced against
 * stopTimeoutMs, and if the session still has not ended after the exit poll
 * the result is "stuck" instead of an eternal STARTING state.
 */
export async function resolveXRHandoff(engine: XRHandoffEngine, opts: XRHandoffOptions = {}): Promise<XRHandHandoff> {
  const sleep = opts.sleep ?? defaultSleep;
  const probePolls = opts.probePolls ?? 25;
  const probeIntervalMs = opts.probeIntervalMs ?? 100;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 3000;
  const exitPolls = opts.exitPolls ?? 30;
  const exitPollIntervalMs = opts.exitPollIntervalMs ?? 100;
  const releaseDelayMs = opts.releaseDelayMs ?? 350;

  if (!engine.isXR()) return { kind: "none" };

  // Wait for the raw-camera probe to conclude (bounded, as before).
  for (let i = 0; i < probePolls && engine.isXR() && engine.rawCameraState() === "pending"; i++) {
    await sleep(probeIntervalMs);
  }
  if (engine.isXR() && engine.rawCameraState() === "yes") return { kind: "raw" };
  if (!engine.isXR()) return { kind: "exited", stoppedByUs: false };

  // AR cannot feed hands on this phone: leave AR (anchor kept) and hand the
  // camera back to MediaPipe. stopXR itself is bounded — its promise hanging
  // must not hang startup; the session may still end during the exit poll.
  opts.onSwitching?.();
  await settleWithin(engine.stopXR(true).catch(() => {}), stopTimeoutMs);
  for (let i = 0; i < exitPolls && engine.isXR(); i++) {
    await sleep(exitPollIntervalMs);
  }
  if (engine.isXR()) return { kind: "stuck" };
  await sleep(releaseDelayMs); // let Android release the camera from the AR session
  return { kind: "exited", stoppedByUs: true };
}
