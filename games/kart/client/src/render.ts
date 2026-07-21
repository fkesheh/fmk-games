// ============================================================================
// KART GP — track/kart renderer (frozen export, docs/KART.md "Client modules").
// One WebGLRenderer (ACES, sRGB out, PCFSoft shadows, pixelRatio <= 2). Sky =
// vertex-gradient dome (the ONE MeshBasicMaterial exception, fog:false); FogExp2,
// hemi + sun from the TrackTheme; the sun's 2048 shadow box follows the watched
// kart. Every other surface is flat-shaded MeshLambertMaterial in KPAL colors.
// buildTrack bakes all static deco into ~1 mesh per material; karts stay
// unbaked (front wheels steer, all wheels spin, the body rolls while drifting).
// All scatter is seeded (@platform/shared rng) — Math.random is never touched.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { decoSeed, rng, rngInt, rngRange } from '@platform/shared';
import {
  KPAL,
  MAX_PLAYERS,
  closestOnTrack,
  gridSlot,
  type TrackDef,
  type TrackTheme,
} from '@kart/shared';

// ---- chase camera (frozen feel: behind + above, modest speed effects) --------
const BASE_FOV = 65;
const FOV_PER_KMH = 0.25; // docs/KART.md: FOV = 65 + 0.25 * speedKmH ...
const FOV_BONUS_CAP = 15; // ... "keep modest" — hard cap on the speed bonus
const CAM_DIST = 7; // m behind the kart at standstill
const CAM_DIST_PER_SPEED = 0.08; // + m per m/s of |speed|
const CAM_HEIGHT = 3;
const CAM_EASE = 8; // camera position ease rate /s
const CAM_LOOK_AHEAD = 4; // aim this far ahead of the kart
const CAM_LOOK_HEIGHT = 1.2;
const INTERP_RATE = 12; // kart target ease rate /s (docs: ~12/s)
const STEER_VIS = 0.4; // front-wheel visual lock (rad at steer = 1)
const DRIFT_ROLL = 0.3; // body roll per rad of visual steer while drifting
const WHEEL_R = 0.28;

// ---- shadow rig (one 2048 box; ortho frustum follows the watched kart) -------
const SHADOW_EXTENT = 60;
const SUN_DISTANCE = 80; // sun sits at target - sunDir x 80

// ---- track deco tuning ---------------------------------------------------------
const DOME_RADIUS = 400;
const GROUND_SIZE = 700; // grass slab; covers the hill ring
const CURB_W = 0.6; // curb stripe width (m)
const CURB_PERIOD = 2; // segments per red/white alternation (~4m)
const DASH_W = 0.18; // center-line dash strip width
const DASH_PERIOD = 2; // one segment on, one off (~2m dashes)
const BARRIER_OFF = 1.2; // posts sit at roadHalfW + this (docs/KART.md)
const BARRIER_EVERY = 2; // segments between posts (~4m)
const BARRIER_H = 0.55;
const CURB_Y = 0.015; // flat paint heights stack above the road (z-fight guard)
const DASH_Y = 0.02;
const PAINT_Y = 0.03; // start line + grid slot markers
const CHECKER_COLS = 10;
const CHECKER_ROWS = 2;
const TREE_COUNT = 120; // docs/KART.md: ~120 seeded trees
const ROCK_COUNT = 40;
const PROP_CLEARANCE = 4; // never on the road: |lateral| > roadHalfW + this
const PROP_SPACING = 5; // min center distance between props
const SCATTER_X = 150; // scatter bounds cover the circuit + apron
const SCATTER_Z = 140;
const HILL_COUNT = 14; // distant hill ring at r ~ 200
const HILL_R_MIN = 185;
const HILL_R_MAX = 225;

// ---- cached material factory (mirrors the fps client visual vocabulary) --------
const matCache = new Map<string, THREE.MeshLambertMaterial>();

/** Shared, cached flat-shaded Lambert material. hex MUST come from KPAL/KART_COLORS. */
function mat(hex: string): THREE.MeshLambertMaterial {
  let m = matCache.get(hex);
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color: hex,
      flatShading: true, // the flat-shaded look — do not remove
    });
    matCache.set(hex, m);
  }
  return m;
}

/** Curb stripes need per-segment colors: one vertexColors Lambert, lazily shared. */
let curbMat: THREE.MeshLambertMaterial | null = null;
function curbMaterial(): THREE.MeshLambertMaterial {
  if (!curbMat) curbMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  return curbMat;
}

// ---- mesh factories (origin at center, y-up) -----------------------------------
function box(w: number, h: number, d: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(hex));
}
function cyl(rTop: number, rBottom: number, h: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), mat(hex));
}
function cone(r: number, h: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat(hex));
}
function sphere(r: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(4, Math.floor(seg * 0.75))), mat(hex));
}

/** Convenience: position a mesh and return it (chainable builder style). */
function at<T extends THREE.Object3D>(obj: T, x: number, y: number, z: number): T {
  obj.position.set(x, y, z);
  return obj;
}

/**
 * Merge all Mesh descendants of `root` into one mesh per material, preserving
 * world transforms. Used for EVERY static structure (ground, barriers, painted
 * markings, scatter, hills) to keep draw calls flat. Karts must NOT be baked —
 * their wheels/steering animate per frame.
 */
function bake(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true);
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const g = child.geometry.clone().applyMatrix4(child.matrixWorld);
    // strip attributes that differ across primitives so merge succeeds
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    const arr = byMaterial.get(child.material as THREE.Material) ?? [];
    arr.push(g);
    byMaterial.set(child.material as THREE.Material, arr);
  });
  const out = new THREE.Group();
  for (const [material, geoms] of byMaterial) {
    const merged = mergeGeometries(geoms, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  return out;
}

/** Dispose every Mesh geometry under root (shared cached materials excluded). */
function disposeGeometries(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  });
}

// ---- track frames ---------------------------------------------------------------
// Per centerline sample: center + unit "left of travel" (lateral +, matching the
// sign convention of closestOnTrack in @kart/shared).
interface SampleFrame {
  cx: number;
  cz: number;
  lx: number;
  lz: number;
}

function trackFrames(centerline: ReadonlyArray<readonly [number, number]>): SampleFrame[] {
  const n = centerline.length;
  const frames: SampleFrame[] = [];
  for (let i = 0; i < n; i++) {
    const prev = centerline[(i - 1 + n) % n]!;
    const c = centerline[i]!;
    const nxt = centerline[(i + 1) % n]!;
    let tx = nxt[0] - prev[0];
    let tz = nxt[1] - prev[1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    frames.push({ cx: c[0], cz: c[1], lx: -tz, lz: tx });
  }
  return frames;
}

// ---- flat ribbon geometry ---------------------------------------------------------
// Road strip: two shared vertices per sample (left/right edge), indices wound to
// face +y. Normals are set straight up — the road is flat by construction.

function roadGeometry(frames: SampleFrame[], halfW: number): THREE.BufferGeometry {
  const n = frames.length;
  const pos = new Float32Array(n * 6);
  const nrm = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const f = frames[i]!;
    pos[i * 6] = f.cx + f.lx * halfW;
    pos[i * 6 + 1] = 0;
    pos[i * 6 + 2] = f.cz + f.lz * halfW;
    pos[i * 6 + 3] = f.cx - f.lx * halfW;
    pos[i * 6 + 4] = 0;
    pos[i * 6 + 5] = f.cz - f.lz * halfW;
    nrm[i * 6 + 1] = 1;
    nrm[i * 6 + 4] = 1;
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const li = i * 2;
    const ri = i * 2 + 1;
    const lj = j * 2;
    const rj = j * 2 + 1;
    idx.push(li, lj, ri, ri, lj, rj);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * Per-segment ribbon with DUPLICATED vertices (4 per emitted segment) so adjacent
 * segments can carry different vertex colors (curb stripes) or be skipped
 * entirely (center-line dashes). Requires leftOff > rightOff; winding faces +y.
 */
function ribbonGeometry(
  frames: SampleFrame[],
  leftOff: number,
  rightOff: number,
  y: number,
  colorFor: (seg: number) => [number, number, number],
  skip: (seg: number) => boolean,
): THREE.BufferGeometry {
  const n = frames.length;
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (skip(i)) continue;
    const a = frames[i]!;
    const b = frames[(i + 1) % n]!;
    const c = colorFor(i);
    const verts: Array<[number, number, number]> = [
      [a.cx + a.lx * leftOff, y, a.cz + a.lz * leftOff], // Li
      [b.cx + b.lx * leftOff, y, b.cz + b.lz * leftOff], // Lj
      [a.cx + a.lx * rightOff, y, a.cz + a.lz * rightOff], // Ri
      [b.cx + b.lx * rightOff, y, b.cz + b.lz * rightOff], // Rj
    ];
    const base = pos.length / 3;
    for (const v of verts) {
      pos.push(v[0], v[1], v[2]);
      nrm.push(0, 1, 0);
      col.push(c[0], c[1], c[2]);
    }
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

// ---- scatter rejections ------------------------------------------------------------

/** Min center distance to every already-placed prop. */
function tooClose(x: number, z: number, placed: ReadonlyArray<{ x: number; z: number }>): boolean {
  const d2 = PROP_SPACING * PROP_SPACING;
  for (const p of placed) {
    const dx = p.x - x;
    const dz = p.z - z;
    if (dx * dx + dz * dz < d2) return true;
  }
  return false;
}

// ---- seeded prop recipes (KPAL only) -------------------------------------------------

/** tree: trunk cylinder + 2 leaf blobs (leaf / leafLight), organic yaw + scale. */
function buildTree(next: () => number): THREE.Group {
  const g = new THREE.Group();
  const h = rngRange(next, 1.0, 1.6);
  g.add(at(cyl(0.12, 0.18, h, 6, KPAL.treeTrunk), 0, h / 2, 0));
  const r1 = rngRange(next, 0.9, 1.3);
  g.add(at(sphere(r1, 7, KPAL.treeLeaf), 0, h + r1 * 0.55, 0));
  const r2 = r1 * rngRange(next, 0.55, 0.7);
  g.add(at(sphere(r2, 6, KPAL.treeLeafLight), rngRange(next, -0.25, 0.25), h + r1 * 0.55 + r2 * 0.9, rngRange(next, -0.25, 0.25)));
  g.rotation.y = next() * Math.PI * 2;
  g.scale.setScalar(rngRange(next, 0.85, 1.25));
  return g;
}

/** rock: 1-2 overlapping squashed spheres. */
function buildRock(next: () => number): THREE.Group {
  const g = new THREE.Group();
  const n = rngInt(next, 1, 2);
  for (let i = 0; i < n; i++) {
    const r = rngRange(next, 0.4, 0.9);
    const m = at(sphere(r, 7, KPAL.rock), rngRange(next, -0.4, 0.4), r * 0.45, rngRange(next, -0.4, 0.4));
    m.scale.set(rngRange(next, 0.9, 1.4), rngRange(next, 0.4, 0.65), rngRange(next, 0.9, 1.4));
    m.rotation.y = next() * Math.PI;
    g.add(m);
  }
  return g;
}

function smooth01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

// ---- kart visuals ----------------------------------------------------------------------

interface KartVisual {
  root: THREE.Group; // positioned/rotated to the eased pose
  body: THREE.Group; // drift-roll pivot (every non-wheel prim)
  wheels: THREE.Mesh[]; // all four — spin about the axle (local X)
  steerPivots: THREE.Group[]; // front pair — yaw with steer
  snapped: boolean; // first updateKart snaps instead of easing
  tx: number; // latest target transform
  ty: number;
  tz: number;
  tyaw: number;
  cx: number; // eased pose actually rendered
  cy: number;
  cz: number;
  cyaw: number;
  spin: number; // accumulated wheel angle (rad)
  steerVis: number; // eased visual steer angle
  roll: number; // eased drift body roll
}

export class KartScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly sky: THREE.Mesh;

  private sunDir: readonly [number, number, number] = [0.5, -1, 0.35];
  private trackRoot: THREE.Group | null = null;
  private readonly karts = new Map<string, KartVisual>();
  private camReady = false; // first setCamera snaps instead of easing
  private readonly camScratch = new THREE.Vector3(); // reuse — no per-frame alloc
  private readonly lookScratch = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    // guard: no WebGL context => readable failure surface, then propagate
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      KartScene.showContextError();
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.renderer = renderer;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(KPAL.fog, 0.006);
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, DOME_RADIUS * 1.5); // far covers the dome

    // lights are created once and re-tinted per theme — no add/remove churn
    this.hemi = new THREE.HemisphereLight(KPAL.sky, KPAL.grass, 0.6);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(KPAL.curbWhite, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_EXTENT;
    sc.right = SHADOW_EXTENT;
    sc.top = SHADOW_EXTENT;
    sc.bottom = -SHADOW_EXTENT;
    sc.near = 1;
    sc.far = SUN_DISTANCE * 3;
    sc.updateProjectionMatrix();
    this.sun.shadow.normalBias = 0.03; // tame acne on flat-shaded Lambert
    this.sun.position.set(
      -this.sunDir[0] * SUN_DISTANCE,
      -this.sunDir[1] * SUN_DISTANCE,
      -this.sunDir[2] * SUN_DISTANCE,
    );
    this.scene.add(this.sun);
    this.scene.add(this.sun.target); // target defaults to origin

    // sky dome: the ONE MeshBasicMaterial exception — vertex gradient, fog:false
    const skyGeo = new THREE.SphereGeometry(DOME_RADIUS, 24, 12);
    this.sky = new THREE.Mesh(
      skyGeo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }),
    );
    this.sky.frustumCulled = false; // the dome always encloses the camera
    this.tintSky(KPAL.sky, KPAL.horizon);
    this.scene.add(this.sky);

    this.renderer.setClearColor(KPAL.sky);
    this.resize();
  }

  /** Re-tint lights/fog/sky from the track theme. Idempotent. */
  setTheme(theme: TrackTheme): void {
    this.hemi.color.set(theme.sky);
    this.hemi.groundColor.set(KPAL.grass);
    this.hemi.intensity = theme.hemiIntensity;

    this.sun.color.set(theme.sunColor);
    this.sun.intensity = theme.sunIntensity;
    this.sunDir = theme.sunDir;
    // sunDir points TOWARDS the scene, so the light sits opposite it
    this.sun.position.set(
      -theme.sunDir[0] * SUN_DISTANCE,
      -theme.sunDir[1] * SUN_DISTANCE,
      -theme.sunDir[2] * SUN_DISTANCE,
    );
    this.sun.target.position.set(0, 0, 0);
    this.sun.target.updateMatrixWorld();

    this.scene.fog = new THREE.FogExp2(theme.fog, theme.fogDensity);
    this.renderer.setClearColor(theme.sky);
    this.tintSky(theme.sky, theme.horizon);
  }

  /**
   * Build the whole circuit: ground, road ribbon + painted markings, curbs,
   * barrier posts, seeded scatter (trees/rocks, never on the road), hill ring.
   * Idempotent — rebuilding disposes the previous track's geometries.
   */
  buildTrack(track: TrackDef): void {
    if (this.trackRoot) {
      this.scene.remove(this.trackRoot);
      disposeGeometries(this.trackRoot);
      this.trackRoot = null;
    }
    const frames = trackFrames(track.centerline);
    const w = track.roadHalfW;
    const root = new THREE.Group();

    // ---- road ribbon + painted markings (flat, receive shadows only) -----------
    const road = new THREE.Mesh(roadGeometry(frames, w), mat(KPAL.asphalt));
    road.receiveShadow = true;
    root.add(road);

    // subtle center-line dashes: thin lighter strip, every other segment
    const dashes = new THREE.Mesh(
      ribbonGeometry(frames, DASH_W / 2, -DASH_W / 2, DASH_Y, () => [1, 1, 1], (i) => i % DASH_PERIOD !== 0),
      mat(KPAL.asphaltLight),
    );
    dashes.receiveShadow = true;
    root.add(dashes);

    // curb stripes: alternating red/white per CURB_PERIOD segments, both edges
    const curbCols = [new THREE.Color(KPAL.curbRed), new THREE.Color(KPAL.curbWhite)];
    const curbColor = (seg: number): [number, number, number] => {
      const c = curbCols[Math.floor(seg / CURB_PERIOD) % 2]!;
      return [c.r, c.g, c.b];
    };
    for (const side of [1, -1]) {
      const inner = side * w;
      const outer = side * (w + CURB_W);
      const curb = new THREE.Mesh(
        ribbonGeometry(frames, Math.max(inner, outer), Math.min(inner, outer), CURB_Y, curbColor, () => false),
        curbMaterial(),
      );
      curb.receiveShadow = true;
      root.add(curb);
    }

    // ---- everything static below is baked into ~1 mesh per material ------------
    const statics = new THREE.Group();

    // ground: grass slab, top surface just below the road ribbon
    statics.add(at(box(GROUND_SIZE, 0.04, GROUND_SIZE, KPAL.grass), 0, -0.04, 0));

    // barrier posts: every BARRIER_EVERY segments at roadHalfW + BARRIER_OFF
    for (let i = 0; i < frames.length; i += BARRIER_EVERY) {
      const f = frames[i]!;
      const hex = (i / BARRIER_EVERY) % 2 === 0 ? KPAL.barrierWhite : KPAL.barrierRed;
      for (const side of [1, -1]) {
        statics.add(
          at(
            cyl(0.09, 0.09, BARRIER_H, 8, hex),
            f.cx + f.lx * (w + BARRIER_OFF) * side,
            BARRIER_H / 2,
            f.cz + f.lz * (w + BARRIER_OFF) * side,
          ),
        );
      }
    }

    // start/finish: checkered band of small quads across gate 0
    const g0 = track.gates[0]!;
    const cell = (w * 2) / CHECKER_COLS;
    const checker = new THREE.Group();
    checker.position.set(g0.x, PAINT_Y, g0.z);
    checker.rotation.y = Math.atan2(-g0.tx, -g0.tz); // local -z = direction of travel
    for (let r = 0; r < CHECKER_ROWS; r++) {
      for (let c = 0; c < CHECKER_COLS; c++) {
        const hex = (r + c) % 2 === 0 ? KPAL.startLine : KPAL.ink;
        checker.add(
          at(
            box(cell * 0.98, 0.02, cell * 0.98, hex),
            (c + 0.5 - CHECKER_COLS / 2) * cell,
            0,
            (CHECKER_ROWS / 2 - r - 0.5) * cell,
          ),
        );
      }
    }
    statics.add(checker);

    // grid slot markers: one outlined stall per slot behind the line
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const s = gridSlot(track, i);
      const stall = new THREE.Group();
      stall.position.set(s.x, PAINT_Y, s.z);
      stall.rotation.y = s.yaw;
      stall.add(at(box(1.7, 0.02, 0.14, KPAL.startLine), 0, 0, -1.25));
      stall.add(at(box(1.7, 0.02, 0.14, KPAL.startLine), 0, 0, 1.25));
      stall.add(at(box(0.14, 0.02, 2.5, KPAL.startLine), -0.85, 0, 0));
      stall.add(at(box(0.14, 0.02, 2.5, KPAL.startLine), 0.85, 0, 0));
      statics.add(stall);
    }

    // seeded scatter: trees + rocks, never on the road (|lateral| > halfW + 4)
    const next = rng(decoSeed('kart-circuit', 0));
    const placed: Array<{ x: number; z: number }> = [];
    let trees = 0;
    let rocks = 0;
    const maxAttempts = (TREE_COUNT + ROCK_COUNT) * 30; // termination cap
    for (let attempt = 0; attempt < maxAttempts && (trees < TREE_COUNT || rocks < ROCK_COUNT); attempt++) {
      const x = rngRange(next, -SCATTER_X, SCATTER_X);
      const z = rngRange(next, -SCATTER_Z, SCATTER_Z);
      if (Math.abs(closestOnTrack(track, x, z).lateral) <= w + PROP_CLEARANCE) continue;
      if (tooClose(x, z, placed)) continue;
      placed.push({ x, z });
      const makeTree = trees < TREE_COUNT && (rocks >= ROCK_COUNT || next() < 0.75);
      const prop = makeTree ? buildTree(next) : buildRock(next);
      if (makeTree) trees++;
      else rocks++;
      prop.position.set(x, 0, z);
      statics.add(prop);
    }

    // distant hill ring: low dark-green cones at r ~ 200
    for (let i = 0; i < HILL_COUNT; i++) {
      const ang = (i / HILL_COUNT) * Math.PI * 2 + rngRange(next, -0.15, 0.15);
      const r = rngRange(next, HILL_R_MIN, HILL_R_MAX);
      const hr = rngRange(next, 26, 48);
      const hh = rngRange(next, 12, 26);
      statics.add(at(cone(hr, hh, 7, KPAL.grassDark), Math.cos(ang) * r, hh / 2 - 0.5, Math.sin(ang) * r));
    }

    root.add(bake(statics)); // one merged mesh per material, shadows on
    this.trackRoot = root;
    this.scene.add(root);
  }

  /** Add a kart; color MUST be its KART_COLORS hex (chassis + helmet). Idempotent. */
  addKart(id: string, color: string): void {
    this.removeKart(id);
    const v = this.buildKart(color);
    this.karts.set(id, v);
    this.scene.add(v.root);
  }

  removeKart(id: string): void {
    const v = this.karts.get(id);
    if (!v) return;
    this.scene.remove(v.root);
    disposeGeometries(v.root);
    this.karts.delete(id);
  }

  /**
   * Push the latest target transform for a kart and ease towards it (~12/s —
   * the interpolation lives in here, callers just forward sim/snapshot poses).
   * First call after addKart snaps. Wheels spin with signed travel distance,
   * the front pair steers, the body rolls slightly while drifting.
   */
  updateKart(id: string, x: number, y: number, z: number, yaw: number, steer: number, drift: boolean, dt: number): void {
    const v = this.karts.get(id);
    if (!v) return; // addKart must run first — ignore stray state
    v.tx = x;
    v.ty = y;
    v.tz = z;
    v.tyaw = yaw;
    const d = Math.min(dt, 0.1); // tab-back spikes never teleport the ease
    if (!v.snapped) {
      v.cx = x;
      v.cy = y;
      v.cz = z;
      v.cyaw = yaw;
      v.snapped = true;
    } else {
      const k = 1 - Math.exp(-INTERP_RATE * d);
      const px = v.cx;
      const pz = v.cz;
      v.cx += (v.tx - v.cx) * k;
      v.cy += (v.ty - v.cy) * k;
      v.cz += (v.tz - v.cz) * k;
      const dyaw = Math.atan2(Math.sin(v.tyaw - v.cyaw), Math.cos(v.tyaw - v.cyaw)); // shortest arc
      v.cyaw += dyaw * k;
      // wheels spin with the signed distance travelled along the forward axis
      const fx = -Math.sin(v.cyaw);
      const fz = -Math.cos(v.cyaw);
      v.spin -= ((v.cx - px) * fx + (v.cz - pz) * fz) / WHEEL_R;
    }
    v.steerVis += (steer * STEER_VIS - v.steerVis) * Math.min(1, 14 * d);
    v.roll += ((drift ? -v.steerVis * DRIFT_ROLL : 0) - v.roll) * Math.min(1, 10 * d);
    v.root.position.set(v.cx, v.cy, v.cz);
    v.root.rotation.y = v.cyaw;
    v.body.rotation.z = v.roll;
    for (const wheel of v.wheels) wheel.rotation.x = v.spin;
    // steer + = RIGHT (yaw decreases). The kart faces local -z, so its right
    // side is local +x; rotating a -z-facing wheel by rotation.y = -angle
    // swings its nose toward +x — hence the negative sign here.
    for (const pivot of v.steerPivots) pivot.rotation.y = -v.steerVis;
  }

  /**
   * Chase camera: behind + above the watched kart (dist 7 + 0.08*|speed|,
   * height ~3), looking a few meters ahead of it. FOV = 65 + 0.25*km/h, bonus
   * capped at +15 to keep it modest. Position eases at ~8/s; first call snaps.
   * The sun's shadow box follows so shadows stay crisp anywhere on the circuit.
   */
  setCamera(x: number, y: number, z: number, yaw: number, speed: number, dt: number): void {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const sp = Math.abs(speed);
    const dist = CAM_DIST + CAM_DIST_PER_SPEED * sp;
    const desired = this.camScratch.set(x - fx * dist, y + CAM_HEIGHT, z - fz * dist);
    if (!this.camReady) {
      this.camera.position.copy(desired);
      this.camReady = true;
    } else {
      this.camera.position.lerp(desired, 1 - Math.exp(-CAM_EASE * Math.min(dt, 0.1)));
    }
    this.camera.lookAt(this.lookScratch.set(x + fx * CAM_LOOK_AHEAD, y + CAM_LOOK_HEIGHT, z + fz * CAM_LOOK_AHEAD));

    const fov = BASE_FOV + Math.min(FOV_BONUS_CAP, FOV_PER_KMH * sp * 3.6);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    this.sun.position.set(
      x - this.sunDir[0] * SUN_DISTANCE,
      -this.sunDir[1] * SUN_DISTANCE,
      z - this.sunDir[2] * SUN_DISTANCE,
    );
    this.sun.target.position.set(x, 0, z);
    this.sun.target.updateMatrixWorld();
  }

  /** Fit renderer + camera to the canvas' laid-out size (DPR capped at 2). */
  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false); // canvas CSS size owned by the app shell
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** Release GPU resources. Materials are shared via the mat() cache — not disposed here. */
  dispose(): void {
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
  }

  // ---- private helpers -------------------------------------------------------------

  /**
   * 20 prims (docs/KART.md allows 18-26): chassis, nose, front wing, 2 side
   * pods, seat, engine block, rear bumper, exhaust, roll bar, driver torso,
   * helmet (player color), steering wheel, rear wing blade + 2 supports,
   * 4 wheels. Faces local -z so root.rotation.y = platform yaw works.
   */
  private buildKart(color: string): KartVisual {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const put = (mesh: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh => {
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      body.add(mesh);
      return mesh;
    };
    put(box(1.1, 0.18, 2.0, color), 0, 0.28, 0); // chassis
    put(box(0.5, 0.14, 0.7, color), 0, 0.3, -1.2); // nose
    put(box(1.25, 0.06, 0.35, KPAL.charcoal), 0, 0.14, -1.42); // front wing
    put(box(0.3, 0.22, 0.9, KPAL.charcoal), -0.62, 0.3, 0.1); // side pod L
    put(box(0.3, 0.22, 0.9, KPAL.charcoal), 0.62, 0.3, 0.1); // side pod R
    put(box(0.55, 0.55, 0.16, KPAL.ink), 0, 0.62, 0.55); // seat back
    put(box(0.5, 0.34, 0.42, KPAL.steel), 0, 0.42, 0.92); // engine block
    put(box(1.2, 0.12, 0.1, KPAL.charcoal), 0, 0.25, 1.26); // rear bumper
    const exhaust = put(cyl(0.05, 0.05, 0.4, 6, KPAL.charcoal), 0.28, 0.5, 1.1);
    exhaust.rotation.x = Math.PI / 2; // axis along z
    const rollBar = put(cyl(0.045, 0.045, 0.55, 6, KPAL.steel), 0, 0.95, 0.58);
    rollBar.rotation.z = Math.PI / 2; // axis across the kart
    put(box(0.46, 0.5, 0.3, KPAL.charcoal), 0, 0.66, 0.3); // driver torso
    put(sphere(0.23, 8, color), 0, 1.02, 0.3); // helmet — player color
    const steering = put(cyl(0.13, 0.13, 0.05, 8, KPAL.ink), 0, 0.66, -0.2);
    steering.rotation.x = -1.1; // tilted towards the driver
    put(box(1.15, 0.06, 0.32, color), 0, 0.88, 1.18); // rear wing blade
    put(box(0.06, 0.34, 0.2, KPAL.charcoal), -0.36, 0.68, 1.15); // wing support L
    put(box(0.06, 0.34, 0.2, KPAL.charcoal), 0.36, 0.68, 1.15); // wing support R

    // wheels: axle along local X (pre-rotated geometry); front pair on steer pivots
    const wheelGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.24, 10);
    wheelGeo.rotateZ(Math.PI / 2);
    const tire = mat(KPAL.tire);
    const wheels: THREE.Mesh[] = [];
    const steerPivots: THREE.Group[] = [];
    const spots: Array<[number, number, boolean]> = [
      [-0.62, -0.75, true],
      [0.62, -0.75, true],
      [-0.66, 0.78, false],
      [0.66, 0.78, false],
    ];
    for (const [wx, wz, steerable] of spots) {
      const pivot = new THREE.Group();
      pivot.position.set(wx, WHEEL_R, wz);
      const wheel = new THREE.Mesh(wheelGeo, tire);
      wheel.castShadow = true;
      pivot.add(wheel);
      root.add(pivot);
      wheels.push(wheel);
      if (steerable) steerPivots.push(pivot);
    }
    return {
      root,
      body,
      wheels,
      steerPivots,
      snapped: false,
      tx: 0,
      ty: 0,
      tz: 0,
      tyaw: 0,
      cx: 0,
      cy: 0,
      cz: 0,
      cyaw: 0,
      spin: 0,
      steerVis: 0,
      roll: 0,
    };
  }

  /** Rewrite the dome's vertex colors: theme.horizon (rim) -> theme.sky (top). */
  private tintSky(topHex: string, bottomHex: string): void {
    const pos = this.sky.geometry.getAttribute('position') as THREE.BufferAttribute;
    let col = this.sky.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!col || col.count !== pos.count) {
      col = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
      this.sky.geometry.setAttribute('color', col);
    }
    const top = new THREE.Color(topHex);
    const bottom = new THREE.Color(bottomHex);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = smooth01(pos.getY(i) / DOME_RADIUS / 2 + 0.5);
      c.copy(bottom).lerp(top, t);
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  /** Tracked context-error overlay (single element; never duplicated). */
  private static contextErrorEl: HTMLDivElement | null = null;

  /** Full-viewport readable failure message (KPAL colors); idempotent. */
  private static showContextError(): void {
    if (KartScene.contextErrorEl?.isConnected) return;
    const div = document.createElement('div');
    div.textContent = 'WebGL is not available in this browser — KART GP needs GPU rendering to run.';
    const s = div.style;
    s.position = 'fixed';
    s.inset = '0';
    s.display = 'flex';
    s.alignItems = 'center';
    s.justifyContent = 'center';
    s.padding = '24px';
    s.textAlign = 'center';
    s.background = KPAL.ink;
    s.color = KPAL.hudText;
    s.font = '16px/1.5 system-ui, sans-serif';
    s.zIndex = '1000';
    document.body.appendChild(div);
    KartScene.contextErrorEl = div;
  }
}
