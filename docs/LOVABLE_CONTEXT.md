# LOVABLE CONTEXT — BLOCKAR STUDIO

## Latest Lovable project supplied by user
https://lovable.dev/projects/c454371b-4ce8-46e3-a9ea-b9a382d83987?magic_link=mc_b0c6962e-e6b5-45e2-97e4-9c310b8b20a9

The current project link could not be inspected through the available Lovable API in this session, so this file records the user's current target and the verified GitHub baseline rather than claiming unverified project contents.

## Canonical GitHub repository
https://github.com/animebyshivamsarraf-hub/blockar-studio

## Current implementation direction
The project is being moved from a fake cone/2D cursor interaction to a real 3D spatial hand interaction:
- WebXR hand tracking primary
- WebXR Input Profiles generic-hand model
- Three.js XRHandModelFactory / XRHandMeshModel
- thumb + index pinch
- GrabController3D with grab offset
- true world-space XYZ movement
- world-locked construction
- MediaPipe fallback
- no automatic Ride

## Workflow for future Lovable sessions
1. Read BLOCKAR_HANDOFF.md.
2. Read BLOCKAR_MASTER_SPEC.md.
3. Inspect actual source before editing.
4. Continue from Git state.
5. Do not ask the user to resend the full project history.
6. Make small verified implementation batches.
7. Run typecheck/build after meaningful changes.
8. Update the handoff when architecture or acceptance status changes.
