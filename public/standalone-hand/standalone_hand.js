// ============================================================
// BlockAR - Standalone 3D Cyan Hand Animation & Tracking Module
// Volumetric 3D hand (palm, wrist, 5 fingers, 21 joints)
// + glowing bones, holographic flesh, pinch ring VFX
// Modes: (1) Reference auto-animation  (2) Live camera tracking
// Fully isolated - no BlockAR gameplay dependencies.
// ============================================================

import * as THREE from "three";
import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8";

// ---------- MediaPipe topology ----------
export const HAND_BONES = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],[1,5]
];
const FINGERS = [
  { chain:[1,2,3,4],  name:"thumb"  },
  { chain:[5,6,7,8],  name:"index"  },
  { chain:[9,10,11,12], name:"middle" },
  { chain:[13,14,15,16], name:"ring"  },
  { chain:[17,18,19,20], name:"pinky" }
];
const PALM_TRIS = [[0,1,5],[0,5,9],[0,9,13],[0,13,17],[5,9,13],[9,13,17],[1,2,5],[0,1,2]];
const TIP_IDS = [4,8,12,16,20];

// Rest pose: open right hand, wrist at origin, units in meters
const REST = [
  [0,0,0],
  [-0.032,0.022,0.012],[-0.054,0.048,0.016],[-0.068,0.076,0.014],[-0.076,0.100,0.010],
  [-0.030,0.072,0.002],[-0.034,0.114,0.000],[-0.036,0.142,-0.002],[-0.037,0.166,-0.004],
  [-0.005,0.076,0.000],[-0.006,0.124,-0.002],[-0.006,0.158,-0.005],[-0.006,0.184,-0.007],
  [0.020,0.071,-0.002],[0.024,0.116,-0.004],[0.026,0.148,-0.006],[0.027,0.172,-0.008],
  [0.042,0.062,-0.004],[0.050,0.098,-0.006],[0.054,0.124,-0.008],[0.057,0.146,-0.010]
].map(p => new THREE.Vector3(...p));

// Per-finger flexion axes computed from rest pose (rotate around MCP pivots)
const FINGER_AXES = FINGERS.map(f => {
  const a = REST[f.chain[0]].clone(), b = REST[f.chain[1]].clone();
  const dir = b.sub(a).normalize();
  const palmN = new THREE.Vector3(0, 0, 1); // palm faces +z in rest pose
  return new THREE.Vector3().crossVectors(palmN, dir).normalize();
});

function poseFromCurls(curls) {
  // curls: { thumb:[a,b,c], index:[...], middle, ring, pinky } in radians
  const pts = REST.map(p => p.clone());
  FINGERS.forEach((f, fi) => {
    const c = curls[f.name];
    const axis = FINGER_AXES[fi];
    for (let k = 0; k < f.chain.length - 1; k++) {
      const pivot = pts[f.chain[k]];
      const ang = c[k];
      for (let m = k + 1; m < f.chain.length; m++) {
        pts[f.chain[m]].sub(pivot).applyAxisAngle(axis, ang).add(pivot);
      }
    }
  });
  return pts;
}

// ---------- Timeline (reference video choreography) ----------
const CYCLE = 8.0; // seconds
function smooth(t) { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); }
function phase(t, a, b) { return smooth((t - a) / (b - a)); }
const lerp = THREE.MathUtils.lerp;
const mixCurl = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));

const OPEN = { thumb:[0.05,0.03,0.02], index:[0.05,0.03,0.02], middle:[0.05,0.03,0.02], ring:[0.07,0.04,0.03], pinky:[0.09,0.05,0.03] };
const PRE  = { thumb:[0.35,0.45,0.35], index:[0.25,0.35,0.30], middle:[0.55,0.55,0.45], ring:[0.60,0.60,0.50], pinky:[0.62,0.60,0.50] };
const PINCHED = { thumb:[0.78,0.85,0.60], index:[0.72,0.80,0.55], middle:[0.85,0.85,0.70], ring:[0.88,0.88,0.75], pinky:[0.88,0.85,0.72] };

function timeline(t) {
  // returns { curls, groupPos, groupRotY, groupRotZ, pinchK (0..1) }
  const out = { curls: null, pos: new THREE.Vector3(), rotY: 0, rotZ: 0, pinchK: 0 };
  if (t < 1.6) {                      // OPEN HAND, gentle sway
    const k = phase(t, 0, 0.8);
    out.curls = mixCurl(PRE, OPEN, k);
    out.rotY = Math.sin(t * 1.2) * 0.15; out.rotZ = 0.05 + Math.sin(t * 0.9) * 0.04;
  } else if (t < 2.6) {               // fingers curl toward pinch
    const k = phase(t, 1.6, 2.6);
    out.curls = mixCurl(OPEN, PRE, k);
    out.rotY = lerp(0.15, 0.35, k); out.rotZ = lerp(0.05, -0.12, k);
  } else if (t < 3.2) {               // PINCH close
    const k = phase(t, 2.6, 3.2);
    out.curls = mixCurl(PRE, PINCHED, k);
    out.pinchK = k; out.rotY = lerp(0.35, 0.55, k); out.rotZ = -0.12;
  } else if (t < 5.0) {               // PINCH + MOVE
    const k = t - 3.2;
    out.curls = PINCHED; out.pinchK = 1;
    out.pos.set(Math.sin(k * 1.1) * 0.09, Math.sin(k * 0.8) * 0.05, Math.sin(k * 0.6) * 0.04);
    out.rotY = 0.55 + Math.sin(k * 1.0) * 0.12; out.rotZ = -0.12 + Math.sin(k * 0.7) * 0.06;
  } else if (t < 5.8) {               // RELEASE
    const k = phase(t, 5.0, 5.8);
    out.curls = mixCurl(PINCHED, PRE, k); out.pinchK = 1 - k;
    out.pos.multiplyScalar(1 - k); out.rotY = lerp(0.55, 0.15, k); out.rotZ = lerp(-0.12, 0.05, k);
  } else {                            // return to open, loop
    const k = phase(t, 5.8, 7.2);
    out.curls = mixCurl(PRE, OPEN, k);
    out.rotY = lerp(0.15, 0, k) + Math.sin(t * 1.2) * 0.1; out.rotZ = lerp(0.05, 0.05, k);
    if (t > 7.2) { const b = phase(t, 7.2, 7.9); out.rotY *= (1 - b); }
  }
  return out;
}

// ---------- Glow sprite texture ----------
function makeGlowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(160,245,255,1)");
  grad.addColorStop(0.35, "rgba(77,232,255,0.55)");
  grad.addColorStop(1, "rgba(77,232,255,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// ---------- Volumetric Hand Model ----------
export class VolumetricHand {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    this.cy = 0x4de8ff; // core cyan
    const glowTex = makeGlowTexture();
    this.glowTex = glowTex;

    // Materials
    this.matCore   = new THREE.MeshBasicMaterial({ color: 0x9ff2ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    this.matBone   = new THREE.MeshBasicMaterial({ color: this.cy, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    this.matFlesh  = new THREE.MeshBasicMaterial({ color: 0x1e9fd8, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.matPalm   = new THREE.MeshBasicMaterial({ color: 0x35c9f5, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.matGlow   = new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    this.matRing   = new THREE.MeshBasicMaterial({ color: 0x53ffc8, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

    // Geometries (created once, reused)
    const jointGeo = new THREE.SphereGeometry(1, 14, 10);
    const coreGeo  = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    const fleshGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);

    // 21 joints + tip glows
    this.joints = []; this.jointGlow = [];
    const radii = i => i === 0 ? 0.0145 : TIP_IDS.includes(i) ? 0.0095 : (i % 4 === 1 ? 0.0105 : 0.0092);
    for (let i = 0; i < 21; i++) {
      const m = new THREE.Mesh(jointGeo, this.matCore);
      m.scale.setScalar(radii(i)); m.renderOrder = 12;
      this.joints.push(m); this.group.add(m);
      const s = new THREE.Sprite(this.matGlow);
      s.scale.setScalar(TIP_IDS.includes(i) ? 0.05 : 0.035); s.renderOrder = 13;
      this.jointGlow.push(s); this.group.add(s);
    }

    // Bones: bright core inside translucent flesh capsule
    this.boneCore = []; this.boneFlesh = [];
    for (let i = 0; i < HAND_BONES.length; i++) {
      const c = new THREE.Mesh(coreGeo, this.matBone); c.renderOrder = 11;
      const f = new THREE.Mesh(fleshGeo, this.matFlesh); f.renderOrder = 10;
      this.boneCore.push(c); this.boneFlesh.push(f);
      this.group.add(c); this.group.add(f);
    }

    // Palm holographic mesh
    const palmGeo = new THREE.BufferGeometry();
    const idx = [];
    PALM_TRIS.forEach(t => idx.push(t[0], t[1], t[2]));
    palmGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(21 * 3), 3));
    palmGeo.setIndex(idx);
    this.palm = new THREE.Mesh(palmGeo, this.matPalm);
    this.palm.frustumCulled = false; this.palm.renderOrder = 9;
    this.group.add(this.palm);

    // Wrist cuff (torus)
    this.cuff = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.006, 10, 24), this.matBone);
    this.cuff.renderOrder = 11; this.group.add(this.cuff);

    // Pinch ring + flare
    this.pinchRing = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.0035, 10, 32), this.matRing);
    this.pinchRing.renderOrder = 14; this.group.add(this.pinchRing);
    this.pinchFlare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x53ffc8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.pinchFlare.scale.setScalar(0.09); this.pinchFlare.renderOrder = 15;
    this.group.add(this.pinchFlare);

    this.smoothed = REST.map(p => p.clone());
    this.hasPose = false;
    this._v = new THREE.Vector3();
  }

  // points: array of 21 THREE.Vector3 in hand-local space
  update(points, pinchActive) {
    if (!points || points.length < 21) { this.group.visible = false; this.hasPose = false; return; }
    this.group.visible = true;
    const k = this.hasPose ? 0.5 : 1.0; // EMA smoothing
    for (let i = 0; i < 21; i++) {
      this.smoothed[i].lerp(points[i], k);
      this.joints[i].position.copy(this.smoothed[i]);
      this.jointGlow[i].position.copy(this.smoothed[i]);
    }
    this.hasPose = true;

    const UP = new THREE.Vector3(0, 1, 0);
    HAND_BONES.forEach(([a, b], i) => {
      const A = this.smoothed[a], B = this.smoothed[b];
      this._v.subVectors(B, A); const len = Math.max(this._v.length(), 1e-5);
      const mid = this._v.clone().multiplyScalar(0.5).add(A);
      for (const [mesh, r] of [[this.boneCore[i], 0.0028], [this.boneFlesh[i], 0.0088]]) {
        mesh.position.copy(mid);
        mesh.scale.set(r, len, r);
        mesh.quaternion.setFromUnitVectors(UP, this._v.clone().normalize());
      }
    });

    // Palm geometry update
    const attr = this.palm.geometry.getAttribute("position");
    PALM_TRIS.flat().forEach((vi, n) => {
      attr.setXYZ(n, this.smoothed[vi].x, this.smoothed[vi].y, this.smoothed[vi].z);
    });
    // NOTE: attr length is 21 but indices reference up to 20; write per unique vertex:
    for (let i = 0; i < 21; i++) attr.setXYZ(i, this.smoothed[i].x, this.smoothed[i].y, this.smoothed[i].z);
    attr.needsUpdate = true;

    // Wrist cuff aligned to wrist->middle MCP direction
    const wd = this._v.subVectors(this.smoothed[9], this.smoothed[0]).normalize();
    this.cuff.position.copy(this.smoothed[0]);
    this.cuff.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), wd);
    this.cuff.visible = true;

    // Pinch visuals at midpoint of thumb tip (4) & index tip (8)
    const mid = this.smoothed[4].clone().add(this.smoothed[8]).multiplyScalar(0.5);
    const target = pinchActive ? 1 : 0;
    this._ringK = lerp(this._ringK || 0, target, 0.25);
    this.pinchRing.position.copy(mid);
    this.pinchRing.lookAt(0, 0, 5); // face camera-ish in local space; refined below
    this.pinchRing.material.opacity = this._ringK * 0.95;
    this.pinchRing.scale.setScalar(1 + Math.sin(performance.now() * 0.006) * 0.12 * this._ringK);
    this.pinchFlare.position.copy(mid);
    this.pinchFlare.material.opacity = this._ringK * 0.75;
  }

  setRingOrientation(camDir) { if (this.pinchRing) this.pinchRing.lookAt(camDir); }
}

// ---------- App ----------
const container = document.getElementById("canvas-container");
const video = document.getElementById("video-feed");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x070c14, 0.3, 1.4);
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 10);
camera.position.set(0, 0, 0.55);

// grid floor for depth cue
const grid = new THREE.GridHelper(1.2, 24, 0x0d3a52, 0x0a2536);
grid.position.y = -0.22; scene.add(grid);

const hand = new VolumetricHand(scene);

// Test cube (grab target)
const cube = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.045), new THREE.MeshStandardMaterial({ color: 0x3a7bff, roughness: 0.35, metalness: 0.15 }));
cube.position.set(0.10, 0.03, 0);
scene.add(cube);
scene.add(new THREE.AmbientLight(0x404a66, 1.4));
const key = new THREE.DirectionalLight(0x88bbff, 1.2); key.position.set(0.4, 0.8, 0.6); scene.add(key);

// ---------- State ----------
let mode = "anim"; // "anim" | "camera"
let paused = false;
let animT = 0, lastNow = performance.now();
let landmarkProvider = null; // function(now) -> {points, pinch}
let grab = { held: false, offset: new THREE.Vector3() };

const elMode = document.getElementById("diag-mode");
const elPhase = document.getElementById("diag-phase");
const elDist = document.getElementById("diag-dist");
const elStatus = document.getElementById("status-text");
const badge = document.getElementById("status-badge");
const btnAnim = document.getElementById("btn-anim");
const btnCam = document.getElementById("btn-camera");
const btnPause = document.getElementById("btn-pause");
const btnReset = document.getElementById("btn-reset");

function setMode(m) {
  mode = m;
  btnAnim.classList.toggle("active", m === "anim");
  btnCam.classList.toggle("active", m === "camera");
  if (m === "camera") { startCamera(); if (!paused) { paused = false; btnPause.textContent = "⏸ Pause"; } }
  else stopCamera();
  elMode.textContent = m === "anim" ? "REFERENCE ANIMATION" : "LIVE CAMERA (MEDIAPIPE)";
}
btnAnim.onclick = () => setMode("anim");
btnCam.onclick = () => setMode("camera");
btnPause.onclick = () => { paused = !paused; btnPause.textContent = paused ? "▶ Resume" : "⏸ Pause"; };
btnReset.onclick = () => { animT = 0; cube.position.set(0.10, 0.03, 0); grab.held = false; };

// ---------- Camera / MediaPipe ----------
let landmarker = null, camStream = null, lastVideoTime = -1;
let camPinch = false;

async function startCamera() {
  try {
    if (!landmarker) {
      const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/wasm");
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate: "GPU" },
        runningMode: "VIDEO", numHands: 2
      });
    }
    if (!camStream) {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = camStream;
      await video.play();
      video.classList.add("active");
    }
  } catch (err) {
    elStatus.textContent = "CAM ERROR: " + err.message;
    setMode("anim");
  }
}
function stopCamera() {
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; video.classList.remove("active"); }
}

// landmarks (normalized) -> hand-local world points, centered at wrist, scaled by palm size
function mapLandmarks(lm) {
  const w = lm[0], pts = [];
  const palmLen = Math.hypot(lm[9].x - w.x, lm[9].y - w.y) || 0.1;
  const s = 0.09 / palmLen;
  for (const p of lm) pts.push(new THREE.Vector3((p.x - w.x) * s, (w.y - p.y) * s, -(p.z || 0) * s * 0.9));
  return pts;
}

function pinchState(pts) {
  const d = pts[4].distanceTo(pts[8]);
  const palmLen = pts[0].distanceTo(pts[9]) || 0.09;
  const norm = d / palmLen;
  if (!camPinch && norm < 0.55) camPinch = true;
  else if (camPinch && norm > 0.85) camPinch = false;
  return { pinched: camPinch, norm };
}

// ---------- Loop ----------
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min((now - lastNow) / 1000, 0.05); lastNow = now;
  if (paused) { renderer.render(scene, camera); return; }

  let pinched = false, phaseText = "", distText = "";

  if (mode === "anim") {
    animT = (animT + dt) % CYCLE;
    const t = timeline(animT);
    const pts = poseFromCurls(t.curls);
    // small continuous breathing motion
    pts.forEach(p => { p.x += Math.sin(animT * 2.2) * 0.0015; p.y += Math.sin(animT * 1.7) * 0.0015; });
    hand.group.position.copy(t.pos);
    hand.group.rotation.set(0, t.rotY, t.rotZ);
    hand.update(pts, t.pinchK > 0.5);
    pinched = t.pinchK > 0.5;
    phaseText = pinched ? (t.pinchK < 1 ? "PINCHING" : "PINCH + MOVE") : (animT < 1.6 ? "OPEN HAND" : animT < 3.2 ? "MOVING FINGERS" : animT < 5.0 ? "PINCHED" : "RELEASING");
    distText = (pts[4].distanceTo(pts[8]) * 100).toFixed(1) + " cm";

    // cube grab demo (auto mode)
    const mid = new THREE.Vector3().addVectors(pts[4], pts[8]).multiplyScalar(0.5).applyMatrix4(hand.group.matrixWorld);
    cubeLogic(mid, pinched);
  } else {
    if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const res = landmarker.detectForVideo(video, now);
      if (res.landmarks && res.landmarks.length > 0) {
        const pts = mapLandmarks(res.landmarks[0]);
        hand.group.position.set(0, 0, 0);
        hand.group.rotation.set(0, 0, 0);
        hand.update(pts, camPinch);
        const st = pinchState(pts);
        pinched = st.pinched;
        distText = (st.norm * 100).toFixed(0) + " %";
        phaseText = pinched ? "PINCH (CAMERA)" : "TRACKING";
        // cube: pinch point in world (hand local == world offset here)
        const mid = new THREE.Vector3().addVectors(pts[4], pts[8]).multiplyScalar(0.5);
        cubeLogic(mid, pinched);
      } else {
        hand.update(null, false);
        phaseText = "LOOKING FOR HAND…"; distText = "—";
        grab.held = false;
      }
    }
  }

  elPhase.textContent = phaseText; elDist.textContent = distText;
  elStatus.textContent = pinched ? "PINCH" : phaseText || "—";
  badge.classList.toggle("pinched", pinched);

  renderer.render(scene, camera);
}

function cubeLogic(pinchWorld, pinched) {
  if (pinched) {
    if (!grab.held && pinchWorld.distanceTo(cube.position) < 0.07) {
      grab.held = true; grab.offset.subVectors(cube.position, pinchWorld);
    }
    if (grab.held) cube.position.copy(pinchWorld).add(grab.offset);
  } else grab.held = false;
  cube.rotation.y += 0.01;
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

setMode("anim");
requestAnimationFrame(tick);
