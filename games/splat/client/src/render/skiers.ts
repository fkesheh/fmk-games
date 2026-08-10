// ============================================================================
// SKI SPLAT — SkierVisuals (task R2, CONTRACT §7 + §7a seam). Remote skiers
// and the first-person own-skis rig.
//
// REMOTES: one skier is TWO baked per-material-merged groups (the kart
// pattern — bake() the static primitives, articulate PIVOT GROUPS, never
// per-primitive meshes):
//   root (feet position + yaw, straight from the interp buffer)
//    ├─ skisPivot  — both skis baked into ONE mesh (slot colour); slight
//   │               edging yaw/roll from steer. Stays planted on the snow.
//    └─ bodyPivot  — boots/legs/torso/arms/poles/helmet baked into ONE mesh
//                    per material (slot colour + ink); pivot at the feet so a
//                    carve lean rolls the whole silhouette around the ankles
//                    (boots stay glued to the skis). Carries the chest-glyph
//                    sprite (the §2.5 CanvasTexture exemption — ONE per skier).
// That is 4 draw calls per remote (ski mesh, two body materials, glyph
// sprite): 7 remotes ≈ 28 calls, leaving ample room in the global <80 budget.
// Model sheet (STYLE_BIBLE): two skis, boots, articulated bent legs, torso,
// arms with poles, helmet in SKIER_COLORS[slot], animal glyph on the chest.
// At 30 m the read is the COLOUR block + the crouch.
//
// OWN SKIS: `ownSkisRig` is a camera-space Group — the app does
// `scene.camera.add(skiers.ownSkisRig)` ONCE (see header note in setOwnSkis).
// Two skis + boot toe-pieces at frame bottom, angling/spreading with steer,
// vibrating with speed. Body presence without a body.
//
// Colours come ONLY from SPAL / SKIER_COLORS / SKIER_GLYPHS via the visual.ts
// factories. No per-frame allocation: per-skier eased state lives in a fixed
// record mutated in place; all randomness is seeded (none needed at runtime).
// ============================================================================

import * as THREE from 'three';
import { box, cyl, sphere, at, bake, type MatFn } from '../contract/visual.js';
import { MAX_SPEED, SKIER_COLORS, SKIER_GLYPHS, SPAL } from '@splat/shared';

// ---- local material factory (visual.ts MatFn seam; hex only from SPAL) -----
const matCache = new Map<string, THREE.MeshLambertMaterial>();
const mat: MatFn = (hex: string) => {
  let m = matCache.get(hex);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color: hex, flatShading: true });
    matCache.set(hex, m);
  }
  return m;
};

// ---- tuning -------------------------------------------------------------------
const LEAN_MAX = 0.38; // rad of carve roll at full lock (into the turn)
const SKI_EDGE_YAW = 0.18; // remote skis yaw with steer (edging read)
const SKI_EDGE_ROLL = 0.12;
const CROUCH_PITCH = 0.22; // forward tuck at MAX_SPEED
const CROUCH_DROP = 0.1; // m the hips sink at MAX_SPEED
const BOB_AMP = 0.03; // m of vertical bob at MAX_SPEED
const EASE = 8; // per-second ease rate for steer/speed visuals

// Own-skis rig (camera space: camera looks down -Z, +X right, +Y up).
const OWN_Y = -1.38; // frame-bottom height
const OWN_Z = -0.55; // just in front of the near plane
const OWN_SPREAD = 0.07; // extra lateral split at full lock
const OWN_ANGLE = 0.22; // ski yaw at full lock
const OWN_EDGE = 0.28; // ski edging roll at full lock
const SHAKE_BASE = 0.004; // idle vibration (m)
const SHAKE_SPEED = 0.014; // added vibration at MAX_SPEED

/** Free every geometry under a root (baked groups own unique geometry). */
function disposeGeometries(root: THREE.Object3D): void {
  root.traverse((c) => {
    if (c instanceof THREE.Mesh) c.geometry.dispose();
  });
}

// ---------------------------------------------------------------------------
// Remote skier prototypes. Feet at y=0, facing +Z (the sim's yaw=0 heading).
// ---------------------------------------------------------------------------

/** Both skis with upturned tips, slot colour — baked into one mesh. */
function skisProto(color: string): THREE.Group {
  const g = new THREE.Group();
  for (const side of [-1, 1]) {
    const x = side * 0.22;
    g.add(at(box(mat, 0.12, 0.035, 1.75, color), x, 0.035, 0.05));
    // Upturned shovel at the front (+z is the facing direction).
    const tip = at(box(mat, 0.12, 0.03, 0.24, color), x, 0.1, 0.98);
    tip.rotation.x = -0.55;
    g.add(tip);
  }
  return g;
}

/**
 * The body: boots, bent legs, torso, arms + poles, helmet. Two materials only
 * (slot colour = the identity block; ink = equipment), so bake() yields two
 * meshes. ~34 primitives in a fixed athletic stance; articulation happens on
 * the pivot, not per primitive.
 */
function bodyProto(color: string): THREE.Group {
  const g = new THREE.Group();
  const ink = SPAL.ink;
  // Boots planted where the skis' bindings are.
  for (const side of [-1, 1]) {
    const x = side * 0.22;
    g.add(at(box(mat, 0.14, 0.18, 0.34, ink), x, 0.13, 0.02));
    // Bent legs: shin tips forward, thigh tips back — the athletic crouch read.
    const shin = at(cyl(mat, 0.06, 0.075, 0.44, 6, ink), x - side * 0.01, 0.44, -0.01);
    shin.rotation.x = 0.18;
    g.add(shin);
    const thigh = at(cyl(mat, 0.075, 0.09, 0.46, 6, ink), x - side * 0.03, 0.8, -0.12);
    thigh.rotation.x = -0.35;
    g.add(thigh);
    g.add(at(sphere(mat, 0.09, 6, ink), x - side * 0.02, 0.56, 0.1)); // knee pad
  }
  g.add(at(box(mat, 0.36, 0.22, 0.24, ink), 0, 1.02, -0.17)); // hips
  // Torso pitched slightly into the tuck; the slot-colour block.
  const torso = at(box(mat, 0.44, 0.52, 0.27, color), 0, 1.35, -0.11);
  torso.rotation.x = 0.24;
  g.add(torso);
  const chest = at(box(mat, 0.4, 0.34, 0.06, color), 0, 1.38, 0.06);
  chest.rotation.x = 0.24;
  g.add(chest);
  // Arms out + back with poles trailing — the downhill silhouette.
  for (const side of [-1, 1]) {
    g.add(at(sphere(mat, 0.11, 6, color), side * 0.27, 1.56, -0.19)); // shoulder
    const upper = at(cyl(mat, 0.05, 0.06, 0.36, 5, color), side * 0.35, 1.36, -0.11);
    upper.rotation.z = -side * 0.55;
    upper.rotation.x = 0.45;
    g.add(upper);
    const fore = at(cyl(mat, 0.04, 0.05, 0.34, 5, color), side * 0.46, 1.13, 0.06);
    fore.rotation.x = 0.95;
    g.add(fore);
    g.add(at(sphere(mat, 0.06, 5, ink), side * 0.47, 0.99, 0.22)); // glove
    const pole = at(cyl(mat, 0.012, 0.012, 0.98, 4, ink), side * 0.5, 0.6, 0.02);
    pole.rotation.x = 0.38;
    g.add(pole);
    g.add(at(cyl(mat, 0.05, 0.05, 0.02, 6, ink), side * 0.5, 0.13, -0.16)); // basket
  }
  // Collar + helmet (slot colour, the second identity block) with a dark visor.
  g.add(at(cyl(mat, 0.09, 0.11, 0.1, 6, ink), 0, 1.64, -0.17));
  g.add(at(sphere(mat, 0.15, 8, color), 0, 1.79, -0.13));
  g.add(at(box(mat, 0.2, 0.07, 0.08, ink), 0, 1.77, 0.0));
  return g;
}

/**
 * Chest glyph decal — the §2.5 exemption: ONE CanvasTexture sprite per skier,
 * SKIER_GLYPHS[slot] on a paper disc ringed with the slot colour. All pigment
 * still traces to the palette.
 */
function glyphSprite(slot: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  if (ctx !== null) {
    ctx.clearRect(0, 0, 128, 128);
    ctx.beginPath();
    ctx.arc(64, 64, 56, 0, Math.PI * 2);
    ctx.fillStyle = SPAL.paper;
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = SKIER_COLORS[slot] ?? SPAL.ink;
    ctx.stroke();
    ctx.font = '72px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(SKIER_GLYPHS[slot] ?? '?', 64, 68);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(0.34, 0.34, 1);
  return sprite;
}

// ---------------------------------------------------------------------------
// Per-remote state (allocated once in add(), mutated in place thereafter).
// ---------------------------------------------------------------------------
interface RemoteSkier {
  readonly root: THREE.Group;
  readonly skisPivot: THREE.Group;
  readonly bodyPivot: THREE.Group;
  readonly baked: THREE.Group[]; // unique geometry to dispose on remove()
  readonly sprite: THREE.Sprite;
  steerVis: number; // eased steer
  vEst: number; // eased speed estimate (finite difference of the interp pose)
  phase: number; // bob clock (dt-driven, deterministic)
  lastX: number;
  lastZ: number;
  hasLast: boolean;
}

export class SkierVisuals {
  private readonly world: THREE.Scene;
  private readonly remotes = new Map<string, RemoteSkier>();

  /**
   * First-person own skis + boot toe-pieces. CAMERA-SPACE rig: the app must
   * attach it ONCE with `camera.add(skierVisuals.ownSkisRig)` (and
   * `world.add(camera)` if the camera is not already in the scene graph);
   * setOwnSkis() then animates it every frame. Never added to the world here.
   */
  readonly ownSkisRig: THREE.Group;
  private readonly ownSkiL: THREE.Group;
  private readonly ownSkiR: THREE.Group;
  private ownSteerVis = 0;
  private ownPhase = 0;

  constructor(world: THREE.Scene) {
    this.world = world;
    this.ownSkisRig = new THREE.Group();
    this.ownSkisRig.position.set(0, OWN_Y, OWN_Z);
    this.ownSkisRig.rotation.x = 0.12; // tips dip away — the downhill read
    this.ownSkiL = ownSkiPivot(-1);
    this.ownSkiR = ownSkiPivot(1);
    this.ownSkisRig.add(this.ownSkiL, this.ownSkiR);
  }

  /** Build a remote skier for roster id `id` wearing SKIER_COLORS[slot]. */
  add(id: string, slot: number): void {
    if (this.remotes.has(id)) this.remove(id);
    const color = SKIER_COLORS[slot] ?? SPAL.ink;

    const root = new THREE.Group();
    const skisPivot = new THREE.Group();
    const bodyPivot = new THREE.Group();

    const skiProtoG = skisProto(color);
    const bakedSkis = bake(skiProtoG);
    disposeGeometries(skiProtoG);
    const bodyProtoG = bodyProto(color);
    const bakedBody = bake(bodyProtoG);
    disposeGeometries(bodyProtoG);
    for (const b of [bakedSkis, bakedBody]) {
      b.traverse((c: THREE.Object3D) => {
        if (c instanceof THREE.Mesh) {
          c.castShadow = true;
          c.receiveShadow = false;
        }
      });
    }
    skisPivot.add(bakedSkis);
    bodyPivot.add(bakedBody);

    const sprite = glyphSprite(slot);
    sprite.position.set(0, 1.38, 0.12);
    bodyPivot.add(sprite);

    root.add(skisPivot, bodyPivot);
    this.world.add(root);
    this.remotes.set(id, {
      root,
      skisPivot,
      bodyPivot,
      baked: [bakedSkis, bakedBody],
      sprite,
      steerVis: 0,
      vEst: 0,
      phase: 0,
      lastX: 0,
      lastZ: 0,
      hasLast: false,
    });
  }

  /** Drop a remote skier and free its unique geometry + glyph texture. */
  remove(id: string): void {
    const s = this.remotes.get(id);
    if (s === undefined) return;
    this.remotes.delete(id);
    this.world.remove(s.root);
    for (const b of s.baked) disposeGeometries(b);
    const sm = s.sprite.material;
    sm.map?.dispose();
    sm.dispose();
  }

  /**
   * Pose one remote from the interp buffer. (x, y, z) is FEET (terrain
   * height); yaw is the sim heading (0 = +Z fall line, + toward +x); steer
   * drives the carve lean. dt is the frame delta (s) — used only for easing
   * and the bob clock, never for integration.
   */
  update(id: string, x: number, y: number, z: number, yaw: number, steer: number, dt: number): void {
    const s = this.remotes.get(id);
    if (s === undefined) return;
    s.root.position.set(x, y, z);
    s.root.rotation.y = yaw;

    // Speed estimate: finite difference of the interpolated pose (the seam
    // carries no v for remotes). Snaps on the first sample after add/teleport.
    if (s.hasLast && dt > 0) {
      const vRaw = Math.min(MAX_SPEED, Math.hypot(x - s.lastX, z - s.lastZ) / dt);
      s.vEst += (vRaw - s.vEst) * Math.min(1, 6 * dt);
    }
    s.lastX = x;
    s.lastZ = z;
    s.hasLast = true;

    const k = Math.min(1, EASE * dt);
    s.steerVis += (steer - s.steerVis) * k;
    s.phase += dt * (6 + s.vEst * 0.8);

    const speedFrac = Math.min(1, s.vEst / MAX_SPEED);
    // Lean into the carve: +steer turns toward +x, so roll the top toward +x.
    s.bodyPivot.rotation.z = -s.steerVis * LEAN_MAX;
    // Crouch with speed + a slight speed-scaled bob.
    s.bodyPivot.rotation.x = speedFrac * CROUCH_PITCH;
    s.bodyPivot.position.y = Math.sin(s.phase) * BOB_AMP * speedFrac - speedFrac * CROUCH_DROP;
    // Skis stay planted; they edge with the steer.
    s.skisPivot.rotation.y = -s.steerVis * SKI_EDGE_YAW;
    s.skisPivot.rotation.z = -s.steerVis * SKI_EDGE_ROLL;
  }

  /**
   * Animate the first-person own skis (camera-space rig — see ownSkisRig).
   * Skis angle into the carve and spread at full lock; the whole rig vibrates
   * with speed. Deterministic: the shake is a dt-driven oscillator, no rng.
   */
  setOwnSkis(steer: number, v: number, dt: number): void {
    const k = Math.min(1, EASE * dt);
    this.ownSteerVis += (steer - this.ownSteerVis) * k;
    const speedFrac = Math.min(1, Math.max(0, v / MAX_SPEED));
    this.ownPhase += dt * (7 + v * 1.2);

    const st = this.ownSteerVis;
    // Angle into the turn (+steer -> tips toward +x => negative rotation.y for
    // the camera-space -Z forward axis) plus a slight static V stance.
    this.ownSkiL.rotation.y = 0.05 - st * OWN_ANGLE;
    this.ownSkiR.rotation.y = -0.05 - st * OWN_ANGLE;
    // Spread under load + edge both skis into the carve.
    const spread = Math.abs(st) * OWN_SPREAD;
    this.ownSkiL.position.x = -0.23 - spread;
    this.ownSkiR.position.x = 0.23 + spread;
    this.ownSkiL.rotation.z = -st * OWN_EDGE;
    this.ownSkiR.rotation.z = -st * OWN_EDGE;
    // Speed vibration: two incommensurate harmonics, amplitude follows v.
    const amp = SHAKE_BASE + SHAKE_SPEED * speedFrac;
    this.ownSkisRig.position.y = OWN_Y + Math.sin(this.ownPhase) * amp;
    this.ownSkisRig.position.x = Math.sin(this.ownPhase * 0.63 + 1.7) * amp * 0.6;
    this.ownSkisRig.rotation.z = -st * 0.06;
  }

  /** Remove every remote and free the own-skis rig's geometry. */
  dispose(): void {
    for (const id of [...this.remotes.keys()]) this.remove(id);
    this.ownSkisRig.removeFromParent();
    disposeGeometries(this.ownSkisRig);
  }
}

/** One own-rig ski pivot: ski + upturned tip + boot toe-piece, baked. */
function ownSkiPivot(side: number): THREE.Group {
  const proto = new THREE.Group();
  // Camera space: forward is -Z, so the ski body runs mostly ahead of the boot.
  proto.add(at(box(mat, 0.13, 0.04, 2.1, SPAL.rockLit), 0, 0, -0.45));
  proto.add(at(box(mat, 0.13, 0.045, 0.5, SPAL.ink), 0, -0.005, -0.2)); // sidewall band
  const tip = at(box(mat, 0.13, 0.04, 0.26, SPAL.rockLit), 0, 0.07, -1.6);
  tip.rotation.x = 0.5;
  proto.add(tip);
  proto.add(at(box(mat, 0.16, 0.15, 0.24, SPAL.ink), 0, 0.1, 0.1)); // boot toe-piece
  const bakedG = bake(proto);
  disposeGeometries(proto);
  const pivot = new THREE.Group();
  pivot.position.set(side * 0.23, 0, 0);
  pivot.add(bakedG);
  return pivot;
}
