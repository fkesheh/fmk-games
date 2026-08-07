// ============================================================================
// ANCIENTS (rift) — NEUTRAL JUNGLE CAMP MESHES (R_MESH_CAMP).
//
// `buildCamp(tier)` is the single archetype factory for the three neutral camp
// tiers — `campPack`, `campBrute`, `campHive` (DESIGN_DELTA §2, tuned in
// shared/src/config.ts as CAMP_PACK / CAMP_BRUTE / CAMP_HIVE). R_UNITS calls it
// ONCE PER TIER at init and pools the result; never per entity, never per
// frame. Nothing here is cached internally, because two callers must get two
// independent `THREE.Group`s — a Group can only have one parent.
//
// ---- NEUTRAL, AND THAT IS A GAMEPLAY FACT ----------------------------------
// The signature takes NO team, deliberately. These entities are `NEUTRAL_TEAM`
// (`EntTeam` 2), and a player reading one as an enemy creep mis-reads the whole
// board: they walk into a camp thinking it is a pushing wave, or they ignore a
// wave thinking it is a camp. So nothing in this file touches `azure`, `ember`
// or any hero accent. The only saturated colour on any of the three is the
// venom `neutral` ladder (APAL.neutral, the yellow-green that sits >= 38 deg
// from every team colour on the wheel precisely so this read cannot fail), and
// it arrives as a bioluminescent glow, which is also what makes the camps the
// brightest neutral thing in the jungle at night (STYLE_BIBLE §4).
// `camps.test.ts` asserts that no material on any tier — albedo OR emissive —
// carries any of the six team hexes.
//
// ---- THE READ: MASS AND HEIGHT (STYLE_BIBLE §7) ----------------------------
// "Deliberately non-humanoid. Beasts, not soldiers." A player decides whether a
// camp is safe BEFORE committing, and they decide it from the silhouette at
// gameplay zoom, so the three tiers are separated on the two cues that survive
// at 40 px: how much ground the shape covers, and how far up it goes.
//
//   pack    0.91 m tall, 1.44 m long, 0.59 m wide, four legs. A LOW HORIZONTAL
//           DASH — the only tier that is longer than it is tall. Reads from
//           above as a narrow ellipse with four paw rectangles and a triple
//           spine spike down the midline. The entry camp; it must look cheap.
//   hive    1.62 m tall on a 0.94 x 0.72 m footprint, six legs. A VERTICAL
//           SPINDLE on a star of legs, abdomen arched up over the thorax rather
//           than trailing behind it. Six-fold radial symmetry from above is a
//           shape no soldier and no quadruped has, which is the whole point: it
//           is the ranged tier and it must never be read as the pack.
//   brute   2.31 m tall, 1.68 m across the forelimbs, 1.46 m deep, arms
//           reaching the ground. A HULK with a bear hump — two and a half
//           times the pack's height and the tallest non-structure thing in the
//           jungle. It must look expensive from across the map.
//
// Height ladder 0.91 / 1.62 / 2.31 and bar widths 0.80 / 0.95 / 1.50: both are
// monotonic, so even the HP bar alone tells the tiers apart. Every figure here
// is MEASURED off the shipped geometry through the baked buckets, not intended.
//
// ---- FOOTPRINT vs THE REST OF THE CAMP -------------------------------------
// A camp at rest is not one body, it is 3-5 of them parked on the fixed post
// ring in server/src/sim/camps.ts (POST_RING_R 1.6 m, eight fixed spokes). The
// TIGHTEST pair a tier can produce is a hard number, and a model wider than
// half of it makes a resting camp render as one merged blob:
//
//   tier   members  closest post pair          per-model half-budget
//   pack   4        90 deg  -> 2.2627 m        1.1314 m
//   brute  3        90 deg  -> 2.2627 m        1.1314 m
//   hive   5        45 deg  -> 1.2246 m        0.6123 m
//
// Two radii are measured against that budget, and both must pass:
//   * the XZ BOUNDING-BOX HALF-DIAGONAL, `hypot(width, depth) / 2` — the
//     circle that holds whatever yaw the model is spawned at, and the one the
//     reviewer measured the previous pass with;
//   * the EXACT FOOTPRINT RADIUS, `max(hypot(x, z))` over every baked vertex —
//     the true non-overlap test about the entity's own origin.
//
//   tier   halfDiag   exactR    budget
//   pack   0.778      0.808     1.1314
//   hive   0.590      0.544     0.6123
//   brute  1.112      0.945     1.1314
//
// The hive's abdomen arches UP and its head sits close because 0.61 m is all a
// 5-member camp can spend — the previous pass measured 0.920 / 0.868 against
// that budget and five of them rendered as one blob. The brute's arms and
// muzzle came in 0.10 m and 0.08 m from 1.232 / 1.025 for the same reason.
//
// ---- LAWS OBSERVED HERE ----------------------------------------------------
//  * MATERIAL LAW. Every material in this file comes from the kit's
//    `partMaterial()`, which is `bake()`'s own resolver. There is no
//    `new THREE.Mesh*Material` here and no Lambert of any kind.
//  * VERTEX-COLOUR LAW. Bodies go through `bake()`, which emits the white
//    `color` attribute itself. The two ANIM geometries do NOT pass through
//    `bake()`, so each is run through `whiteVertexColors()` before it leaves
//    this module — without it they render black under `vertexColors: true`,
//    with a perfectly clean typecheck.
//  * UV LAW. No `texture.repeat`, no `uvLocal`: baked parts take `bake()`'s
//    world-space projection at 1 UV unit = 1 metre in the build's own local
//    space (origin on the ground between the feet, +Z forward), so every
//    instance of a tier has identical UVs wherever it stands and its texel
//    density matches the jungle floor it stands on. The anim parts are the one
//    geometry `bake()` never reprojects, and they need no UV scaling either:
//    both are `crystal`, and `SURFACES.crystal` is `normal: null,
//    roughnessMap: false` with no albedo map, so it samples no texture at all.
//  * FLAT SHADING. `cliffRock` is the one flat-shaded family used here, and it
//    is used ONLY on genuinely faceted forms — chitin plates, horns, claws,
//    spikes, elytra, the hive's cranium. Hide, haunches and limbs are organic
//    curves and take the smooth-shading `leather` family (STYLE_BIBLE §2:
//    faceting a curved organic surface is a defect).
//  * BLOOM. Emissive alone does not glow. Exactly one baked bucket per tier is
//    an emissive bucket, and `assemble()` marks that bucket and asserts there
//    was exactly one; the hide, bone and chitin buckets are never marked,
//    because bloom on everything is the amateur tell STYLE_BIBLE §6 bans.
//  * DETERMINISM. There is no randomness in this file at all — the builds are
//    fixed geometry. No `Math.random`, and no `rng` needed.
//  * No per-frame allocation: everything here happens once, at init.
//
// ---- THE GLOW IS A TINTED EMISSIVE, NOT A RE-POINTED BUCKET ----------------
// AMENDMENT_3 §A: a glowing part declares `Part.emissive` and `Part.tint`, and
// `bake()` buckets by `(surfaceId, tint, emissive)` and builds the bucket
// through `emissiveSurface(id, colorKey, intensity, tint)`. The earlier version
// of this file re-pointed the baked crystal bucket at an untinted
// `emissiveSurface()` after the fact, which discarded the tint and shipped the
// venom markings at the crystal family's own cream `#c9c2ae`. They are now
// measured at `#98b45c` — APAL.neutral, albedo AND emissive.
//
// ---- READABILITY AGAINST THE GROUND ----------------------------------------
// Camps stand on jungle moss (APAL.moss, L* ~21) and the STYLE_BIBLE's whole
// readability strategy is that gameplay-relevant things out-read the world they
// stand on. A hide at the `leather` family's own albedo (APAL.trunk, L* ~27)
// gives only ~6 L* of separation from that moss and disappears at gameplay
// zoom. So both hides are tinted UP the bark ladder — the pack, which is
// smallest and needs the read most, to `barkLit` (L* ~45); the brute, which can
// afford to be menacing because its mass carries the read, to `bark` (L* ~30)
// with high-contrast bone and chitin doing the separating. Both tints are APAL
// entries, so no ad-hoc hex is introduced.
//
// ---- DRAW-CALL ARITHMETIC (GRAPHICS_CONTRACT §5, AMENDMENT_3 §D) -----------
// `bake()` merges one geometry per (surface, tint, emissive) triple, so a
// tier's BODY cost is its distinct-material count, paid per live entity. Every
// tier is held to FOUR buckets:
//
//   hide (leather, tinted) · chitin (cliffRock) · bone (monumentStone/
//   monumentLit) · glow (crystal, neutral-tinted, neutral-emissive)
//
// That is a deliberate cap, not a coincidence. The moss on the brute's hump is
// in the GLOW bucket as bioluminescent fungus rather than in a fifth `fern`
// bucket, and the pack's eyes are glow beads reusing the same bucket rather
// than minting a dark tint of their own.
//
// BUT THE BODY IS NOT THE WHOLE COST. The hive and the brute each carry ONE
// UNBAKED ANIM MESH PER ENTITY, and that is a fifth draw call on every one of
// them. The worst case, at 3 lanes, is:
//
//   CAMPS_PER_HALF[3] = 4 -> hive, brute, pack, pack per half; member counts
//   5 / 3 / 4 / 4 = 16 per half, 32 camp entities on the map. Bodies:
//   32 x 4 = 128. Anim meshes: (5 hive + 3 brute) x 2 halves = 16.
//   TOTAL 144 draw calls, not 128.
//
// Re-measured in headless Chrome on a real WebGL2 context, through
// `renderer.info.render.calls` with `autoReset = false` and the shadow pass
// included (AMENDMENT_3 §D.5) — not counted from an array — with all 32
// entities forced in frustum: **144 calls, 91 056 triangles**. Camps are not
// one of R_SCENE's four `ShadowCasterClass` values, so `applyShadowPolicy` will
// clear every caster on them and they add NOTHING to the shadow pass; the same
// scene with camp bodies casting measures 272 calls / 180 832 triangles, which
// is what admitting them to the whitelist would cost. In practice camps are
// scattered through the jungle and frustum-culled to one or two clearings.
//
// ---- BUILD COST (AMENDMENT_3 §E) -------------------------------------------
// Measured in the browser, per mode in a FRESHLY LOADED PAGE so "cold" means an
// empty `matCache` in a process that has built nothing. Five runs, full ranges:
//
//   cold, no prewarm      pack 59.9-73.8 · hive 6.3-7.6 · brute 4.1-5.1
//                         TOTAL 71.3-85.3 ms
//   after R_SCENE prewarm pack 10.4-12.7 · hive 6.6-9.0 · brute 3.9-4.5
//                         TOTAL 21.0-25.0 ms   (prewarm itself: 150-165 ms,
//                         and it is R_SCENE's budget line, not this module's)
//   warm (2nd build on)   1.6-4.4 ms per tier, 6.1-9.1 ms total
//
// Read the cold column carefully: the pack is not an expensive model, it is the
// model that happens to be built FIRST and therefore pays the shared
// first-`surface()` texture rasterisation for `leather`, `cliffRock`,
// `monumentStone` and `crystal` on behalf of the other two. The BRUTE — 39
// parts, the most of any tier — is the CHEAPEST to build. With R_SCENE's
// prewarm in place, which is the shipping configuration, all three tiers
// together cost 21-25 ms of the 80 ms AMENDMENT_3 §E.4 gives mesh builders.
// Nothing here uses `bakeChunked`: three fixed archetypes built once at init
// have no frame to bound.
//
// ---- CONTRACT_GAP: the anim part's swept volume is R_UNITS' ----------------
// `UnitBuild` carries `animKind` and `animY` but nothing about how far an anim
// part TRAVELS: `units.ts` hard-codes the orbit radius (0.55 m) and the bob
// amplitude (+/-0.30 m). This module therefore cannot state where its own anim
// part ends up, only where it rests, and it cannot keep a bobbing part clear of
// the HP bar it also sizes. Reported as a CONTRACT_GAP. Until it is closed:
//   * the brute's heart is `spin`, the one kind whose position is animY exactly
//     — a `bob` at the measured amplitude would sweep 0.30 m through both the
//     back plate below it and the HP bar above it;
//   * the hive's drone stays `orbit` (a drone that does not orbit is not a
//     drone) and is sized so that, at the current 0.55 m radius, its swept
//     circle is 0.610 m — inside the hive's 0.6122 m post half-budget.
// Every measurement in this header is of geometry this module owns.
// ============================================================================
import * as THREE from 'three';
import { APAL } from '@rift/shared/palette.js';
import type { SurfaceId } from '@rift/shared/surfaces.js';
import type { AnimPart, EmissiveSpec, Part, UnitBuild } from '../kit.js';
import { bake, box, capsule, cone, cyl, ico, markBloom, partMaterial, sphere } from '../kit.js';
import { whiteVertexColors } from '../core.js';

/** The three neutral camp tiers. Mirrors the `tier` union on `CampDef` in
 *  shared/src/terrain.ts; declared locally rather than exported so this module
 *  adds nothing to the frozen contract surface. */
type CampTier = 'pack' | 'brute' | 'hive';

// ---- the neutral identity ---------------------------------------------------

/** The one surface every glowing part on every tier renders in. */
const GLOW_SURFACE: SurfaceId = 'crystal';
/** The venom albedo. `TINT_MIX` is 1, so a tinted bucket lands on this hex
 *  exactly — measured `#98b45c` on all three tiers. */
const GLOW_TINT = APAL.neutral;
/** The emissive override carried on every glow part. `colorKey` is an APAL KEY
 *  NAME (`emissiveSurface` resolves colours by name); the intensity is pleasant
 *  by day and dominant by night (STYLE_BIBLE §4), and sits below the hero
 *  accent glow — a camp is a landmark in the jungle, not the brightest thing in
 *  the frame. That is the ancient's. */
const GLOW: EmissiveSpec = { colorKey: 'neutral', intensity: 2.6 };

/** Hide tints. Both are APAL entries; see the READABILITY note in the header
 *  for why neither hide is left at the `leather` family's own albedo. */
const PACK_HIDE = APAL.barkLit;
const BRUTE_HIDE = APAL.bark;
const HIVE_HIDE = APAL.bark;
/** Tusk, fang, mandible, claw and rib. `monumentStone` tinted up its own ladder
 *  is the palest thing on any of these beasts, which is what makes a bared jaw
 *  read at gameplay zoom. */
const BONE = APAL.monumentLit;

/** Left/right mirror driver. Every symmetric pair is emitted from one loop so a
 *  hand-tuned offset cannot drift between the two sides. */
const SIDES: readonly number[] = [-1, 1];

/** The §7 part budget for this module (BUILD_SPECS R_MESH_CAMP: 25-40 parts).
 *  Enforced in {@link assemble} rather than trusted to a comment, because a
 *  part count is the one figure in a mesh module that drifts silently. */
const MIN_PARTS = 25;
const MAX_PARTS = 40;

// ---- part helpers -----------------------------------------------------------

/** Push one opaque part. Split on `tint` because `exactOptionalPropertyTypes`
 *  forbids writing an explicit `undefined` into an optional field. */
function add(parts: Part[], geo: THREE.BufferGeometry, id: SurfaceId, tint?: string): void {
  if (tint === undefined) parts.push({ geo, surface: id });
  else parts.push({ geo, surface: id, tint });
}

/** Push one venom-glow part: tinted albedo AND an emissive override, so
 *  `bake()` gives it its own bucket and builds that bucket through
 *  `emissiveSurface('crystal', 'neutral', 2.6, '#98b45c')`. Every glow on every
 *  tier goes through here, which is what keeps the count of emissive buckets at
 *  exactly one per tier. */
function glow(parts: Part[], geo: THREE.BufferGeometry): void {
  parts.push({ geo, surface: GLOW_SURFACE, tint: GLOW_TINT, emissive: GLOW });
}

// ============================================================================
// PACK — the low quadruped scavenger (the entry camp, CAMP_PACK, 4 per camp)
// ============================================================================
//
// Measured envelope: 1.44 m nose to tail, 0.59 m across the paws, 0.905 m to
// the venom bead on the tallest spine spike, sitting flush at y 0.000. Body
// mass sits at 0.52 m — below the knee of every hero in the game, which is the
// point: this thing reads as something you step over, and that is how a player
// knows the camp is cheap.
//
// From directly above: a narrow ellipse, four paw rectangles at the corners, a
// pale skull wedge pushed forward of the shoulders, and three spike triangles
// down the midline. Nothing about that outline is a soldier. Footprint
// half-diagonal 0.778 m against a 1.1314 m budget: four packs at rest on the
// post ring never touch.

function packParts(): Part[] {
  const p: Part[] = [];

  // --- four legs. Front pair braced forward, rear pair cocked back, so even a
  //     static pose reads as mid-stride rather than as a table.
  for (const s of SIDES) {
    add(p, capsule(0.075, 0.16, { x: s * 0.2, y: 0.44, z: 0.27, rx: 0.16 }), 'leather', PACK_HIDE);
    add(p, capsule(0.085, 0.18, { x: s * 0.21, y: 0.46, z: -0.27, rx: -0.2 }), 'leather', PACK_HIDE);
    add(p, cyl(0.05, 0.065, 0.3, 8, { x: s * 0.2, y: 0.18, z: 0.3 }), 'leather', PACK_HIDE);
    add(p, cyl(0.052, 0.07, 0.32, 8, { x: s * 0.21, y: 0.17, z: -0.245 }), 'leather', PACK_HIDE);
    // splayed chitin paws — the four corner marks of the top-down read
    add(p, box(0.14, 0.08, 0.2, { x: s * 0.2, y: 0.04, z: 0.34 }), 'cliffRock');
    add(p, box(0.14, 0.08, 0.2, { x: s * 0.21, y: 0.04, z: -0.21 }), 'cliffRock');
  }

  // --- barrel body, deep chest, heavy haunch: the horizontal mass
  add(p, capsule(0.21, 0.36, { rx: Math.PI / 2, x: 0, y: 0.52, z: 0 }), 'leather', PACK_HIDE);
  add(p, sphere(0.22, 12, { sz: 0.9, x: 0, y: 0.54, z: 0.27 }), 'leather', PACK_HIDE);
  add(p, sphere(0.235, 12, { sz: 0.95, x: 0, y: 0.5, z: -0.28 }), 'leather', PACK_HIDE);
  // hackle ruff — a flared collar that widens the shoulders from above
  add(p, cyl(0.3, 0.22, 0.16, 10, { x: 0, y: 0.62, z: 0.15, rx: 0.25 }), 'leather', PACK_HIDE);
  add(p, cyl(0.11, 0.15, 0.24, 8, { x: 0, y: 0.66, z: 0.38, rx: 0.7 }), 'leather', PACK_HIDE);

  // --- skull. Bone, not hide: the head is the one part that must separate from
  //     the body at 40 px, and value does that where shape cannot.
  add(p, box(0.2, 0.17, 0.26, { x: 0, y: 0.7, z: 0.54, rx: 0.18 }), 'monumentStone', BONE);
  add(p, box(0.13, 0.11, 0.2, { x: 0, y: 0.655, z: 0.7, rx: 0.1 }), 'monumentStone', BONE);
  add(p, box(0.22, 0.05, 0.09, { x: 0, y: 0.79, z: 0.525 }), 'monumentStone', BONE);
  add(p, box(0.115, 0.06, 0.19, { x: 0, y: 0.6, z: 0.695 }), 'leather', PACK_HIDE);
  for (const s of SIDES) {
    // bared fangs, apex down past the jaw line
    add(
      p,
      cone(0.026, 0.1, 6, { x: s * 0.055, y: 0.61, z: 0.775, rx: Math.PI }),
      'monumentStone',
      BONE,
    );
    add(p, cone(0.055, 0.16, 5, { x: s * 0.1, y: 0.83, z: 0.49, rz: s * -0.35 }), 'cliffRock');
    // eyes: venom-lit beads, NOT dark sockets. They ride the glow bucket, which
    // is what makes a pack read as "alive and looking at you" in night fog.
    glow(p, ico(0.032, 0, { x: s * 0.075, y: 0.745, z: 0.645 }));
  }

  // --- dorsal spine. Three spikes down the midline: the vertical that stops a
  //     low quadruped from vanishing into the moss when seen from the 55 deg
  //     camera, and the tier's whole "do not touch me" tell.
  add(p, cone(0.05, 0.17, 5, { x: 0, y: 0.74, z: 0.22, rx: -0.3 }), 'cliffRock');
  add(p, cone(0.055, 0.2, 5, { x: 0, y: 0.76, z: 0.02, rx: -0.15 }), 'cliffRock');
  add(p, cone(0.05, 0.17, 5, { x: 0, y: 0.74, z: -0.18, rx: 0.1 }), 'cliffRock');
  // venom bead on the tallest spike — the pack's brightest light, and the point
  // of the build at y 0.905.
  glow(p, ico(0.033, 0, { x: 0, y: 0.875, z: 0.02 }));

  // --- shoulder plates and exposed flank ribs
  for (const s of SIDES) {
    add(p, box(0.1, 0.13, 0.22, { x: s * 0.19, y: 0.6, z: 0.1, rz: s * 0.3 }), 'cliffRock');
    add(p, box(0.035, 0.15, 0.3, { x: s * 0.19, y: 0.48, z: -0.06 }), 'monumentStone', BONE);
  }

  // --- tail, carried low with a chitin barb. Kept SHORT on purpose: a pack is
  //     four bodies inside a 2.5 m clearing radius (terrain.ts CAMP_CLEARING),
  //     and a trailing tail is the cheapest metre to give back.
  add(p, cyl(0.035, 0.075, 0.3, 7, { x: 0, y: 0.52, z: -0.44, rx: 1.25 }), 'leather', PACK_HIDE);
  add(p, cone(0.05, 0.12, 6, { x: 0, y: 0.6, z: -0.56, rx: 2.0 }), 'cliffRock');

  return p;
}

// ============================================================================
// HIVE — the insectile spitter (the large camp, CAMP_HIVE, 5 per camp)
// ============================================================================
//
// Measured envelope: 0.94 m leg span, 0.72 m deep, 1.62 m to the sting tip,
// feet flush at y 0.000, body mass at 0.94 m. It is the RANGED tier
// (attackRange 7.5), dangerous below level 6, so its silhouette has to say
// "swarm" from the moment it is on screen: six legs radiating from a segmented
// spindle, mandibles thrust forward, a lit venom sac slung under the abdomen.
//
// Six-fold radial symmetry from above is the tell. Neither a lane creep nor the
// pack has anything like it, and it survives all the way down to the pixel
// count where the legs merge into a star.
//
// IT IS THE MOST TIGHTLY BUDGETED MODEL IN THE FILE. Five members on the post
// ring put two of them 1.2245 m apart, so a hive may spend 0.6122 m of radius
// and no more. That is why the abdomen arches UP over the thorax instead of
// trailing behind it, why the head sits close on a short neck, and why the
// tibiae splay to 0.47 m rather than the 0.53 m the first pass drew: the tier
// buys its mass in HEIGHT, which is free, instead of in DEPTH, which is not.
// Measured half-diagonal 0.590 m, exact footprint radius 0.544 m.

function hiveParts(): Part[] {
  const p: Part[] = [];

  // --- six legs, three pairs. Femur up-and-out to a high knee, tibia down-and-
  //     out to the ground: the inverted-V that makes an insect an insect. The
  //     tibia is 0.995 m long so its foot lands ON the ground — at 0.90 m the
  //     whole build floated 4.7 cm, which reads as a hover, not a stance.
  const legZ: readonly number[] = [0.26, 0.0, -0.26];
  for (const s of SIDES) {
    for (const z of legZ) {
      add(
        p,
        capsule(0.055, 0.24, { x: s * 0.19, y: 0.98, z, rz: s * 0.95 }),
        'leather',
        HIVE_HIDE,
      );
      add(
        p,
        cyl(0.038, 0.055, 0.995, 7, { x: s * 0.355, y: 0.5, z, rz: s * -0.16 }),
        'leather',
        HIVE_HIDE,
      );
    }
  }

  // --- thorax: a soft core inside hard plates, which is how chitin actually
  //     reads and why the capsule is `leather` and the plates are `cliffRock`.
  add(p, capsule(0.18, 0.22, { rx: Math.PI / 2, x: 0, y: 0.94, z: 0.02 }), 'leather', HIVE_HIDE);
  add(p, box(0.34, 0.1, 0.42, { x: 0, y: 1.1, z: 0.02, rx: 0.06 }), 'cliffRock');
  for (const s of SIDES) {
    add(p, box(0.08, 0.2, 0.34, { x: s * 0.18, y: 0.96, z: 0.02, rz: s * -0.22 }), 'cliffRock');
  }

  // --- pedicel and the two abdomen segments. The abdomen ARCHES UP over the
  //     thorax rather than trailing behind it: a raised sting is a far stronger
  //     "this one is dangerous" read than a dragged one, and it is the only way
  //     a 1.62 m insect fits a 0.61 m radius. Measured: the sting tops the build
  //     at 1.620 m and the abdomen reaches only 0.36 m behind the origin.
  add(p, cyl(0.09, 0.11, 0.14, 8, { x: 0, y: 1.04, z: -0.14, rx: 0.9 }), 'leather', HIVE_HIDE);
  add(p, sphere(0.2, 12, { sz: 1.0, x: 0, y: 1.2, z: -0.16 }), 'leather', HIVE_HIDE);
  add(p, sphere(0.15, 12, { sz: 1.0, x: 0, y: 1.38, z: -0.2 }), 'leather', HIVE_HIDE);
  add(p, cyl(0.215, 0.215, 0.07, 10, { rx: 1.1, x: 0, y: 1.2, z: -0.15 }), 'cliffRock');
  add(p, cyl(0.17, 0.17, 0.06, 10, { rx: 0.9, x: 0, y: 1.33, z: -0.19 }), 'cliffRock');
  // elytra, half-raised — the widest part of the upper silhouette
  for (const s of SIDES) {
    add(
      p,
      box(0.1, 0.3, 0.32, { x: s * 0.15, y: 1.24, z: -0.14, rz: s * -0.55, rx: 0.35 }),
      'cliffRock',
    );
    add(
      p,
      cone(0.04, 0.14, 5, { x: s * 0.19, y: 1.22, z: -0.16, rz: s * -1.1 }),
      'monumentStone',
      BONE,
    );
  }
  // the venom sac, slung under the arch: the tier's light and the reason a
  // player can find a hive camp in the dark
  glow(p, ico(0.12, 1, { sy: 1.2, x: 0, y: 1.16, z: -0.2 }));
  // the sting, cocked up and forward over the back
  add(p, cone(0.055, 0.26, 6, { x: 0, y: 1.521, z: -0.2, rx: 0.7 }), 'monumentStone', BONE);

  // --- head, carried close on a short neck. It is thrust DOWN rather than
  //     forward: forward is the axis the post ring cannot afford.
  add(p, cyl(0.11, 0.13, 0.16, 8, { x: 0, y: 1.0, z: 0.16, rx: 1.1 }), 'leather', HIVE_HIDE);
  add(p, ico(0.165, 1, { sz: 1.1, x: 0, y: 1.02, z: 0.17 }), 'cliffRock');
  add(p, box(0.24, 0.18, 0.06, { x: 0, y: 0.99, z: 0.28, rx: 0.2 }), 'cliffRock');
  for (const s of SIDES) {
    // mandibles, apex forward and splayed — the forward silhouette break
    add(
      p,
      cone(0.05, 0.22, 6, { x: s * 0.11, y: 0.95, z: 0.24, rx: 1.7, rz: s * 0.3 }),
      'monumentStone',
      BONE,
    );
    // four compound eyes. A count no vertebrate has, at the size that survives
    // the zoom, and they are the neutral glow bucket doing double duty.
    glow(p, ico(0.05, 0, { x: s * 0.11, y: 1.09, z: 0.26 }));
    glow(p, ico(0.04, 0, { x: s * 0.14, y: 1.0, z: 0.22 }));
    // antennae, swept back over the thorax; kept fat enough not to alias
    add(
      p,
      cyl(0.04, 0.055, 0.4, 6, { x: s * 0.13, y: 1.24, z: 0.14, rx: -0.5, rz: s * -0.45 }),
      'cliffRock',
    );
  }

  return p;
}

// ============================================================================
// BRUTE — the hulking ursine colossus (the mid camp, CAMP_BRUTE, 3 per camp)
// ============================================================================
//
// Measured envelope: 2.310 m to the back plate, 1.68 m across the forelimbs,
// 1.46 m deep, feet at y 0.010, arms reaching the ground at z +0.26. Armoured
// (armor 4) and slow (2.9 m/s), and it has to LOOK like both from across the
// map — the hump, the back plate and the horns are the armour, the
// ground-reaching knuckle-walking arms are the mass.
//
// From directly above: a dominating round hump, two long arms breaking the
// envelope forward, two horns and two shoulder spurs radiating from the mass,
// and a lit fissure down the back plate. Two and a half times the pack's
// height, which is the entire "is this camp safe" decision made in one glance.
//
// Three brutes rest 2.2627 m apart, so the model may spend 1.1314 m of radius.
// Measured half-diagonal 1.112 m, exact footprint radius 0.945 m: it fits, but
// it is the closest fit of the three, which is why the arms sit at x 0.60 and
// the muzzle stops at z 0.94 rather than the 0.70 / 1.02 the first pass drew.

function bruteParts(): Part[] {
  const p: Part[] = [];

  // --- hind legs: short, thick, planted. All the height is in the torso.
  for (const s of SIDES) {
    add(p, capsule(0.26, 0.3, { x: s * 0.36, y: 0.92, z: -0.1 }), 'leather', BRUTE_HIDE);
    add(p, cyl(0.19, 0.24, 0.52, 10, { x: s * 0.36, y: 0.4, z: -0.04 }), 'leather', BRUTE_HIDE);
    add(p, box(0.34, 0.16, 0.5, { x: s * 0.36, y: 0.09, z: 0.06 }), 'leather', BRUTE_HIDE);
  }

  // --- torso: hips, a forward-leaning barrel, the bear hump, a deep chest
  add(p, sphere(0.4, 12, { sz: 0.9, x: 0, y: 1.12, z: -0.12 }), 'leather', BRUTE_HIDE);
  add(p, capsule(0.42, 0.46, { rx: 0.3, x: 0, y: 1.46, z: 0.02 }), 'leather', BRUTE_HIDE);
  add(p, sphere(0.44, 14, { sy: 0.85, x: 0, y: 1.86, z: -0.1 }), 'leather', BRUTE_HIDE);
  add(p, sphere(0.36, 12, { sz: 0.85, x: 0, y: 1.42, z: 0.28 }), 'leather', BRUTE_HIDE);

  // --- forelimbs: knuckle-walkers that reach the floor, which is what makes
  //     the pose read as a beast rather than as a big humanoid.
  for (const s of SIDES) {
    add(p, sphere(0.24, 12, { x: s * 0.5, y: 1.72, z: 0.06 }), 'leather', BRUTE_HIDE);
    add(p, capsule(0.19, 0.42, { x: s * 0.56, y: 1.32, z: 0.1, rz: s * -0.16 }), 'leather', BRUTE_HIDE);
    add(
      p,
      capsule(0.21, 0.4, { x: s * 0.6, y: 0.66, z: 0.2, rz: s * -0.1, rx: -0.12 }),
      'leather',
      BRUTE_HIDE,
    );
    add(p, ico(0.24, 1, { x: s * 0.6, y: 0.26, z: 0.26 }), 'leather', BRUTE_HIDE);
    // two bone claws per hand, apex forward
    add(
      p,
      cone(0.05, 0.26, 6, { x: s * 0.7, y: 0.13, z: 0.42, rx: 1.5 }),
      'monumentStone',
      BONE,
    );
    add(
      p,
      cone(0.05, 0.26, 6, { x: s * 0.52, y: 0.13, z: 0.44, rx: 1.5 }),
      'monumentStone',
      BONE,
    );
  }

  // --- head, sunk between the shoulders under a chitin cranial plate
  add(p, cyl(0.24, 0.3, 0.22, 10, { x: 0, y: 1.72, z: 0.3, rx: 0.5 }), 'leather', BRUTE_HIDE);
  add(p, box(0.42, 0.36, 0.44, { x: 0, y: 1.7, z: 0.52, rx: 0.14 }), 'leather', BRUTE_HIDE);
  add(p, box(0.44, 0.1, 0.4, { x: 0, y: 1.89, z: 0.5, rx: 0.14 }), 'cliffRock');
  add(p, box(0.26, 0.22, 0.3, { x: 0, y: 1.6, z: 0.78, rx: 0.06 }), 'leather', BRUTE_HIDE);
  add(p, box(0.24, 0.1, 0.28, { x: 0, y: 1.5, z: 0.79 }), 'monumentStone', BONE);
  for (const s of SIDES) {
    add(
      p,
      cone(0.055, 0.34, 6, { x: s * 0.12, y: 1.68, z: 0.845, rx: -0.25, rz: s * -0.18 }),
      'monumentStone',
      BONE,
    );
    glow(p, ico(0.05, 0, { x: s * 0.13, y: 1.79, z: 0.72 }));
    // horns, swept out and back — the widest and highest points of the build
    add(
      p,
      cone(0.085, 0.46, 6, { x: s * 0.26, y: 2.1, z: 0.4, rz: s * -0.45, rx: -0.3 }),
      'cliffRock',
    );
  }

  // --- back armour, shoulder spurs, and the venom fissure through the plate
  add(p, box(0.62, 0.16, 0.7, { x: 0, y: 2.16, z: -0.16, rx: -0.14 }), 'cliffRock');
  for (const s of SIDES) {
    add(p, cone(0.1, 0.36, 6, { x: s * 0.46, y: 2.02, z: -0.24, rz: s * -0.55 }), 'cliffRock');
  }
  glow(p, box(0.14, 0.07, 0.5, { x: 0, y: 2.24, z: -0.16, rx: -0.14 }));
  // bioluminescent fungus growing on the hump. It rides the GLOW bucket rather
  // than minting a fifth `fern` material, which would cost a draw call on every
  // brute alive for two nodules four centimetres across — and it earns its
  // place twice, because at night these are what say "jungle, and old".
  for (const s of SIDES) {
    glow(p, ico(0.09, 1, { sy: 0.55, x: s * 0.28, y: 2.0, z: -0.4 }));
  }

  return p;
}

// ============================================================================
// Assembly
// ============================================================================

/** One tier's animated carve-out before it becomes an {@link AnimPart}: a
 *  single kit primitive, so it needs no merge, plus the motion R_UNITS drives
 *  it with and the height it rests at. */
interface CampAnim {
  readonly geo: THREE.BufferGeometry;
  readonly kind: 'orbit' | 'bob' | 'spin';
  readonly y: number;
}

/** Per-tier metadata that is not derivable from the parts list.
 *
 *  A bar height is `measured top of the baked geometry + 0.25 m`, and nothing
 *  else. The previous brute figure was 2.85 against a measured top of 2.310 —
 *  a 0.54 m gap, more than twice the largest clearance anywhere in the game,
 *  which reads as a bar belonging to something behind the brute. The tops are
 *  0.905 / 1.620 / 2.310, so the bars are 1.15 / 1.87 / 2.56 and the clearances
 *  are 0.245 / 0.250 / 0.250.
 *
 *  Bar widths are deliberately monotonic 0.80 / 0.95 / 1.50 so the bar alone
 *  separates the three tiers. */
interface CampFit {
  readonly barH: number;
  readonly barW: number;
}

const CAMP_FIT: Record<CampTier, CampFit> = {
  pack: { barH: 1.15, barW: 0.8 },
  hive: { barH: 1.87, barW: 0.95 },
  brute: { barH: 2.56, barW: 1.5 },
};

/**
 * The floating carve-out, per tier.
 *
 * The pack has NONE, and that is a decision rather than an omission: it is the
 * most numerous entity of the three (four per camp, two camps per half at three
 * lanes) and a bobbing light on a knee-high scavenger both costs a draw call
 * per body and contradicts the "cheap, take it at level 2" read the tier
 * exists to give. The two tiers a player must think about before committing get
 * the motion instead — which is also STYLE_BIBLE §9's "a still frame of a MOBA
 * should never look still", spent where it buys a gameplay read.
 *
 * How far these TRAVEL is R_UNITS' — see the CONTRACT_GAP in the header. The
 * numbers below are the ones this module owns: the primitive's own size, and
 * the height it rests at.
 */
function campAnim(tier: CampTier): CampAnim | null {
  switch (tier) {
    case 'pack':
      return null;
    case 'hive':
      // A drone spore orbiting the swarm-tier body: the motion says "there are
      // more of these than you can see", which is exactly the hive's threat.
      // Radius 0.060 m, so at R_UNITS' current 0.55 m orbit the swept circle is
      // 0.610 m — inside the 0.6122 m the post ring allows this tier. It rests
      // at 1.35 m, above the 1.10 m dorsal plate and below the 1.62 m sting.
      return { geo: ico(0.06, 1, { sy: 1.4 }), kind: 'orbit', y: 1.35 };
    case 'brute':
      // A heart-light riding on the hump. `spin` and not `bob`: spin is the one
      // kind that leaves the part at animY, and the measured bob amplitude
      // (+/-0.30 m in units.ts) would drive a 0.10 m bead 0.19 m down into the
      // 2.310 m back plate and 0.16 m up through the 2.56 m HP bar. At 2.42 m
      // the bead spans 2.32-2.52 m: resting on the plate, clear of the bar.
      return { geo: ico(0.1, 1), kind: 'spin', y: 2.42 };
  }
}

function campParts(tier: CampTier): Part[] {
  switch (tier) {
    case 'pack':
      return packParts();
    case 'hive':
      return hiveParts();
    case 'brute':
      return bruteParts();
  }
}

/**
 * Turn the carve-out geometry into the typed {@link AnimPart} R_UNITS mounts.
 *
 * `geo` does NOT pass through `bake()`, so this module owns the two things
 * `bake()` would otherwise do for it (AMENDMENT_3 §B):
 *   1. `whiteVertexColors(geo)` — without it the part renders BLACK under the
 *      kit's unconditional `vertexColors: true`, and typechecks perfectly;
 *   2. UV scaling — a no-op here and deliberately so: both anim parts are
 *      `crystal`, and that family has `normal: null`, `roughnessMap: false`
 *      and no albedo map, so it samples no texture and has no UV density to
 *      match.
 *
 * The material description travels in the type. There is no `userData.rift*`
 * side-channel on this geometry and there must never be one again — that was
 * the banned sibling negotiation that made the ward eye wear the ancient's
 * heart material.
 */
function animPart(geo: THREE.BufferGeometry): AnimPart {
  return {
    geo: whiteVertexColors(geo),
    surfaceId: GLOW_SURFACE,
    tint: GLOW_TINT,
    emissive: GLOW,
    bloom: true,
  };
}

/**
 * Bake the parts and mark the one bucket that is allowed to glow.
 *
 * The glow bucket is NOT re-pointed after the fact. Every glow part declares
 * `tint` + `emissive`, so `bake()` buckets it separately and builds it through
 * `partMaterial` -> `emissiveSurface('crystal', 'neutral', 2.6, tint)` from the
 * start. `BakedMesh.parts` therefore stays readonly and untouched, and the
 * venom keeps its team-independent `#98b45c` albedo instead of the crystal
 * family's cream (AMENDMENT_3 §A).
 *
 * Bloom is layer-masked, so ONLY that bucket goes on BLOOM_LAYER. Hide, bone
 * and chitin are never marked.
 *
 * The two asserts are the point of this function, not decoration. Marking is
 * driven off material IDENTITY against the kit's own cache, so a bucket the
 * loop fails to find CANNOT be silently reported as bloomed — the count is
 * checked, and a build that does not have exactly one glow bucket throws here
 * with its tier named rather than shipping a flat, unmarked emissive.
 */
function assemble(tier: CampTier, parts: readonly Part[]): UnitBuild {
  if (parts.length < MIN_PARTS || parts.length > MAX_PARTS) {
    throw new Error(
      `rift camps: ${tier} built ${parts.length} parts, outside the ${MIN_PARTS}-${MAX_PARTS} budget`,
    );
  }

  const body = bake(parts);
  const glowMat = partMaterial(GLOW_SURFACE, GLOW_TINT, GLOW);
  let marked = 0;
  for (const child of body.group.children) {
    if (child instanceof THREE.Mesh && child.material === glowMat) {
      markBloom(child);
      marked += 1;
    }
  }
  if (marked !== 1) {
    throw new Error(
      `rift camps: ${tier} baked ${marked} glow buckets, expected exactly 1 — ` +
        'a marked bucket with no emissive hazes the frame and an unmarked one does not glow',
    );
  }
  body.group.name = `rift:camp:${tier}`;

  const fit = CAMP_FIT[tier];
  const anim = campAnim(tier);
  if (anim === null) {
    return { body, anim: null, animKind: null, animY: 0, barH: fit.barH, barW: fit.barW };
  }
  return {
    body,
    anim: animPart(anim.geo),
    animKind: anim.kind,
    animY: anim.y,
    barH: fit.barH,
    barW: fit.barW,
  };
}

/**
 * Build one neutral jungle-camp archetype. Called ONCE PER TIER by R_UNITS,
 * which pools and reuses the result for every member of every camp of that
 * tier — never once per entity, and never per frame.
 *
 * There is no `team` parameter by design: camps are `NEUTRAL_TEAM` and must
 * never wear a team colour (see the header). The `EntKind` members
 * `campPack` / `campBrute` / `campHive` map onto `'pack' | 'brute' | 'hive'`
 * one-for-one; a caller holding an `EntKind` strips the `camp` prefix.
 */
export function buildCamp(tier: CampTier): UnitBuild {
  return assemble(tier, campParts(tier));
}
