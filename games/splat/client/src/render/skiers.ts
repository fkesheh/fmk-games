// ============================================================================
// SKI SPLAT — SkierVisuals (task R2, CONTRACT §7 + §7a seam; R4v2 detail pass
// + AIR POSE + own-skis tuck, CONTRACT §11.5, STYLE_BIBLE §V2.4). Remote
// skiers and the first-person own-skis rig.
//
// REMOTES: one skier is THREE baked per-material-merged groups (the kart
// pattern — bake() the static primitives, articulate PIVOT GROUPS, never
// per-primitive meshes):
//   root (feet position + yaw, straight from the interp buffer)
//    ├─ skisPivot  — both skis baked into ONE mesh (slot colour); slight
//   │               edging yaw/roll from steer. Stays planted on the snow.
//    └─ bodyPivot  — boots/legs/torso/backpack/arms/poles/helmet baked into
//                     ONE mesh per material (slot colour, ink, paper); pivot
//                     at the feet so a carve lean rolls the whole silhouette
//                     around the ankles (boots stay glued to the skis).
//                     Carries the chest-glyph sprite (the §2.5 CanvasTexture
//                     exemption — ONE per skier).
// That is 5 draw calls per remote (ski mesh, three body materials, glyph
// sprite): 7 remotes ≈ 35 calls. The paper visor band is the R4v2 addition
// over the v1 body (was 4 calls/remote ≈ 28) — the brief asked for a `paper`
// visor band, and the global <80 budget still holds; flag for the E2E gate.
// Model sheet (STYLE_BIBLE): two skis, boots, articulated bent legs, torso
// with shoulder-panel taper + backpack + chest strap, arms with elbow joints
// + poles with baskets, helmet with visor band, in SKIER_COLORS[slot], animal
// glyph on the chest. At 30 m the read is the COLOUR block + the crouch.
//
// AIR POSE (R4v2): per-remote eased `airVis` (0..1) driven by
// setRemoteAirborne(id, on). While airborne the carve crouch blends toward:
// legs extend (body lifts off the skis), torso uprights (bodyPivot.rotation.x
// -> AIR_UPRIGHT, a slight back-lean), the carve roll/edge fades (flat skis),
// skis tuck (skisPivot drops slightly, y-scale ~0.9). On the air->ground edge
// a one-shot `landVis` over-crouch (~AIR_LAND_TAU) fires and eases back — the
// landing absorb. All eased state lives in the per-remote record: zero
// per-frame allocation.
//
// OWN SKIS: `ownSkisRig` is a camera-space Group — the app does
// `scene.camera.add(skiers.ownSkisRig)` ONCE (see header note in setOwnSkis).
// Two skis (paper top-sheet stripe + ink sidewall + binding) + boot toe-pieces
// at frame bottom, angling/spreading with steer, vibrating with speed. Body
// presence without a body. In air (setOwnAirborne) the rig tucks: it rises,
// tips level (rotation.x 0.12 -> 0.02), spread/edge/vibration fade; on the
// grounded edge a one-shot dip (the land spring) fires.
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

// ---- air pose (R4v2, STYLE_BIBLE §V2.4) ----------------------------------------
const AIR_TAU = 0.12; // s — carve<->air pose ease time constant
const AIR_LAND_TAU = 0.15; // s — landing over-crouch absorb duration
const AIR_UPRIGHT = -0.08; // rad — torso pitch while flying (slight back-lean)
const AIR_BODY_LIFT = 0.05; // m — body rises off the skis (legs-extend read)
const AIR_SKI_DROP = 0.02; // m — skis sink slightly under the tuck
const AIR_SKI_TUCK = 0.9; // skisPivot y-scale while flying (visual tuck)
const LAND_CROUCH = 0.22; // rad — extra forward pitch at the landing-absorb peak
const LAND_CROUCH_DROP = 0.06; // m — extra hip sink at the landing-absorb peak

// Own-skis rig (camera space: camera looks down -Z, +X right, +Y up).
const OWN_Y = -1.38; // frame-bottom height
const OWN_Z = -0.55; // just in front of the near plane
const OWN_SPREAD = 0.07; // extra lateral split at full lock
const OWN_ANGLE = 0.22; // ski yaw at full lock
const OWN_EDGE = 0.28; // ski edging roll at full lock
const SHAKE_BASE = 0.004; // idle vibration (m)
const SHAKE_SPEED = 0.014; // added vibration at MAX_SPEED
// Own-skis air: the rig rides tips-down (OWN_RIDE_PITCH), levels + lifts in air.
const OWN_RIDE_PITCH = 0.12; // rig rotation.x at rest (tips dip away)
const OWN_AIR_PITCH = 0.02; // rig rotation.x while flying (tips level)
const OWN_AIR_LIFT = 0.06; // m the rig rises while flying (skis tuck up)
const OWN_LAND_TAU = 0.18; // s — one-shot landing dip duration
const OWN_LAND_DIP = 0.045; // m — dip depth on the grounded edge

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
 * The body: boots, bent legs, torso + backpack + straps, arms with elbow
 * joints + poles, helmet with visor. Three materials: slot colour (the
 * identity block — torso, chest, shoulder panels, chest strap, shoulders,
 * arms, helmet), ink (boots, legs, hips, backpack, gloves, poles, baskets,
 * collar, visor, strap), paper (the helmet visor band). bake() yields one
 * mesh per material; articulation happens on the pivot, not per primitive.
 * ~36 primitives in a fixed athletic stance.
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
  g.add(at(box(mat, 0.38, 0.07, 0.08, ink), 0, 1.12, -0.08)); // waist belt
  // Torso pitched slightly into the tuck; the slot-colour block.
  const torso = at(box(mat, 0.44, 0.52, 0.27, color), 0, 1.35, -0.11);
  torso.rotation.x = 0.24;
  g.add(torso);
  const chest = at(box(mat, 0.4, 0.34, 0.06, color), 0, 1.38, 0.06);
  chest.rotation.x = 0.24;
  g.add(chest);
  // Shoulder-panel taper: two slot-colour boxes over the torso's upper
  // corners, so the colour block reads as a jacket with real shoulders.
  for (const side of [-1, 1]) {
    g.add(at(box(mat, 0.14, 0.16, 0.16, color), side * 0.19, 1.52, -0.16));
  }
  // Backpack (ink) behind the torso with a slot-colour strap across the chest.
  g.add(at(box(mat, 0.34, 0.44, 0.14, ink), 0, 1.34, -0.32));
  g.add(at(box(mat, 0.34, 0.06, 0.14, ink), 0, 1.56, -0.32)); // flap
  const strap = at(box(mat, 0.36, 0.07, 0.05, color), 0, 1.56, 0.09);
  strap.rotation.x = 0.24;
  g.add(strap);
  // Arms out + back with poles trailing — the downhill silhouette. Each arm
  // splits ~0.55/0.45 (upper/fore) around a small elbow-joint sphere.
  for (const side of [-1, 1]) {
    g.add(at(sphere(mat, 0.11, 6, color), side * 0.27, 1.56, -0.19)); // shoulder
    const upper = at(cyl(mat, 0.05, 0.06, 0.39, 5, color), side * 0.35, 1.36, -0.11);
    upper.rotation.z = -side * 0.55;
    upper.rotation.x = 0.45;
    g.add(upper);
    g.add(at(sphere(mat, 0.055, 5, color), side * 0.41, 1.24, -0.03)); // elbow joint
    const fore = at(cyl(mat, 0.04, 0.05, 0.32, 5, color), side * 0.47, 1.13, 0.07);
    fore.rotation.x = 0.95;
    g.add(fore);
    g.add(at(sphere(mat, 0.06, 5, ink), side * 0.48, 0.99, 0.22)); // glove
    const pole = at(cyl(mat, 0.012, 0.012, 0.98, 4, ink), side * 0.5, 0.6, 0.02);
    pole.rotation.x = 0.38;
    g.add(pole);
    g.add(at(cyl(mat, 0.05, 0.05, 0.02, 6, ink), side * 0.5, 0.13, -0.16)); // basket
  }
  // Collar + helmet (slot colour, the second identity block) with a dark visor,
  // a `paper` visor band and an `ink` strap at the base.
  g.add(at(cyl(mat, 0.09, 0.11, 0.1, 6, ink), 0, 1.64, -0.17));
  g.add(at(sphere(mat, 0.15, 8, color), 0, 1.79, -0.13));
  g.add(at(box(mat, 0.2, 0.07, 0.08, ink), 0, 1.77, 0.0));
  const band = at(box(mat, 0.28, 0.08, 0.1, SPAL.paper), 0, 1.85, -0.02);
  band.rotation.x = -0.3;
  g.add(band);
  g.add(at(box(mat, 0.3, 0.06, 0.3, ink), 0, 1.68, -0.13));
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
  airVis: number; // eased air-pose blend 0..1 (R4v2)
  airTarget: boolean; // desired air state from setRemoteAirborne
  landVis: number; // landing absorb 1 -> 0 (fires once on the air->ground edge)
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
  private ownAirVis = 0; // eased air blend 0..1 (setOwnAirborne)
  private ownAirTarget = false; // desired air state
  private ownLand = 0; // one-shot landing dip 1 -> 0

  constructor(world: THREE.Scene) {
    this.world = world;
    this.ownSkisRig = new THREE.Group();
    this.ownSkisRig.position.set(0, OWN_Y, OWN_Z);
    this.ownSkisRig.rotation.x = OWN_RIDE_PITCH; // tips dip away — the downhill read
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
      airVis: 0,
      airTarget: false,
      landVis: 0,
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

    // Air pose blend (R4v2): ease airVis toward the setRemoteAirborne target;
    // the landing absorb (landVis) fires once on the air->ground edge and
    // decays over AIR_LAND_TAU — a brief over-crouch, then back to carve.
    const ak = Math.min(1, dt / AIR_TAU);
    s.airVis += ((s.airTarget ? 1 : 0) - s.airVis) * ak;
    if (s.landVis > 0) s.landVis = Math.max(0, s.landVis - dt / AIR_LAND_TAU);
    const air = s.airVis;
    const land = s.landVis;

    const speedFrac = Math.min(1, s.vEst / MAX_SPEED);
    // Lean into the carve: +steer turns toward +x, so roll the top toward +x.
    // The carve roll fades out while flying (the body holds level).
    s.bodyPivot.rotation.z = -s.steerVis * LEAN_MAX * (1 - air);
    // Crouch with speed; in air the torso uprights (slight back-lean) and the
    // landing absorb adds a brief deeper tuck that eases back.
    const crouch = speedFrac * CROUCH_PITCH;
    s.bodyPivot.rotation.x = crouch + (AIR_UPRIGHT - crouch) * air + land * LAND_CROUCH;
    // Bob fades in air; the body lifts off the skis (legs-extend read) and the
    // landing absorb sinks the hips once.
    s.bodyPivot.position.y =
      Math.sin(s.phase) * BOB_AMP * speedFrac * (1 - air) -
      speedFrac * CROUCH_DROP * (1 - air) +
      air * AIR_BODY_LIFT -
      land * LAND_CROUCH_DROP;
    // Skis stay planted; they edge with the steer on the ground and flatten,
    // drop slightly and tuck (y-scale) while flying.
    s.skisPivot.rotation.y = -s.steerVis * SKI_EDGE_YAW * (1 - air);
    s.skisPivot.rotation.z = -s.steerVis * SKI_EDGE_ROLL * (1 - air);
    s.skisPivot.position.y = -air * AIR_SKI_DROP;
    s.skisPivot.scale.y = 1 - air * (1 - AIR_SKI_TUCK);
  }

  /**
   * R4v2 air seam: flag remote `id` as airborne. The carve->air pose eases
   * over ~AIR_TAU; on the air->ground edge a one-shot over-crouch (the
   * landing absorb) fires and eases back over ~AIR_LAND_TAU. Missing ids are
   * ignored; repeated calls with the same state are no-ops.
   */
  setRemoteAirborne(id: string, on: boolean): void {
    const s = this.remotes.get(id);
    if (s === undefined || s.airTarget === on) return;
    s.airTarget = on;
    if (!on) s.landVis = 1;
  }

  /**
   * Animate the first-person own skis (camera-space rig — see ownSkisRig).
   * Skis angle into the carve and spread at full lock; the whole rig vibrates
   * with speed. Deterministic: the shake is a dt-driven oscillator, no rng.
   * While airborne the rig tucks (rise, level tips, narrow spread, still
   * vibration); on the grounded edge a one-shot dip fires (the land spring).
   */
  setOwnSkis(steer: number, v: number, dt: number): void {
    const k = Math.min(1, EASE * dt);
    this.ownSteerVis += (steer - this.ownSteerVis) * k;
    const speedFrac = Math.min(1, Math.max(0, v / MAX_SPEED));
    this.ownPhase += dt * (7 + v * 1.2);

    // Own air tuck (R4v2): ease toward the setOwnAirborne target; the landing
    // dip fires once on the air->ground edge and decays over OWN_LAND_TAU.
    const ak = Math.min(1, dt / AIR_TAU);
    this.ownAirVis += ((this.ownAirTarget ? 1 : 0) - this.ownAirVis) * ak;
    if (this.ownLand > 0) this.ownLand = Math.max(0, this.ownLand - dt / OWN_LAND_TAU);
    const air = this.ownAirVis;

    const st = this.ownSteerVis;
    // Angle into the turn (+steer -> tips toward +x => negative rotation.y for
    // the camera-space -Z forward axis) plus a slight static V stance. In air
    // the carve angles fade and the skis run parallel.
    this.ownSkiL.rotation.y = (0.05 - st * OWN_ANGLE) * (1 - air);
    this.ownSkiR.rotation.y = (-0.05 - st * OWN_ANGLE) * (1 - air);
    // Spread under load + edge both skis into the carve; the spread and edge
    // narrow to zero while flying (skis tuck together, tips level).
    const spread = Math.abs(st) * OWN_SPREAD * (1 - air);
    this.ownSkiL.position.x = -0.23 - spread;
    this.ownSkiR.position.x = 0.23 + spread;
    this.ownSkiL.rotation.z = -st * OWN_EDGE * (1 - air);
    this.ownSkiR.rotation.z = -st * OWN_EDGE * (1 - air);
    // Speed vibration: two incommensurate harmonics, amplitude follows v; the
    // vibration fades in air (smooth float). The rig rises and levels in air;
    // the one-shot landing dip bounces it below the ride line once.
    const amp = (SHAKE_BASE + SHAKE_SPEED * speedFrac) * (1 - air);
    this.ownSkisRig.position.y =
      OWN_Y + air * OWN_AIR_LIFT + Math.sin(this.ownPhase) * amp - this.ownLand * OWN_LAND_DIP;
    this.ownSkisRig.position.x = Math.sin(this.ownPhase * 0.63 + 1.7) * amp * 0.6;
    this.ownSkisRig.rotation.x = OWN_RIDE_PITCH - (OWN_RIDE_PITCH - OWN_AIR_PITCH) * air;
    this.ownSkisRig.rotation.z = -st * 0.06 * (1 - air);
  }

  /**
   * R4v2 air seam for the first-person rig: while airborne the own skis tuck
   * up + level (eased over ~AIR_TAU); on the grounded edge the rig dips once
   * (a small landing spring) then rides again. Repeated calls with the same
   * state are no-ops.
   */
  setOwnAirborne(on: boolean): void {
    if (this.ownAirTarget === on) return;
    this.ownAirTarget = on;
    if (!on) this.ownLand = 1;
  }

  /** Remove every remote and free the own-skis rig's geometry. */
  dispose(): void {
    for (const id of [...this.remotes.keys()]) this.remove(id);
    this.ownSkisRig.removeFromParent();
    disposeGeometries(this.ownSkisRig);
  }
}

/**
 * One own-rig ski pivot: ski + upturned tip + boot toe-piece, baked. R4v2
 * detail: a `paper` top-sheet stripe + `ink` sidewall + a visible binding.
 */
function ownSkiPivot(side: number): THREE.Group {
  const proto = new THREE.Group();
  // Camera space: forward is -Z, so the ski body runs mostly ahead of the boot.
  proto.add(at(box(mat, 0.13, 0.04, 2.1, SPAL.rockLit), 0, 0, -0.45));
  proto.add(at(box(mat, 0.13, 0.045, 0.5, SPAL.ink), 0, -0.005, -0.2)); // sidewall band
  proto.add(at(box(mat, 0.09, 0.012, 1.8, SPAL.paper), 0, 0.026, -0.45)); // top-sheet stripe
  const tip = at(box(mat, 0.13, 0.04, 0.26, SPAL.rockLit), 0, 0.07, -1.6);
  tip.rotation.x = 0.5;
  proto.add(tip);
  proto.add(at(box(mat, 0.12, 0.04, 0.5, SPAL.ink), 0, 0.04, -0.1)); // binding
  proto.add(at(box(mat, 0.16, 0.15, 0.24, SPAL.ink), 0, 0.1, 0.1)); // boot toe-piece
  const bakedG = bake(proto);
  disposeGeometries(proto);
  const pivot = new THREE.Group();
  pivot.position.set(side * 0.23, 0, 0);
  pivot.add(bakedG);
  return pivot;
}
