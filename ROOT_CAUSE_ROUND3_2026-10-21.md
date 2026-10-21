# BlockAR Studio — Round 3 Root-Cause & Repair Report (2026-10-21)

Scope: exercise the phone's actual hand-tracking path (Web Worker + CPU
delegate + rear-camera fallback) end-to-end **on this machine**, fix what
provably breaks, audit the deployed WebXR engine, and leave the phone-side
question answerable with evidence. All Round-1 and Round-2 fixes are
preserved (startup deadline, stale-session guard, exactly-one-stream, 40 s
worker budget, pipeline counters, liveness supervision, DETECT_ERROR
escalation).

**Honesty boundary:** everything below labelled MACHINE was verified on
this machine (headless Chromium, fake camera). None of it is Android
verification. The owner's phone remains **UNTESTED** — see §8.

---

## 1. Root causes (with file:line)

### RC-A — The "stuck at Looking for hand…" failure class is a FRAMING failure, reproduced exactly on this machine (root cause of the *class*; the phone's individual cause is still UNKNOWN)

Round 2 left five candidate explanations for the phone symptom (worker
READY, results flowing or not, landmarks never arriving). Round 3 built a
harness that drives the **real production worker + real model + real wasm**
and the **full production app** with a fake camera, and reproduced the
owner's exact symptom in-app:

- App E2E run 1: HUD stuck at `HAND: LOST · MEDIAPIPE FALLBACK ·
  Looking for hand…` for 90+ s with counters **f=798, res=797, lm=0** —
  frames submitted, worker answering, **zero results with landmarks**,
  zero drops/errors, video element healthy (readyState 4, 640×480,
  currentTime advancing).
- The exact camera frame from that run, fed to the bare worker, scored
  **0/8** (`scripts/e2e/fixtures/frame-from-clip.jpg`): the clip framed
  the hand as an extreme palm close-up with no hand outline or fingers —
  **content the model legitimately cannot recognise**. The pipeline was
  never broken; nothing in the app could distinguish this state from a
  dead pipeline, and the user got one eternal, unactionable message.

Fix: the app now detects this counter pattern itself and tells the user
the fixable thing — see D4 in §2. Whether the phone's failure is this
framing class or a device-specific break is **UNKNOWN** until the
`hand_pipeline_stats` evidence in §8 is captured; `lm` growing vs
`res`-growing/`lm:0` decides it, and the app now surfaces the framing
case on its own.

### D1 — Host offered WebXR AR in exactly the case its own policy says AR cannot work (PROVEN, code)

`BlockAR.tsx` gated the "Start WebXR AR" button and the permission
screen's AR UI on `cap.immersiveArSupported` alone (pre-fix line 172:
`setXrOk(cap.immersiveArSupported)`), while the capability detector's
backend policy (`device/CapabilityDetector.ts:176-190`) requires
`immersiveArSupported && hitTestSupported`, and the deployed engine
makes hit-test a **required** session feature
(`DEPLOYED_ENGINE_CURRENT.ts:777-781`). On a device with immersive-ar but
no hit-test, the app offered AR that could only reject at
`requestSession`. Fixed in `BlockAR.tsx:136` (gate on both; the detector's
fallback messaging takes over otherwise).

### D2 — Deployed engine `startXR` was not atomic: a mid-setup failure orphaned a live XR session (PROVEN, code)

In `DEPLOYED_ENGINE_CURRENT.ts:782-793`, `xrSession = session` is assigned
and `renderer.xr.setSession(session)` awaited **before** the reference
space and hit-test source are set up, with no try/catch around the span.
If any later step rejected, the error propagated to the host (which
believes AR failed and restores camera mode) while a live, presenting
session stayed parked in `xrSession` — `isXR()` true, camera held by the
orphaned session, silently breaking the rear-camera hand fallback until
some later retry happened to end it. Fixed in
`DEPLOYED_ENGINE_REPAIRED3.ts` (setup wrapped; on failure the session is
ended, all XR state cleared, error rethrown into the host's existing
retry path).

### D3 — Hit-test source never cancelled on session end (PROVEN, minor)

`DEPLOYED_ENGINE_CURRENT.ts` 'end' handler (lines 836-851) dropped
`hitSource` without `cancel()`. Fixed in `DEPLOYED_ENGINE_REPAIRED3.ts`.

### REFUTED — Round-2 hypothesis "requestHitTestSource is missing"

It is **not** missing. The deployed engine requests it
(`DEPLOYED_ENGINE_CURRENT.ts:791`), stores it, and consumes it every
frame until anchored (`:907`, `frame.getHitTestResults(hitSource)`).
Anchoring was never broken by absence of hit-test in this engine.

### Residual risks (not proven defects; recorded, not patched blind)

- `startXR` ends a stale session without awaiting its 'end' before
  `requestSession` (`DEPLOYED_ENGINE_CURRENT.ts:771-776`). A browser may
  reject a new immersive session requested in that window; the host
  already retries once, and D2's atomic cleanup now guarantees the retry
  starts from a clean state.
- The runtime drops frames submitted while a detect is in flight
  (by design). On a slow phone CPU this lowers the effective rate;
  whether it matters on the owner's device is measurable from the same
  `hand_pipeline_stats` evidence (`f` vs `res` growth).
- The `frameSource: "xr"` path stays unreachable: the engine's raw-camera
  contract is honestly `"no"` (`rawCameraState: () => "no"`,
  `setXRCameraSink` stores only). Rear-camera MediaPipe fallback is the
  supported hand path outside AR — unchanged.

---

## 2. Changed files (this round)

| File | Change |
|---|---|
| `src/components/blockar/hand/pipelineStats.ts` | `FRAMING_HINT_MIN_RESULTS` (30) + `shouldShowFramingHint()` (:127-131): true when ≥30 results arrived and none contained landmarks. |
| `src/components/blockar/hand/HandSystemRuntime.ts` | `PipelineDiagnostics.framingHint` (:32) computed in `getPipelineStats()` (:1071) from the same snapshot already used for telemetry. |
| `src/components/blockar/device/CapabilityDetector.ts` | Telemetry event union += `"hand_framing_hint"`. (The pre-existing TS2375 in this file is untouched.) |
| `src/components/blockar/BlockAR.tsx` | (a) AR UI gate: `xrOk = immersiveArSupported && hitTestSupported` (:136) — D1. (b) Framing hint (:695-706): once-per-transition telemetry + toast ("Camera chal rahi hai, lekin haath saaf nahi dikh raha — haath pura frame me, thoda door, roshni me rakho"); hand button sub-text shows "Whole hand in frame?" while the hint is active; latch resets when hands are turned off (:578). |
| `DEPLOYED_ENGINE_REPAIRED3.ts` | **NEW** — byte-copy of `DEPLOYED_ENGINE_CURRENT.ts` + only: header note, atomic `startXR` (D2), `hitSource?.cancel()` in the 'end' handler (D3). Parent pushes this as `src/components/blockar/engine.ts` via the established snapshot route; local `engine.ts` was NOT edited (verified restored via git). Compiles in-project: swapped in, `npm run build` PASS, restored. |
| `src/components/blockar/hand/pinch-replay.test.ts` | **NEW** — 6 tests replaying REAL recorded model landmarks through the runtime's transform chain into `PinchStateMachine` (§4). |
| `src/components/blockar/hand/engine-contract.test.ts` | **NEW** — 6 tests pinning REPAIRED3 invariants: hit-test required + requested + consumed, atomic start, cancel-on-end, stale-session guard intact, honest raw-camera (no fabricated sink frames). |
| `src/components/blockar/hand/pipeline-liveness.test.ts` | +4 framing-hint policy tests (below threshold quiet; fires at ≥30 results/0 landmarks; never after any landmark result; reset clears). |
| `scripts/e2e/**` | **NEW** — kept machine-only harness suite: `worker-harness.*` (real worker chunk + model + wasm), `app-e2e.mjs` (full app, mobile UA + touch, fake camera), `frame-content-test.mjs`, `make-hand-clip.sh`, `make-pinch-clip.sh`, `serve.mjs`, fixtures (real CC-licensed hand photos, recorded landmark JSONs, evidence frames), and `results/` (run outputs incl. screenshots). Labelled machine-only in every file header. |

No Round-1/Round-2 code was reverted or weakened; `src/components/
blockar/engine.ts` untouched.

---

## 3. Harness evidence — actual frames / results / landmarks (MACHINE)

Harness: Playwright Chromium, mobile UA (moto g45 5G, Chrome 141), the
app's **real built worker chunk** (`hand-landmarker.worker-*.js`), real
`/models/hand_landmarker.task`, real `/wasm`, frames as 480×270
ImageBitmaps with strictly increasing timestamps (exactly what
`HandSystemRuntime` submits). Full outputs in `scripts/e2e/results/`.

**Worker harness (bare worker):**

| Input | Result |
|---|---|
| INIT (CPU delegate) | READY in **842-1010 ms** |
| Open-hand photo (real photo, `fixtures/hand-open.jpg`) | **8/8 frames with 1 hand** — static, pan, big-timestamp, native-size modes; CPU and GPU |
| Blank/dark frame | RESULT with **0 landmarks** on 3/3 — never silence |
| Pinch photo (`fixtures/hand-pinch.jpg`) | static 0/5, big-ts 0/5, **pan 5/5, native 5/5** — this pose is motion/size-sensitive |
| FRAME with no image | DROPPED "empty frame" reply — every FRAME gets exactly one reply (protocol contract holds) |

**Full-app E2E (production build served locally, fake video capture):**

| Run | Counters / outcome |
|---|---|
| Run 1 — symptom reproduction | f=798, **res=797, lm=0**, drop=0, de=0, bf=0, pf=0, video healthy; HUD stuck at "Looking for hand…" 90+ s. Cause isolated to frame **content** (that frame scores 0/8 in the bare worker). |
| Run 2 — whole hand framed | f=83, res=82, **lm=82**; HUD reached "HAND: TRACKING · Hand detected". |
| Pinch run (Round-3 build, open→pinch→open clip) | **`pinch_detected` telemetry fired; "HAND: PINCHING" observed; blocks in scene = 2**; final counters f=65, res=65, **lm=65**; a mid-run `hand_lost` recovered on its own ("Hand recovered" toast). Screenshot: `scripts/e2e/results/app-e2e-pinch.png` (header "2 blocks", skeleton rendered, TRACKING). |
| Open-hand regression (Round-3 build) | f=59, res=58, **lm=58**, TRACKING from the first poll; framing hint correctly did NOT fire. |

Conclusion: the worker chain INIT→READY→FRAME→RESULT→landmarks→TRACKING
and the pinch→block chain both work end-to-end **on this machine** with
recognisable hand content. The one failure mode that reproduces the
owner's symptom is results-with-zero-landmarks (framing/content), which
the app now diagnoses itself (D-framing, §2).

---

## 4. Pinch → block

- **Unit replay (REAL data):** `pinch-replay.test.ts` — landmarks recorded
  from the real model (open ratio 0.482, pinch ratio 0.222 vs thresholds
  start 0.28 / release 0.42) replayed through screen-mapping →
  `liftLandmarks` → ratio → `PinchStateMachine`: open pose stays OPEN
  across 10 frames (no false pinch); pinch pose goes PINCHING → PINCHED,
  holds without flicker, yields a finite pinch point; release returns
  RELEASING → RELEASED → OPEN. **6/6 PASS.**
- **In-app (MACHINE):** pinch run above — pinch strokes in the fake
  camera feed produced **2 placed blocks** in the live app, counted in
  the app's own header. This is the first machine run in which the full
  pinch→block path (camera → worker → landmarks → pinch machine →
  engine placement) is proven end-to-end.
- **On the phone: UNTESTED.** No Android device exists here.

---

## 5. WebXR — actual status

Audited in the deployed engine (`DEPLOYED_ENGINE_CURRENT.ts`, blob
`4e9ff1aa` = what production runs):

- `requestSession("immersive-ar", …)` (:777-781): `requiredFeatures:
  ["hit-test"]`; optional: dom-overlay, anchors, hand-tracking,
  local-floor. Reference space `local-floor` with `local` fallback
  (:786-789); viewer space for hit-test (:790); hit-test source created
  (:791) and consumed per frame until anchored (:907).
- Session lifecycle: stale session ended before a new request
  (:771-776); 'end' handler guarded by `isStaleSessionEnd` (:836-851)
  with sink/state cleanup and a 150 ms delayed host notification;
  `stopXR` preserves the anchor by default (:989-992). AR-end →
  hand-restart at host level is covered by existing tests
  (`camera/xr-handoff.test.ts`, `hand/deployed-combination.test.ts`) —
  not duplicated.
- Defects found and fixed: **D1** (host AR gate), **D2** (non-atomic
  start), **D3** (hit-source cancel) — §1/§2. Pinned by
  `engine-contract.test.ts` (6/6 PASS).
- Compatibility truth: immersive-ar + hit-test availability is
  device/browser-dependent. The detector already measures it at runtime
  and selects the rear-camera fallback with an honest reason when absent;
  after D1 the UI no longer contradicts that. **Whether WebXR AR works
  on the owner's moto g45 is UNTESTED** — no device here, and no claim is
  made either way.

---

## 6. Build / typecheck / test — real output (MACHINE)

- `npx vitest run` → **Test Files 16 passed (16), Tests 135 passed
  (135)**. Baseline before this round: 14 files / 119 tests → **+16 new
  tests, zero regressions** (4 framing + 6 pinch replay + 6 engine
  contract).
- `npm run build` → **PASS** (also PASS with `DEPLOYED_ENGINE_REPAIRED3.ts`
  swapped in as `src/components/blockar/engine.ts`, proving the repaired
  engine compiles in-project; local `engine.ts` then restored
  byte-identical, git-clean).
- `npx tsc --noEmit` → **exactly 1 error**, the known pre-existing one:
  `src/components/blockar/device/CapabilityDetector.ts(196,3): error
  TS2375` (line moved 195→196 because of the one-line telemetry-union
  addition; same error, nothing new).

---

## 7. Commit / deployment state

**Local commit only. No push, no deploy in this round** — the parent
agent reviews this diff, pushes via the established snapshot route
(src files + `engine.ts` copied from `DEPLOYED_ENGINE_REPAIRED3.ts`,
then restores the local engine file), deploys to Vercel production, and
verifies the live build stamp before reporting to the owner. Production
at the time of writing is still build **7c10361** (Round 2).

---

## 8. Android: VERIFIED vs UNTESTED + next required evidence

**Android VERIFIED: nothing.** There is no Android device in this
environment; every result above is machine evidence (headless Chromium +
fake camera). Any claim beyond that would be fabrication.

Machine-verified this round: worker INIT→READY; FRAME→RESULT with real
landmarks (open hand 8/8; pinch with motion 5/5+); blank frames answer
with 0 landmarks; full-app TRACKING with lm>0; pinch→2 blocks in-app;
hand-loss recovery; framing-hint policy; engine contract invariants;
135/135 unit tests; production build; REPAIRED3 compiles as the engine.

**Next required evidence (owner's phone, ~1 minute):** the CURRENT live
build (7c10361) already logs what Round 3 needs —

1. Open https://blockar-studio.vercel.app → Allow Camera → Hand ON.
2. Hold the phone so a hand is in front of the REAR camera, whole hand
   in frame, ~15 seconds.
3. Open **Dev Test Logs** and screenshot the `hand_pipeline_stats` line.

Reading it: `lm` growing → landmarks flow on the phone (framing was the
issue; technique: whole hand, a little distance, light). `res` growing
with `lm:0` → the framing class of RC-A (after the Round-3 deploy the
app itself will say so via the new hint). `res:0` with `f` growing → a
device-specific worker break — the counters (`de`, `bf`, `drop`) will
say which, and that is the first genuinely new phone-side evidence any
round will have had. WebXR AR on the phone likewise stays UNTESTED
until tried there.
