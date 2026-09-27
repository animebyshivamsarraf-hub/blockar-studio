# BLOCKAR STUDIO — MASTER SPEC

## Canonical goal
Mobile-first room-scale AR construction game. The user's real hand is the primary controller.

## Current target interaction
REAR CAMERA / NATIVE AR
→ spatial tracking
→ choose start surface
→ world-locked ConstructionRoot
→ visible 3D tracked hand
→ thumb + index pinch
→ grab at the real pinch point
→ move in X/Y/Z
→ release
→ object remains world locked
→ RIDE only after explicit user action

## Non-negotiables
- Camera movement must never move existing construction.
- Hand movement controls construction.
- No fake cone/cursor as primary interaction.
- No 2D screen-space drag as primary interaction.
- No arbitrary camera-relative depth.
- No giant/tiny accidental scale.
- No automatic ride.
- Hand loss freezes; recovery must not teleport or bridge gaps.
- Rear/environment camera is the fallback camera; never silently switch to front camera.
- 1 Three.js world unit = 1 meter.

## 3D hand
Preferred native path:
- WebXR hand tracking.
- Public WebXR Input Profiles generic-hand assets.
- Three.js XRHandModelFactory / XRHandMeshModel.
- Support left and right hands.
- Render a real skinned hand, not only joint spheres.
- BlockAR may apply its own material/highlight style; do not copy Meta branding or proprietary assets.

Fallback:
- MediaPipe hand landmarks.
- Same SpatialHandState / GestureDetector / GrabController3D APIs.
- If depth confidence is poor, prefer constrained stable motion over runaway depth.

## Pinch / grab
- Thumb tip + index tip distance with hysteresis.
- On grab: grabOffset = objectWorldPosition - pinchWorldPosition.
- During grab: objectWorldPosition = currentPinchWorldPosition + grabOffset.
- Preserve the exact grab point; no snapping/jumping.

## Hand states
TRACKING → PINCHING → GRABBING → LOST → FROZEN → REACQUIRING → TRACKING

## Track construction
- Pinch starts preview at actual pinch world position.
- Pinch + move continuously extrudes track in world space.
- Release commits one undo transaction.
- Target spatial sampling about 0.05 m.
- Straight hand path = straight track.
- Smooth hand curve = smooth track.
- No automatic circles/loops/noise.
- Keep path scale separate from rail/support dimensions.
- Coaster gauge approximately 0.12 m; use centralized metric constants.

## Existing features to preserve
- voxel/block building
- track/coaster mode
- supports
- paint/delete
- grouping
- height controls where useful
- AI Build
- save/load
- undo/redo
- manual Ride
- exit Ride back to build mode

## Ride
Building never starts Ride automatically.
Ride starts only after explicit Ride action.
Exit Ride must return to build/edit mode.

## Architecture
Use real runtime integration:
src/components/blockar/spatial/
- SpatialTypes.ts
- SpatialProvider.ts
- WebXRSpatialProvider.ts
- FallbackSpatialProvider.ts
- CoordinateBridge.ts

src/components/blockar/hand/
- HandController3D.ts
- HandModel.ts
- GestureDetector.ts

src/components/blockar/interaction/
- GrabController3D.ts

src/components/blockar/build/
- ConstructionRoot.ts
- TrackBuilder.ts
- TrackGeometry.ts

Do not leave placeholder architecture disconnected from the actual runtime.

## Acceptance tests
1. Rear/environment camera.
2. Start surface selected and world locked.
3. Real tracked 3D hand appears.
4. Finger movement is visible on the 3D hand.
5. Pinch grabs without jump.
6. Hand movement changes object in real XYZ.
7. Phone movement changes only camera view.
8. Released object stays fixed in room.
9. Track follows pinch path without runaway scale.
10. Hand loss freezes.
11. Recovery is smooth and does not teleport.
12. Save/load works.
13. Undo/redo works.
14. AI Build never starts Ride.
15. Ride only starts after explicit Ride action.

## Reference
WebXR Input Profiles:
https://github.com/immersive-web/webxr-input-profiles

Three.js:
XRHandModelFactory / XRHandMeshModel

Before copying third-party code/assets, verify license and preserve required notices.
