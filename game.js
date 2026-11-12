// ============================================================
//  FREESTYLE CAR CRASH — game.js
//  Arcade driving, destruction, rail grinding & freestyle tricks
// ============================================================

import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js';

const MOBILE = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
const TAU = Math.PI * 2;
const $ = (id) => document.getElementById(id);

// ─────────────────────────────────────────────────────────────
//  SMALL HELPERS
// ─────────────────────────────────────────────────────────────
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
function approach(v, target, delta) { return v < target ? Math.min(target, v + delta) : Math.max(target, v - delta); }
function wrapAngle(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
function approachAngle(a, b, step) { return a + clamp(wrapAngle(b - a), -step, step); }
const deadzone = (v) => Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88;

// Seeded RNG so the city is the same every load (effects use Math.random)
let _seed = 20240611;
function rand() {
  _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rng = (a, b) => a + rand() * (b - a);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// Cached DOM
const ui = {
  score: $('score-value'), speed: $('speed-value'), air: $('air-display'), grind: $('grind-display'),
  cam: $('cam-display'), gear: $('gear-display')
};
if (ui.air) ui.air.style.whiteSpace = 'nowrap';
if (ui.grind) ui.grind.style.whiteSpace = 'nowrap';
function setText(el, s) { if (el && el._t !== s) { el._t = s; el.textContent = s; } }
function setHidden(el, h) { if (el && el._h !== h) { el._h = h; el.classList.toggle('hidden', h); } }

// ─────────────────────────────────────────────────────────────
//  GLOBALS & CONSTANTS
// ─────────────────────────────────────────────────────────────
let scene, camera, renderer, clock, sun;
let car, carBody;
let wheels = [];
let cameraMode = 0;
const CAM_MODES = ['CHASE CAM', 'BUMPER CAM'];

let gameRunning = false, gamePaused = false, loopActive = false;

const colliders = [];      // building / ledge boxes {minX,maxX,minZ,maxZ,top}
const destructibles = [];
const ramps = [];
const rails = [];          // grindable rails {a,b,dir,len}
const reserved = [];       // areas where buildings / trees must not spawn
const railZones = [];      // corridors kept free of overhead rails
const roadBounds = [], solids = [];
const flying = [];

const ROAD_W = 7.0, SIDE_W = 1.4, ROAD_H = 0.05, WORLD = 200;
const GRID = [-160, -120, -80, -40, 0, 40, 80, 120, 160];
const CAR_Y = 0.45;        // car pivot height above the surface it drives on
const RAIL_OFF = 0.55;     // car pivot height above a rail's centre line

let score = 0, popupCount = 0;
const SCORE_TABLE = { barrel: 150, crate: 100, bin: 80, cone: 50, hydrant: 200, tree: 300, fence: 120, bench: 90, lamp: 140, light: 180, grind: 25 };

// ── Input state
const keys = { forward: false, back: false, left: false, right: false, brake: false, jump: false, dash: false };
const joyState = { active: false, x: 0, y: 0 };
let jumpPressed = false;

// ── Car physics state
const carState = {
  speed: 0, steerAngle: 0, heading: 0, angularVel: 0,
  position: new THREE.Vector3(0, CAR_Y, 25),
  vx: 0, vz: 0, velY: 0,
  lean: 0, pitch: 0, wheelRot: 0, pedal: 0, steerInput: 0, bob: 0,
  onGround: true, airTime: 0, coyote: 0, jumpBuffer: 0, wipeT: 0,
  airPitch: 0, airRoll: 0, airYaw: 0, airPitchVel: 0, airRollVel: 0,
  rampRef: null, rampLZ: 0,
  grinding: false, grindRail: null, grindT: 0, grindDir: 1, grindSpeed: 0,
  grindOff: new THREE.Vector3(), grindTime: 0, grindAcc: 0, grindPts: 0, railCooldown: 0,
  bannerText: '', bannerT: 0,
  // ── Wall-ride state ──────────────────────────────────────────
  wallRide: false, wallNX: 0, wallNZ: 0, wallTimer: 0, wallCooldown: 0,
  // ── Dash state ───────────────────────────────────────────────
  dashCooldown: 0,
  // ── Double-jump state ────────────────────────────────────────
  canDoubleJump: true
};

// ── Driving constants
const CAR_MAX_SPEED   = 48;
const CAR_ACCEL       = 27;
const CAR_BRAKE_FORCE = 42;
const CAR_REVERSE_ACC = 15;
const CAR_ROLL_FRIC   = 2.4;
const CAR_AERO        = 0.0015;
const CAR_STEER_MAX   = 0.6;     // visual wheel angle
const YAW_LOW         = 2.7;     // rad/s steering rate at low speed
const YAW_HIGH        = 1.25;    // rad/s steering rate at top speed
const GRIP            = 10;      // lateral grip (higher = more traction)
const GRIP_HAND       = 5;
const GRIP_DRIFT      = 2.4;
const DRIFT_ENTRY_SPD = 7;
const DRIFT_YAW_BOOST = 1.45;
const JUMP_FORCE      = 13.5;
const GRAVITY         = 22;
const HW = 0.8, HL = 1.8;        // ground collision half extents
const AIR_HW = 1.0, AIR_HL = 1.0;
// ── Dash constant ────────────────────────────────────────────────
const DASH_IMPULSE    = 22;     // extra forward speed on dash
const DASH_COOLDOWN   = 1.2;    // seconds between dashes
// ── Nitro constants ──────────────────────────────────────────────
const NITRO_MAX_SPEED = 72;     // top speed while nitro is held
const NITRO_ACCEL     = 38;     // acceleration rate during nitro
// ── Wall-ride constants ──────────────────────────────────────────
const WALL_MIN_SPD    = 7;      // min speed to attach (lowered so attachment feels automatic)
const WALL_GRAVITY    = 4.5;    // downward pull while wall-riding (gentler than GRAVITY=22)
const WALL_STICK      = 20;     // lateral force holding car against wall
const WALL_MAX_TIME   = 3.0;    // max seconds before sliding off
const WALL_JUMP_KICK  = 12;     // lateral kick away from wall on wall-jump

const camPos = new THREE.Vector3(), camTarget = new THREE.Vector3();
const _cp = new THREE.Vector3(), _ct = new THREE.Vector3(), _pv = new THREE.Vector3();
// ── Camera orbit (right-mouse drag — full 360° horizontal + vertical) ──
let camOrbitYaw = 0;          // horizontal orbit around car (radians, full 360°)
let camOrbitPitch = 0.28;     // vertical orbit angle (radians; 0 = horizon, clamped 0.05–1.4)
let _rmbDown = false, _rmbLastX = 0, _rmbLastY = 0;

// ─────────────────────────────────────────────────────────────
//  SCORE & POPUPS
// ─────────────────────────────────────────────────────────────
function popup(text, wx, wy, wz) {
  if (!camera || popupCount >= 8) return;
  _pv.set(wx, wy, wz).project(camera);
  if (_pv.z > 1) return;
  const px = clamp((_pv.x * 0.5 + 0.5) * window.innerWidth, 40, window.innerWidth - 120);
  const py = clamp((_pv.y * -0.5 + 0.5) * window.innerHeight, 60, window.innerHeight - 60);
  const div = document.createElement('div');
  div.className = 'score-popup';
  div.textContent = text;
  div.style.left = px + 'px'; div.style.top = py + 'px';
  document.body.appendChild(div);
  popupCount++;
  setTimeout(() => { div.remove(); popupCount--; }, 1200);
}

function addScore(pts, wx, wz, label) {
  score += pts;
  if (ui.score) {
    ui.score.classList.remove('bump'); void ui.score.offsetWidth; ui.score.classList.add('bump');
    setTimeout(() => ui.score.classList.remove('bump'), 200);
  }
  if (wx !== undefined) popup((label ? label + '  ' : '') + '+' + pts, wx, 1.5, wz);
}

// ─────────────────────────────────────────────────────────────
//  GEOMETRY BATCHING (merge many boxes into one draw call)
// ─────────────────────────────────────────────────────────────
class Batch {
  constructor() { this.p = []; this.n = []; this.u = []; this.c = []; }
  add(geo, color = 0xffffff, matrix = null) {
    if (matrix) geo.applyMatrix4(matrix);
    const g = geo.index ? geo.toNonIndexed() : geo;
    const pa = g.attributes.position.array, na = g.attributes.normal.array;
    const ua = g.attributes.uv ? g.attributes.uv.array : new Float32Array(pa.length / 3 * 2);
    const cnt = pa.length / 3;
    const cc = color instanceof THREE.Color ? color : new THREE.Color(color);
    const col = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) { col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b; }
    this.p.push(pa); this.n.push(na); this.u.push(ua); this.c.push(col);
    if (g !== geo) g.dispose();
    geo.dispose();
  }
  static cat(arrs) {
    let total = 0; for (const a of arrs) total += a.length;
    const out = new Float32Array(total); let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }
  geometry() {
    if (!this.p.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(Batch.cat(this.p), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(Batch.cat(this.n), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(Batch.cat(this.u), 2));
    geo.setAttribute('color', new THREE.BufferAttribute(Batch.cat(this.c), 3));
    geo.computeBoundingSphere();
    return geo;
  }
  build(material, cast = false, receive = true) {
    const geo = this.geometry();
    if (!geo) return null;
    const m = new THREE.Mesh(geo, material);
    m.castShadow = cast; m.receiveShadow = receive;
    return m;
  }
}

const _tq = new THREE.Quaternion(), _te = new THREE.Euler(), _ts = new THREE.Vector3(1, 1, 1), _tp = new THREE.Vector3();
function mat4(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  _te.set(rx, ry, rz); _tq.setFromEuler(_te);
  return new THREE.Matrix4().compose(_tp.set(x, y, z), _tq, _ts);
}
const bx = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const cyl = (rt, rb, h, seg, x = 0, y = 0, z = 0) => new THREE.CylinderGeometry(rt, rb, h, seg).translate(x, y, z);
function scaleFaceUV(g, face, su, sv) {
  const uv = g.attributes.uv;
  for (let i = face * 4; i < face * 4 + 4; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}
// Box with UVs tiled for a window facade (tiles = whole windows, no cut-off)
function wallGeo(w, h, d, cx, cy, cz) {
  const g = new THREE.BoxGeometry(w, h, d);
  const tv = Math.max(1, Math.round(h / 7));
  const tuD = Math.max(1, Math.round(d / 8)), tuW = Math.max(1, Math.round(w / 8));
  scaleFaceUV(g, 0, tuD, tv); scaleFaceUV(g, 1, tuD, tv);
  scaleFaceUV(g, 4, tuW, tv); scaleFaceUV(g, 5, tuW, tv);
  scaleFaceUV(g, 2, 0.01, 0.01); scaleFaceUV(g, 3, 0.01, 0.01);
  return g.translate(cx, cy, cz);
}

// ─────────────────────────────────────────────────────────────
//  PROCEDURAL CANVAS TEXTURES (small, tiled, cheap)
// ─────────────────────────────────────────────────────────────
function cv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function mkTex(c) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function speckle(g, w, h, n, cols, size = 2) {
  for (let i = 0; i < n; i++) { g.fillStyle = cols[i % cols.length]; g.fillRect(rand() * w, rand() * h, size, size); }
}

const SIGN_WORDS = ['RAMEN', 'DISCO', 'PIZZA', '24H', 'ARCADE', 'JET'];
const SIGN_COLORS = ['#ff4fd8', '#35f0ff', '#ffe14a', '#7dff4a', '#ff8a3a', '#ffffff'];
const TEX = {};
const MAT = {};

function facadeTex(kind) {
  const [c, g] = cv(128, 128);
  const R = (col, x, y, w, h) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  if (kind === 0) { // apartments
    R('#f4ede2', 0, 0, 128, 128);
    for (let cx = 0; cx < 2; cx++) for (let cy = 0; cy < 2; cy++) {
      const x = cx * 64, y = cy * 64;
      R('#ffffff', x + 10, y + 8, 44, 48);
      R(rand() < 0.35 ? '#ffe08a' : '#3b5875', x + 14, y + 12, 36, 40);
      R('#ffffff', x + 31, y + 12, 2, 40); R('#ffffff', x + 14, y + 31, 36, 2);
      R('#c9b9a0', x + 8, y + 56, 48, 5);
    }
    R('#e2d6c2', 0, 62, 128, 3);
  } else if (kind === 1) { // glass office
    R('#c9d3dc', 0, 0, 128, 128);
    for (let cy = 0; cy < 2; cy++) {
      const y = cy * 64 + 10;
      R('#2f5f8f', 0, y, 128, 42); R('#5f9bd0', 0, y, 128, 8);
      for (let x = 0; x < 128; x += 16) R('#c9d3dc', x, y, 2, 42);
      for (let i = 0; i < 3; i++) R('#7fb3de', rand() * 120, y + 12 + rand() * 24, 8, 2);
    }
    R('#aab6c2', 0, 60, 128, 6);
  } else if (kind === 2) { // brick
    R('#c4694a', 0, 0, 128, 128);
    for (let y = 0; y < 128; y += 8) {
      R('#8f4a35', 0, y, 128, 1);
      for (let x = ((y / 8) % 2) * 8; x < 128; x += 16) R('#8f4a35', x, y, 1, 8);
    }
    for (let cx = 0; cx < 2; cx++) for (let cy = 0; cy < 2; cy++) {
      const x = cx * 64, y = cy * 64;
      R('#f3e6d0', x + 12, y + 10, 40, 44);
      R(rand() < 0.3 ? '#ffd36b' : '#2d3e56', x + 16, y + 14, 32, 36);
      R('#f3e6d0', x + 31, y + 14, 2, 36);
    }
  } else if (kind === 3) { // retro portholes
    R('#f8e8c8', 0, 0, 128, 128);
    for (let x = 0; x < 128; x += 8) R('#ecd7aa', x, 0, 3, 128);
    for (let cx = 0; cx < 2; cx++) for (let cy = 0; cy < 2; cy++) {
      const x = cx * 64 + 32, y = cy * 64 + 32;
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x, y, 18, 0, TAU); g.fill();
      g.fillStyle = rand() < 0.3 ? '#ffd36b' : '#245a78'; g.beginPath(); g.arc(x, y, 13, 0, TAU); g.fill();
    }
  } else { // neon club
    R('#272642', 0, 0, 128, 128);
    const nc = ['#ff4fd8', '#35f0ff', '#ffe14a'];
    for (let cx = 0; cx < 2; cx++) for (let cy = 0; cy < 2; cy++) {
      const x = cx * 64, y = cy * 64;
      R('#ffffff', x + 10, y + 12, 44, 38);
      R(nc[(cx + cy * 2 + ((rand() * 3) | 0)) % 3], x + 13, y + 15, 38, 32);
    }
    R('#ffd400', 0, 60, 128, 3); R('#ffd400', 0, 124, 128, 3);
  }
  return mkTex(c);
}

function initTextures() {
  // Road: asphalt, white edge lines, yellow dashed centre line (u = along the road, 8 units/tile)
  let [c, g] = cv(128, 128);
  g.fillStyle = '#2c2c3d'; g.fillRect(0, 0, 128, 128);
  speckle(g, 128, 128, 420, ['#34344a', '#25253a', '#3a3a52'], 2);
  g.fillStyle = '#f4f4f4'; g.fillRect(0, 6, 128, 3); g.fillRect(0, 119, 128, 3);
  g.fillStyle = '#ffd400'; g.fillRect(8, 62, 64, 4);
  TEX.road = mkTex(c);

  [c, g] = cv(64, 64);
  g.fillStyle = '#2c2c3d'; g.fillRect(0, 0, 64, 64);
  speckle(g, 64, 64, 200, ['#34344a', '#25253a', '#3a3a52'], 2);
  TEX.asphalt = mkTex(c);

  // Sidewalk: 4 pavers with orange curb stripes
  [c, g] = cv(128, 64);
  g.fillStyle = '#e8d9c4'; g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#b8a98f'; for (let x = 0; x < 128; x += 32) g.fillRect(x, 0, 2, 64);
  g.fillRect(0, 31, 128, 2);
  g.fillStyle = '#ff9f1c'; g.fillRect(0, 0, 128, 6); g.fillRect(0, 58, 128, 6);
  speckle(g, 128, 64, 60, ['#d4c4ab'], 2);
  TEX.side = mkTex(c);

  // Grass with flowers
  [c, g] = cv(128, 128);
  g.fillStyle = '#26c45f'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 14; i++) { g.fillStyle = i % 2 ? '#1fb353' : '#33d46c'; g.beginPath(); g.ellipse(rand() * 128, rand() * 128, 6 + rand() * 12, 4 + rand() * 8, rand() * 3, 0, TAU); g.fill(); }
  speckle(g, 128, 128, 120, ['#4be27f', '#1a9a47'], 2);
  speckle(g, 128, 128, 6, ['#ff7ab8', '#ffe34a', '#ffffff'], 3);
  TEX.grass = mkTex(c); TEX.grass.repeat.set(100, 100);

  // Plaza: pink checker with cyan grid
  [c, g] = cv(128, 128);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { g.fillStyle = (i + j) % 2 ? '#ff8fc7' : '#ffd6ec'; g.fillRect(i * 32, j * 32, 32, 32); }
  g.fillStyle = '#35f0ff'; for (let i = 0; i < 128; i += 64) { g.fillRect(i, 0, 2, 128); g.fillRect(0, i, 128, 2); }
  TEX.plaza = mkTex(c);

  // Facades
  TEX.facade = [0, 1, 2, 3, 4].map(facadeTex);

  // Rooftop gravel
  [c, g] = cv(64, 64);
  g.fillStyle = '#6a6a7a'; g.fillRect(0, 0, 64, 64);
  speckle(g, 64, 64, 240, ['#7a7a8a', '#585868'], 2);
  g.fillStyle = '#505060'; g.fillRect(0, 0, 64, 2); g.fillRect(0, 0, 2, 64);
  TEX.roof = mkTex(c);

  // Shopfront band
  [c, g] = cv(128, 64);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#ffd400'; g.fillRect(0, 0, 128, 8);
  g.fillStyle = '#2f6a88'; g.fillRect(6, 16, 50, 44); g.fillRect(72, 16, 50, 44);
  g.fillStyle = '#9fd8ee'; g.fillRect(6, 16, 50, 10); g.fillRect(72, 16, 50, 10);
  g.fillStyle = '#ffffff'; g.fillRect(30, 16, 2, 44); g.fillRect(96, 16, 2, 44);
  g.fillStyle = '#5a3a2a'; g.fillRect(58, 20, 12, 44);
  TEX.shop = mkTex(c);

  // Ramp surface: magenta with white cross-bands, yellow edge bars
  [c, g] = cv(64, 64);
  g.fillStyle = '#ff2bd6'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 8);
  g.fillStyle = '#ffe14a'; g.fillRect(0, 0, 4, 64); g.fillRect(60, 0, 4, 64);
  TEX.ramp = mkTex(c);

  // Zebra crossing (transparent)
  [c, g] = cv(64, 64);
  g.clearRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillRect(0, 0, 64, 34);
  TEX.zebra = mkTex(c);

  // Neon signs
  TEX.signs = SIGN_WORDS.map((w, i) => {
    const [sc, sg] = cv(128, 64);
    sg.fillStyle = '#12001f'; sg.fillRect(0, 0, 128, 64);
    sg.strokeStyle = SIGN_COLORS[i]; sg.lineWidth = 4; sg.strokeRect(4, 4, 120, 56);
    sg.shadowColor = SIGN_COLORS[i]; sg.shadowBlur = 8;
    sg.fillStyle = SIGN_COLORS[i]; sg.font = '34px Impact, sans-serif'; sg.textAlign = 'center'; sg.textBaseline = 'middle';
    sg.fillText(w, 64, 34);
    const t = new THREE.CanvasTexture(sc); t.colorSpace = THREE.SRGBColorSpace; return t;
  });
}

function initMaterials() {
  const lam = (o) => new THREE.MeshLambertMaterial(o);
  MAT.road = lam({ map: TEX.road });
  MAT.asphalt = lam({ map: TEX.asphalt });
  MAT.side = lam({ map: TEX.side });
  MAT.grass = lam({ map: TEX.grass });
  MAT.plaza = lam({ map: TEX.plaza });
  MAT.facade = TEX.facade.map(t => lam({ map: t, vertexColors: true }));
  MAT.roof = lam({ map: TEX.roof, vertexColors: true });
  MAT.shop = lam({ map: TEX.shop, vertexColors: true });
  MAT.prop = lam({ vertexColors: true, flatShading: true });
  MAT.metal = lam({ vertexColors: true, emissive: 0x1a1a22 });
  MAT.ramp = lam({ map: TEX.ramp, side: THREE.DoubleSide, emissive: 0x330033 });
  MAT.rampSide = lam({ vertexColors: true, side: THREE.DoubleSide, flatShading: true });
  MAT.zebra = lam({ map: TEX.zebra, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  MAT.sign = TEX.signs.map(t => new THREE.MeshBasicMaterial({ map: t }));
  MAT.glass = lam({ vertexColors: true, transparent: true, opacity: 0.8, side: THREE.DoubleSide, emissive: 0x08202a });
  MAT.light = new THREE.MeshBasicMaterial({ vertexColors: true });
  MAT.tail = new THREE.MeshBasicMaterial({ color: 0xaa1030 });
  MAT.glow = new THREE.MeshBasicMaterial({ color: 0x00ffe0, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  MAT.cloud = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, transparent: true, opacity: 0.92 });
  MAT.sun = new THREE.MeshBasicMaterial({ color: 0xfff6a0, fog: false });
}

// ─────────────────────────────────────────────────────────────
//  PARTICLE POOLS (sparks, dust, debris) — 3 draw calls total
// ─────────────────────────────────────────────────────────────
const PT_VERT = `
attribute vec4 pcolor; attribute float psize; uniform float uScale; varying vec4 vC;
void main(){ vC = pcolor; vec4 mv = modelViewMatrix * vec4(position,1.0);
  gl_PointSize = psize * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`;
const PT_FRAG = `
varying vec4 vC;
void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
  gl_FragColor = vec4(vC.rgb, vC.a * smoothstep(0.5, 0.2, d)); }`;

class ParticlePool {
  constructor(max, additive, grav, drag, grow) {
    this.max = max; this.i = 0; this.grav = grav; this.drag = drag; this.grow = grow;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4); this.siz = new Float32Array(max);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.a0 = new Float32Array(max); this.s0 = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSiz = new THREE.BufferAttribute(this.siz, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos); geo.setAttribute('pcolor', this.aCol); geo.setAttribute('psize', this.aSiz);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } }, vertexShader: PT_VERT, fragmentShader: PT_FRAG,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  emit(x, y, z, vx, vy, vz, life, r, g, b, a, size) {
    const i = this.i; this.i = (i + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
    this.life[i] = life; this.maxLife[i] = life; this.a0[i] = a; this.s0[i] = size; this.siz[i] = size;
  }
  update(dt, scale) {
    this.mat.uniforms.uScale.value = scale;
    const dragK = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.siz[i] = 0; continue; }
      const f = this.life[i] / this.maxLife[i];
      this.vel[i * 3] *= dragK; this.vel[i * 3 + 2] *= dragK;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dragK - this.grav * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.12) { this.pos[i * 3 + 1] = 0.12; this.vel[i * 3 + 1] *= -0.35; }
      this.col[i * 4 + 3] = this.a0[i] * f;
      this.siz[i] = this.s0[i] * (1 + (1 - f) * this.grow);
    }
    this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aSiz.needsUpdate = true;
  }
}
let sparks, dust, chips;

function setupFX() {
  sparks = new ParticlePool(MOBILE ? 120 : 220, true, 14, 0.6, -0.5);
  dust = new ParticlePool(MOBILE ? 70 : 120, false, -0.6, 1.6, 1.6);
  chips = new ParticlePool(MOBILE ? 90 : 160, false, 22, 0.3, 0);
}
function updateFX(dt) {
  const scale = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
  sparks.update(dt, scale); dust.update(dt, scale); chips.update(dt, scale);
}
function emitDust(x, y, z, n, spread, up, shade = 0.85, size = 0.9) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, s = Math.random() * spread;
    dust.emit(x + (Math.random() - 0.5) * 0.6, y, z + (Math.random() - 0.5) * 0.6, Math.cos(a) * s, Math.random() * up, Math.sin(a) * s,
      0.5 + Math.random() * 0.4, shade, shade, shade, 0.45, size);
  }
}
function emitChips(x, y, z, color, n) {
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) {
    chips.emit(x, y, z, (Math.random() - 0.5) * 9, 3 + Math.random() * 7, (Math.random() - 0.5) * 9,
      0.7 + Math.random() * 0.6, c.r, c.g, c.b, 1, 0.28 + Math.random() * 0.2);
  }
}
function emitSparks(x, y, z, vx, vz, n, speedK = 1) {
  for (let i = 0; i < n; i++) {
    sparks.emit(x, y, z, vx + (Math.random() - 0.5) * 4, 1.5 + Math.random() * 4 * speedK, vz + (Math.random() - 0.5) * 4,
      0.3 + Math.random() * 0.35, 1, 0.55 + Math.random() * 0.4, 0.15, 1, 0.22 + Math.random() * 0.1);
  }
}

// ─────────────────────────────────────────────────────────────
//  INIT & UI
// ─────────────────────────────────────────────────────────────
function init() {
  initTextures();
  initMaterials();
  setupUI();
}

function startGame() {
  $('main-menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('pause-menu').classList.add('hidden');

  if (!scene) {
    setupRenderer();
    setupScene();
    setupLights();
    setupFX();
    setupCar();
    buildCity();
    setupEventListeners();
    clock = new THREE.Clock();
  }
  resetCarPosition();
  gameRunning = true; gamePaused = false;
  clock.getDelta(); if (!loopActive) loop();
}

function setupUI() {
  $('btn-start').addEventListener('click', startGame);
  $('btn-controls').addEventListener('click', () => $('controls-overlay').classList.remove('hidden'));
  $('btn-controls-close').addEventListener('click', () => $('controls-overlay').classList.add('hidden'));
  $('btn-pause-hud').addEventListener('click', togglePause);
  $('btn-reset-hud').addEventListener('click', resetCarPosition);
  $('btn-resume').addEventListener('click', togglePause);
  $('btn-restart').addEventListener('click', () => { $('pause-menu').classList.add('hidden'); score = 0; resetCarPosition(); gameRunning = true; gamePaused = false; clock.getDelta(); if (!loopActive) loop(); });
  $('btn-mainmenu').addEventListener('click', () => { gameRunning = false; gamePaused = false; $('pause-menu').classList.add('hidden'); $('hud').classList.add('hidden'); $('main-menu').classList.remove('hidden'); });

  // Joystick
  const joyZone = $('joystick-zone'), joyBase = $('joystick-base'), joyKnob = $('joystick-knob');
  let joyStartX = 0, joyStartY = 0;
  joyZone.addEventListener('pointerdown', (e) => {
    joyState.active = true;
    const rect = joyZone.getBoundingClientRect();
    joyStartX = e.clientX - rect.left; joyStartY = e.clientY - rect.top;
    joyBase.style.display = 'block'; joyBase.style.left = joyStartX + 'px'; joyBase.style.top = joyStartY + 'px';
    joyKnob.style.transform = 'translate(0px, 0px)';
    joyZone.setPointerCapture(e.pointerId);
  });
  joyZone.addEventListener('pointermove', (e) => {
    if (!joyState.active) return;
    const rect = joyZone.getBoundingClientRect();
    let dx = (e.clientX - rect.left) - joyStartX, dy = (e.clientY - rect.top) - joyStartY;
    const maxR = 45, dist = Math.hypot(dx, dy);
    if (dist > maxR) { dx = (dx / dist) * maxR; dy = (dy / dist) * maxR; }
    joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    joyState.x = dx / maxR; joyState.y = dy / maxR;
  });
  const endJoy = (e) => {
    joyState.active = false; joyState.x = 0; joyState.y = 0; joyBase.style.display = 'none';
    try { joyZone.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
  };
  joyZone.addEventListener('pointerup', endJoy); joyZone.addEventListener('pointercancel', endJoy);

  // Buttons
  const bindBtn = (id, key) => {
    const el = $(id);
    if (!el) return;
    const down = (e) => { e.preventDefault(); keys[key] = true; el.classList.add('active'); };
    const up = (e) => { e.preventDefault(); keys[key] = false; el.classList.remove('active'); };
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
  };
  bindBtn('btn-accel', 'forward'); bindBtn('btn-jump', 'jump');
  bindBtn('btn-handbrake', 'brake');   // nitro (Shift) — held to boost
  // Freestyle trick buttons (mobile-only extra column)
  bindBtn('btn-flip-fwd', 'forward');
  bindBtn('btn-flip-bwd', 'back');
  // Dash button — fires once on touch (not a held key)
  const dashEl = $('btn-dash');
  if (dashEl) dashEl.addEventListener('touchstart', (e) => { e.preventDefault(); keys.dash = true; }, { passive: false });
}

// ─────────────────────────────────────────────────────────────
//  RENDERER, SCENE & LIGHTS
// ─────────────────────────────────────────────────────────────
function setupRenderer() {
  renderer = new THREE.WebGLRenderer({ canvas: $('game-canvas'), antialias: !MOBILE, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MOBILE ? 1.25 : 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0xff4a80);
}

function setupScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xff4a80);
  scene.fog = new THREE.FogExp2(0xff4a80, 0.005);
  camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 700);
}

function setupLights() {
  scene.add(new THREE.AmbientLight(0xffccff, 0.85));
  sun = new THREE.DirectionalLight(0xfffaaa, 1.4);
  sun.position.set(100, 150, -80);
  sun.castShadow = true;
  const ms = MOBILE ? 1024 : 2048;
  sun.shadow.mapSize.set(ms, ms);
  const d = 90;
  sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
  sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 500;
  sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.05;
  scene.add(sun); scene.add(sun.target);
}

function releaseKeys() { for (const k in keys) keys[k] = false; }

function setupEventListeners() {
  document.addEventListener('keydown', e => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    keys.forward = true; break;
      case 'KeyS': case 'ArrowDown':  keys.back = true; break;
      case 'KeyA': case 'ArrowLeft':  keys.left = true; break;
      case 'KeyD': case 'ArrowRight': keys.right = true; break;
      case 'Space': keys.jump = true; e.preventDefault(); break;
      case 'ShiftLeft': case 'ShiftRight': keys.brake = true; e.preventDefault(); break;
      case 'KeyF': if (!e.repeat) keys.dash = true; break;
      case 'KeyR': if (!e.repeat) resetCarPosition(); break;
      case 'KeyC': if (!e.repeat) cycleCameraMode(); break;
      case 'Escape': if (gameRunning && !e.repeat) togglePause(); break;
    }
  });
  document.addEventListener('keyup', e => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    keys.forward = false; break;
      case 'KeyS': case 'ArrowDown':  keys.back = false; break;
      case 'KeyA': case 'ArrowLeft':  keys.left = false; break;
      case 'KeyD': case 'ArrowRight': keys.right = false; break;
      case 'Space': keys.jump = false; break;
      case 'ShiftLeft': case 'ShiftRight': keys.brake = false; break;
    }
  });
  // Right-mouse drag → 360° camera orbit (horizontal + vertical)
  const canvas = $('game-canvas');
  canvas.addEventListener('mousedown', e => {
    if (e.button === 2) { _rmbDown = true; _rmbLastX = e.clientX; _rmbLastY = e.clientY; }
  });
  window.addEventListener('mouseup', e => { if (e.button === 2) _rmbDown = false; });
  window.addEventListener('mousemove', e => {
    if (!_rmbDown || !gameRunning || gamePaused) return;
    const dx = e.clientX - _rmbLastX, dy = e.clientY - _rmbLastY;
    _rmbLastX = e.clientX; _rmbLastY = e.clientY;
    camOrbitYaw   += dx * 0.006;                                      // full 360° — no clamp
    camOrbitPitch  = clamp(camOrbitPitch + dy * 0.004, 0.05, 1.4);   // limit: near-horizon to near-top
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('blur', releaseKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { releaseKeys(); if (gameRunning && !gamePaused) togglePause(); } });
  window.addEventListener('resize', () => {
    if (!renderer) return;
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  });
}

// ─────────────────────────────────────────────────────────────
//  CAR (detailed low-poly model, merged into a handful of meshes)
// ─────────────────────────────────────────────────────────────
let tailBright = false;
function setupCar() {
  car = new THREE.Group(); scene.add(car);
  carBody = new THREE.Group(); car.add(carBody);

  const YEL = 0xffe800, PINK = 0xff0055, DARK = 0x181826, TRIM = 0x20202c;
  const body = new Batch(), glass = new Batch(), lights = new Batch(), tail = new Batch();

  // Pivot is the wheel-centre height: wheel bottoms sit at -0.35.
  body.add(bx(1.84, 0.42, 4.1, 0, -0.07, 0), YEL);                 // lower body
  body.add(bx(1.86, 0.08, 4.12, 0, 0.14, 0), DARK);                // belt trim
  body.add(bx(1.74, 0.2, 1.35, 0, 0.28, 1.3), YEL);                // hood
  body.add(bx(1.74, 0.2, 1.05, 0, 0.28, -1.45), YEL);              // trunk
  body.add(bx(1.55, 0.5, 2.0, 0, 0.51, -0.1), DARK);               // cabin
  body.add(bx(1.45, 0.05, 1.7, 0, 0.78, -0.1), YEL);               // roof panel
  for (const sx of [-0.18, 0.18]) {                                // racing stripes
    body.add(bx(0.14, 0.02, 1.35, sx, 0.385, 1.3), PINK);
    body.add(bx(0.14, 0.02, 1.05, sx, 0.385, -1.45), PINK);
    body.add(bx(0.14, 0.02, 1.7, sx, 0.81, -0.1), PINK);
  }
  body.add(bx(1.9, 0.22, 0.22, 0, -0.17, 2.05), TRIM);             // bumpers
  body.add(bx(1.9, 0.22, 0.22, 0, -0.17, -2.05), TRIM);
  body.add(bx(1.8, 0.04, 0.3, 0, -0.3, 2.15), PINK);               // splitter
  body.add(bx(0.6, 0.1, 0.04, 0, 0.02, 2.07), TRIM);               // grille
  for (const sx of [-1, 1]) {
    body.add(bx(0.28, 0.06, 1.05, sx * 0.96, 0.36, 1.2), YEL);     // fender flares
    body.add(bx(0.28, 0.06, 1.05, sx * 0.96, 0.36, -1.2), YEL);
    body.add(bx(0.18, 0.12, 0.1, sx * 0.95, 0.42, 0.75), TRIM);    // mirrors
    body.add(cyl(0.07, 0.07, 0.35, 6).rotateX(Math.PI / 2).translate(sx * 0.45, -0.27, -2.2), 0xbfc3d0); // exhaust
    body.add(bx(0.1, 0.3, 0.1, sx * 0.7, 0.6, -1.8), DARK);        // spoiler posts
    lights.add(bx(0.42, 0.17, 0.06, sx * 0.62, 0.04, 2.06), 0xfff4b0);  // headlights
    tail.add(bx(0.44, 0.15, 0.06, sx * 0.62, 0.06, -2.06), 0xffffff);   // tail lights
  }
  body.add(bx(1.7, 0.08, 0.5, 0, 0.77, -1.8), PINK);               // wing
  body.add(cyl(0.015, 0.015, 0.6, 4, -0.6, 1.1, -0.8), 0x222222);  // antenna

  // Glass (double-sided so side windows show from outside)
  const GL = 0x00ffff;
  glass.add(new THREE.PlaneGeometry(1.3, 0.48), GL, mat4(0, 0.575, 0.91, -0.3));
  glass.add(new THREE.PlaneGeometry(1.3, 0.48), GL, mat4(0, 0.575, -1.11, 0.3));
  glass.add(new THREE.PlaneGeometry(1.75, 0.4), GL, mat4(-0.78, 0.575, -0.1, 0, Math.PI / 2));
  glass.add(new THREE.PlaneGeometry(1.75, 0.4), GL, mat4(0.78, 0.575, -0.1, 0, -Math.PI / 2));

  const bodyMesh = body.build(MAT.prop, true, false); carBody.add(bodyMesh);
  carBody.add(glass.build(MAT.glass, false, false));
  carBody.add(lights.build(MAT.light, false, false));
  const tailMesh = tail.build(MAT.tail, false, false); carBody.add(tailMesh);

  // Underglow
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 3.6).rotateX(-Math.PI / 2), MAT.glow);
  glow.position.y = -0.33; carBody.add(glow);

  // Shared wheel geometry
  const wb = new Batch();
  wb.add(cyl(0.35, 0.35, 0.28, 12).rotateZ(Math.PI / 2), 0x1a1a22);
  wb.add(cyl(0.22, 0.22, 0.3, 6).rotateZ(Math.PI / 2), PINK);
  wb.add(cyl(0.1, 0.1, 0.32, 6).rotateZ(Math.PI / 2), 0xffff00);
  const wheelGeo = wb.geometry();

  wheels = [];
  [[0.95, 1.2, true], [-0.95, 1.2, true], [0.95, -1.2, false], [-0.95, -1.2, false]].forEach(([wx, wz, front]) => {
    const wm = new THREE.Mesh(wheelGeo, MAT.prop); wm.castShadow = true;
    const pivot = new THREE.Group(); pivot.position.set(wx, 0, wz); pivot.add(wm);
    carBody.add(pivot); wheels.push({ pivot, mesh: wm, isFront: front });
  });
  car.position.copy(carState.position);
}

// ─────────────────────────────────────────────────────────────
//  CITY — roads, sidewalks, plazas, buildings
// ─────────────────────────────────────────────────────────────
const FACADE_COLORS = [
  [0xffffff, 0xffd0e4, 0xd0fff0, 0xfff2b8, 0xd8c8ff, 0xffc9a0, 0xbfe8ff, 0xe4ffb0],
  [0xffffff, 0xcfe8ff, 0xd8fff2, 0xffe8f4],
  [0xffffff, 0xffe0d0, 0xffc0a0, 0xffd8a8],
  [0xffffff, 0xffd0e4, 0xd0fff0, 0xfff2b8],
  [0xffffff, 0xffb0ff, 0xb0ffff]
];
const SHOP_COLORS = [0xff7aa8, 0x35e0d0, 0xffd84a, 0xa27aff, 0xff9a5a];
const ROOF_COLORS = [0x77778a, 0x8a6a5a, 0x5a7a8a, 0x9a8a6a, 0x6a6a7a];
const AWNING_COLORS = [0xff3fb0, 0x35f0ff, 0xffe14a, 0x7dff4a, 0xff8a3a];
const RAIL_COLORS = [0x35f0ff, 0xff3fb0, 0xffe14a, 0xe8e8f0];

const PLAZAS = [
  { cx: -20, cz: -20, ry: Math.PI / 2 },
  { cx: 20, cz: 20, ry: -Math.PI / 2 },
  { cx: -20, cz: 20, ry: Math.PI },
  { cx: 20, cz: -20, ry: 0 }
];
const parks = [];
let W = null;   // static batches while building the city

function hitsReserved(x, z, w, d, m) {
  for (const r of reserved) if (x - w / 2 - m < r.maxX && x + w / 2 + m > r.minX && z - d / 2 - m < r.maxZ && z + d / 2 + m > r.minZ) return true;
  return false;
}
function isOnRoad(bx_, bz, bw, bd) {
  const pad = 1.2;
  for (const rb of roadBounds) if (bx_ - bw / 2 < rb.maxX + pad && bx_ + bw / 2 > rb.minX - pad && bz - bd / 2 < rb.maxZ + pad && bz + bd / 2 > rb.minZ - pad) return true;
  for (const s of solids) if (bx_ - bw / 2 < s.maxX + 0.6 && bx_ + bw / 2 > s.minX - 0.6 && bz - bd / 2 < s.maxZ + 0.6 && bz + bd / 2 > s.minZ - 0.6) return true;
  return hitsReserved(bx_, bz, bw, bd, 0);
}

function buildCity() {
  _seed = 20240611;
  W = {
    road: new Batch(), asphalt: new Batch(), side: new Batch(), plaza: new Batch(), zebra: new Batch(),
    roof: new Batch(), shop: new Batch(), props: new Batch(), metal: new Batch(),
    rampTop: new Batch(), rampSide: new Batch(), cloud: new Batch(),
    fac: [0, 1, 2, 3, 4].map(() => new Batch()), sign: SIGN_WORDS.map(() => new Batch())
  };

  // Ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), MAT.grass);
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  buildRoads();
  buildPlazas();
  buildMegaRamps();
  fillBlocks();
  buildParks();
  buildGrindRails();
  buildSky();
  scatterDestructibles();

  // Flush batches into the scene
  const flush = (batch, mat, cast = false, recv = true) => { const m = batch.build(mat, cast, recv); if (m) scene.add(m); };
  flush(W.road, MAT.road); flush(W.asphalt, MAT.asphalt); flush(W.side, MAT.side); flush(W.plaza, MAT.plaza);
  flush(W.zebra, MAT.zebra, false, false);
  W.fac.forEach((b, i) => flush(b, MAT.facade[i], true, true));
  flush(W.roof, MAT.roof, true, true); flush(W.shop, MAT.shop, true, true);
  flush(W.props, MAT.prop, true, true); flush(W.metal, MAT.metal, true, false);
  flush(W.rampTop, MAT.ramp, true, true); flush(W.rampSide, MAT.rampSide, true, true);
  W.sign.forEach((b, i) => flush(b, MAT.sign[i], false, false));
  const clouds = W.cloud.build(MAT.cloud, false, false);
  if (clouds) { scene.add(clouds); cloudMesh = clouds; }
  W = null;
}

let cloudMesh = null;

// ── Roads, sidewalks, intersections ───────────────────────────
function buildRoads() {
  // Road spans between intersections (no overlaps → no z-fighting)
  const spans = []; let s = -WORLD;
  for (const g of GRID) { spans.push([s, g - ROAD_W]); s = g + ROAD_W; }
  spans.push([s, WORLD]);
  const swSpansX = []; s = -WORLD;
  for (const g of GRID) { swSpansX.push([s, g - (ROAD_W + SIDE_W)]); s = g + ROAD_W + SIDE_W; }
  swSpansX.push([s, WORLD]);

  for (const v of GRID) {
    for (const [a, b] of spans) {
      const L = b - a, c = (a + b) / 2;
      let g = new THREE.BoxGeometry(L, ROAD_H * 2, ROAD_W * 2); scaleFaceUV(g, 2, L / 8, 1); g.translate(c, ROAD_H, v);
      W.road.add(g);
      g = new THREE.BoxGeometry(L, ROAD_H * 2, ROAD_W * 2); scaleFaceUV(g, 2, L / 8, 1); g.rotateY(Math.PI / 2); g.translate(v, ROAD_H, c);
      W.road.add(g);
    }
    for (const side of [-1, 1]) {
      const off = ROAD_W + SIDE_W / 2;
      for (const [a, b] of swSpansX) {   // sidewalks of X-roads
        const L = b - a;
        const g = new THREE.BoxGeometry(L, 0.14, SIDE_W); scaleFaceUV(g, 2, L / 5.6, 1);
        g.translate((a + b) / 2, 0.07, v + side * off); W.side.add(g);
      }
      for (const [a, b] of spans) {      // sidewalks of Z-roads
        const L = b - a;
        const g = new THREE.BoxGeometry(L, 0.14, SIDE_W); scaleFaceUV(g, 2, L / 5.6, 1); g.rotateY(Math.PI / 2);
        g.translate(v + side * off, 0.07, (a + b) / 2); W.side.add(g);
      }
    }
    roadBounds.push({ minX: -WORLD, maxX: WORLD, minZ: v - ROAD_W - SIDE_W, maxZ: v + ROAD_W + SIDE_W });
    roadBounds.push({ minX: v - ROAD_W - SIDE_W, maxX: v + ROAD_W + SIDE_W, minZ: -WORLD, maxZ: WORLD });
  }

  // Intersection patches + zebra crossings
  for (const a of GRID) for (const b of GRID) {
    const g = new THREE.BoxGeometry(ROAD_W * 2, ROAD_H * 2, ROAD_W * 2); scaleFaceUV(g, 2, 2.3, 2.3);
    g.translate(a, ROAD_H, b); W.asphalt.add(g);
    for (const sgn of [-1, 1]) {
      const zx = new THREE.PlaneGeometry(2.4, 11).rotateX(-Math.PI / 2); scaleFaceUV(zx, 0, 1, 11);
      zx.translate(a + sgn * 8.2, 0.1, b); W.zebra.add(zx);
      const zz = new THREE.PlaneGeometry(2.4, 11).rotateX(-Math.PI / 2); scaleFaceUV(zz, 0, 1, 11); zz.rotateY(Math.PI / 2);
      zz.translate(a, 0.1, b + sgn * 8.2); W.zebra.add(zz);
    }
  }
}

// ── Plazas (central skate district) ───────────────────────────
function lw(p, lx, lz) {
  return { x: p.cx + lx * Math.cos(p.ry) + lz * Math.sin(p.ry), z: p.cz - lx * Math.sin(p.ry) + lz * Math.cos(p.ry) };
}

function addLedge(x1, z1, x2, z2, h, color) {
  const minX = Math.min(x1, x2) - 0.35, maxX = Math.max(x1, x2) + 0.35;
  const minZ = Math.min(z1, z2) - 0.35, maxZ = Math.max(z1, z2) + 0.35;
  const sx = maxX - minX, sz = maxZ - minZ;
  W.props.add(bx(sx, h, sz, (minX + maxX) / 2, h / 2, (minZ + maxZ) / 2), 0x6a6a86);
  W.props.add(bx(sx + 0.02, 0.06, sz + 0.02, (minX + maxX) / 2, h + 0.03, (minZ + maxZ) / 2), 0xffe14a);
  colliders.push({ minX, maxX, minZ, maxZ, top: h + 0.06, land: true });
  addRail(x1, h + 0.1, z1, x2, h + 0.1, z2, { color, posts: false });
}

function buildPlazas() {
  for (const p of PLAZAS) {
    reserved.push({ minX: p.cx - 11.6, maxX: p.cx + 11.6, minZ: p.cz - 11.6, maxZ: p.cz + 11.6 });
    const g = new THREE.BoxGeometry(22, 0.12, 22); scaleFaceUV(g, 2, 22 / 6, 22 / 6);
    g.translate(p.cx, 0.06, p.cz); W.plaza.add(g);

    // Parallel grind ledges along the feed direction, plus a high cross bar
    let a = lw(p, -6, -3), b = lw(p, -6, 9); addLedge(a.x, a.z, b.x, b.z, 0.85, 0xff3fb0);
    a = lw(p, 6, -3); b = lw(p, 6, 9); addLedge(a.x, a.z, b.x, b.z, 0.85, 0x35f0ff);
    a = lw(p, -9, 8); b = lw(p, 9, 8); addRail(a.x, 2.8, a.z, b.x, 2.8, b.z, { color: 0xffe14a, postXZ: [lw(p, -9, 8), lw(p, -4.5, 8), lw(p, 4.5, 8), lw(p, 9, 8)] });
    // Kinked diagonal rail
    a = lw(p, -8, -9.5); b = lw(p, -3, -9.5); addRail(a.x, 3.4, a.z, b.x, 2.6, b.z, { color: 0xe8e8f0, posts: true });

    // Decoration: trees in the far corners, benches by the entrance, planters
    for (const sx of [-1, 1]) {
      const t = lw(p, sx * 9.6, 9.6); spawnProp('tree', pick(TREE_KEYS), t.x, t.z, { scale: rng(0.9, 1.2), rot: rand() * TAU });
      const bn = lw(p, sx * 9.6, -9); spawnProp('bench', 'bench', bn.x, bn.z, { rot: p.ry + Math.PI / 2 });
      const pl = lw(p, sx * 9.6, 1); W.props.add(bx(1.2, 0.5, 1.2, pl.x, 0.31, pl.z), 0xb06a4a);
      W.props.add(new THREE.IcosahedronGeometry(0.7, 0).translate(pl.x, 0.95, pl.z), 0x2fe06a);
    }
  }
}

// ── Ramps ─────────────────────────────────────────────────────
function rampSlopeGeo(w, len, h) {
  const hw = w / 2, slope = Math.hypot(len, h);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-hw, 0, 0, hw, 0, 0, hw, h, len, -hw, h, len], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, slope / 2, 0, slope / 2], 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  g.computeVertexNormals();
  return g;
}
function rampSideGeo(w, len, h) {
  const hw = w / 2;
  const A = [-hw, 0, 0], B = [hw, 0, 0], C = [-hw, 0, len], D = [hw, 0, len], E = [-hw, h, len], F = [hw, h, len];
  const tris = [A, C, E, B, F, D, C, D, F, C, F, E];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(tris.length * 2), 2));
  g.computeVertexNormals();
  return g;
}

function buildMegaRamps() {
  const rampDefs = [
    // ── Original medium ramps (4 cardinal positions, inner ring) ──
    { x: 20, z: -40, ry: 0, len: 12, h: 4.5 },
    { x: -20, z: 40, ry: Math.PI, len: 12, h: 4.5 },
    { x: 40, z: 20, ry: -Math.PI / 2, len: 12, h: 4.5 },
    { x: -40, z: -20, ry: Math.PI / 2, len: 12, h: 4.5 },
    // ── Original big ramps (outer ring) ──
    { x: 60, z: 80, ry: Math.PI / 2, len: 18, h: 8.0 },
    { x: -60, z: -80, ry: -Math.PI / 2, len: 18, h: 8.0 },
    { x: 0, z: -100, ry: 0, len: 20, h: 9.0 },
    { x: 0, z: 100, ry: Math.PI, len: 20, h: 9.0 },
    // ── Small quick-jump ramps (low & short) ──
    { x: -55, z: 15, ry: Math.PI / 2, len: 5, h: 1.8, w: 7 },
    { x: 55, z: -15, ry: -Math.PI / 2, len: 5, h: 1.8, w: 7 },
    { x: 15, z: 55, ry: Math.PI, len: 5, h: 1.8, w: 7 },
    { x: -15, z: -55, ry: 0, len: 5, h: 1.8, w: 7 },
    // ── Steep ramps (short len, tall height for big launch angle) ──
    { x: -80, z: 40, ry: Math.PI / 2, len: 7, h: 6.5, w: 8 },
    { x: 80, z: -40, ry: -Math.PI / 2, len: 7, h: 6.5, w: 8 },
    { x: 40, z: -80, ry: 0, len: 7, h: 6.5, w: 8 },
    { x: -40, z: 80, ry: Math.PI, len: 7, h: 6.5, w: 8 },
    // ── Long smooth ramps (long gradual incline) ──
    { x: -100, z: 0, ry: -Math.PI / 2, len: 28, h: 6.0, w: 11 },
    { x: 100, z: 0, ry: Math.PI / 2, len: 28, h: 6.0, w: 11 },
    { x: 0, z: -60, ry: 0, len: 24, h: 5.5, w: 10 },
    { x: 0, z: 60, ry: Math.PI, len: 24, h: 5.5, w: 10 },
    // ── Outer-ring ramps for the expanded city (±160 zone) ──
    { x: 140, z: 0,    ry: Math.PI / 2,  len: 16, h: 7.0, w: 10 },
    { x: -140, z: 0,   ry: -Math.PI / 2, len: 16, h: 7.0, w: 10 },
    { x: 0, z: 140,    ry: Math.PI,       len: 16, h: 7.0, w: 10 },
    { x: 0, z: -140,   ry: 0,             len: 16, h: 7.0, w: 10 },
    { x: 140, z: 140,  ry: Math.PI / 2,  len: 10, h: 5.0, w: 9 },
    { x: -140, z: -140,ry: -Math.PI / 2, len: 10, h: 5.0, w: 9 },
    { x: 140, z: -140, ry: 0,             len: 10, h: 5.0, w: 9 },
    { x: -140, z: 140, ry: Math.PI,       len: 10, h: 5.0, w: 9 },
  ];
  for (const def of rampDefs) {
    const { x, z, ry, len, h } = def; const w = def.w || 10; const rAngle = Math.atan2(h, len);
    const M = new THREE.Matrix4().makeRotationY(ry); M.setPosition(x, 0, z);
    W.rampTop.add(rampSlopeGeo(w, len, h), 0xffffff, M);
    W.rampSide.add(rampSideGeo(w, len, h), 0x2a1a3a, M);
    const cosRY = Math.cos(ry), sinRY = Math.sin(ry);
    const ramp = { wx: x, wz: z, fwdX: sinRY, fwdZ: cosRY, rightX: cosRY, rightZ: -sinRY, w, len, h, rAngle, ry };
    ramps.push(ramp);
    // Glowing edge rails (visual only)
    for (const sx of [-1, 1]) {
      const a = new THREE.Vector3(sx * w / 2, 0.05, 0).applyMatrix4(M), b = new THREE.Vector3(sx * w / 2, h + 0.05, len).applyMatrix4(M);
      addTube(a, b, 0.1, 0xffe14a);
    }
    // Reserve footprint
    const pts = [[-w / 2, 0], [w / 2, 0], [-w / 2, len], [w / 2, len]].map(([lx, lz]) => [x + lx * cosRY + lz * sinRY, z - lx * sinRY + lz * cosRY]);
    const r = { minX: Math.min(...pts.map(p => p[0])) - 1, maxX: Math.max(...pts.map(p => p[0])) + 1, minZ: Math.min(...pts.map(p => p[1])) - 1, maxZ: Math.max(...pts.map(p => p[1])) + 1 };
    reserved.push(r); railZones.push(r);
  }
}

function rampUnder(px, pz) {
  let best = null;
  for (const r of ramps) {
    const dx = px - r.wx, dz = pz - r.wz;
    const lZ = dx * r.fwdX + dz * r.fwdZ, lX = dx * r.rightX + dz * r.rightZ;
    if (lZ < -0.3 || lZ > r.len + 0.3 || Math.abs(lX) > r.w / 2 + 0.2) continue;
    const h = clamp(lZ / r.len, 0, 1) * r.h;
    if (!best || h > best.h) best = { r, h, lz: lZ };
  }
  return best;
}

// Surface height under (x,z) for a car at height H above the base level
function floorAt(x, z, H) {
  let s = 0;
  const ru = rampUnder(x, z);
  if (ru) s = ru.h;
  for (const c of colliders) {
    if (c.land === false || c.top <= s) continue;
    if (x > c.minX - 0.3 && x < c.maxX + 0.3 && z > c.minZ - 0.3 && z < c.maxZ + 0.3 && H >= c.top - 0.5) s = c.top;
  }
  return s;
}
function blocked(px, pz, H, hw, hl) {
  for (const c of colliders) {
    if (px + hw > c.minX && px - hw < c.maxX && pz + hl > c.minZ && pz - hl < c.maxZ && H < c.top - 0.5) return true;
  }
  return false;
}

// ── Buildings ─────────────────────────────────────────────────
function fillBlocks() {
  const blocks = [-140, -100, -60, -20, 20, 60, 100, 140];
  for (const bx_ of blocks) for (const bz of blocks) {
    if (PLAZAS.some(p => p.cx === bx_ && p.cz === bz)) continue;
    for (const ix of [-1, 1]) for (const iz of [-1, 1]) {
      const x = bx_ + ix * 5.8 + rng(-0.5, 0.5), z = bz + iz * 5.8 + rng(-0.5, 0.5);
      const w = rng(6.5, 10), d = rng(6.5, 10);
      if (hitsReserved(x, z, w, d, 1.5)) continue;
      if (rand() < 0.28) { parks.push({ x: bx_ + ix * 5.8, z: bz + iz * 5.8 }); continue; }
      const r = rand();
      const h = r < 0.3 ? rng(8, 12) : r < 0.78 ? rng(12, 20) : rng(20, 30);
      spawnBuilding(x, z, w, d, h);
    }
  }
}

function addTier(x, z, w, d, y0, hh, f, col, roofCol) {
  W.fac[f].add(wallGeo(w, hh, d, x, y0 + hh / 2, z), col);
  // Roof slab with gravel texture
  const rg = new THREE.BoxGeometry(w + 0.5, 0.3, d + 0.5); scaleFaceUV(rg, 2, (w + 0.5) / 4, (d + 0.5) / 4);
  rg.translate(x, y0 + hh + 0.15, z); W.roof.add(rg, roofCol);
  // Cornice
  W.props.add(bx(w + 0.3, 0.25, d + 0.3, x, y0 + hh - 0.12, z), 0xf0e8f8);
  const c = { minX: x - w / 2 - 0.25, maxX: x + w / 2 + 0.25, minZ: z - d / 2 - 0.25, maxZ: z + d / 2 + 0.25, top: y0 + hh + 0.3, land: true };
  colliders.push(c);
  solids.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
  if ((f === 0 || f === 3) && rand() < 0.5) {   // corner pilasters
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) W.props.add(bx(0.45, hh, 0.45, x + sx * (w / 2 + 0.05), y0 + hh / 2, z + sz * (d / 2 + 0.05)), 0xf4ecff);
  }
  return y0 + hh + 0.3;
}

function addRoofProps(x, z, w, d, topY, tall) {
  const n = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const px = x + rng(-1, 1) * Math.max(0.1, w / 2 - 1.4), pz = z + rng(-1, 1) * Math.max(0.1, d / 2 - 1.4);
    const k = rand();
    if (k < 0.4) W.props.add(bx(rng(1, 2), rng(0.6, 1), rng(1, 1.6), px, topY + 0.4, pz), 0xb8bcc8);
    else if (k < 0.7) { W.props.add(cyl(0.9, 0.9, 1.6, 8, px, topY + 0.8, pz), pick([0x9a6b4a, 0xd0d4de])); W.props.add(new THREE.ConeGeometry(1.0, 0.6, 8).translate(px, topY + 1.9, pz), 0x6a4a3a); }
    else { const hgt = rng(3, 6); W.props.add(cyl(0.06, 0.06, hgt, 5, px, topY + hgt / 2, pz), 0x444455); W.props.add(new THREE.SphereGeometry(0.16, 6, 5).translate(px, topY + hgt, pz), 0xff2040); }
  }
  if (tall && rand() < 0.2 && w > 6) {   // rooftop billboard (two-sided)
    const si = Math.floor(rand() * SIGN_WORDS.length);
    W.props.add(bx(0.2, 3, 0.2, x - 1.8, topY + 1.5, z), 0x444455); W.props.add(bx(0.2, 3, 0.2, x + 1.8, topY + 1.5, z), 0x444455);
    W.sign[si].add(new THREE.PlaneGeometry(4.8, 2.4), 0xffffff, mat4(x, topY + 3.6, z + 0.12));
    W.sign[si].add(new THREE.PlaneGeometry(4.8, 2.4), 0xffffff, mat4(x, topY + 3.6, z - 0.12, 0, Math.PI));
  }
}

function spawnBuilding(x, z, w, d, h) {
  const f = Math.floor(rand() * 5);
  const col = pick(FACADE_COLORS[f]), roofCol = pick(ROOF_COLORS);
  const kind = rand();
  let topY, bw = w, bd = d, rw = w, rd = d, rx = x, rz = z;
  if (kind < 0.55) {
    topY = addTier(x, z, w, d, 0, h, f, col, roofCol);
  } else if (kind < 0.85) {
    const h1 = h * 0.6;
    addTier(x, z, w, d, 0, h1, f, col, roofCol);
    const w2 = w * rng(0.55, 0.75), d2 = d * rng(0.55, 0.75);
    rx = x + rng(-1, 1) * (w - w2) / 2 * 0.7; rz = z + rng(-1, 1) * (d - d2) / 2 * 0.7; rw = w2; rd = d2;
    topY = addTier(rx, rz, w2, d2, h1 + 0.3, h - h1, f, pick(FACADE_COLORS[f]), roofCol);
  } else {
    bw = w * 0.72; bd = d * 0.72; rw = bw; rd = bd;
    topY = addTier(x, z, bw, bd, 0, Math.min(34, h * 1.35), f, col, roofCol);
  }
  addRoofProps(rx, rz, rw, rd, topY, h > 14);

  // Ground-floor shop band, awning and neon sign on a random face
  const face = Math.floor(rand() * 4);
  const yaw = [0, Math.PI / 2, Math.PI, -Math.PI / 2][face];
  const fh = face % 2 === 0 ? bd / 2 : bw / 2, fw = face % 2 === 0 ? bw : bd;
  const sg = new THREE.BoxGeometry(bw + 0.2, 2.4, bd + 0.2);
  const tu = Math.max(1, Math.round((bw + 0.2) / 8)), tu2 = Math.max(1, Math.round((bd + 0.2) / 8));
  scaleFaceUV(sg, 0, tu2, 1); scaleFaceUV(sg, 1, tu2, 1); scaleFaceUV(sg, 4, tu, 1); scaleFaceUV(sg, 5, tu, 1);
  sg.translate(x, 1.2, z); W.shop.add(sg, pick(SHOP_COLORS));

  const M = new THREE.Matrix4().makeRotationY(yaw); M.setPosition(x, 0, z);
  if (rand() < 0.6) W.props.add(bx(fw * 0.55, 0.1, 1.5, 0, 2.7, fh + 0.85).applyMatrix4(mat4(0, 0, 0, 0)), pick(AWNING_COLORS), M);
  if (h > 9 && rand() < 0.7) {
    const si = Math.floor(rand() * SIGN_WORDS.length);
    W.sign[si].add(new THREE.PlaneGeometry(3.2, 1.6), 0xffffff, M.clone().multiply(mat4(rng(-1, 1) * Math.max(0, fw / 2 - 2), 4.4, fh + 0.16)));
  }
}

// ── Parks ─────────────────────────────────────────────────────
function buildParks() {
  for (const p of parks) {
    W.props.add(cyl(2.6, 2.6, 0.08, 14, p.x, 0.04, p.z), 0x22d9ff);
    W.props.add(cyl(2.9, 2.9, 0.06, 14, p.x, 0.03, p.z), 0xf0e8f8);
    for (let i = 0; i < 6; i++) W.props.add(bx(0.7, 0.2, 0.7, p.x + rng(-4.5, 4.5), 0.1, p.z + rng(-4.5, 4.5)), pick([0xff7ab8, 0xffe34a, 0xffffff, 0xff8a3a]));
    for (let i = 0; i < 3; i++) {
      const a = rand() * TAU;
      spawnProp('tree', pick(TREE_KEYS), p.x + Math.cos(a) * 4.5, p.z + Math.sin(a) * 4.5, { scale: rng(0.9, 1.4), rot: rand() * TAU });
    }
  }
}

// ── Sky ───────────────────────────────────────────────────────
function buildSky() {
  for (let i = 0; i < 14; i++) {
    const cx = rng(-300, 300), cz = rng(-300, 300), cy = rng(95, 150);
    for (let k = 0; k < 4; k++) {
      const g = new THREE.IcosahedronGeometry(rng(6, 11), 0); g.scale(1.4, 0.55, 1);
      g.translate(cx + rng(-9, 9), cy + rng(-2, 2), cz + rng(-6, 6)); W.cloud.add(g, 0xfff0ff);
    }
  }
  const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(18, 12, 10), MAT.sun);
  sunMesh.position.set(300, 200, -240); scene.add(sunMesh);
}

// ─────────────────────────────────────────────────────────────
//  RAILS & GRINDING STRUCTURES (Jet Set Radio style)
// ─────────────────────────────────────────────────────────────
const UP = new THREE.Vector3(0, 1, 0);
function addTube(a, b, r, color) {
  const dir = new THREE.Vector3().subVectors(b, a); const len = dir.length(); dir.divideScalar(len);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  W.metal.add(new THREE.CylinderGeometry(r, r, len, 8), color, new THREE.Matrix4().compose(mid, q, _ts));
}
function addPost(x, z, y, color = 0x3a3a52) {
  W.props.add(new THREE.CylinderGeometry(0.08, 0.1, y, 6).translate(x, y / 2, z), color);
}

function addRail(x1, y1, z1, x2, y2, z2, opt = {}) {
  const a = new THREE.Vector3(x1, y1, z1), b = new THREE.Vector3(x2, y2, z2);
  const len = a.distanceTo(b), dir = new THREE.Vector3().subVectors(b, a).divideScalar(len);
  const color = opt.color !== undefined ? opt.color : pick(RAIL_COLORS);
  addTube(a, b, 0.22, color);
  W.metal.add(new THREE.SphereGeometry(0.16, 8, 6).translate(a.x, a.y, a.z), 0xffffff);
  W.metal.add(new THREE.SphereGeometry(0.16, 8, 6).translate(b.x, b.y, b.z), 0xffffff);
  if (opt.postXZ) for (const p of opt.postXZ) addPost(p.x, p.z, lerp(y1, y2, Math.hypot(p.x - x1, p.z - z1) / Math.max(0.01, Math.hypot(x2 - x1, z2 - z1))));
  else if (opt.posts) {
    const n = Math.max(1, Math.round(len / 6));
    for (let i = 0; i <= n; i++) { const t = i / n; addPost(lerp(x1, x2, t), lerp(z1, z2, t), lerp(y1, y2, t)); }
  }
  rails.push({ a, b, dir, len });
}

// Gantry frame across a road with a rail hanging from it
function addGantry(px, py, pz, dir) {
  const alongX = Math.abs(dir.x) > Math.abs(dir.z);
  const top = py + 1.7;
  for (const s of [-1, 1]) {
    const x = alongX ? px : px + s * 8, z = alongX ? pz + s * 8 : pz;
    addPost(x, z, top, 0x3a3a52);
  }
  const beam = alongX ? bx(0.25, 0.25, 16.2, px, top, pz) : bx(16.2, 0.25, 0.25, px, top, pz);
  W.props.add(beam, 0xff3fb0);
  W.props.add(cyl(0.05, 0.05, 1.7, 5, px, py + 0.85, pz), 0xaaaabb);
}

function zoneHit(minX, maxX, minZ, maxZ) {
  for (const r of railZones) if (minX < r.maxX && maxX > r.minX && minZ < r.maxZ && maxZ > r.minZ) return true;
  return false;
}

function buildGrindRails() {
  // 1) Sloped launch rails that catch jumps off the big ramps
  for (const r of ramps) {
    if (r.len < 18) continue;
    const ds = r.len >= 20 ? [14, 28, 52, 66] : [14, 28, 54];
    const dEnd = ds[ds.length - 1];
    const lipX = r.wx + r.fwdX * r.len, lipZ = r.wz + r.fwdZ * r.len;
    const yAt = (d) => lerp(r.h + 5, 4.5, (d - 14) / (dEnd - 14));
    const a = { x: lipX + r.fwdX * 14, z: lipZ + r.fwdZ * 14 }, b = { x: lipX + r.fwdX * dEnd, z: lipZ + r.fwdZ * dEnd };
    addRail(a.x, yAt(14), a.z, b.x, yAt(dEnd), b.z, { color: 0xff3fb0 });
    const dir = new THREE.Vector3(r.fwdX, 0, r.fwdZ);
    for (const d of ds) addGantry(lipX + r.fwdX * d, yAt(d), lipZ + r.fwdZ * d, dir);
    const lat = 9, px = -r.fwdZ * lat, pz = r.fwdX * lat;
    const xs = [a.x + px, a.x - px, b.x + px, b.x - px], zs = [a.z + pz, a.z - pz, b.z + pz, b.z - pz];
    railZones.push({ minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) });
  }

  // 2) Low overhead gantry rails over road segments (jump from the street to grind)
  GRID.forEach((v, idx) => {
    for (let k = 0; k < GRID.length - 1; k++) {
      const s0 = GRID[k] + 9, s1 = GRID[k + 1] - 9;
      if ((idx + k) % 3 === 0 && !zoneHit(v - 9, v + 9, s0, s1)) {            // rail along Z at x = v
        addRail(v, 3.3, s0, v, 3.3, s1, { color: pick(RAIL_COLORS) });
        const dir = new THREE.Vector3(0, 0, 1);
        for (const z of [s0, (s0 + s1) / 2, s1]) addGantry(v, 3.3, z, dir);
      }
      if ((idx + k + 1) % 3 === 0 && !zoneHit(s0, s1, v - 9, v + 9)) {        // rail along X at z = v
        addRail(s0, 3.3, v, s1, 3.3, v, { color: pick(RAIL_COLORS) });
        const dir = new THREE.Vector3(1, 0, 0);
        for (const x of [s0, (s0 + s1) / 2, s1]) addGantry(x, 3.3, v, dir);
      }
    }
  });

  // 3) Short low ground rails (quick grinds near the road surface)
  //    Placed in block midpoints (≈±20 from road centrelines) to avoid crowding roads
  const lowRailDefs = [
    { x1: -35, z1: -22, x2: -18, z2: -22, y: 0.6 },
    { x1:  18, z1:  22, x2:  35, z2:  22, y: 0.6 },
    { x1: -22, z1:  18, x2: -22, z2:  35, y: 0.6 },
    { x1:  22, z1: -35, x2:  22, z2: -18, y: 0.6 },
    { x1:  50, z1: -52, x2:  66, z2: -52, y: 0.6 },
    { x1: -66, z1:  50, x2: -50, z2:  50, y: 0.6 },
    { x1: -52, z1: -66, x2: -52, z2: -50, y: 0.6 },
    { x1:  50, z1:  50, x2:  50, z2:  66, y: 0.6 },
  ];
  for (const d of lowRailDefs) {
    if (!zoneHit(Math.min(d.x1,d.x2)-1, Math.max(d.x1,d.x2)+1, Math.min(d.z1,d.z2)-1, Math.max(d.z1,d.z2)+1))
      addRail(d.x1, d.y, d.z1, d.x2, d.y, d.z2, { color: pick(RAIL_COLORS), posts: true });
  }

  // 4) High elevated rails (tall posts, extra air needed)
  //    Shifted into block interiors away from road centrelines
  const highRailDefs = [
    { x1: -75, z1: -22, x2: -55, z2: -22, y: 7.0 },
    { x1:  55, z1:  22, x2:  75, z2:  22, y: 7.0 },
    { x1: -22, z1:  55, x2: -22, z2:  75, y: 7.0 },
    { x1:  22, z1: -75, x2:  22, z2: -55, y: 7.0 },
    { x1: -95, z1:  22, x2: -75, z2:  22, y: 8.5 },
    { x1:  75, z1: -22, x2:  95, z2: -22, y: 8.5 },
  ];
  for (const d of highRailDefs) {
    if (!zoneHit(Math.min(d.x1,d.x2)-1, Math.max(d.x1,d.x2)+1, Math.min(d.z1,d.z2)-1, Math.max(d.z1,d.z2)+1)) {
      addRail(d.x1, d.y, d.z1, d.x2, d.y, d.z2, { color: pick(RAIL_COLORS), posts: true });
    }
  }

  // 5) Sloped rails (connect two different heights — ride up or down)
  //    Placed inside city blocks, well away from road centres
  const slopedRailDefs = [
    { x1: -32, y1: 0.6, z1:  52, x2: -18, y2: 4.5, z2:  52 },
    { x1:  18, y1: 4.5, z1: -52, x2:  32, y2: 0.6, z2: -52 },
    { x1:  62, y1: 1.0, z1: -22, x2:  62, y2: 5.5, z2:  -6 },
    { x1: -62, y1: 5.5, z1:  -6, x2: -62, y2: 1.0, z2:  22 },
    { x1: -22, y1: 1.0, z1: -85, x2:  22, y2: 6.0, z2: -85 },
    { x1:  22, y1: 1.0, z1:  85, x2: -22, y2: 6.0, z2:  85 },
  ];
  for (const d of slopedRailDefs) {
    if (!zoneHit(Math.min(d.x1,d.x2)-1, Math.max(d.x1,d.x2)+1, Math.min(d.z1,d.z2)-1, Math.max(d.z1,d.z2)+1))
      addRail(d.x1, d.y1, d.z1, d.x2, d.y2, d.z2, { color: pick(RAIL_COLORS), posts: true });
  }

  // 6) Staggered parallel twin rails (two rails side-by-side at mid height)
  //    Centres moved to block midpoints (≈±50 from origin) away from ±40/0 roads
  const twinRailDefs = [
    { cx:  50, cz: -50, axis: 'x', halfLen: 10, y: 2.2, gap: 2.5 },
    { cx: -50, cz:  50, axis: 'x', halfLen: 10, y: 2.2, gap: 2.5 },
    { cx: -50, cz: -50, axis: 'z', halfLen: 10, y: 2.2, gap: 2.5 },
    { cx:  50, cz:  50, axis: 'z', halfLen: 10, y: 2.2, gap: 2.5 },
    { cx:  90, cz:  90, axis: 'x', halfLen:  9, y: 3.0, gap: 2.8 },
    { cx: -90, cz: -90, axis: 'x', halfLen:  9, y: 3.0, gap: 2.8 },
  ];
  for (const d of twinRailDefs) {
    const { cx, cz, axis, halfLen, y, gap } = d;
    for (const sg of [-1, 1]) {
      const ox = axis === 'z' ? sg * gap / 2 : 0;
      const oz = axis === 'x' ? sg * gap / 2 : 0;
      const ax_ = axis === 'x' ? -halfLen : 0, az_ = axis === 'z' ? -halfLen : 0;
      const bx_ = axis === 'x' ?  halfLen : 0, bz_ = axis === 'z' ?  halfLen : 0;
      if (!zoneHit(cx + Math.min(ax_, bx_) + ox - 1, cx + Math.max(ax_, bx_) + ox + 1,
                   cz + Math.min(az_, bz_) + oz - 1, cz + Math.max(az_, bz_) + oz + 1))
        addRail(cx + ax_ + ox, y, cz + az_ + oz, cx + bx_ + ox, y, cz + bz_ + oz, { color: pick(RAIL_COLORS), posts: true });
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  DESTRUCTIBLE PROPS (one merged mesh each, shared geometry)
// ─────────────────────────────────────────────────────────────
const TREE_KEYS = ['pine', 'roundPink', 'roundLime', 'palm'];
const PROP_CACHE = {};
const PROP_INFO = {
  barrel: { r: 0.6, h: 1.0 }, crate: { r: 0.6, h: 0.9 }, cone: { r: 0.4, h: 0.9 }, bin: { r: 0.5, h: 0.9 },
  hydrant: { r: 0.5, h: 0.7 }, fence: { rx: 1.3, rz: 0.4, h: 0.9 }, bench: { rx: 0.9, rz: 0.5, h: 0.9 },
  lamp: { r: 0.5, h: 4.2 }, light: { r: 0.5, h: 4.5 }, tree: { r: 1.0, h: 4.0 }
};
const TYPE_COLOR = { barrel: 0xff0055, crate: 0xff9a2a, cone: 0xffe000, bin: 0x2f8f6b, hydrant: 0xff3030, tree: 0x2fe08a, fence: 0xffffff, bench: 0xc98a4b, lamp: 0xfff2a0, light: 0xffd400 };

function propGeo(key) {
  if (PROP_CACHE[key]) return PROP_CACHE[key];
  const b = new Batch();
  if (key.startsWith('barrel')) {
    const c = [0xff0055, 0x2b8cff, 0xffc400][+key.slice(6) % 3];
    b.add(cyl(0.4, 0.4, 1.0, 10, 0, 0.5, 0), c); b.add(cyl(0.43, 0.43, 0.1, 10, 0, 0.25, 0), 0x222233);
    b.add(cyl(0.43, 0.43, 0.1, 10, 0, 0.75, 0), 0x222233); b.add(cyl(0.34, 0.34, 0.04, 10, 0, 1.0, 0), 0x333344);
  } else if (key === 'crate') {
    b.add(bx(0.9, 0.9, 0.9, 0, 0.45, 0), 0xff9a2a);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(bx(0.14, 0.94, 0.14, sx * 0.38, 0.47, sz * 0.38), 0xc2661a);
    b.add(bx(0.92, 0.1, 0.92, 0, 0.05, 0), 0xc2661a); b.add(bx(0.92, 0.1, 0.92, 0, 0.85, 0), 0xc2661a);
  } else if (key === 'cone') {
    b.add(bx(0.7, 0.06, 0.7, 0, 0.03, 0), 0x222233); b.add(new THREE.ConeGeometry(0.3, 0.9, 8).translate(0, 0.51, 0), 0xffe000);
    b.add(cyl(0.17, 0.21, 0.12, 8, 0, 0.38, 0), 0xffffff);
  } else if (key === 'bin') {
    b.add(cyl(0.3, 0.26, 0.8, 8, 0, 0.4, 0), 0x2f8f6b); b.add(cyl(0.34, 0.34, 0.08, 8, 0, 0.84, 0), 0x226b50); b.add(bx(0.2, 0.06, 0.06, 0, 0.92, 0), 0x111111);
  } else if (key === 'hydrant') {
    b.add(cyl(0.2, 0.24, 0.6, 8, 0, 0.3, 0), 0xff3030); b.add(new THREE.SphereGeometry(0.2, 8, 6).translate(0, 0.62, 0), 0xff3030);
    b.add(cyl(0.08, 0.08, 0.5, 6).rotateZ(Math.PI / 2).translate(0, 0.42, 0), 0xffd400);
  } else if (key === 'fence') {
    for (const sx of [-1.1, 1.1]) b.add(bx(0.1, 0.9, 0.1, sx, 0.45, 0), 0xffb3d9);
    for (const y of [0.35, 0.7]) b.add(bx(2.3, 0.08, 0.06, 0, y, 0), 0xffffff);
    for (let i = 0; i < 8; i++) b.add(bx(0.12, 0.7, 0.04, -0.95 + i * 0.27, 0.45, 0.05), 0xffffff);
  } else if (key === 'bench') {
    b.add(bx(1.6, 0.1, 0.5, 0, 0.45, 0), 0xc98a4b); b.add(bx(1.6, 0.5, 0.08, 0, 0.8, -0.22), 0xc98a4b);
    for (const sx of [-0.7, 0.7]) b.add(bx(0.1, 0.45, 0.5, sx, 0.22, 0), 0x333344);
  } else if (key === 'lamp') {
    b.add(cyl(0.2, 0.25, 0.4, 6, 0, 0.2, 0), 0x333344); b.add(cyl(0.07, 0.1, 4.2, 6, 0, 2.1, 0), 0x333344);
    b.add(bx(0.9, 0.08, 0.08, 0.45, 4.2, 0), 0x333344); b.add(bx(0.5, 0.12, 0.3, 0.9, 4.15, 0), 0xfff2a0);
  } else if (key === 'light') {
    b.add(cyl(0.07, 0.1, 4.5, 6, 0, 2.25, 0), 0x333344); b.add(bx(0.9, 0.08, 0.08, 0.45, 4.4, 0), 0x333344);
    b.add(bx(0.4, 1.1, 0.35, 0.9, 4.1, 0), 0x1a1a24);
    b.add(new THREE.SphereGeometry(0.12, 6, 5).translate(0.9, 4.45, 0.19), 0xff2040);
    b.add(new THREE.SphereGeometry(0.12, 6, 5).translate(0.9, 4.1, 0.19), 0xffd400);
    b.add(new THREE.SphereGeometry(0.12, 6, 5).translate(0.9, 3.75, 0.19), 0x30ff70);
  } else if (key === 'pine') {
    b.add(cyl(0.2, 0.3, 1.4, 6, 0, 0.7, 0), 0x7a3b69);
    [1.4, 2.4, 3.2].forEach((y, i) => b.add(new THREE.ConeGeometry([1.5, 1.1, 0.7][i], 1.4, 7).translate(0, y, 0), i % 2 === 0 ? 0x00ff88 : 0x00ddff));
  } else if (key === 'roundPink' || key === 'roundLime') {
    const c = key === 'roundPink' ? [0xff8ad8, 0xffa8e6, 0xff6ac8] : [0x7dff4a, 0xa0ff70, 0x5ae03a];
    b.add(cyl(0.18, 0.26, 1.6, 6, 0, 0.8, 0), 0x8a4b2a);
    b.add(new THREE.IcosahedronGeometry(1.4, 0).translate(0, 2.7, 0), c[0]);
    b.add(new THREE.IcosahedronGeometry(0.8, 0).translate(0.7, 2.2, 0.3), c[1]);
    b.add(new THREE.IcosahedronGeometry(0.7, 0).translate(-0.6, 3.1, -0.3), c[2]);
  } else if (key === 'palm') {
    b.add(cyl(0.16, 0.24, 3.3, 6).translate(0, 1.65, 0).applyMatrix4(mat4(0, 0, 0, 0, 0, 0.1)), 0xb5793a);
    for (let i = 0; i < 6; i++) b.add(new THREE.BoxGeometry(1.8, 0.06, 0.5).translate(0.9, 0, 0), 0x22d27a, mat4(0.3, 3.3, 0, 0, i * Math.PI / 3, -0.4));
  }
  return (PROP_CACHE[key] = b.geometry());
}

function spawnProp(type, key, x, z, opt = {}) {
  const info = PROP_INFO[type];
  const mesh = new THREE.Mesh(propGeo(key), MAT.prop);
  const sc = opt.scale || 1;
  mesh.position.set(x, 0.1, z); mesh.rotation.y = opt.rot || 0; mesh.scale.setScalar(sc);
  mesh.castShadow = true; scene.add(mesh);
  let rx, rz;
  if (info.r !== undefined) { rx = rz = info.r * sc; }
  else { const swap = Math.abs(Math.sin(opt.rot || 0)) > 0.7; rx = swap ? info.rz : info.rx; rz = swap ? info.rx : info.rz; }
  destructibles.push({ group: mesh, collider: { minX: x - rx, maxX: x + rx, minZ: z - rz, maxZ: z + rz }, type, h: info.h * sc, alive: true });
  return mesh;
}

function sidewalkPoint() {
  const v = pick(GRID), side = rand() < 0.5 ? -1 : 1, alongX = rand() < 0.5;
  const t = rng(-WORLD + 10, WORLD - 10);
  for (const g of GRID) if (Math.abs(t - g) < 10) return null;
  const off = v + side * 7.7;
  return alongX ? { x: t, z: off, alongX, side } : { x: off, z: t, alongX, side };
}

function scatterDestructibles() {
  const k = MOBILE ? 0.65 : 1;
  // Trees in blocks / parks
  let placed = 0, tries = 0;
  while (placed < 100 * k && tries++ < 700) {
    const x = rng(-WORLD + 10, WORLD - 10), z = rng(-WORLD + 10, WORLD - 10);
    if (isOnRoad(x, z, 3, 3)) continue;
    spawnProp('tree', pick(TREE_KEYS), x, z, { scale: rng(0.8, 1.5), rot: rand() * TAU }); placed++;
  }
  // Street trees on sidewalks
  placed = 0; tries = 0;
  while (placed < 35 * k && tries++ < 300) {
    const p = sidewalkPoint(); if (!p) continue;
    spawnProp('tree', pick(TREE_KEYS), p.x, p.z, { scale: rng(0.6, 0.9), rot: rand() * TAU }); placed++;
  }
  // Roadside clutter: barrels, crates, cones
  placed = 0; tries = 0;
  while (placed < 170 * k && tries++ < 800) {
    const rb = pick(roadBounds);
    const x = rng(rb.minX + 2, rb.maxX - 2), z = rng(rb.minZ + 2, rb.maxZ - 2);
    if (Math.hypot(x, z - 25) < 12) continue;
    if (hitsReserved(x, z, 1, 1, 0)) continue;
    const r = rand();
    if (r < 0.3) spawnProp('barrel', 'barrel' + Math.floor(rand() * 3), x, z, { rot: rand() * TAU });
    else if (r < 0.6) spawnProp('crate', 'crate', x, z, { rot: rand() * 1.5 });
    else spawnProp('cone', 'cone', x, z);
    placed++;
  }
  // Sidewalk furniture
  placed = 0; tries = 0;
  while (placed < 90 * k && tries++ < 600) {
    const p = sidewalkPoint(); if (!p) continue;
    const r = rand();
    const roadRot = p.alongX ? 0 : Math.PI / 2;                      // lie parallel to the road
    const armRot = p.alongX ? (p.side > 0 ? Math.PI / 2 : -Math.PI / 2) : (p.side > 0 ? Math.PI : 0); // arm points at the road
    if (r < 0.2) spawnProp('hydrant', 'hydrant', p.x, p.z);
    else if (r < 0.4) spawnProp('bin', 'bin', p.x, p.z);
    else if (r < 0.55) spawnProp('bench', 'bench', p.x, p.z, { rot: roadRot });
    else if (r < 0.75) spawnProp('fence', 'fence', p.x, p.z, { rot: roadRot });
    else spawnProp('lamp', 'lamp', p.x, p.z, { rot: armRot });
    placed++;
  }
  // Traffic lights at some intersections
  for (const a of GRID) for (const b of GRID) {
    if (rand() < 0.45) continue;
    const sx = rand() < 0.5 ? -1 : 1, sz = rand() < 0.5 ? -1 : 1;
    spawnProp('light', 'light', a + sx * 8.0, b + sz * 8.0, { rot: sx > 0 ? Math.PI : 0 });
  }
}

// ─────────────────────────────────────────────────────────────
//  DESTRUCTION
// ─────────────────────────────────────────────────────────────
function destroyObject(d, dx, dz, impact) {
  if (!d.alive) return;
  d.alive = false;
  const mult = carState.onGround ? 1 : 3;
  addScore((SCORE_TABLE[d.type] || 50) * mult, d.group.position.x, d.group.position.z);
  const p = d.group.position;
  emitChips(p.x, p.y + 0.6, p.z, TYPE_COLOR[d.type] || 0xffffff, MOBILE ? 6 : 10);
  flying.push({
    group: d.group, base: d.group.scale.x, t: 0, life: 3, floor: 0.1,
    vel: new THREE.Vector3(dx * impact * 1.5 + rng(-2, 2), 8 + impact * 0.4, dz * impact * 1.5 + rng(-2, 2)),
    spin: new THREE.Vector3(rng(-6, 6), rng(-6, 6), rng(-6, 6))
  });
}

function updateParticles(dt) {
  for (let i = flying.length - 1; i >= 0; i--) {
    const f = flying[i]; f.t += dt;
    f.vel.y -= 25 * dt;
    f.group.position.addScaledVector(f.vel, dt);
    f.group.rotation.x += f.spin.x * dt; f.group.rotation.y += f.spin.y * dt; f.group.rotation.z += f.spin.z * dt;
    if (f.group.position.y < f.floor) {
      f.group.position.y = f.floor;
      f.vel.y = Math.abs(f.vel.y) > 3 ? -f.vel.y * 0.5 : 0;
      f.vel.x *= 0.7; f.vel.z *= 0.7;
    }
    if (f.t > f.life) {
      const s = 1 - (f.t - f.life) / 0.3;
      if (s <= 0) { scene.remove(f.group); flying.splice(i, 1); }
      else f.group.scale.setScalar(f.base * s);
    }
  }
}

function checkDestruction(nx, nz, H) {
  const cs = carState;
  const spd = Math.hypot(cs.vx, cs.vz);
  if (spd < 3) return;
  const dx = cs.vx / spd, dz = cs.vz / spd;
  for (const d of destructibles) {
    if (!d.alive) continue;
    const c = d.collider;
    if (nx > c.minX - 0.5 && nx < c.maxX + 0.5 && nz > c.minZ - 0.5 && nz < c.maxZ + 0.5 && H < d.h - 0.2) {
      destroyObject(d, dx, dz, spd);
      cs.vx *= 0.985; cs.vz *= 0.985;
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  TRICKS, LANDING & RAIL ATTACH
// ─────────────────────────────────────────────────────────────
function resetAir() {
  const cs = carState;
  cs.airPitch = 0; cs.airRoll = 0; cs.airYaw = 0; cs.airPitchVel = 0; cs.airRollVel = 0;
}

function bankTricks() {
  const cs = carState;
  const pW = wrapAngle(cs.airPitch), rW = wrapAngle(cs.airRoll);
  const pSign = cs.airPitch - pW, flips = Math.round(Math.abs(pSign) / TAU);
  const rolls = Math.round(Math.abs(cs.airRoll - rW) / TAU);
  const spins = Math.round(Math.abs(cs.airYaw) / TAU);
  const parts = [];
  if (flips) parts.push((pSign > 0 ? 'FRONTFLIP' : 'BACKFLIP') + (flips > 1 ? ' x' + flips : ''));
  if (rolls) parts.push('BARREL ROLL' + (rolls > 1 ? ' x' + rolls : ''));
  if (spins) parts.push('360 SPIN' + (spins > 1 ? ' x' + spins : ''));
  const n = flips + rolls + spins;
  let pts = Math.round(Math.max(0, cs.airTime - 0.4) * 150) + flips * 500 + rolls * 400 + spins * 350;
  pts = Math.round(pts * (1 + 0.5 * Math.max(0, n - 1)));
  cs.airPitch = pW; cs.airRoll = rW; cs.airYaw = 0;
  return { pts, label: parts.join(' + '), n };
}

function setBanner(text, t = 1.6) { carState.bannerText = text; carState.bannerT = t; }

function land(fallSpeed) {
  const cs = carState, pos = cs.position;
  const pW = wrapAngle(cs.airPitch), rW = wrapAngle(cs.airRoll);
  const clean = Math.abs(pW) < 1.15 && Math.abs(rW) < 1.15;
  cs.onGround = true; cs.velY = 0; cs.rampRef = null; cs.coyote = 0;
  cs.canDoubleJump = true;   // restore double jump on landing
  if (cs.airTime > 0.35) {
    if (clean) {
      const t = bankTricks();
      if (t.pts > 0) { addScore(t.pts, pos.x, pos.z, t.label); setBanner((t.label ? t.label + '  ' : 'NICE LANDING  ') + '+' + t.pts); }
      emitDust(pos.x, 0.2, pos.z, MOBILE ? 5 : 9, 4, 1.5);
      cs.bob = -clamp(fallSpeed * 0.012, 0.05, 0.25);
    } else {
      cs.airPitch = pW; cs.airRoll = rW; cs.airYaw = 0;
      cs.wipeT = 0.7; cs.vx *= 0.5; cs.vz *= 0.5;
      setBanner('WIPEOUT!', 1.2);
      emitDust(pos.x, 0.2, pos.z, MOBILE ? 8 : 16, 6, 2, 0.7, 1.2);
      emitSparks(pos.x, 0.5, pos.z, 0, 0, 8);
    }
  } else { cs.airPitch = pW; cs.airRoll = rW; cs.airYaw = 0; }
  cs.airTime = 0; cs.airPitchVel = 0; cs.airRollVel = 0;
}

function attachRail(rail, t, dx, dy, dz) {
  const cs = carState, pos = cs.position;
  const tr = bankTricks();
  if (tr.pts > 0) { addScore(tr.pts, pos.x, pos.z, tr.label); setBanner((tr.label ? tr.label + '  ' : '') + '+' + tr.pts); }
  cs.grinding = true; cs.grindRail = rail; cs.grindT = t;
  cs.canDoubleJump = true;   // restore double jump when landing on a rail
  const hs = Math.hypot(cs.vx, cs.vz);
  const fx = hs > 3 ? cs.vx / hs : Math.sin(cs.heading), fz = hs > 3 ? cs.vz / hs : Math.cos(cs.heading);
  cs.grindDir = (fx * rail.dir.x + fz * rail.dir.z) >= 0 ? 1 : -1;
  cs.grindSpeed = clamp(hs * 0.95 + 1, 9, 38);
  cs.grindOff.set(dx, dy, dz);
  cs.velY = 0; cs.grindTime = 0; cs.grindAcc = 0; cs.grindPts = 0; cs.airTime = 0;
  emitSparks(pos.x, pos.y - RAIL_OFF, pos.z, 0, 0, 10);
}

function tryAttachRail() {
  const cs = carState, pos = cs.position;
  if (cs.railCooldown > 0 || cs.velY > 5) return false;   // velY guard relaxed: was 3
  if (Math.abs(wrapAngle(cs.airPitch)) > 1.2 || Math.abs(wrapAngle(cs.airRoll)) > 1.2) return false;
  const px = pos.x, py = pos.y - RAIL_OFF, pz = pos.z;
  for (const r of rails) {
    const rx = px - r.a.x, ry = py - r.a.y, rz = pz - r.a.z;
    const t = (rx * r.dir.x + ry * r.dir.y + rz * r.dir.z) / r.len;
    if (t < 0 || t > 1) continue;
    const cx = r.a.x + r.dir.x * t * r.len, cy = r.a.y + r.dir.y * t * r.len, cz = r.a.z + r.dir.z * t * r.len;
    const dx = px - cx, dy = py - cy, dz = pz - cz;
    // Horizontal radius: 2.0 m (was 1.8); vertical window: ±1.8 (was 1.5)
    if (dx * dx + dz * dz < 4.0 && Math.abs(dy) < 1.8) { attachRail(r, t, dx, dy, dz); return true; }
  }
  return false;
}

function finishGrind(jump) {
  const cs = carState, r = cs.grindRail, gs = cs.grindSpeed, pos = cs.position;
  const slopeV = r ? r.dir.y * cs.grindDir * gs : 0;
  cs.grinding = false; cs.grindRail = null; cs.onGround = false; cs.railCooldown = 0.45;
  cs.airTime = 0; cs.airYaw = 0; cs.airPitchVel = 0; cs.airRollVel = 0;
  cs.velY = jump ? JUMP_FORCE * 0.8 + Math.max(0, slopeV * 0.5) : Math.max(3.5, slopeV * 0.8 + 2.5);
  cs.speed = gs;
  if (cs.grindPts > 0) { popup('GRIND +' + cs.grindPts, pos.x, 2.0, pos.z); setBanner('RAIL GRIND  +' + cs.grindPts, 1.4); }
  setHidden(ui.grind, true);
}

function updateGrind(dt, jumpEdge, steerIn) {
  const cs = carState, pos = cs.position, r = cs.grindRail;
  let gs = cs.grindSpeed;
  if (keys.forward) gs = approach(gs, 36, 12 * dt);
  else if (keys.back) gs = approach(gs, 7, 28 * dt);
  else gs = approach(gs, 12, 2.5 * dt);
  gs += -r.dir.y * cs.grindDir * 14 * dt;      // gravity assist on slopes
  gs = clamp(gs, 5, 40);
  cs.grindSpeed = gs;
  cs.grindT += cs.grindDir * gs * dt / r.len;
  cs.grindTime += dt;

  // Score (frame-rate independent, no DOM spam)
  cs.grindAcc += dt * (70 + gs * 3);
  const whole = Math.floor(cs.grindAcc);
  if (whole > 0) { cs.grindAcc -= whole; cs.grindPts += whole; score += whole; }

  const tc = clamp(cs.grindT, 0, 1);
  cs.grindOff.multiplyScalar(Math.exp(-12 * dt));
  pos.set(r.a.x + r.dir.x * tc * r.len + cs.grindOff.x,
          r.a.y + r.dir.y * tc * r.len + RAIL_OFF + cs.grindOff.y,
          r.a.z + r.dir.z * tc * r.len + cs.grindOff.z);

  // Smoothly align with the rail
  const desired = Math.atan2(r.dir.x * cs.grindDir, r.dir.z * cs.grindDir);
  cs.heading = approachAngle(cs.heading, desired, 14 * dt);
  cs.angularVel = 0; cs.speed = gs;
  const sH = Math.sin(cs.heading), cH = Math.cos(cs.heading);
  cs.vx = sH * gs; cs.vz = cH * gs;

  const slope = Math.atan2(r.dir.y * cs.grindDir, Math.hypot(r.dir.x, r.dir.z));
  cs.pitch = approach(cs.pitch, -slope, 6 * dt);
  cs.airPitch = approach(cs.airPitch, 0, 10 * dt); cs.airRoll = approach(cs.airRoll, 0, 10 * dt);
  cs.lean = approach(cs.lean, Math.sin(cs.grindTime * 7) * 0.04 + steerIn * 0.06, 6 * dt);

  // Sparks from the rear wheels
  const sx = pos.x - sH * 0.9, sz = pos.z - cH * 0.9, sy = pos.y - RAIL_OFF + 0.12;
  for (const side of [-0.45, 0.45]) emitSparks(sx + cH * side, sy, sz - sH * side, -sH * gs * 0.25, -cH * gs * 0.25, MOBILE ? 1 : 2);

  setHidden(ui.grind, false);
  setText(ui.grind, '⚡ RAIL GRIND ' + cs.grindTime.toFixed(1) + 's  +' + cs.grindPts);

  if (jumpEdge) { cs.jumpBuffer = 0; finishGrind(true); return; }
  if ((cs.grindDir > 0 && cs.grindT >= 1) || (cs.grindDir < 0 && cs.grindT <= 0)) finishGrind(false);
}

// ─────────────────────────────────────────────────────────────
//  WALL RIDING
// ─────────────────────────────────────────────────────────────

// Called when the car hits a building wall at speed.
// wnx/wnz = outward wall normal (one of ±1,0 / 0,±1).
function tryAttachWall(wnx, wnz) {
  const cs = carState;
  if (cs.wallCooldown > 0 || cs.wallRide) return false;
  // Guard: zero-length normal means no real wall hit (can happen when sign(0)=0)
  if (wnx === 0 && wnz === 0) return false;
  const spd = Math.hypot(cs.vx, cs.vz);
  if (spd < WALL_MIN_SPD) return false;
  // Attach when the car is MOVING TOWARD the wall:
  //   outward normal = direction pointing away from wall surface.
  //   Car approaching → velocity · outward_normal is NEGATIVE.
  //   Previous logic had the threshold inverted and rejected the correct case.
  //   Accept: vDotN <= 0.35 (approaching, glancing, parallel — all fine).
  //   Reject: vDotN > 0.35 (car already moving away from wall).
  const vDotN = (cs.vx * wnx + cs.vz * wnz) / spd;
  if (vDotN > 0.35) return false;
  cs.wallRide = true;
  cs.wallNX = wnx; cs.wallNZ = wnz;
  cs.wallTimer = 0;
  cs.onGround = false;
  cs.airTime = Math.max(cs.airTime, 0);
  cs.rampRef = null;
  // Preserve trick accumulation — do NOT call resetAir()
  setBanner('WALL RUN!', 1.0);
  emitSparks(cs.position.x, cs.position.y, cs.position.z, 0, 0, MOBILE ? 5 : 10);
  return true;
}

function detachWall(jumpOff) {
  const cs = carState;
  cs.wallRide = false;
  cs.wallCooldown = 0.4;
  cs.onGround = false;
  if (jumpOff) {
    cs.velY = JUMP_FORCE * 0.95;
    cs.vx += cs.wallNX * WALL_JUMP_KICK;
    cs.vz += cs.wallNZ * WALL_JUMP_KICK;
    setBanner('WALL JUMP!', 1.0);
    emitDust(cs.position.x, cs.position.y - 0.3, cs.position.z, MOBILE ? 5 : 10, 4, 2.5);
    emitSparks(cs.position.x, cs.position.y, cs.position.z,
               cs.wallNX * 4, cs.wallNZ * 4, MOBILE ? 4 : 8);
  } else {
    cs.velY = Math.max(cs.velY, 0.5);
  }
}

function updateWallRide(dt, steerIn, jumpEdge, flipIn) {
  const cs = carState, pos = cs.position;
  cs.wallTimer += dt;
  cs.wallCooldown = Math.max(0, cs.wallCooldown - dt);

  // SPACE while on wall → wall jump
  if (jumpEdge) { cs.jumpBuffer = 0; detachWall(true); return; }

  // Gentle gravity while running — much less than GRAVITY=22
  cs.velY -= WALL_GRAVITY * dt;
  cs.velY = Math.max(cs.velY, -10);

  // Stick: pull car toward wall (into = −normal direction)
  cs.vx -= cs.wallNX * WALL_STICK * dt;
  cs.vz -= cs.wallNZ * WALL_STICK * dt;

  // Tangent direction: perpendicular to normal in XZ plane
  const tx = -cs.wallNZ, tz = cs.wallNX;
  const pedalTarget = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  cs.pedal = approach(cs.pedal, pedalTarget, 8 * dt);
  let tangentSpd = cs.vx * tx + cs.vz * tz;
  tangentSpd += CAR_ACCEL * 0.8 * cs.pedal * dt;
  tangentSpd = clamp(tangentSpd, -15, CAR_MAX_SPEED * 0.85);
  // Rebuild velocity: tangent + small constant inward offset
  cs.vx = tx * tangentSpd - cs.wallNX * 0.8;
  cs.vz = tz * tangentSpd - cs.wallNZ * 0.8;

  // Steering
  cs.steerInput = approach(cs.steerInput, steerIn, 9 * dt);
  const tangentHeading = Math.atan2(tx, tz);
  cs.heading = approach(cs.heading, tangentHeading + steerIn * 0.4, 7 * dt);
  cs.angularVel = approach(cs.angularVel, steerIn * YAW_HIGH, 20 * dt);

  // Trick accumulation — identical to air, scored on wall-jump or landing
  const spinMode = keys.brake;
  const pitchT = flipIn * 7, rollT = spinMode ? 0 : -steerIn * 6;
  cs.airPitchVel = approach(cs.airPitchVel, pitchT, 30 * dt);
  cs.airRollVel  = approach(cs.airRollVel,  rollT,  26 * dt);
  cs.airPitch   += cs.airPitchVel * dt;
  cs.airRoll    += cs.airRollVel * dt;
  if (spinMode) cs.airYaw += steerIn * 5 * dt;
  cs.airTime += dt;

  // Move
  pos.x = clamp(pos.x + cs.vx * dt, -WORLD + 2, WORLD - 2);
  pos.z = clamp(pos.z + cs.vz * dt, -WORLD + 2, WORLD - 2);
  pos.y += cs.velY * dt;
  cs.speed = tangentSpd;

  // Periodic sparks
  if (Math.floor(cs.wallTimer / 0.15) > Math.floor((cs.wallTimer - dt) / 0.15))
    emitSparks(pos.x, pos.y, pos.z, 0, 0, MOBILE ? 1 : 2, 0.6);

  // Proximity check: probe INTO wall (car pos minus 1.5× outward normal should hit collider)
  const probeX = pos.x - cs.wallNX * 1.5, probeZ = pos.z - cs.wallNZ * 1.5;
  const onWall = colliders.some(c =>
    probeX > c.minX - 0.3 && probeX < c.maxX + 0.3 &&
    probeZ > c.minZ - 0.3 && probeZ < c.maxZ + 0.3 &&
    pos.y < c.top + 0.5 && pos.y > -0.5
  );
  if (!onWall) { detachWall(false); return; }

  // Time / speed limit
  if (cs.wallTimer > WALL_MAX_TIME || Math.hypot(cs.vx, cs.vz) < 3) detachWall(false);
}

// ─────────────────────────────────────────────────────────────
//  PHYSICS: AIR, GROUND
// ─────────────────────────────────────────────────────────────
function doJump() {
  const cs = carState, pos = cs.position;
  let extra = 0;
  if (cs.rampRef) extra = Math.sin(cs.rampRef.rAngle) * Math.max(0, cs.speed) * 0.9;
  cs.velY = JUMP_FORCE + extra;
  cs.onGround = false; cs.coyote = 0; cs.jumpBuffer = 0; cs.airTime = 0; cs.rampRef = null;
  resetAir();
  emitDust(pos.x, 0.2, pos.z, MOBILE ? 3 : 6, 3, 1);
}

function updateAir(dt, steerIn, flipIn) {
  const cs = carState, pos = cs.position;
  const Hprev = pos.y - CAR_Y;
  cs.velY -= GRAVITY * dt;
  cs.airTime += dt;

  // Rotation control: W/S flips, A/D rolls, Shift + A/D spins
  const spinMode = keys.brake;
  let pitchT = flipIn * 11, rollT = spinMode ? 0 : -steerIn * 9;
  if (Math.abs(flipIn) < 0.05) { const w = wrapAngle(cs.airPitch); if (Math.abs(w) < 1.2) pitchT = -w * 3.2; }
  if (!spinMode && Math.abs(steerIn) < 0.05) { const w = wrapAngle(cs.airRoll); if (Math.abs(w) < 1.2) rollT = -w * 3.2; }
  cs.airPitchVel = approach(cs.airPitchVel, pitchT, 34 * dt);
  cs.airRollVel = approach(cs.airRollVel, rollT, 30 * dt);
  cs.airPitch += cs.airPitchVel * dt;
  cs.airRoll += cs.airRollVel * dt;

  let yawT = spinMode ? steerIn * 7 : steerIn * 1.0;
  const hs = Math.hypot(cs.vx, cs.vz);
  if (!spinMode && Math.abs(steerIn) < 0.05 && hs > 3) {
    const off = wrapAngle(Math.atan2(cs.vx, cs.vz) - cs.heading);
    if (Math.abs(off) < 0.9) yawT = off * 2.5;
  }
  cs.angularVel = approach(cs.angularVel, yawT, 40 * dt);
  cs.heading += cs.angularVel * dt; cs.airYaw += cs.angularVel * dt;

  // Horizontal flight keeps its momentum
  const drag = Math.exp(-0.12 * dt); cs.vx *= drag; cs.vz *= drag;
  let nx = pos.x + cs.vx * dt, nz = pos.z + cs.vz * dt;
  const ny = pos.y + cs.velY * dt, Hn = ny - CAR_Y;
  if (!blocked(pos.x, pos.z, Hprev, AIR_HW, AIR_HL)) {
    if (blocked(nx, pos.z, Hn, AIR_HW, AIR_HL)) {
      if (Math.abs(cs.vx) > 6) emitSparks(pos.x, pos.y, pos.z, 0, 0, 5);
      // Try wall attachment — normal points in -sign(vx) direction on X axis
      if (!tryAttachWall(-Math.sign(cs.vx), 0)) { nx = pos.x; cs.vx *= -0.25; }
    }
    if (blocked(pos.x, nz, Hn, AIR_HW, AIR_HL)) {
      if (Math.abs(cs.vz) > 6) emitSparks(pos.x, pos.y, pos.z, 0, 0, 5);
      if (!tryAttachWall(0, -Math.sign(cs.vz))) { nz = pos.z; cs.vz *= -0.25; }
    }
  }
  pos.x = clamp(nx, -WORLD + 2, WORLD - 2); pos.z = clamp(nz, -WORLD + 2, WORLD - 2); pos.y = ny;
  cs.speed = cs.vx * Math.sin(cs.heading) + cs.vz * Math.cos(cs.heading);
  cs.steerInput = approach(cs.steerInput, steerIn, 5 * dt);

  checkDestruction(pos.x, pos.z, Hn);
  if (tryAttachRail()) return;

  const fl = CAR_Y + floorAt(pos.x, pos.z, Hprev);
  if (cs.velY <= 0 && pos.y <= fl) { pos.y = fl; land(-cs.velY); }
}

function updateGround(dt, steerIn, ctrl) {
  const cs = carState, pos = cs.position;
  const H0 = pos.y - CAR_Y;
  const prevRamp = cs.rampRef;

  cs.airPitch = approach(cs.airPitch, 0, 15 * dt);
  cs.airRoll = approach(cs.airRoll, 0, 15 * dt);

  // ── Steering: speed-sensitive yaw rate (nimble when slow, stable when fast)
  const spd0 = cs.speed, spd0Abs = Math.abs(spd0);
  const spdNorm = clamp(spd0Abs / CAR_MAX_SPEED, 0, 1);
  cs.steerInput = approach(cs.steerInput, steerIn * ctrl, (steerIn === 0 ? 12 : 9) * dt);
  cs.steerAngle = cs.steerInput * CAR_STEER_MAX * (1 - 0.5 * spdNorm);
  const yawMax = lerp(YAW_LOW, YAW_HIGH, Math.pow(spdNorm, 0.8));
  const authority = clamp(spd0Abs / 4.5, 0, 1);
  const targetYaw = cs.steerInput * yawMax * authority * (spd0 >= 0 ? 1 : -1);
  cs.angularVel += (targetYaw - cs.angularVel) * (1 - Math.exp(-13 * dt));
  cs.heading += cs.angularVel * dt;

  const sH = Math.sin(cs.heading), cH = Math.cos(cs.heading);
  let fs = cs.vx * sH + cs.vz * cH;      // forward speed
  let ls = cs.vx * cH - cs.vz * sH;      // lateral (sideways) speed

  // ── Engine / brakes
  const pedalTarget = ((keys.forward ? 1 : 0) - (keys.back ? 1 : 0)) * ctrl;
  cs.pedal = approach(cs.pedal, pedalTarget, (pedalTarget === 0 ? 10 : 8) * dt);
  let spd = fs;
  if (cs.pedal > 0.02) {
    if (spd < -0.3) spd += CAR_BRAKE_FORCE * cs.pedal * dt;
    else spd += CAR_ACCEL * cs.pedal * Math.max(0.25, 1 - spd / CAR_MAX_SPEED) * dt;
  } else if (cs.pedal < -0.02) {
    if (spd > 0.3) spd += CAR_BRAKE_FORCE * cs.pedal * dt;
    else spd += CAR_REVERSE_ACC * cs.pedal * Math.max(0.3, 1 - Math.abs(spd) / 25) * dt;
  } else spd = approach(spd, 0, CAR_ROLL_FRIC * dt);
  spd -= CAR_AERO * spd * Math.abs(spd) * dt;
  // ── Nitro boost (SHIFT held on ground)
  if (keys.brake && spd > 0) {
    spd += NITRO_ACCEL * Math.max(0.1, 1 - spd / NITRO_MAX_SPEED) * dt;
    spd = Math.min(spd, NITRO_MAX_SPEED);
    if (Math.random() < 0.4) emitDust(pos.x - Math.sin(cs.heading) * 2, 0.3, pos.z - Math.cos(cs.heading) * 2, 1, 1.5, 0.8, 0.6, 0.7);
  }
  spd = clamp(spd, -18, keys.brake ? NITRO_MAX_SPEED : CAR_MAX_SPEED);
  const accel = (spd - fs) / Math.max(dt, 1e-3);

  // ── Tyre grip (nitro keeps full grip — no loosening)
  let grip = GRIP;
  if (cs.wipeT > 0) grip *= 0.5;
  ls *= Math.exp(-grip * dt);
  cs.vx = sH * spd + cH * ls; cs.vz = cH * spd - sH * ls;

  // ── Tilt
  cs.lean = approach(cs.lean, clamp(cs.angularVel * spd * 0.0035, -0.11, 0.11), 10 * dt);
  cs.pitch = approach(cs.pitch, clamp(-accel * 0.0016, -0.07, 0.07), 10 * dt);

  // ── Movement + collisions
  let nx = pos.x + cs.vx * dt, nz = pos.z + cs.vz * dt;
  checkDestruction(nx, nz, H0);
  const stuck = blocked(pos.x, pos.z, H0, HW, HL);
  const canMove = (px, pz) => stuck || (!blocked(px, pz, H0, HW, HL) && floorAt(px, pz, H0) <= H0 + 0.9);
  const speedBefore = Math.hypot(cs.vx, cs.vz);
  let hitWall = false;
  // When stuck=true, canMove() always returns true and walls are never detected.
  // Instead, test the un-biased blocked() directly to catch wall hits even when stuck.
  const hitX = !canMove(nx, pos.z) || (stuck && blocked(nx, pos.z, H0, HW, HL));
  const hitZ = !canMove(pos.x, nz) || (stuck && blocked(pos.x, nz, H0, HW, HL));
  if (hitX && cs.vx !== 0) {
    if (!tryAttachWall(-Math.sign(cs.vx), 0)) { nx = pos.x; cs.vx *= -0.15; hitWall = true; }
    else return;   // wall-ride began; skip rest of updateGround this frame
  }
  if (hitZ && cs.vz !== 0) {
    if (!tryAttachWall(0, -Math.sign(cs.vz))) { nz = pos.z; cs.vz *= -0.15; hitWall = true; }
    else return;
  }
  if (hitWall && speedBefore > 8) emitSparks(pos.x, pos.y - 0.2, pos.z, 0, 0, MOBILE ? 3 : 6);
  const cx = clamp(nx, -WORLD + 2, WORLD - 2), cz = clamp(nz, -WORLD + 2, WORLD - 2);
  if (cx !== nx) cs.vx = 0; if (cz !== nz) cs.vz = 0;
  pos.x = cx; pos.z = cz;
  cs.speed = clamp(cs.vx * sH + cs.vz * cH, -18, CAR_MAX_SPEED + 6);

  // ── Surface following, ramp launch and edge drops
  const ru = rampUnder(pos.x, pos.z);
  const S = floorAt(pos.x, pos.z, H0);
  if (ru) { cs.rampRef = ru.r; cs.rampLZ = ru.lz; }
  else if (prevRamp) {
    cs.rampRef = null;
    if (cs.rampLZ > prevRamp.len * 0.8 && cs.speed > 4) {       // flew off the lip
      cs.velY = Math.max(5, Math.sin(prevRamp.rAngle) * cs.speed * 1.3);
      cs.onGround = false; cs.airTime = 0; resetAir();
      setBanner('RAMP JUMP!', 1.0);
      return;
    }
  }
  const target = CAR_Y + S;
  if (pos.y - target > 0.7) {                                   // drove off an edge
    cs.onGround = false; cs.velY = 0; cs.airTime = 0; cs.coyote = 0.1; resetAir();
    return;
  }
  pos.y = approach(pos.y, target, 30 * dt);
  if (ru) cs.pitch = approach(cs.pitch, -ru.r.rAngle, 15 * dt);

  // ── Tyre smoke when sliding hard
  const slide = Math.abs(ls);
  if (slide > 4) {
    const bx_ = pos.x - sH * 1.3, bz_ = pos.z - cH * 1.3;
    emitDust(bx_ + cH * 0.8, 0.2, bz_ - sH * 0.8, 1, 1.5, 1, 0.85, 1.0);
    emitDust(bx_ - cH * 0.8, 0.2, bz_ + sH * 0.8, 1, 1.5, 1, 0.85, 1.0);
  }
}

function updateCar(dt) {
  if (gamePaused || !gameRunning) return;
  const cs = carState;
  cs.railCooldown = Math.max(0, cs.railCooldown - dt);
  cs.jumpBuffer = Math.max(0, cs.jumpBuffer - dt);
  cs.coyote = Math.max(0, cs.coyote - dt);
  cs.wipeT = Math.max(0, cs.wipeT - dt);
  cs.wallCooldown = Math.max(0, cs.wallCooldown - dt);
  cs.dashCooldown = Math.max(0, cs.dashCooldown - dt);
  cs.bob = approach(cs.bob, 0, 0.9 * dt);

  const jumpEdge = keys.jump && !jumpPressed; jumpPressed = keys.jump;
  if (jumpEdge) cs.jumpBuffer = 0.15;

  // ── Forward dash (F key — fires once per press, has cooldown) ──
  if (keys.dash) {
    keys.dash = false;   // consume the press immediately (it's a momentary trigger)
    if (cs.dashCooldown <= 0 && !cs.wallRide && !cs.grinding) {
      const sHd = Math.sin(cs.heading), cHd = Math.cos(cs.heading);
      cs.vx += sHd * DASH_IMPULSE;
      cs.vz += cHd * DASH_IMPULSE;
      cs.dashCooldown = DASH_COOLDOWN;
      setBanner('DASH!', 0.5);
      emitDust(cs.position.x, 0.2, cs.position.z, MOBILE ? 4 : 8, 4, 1.5, 0.9, 1.1);
    }
  }

  const kSteer = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
  const steerIn = joyState.active ? -deadzone(joyState.x) : kSteer;
  const kFlip = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const flipIn = joyState.active ? -deadzone(joyState.y) : kFlip;
  const ctrl = cs.wipeT > 0 ? 0.35 : 1;

  if (cs.grinding) {
    updateGrind(dt, jumpEdge, steerIn);
  } else if (cs.wallRide) {
    updateWallRide(dt, steerIn, jumpEdge, flipIn);
  } else {
    if (cs.jumpBuffer > 0 && (cs.onGround || cs.coyote > 0)) {
      doJump();
    } else if (jumpEdge && !cs.onGround && cs.canDoubleJump) {
      // ── Double jump: second jump while airborne ──
      cs.velY = JUMP_FORCE * 0.82;   // slightly weaker than first jump
      cs.canDoubleJump = false;
      cs.jumpBuffer = 0;
      setBanner('DOUBLE JUMP!', 0.7);
      emitDust(cs.position.x, cs.position.y - 0.3, cs.position.z, MOBILE ? 3 : 6, 3, 1.5);
    }
    if (cs.onGround) updateGround(dt, steerIn, ctrl);
    else updateAir(dt, steerIn, flipIn);
  }
  _applyCarTransform(dt);
  updateTrickHUD(dt);
}

function _applyCarTransform(dt) {
  const cs = carState;
  car.position.copy(cs.position); car.rotation.y = cs.heading;
  // While wall-riding, tilt the car body 90° toward the wall face
  let bodyRoll = cs.lean + cs.airRoll;
  let bodyPitch = cs.pitch + cs.airPitch;
  if (cs.wallRide) {
    const wallTilt = Math.PI / 2 * clamp(cs.wallTimer / 0.18, 0, 1);
    bodyRoll = approach(bodyRoll, wallTilt, 18 * dt);
    cs.lean = bodyRoll - cs.airRoll;   // keep lean in sync so it un-tilts cleanly
  }
  carBody.rotation.x = bodyPitch;
  carBody.rotation.z = bodyRoll;
  carBody.position.y = cs.bob;
  cs.wheelRot += (cs.speed * dt) / 0.35;
  for (const w of wheels) {
    w.mesh.rotation.x = cs.wheelRot;
    if (w.isFront) w.pivot.rotation.y = cs.steerAngle;
  }
  const braking = keys.back && cs.speed > 1;
  if (braking !== tailBright) { tailBright = braking; MAT.tail.color.setHex(braking ? 0xff6070 : 0xaa1030); }
}

function updateTrickHUD(dt) {
  const cs = carState;
  if (!cs.grinding) setHidden(ui.grind, true);
  if (cs.wallRide) {
    let t = ' 🏙 WALL RIDE ' + cs.wallTimer.toFixed(1) + 's';
    if (Math.abs(cs.airPitch) > 0.8) t += cs.airPitch > 0 ? ' 🔄 FLIP' : ' 🔄 FLIP';
    if (Math.abs(cs.airRoll) > 0.8) t += ' 🌀 ROLL';
    if (Math.abs(cs.airYaw) > 1.2) t += ' 💫 SPIN';
    setText(ui.air, t);
    setHidden(ui.air, false);
  } else if (!cs.onGround && !cs.grinding) {
    let t = '';
    if (Math.abs(cs.airPitch) > 0.8) t += cs.airPitch > 0 ? ' 🔄 FRONTFLIP' : ' 🔄 BACKFLIP';
    if (Math.abs(cs.airRoll) > 0.8) t += ' 🌀 BARREL ROLL';
    if (Math.abs(cs.airYaw) > 1.2) t += ' 💫 SPIN';
    setText(ui.air, '🚀 AIRTIME ' + cs.airTime.toFixed(1) + 's' + t);
    setHidden(ui.air, false);
  } else if (cs.bannerT > 0) {
    cs.bannerT -= dt;
    setText(ui.air, cs.bannerText);
    setHidden(ui.air, false);
  } else setHidden(ui.air, true);
}

// ─────────────────────────────────────────────────────────────
//  CAMERA & HUD
// ─────────────────────────────────────────────────────────────
function updateCamera(dt) {
  if (!car) return;
  const p = car.position, spd = Math.min(1, Math.abs(carState.speed) / CAR_MAX_SPEED);

  const fov = approach(camera.fov, 70 + spd * 20, 6 * dt);
  if (fov !== camera.fov) { camera.fov = fov; camera.updateProjectionMatrix(); }

  if (cameraMode === 0) {
    // ── Chase cam with full 360° orbit ──────────────────────────
    // yaw = car heading + persistent horizontal orbit offset (no auto-reset)
    const yaw = carState.heading + camOrbitYaw;
    const sinY = Math.sin(yaw), cosY = Math.cos(yaw);
    // Spherical orbit arm: pitch rotates the arm up/down around the car
    const arm = 8.0 + spd * 2.5;
    const cosP = Math.cos(camOrbitPitch), sinP = Math.sin(camOrbitPitch);
    // Camera sits at: car + arm * (-sinY*cosP,  sinP, -cosY*cosP)
    const tx = -sinY * cosP, ty = sinP, tz = -cosY * cosP;
    _cp.set(p.x + tx * arm, p.y + ty * arm, p.z + tz * arm);
    camPos.lerp(_cp, 1 - Math.exp(-12 * dt));
    camera.position.copy(camPos);
    // Always look at the car — keeps the car centred regardless of orbit angle
    camera.lookAt(p.x, p.y + 0.8, p.z);
  } else {
    // ── Bumper cam (unaffected by orbit) ────────────────────────
    const sHc = Math.sin(carState.heading), cHc = Math.cos(carState.heading);
    camera.position.set(p.x + sHc * 0.5, p.y + 2.0, p.z + cHc * 0.5);
    camera.lookAt(p.x + sHc * 15, p.y + 1.0, p.z + cHc * 15);
  }

  // Shadow frustum follows the car for crisp shadows
  if (sun) { sun.target.position.set(p.x, 0, p.z); sun.position.set(p.x + 100, 150, p.z - 80); sun.target.updateMatrixWorld(); }
  if (cloudMesh) cloudMesh.rotation.y += 0.004 * dt;
}

function cycleCameraMode() { cameraMode = (cameraMode + 1) % 2; setText(ui.cam, CAM_MODES[cameraMode]); }

const speedoCtx = $('speedo-canvas').getContext('2d');
function drawSpeedometer(speedKmh) {
  const ctx = speedoCtx, Wd = 120, Ht = 120, cx = Wd / 2, cy = Ht / 2 + 8, r = 48;
  const minA = Math.PI * 0.75, maxA = Math.PI * 2.25;
  const pct = Math.min(1, Math.abs(speedKmh) / (CAR_MAX_SPEED * 3.6));
  const needleA = minA + pct * (maxA - minA);
  ctx.clearRect(0, 0, Wd, Ht);
  ctx.beginPath(); ctx.arc(cx, cy, r, minA, maxA);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 10; ctx.stroke();
  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  grad.addColorStop(0, '#00ffff'); grad.addColorStop(0.5, '#ffff00'); grad.addColorStop(1, '#ff0055');
  ctx.beginPath(); ctx.arc(cx, cy, r, minA, needleA);
  ctx.strokeStyle = grad; ctx.lineWidth = 8; ctx.lineCap = 'butt'; ctx.stroke();
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(needleA);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(r - 8, 0);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.stroke();
  ctx.restore();
}

let _lastKmh = -1;
function updateHUD() {
  const kmh = Math.abs(carState.speed) * 3.6, r = Math.round(kmh);
  setText(ui.speed, String(r));
  setText(ui.score, String(score));
  if (r !== _lastKmh) { _lastKmh = r; drawSpeedometer(kmh); }
  setText(ui.gear, Math.abs(carState.speed) < 0.5 ? 'N' : carState.speed < 0 ? 'R' : 'D');
}

function resetCarPosition() {
  const cs = carState;
  cs.position.set(0, CAR_Y, 25);
  cs.heading = 0; cs.speed = 0; cs.vx = 0; cs.vz = 0; cs.velY = 0; cs.angularVel = 0;
  cs.pitch = 0; cs.lean = 0; cs.bob = 0; cs.steerInput = 0; cs.pedal = 0;
  cs.onGround = true; cs.grinding = false; cs.grindRail = null; cs.rampRef = null;
  cs.airTime = 0; cs.coyote = 0; cs.jumpBuffer = 0; cs.wipeT = 0; cs.railCooldown = 0; cs.bannerT = 0;
  cs.wallRide = false; cs.wallNX = 0; cs.wallNZ = 0; cs.wallTimer = 0; cs.wallCooldown = 0;
  cs.dashCooldown = 0; cs.canDoubleJump = true;
  resetAir();
  camPos.set(0, 5, 35); camTarget.set(0, 1, 20);
  if (car) { car.position.copy(cs.position); car.rotation.y = 0; }
}

function togglePause() {
  if (!gameRunning) return;
  gamePaused = !gamePaused;
  $('pause-menu').classList.toggle('hidden', !gamePaused);
  if (!gamePaused) { clock.getDelta(); if (!loopActive) loop(); }
}

function loop() {
  if (!gameRunning || gamePaused) { loopActive = false; return; }
  loopActive = true; requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  updateCar(dt); updateParticles(dt); updateCamera(dt); updateFX(dt); updateHUD();
  renderer.render(scene, camera);
}

init();
