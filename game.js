// ============================================================
//  LITTLE CITY DRIVE — game.js  (v2 - Improved)
//  Three.js low-poly driving game
// ============================================================

import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js';

// ─────────────────────────────────────────────────────────────
//  GLOBALS
// ─────────────────────────────────────────────────────────────
let scene, camera, renderer, clock;
let car, carBody;
let wheels = [];
let cameraMode = 0;           // 0 = chase, 1 = hood
const CAM_MODES = ['CAM 1', 'CAM 2'];

let gameRunning = false;
let gamePaused  = false;
let loopActive  = false;

// Static building/tree colliders (permanent)
const colliders = [];

// Destructible objects  { group, collider:{minX,maxX,minZ,maxZ}, type, alive }
const destructibles = [];

// Active particle systems  [{ meshes:[], vel:[], life, maxLife }]
const particles = [];

// Ramp launch zones  { minX, maxX, minZ, maxZ, nx, nz, angle, launchSpeed }
const ramps = [];

// Scoring
let score = 0;

const SCORE_TABLE = {
  barrel:  150,
  crate:   100,
  bin:      60,
  cone:     30,
  hydrant: 120,
  tree:     80,
};

function addScore(pts, wx, wz) {
  score += pts;
  // Update DOM
  const el = document.getElementById('score-value');
  if (el) {
    el.textContent = score;
    el.classList.remove('bump');
    void el.offsetWidth; // reflow to restart animation
    el.classList.add('bump');
    setTimeout(() => el.classList.remove('bump'), 200);
  }
  // Floating popup
  if (wx !== undefined && camera) {
    const v = new THREE.Vector3(wx, 1.5, wz).project(camera);
    const px = (v.x *  0.5 + 0.5) * window.innerWidth;
    const py = (v.y * -0.5 + 0.5) * window.innerHeight;
    const div = document.createElement('div');
    div.className = 'score-popup';
    div.textContent = '+' + pts;
    div.style.left = px + 'px';
    div.style.top  = py + 'px';
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 900);
  }
}

// ── Input state ───────────────────────────────────────────────
const TOUCH_KEYS = { 'touch-accel': 'forward', 'touch-brake': 'back', 'touch-left': 'left', 'touch-right': 'right' };
const keys = {
  forward: false, back: false,
  left: false,    right: false,
  brake: false,
};

// ── Car physics state ─────────────────────────────────────────
const carState = {
  speed:       0,       // m/s  (+forward, -reverse)
  steerAngle:  0,       // current wheel angle (radians)
  heading:     0,       // world-space yaw (radians)
  angularVel:  0,       // smoothed yaw-rate (rad/s)
  position:    new THREE.Vector3(0, 0.45, 25),
  lean:        0,
  wheelRot:    0,
  pedal:       0,       // smoothed throttle/brake pedal (-1..1)
  steerInput:  0,       // smoothed steering input (-1..1)
  pitch:       0,
  // Jump physics
  velY:        0,       // vertical velocity (m/s)
  onGround:    true,
  airTime:     0,       // cumulative airborne seconds
  // Air trick rotation (radians, applied on top of car orientation)
  airPitch:    0,       // frontflip(+) / backflip(-) accumulated angle
  airRoll:     0,       // barrel roll accumulated angle
  airPitchVel: 0,       // angular velocity for pitch trick
  airRollVel:  0,       // angular velocity for roll trick
  drifting:    false,   // in a handbrake drift
  driftVelX:   0,       // world-space slide velocity X
  driftVelZ:   0,       // world-space slide velocity Z
};

// Physics constants (Tweaked for lighter, more fluid driving and stylish drifting)
const CAR_MAX_SPEED    = 30;      // m/s 
const CAR_ACCEL        = 15;      // punchier off-the-line
const CAR_BRAKE_FORCE  = 28;
const CAR_REVERSE_ACC  = 8;
const CAR_ROLL_FRIC    = 1.2;     // lighter coasting — car glides more freely
const CAR_AERO         = 0.0025;
const CAR_STEER_MAX    = 0.75;    // wider steering angle for better control
const CAR_LAT_ACC      = 22;      // more grip headroom before sliding naturally
const WHEEL_BASE       = 2.1;
// Drift constants
const DRIFT_ENTRY_SPD  = 5;       // min speed to enter drift
const DRIFT_SLIDE_FRIC = 2.0;     // lower decay for longer, smoother slides
const DRIFT_YAW_BOOST  = 2.2;     // sharper, more stylish rotation during drift

// ── Smooth camera state ───────────────────────────────────────
const camPos    = new THREE.Vector3();
const camTarget = new THREE.Vector3();

// ─────────────────────────────────────────────────────────────
//  ENTRY POINT
// ─────────────────────────────────────────────────────────────
function init() {
  setupUI();
}

function startGame() {
  document.getElementById('main-menu').classList.add('hidden');
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('pause-menu').classList.add('hidden');

  if (!scene) {
    setupRenderer();
    setupScene();
    setupCar();
    buildCity();
    setupLights();
    setupEventListeners();
    clock = new THREE.Clock();
  }

  resetCarPosition();
  gameRunning = true;
  gamePaused  = false;
  clock.getDelta();
  if (!loopActive) loop();
}

// ─────────────────────────────────────────────────────────────
//  UI SETUP
// ─────────────────────────────────────────────────────────────
function setupUI() {
  document.getElementById('btn-start').addEventListener('click', startGame);
  document.getElementById('btn-controls').addEventListener('click', () => {
    document.getElementById('controls-overlay').classList.remove('hidden');
  });
  document.getElementById('btn-controls-close').addEventListener('click', () => {
    document.getElementById('controls-overlay').classList.add('hidden');
  });

  document.getElementById('btn-pause-hud').addEventListener('click', togglePause);
  document.getElementById('btn-reset-hud').addEventListener('click', resetCarPosition);
  document.getElementById('btn-resume').addEventListener('click', togglePause);
  document.getElementById('btn-restart').addEventListener('click', () => {
    document.getElementById('pause-menu').classList.add('hidden');
    score = 0;
    resetCarPosition();
    gameRunning = true;
    gamePaused  = false;
    clock.getDelta();
    if (!loopActive) loop();
  });
  document.getElementById('btn-mainmenu').addEventListener('click', () => {
    gameRunning = false;
    gamePaused  = false;
    document.getElementById('pause-menu').classList.add('hidden');
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('main-menu').classList.remove('hidden');
  });

  // Touch controls
  const touchMap = {
    'touch-accel': () => { keys.forward = true; },
    'touch-brake': () => { keys.back    = true; },
    'touch-left':  () => { keys.left    = true; },
    'touch-right': () => { keys.right   = true; },
  };
  for (const [id, fn] of Object.entries(touchMap)) {
    const el = document.getElementById(id);
    el.addEventListener('touchstart', e => { e.preventDefault(); fn(); el.classList.add('active'); }, { passive: false });
    el.addEventListener('touchend',   e => {
      e.preventDefault();
      keys[TOUCH_KEYS[id]] = false;
      el.classList.remove('active');
    }, { passive: false });
  }
}

// ─────────────────────────────────────────────────────────────
//  RENDERER & SCENE
// ─────────────────────────────────────────────────────────────
function setupRenderer() {
  const canvas = document.getElementById('game-canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x87ceeb);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function setupScene() {
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xd0eeff, 0.010);
  scene.background = new THREE.Color(0x87ceeb);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 5, -10);
  scene.add(camera);
}

function setupLights() {
  const ambient = new THREE.AmbientLight(0xfff4e0, 0.65);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff8e7, 1.3);
  sun.position.set(80, 100, 60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near   = 1;
  sun.shadow.camera.far    = 350;
  sun.shadow.camera.left   = -120;
  sun.shadow.camera.right  =  120;
  sun.shadow.camera.top    =  120;
  sun.shadow.camera.bottom = -120;
  sun.shadow.bias = -0.001;
  scene.add(sun);

  const hemi = new THREE.HemisphereLight(0x87ceeb, 0x9ccc65, 0.4);
  scene.add(hemi);
}

// ─────────────────────────────────────────────────────────────
//  EVENT LISTENERS
// ─────────────────────────────────────────────────────────────
function setupEventListeners() {
  document.addEventListener('keydown', e => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    keys.forward = true;  break;
      case 'KeyS': case 'ArrowDown':  keys.back    = true;  break;
      case 'KeyA': case 'ArrowLeft':  keys.left    = true;  break;
      case 'KeyD': case 'ArrowRight': keys.right   = true;  break;
      case 'Space': keys.brake = true; e.preventDefault(); break;
      case 'KeyR': if (!e.repeat) resetCarPosition(); break;
      case 'KeyC': if (!e.repeat) cycleCameraMode(); break;
      case 'Escape': if (gameRunning) togglePause(); break;
    }
  });
  document.addEventListener('keyup', e => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    keys.forward = false; break;
      case 'KeyS': case 'ArrowDown':  keys.back    = false; break;
      case 'KeyA': case 'ArrowLeft':  keys.left    = false; break;
      case 'KeyD': case 'ArrowRight': keys.right   = false; break;
      case 'Space': keys.brake = false; break;
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  CAR CONSTRUCTION
// ─────────────────────────────────────────────────────────────
function setupCar() {
  car = new THREE.Group();
  scene.add(car);

  const bodyMat  = new THREE.MeshLambertMaterial({ color: 0xe63232, flatShading: true });
  const roofMat  = new THREE.MeshLambertMaterial({ color: 0xcc2222, flatShading: true });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x99ddff, transparent: true, opacity: 0.7, flatShading: true });
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x222222, flatShading: true });
  const rimMat   = new THREE.MeshLambertMaterial({ color: 0xcccccc, flatShading: true });
  const lightMat = new THREE.MeshLambertMaterial({ color: 0xffffaa, emissive: 0xffff00, emissiveIntensity: 0.3 });
  const tailMat  = new THREE.MeshLambertMaterial({ color: 0xff3300, emissive: 0xff2200, emissiveIntensity: 0.4 });
  const bumpMat  = new THREE.MeshLambertMaterial({ color: 0xdd2222, flatShading: true });

  carBody = new THREE.Group();
  car.add(carBody);

  // Main body
  const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.65, 4.0), bodyMat);
  bodyMesh.position.set(0, 0.32, 0);
  bodyMesh.castShadow = true;
  carBody.add(bodyMesh);

  // Roof cabin
  const cabinMesh = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.55, 2.0), roofMat);
  cabinMesh.position.set(0, 0.925, -0.1);
  cabinMesh.castShadow = true;
  carBody.add(cabinMesh);

  // Windshields
  const wfGeo = new THREE.PlaneGeometry(1.3, 0.48);
  const wfMesh = new THREE.Mesh(wfGeo, glassMat);
  wfMesh.position.set(0, 0.925, 0.91);
  wfMesh.rotation.x = -0.3;
  carBody.add(wfMesh);
  const wrMesh = new THREE.Mesh(wfGeo, glassMat);
  wrMesh.position.set(0, 0.925, -1.11);
  wrMesh.rotation.x = 0.3;
  carBody.add(wrMesh);

  // Side windows
  const swGeo = new THREE.PlaneGeometry(1.75, 0.4);
  const swL = new THREE.Mesh(swGeo, glassMat);
  swL.position.set(-0.78, 0.925, -0.1);
  swL.rotation.y = Math.PI / 2;
  carBody.add(swL);
  const swR = swL.clone();
  swR.position.set(0.78, 0.925, -0.1);
  swR.rotation.y = -Math.PI / 2;
  carBody.add(swR);

  // Bumpers
  const bfGeo  = new THREE.BoxGeometry(1.75, 0.25, 0.18);
  const bfMesh = new THREE.Mesh(bfGeo, bumpMat);
  bfMesh.position.set(0, 0.18, 2.09);
  carBody.add(bfMesh);
  const brMesh = bfMesh.clone();
  brMesh.position.set(0, 0.18, -2.09);
  carBody.add(brMesh);

  // Headlights
  [[0.6, 0.35, 2.01], [-0.6, 0.35, 2.01]].forEach(([x, y, z]) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.06), lightMat);
    mesh.position.set(x, y, z);
    carBody.add(mesh);
  });
  // Taillights
  [[0.6, 0.35, -2.01], [-0.6, 0.35, -2.01]].forEach(([x, y, z]) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.06), tailMat);
    mesh.position.set(x, y, z);
    carBody.add(mesh);
  });

  // Wheels
  wheels = [];
  const wheelPositions = [
    [ 0.95,  1.2, true ],
    [-0.95,  1.2, true ],
    [ 0.95, -1.2, false],
    [-0.95, -1.2, false],
  ];
  wheelPositions.forEach(([wx, wz, front]) => {
    const wm = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.28, 10), wheelMat);
    wm.rotation.z = Math.PI / 2;
    wm.castShadow = true;
    const rm = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.29, 6), rimMat);
    rm.rotation.z = Math.PI / 2;
    wm.add(rm);
    const pivot = new THREE.Group();
    pivot.position.set(wx, 0.35, wz);
    pivot.add(wm);
    car.add(pivot);
    wheels.push({ pivot, mesh: wm, isFront: front });
  });

  car.position.copy(carState.position);
}

// ─────────────────────────────────────────────────────────────
//  SHARED MATERIALS
// ─────────────────────────────────────────────────────────────
const MAT = {
  road:      new THREE.MeshLambertMaterial({ color: 0x444455, flatShading: true }),
  sidewalk:  new THREE.MeshLambertMaterial({ color: 0xccbbaa, flatShading: true }),
  grass:     new THREE.MeshLambertMaterial({ color: 0x5a9e3a, flatShading: true }),
  marking:   new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
  yellowMk:  new THREE.MeshLambertMaterial({ color: 0xffee00, flatShading: true }),
  trunk:     new THREE.MeshLambertMaterial({ color: 0x8b5e3c, flatShading: true }),
  leaves:    new THREE.MeshLambertMaterial({ color: 0x3c9e2e, flatShading: true }),
  leaves2:   new THREE.MeshLambertMaterial({ color: 0x52b53e, flatShading: true }),
  lampPost:  new THREE.MeshLambertMaterial({ color: 0x888888, flatShading: true }),
  lampLight: new THREE.MeshLambertMaterial({ color: 0xfff8cc, emissive: 0xffff88, emissiveIntensity: 0.6 }),
  fence:     new THREE.MeshLambertMaterial({ color: 0xccaa77, flatShading: true }),
  bench:     new THREE.MeshLambertMaterial({ color: 0xaa7744, flatShading: true }),
  water:     new THREE.MeshLambertMaterial({ color: 0x3399cc, transparent: true, opacity: 0.8, flatShading: true }),
  barrel:    new THREE.MeshLambertMaterial({ color: 0xdd4400, flatShading: true }),
  cone:      new THREE.MeshLambertMaterial({ color: 0xff7700, flatShading: true }),
  crate:     new THREE.MeshLambertMaterial({ color: 0xbb8833, flatShading: true }),
  stone:     new THREE.MeshLambertMaterial({ color: 0x999988, flatShading: true }),
};

const BUILDING_COLORS = [
  0xf0e0c8, 0xe8c8a0, 0xffd0a0, 0xd4c4b0,
  0xc8d4b0, 0xb0c8d4, 0xd4b0c8, 0xe8e0d0,
  0xf0d0b0, 0xc0d8b0, 0xb8c8e0, 0xe0c8c0,
  0xf5e8d0, 0xd0e8c8, 0xc8d0e8,
];
const ROOF_COLORS = [
  0xcc4433, 0x885522, 0x556633, 0x334455,
  0x993322, 0x446644, 0x334488, 0x885544,
  0xaa6633, 0x445566, 0x996644,
];

function rng(a, b) { return a + Math.random() * (b - a); }
function pick(arr)  { return arr[Math.floor(Math.random() * arr.length)]; }

// ─────────────────────────────────────────────────────────────
//  CITY GENERATION
// ─────────────────────────────────────────────────────────────
const ROAD_W = 7.0;   // half-road-width
const SIDE_W = 1.4;   // sidewalk width
const ROAD_H = 0.05;

const roadBounds = [];
const solids = [];     // building / tree footprints used to keep new props from overlapping
const WORLD = 92;      // half-size of the playable world
const GRID  = [-80, -40, 0, 40, 80];                                   // road centre lines (both axes)
const PARK_SPOTS = [[-60, -60, 16], [60, 60, 14], [60, -60, 12], [-60, 60, 12]];

function buildCity() {
  buildGround();
  buildRoadNetwork();
  buildBuildings();
  buildPark();
  buildTrees();
  scatterTrees();
  buildStreetFurniture();
  buildDestructibles();
  scatterProps();
  buildRamps();
}

function buildGround() {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), MAT.grass);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// ── Road helpers ──────────────────────────────────────────────
function addRoadSegment(x, z, hw, hd) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, ROAD_H * 2, hd * 2), MAT.road);
  mesh.position.set(x, ROAD_H, z);
  mesh.receiveShadow = true;
  scene.add(mesh);

  const swGeo = new THREE.BoxGeometry(SIDE_W, 0.1, hd * 2 + SIDE_W * 2);
  for (const side of [-1, 1]) {
    const sw = new THREE.Mesh(swGeo, MAT.sidewalk);
    sw.position.set(x + side * (hw + SIDE_W / 2), ROAD_H + 0.03, z);
    sw.receiveShadow = true;
    scene.add(sw);
  }
  roadBounds.push({ minX: x - hw - SIDE_W, maxX: x + hw + SIDE_W, minZ: z - hd, maxZ: z + hd });
}

function addRoadSegmentZ(x, z, hz, hx) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, ROAD_H * 2, hz * 2), MAT.road);
  mesh.position.set(x, ROAD_H, z);
  mesh.receiveShadow = true;
  scene.add(mesh);

  const swGeo = new THREE.BoxGeometry(hx * 2 + SIDE_W * 2, 0.1, SIDE_W);
  for (const side of [-1, 1]) {
    const sw = new THREE.Mesh(swGeo, MAT.sidewalk);
    sw.position.set(x, ROAD_H + 0.03, z + side * (hz + SIDE_W / 2));
    sw.receiveShadow = true;
    scene.add(sw);
  }
  roadBounds.push({ minX: x - hx - SIDE_W, maxX: x + hx + SIDE_W, minZ: z - hz, maxZ: z + hz });
}

function addIntersection(x, z, r) {
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(Math.min(r, ROAD_W), 16), MAT.road);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, ROAD_H * 2 + 0.002, z);
  scene.add(mesh);
  roadBounds.push({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r });
}

function addRoadMarkings(x, z, len, isZ) {
  const dashCount = Math.floor(len / 3);
  const dashGeo = new THREE.PlaneGeometry(isZ ? 0.2 : 2.5, isZ ? 2.5 : 0.2);
  for (let i = 0; i < dashCount; i++) {
    const px = isZ ? x : x - len / 2 + i * 3 + 1.5;
    const pz = isZ ? z - len / 2 + i * 3 + 1.5 : z;
    const c  = isZ ? pz : px;
    if (GRID.some(g => Math.abs(c - g) < 9)) continue;     // keep junctions clear
    const m = new THREE.Mesh(dashGeo, MAT.marking);
    m.rotation.x = -Math.PI / 2;
    m.position.set(px, ROAD_H * 2 + 0.012, pz);
    scene.add(m);
  }
}

function addPedestrianCrossing(x, z, roadAlongZ) {
  const stripGeo = new THREE.PlaneGeometry(roadAlongZ ? ROAD_W * 2 : 0.7, roadAlongZ ? 0.7 : ROAD_W * 2);
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(stripGeo, MAT.marking);
    m.rotation.x = -Math.PI / 2;
    const off = (i - 2) * 1.3;
    m.position.set(roadAlongZ ? x : x + off, ROAD_H * 2 + 0.012, roadAlongZ ? z + off : z);
    scene.add(m);
  }
}

function buildRoundabout(x, z, r) {
  const innerR = r - ROAD_W;
  const ring = new THREE.Mesh(new THREE.RingGeometry(innerR, r, 32), MAT.road);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, ROAD_H * 2 + 0.004, z);
  scene.add(ring);

  const island = new THREE.Mesh(new THREE.CylinderGeometry(innerR - 0.3, innerR - 0.3, 0.3, 24), MAT.grass);
  island.position.set(x, 0.15, z);
  scene.add(island);

  addTree(x, z, 0.5);
  roadBounds.push({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r });
}

function buildRoadNetwork() {
  const LEN = 92;
  for (const v of GRID) {
    addRoadSegmentZ(v, 0, LEN, ROAD_W); addRoadMarkings(v, 0, LEN * 2, true);
    addRoadSegment(0, v, LEN, ROAD_W);  addRoadMarkings(0, v, LEN * 2, false);
  }
  for (const a of GRID) for (const b of GRID) addIntersection(a, b, ROAD_W + 0.5);

  buildRoundabout(0, 0, 10);

  // Pedestrian crossings next to the inner junctions
  for (const a of [-40, 0, 40]) {
    for (const b of [-40, 0, 40]) {
      addPedestrianCrossing(a, b - 12, true);
      addPedestrianCrossing(a, b + 12, true);
      addPedestrianCrossing(a - 12, b, false);
      addPedestrianCrossing(a + 12, b, false);
    }
  }
}

// ── Road overlap check ────────────────────────────────────────
function isOnRoad(bx, bz, bw, bd, includeSolids = true) {
  const pad = 1.2;
  for (const rb of roadBounds) {
    if (bx - bw / 2 < rb.maxX + pad && bx + bw / 2 > rb.minX - pad &&
        bz - bd / 2 < rb.maxZ + pad && bz + bd / 2 > rb.minZ - pad) return true;
  }
  if (includeSolids) {
    const sp = 0.6;
    for (const s of solids) {
      if (bx - bw / 2 < s.maxX + sp && bx + bw / 2 > s.minX - sp &&
          bz - bd / 2 < s.maxZ + sp && bz + bd / 2 > s.minZ - sp) return true;
    }
  }
  return false;
}

// ── Buildings ─────────────────────────────────────────────────
function buildBuildings() {
  const defs = [
    // ── Inner NE block (x+, z-)
    { x:  18, z: -15, w: 7, d: 7, h: 7,  type: 'office'    },
    { x:  25, z: -18, w: 5, d: 5, h: 5,  type: 'house'     },
    { x:  15, z: -22, w: 6, d: 5, h: 9,  type: 'apartment' },
    { x:  22, z: -10, w: 4, d: 4, h: 4,  type: 'shop'      },
    { x:  26, z:  -6, w: 4, d: 5, h: 6,  type: 'office'    },

    // ── Inner NW block (x-, z-)
    { x: -18, z: -15, w: 6, d: 6, h: 8,  type: 'office'    },
    { x: -24, z: -20, w: 5, d: 5, h: 5,  type: 'house'     },
    { x: -14, z: -22, w: 5, d: 5, h: 6,  type: 'cafe'      },
    { x: -22, z: -10, w: 4, d: 4, h: 4,  type: 'shop'      },
    { x: -26, z:  -5, w: 4, d: 5, h: 7,  type: 'apartment' },

    // ── Inner SE block (x+, z+)
    { x:  18, z:  15, w: 6, d: 6, h: 7,  type: 'apartment' },
    { x:  25, z:  18, w: 5, d: 5, h: 4,  type: 'house'     },
    { x:  14, z:  22, w: 5, d: 5, h: 5,  type: 'shop'      },
    { x:  22, z:  10, w: 4, d: 4, h: 10, type: 'office'    },
    { x:  27, z:   7, w: 4, d: 5, h: 5,  type: 'cafe'      },

    // ── Inner SW block (x-, z+)
    { x: -18, z:  15, w: 6, d: 7, h: 8,  type: 'office'    },
    { x: -24, z:  20, w: 5, d: 5, h: 5,  type: 'house'     },
    { x: -14, z:  22, w: 7, d: 5, h: 6,  type: 'gas'       },
    { x: -22, z:  10, w: 4, d: 4, h: 4,  type: 'shop'      },
    { x: -27, z:   7, w: 4, d: 5, h: 6,  type: 'house'     },

    // ── Outer N belt (z=-45 corridor)
    { x:   8, z: -40, w: 6, d: 5, h: 6,  type: 'house'     },
    { x:  -8, z: -40, w: 6, d: 5, h: 5,  type: 'house'     },
    { x:  20, z: -40, w: 5, d: 5, h: 7,  type: 'apartment' },
    { x: -20, z: -40, w: 5, d: 5, h: 7,  type: 'apartment' },
    { x:  36, z: -40, w: 6, d: 5, h: 5,  type: 'house'     },
    { x: -36, z: -40, w: 6, d: 5, h: 5,  type: 'cafe'      },
    { x:   8, z: -52, w: 6, d: 5, h: 6,  type: 'house'     },
    { x:  -8, z: -52, w: 5, d: 5, h: 5,  type: 'house'     },
    { x:  22, z: -52, w: 5, d: 5, h: 6,  type: 'office'    },
    { x: -22, z: -52, w: 5, d: 5, h: 7,  type: 'apartment' },

    // ── Outer S belt
    { x:   8, z:  40, w: 6, d: 5, h: 6,  type: 'house'     },
    { x:  -8, z:  40, w: 6, d: 5, h: 5,  type: 'cafe'      },
    { x:  20, z:  40, w: 5, d: 5, h: 7,  type: 'apartment' },
    { x: -20, z:  40, w: 5, d: 5, h: 7,  type: 'house'     },
    { x:  36, z:  40, w: 5, d: 5, h: 6,  type: 'office'    },
    { x: -36, z:  40, w: 6, d: 5, h: 5,  type: 'house'     },
    { x:   8, z:  52, w: 6, d: 5, h: 5,  type: 'house'     },
    { x:  -8, z:  52, w: 5, d: 5, h: 5,  type: 'house'     },
    { x:  22, z:  52, w: 5, d: 5, h: 6,  type: 'shop'      },
    { x: -22, z:  52, w: 5, d: 5, h: 7,  type: 'apartment' },

    // ── Outer E belt
    { x:  40, z:   8, w: 5, d: 6, h: 6,  type: 'house'     },
    { x:  40, z:  -8, w: 5, d: 6, h: 7,  type: 'office'    },
    { x:  40, z:  20, w: 5, d: 5, h: 5,  type: 'house'     },
    { x:  40, z: -20, w: 5, d: 5, h: 6,  type: 'cafe'      },
    { x:  52, z:   8, w: 5, d: 5, h: 5,  type: 'house'     },
    { x:  52, z:  -8, w: 5, d: 5, h: 6,  type: 'house'     },
    { x:  52, z:  22, w: 5, d: 5, h: 7,  type: 'apartment' },
    { x:  52, z: -22, w: 5, d: 5, h: 5,  type: 'shop'      },

    // ── Outer W belt
    { x: -40, z:   8, w: 5, d: 6, h: 6,  type: 'house'     },
    { x: -40, z:  -8, w: 5, d: 6, h: 7,  type: 'house'     },
    { x: -40, z:  20, w: 5, d: 5, h: 5,  type: 'house'     },
    { x: -40, z: -20, w: 5, d: 5, h: 6,  type: 'office'    },
    { x: -52, z:   8, w: 5, d: 5, h: 5,  type: 'house'     },
    { x: -52, z:  -8, w: 5, d: 5, h: 6,  type: 'gas'       },
    { x: -52, z:  22, w: 5, d: 5, h: 7,  type: 'apartment' },
    { x: -52, z: -22, w: 5, d: 5, h: 5,  type: 'shop'      },
  ];

  defs.forEach(def => {
    if (!isOnRoad(def.x, def.z, def.w + 2, def.d + 2, false)) {
      spawnBuilding(def);
    }
  });

  // Densify: fill the empty blocks with extra buildings
  fillBlocks();
}

function spawnBuilding({ x, z, w, d, h, type, simple = false }) {
  const wallColor = pick(BUILDING_COLORS);
  const roofColor = pick(ROOF_COLORS);
  const wallMat   = new THREE.MeshLambertMaterial({ color: wallColor, flatShading: true });
  const roofMat   = new THREE.MeshLambertMaterial({ color: roofColor, flatShading: true });

  const group = new THREE.Group();
  scene.add(group);
  group.position.set(x, 0, z);

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
  mesh.position.y = h / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  if (type === 'house') {
    const roofMesh = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.78, h * 0.5, 4), roofMat);
    roofMesh.position.y = h + h * 0.25;
    roofMesh.rotation.y = Math.PI / 4;
    roofMesh.castShadow = true;
    group.add(roofMesh);
  } else if (type === 'cafe') {
    const awningMat = new THREE.MeshLambertMaterial({ color: 0xdd4422, flatShading: true });
    const awning = new THREE.Mesh(new THREE.BoxGeometry(w + 0.5, 0.2, 1.5), awningMat);
    awning.position.set(0, h * 0.6, d / 2 + 0.5);
    group.add(awning);
    const fm = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), roofMat);
    fm.position.y = h + 0.15;
    group.add(fm);
  } else if (type === 'gas') {
    const fm = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), roofMat);
    fm.position.y = h + 0.15;
    group.add(fm);
    const canopyMat = new THREE.MeshLambertMaterial({ color: 0x3366aa, flatShading: true });
    const cMesh = new THREE.Mesh(new THREE.BoxGeometry(10, 0.3, 7), canopyMat);
    cMesh.position.set(0, 4.5, d / 2 + 2.5);
    group.add(cMesh);
    for (const px of [-3.5, 3.5]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4.5, 6), MAT.lampPost);
      pole.position.set(px, 2.25, d / 2 + 2.5);
      group.add(pole);
    }
  } else {
    const fm = new THREE.Mesh(new THREE.BoxGeometry(w, 0.4, d), roofMat);
    fm.position.y = h + 0.2;
    fm.castShadow = true;
    group.add(fm);
    if (type === 'apartment' && h > 5) {
      const flineMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
      const floors = Math.floor(h / 3);
      for (let f = 1; f < floors; f++) {
        const ledge = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.12, d + 0.1), flineMat);
        ledge.position.y = f * (h / floors);
        group.add(ledge);
      }
    }
  }

  addWindows(group, w, h, d, wallColor, simple);

  const doorMat = new THREE.MeshLambertMaterial({ color: 0x553311, flatShading: true });
  const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.0, 0.1), doorMat);
  doorMesh.position.set(0, 1.0, d / 2 + 0.05);
  group.add(doorMesh);

  // Removed 0.05 padding from bounds to prevent unnecessary "invisible wall" hits
  colliders.push({ minX: x - w/2, maxX: x + w/2, minZ: z - d/2, maxZ: z + d/2 });
  solids.push({ minX: x - w/2, maxX: x + w/2, minZ: z - d/2, maxZ: z + d/2 });
}

function addWindows(group, w, h, d, wallColor, simple = false) {
  const isBright = wallColor > 0xd0d0d0;
  const winMat = new THREE.MeshLambertMaterial({ color: isBright ? 0x334455 : 0x99ccee, flatShading: true });
  const winGeo = new THREE.PlaneGeometry(0.7, 0.9);
  const rows = Math.max(1, Math.floor(h / 2.5));
  const cols = Math.max(1, Math.floor(w / 2.2));
  const colsD = Math.max(1, Math.floor(d / 2.2));

  for (let r = 0; r < rows; r++) {
    const wy = 1.4 + r * 2.4;
    if (wy > h - 0.5) continue;
    for (let c = 0; c < cols; c++) {
      const wx = -w / 2 + w / (cols + 1) * (c + 1);
      for (const side of (simple ? [1] : [1, -1])) {
        const m = new THREE.Mesh(winGeo, winMat);
        m.position.set(wx, wy, side * (d / 2 + 0.01));
        if (side < 0) m.rotation.y = Math.PI;
        group.add(m);
      }
    }
    for (let c = 0; !simple && c < colsD; c++) {
      const wz = -d / 2 + d / (colsD + 1) * (c + 1);
      for (const side of [1, -1]) {
        const m = new THREE.Mesh(winGeo, winMat);
        m.position.set(side * (w / 2 + 0.01), wy, wz);
        m.rotation.y = side * Math.PI / 2;
        group.add(m);
      }
    }
  }
}

// ── Trees ─────────────────────────────────────────────────────
function fillBlocks() {
  const types = ['house', 'house', 'house', 'apartment', 'shop', 'cafe', 'office', 'office'];
  for (const bx of [-60, -20, 20, 60]) {
    for (const bz of [-60, -20, 20, 60]) {
      if (PARK_SPOTS.some(([px, pz]) => px === bx && pz === bz)) continue;
      for (const ox of [-5.2, 5.2]) {
        for (const oz of [-5.2, 5.2]) {
          if (Math.random() < 0.1) continue;
          const type = pick(types);
          const w = rng(5, 7.5), d = rng(5, 7.5);
          const h = type === 'apartment' ? rng(7, 11)
                  : type === 'office'    ? rng(8, 13)
                  : type === 'house'     ? rng(4, 6)
                  : rng(3.5, 5);
          const x = bx + ox + rng(-0.6, 0.6), z = bz + oz + rng(-0.6, 0.6);
          if (isOnRoad(x, z, w + 2, d + 2)) continue;
          spawnBuilding({ x, z, w, d, h, type, simple: true });
        }
      }
    }
  }
}

function scatterTrees() {
  // Roadside trees along every street
  for (const v of GRID) {
    for (const side of [-11, 11]) {
      for (let t = -84; t <= 84; t += 12) {
        if (Math.random() < 0.45) continue;
        const j = rng(-2, 2);
        if (!isOnRoad(v + side, t + j, 2.4, 2.4)) addTree(v + side, t + j, rng(0.7, 1.2), false);
        if (!isOnRoad(t + j, v + side, 2.4, 2.4)) addTree(t + j, v + side, rng(0.7, 1.2), false);
      }
    }
  }
  // Extra trees in open ground
  let c = 0;
  for (let i = 0; i < 800 && c < 60; i++) {
    const x = rng(-WORLD + 6, WORLD - 6), z = rng(-WORLD + 6, WORLD - 6);
    if (isOnRoad(x, z, 2.4, 2.4)) continue;
    addTree(x, z, rng(0.7, 1.3), false);
    c++;
  }
}

// ── More props + obstacles (also placed ON the roads) ───────────
function scatterProps() {
  const tryN = (n, fn, tries = 800) => {
    let c = 0;
    for (let i = 0; i < tries && c < n; i++) {
      const x = rng(-WORLD + 6, WORLD - 6), z = rng(-WORLD + 6, WORLD - 6);
      if (!isOnRoad(x, z, 2, 2)) { fn(x, z); c++; }
    }
  };
  tryN(28, spawnBarrel);
  tryN(22, spawnCrate);
  tryN(30, spawnCone);
  tryN(26, spawnBin);
  tryN(22, spawnHydrant);
  tryN(18, (x, z) => addTree(x, z, rng(0.6, 1.0), true));

  // Obstacles on the road surface (cone lines, crates, lone barrels)
  const lift = () => { destructibles[destructibles.length - 1].group.position.y = 0.1; };
  for (let i = 0; i < 70; i++) {
    const rb = pick(roadBounds);
    if (rb.maxX - rb.minX < 8 || rb.maxZ - rb.minZ < 8) continue;
    const x = rng(rb.minX + 3, rb.maxX - 3), z = rng(rb.minZ + 3, rb.maxZ - 3);
    if (Math.hypot(x, z) < 14 || Math.hypot(x, z - 25) < 14) continue;
    const r = Math.random();
    if (r < 0.55)      { for (let k = 0; k < 3; k++) { spawnCone(x + k * 1.5, z + rng(-0.3, 0.3)); lift(); } }
    else if (r < 0.80) { spawnCrate(x, z); lift(); }
    else               { spawnBarrel(x, z); lift(); }
  }
}

function addTree(x, z, scale = 1, destructible = false) {
  const group = new THREE.Group();
  scene.add(group);

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18 * scale, 0.25 * scale, 1.4 * scale, 6),
    MAT.trunk
  );
  trunk.position.set(0, 0.7 * scale, 0);
  trunk.castShadow = true;
  group.add(trunk);

  const heights = [1.4, 2.4, 3.2];
  const radii   = [1.5, 1.1, 0.7];
  heights.forEach((yoff, i) => {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(radii[i] * scale, 1.4 * scale, 7),
      i % 2 === 0 ? MAT.leaves : MAT.leaves2
    );
    cone.position.set(0, yoff * scale, 0);
    cone.castShadow = true;
    group.add(cone);
  });

  group.position.set(x, 0, z);

  const col = { minX: x - 0.3 * scale, maxX: x + 0.3 * scale, minZ: z - 0.3 * scale, maxZ: z + 0.3 * scale };

  solids.push(col);
  if (destructible) {
    destructibles.push({ group, collider: col, type: 'tree', alive: true });
  } else {
    colliders.push(col);
  }
}

function buildTrees() {
  const treeSpots = [
    // Along main avenues
    ...[...Array(10)].map((_, i) => ({ x:  4, z: -45 + i * 10 })),
    ...[...Array(10)].map((_, i) => ({ x: -4, z: -45 + i * 10 })),
    ...[...Array(10)].map((_, i) => ({ x: -45 + i * 10, z:  4 })),
    ...[...Array(10)].map((_, i) => ({ x: -45 + i * 10, z: -4 })),
    // Corner decorations
    { x:  35, z:  35 }, { x: -35, z:  35 }, { x:  35, z: -35 }, { x: -35, z: -35 },
    { x:  55, z:  55 }, { x: -55, z:  55 }, { x:  55, z: -55 }, { x: -55, z: -55 },
    // Around roundabout
    { x:  12, z:  0 }, { x: -12, z:  0 }, { x:  0, z:  12 }, { x:  0, z: -12 },
    // Outer belt
    { x:  40, z:  20 }, { x: -40, z:  20 }, { x:  40, z: -20 }, { x: -40, z: -20 },
    { x:  20, z:  44 }, { x: -20, z:  44 }, { x:  20, z: -44 }, { x: -20, z: -44 },
    { x:  44, z:  20 }, { x: -44, z:  20 }, { x:  44, z: -20 }, { x: -44, z: -20 },
    { x:  60, z:  0 }, { x: -60, z:  0 }, { x:  0, z:  60 }, { x:  0, z: -60 },
    // Filler
    { x:  60, z:  30 }, { x: -60, z:  30 }, { x:  60, z: -30 }, { x: -60, z: -30 },
    { x:  30, z:  60 }, { x: -30, z:  60 }, { x:  30, z: -60 }, { x: -30, z: -60 },
  ];

  treeSpots.forEach(({ x, z }) => {
    if (!isOnRoad(x, z, 2, 2)) {
      addTree(x, z, rng(0.75, 1.25), false);
    }
  });
}

// ── Street furniture ──────────────────────────────────────────
function addStreetLight(x, z) {
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 5, 6), MAT.lampPost);
  post.position.set(x, 2.5, z);
  post.castShadow = true;
  scene.add(post);

  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 4), MAT.lampPost);
  arm.position.set(x + 0.6, 5.1, z);
  arm.rotation.z = Math.PI / 2;
  scene.add(arm);

  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 6), MAT.lampLight);
  bulb.position.set(x + 1.1, 4.95, z);
  scene.add(bulb);
}

function addBench(x, z, rot = 0) {
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 0.5), MAT.bench);
  seat.position.set(x, 0.5, z);
  seat.rotation.y = rot;
  seat.castShadow = true;
  scene.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.08), MAT.bench);
  back.position.set(x + Math.sin(rot + Math.PI/2) * 0.2, 0.85, z + Math.cos(rot + Math.PI/2) * 0.2);
  back.rotation.y = rot;
  scene.add(back);
}

function addFenceSegment(x, z, len, isZ) {
  const fMesh = new THREE.Mesh(
    new THREE.BoxGeometry(isZ ? 0.1 : len, 0.9, isZ ? len : 0.1),
    MAT.fence
  );
  fMesh.position.set(x, 0.45, z);
  scene.add(fMesh);
}

function buildStreetFurniture() {
  for (const v of GRID) {
    for (const t of [-60, -20, 20, 60]) {
      for (const s of [-9, 9]) {
        addStreetLight(v + s, t);     // along N-S road
        addStreetLight(t, v + s);     // along E-W road
      }
      addBench(v + 9.8, t + 4, Math.PI / 2);
      addBench(t + 4, v - 9.8, 0);
    }
  }

  // World boundary fence
  addFenceSegment(-WORLD, 0, WORLD * 2, true);
  addFenceSegment( WORLD, 0, WORLD * 2, true);
  addFenceSegment(0,  WORLD, WORLD * 2, false);
  addFenceSegment(0, -WORLD, WORLD * 2, false);
}

// ── Parks ─────────────────────────────────────────────────────
function buildPark() {
  for (const [px, pz, ps] of PARK_SPOTS) _makePark(px, pz, ps);
}

function _makePark(px, pz, ps) {
  if (isOnRoad(px, pz, ps + 2, ps + 2)) return;

  const parkMesh = new THREE.Mesh(new THREE.BoxGeometry(ps, 0.15, ps), MAT.grass);
  parkMesh.position.set(px, 0.075, pz);
  scene.add(parkMesh);

  // Fountain
  const fBMat = new THREE.MeshLambertMaterial({ color: 0xbbbbcc, flatShading: true });
  const fBase = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.3, 0.4, 16), fBMat);
  fBase.position.set(px, 0.2, pz);
  scene.add(fBase);
  const fWater = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 0.1, 16), MAT.water);
  fWater.position.set(px, 0.45, pz);
  scene.add(fWater);
  const fSpout = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.2, 6), fBMat);
  fSpout.position.set(px, 0.8, pz);
  scene.add(fSpout);

  // Path
  const pathMat = new THREE.MeshLambertMaterial({ color: 0xd4c4a8, flatShading: true });
  const path = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, ps), pathMat);
  path.position.set(px, 0.14, pz);
  scene.add(path);

  // Trees
  for (let t = 0; t < 4; t++) {
    const angle = (t / 4) * Math.PI * 2;
    const tx = px + Math.cos(angle) * (ps * 0.35);
    const tz = pz + Math.sin(angle) * (ps * 0.35);
    addTree(tx, tz, 0.9, false);
  }

  // Fencing
  addFenceSegment(px, pz - ps/2, ps, false);
  addFenceSegment(px, pz + ps/2, ps, false);
  addFenceSegment(px - ps/2, pz, ps, true);
  addFenceSegment(px + ps/2, pz, ps, true);

  addBench(px - 3, pz - 1, 0);
  addBench(px + 3, pz + 1, Math.PI);
}

// ─────────────────────────────────────────────────────────────
//  RAMPS
// ─────────────────────────────────────────────────────────────
function buildRamps() {
  const rampDefs = [
    { x:  12, z: -22, ry: 0,           len: 6,  h: 1.4, big: false },
    { x: -12, z:  22, ry: Math.PI,     len: 6,  h: 1.4, big: false },
    { x:  22, z:  12, ry:-Math.PI/2,   len: 6,  h: 1.4, big: false },
    { x: -22, z: -12, ry: Math.PI/2,   len: 6,  h: 1.4, big: false },
    { x:  36, z:  -6, ry: 0,           len: 6,  h: 1.4, big: false },
    { x: -36, z:   6, ry: Math.PI,     len: 6,  h: 1.4, big: false },
    { x:   6, z:  36, ry:-Math.PI/2,   len: 6,  h: 1.4, big: false },
    { x:  -6, z: -36, ry: Math.PI/2,   len: 6,  h: 1.4, big: false },
    // Large stunt ramps
    { x:  56, z:  22, ry: Math.PI/2,   len: 9,  h: 2.8, big: true  },
    { x: -56, z: -22, ry:-Math.PI/2,   len: 9,  h: 2.8, big: true  },
    { x:  22, z:  56, ry: 0,           len: 9,  h: 2.8, big: true  },
    { x: -22, z: -56, ry: Math.PI,     len: 9,  h: 2.8, big: true  },
    { x:   0, z: -66, ry: 0,           len: 10, h: 3.2, big: true  },
    { x:   0, z:  66, ry: Math.PI,     len: 10, h: 3.2, big: true  },
  ];

  const rampMat  = new THREE.MeshLambertMaterial({ color: 0x778899, flatShading: true });
  const stripMat = new THREE.MeshLambertMaterial({ color: 0xffcc00, flatShading: true });
  const sideMat  = new THREE.MeshLambertMaterial({ color: 0x556677, flatShading: true });

  for (const def of rampDefs) {
    const { x, z, ry, len, h, big } = def;
    const w = big ? 7 : 4.5;
    const rampAngle = Math.atan2(h, len);
    const surfLen   = Math.sqrt(len * len + h * h);

    const group = new THREE.Group();
    scene.add(group);
    group.position.set(x, 0, z);
    group.rotation.y = ry;

    // ── Ramp surface slab (angled)
    const surf = new THREE.Mesh(new THREE.BoxGeometry(w, 0.25, surfLen), rampMat);
    surf.position.set(0, h / 2, len / 2);
    surf.rotation.x = -rampAngle;
    surf.castShadow = true;
    surf.receiveShadow = true;
    group.add(surf);

    // ── Solid wedge fill
    const steps = 6;
    for (let si = 0; si < steps; si++) {
      const t0 = si / steps, t1 = (si + 1) / steps;
      const zc  = (t0 + t1) / 2 * len;
      const hc  = (t0 + t1) / 2 * h;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(w, hc, len / steps), sideMat);
      seg.position.set(0, hc / 2, zc);
      group.add(seg);
    }

    // ── Back wall at the top
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.25), sideMat);
    backWall.position.set(0, h / 2, len);
    group.add(backWall);

    // ── Side walls
    for (const sx of [-w/2, w/2]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.25, h * 0.6, len), sideMat);
      side.position.set(sx, h * 0.3, len / 2);
      group.add(side);
    }

    // ── Stripes on big ramps
    if (big) {
      for (let si = 0; si < 3; si++) {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(w - 0.2, 0.06, 0.4), stripMat);
        const frac   = 0.25 + si * 0.25;
        stripe.position.set(0, frac * h + 0.14, frac * len);
        stripe.rotation.x = -rampAngle;
        group.add(stripe);
      }
    }

    // ── Register ramp data for physics
    const cosRY = Math.cos(ry), sinRY = Math.sin(ry);
    ramps.push({
      wx: x, wz: z,
      fwdX: sinRY, fwdZ: cosRY,
      rightX: cosRY, rightZ: -sinRY,
      w, len, h,
      rampAngle,
      big,
    });
  }
}

function getRampHeight(ramp, px, pz) {
  const dx = px - ramp.wx;
  const dz = pz - ramp.wz;
  const localZ = dx * ramp.fwdX   + dz * ramp.fwdZ;
  const localX = dx * ramp.rightX + dz * ramp.rightZ;

  if (localZ < -0.5 || localZ > ramp.len + 0.5) return null;
  if (Math.abs(localX) > ramp.w / 2 + 0.4) return null;

  const t = clamp(localZ / ramp.len, 0, 1);
  return t * ramp.h;
}

// ─────────────────────────────────────────────────────────────
//  DESTRUCTIBLE OBJECTS
// ─────────────────────────────────────────────────────────────
function buildDestructibles() {
  // Barrels  (explode)
  const barrelSpots = [
    [ 10, -25], [-10, -25], [ 10,  25], [-10,  25],
    [ 25,  10], [ 25, -10], [-25,  10], [-25, -10],
    [ 36,  36], [-36,  36], [ 36, -36], [-36, -36],
    [  0,  36], [  0, -36], [ 36,   0], [-36,   0],
    [ 50,  25], [-50,  25], [ 50, -25], [-50, -25],
    [ 20,  50], [-20,  50], [ 20, -50], [-20, -50],
  ];
  barrelSpots.forEach(([x, z]) => {
    if (!isOnRoad(x, z, 2, 2)) spawnBarrel(x, z);
  });

  // Traffic cones  (topple)
  const coneSpots = [
    [  8, -18], [ -8, -18], [  8,  18], [ -8,  18],
    [ 18,   8], [ 18,  -8], [-18,   8], [-18,  -8],
    [ 32,  12], [-32,  12], [ 32, -12], [-32, -12],
    [  4,  38], [ -4,  38], [  4, -38], [ -4, -38],
    [ 42,  22], [-42,  22], [ 42, -22], [-42, -22],
  ];
  coneSpots.forEach(([x, z]) => {
    if (!isOnRoad(x, z, 1.5, 1.5)) spawnCone(x, z);
  });

  // Wooden crates  (shatter)
  const crateSpots = [
    [ 20,  26], [-20,  26], [ 20, -26], [-20, -26],
    [ 26,  20], [-26,  20], [ 26, -20], [-26, -20],
    [ 38,  38], [-38,  38], [ 38, -38], [-38, -38],
    [ 48,  12], [-48,  12], [ 48, -12], [-48, -12],
  ];
  crateSpots.forEach(([x, z]) => {
    if (!isOnRoad(x, z, 2, 2)) spawnCrate(x, z);
  });

  // Destructible small trees scattered around
  const dTreeSpots = [
    [ 22,  22], [-22,  22], [ 22, -22], [-22, -22],
    [ 38,  18], [-38,  18], [ 38, -18], [-38, -18],
    [ 52,  36], [-52,  36], [ 52, -36], [-52, -36],
  ];
  dTreeSpots.forEach(([x, z]) => {
    if (!isOnRoad(x, z, 2, 2)) addTree(x, z, rng(0.6, 1.0), true);
  });
}

function spawnBarrel(x, z) {
  const group = new THREE.Group();
  scene.add(group);
  group.position.set(x, 0, z);

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.0, 10), MAT.barrel);
  body.position.y = 0.5;
  body.castShadow = true;
  group.add(body);

  const ringMat = new THREE.MeshLambertMaterial({ color: 0x222222, flatShading: true });
  for (const ry of [0.25, 0.75]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.04, 6, 12), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = ry;
    group.add(ring);
  }

  const col = { minX: x - 0.5, maxX: x + 0.5, minZ: z - 0.5, maxZ: z + 0.5 };
  destructibles.push({ group, collider: col, type: 'barrel', alive: true });
}

function spawnCone(x, z) {
  const group = new THREE.Group();
  scene.add(group);
  group.position.set(x, 0, z);

  const body = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.9, 8), MAT.cone);
  body.position.y = 0.45;
  body.castShadow = true;
  group.add(body);

  const baseMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.08, 8), baseMat);
  base.position.y = 0.04;
  group.add(base);

  const col = { minX: x - 0.4, maxX: x + 0.4, minZ: z - 0.4, maxZ: z + 0.4 };
  destructibles.push({ group, collider: col, type: 'cone', alive: true });
}

function spawnCrate(x, z) {
  const group = new THREE.Group();
  scene.add(group);
  group.position.set(x, 0, z);

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), MAT.crate);
  body.position.y = 0.45;
  body.castShadow = true;
  group.add(body);

  const lineMat = new THREE.MeshLambertMaterial({ color: 0x885522, flatShading: true });
  for (const axis of ['x', 'z']) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(axis === 'x' ? 0.92 : 0.04, 0.04, axis === 'z' ? 0.92 : 0.04), lineMat);
    line.position.y = 0.9;
    group.add(line);
  }

  const col = { minX: x - 0.5, maxX: x + 0.5, minZ: z - 0.5, maxZ: z + 0.5 };
  destructibles.push({ group, collider: col, type: 'crate', alive: true });
}

// ─────────────────────────────────────────────────────────────
//  DESTRUCTION EFFECTS
// ─────────────────────────────────────────────────────────────
const flying = [];     // pieces launched/toppled by the car
const fx     = [];     // timed effects  { t, update(t, dt) -> done }
let   camShake = 0;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function approach(v, target, delta) { return v < target ? Math.min(target, v + delta) : Math.max(target, v - delta); }
function addFx(update) { fx.push({ t: 0, update }); }

function removeGroup(g) {
  scene.remove(g);
  g.traverse(child => { if (child.geometry) child.geometry.dispose(); });
}

function spawnBin(x, z) {
  const group = new THREE.Group();
  scene.add(group);
  group.position.set(x, 0, z);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.26, 0.8, 8), new THREE.MeshLambertMaterial({ color: 0x4a7a5a, flatShading: true }));
  body.position.y = 0.4;
  body.castShadow = true;
  group.add(body);
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.08, 8), new THREE.MeshLambertMaterial({ color: 0x335544, flatShading: true }));
  lid.position.y = 0.84;
  group.add(lid);
  destructibles.push({ group, collider: { minX: x - 0.4, maxX: x + 0.4, minZ: z - 0.4, maxZ: z + 0.4 }, type: 'bin', alive: true });
}

function spawnHydrant(x, z) {
  const group = new THREE.Group();
  scene.add(group);
  group.position.set(x, 0, z);
  const mat = new THREE.MeshLambertMaterial({ color: 0xcc2222, flatShading: true });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 0.7, 8), mat);
  body.position.y = 0.35;
  body.castShadow = true;
  group.add(body);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), mat);
  cap.position.y = 0.72;
  group.add(cap);
  const nub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.6, 6), mat);
  nub.rotation.z = Math.PI / 2;
  nub.position.y = 0.45;
  group.add(nub);
  destructibles.push({ group, collider: { minX: x - 0.35, maxX: x + 0.35, minZ: z - 0.35, maxZ: z + 0.35 }, type: 'hydrant', alive: true });
}

function launchGroup(group, dx, dz, power, up, spin, life) {
  flying.push({
    kind: 'fly', group, t: 0, life,
    floor: group.position.y,
    vel:  new THREE.Vector3(dx * power + rng(-1, 1), up + rng(0, 2), dz * power + rng(-1, 1)),
    spin: new THREE.Vector3(rng(-1, 1) * spin, rng(-1, 1) * spin, rng(-1, 1) * spin),
  });
}

function toppleGroup(group, dx, dz) {
  flying.push({ kind: 'topple', group, t: 0, life: 5, dx, dz, floor: 0 });
}

function destroyObject(d, dx = 0, dz = 1, impact = 10) {
  if (!d.alive) return;
  d.alive = false;
  const wx = (d.collider.minX + d.collider.maxX) / 2;
  const wz = (d.collider.minZ + d.collider.maxZ) / 2;

  const airBonus = carState.onGround ? 1 : 2;
  addScore((SCORE_TABLE[d.type] || 50) * airBonus, wx, wz);

  switch (d.type) {
    case 'barrel':
      explodeBarrel(d, wx, wz);
      break;
    case 'cone':
      launchGroup(d.group, dx, dz, 4 + impact * 0.5, 3 + impact * 0.1, 8, 6);
      break;
    case 'bin':
      launchGroup(d.group, dx, dz, 3 + impact * 0.45, 3, 6, 6);
      spawnDebris(wx, wz, 0x667766, 5, dx, dz);
      break;
    case 'crate':
      spawnCrateShatter(wx, wz, dx, dz);
      removeGroup(d.group);
      break;
    case 'hydrant':
      launchGroup(d.group, dx, dz, 2 + impact * 0.3, 4, 5, 3);
      spawnSprayJet(wx, wz);
      break;
    case 'tree':
      spawnDebris(wx, wz, 0x3c9e2e, 10, dx, dz);
      toppleGroup(d.group, dx, dz);
      break;
    default:
      removeGroup(d.group);
  }
}

function explodeBarrel(d, x, z) {
  removeGroup(d.group);
  spawnExplosion(x, z);
  scorchMark(x, z);
  shockwave(x, z);

  const dist = car ? Math.hypot(car.position.x - x, car.position.z - z) : 99;
  camShake = Math.max(camShake, 0.7 * Math.max(0, 1 - dist / 35));

  for (const o of destructibles) {
    if (!o.alive || o === d) continue;
    const ox = (o.collider.minX + o.collider.maxX) / 2;
    const oz = (o.collider.minZ + o.collider.maxZ) / 2;
    const od = Math.hypot(ox - x, oz - z);
    if (od > 6) continue;
    const nx = od > 0.01 ? (ox - x) / od : 1;
    const nz = od > 0.01 ? (oz - z) / od : 0;
    if (o.type === 'barrel') {
      o.alive = false;
      const delay = 0.12 + od * 0.05;
      addFx(t => { if (t < delay) return false; explodeBarrel(o, ox, oz); return true; });
    } else if (o.type !== 'tree' || od < 3.5) {
      destroyObject(o, nx, nz, 14);
    }
  }
}

function shockwave(x, z) {
  const mat  = new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.0, 24), mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.16, z);
  scene.add(ring);
  addFx(t => {
    const s = 1 + t * 14;
    ring.scale.set(s, s, 1);
    mat.opacity = Math.max(0, 0.7 - t * 2.2);
    if (t > 0.35) { scene.remove(ring); ring.geometry.dispose(); mat.dispose(); return true; }
    return false;
  });
}

function scorchMark(x, z) {
  const mat  = new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.5, depthWrite: false });
  const mark = new THREE.Mesh(new THREE.CircleGeometry(1.6, 14), mat);
  mark.rotation.x = -Math.PI / 2;
  mark.position.set(x, 0.14, z);
  scene.add(mark);
  addFx(t => {
    if (t > 6) mat.opacity = Math.max(0, 0.5 * (1 - (t - 6) / 2));
    if (t > 8) { scene.remove(mark); mark.geometry.dispose(); mat.dispose(); return true; }
    return false;
  });
}

function spawnExplosion(x, z) {
  const flashMat = new THREE.MeshBasicMaterial({ color: 0xffbb44, transparent: true, opacity: 0.95 });
  const flash = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 8), flashMat);
  flash.position.set(x, 1.2, z);
  scene.add(flash);
  addFx(t => {
    flash.scale.setScalar(1 + t * 5);
    flashMat.opacity = Math.max(0, 0.95 - t * 3.2);
    if (t > 0.3) { scene.remove(flash); flash.geometry.dispose(); flashMat.dispose(); return true; }
    return false;
  });

  const colors = [0xff6600, 0xff4400, 0xffcc00, 0xff8800, 0xffee55];
  const sm = [], sv = [];
  for (let i = 0; i < 30; i++) {
    const m = new THREE.Mesh(new THREE.TetrahedronGeometry(rng(0.08, 0.26), 0), new THREE.MeshLambertMaterial({ color: pick(colors), flatShading: true }));
    m.position.set(x + rng(-0.3, 0.3), rng(0.5, 1.5), z + rng(-0.3, 0.3));
    scene.add(m);
    sm.push(m);
    const a = rng(0, Math.PI * 2);
    sv.push(new THREE.Vector3(Math.cos(a) * rng(2, 6), rng(3, 8), Math.sin(a) * rng(2, 6)));
  }
  particles.push({ meshes: sm, vels: sv, life: 0, maxLife: 1.3, gravity: true, shrink: true, drag: 1.2 });

  const fm = [], fv = [];
  for (let i = 0; i < 9; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: pick([0xff5500, 0xff8800, 0xffbb33]), transparent: true, opacity: 0.9 });
    const m = new THREE.Mesh(new THREE.SphereGeometry(rng(0.5, 0.9), 7, 6), mat);
    m.position.set(x + rng(-0.4, 0.4), rng(0.6, 1.4), z + rng(-0.4, 0.4));
    scene.add(m);
    fm.push(m);
    fv.push(new THREE.Vector3(rng(-2.5, 2.5), rng(0.5, 3), rng(-2.5, 2.5)));
  }
  particles.push({ meshes: fm, vels: fv, life: 0, maxLife: 0.7, gravity: false, grow: 2.2, op0: 0.9, drag: 3 });

  const km = [], kv = [];
  for (let i = 0; i < 9; i++) {
    const mat = new THREE.MeshLambertMaterial({ color: 0x555555, transparent: true, opacity: 0.6, flatShading: true });
    const m = new THREE.Mesh(new THREE.SphereGeometry(rng(0.4, 0.8), 6, 5), mat);
    m.position.set(x + rng(-0.6, 0.6), rng(0.6, 1.8), z + rng(-0.6, 0.6));
    scene.add(m);
    km.push(m);
    kv.push(new THREE.Vector3(rng(-1, 1), rng(1.5, 3), rng(-1, 1)));
  }
  particles.push({ meshes: km, vels: kv, life: 0, maxLife: 2.2, gravity: false, grow: 0.9, op0: 0.6, drag: 0.8 });
}

function spawnCrateShatter(x, z, dx = 0, dz = 0) {
  const meshes = [], vels = [];
  for (let i = 0; i < 14; i++) {
    const s = rng(0.1, 0.35);
    const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), new THREE.MeshLambertMaterial({ color: pick([0xbb8833, 0x996622, 0xcc9944]), flatShading: true }));
    m.position.set(x + rng(-0.4, 0.4), rng(0.2, 0.8), z + rng(-0.4, 0.4));
    scene.add(m);
    meshes.push(m);
    const a = rng(0, Math.PI * 2);
    vels.push(new THREE.Vector3(Math.cos(a) * rng(1.5, 4) + dx * rng(2, 5), rng(2, 5), Math.sin(a) * rng(1.5, 4) + dz * rng(2, 5)));
  }
  particles.push({ meshes, vels, life: 0, maxLife: 1.5, gravity: true, shrink: true, drag: 1.5 });
}

function spawnDebris(x, z, color, count, dx = 0, dz = 0) {
  const meshes = [], vels = [];
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(new THREE.TetrahedronGeometry(rng(0.1, 0.3), 0), new THREE.MeshLambertMaterial({ color, flatShading: true }));
    m.position.set(x + rng(-0.3, 0.3), rng(0.5, 1.5), z + rng(-0.3, 0.3));
    scene.add(m);
    meshes.push(m);
    const a = rng(0, Math.PI * 2);
    vels.push(new THREE.Vector3(Math.cos(a) * rng(1, 3) + dx * 2, rng(2, 5), Math.sin(a) * rng(1, 3) + dz * 2));
  }
  particles.push({ meshes, vels, life: 0, maxLife: 1.1, gravity: true, shrink: true, drag: 1.5 });
}

function sprayBurst(x, z, count) {
  const meshes = [], vels = [];
  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshLambertMaterial({ color: 0x99ddff, transparent: true, opacity: 0.8, flatShading: true });
    const m = new THREE.Mesh(new THREE.SphereGeometry(rng(0.07, 0.14), 5, 4), mat);
    m.position.set(x, 0.8, z);
    scene.add(m);
    meshes.push(m);
    const a = rng(0, Math.PI * 2);
    vels.push(new THREE.Vector3(Math.cos(a) * rng(0.3, 1.6), rng(5, 9), Math.sin(a) * rng(0.3, 1.6)));
  }
  particles.push({ meshes, vels, life: 0, maxLife: 1.2, gravity: true, op0: 0.8, drag: 0.5 });
}

function spawnSprayJet(x, z) {
  let acc = 0;
  addFx((t, dt) => {
    acc += dt;
    while (acc > 0.08) { acc -= 0.08; sprayBurst(x, z, 5); }
    return t > 2.5;
  });
}

// ─────────────────────────────────────────────────────────────
//  PARTICLE / EFFECT UPDATE
// ─────────────────────────────────────────────────────────────
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    const t = Math.min(1, p.life / p.maxLife);
    const dr = Math.exp(-(p.drag ?? 2) * dt);

    for (let j = 0; j < p.meshes.length; j++) {
      const m = p.meshes[j];
      const v = p.vels[j];
      if (p.gravity) v.y -= 12 * dt;
      m.position.addScaledVector(v, dt);
      m.rotation.x += v.x * dt * 2;
      m.rotation.z += v.z * dt * 2;
      v.x *= dr; v.z *= dr;
      if (!p.gravity) v.y *= dr;
      if (p.gravity && m.position.y < 0.08) {
        m.position.y = 0.08;
        v.y = Math.abs(v.y) > 1 ? -v.y * 0.3 : 0;
        v.x *= 0.6; v.z *= 0.6;
      }
      if (p.grow) m.scale.multiplyScalar(1 + p.grow * dt);
      if (p.shrink) m.scale.setScalar(Math.max(0.01, 1 - t * t * t));
      if (m.material.transparent) m.material.opacity = (p.op0 ?? 1) * (1 - t);
    }

    if (p.life >= p.maxLife) {
      p.meshes.forEach(m => {
        scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
      });
      particles.splice(i, 1);
    }
  }

  for (let i = flying.length - 1; i >= 0; i--) {
    const f = flying[i];
    const g = f.group;
    f.t += dt;

    if (f.kind === 'topple') {
      const a = Math.min(1, f.t / 0.8);
      const ang = 1.5 * a * a;
      g.rotation.x =  f.dz * ang;
      g.rotation.z = -f.dx * ang;
    } else {
      f.vel.y -= 14 * dt;
      g.position.addScaledVector(f.vel, dt);
      g.rotation.x += f.spin.x * dt;
      g.rotation.y += f.spin.y * dt;
      g.rotation.z += f.spin.z * dt;
      if (g.position.y < f.floor) {
        g.position.y = f.floor;
        f.vel.y = Math.abs(f.vel.y) > 1.5 ? -f.vel.y * 0.35 : 0;
        const fr = Math.exp(-4 * dt);
        f.vel.x *= fr; f.vel.z *= fr;
        f.spin.multiplyScalar(fr);
      }
    }

    if (f.t > f.life) {
      const s = 1 - (f.t - f.life) / 0.5;
      if (s <= 0) { removeGroup(g); flying.splice(i, 1); }
      else g.scale.setScalar(s);
    }
  }

  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    f.t += dt;
    if (f.update(f.t, dt)) fx.splice(i, 1);
  }
}

// ─────────────────────────────────────────────────────────────
//  IMPROVED CAR PHYSICS
// ─────────────────────────────────────────────────────────────
const IMPACT_DRAG = { barrel: 0.96, cone: 0.99, crate: 0.96, tree: 0.9, bin: 0.98, hydrant: 0.95 };

function updateCar(dt) {
  if (gamePaused || !gameRunning) return;

  const pos    = carState.position;
  const sH     = Math.sin(carState.heading);
  const cH     = Math.cos(carState.heading);
  const spdAbs = Math.abs(carState.speed);

  // ════════════════════════════════════════════════════════
  //  AIRBORNE BRANCH
  // ════════════════════════════════════════════════════════
  if (!carState.onGround) {
    const GRAVITY = 20;
    carState.velY    -= GRAVITY * dt;
    pos.y            += carState.velY * dt;
    carState.airTime += dt;

    // ── Air tricks: W/S = flip, A/D = roll
    const FLIP_RATE = 4.5;   // rad/s
    const ROLL_RATE = 4.0;

    const flipInput = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
    const rollInput = (keys.left   ? 1 : 0) - (keys.right ? 1 : 0);

    carState.airPitchVel += (flipInput * FLIP_RATE - carState.airPitchVel) * (1 - Math.exp(-8 * dt));
    carState.airRollVel  += (rollInput * ROLL_RATE - carState.airRollVel)  * (1 - Math.exp(-8 * dt));

    carState.airPitch += carState.airPitchVel * dt;
    carState.airRoll  += carState.airRollVel  * dt;

    // Minimal horizontal steering in air
    const airSteerIn = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
    carState.steerInput = approach(carState.steerInput, airSteerIn, 3 * dt);
    carState.heading   += airSteerIn * 0.6 * dt;

    pos.x += sH * carState.speed * dt;
    pos.z += cH * carState.speed * dt;
    pos.x += carState.driftVelX * dt;
    pos.z += carState.driftVelZ * dt;
    carState.driftVelX *= Math.exp(-1.5 * dt);
    carState.driftVelZ *= Math.exp(-1.5 * dt);

    const airEl = document.getElementById('air-display');
    if (airEl) {
      airEl.classList.remove('hidden');
      let trickTxt = '';
      if (Math.abs(carState.airPitch) > 0.5) trickTxt = carState.airPitch > 0 ? ' 🔄FLIP' : ' 🔄BACKFLIP';
      if (Math.abs(carState.airRoll)  > 0.5) trickTxt = ' 🌀ROLL';
      airEl.textContent = '🚀 AIRTIME ' + carState.airTime.toFixed(1) + 's' + trickTxt;
    }

    const GROUND_Y = 0.45;
    if (pos.y <= GROUND_Y) {
      pos.y = GROUND_Y;
      const landSpd = Math.abs(carState.velY);
      carState.velY     = 0;
      carState.onGround = true;

      if (landSpd > 6) camShake = Math.max(camShake, Math.min(1.0, landSpd / 22));

      if (carState.airTime > 0.4) {
        const flipMult = Math.min(4, 1 + Math.abs(carState.airPitch) / (Math.PI * 2));
        const rollMult = Math.min(4, 1 + Math.abs(carState.airRoll)  / (Math.PI * 2));
        const airPts   = Math.round(carState.airTime * 80 * flipMult * rollMult);
        addScore(airPts, pos.x, pos.z);
      }
      carState.airTime    = 0;

      // Landing — smoothly fade tricks
      carState.airPitch    *= 0.1;  
      carState.airRoll     *= 0.1;
      carState.airPitchVel = 0;
      carState.airRollVel  = 0;

      document.getElementById('air-display')?.classList.add('hidden');
    }

    _applyCarTransform(dt);
    return;
  }

  // ════════════════════════════════════════════════════════
  //  GROUND BRANCH
  // ════════════════════════════════════════════════════════

  // Smooth fade for remaining trick rotations after landing
  carState.airPitch    += (0 - carState.airPitch)    * Math.min(1, 12 * dt);
  carState.airRoll     += (0 - carState.airRoll)     * Math.min(1, 12 * dt);
  carState.airPitchVel  = 0;
  carState.airRollVel   = 0;

  // ── Pedal input
  const pedalTarget = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  carState.pedal = approach(carState.pedal, pedalTarget, (pedalTarget === 0 ? 8 : 5) * dt);
  const pedal = carState.pedal;
  const prevSpeed = carState.speed;

  let spd = carState.speed;

  if (pedal > 0.02) {
    if (spd < -0.3) {
      spd = Math.min(0, spd + CAR_BRAKE_FORCE * pedal * dt);
    } else {
      const taper = Math.max(0.1, 1 - Math.pow(Math.abs(spd) / CAR_MAX_SPEED, 1.5));
      spd += CAR_ACCEL * pedal * taper * dt;
    }
  } else if (pedal < -0.02) {
    if (spd > 0.3) {
      spd = Math.max(0, spd + CAR_BRAKE_FORCE * pedal * dt);
    } else {
      const taper = Math.max(0.15, 1 - Math.abs(spd) / (CAR_MAX_SPEED * 0.4));
      spd += CAR_REVERSE_ACC * pedal * taper * dt;
    }
  } else {
    const fr = CAR_ROLL_FRIC * dt;
    spd = Math.abs(spd) <= fr ? 0 : spd - Math.sign(spd) * fr;
  }

  spd -= CAR_AERO * spd * Math.abs(spd) * dt;

  // ── Handbrake / drift
  const speedNorm = Math.min(1, Math.abs(spd) / CAR_MAX_SPEED);
  const drifting  = keys.brake && Math.abs(spd) > DRIFT_ENTRY_SPD;

  if (keys.brake) {
    if (drifting) {
      const latDir = cH * (Math.sign(carState.steerInput) || 1);
      const driftKick = Math.abs(spd) * 0.35;
      carState.driftVelX += -cH * driftKick * Math.sign(carState.steerInput + 0.01) * dt * 6;
      carState.driftVelZ +=  sH * driftKick * Math.sign(carState.steerInput + 0.01) * dt * 6;
      spd *= Math.exp(-1.6 * dt);
    } else {
      spd *= Math.exp(-2.8 * dt);
    }
    if (Math.abs(spd) < 0.08) spd = 0;
  }

  carState.driftVelX *= Math.exp(-DRIFT_SLIDE_FRIC * dt);
  carState.driftVelZ *= Math.exp(-DRIFT_SLIDE_FRIC * dt);

  carState.speed = clamp(spd, -CAR_MAX_SPEED * 0.4, CAR_MAX_SPEED);

  // ── Steering
  const steerIn   = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
  const reversing = steerIn !== 0 && carState.steerInput !== 0 && Math.sign(steerIn) !== Math.sign(carState.steerInput);
  const steerRate = steerIn === 0 ? 8 : (reversing ? 11 : 5);
  carState.steerInput = approach(carState.steerInput, steerIn, steerRate * dt);

  const steerWiden  = drifting ? 1.25 : 1.0;
  carState.steerAngle = carState.steerInput * CAR_STEER_MAX * steerWiden * (1 - 0.55 * speedNorm);

  let targetYaw = 0;
  if (Math.abs(carState.speed) > 0.05) {
    targetYaw = carState.speed * Math.tan(carState.steerAngle) / WHEEL_BASE;
    const yawBoost = drifting ? DRIFT_YAW_BOOST : 1.0;
    const maxYaw   = (CAR_LAT_ACC / Math.max(Math.abs(carState.speed), 4)) * (drifting ? 2.0 : 1.0);
    targetYaw = clamp(targetYaw * yawBoost, -maxYaw, maxYaw);
  }
  carState.angularVel += (targetYaw - carState.angularVel) * (1 - Math.exp(-10 * dt));
  carState.heading    += carState.angularVel * dt;

  // ── Body lean + pitch
  const leanT  = clamp(carState.angularVel * carState.speed * 0.003, -0.08, 0.08);
  carState.lean += (leanT - carState.lean) * (1 - Math.exp(-7 * dt));
  const accel   = (carState.speed - prevSpeed) / Math.max(dt, 0.001);
  const pitchT  = clamp(-accel * 0.003, -0.045, 0.045);
  carState.pitch += (pitchT - carState.pitch) * (1 - Math.exp(-7 * dt));

  // ── Movement Projections
  const fwdX = sH * carState.speed;
  const fwdZ = cH * carState.speed;
  let nx = pos.x + (fwdX + carState.driftVelX) * dt;
  let nz = pos.z + (fwdZ + carState.driftVelZ) * dt;

  // ── Destructible collisions
  if (spdAbs > 0.5) {
    const moveSign = carState.speed >= 0 ? 1 : -1;
    for (const d of destructibles) {
      if (!d.alive) continue;
      const col = d.collider;
      const r   = (col.maxX - col.minX) / 2;
      const rx  = (col.minX + col.maxX) / 2 - nx;
      const rz  = (col.minZ + col.maxZ) / 2 - nz;
      const fwd = rx * sH + rz * cH;
      const lat = rx * cH - rz * sH;
      if (Math.abs(fwd) < 2.0 + r && Math.abs(lat) < 0.95 + r) {
        destroyObject(d, sH * moveSign, cH * moveSign, spdAbs);
        carState.speed *= (IMPACT_DRAG[d.type] || 0.97);
      }
    }
  }

  // ── Static collisions — Tighter hitbox removes invisible walls feeling
  const CAR_HL = 1.6;  
  const CAR_HW = 0.7;  
  const hx = CAR_HL * Math.abs(sH) + CAR_HW * Math.abs(cH);
  const hz = CAR_HL * Math.abs(cH) + CAR_HW * Math.abs(sH);
  const hit = (px, pz) => {
    for (const c of colliders) {
      if (px - hx < c.maxX && px + hx > c.minX && pz - hz < c.maxZ && pz + hz > c.minZ) return c;
    }
    return null;
  };

  // Push out if already embedded
  const emb = hit(pos.x, pos.z);
  if (emb) {
    const overX = Math.min(pos.x + hx - emb.minX, emb.maxX - (pos.x - hx));
    const overZ = Math.min(pos.z + hz - emb.minZ, emb.maxZ - (pos.z - hz));
    const push  = 5 * dt + 0.015;
    if (overX < overZ) pos.x += (pos.x < (emb.minX + emb.maxX) / 2 ? -1 : 1) * Math.min(overX, push);
    else               pos.z += (pos.z < (emb.minZ + emb.maxZ) / 2 ? -1 : 1) * Math.min(overZ, push);
  }

  // ── Ramp height-field Logic Check
  const GROUND_Y = 0.45;
  let rampY = GROUND_Y;
  let onRamp = false;
  let activeRamp = null;

  for (const ramp of ramps) {
    const ry = getRampHeight(ramp, nx, nz);
    if (ry === null) continue;
    const targetY = GROUND_Y + ry;
    if (targetY > rampY) {
      rampY      = targetY;
      onRamp     = true;
      activeRamp = ramp;
    }
  }

  // ── Static collisions (Processed ONLY if NOT on a Ramp)
  if (!onRamp) {
    let blockX = hit(nx, pos.z);
    if (!blockX) pos.x = nx;

    let blockZ = hit(pos.x, nz);
    if (!blockZ) pos.z = nz;

    if (blockX || blockZ) {
      if (blockX && blockZ) {
        carState.speed *= -0.15;
      } else {
        const vx = blockX ? 0 : fwdX;
        const vz = blockZ ? 0 : fwdZ;
        carState.speed = (vx * sH + vz * cH) * 0.95;
      }
      if (spdAbs > 6) camShake = Math.max(camShake, Math.min(0.45, spdAbs / 44));
      carState.angularVel *= 0.5;
      carState.driftVelX *= 0.3;
      carState.driftVelZ *= 0.3;
    }
  } else {
    // Mobil bebas bergerak ke nx, nz ketika sedang di atas ramp
    pos.x = nx;
    pos.z = nz;
  }

  // ── World boundary
  const BOUND = WORLD - 2;
  pos.x = clamp(pos.x, -BOUND, BOUND);
  pos.z = clamp(pos.z, -BOUND, BOUND);

  // ── Smooth Y Lifting untuk Ramp
  if (onRamp) {
    pos.y += (rampY - pos.y) * Math.min(1, 20 * dt);

    if (activeRamp) {
      const dx = pos.x - activeRamp.wx;
      const dz = pos.z - activeRamp.wz;
      const localZ = dx * activeRamp.fwdX + dz * activeRamp.fwdZ;
      const dot    = carState.speed * (sH * activeRamp.fwdX + cH * activeRamp.fwdZ);

      // Launch saat mencapai ujung
      if (localZ > activeRamp.len * 0.7 && dot > 0.3) {
        const launchSpd  = Math.abs(carState.speed);
        carState.velY    = Math.sin(activeRamp.rampAngle) * launchSpd * 1.2;
        carState.speed   = Math.cos(activeRamp.rampAngle) * launchSpd;
        carState.onGround = false;
        carState.airTime  = 0;
      }
    }

    const pitchFromRamp = -activeRamp?.rampAngle || 0;
    carState.pitch += (pitchFromRamp - carState.pitch) * Math.min(1, 10 * dt);
  } else {
    pos.y += (GROUND_Y - pos.y) * Math.min(1, 15 * dt);
  }

  _applyCarTransform(dt);
}

function _applyCarTransform(dt) {
  const pos = carState.position;
  car.position.set(pos.x, pos.y, pos.z);
  car.rotation.y = carState.heading;

  if (carState.onGround) {
    carBody.rotation.x = carState.pitch;
    carBody.rotation.z = carState.lean;
  } else {
    carBody.rotation.x = carState.pitch + carState.airPitch;
    carBody.rotation.z = carState.lean  + carState.airRoll;
  }

  carState.wheelRot += (carState.speed * dt) / 0.35;
  wheels.forEach(({ pivot, mesh, isFront }) => {
    mesh.rotation.x = carState.wheelRot;
    if (isFront) pivot.rotation.y = carState.steerAngle;
  });
}

// ─────────────────────────────────────────────────────────────
//  CAMERA 
// ─────────────────────────────────────────────────────────────
let camBlend = 0;                       // 0 = chase, 1 = hood
const _chasePos = new THREE.Vector3();
const _chaseLook = new THREE.Vector3();
const _hoodPos  = new THREE.Vector3();
const _hoodLook = new THREE.Vector3();
const _lookAt   = new THREE.Vector3();

function updateCamera(dt) {
  if (!car) return;

  const p  = car.position;
  const sH = Math.sin(carState.heading);
  const cH = Math.cos(carState.heading);
  const speedNorm = Math.min(1, Math.abs(carState.speed) / CAR_MAX_SPEED);

  const back = 8.5 + speedNorm * 1.5;
  _chasePos.set(p.x - sH * back, p.y + 4.2 + speedNorm * 0.6, p.z - cH * back);
  _chaseLook.set(p.x + sH * 5, p.y + 1.2, p.z + cH * 5);
  camPos.lerp(_chasePos, 1 - Math.exp(-7 * dt));
  camTarget.lerp(_chaseLook, 1 - Math.exp(-9 * dt));

  _hoodPos.set(p.x + sH * 1.5, p.y + 1.65, p.z + cH * 1.5);
  _hoodLook.set(p.x + sH * 10, p.y + 1.4, p.z + cH * 10);

  const goal = cameraMode === 0 ? 0 : 1;
  camBlend += (goal - camBlend) * (1 - Math.exp(-9 * dt));
  if (Math.abs(goal - camBlend) < 0.002) camBlend = goal;

  camera.position.lerpVectors(camPos, _hoodPos, camBlend);
  _lookAt.lerpVectors(camTarget, _hoodLook, camBlend);

  if (camShake > 0.001) {
    camera.position.x += rng(-1, 1) * camShake * 0.35;
    camera.position.y += rng(-1, 1) * camShake * 0.35;
    camera.position.z += rng(-1, 1) * camShake * 0.35;
    camShake *= Math.exp(-4 * dt);
  } else {
    camShake = 0;
  }
  camera.lookAt(_lookAt);

  const fovT = 60 + speedNorm * 7;
  camera.fov += (fovT - camera.fov) * (1 - Math.exp(-4 * dt));
  camera.updateProjectionMatrix();
}

function cycleCameraMode() {
  cameraMode = (cameraMode + 1) % CAM_MODES.length;
}

// ─────────────────────────────────────────────────────────────
//  SPEEDOMETER HUD
// ─────────────────────────────────────────────────────────────
const speedoCtx = document.getElementById('speedo-canvas').getContext('2d');

function drawSpeedometer(speedKmh) {
  const ctx = speedoCtx;
  const W = 120, H = 120, cx = W / 2, cy = H / 2 + 8, r = 48;
  const minA = Math.PI * 0.75, maxA = Math.PI * 2.25;
  const pct = Math.min(1, Math.abs(speedKmh) / (CAR_MAX_SPEED * 3.6));
  const needleA = minA + pct * (maxA - minA);

  ctx.clearRect(0, 0, W, H);

  ctx.beginPath();
  ctx.arc(cx, cy, r, minA, maxA);
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 8;
  ctx.stroke();

  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  grad.addColorStop(0, '#44cc88');
  grad.addColorStop(0.5, '#ffcc00');
  grad.addColorStop(1, '#ff4444');
  ctx.beginPath();
  ctx.arc(cx, cy, r, minA, needleA);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i <= 8; i++) {
    const a = minA + (i / 8) * (maxA - minA);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6));
    ctx.lineTo(cx + Math.cos(a) * (r - 13), cy + Math.sin(a) * (r - 13));
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(needleA);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(r - 12, 0);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
}

function updateHUD() {
  const kmh = Math.abs(carState.speed) * 3.6;
  document.getElementById('speed-value').textContent = Math.round(kmh);
  document.getElementById('gear-display').textContent = carState.speed >= -0.1 ? 'D' : 'R';
  document.getElementById('cam-display').textContent  = CAM_MODES[cameraMode];
  document.getElementById('score-value').textContent  = score;
  drawSpeedometer(kmh);
}

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────
function resetCarPosition() {
  carState.position.set(0, 0.45, 25);
  carState.heading    = 0;
  carState.speed      = 0;
  carState.steerAngle = 0;
  carState.angularVel = 0;
  carState.lean       = 0;
  carState.pedal      = 0;
  carState.steerInput = 0;
  carState.pitch      = 0;
  carState.velY       = 0;
  carState.onGround   = true;
  carState.airTime    = 0;
  carState.airPitch    = 0;
  carState.airRoll     = 0;
  carState.airPitchVel = 0;
  carState.airRollVel  = 0;
  carState.drifting    = false;
  carState.driftVelX   = 0;
  carState.driftVelZ   = 0;
  if (carBody) carBody.rotation.x = 0;
  if (car) {
    car.position.copy(carState.position);
    car.rotation.y    = 0;
    carBody.rotation.z = 0;
  }
  camPos.set(0, 5, 35);
  camTarget.set(0, 1, 20);
  camBlend = cameraMode === 0 ? 0 : 1;
}

function togglePause() {
  if (!gameRunning) return;
  gamePaused = !gamePaused;
  if (gamePaused) {
    document.getElementById('pause-menu').classList.remove('hidden');
  } else {
    document.getElementById('pause-menu').classList.add('hidden');
    clock.getDelta();
    if (!loopActive) loop();
  }
}

// ─────────────────────────────────────────────────────────────
//  GAME LOOP
// ─────────────────────────────────────────────────────────────
function loop() {
  if (!gameRunning || gamePaused) { loopActive = false; return; }
  loopActive = true;

  requestAnimationFrame(loop);

  const dt = Math.min(clock.getDelta(), 0.05);

  updateCar(dt);
  updateParticles(dt);
  updateCamera(dt);
  updateHUD();

  renderer.render(scene, camera);
}

// ─────────────────────────────────────────────────────────────
//  KICK OFF
// ─────────────────────────────────────────────────────────────
init();