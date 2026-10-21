# BlockAR — Root-Cause Investigation & End-to-End Repair, ROUND 2 (2026-10-21)

**Authorship (honest):** This round was executed by the parent agent's worker
after Antigravity's quota was exhausted mid-task. It is NOT Antigravity's work.
Spec followed: `AGY_ROUND2_TASK.md`. Round-1 fixes (`ROOT_CAUSE_FINAL_2026-10-21.md`,
live in build `119e212`) were NOT redone or reverted.

**Decisive symptom (owner's Android phone, live build 119e212):** hand startup
completes into **"HAND: LOST · MEDIAPIPE FALLBACK · Looking for hand…"** and
stays there forever. WebXR AR also unreliable on the phone.

Labels: **VERIFIED** = proven by code trace / installed-package typings / test run.
**HYPOTHESIS** = evidence points at it, not proven. **UNKNOWN** = no evidence exists.

---

## 1. Confirmed root causes + file:line evidence

### RC-1 (VERIFIED — primary): the video-fallback frame chain had NO liveness supervision and NO telemetry, so every possible break was silent and identical

The phone's hand path is the MediaPipe **worker** path on the DOM `"video"`
frame source. Tracing that chain end-to-end in `HandSystemRuntime.ts`
(line numbers = pre-repair file):

- The no-result watchdog (`FrameArrivalWatchdog`) was armed **only** for the
  XR frame source — `armFrameArrival`, old `:533-535`:
  `if (backend === "MEDIAPIPE" && frameSource === "xr") arm else disarm`.
  On the video fallback it was permanently disarmed, so "TRACKING but no
  result ever arrives" could never fire `checkFrameArrival` (old `:539-546`).
- Worker `DETECT_ERROR` replies were swallowed — old `:454-456`: the handler
  only assigned `this.error` and looped. The system stayed `TRACKING`, and the
  host (`BlockAR.tsx` diagnostics callback) only reacts to `system === "ERROR"`,
  so a per-frame detection failure ran forever, invisible, with the HUD stuck
  at "Looking for hand…".
- `createImageBitmap(...)` failure was swallowed — `submitVideoFrame` old
  `:824` + catch old `:839`: a bare `gate.finish(id)`, no counter, no
  escalation. If bitmap creation rejects/hangs per frame on the device, zero
  frames ever reach the worker, silently.
- `video.play()` failure was swallowed — `startMediaPipe` old `:357` catch:
  "continue anyway; the watchdog will catch a stalled video" — but see RC-2:
  that watchdog could not catch the never-started case.
- Frame submission is gated on `v.readyState >= 2` (old `:788`). An element
  stuck below `HAVE_CURRENT_DATA` submits nothing and logs nothing.
- The pipeline kept **no counters at all**: nothing recorded frames
  submitted, results received, results with landmarks, drops, or detect
  errors — so even with a Dev Test Logs screenshot there was no evidence to
  distinguish the broken link.

### RC-2 (VERIFIED): the video stall watchdog was blind from t=0

- `lastVideoAdvanceT` initialises to `0` (`:129`) and the stall test requires
  `lastVideoAdvanceT > 0` (`checkVideoStall`, `:768`). It is only set when a
  frame advances (`sampleMediaPipe`, `:790`) or in `setFrameSource` (`:556`) —
  but the initial `startMediaPipe` assigns `this.frameSource` directly and
  never calls `setFrameSource`. A video whose clock never advances from the
  start is therefore invisible to the stall watchdog forever.

### RC-3 (VERIFIED): the worker path is phone-only and was never exercised end-to-end by any machine test

- `:90` — mobile UA ⇒ CPU delegate; `startMediaPipe` sends phones to
  `startMediaPipeWorker`, desktops to a main-thread `HandLandmarker`
  (LIVE_STREAM + resultCallback). Round-1's desktop E2E (fake camera)
  exercised the **main-thread** path and verified the system reaches
  `TRACKING` — never the worker FRAME→RESULT→landmarks chain, and never a
  detected hand (a fake camera contains no hand). "Desktop reaches TRACKING"
  and "phone reaches TRACKING" are the same state; the phone-only worker
  chain in between had unit coverage of its policies only.

### What DID work on the phone (VERIFIED by host-logic elimination)

The owner saw hand **"on"** (not "error"). `BlockAR.tsx toggleHands` sets
hand "on" only after `rt.start(...)` resolves AND `rt.getSystem() ===
"TRACKING"`, and the diagnostics callback flips to "error" if the runtime
later reports `system === "ERROR"`. Therefore on the device: getUserMedia
succeeded, the stream was accepted as rear camera, the worker completed
INIT → READY (CPU delegate), and the system entered TRACKING. **The break
is strictly between TRACKING-entry and the first consumed landmark result.**

### UNKNOWN — which link inside RC-1's hole is broken on the device

Candidates, today indistinguishable *because of* RC-1: (a) frames never
submitted (readyState/clock — RC-2 made this silent); (b) `createImageBitmap`
rejects/hangs per frame on the Dimensity 6300's Chrome; (c) worker replies
`DROPPED` every frame; (d) `detectForVideo` throws per frame → DETECT_ERROR
loop; (e) results return but always with empty landmarks (blank frames /
detection failing on real frames). The repair instruments all five,
self-recovers (a)–(d), and makes (e) provable from one screenshot
(results > 0, landmarks = 0 while a hand is in view).

### Verified NON-defects (checked, deliberately untouched)

- **Worker RESULT contract is correct.** Installed `@mediapipe/tasks-vision`
  1.0.1 typings: `HandLandmarkerResult { landmarks: NormalizedLandmark[][]; handedness: Category[][] }`
  (`node_modules/@mediapipe/tasks-vision/vision.d.ts:919, 1038-1050`). The
  worker posts exactly `{ landmarks, handedness }`
  (`hand-landmarker.worker.ts`, RESULT branch) and the runtime consumes
  exactly those fields (`consumeMediaPipeResult`).
- **Timestamps:** the worker enforces strictly increasing timestamps via
  `computeStrictTimestamp` (`workerPolicy.ts`).
- **Delegate fallback is wired:** worker INIT GPU→CPU on failure, runtime
  GPU→CPU via `RUNTIME_FALLBACK` on inference error (`hand-landmarker.worker.ts`).
- **Pinch → block chain is connected in fallback mode.** Runtime
  `processHand` → `onPinchWorld` → host callback → `engine.handSamplePoint`.
  The deployed engine's gate `xrHandTrackingEnabled` **defaults to `true`**
  (`DEPLOYED_ENGINE_CURRENT.ts:445`; the host only ever sets it `false` on
  hand-off and `true` on the WebXR branch) — so fallback pinch samples are
  NOT dropped by the engine. The chain is blocked only by the missing
  landmarks upstream (RC-1), not by a second break.
- **XR engine lifecycle:** raw-camera contract is honest ("no", no fake
  producer), stale-session guard and end-previous-session repair are present
  (`DEPLOYED_ENGINE_CURRENT.ts:750-776, 812-834`). Phone-side WebXR
  unreliability: **UNKNOWN** — no code defect proven this round; one
  HYPOTHESIS recorded: if `requestHitTestSource` is unavailable the session
  "starts" but the reticle/anchor never engages. No speculative engine patch
  was made, and **`DEPLOYED_ENGINE_REPAIRED2.ts` was intentionally not
  created — there are zero engine diffs this round.**

---

## 2. Changed files + exact fixes

| File | Fix |
|------|-----|
| `src/components/blockar/hand/pipelineStats.ts` | **NEW.** Pure, time-injected `PipelineStatsTracker` (framesSubmitted, bitmapFailures, resultsReceived, resultsWithLandmarks, droppedFrames, detectErrors + consecutive run, playFailures, workerRestarts, msSinceLastResult/Landmark) and liveness policy: `shouldEscalateDetectErrors` (threshold 5), `noResultAction(source, strikes, canRestartWorker)` → handoff / restart-worker / rearm / error / none. |
| `src/components/blockar/hand/HandSystemRuntime.ts` | (a) `armFrameArrival` now arms the no-result watchdog for **every** live frame source (video included), fixing RC-1's supervision hole. (b) `checkFrameArrival` acts per policy: XR → existing host handoff; video+worker strike 1 → restart worker once; strike 2 (or main-thread second strike) → real retryable `ERROR` ("Camera is live but hand detection is producing no results — tap Hand to retry"); re-arms instead of striking while a worker (re)start is legitimately in its init window. (c) DETECT_ERROR replies are counted and escalate to a worker restart after 5 consecutive (a wedged detector is no longer an infinite silent loop). (d) Counters wired: frameSubmitted (video + XR pixel paths), bitmapFailed, dropped, playFailed (startup / rebind / stall-retry), workerRestarted, result+landmark counts in `consumeMediaPipeResult` (also clears no-result strikes). (e) RC-2 fix: at TRACKING entry the stats reset and `lastVideoAdvanceT = performance.now()`, so the stall watchdog covers a video that never advances from t=0 (one play() retry, then camera restore via the existing path). (f) `HandDiagnostics` gains `pipeline` (counters + worker delegate/ready + video readyState/dimensions/paused) via new `getPipelineStats()`, emitted on every diagnostics update. |
| `src/components/blockar/BlockAR.tsx` | Diagnostics callback logs `hand_pipeline_stats` to the Dev Test Logs telemetry, throttled to ~4 s, with compact meta: `src, del, rdy, f, res, lm, drop, de, bf, pf, vid=<readyState>/<w>x<h>[P], lastResMs, lastLmMs`. The Dev Test Logs panel now renders telemetry `meta` (previously only the event name was shown, so meta was invisible in screenshots). |
| `src/components/blockar/device/CapabilityDetector.ts` | Added `"hand_pipeline_stats"` to the telemetry event union. |
| `src/components/blockar/hand/pipeline-liveness.test.ts` | **NEW** — 19 machine tests (see §4). |
| `ROOT_CAUSE_ROUND2_2026-10-21.md` | This report. |

Untouched by design: local `src/components/blockar/engine.ts` (ZIP lineage),
the deployed engine (no diff needed — see §1), the worker file (its
RESULT/DROPPED/DETECT_ERROR contract was already complete), all round-1 fixes.

---

## 3. Verified camera → worker → landmarks → pinch → block data flow

```
Rear camera (getUserMedia, exactly-one-stream — round 1)
  → <video> (srcObject guard + play(), play failures now COUNTED)
  → runtime frame loop: readyState ≥ 2 gate; currentTime-advance tracking
    (stall clock starts at TRACKING entry — RC-2 fix)
  → submitVideoFrame: FrameGate (1 in flight) → createImageBitmap 480×270
    (failures COUNTED) → worker FRAME {frameId, bitmap, timestampMs}
  → worker: detectForVideo (strictly increasing ts) → RESULT / DROPPED /
    DETECT_ERROR (errors COUNTED; 5 consecutive → worker restart)
  → runtime onmessage: token-checked gate.finish → consumeMediaPipeResult
    (result + landmark counts recorded; strikes cleared)
    → mpFrame (screen px) → liftLandmarks → processHand
    → hand status LOST → TRACKING only on real lifted points
    ("HAND: TRACKING" can never be shown without consumed landmark results)
  → PinchStateMachine (ratio hysteresis, unit-tested below)
  → onPinchWorld → engine.handSamplePoint (gate defaults enabled)
  → block placement / grab-move via GrabController3D

Supervision (new): FrameArrivalWatchdog armed for ALL sources while
TRACKING — 6 s with no consumed result ⇒ worker restart (video, once) ⇒
retryable ERROR; XR ⇒ existing camera handoff. Pipeline counters stream
into the Dev Test Logs every ~4 s while hands are on.
```

Machine-verified links: counter/policy logic (§4 tests), watchdog semantics
(round-1 `frame-arrival.test.ts`), pinch state machine (§4), worker policy
(round-1 suites), full typecheck/build (§4). Device verification: §6.

---

## 4. Build, typecheck, tests — actual results (this machine, real command output)

- `npx vitest run` → **Test Files 14 passed (14), Tests 119 passed (119)**
  (baseline before this repair: 13 files / 100 tests; +19 new, 0 regressions).
- `npm run build` → **PASS** ("✓ built in 1.33s"); the new strings
  ("hand detection is producing no results", "hand_pipeline_stats") are
  present in the built client chunks
  (`.output/public/assets/HandSystemRuntime-*.js`, `routes-*.js`).
- `npx tsc --noEmit` → exactly **1 error, pre-existing**:
  `CapabilityDetector.ts(195,3) TS2375` (documented in round 1; unrelated to
  this round's one-line union addition at the top of that file). No new errors.

New tests (`pipeline-liveness.test.ts`, 19) cover: counter independence;
empty-vs-landmark result distinction (the decisive phone evidence);
msSince null-before-first-result; reset; DETECT_ERROR escalation threshold
and its reset on any result; `noResultAction` for XR handoff / video
restart-once / rearm / error / none; PinchStateMachine open→pinching→
pinched→held, aborted pinch, sustained release, reset.

Phase-4 scenario coverage map (existing suites, all passing): camera
permission denial + bounded startup (`startup-guards.test.ts`,
`startup-regression.test.ts`), worker timeout/crash/restart bounds
(`worker-stability.test.ts`, `frame-pipeline.test.ts`), slow model loading
(40 s budget, round 1), duplicate-stream prevention + repeated start/stop +
XR session cleanup + fallback recovery (`camera/mobile-fixes.test.ts`,
`camera/freeze-recovery.test.ts`, `camera/xr-handoff.test.ts`,
`hand/deployed-combination.test.ts`), pinch detection (new, above), block
placement geometry (`build/straight.test.ts`, `hand/phase1.test.ts`).

---

## 5. Commit / deployment

NOT DONE by worker — parent will push/deploy.

(Local commit of exactly the files in §2 was made by the worker for parent
review; no push, no deploy, no live-stamp claim.)

---

## 6. Android phone: VERIFIED vs UNTESTED

**There is no Android device available to this worker. Everything
phone-side is UNTESTED.**

- VERIFIED (machine only): all §4 results; code traces in §1/§3; worker
  result contract against the installed MediaPipe typings.
- UNTESTED on the device: whether frames now flow on the Moto G45 /
  Dimensity 6300; which of the RC-1 candidate links (a)–(e) was the broken
  one; the new self-recovery behaviour; pinch-to-block on the phone;
  WebXR reliability.

Honest expectation: if the device's break is a wedged detector, starving
bitmaps, a DROPPED loop, or a DETECT_ERROR loop, this build now recovers or
fails loudly with a retryable error instead of sitting in "LOST" forever.
If results return with empty landmarks while a hand is clearly in view
(candidate (e)), this build will *prove* it via the counters — that outcome
needs the evidence in §7 before any further patch; no speculative fix for
(e) was attempted.

---

## 7. Remaining issues + exact device evidence the owner must capture next

1. Install the new build (parent will supply the deployed stamp), open
   BlockAR, allow the camera, tap **Hand**, hold a hand in front of the
   rear camera for ~15 seconds.
2. Open **Dev Test Logs** and screenshot the `hand_pipeline_stats` lines.
   They decide everything:
   - `f:0` + `vid:0/…` or `vid:1/0x0` → video never became readable
     (stream/element problem — check `pf` play failures).
   - `f:0` + `bf` growing → `createImageBitmap` is failing on this device.
   - `f` growing + `drop` growing + `res:0` → worker is dropping frames.
   - `f` growing + `de` growing → per-frame detection errors (the log's
     restart counter `res` staying 0 with worker restarts visible in the
     session line confirms the escalation fired).
   - `res` growing + `lm:0` while a hand is in view → detection runs but
     finds nothing in the frames (candidate (e)) — next step is frame
     content inspection, NOT more pipeline patches.
   - `lm` growing → landmarks flow; if the HUD still says LOST, the break
     is downstream (lift/status) and the same screenshot proves it.
3. Also screenshot whatever the hand button shows after ~30 s (TRACKING /
   ERROR text) — the new build must not sit silently at LOST: it either
   tracks, restarts the worker once, or shows the retryable error.
4. For WebXR: one screenshot of what happens on "Start WebXR AR" (session
   opens? reticle appears? error toast text?) — currently UNKNOWN, no code
   defect proven.
