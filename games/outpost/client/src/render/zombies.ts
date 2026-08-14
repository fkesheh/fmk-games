// ============================================================================
// render/zombies.ts — THE HORDE.
//
// Four kinds, distinguishable at 40 m by SILHOUETTE alone (STYLE_BIBLE's
// silhouette table): shambler = hunched lowercase "n", runner = an upright
// arrow, brute = a "T" twice as wide as anything else with one oversized arm,
// spitter = a lightbulb on legs. Colour is a SECOND, value-based mechanism on
// top of shape — rotPale on chest/skull/forearms stays lighter than the
// pineDeep treeline and mudDark ground at any distance through any fog, which
// is what makes the horde pixel gate (VISUAL_GATES.minHordePixelShare)
// reachable instead of the previous build's measured 0.00%.
//
// LOD & pooling (this is the draw-call budget):
//   - NEAR (< HORDE.nearLodDist, capped at HORDE.nearLodMax nearest overall,
//     not per kind): a live, pivot-anchored THREE.Group per zombie, pooled —
//     HORDE.nearLodMax slots pre-built PER KIND at construction (worst case
//     all nearLodMax simultaneous zombies are the same kind), never rebuilt.
//     Each slot's STATIC sub-parts (torso, head, each limb) are merged with
//     the shared `bake()` helper at construction time via `mergeStatic()`
//     below — bake()'s own "static parts merge, animate parts stay live"
//     contract, just applied one pivot at a time so the pivots themselves
//     stay live for per-frame rotation while everything rigid inside a pivot
//     collapses to one draw call per material.
//   - FAR (everything else): ONE static baked pose per kind, turned into an
//     InstancedMesh per material bucket (via the SAME `bake()` call, this
//     time over the whole rig with nothing marked `animate` — it can't tell
//     the difference between "many small rigid parts" and "one pivot", it
//     just merges by material either way) and driven by per-instance
//     matrices with a gait-phase bob, per STYLE_BIBLE / CONTRACT.md's
//     InstancedMesh mandate. No live limb animation at range — a baked mesh
//     bobbing on gait phase is the frozen, explicitly-endorsed compromise.
//
// Materials per kind are EXACTLY the six the STYLE_BIBLE's horde row names,
// and no more (a material is a draw call in the near path and a bucket in the
// far path):
//   rotPale  — skull/brow/jaw, forearms + hands, ribcage/sternum/rib panels.
//              The silhouette tier: the parts that break the horizon first.
//   rotFlesh — the body mass: pelvis, hip flare, clavicles, deltoids, neck,
//              upper arms, the spitter's barrel. STYLE_BIBLE §"reads by VALUE"
//              is explicit that SHOULDERS and the remaining torso are rotFlesh
//              and only chest/skull/forearms are rotPale; the upper arm belongs
//              to the body mass, and putting the value break at the ELBOW is
//              what stops an arm reading as one pale plank.
//   rotDark  — thighs, knees, shins, torn-coat detail.
//   rotDeep  — the contact band: heel + toe. The fourth ladder tier was defined
//              in palette.ts for exactly this and was previously unused here,
//              so every zombie's ground line was one flat rotDark value.
//   zeye     — emissive eyes, kept live and unbaked so their world scale can
//              grow with camera distance.
//   gore     — only on the ~50% of pooled slots whose variant calls for it.
// contactShadow()'s PALETTE.ink is shared game-wide infrastructure, not
// counted against the per-kind budget.
//
// DRAW CALLS. Splitting the arm (rotFlesh/rotPale) and the leg
// (rotDark/rotDeep) adds 4 merged buckets per articulated zombie, i.e. 56 at
// HORDE.nearLodMax. That is paid for by NOT casting real-time shadows from the
// two DETAIL buckets — the rotDeep foot and the rotFlesh upper arm — via
// `mergeStatic`'s `noShadow` argument. Those two are small, low-contrast and
// sit inside the shadow the torso/legs/head already cast; the character's
// grounding comes from its baked `contactShadow()` disc either way (STYLE_BIBLE
// mandates that disc precisely because it is the cheap stand-in). The big
// silhouette masses still cast, so the horde still lays shadows across the mud.
//
// Per-slot variation (STYLE_BIBLE: "a wave of 40 never reads as 40 clones")
// is baked in at POOL-CONSTRUCTION time via a seeded `vrng()` per slot —
// height jitter ±8% and exactly one asymmetric detail — rather than rebuilt
// per zombie id, which would violate the no-hot-path-allocation rule. With
// only nearLodMax (14) simultaneous articulated zombies, 14 distinct fixed
// variants per kind is already the entire population a player can see
// close-up in one frame.
// ============================================================================

import * as THREE from 'three';
import { PALETTE, mat, box, cyl, sphere, at, contactShadow, bake, vrng } from '../contract/visual.js';
import { HORDE } from '@outpost/shared';
import type { ZombieSnap, ZombieKind, ZombieState } from '@outpost/shared';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const KINDS: readonly ZombieKind[] = ['shambler', 'runner', 'brute', 'spitter'];

const KIND_SEED: Record<ZombieKind, number> = {
  shambler: 1000,
  runner: 2000,
  brute: 3000,
  spitter: 4000,
};

/**
 * Emissive eye world-size at zero distance, and growth per metre of camera
 * distance, so it never falls below ~3 px on screen. Derived for BASE_FOV
 * 75deg (STYLE_BIBLE) over a ~900px-tall viewport: worldSize(d) for a target
 * of 3 px is ~0.0051*d; 0.006 keeps a small margin. Near-LOD only — far-LOD
 * eyes share one baked, fixed-size instance geometry (see FAR_EYE_SIZE)
 * since InstancedMesh cannot vary geometry per instance.
 */
const EYE_BASE_SIZE = 0.055;
const EYE_GROWTH_PER_M = 0.006;
/** Far zombies are always >= HORDE.nearLodDist away; size the eye for that. */
const FAR_EYE_SIZE = 0.16;

/** Seconds for the death collapse to finish (near AND far). No `dyingFor` is
 *  on the wire (CONTRACT GAP — see summary), so this is a local, per-zombie-id
 *  clock advanced by `dt`, reset whenever a zombie is observed NOT dying. */
const DEATH_COLLAPSE_SEC = 1.1;

// ---------------------------------------------------------------------------
// Per-kind body plan — STYLE_BIBLE's silhouette table, in metres/radians.
// Heights are chosen to sum to roughly ZOMBIE_BASE[kind].height; widths are
// deliberately stylised beyond ZOMBIE_BASE[kind].radius (PRESENTATION ONLY —
// every actor still collides as the same 0.6 m box, per CONTRACT.md).
// ---------------------------------------------------------------------------

interface KindSpec {
  legLen: number;
  legRadius: number;
  torsoLen: number;
  bodyDepth: number;
  headRadius: number;
  hipWidth: number;
  shoulderWidth: number;
  /** Ribcage width as a fraction of `shoulderWidth` — how much of the shoulder
   *  span is actual chest and how much is deltoid/clavicle mass hung off it.
   *  Low on the brute (a huge yoke of shoulder around a modest chest) and on
   *  the spitter (a pinched chest over the barrel — the bulb's neck). */
  chestWidthMul: number;
  /** Hip mass width as a multiple of `hipWidth`, so the pelvis reads as its own
   *  block rather than the bottom of the torso box. */
  hipFlare: number;
  /** Neck cylinder radius. Distinctly under both headRadius and chest depth —
   *  the neck is what makes a head read as attached rather than balanced. */
  neckRadius: number;
  /** Head pivot offset from the top of the torso, in torso-local metres.
   *  `headDropY` NEGATIVE puts the skull BELOW the shoulder line (the
   *  shambler's and the brute's whole silhouette rule); `headPushZ` negative
   *  pushes it FORWARD of the chest (-Z is the facing direction — the runner's
   *  arrowhead), positive pulls it back over the spine (the spitter). These are
   *  POSITIONAL, not rotational: rotation alone left three of the four kinds
   *  with their head in the same place on the same neck. */
  headDropY: number;
  headPushZ: number;
  armRadius: number;
  armUpperLen: number;
  armForeLen: number;
  /** Multiplier applied to the oversized-arm side's length + radius. */
  armLenScale: number;
  oversizedArmSide: 'L' | 'R' | null;
  /** Rest pose, radians. POSITIVE torso/head lean = tipped FORWARD, over the
   *  toes. (Applied as a NEGATIVE rotation.x: +X rotation carries +Y toward
   *  +Z, and +Z is the zombie's BACK. The old table read `torsoLeanRest: 0.55`
   *  on the "hunched" shambler and leant it 31 degrees BACKWARDS, head
   *  trailing behind its hips — visible in a profile capture.) */
  torsoLeanRest: number;
  headLeanRest: number;
  /** Positive swings the hands FORWARD; negative sweeps them back (runner). */
  armRestAngle: number;
  /** Gait amplitudes, radians. */
  strideAmp: number;
  armSwingAmp: number;
  lurchAmp: number;
  attackSwingAmp: number;
  /** Spitter's distended barrel torso — a scale on the belly sphere, 0 = none. */
  barrel: number;
}

const KIND_SPECS: Record<ZombieKind, KindSpec> = {
  // "n": hunched hard over the toes, high rounded shoulders, skull slung BELOW
  // and AHEAD of the shoulder line on a downward neck, long arms hanging slack
  // toward the knees, wide hips and a heavy roll. The two uprights of the "n" are the
  // legs; the arch is the back, and the head hangs off the front of it.
  shambler: {
    legLen: 0.82, legRadius: 0.125, torsoLen: 0.84, bodyDepth: 0.32, headRadius: 0.155,
    hipWidth: 0.48, shoulderWidth: 0.66, chestWidthMul: 0.80, hipFlare: 1.20,
    neckRadius: 0.072, headDropY: -0.22, headPushZ: -0.30,
    armRadius: 0.090, armUpperLen: 0.36, armForeLen: 0.35, armLenScale: 1, oversizedArmSide: null,
    torsoLeanRest: 0.44, headLeanRest: 0.34, armRestAngle: 0.12,
    strideAmp: 0.5, armSwingAmp: 0.12, lurchAmp: 0.26, attackSwingAmp: 0.9,
    barrel: 0,
  },
  // arrow: tall, narrow and lean, running on the balls of long thin legs, the
  // skull thrust a quarter-metre AHEAD of the chest on a nearly horizontal
  // neck, both arms locked back behind the hips. Head = point, arms = flights.
  runner: {
    legLen: 1.08, legRadius: 0.072, torsoLen: 0.58, bodyDepth: 0.21, headRadius: 0.125,
    hipWidth: 0.26, shoulderWidth: 0.36, chestWidthMul: 0.84, hipFlare: 1.04,
    neckRadius: 0.055, headDropY: 0.01, headPushZ: -0.28,
    armRadius: 0.058, armUpperLen: 0.31, armForeLen: 0.29, armLenScale: 1, oversizedArmSide: null,
    torsoLeanRest: 0.40, headLeanRest: 0.10, armRestAngle: -1.30,
    strideAmp: 0.95, armSwingAmp: 0.55, lurchAmp: 0.03, attackSwingAmp: 1.1,
    barrel: 0,
  },
  // "T" twice as wide as anything else: a 1.62 m yoke of shoulder on a 2.4 m
  // frame — 2.5x the shambler's span — a head under three quarters the radius
  // of the shambler's, SUNK below the clavicle line so the shoulders read as
  // one unbroken bar, and one arm 1.75x the other dragging at knee height.
  brute: {
    legLen: 1.28, legRadius: 0.205, torsoLen: 1.14, bodyDepth: 0.50, headRadius: 0.115,
    hipWidth: 0.62, shoulderWidth: 1.62, chestWidthMul: 0.70, hipFlare: 1.14,
    neckRadius: 0.075, headDropY: -0.17, headPushZ: -0.03,
    armRadius: 0.128, armUpperLen: 0.52, armForeLen: 0.48, armLenScale: 1.75, oversizedArmSide: 'R',
    torsoLeanRest: 0.14, headLeanRest: 0.08, armRestAngle: 0.10,
    strideAmp: 0.30, armSwingAmp: 0.10, lurchAmp: 0.06, attackSwingAmp: 1.3,
    barrel: 0,
  },
  // lightbulb on legs: a gourd of a belly three times the width of its own
  // shoulders, pinched to a narrow chest, a head tipped back off the top of it,
  // all balanced on two wire-thin legs. Leans BACK so the barrel leads.
  spitter: {
    legLen: 1.00, legRadius: 0.066, torsoLen: 0.72, bodyDepth: 0.34, headRadius: 0.15,
    hipWidth: 0.24, shoulderWidth: 0.32, chestWidthMul: 0.70, hipFlare: 1.0,
    neckRadius: 0.058, headDropY: 0.05, headPushZ: 0.07,
    armRadius: 0.050, armUpperLen: 0.28, armForeLen: 0.26, armLenScale: 1, oversizedArmSide: null,
    torsoLeanRest: -0.12, headLeanRest: -0.55, armRestAngle: 0.05,
    strideAmp: 0.45, armSwingAmp: 0.16, lurchAmp: 0.10, attackSwingAmp: 0.6,
    barrel: 1,
  },
};

// ---------------------------------------------------------------------------
// Per-slot variant — "one asymmetric detail" (STYLE_BIBLE), fixed forever at
// pool-construction time.
// ---------------------------------------------------------------------------

type Variant = 'none' | 'missingForearm' | 'hangingJaw' | 'goreWound' | 'tornCoat';

function pickVariant(rand: () => number): Variant {
  const r = rand();
  if (r < 0.25) return 'missingForearm';
  if (r < 0.5) return 'hangingJaw';
  if (r < 0.75) return 'goreWound';
  return 'tornCoat';
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function newPivot(x: number, y: number, z: number): THREE.Group {
  return at(new THREE.Group(), x, y, z);
}

function addChild(parent: THREE.Object3D, mesh: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh {
  at(mesh, x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/**
 * Bake `group`'s children down to one mesh per material, IN PLACE. Only for
 * a subtree with no further live sub-parts — every pivot's own contents.
 *
 * `noShadow` lists palette tiers whose merged bucket must NOT cast a real-time
 * shadow (`bake()` sets `castShadow` on everything it emits). See the file
 * header: this is how the two extra material splits this rig needs — the
 * rotDeep foot and the rotFlesh upper arm — are paid for. Both are small,
 * sit inside the shadow their own limb's main bucket already casts, and the
 * figure's grounding is the baked `contactShadow()` disc regardless.
 * Compared by material IDENTITY, which is exact: `mat()` is a cache keyed on
 * the hex, so every mesh built from the same PALETTE key shares one instance.
 */
function mergeStatic(group: THREE.Group, noShadow: readonly string[] = []): void {
  const baked = bake(group);
  for (let i = group.children.length - 1; i >= 0; i--) {
    const c = group.children[i];
    if (c) group.remove(c);
  }
  const muted = noShadow.map((hex) => mat(hex) as THREE.Material);
  for (const child of baked.children) {
    if (child instanceof THREE.Mesh && muted.includes(child.material as THREE.Material)) {
      child.castShadow = false;
    }
    group.add(child);
  }
}

/**
 * Hip pivot down: thigh, knee, shin, then a two-part FOOT on the contact tier.
 *
 * The foot was one small box canted 0.8 radii BEHIND the ankle — a stub that
 * pointed the wrong way (-Z is the facing direction) and shared the legs'
 * single rotDark value, so every figure met the ground on a flat tone. It is
 * now a taller heel block behind the ankle and a long low toe slab in front of
 * it, both `rotDeep`: the palette's fourth tier, defined as "contact band,
 * deep creases" and previously unused anywhere in this file.
 */
function buildLeg(spec: KindSpec): THREE.Group {
  const g = new THREE.Group();
  const r = spec.legRadius;
  const thighLen = spec.legLen * 0.50;
  const shinLen = spec.legLen * 0.50;
  const ankleY = -thighLen - shinLen;
  addChild(g, cyl(r * 1.08, r * 0.84, thighLen, 6, PALETTE.rotDark), 0, -thighLen / 2, 0);
  addChild(g, box(r * 1.42, r * 0.86, r * 1.42, PALETTE.rotDark), 0, -thighLen, 0);
  addChild(g, cyl(r * 0.80, r * 0.54, shinLen, 6, PALETTE.rotDark), 0, -thighLen - shinLen / 2, 0);
  addChild(g, box(r * 1.45, r * 0.86, r * 1.15, PALETTE.rotDeep), 0, ankleY - r * 0.28, r * 0.46);
  addChild(g, box(r * 1.32, r * 0.58, r * 2.15, PALETTE.rotDeep), 0, ankleY - r * 0.46, -r * 0.72);
  mergeStatic(g, [PALETTE.rotDeep]);
  return g;
}

/**
 * Shoulder pivot down: rotFlesh upper arm + elbow, then a hard-tapered rotPale
 * forearm, wrist and hand. The value break lands ON THE ELBOW, which is the
 * whole point — the previous arm was one uniform rotPale cylinder pair and at
 * any range read as a bright plank hung off the torso, the single loudest
 * "stack of boxes" tell on the model.
 */
function buildArm(upperLen: number, foreLen: number, radius: number, missing: boolean): THREE.Group {
  const g = new THREE.Group();
  addChild(g, cyl(radius * 1.06, radius * 0.82, upperLen, 6, PALETTE.rotFlesh), 0, -upperLen / 2, 0);
  addChild(g, box(radius * 1.5, radius * 0.9, radius * 1.5, PALETTE.rotFlesh), 0, -upperLen, 0);
  if (!missing) {
    addChild(g, cyl(radius * 0.78, radius * 0.46, foreLen, 6, PALETTE.rotPale), 0, -upperLen - foreLen / 2, 0);
    addChild(g, sphere(radius * 0.44, 6, PALETTE.rotPale), 0, -upperLen - foreLen, 0);
    addChild(
      g,
      box(radius * 1.1, radius * 1.3, radius * 0.8, PALETTE.rotPale),
      0,
      -upperLen - foreLen - radius * 0.7,
      -radius * 0.2,
    );
  } else {
    addChild(g, box(radius * 1.25, radius * 0.9, radius * 1.25, PALETTE.rotPale), 0, -upperLen - radius * 0.45, 0);
  }
  mergeStatic(g, [PALETTE.rotFlesh]);
  return g;
}

/** Skull + a heavy brow slab (the eyes sit in its shade) + jaw. One material. */
function buildHead(spec: KindSpec, hangingJaw: boolean): THREE.Group {
  const g = new THREE.Group();
  const r = spec.headRadius;
  const skull = sphere(r, 6, PALETTE.rotPale);
  skull.scale.set(1, 0.96, 0.92);
  addChild(g, skull, 0, r * 0.9, 0);
  addChild(g, box(r * 1.46, r * 0.34, r * 0.62, PALETTE.rotPale), 0, r * 1.32, -r * 0.6);
  const jaw = box(r * 0.78, r * 0.46, r * 0.68, PALETTE.rotPale);
  if (hangingJaw) {
    at(jaw, 0, r * 0.15, -r * 0.45);
    jaw.rotation.x = -0.95;
  } else {
    at(jaw, 0, r * 0.55, -r * 0.38);
    jaw.rotation.x = -0.12;
  }
  jaw.castShadow = true;
  jaw.receiveShadow = true;
  g.add(jaw);
  mergeStatic(g);
  return g;
}

/** eL/eR are kept LIVE and UNMERGED (no `mergeStatic` here) so each can have
 *  its own `.scale` mutated per-frame for distance-independent apparent size
 *  WITHOUT also scaling its offset from the head centre. Scaling a mesh only
 *  grows its geometry about its own local origin — its `position` (the
 *  head-relative offset baked in via `at()`) is untouched by that mesh's own
 *  scale. Merging them (as before) baked both eyes' offsets into one shared
 *  geometry relative to the GROUP's origin, so scaling the group scaled the
 *  offsets too, pushing the eyes outside the skull at high eyeScale. The
 *  far-LOD path still bakes this same group (via `bake(rig.root)` in
 *  `buildFarBucket`), producing the same fixed merged geometry as before. */
function buildEyePair(spec: KindSpec, eyeSize: number): { group: THREE.Group; eyeL: THREE.Mesh; eyeR: THREE.Mesh } {
  const g = new THREE.Group();
  const r = spec.headRadius;
  const eL = box(eyeSize, eyeSize, eyeSize * 0.35, PALETTE.zeye, { emissive: PALETTE.zeye });
  const eR = box(eyeSize, eyeSize, eyeSize * 0.35, PALETTE.zeye, { emissive: PALETTE.zeye });
  at(eL, -r * 0.38, r * 0.95, -r * 0.88);
  at(eR, r * 0.38, r * 0.95, -r * 0.88);
  eL.castShadow = false;
  eL.receiveShadow = false;
  eR.castShadow = false;
  eR.receiveShadow = false;
  g.add(eL, eR);
  return { group: g, eyeL: eL, eyeR: eR };
}

function applyVariantToTorso(torsoStatic: THREE.Group, spec: KindSpec, variant: Variant, rand: () => number): void {
  const side = rand() < 0.5 ? -1 : 1;
  if (variant === 'goreWound') {
    // On the rib panel's outer face, torn open between two ribs.
    const wound = box(spec.shoulderWidth * 0.20, spec.torsoLen * 0.17, 0.05, PALETTE.gore);
    at(wound, side * spec.shoulderWidth * 0.22, spec.torsoLen * 0.62, -spec.bodyDepth * 0.52 - 0.03);
    wound.rotation.y = side * 0.44;
    wound.castShadow = true;
    wound.receiveShadow = true;
    torsoStatic.add(wound);
  } else if (variant === 'tornCoat') {
    const tail = box(0.12, spec.torsoLen * 0.5, 0.05, PALETTE.rotDark);
    at(tail, side * spec.hipWidth * 0.55, spec.torsoLen * 0.15, spec.bodyDepth * 0.35);
    tail.rotation.z = side * 0.35;
    tail.castShadow = true;
    tail.receiveShadow = true;
    torsoStatic.add(tail);
  }
}

interface Rig {
  root: THREE.Group;
  /** Everything that moves during death collapse (legs/torso/head), as a
   *  sibling of the ground contact shadow rather than a parent of it — see
   *  `applyDeathCollapse`. */
  bodyPivot: THREE.Group;
  torsoPivot: THREE.Group;
  headPivot: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  eyePair: THREE.Group;
  eyeL: THREE.Mesh;
  eyeR: THREE.Mesh;
}

function buildRig(spec: KindSpec, rand: () => number, eyeSize: number, variant: Variant): Rig {
  const root = new THREE.Group();
  // Sibling of the contact shadow (added to `root` directly, below) so death
  // collapse — which rotates/sinks `bodyPivot` — never tilts the shadow disc
  // off the ground plane. Mirrors survivors.ts's root/body split.
  const bodyPivot = new THREE.Group();
  root.add(bodyPivot);

  const legL = newPivot(-spec.hipWidth / 2, spec.legLen, 0);
  legL.add(buildLeg(spec));
  const legR = newPivot(spec.hipWidth / 2, spec.legLen, 0);
  legR.add(buildLeg(spec));
  bodyPivot.add(legL, legR);

  const torsoPivot = newPivot(0, spec.legLen, 0);
  bodyPivot.add(torsoPivot);

  const pelvisH = spec.torsoLen * 0.40;
  const chestH = spec.torsoLen * 0.60;
  const shoulderY = pelvisH + chestH * 0.86;
  const chestW = spec.shoulderWidth * spec.chestWidthMul;

  // ---- torso: hips -> waist -> keeled ribcage -> clavicle/deltoid yoke ----
  // Every piece here is rigid relative to `torsoPivot`, so `mergeStatic` below
  // collapses all of it to ONE draw call per material however many primitives
  // it is. The old torso was four boxes: a pelvis slab, a chest slab, and two
  // flat vertical strips at the shoulders. A slab-fronted chest is the exact
  // "solid colour swatch" tell STYLE_BIBLE names, and flat-shaded Lambert
  // turns every added edge into a free value break, so this spends the
  // primitive budget (24-40 per zombie) on the four reads that make a low-poly
  // figure legible as a BODY: a hip block wider than the waist above it, a
  // ribcage broken by a proud sternum keel and two front-angled rib panels,
  // clavicles running out to the shoulder points, and deltoid caps that carry
  // the shoulder line all the way to where the arms actually hang.
  const torsoStatic = new THREE.Group();

  // hips — a distinct block, deliberately WIDER than both the waist above and
  // the pelvis body, so the hip line reads as its own mass and not as the
  // bottom edge of one long torso box.
  addChild(torsoStatic, box(spec.hipWidth * 0.86, pelvisH * 0.94, spec.bodyDepth * 0.88, PALETTE.rotFlesh), 0, pelvisH * 0.47, 0);
  addChild(
    torsoStatic,
    box(spec.hipWidth * spec.hipFlare, pelvisH * 0.44, spec.bodyDepth * 1.02, PALETTE.rotFlesh),
    0,
    pelvisH * 0.78,
    0,
  );
  // waist — the pinch between the hip block and the ribcage.
  addChild(
    torsoStatic,
    box(spec.hipWidth * 0.62, pelvisH * 0.30, spec.bodyDepth * 0.68, PALETTE.rotFlesh),
    0,
    pelvisH * 1.02,
    0,
  );

  // ribcage — core box plus a sternum keel and two front-angled panels, so the
  // chest silhouette from any angle is a shallow chevron rather than a slab.
  // The core runs from the waist all the way UP INTO the shoulder line — a
  // ribcage that stops short leaves a void the yoke floats over, which is
  // exactly what the first pass at this looked like.
  addChild(torsoStatic, box(chestW, chestH * 0.88, spec.bodyDepth * 0.92, PALETTE.rotPale), 0, pelvisH + chestH * 0.48, 0);
  // sternum keel: a flat plate standing proud of the chest face, so the front
  // of the ribcage carries a lit centre strip and two shaded flanks instead of
  // one even quad.
  addChild(
    torsoStatic,
    box(chestW * 0.40, chestH * 0.72, spec.bodyDepth * 0.36, PALETTE.rotPale),
    0,
    pelvisH + chestH * 0.44,
    -spec.bodyDepth * 0.44,
  );
  // two rib panels raked off the keel — shallow enough that their faces still
  // take the key light, steep enough to break the chest's outline into a
  // chevron from the front and a bevel from the side.
  for (const side of [-1, 1] as const) {
    const panel = box(chestW * 0.42, chestH * 0.62, spec.bodyDepth * 0.30, PALETTE.rotPale);
    at(panel, side * chestW * 0.30, pelvisH + chestH * 0.46, -spec.bodyDepth * 0.34);
    panel.rotation.y = side * 0.28;
    panel.castShadow = true;
    panel.receiveShadow = true;
    torsoStatic.add(panel);
  }

  // clavicle + deltoid yoke — rotFlesh per STYLE_BIBLE ("shoulders and
  // remaining torso rotFlesh"), which also means the pale chest is framed by a
  // darker shoulder mass instead of merging into it. Both OVERLAP the top of
  // the ribcage rather than perching above it.
  for (const side of [-1, 1] as const) {
    // The pair leaves a deliberate notch at x=0 for the neck to rise through:
    // clavicles carried all the way to the centreline swallowed the head whole
    // and every kind came out no-necked, the head embedded in one shoulder blob.
    const clav = box(spec.shoulderWidth * 0.40, chestH * 0.30, spec.bodyDepth * 0.80, PALETTE.rotFlesh);
    at(clav, side * spec.shoulderWidth * 0.32, shoulderY - chestH * 0.12, -spec.bodyDepth * 0.06);
    clav.rotation.z = -side * 0.10;
    clav.castShadow = true;
    clav.receiveShadow = true;
    torsoStatic.add(clav);

    const delt = box(spec.shoulderWidth * 0.20, chestH * 0.46, spec.bodyDepth * 0.94, PALETTE.rotFlesh);
    at(delt, side * spec.shoulderWidth * 0.45, shoulderY - chestH * 0.16, 0);
    delt.rotation.z = -side * 0.10;
    delt.castShadow = true;
    delt.receiveShadow = true;
    torsoStatic.add(delt);
  }

  // neck — a short, narrow cylinder aimed from the top of the ribcage at
  // wherever this kind's head pivot actually sits, so a head slung low and
  // forward (shambler) or thrust ahead (runner) or sunk between the shoulders
  // (brute, where the neck ends up buried and correctly invisible) is CARRIED
  // rather than floating.
  const neckBaseY = spec.torsoLen - chestH * 0.16;
  const neckDY = spec.torsoLen + spec.headDropY - neckBaseY;
  const neckDZ = spec.headPushZ;
  const neckSpan = Math.max(Math.hypot(neckDY, neckDZ), spec.headRadius * 0.6);
  const neck = cyl(spec.neckRadius * 0.88, spec.neckRadius * 1.12, neckSpan + spec.headRadius * 0.7, 6, PALETTE.rotFlesh);
  at(neck, 0, neckBaseY + neckDY / 2, neckDZ / 2);
  neck.rotation.x = Math.atan2(neckDZ, neckDY);
  neck.castShadow = true;
  neck.receiveShadow = true;
  torsoStatic.add(neck);

  if (spec.barrel > 0) {
    const bulge = sphere(spec.bodyDepth * 0.95, 8, PALETTE.rotFlesh);
    bulge.scale.set(1.42 * spec.barrel, 1.12 * spec.barrel, 1.26 * spec.barrel);
    addChild(torsoStatic, bulge, 0, pelvisH + chestH * 0.34, 0);
  }
  applyVariantToTorso(torsoStatic, spec, variant, rand);
  mergeStatic(torsoStatic);
  torsoPivot.add(torsoStatic);

  const armL = newPivot(-spec.shoulderWidth / 2, shoulderY, 0);
  const armR = newPivot(spec.shoulderWidth / 2, shoulderY, 0);
  armL.rotation.x = spec.armRestAngle;
  armR.rotation.x = spec.armRestAngle;
  const missingSide: 'L' | 'R' | null = variant === 'missingForearm' ? (rand() < 0.5 ? 'L' : 'R') : null;

  const upperL = spec.oversizedArmSide === 'L' ? spec.armUpperLen * spec.armLenScale : spec.armUpperLen;
  const foreL = spec.oversizedArmSide === 'L' ? spec.armForeLen * spec.armLenScale : spec.armForeLen;
  const radiusL = spec.oversizedArmSide === 'L' ? spec.armRadius * spec.armLenScale : spec.armRadius;
  armL.add(buildArm(upperL, foreL, radiusL, missingSide === 'L'));

  const upperR = spec.oversizedArmSide === 'R' ? spec.armUpperLen * spec.armLenScale : spec.armUpperLen;
  const foreR = spec.oversizedArmSide === 'R' ? spec.armForeLen * spec.armLenScale : spec.armForeLen;
  const radiusR = spec.oversizedArmSide === 'R' ? spec.armRadius * spec.armLenScale : spec.armRadius;
  armR.add(buildArm(upperR, foreR, radiusR, missingSide === 'R'));

  torsoPivot.add(armL, armR);

  // Head POSITION, not just head rotation — see KindSpec.headDropY/headPushZ.
  // `applyGait` reasserts the y every frame (plus its walk bob) via
  // `headRestY()`; the z is a rest offset nothing animates.
  const headPivot = newPivot(0, headRestY(spec), spec.headPushZ);
  headPivot.rotation.x = -spec.headLeanRest;
  headPivot.add(buildHead(spec, variant === 'hangingJaw'));
  const eyeParts = buildEyePair(spec, eyeSize);
  headPivot.add(eyeParts.group);
  torsoPivot.add(headPivot);

  // The disc tracks the footprint, not the shoulder span: at the brute's
  // 1.8 m yoke the old `shoulderWidth * 0.55` painted a 1 m radius puddle that
  // reached well past anything touching the ground.
  root.add(contactShadow(Math.max(spec.hipWidth, spec.shoulderWidth * 0.5) * 0.62));

  return {
    root,
    bodyPivot,
    torsoPivot,
    headPivot,
    armL,
    armR,
    legL,
    legR,
    eyePair: eyeParts.group,
    eyeL: eyeParts.eyeL,
    eyeR: eyeParts.eyeR,
  };
}

// ---------------------------------------------------------------------------
// Animation — pure functions of (state, gait). DEATH is the one deliberate
// exception: no `dyingFor` on the wire, so collapse progress comes from a
// local per-zombie-id clock advanced by `dt` (see DEATH_COLLAPSE_SEC).
// ---------------------------------------------------------------------------

/** Rest height of the head pivot in torso-local space. Was a bare
 *  `spec.torsoLen` for every kind, which is why "head below the shoulder line"
 *  and "head thrust forward" were rotation-only approximations. */
function headRestY(spec: KindSpec): number {
  return spec.torsoLen + spec.headDropY;
}

function applyGait(rig: Rig, spec: KindSpec, state: ZombieState, gait: number): void {
  const phase = gait * Math.PI * 2;
  if (state === 'attackFence' || state === 'attackPlayer') {
    const swing = Math.max(0, Math.sin(phase));
    const primary = spec.oversizedArmSide === 'L' ? rig.armL : rig.armR;
    const other = spec.oversizedArmSide === 'L' ? rig.armR : rig.armL;
    primary.rotation.x = spec.armRestAngle - swing * spec.attackSwingAmp;
    other.rotation.x = spec.armRestAngle - swing * spec.attackSwingAmp * 0.3;
    // Negated: +rotation.x carries the torso's top toward +Z, which is its
    // BACK. Lunging into a swing leans FORWARD, so the swing term adds to the
    // forward lean rather than cancelling it. (See KindSpec.torsoLeanRest.)
    rig.torsoPivot.rotation.x = -(spec.torsoLeanRest + swing * 0.22);
    rig.torsoPivot.rotation.z = 0;
    rig.legL.rotation.x = Math.sin(phase) * spec.strideAmp * 0.25;
    rig.legR.rotation.x = -Math.sin(phase) * spec.strideAmp * 0.25;
    rig.headPivot.rotation.x = -(spec.headLeanRest + swing * 0.12);
    rig.headPivot.position.y = headRestY(spec);
    return;
  }
  // approach / pursue: walk cycle (shambler's wide stagger is the torso roll).
  rig.legL.rotation.x = Math.sin(phase) * spec.strideAmp;
  rig.legR.rotation.x = -Math.sin(phase) * spec.strideAmp;
  rig.armL.rotation.x = spec.armRestAngle - Math.sin(phase) * spec.armSwingAmp;
  rig.armR.rotation.x = spec.armRestAngle + Math.sin(phase) * spec.armSwingAmp;
  rig.torsoPivot.rotation.x = -spec.torsoLeanRest;
  rig.torsoPivot.rotation.z = Math.sin(phase) * spec.lurchAmp;
  rig.headPivot.rotation.x = -spec.headLeanRest;
  rig.headPivot.position.y = headRestY(spec) + Math.abs(Math.sin(phase)) * 0.02;
}

/** `p` is 0..1 collapse progress. Blends additively on top of whatever
 *  `applyGait` last set, so death interrupts a walk/attack pose naturally. */
function applyDeathCollapse(rig: Rig, p: number): void {
  const e = p * p;
  // Rotate/sink `bodyPivot`, NOT `root` — `root` also parents the flat
  // ground contact shadow (see buildRig), which must stay glued to the
  // ground plane throughout the collapse, not tilt up with the corpse.
  rig.bodyPivot.rotation.x = e * (Math.PI * 0.42);
  rig.bodyPivot.position.y += -e * 0.12;
  rig.legL.rotation.x += e * -0.25;
  rig.legR.rotation.x += e * 0.25;
  rig.armL.rotation.x += e * -0.5;
  rig.armR.rotation.x += e * 0.5;
}

// ---------------------------------------------------------------------------
// Pooling structures
// ---------------------------------------------------------------------------

interface NearSlot {
  rig: Rig;
  kind: ZombieKind;
  /** -1 = free. */
  zid: number;
}

function disposeGeometries(obj: THREE.Object3D): void {
  if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  for (const child of obj.children) disposeGeometries(child);
}

// ---------------------------------------------------------------------------
// ZombieModels — the public surface (CONTRACT.md)
// ---------------------------------------------------------------------------

export class ZombieModels {
  private readonly scene: THREE.Scene;

  private readonly nearPool: Record<ZombieKind, NearSlot[]>;
  private readonly assigned = new Map<number, NearSlot>();
  private readonly nearIds = new Set<number>();

  private readonly farBuckets: Record<ZombieKind, THREE.InstancedMesh[]>;
  private readonly farCount: Record<ZombieKind, number>;

  /** Local death-collapse clock, seconds, indexed by ZombieId (dense, stable
   *  while a zombie lives — see CONTRACT.md's `ZombieId` doc). */
  private readonly deathT: Float32Array;

  // scratch — no per-frame allocation
  private readonly idxScratch: Int32Array;
  private readonly distScratch: Float32Array;
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly scratchEuler = new THREE.Euler();
  private readonly scratchScale = new THREE.Vector3(1, 1, 1);
  private readonly scratchMatrix = new THREE.Matrix4();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.nearPool = { shambler: [], runner: [], brute: [], spitter: [] };
    this.farBuckets = { shambler: [], runner: [], brute: [], spitter: [] };
    this.farCount = { shambler: 0, runner: 0, brute: 0, spitter: 0 };
    this.deathT = new Float32Array(HORDE.maxAlive);
    this.idxScratch = new Int32Array(HORDE.maxAlive);
    this.distScratch = new Float32Array(HORDE.maxAlive);

    for (const kind of KINDS) {
      this.nearPool[kind] = this.buildNearPool(kind);
      this.farBuckets[kind] = this.buildFarBucket(kind);
    }
  }

  /** Float32Array reads are `number | undefined` under noUncheckedIndexedAccess
   *  even though every call site here passes an in-bounds index; centralised
   *  so the fallback (0 — "just started dying") is stated once. */
  private deathAt(id: number): number {
    return this.deathT[id] ?? 0;
  }

  /** Same rationale as `deathAt`; Infinity fallback sorts an out-of-bounds
   *  read to the back rather than corrupting the nearest-N selection. */
  private distAt(i: number): number {
    return this.distScratch[i] ?? Number.POSITIVE_INFINITY;
  }

  private buildNearPool(kind: ZombieKind): NearSlot[] {
    const spec = KIND_SPECS[kind];
    const slots: NearSlot[] = [];
    for (let i = 0; i < HORDE.nearLodMax; i++) {
      const rand = vrng(KIND_SEED[kind] + i);
      const variant = pickVariant(rand);
      const rig = buildRig(spec, rand, EYE_BASE_SIZE, variant);
      const jitter = 1 + (rand() * 2 - 1) * 0.08;
      rig.root.scale.setScalar(jitter);
      rig.root.visible = false;
      this.scene.add(rig.root);
      slots.push({ rig, kind, zid: -1 });
    }
    return slots;
  }

  private buildFarBucket(kind: ZombieKind): THREE.InstancedMesh[] {
    const spec = KIND_SPECS[kind];
    const rand = vrng(KIND_SEED[kind] + 900);
    const rig = buildRig(spec, rand, FAR_EYE_SIZE, 'none');
    applyGait(rig, spec, 'approach', 0.25);
    const baked = bake(rig.root);
    const meshes: THREE.InstancedMesh[] = [];
    const deepMat = mat(PALETTE.rotDeep) as THREE.Material;
    for (const child of baked.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const im = new THREE.InstancedMesh(child.geometry, child.material, HORDE.maxAlive);
      im.count = 0;
      // The contact-band bucket is the same detail tier the near rig mutes
      // (see mergeStatic's `noShadow`), and at > HORDE.nearLodDist a boot sole
      // cannot resolve a shadow anyway.
      im.castShadow = child.material !== deepMat;
      im.receiveShadow = true;
      im.frustumCulled = false; // instances are scattered across the map; the
      // base geometry's own bounding sphere (centred near the model origin)
      // would otherwise cull the whole batch based on the wrong bounds.
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(im);
      meshes.push(im);
    }
    return meshes;
  }

  sync(zs: readonly ZombieSnap[], camPos: THREE.Vector3, dt: number): void {
    const n = Math.min(zs.length, HORDE.maxAlive);
    for (let i = 0; i < n; i++) {
      const z = zs[i];
      if (z === undefined) {
        this.idxScratch[i] = i;
        this.distScratch[i] = Number.POSITIVE_INFINITY;
        continue;
      }
      const dx = z.x - camPos.x;
      const dy = z.y - camPos.y;
      const dz = z.z - camPos.z;
      this.distScratch[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this.idxScratch[i] = i;
      if (z.id >= 0 && z.id < HORDE.maxAlive) {
        this.deathT[z.id] = z.st === 'dying' ? this.deathAt(z.id) + dt : 0;
      }
    }

    const order = this.idxScratch.subarray(0, n);
    order.sort((a, b) => this.distAt(a) - this.distAt(b));

    this.nearIds.clear();
    let nearCount = 0;
    for (let k = 0; k < n && nearCount < HORDE.nearLodMax; k++) {
      const i = order[k];
      if (i === undefined) continue;
      if (this.distAt(i) > HORDE.nearLodDist) continue;
      const z = zs[i];
      if (z === undefined) continue;
      this.nearIds.add(z.id);
      nearCount++;
    }

    for (const kind of KINDS) {
      for (const slot of this.nearPool[kind]) {
        if (slot.zid !== -1 && !this.nearIds.has(slot.zid)) {
          slot.rig.root.visible = false;
          this.assigned.delete(slot.zid);
          slot.zid = -1;
        }
      }
    }

    for (const kind of KINDS) this.farCount[kind] = 0;

    for (let i = 0; i < zs.length; i++) {
      const z = zs[i];
      if (z === undefined) continue;
      if (this.nearIds.has(z.id)) {
        this.syncNear(z, camPos);
      } else {
        this.syncFar(z);
      }
    }

    for (const kind of KINDS) {
      const count = this.farCount[kind];
      for (const im of this.farBuckets[kind]) {
        im.count = count;
        im.instanceMatrix.needsUpdate = true;
      }
    }
  }

  private syncNear(z: ZombieSnap, camPos: THREE.Vector3): void {
    let slot = this.assigned.get(z.id);
    if (slot === undefined) {
      const pool = this.nearPool[z.k];
      let found: NearSlot | undefined;
      for (const s of pool) {
        if (s.zid === -1) {
          found = s;
          break;
        }
      }
      if (found === undefined) return; // pool sized to HORDE.nearLodMax per
      // kind, and nearIds is capped at HORDE.nearLodMax total, so this never
      // actually happens — kept as a no-throw guard, not a crash.
      found.zid = z.id;
      found.rig.root.visible = true;
      this.assigned.set(z.id, found);
      slot = found;
    }

    const spec = KIND_SPECS[z.k];
    slot.rig.root.position.set(z.x, z.y, z.z);
    slot.rig.root.rotation.y = z.yaw;
    // Reset the collapse transform on `bodyPivot` (not `root`, which no
    // longer carries it — see applyDeathCollapse) so a zombie that stops
    // dying, or hasn't started, doesn't retain a stale tilt/sink.
    slot.rig.bodyPivot.rotation.x = 0;
    slot.rig.bodyPivot.position.y = 0;
    applyGait(slot.rig, spec, z.st, z.g);
    if (z.st === 'dying' && z.id >= 0 && z.id < HORDE.maxAlive) {
      const p = Math.min(1, this.deathAt(z.id) / DEATH_COLLAPSE_SEC);
      applyDeathCollapse(slot.rig, p);
    }

    const headH = spec.legLen + spec.torsoLen;
    const dx = z.x - camPos.x;
    const dy = z.y + headH - camPos.y;
    const dz = z.z - camPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const eyeScale = (EYE_BASE_SIZE + dist * EYE_GROWTH_PER_M) / EYE_BASE_SIZE;
    // Scale each eye mesh individually (about its own local origin), NOT the
    // `eyePair` group's transform — the group scale would also scale each
    // eye's baked head-relative offset, floating them outside the skull at
    // high eyeScale. See buildEyePair.
    slot.rig.eyeL.scale.setScalar(eyeScale);
    slot.rig.eyeR.scale.setScalar(eyeScale);
  }

  private syncFar(z: ZombieSnap): void {
    const count = this.farCount[z.k];
    if (count >= HORDE.maxAlive) return;

    let tiltX = 0;
    let sinkY = 0;
    if (z.st === 'dying' && z.id >= 0 && z.id < HORDE.maxAlive) {
      const p = Math.min(1, this.deathAt(z.id) / DEATH_COLLAPSE_SEC);
      const e = p * p;
      tiltX = e * (Math.PI * 0.42);
      sinkY = -e * 0.12;
    }
    const bob = Math.sin(z.g * Math.PI * 4) * 0.03;

    this.scratchEuler.set(tiltX, z.yaw, 0);
    this.scratchQuat.setFromEuler(this.scratchEuler);
    this.scratchPos.set(z.x, z.y + bob + sinkY, z.z);
    this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);

    for (const im of this.farBuckets[z.k]) {
      im.setMatrixAt(count, this.scratchMatrix);
    }
    this.farCount[z.k] = count + 1;
  }

  clear(): void {
    for (const kind of KINDS) {
      for (const slot of this.nearPool[kind]) {
        slot.rig.root.visible = false;
        slot.zid = -1;
      }
      for (const im of this.farBuckets[kind]) {
        im.count = 0;
        im.instanceMatrix.needsUpdate = true;
      }
      this.farCount[kind] = 0;
    }
    this.assigned.clear();
    this.nearIds.clear();
    this.deathT.fill(0);
  }

  dispose(): void {
    for (const kind of KINDS) {
      for (const slot of this.nearPool[kind]) {
        this.scene.remove(slot.rig.root);
        disposeGeometries(slot.rig.root);
      }
      this.nearPool[kind] = [];
      for (const im of this.farBuckets[kind]) {
        this.scene.remove(im);
        im.geometry.dispose();
        im.dispose();
      }
      this.farBuckets[kind] = [];
      this.farCount[kind] = 0;
    }
    this.assigned.clear();
    this.nearIds.clear();
  }
}
