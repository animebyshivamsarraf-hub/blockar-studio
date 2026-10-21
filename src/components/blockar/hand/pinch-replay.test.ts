import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { liftLandmarks, type ScreenLandmark } from "./landmarkMapping";
import { PinchStateMachine } from "./PinchStateMachine";

/**
 * Pinch replay on REAL model output (round 3).
 *
 * The landmark fixtures are NOT synthetic: they are the MediaPipe model's
 * own RESULTs, recorded by scripts/e2e/worker-harness.mjs driving the real
 * production worker with real hand photographs (fixtures/hand-open.jpg,
 * hand-pinch.jpg — see scripts/e2e/fixtures/README.md). This test replays
 * them through the exact transform chain HandSystemRuntime applies —
 * normalized landmarks → screen px → liftLandmarks → pinch ratio
 * (|j4−j8| / |j0−j9|) → PinchStateMachine — the same values that feed
 * rt.onPinchWorld → engine.handSamplePoint on device.
 *
 * Scope honesty: this verifies pinch DETECTION and a stable, finite pinch
 * point on real landmarks. The deployed engine's place() call itself is
 * not importable here (the production engine is a separate lineage,
 * managed as DEPLOYED_ENGINE_*.ts) — block placement on a phone remains
 * device-UNTESTED; see ROOT_CAUSE_ROUND3_2026-10-21.md.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/e2e/fixtures");

interface RecordedResult {
  landmarks: Array<Array<{ x: number; y: number; z: number }>>;
  handedness: Array<Array<{ categoryName?: string }>>;
}

function loadFixture(name: string): RecordedResult {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as RecordedResult;
}

const FRAME_W = 480;
const FRAME_H = 270;

/** Normalized landmarks → screen px, exactly as consumeMediaPipeResult maps them for a rear camera at 1:1 frame scale. */
function toScreen(hand: Array<{ x: number; y: number; z: number }>): ScreenLandmark[] {
  return hand.map((p) => ({ x: p.x * FRAME_W, y: p.y * FRAME_H, z: p.z }));
}

function rawRatio(hand: Array<{ x: number; y: number; z: number }>): number {
  const d = (a: number, b: number) => Math.hypot(hand[a]!.x - hand[b]!.x, hand[a]!.y - hand[b]!.y, hand[a]!.z - hand[b]!.z);
  return d(4, 8) / d(0, 9);
}

/** Lift one recorded hand the way sampleMediaPipe does (depth carried across frames). */
function makeLifter() {
  const camera = new THREE.PerspectiveCamera(60, FRAME_W / FRAME_H, 0.01, 50);
  camera.updateMatrixWorld();
  let depth: number | null = null;
  return (hand: Array<{ x: number; y: number; z: number }>) => {
    const lifted = liftLandmarks(toScreen(hand), camera, FRAME_W, FRAME_H, depth, FRAME_W);
    depth = lifted.depth;
    return lifted.points;
  };
}

function liftedRatio(points: THREE.Vector3[]): number {
  return points[4]!.distanceTo(points[8]!) / points[0]!.distanceTo(points[9]!);
}

const open = loadFixture("landmarks-open.json");
const pinch = loadFixture("landmarks-pinch.json");

describe("recorded fixtures are real, complete model output", () => {
  it("open hand: 1 hand × 21 finite landmarks", () => {
    expect(open.landmarks).toHaveLength(1);
    expect(open.landmarks[0]).toHaveLength(21);
    for (const p of open.landmarks[0]!) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
  });
  it("pinch hand: 1 hand × 21 finite landmarks", () => {
    expect(pinch.landmarks).toHaveLength(1);
    expect(pinch.landmarks[0]).toHaveLength(21);
    for (const p of pinch.landmarks[0]!) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
  });
  it("recorded ratios sit on opposite sides of the pinch thresholds", () => {
    // PinchStateMachine defaults: start 0.28, release 0.42.
    expect(rawRatio(open.landmarks[0]!)).toBeGreaterThan(0.42);
    expect(rawRatio(pinch.landmarks[0]!)).toBeLessThan(0.28);
  });
});

describe("pinch state machine replayed on real landmarks", () => {
  it("open hand never pinches across 10 frames", () => {
    const lift = makeLifter();
    const sm = new PinchStateMachine();
    for (let i = 0; i < 10; i++) {
      const ratio = liftedRatio(lift(open.landmarks[0]!));
      expect(sm.update(ratio)).toBe("OPEN");
      expect(sm.held).toBe(false);
    }
  });

  it("pinch pose reaches PINCHED, holds without flicker, and yields a finite pinch point", () => {
    const lift = makeLifter();
    const sm = new PinchStateMachine();
    const phases: string[] = [];
    let pinchPoint: THREE.Vector3 | null = null;
    for (let i = 0; i < 6; i++) {
      const points = lift(pinch.landmarks[0]!);
      phases.push(sm.update(liftedRatio(points)));
      // The exact point HandSystemRuntime emits via onPinchWorld:
      // midpoint of the lifted thumb-tip (4) and index-tip (8) joints.
      pinchPoint = points[4]!.clone().add(points[8]!).multiplyScalar(0.5);
    }
    expect(phases[0]).toBe("PINCHING");
    expect(phases[1]).toBe("PINCHED");
    expect(phases.slice(2)).toEqual(["PINCHED", "PINCHED", "PINCHED", "PINCHED"]);
    expect(sm.held).toBe(true);
    expect(pinchPoint).not.toBeNull();
    expect(Number.isFinite(pinchPoint!.x + pinchPoint!.y + pinchPoint!.z)).toBe(true);
  });

  it("releasing back to the open pose ends the pinch (stroke commit path)", () => {
    const lift = makeLifter();
    const sm = new PinchStateMachine();
    for (let i = 0; i < 4; i++) sm.update(liftedRatio(lift(pinch.landmarks[0]!)));
    expect(sm.phase).toBe("PINCHED");
    const releasePhases: string[] = [];
    for (let i = 0; i < 3; i++) releasePhases.push(sm.update(liftedRatio(lift(open.landmarks[0]!))));
    expect(releasePhases).toContain("RELEASING");
    // RELEASED is the transition frame the runtime acts on (stroke commit);
    // the machine then settles back to OPEN on the next open-hand frame.
    expect(sm.phase).toBe("RELEASED");
    expect(sm.held).toBe(false);
    expect(sm.update(liftedRatio(lift(open.landmarks[0]!)))).toBe("OPEN");
  });
});
