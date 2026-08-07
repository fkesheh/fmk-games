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
//           additively-blended wisps. The one creep permitted emissive + bloom.
//   ward    a planted totem, not a creature. No HP bar, a glowing lens glyph,
//           and an eye that turns in the cradle between its horns.
//   proj    a lit dart, centred on its own origin and pointing +Z.
//
// Team identity is TINTED TRIM on a handful of parts (crest, tabard, banner,
// sash, blazon) — never a whole-model tint, which would destroy the shape read
// the paragraph above exists to buy. Neutral entities (`NEUTRAL_TEAM`) take the
// venom-green neutral ladder; every per-team choice narrows through
// `isPlayerTeam` first, because `EntTeam` is `TeamId | 2` and a raw index into
// a two-element team tuple is the exact failure that widening invites.
//
// ---- SIZE LAW (STYLE_BIBLE §7, AMENDMENT_3 §F) -----------------------------
// A unit must read at its hitbox size. The hitboxes are `CREEP_MELEE.radius`
// 0.42, `CREEP_RANGED.radius` 0.40 and `CREEP_SIEGE.radius` 0.62 m, and §7 caps
// a creep at 1.5u tall. The measured envelopes below are held against those two
// numbers, and the siege — which shipped at 1.30 x 3.07 m and 2.01 m tall,
// 2.5x its own hitbox and taller than five of six heroes — was rebuilt to them.
//
// ---- ANTI-ALIAS FLOOR (STYLE_BIBLE §7) -------------------------------------
// "Nothing anywhere may be thin enough to alias at gameplay zoom." The bible's
// own datum is a 1.9 m hero at roughly 40 px of a 1080p frame at camH 18, i.e.
// 21.1 px/m, and screen scale is inversely proportional to camera height — so
// gameplay zoom (camH 36) is 10.5 px/m and full zoom-in (CAM_MIN_H 11) is
// 34.5 px/m. This module therefore holds a hard floor of
//
//     MIN_FEATURE_M = 0.05 m on the SMALLEST dimension of every part
//                     (~0.53 px at camH 36, ~1.7 px at camH 11)
//
// which is the width at which a plate stops dropping out entirely between
// frames. Nothing below it survived: the 14 mm projectile fins, the 20 mm ward
// glyph, the 28 mm shade dagger, the 30 mm melee tabard, the 30 mm shield
// blazon, the 35 mm visor slit and staff prongs, the 40 mm pauldron trim and
// the 44 mm pennant mast were all thickened to it or past it.
//
// ---- LAWS OBSERVED HERE ----------------------------------------------------
//  * MATERIAL LAW. This module constructs NO material at all. Body parts
//    declare `surface` / `tint` / `emissive` on the `Part` and `bake()` resolves
//    them through `partMaterial()`; the anim part declares the same three fields
//    on the `AnimPart` and R_UNITS resolves them through the same function. The
//    only kit material call in this file is the bloom-bucket LOOKUP, which asks
//    `partMaterial()` for the instance `bake()` already used.
//  * VERTEX-COLOUR LAW. Bodies go through `bake()`, which emits the white
//    `color` attribute itself. The ANIM geometries do not (AMENDMENT_3 §B), so
//    each one is run through `whiteVertexColors()` before it leaves this module
//    — without it they render black under `vertexColors: true`, with a clean
//    typecheck.
//  * UV LAW. No `texture.repeat`, no `uvLocal` on baked parts: they take
//    `bake()`'s world-space projection at 1 UV unit = 1 metre, in the build's
//    own local space (origin between the feet). The anim parts never reach
//    `bake()`, so they carry `uvLocal: true` and ship their primitive's own
//    normalised layout — which is also moot in practice, because both anim
//    parts are `crystal`, and `crystal` declares `normal: null` and
//    `roughnessMap: false`, so no sampler on that material reads a UV at all.
//  * BLOOM. Emissive alone does not glow. Each build's emissive buckets are
//    looked up by material identity and passed to `markBloom` — the whole group
//    is never marked, or the cloth and iron would haze the frame too. The anim
//    parts carry `bloom: true` and R_UNITS marks them (AMENDMENT_3 §B); this
//    module cannot, because it never sees their meshes.
//  * DETERMINISM. The only variation (shade hem tatters and trailing wisps) is
//    drawn from the kit's seeded `rng`. No `Math.random`.
//  * No per-frame allocation: everything here happens once, at init.
//  * NO GUARD ON `buildCreep`. A `bake()` merge failure means an archetype's
//    geometry is wrong, and the sanctioned response is to fail loudly rather
//    than return a hollow build: AMENDMENT_3 §G.1 forbids reporting success
//    from a catch, and an invisible creep walking a lane is the undiagnosable
//    version of the same bug. An out-of-remit `EntKind` — a caller-side
//    dispatch bug rather than a broken build — does not throw; it warns and
//    substitutes the melee soldier. This module installs no frame hook, so
//    §G.2 has nothing to guard here.
//
// ---- MEASURED COST (GRAPHICS_CONTRACT §5, AMENDMENT_3 §D) ------------------
// `bake()` merges one geometry per (surface, tint, emissive) triple, so an
// archetype's draw-call cost IS its distinct-material count, paid per live
// entity — and paid TWICE for every bucket whose surface casts a shadow,
// because `core.ts` sets `info.autoReset = false` with one `reset()` per frame
// and the meter therefore ACCUMULATES THE SHADOW PASS.
//
// Measured through `renderer.info.render.calls` in a real WebGL2 context —
// one shadow-casting directional light, one 1920x1080 frame, `autoReset =
// false`, a single `reset()` at the top, and the anim part mounted the way
// R_UNITS mounts it (`partMaterial` + `markBloom`, `castShadow` left false per
// §D.2). A lights-only scene measures 0 calls, so these are deltas already:
//
//   archetype   buckets(body+anim)  bloom meshes  DRAWS  info triangles
//   melee              5 + 0             0         10        1336
//   ranged             5 + 0             0         10        1372
//   siege              6 + 0             0         12        1528
//   shade              6 + 1             2         12        1030
//   ward               5 + 1             2         11        1072
//   proj               2 + 0             1          4         268
//   proj + school      3 + 0             2          6         268
//
// Geometry triangles (one pass) are 668 / 686 / 764 / 528 / 496 / 134, plus 64
// for the shade's mote and 80 for the ward's eye. The `info` column is higher
// because the shadow pass re-draws every CASTER: the shade's 12 draws are 7
// beauty (6 buckets + mote) plus 5 shadow, since `fxAdditive` declares
// `castShadow: false` and the anim part does not cast either.
//
// Those figures are measured, not intended, and they are the reason some part
// reuses a family it would not otherwise have chosen: visor slits and hood
// voids reuse the `leather`/`cloth` families instead of minting a dark tint of
// their own, because one extra bucket is TWO extra draw calls on every creep
// alive, and at 30 creeps that is 60 draw calls spent on four square
// centimetres of shadow.
//
// ---- MEASURED COLD LOAD (AMENDMENT_3 §E) -----------------------------------
// Cold means cold: a fresh browser process, an empty `matCache`, a real DOM so
// the kit's procedural textures actually rasterise. Six fresh pages across two
// sessions, and the two costs are separated by TIMING THEM APART rather than by
// assertion:
//
//   shared first-`surface()` texture rasterisation, 7 families   190-223 ms, then
//                                                               949-1012 ms
//   THIS MODULE, all six archetypes, after that prewarm          11.0-18.4 ms
//     (melee 4.4-6.9, ranged 2.1-4.6, siege 1.4-2.6, shade 1.4-2.3,
//      ward 0.9-1.6, proj 0.3-0.8)
//   second team, `matCache` primed                                4.0-9.1 ms
//
// The 5x spread between the two sessions is machine load, not code: what is
// bit-identical across all six pages is the draw-call, bucket, bloom and
// triangle table above. The number this module is held to is the second line,
// and it is under 5% of the 400 ms cold budget even at its worst.
//
// The first line is not this module's: it is the shared cost AMENDMENT_3 §E.3
// hoists into R_SCENE's scene construction, and it lands on whichever module
// happens to call `surface()` first. Measured, not assumed — with the prewarm
// removed, three further fresh pages charge 109 / 241 / 794 ms to whichever
// archetype is built FIRST (`melee`), a further 10.8-15.8 ms to `siege` because
// it is the first user of `monumentStone`, and 0.4-3.6 ms to every other
// archetype. The spread is SwiftShader's; what is stable across all six runs is
// that the cost tracks first USE OF A FAMILY, never an archetype's own
// geometry.
//
// A headless node process is NOT a substitute measurement and is not quoted as
// one: `kit.ts` returns image-less textures when there is no `document`, so no
// rasterisation happens at all, and four fresh vitest processes spread from
// 65 to 340 ms on first-call JIT and module transform alone. The browser
// figures above are the ones this module is held to.
// ============================================================================
import * as THREE from 'three';
import { mix } from '@platform/shared';
import { APAL } from '@rift/shared/palette.js';
import { isPlayerTeam } from '@rift/shared/types.js';
import type { EntKind, EntTeam } from '@rift/shared/types.js';
import type { SurfaceId } from '@rift/shared/surfaces.js';
import type { AnimPart, BakedMesh, EmissiveSpec, Part, UnitBuild } from '../kit.js';
import { bake, box, cone, cyl, ico, lathe, markBloom, partMaterial, rng, sphere } from '../kit.js';
import { whiteVertexColors } from '../core.js';

// ---- the anti-alias floor ----------------------------------------------------

/** The smallest dimension any part in this file is allowed to have, in metres.
 *  See the ANTI-ALIAS FLOOR note in the header for the derivation. It is a
 *  design constant rather than a runtime check: every literal below is held
 *  against it by hand, and `creeps.test.ts` pins the parts that were under it. */
const MIN_FEATURE_M = 0.05;

// ---- team identity ----------------------------------------------------------

/** The tint steps and the emissive key one side of the war is allowed to use.
 *  `key` is an APAL key NAME because emissive colour is resolved by name, while
 *  `base`/`lit` are resolved hexes for the albedo `tint`. The two are SEPARATE
 *  channels (AMENDMENT_3 §A): a team crystal is azure-tinted AND azure-glowing,
 *  and before the amendment there was no way to say both, so every crystal in
 *  the game rendered the same cream `#c9c2ae`.
 *
 *  Only two tint steps, not the family's full {base, Lit, Deep} ladder: each
 *  step used is a distinct bucket and therefore a draw call on every unit
 *  alive. Deep tones are carried by the `leather` family instead, which is
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

// ---- damage school -----------------------------------------------------------

/** The three projectile damage schools the renderer distinguishes.
 *
 *  It is declared HERE rather than imported because `shared/` has no such type:
 *  `units.ts` derives it from an ability's `fx` string, and `ability.ts`'s own
 *  `school` field is `'physical' | 'magic'` with no heal arm. See the
 *  CONTRACT_GAP note on `buildProjectile` below. */
export type ProjSchool = 'phys' | 'magic' | 'heal';

/** Albedo tint and emissive key for a school's dart tip. Physical is the bare
 *  paper white of a fired bolt; magic is the arcane violet every ability in
 *  `hero.ts` is authored in; heal is the mender green. All three are APAL
 *  entries, so the tip stays on the value ladder. */
function schoolTints(school: ProjSchool): { readonly tint: string; readonly key: string } {
  if (school === 'phys') return { tint: APAL.paper, key: 'paper' };
  if (school === 'heal') return { tint: APAL.heal, key: 'heal' };
  return { tint: APAL.arcane, key: 'arcane' };
}

// ---- shared dark accent -----------------------------------------------------
// Visor slits, hood voids and eye sockets want to be the darkest thing on the
// model. They reuse the `leather` family (albedo `trunk`, L* ~27) rather than
// minting a tinted bucket of their own: one extra bucket is one extra draw call
// on every creep alive, and at 30 creeps that is 30 draw calls spent on four
// square centimetres of shadow.

// ---- part helpers ------------------------------------------------------------

/** Push one opaque part. Split on `tint` because `exactOptionalPropertyTypes`
 *  forbids writing an explicit `undefined` into an optional field. */
function add(parts: Part[], geo: THREE.BufferGeometry, id: SurfaceId, tint?: string): void {
  if (tint === undefined) parts.push({ geo, surface: id });
  else parts.push({ geo, surface: id, tint });
}

/** Push one EMISSIVE part: tinted albedo and a separately-keyed glow, resolved
 *  by `bake()` through `emissiveSurface(id, colorKey, intensity, tint)` so the
 *  team colour survives the glow (AMENDMENT_3 §A). Its bucket is a bloom input
 *  and must be passed to `bloomBuckets` — emissive alone does not glow. */
function addGlow(
  parts: Part[],
  geo: THREE.BufferGeometry,
  id: SurfaceId,
  tint: string,
  emissive: EmissiveSpec,
): void {
  parts.push({ geo, surface: id, tint, emissive });
}

/** Enable BLOOM_LAYER on exactly the baked buckets drawn with one of `mats`.
 *  Marking `body.group` wholesale would put the cloth, iron and stone into the
 *  bloom target as well, which is the "bloom on everything" tell STYLE_BIBLE §6
 *  bans by name. Bucket meshes are identified by material identity, which is
 *  reliable because `partMaterial()` is cached per (id, tint, emissive) and
 *  therefore returns the very instance `bake()` bucketed the parts into. */
function bloomBuckets(body: BakedMesh, mats: readonly THREE.Material[]): void {
  for (const child of body.group.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    const m = child.material;
    if (Array.isArray(m)) continue;
    if (mats.includes(m)) markBloom(child);
  }
}

/** Wrap an unbaked animated carve-out as an `AnimPart` (AMENDMENT_3 §B).
 *
 *  Anim geometry does NOT pass through `bake()`, so this module owns the two
 *  things `bake()` would otherwise do for it: the vertex-colour attribute
 *  (applied here — without it the part renders black and typechecks perfectly)
 *  and the UV layout (the primitive's own normalised one, declared by building
 *  the geometry with `uvLocal: true`).
 *
 *  It carries a material DESCRIPTION, never a material: R_UNITS resolves it
 *  through `partMaterial()` and marks bloom itself. The `geo.userData.rift*`
 *  side-channel this replaced was a banned interface negotiation between
 *  siblings, and it is why the ward eye rendered with the ancient's heart
 *  material. */
function animPart(
  geo: THREE.BufferGeometry,
  id: SurfaceId,
  tint: string,
  emissive: EmissiveSpec,
): AnimPart {
  whiteVertexColors(geo);
  return { geo, surfaceId: id, tint, emissive, bloom: true };
}

// ============================================================================
// MELEE — the compact wedge behind a slab shield
// ============================================================================
//
// Measured envelope: 0.946 x 0.650 m footprint, 1.5700 m to the tip of the
// crest (the pauldrons are 0.62 m apart centre to centre; the rest of the width
// is shield and sword breaking the left and right silhouette), against a 0.42 m
// hitbox radius — 1.13x its own
// hitbox diameter across, which is what a soldier holding a shield out should
// be. From directly above the read is: rectangle (shield) | diamond (prow
// plate) | line (sword).
//
// Limbs are hexagonal `cyl` prisms rather than `capsule`s. That is not a style
// choice: `capsule()` is fixed at 6 cap segments by 12 radial, which is 312
// triangles for a 6.5 cm arm stub, and four of them made the basic melee
// soldier the heaviest creep in the game at 1820 triangles against the siege's
// 764. A 6-segment prism is 24, and at 10.5 px/m the difference is invisible.

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
  add(p, cyl(0.1, 0.13, 0.09, 8, { x: 0, y: 1.17, z: 0 }), 'iron');

  // team tabard, hung on the belt BELOW the prow plate rather than behind it.
  // 60 mm thick and tilted 0.1 rad so it touches the belt at the top (z 0.167
  // to 0.227 against a 0.17 belt face) and the hip skirt at the bottom (0.203
  // to 0.263 against a 0.266 skirt radius) — a team patch that is actually
  // visible, where the old 30 mm plate was buried inside the prow.
  add(p, box(0.22, 0.36, 0.06, { x: 0, y: 0.655, z: 0.215, rx: -0.1 }), 'cloth', t.base);

  // pauldrons + bronze trim — the widest points of the envelope
  add(p, box(0.2, 0.12, 0.26, { x: -0.31, y: 1.11, z: 0, rz: 0.25 }), 'iron');
  add(p, box(0.2, 0.12, 0.26, { x: 0.31, y: 1.11, z: 0, rz: -0.25 }), 'iron');
  add(p, box(0.21, 0.055, 0.27, { x: -0.315, y: 1.185, z: 0, rz: 0.25 }), 'bronze');
  add(p, box(0.21, 0.055, 0.27, { x: 0.315, y: 1.185, z: 0, rz: -0.25 }), 'bronze');

  // arms, dropped forward toward shield and sword
  add(p, cyl(0.065, 0.065, 0.31, 6, { x: -0.3, y: 0.93, z: 0.02, rz: 0.16 }), 'leather');
  add(p, cyl(0.065, 0.065, 0.31, 6, { x: 0.3, y: 0.93, z: 0.02, rz: -0.16 }), 'leather');
  add(p, cyl(0.06, 0.06, 0.28, 6, { x: -0.335, y: 0.65, z: 0.1, rx: 0.5 }), 'iron');
  add(p, cyl(0.06, 0.06, 0.28, 6, { x: 0.335, y: 0.65, z: 0.1, rx: 0.5 }), 'iron');

  // helm: dome, brow, slit — and the team crest that carries the read past 20 m
  add(p, sphere(0.145, 10, { sy: 0.95, x: 0, y: 1.29, z: 0 }), 'iron');
  add(p, box(0.3, 0.06, 0.28, { x: 0, y: 1.25, z: 0.02 }), 'iron');
  add(p, box(0.2, 0.05, 0.05, { x: 0, y: 1.26, z: 0.145 }), 'leather');
  add(p, box(0.05, 0.07, 0.36, { x: 0, y: 1.37, z: -0.02 }), 'bronze');
  add(p, box(0.06, 0.2, 0.34, { x: 0, y: 1.47, z: -0.02 }), 'cloth', t.lit);

  // slab shield — the left half of the silhouette
  add(p, box(0.09, 0.62, 0.46, { x: -0.36, y: 0.78, z: 0.14, rz: 0.06 }), 'iron');
  add(p, box(0.11, 0.06, 0.48, { x: -0.355, y: 1.09, z: 0.14 }), 'bronze');
  add(p, box(0.11, 0.06, 0.48, { x: -0.365, y: 0.47, z: 0.14 }), 'bronze');
  add(p, cyl(0.1, 0.12, 0.07, 8, { x: -0.42, y: 0.78, z: 0.14, rz: Math.PI / 2 }), 'bronze');
  add(p, box(0.05, 0.34, 0.26, { x: -0.44, y: 0.8, z: 0.14 }), 'cloth', t.base);

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
// silhouette hung on one vertical line. Measured envelope: 0.656 x 0.580 m
// footprint against a 0.40 m hitbox radius, 1.7704 m tall — and BOTH of those
// extremes are the staff, which is held out to x 0.339 and finishes 0.23 m
// above the hood. It is the "visible implement" and the only part of a ranged
// creep that is legible at the top of the zoom range, so it breaks the 1.5u
// body cap exactly as a hero's back-mounted weapon does; the robed body it
// hangs beside is 0.55 m across at the hem and 1.6402 m to the hood tassel.

function rangedParts(t: TeamTints): Part[] {
  const p: Part[] = [];

  // robe — narrow, floor-length, no visible legs: a column, not a body
  add(p, cyl(0.15, 0.26, 0.74, 10, { x: 0, y: 0.4, z: 0 }), 'cloth');
  add(p, cyl(0.265, 0.275, 0.07, 10, { x: 0, y: 0.055, z: 0 }), 'leather');
  add(p, box(0.13, 0.07, 0.2, { x: -0.09, y: 0.035, z: 0.06 }), 'leather');
  add(p, box(0.13, 0.07, 0.2, { x: 0.09, y: 0.035, z: 0.06 }), 'leather');

  // torso + a flared team mantle high on the shoulders (cone flipped so it
  // hangs) — the one wide element, and it sits where the eye looks first
  add(p, cyl(0.115, 0.135, 0.42, 8, { x: 0, y: 0.94, z: 0 }), 'cloth');
  add(p, cone(0.25, 0.3, 10, { x: 0, y: 1.08, z: 0, rx: Math.PI }), 'cloth', t.base);
  add(p, cyl(0.25, 0.26, 0.06, 10, { x: 0, y: 0.945, z: 0 }), 'cloth', t.lit);
  add(p, box(0.3, 0.11, 0.24, { x: 0, y: 1.06, z: 0.02, rz: 0.42 }), 'cloth', t.base);

  // hood — a peak, not a head; the void under it reuses the leather bucket
  add(p, cone(0.155, 0.36, 10, { x: 0, y: 1.36, z: 0, rx: -0.1 }), 'cloth');
  add(p, cyl(0.16, 0.175, 0.05, 10, { x: 0, y: 1.2, z: 0.01 }), 'leather');
  add(p, sphere(0.085, 6, { x: 0, y: 1.26, z: 0.1 }), 'leather');
  add(p, cone(0.045, 0.16, 7, { x: 0, y: 1.57, z: -0.07, rx: 0.5 }), 'cloth', t.lit);

  // sleeves and hands, brought together in front of the staff
  add(p, cyl(0.055, 0.055, 0.33, 6, { x: -0.185, y: 0.93, z: 0.03, rz: 0.3 }), 'cloth');
  add(p, cyl(0.055, 0.055, 0.33, 6, { x: 0.185, y: 0.93, z: 0.03, rz: -0.3 }), 'cloth');
  add(p, sphere(0.06, 6, { x: -0.225, y: 0.69, z: 0.11 }), 'leather');
  add(p, sphere(0.06, 6, { x: 0.225, y: 0.69, z: 0.11 }), 'leather');
  add(p, sphere(0.045, 6, { x: -0.165, y: 1.11, z: 0.06 }), 'bronze');
  add(p, sphere(0.045, 6, { x: 0.165, y: 1.11, z: 0.06 }), 'bronze');

  // the staff — 1.74 m of it, standing a clear head above the hood
  add(p, cyl(0.028, 0.034, 1.74, 8, { x: 0.27, y: 0.9, z: 0.09, rz: -0.045 }), 'leather');
  add(p, cyl(0.036, 0.036, 0.09, 6, { x: 0.292, y: 0.06, z: 0.09 }), 'bronze');
  add(p, cyl(0.045, 0.045, 0.06, 6, { x: 0.277, y: 0.74, z: 0.09 }), 'bronze');
  add(p, cyl(0.048, 0.048, 0.07, 6, { x: 0.258, y: 1.48, z: 0.09 }), 'bronze');
  add(p, box(0.055, 0.24, 0.06, { x: 0.203, y: 1.64, z: 0.09, rz: 0.34 }), 'bronze');
  add(p, box(0.055, 0.24, 0.06, { x: 0.311, y: 1.64, z: 0.09, rz: -0.34 }), 'bronze');
  add(p, ico(0.075, 0, { x: 0.256, y: 1.69, z: 0.09 }), 'bronze');

  // belt, pouch, scroll case, satchel — asymmetry so the column is not a pole
  add(
    p,
    lathe(
      [
        { r: 0.155, y: -0.025 },
        { r: 0.185, y: 0 },
        { r: 0.155, y: 0.025 },
      ],
      10,
      { x: 0, y: 0.73, z: 0 },
    ),
    'leather',
  );
  add(p, box(0.14, 0.16, 0.1, { x: -0.195, y: 0.63, z: 0.02 }), 'leather');
  add(p, cyl(0.05, 0.05, 0.34, 6, { x: 0.11, y: 0.99, z: -0.18, rx: 0.5 }), 'leather');
  add(p, box(0.22, 0.18, 0.09, { x: 0, y: 0.85, z: -0.18 }), 'leather');

  return p;
}

// ============================================================================
// SIEGE — the wide low quadruped hauling a ram
// ============================================================================
//
// REBUILT to its hitbox (AMENDMENT_3 §F). `CREEP_SIEGE.radius` is 0.62 m, so
// the hitbox is a 1.24 m disc, and STYLE_BIBLE §7 caps a creep at 1.5u.
// Measured envelope: 1.21 m wide x 1.60 m nose-to-tail x 1.48 m tall. The body
// sits inside the disc and only the ram breaks it forward, exactly as the
// melee's shield and sword break its own envelope; 1.60 m nose-to-tail is
// 1.29x the hitbox diameter where the shipped build was 2.5x, and 1.48 m is
// now the SHORTEST of the three lane creeps rather than taller than five of the
// six heroes.
//
// It still reads as the siege, because the read was never the height: its plan
// area is 1.94 m2 against the melee's 0.61 m2 — 3.2x — and it is the only lane
// unit standing on four legs. The banners give it the one vertical it needs to
// be findable in a wave, and the ram reaches 0.96 m ahead of the origin so the
// thing reads as *pointed at your tower* from above.

function siegeParts(t: TeamTints): Part[] {
  const p: Part[] = [];

  // carapace + spine ridge + rear hump + tail: the horizontal mass
  add(p, sphere(0.42, 12, { sx: 1.4, sy: 0.74, sz: 1.42, x: 0, y: 0.62, z: -0.03 }), 'monumentStone');
  add(p, box(0.17, 0.13, 0.84, { x: 0, y: 0.92, z: -0.03 }), 'monumentStone');
  add(p, sphere(0.24, 10, { sy: 0.75, x: 0, y: 0.8, z: -0.4 }), 'monumentStone');
  add(p, cone(0.13, 0.24, 8, { x: 0, y: 0.72, z: -0.53, rx: -1.9 }), 'monumentStone');

  // four splayed legs — the quadruped read, and the reason it looks slow
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      add(p, cyl(0.062, 0.078, 0.34, 8, { x: sx * 0.38, y: 0.27, z: sz * 0.3 }), 'iron');
      add(p, box(0.16, 0.1, 0.2, { x: sx * 0.38, y: 0.05, z: sz * 0.315 }), 'monumentStone');
    }
  }

  // head block + bronze crest, tucked under the ram
  add(p, box(0.38, 0.24, 0.3, { x: 0, y: 0.5, z: 0.46 }), 'monumentStone');
  add(p, box(0.3, 0.06, 0.22, { x: 0, y: 0.64, z: 0.44 }), 'bronze');

  // the ram: bound beam over the head, iron head, spike, two bronze bindings
  add(p, cyl(0.068, 0.078, 0.52, 10, { x: 0, y: 0.68, z: 0.36, rx: Math.PI / 2 }), 'leather');
  add(p, cyl(0.105, 0.12, 0.18, 10, { x: 0, y: 0.68, z: 0.67, rx: Math.PI / 2 }), 'iron');
  add(p, cone(0.1, 0.2, 10, { x: 0, y: 0.68, z: 0.86, rx: Math.PI / 2 }), 'iron');
  add(p, cyl(0.088, 0.088, 0.06, 10, { x: 0, y: 0.68, z: 0.2, rx: Math.PI / 2 }), 'bronze');
  add(p, cyl(0.092, 0.092, 0.06, 10, { x: 0, y: 0.68, z: 0.52, rx: Math.PI / 2 }), 'bronze');

  // yoke + harness that visibly attach the ram to the beast
  add(p, box(0.62, 0.08, 0.12, { x: 0, y: 0.8, z: 0.3 }), 'iron');
  add(p, box(0.055, 0.26, 0.08, { x: -0.22, y: 0.72, z: 0.33, rz: 0.35 }), 'leather');
  add(p, box(0.055, 0.26, 0.08, { x: 0.22, y: 0.72, z: 0.33, rz: -0.35 }), 'leather');

  // flank armour skirts — the widest points, at x +/- 0.604
  add(p, box(0.06, 0.24, 0.72, { x: -0.56, y: 0.52, z: -0.05, rz: 0.12 }), 'iron');
  add(p, box(0.06, 0.24, 0.72, { x: 0.56, y: 0.52, z: -0.05, rz: -0.12 }), 'iron');

  // twin banners — the height cue, and the only thing above the carapace
  for (const sx of [-1, 1] as const) {
    add(p, cyl(0.03, 0.03, 0.62, 6, { x: sx * 0.26, y: 1.1, z: -0.3 }), 'leather');
    add(p, box(0.055, 0.42, 0.3, { x: sx * 0.26, y: 1.2, z: -0.44 }), 'cloth', t.base);
    add(p, box(0.055, 0.08, 0.32, { x: sx * 0.26, y: 1.44, z: -0.44 }), 'cloth', t.lit);
  }

  return p;
}

// ============================================================================
// SHADE — the spectral taper
// ============================================================================
//
// A summoned thing, so it must not read as a soldier: no boots, no shoulders,
// a hem that dissolves into wisps instead of ending. Measured envelope: 0.774 x
// 0.695 m, 1.3794 m tall, and it floats — its lowest vertex is at y 0.008.
// Half-width 0.387 m, which is the number the orbiting mote is judged against.
//
// It is the ONE creep STYLE_BIBLE permits emissive + bloom on, spent on two
// eyes and a chest sigil — small, saturated, TEAM-COLOURED points against a
// desaturated body, which is the whole "spectral" trick. They are declared as
// `Part.emissive` with the team tint, so azure and ember shades no longer both
// glow the same cream (AMENDMENT_3 §A).
//
// The hem tatters and trailing wisps ride the `fxAdditive` family, which is
// what finally makes BUILD_SPECS' "translucent/spectral" reachable: before
// AMENDMENT_3 §C every surface a shade could use shipped `transparent: false`,
// so the dissolve had to be faked with a darker opaque cloth. Additive is the
// right blend for it — the hem BRIGHTENS what is behind it and fades out with
// distance from the body instead of ending on a hard silhouette edge — and the
// family declares `castShadow: false`, so the seven tatters and wisps cost one
// beauty draw and nothing at all in the shadow pass.

function shadeParts(t: TeamTints): Part[] {
  const p: Part[] = [];
  // Seeded per (kind, team): deterministic, and the two teams' shades are not
  // the same object mirrored.
  const r = rng(`rift:creep:shade:${t.key}`);
  const pale = mix(APAL.shade, APAL.paperDim, 0.25);
  const dark = mix(APAL.shade, APAL.inkDeep, 0.55);
  const glow: EmissiveSpec = { colorKey: t.key, intensity: 2.4 };

  // body: a cone that never touches the ground, plus a wisp torso
  add(p, cone(0.3, 1.0, 10, { x: 0, y: 0.55, z: 0 }), 'cloth', pale);
  add(p, cyl(0.12, 0.14, 0.4, 8, { x: 0, y: 0.9, z: 0 }), 'cloth', pale);

  // four hem tatters, angled by the seeded generator so the dissolve is not a
  // rotationally symmetric fan. 0.05 m thick — exactly the anti-alias floor.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + r.range(-0.35, 0.35);
    const len = r.range(0.24, 0.36);
    add(
      p,
      box(MIN_FEATURE_M, len, 0.16, {
        x: Math.sin(a) * 0.24,
        y: 0.12 + len * 0.2,
        z: Math.cos(a) * 0.24,
        rx: r.range(-0.3, 0.3),
        rz: r.range(-0.3, 0.3),
        ry: a,
      }),
      'fxAdditive',
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
      'fxAdditive',
      pale,
    );
  }

  // hood + the void inside it
  add(p, cone(0.2, 0.4, 9, { x: 0, y: 1.18, z: 0, rx: -0.08 }), 'cloth', dark);
  add(p, sphere(0.1, 8, { x: 0, y: 1.12, z: 0.09 }), 'cloth', dark);
  add(p, sphere(0.1, 8, { sy: 0.7, x: -0.2, y: 1.03, z: 0 }), 'cloth', pale);
  add(p, sphere(0.1, 8, { sy: 0.7, x: 0.2, y: 1.03, z: 0 }), 'cloth', pale);

  // arms and claws, reaching forward and down
  add(p, cyl(0.045, 0.045, 0.33, 6, { x: -0.21, y: 0.84, z: 0.05, rz: 0.4 }), 'cloth', pale);
  add(p, cyl(0.045, 0.045, 0.33, 6, { x: 0.21, y: 0.84, z: 0.05, rz: -0.4 }), 'cloth', pale);
  add(p, cone(0.05, 0.16, 7, { x: -0.285, y: 0.62, z: 0.11, rx: 0.6, rz: 0.4 }), 'iron');
  add(p, cone(0.05, 0.16, 7, { x: 0.285, y: 0.62, z: 0.11, rx: 0.6, rz: -0.4 }), 'iron');

  // twin daggers — the only hard edges on the model. Held close in: the shade
  // must stay narrower than the melee wedge or the two read alike from above.
  add(p, box(0.05, 0.38, 0.085, { x: -0.29, y: 0.5, z: 0.16, rz: 0.4 }), 'iron');
  add(p, box(0.05, 0.38, 0.085, { x: 0.29, y: 0.5, z: 0.16, rz: -0.4 }), 'iron');
  add(p, box(0.05, 0.055, 0.16, { x: -0.25, y: 0.69, z: 0.155, rz: 0.4 }), 'iron');
  add(p, box(0.05, 0.055, 0.16, { x: 0.25, y: 0.69, z: 0.155, rz: -0.4 }), 'iron');

  // team band + clasp: the whole opaque team read on a spectral unit, kept tiny
  add(p, box(0.34, 0.09, 0.22, { x: 0, y: 0.96, z: 0.02, rz: 0.36 }), 'cloth', t.base);
  add(p, box(0.1, 0.07, 0.18, { x: 0.14, y: 1.02, z: 0.05 }), 'iron');

  // emissive: two eyes and a chest sigil, tinted AND keyed to the team
  addGlow(p, sphere(0.034, 7, { x: -0.045, y: 1.13, z: 0.155 }), 'crystal', t.base, glow);
  addGlow(p, sphere(0.034, 7, { x: 0.045, y: 1.13, z: 0.155 }), 'crystal', t.base, glow);
  addGlow(p, ico(0.06, 0, { x: 0, y: 0.92, z: 0.15 }), 'crystal', t.base, glow);

  return p;
}

// ============================================================================
// WARD — a planted totem with a glowing lens and a turning eye
// ============================================================================
//
// Not a creature and must never be mistaken for one: it is rooted, symmetric
// about its stake, and its measured 0.406 x 0.516 m footprint is a third of a
// creep's. It reaches 0.028 m BELOW y 0, which is the three root spikes driven
// into the ground and is the whole reason it reads as planted rather than
// placed. Measured height 1.3575 m to the pennant cap; the horn tips reach 1.33
// and the crown disc tops out at 1.255, which is the number the eye's clearance
// is held against (see `buildCreep`). It carries no HP bar (barH/barW 0), which
// is also how the pooling layer knows not to allocate one.

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
  add(p, box(0.055, 0.26, 0.14, { x: -0.1, y: 0.55, z: 0, rz: 0.06 }), 'leather');
  add(p, box(0.055, 0.26, 0.14, { x: 0.1, y: 0.55, z: 0, rz: -0.06 }), 'leather');
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

  // head: block, brow, horns, crown — a face without being a face
  add(p, box(0.24, 0.22, 0.2, { x: 0, y: 1.05, z: 0 }), 'monumentStone');
  add(p, box(0.27, 0.055, 0.22, { x: 0, y: 1.15, z: 0.005 }), 'monumentStone');
  add(p, cone(0.045, 0.2, 7, { x: -0.115, y: 1.24, z: -0.02, rz: 0.45 }), 'bronze');
  add(p, cone(0.045, 0.2, 7, { x: 0.115, y: 1.24, z: -0.02, rz: -0.45 }), 'bronze');
  add(p, cyl(0.12, 0.14, 0.06, 8, { x: 0, y: 1.19, z: 0 }), 'monumentStone');
  add(p, cyl(0.085, 0.085, MIN_FEATURE_M, 10, { x: 0, y: 1.23, z: 0 }), 'bronze');

  // the lens glyph: the ward's one emissive part, 60 mm thick and standing 50 mm
  // proud of the 0.10 m head face. It is what makes the archetype legible at
  // night, and it is the reason a ward has a bloom bucket at all — the old
  // bronze plate meant a ward measured zero bloom meshes.
  addGlow(p, box(0.14, 0.11, 0.06, { x: 0, y: 1.05, z: 0.118 }), 'crystal', t.base, {
    colorKey: t.key,
    intensity: 2.2,
  });

  // team pennant on a short mast, the only cloth on the model
  add(p, cyl(0.028, 0.028, 0.44, 6, { x: 0.15, y: 1.1, z: -0.1 }), 'leather');
  add(p, box(0.055, 0.22, 0.2, { x: 0.15, y: 1.2, z: -0.21 }), 'cloth', t.base);
  add(p, box(0.055, 0.055, 0.21, { x: 0.15, y: 1.33, z: -0.21 }), 'bronze');

  return p;
}

// ============================================================================
// PROJ — the lit dart
// ============================================================================
//
// Centred on its own ORIGIN (not on the ground) and pointing +Z, because the
// pool orients it to flight rather than placing it on terrain. Measured
// envelope: 0.250 m across the fins x 0.670 m long x 0.189 m tall, spanning
// y -0.064 to 0.125 about its own origin. Two buckets when the school is
// unspecified — the nose then reuses the core's exact emissive spec, and
// intensity is part of the bucket key, so 3.0 vs 3.2 is a second draw call: a
// projectile's cost is paid once per live projectile and there can be dozens in
// the air, so every extra bucket here is dozens of draw calls — which is why
// the core, the tail flare and (absent a school) the nose all share ONE crystal
// bucket, and everything structural shares one iron bucket.
//
// `school` is the damage school of the shot. When it is null the nose takes the
// team tint and folds into the team crystal bucket; when it is given the nose
// takes the school's own accent and mints a second crystal bucket, which is the
// colour read `units.ts` used to do with `projGeo(school)`. See the
// CONTRACT_GAP note on `buildProjectile`.

function projParts(t: TeamTints, school: ProjSchool | null): Part[] {
  const p: Part[] = [];
  const core: EmissiveSpec = { colorKey: t.key, intensity: 3.0 };
  const accent = school === null ? null : schoolTints(school);
  // Intensity is part of the bucket key, so the school-less nose must reuse the
  // core's SPEC OBJECT VALUES exactly, not merely its colour, or the dart pays
  // for a second crystal bucket it does not use.
  const noseTint = accent === null ? t.base : accent.tint;
  const noseGlow: EmissiveSpec = accent === null ? core : { colorKey: accent.key, intensity: 3.2 };

  addGlow(p, ico(0.075, 0, { sz: 1.9, x: 0, y: 0, z: 0 }), 'crystal', t.base, core);
  addGlow(p, cone(0.06, 0.18, 8, { x: 0, y: 0, z: 0.22, rx: Math.PI / 2 }), 'crystal', noseTint, noseGlow);
  add(p, cyl(0.062, 0.062, 0.055, 8, { x: 0, y: 0, z: 0.1, rx: Math.PI / 2 }), 'iron');
  add(p, box(0.05, 0.1, 0.14, { x: 0, y: 0.075, z: -0.1 }), 'iron');
  add(p, box(0.1, 0.05, 0.14, { x: -0.075, y: 0, z: -0.1 }), 'iron');
  add(p, box(0.1, 0.05, 0.14, { x: 0.075, y: 0, z: -0.1 }), 'iron');
  add(p, cone(0.05, 0.14, 8, { x: 0, y: 0, z: -0.2, rx: -Math.PI / 2 }), 'iron');
  addGlow(p, cone(0.04, 0.18, 7, { x: 0, y: 0, z: -0.27, rx: -Math.PI / 2 }), 'crystal', t.base, core);
  return p;
}

// ============================================================================
// The factory
// ============================================================================

/** A build with no animated carve-out. Spelled out once so the four static
 *  archetypes cannot drift apart on the null fields. */
function staticBuild(body: BakedMesh, barH: number, barW: number): UnitBuild {
  return { body, anim: null, animKind: null, animY: 0, barH, barW };
}

/** The shade's orbiting mote: a lathed spindle, not a ball.
 *
 *  R_UNITS orbits an `'orbit'` anim part at a HARDCODED 0.55 m radius
 *  (`units.ts` frame hook) and `UnitBuild` has no field to ask for another, so
 *  a 0.085 m ball 0.55 m out from a 0.38 m half-width body read as a detached
 *  dot. Two things fix it inside this module's remit: the mote is a 0.34 m
 *  tall tapered wisp rather than a point, so it carries mass at 10.5 px/m, and
 *  `animY` drops from 1.45 (clear of the 1.38 m hood, i.e. floating in open air
 *  beside the head) to 1.15, which puts it in the same horizontal band as the
 *  arms and daggers where it reads as part of the unit. The orbit radius itself
 *  is reported as a CONTRACT_GAP. */
function moteGeo(): THREE.BufferGeometry {
  return lathe(
    [
      { r: 0, y: -0.16 },
      { r: 0.05, y: -0.09 },
      { r: 0.085, y: 0 },
      { r: 0.055, y: 0.09 },
      { r: 0, y: 0.18 },
    ],
    8,
    { uvLocal: true },
  );
}

/**
 * Build one creep-family archetype. Called ONCE PER ARCHETYPE by R_UNITS, which
 * pools and reuses the result; never call it per entity.
 *
 * Handles `'melee' | 'ranged' | 'siege' | 'shade' | 'ward' | 'proj'`. The
 * remaining `EntKind` members belong to sibling builders — `buildHero` for
 * `'hero'`, `buildStructure` for `'tower' | 'guard' | 'ancient'`, `buildCamp`
 * for the three `camp*` tiers — and a caller that routes one of them here has a
 * dispatch bug. It WARNS and gets the melee soldier rather than an exception: a
 * builder must never white-screen the game (GRAPHICS_CONTRACT §7.7), and a
 * warned, visibly wrong unit is a bug someone reports, where a silent
 * substitution is a bug nobody ever sees and a thrown error at scene-build time
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
      // barH 1.70 floats the bar 0.22 m over the rebuilt 1.48 m envelope — the
      // same clearance the melee's 1.80 gives its 1.57 m; barW 1.25 matches the
      // 1.21 m body rather than the old 1.35 m of a unit that no longer exists.
      return staticBuild(bake(siegeParts(t)), 1.7, 1.25);

    case 'shade': {
      const body = bake(shadeParts(t));
      // Only the team crystal bucket glows. `partMaterial()` is cached per
      // (id, tint, emissive), so this is the identical instance `bake()`
      // bucketed the eyes and sigil into — no lookup by name, no fragile
      // ordering assumption.
      bloomBuckets(body, [partMaterial('crystal', t.base, { colorKey: t.key, intensity: 2.4 })]);
      const mote = animPart(moteGeo(), 'crystal', t.base, { colorKey: t.key, intensity: 3.0 });
      // barH 1.60 sits 0.22 m over the 1.38 m hood, matching the melee's ratio.
      return { body, anim: mote, animKind: 'orbit', animY: 1.15, barH: 1.6, barW: 0.9 };
    }

    case 'ward': {
      const body = bake(wardParts(t));
      bloomBuckets(body, [partMaterial('crystal', t.base, { colorKey: t.key, intensity: 2.2 })]);
      const eye = animPart(ico(0.075, 1, { uvLocal: true }), 'crystal', t.base, {
        colorKey: t.key,
        intensity: 2.6,
      });
      // 'spin', NOT 'bob'. R_UNITS' bob is a +/- 0.30 m vertical sweep, which on
      // a 1.36 m totem is 44% of the whole model and drove the eye down to
      // y 1.045 — a full 0.21 m INSIDE the head block (0.94 to 1.16) and
      // through the crown disc on every cycle. A spin turns the eye in place.
      //
      // Clearance, measured against the geometry above: the tallest body vertex
      // inside the eye's own 0.075 m column about the stake axis is the top cap
      // of the bronze crown disc, at y 1.255 (the horns lean out of the column
      // by y 1.17 and their tips stand at x +/- 0.1585, y 1.33). The eye's
      // centre sits at 1.39, so its underside is at 1.315 — 0.060 m of air, and
      // still 0.0435 m at the 1.22x scale pulse R_UNITS applies to a part that
      // is neither orbiting nor bobbing. It hovers just above the cradle the
      // horns frame; `creeps.test.ts` recomputes both figures from the vertices
      // rather than trusting this comment.
      //
      // Wards carry no HP bar — barH/barW 0 is the signal to the pool.
      return { body, anim: eye, animKind: 'spin', animY: 1.39, barH: 0, barW: 0 };
    }

    case 'proj':
      return buildProjectile(team, null);

    case 'melee':
      return staticBuild(bake(meleeParts(t)), 1.8, 0.9);

    default:
      console.warn(
        `rift creeps: buildCreep() was handed out-of-remit EntKind '${kind}' — ` +
          `'hero' belongs to buildHero, 'tower'/'guard'/'ancient' to buildStructure and ` +
          `'campPack'/'campBrute'/'campHive' to buildCamp. Substituting the melee soldier; ` +
          `this is a caller-side dispatch bug.`,
      );
      return staticBuild(bake(meleeParts(t)), 1.8, 0.9);
  }
}

/**
 * Build a projectile whose nose carries its DAMAGE SCHOOL as well as its team.
 *
 * CONTRACT_GAP (reported, not worked around): `buildCreep(kind, team)` is the
 * frozen signature and it cannot express a projectile's school, so routing
 * projectiles through it drops the colour read `units.ts:445`'s `projGeo(school)`
 * used to do — phys paper-white, magic arcane violet, heal mender green. The
 * gap is in `UnitBuild`/`buildCreep`, which have no channel for a per-kind
 * discriminator, and closing it properly means either a `buildCreep` overload
 * or a school field on the build request. Neither is mine to add.
 *
 * What is preserved here instead of invented: the read itself. This is the real
 * implementation and `buildCreep('proj', team)` is `buildProjectile(team, null)`
 * — the school-less path is complete and correct on its own (a team-tinted,
 * team-glowing dart, which is a stronger read than the school accent was), and
 * a caller that knows the school gets the accent back for one extra bucket.
 * Nothing negotiates: if R_UNITS is never told, the frozen path is still right.
 */
export function buildProjectile(team: EntTeam, school: ProjSchool | null): UnitBuild {
  const t = tintsOf(team);
  const body = bake(projParts(t, school));
  const mats = [partMaterial('crystal', t.base, { colorKey: t.key, intensity: 3.0 })];
  if (school !== null) {
    const n = schoolTints(school);
    mats.push(partMaterial('crystal', n.tint, { colorKey: n.key, intensity: 3.2 }));
  }
  bloomBuckets(body, mats);
  return staticBuild(body, 0, 0);
}
