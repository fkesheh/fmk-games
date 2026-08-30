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
// Two skis (rockLit lit deck + rock shade sidewall/base + sunGold top-sheet
// stripe + binding + boot) at frame bottom, angling/spreading with steer,
// vibrating with speed. Body presence without a body. In air (setOwnAirborne)
// the rig tucks: it rises, tips level, spread/edge/vibration fade; on the
// grounded edge a one-shot dip (the land spring) fires.
//
// ART-DIRECTOR ROUND 3 — TWO DEFECTS FIXED HERE, both visible in
// docs/splat-v3/round-2/v3-descent.png:
//
//   (a) BLACK BLOCKS. The rig was built almost entirely from SPAL.ink
//       (#10141c, linear luma ~0.007 — a UI-text value, not an object
//       value). At ~0.7% of snow's albedo NO legal amount of light lifts it
//       out of the ACES toe, so boots/gloves rendered as unshaded black
//       silhouettes. This is NOT the round-0 "no ambient floor" problem —
//       scene.ts already carries the §12.5a.2 ambient floor (snowShade @
//       0.38) plus a 1.35 hemisphere; the defect was pure albedo.
//       FIX: the whole rig is now painted on the rock value ladder —
//       `rock` (#6b7280) shade tier, `rockLit` (#9aa2b0) lit tier, `paper`
//       cuff, `sunGold` top-sheet — with the lit/shade split BUILT INTO THE
//       GEOMETRY (lit facets on the up/outward faces, shade bodies below).
//       That split cannot come from the sun: SUN_AZ=1.05 puts the key ahead
//       and to the right, so every camera-FACING face of a first-person rig
//       is back-lit by construction. Flat-shaded low-poly answers this by
//       painting the ladder, not by asking the light for it. `ink` no
//       longer appears anywhere in the first-person rig.
//
//   (b) FRAME DOMINANCE (§V3.7: "the body never occupies more than the
//       bottom quarter"). The previous frustum fix moved the anchor to
//       OWN_Y=-0.56 / OWN_Z=-1.85 — a distant MINIATURE, which put the
//       boots and gloves at the vertical CENTRE of frame (measured ~y=400px
//       of 720 in the round-2 capture). Perspective, not size, decides
//       frame height: NDC_y = y / (|z| * tan(fov/2)), so a rig 1.85 m ahead
//       of the eye must hang implausibly low to stay down in the frame.
//       FIX: the anchor returns to a REALISTIC first-person station (low
//       and near, OWN_Y/OWN_Z below) and the geometry is re-authored so no
//       vertex sits above NDC_y = -0.5 at the WIDEST speed FOV
//       (BASE_FOV + SPEED_FOV_MAX = 83°, the descent-shot case — a wider
//       FOV pulls the rig UP toward the centre, so it is the binding case,
//       not BASE_FOV). The rig lower edge deliberately runs off the bottom
//       of the frame, as a real first-person body does.
//
// FRUSTUM: the old anchor was chosen so every rig vertex stayed inside the
// frustum, because the failure it was fixing was "the hands never appear".
// The real hazard there is whole-MESH frustum culling (a bounding sphere
// entirely outside the frustum pops the ski out), not per-vertex clipping —
// vertices below the bottom plane are simply rasterised away, which is what
// a first-person body is supposed to do. So the constraint is dropped and
// replaced by `frustumCulled = false` on every baked rig mesh, which makes
// the whole class of pop impossible. Nothing in the rig may sit behind the
// camera though: the ski tail (local z max) must keep |world z| > near
// (0.1 m) — with OWN_Z=-0.80 and a tail at local z=+0.35 it sits at 0.45 m.
//
// FIRST-PERSON BODY PRESENCE (W5, STYLE_BIBLE §V3.7): two gloved hands
// (`rock` glove with a `rockLit` knuckle facet and the §V3.7 `paper` cuff)
// + poles are children of the SAME ownSkisRig — never a
// second camera.add, which would need an app.ts edit (out of scope). Past a
// |steer| threshold the inside pole (the side matching the turn direction)
// swings down and back on an eased ~0.4 s arc (pole plant); both hands ease
// toward an up-and-back air pose as setOwnAirborne blends in, mirroring the
// §V2.4 remote air-pose direction. The skis additionally flex up to 1.5°
// under carve load and chatter ±0.3° at ~18 Hz scaling with v/MAX_SPEED, both
// fading to zero in air. All of it falls out of the existing
// setOwnSkis(steer, v, dt) / setOwnAirborne(on) signals — no new seam.
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
// The anchor is a REALISTIC first-person station — low (below the eye) and
// near — because frame height is set by perspective, not by size: a point at
// (y, z) lands at NDC_y = y / (|z| * tan(fov/2)). §V3.7 caps the body at the
// bottom quarter (NDC_y <= -0.5) and the binding case is the WIDEST FOV the
// speed ramp reaches (BASE_FOV + SPEED_FOV_MAX = 83deg, tan = 0.885) — wide
// FOV shrinks |NDC| and pulls the rig UP toward the centre. Worked example,
// the ski tip (the rig's highest point, local y 0.099 / z -1.263 after the
// tip upturn): rig pitch lifts it to y=-1.005, |z|=2.055 in camera space, so
// NDC_y = -0.553 -> 559 px of 720 — inside the bottom quarter, and at
// BASE_FOV it drops to 628 px rather than leaving the frame.
const OWN_Y = -1.18; // eye-relative height of the ski deck (frame bottom)
const OWN_Z = -0.8; // distance from camera — a real boot station, not a prop
const OWN_STANCE_X = 0.24; // half-stance: lateral offset of each ski pivot
const OWN_SPREAD = 0.07; // extra lateral split at full lock
const OWN_ANGLE = 0.22; // ski yaw at full lock
const OWN_EDGE = 0.28; // ski edging roll at full lock
const SHAKE_BASE = 0.004; // idle vibration (m)
const SHAKE_SPEED = 0.014; // added vibration at MAX_SPEED
// Own-skis air: the rig rides tips-down (OWN_RIDE_PITCH), levels + lifts in air.
// The pitch flattening cancels most of the air lift at the tip, so the air
// shot (FOV 87 with the +4 punch) still holds the tip below NDC_y = -0.5.
const OWN_RIDE_PITCH = 0.06; // rig rotation.x at rest (tips dip away)
const OWN_AIR_PITCH = 0.0; // rig rotation.x while flying (tips level)
const OWN_AIR_LIFT = 0.06; // m the rig rises while flying (skis tuck up)
const OWN_LAND_TAU = 0.18; // s — one-shot landing dip duration
const OWN_LAND_DIP = 0.045; // m — dip depth on the grounded edge

// Ski flex + chatter (STYLE_BIBLE §V3.7): a small extra pitch on each ski
// pivot, on top of the existing edge/spread terms above. Flex is a slow bend
// under carve load; chatter is a fast tremor at speed. Both fade to zero in
// air (no snow contact to load or chatter against).
const FLEX_MAX_RAD = 0.0262; // 1.5deg — flex ceiling under full carve load
const CHATTER_AMP_RAD = 0.00524; // 0.3deg — chatter amplitude ceiling
const CHATTER_HZ = 18; // chatter oscillation frequency

// Own hands + poles (STYLE_BIBLE §V3.7): two camera-space pivots, children of
// ownSkisRig (never a separate camera.add — that would need an app.ts edit,
// out of scope), gloved (`rock` + a `rockLit` knuckle facet) with a `paper`
// cuff, holding a pole that rakes forward-down out of the fist.
// X/Y are set by the same NDC arithmetic as the rig anchor: at the widest
// speed FOV the gloves land at ~(198, 1082) px horizontally — the lower frame
// corners §V3.7 asks for — with the cuff crown at ~586 px, inside the bottom
// quarter; at BASE_FOV only the cuff and knuckles clear the bottom edge.
const OWN_HAND_X = 0.85; // lateral offset from centre — the frame corners
const OWN_HAND_Y_LOCAL = 0.61; // m above the rig origin (OWN_Y) — above the skis
const OWN_HAND_Z_LOCAL = -0.02; // m, local to the rig origin (OWN_Z)
const HAND_IDLE_PITCH = 0.18; // rad — resting forward-down arm tilt
// Pole plant: past this |steer|, the inside pole (the side matching the turn
// direction, mirroring the +steer->+x convention used for the ski edge above)
// swings down and back, eased over ~0.4 s (STYLE_BIBLE "hard carve").
const POLE_PLANT_THRESH = 0.55; // |steer| that counts as a hard carve
const POLE_PLANT_TAU = 0.4; // s — eased plant/release arc
const POLE_PLANT_PITCH = 0.2; // rad — extra downward swing when planted
const POLE_PLANT_BACK = 0.07; // m — the planted pole trails back toward camera
// Air pose (mirrors the §V2.4 remote air pose direction: torso/arms uprighting
// and lifting): hands come up and back, the idle forward tilt reverses.
const HAND_AIR_LIFT = 0.06; // m — hands rise while flying (capped by §V3.7)
const HAND_AIR_BACK = -0.08; // m — hands pull back toward the body while flying
const HAND_AIR_PITCH = -0.28; // rad — arms swing up/back (reverses the idle tilt)

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
  private readonly ownHandL: THREE.Group;
  private readonly ownHandR: THREE.Group;
  private ownSteerVis = 0;
  private ownPhase = 0;
  private ownChatterPhase = 0; // ski-chatter oscillator, ~18 Hz (STYLE_BIBLE §V3.7)
  private ownAirVis = 0; // eased air blend 0..1 (setOwnAirborne)
  private ownAirTarget = false; // desired air state
  private ownLand = 0; // one-shot landing dip 1 -> 0
  private ownPlantL = 0; // eased pole-plant amount 0..1, left pole
  private ownPlantR = 0; // eased pole-plant amount 0..1, right pole

  constructor(world: THREE.Scene) {
    this.world = world;
    this.ownSkisRig = new THREE.Group();
    this.ownSkisRig.position.set(0, OWN_Y, OWN_Z);
    this.ownSkisRig.rotation.x = OWN_RIDE_PITCH; // tips dip away — the downhill read
    this.ownSkiL = ownSkiPivot(-1);
    this.ownSkiR = ownSkiPivot(1);
    this.ownHandL = ownHandPivot(-1);
    this.ownHandR = ownHandPivot(1);
    this.ownSkisRig.add(this.ownSkiL, this.ownSkiR, this.ownHandL, this.ownHandR);
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
    this.ownSkiL.position.x = -OWN_STANCE_X - spread;
    this.ownSkiR.position.x = OWN_STANCE_X + spread;
    this.ownSkiL.rotation.z = -st * OWN_EDGE * (1 - air);
    this.ownSkiR.rotation.z = -st * OWN_EDGE * (1 - air);
    // Ski flex + chatter (STYLE_BIBLE §V3.7): flex bends the tip under carve
    // load (|steer| x speed, both grounded-only proxies for load); chatter is
    // a ~18 Hz tremor whose amplitude scales linearly with v/MAX_SPEED. Both
    // are additive on top of the edge/spread rotation above and fade to zero
    // in air. One shared oscillator for both skis (they chatter in phase).
    this.ownChatterPhase += dt * CHATTER_HZ * Math.PI * 2;
    const ground = 1 - air;
    const load = Math.min(1, Math.abs(st) * speedFrac);
    const chatter = Math.sin(this.ownChatterPhase) * CHATTER_AMP_RAD * speedFrac * ground;
    const flex = load * FLEX_MAX_RAD * ground + chatter;
    this.ownSkiL.rotation.x = flex;
    this.ownSkiR.rotation.x = flex;
    // Speed vibration: two incommensurate harmonics, amplitude follows v; the
    // vibration fades in air (smooth float). The rig rises and levels in air;
    // the one-shot landing dip bounces it below the ride line once.
    const amp = (SHAKE_BASE + SHAKE_SPEED * speedFrac) * (1 - air);
    this.ownSkisRig.position.y =
      OWN_Y + air * OWN_AIR_LIFT + Math.sin(this.ownPhase) * amp - this.ownLand * OWN_LAND_DIP;
    this.ownSkisRig.position.x = Math.sin(this.ownPhase * 0.63 + 1.7) * amp * 0.6;
    this.ownSkisRig.rotation.x = OWN_RIDE_PITCH - (OWN_RIDE_PITCH - OWN_AIR_PITCH) * air;
    this.ownSkisRig.rotation.z = -st * 0.06 * (1 - air);

    // Hands + poles (STYLE_BIBLE §V3.7): the inside pole (the side matching
    // the turn direction, same +steer->+x convention as the ski edge above)
    // swings down and back on a hard carve, eased over ~POLE_PLANT_TAU; both
    // hands ease toward the air pose (up + back, idle tilt reversed) as `air`
    // rises, mirroring the §V2.4 remote air-pose direction.
    const pk = Math.min(1, dt / POLE_PLANT_TAU);
    const plantTargetL = st < -POLE_PLANT_THRESH ? 1 : 0;
    const plantTargetR = st > POLE_PLANT_THRESH ? 1 : 0;
    this.ownPlantL += (plantTargetL - this.ownPlantL) * pk;
    this.ownPlantR += (plantTargetR - this.ownPlantR) * pk;
    for (const [hand, plant] of [
      [this.ownHandL, this.ownPlantL],
      [this.ownHandR, this.ownPlantR],
    ] as const) {
      const idlePitch = HAND_IDLE_PITCH + plant * POLE_PLANT_PITCH;
      hand.rotation.x = idlePitch - (idlePitch - HAND_AIR_PITCH) * air;
      hand.position.y = OWN_HAND_Y_LOCAL + air * HAND_AIR_LIFT;
      hand.position.z = OWN_HAND_Z_LOCAL + plant * POLE_PLANT_BACK * ground + air * HAND_AIR_BACK;
    }
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
 * One own-rig ski pivot: ski + bevelled steel edge + upturned tip + binding +
 * boot cuff + lower shin, baked. STYLE_BIBLE §V3.7 art-director fix round 2:
 * a coloured (`sunGold`) top-sheet replaces the neutral `paper` one (same
 * material COUNT — a straight swap, budget-neutral against the pre-v3
 * baseline), a `rockLit` bevelled edge strip runs each outer edge of the
 * plank (the brightest grey in the ski's own palette, reading as a struck
 * steel edge under flat Lambert; merges into the already-existing `rockLit`
 * bucket, so it costs nothing extra), and the boot grows a cuff + a length of
 * shin (both `ink`, same bucket as the toe-piece/binding) so the closest
 * object to the camera reads as *worn gear on a leg*, not a flat grey slab.
 * Materials: rockLit (plank/tip/edge/buckle), ink (sidewall/binding/boot/
 * cuff/shin), sunGold (topsheet) — 3 buckets, same count as before the fix.
 */
function ownSkiPivot(side: number): THREE.Group {
  const proto = new THREE.Group();
  // Camera space: forward is -Z, so the ski body runs ahead of the boot.
  // Length/centre are chosen with the NDC arithmetic in the OWN_Y comment:
  // a longer ski puts its tip further away, and a further tip rides HIGHER in
  // frame (NDC_y = y / (|z| tan)), which is what breaks the §V3.7 quarter.
  const LEN = 1.4; // tail at local z +0.35, tip at -1.05
  const CZ = -0.35; // ski centre in z
  // The value ladder is PAINTED, not lit: the shade tier (rock) is the base +
  // sidewall mass, the lit tier (rockLit) is the deck that faces the sky. A
  // camera-facing first-person rig is back-lit by SUN_DIR by construction, so
  // this split is the only thing that keeps the object from reading flat.
  proto.add(at(box(mat, 0.142, 0.05, LEN, SPAL.rock), 0, -0.016, CZ)); // base + sidewall (shade)
  proto.add(at(box(mat, 0.132, 0.03, LEN, SPAL.rockLit), 0, 0.024, CZ)); // deck (lit)
  proto.add(at(box(mat, 0.076, 0.014, LEN * 0.78, SPAL.sunGold), 0, 0.042, CZ - 0.06)); // top-sheet
  // Bevelled steel edge: a thin angled strip along each outer edge of the
  // plank in the SHADE tier, so the chamfer reads as a value break against
  // the lit deck even where the sun never reaches it.
  for (const edge of [-1, 1]) {
    const bevel = at(box(mat, 0.016, 0.05, LEN * 0.95, SPAL.rock), edge * 0.072, -0.02, CZ);
    bevel.rotation.z = -edge * 0.4;
    proto.add(bevel);
  }
  // Upturned tip: shallow (0.3 rad, was 0.5) — every degree of upturn lifts
  // the rig's highest point further up the frame.
  const tip = at(box(mat, 0.132, 0.034, 0.3, SPAL.rockLit), 0, 0.055, -1.12);
  tip.rotation.x = 0.3;
  proto.add(tip);
  const tipShade = at(box(mat, 0.138, 0.026, 0.28, SPAL.rock), 0, 0.026, -1.11);
  tipShade.rotation.x = 0.3;
  proto.add(tipShade); // the tip's underside — grounds the upturn
  // Contact shading where the boot meets the ski: a darker (shade-tier) plate
  // laid ON the lit deck under the binding. This is the contact-AO note the
  // judge called out as missing — an object with no darkening at its base
  // reads as floating decal, not as a thing standing on another thing.
  proto.add(at(box(mat, 0.136, 0.008, 0.46, SPAL.rock), 0, 0.041, -0.28));
  proto.add(at(box(mat, 0.12, 0.036, 0.3, SPAL.rock), 0, 0.058, -0.3)); // binding rail
  proto.add(at(box(mat, 0.108, 0.05, 0.1, SPAL.rock), 0, 0.06, -0.14)); // heel block
  // Boot: shade body, lit facets on the up-facing planes. Sits at local
  // z=-0.30 so its crown clears the bottom clip plane at speed FOV (the
  // §V1 "boot toe-pieces visible at frame bottom" read) while the deck it
  // stands on is still cropped away below.
  proto.add(at(box(mat, 0.152, 0.13, 0.3, SPAL.rock), 0, 0.14, -0.3)); // toe-piece (shade)
  proto.add(at(box(mat, 0.138, 0.022, 0.26, SPAL.rockLit), 0, 0.212, -0.31)); // toe upper (lit)
  proto.add(at(box(mat, 0.158, 0.14, 0.19, SPAL.rock), 0, 0.22, -0.19)); // cuff (shade)
  proto.add(at(box(mat, 0.144, 0.026, 0.17, SPAL.rockLit), 0, 0.298, -0.2)); // cuff crown (lit)
  proto.add(at(box(mat, 0.166, 0.022, 0.03, SPAL.rockLit), 0, 0.25, -0.28)); // buckle strap (lit)
  const bakedG = bake(proto);
  disposeGeometries(proto);
  bakedG.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      c.castShadow = false; // camera-space rig: no shadow-pass cost (§12.3e)
      c.frustumCulled = false; // the rig straddles the bottom clip plane
    }
  });
  const pivot = new THREE.Group();
  pivot.position.set(side * OWN_STANCE_X, 0, 0);
  pivot.add(bakedG);
  return pivot;
}

/**
 * One own-rig hand+pole pivot: a gloved fist (ink) with a paper cuff, holding
 * a trailing pole with a basket (STYLE_BIBLE §V3.7 — NOT the player slot
 * colour; the local slot never reaches this file). Baked to 2 meshes (ink,
 * paper) so both sides together cost exactly the +4 draw-call allowance.
 * Explicitly non-shadow-casting: the rig is camera-space body presence, not a
 * world object, and W5's budget assumes no shadow-pass cost per §12.3e.
 * `side` is -1 (left) or +1 (right); the pivot itself carries the plant swing
 * and air-pose animation set every frame in setOwnSkis().
 */
function ownHandPivot(side: number): THREE.Group {
  const proto = new THREE.Group();
  // Glove on the rock ladder: shade body, lit knuckle facet on the up/outward
  // face, `paper` cuff (the one §V3.7 colour call-out). NOT `ink` — see the
  // file header: at 0.007 linear luma a glove is a hole in the frame, and it
  // sits at 0.8 m from the eye where a hole is unmissable.
  proto.add(at(sphere(mat, 0.065, 6, SPAL.rock), 0, 0, 0)); // glove (shade)
  const knuckle = at(box(mat, 0.078, 0.024, 0.095, SPAL.rockLit), side * 0.012, 0.046, -0.012);
  knuckle.rotation.z = -side * 0.25;
  proto.add(knuckle); // lit facet — the light-catching top of the fist
  proto.add(at(cyl(mat, 0.062, 0.064, 0.05, 6, SPAL.paper), 0, 0.072, 0)); // cuff
  // NO forearm. Tried and reverted (round-3 capture 2): a 0.4 m arm running
  // back toward the camera swells under perspective exactly as fast as the
  // frustum shrinks, and rendered as two grey slabs reaching the middle of
  // the frame — the §V3.7 violation this whole task exists to remove. The
  // hand ends at the cuff; anything closer to the eye than the cuff cannot
  // be drawn small.
  // Pole raking forward-DOWN out of the fist. The angle is load-bearing: any
  // forward run raises a point in frame (NDC_y = y / (|z| tan)), so a shallow
  // pole puts its basket ABOVE the fist and reads upside-down. At this angle
  // the basket lands ~700px vs the fist's ~640px — pole down, as it should be.
  const shaft = at(cyl(mat, 0.012, 0.012, 0.5, 4, SPAL.rock), 0, -0.217, -0.124);
  shaft.rotation.x = 0.52;
  proto.add(shaft);
  const basket = at(cyl(mat, 0.038, 0.038, 0.014, 6, SPAL.rock), 0, -0.4, -0.23);
  basket.rotation.x = 0.52;
  proto.add(basket);
  const bakedG = bake(proto);
  disposeGeometries(proto);
  bakedG.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      c.castShadow = false; // camera-space: no shadow cost
      c.frustumCulled = false; // the hands straddle the bottom clip plane
    }
  });
  const pivot = new THREE.Group();
  pivot.position.set(side * OWN_HAND_X, OWN_HAND_Y_LOCAL, OWN_HAND_Z_LOCAL);
  pivot.rotation.x = HAND_IDLE_PITCH;
  pivot.rotation.z = side * 0.12; // poles splay outward from the body
  pivot.add(bakedG);
  return pivot;
}
