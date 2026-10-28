import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Regression tests for ChatGPT's P0-branch review (28 Oct 2026):
// 1. allowCamera() had direct getUserMedia calls bypassing the shared
//    gumInFlight guard. 2. autoExitXRForHands() cleared the handoff banner
//    after 300 ms regardless of whether camera recovery succeeded.
// These are source-level guards: allowCamera/autoExit live inside the
// BlockAR component and are not directly unit-testable, so the tests
// assert the structural fix in BlockAR.tsx itself. If a future change
// reintroduces a direct call or a timer-cleared banner, these fail
// loudly instead of silently reintroducing the Android camera wedge.
const src = readFileSync(new URL("../BlockAR.tsx", import.meta.url), "utf8");

const section = (start: string, end: string) => {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe("ChatGPT P0 gaps: shared camera guard + terminal handoff banner", () => {
  it("BlockAR.tsx has exactly one getUserMedia call site, inside acquireRearStream", () => {
    const calls = src.match(/navigator\.mediaDevices\.getUserMedia/g) ?? [];
    expect(calls.length).toBe(1);
    const acquire = section("async function acquireRearStream", "const recoveringCamera");
    expect(acquire).toContain("navigator.mediaDevices.getUserMedia");
  });

  it("allowCamera routes through acquireRearStream and has no direct getUserMedia", () => {
    const allow = section("async function allowCamera", "async function enterXR");
    expect(allow).toContain("await acquireRearStream()");
    expect(allow).not.toContain("navigator.mediaDevices.getUserMedia");
  });

  it("autoExitXRForHands does not clear the handoff banner on a timer", () => {
    const autoExit = section("function autoExitXRForHands", "Single place where camera ownership");
    expect(autoExit).toContain('setHandoffMsg("AR se rear-camera hand mode me ja raha hai');
    expect(autoExit).not.toContain("setHandoffMsg(null)");
    expect(autoExit).not.toContain("setTimeout");
  });

  it("restore success still owns clearing the banner (terminal state)", () => {
    const restore = section("async function restoreVideoPipeline", "AR is on but can't feed hands");
    expect(restore).toContain("setHandoffMsg(null)");
  });
});
