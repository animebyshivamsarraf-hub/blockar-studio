# BlockAR — FINAL Root-Cause Investigation & End-to-End Repair (2026-10-21)

Scope: the DEPLOYED combination only — host modules in `src/` (blob-identical to GitHub)
+ the GitHub-lineage engine (`DEPLOYED_ENGINE_CURRENT.ts`, blob `61cc31f`, GitHub main @
`a39269e`). The local ZIP-lineage `src/components/blockar/engine.ts` was NOT touched.

Labels: **VERIFIED** = proven by code trace / test / run below. **HYPOTHESIS** = evidence
points at it, not proven. **UNKNOWN** = no evidence exists yet. Nothing is called fixed on
the strength of unit tests alone; the device-only list at the end is the real acceptance.

---

## 1. The central question, answered first

**Suspicion:** the deployed engine's `rawCameraState: () => "no"`,
`markRawCameraFailed: () => {}` and store-only `setXRCameraSink` break the host's
XR→DOM-camera handoff in `startupGuards.ts` / `BlockAR.tsx`.

**Verdict: the suspicion is half right.** The three members ARE stubs (VERIFIED, §2 row 2),
but **no host path waits on them** (VERIFIED, §2 rows 2–4):

- `frameSource "xr"` — the only state in which anything consumes the sink or the raw
  watchdog — requires owner `CAMERA_XR_RAW_CAMERA`
  (`camera/CameraOwnership.ts` `frameSourceFor`), which requires an `XR_STARTED` event
  with `rawCamera: true`. The deployed engine sends `rawCamera: false` in BOTH its
  `onXRStateChange` payloads (`DEPLOYED_ENGINE_CURRENT.ts:773` start, `:818-819` end), and
  `toggleHands` can only take the XR-raw branch when `resolveXRHandoff` returns `"raw"`,
  which requires `rawCameraState() === "yes"` — impossible, it is the constant `"no"`
  (`DEPLOYED_ENGINE_CURRENT.ts:962`).
- The sink is installed ONLY when `frameSourceFor(next) === "xr"`
  (`BlockAR.tsx` dispatchCamera, lines ~406-413); otherwise the host explicitly installs
  `null`. In this build the sink is therefore always null and nothing ever blocks on it.
- `markRawCameraFailed()` is called from exactly two places — the RawFrameWatchdog effect
  (gated on owner `CAMERA_XR_RAW_CAMERA`, unreachable) and the runtime's `onNoFrames`
  (gated on frameSource `"xr"` in `hand/frameArrival.ts` arming, unreachable). Its no-op
  body is never exercised on any reachable path.

**The fallback handoff itself is wired end-to-end and works** (VERIFIED by full trace +
browser E2E, §2 rows 3–4, §5): XR active + Hand tap → `resolveXRHandoff` exits XR (bounded)
→ `toggleHands` opens exactly one fresh DOM stream → `HandSystemRuntime.start("mediapipe",
{ stream })` → frameSource `"video"` → MediaPipe worker receives frames → landmarks →
pinch pipeline.

So the historical failures were NOT "the fallback is broken". They were, in order:
(1) the engine API surface was incomplete → hard crashes (tests #3, #4 — now complete);
(2) the pre-fix unbounded startup → permanent STARTING (fixed in `ba8523e`);
(3) test #5's symptom is **UNKNOWN** — no screenshot or log was ever received for it.

---

## 2. Root-cause table

| # | Symptom | Cause — label | Evidence (file:line) | User impact | Fix applied | Regression test |
|---|---------|---------------|----------------------|-------------|-------------|-----------------|
| 1 | Phone tests #3/#4: `e.rawCameraState is not a function`, then `a?.setXRCameraSink is not a function` | **VERIFIED** — deployed (GitHub-lineage) engine lacked the ZIP-architecture API surface the host calls | Host call sites `BlockAR.tsx` (rawCameraState in dispatchCamera probing + toggleHands; setXRCameraSink ~408/413); engine history in `AGY_FIX_REPORT.md` | Hand start crashed with a raw TypeError | Already repaired before this investigation (ports + AGY completion @ `a39269e`); this investigation verified the surface is now complete — every `engine.current.*` member called by `BlockAR.tsx`/`HandLab.tsx` exists in the deployed engine | `deployed-combination.test.ts` pins the deployed contract so a missing/renamed member fails loudly |
| 2 | Owner's suspicion: stubs fake a raw-camera capability | **VERIFIED as code fact; NOT a fallback blocker** — raw mode is genuinely absent (no `XRCameraReader` anywhere in the deployed engine), and the stubs make frameSource `"xr"` unreachable rather than waited-on | `DEPLOYED_ENGINE_CURRENT.ts:962` (`"no"`), `:965` (no-op), `:968` + sink declaration (store-only, never read elsewhere); gating: `CameraOwnership.ts` `frameSourceFor`, `BlockAR.tsx:406-413`, `hand/frameArrival.ts` | None on the fallback path. Honesty debt: a reader could believe raw mode exists | Engine contract rewritten as an explicit "NOT SUPPORTED in this build" block in `DEPLOYED_ENGINE_REPAIRED.ts:750-759`; behaviour unchanged (a fake producer was explicitly rejected) | `deployed-combination.test.ts` tests 3–4 (xr unreachable; sink never installed) |
| 3 | Phone test #2: HAND stuck at STARTING forever, no retry | **VERIFIED** (fixed earlier) — `toggleHands` had no overall deadline; its XR-handoff section sat outside try/catch; stacked internal timeouts ≈ 69 s | Audit in `ROOT_CAUSE_2026-10-21.md` RC-1; fix in local commit `ba8523e` (`BlockAR.tsx` toggleHands: 75 s deadline + attempt token + whole body in try/catch) | Permanent "Please wait…", button disabled | Already fixed + deployed (`e01d23c`); re-verified in this audit's trace | `startup-guards.test.ts`, `mobile-fixes.test.ts` (existing) |
| 4 | Phone test #2: pill "Camera off" over a live AR feed | **VERIFIED** (fixed earlier) — engine `'end'` listener had no session-identity check; a stale session's late `'end'` clobbered live state | `ROOT_CAUSE_2026-10-21.md` RC-2; guard `isStaleSessionEnd` ported to the deployed engine (its `'end'` listener, `DEPLOYED_ENGINE_CURRENT.ts:812-834`) + 500 ms pill resync in `BlockAR.tsx` | UI lied about camera state | Already fixed + deployed; phone test #3 confirmed pill truthful | `startup-guards.test.ts` isStaleSessionEnd cases |
| 5 | "Camera preview only" / stale-stream hand start could open a SECOND stream while the old one still held the camera | **VERIFIED code gap** — `allowCamera()` never stopped or reused the previous stream (unlike `restoreVideoPipeline`, which stops first). On Android a second `getUserMedia` for a held camera can fail `NotReadableError` | `BlockAR.tsx` allowCamera (pre-repair ~445-492): unconditional getUserMedia, no streamRef cleanup | Possible "Rear camera unavailable" ERROR on re-entry/stale paths; leaked tracks keep the camera LED/battery busy | **This repair (H1)** `BlockAR.tsx:449-465`: healthy previewed stream is reused; a dead/muted leftover is stopped BEFORE acquiring — exactly one stream, freeze fix (no blind srcObject reassign) preserved | E2E re-run after edit (§5) exercises the reuse branch; unit-level host test not feasible (React + getUserMedia DOM) — stated honestly |
| 6 | First-ever hand start on the phone may fail "MediaPipe worker timed out (20s)" | **HYPOTHESIS** — first load downloads ~19 MB (model 7,819,105 B + WASM pair) before READY; 20 s is tight on mobile networks. `_headers` gives immutable caching only to `/assets/*`, so repeat visits rely on heuristic caching | `hand/HandSystemRuntime.ts` worker READY timer (was :421); `public/models/hand_landmarker.task` 7,819,105 B; `public/wasm/` 35,444,140 B total; `.output/public/_headers` | First-attempt ERROR (retryable; second attempt usually cached) | **This repair (H2)** `HandSystemRuntime.ts:425`: worker-init budget 20 s → 40 s — still inside the 45 s startup race and the host's 75 s deadline, so startup stays bounded | Existing worker suites + full suite re-run (§5) |
| 7 | `enterXR` retry can leave TWO immersive sessions alive | **VERIFIED code path, impact HYPOTHESIS** — `enterXR`'s catch path calls `startXR` again; if attempt 1 had already created a session, the engine overwrote `xrSession` without ending attempt 1's session — a leaked immersive session holds the camera and can break the DOM fallback | `BlockAR.tsx` enterXR (~505-512 post-edit); `DEPLOYED_ENGINE_CURRENT.ts` startXR (no stale-session handling at :755-763) | Rare; camera held by a ghost session → fallback getUserMedia can fail | **This repair (E2)** `DEPLOYED_ENGINE_REPAIRED.ts:765-776`: startXR ends the previously tracked session first (its `'end'` listener treats it as stale by design) | esbuild + full suite; device-only confirmation listed in §6 |
| 8 | Starting AR while hands are ON instantly exits AR again | **VERIFIED behaviour — by host design, NOT a hang** — the engine reports `pending:false` at start, so `xrHandoffAction` returns `exit-xr-for-hands` immediately (hands win over AR in this architecture). The host's "probing" grace can never engage in this build | `DEPLOYED_ENGINE_CURRENT.ts:773`; `CameraOwnership.ts` `xrHandoffAction`; `BlockAR.tsx` dispatchCamera/autoExitXRForHands | UX surprise only; a toast explains "switching to rear-camera hand mode" | No behaviour change (changing event semantics risks double transitions — rejected as speculative). Documented here + engine comment block | `deployed-combination.test.ts` test 1 pins the behaviour |
| 9 | Phone test #5 (build `a39269e`): "abhi bhi kuch nahi kaam kar raha" | **UNKNOWN** — no screenshot, error text, or Dev Test Logs were captured for this test. Every reachable code path has been traced and the fallback E2E-verified on desktop Chromium; the remaining unknowns are device-only (Dimensity 6300 worker/WASM timing, network first-load, Chrome version behaviour) | — | Cannot be diagnosed without evidence | **This repair (H3)** `BlockAR.tsx:957`: Dev Test Logs now show the last 15 telemetry entries (was 5) so the `hand_start_*` milestones survive to be screenshotted | §6 gives the exact 2-screenshot evidence request |
| 10 | `MediaPipeFallbackAdapter` looks like a second hand path | **VERIFIED non-defect** — the class is dead code in the host path; only its `FALLBACK_LIMITATION` string constant is imported | `BlockAR.tsx` imports; class has no instantiation in `src/` | None; confusion risk only | None (documented here) | — |

---

## 3. Exact data flow (deployed combination, after repair)

```
DOM-camera fallback (the SUPPORTED hand path in this build)
  Tap Hand → toggleHands (75 s deadline, attempt token)
    → resolveXRHandoff: not XR ⇒ "none" | XR + raw "no" ⇒ stopXR (≤3 s settle,
      ≤3 s exit poll, 350 ms release) ⇒ "exited"          [startupGuards.ts]
    → allowCamera(): reuse healthy stream OR stop stale + getUserMedia
      (environment, exact→plain), isEnvironmentStream gate [BlockAR.tsx:445+]
    → HandSystemRuntime.start("mediapipe", { stream })
        frameSource = "video"                             [CameraOwnership.frameSourceFor]
        → startMediaPipeWorker: WASM /wasm/*, model /models/hand_landmarker.task
          (same-origin, present in .output/public), READY ≤ 40 s, GPU→CPU fallback
        → per frame: createImageBitmap 480×270 → FrameGate (1 in flight)
          → worker detectForVideo → RESULT landmarks (21 joints × up to 2 hands)
    → PinchStateMachine → pinch: onPinchWorld (non-XR) → engine.handSamplePoint
      → block placement; grab/drag via GrabController3D  [HandSystemRuntime.ts]

XR path (unchanged): enterXR → engine.startXR → hit-test/anchors/reticle.
  Hands ON + XR start ⇒ designed instant auto-exit to the fallback above (row 8).
XR hand-tracking (navigator.xr hands) path in toggleHands is independent of the
  stubs and untouched.

Raw XR camera path: DOES NOT EXIST in this build (row 2). No producer, no
  consumer, no waiting path. Stated in code at DEPLOYED_ENGINE_REPAIRED.ts:750-759.
```

Worker lifecycle (verified in trace): INIT → READY (generation + worker-identity
checked) → FRAME → RESULT/DROPPED/DETECT_ERROR; inference timeout 3.5 s
(`workerPolicy.ts`); restarts bounded `MAX_WORKER_RESTARTS = 3` with CPU recovery;
teardown caps `session.end()` at 3 s and never stops an externally owned stream.

---

## 4. Files changed in THIS repair

| File | Change | Why |
|------|--------|-----|
| `src/components/blockar/BlockAR.tsx:449-465` | allowCamera: reuse healthy stream / stop stale stream before acquiring (H1) | Row 5 — exactly one valid stream |
| `src/components/blockar/BlockAR.tsx:957` | Dev Test Logs `slice(-5)` → `slice(-15)` (H3) | Row 9 — decisive telemetry must survive for evidence |
| `src/components/blockar/hand/HandSystemRuntime.ts:419-425` | Worker READY budget 20 s → 40 s + comment (H2) | Row 6 — first-load ~19 MB on mobile networks |
| `DEPLOYED_ENGINE_REPAIRED.ts:750-759` | Raw-camera contract comment rewritten as explicit NOT SUPPORTED block | Row 2 — honesty in code |
| `DEPLOYED_ENGINE_REPAIRED.ts:765-776` | startXR ends a previously tracked session before requesting a new one (E2) | Row 7 — no leaked immersive session |
| `src/components/blockar/hand/deployed-combination.test.ts` | NEW — 5 contract tests for the deployed combination | Rows 1–2 — pins the stub contract + fallback sequence |
| `ROOT_CAUSE_FINAL_2026-10-21.md` | This report | — |

Untouched by design: local `src/components/blockar/engine.ts` (ZIP lineage),
`DEPLOYED_E
...[truncated 3554 chars]