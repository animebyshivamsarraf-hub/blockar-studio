# BLOCKAR STUDIO — CANONICAL DEVELOPER HANDOFF

## 1. What BlockAR Studio Is
BlockAR Studio is an augmented reality 3D voxel and procedural roller coaster design application built for web and mobile AR. Users build spatial structures in real room dimensions where 1 Three.js coordinate unit equals 1 real-world meter. It features two primary creation tracks:
1. **Classic Voxel & Track Mode**: Grid-based voxel placement (10 cm default voxels), block manipulation, and sequential Catmull-Rom coaster waypoint placement.
2. **Real AR Hand Mode**: Direct, unquantized hand-pinch 3D coaster extrusion in world space using WebXR Hand Tracking (or MediaPipe camera fallback on mobile) with continuous parallel rails, cross-ties, and ground stanchions.

Canonical Repository: `https://github.com/animebyshivamsarraf-hub/blockar-studio`
Canonical Branch: `main`

---

## 2. Core Architecture
- **Framework & Runtime**: React 19, Vite, TanStack Router/Start, Tailwind CSS v4, Lucide icons.
- **3D Engine**: Three.js (`three` r186) managed through imperative canvas loops (`src/components/blockar/engine.ts`).
- **Spatial Anchoring (`ConstructionRoot`)**: Placed objects live in an anchored world-space group (`ConstructionRoot`). Phone/camera movement updates the view matrix; it never moves or parents the placed objects.
- **Hand Pipeline**: `HandSystemRuntime.ts`, `PinchStateMachine.ts`, `GrabController3D.ts`, and native ARCore bridge in `native/android/`.
- **Procedural Coaster Engine (`coaster.ts`)**: Centripetal Catmull-Rom splines, parallel-transport rail generation (0.12 m track gauge, 0.012 m rail radius, 0.016 m spine radius, 0.15 m tie spacing), and numerical energy/gravity coaster simulation.

---

## 3. Features & Subsystems

### Classic Track Mode
- Discrete click/tap or waypoint placement on the floor or block surfaces.
- Segment elevation adjustment (`raiseLast`), loop closing (`setLoop`), and undo point.
- Track points are connected with spline interpolation; straight segments are collinearity-filtered to prevent Catmull-Rom overshoot.

### Real AR Hand Mode
- Real-time continuous extrusion: Pinch down begins a stroke; moving hand extends the stroke at ~0.05 m intervals; pinch release finalizes track without triggering ride.
- Visuals: Luminous cyan/white twin rails (`#00e5ff` / `#e2e8f0`), teal stanchions/supports (`#00897b`), and green active stroke indicator (`#00e676`).
- Bypasses voxel `extrudeCells()` to ensure smooth 3D spline rails rather than voxel blocks.
- Hand loss freezes active track construction; reacquisition rebases stroke without teleportation, runaway spikes, or bridging across the gap.

### Hand Tracking & Pinch Pipeline
- Hand input reports world-space fingertip coordinates (thumb tip and index tip midpoint).
- Hand loss triggers an immediate freeze (`xrHandFrozen = true`) to prevent phantom placement or jumps.
- Reacquisition waits for stabilization frames and rebases (`grabController.rebase`) without bridging or teleporting.

### Voxel & Manipulation System
- 10 cm voxels snapping to local integer coordinates.
- Tools: Build (extrude), Move, Delete, Paint, Group.
- History: Full Undo/Redo stack for voxel operations.

### AI Build & Persistence
- AI Build: Natural language prompt generates structured voxel coordinate blueprints.
- Save/Load: Serializes voxel lists and coaster spline definitions to `localStorage`.

### Manual Ride Simulation
- Manual-only start via Ride button. No automatic start upon building, loading, or closing a stroke.
- Supports both third-person orbit/overview and first-person POV camera locked to train nose with banking.
- Speed simulation includes gravity slope acceleration, friction, and chain lift minimum velocity.

---

## 4. Verification & Build Commands
```bash
# Install dependencies
bun install

# Run unit tests
bun test

# Production build
bun run build
```

---

## 5. Known Limitations & Untested Items
- **Physical Device Testing**: Hand tracking under true WebXR device sessions requires WebXR-compatible Android hardware running ARCore (Chrome AR) or native Capacitor shell. Browser webcam testing uses 2D planar projection fallback and does not provide genuine 6DOF metric hand depth.
- **Lighting & Occlusion**: Virtual coaster rails render on top of camera video feed without depth occlusion from real-world obstacles.
- **Git Push Access**: Push to `origin/main` on GitHub requires write authentication credentials.

---

## 6. Guidelines for Future AI Continuation
1. Continue strictly from the canonical repository: `https://github.com/animebyshivamsarraf-hub/blockar-studio`.
2. Do not create a separate repository or wipe the architecture.
3. Keep `Classic Track` and `Real AR Hand` pipelines decoupled so improvements to one do not regress the other.
4. Always verify with `bun test` and `bun run build` before committing.
