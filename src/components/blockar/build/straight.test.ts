import * as THREE from "three";
import { createCoaster } from "../coaster";
import { test, expect } from "vitest";
test("straight hand path -> collinear points", () => {
  const c = createCoaster(new THREE.Group(), 0.1);
  let t = 0; c.beginStroke(new THREE.Vector3(0,0.2,0), t);
  for (let i=1;i<=60;i++){ t+=33; c.extendStroke(new THREE.Vector3(i*0.01,0.2+(Math.random()-0.5)*0.004,(Math.random()-0.5)*0.004), t); }
  c.endStroke();
  const s = c.serialize().pts; console.log("points", s.length);
  expect(s.length).toBeLessThanOrEqual(3);
});
