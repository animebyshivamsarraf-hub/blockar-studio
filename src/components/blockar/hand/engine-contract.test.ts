import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Contract guards for the DEPLOYED engine lineage (round 3).
 *
 * Production does not build from src/components/blockar/engine.ts — the
 * deployed engine is managed as a verbatim file (DEPLOYED_ENGINE_CURRENT.ts)
 * and repairs are delivered as the next DEPLOYED_ENGINE_REPAIRED<n>.ts for
 * the parent to push as engine.ts. These tests pin the invariants the
 * round-3 WebXR audit verified, so a future engine copy-forward cannot
 * silently regress them:
 *  - hit-test is requested AND consumed (round-2's "missing
 *    requestHitTestSource" hypothesis was wrong — it must stay present);
 *  - startXR is atomic (a setup failure ends the session and clears state);
 *  - the 'end' handler cancels the hit-test source;
 *  - raw camera stays honest: "no", and no code pushes fabricated frames
 *    into the host sink.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const engine = readFileSync(join(ROOT, "DEPLOYED_ENGINE_REPAIRED3.ts"), "utf8");

describe("deployed engine (REPAIRED3) WebXR contract", () => {
  it("requests an immersive-ar session with hit-test as a required feature", () => {
    expect(engine).toMatch(/requestSession\("immersive-ar"/);
    expect(engine).toMatch(/requiredFeatures:\s*\[\s*"hit-test"\s*\]/);
  });

  it("creates and consumes a hit-test source", () => {
    expect(engine).toMatch(/requestHitTestSource\?\.\(\{\s*space: viewer\s*\}\)/);
    expect(engine).toMatch(/getHitTestResults\(hitSource\)/);
  });

  it("startXR is atomic: setup failure ends the session, clears state, rethrows", () => {
    expect(engine).toContain("ATOMIC START (round 3)");
    const catchBlock = engine.match(/catch \(setupError\) \{([\s\S]*?)\n      throw setupError;/);
    expect(catchBlock).not.toBeNull();
    expect(catchBlock![1]).toContain("xrSession = null");
    expect(catchBlock![1]).toContain("hitSource = null");
    expect(catchBlock![1]).toContain("await session.end()");
  });

  it("session end handler cancels the hit-test source before dropping it", () => {
    expect(engine).toMatch(/hitSource\?\.cancel\(\)/);
  });

  it("keeps the stale-session end guard (round 1) intact", () => {
    expect(engine).toMatch(/isStaleSessionEnd\(xrSession, session\)/);
  });

  it("raw camera stays honest: reports 'no' and never fabricates sink frames", () => {
    expect(engine).toMatch(/rawCameraState: \(\) => "no"/);
    // No invocation pushes pixels into the host sink (the sink's `push`
    // TYPE declaration is fine; calling it would be a fake frame producer).
    expect(engine).not.toMatch(/xrCameraSink\??\.push\(/);
    expect(engine).not.toMatch(/sink\.push\(/);
  });
});
