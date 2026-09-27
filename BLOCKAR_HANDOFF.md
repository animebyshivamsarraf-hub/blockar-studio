# BLOCKAR STUDIO — Permanent Handoff

Source of truth: actual GitHub code, not historical chat claims.

Project:
- Lovable: https://lovable.dev/projects/f73decd4-41ff-443a-9a1f-217250d2c81c
- GitHub: https://github.com/animebyshivamsarraf-hub/blockar-studio
- Goal: mobile-first room-scale AR construction with rear camera, real spatial hit/depth where supported, world-locked construction, hand pinch/grab, continuous 3D coaster/voxel building, optional manual Ride.

NON-NEGOTIABLE:
- CAMERA != WORLD. Phone movement must not move existing construction.
- Rear/environment camera only.
- 1 Three.js world unit = 1 meter.
- User chooses start surface; create ConstructionRoot/world anchor.
- Straight hand movement -> straight track.
- Hand loss -> freeze; recovery -> rebase without bridging/jump.
- Ride ONLY after explicit Ride button. Never auto-enter/follow/start.
- Preserve voxel, coaster, AI Build, save/load, undo/redo, manual Ride.

AUDIT BASELINE:
Verified: no auto-Ride; rear camera request uses environment.
Missing/incomplete: formal SpatialProvider, SpatialHit/Surface/Anchor/Input contracts, CoordinateBridge, world anchor flow, 3D grab offset, hand freeze/rebase, iOS orientation permission flow, structured 0.05m-ish spatial coaster sampling/DDA, centralized metric geometry.
Partial: basic Three.js root exists; GAUGE about 0.12m exists but geometry has inline constants.

REQUIRED SPATIAL LAYER:
src/components/blockar/spatial/
- SpatialTypes.ts
- SpatialProvider.ts
- WebXRSpatialProvider.ts
- FallbackSpatialProvider.ts
- CoordinateBridge.ts
Use explicit Screen -> Camera -> World -> Construction Local conversions.
WebXR: use genuine immersive-ar/hit-test/reference space/anchors/planes/depth only where supported.
Fallback: rear camera/orientation/calibration is NOT equivalent to native ARCore/ARKit/WebXR. Never fake true metric depth with arbitrary MediaPipe Z multipliers.

HAND:
Implement world-aware SpatialInput, pinch hysteresis, grabOffset = objectWorld - pinchWorld, LOST/FROZEN/REACQUIRING states, no extrapolation or gap bridging.

COASTER:
Preserve TrackGeometry/TrackBuilder/RideController. World-space path; target ~0.05m sampling; DDA/Amanatides-Woo or equivalent when needed; no duplicate/gap/runaway points; no uncontrolled spline overshoot. Keep path scale separate from rail/support dimensions. Reference: gauge ~0.12m, rail radius ~0.012m, spine ~0.016m, ties ~0.15m.

EXISTING SYSTEMS:
Preserve blocks, voxel tools, delete, paint, grouping, height, loop, AI Build, save/load, undo/redo, manual Ride. One undo transaction per continuous stroke.

LARGE REFERENCES:
BlockAR-Studio.zip, RollercoasterDesigner-main.zip, threejs-handtracking-101-main.zip, godot4-vehicle-framework-main.zip, Shift-main.zip, reference video and diagrams. Do not repeatedly request files over 20MB when a repository/reference URL exists; never invent private URLs.

REFERENCE REPOS:
https://github.com/collidingScopes/threejs-handtracking-101
https://github.com/AbijahKaj/handtracker-3d
https://github.com/stewdio/handy.js
https://github.com/snkttrivedi/threejs-hand-interactions
https://github.com/damiansire/web-ar-hand-tracking
https://github.com/realitycollective/WebXR-Interactions
https://github.com/Unity-Technologies/arfoundation-samples
https://github.com/googlesamples/arcore-depth-lab
Check licenses before copying.

TESTS:
rear camera; start surface; world anchor; phone movement leaves construction fixed; pinch no jump; X/Y/Z hand movement where supported; straight path; controlled curves; hand-loss freeze/rebase; release; one undo per stroke; redo; save/load; AI does not Ride; Ride only after button; exit Ride restores build mode.

Do not claim runtime verification from static inspection. Do not claim unsupported depth/native AR.

RECOVERY:
Read this file first in every new Lovable session. Inspect actual source. Continue from Git state. Do not ask the user to restate the entire history. Prefer coordinated batches and verify build/typecheck after changes.