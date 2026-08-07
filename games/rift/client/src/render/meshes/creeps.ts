// ============================================================================
// ANCIENTS (rift) — CREEP / WARD / PROJECTILE MESHES (R_MESH_CREEP).
//
// `buildCreep(kind, team)` is the single archetype factory for everything that
// walks a lane, sits on the ground watching it, or flies down it: the three
// lane creeps, the summoned shade, the observer ward and the projectile.
// R_UNITS calls it ONCE PER ARCHETYPE at init and pools the result — never per
// entity — so nothing here is on any hot path and nothing here is cached
// internally (two callers must get two independent `THREE.Group`s, since a
// Group can only have one parent).
//
// ---- THE READ (STYLE_BIBLE §7) ---------------------------------------------
// Last-hitting is a timing skill played on a silhouette, so the three lane
// creeps are separated by BODY SHAPE, never by hue — a colour-blind read at 40
// px must still tell them apart:
//
//   melee   a compact WEDGE behind a slab shield. Widest at the shoulders,
//           tapering to the boots, with a rotated prow plate that reads as a
//           diamond from the 55 deg camera and a shield breaking the left
//           envelope. Crested helm for the vertical.
//   ranged  a tall thin SPINDLE. Half the shoulder mass of the melee, a flared
//           mantle high on the body, and a staff standing a full head above the
//           hood — the "visible implement" that says "this one shoots you".
//   siege   a wide low QUADRUPED. Its mass is horizontal where the other two
//           are vertical; four splayed legs, a beetle carapace, a bound ram
//           thrust forward past the head, and twin banners for the height cue
//           that says "slow and important".
//   shade   a SPECTRAL taper. Hooded, armless-looking, hem dissolving into
//           trailing wisps. The one creep permitted emissive + markBloom.
//   ward    a planted totem, not a creature. No HP bar, an eye that bobs.
//   proj    a lit dart, centred on its own origin and pointing +Z.
//
// Team identity is TINTED TRIM on a handful of parts (crest, tabard, banner,
// sash, blazon) — never a whole-model tint, which would destroy the shape read
// the paragraph above exists to buy. Neutral entities (`NEUTRAL_TEAM`) take the
// venom-green neutral ladder; every per-team choice narrows through
// `isPlayerTeam` first, because `EntTeam` is `TeamId | 2` and a raw index into
// a two-element team tuple is the exact failure that widening invites.
//
// ---- LAWS OBSERVED HERE ----------------------------------------------------
//  * MATERIAL LAW. Every material comes from the kit's `surface()` /
//    `emissiveSurface()`. There is no `new THREE.Mesh*Material` in this file.
//  * VERTEX-COLOUR LAW. Bodies go through `bake()`, which emits the white
//    `color` attribute itself. The ANIM geometries do not, so each one is run
//    through `whiteVertexColors()` before it leaves this module — without it
//    they render black under `vertexColors: true`.
//  * UV LAW. No `texture.repeat`, no `uvLocal`: parts take `bake()`'s
//    world-space projection at 1 UV unit = 1 metre, in the build's own local
//    space (origin between the feet). Every instance of an archetype therefore
//    has identical UVs no matter where it stands, and its texel density matches
//    the ground it walks on.
//  * BLOOM. Emissive alone does not glow. The crystal buckets are looked up by
//    material identity in the baked group and passed to `markBloom` — the whole
//    group is never marked, or the cloth and iron would haze the frame too.
//  * DETERMINISM. The only variation (shade hem tatters and trailing wisps) is
//    drawn from the kit's seeded `rng`. No `Math.random`.
//  * No per-frame allocation: everything here happens once, at init.
//
// ---- DRAW-CALL ARITHMETIC (GRAPHICS_CONTRACT §5) ---------------------------
// `bake()` merges one geometry per (surface, tint) pair, so an archetype's
// draw-call cost IS its distinct-material count, paid per live entity. That is
// the budget pressure that caps the palette of each build, and it is why (for
// example) visor slits and hood voids reuse the `leather` bucket instead of
// minting a dark tint of their own, and why the projectile is deliberately down
// at two materials:
//
//   melee 5 · ranged 5 · siege 6 · shade 5 · ward 4 (+1 for the eye) · proj 2
//
// Those figures are measured, not intended — the smoke build counts the baked
// buckets per archetype, and every one of them is the reason some part reuses a
// family it would not otherwise have chosen.
//
// ---- CONTRACT NOTE: the anim part has nowhere to carry its material ---------
// `UnitBuild.anim` is a bare `BufferGeometry` and `UnitBuild` has no field for
// the material it should be drawn with. Under the amended material law that
// information cannot be recovered downstream (the old `paintGeo` vertex-paint
// route is gone), so R_UNITS has no sanctioned way to know that a ward eye is
// an emissive crystal. Reported upstream as a CONTRACT_GAP. Until it is
// resolved, this module attaches the already-constructed kit material and its
// description to the geometry's `userData` (`riftMaterial`, `riftSurface`,
// `riftEmissiveKey`, `riftEmissiveIntensity`, `riftBloom`); that is additive,
// costs nothing, and lets a consumer do the right thing without either of us
// touching a frozen file.
// ============================================================================
import * as THREE from 'three';
import { mix } from '@platform/shared';
import { APAL } from '@rift/shared/palette.js';
import { isPlayerTeam } from '@rift/shared/types.js';
import type { EntKind, EntTeam } from '@rift/shared/types.js';
import type { SurfaceId } from '@rift/shared/surfaces.js';
import type { BakedMesh, Part, UnitBuild } from '../kit.js';
import {
  bake,
  box,
  capsule,
  cone,
  cyl,
  emissiveSurface,
  ico,
  lathe,
  markBloom,
  rng,
  sphere,
  surface,
} from '../kit.js';
import { whiteVertexColors } from '../core.js';

// ---- team identity ----------------------------------------------------------

/** The tint steps and the emissive key one side of the war is allowed to use.
 *  `key` is an APAL key NAME because `emissiveSurface` resolves colours by name,
 *  while `base`/`lit` are resolved hexes for `surface(id, tint)`.
 *
 *  Only two steps, not the family's full {base, Lit, Deep} ladder: each step
 *  used is a distinct `(surface, tint)` pair and therefore a draw call on every
 *  unit alive. Deep tones are carried by the `leather` family instead, which is
 *  already on every one of these builds. */
interface TeamTints {
  readonly base: string;
  readonly lit: string;
  readonly key: string;
}

const AZURE: TeamTints = { base: APAL.azure, lit: APAL.azureLit, key: 'azure' };
const EMBER: TeamTints = { base: APAL.ember, lit: APAL.emberLit, key: 'ember' };
/** NEUTRAL_TEAM. A summoned shade or a projectile can legitimately be neutral;
 *  it must never wear a team colour, because "is that mine?" is a gameplay
 *  question and a mis-tinted unit answers it wrongly. */
const NEUTRAL: TeamTints = { base: APAL.neutral, lit: APAL.neutralLit, key: 'neutral' };

/** The ONLY team->colour path in this file. Narrows `EntTeam` with the
 *  sanctioned guard rather than indexing a two-element tuple. */
function tintsOf(team: EntTeam): TeamTints {
  if (!isPlayerTeam(team)) return NEUTRAL;
  return team === 0 ? AZURE : EMBER;
}

// ---- shared dark accent -----------------------------------------------------
// Visor slits, hood voids and eye sockets want to be the darkest thing on the
// model. They reuse the `leather` family (albedo `trunk`, L* ~27) rather than
// minting a tinted bucket of their own: one extra (surface, tint) pair is one
// extra draw call on every creep alive, and at 30 creeps that is 30 draw calls
// spent on four square centimetres of shadow.

// ---- part helper ------------------------------------------------------------

/** Push one part. Split on `tint` because `exactOptionalPropertyTypes` forbids
 *  writing an explicit `undefined` into an optional field. */
function add(parts: Part[], geo: THREE.BufferGeometry, id: SurfaceId, tint?: string): void {
  if (tint === undefined) parts.push({ geo, surface: id });
  else parts.push({ geo, surface: id, tint });
}

/** Enable BLOOM_LAYER on exactly the baked buckets drawn with one of `mats`.
 *  Marking `body.group` wholesale would put the cloth, iron and stone into the
 *  bloom target as well, which is the "bloom on everything" tell STYLE_BIBLE §6
 *  bans by name. Bucket meshes are identified by material identity, which is
 *  reliable because `surface()` is cached per (id, tint) and therefore returns
 *  the very instance `bake()` used. */
function bloomBuckets(body: BakedMesh, mats: readonly THREE.Material[]): void {
  for (const child of body.group.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    const m = child.material;
    if (Array.isArray(m)) continue;
    if (mats.includes(m)) markBloom(child);
  }
}

/** Prepare an unbaked animated carve-out: satisfy the vertex-colour law and
 *  attach the material it is meant to be drawn with (see the CONTRACT NOTE in
 *  the header). Returns the same geometry. */
function animGeo(
  geo: THREE.BufferGeometry,
  id: SurfaceId,
  colorKey: string,
  intensity: number,
): THREE.BufferGeometry {
  whiteVertexColors(geo);
  geo.userData['riftMaterial'] = emissiveSurface(id, colorKey, intensity);
  geo.userData['riftSurface'] = id;
  geo.userData['riftEmissiveKey'] = colorKey;
  geo.userData['riftEmissiveIntensity'] = intensity;
  geo.userData['riftBloom'] = true;
  return geo;
}

// ============================================================================
// MELEE — the compact wedge behind a slab shield
// ============================================================================
//
// Measured envelope: 0.94 x 0.65 m footprint, 1.57 m to the tip of the crest
// (0.62 m across the pauldrons alone; the rest is shield and sword breaking the
// left and right silhouette). From directly above the read is: rectangle
// (shield) | diamond (prow plate) | line (sword). Nothing on it is thin enough
// to alias at gameplay zoom.

function meleeParts(t: TeamTints): Part[] {
  const p: Part[] = [];

  // legs — short and wide-set, so the wedge sits on a stable base
  add(p, box(0.17, 0.1, 0.26, { x: -0.13, y: 0.05, z: 0.03 }), 'leather');
  add(p, box(0.17, 0.1, 0.26, { x: 0.13, y: 0.05, z: 0.03 }), 'leather');
  add(p, cyl(0.065, 0.085, 0.36, 8, { x: -0.13, y: 0.28, z: 0 }), 'iron');
  add(p, cyl(0.065, 0.085, 0.36, 8, { x: 0.13, y: 0.28, z: 0 }), 'iron');

  // hip skirt + belt
  add(p, cyl(0.19, 0.27, 0.26, 10, { x: 0, y: 0.58, z: 0 }), 'leather');
  add(p, box(0.44, 0.08, 0.34, { x: 0, y: 0.73, z: 0 }), 'leather');

  // torso: the wedge itself — a broad cuirass with a rotated prow plate that
  // reads as a diamond point from above, which is the melee's whole shape cue
  add(p, box(0.46, 0.36, 0.3, { x: 0, y: 0.95, z: 0 }), 'iron');
  add(p, box(0.28, 0.3, 0.2, { x: 0, y: 0.95, z: 0.14, ry: Math.PI / 4 }), 'iron');
  add(p, box(0.2, 0.42, 0.03, { x: 0, y: 0.91, z: 0.17 }), 'cloth', t.base);
  add(p, cyl(0.1, 0.13, 0.09, 8, { x: 0, y: 1.17, z: 0 }), 'iron');

  // pauldrons + bronze trim — the widest points of the envelope
  add(p, box(0.2, 0.12, 0.26, { x: -0.31, y: 1.11, z: 0, rz: 0.25 }), 'iron');
  add(p, box(0.2, 0.12, 0.26, { x: 0.31, y: 1.11, z: 0, rz: -0.25 }), 'iron');
  add(p, box(0.21, 0.04, 0.27, { x: -0.315, y: 1.18, z: 0, rz: 0.25 }), 'bronze');
  add(p, box(0.21, 0.04, 0.27, { x: 0.315, y: 1.18, z: 0, rz: -0.25 }), 'bronze');

  // arms, dropped forward toward shield and sword
  add(p, capsule(0.065, 0.18, { x: -0.3, y: 0.93, z: 0.02, rz: 0.16 }), 'leather');
  add(p, capsule(0.065, 0.18, { x: 0.3, y: 0.93, z: 0.02, rz: -0.16 }), 'leather');
  add(p, capsule(0.06, 0.16, { x: -0.335, y: 0.65, z: 0.1, rx: 0.5 }), 'iron');
  add(p, capsule(0.06, 0.16, { x: 0.335, y: 0.65, z: 0.1, rx: 0.5 }), 'iron');

  // helm: dome, brow, slit — and the team crest that carries the read past 20 m
  add(p, sphere(0.145, 10, { sy: 0.95, x: 0, y: 1.29, z: 0 }), 'iron');
  add(p, box(0.3, 0.06, 0.28, { x: 0, y: 1.25, z: 0.02 }), 'iron');
  add(p, box(0.2, 0.035, 0.05, { x: 0, y: 1.26, z: 0.145 }), 'leather');
  add(p, box(0.05, 0.07, 0.36, { x: 0, y: 1.37, z: -0.02 }), 'bronze');
  add(p, box(0.06, 0.2, 0.34, { x: 0, y: 1.47, z: -0.02 }), 'cloth', t.lit);

  // slab shield — the left half of the silhouette
  add(p, box(0.09, 0.62, 0.46, { x: -0.36, y: 0.78, z: 0.14, rz: 0.06 }), 'iron');
  add(p, box(0.11, 0.06, 0.48, { x: -0.355, y: 1.09, z: 0.14 }), 'bronze');
  add(p, box(0.11, 0.06, 0.48, { x: -0.365, y: 0.47, z: 0.14 }), 'bronze');
  add(p, cyl(0.1, 0.12, 0.07, 8, { x: -0.42, y: 0.78, z: 0.14, rz: Math.PI / 2 }), 'bronze');
  add(p, box(0.03, 0.34, 0.26, { x: -0.43, y: 0.8, z: 0.14 }), 'cloth', t.base);

  // short stabbing sword, held low on the right
  add(p, box(0.05, 0.56, 0.11, { x: 0.4, y: 0.97, z: 0.16, rx: -0.15, rz: -0.2 }), 'iron');
  add(p, box(0.05, 0.05, 0.24, { x: 0.385, y: 0.67, z: 0.14 }), 'bronze');
  add(p, cyl(0.032, 0.032, 0.14, 6, { x: 0.378, y: 0.58, z: 0.135 }), 'leather');
  add(p, sphere(0.045, 8, { x: 0.375, y: 0.5, z: 0.132 }), 'bronze');

  // back strap — breaks the flat rear plate the 55 deg camera stares straight at
  add(p, box(0.36, 0.06, 0.05, { x: 0, y: 0.99, z: -0.16, rz: 0.6 }), 'leather');

  return p;
}

// ============================================================================
// RANGED — the tall thin robed spindle
// ============================================================================
//
// Deliberately half the melee's shoulder mass and a head taller, with the whole
// silhouette hung on one vertical line. The staff clears the hood by 0.25 m: it
// is the "visible implement" and the only part of a ranged creep that is legible
// at the top of the zoom range.

function rangedParts(t: TeamTints): Part[] {
  const p: Part[] = [];

  // robe — narrow, floor-length, no visible legs: a column, not a body
  add(p, cyl(0.15, 0.26, 0.74, 12, { x: 0, y: 0.4, z: 0 }), 'cloth');
  add(p, cyl(0.265, 0.275, 0.07, 12, { x: 0, y: 0.055, z: 0 }), 'leather');
  add(p, box(0.13, 0.07, 0.2, { x: -0.09, y: 0.035, z: 0.06 }), 'leather');
  add(p, box(0.13, 0.07, 0.2, { x: 0.09, y: 0.035, z: 0.06 }), 'leather');

  // torso + a flared team mantle high on the shoulders (cone flipped so it
  // hangs) — the one wide element, and it sits where the eye looks first
  add(p, capsule(0.125, 0.2, { x: 0, y: 0.94, z: 0 }), 'cloth');
  add(p, cone(0.25, 0.3, 12, { x: 0, y: 1.08, z: 0, rx: Math.PI }), 'cloth', t.base);
  add(p, cyl(0.25, 0.26, 0.045, 12, { x: 0, y: 0.945, z: 0 }), 'cloth', t.lit);
  add(p, box(0.3, 0.11, 0.24, { x: 0, y: 1.06, z: 0.02, rz: 0.42 }), 'cloth', t.base);

  // hood — a peak, not a head; the void under it reuses the leather bucket
  add(p, cone(0.155, 0.36, 10, { x: 0, y: 1.36, z: 0, rx: -0.1 }), 'cloth');
  add(p, cyl(0.16, 0.175, 0.05, 10, { x: 0, y: 1.2, z: 0.01 }), 'leather');
  add(p, sphere(0.085, 8, { x: 0, y: 1.26, z: 0.1 }), 'leather');
  add(p, cone(0.045, 0.16, 7, { x: 0, y: 1.57, z: -0.07, rx: 0.5 }), 'cloth', t.lit);

  // sleeves and hands, brought together in front of the staff
  add(p, capsule(0.055, 0.22, { x: -0.185, y: 0.93, z: 0.03, rz: 0.3 }), 'cloth');
  add(p, capsule(0.055, 0.22, { x: 0.185, y: 0.93, z: 0.03, rz: -0.3 }), 'cloth');
  add(p, sphere(0.06, 8, { x: -0.225, y: 0.69, z: 0.11 }), 'leather');
  add(p, sphere(0.06, 8, { x: 0.225, y: 0.69, z: 0.11 }), 'leather');
  add(p, sphere(0.045, 8, { x: -0.165, y: 1.11, z: 0.06 }), 'bronze');
  add(p, sphere(0.045, 8, { x: 0.165, y: 1.11, z: 0.06 }), 'bronze');

  // the staff — 1.74 m of it, standing a clear head above the hood
  add(p, cyl(0.028, 0.034, 1.74, 8, { x: 0.27, y: 0.9, z: 0.09, rz: -0.045 }), 'leather');
  add(p, cyl(0.036, 0.036, 0.09, 8, { x: 0.292, y: 0.06, z: 0.09 }), 'bronze');
  add(p, cyl(0.045, 0.045, 0.06, 8, { x: 0.277, y: 0.74, z: 0.09 }), 'bronze');
  add(p, cyl(0.048, 0.048, 0.07, 8, { x: 0.258, y: 1.48, z: 0.09 }), 'bronze');
  add(p, box(0.035, 0.24, 0.05, { x: 0.203, y: 1.64, z: 0.09, rz: 0.34 }), 'bronze');
  add(p, box(0.035, 0.24, 0.05, { x: 0.311, y: 1.64, z: 0.09, rz: -0.34 }), 'bronze');
  add(p, ico(0.075, 1, { x: 0.256, y: 1.69, z: 0.09 }), 'bronze');

  // belt, pouch, scroll case, satchel — asymmetry so the column is not a pole
  add(
    p,
    lathe(
      [
        { r: 0.155, y: -0.025 },
        { r: 0.185, y: 0 },
        { r: 0.155, y: 0.025 },
      ],
      12,
      { x: 0, y: 0.73, z: 0 },
    ),
    'leather',
  );
  add(p, box(0.14, 0.16, 0.1, { x: -0.195, y: 0.63, z: 0.02 }), 'leather');
  add(p, cyl(0.05, 0.05, 0.34, 8, { x: 0.11, y: 0.99, z: -0.18, rx: 0.5 }), 'leather');
  add(p, box(0.22, 0.18, 0.09, { x: 0, y: 0.85, z: -0.18 }), 'leather');

  return p;
}

// ============================================================================
// SIEGE — the wide low quadruped hauling a ram
// ============================================================================
//
// The only lane unit whose mass is horizontal. Measured envelope: 1.30 m wide
// by 3.07 m nose to tail, against a 1.10 m carapace height — a 2.4:1 plan ratio
// where melee and ranged are both roughly square. The banners give it the one
// vertical it needs to be findable in a wave, and the ram reaches 1.96 m ahead
// of the origin so the thing reads as *pointed at your tower* from above.

function siegeParts(t: TeamTints): Part[] {
  const p: Part[] = [];

  // carapace + spine ridge + rear hump
  add(p, sphere(0.55, 12, { sx: 1.12, sy: 0.62, sz: 1.42, x: 0, y: 0.78, z: -0.05 }), 'monumentStone');
  add(p, box(0.2, 0.14, 1.3, { x: 0, y: 1.1, z: -0.05 }), 'monumentStone');
  add(p, sphere(0.34, 10, { sy: 0.72, x: 0, y: 0.9, z: -0.62 }), 'monumentStone');
  add(p, cone(0.18, 0.34, 8, { x: 0, y: 0.86, z: -0.95, rx: -1.9 }), 'monumentStone');

  // head block + bronze crest
  add(p, box(0.46, 0.3, 0.4, { x: 0, y: 0.72, z: 0.72 }), 'monumentStone');
  add(p, box(0.34, 0.07, 0.26, { x: 0, y: 0.89, z: 0.7 }), 'bronze');

  // four splayed legs — the quadruped read, and the reason it looks slow
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      add(p, cyl(0.075, 0.095, 0.5, 8, { x: sx * 0.46, y: 0.4, z: sz * 0.45 }), 'iron');
      add(p, box(0.19, 0.14, 0.24, { x: sx * 0.46, y: 0.07, z: sz * 0.47 }), 'monumentStone');
    }
  }

  // the ram: bound beam, iron head, spike, two bronze bindings
  add(p, cyl(0.085, 0.095, 1.1, 10, { x: 0, y: 0.62, z: 1.05, rx: Math.PI / 2 }), 'leather');
  add(p, cyl(0.13, 0.15, 0.26, 10, { x: 0, y: 0.62, z: 1.6, rx: Math.PI / 2 }), 'iron');
  add(p, cone(0.13, 0.26, 10, { x: 0, y: 0.62, z: 1.83, rx: Math.PI / 2 }), 'iron');
  add(p, cyl(0.105, 0.105, 0.07, 10, { x: 0, y: 0.62, z: 1.22, rx: Math.PI / 2 }), 'bronze');
  add(p, cyl(0.1, 0.1, 0.07, 10, { x: 0, y: 0.62, z: 0.72, rx: Math.PI / 2 }), 'bronze');

  // yoke + harness that visibly attach the ram to the beast
  add(p, box(0.72, 0.09, 0.14, { x: 0, y: 0.86, z: 0.52 }), 'iron');
  add(p, box(0.06, 0.3, 0.09, { x: -0.26, y: 0.78, z: 0.56, rz: 0.35 }), 'leather');
  add(p, box(0.06, 0.3, 0.09, { x: 0.26, y: 0.78, z: 0.56, rz: -0.35 }), 'leather');

  // flank armour skirts
  add(p, box(0.07, 0.26, 0.9, { x: -0.6, y: 0.62, z: -0.05, rz: 0.12 }), 'iron');
  add(p, box(0.07, 0.26, 0.9, { x: 0.6, y: 0.62, z: -0.05, rz: -0.12 }), 'iron');

  // twin banners — the height cue, sized to hold at 30 m
  for (const sx of [-1, 1] as const) {
    add(p, cyl(0.032, 0.032, 1.05, 6, { x: sx * 0.3, y: 1.42, z: -0.4 }), 'leather');
    add(p, box(0.045, 0.62, 0.44, { x: sx * 0.3, y: 1.62, z: -0.62 }), 'cloth', t.base);
    add(p, box(0.055, 0.1, 0.46, { x: sx * 0.3, y: 1.96, z: -0.62 }), 'cloth', t.lit);
  }

  return p;
}

// ============================================================================
// SHADE — the spectral taper
// ============================================================================
//
// A summoned thing, so it must not read as a soldier: no boots, no shoulders,
// a hem that dissolves into wisps instead of ending. It is the ONE creep
// STYLE_BIBLE permits emissive + bloom on, spent on two eyes, a chest sigil and
// an orbiting mote — small, saturated points against a desaturated body, which
// is the whole "spectral" trick.

function shadeParts(t: TeamTints): Part[] {
  const p: Part[] = [];
  // Seeded per (kind, team): deterministic, and the two teams' shades are not
  // the same object mirrored.
  const r = rng(`rift:creep:shade:${t.key}`);
  const pale = mix(APAL.shade, APAL.paperDim, 0.25);
  const dark = mix(APAL.shade, APAL.inkDeep, 0.55);

  // body: a cone that never touches the ground, plus a wisp torso
  add(p, cone(0.3, 1.0, 10, { x: 0, y: 0.55, z: 0 }), 'cloth', pale);
  add(p, capsule(0.13, 0.16, { x: 0, y: 0.9, z: 0 }), 'cloth', pale);

  // four hem tatters, angled by the seeded generator so the dissolve is not a
  // rotationally symmetric fan
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + r.range(-0.35, 0.35);
    const len = r.range(0.24, 0.36);
    add(
      p,
      box(0.05, len, 0.16, {
        x: Math.sin(a) * 0.24,
        y: 0.12 + len * 0.2,
        z: Math.cos(a) * 0.24,
        rx: r.range(-0.3, 0.3),
        rz: r.range(-0.3, 0.3),
        ry: a,
      }),
      'cloth',
      pale,
    );
  }

  // three trailing wisps behind the hem — the "it is moving even when still"
  // cue STYLE_BIBLE §9 asks for, bought with geometry instead of a frame hook
  for (let i = 0; i < 3; i++) {
    const a = Math.PI + (i - 1) * 0.5 + r.range(-0.2, 0.2);
    add(
      p,
      cone(0.09, r.range(0.26, 0.38), 7, {
        x: Math.sin(a) * 0.2,
        y: 0.2 + r.range(0, 0.14),
        z: Math.cos(a) * 0.2,
        rx: 2.5 + r.range(-0.25, 0.25),
        ry: a,
      }),
      'cloth',
      dark,
    );
  }

  // hood + the void inside it
  add(p, cone(0.2, 0.4, 9, { x: 0, y: 1.18, z: 0, rx: -0.08 }), 'cloth', dark);
  add(p, sphere(0.1, 8, { x: 0, y: 1.12, z: 0.09 }), 'cloth', dark);
  add(p, sphere(0.1, 8, { sy: 0.7, x: -0.2, y: 1.03, z: 0 }), 'cloth', pale);
  add(p, sphere(0.1, 8, { sy: 0.7, x: 0.2, y: 1.03, z: 0 }), 'cloth', pale);

  // arms and claws, reaching forward and down
  add(p, capsule(0.045, 0.24, { x: -0.21, y: 0.84, z: 0.05, rz: 0.4 }), 'cloth', pale);
  add(p, capsule(0.045, 0.24, { x: 0.21, y: 0.84, z: 0.05, rz: -0.4 }), 'cloth', pale);
  add(p, cone(0.05, 0.16, 7, { x: -0.285, y: 0.62, z: 0.11, rx: 0.6, rz: 0.4 }), 'iron');
  add(p, cone(0.05, 0.16, 7, { x: 0.285, y: 0.62, z: 0.11, rx: 0.6, rz: -0.4 }), 'iron');

  // twin daggers — the only hard edges on the model. Held close in: the shade
  // must stay narrower than the melee wedge or the two read alike from above.
  add(p, box(0.028, 0.4, 0.075, { x: -0.29, y: 0.5, z: 0.16, rz: 0.4 }), 'iron');
  add(p, box(0.028, 0.4, 0.075, { x: 0.29, y: 0.5, z: 0.16, rz: -0.4 }), 'iron');
  add(p, box(0.03, 0.05, 0.16, { x: -0.25, y: 0.69, z: 0.155, rz: 0.4 }), 'iron');
  add(p, box(0.03, 0.05, 0.16, { x: 0.25, y: 0.69, z: 0.155, rz: -0.4 }), 'iron');

  // team band + clasp: the whole team read on a spectral unit, kept tiny
  add(p, box(0.34, 0.09, 0.22, { x: 0, y: 0.96, z: 0.02, rz: 0.36 }), 'cloth', t.base);
  add(p, box(0.1, 0.07, 0.18, { x: 0.14, y: 1.02, z: 0.05 }), 'iron');

  // emissive: two eyes and a chest sigil, on the crystal family
  add(p, sphere(0.034, 7, { x: -0.045, y: 1.13, z: 0.155 }), 'crystal', t.base);
  add(p, sphere(0.034, 7, { x: 0.045, y: 1.13, z: 0.155 }), 'crystal', t.base);
  add(p, ico(0.06, 0, { x: 0, y: 0.92, z: 0.15 }), 'crystal', t.base);

  return p;
}

// ============================================================================
// WARD — a planted totem with a bobbing eye
// ============================================================================
//
// Not a creature and must never be mistaken for one: it is rooted, symmetric
// about its stake, and its 0.41 x 0.52 m footprint is a third of a creep's.
// Measured height 1.36 m to the horn tips. It carries no HP bar (barH/barW 0),
// which is also how the pooling layer knows not to allocate one.

function wardParts(t: TeamTints): Part[] {
  const p: Part[] = [];

  // footing
  add(p, box(0.34, 0.09, 0.34, { x: 0, y: 0.045, z: 0 }), 'monumentStone');
  add(p, cyl(0.15, 0.19, 0.08, 8, { x: 0, y: 0.13, z: 0 }), 'monumentStone');

  // three root spikes pinning it to the ground — reads as *planted*
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    add(
      p,
      cone(0.045, 0.2, 6, {
        x: Math.sin(a) * 0.17,
        y: 0.08,
        z: Math.cos(a) * 0.17,
        rx: Math.cos(a) * 0.5,
        rz: -Math.sin(a) * 0.5,
      }),
      'leather',
    );
  }

  // stake + bindings + a carved collar under the head
  add(p, cyl(0.055, 0.085, 0.66, 9, { x: 0, y: 0.5, z: 0 }), 'leather');
  add(p, cyl(0.088, 0.088, 0.055, 9, { x: 0, y: 0.26, z: 0 }), 'bronze');
  add(p, cyl(0.07, 0.07, 0.055, 9, { x: 0, y: 0.74, z: 0 }), 'bronze');
  add(p, cyl(0.092, 0.092, 0.05, 10, { x: 0, y: 0.44, z: 0 }), 'bronze');
  add(p, box(0.03, 0.26, 0.14, { x: -0.1, y: 0.55, z: 0, rz: 0.06 }), 'leather');
  add(p, box(0.03, 0.26, 0.14, { x: 0.1, y: 0.55, z: 0, rz: -0.06 }), 'leather');
  add(
    p,
    lathe(
      [
        { r: 0.09, y: 0 },
        { r: 0.145, y: 0.05 },
        { r: 0.125, y: 0.1 },
        { r: 0.1, y: 0.13 },
      ],
      10,
      { x: 0, y: 0.83, z: 0 },
    ),
    'monumentStone',
  );

  // head: block, brow, horns, glyph — a face without being a face
  add(p, box(0.24, 0.22, 0.2, { x: 0, y: 1.05, z: 0 }), 'monumentStone');
  add(p, box(0.27, 0.055, 0.22, { x: 0, y: 1.15, z: 0.005 }), 'monumentStone');
  add(p, box(0.13, 0.1, 0.02, { x: 0, y: 1.05, z: 0.105 }), 'bronze');
  add(p, cone(0.045, 0.2, 7, { x: -0.115, y: 1.24, z: -0.02, rz: 0.45 }), 'bronze');
  add(p, cone(0.045, 0.2, 7, { x: 0.115, y: 1.24, z: -0.02, rz: -0.45 }), 'bronze');
  add(p, cyl(0.12, 0.14, 0.06, 8, { x: 0, y: 1.19, z: 0 }), 'monumentStone');
  add(p, cyl(0.085, 0.085, 0.045, 10, { x: 0, y: 1.23, z: 0 }), 'bronze');

  // team pennant on a short mast, the only team colour on the model
  add(p, cyl(0.022, 0.022, 0.44, 6, { x: 0.15, y: 1.1, z: -0.1 }), 'leather');
  add(p, box(0.03, 0.22, 0.2, { x: 0.15, y: 1.2, z: -0.21 }), 'cloth', t.base);
  add(p, box(0.035, 0.05, 0.21, { x: 0.15, y: 1.33, z: -0.21 }), 'bronze');

  return p;
}

// ============================================================================
// PROJ — the lit dart
// ============================================================================
//
// Centred on its own ORIGIN (not on the ground) and pointing +Z, because the
// pool orients it to flight rather than placing it on terrain. Two materials
// only: a projectile's cost is paid once per live projectile and there can be
// dozens in the air, so every extra bucket here is dozens of draw calls.

function projParts(t: TeamTints): Part[] {
  const p: Part[] = [];
  add(p, ico(0.075, 1, { sz: 1.9, x: 0, y: 0, z: 0 }), 'crystal', t.base);
  add(p, cone(0.055, 0.16, 8, { x: 0, y: 0, z: 0.2, rx: Math.PI / 2 }), 'iron');
  add(p, cone(0.05, 0.14, 8, { x: 0, y: 0, z: -0.17, rx: -Math.PI / 2 }), 'iron');
  add(p, cyl(0.062, 0.062, 0.04, 8, { x: 0, y: 0, z: 0.1, rx: Math.PI / 2 }), 'iron');
  add(p, box(0.014, 0.09, 0.13, { x: 0, y: 0.075, z: -0.1 }), 'iron');
  add(p, box(0.09, 0.014, 0.13, { x: -0.075, y: 0, z: -0.1 }), 'iron');
  add(p, box(0.09, 0.014, 0.13, { x: 0.075, y: 0, z: -0.1 }), 'iron');
  add(p, cone(0.035, 0.18, 7, { x: 0, y: 0, z: -0.29, rx: -Math.PI / 2 }), 'crystal', t.base);
  return p;
}

// ============================================================================
// The factory
// ============================================================================

/** A build with no animated carve-out. Spelled out once so the five static
 *  archetypes cannot drift apart on the null fields. */
function staticBuild(body: BakedMesh, barH: number, barW: number): UnitBuild {
  return { body, anim: null, animKind: null, animY: 0, barH, barW };
}

/**
 * Build one creep-family archetype. Called ONCE PER ARCHETYPE by R_UNITS, which
 * pools and reuses the result; never call it per entity.
 *
 * Handles `'melee' | 'ranged' | 'siege' | 'shade' | 'ward' | 'proj'`. The
 * remaining `EntKind` members belong to sibling builders — `buildHero` for
 * `'hero'`, `buildStructure` for `'tower' | 'guard' | 'ancient'`, `buildCamp`
 * for the three `camp*` tiers — and a caller that routes one of them here has a
 * dispatch bug. It gets the melee soldier rather than an exception: a builder
 * must never white-screen the game (GRAPHICS_CONTRACT §7.7), and a visibly
 * wrong unit is a bug someone reports, where a thrown error at scene-build time
 * is a black canvas nobody can diagnose.
 *
 * `team` is `EntTeam`, so it may be `NEUTRAL_TEAM`; neutrals take the neutral
 * ladder and never a team colour.
 */
export function buildCreep(kind: EntKind, team: EntTeam): UnitBuild {
  const t = tintsOf(team);

  switch (kind) {
    case 'ranged':
      return staticBuild(bake(rangedParts(t)), 1.85, 0.9);

    case 'siege':
      return staticBuild(bake(siegeParts(t)), 2.25, 1.35);

    case 'shade': {
      const body = bake(shadeParts(t));
      // Only the crystal bucket glows. `surface()` is cached per (id, tint), so
      // this is the identical instance `bake()` bucketed the eyes and sigil
      // into — no lookup by name, no fragile ordering assumption.
      bloomBuckets(body, [surface('crystal', t.base)]);
      const mote = animGeo(ico(0.085, 1), 'crystal', t.key, 3.0);
      return { body, anim: mote, animKind: 'orbit', animY: 1.45, barH: 1.75, barW: 0.9 };
    }

    case 'ward': {
      const body = bake(wardParts(t));
      const eye = animGeo(ico(0.075, 1), 'crystal', t.key, 2.6);
      // Wards carry no HP bar — barH/barW 0 is the signal to the pool, and it
      // matches the behaviour the ward has always had.
      // 1.42 clears the crown cap (1.22) and the horn tips (1.34), so the eye
      // floats BETWEEN the horns instead of intersecting them.
      return { body, anim: eye, animKind: 'bob', animY: 1.42, barH: 0, barW: 0 };
    }

    case 'proj': {
      const body = bake(projParts(t));
      bloomBuckets(body, [surface('crystal', t.base)]);
      return staticBuild(body, 0, 0);
    }

    case 'melee':
    case 'hero':
    case 'tower':
    case 'guard':
    case 'ancient':
    case 'campPack':
    case 'campBrute':
    case 'campHive':
      return staticBuild(bake(meleeParts(t)), 1.8, 0.9);
  }
}
