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
//
// ---- THE READ: MASS AND HEIGHT (STYLE_BIBLE §7) ----------------------------
// "Deliberately non-humanoid. Beasts, not soldiers." A player decides whether a
// camp is safe BEFORE committing, and they decide it from the silhouette at
// gameplay zoom, so the three tiers are separated on the two cues that survive
// at 40 px: how much ground the shape covers, and how far up it goes.
//
//   pack    0.91 m tall, 1.44 m long, four legs. A LOW HORIZONTAL DASH — the
//           only tier that is longer than it is tall. Reads from above as a
//           narrow ellipse with four paw rectangles and a triple spine spike
//           down the midline. The entry camp; it must look cheap to take.
//   hive    1.62 m tall, 1.51 m deep, six legs radiating to a 1.06 m span. A
//           SPIKED SPINDLE on a star of legs. Six-fold radial symmetry from
//           above is a shape no soldier and no quadruped has, which is the
//           whole point: it is the ranged tier and it must never be mistaken
//           for the pack.
//   brute   2.31 m tall, 1.88 m across the forelimbs, 1.59 m deep, arms
//           reaching the ground. A HULK with a bear hump — two and a half
//           times the pack's height and the tallest non-structure thing in the
//           jungle. It must look expensive from across the map.
//
// Height ladder 0.91 / 1.62 / 2.31 and bar widths 0.80 / 0.95 / 1.50: both are
// monotonic, so even the HP bar alone tells the tiers apart. Every figure here
// is MEASURED off the shipped geometry, not intended.
//
// Footprints are 1.9x / 1.9x / 1.3x the tier's collision DIAMETER (config.ts
// radius 0.38 / 0.40 / 0.70). A model wider than its collision circle is
// normal and matches the benchmark; what is not normal is a model so long that
// four of them cannot stand inside their own clearing, which is why the pack's
// tail and the hive's abdomen are both shorter than the first pass drew them.
//
// ---- LAWS OBSERVED HERE ----------------------------------------------------
//  * MATERIAL LAW. Every material comes from the kit's `surface()` /
//    `emissiveSurface()`. There is no `new THREE.Mesh*Material` in this file
//    and no Lambert of any kind.
//  * VERTEX-COLOUR LAW. Bodies go through `bake()`, which emits the white
//    `color` attribute itself. The two ANIM geometries do not, so each is run
//    through `whiteVertexColors()` before it leaves this module — without it
//    they render black under `vertexColors: true`.
//  * UV LAW. No `texture.repeat`, no `uvLocal`: parts take `bake()`'s
//    world-space projection at 1 UV unit = 1 metre in the build's own local
//    space (origin on the ground between the feet, +Z forward), so every
//    instance of a tier has identical UVs wherever it stands and its texel
//    density matches the jungle floor it stands on.
//  * FLAT SHADING. `cliffRock` is the one flat-shaded family used here, and it
//    is used ONLY on genuinely faceted forms — chitin plates, horns, claws,
//    spikes, elytra, the hive's cranium. Hide, haunches and limbs are organic
//    curves and take the smooth-shading `leather` family (STYLE_BIBLE §2:
//    faceting a curved organic surface is a defect).
//  * BLOOM. Emissive alone does not glow. Exactly one baked bucket per tier is
//    re-pointed at an `emissiveSurface()` and passed to `markBloom`; the hide,
//    bone and chitin buckets are never marked, because bloom on everything is
//    the amateur tell STYLE_BIBLE §6 bans by name.
//  * DETERMINISM. There is no randomness in this file at all — the builds are
//    fixed geometry. No `Math.random`, and no `rng` needed.
//  * No per-frame allocation: everything here happens once, at init.
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
// ---- DRAW-CALL ARITHMETIC (GRAPHICS_CONTRACT §5) ---------------------------
// `bake()` merges one geometry per (surface, tint) pair, so a tier's draw-call
// cost IS its distinct-material count, paid per live entity. Every tier is held
// to FOUR:
//
//   hide (leather, tinted) · chitin (cliffRock) · bone (monumentStone/
//   monumentLit) · glow (crystal/neutral)
//
// That is a deliberate cap, not a coincidence. A 3-lane map runs 4 camps per
// half: pack, pack, brute, hive (config.ts CAMPS_PER_HALF) at member counts
// 4/4/3/5, so 32 camp entities exist across the map and every extra material
// here costs 32 draw calls of the 700 budget. The moss growing on the brute's
// hump is therefore in the GLOW bucket as bioluminescent fungus rather than in
// a fifth `fern` bucket, and the pack's dark eye sockets reuse the hide instead
// of minting a dark tint of their own. All 32 alive and on screen at once is
// 128 draw calls; in practice camps are scattered through the jungle and
// frustum-culled to one or two at a time.
//
// ---- CONTRACT NOTE: the anim part has nowhere to carry its material ---------
// `UnitBuild.anim` is a bare `BufferGeometry` and `UnitBuild` has no field for
// the material it should be drawn with, so a consumer cannot know that the
// brute's heart is an emissive neutral crystal. Reported upstream as a
// CONTRACT_GAP (R_MESH_CREEP reported the same one). Until it is resolved this
// module attaches the already-constructed kit material and its description to
// the geometry's `userData` (`riftMaterial`, `riftSurface`, `riftEmissiveKey`,
// `riftEmissiveIntensity`, `riftBloom`) — additive, free, and it lets R_UNITS
// do the right thing without either of us touching a frozen file. The keying
// matches R_MESH_CREEP's exactly so one consumer handles both.
// ============================================================================
import * as THREE from 'three';
import { APAL } from '@rift/shared/palette.js';
import type { SurfaceId } from '@rift/shared/surfaces.js';
import type { BakedMesh, BakedPart, Part, UnitBuild } from '../kit.js';
import {
  bake,
  box,
  capsule,
  cone,
  cyl,
  emissiveSurface,
  ico,
  markBloom,
  sphere,
  surface,
} from '../kit.js';
import { whiteVertexColors } from '../core.js';

/** The three neutral camp tiers. Mirrors the `tier` union on `CampDef` in
 *  shared/src/terrain.ts; declared locally rather than exported so this module
 *  adds nothing to the frozen contract surface. */
type CampTier = 'pack' | 'brute' | 'hive';

// ---- the neutral identity ---------------------------------------------------

/** APAL KEY NAME (not a hex) — `emissiveSurface` resolves colours by name. */
const GLOW_KEY = 'neutral';
/** The same colour as a resolved hex, for `surface('crystal', tint)`. The two
 *  keyings must stay in step: the tint is how the glow parts get their OWN
 *  bake bucket, and the key is how that bucket is re-pointed at the emissive
 *  material afterwards (see {@link assemble}). */
const GLOW_TINT = APAL.neutral;
/** Pleasant by day, dominant by night (STYLE_BIBLE §4). Below the hero accent
 *  glow: a camp is a landmark in the jungle, not the brightest thing in the
 *  frame — that is the ancient's. */
const GLOW_INTENSITY = 2.6;

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

// ---- part helper ------------------------------------------------------------

/** Push one part. Split on `tint` because `exactOptionalPropertyTypes` forbids
 *  writing an explicit `undefined` into an optional field. */
function add(parts: Part[], geo: THREE.BufferGeometry, id: SurfaceId, tint?: string): void {
  if (tint === undefined) parts.push({ geo, surface: id });
  else parts.push({ geo, surface: id, tint });
}

// ============================================================================
// PACK — the low quadruped scavenger (the entry camp, CAMP_PACK, 4 per camp)
// ============================================================================
//
// Measured envelope: 1.44 m nose to tail, 0.59 m across the paws, 0.91 m to the
// venom bead on the tallest spine spike. Body mass sits at 0.52 m — below the
// knee of every hero in the game, which is the point: this thing reads as
// something you step over, and that is how a player knows the camp is cheap.
//
// From directly above: a narrow ellipse, four paw rectangles at the corners, a
// pale skull wedge pushed forward of the shoulders, and three spike triangles
// down the midline. Nothing about that outline is a soldier.

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
    add(p, ico(0.032, 0, { x: s * 0.075, y: 0.745, z: 0.645 }), 'crystal', GLOW_TINT);
  }

  // --- dorsal spine. Three spikes down the midline: the vertical that stops a
  //     low quadruped from vanishing into the moss when seen from the 55 deg
  //     camera, and the tier's whole "do not touch me" tell.
  add(p, cone(0.05, 0.17, 5, { x: 0, y: 0.74, z: 0.22, rx: -0.3 }), 'cliffRock');
  add(p, cone(0.055, 0.2, 5, { x: 0, y: 0.76, z: 0.02, rx: -0.15 }), 'cliffRock');
  add(p, cone(0.05, 0.17, 5, { x: 0, y: 0.74, z: -0.18, rx: 0.1 }), 'cliffRock');
  // venom bead on the tallest spike — the pack's only light, and its neutral ID
  add(p, ico(0.033, 0, { x: 0, y: 0.875, z: 0.02 }), 'crystal', GLOW_TINT);

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
// Measured envelope: 1.06 m leg span, 1.51 m deep, 1.62 m to the sting tip,
// body mass at 0.94 m. It is the RANGED tier (attackRange 7.5), dangerous below
// level 6, so its silhouette has to say "swarm" from the moment it is on
// screen: six legs radiating from a segmented spindle, mandibles thrust
// forward, a lit venom sac slung under the abdomen.
//
// Six-fold radial symmetry from above is the tell. Neither a lane creep nor the
// pack has anything like it, and it survives all the way down to the pixel
// count where the legs merge into a star.

function hiveParts(): Part[] {
  const p: Part[] = [];

  // --- six legs, three pairs. Femur up-and-out to a high knee, tibia down-and-
  //     out to the ground: the inverted-V that makes an insect an insect.
  const legZ: readonly number[] = [0.28, 0.0, -0.28];
  for (const s of SIDES) {
    for (const z of legZ) {
      add(
        p,
        capsule(0.055, 0.24, { x: s * 0.2, y: 0.98, z, rz: s * 0.95 }),
        'leather',
        HIVE_HIDE,
      );
      add(
        p,
        cyl(0.038, 0.055, 0.9, 7, { x: s * 0.42, y: 0.5, z, rz: s * -0.16 }),
        'leather',
        HIVE_HIDE,
      );
    }
  }

  // --- thorax: a soft core inside hard plates, which is how chitin actually
  //     reads and why the capsule is `leather` and the plates are `cliffRock`.
  add(p, capsule(0.2, 0.26, { rx: Math.PI / 2, x: 0, y: 0.94, z: 0.06 }), 'leather', HIVE_HIDE);
  add(p, box(0.34, 0.1, 0.46, { x: 0, y: 1.1, z: 0.04, rx: 0.06 }), 'cliffRock');
  for (const s of SIDES) {
    add(p, box(0.08, 0.2, 0.36, { x: s * 0.19, y: 0.96, z: 0.04, rz: s * -0.22 }), 'cliffRock');
  }

  // --- pedicel and the two abdomen segments. The abdomen ARCHES UP over the
  //     thorax rather than trailing behind it: a raised sting is a far stronger
  //     "this one is dangerous" read than a dragged one, and it converts the
  //     length an insect would otherwise spend on the ground into the height
  //     the mass ladder needs — measured, 0.45 m of depth given back and the
  //     sting now tops the build at 1.62 m instead of the elytra at 1.42 m.
  add(p, cyl(0.09, 0.11, 0.14, 8, { x: 0, y: 1.04, z: -0.22, rx: 0.9 }), 'leather', HIVE_HIDE);
  add(p, sphere(0.22, 12, { sz: 1.05, x: 0, y: 1.2, z: -0.36 }), 'leather', HIVE_HIDE);
  add(p, sphere(0.16, 12, { sz: 1.05, x: 0, y: 1.4, z: -0.48 }), 'leather', HIVE_HIDE);
  add(p, cyl(0.235, 0.235, 0.07, 10, { rx: 1.1, x: 0, y: 1.2, z: -0.33 }), 'cliffRock');
  add(p, cyl(0.185, 0.185, 0.06, 10, { rx: 0.9, x: 0, y: 1.33, z: -0.43 }), 'cliffRock');
  // elytra, half-raised — the widest part of the upper silhouette
  for (const s of SIDES) {
    add(
      p,
      box(0.1, 0.34, 0.44, { x: s * 0.16, y: 1.24, z: -0.34, rz: s * -0.55, rx: 0.35 }),
      'cliffRock',
    );
    add(
      p,
      cone(0.04, 0.16, 5, { x: s * 0.2, y: 1.22, z: -0.36, rz: s * -1.1 }),
      'monumentStone',
      BONE,
    );
  }
  // the venom sac, slung under the arch: the tier's light and the reason a
  // player can find a hive camp in the dark
  add(p, ico(0.13, 1, { sy: 1.2, x: 0, y: 1.22, z: -0.44 }), 'crystal', GLOW_TINT);
  // the sting, cocked up and forward over the back
  add(p, cone(0.055, 0.26, 6, { x: 0, y: 1.52, z: -0.52, rx: 0.7 }), 'monumentStone', BONE);

  // --- head, thrust forward and down on a short neck
  add(p, cyl(0.11, 0.13, 0.16, 8, { x: 0, y: 1.0, z: 0.3, rx: 1.1 }), 'leather', HIVE_HIDE);
  add(p, ico(0.19, 1, { sz: 1.15, x: 0, y: 1.02, z: 0.45 }), 'cliffRock');
  add(p, box(0.24, 0.18, 0.06, { x: 0, y: 0.99, z: 0.62, rx: 0.2 }), 'cliffRock');
  for (const s of SIDES) {
    // mandibles, apex forward and splayed — the forward silhouette break
    add(
      p,
      cone(0.055, 0.28, 6, { x: s * 0.12, y: 0.95, z: 0.72, rx: 1.7, rz: s * 0.3 }),
      'monumentStone',
      BONE,
    );
    // four compound eyes. A count no vertebrate has, at the size that survives
    // the zoom, and they are the neutral glow bucket doing double duty.
    add(p, ico(0.052, 0, { x: s * 0.115, y: 1.09, z: 0.55 }), 'crystal', GLOW_TINT);
    add(p, ico(0.042, 0, { x: s * 0.145, y: 1.0, z: 0.51 }), 'crystal', GLOW_TINT);
    // antennae, swept back over the thorax; kept fat enough not to alias
    add(
      p,
      cyl(0.04, 0.055, 0.44, 6, { x: s * 0.14, y: 1.24, z: 0.34, rx: -0.5, rz: s * -0.45 }),
      'cliffRock',
    );
  }

  return p;
}

// ============================================================================
// BRUTE — the hulking ursine colossus (the mid camp, CAMP_BRUTE, 3 per camp)
// ============================================================================
//
// Measured envelope: 2.31 m to the back plate, 1.88 m across the forelimbs,
// 1.59 m deep, arms reaching the ground at z +0.26. Armoured (armor 4) and slow
// (2.9 m/s), and it
// has to LOOK like both from across the map — the hump, the back plate and the
// horns are the armour, the ground-reaching knuckle-walking arms are the mass.
//
// From directly above: a dominating round hump, two long arms breaking the
// envelope forward, two horns and two shoulder spurs radiating from the mass,
// and a lit fissure down the back plate. Two and a half times the pack's
// height, which is the entire "is this camp safe" decision made in one glance.

function bruteParts(): Part[] {
  const p: Part[] = [];

  // --- hind legs: short, thick, planted. All the height is in the torso.
  for (const s of SIDES) {
    add(p, capsule(0.26, 0.3, { x: s * 0.36, y: 0.92, z: -0.1 }), 'leather', BRUTE_HIDE);
    add(p, cyl(0.19, 0.24, 0.52, 10, { x: s * 0.36, y: 0.4, z: -0.04 }), 'leather', BRUTE_HIDE);
    add(p, box(0.34, 0.16, 0.5, { x: s * 0.36, y: 0.09, z: 0.06 }), 'leather', BRUTE_HIDE);
  }

  // --- torso: hips, a forward-leaning barrel, the bear hump, a deep chest
  add(p, sphere(0.4, 12, { sz: 0.9, x: 0, y: 1.12, z: -0.16 }), 'leather', BRUTE_HIDE);
  add(p, capsule(0.42, 0.46, { rx: 0.3, x: 0, y: 1.46, z: 0.02 }), 'leather', BRUTE_HIDE);
  add(p, sphere(0.44, 14, { sy: 0.85, x: 0, y: 1.86, z: -0.16 }), 'leather', BRUTE_HIDE);
  add(p, sphere(0.36, 12, { sz: 0.85, x: 0, y: 1.42, z: 0.28 }), 'leather', BRUTE_HIDE);

  // --- forelimbs: knuckle-walkers that reach the floor, which is what makes
  //     the pose read as a beast rather than as a big humanoid.
  for (const s of SIDES) {
    add(p, sphere(0.24, 12, { x: s * 0.56, y: 1.72, z: 0.06 }), 'leather', BRUTE_HIDE);
    add(p, capsule(0.19, 0.42, { x: s * 0.62, y: 1.32, z: 0.1, rz: s * -0.16 }), 'leather', BRUTE_HIDE);
    add(
      p,
      capsule(0.21, 0.4, { x: s * 0.68, y: 0.66, z: 0.2, rz: s * -0.1, rx: -0.12 }),
      'leather',
      BRUTE_HIDE,
    );
    add(p, ico(0.24, 1, { x: s * 0.7, y: 0.26, z: 0.26 }), 'leather', BRUTE_HIDE);
    // two bone claws per hand, apex forward
    add(
      p,
      cone(0.05, 0.26, 6, { x: s * 0.8, y: 0.13, z: 0.42, rx: 1.5 }),
      'monumentStone',
      BONE,
    );
    add(
      p,
      cone(0.05, 0.26, 6, { x: s * 0.62, y: 0.13, z: 0.44, rx: 1.5 }),
      'monumentStone',
      BONE,
    );
  }

  // --- head, sunk between the shoulders under a chitin cranial plate
  add(p, cyl(0.24, 0.3, 0.22, 10, { x: 0, y: 1.72, z: 0.34, rx: 0.5 }), 'leather', BRUTE_HIDE);
  add(p, box(0.42, 0.36, 0.44, { x: 0, y: 1.7, z: 0.58, rx: 0.14 }), 'leather', BRUTE_HIDE);
  add(p, box(0.44, 0.1, 0.4, { x: 0, y: 1.89, z: 0.56, rx: 0.14 }), 'cliffRock');
  add(p, box(0.26, 0.22, 0.3, { x: 0, y: 1.6, z: 0.86, rx: 0.06 }), 'leather', BRUTE_HIDE);
  add(p, box(0.24, 0.1, 0.28, { x: 0, y: 1.5, z: 0.85 }), 'monumentStone', BONE);
  for (const s of SIDES) {
    add(
      p,
      cone(0.055, 0.34, 6, { x: s * 0.12, y: 1.68, z: 0.92, rx: -0.25, rz: s * -0.18 }),
      'monumentStone',
      BONE,
    );
    add(p, ico(0.05, 0, { x: s * 0.13, y: 1.79, z: 0.78 }), 'crystal', GLOW_TINT);
    // horns, swept out and back — the widest and highest points of the build
    add(
      p,
      cone(0.085, 0.46, 6, { x: s * 0.26, y: 2.1, z: 0.4, rz: s * -0.45, rx: -0.3 }),
      'cliffRock',
    );
  }

  // --- back armour, shoulder spurs, and the venom fissure through the plate
  add(p, box(0.62, 0.16, 0.7, { x: 0, y: 2.16, z: -0.18, rx: -0.14 }), 'cliffRock');
  for (const s of SIDES) {
    add(p, cone(0.1, 0.36, 6, { x: s * 0.46, y: 2.02, z: -0.26, rz: s * -0.55 }), 'cliffRock');
  }
  add(p, box(0.14, 0.07, 0.5, { x: 0, y: 2.24, z: -0.18, rx: -0.14 }), 'crystal', GLOW_TINT);
  // bioluminescent fungus growing on the hump. It rides the GLOW bucket rather
  // than minting a fifth `fern` material, which would cost a draw call on every
  // brute alive for two nodules four centimetres across — and it earns its
  // place twice, because at night these are what say "jungle, and old".
  for (const s of SIDES) {
    add(p, ico(0.09, 1, { sy: 0.55, x: s * 0.28, y: 2.0, z: -0.42 }), 'crystal', GLOW_TINT);
  }

  return p;
}

// ============================================================================
// Assembly
// ============================================================================

/** One tier's animated carve-out: a single kit primitive, so it needs no merge.
 *  R_UNITS owns its motion; this module supplies the geometry, the white vertex
 *  colours it cannot get from `bake()`, and the material hint described in the
 *  CONTRACT NOTE at the top of this file. */
interface CampAnim {
  readonly geo: THREE.BufferGeometry;
  readonly kind: 'orbit' | 'bob' | 'spin';
  readonly y: number;
}

/** Per-tier metadata that is not derivable from the parts list. Bar heights
 *  clear the head, not the tallest spike — a bar floating above the brute's
 *  horns would read as detached — and bar widths are deliberately monotonic
 *  0.80 / 0.95 / 1.50 so the bar alone separates the three tiers. */
interface CampFit {
  readonly barH: number;
  readonly barW: number;
}

const CAMP_FIT: Record<CampTier, CampFit> = {
  pack: { barH: 1.15, barW: 0.8 },
  hive: { barH: 1.9, barW: 0.95 },
  brute: { barH: 2.85, barW: 1.5 },
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
 */
function campAnim(tier: CampTier): CampAnim | null {
  switch (tier) {
    case 'pack':
      return null;
    case 'hive':
      // A drone spore orbiting the swarm-tier body: the motion says "there are
      // more of these than you can see", which is exactly the hive's threat.
      // `orbit` sweeps a 0.55 m circle, clear of the 0.25 m body at this height
      // and well inside the 0.98 m leg span, so it never intersects a leg.
      return { geo: ico(0.07, 1, { sy: 1.4 }), kind: 'orbit', y: 1.35 };
    case 'brute':
      // A heart-light riding above the hump. `bob` sits on the unit's own axis,
      // where the tallest geometry is the back plate at 2.24 m, so 2.62 m
      // floats it clear without detaching it from the mass below.
      return { geo: ico(0.12, 1), kind: 'bob', y: 2.62 };
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
 * Prepare the animated carve-out: satisfy the vertex-colour law and attach the
 * material it is meant to be drawn with (see the CONTRACT NOTE in the header).
 * Returns the same geometry.
 */
function animGeo(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  whiteVertexColors(geo);
  geo.userData['riftMaterial'] = emissiveSurface('crystal', GLOW_KEY, GLOW_INTENSITY);
  geo.userData['riftSurface'] = 'crystal';
  geo.userData['riftEmissiveKey'] = GLOW_KEY;
  geo.userData['riftEmissiveIntensity'] = GLOW_INTENSITY;
  geo.userData['riftBloom'] = true;
  return geo;
}

/**
 * Bake the parts and light the one bucket that is allowed to glow.
 *
 * `bake()` has no emissive path — it resolves every bucket through
 * `surface(id, tint)`, and `surface('crystal', tint)` carries the crystal
 * family's DEFAULT pale-ward emissive at intensity 2.2, which at that strength
 * swamps the tint and would render every venom marking on every camp creature
 * white. So the crystal bucket is re-pointed here, once, at build time, never
 * per frame, at the `emissiveSurface()` material of the same colour. No
 * material is minted: both come out of the kit's own factories and its cache.
 * (Recorded as a CONTRACT_GAP; R_MESH_HERO works around the identical defect
 * the identical way, so a reviewer sees one pattern rather than two.)
 *
 * `parts` is rebuilt rather than mutated — `BakedMesh.parts` is readonly, and a
 * consumer reading a material out of it must see the material that actually
 * renders, not the one `bake()` happened to start with.
 *
 * Bloom is layer-masked, so ONLY that bucket goes on BLOOM_LAYER. Hide, bone
 * and chitin are never marked.
 */
function assemble(tier: CampTier, parts: readonly Part[]): UnitBuild {
  const baked = bake(parts);
  const flat = surface('crystal', GLOW_TINT);
  const glow = emissiveSurface('crystal', GLOW_KEY, GLOW_INTENSITY);

  const buckets: BakedPart[] = [];
  for (const bucket of baked.parts) {
    const material = bucket.material === flat ? glow : bucket.material;
    const mesh = baked.group.children.find(
      (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.geometry === bucket.geo,
    );
    if (mesh !== undefined) {
      mesh.material = material;
      if (material === glow) markBloom(mesh);
    }
    buckets.push({ geo: bucket.geo, material });
  }
  const body: BakedMesh = { group: baked.group, parts: buckets };

  // The §7 part budget, stamped on the artifact so it can be checked against
  // the shipped geometry rather than against a comment that can drift.
  body.group.userData['riftPartCount'] = parts.length;
  body.group.name = `rift:camp:${tier}`;

  const fit = CAMP_FIT[tier];
  const anim = campAnim(tier);
  if (anim === null) {
    return { body, anim: null, animKind: null, animY: 0, barH: fit.barH, barW: fit.barW };
  }
  return {
    body,
    anim: animGeo(anim.geo),
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
