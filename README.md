# BlockAR Studio

BlockAR: 3D Voxel Builder & AR Hand Tracking Game Blueprint

1. Project Overview & Tech Stack
BlockAR ek WebXR / Augmented Reality (AR) app hai jo real-world surfaces par 3D Voxels (blocks) build karne aur manipulating ki facility deta hai. Isme kisi physical controller ki zaroorat nahi hai; yeh poori tarah Real 3D Hand Tracking aur Pinch Gestures par kaam karta hai.

Production Tech Stack:
- Frontend Framework: React + TypeScript + Tailwind + Lucide icons.
- 3D & AR Rendering Engine: Three.js / React Three Fiber + WebXR Device API.
- Computer Vision / Hand Tracking: MediaPipe Hands API / Tasks-Vision ya WebXR Hand Input API.
- Raycasting: Surface Detection aur Snap-to-Grid ke liye.
- State Management: Fast state updates for Undo/Redo, Selected Block, Shapes, Colors.
- Local Storage for world saving.

2. Onboarding & User Flow Architecture
[1. Welcome Screen] -> [2. Camera Permission] -> [3. Surface Scanning] -> [4. Surface Detected] -> [5. First Pinch Starter] -> [6. Active Build Mode] -> [7. Hand Tracking View (Visual Landmarks)] -> [Save / Load / Share Engine]

3. UI/UX Interface Mapping
- Top Left Overlay: Quick Guide Panel ("Point at a block", "Pinch (thumb + index)", "Drag to build", "Release to place").
- Top Right Control Cluster: Camera Status indicator, Save, Load, Undo, Redo.
- Mid Left Overlay: Hand Tracking Status badge (Tracking: Active, Pinch: Ready).
- Center Screen Viewport: Surface Reticle (green glowing grid placement marker), 3D Axis Indicator (Red X, Green Y, Blue Z Gizmo), Selection Highlight (glowing wireframe on selected voxel).
- Bottom Controls Dashboard:
  - Shapes: Cube, Sphere, Cylinder, Pyramid.
  - Colors: Blue, Cyan, Magenta, Pink, Orange, Grey neon tones.
  - Interactive Instruction Card: Dynamic text (e.g., "Pinch to Grab - Then move your hand to build in 3D").
  - Mode Selector Dock: Build, Move, Delete, Paint, Group.

4. Core Mechanics:
- 10cm Voxel snapping matrix with face-adjacent snapping (like Minecraft).
- Pinch gesture detection (Thumb + Index finger) & touch fallback so building works reliably on every mobile device.
- Continuous extrusion / drag build along axes.

हाँ, BlockAR शुरू करो—पहले मोबाइल पर चलने वाला AR viewport, voxel placement और touch fallback बनाओ।

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/f73decd4-41ff-443a-9a1f-217250d2c81c).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
