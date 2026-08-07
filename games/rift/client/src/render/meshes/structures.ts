// ============================================================================
// ANCIENTS (rift) — STRUCTURE MESHES (R_MESH_STRUCT).
//
// `buildStructure(kind, team)` builds the map's three landmarks: the lane
// tower, the ancient's guard tower, and the Ancient itself. R_UNITS calls it
// ONCE PER ARCHETYPE at init and pools the result — never per entity — so
// nothing here is on a hot path, nothing here is cached internally (two callers
// must get two independent `THREE.Group`s, since a Group has one parent), and
// nothing here allocates after construction.
//
// ---- THE READ (STYLE_BIBLE §7) ---------------------------------------------
// These are the tallest things in the game and the only things a player who has
// just panned can orient on, so every one of them is designed to be identified
// from ACROSS the map, in silhouette, at 55 deg from above:
//
//   tower    9.4 m. A tapered octagonal shaft on a wide quarried plinth, a
//            flaring carved cornice on corbels, and an OPEN crown arcade — four
//            posts and four lintels with nothing on top — so the brazier fire
//            burning inside it is visible from the top-down camera. A roof over
//            that brazier would hide the single feature that makes a tower read
//            at night. Two banners break the vertical envelope; the team
//            crystal turns above the crown at 10.2 m.
//   guard    9.3 m and 22% broader in XZ, capped by a solid drum and TWIN HORNS
//            instead of an arcade, with its brazier exposed on the cap. From
//            above it is a fatter footprint with two spurs; from the side it is
//            broader and a shade lower where the lane tower is slender. It
//            flanks the Ancient and must never be counted as a lane tower at a
//            glance — which is a navigation error, since the two sit in
//            completely different parts of the map.
//   ancient  14 m. A kneeling colossus of cracked monument stone that kneels
//            BEHIND the dais centre and reaches forward and down, its two arms
//            and its bowed helm closing AROUND the suspended crystal heart —
//            which is what "around" in §7 means for a single figure. Under the
//            heart, a gold pool set into a three-tier dais catches its light.
//            The biggest silhouette in the game and the brightest thing in a
//            wide base shot.
//
// ---- WHY THE BRAZIER FIRE IS TEAM-COLOURED ---------------------------------
// Deliberate, and it does two jobs. STYLE_BIBLE §1: "the two teams are the only
// saturated warm/cold lights" in a cool damp world; §4: at night "the team
// lights, ability FX, brazier fires and the ancients' hearts become the primary
// light sources in the frame". A team-coloured flame IS that light. It also
// collapses the flame, the shaft glyphs and the crystal into ONE emissive
// bucket, and a bucket is a draw call paid on every structure alive.
//
// ---- DRAW-CALL ARITHMETIC (GRAPHICS_CONTRACT §5) ---------------------------
// `bake()` merges one geometry per (surface, tint) pair, so an archetype's
// draw-call cost IS its distinct-material count, paid once per live structure.
// A 3-lane match stands up 12 lane towers, 4 guards and 2 Ancients, so every
// bucket on a tower costs 16 draw calls across the map — which is why the two
// stone roles here are two FAMILIES rather than two tints of one:
//
//   tower / guard  cliffRock (plinth, kerb, buttresses, weathering) ·
//                  monumentStone (shaft, cornice, corbels, arcade) · bronze
//                  (brazier, bands, banner crossbars) · cloth+team (banners) ·
//                  crystal+team emissive (glyphs, brazier fire)      = 5
//   ancient        monumentStone · monumentStone+monumentLit (crown, pauldron
//                  caps, faceplate) · cliffRock (dais, cracks, rubble) · gold
//                  (pool, lip, filigree) · bronze (braziers) · cloth+team
//                  (banners) · crystal+team emissive (glyph ring, veins,
//                  fires) · fern+fernDeep (creepers)                 = 8
//
// Plus one for the unbaked anim part. 16*(5+1) + 2*(8+1) = 114 draw calls for
// every landmark on the map. The quarried plinth reading as a DIFFERENT stone
// from the dressed shaft is therefore not decoration — it is the same bucket a
// dark tint would have cost, spent on the material variety STYLE_BIBLE §0.2
// asks for instead.
//
// ---- DAMAGED VS HEALTHY ----------------------------------------------------
// The spec asks for a damaged-vs-healthy read "if it is cheap", and it is,
// because a hidden mesh costs zero draw calls. Every build carries a second
// rough-stone bucket — `cliffRock` tinted `cliffDeep`: fallen blocks around the
// foot, spall scars up the shaft, a shed slab. It is baked into its own bucket,
// named `rift:structDamage`, flagged `userData.riftDamage`, and shipped
// `visible = false`. R_UNITS shows it when the structure drops below half hp.
// The default is the healthy read, so a consumer that never learns about the
// flag still renders a correct, intact tower — the failure mode of the opposite
// default (every tower permanently ruined) is not recoverable downstream.
// Baked-in weathering that ANY standing structure plausibly has (chipped
// arrises, lichened patches) is not part of that layer and is always visible.
//
// ---- CONTRACT NOTE: the anim part has nowhere to carry its material ---------
// `UnitBuild.anim` is a bare `BufferGeometry` and `UnitBuild` has no field for
// the material it should be drawn with. Under the amended material law that
// information cannot be recovered downstream (the `paintGeo` vertex-paint route
// is gone), so R_UNITS has no sanctioned way to know a tower crystal is an
// emissive that must also be bloom-marked. Reported upstream as a CONTRACT_GAP;
// R_MESH_CREEP and R_MESH_CAMP hit the identical defect. Until it is resolved
// this module uses the SAME workaround they chose, so R_UNITS needs one code
// path and not three: the constructed kit material and its description ride on
// the geometry's `userData` (`riftMaterial`, `riftSurface`, `riftEmissiveKey`,
// `riftEmissiveIntensity`, `riftBloom`). Additive, free, and neither of us
// touches a frozen file.
//
// ---- LAWS OBSERVED HERE ----------------------------------------------------
//  * MATERIAL LAW. Every material comes from the kit's `surface()` /
//    `emissiveSurface()`. There is no `new THREE.Mesh*Material` in this file.
//  * VERTEX-COLOUR LAW. Bodies go through `bake()`, which emits the white
//    `color` attribute itself; baked AO then MULTIPLIES into it. The two anim
//    geometries do not go through `bake()`, so each is run through
//    `whiteVertexColors()` — without it they render black.
//  * UV LAW. No `texture.repeat`, no `uvLocal`: parts take `bake()`'s
//    world-space projection at 1 UV unit = 1 metre in the build's own local
//    space (origin centred at the foot of the structure), so a tower's stone
//    seams match the paving it stands on and every instance is identical.
//  * BLOOM. Emissive alone does not glow. The emissive crystal bucket and the
//    gold bucket are located by material identity and marked individually — the
//    whole group is never marked, or the stone and cloth would haze the frame.
//    Gold is a bloom target with NO emissive (see the `gold` note in
//    shared/surfaces.ts): it blooms off the sun's specular anchor in the
//    environment, which is why it is marked but not lit from within.
//  * THE CRYSTAL RE-POINT. `bake()` has no emissive path — it resolves every
//    bucket through `surface(id, tint)`, and `surface('crystal', tint)` carries
//    the family's default PALE WARD emissive at intensity 2.2, which at that
//    strength swamps the tint and renders every team crystal cream-white. A
//    cream glyph course is exactly the opposite of §1's "the two teams are the
//    only saturated warm/cold lights". So the crystal bucket is re-pointed once
//    at build time — never per frame — to the `emissiveSurface()` material of
//    the same colour. No material is minted: both come out of the kit's own
//    factories and its cache. The re-point is applied to the MESH and to the
//    returned `BakedPart` in the same step, and `parts` is rebuilt rather than
//    mutated, because a consumer reading a material out of `BakedMesh.parts`
//    must see the material that actually renders. Recorded as a CONTRACT_GAP;
//    R_MESH_HERO hit and solved the identical defect the identical way.
//  * BAKED AO. Every non-metal, non-emissive bucket is run through
//    `bakeVertexAO`. It is skipped on bronze and gold because metalness 1 zeroes
//    the diffuse term and a vertex colour cannot reach it, and on the emissive
//    bucket because darkening its albedo does nothing a glow would show.
//  * DETERMINISM. Weathering and rubble placement draw from the kit's seeded
//    `rng`, keyed on (kind, team). No `Math.random`.
//  * No per-frame allocation: everything here happens once, at init.
// ============================================================================
import * as THREE from 'three';
import { APAL } from '@rift/shared/palette.js';
import type { StructureKind, TeamId } from '@rift/shared/types.js';
import type { SurfaceId } from '@rift/shared/surfaces.js';
import type { BakedMesh, BakedPart, LatheVec, Part, Rng, UnitBuild } from '../kit.js';
import {
  bake,
  bakeVertexAO,
  box,
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

/** The one tint step and the one emissive key a side of the war is allowed to
 *  use. `key` is an APAL key NAME because `emissiveSurface` resolves colours by
 *  name; `base` is the resolved hex for `surface(id, tint)`, and the two are the
 *  SAME colour so the crystal re-point in `finish()` can match the flat bucket
 *  to its glowing replacement by material identity alone.
 *
 *  Deliberately ONE step and not the family's {base, Lit, Deep} ladder: every
 *  step used is a distinct (surface, tint) pair and therefore a draw call on
 *  every one of the map's eighteen structures. The lighter and darker reads are
 *  bought with form and with the two stone families instead.
 *
 *  Structures are never neutral — `buildStructure` takes `TeamId`, not
 *  `EntTeam` — so there is no third entry and no `isPlayerTeam` narrowing to do
 *  here, unlike the creep and camp builders. */
interface TeamTints {
  readonly base: string;
  readonly key: string;
}

const AZURE: TeamTints = { base: APAL.azure, key: 'azure' };
const EMBER: TeamTints = { base: APAL.ember, key: 'ember' };

function tintsOf(team: TeamId): TeamTints {
  return team === 0 ? AZURE : EMBER;
}

// ---- tuning -----------------------------------------------------------------

/** Emissive intensity of the glyph courses, crystal insets and brazier fires
 *  baked into a structure's BODY. One value per body, because every distinct
 *  intensity mints its own cached material and therefore its own draw-call
 *  bucket on every structure alive. Tuned per STYLE_BIBLE §4 to be pleasant
 *  under the 2.75 day exposure and dominant under the 1.9 night one. */
const BODY_GLOW = 1.9;
/** The turning tower crystal. Brighter than the body glyphs — it is the single
 *  point a player finds a tower by across the map at night. */
const TOWER_CRYSTAL_GLOW = 2.6;
/** The Ancient's heart. The brightest emissive in the game by design: "the
 *  ancient should be the single brightest thing in a wide base shot".
 *
 *  The ladder stops at 3.2 rather than going higher: measured on a render at
 *  the day exposure of 2.75, everything above ~3.5 tone-maps to flat white and
 *  the team HUE is gone — a white heart is a lamp, not team identity, and the
 *  bloom pass then has nothing coloured to spread. Night is where these
 *  dominate, and night drops the exposure to 1.9 for them rather than raising
 *  the emissive here. */
const HEART_GLOW = 3.2;

/** Baked-AO strength for structures. Half, not full: these are large masses
 *  read at distance, and the screen-space pass in STYLE_BIBLE §6 supplies the
 *  contact darkening at close zoom. Pushed higher the corbel undersides and the
 *  arcade interior go to mud in a wide shot. */
const AO_STRENGTH = 0.5;

// ---- part helpers -----------------------------------------------------------

/** Push one part. Split on `tint` because `exactOptionalPropertyTypes` forbids
 *  writing an explicit `undefined` into an optional field. */
function add(parts: Part[], geo: THREE.BufferGeometry, id: SurfaceId, tint?: string): void {
  if (tint === undefined) parts.push({ geo, surface: id });
  else parts.push({ geo, surface: id, tint });
}

/** The two rotations that aim a Y-up primitive down the unit vector (ux,uy,uz),
 *  in the kit's own application order (scale → rx → rz → ry → translate).
 *
 *  With `rx` left at 0 the chain reduces to: +Y --rz--> (-sin rz, cos rz, 0)
 *  --ry--> (-sin rz·cos ry, cos rz, sin rz·sin ry). Matching that to the target
 *  gives rz = acos(uy) and ry = atan2(uz, -ux) — the closed form below. It is
 *  what lets a limb be authored as the two joint centres it spans instead of as
 *  a length plus two hand-solved Euler angles. */
function aimY(ux: number, uy: number, uz: number): { readonly rz: number; readonly ry: number } {
  const rz = Math.acos(Math.max(-1, Math.min(1, uy)));
  const h = Math.hypot(ux, uz);
  return { rz, ry: h < 1e-6 ? 0 : Math.atan2(uz, -ux) };
}

/** One irregular block of quarried stone.
 *
 *  A bare `ico(size, 0)` is a Platonic solid, which STYLE_BIBLE §11 bans by
 *  name — and rightly: twenty identical faces read as a die at any zoom. Three
 *  INDEPENDENT scale axes plus a full three-axis rotation turn the same twenty
 *  triangles into a lump that never repeats and never reads as a solid, at zero
 *  extra cost. Every caller draws from the seeded generator, so the whole spoil
 *  ring is deterministic and no two adjacent blocks are the same shape. */
function boulder(
  parts: Part[],
  r: Rng,
  size: number,
  x: number,
  y: number,
  z: number,
  tint?: string,
): void {
  const geo = ico(size, 0, {
    sx: r.range(0.68, 1.4),
    sy: r.range(0.42, 0.95),
    sz: r.range(0.68, 1.4),
    rx: r.range(-0.55, 0.55),
    ry: r.next() * Math.PI * 2,
    rz: r.range(-0.55, 0.55),
    x,
    y,
    z,
  });
  add(parts, geo, 'cliffRock', tint);
}

/** An octagonal limb spanning two joint centres. `r` is the limb radius.
 *
 *  A cylinder and not a `capsule()`: the kit's capsule is fixed at 6 cap
 *  segments by 12 radial, which is ~300 triangles a limb, and eleven of those
 *  on the Ancient cost more in the `bakeVertexAO` occupancy pass than the whole
 *  rest of the build. Eight-sided limbs with a sphere at every articulated
 *  joint read BETTER on a stone colossus anyway — cut stone is faceted — and
 *  every flat end here is covered by the joint, the pelvis, a pauldron or a
 *  gold wristband, so no disc is ever visible. */
function limb(
  parts: Part[],
  id: SurfaceId,
  r: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  tint?: string,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.max(1e-3, Math.hypot(dx, dy, dz));
  const aim = aimY(dx / len, dy / len, dz / len);
  add(
    parts,
    cyl(r, r, len, 8, {
      rz: aim.rz,
      ry: aim.ry,
      x: (ax + bx) * 0.5,
      y: (ay + by) * 0.5,
      z: (az + bz) * 0.5,
    }),
    id,
    tint,
  );
}

/** Prepare an unbaked animated carve-out: satisfy the vertex-colour law and
 *  attach the material it is meant to be drawn with (see the CONTRACT NOTE in
 *  the header). Returns the same geometry. */
function animGeo(geo: THREE.BufferGeometry, colorKey: string, intensity: number): THREE.BufferGeometry {
  whiteVertexColors(geo);
  geo.userData['riftMaterial'] = emissiveSurface('crystal', colorKey, intensity);
  geo.userData['riftSurface'] = 'crystal';
  geo.userData['riftEmissiveKey'] = colorKey;
  geo.userData['riftEmissiveIntensity'] = intensity;
  geo.userData['riftBloom'] = true;
  return geo;
}

// ============================================================================
// TOWER + GUARD — the lane landmark and its stouter cousin
// ============================================================================
//
// Measured envelope, lane tower: 5.3 x 4.9 m footprint including the kerb ring,
// 9.4 m to the crown finials, crystal turning at 10.2 m, 1596 triangles. Guard:
// 6.3 x 5.6 m footprint, 9.4 m to the horn tips, 1620 triangles. From directly
// above the lane tower reads octagon | four-post square | fire; the guard reads
// a bigger octagon | drum | two spurs. Nothing on either is thin enough to
// alias at gameplay zoom — the thinnest member is the 0.20 m banner crossbar.

/** Plinth: quarried, unsquared, wider than it needs to be. It is the whole
 *  contact story — a 9 m shaft rising straight out of the moss reads as pasted
 *  on, and the flared foot plus the half-sunken kerb ring is what stops that. */
const PLINTH_PROFILE: readonly LatheVec[] = [
  { r: 0.0, y: 0.0 },
  { r: 1.95, y: 0.0 },
  { r: 1.95, y: 0.3 },
  { r: 1.76, y: 0.36 },
  { r: 1.76, y: 0.62 },
  { r: 1.5, y: 0.72 },
  { r: 1.4, y: 0.9 },
];

/** Shaft, with entasis: the taper is convex, not straight, so the column does
 *  not read as visually pinched at mid-height. Eight-sided, because a lathe at
 *  seg 8 IS an octagonal shaft and the arrises catch the low sun. */
const SHAFT_PROFILE: readonly LatheVec[] = [
  { r: 1.34, y: 0.86 },
  { r: 1.27, y: 1.6 },
  { r: 1.19, y: 2.6 },
  { r: 1.08, y: 3.8 },
  { r: 0.96, y: 5.0 },
  { r: 0.87, y: 6.1 },
  { r: 0.83, y: 6.6 },
];

/** Cornice: a real moulding — fillet, ovolo, corona, cavetto — turned in one
 *  lathe. This is the form that reads as *carved* rather than *stacked* from
 *  across the map, and it is the shadow-detail success criterion of
 *  STYLE_BIBLE §10a.2 ("a tower's shadow must show its cornice and brazier as
 *  distinct forms"). */
const CORNICE_PROFILE: readonly LatheVec[] = [
  { r: 0.83, y: 6.6 },
  { r: 1.02, y: 6.72 },
  { r: 1.02, y: 6.9 },
  { r: 1.46, y: 7.1 },
  { r: 1.5, y: 7.3 },
  { r: 1.34, y: 7.44 },
  { r: 1.3, y: 7.52 },
];

/** Brazier bowl: a lathed hemisphere on a short stem, open to the sky. */
const BRAZIER_PROFILE: readonly LatheVec[] = [
  { r: 0.16, y: 0.0 },
  { r: 0.2, y: 0.14 },
  { r: 0.46, y: 0.3 },
  { r: 0.62, y: 0.5 },
  { r: 0.66, y: 0.62 },
  { r: 0.56, y: 0.6 },
  { r: 0.4, y: 0.44 },
];

/** Guard cap drum, replacing the lane tower's open arcade. */
const DRUM_PROFILE: readonly LatheVec[] = [
  { r: 1.3, y: 7.52 },
  { r: 1.3, y: 7.86 },
  { r: 1.18, y: 7.96 },
  { r: 1.18, y: 8.2 },
  { r: 0.0, y: 8.2 },
];

/** The brazier, its legs and its fire. `y` is the bowl's seat; the fire sits in
 *  the bowl and its three tongues lean outward so the flame reads as motion
 *  even in a still frame (STYLE_BIBLE §9). */
function brazier(parts: Part[], t: TeamTints, y: number, s: number): void {
  add(parts, lathe(BRAZIER_PROFILE, 10, { sx: s, sz: s, y }), 'bronze');
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    add(
      parts,
      box(0.11 * s, 0.34 * s, 0.11 * s, {
        rz: Math.cos(a) * 0.26,
        rx: -Math.sin(a) * 0.26,
        x: Math.cos(a) * 0.3 * s,
        y: y - 0.14 * s,
        z: Math.sin(a) * 0.3 * s,
      }),
      'bronze',
    );
  }
  // ember bed — a squashed icosphere filling the bowl mouth
  add(
    parts,
    ico(0.42 * s, 1, { sy: 0.42, x: 0, y: y + 0.44 * s, z: 0 }),
    'crystal',
    t.base,
  );
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 1.1;
    add(
      parts,
      cone(0.19 * s, 0.66 * s, 6, {
        rz: -Math.cos(a) * 0.3,
        rx: Math.sin(a) * 0.3,
        x: Math.cos(a) * 0.16 * s,
        y: y + 0.76 * s,
        z: Math.sin(a) * 0.16 * s,
      }),
      'crystal',
      t.base,
    );
  }
}

/** One hanging banner: a cloth panel with a bronze crossbar and a torn tail,
 *  set on the face `a` radians round the shaft. Banners are the tower's only
 *  silhouette break below the cornice and the reason a tower is not a cylinder
 *  from every angle.
 *
 *  Both banners hang on the +Z half, at 45 deg either side of front, and not on
 *  opposite faces. The camera yaw in this game is FIXED (STYLE_BIBLE §5), so a
 *  banner on the far face is a banner the player never sees; splaying two
 *  across the near half means the whole team-coloured area is always facing the
 *  frame. It is also what "banners on the WINDWARD side" means — one side. */
function banner(parts: Part[], t: TeamTints, a: number, radius: number, top: number): void {
  const bx = Math.cos(a) * radius;
  const bz = Math.sin(a) * radius;
  const face = -a + Math.PI / 2;
  add(parts, box(1.34, 0.16, 0.22, { ry: face, x: bx, y: top, z: bz }), 'bronze');
  add(parts, box(1.14, 2.1, 0.08, { ry: face, x: bx, y: top - 1.14, z: bz }), 'cloth', t.base);
  add(
    parts,
    box(0.78, 0.62, 0.08, { ry: face, rx: 0.14, x: bx, y: top - 2.44, z: bz }),
    'cloth',
    t.base,
  );
}

function towerParts(t: TeamTints, guard: boolean, seed: string): { body: Part[]; dmg: Part[] } {
  const parts: Part[] = [];
  const dmg: Part[] = [];
  const r = rng(seed);
  const B = guard ? 1.22 : 1.0;

  // ---- ground tie: half-sunken kerb stones round the plinth ----------------
  // Six, not eight: at this radius eight reads as a deliberate ring of bollards
  // and six with seeded size and lean reads as spoil that was never cleared.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + r.range(-0.25, 0.25);
    const s = r.range(0.42, 0.78);
    boulder(parts, r, s, Math.cos(a) * 2.05 * B, r.range(0.16, 0.32), Math.sin(a) * 2.05 * B);
  }

  // ---- plinth + corner buttresses -----------------------------------------
  add(parts, lathe(PLINTH_PROFILE, 8, { sx: B, sz: B }), 'cliffRock');
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    add(
      parts,
      box(0.44 * B, 0.86, 0.66 * B, {
        rx: 0.16,
        ry: -a + Math.PI / 2,
        x: Math.cos(a) * 1.62 * B,
        y: 0.43,
        z: Math.sin(a) * 1.62 * B,
      }),
      'cliffRock',
    );
  }

  // ---- shaft ---------------------------------------------------------------
  add(parts, lathe(SHAFT_PROFILE, 8, { sx: B, sz: B }), 'monumentStone');
  // four pilaster ribs on the cardinal faces: they catch the raking sun and
  // give the shaft a vertical grain the octagon alone does not have
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    add(
      parts,
      box(0.34 * B, 5.3, 0.3 * B, {
        ry: -a + Math.PI / 2,
        x: Math.cos(a) * 1.06 * B,
        y: 3.5,
        z: Math.sin(a) * 1.06 * B,
      }),
      'monumentStone',
    );
  }
  // two turned string courses breaking the shaft into storeys
  add(parts, cyl(1.24 * B, 1.3 * B, 0.2, 8, { y: 1.78 }), 'monumentStone');
  add(parts, cyl(0.94 * B, 1.0 * B, 0.18, 8, { y: 5.22 }), 'monumentStone');
  // bronze bands: the warm metal catching light against cold stone
  add(parts, cyl(1.16 * B, 1.16 * B, 0.14, 8, { y: 1.1 }), 'bronze');
  add(parts, cyl(0.88 * B, 0.88 * B, 0.12, 8, { y: 5.9 }), 'bronze');

  // ---- glyph course: the night read ---------------------------------------
  // Six inset crystal channels round the shaft at eye height for the camera.
  // These are what tell a player whose tower it is from the far side of the map
  // after dark, when the banners are unlit shapes.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    add(
      parts,
      box(0.2, 1.05, 0.14, {
        ry: -a + Math.PI / 2,
        x: Math.cos(a) * 1.06 * B,
        y: 3.35,
        z: Math.sin(a) * 1.06 * B,
      }),
      'crystal',
      t.base,
    );
  }

  // ---- cornice on corbels --------------------------------------------------
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    add(
      parts,
      box(0.3 * B, 0.4, 0.5 * B, {
        rx: -0.2,
        ry: -a + Math.PI / 2,
        x: Math.cos(a) * 0.96 * B,
        y: 6.5,
        z: Math.sin(a) * 0.96 * B,
      }),
      'monumentStone',
    );
  }
  add(parts, lathe(CORNICE_PROFILE, 8, { sx: B, sz: B }), 'monumentStone');

  if (guard) {
    // ---- guard crown: solid drum, twin horns, exposed brazier -------------
    add(parts, lathe(DRUM_PROFILE, 8, { sx: B, sz: B }), 'monumentStone');
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      add(
        parts,
        box(0.36 * B, 0.44, 0.28 * B, {
          ry: -a + Math.PI / 2,
          x: Math.cos(a) * 1.06 * B,
          y: 7.7,
          z: Math.sin(a) * 1.06 * B,
        }),
        'monumentStone',
      );
    }
    for (const sgn of [-1, 1] as const) {
      add(
        parts,
        box(0.44, 0.5, 0.62, { x: sgn * 0.86 * B, y: 8.32, z: 0 }),
        'monumentStone',
      );
      add(
        parts,
        cone(0.28, 1.1, 6, { rz: -sgn * 0.34, x: sgn * 1.06 * B, y: 8.82, z: 0 }),
        'monumentStone',
      );
    }
    brazier(parts, t, 8.2, 1.05 * B);
  } else {
    // ---- lane crown: open arcade, fire burning inside it -------------------
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      add(
        parts,
        box(0.3, 1.2, 0.3, {
          ry: -a,
          x: Math.cos(a) * 1.02,
          y: 8.12,
          z: Math.sin(a) * 1.02,
        }),
        'monumentStone',
      );
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      add(
        parts,
        box(1.62, 0.26, 0.26, {
          ry: -a,
          x: Math.cos(a) * 0.72,
          y: 8.84,
          z: Math.sin(a) * 0.72,
        }),
        'monumentStone',
      );
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      add(
        parts,
        cone(0.2, 0.44, 5, { x: Math.cos(a) * 1.02, y: 9.19, z: Math.sin(a) * 1.02 }),
        'monumentStone',
      );
    }
    brazier(parts, t, 7.56, 1.0);
  }

  // ---- banners on the windward side ---------------------------------------
  banner(parts, t, Math.PI * 0.25, 1.14 * B, 6.1);
  banner(parts, t, Math.PI * 0.75, 1.14 * B, 6.1);

  // ---- weathering: always visible, never a state --------------------------
  // Chipped arrises and lichened patches any standing tower has. Kept in the
  // quarried-stone family so it costs no bucket of its own.
  for (let i = 0; i < 5; i++) {
    const a = r.next() * Math.PI * 2;
    const s = r.range(0.16, 0.34);
    boulder(parts, r, s, Math.cos(a) * 1.1 * B, r.range(1.2, 6.0), Math.sin(a) * 1.1 * B);
  }

  // ---- damage layer: hidden until R_UNITS reveals it -----------------------
  for (let i = 0; i < 6; i++) {
    const a = r.next() * Math.PI * 2;
    const d = r.range(1.9, 3.1);
    const s = r.range(0.3, 0.62);
    boulder(dmg, r, s, Math.cos(a) * d * B, s * 0.3, Math.sin(a) * d * B, APAL.cliffDeep);
  }
  for (let i = 0; i < 3; i++) {
    const a = r.next() * Math.PI * 2;
    add(
      dmg,
      box(0.3, r.range(1.0, 1.9), 0.2, {
        rz: r.range(-0.2, 0.2),
        ry: -a + Math.PI / 2,
        x: Math.cos(a) * 1.08 * B,
        y: r.range(2.0, 5.0),
        z: Math.sin(a) * 1.08 * B,
      }),
      'cliffRock',
      APAL.cliffDeep,
    );
  }
  // the shed slab: a cornice fragment leaning against the plinth
  add(
    dmg,
    box(0.9, 1.3, 0.42, { rx: 0.5, rz: 0.24, x: 1.5 * B, y: 0.75, z: -1.0 * B }),
    'cliffRock',
    APAL.cliffDeep,
  );

  return { body: parts, dmg };
}

/** The turning team crystal: a six-sided bipyramid, which is what a crystal
 *  actually is and what the `crystal` family's flat shading was chosen for. One
 *  primitive, so no merge is needed to hand it back as a single geometry. */
function towerCrystalGeo(): THREE.BufferGeometry {
  return lathe(
    [
      { r: 0.0, y: -0.56 },
      { r: 0.26, y: -0.16 },
      { r: 0.34, y: 0.06 },
      { r: 0.19, y: 0.36 },
      { r: 0.0, y: 0.66 },
    ],
    6,
  );
}

// ============================================================================
// ANCIENT — the kneeling colossus
// ============================================================================
//
// Measured envelope: 10.9 x 10.3 m including the spoil ring, 14.0 m to the
// crown spikes, 6.8 m across the pauldrons, 3072 triangles. It kneels on -Z and
// reaches forward, so from
// the 55 deg camera the read is: three concentric octagons (the dais) | a gold
// disc | two great arms curving in | a bowed helm and a six-point crown above
// them, with the heart burning in the gap the arms leave. Every one of those
// bands is a different value, which is what makes it legible at the far end of
// a 2048 map.
//
// The colossus is authored as joint centres and spanned with `limb()`, not as
// hand-solved boxes, because a kneeling pose has eleven non-axis-aligned
// members and solving each one by eye is how a figure ends up subtly
// disjointed at the knees.

const DAIS_T1: readonly LatheVec[] = [
  { r: 0.0, y: 0.0 },
  { r: 4.4, y: 0.0 },
  { r: 4.4, y: 0.38 },
  { r: 4.18, y: 0.46 },
  { r: 4.18, y: 0.6 },
];
const DAIS_T2: readonly LatheVec[] = [
  { r: 0.0, y: 0.6 },
  { r: 3.6, y: 0.6 },
  { r: 3.6, y: 0.94 },
  { r: 3.42, y: 1.02 },
  { r: 3.42, y: 1.14 },
];
const DAIS_T3: readonly LatheVec[] = [
  { r: 0.0, y: 1.14 },
  { r: 2.98, y: 1.14 },
  { r: 2.98, y: 1.44 },
  { r: 2.82, y: 1.5 },
  { r: 2.82, y: 1.62 },
];
/** The gold pool's lip: a closed annular moulding, so the pool reads as INSET
 *  into the dais rather than as a disc lying on it. */
const POOL_LIP: readonly LatheVec[] = [
  { r: 1.72, y: 1.5 },
  { r: 1.98, y: 1.5 },
  { r: 1.98, y: 1.72 },
  { r: 1.8, y: 1.74 },
  { r: 1.72, y: 1.62 },
  { r: 1.72, y: 1.5 },
];
const ANC_BRAZIER: readonly LatheVec[] = [
  { r: 0.2, y: 0.0 },
  { r: 0.26, y: 0.2 },
  { r: 0.6, y: 0.42 },
  { r: 0.82, y: 0.7 },
  { r: 0.88, y: 0.86 },
  { r: 0.74, y: 0.84 },
  { r: 0.52, y: 0.62 },
];

function ancientParts(t: TeamTints, seed: string): { body: Part[]; dmg: Part[] } {
  const parts: Part[] = [];
  const dmg: Part[] = [];
  const r = rng(seed);

  // ---- dais ---------------------------------------------------------------
  add(parts, lathe(DAIS_T1, 8), 'cliffRock');
  add(parts, lathe(DAIS_T2, 8), 'cliffRock');
  add(parts, lathe(DAIS_T3, 8), 'monumentStone');
  // approach steps on the +Z face
  for (let i = 0; i < 3; i++) {
    add(
      parts,
      box(3.4 - i * 0.5, 0.32, 0.7, { x: 0, y: 0.16 + i * 0.44, z: 4.5 - i * 0.66 }),
      'cliffRock',
    );
  }
  // spoil ring: unsquared blocks never cleared from the foot of the dais
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + r.range(-0.18, 0.18);
    const s = r.range(0.5, 0.95);
    boulder(parts, r, s, Math.cos(a) * 4.62, r.range(0.18, 0.36), Math.sin(a) * 4.62);
  }
  // glyph ring set into the second tier's rim
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    add(
      parts,
      box(0.46, 0.2, 0.14, {
        ry: -a + Math.PI / 2,
        x: Math.cos(a) * 3.5,
        y: 0.84,
        z: Math.sin(a) * 3.5,
      }),
      'crystal',
      t.base,
    );
  }
  // creepers: the ruin is half-swallowed (STYLE_BIBLE §1). Four leaf clumps
  // wedged into the tier joints — one bucket, two instances in the whole game.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.9;
    const tier = i % 2 === 0;
    add(
      parts,
      ico(tier ? 0.62 : 0.5, 1, {
        sy: 0.4,
        ry: r.next() * Math.PI * 2,
        x: Math.cos(a) * (tier ? 3.62 : 3.0),
        y: tier ? 0.62 : 1.16,
        z: Math.sin(a) * (tier ? 3.62 : 3.0),
      }),
      'fern',
      APAL.fernDeep,
    );
  }

  // ---- gold: the pool under the heart, and the ornament it echoes ----------
  add(parts, lathe(POOL_LIP, 16), 'gold');
  add(parts, cyl(1.76, 1.76, 0.08, 16, { y: 1.6 }), 'gold');

  // ---- the colossus: kneeling at -Z, reaching to the dais centre -----------
  // Joint centres, authored once and reused by every limb so the pose stays
  // internally consistent when a number is tuned.
  const HIP_Y = 4.7;
  const HIP_Z = -1.85;
  const SHO_Y = 10.05;
  const SHO_Z = -1.1;
  const SHO_X = 2.55;

  // left leg: shin flat on the dais, knee down — the kneel
  limb(parts, 'monumentStone', 0.46, -1.35, 1.98, -0.35, -1.35, 2.02, 1.15);
  add(parts, box(1.0, 0.42, 1.5, { x: -1.35, y: 1.86, z: 1.9 }), 'monumentStone');
  add(parts, sphere(0.6, 8, { x: -1.32, y: 2.3, z: 1.1 }), 'monumentStone');
  limb(parts, 'monumentStone', 0.62, -1.32, 2.3, 1.1, -1.2, HIP_Y - 0.3, HIP_Z + 0.5);
  // right leg: foot planted, knee raised — the asymmetry that makes it a pose
  add(parts, box(1.14, 0.46, 1.66, { rx: -0.1, x: 1.5, y: 1.85, z: 1.5 }), 'monumentStone');
  limb(parts, 'monumentStone', 0.5, 1.5, 1.98, 1.35, 1.56, 4.0, 0.75);
  add(parts, sphere(0.64, 8, { x: 1.56, y: 4.05, z: 0.75 }), 'monumentStone');
  limb(parts, 'monumentStone', 0.66, 1.56, 4.0, 0.75, 1.28, HIP_Y - 0.25, HIP_Z + 0.5);

  // pelvis + torso, leaning forward over the heart. The torso TAPERS at the
  // waist and flares at the chest: a constant-width stack reads as a wall from
  // the 55 deg camera, and a wall is the one thing a figure must not be.
  add(parts, box(2.5, 1.3, 1.9, { rx: 0.14, x: 0, y: HIP_Y, z: HIP_Z }), 'monumentStone');
  add(parts, box(2.05, 1.7, 1.6, { rx: 0.16, x: 0, y: 6.0, z: -1.68 }), 'monumentStone');
  add(parts, box(2.4, 1.8, 1.7, { rx: 0.17, x: 0, y: 7.6, z: -1.42 }), 'monumentStone');
  add(parts, box(2.75, 1.7, 1.75, { rx: 0.18, x: 0, y: 9.2, z: -1.15 }), 'monumentStone');
  // breastplate slab, proud of the chest so it casts its own shadow line
  add(parts, box(2.0, 1.5, 0.4, { rx: 0.18, x: 0, y: 8.85, z: -0.35 }), 'monumentStone', APAL.monumentLit);
  // crystal veins running up the chest, under the plate's edge
  for (const sgn of [-1, 1] as const) {
    add(
      parts,
      box(0.16, 2.4, 0.14, { rx: 0.18, rz: sgn * 0.1, x: sgn * 0.66, y: 7.4, z: -0.66 }),
      'crystal',
      t.base,
    );
  }
  // gorget: the neck break that lets the head read as a HEAD and not as the
  // next box up the stack
  add(parts, cyl(0.62, 0.82, 0.72, 8, { rx: 0.3, y: 10.5, z: -0.85 }), 'monumentStone');
  add(parts, box(0.9, 0.3, 0.2, { rx: 0.18, x: 0, y: 9.62, z: -0.42 }), 'gold');

  // Pauldrons: the widest thing in the game and the whole silhouette from
  // above. They slope steeply DOWN and OUT (rz -sgn*0.5), so the camera sees a
  // raking plane and a shadow, not a tabletop — the flat-topped version read as
  // a roof and buried the head under it. The Lit step is a narrow rim along the
  // outer edge, which is a highlight line rather than a second slab.
  for (const sgn of [-1, 1] as const) {
    const tilt = -sgn * 0.5;
    add(
      parts,
      box(1.9, 0.8, 2.15, { rz: tilt, rx: 0.1, x: sgn * SHO_X, y: SHO_Y, z: SHO_Z }),
      'monumentStone',
    );
    add(
      parts,
      box(0.42, 0.34, 2.25, { rz: tilt, x: sgn * 3.38, y: 9.62, z: SHO_Z }),
      'monumentStone',
      APAL.monumentLit,
    );
    add(
      parts,
      box(0.5, 0.44, 0.5, { rz: tilt, x: sgn * 3.06, y: 9.82, z: SHO_Z - 0.86 }),
      'monumentStone',
    );
    add(
      parts,
      box(0.5, 0.44, 0.5, { rz: tilt, x: sgn * 3.06, y: 9.82, z: SHO_Z + 0.86 }),
      'monumentStone',
    );
  }

  // head: bowed over the heart, faceless, and raised clear of the pauldrons so
  // it is the highest and lightest mass between them. A blank mask is more
  // monumental than a face and survives the 40-110 px read a face would not.
  add(parts, box(1.6, 1.75, 1.7, { rx: 0.36, x: 0, y: 11.6, z: -0.62 }), 'monumentStone');
  add(parts, box(1.25, 1.35, 0.32, { rx: 0.36, x: 0, y: 11.38, z: 0.22 }), 'monumentStone', APAL.monumentLit);
  add(parts, box(1.3, 0.45, 1.3, { rx: 0.36, x: 0, y: 10.72, z: -0.35 }), 'monumentStone');
  add(parts, cyl(1.0, 0.84, 0.34, 8, { rx: 0.3, y: 12.45, z: -0.86 }), 'monumentStone', APAL.monumentLit);
  add(parts, cyl(0.88, 0.88, 0.15, 8, { rx: 0.3, y: 12.66, z: -0.92 }), 'gold');
  // six-point crown: the last 1.4 m of the 14 m, alternating tall and short so
  // it reads as a crown rather than a chimney from directly above. The tallest
  // spike tip IS the Ancient's 14 m — the §7 figure is measured here.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const h = i % 2 === 0 ? 1.55 : 1.1;
    add(
      parts,
      cone(0.24, h, 5, {
        rz: -Math.cos(a) * 0.3,
        rx: Math.sin(a) * 0.3 + 0.3,
        x: Math.cos(a) * 0.6,
        y: 12.5 + h * 0.42,
        z: Math.sin(a) * 0.6 - 0.96,
      }),
      'monumentStone',
      APAL.monumentLit,
    );
  }

  // Arms: shoulder (high, inside) → elbow (low, OUTSIDE and forward) → wrist
  // (low, inside), which from the fixed front camera is a wide V closing on the
  // heart. The first pass ran them almost straight down and they read as two
  // porch columns; the outward sweep is what makes them read as arms and what
  // makes the figure "close AROUND" the heart rather than stand behind it.
  for (const sgn of [-1, 1] as const) {
    limb(parts, 'monumentStone', 0.66, sgn * 2.5, SHO_Y - 0.35, SHO_Z + 0.1, sgn * 3.1, 7.15, 0.9);
    add(parts, sphere(0.68, 8, { x: sgn * 3.1, y: 7.15, z: 0.9 }), 'monumentStone');
    limb(parts, 'monumentStone', 0.56, sgn * 3.1, 7.15, 0.9, sgn * 1.4, 6.2, 0.45);
    add(
      parts,
      cyl(0.52, 0.58, 0.32, 8, { rz: sgn * 1.1, x: sgn * 1.58, y: 6.28, z: 0.48 }),
      'gold',
    );
    // cupped hand: a palm slab and three finger blocks curling toward centre
    add(
      parts,
      box(0.8, 0.34, 0.9, { rz: sgn * 0.5, x: sgn * 1.06, y: 6.06, z: 0.34 }),
      'monumentStone',
    );
    for (let f = 0; f < 3; f++) {
      add(
        parts,
        box(0.52, 0.24, 0.24, {
          rz: sgn * 0.9,
          x: sgn * (0.74 - f * 0.05),
          y: 6.3 + f * 0.1,
          z: 0.66 - f * 0.34,
        }),
        'monumentStone',
      );
    }
  }

  // back banners hanging from the pauldrons — the vertical the back needs
  for (const sgn of [-1, 1] as const) {
    add(parts, box(0.2, 0.16, 1.9, { x: sgn * 2.35, y: 9.5, z: -2.1 }), 'bronze');
    add(parts, box(0.09, 3.5, 1.6, { x: sgn * 2.35, y: 7.65, z: -2.1 }), 'cloth', t.base);
    add(
      parts,
      box(0.09, 0.9, 1.1, { rx: -0.15, x: sgn * 2.35, y: 5.72, z: -2.02 }),
      'cloth',
      t.base,
    );
  }

  // dais braziers, flanking the approach
  for (const sgn of [-1, 1] as const) {
    const bx = sgn * 3.1;
    const bz = 1.9;
    add(parts, lathe(ANC_BRAZIER, 10, { x: bx, y: 1.14, z: bz }), 'bronze');
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      add(
        parts,
        box(0.14, 0.44, 0.14, {
          rz: Math.cos(a) * 0.24,
          rx: -Math.sin(a) * 0.24,
          x: bx + Math.cos(a) * 0.38,
          y: 0.94,
          z: bz + Math.sin(a) * 0.38,
        }),
        'bronze',
      );
    }
    add(parts, ico(0.56, 1, { sy: 0.42, x: bx, y: 1.76, z: bz }), 'crystal', t.base);
    for (let i = 0; i < 2; i++) {
      const a = i === 0 ? 0.7 : 3.6;
      add(
        parts,
        cone(0.24, 0.86, 6, {
          rz: -Math.cos(a) * 0.28,
          rx: Math.sin(a) * 0.28,
          x: bx + Math.cos(a) * 0.2,
          y: 2.2,
          z: bz + Math.sin(a) * 0.2,
        }),
        'crystal',
        t.base,
      );
    }
  }

  // ---- cracks: always visible. It is CRACKED monument stone (§7), so the
  // fissures are part of the healthy read, not the damage state. ------------
  for (let i = 0; i < 8; i++) {
    const a = r.next() * Math.PI * 2;
    const y = r.range(4.6, 10.6);
    add(
      parts,
      box(r.range(0.14, 0.26), r.range(0.9, 2.2), 0.2, {
        rz: r.range(-0.35, 0.35),
        ry: -a + Math.PI / 2,
        x: Math.cos(a) * 1.5,
        y,
        z: Math.sin(a) * 1.0 - 1.4,
      }),
      'cliffRock',
    );
  }
  // the shed pauldron corner: a broken wedge that is missing from one shoulder
  // and lying on the dais below it — the one narrative injury the figure has
  add(
    parts,
    box(1.05, 0.7, 1.1, { rx: 0.5, ry: 0.6, rz: 0.3, x: -3.1, y: 1.95, z: -0.3 }),
    'cliffRock',
  );

  // ---- damage layer: hidden until R_UNITS reveals it -----------------------
  for (let i = 0; i < 8; i++) {
    const a = r.next() * Math.PI * 2;
    const d = r.range(4.7, 6.4);
    const s = r.range(0.45, 1.0);
    boulder(dmg, r, s, Math.cos(a) * d, s * 0.3, Math.sin(a) * d, APAL.cliffDeep);
  }
  for (let i = 0; i < 4; i++) {
    const a = r.next() * Math.PI * 2;
    add(
      dmg,
      box(0.42, r.range(1.6, 2.8), 0.3, {
        rz: r.range(-0.3, 0.3),
        ry: -a + Math.PI / 2,
        x: Math.cos(a) * 1.7,
        y: r.range(5.5, 9.5),
        z: Math.sin(a) * 1.2 - 1.4,
      }),
      'cliffRock',
      APAL.cliffDeep,
    );
  }

  return { body: parts, dmg };
}

/** The Ancient's heart: an eight-sided gem, wider than it is deep, faceted by
 *  the `crystal` family's flat shading. One primitive, no merge. */
function heartGeo(): THREE.BufferGeometry {
  return lathe(
    [
      { r: 0.0, y: -0.98 },
      { r: 0.34, y: -0.4 },
      { r: 0.66, y: 0.06 },
      { r: 0.54, y: 0.36 },
      { r: 0.3, y: 0.66 },
      { r: 0.0, y: 1.02 },
    ],
    8,
  );
}

// ============================================================================
// buildStructure
// ============================================================================

/**
 * Bake a build and apply, in ONE pass over the buckets, the four things every
 * structure needs and none of them may skip: the crystal re-point, selective
 * bloom, baked AO where a vertex colour can actually reach, and the hidden
 * damage layer. Shared by all three kinds precisely so none of them can be
 * quietly finished differently from the others.
 *
 * `withGold` is false on the towers, which carry no gold at all — bronze is the
 * ornament metal there and gold is reserved for the Ancient, so the treasure
 * read means something when a player finally sees it.
 */
function finish(body: Part[], dmg: Part[], t: TeamTints, withGold: boolean): BakedMesh {
  const all: Part[] = body.slice();
  for (const p of dmg) all.push(p);
  const baked = bake(all);

  // `surface()` is cached per (id, tint), so these are the very instances
  // `bake()` bucketed into — identity, not a lookup by name or by order.
  const flatCrystal = surface('crystal', t.base);
  const glow = emissiveSurface('crystal', t.key, BODY_GLOW);
  const goldMat = withGold ? surface('gold') : null;
  const damageMat = surface('cliffRock', APAL.cliffDeep);

  const parts: BakedPart[] = [];
  for (const bucket of baked.parts) {
    const isGlow = bucket.material === flatCrystal;
    const material = isGlow ? glow : bucket.material;
    const mesh = baked.group.children.find(
      (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.geometry === bucket.geo,
    );
    if (mesh !== undefined) {
      mesh.material = material;
      if (isGlow || (goldMat !== null && material === goldMat)) markBloom(mesh);
      if (bucket.material === damageMat) {
        mesh.name = 'rift:structDamage';
        mesh.userData['riftDamage'] = true;
        mesh.visible = false;
      }
    }
    // Metal buckets are skipped: metalness 1 zeroes the diffuse term and a
    // vertex colour cannot reach it. The glow bucket is skipped: darkening the
    // albedo under an emissive that strong changes nothing on screen.
    if (!isGlow && material.metalness === 0) bakeVertexAO(bucket.geo, AO_STRENGTH);
    parts.push({ geo: bucket.geo, material });
  }
  return { group: baked.group, parts };
}

/**
 * The map's landmarks. Pure: same arguments produce the same geometry, all
 * variation drawn from the kit's seeded `rng`, so a caller may cache per key —
 * but a cached `BakedMesh` cannot be added to the scene twice, since its
 * `group` has one parent. R_UNITS calls this once per archetype and pools.
 *
 * Measured part counts (STYLE_BIBLE §7): tower 76, guard 73, ancient 123 —
 * inside the 55-80 and 110-160 budgets. Measured heights: tower 9.4 m to the
 * crown finials with the crystal turning at 10.2 m, guard 9.4 m to the horn
 * tips, ancient 14.0 m to the crown spikes. Measured triangles: 1596 / 1620 /
 * 3072, so all eighteen structures on a 3-lane map cost 31.8 k of the 1.2 M
 * budget and 114 of the 700 draw calls.
 *
 * `barH` sits just clear of the STONE, not of the crystal: the turning crystal
 * and the brazier flames are allowed to cross the bar, exactly as the tower
 * props do in the game this is benchmarked against, because a bar hoisted above
 * every prop floats half a metre off the structure and reads as detached.
 *
 * Structures are never neutral, which is why this takes `TeamId`, not `EntTeam`.
 */
export function buildStructure(kind: StructureKind, team: TeamId): UnitBuild {
  const t = tintsOf(team);

  if (kind === 'ancient') {
    const built = ancientParts(t, `rift:ancient:${team}`);
    const body = finish(built.body, built.dmg, t, true);
    return {
      body,
      anim: animGeo(heartGeo(), t.key, HEART_GLOW),
      animKind: 'bob',
      // the heart hangs in the ring the arms and the bowed helm close around,
      // directly over the gold pool that reflects it
      animY: 6.55,
      barH: 14.4,
      barW: 3.4,
    };
  }

  const guard = kind === 'guard';
  const built = towerParts(t, guard, `rift:${kind}:${team}`);
  const body = finish(built.body, built.dmg, t, false);
  return {
    body,
    anim: animGeo(towerCrystalGeo(), t.key, TOWER_CRYSTAL_GLOW),
    animKind: 'orbit',
    animY: guard ? 10.1 : 10.2,
    barH: guard ? 9.7 : 9.8,
    barW: guard ? 2.6 : 2.4,
  };
}
