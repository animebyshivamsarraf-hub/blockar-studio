# BlockAR hand-startup root-cause audit — 2026-10-21

Device evidence: moto g45 5G, Android Chrome, build stamp `9371c01 2026-10-21 01:42Z`
(= local `bb42b83`). AR session live ("AR on" toast, camera feed behind UI), hand HUD
stuck at `HAND: STARTING — MEDIAPIPE FALLBACK — Please wait…`, pinch does nothing,
top-right pill shows "Camera off" while the XR camera is live.

All line numbers refer to the code at `bb42b83`.

> **ADDENDUM (2026-10-21, fixes implemented on top of local `bb42b83`):**
> F1: 75 s overall deadline (`startStartupDeadline`) + attempt token + whole
> `toggleHands` body inside try/catch + stale-runtime dispose.
> F2: engine ignores stale-session `'end'` (`isStaleSessionEnd`); pill ORs a
> 500 ms live `engine.isXR()` resync (`xrLive`).
> F3: new `hand/frameArrival.ts` `FrameArrivalWatchdog` (6 s) wired into the
> runtime; on fire → ERROR + `onNoFrames` → `markRawCameraFailed()` handoff.
> F4: 45 s race made cooperative (generation bump on timeout, timer cleared,
> no-op catch on the losing promise, landmarker resurrection guard);
> `teardown()`'s `session.end()` capped at 3 s.
> F5: `enumerateDevices()` capped at 3 s, fail-closed (rear-camera rule kept).
> F6: `hand_start_*` telemetry milestones logged through toggleHands, so Dev
> Test Logs now show exactly where a startup attempt stops.
> Tests: 95/95 PASS (82 baseline + 13 new: 6 deadline/stale-session, 7
> frame-arrival). `npm run build` PASS. `tsc --noEmit`: only the 1
> pre-existing CapabilityDetector TS2375 (also present at bb42b83).

---

## 1. The full startup path, await by await

Path: hand button → `BlockAR.toggleHands()` (`src/components/blockar/BlockAR.tsx:523`)
→ XR handoff (`hand/startupGuards.ts` `resolveXRHandoff`) → camera
(`BlockAR.allowCamera`, BlockAR.tsx:436) → `HandSystemRuntime.start()`
(`hand/HandSystemRuntime.ts:223`) → `startMediaPipe()` (:272) →
`startMediaPipeWorker()` (:383) → worker `INIT` (`hand/hand-landmarker.worker.ts:88`)
→ `TRACKING`.

| # | Await / async step | File:line | Bounded? |
|---|---|---|---|
| 1 | `resolveXRHandoff` raw-probe poll (25 × 100 ms) | startupGuards.ts:74-76 | ✅ 2.5 s |
| 2 | `settleWithin(engine.stopXR(true), 3000)` | startupGuards.ts:86 | ✅ 3 s |
| 3 | exit poll (30 × 100 ms) + release delay 350 ms | startupGuards.ts:87-91 | ✅ 3.35 s |
| 4 | `settleWithin(allowCamera(), 15000)` | BlockAR.tsx:594-595 | ✅ 15 s (but see §3 RC-5: the underlying promise keeps running and mutates state after the timeout) |
| 5 | `allowCamera` → `getUserMedia` ×2 | BlockAR.tsx:443-459 | only via #4 |
| 6 | `allowCamera` → `await isEnvironmentStream(s)` → `await navigator.mediaDevices.enumerateDevices()` | HandSystemRuntime.ts:44 | ❌ **no timeout of its own** (only the caller's 15 s race at toggle time; unbounded when reached via `acquireRearStream` in restore paths) |
| 7 | `allowCamera` → `await videoRef.current.play()` | BlockAR.tsx:477 | only via #4 (play() is known to be able to stay pending on Android) |
| 8 | `rt.start()` overall race, 45 s | HandSystemRuntime.ts:236-239 | ✅ 45 s — **but non-cooperative**: on timeout the orphaned `startup` promise keeps running and can mutate the torn-down runtime (see RC-4); the race timer is also never cleared |
| 9 | `start()` → `await this.stop()` → `teardown()` → `await s.end()` (WebXR mode only) | HandSystemRuntime.ts:225, 556-559 | ❌ **unbounded** (a wedged `XRSession.end()` hangs `start()` before the 45 s race is even armed — headsets path, not the phone path) |
| 10 | `startMediaPipeWorker` → `await ready` (READY / ERROR / onerror / 20 s timer) | HandSystemRuntime.ts:385-430 | ✅ 20 s |
| 11 | worker `init()` → `FilesetResolver.forVisionTasks()` + model fetch + `HandLandmarker.createFromOptions()` | hand-landmarker.worker.ts:35-64 | only via #10 (a stalled fetch/WASM compile inside the worker is invisible except through the 20 s timeout) |
| 12 | main-thread (desktop) `HandLandmarker.createFromOptions` race, 20 s | HandSystemRuntime.ts:349-374 | ✅ 20 s |
| 13 | `video.play()` race, 5 s (video branch) | HandSystemRuntime.ts:326-331 | ✅ 5 s |
| 14 | `createImageBitmap` in `submitVideoFrame` | HandSystemRuntime.ts:764 | ✅ via `FrameGate.expire` (BITMAP_TIMEOUT_MS 1200) in the frame loop |
| 15 | worker inference per frame | hand-landmarker.worker.ts:118-148 | ✅ via `FrameGate.expire` (WORKER_INFERENCE_TIMEOUT_MS 3500) → `restartWorker` |

**Composite worst case in XR mode is ≈ 69 s** (handoff 8.85 s + camera 15 s +
runtime 45 s) — or ≈ 48 s on the raw-camera path (no camera step) — all of it
spent in the UI state `starting` with the hand button disabled
(BlockAR.tsx:794: `disabled={hand === "starting" || hand === "initializing"}`)
and the only feedback "Please wait…".

---

## 2. Answers to the specific questions

### (a) AR mode without raw camera: what does the fallback consume? Can it wait forever for frames that never arrive?

By design it consumes **nothing** while XR owns the camera — this part is
correct and is what keeps the "never feed stale video" rule:

- `camera/CameraOwnership.ts:56-61` `frameSourceFor()`: owner `CAMERA_XR`
  (XR, no raw) → `"none"`. `BlockAR.dispatchCamera` (BlockAR.tsx:385) then calls
  `rt.setFrameSource("none")`.
- At toggle time, `toggleHands` never opens a DOM stream under a live XR
  session: `resolveXRHandoff` either returns `"raw"` (frames come from
  `XRCameraReader` via `engine.feedRawCamera` → sink → `rt.submitPixels`) or
  exits XR first and only then opens the rear DOM camera.

The wait-forever hazard is real but one level up — it is in the **frame
plumbing**, not in `start()`:

1. The sink that feeds the runtime is installed **only** inside
   `dispatchCamera`, and only when `frameSourceFor(next) === "xr"`
   (BlockAR.tsx:394-401). If camera-ownership state is wrong (see RC-3), the
   sink is never installed and no frame is ever pushed — with no error
   anywhere.
2. `engine.feedRawCamera` (engine.ts:771) early-returns unless
   `xrSession` is non-null. The stale-session clobber in RC-3 nulls
   `xrSession` while the compositor is still presenting → raw frames stop
   permanently.
3. BlockAR's `RawFrameWatchdog` (BlockAR.tsx, raw-camera watchdog effect)
   would catch stopped frames, but it only runs while
   `camState.owner === "CAMERA_XR_RAW_CAMERA"` — the same wrong state from
   RC-3 disables the watchdog too.
4. Inside the runtime, once `TRACKING` with `frameSource === "xr"`, nothing
   checked frame *arrival*: `checkVideoStall` explicitly only handles
   `frameSource === "video"` (HandSystemRuntime.ts:701-702). A worker that is
   READY but never fed would sit in TRACKING forever, silent. (**Fixed** —
   see F5 in §4.)

### (b) Does the fec286f 45 s overall startup timeout still exist? Why does the UI still show STARTING?

It exists: `HandSystemRuntime.start()`, HandSystemRuntime.ts:236-239 —

```ts
await Promise.race([
  startup,
  new Promise((_, reject) => setTimeout(() => reject(new Error("Hand tracking startup timed out (45s)")), 45000)),
]);
```

It fails to save the UI for three code-proven reasons:

1. **It only covers the last step.** `rt.start()` is awaited at
   BlockAR.tsx:647, *after* the XR handoff and camera acquisition. The UI
  `hand` state (`"starting"`, set at BlockAR.tsx:542) is a separate state
   machine that nothing bounds as a whole.
2. **The handoff section is outside the try/catch.** `await
   resolveXRHandoff(...)` is at BlockAR.tsx:569; the `try {` only opens at
   BlockAR.tsx:583. Any rejection in that section (or in the section between
   `setHand("starting")` and the try) propagates out of `toggleHands` as an
   unhandled rejection — `setHand("error")` is never reached and the button
   stays disabled forever. This is a permanent-STARTING mechanism that no
   timeout inside the runtime can fix.
3. **The timeouts stack.** Even when every layer behaves exactly as coded,
   the user waits up to ≈ 69 s in `starting`. On the device the screenshot
   was taken while the toast still read "AR on — choose a surface…" (the
   `enterXR` toast): `onSwitching`'s toast ("This phone can't share the AR
   camera…") had not fired, so at capture time execution was either inside
   the 2.5 s raw-probe window or already in `rt.start()` on the raw path
   (which never touches the toast). The runtime-never-created vs
   runtime-created distinction therefore cannot be settled from the
   screenshot alone — but both legs funnel into the same unbounded-UI defect.

### (c) Why is `camOwner.xr` false while `engine.isXR()` is true?

`camOwner` changes **only** through `dispatchCamera` (BlockAR.tsx:385), which
is fed **only** by the engine's `onXRStateChange` callback (BlockAR.tsx:132-137).
The engine fires it at: `startXR` success (engine.ts:697,
`{active:true, rawCamera:false, pending}`), first raw camera image (:776,
`rawCamera:true`), `markRawCameraFailed` (:766), and the session `'end'`
listener (:740, `{active:false}`).

The `'end'` listener has **no session-identity check** (engine.ts:736-748):

```ts
session.addEventListener("end", () => {
  …
  try { o.onXRStateChange?.({ active: false, rawCamera: false }); } catch { … }
  hitSource = null; xrSession = null; xrReferenceSpace = null;
```

and `startXR` overwrites `xrSession = session` (engine.ts:683) without ending
any previous session. `BlockAR.enterXR` (BlockAR.tsx:487-519) **retries**
`startXR` after a first failure — if attempt 1 got far enough to create a
session (session created at engine.ts:683, a later await such as
`requestReferenceSpace("viewer")` / `requestHitTestSource` throws), Chrome
ends session 1 when session 2 starts; session 1's `'end'` can fire **after**
session 2 is live, and the unguarded handler then (i) dispatches `XR_ENDED`
→ `camState.xr = false` → pill reads "Camera off", and (ii) sets
`xrSession = null` → `engine.isXR()` false and `feedRawCamera` dead — while
the three.js compositor keeps presenting session 2, so the user still sees a
live AR camera. There is also **no resync**: nothing ever re-reads
`engine.isXR()` into `camOwner`, so one missed/spurious event leaves the
pill (and the whole ownership machine, including the RawFrameWatchdog gate
and the hands-paused banner) wrong indefinitely. CODE-PROVEN as a mechanism;
the exact event ordering on the phone is a HYPOTHESIS (needs device logs).

### (d) Are the WASM + model assets present in the production build at the fetched paths?

**Yes — CODE-PROVEN (local build output, `.output/public`):**

- Code fetches `${origin}/wasm` (HandSystemRuntime.ts:13,
  hand-landmarker.worker.ts:6) and `${origin}/models/hand_landmarker.task`
  (HandSystemRuntime.ts:14, worker:8).
- `.output/public/wasm/` contains `vision_wasm_internal.js/.wasm`,
  `vision_wasm_module_internal.js/.wasm`, `vision_wasm_nosimd_internal.js/.wasm`.
- `.output/public/models/hand_landmarker.task` is present.
- The emitted worker chunk `assets/hand-landmarker.worker-*.js` and the
  `vision_bundle-*.js` chunk are present in `.output/public/assets/`.

So a 404 for model/WASM is **not** the stall cause. (Residual HYPOTHESIS,
not checkable from here: the CDN in front of the deployment must serve
`.wasm` without mangling; FilesetResolver falls back to non-streaming
instantiation, so MIME is unlikely to be fatal.)

### (e) Can "Dev Test Logs" or HandLab capture the stall point?

- **Dev Test Logs (in-app): NO.** The panel (BlockAR.tsx, `debugOpen`) shows
  only the `CapabilityReport` and the last 5 `deviceTelemetry` events.
  `deviceTelemetry.log` is called only from `CapabilityDetector` and from
  `allowCamera` (`"fallback_selected"`, BlockAR.tsx:478). Hand startup emits
  **no** telemetry — the panel cannot show where startup stalled. (Mitigated
  in this fix round: hand-startup milestones are now logged, see F6.)
- **HandLab (/hand-lab): PARTIALLY.** It renders the full `HandDiagnostics`
  (HandLab.tsx:79-83: system, backend, session string, error, fps) from its
  own `HandSystemRuntime`, so it *would* expose a worker/WASM/model stall
  (system stuck at STARTING, session string frozen before "worker · CPU").
  But HandLab has no XR session, so it cannot reproduce the XR-handoff leg
  or the stale-session clobber.
- `DiagnosticsOverlay.tsx` exists but is **not rendered anywhere** (no imports
  outside its own file).

---

## 3. Ranked root causes

### RC-1 — CODE-PROVEN · The UI startup operation has no deadline, and its first section is outside any error handling
`toggleHands` (BlockAR.tsx:523): `setHand("starting")` at :542;
`await resolveXRHandoff(...)` at :569 is **before** the `try {` at :583.
A rejection there strands the UI at STARTING forever (button disabled at
:794). Even with zero defects elsewhere, the stacked per-layer timeouts
(§1) hold the UI in STARTING for up to ≈ 69 s (XR) / ≈ 48 s (raw) with no
progress signal — indistinguishable from a hang, and the fec286f 45 s
runtime timeout (HandSystemRuntime.ts:236-239) cannot shorten the
pre-runtime legs. **This is the primary structural cause.**

### RC-2 — CODE-PROVEN · Stale XR session `'end'` clobbers the live session (pill lies, raw frames die, watchdog disarmed)
engine.ts:683 (`xrSession = session`, previous session never ended) +
engine.ts:736-748 (`'end'` handler with no identity check, unconditional
`xrSession = null` + `onXRStateChange({active:false})`). Triggered by
`enterXR`'s retry (BlockAR.tsx:494-499). Explains the screenshot's "Camera
off" pill under a live AR feed, and silently kills `feedRawCamera`
(engine.ts:771 early-return) and the `RawFrameWatchdog` gate (§2a). The
pill additionally has no resync path from `engine.isXR()`.

### RC-3 — CODE-PROVEN · No frame-arrival watchdog on the XR frame source
`checkVideoStall` covers only `frameSource === "video"`
(HandSystemRuntime.ts:701-702). In `frameSource === "xr"` TRACKING, a
READY worker that receives no frames (sink missing, `getCameraImage`
silently failing after the probe, sink `want()` never true) produces no
error, no recovery, forever. The app-level RawFrameWatchdog exists but is
gated on ownership state that RC-2 can corrupt.

### RC-4 — CODE-PROVEN · `HandSystemRuntime.start()`'s 45 s timeout is non-cooperative; teardown's session end is unbounded
On timeout, `start()` tears down and sets ERROR, but the losing `startup`
promise continues: in the video branch it can still execute
`this.stream = s; this.video.srcObject = s` (HandSystemRuntime.ts:340-346)
and `this.landmarker = await Promise.race(...)` (:374) **after** teardown
nulled them — resurrecting a worker/landmarker/stream on a runtime the host
has disposed (BlockAR disposes it in the error path). The race timer is
never cleared. Separately, `teardown()` awaits `s.end()`
(HandSystemRuntime.ts:559) with no bound, and `start()` awaits `stop()` →
`teardown()` at :225 **before** the 45 s race exists — a wedged session end
hangs `start()` itself (WebXR-headset path).

### RC-5 — CODE-PROVEN · `settleWithin(allowCamera(), 15 s)` abandons the promise but not its side effects
If `getUserMedia` answers after the 15 s timeout (camera still held by the
just-ended XR session), `allowCamera` keeps executing: it overwrites
`streamRef.current`, calls `setCamOk(true)`, attaches track listeners,
assigns `video.srcObject`, and sets a "Rear camera ready" toast
(BlockAR.tsx:436-483) — after `toggleHands` has already errored and
disposed the runtime. State corruption across attempts, and a second
`allowCamera` completion can fight the retry attempt. (Same pattern,
lower stakes: `acquireRearStream` in restore paths.)

### RC-6 — CODE-PROVEN (minor) · `isEnvironmentStream` awaits `enumerateDevices()` unbounded
HandSystemRuntime.ts:44. Only the caller's race bounds it at toggle time;
in restore paths it is unbounded. A wedged `enumerateDevices` (seen on
Android after permission churn) stalls camera validation indefinitely.

### RC-7 — HYPOTHESIS (needs device evidence) · The on-device stall leg itself
Most probable device-side leg, given the unchanged enterXR toast: the raw
path's worker initialisation — `FilesetResolver.forVisionTasks` +
`ensureModuleFactory` fetch/eval + `HandLandmarker.createFromOptions` on
CPU (Dimensity 6300) — consuming the worker's 20 s and then the runtime's
45 s while the user reasonably concluded "hang". Alternative: RC-2's
ordering fired and startup took the getUserMedia-under-live-XR leg.
Discriminator: after this fix round, Dev Test Logs will show the last
hand-startup milestone reached (F6), and HandLab's session string shows
whether the worker ever posts READY on this phone.

---

## 4. Fixes applied (this commit)

- **F1 (RC-1)** `hand/startupGuards.ts`: new `startStartupDeadline()` —
  a one-shot, cancellable deadline (injectable timers). `BlockAR.toggleHands`:
  the whole body (handoff included) is now inside the try/catch; a 75 s
  deadline forces `hand = "error"` (retryable) + disposes the half-built
  runtime; a per-attempt token makes late completions of a dead attempt
  abort instead of mutating state.
- **F2 (RC-2)** `engine.ts`: the session `'end'` handler ignores stale
  sessions (`isStaleSessionEnd(xrSession, session)`, helper in
  `hand/startupGuards.ts`); `BlockAR` pill now also ORs in a live
  `engine.isXR()` value resynced on an interval, so the pill reflects the
  engine's real XR state even if an event is missed.
- **F3 (RC-3)** new pure `hand/frameArrival.ts` `FrameArrivalWatchdog`;
  `HandSystemRuntime` arms it on entering TRACKING with
  `frameSource === "xr"` (and on switching to `"xr"` while TRACKING),
  feeds it on every consumed result, and on expiry sets ERROR and fires
  `onNoFrames` → BlockAR calls `engine.markRawCameraFailed()`, which runs
  the existing ownership handoff (exit XR for hands → DOM camera restore).
  The DOM-video source keeps its existing stall watchdog.
- **F4 (RC-4)** `HandSystemRuntime.start()`: race timer cleared on settle;
  on timeout the generation is bumped **before** teardown so the orphaned
  startup aborts at its checkpoints (explicit generation check before the
  landmarker assignment in the video branch); the losing promise gets a
  no-op catch; `teardown()`'s `session.end()` is raced against 3 s.
- **F5 (RC-6)** `isEnvironmentStream`: `enumerateDevices()` raced against
  3 s; timeout ⇒ "not confirmed rear" (fail-closed, callers already treat
  that as an honest error / retry).
- **F6 (§2e)** `CapabilityDetector` telemetry union extended with
  `hand_start_*` events; `toggleHands` logs begin / handoff / camera /
  runtime / tracking / error / timeout milestones so the in-app Dev Test
  Logs (last 5 events) now show exactly where startup stopped.
- RC-5 is mitigated by F1's attempt token (late `allowCamera` completions
  can no longer resurrect a dead attempt's UI state; the stream it opens is
  the same rear stream a retry would use).

Regression tests: `hand/startup-guards.test.ts` (deadline fires once,
cancel prevents firing, stale-session predicate),
`hand/frame-arrival.test.ts` (arm/feed/expiry semantics).

## 5. What would still confirm the device-side leg

One screen recording (or a Dev Test Logs screenshot after this build) of a
hand-toggle attempt in AR: the last `hand_start_*` milestone + whether an
ERROR appears, plus — if it still stalls — the HandLab session string on
the same phone. That single artifact separates RC-7's two candidates.
