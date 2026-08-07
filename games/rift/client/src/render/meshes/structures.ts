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
// ---- THE CAMERA IS FIXED, AND IT LOOKS DOWN +Z ------------------------------
// `scene.ts` parks the camera at `(gx, y, gz - back)` and calls
// `lookAt(gx, groundY, gz)`, and `units.ts` explicitly EXEMPTS `tower`/`guard`/
// `ancient` from the yaw it gives every mobile. So a structure's local axes ARE
// world axes, permanently:
//
//     -Z is the near face, the one the player sees.   +Z is never seen.
//     +Y is the top, seen at 55 deg.                  -Y is never seen.
//
// Everything that carries identity — banners, the breastplate, the chest veins,
// the approach — is on -Z. The first cut of this module put both team banners
// at +Z and buried the Ancient's heart behind the figure's own back, so this is
// stated here rather than left to be re-derived.
//
// ---- THE READ (STYLE_BIBLE §7) ---------------------------------------------
// These are the tallest things in the game and the only things a player who has
// just panned can orient on, so every one of them is designed to be identified
// from ACROSS the map, in silhouette, at 55 deg from above:
//
//   tower    9.41 m. A tapered octagonal shaft on a wide quarried plinth, a
//            flaring carved cornice on corbels, and an OPEN crown arcade — four
//            posts, four tangential lintels and four finials with nothing over
//            the middle — so the brazier fire burning inside it is visible from
//            the top-down camera. A ray dropped straight down the tower's own
//            axis hits the FIRE, at y 8.21, before it hits any stone. A roof
//            over that brazier would hide the single feature that makes a tower
//            read at night. Two banners on the near face break the vertical
//            envelope; the team crystal turns above the crown at 10.2 m.
//   guard    9.10 m — 0.32 m LOWER than the lane tower, and 18% broader in X /
//            14% in Z (4.81 x 4.46 m against 5.69 x 5.10 m) — capped by a solid
//            drum and TWIN HORNS instead of an arcade, with its brazier exposed
//            on the cap and NO turning crystal at all. From above the lane tower
//            reads octagon | four-post square | a point of light orbiting; the
//            guard reads a bigger octagon | drum | two spurs | a fire that stays
//            put. It flanks the Ancient and must never be counted as a lane
//            tower at a glance — which is a navigation error, since the two sit
//            in completely different parts of the map. Height, footprint, crown
//            shape and the presence or absence of an orbiting light are four
//            independent tells; the first cut had the guard TALLER than the
//            tower (9.58 against 9.41) under a comment claiming it was lower,
//            and gave both the same crystal turning at 10.1 / 10.2 m.
//   ancient  13.93 m. A kneeling colossus of cracked monument stone that kneels
//            BEHIND the dais centre and reaches forward and down, its two arms
//            and its bowed helm closing AROUND the suspended crystal heart —
//            which is what "around" in §7 means for a single figure. Under the
//            heart, a gold pool set into a three-tier dais catches its light,
//            and two team standards flank the approach steps on the near face.
//            The biggest silhouette in the game and the brightest thing in a
//            wide base shot.
//
// ---- WHY THE BRAZIER FIRE IS TEAM-COLOURED ---------------------------------
// Deliberate, and it does two jobs. STYLE_BIBLE §1: "the two teams are the only
// saturated warm/cold lights" in a cool damp world; §4: at night "the team
// lights, ability FX, brazier fires and the ancients' hearts become the primary
// light sources in the frame". A team-coloured flame IS that light. It also
// collapses the flame, the shaft glyphs and the crystal insets into ONE emissive
// bucket, and a bucket is a draw call paid on every structure alive.
//
// ---- DRAW-CALL ARITHMETIC (AMENDMENT_3 §D, AMENDMENT_4 §F) -----------------
// The meter accumulates the SHADOW PASS (`core.ts` sets `info.autoReset = false`
// with one `reset()` per frame), and `bake()` now buckets by
// (surfaceId, tint, emissive), which is strictly finer than it was. The first
// cut of this module reported 114 — that was the OBJECT count, not the draw
// count, and the real figure was more than double it. This module was named the
// single largest consumer of the 700-draw gate, so the bucket count is cut here
// rather than argued about:
//
//   tower / guard  cliffRock (plinth, kerb, buttresses, weathering)
//                  monumentStone (shaft, ribs, courses, corbels, cornice,
//                                 crown, brazier bowl, banner crossbars)
//                  crystal + team tint + team emissive (glyphs, fire)
//                  cloth + team tint (banner panels)                     = 4
//   ancient        cliffRock · monumentStone · crystal+team emissive ·
//                  gold · bronze · fern · cloth+team                     = 7
//
// Three buckets were spent to buy that back. **Bronze is gone from the towers**
// — the brazier bowl, its legs and the banner crossbars are stone now, and the
// two bronze shaft bands are deleted outright (they sat at radius 1.16/0.88
// inside a shaft of radius 1.27/0.89, so they were buried geometry that never
// drew a pixel). A tower is two stones, one glow and one cloth; the first metal
// a player ever sees on this map is the Ancient's gold, which is the read the
// `withGold` split was always for. **`monumentLit` is gone from the Ancient** —
// same surface as `monumentStone`, so it was the one pair that AMENDMENT_3 §D.4
// names literally, and its highlight job moves to the gold faceplate. **The
// Ancient's back banners are gone** — they hung at +Z, which after the figure
// was turned to face the camera is the face nothing ever sees; two standards on
// the approach replace them at the same part cost and are actually visible.
//
// Shadow casters follow AMENDMENT_3 §D.2, which names "banners" and "ferns" as
// non-casters and "FX, motes" with them. `SurfaceDef.castShadow` (AMENDMENT_4
// §C) cannot express this: `cloth`, `fern` and `crystal` all have solid,
// shadow-casting users elsewhere in the game. So the opt-out is per bucket and
// per module, exactly as §C leaves ferns and ground cover to R_VEG:
//
//   cloth   — §D.2 names banners.
//   fern    — §D.2 names ferns.
//   crystal — the bucket is a brazier FIRE plus recessed glyphs. A flame is
//             light, not matter; §D.2 puts FX and motes outside the pass for
//             the same reason. FLAGGED FOR R_SCENE, which owns overall policy.
//
// Measured through `renderer.info` on a real WebGL2 context with the shadow map
// enabled, at 3 lanes (12 lane towers, 4 guards, 2 Ancients — 18 structures):
// see the block above `buildStructure`.
//
// ---- DAMAGED VS HEALTHY ----------------------------------------------------
// The spec asks for a damaged-vs-healthy read "if it is cheap", and it is,
// because a hidden mesh costs zero draw calls in the colour pass AND zero in
// the shadow pass — three.js skips `visible === false` before either. Every
// build carries a second rough-stone bucket — `cliffRock` tinted `cliffDeep`:
// fallen blocks around the foot, spall scars up the shaft, a shed slab. It is
// baked into its own bucket, named `rift:structDamage`, flagged
// `userData.riftDamage`, and shipped `visible = false`. R_UNITS shows it when
// the structure drops below half hp. The default is the healthy read, so a
// consumer that never learns about the flag still renders a correct, intact
// tower — the failure mode of the opposite default (every tower permanently
// ruined) is not recoverable downstream. Baked-in weathering that ANY standing
// structure plausibly has (chipped arrises, lichened patches) is not part of
// that layer and is always visible.
//
// ---- LAWS OBSERVED HERE ----------------------------------------------------
//  * MATERIAL LAW. Every material comes from the kit's `surface()` /
//    `emissiveSurface()` / `partMaterial()`. There is no `new THREE.Mesh*Material`
//    in this file, and no bucket is re-pointed after `bake()`. A glowing part
//    declares `Part.emissive` and `bake()` builds it through
//    `emissiveSurface(id, colorKey, intensity, tint)` — which is what keeps the
//    team tint on the game's primary glow surface (AMENDMENT_3 §A). The
//    re-point workaround this module used to carry discarded that tint and
//    rendered every team crystal cream `#c9c2ae`; it is deleted.
//  * VERTEX-COLOUR LAW. Bodies go through `bake()`, which emits the white
//    `color` attribute itself; baked AO then MULTIPLIES into it. The tower
//    crystal does NOT go through `bake()`, so `crystalAnim()` runs
//    `whiteVertexColors()` on it — without it the anim part renders BLACK with
//    a perfectly clean typecheck.
//  * UV LAW. No `texture.repeat`, no `uvLocal`: baked parts take `bake()`'s
//    world-space projection at 1 UV unit = 1 metre in the build's own local
//    space (origin centred at the foot of the structure), so a tower's stone
//    seams match the paving it stands on and every instance is identical. The
//    anim part needs no UV scaling of its own and gets none: `SURFACES.crystal`
//    is the one family in the table with `normal: null` and
//    `roughnessMap: false`, so it samples no texture and its UVs are unused.
//  * ANIM PARTS ARE TYPED. `UnitBuild.anim` is an `AnimPart` (AMENDMENT_3 §B):
//    geometry plus `surfaceId`, `tint`, `emissive` and `bloom`. The
//    `userData.rift*` side-channel three mesh modules invented is deleted — it
//    was a sibling interface negotiation, and it is what made `units.ts` hand
//    the ward eye the Ancient's heart material.
//  * BLOOM. Emissive alone does not glow. The emissive crystal bucket and the
//    gold bucket are located by material identity and marked individually — the
//    whole group is never marked, or the stone and cloth would haze the frame.
//    Gold is a bloom target with NO emissive (see the `gold` note in
//    shared/surfaces.ts): it blooms off the sun's specular anchor in the
//    environment, which is why it is marked but not lit from within.
//  * BAKED AO. Every non-metal, non-emissive bucket is run through
//    `bakeVertexAO`. It is skipped on bronze and gold because metalness 1 zeroes
//    the diffuse term and a vertex colour cannot reach it, and on the emissive
//    bucket because darkening its albedo does nothing a glow would show.
//  * NOTHING FLOATS. Every part that sits ON another part is seated from that
//    part's own measured surface rather than from a hand-typed radius: the
//    weathering lumps and the damage spall from `shaftRadiusAt()`, the Ancient's
//    cracks from the `TORSO` table that also emits the torso itself. Where a
//    part straddles a face, the float is exactly zero by construction — the
//    slab is centred ON the face plane — not by tuning. See `structures.test.ts`.
//  * DETERMINISM. Weathering and rubble placement draw from the kit's seeded
//    `rng`, keyed on (kind, team). No `Math.random`.
//  * No per-frame allocation: everything here happens once, at init.
// ============================================================================
import * as THREE from 'three';
import { APAL } from '@rift/shared/palette.js';
import type { StructureKind, TeamId } from '@rift/shared/types.js';
import type { SurfaceId } from '@rift/shared/surfaces.js';
import type { AnimPart, BakedMesh, LatheVec, Part, Rng, UnitBuild } from '../kit.js';
import {
  bake,
  bakeVertexAO,
  box,
  cone,
  cyl,
  ico,
  lathe,
  markBloom,
  partMaterial,
  rng,
  sphere,
} from '../kit.js';
import { whiteVertexColors } from '../core.js';

// ---- team identity ----------------------------------------------------------

/** The one tint step and the one emissive key a side of the war is allowed to
 *  use. `key` is an APAL key NAME because `emissiveSurface` resolves the GLOW
 *  colour by name; `base` is the resolved hex, and it is what tints the ALBEDO.
 *  They are the same colour on purpose: a team crystal is azure-tinted AND
 *  azure-glowing, and the two channels are separate precisely so neither
 *  swamps the other (AMENDMENT_3 §A).
 *
 *  Deliberately ONE step and not the family's {base, Lit, Deep} ladder: every
 *  step used is a distinct (surface, tint, emissive) triple and therefore a
 *  draw call on every one of the map's eighteen structures. The lighter and
 *  darker reads are bought with form and with the two stone families instead.
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
 *  point a player finds a LANE tower by across the map at night, and the guard
 *  deliberately has none. */
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

/** Gap between the top of a structure's STONE and its hp bar. One number for
 *  all three kinds, applied to the MEASURED top of the baked geometry rather
 *  than to a hand-typed height, so `barH` cannot drift away from the mesh the
 *  way three different quoted tower heights did. The turning crystal and the
 *  brazier flames are allowed to cross the bar, exactly as the tower props do
 *  in the game this is benchmarked against, because a bar hoisted above every
 *  prop floats half a metre off the structure and reads as detached. */
const BAR_CLEAR = 0.38;

/** Thickness of a crack / spall slab, in metres. A scar is placed with its
 *  centre ON the host face, so exactly half of this is embedded and exactly
 *  half stands proud. */
const SCAR_T = 0.2;

/** Inradius / circumradius of a regular octagon. Every lathe here is `seg 8`,
 *  so a part seated at `circumradius * OCT_IN` is guaranteed to be inside the
 *  real surface at EVERY angle rather than only at the eight corners. */
const OCT_IN = Math.cos(Math.PI / 8);

// ---- part helpers -----------------------------------------------------------

/** Push one opaque part. Split on `tint` because `exactOptionalPropertyTypes`
 *  forbids writing an explicit `undefined` into an optional field. */
function add(parts: Part[], geo: THREE.BufferGeometry, id: SurfaceId, tint?: string): void {
  if (tint === undefined) parts.push({ geo, surface: id });
  else parts.push({ geo, surface: id, tint });
}

/** Push one GLOWING team part. This is the whole emissive path: the part
 *  declares its emissive, `bake()` buckets by (surface, tint, emissive) and
 *  builds the material through `emissiveSurface('crystal', key, BODY_GLOW,
 *  base)`, so the albedo keeps the team tint and the glow keeps the team hue.
 *  One intensity per body, so all of these land in ONE bucket. */
function addGlow(parts: Part[], geo: THREE.BufferGeometry, t: TeamTints): void {
  parts.push({
    geo,
    surface: 'crystal',
    tint: t.base,
    emissive: { colorKey: t.key, intensity: BODY_GLOW },
  });
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

/** Wrap an UNBAKED animated carve-out as a typed `AnimPart` (AMENDMENT_3 §B).
 *
 *  This geometry never passes through `bake()`, so the two things `bake()`
 *  would have done are done here:
 *   1. `whiteVertexColors(geo)` — every kit material is `vertexColors: true`
 *      and a geometry with no `color` attribute renders BLACK.
 *   2. UV scaling — none is needed. `SURFACES.crystal` has `normal: null` and
 *      `roughnessMap: false`, so the material samples no texture at all and the
 *      lathe's own normalised UVs are never read.
 *
 *  The material itself is R_UNITS' to build, from these fields, through
 *  `partMaterial(surfaceId, tint, emissive)` — the one resolver. */
function crystalAnim(geo: THREE.BufferGeometry, t: TeamTints, intensity: number): AnimPart {
  whiteVertexColors(geo);
  return {
    geo,
    surfaceId: 'crystal',
    tint: t.base,
    emissive: { colorKey: t.key, intensity },
    bloom: true,
  };
}

// ============================================================================
// TOWER + GUARD — the lane landmark and its stouter cousin
// ============================================================================
//
// Both are turned about the same axis, so every part that sits on the shaft is
// seated from `shaftRadiusAt()` rather than from a typed radius. Heights and
// footprints are in the file header; part, triangle and draw counts are above
// `buildStructure`. All of them are measured, none are asserted here twice —
// one quoted number, one place, is the point.

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

/** The shaft's CIRCUMRADIUS at height `y`, clamped to the profile's own ends.
 *  Everything that clings to the shaft — the pilaster ribs, the always-visible
 *  weathering lumps, the hidden spall scars — is seated from this rather than
 *  from a constant, which is what stops a lump from hanging in the air at the
 *  top of a taper it was placed against at the bottom. */
function shaftRadiusAt(y: number): number {
  const p = SHAFT_PROFILE;
  const first = p[0];
  const last = p[p.length - 1];
  if (first === undefined || last === undefined) return 1;
  if (y <= first.y) return first.r;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    if (a === undefined || b === undefined) break;
    if (y <= b.y) return a.r + ((b.r - a.r) * (y - a.y)) / (b.y - a.y);
  }
  return last.r;
}

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

/** Brazier bowl: a lathed hemisphere on a short stem, open to the sky. Stone,
 *  not bronze — see the bucket arithmetic in the header. */
const BRAZIER_PROFILE: readonly LatheVec[] = [
  { r: 0.16, y: 0.0 },
  { r: 0.2, y: 0.14 },
  { r: 0.46, y: 0.3 },
  { r: 0.62, y: 0.5 },
  { r: 0.66, y: 0.62 },
  { r: 0.56, y: 0.6 },
  { r: 0.4, y: 0.44 },
];

/** Guard cap drum, replacing the lane tower's open arcade. It is deliberately
 *  SHORT: the guard has to come in under the lane tower's crown, and the drum
 *  is where that height is taken out. Top face at y 8.02. */
const DRUM_PROFILE: readonly LatheVec[] = [
  { r: 1.3, y: 7.52 },
  { r: 1.3, y: 7.8 },
  { r: 1.18, y: 7.9 },
  { r: 1.18, y: 8.02 },
  { r: 0.0, y: 8.02 },
];

/** The brazier, its legs and its fire. `y` is the bowl's seat; the fire sits in
 *  the bowl and its three tongues lean outward so the flame reads as motion
 *  even in a still frame (STYLE_BIBLE §9). Bowl and legs are `monumentStone`;
 *  only the ember bed and the tongues are team crystal. */
function brazier(parts: Part[], t: TeamTints, y: number, s: number): void {
  add(parts, lathe(BRAZIER_PROFILE, 10, { sx: s, sz: s, y }), 'monumentStone');
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
      'monumentStone',
    );
  }
  // ember bed — a squashed icosphere filling the bowl mouth
  addGlow(parts, ico(0.42 * s, 1, { sy: 0.42, x: 0, y: y + 0.44 * s, z: 0 }), t);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 1.1;
    addGlow(
      parts,
      cone(0.19 * s, 0.66 * s, 6, {
        rz: -Math.cos(a) * 0.3,
        rx: Math.sin(a) * 0.3,
        x: Math.cos(a) * 0.16 * s,
        y: y + 0.76 * s,
        z: Math.sin(a) * 0.16 * s,
      }),
      t,
    );
  }
}

/** One hanging banner: a cloth panel with a stone crossbar and a torn tail,
 *  set on the face `a` radians round the shaft. Banners are the tower's only
 *  silhouette break below the cornice and the reason a tower is not a cylinder
 *  from every angle.
 *
 *  Both banners hang on the **-Z** half, at 45 deg either side of the near
 *  face, and not on opposite faces. The camera yaw in this game is FIXED
 *  (STYLE_BIBLE §5) and it looks down +Z, so a banner on the +Z half is a
 *  banner the player NEVER sees — which is exactly what the first cut of this
 *  module shipped: both banners at +Z, two of the tower's twenty-four banner
 *  triangles reaching the frame and none at all on the guard. Splaying two
 *  across the NEAR half means the whole team-coloured area always faces the
 *  camera. It is also what "banners on the windward side" means — one side. */
function banner(parts: Part[], t: TeamTints, a: number, radius: number, top: number): void {
  const bx = Math.cos(a) * radius;
  const bz = Math.sin(a) * radius;
  const face = -a + Math.PI / 2;
  add(parts, box(1.34, 0.16, 0.22, { ry: face, x: bx, y: top, z: bz }), 'monumentStone');
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
  // Pulled in against the plinth (1.92 B, not 2.05 B) and cut a size step: a
  // GUARD is 1.22 B and sits at GUARD_FLANK_DIST 7.51 from an Ancient whose own
  // spoil ring reaches past 4.4 m, so every centimetre of loose stone out here
  // is a centimetre of two builds interpenetrating. See the clearance note
  // above `buildStructure`.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + r.range(-0.25, 0.25);
    const s = r.range(0.34, 0.62);
    boulder(parts, r, s, Math.cos(a) * 1.92 * B, r.range(0.16, 0.32), Math.sin(a) * 1.92 * B);
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
  // Four pilaster ribs on the cardinal faces: they catch the raking sun and
  // give the shaft a vertical grain the octagon alone does not have. `rx`
  // leans each rib INWARD with height by exactly the shaft's own taper —
  // atan((1.34 - 0.866) / 5.3) = 0.0894 rad over the rib's 0.86..6.15 span —
  // so a rib that is embedded at its foot is still embedded at its head. A
  // plumb rib was not: the shaft loses 0.474 m of radius under it.
  const RIB_LEAN = 0.0894;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    add(
      parts,
      box(0.34 * B, 5.3, 0.3 * B, {
        rx: -RIB_LEAN,
        ry: -a + Math.PI / 2,
        x: Math.cos(a) * shaftRadiusAt(3.5) * OCT_IN * B,
        y: 3.5,
        z: Math.sin(a) * shaftRadiusAt(3.5) * OCT_IN * B,
      }),
      'monumentStone',
    );
  }
  // Two turned string courses breaking the shaft into storeys. There were two
  // bronze bands as well; they sat INSIDE the shaft and never drew a pixel, so
  // they are gone rather than moved — four rings on one shaft is a fence.
  add(parts, cyl(1.24 * B, 1.3 * B, 0.2, 8, { y: 1.78 }), 'monumentStone');
  add(parts, cyl(0.94 * B, 1.0 * B, 0.18, 8, { y: 5.22 }), 'monumentStone');

  // ---- glyph course: the night read ---------------------------------------
  // Six inset crystal channels round the shaft at eye height for the camera.
  // These are what tell a player whose tower it is from the far side of the map
  // after dark, when the banners are unlit shapes. Seated on the octagon's
  // INRADIUS at the top of their own span (y 3.875), so the channel is cut into
  // the stone over its whole length instead of lifting off it at the top.
  const glyphR = shaftRadiusAt(3.875) * OCT_IN;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    addGlow(
      parts,
      box(0.2, 1.05, 0.14, {
        ry: -a + Math.PI / 2,
        x: Math.cos(a) * glyphR * B,
        y: 3.35,
        z: Math.sin(a) * glyphR * B,
      }),
      t,
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
    // Every course here is set to bring the guard in UNDER the lane tower's
    // crown; the two heights are asserted against each other in the suite.
    add(parts, lathe(DRUM_PROFILE, 8, { sx: B, sz: B }), 'monumentStone');
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      add(
        parts,
        box(0.36 * B, 0.44, 0.28 * B, {
          ry: -a + Math.PI / 2,
          x: Math.cos(a) * 1.06 * B,
          y: 7.62,
          z: Math.sin(a) * 1.06 * B,
        }),
        'monumentStone',
      );
    }
    for (const sgn of [-1, 1] as const) {
      add(parts, box(0.44, 0.5, 0.62, { x: sgn * 0.86 * B, y: 8.12, z: 0 }), 'monumentStone');
      add(
        parts,
        cone(0.28, 0.95, 6, { rz: -sgn * 0.34, x: sgn * 1.06 * B, y: 8.62, z: 0 }),
        'monumentStone',
      );
    }
    brazier(parts, t, 8.02, 1.0);
  } else {
    // ---- lane crown: open arcade, fire burning inside it -------------------
    // Four posts at the diagonals; four lintels spanning post to post, which
    // means TANGENTIAL (`ry: -a + PI/2`) at the chord midpoint radius
    // 1.02 * cos(PI/4) = 0.7212. The first cut used `ry: -a`, which points a
    // beam RADIALLY: four beams crossing over the middle instead of a square
    // arcade, and — because the finials are seated on the lintel ends — four
    // finials hanging 0.25 m above nothing.
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
    const lintelR = 1.02 * Math.cos(Math.PI / 4);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      add(
        parts,
        box(1.62, 0.26, 0.26, {
          ry: -a + Math.PI / 2,
          x: Math.cos(a) * lintelR,
          y: 8.84,
          z: Math.sin(a) * lintelR,
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

  // ---- banners on the NEAR (-Z) side --------------------------------------
  banner(parts, t, -Math.PI * 0.25, 1.14 * B, 6.1);
  banner(parts, t, -Math.PI * 0.75, 1.14 * B, 6.1);

  // ---- weathering: always visible, never a state --------------------------
  // Chipped arrises and lichened patches any standing tower has. Kept in the
  // quarried-stone family so it costs no bucket of its own, and each lump's
  // CENTRE is placed on the shaft's octagonal inradius at its own height, so
  // whatever size and rotation the generator hands it, it always straddles the
  // face. At the old fixed 1.10 B one of the five stood 0.0110 m clear of the
  // stone; measured surface-to-surface, all five now cross it.
  for (let i = 0; i < 5; i++) {
    const a = r.next() * Math.PI * 2;
    const y = r.range(1.2, 6.0);
    const s = r.range(0.16, 0.34);
    const rad = shaftRadiusAt(y) * OCT_IN * B;
    boulder(parts, r, s, Math.cos(a) * rad, y, Math.sin(a) * rad);
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
    const y = r.range(2.0, 5.0);
    const h = r.range(1.0, 1.9);
    // Seated on the shaft face at the TOP of the scar's own span, so the whole
    // scar is cut into stone even where the shaft has narrowed above it.
    const rad = shaftRadiusAt(y + h * 0.5) * OCT_IN * B;
    add(
      dmg,
      box(0.3, h, SCAR_T, {
        rz: r.range(-0.2, 0.2),
        ry: -a + Math.PI / 2,
        x: Math.cos(a) * rad,
        y,
        z: Math.sin(a) * rad,
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
 *  primitive, so no merge is needed to hand it back as a single geometry.
 *  LANE TOWERS ONLY — the guard's beacon is its exposed fire, and giving both
 *  the same orbiting light is what made them read as the same building. */
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
// TWO SPACES, ONE TRANSFORM. Every coordinate in `ancientParts` is FIGURE
// SPACE: the figure's own frame, in which it kneels toward -Z and reaches
// toward +Z, its chest faces +Z and the approach steps are at +Z. The last
// thing `ancientParts` does is turn the whole build 180 deg about Y, which maps
//
//     figure (x, y, z)  ->  build (-x, y, -z)
//
// and that build space is world space, because `units.ts` never yaws a
// structure. The turn exists for one measured reason: the heart is an anim part
// mounted at (unit.x, animY, unit.z) — `UnitBuild` has `animY` and NO `animZ` —
// so the heart is pinned to local z = 0, and with the figure facing the camera
// its own torso stack at z -1.15..-1.68 sat between the camera and the heart
// and occluded it at every one of forty sample points. Turned, the chest, the
// breastplate, the chest veins and the approach all face the camera, the back
// and the crown face away, and the heart burns in front of the chest with the
// arms coming round it. Reported upstream as `CONTRACT_GAP: UnitBuild.animZ`.
//
// A 180 deg turn and not a Z mirror: a mirror flips triangle winding and
// normals and would need both undone, whereas a rotation is rigid. It also
// swaps the figure's left and right, which is why the kneeling leg is the
// figure's own left rather than the viewer's.
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

/** One box of the torso stack, in FIGURE SPACE. This table is the single source
 *  of truth for the torso: it emits the boxes AND it seats every crack and
 *  every spall scar. Before it existed the cracks were placed on a hand-typed
 *  ellipse of radius (1.5, 1.0) around a stack whose half-width runs 1.025 to
 *  1.375, and three of the eight always-visible ones stood 0.0238, 0.0303 and
 *  0.0610 m clear of the stone (the review counted four in the same range; on a
 *  surface-crossing test rather than a nearest-vertex one it is three). A scar
 *  seated from the table cannot: it is placed ON the face plane, so exactly
 *  `SCAR_T / 2` is embedded and every one of the eight now crosses the torso
 *  surface — maximum gap 0.0000 m. */
interface TorsoSeg {
  /** Centre, figure space. */
  readonly cy: number;
  readonly cz: number;
  /** Half extents along the box's own X / Y / Z before rotation. */
  readonly hw: number;
  readonly hh: number;
  readonly hd: number;
  /** Forward lean, about X. */
  readonly rx: number;
}

const TORSO: readonly TorsoSeg[] = [
  { cy: 4.7, cz: -1.85, hw: 1.25, hh: 0.65, hd: 0.95, rx: 0.14 }, // pelvis
  { cy: 6.0, cz: -1.68, hw: 1.025, hh: 0.85, hd: 0.8, rx: 0.16 }, // waist — the taper
  { cy: 7.6, cz: -1.42, hw: 1.2, hh: 0.9, hd: 0.85, rx: 0.17 }, // ribs
  { cy: 9.2, cz: -1.15, hw: 1.375, hh: 0.85, hd: 0.875, rx: 0.18 }, // chest — the flare
];

function torsoSeg(i: number): TorsoSeg {
  const s = TORSO[i % TORSO.length];
  if (s === undefined) throw new Error('rift structures: empty TORSO table');
  return s;
}

/** A scar lying exactly on one FLANK (±X) face of a torso segment.
 *
 *  `u` and `v` run -1..1 across the face along its own up axis and its own
 *  depth axis. `rz` then `ry: PI/2` map the slab's thin axis to exactly
 *  (1, 0, 0), so its world X extent is exactly `SCAR_T / 2` about the face
 *  plane `x = ±hw`: half in the stone, half proud, float zero. */
function flankScar(
  parts: Part[],
  s: TorsoSeg,
  sgn: -1 | 1,
  u: number,
  v: number,
  w: number,
  h: number,
  tilt: number,
  tint?: string,
): void {
  const c = Math.cos(s.rx);
  const sn = Math.sin(s.rx);
  add(
    parts,
    box(w, h, SCAR_T, {
      rz: tilt,
      ry: Math.PI / 2,
      x: sgn * s.hw,
      y: s.cy + u * s.hh * c - v * s.hd * sn,
      z: s.cz + u * s.hh * sn + v * s.hd * c,
    }),
    'cliffRock',
    tint,
  );
}

/** A scar lying exactly on the CHEST (+Z, figure space) face of a segment.
 *  `rx: s.rx` puts the slab's thin axis on the face normal (0, -sin, cos), so
 *  again exactly `SCAR_T / 2` is embedded and the float is zero. */
function chestScar(
  parts: Part[],
  s: TorsoSeg,
  u: number,
  v: number,
  w: number,
  h: number,
  tint?: string,
): void {
  const c = Math.cos(s.rx);
  const sn = Math.sin(s.rx);
  add(
    parts,
    box(w, h, SCAR_T, {
      rx: s.rx,
      x: u * s.hw,
      y: s.cy - s.hd * sn + v * s.hh * c,
      z: s.cz + s.hd * c + v * s.hh * sn,
    }),
    'cliffRock',
    tint,
  );
}

/** One team standard flanking the approach: stone post, stone crossbar, cloth
 *  panel, torn tail. These replace the pair that used to hang off the back of
 *  the pauldrons at figure-space z -2.1 — which, once the figure was turned to
 *  face the camera, is the +Z face the player never sees. Same four-part cost,
 *  same cloth bucket, and now in frame, low, beside the steps a player walks
 *  up. */
function standard(parts: Part[], t: TeamTints, x: number, z: number, base: number): void {
  add(parts, cyl(0.13, 0.16, 3.6, 6, { x, y: base + 1.8, z }), 'monumentStone');
  add(parts, box(1.16, 0.14, 0.18, { x, y: base + 3.5, z }), 'monumentStone');
  add(parts, box(0.98, 1.7, 0.07, { x, y: base + 2.6, z }), 'cloth', t.base);
  add(parts, box(0.66, 0.5, 0.07, { rx: 0.14, x, y: base + 1.6, z }), 'cloth', t.base);
}

function ancientParts(t: TeamTints, seed: string): { body: Part[]; dmg: Part[] } {
  const parts: Part[] = [];
  const dmg: Part[] = [];
  const r = rng(seed);

  // ---- dais ---------------------------------------------------------------
  add(parts, lathe(DAIS_T1, 8), 'cliffRock');
  add(parts, lathe(DAIS_T2, 8), 'cliffRock');
  add(parts, lathe(DAIS_T3, 8), 'monumentStone');
  // approach steps, figure-space +Z — the NEAR face once the build is turned
  for (let i = 0; i < 3; i++) {
    add(
      parts,
      box(3.4 - i * 0.5, 0.32, 0.7, { x: 0, y: 0.16 + i * 0.44, z: 4.5 - i * 0.66 }),
      'cliffRock',
    );
  }
  // Spoil ring: unsquared blocks never cleared from the foot of the dais. Tight
  // against the first tier (4.46, not 4.62) and a size step smaller, because
  // this ring IS the Ancient's measured half-width and it is what a guard tower
  // 7.51 m away collides with.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + r.range(-0.18, 0.18);
    const s = r.range(0.38, 0.68);
    boulder(parts, r, s, Math.cos(a) * 4.46, r.range(0.18, 0.36), Math.sin(a) * 4.46);
  }
  // glyph ring set into the second tier's rim
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    addGlow(
      parts,
      box(0.46, 0.2, 0.14, {
        ry: -a + Math.PI / 2,
        x: Math.cos(a) * 3.5,
        y: 0.84,
        z: Math.sin(a) * 3.5,
      }),
      t,
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

  // pelvis + torso, leaning forward over the heart, straight off the TORSO
  // table. The torso TAPERS at the waist and flares at the chest: a
  // constant-width stack reads as a wall from the 55 deg camera, and a wall is
  // the one thing a figure must not be.
  for (const s of TORSO) {
    add(
      parts,
      box(s.hw * 2, s.hh * 2, s.hd * 2, { rx: s.rx, x: 0, y: s.cy, z: s.cz }),
      'monumentStone',
    );
  }
  // breastplate slab, proud of the chest so it casts its own shadow line. It
  // faces the camera once the build is turned, which is why the value break
  // that used to be a `monumentLit` tint is now carried by the gold faceplate
  // instead — same read, one bucket fewer (AMENDMENT_3 §D.4).
  add(parts, box(2.0, 1.5, 0.4, { rx: 0.18, x: 0, y: 8.85, z: -0.35 }), 'monumentStone');
  // crystal veins running up the chest, under the plate's edge
  for (const sgn of [-1, 1] as const) {
    addGlow(
      parts,
      box(0.16, 2.4, 0.14, { rx: 0.18, rz: sgn * 0.1, x: sgn * 0.66, y: 7.4, z: -0.66 }),
      t,
    );
  }
  // gorget: the neck break that lets the head read as a HEAD and not as the
  // next box up the stack
  add(parts, cyl(0.62, 0.82, 0.72, 8, { rx: 0.3, y: 10.5, z: -0.85 }), 'monumentStone');
  add(parts, box(0.9, 0.3, 0.2, { rx: 0.18, x: 0, y: 9.62, z: -0.42 }), 'gold');

  // Pauldrons: the widest thing in the game and the whole silhouette from
  // above. They slope steeply DOWN and OUT (rz -sgn*0.5), so the camera sees a
  // raking plane and a shadow, not a tabletop — the flat-topped version read as
  // a roof and buried the head under it.
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
  // The faceplate is GOLD: it is the one highlight the figure needs, it is a
  // bucket the Ancient already pays for, and it puts the brightest non-emissive
  // value in the game directly above the heart.
  add(parts, box(1.6, 1.75, 1.7, { rx: 0.36, x: 0, y: 11.6, z: -0.62 }), 'monumentStone');
  add(parts, box(1.25, 1.35, 0.32, { rx: 0.36, x: 0, y: 11.38, z: 0.22 }), 'gold');
  add(parts, box(1.3, 0.45, 1.3, { rx: 0.36, x: 0, y: 10.72, z: -0.35 }), 'monumentStone');
  add(parts, cyl(1.0, 0.84, 0.34, 8, { rx: 0.3, y: 12.45, z: -0.86 }), 'monumentStone');
  add(parts, cyl(0.88, 0.88, 0.15, 8, { rx: 0.3, y: 12.66, z: -0.92 }), 'gold');
  // six-point crown: the last 1.4 m of the Ancient's height, alternating tall
  // and short so it reads as a crown rather than a chimney from directly above.
  // The tallest spike tip IS the measured top.
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
    );
  }

  // Arms: shoulder (high, inside) → elbow (low, OUTSIDE and forward) → wrist
  // (low, inside), which from the fixed camera is a wide V closing on the
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

  // team standards flanking the approach, standing on the first dais tier
  for (const sgn of [-1, 1] as const) {
    standard(parts, t, sgn * 3.9, 1.2, 0.6);
  }

  // dais braziers, flanking the approach. Bronze here and NOT on the towers:
  // the Ancient is the only place metal ornament appears, which is what makes
  // its gold read as treasure when a player finally reaches it.
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
    addGlow(parts, ico(0.56, 1, { sy: 0.42, x: bx, y: 1.76, z: bz }), t);
    for (let i = 0; i < 2; i++) {
      const a = i === 0 ? 0.7 : 3.6;
      addGlow(
        parts,
        cone(0.24, 0.86, 6, {
          rz: -Math.cos(a) * 0.28,
          rx: Math.sin(a) * 0.28,
          x: bx + Math.cos(a) * 0.2,
          y: 2.2,
          z: bz + Math.sin(a) * 0.2,
        }),
        t,
      );
    }
  }

  // ---- cracks: always visible. It is CRACKED monument stone (§7), so the
  // fissures are part of the healthy read, not the damage state. Six on the
  // flanks, two on the chest — the chest ones face the camera after the turn,
  // and both placers seat the slab ON the host face, so the float is zero. ---
  for (let i = 0; i < 6; i++) {
    const s = torsoSeg(i);
    const sgn: -1 | 1 = i % 2 === 0 ? -1 : 1;
    flankScar(
      parts,
      s,
      sgn,
      r.range(-0.45, 0.45),
      r.range(-0.45, 0.45),
      r.range(0.14, 0.26),
      Math.min(r.range(0.9, 2.2), s.hh * 1.6),
      r.range(-0.35, 0.35),
    );
  }
  for (let i = 0; i < 2; i++) {
    const s = torsoSeg(i + 1); // waist and ribs: clear of the breastplate slab
    chestScar(
      parts,
      s,
      r.range(-0.5, 0.5),
      r.range(-0.5, 0.2),
      r.range(0.14, 0.26),
      Math.min(r.range(0.9, 1.8), s.hh * 1.4),
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
    // 4.5..5.5 and not 4.7..6.4: a revealed damage layer must not reach further
    // out than the healthy silhouette does, or a wounded Ancient starts
    // interpenetrating the guard towers that a healthy one clears.
    const d = r.range(4.5, 5.5);
    const s = r.range(0.42, 0.9);
    boulder(dmg, r, s, Math.cos(a) * d, s * 0.3, Math.sin(a) * d, APAL.cliffDeep);
  }
  for (let i = 0; i < 4; i++) {
    const s = torsoSeg(i);
    const sgn: -1 | 1 = i % 2 === 0 ? 1 : -1;
    flankScar(
      dmg,
      s,
      sgn,
      r.range(-0.4, 0.4),
      r.range(-0.4, 0.4),
      r.range(0.3, 0.42),
      Math.min(r.range(1.6, 2.8), s.hh * 1.7),
      r.range(-0.3, 0.3),
      APAL.cliffDeep,
    );
  }

  // ---- the one transform: turn the figure to face the camera --------------
  // See the block comment above. Everything up to here is FIGURE SPACE.
  for (const p of parts) p.geo.rotateY(Math.PI);
  for (const p of dmg) p.geo.rotateY(Math.PI);

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

/** What `finish()` hands back: the baked body, and the measured top of its
 *  VISIBLE geometry, which is where the hp bar is hung from. */
interface Finished {
  readonly mesh: BakedMesh;
  readonly top: number;
}

/**
 * Bake a build and apply, in ONE pass over the meshes that actually render,
 * the four things every structure needs and none of them may skip: selective
 * bloom, the shadow-caster opt-outs, baked AO where a vertex colour can reach,
 * and the hidden damage layer. Shared by all three kinds precisely so none of
 * them can be quietly finished differently from the others.
 *
 * `BakedMesh.parts` is returned EXACTLY as `bake()` built it. Nothing is
 * re-pointed and nothing is rebuilt: a glowing part declares `Part.emissive`
 * and arrives already carrying `emissiveSurface(id, key, intensity, tint)`.
 * The policy sets below are keyed by material identity, and every material in
 * them is resolved through `partMaterial()` from the very same
 * (surface, tint, emissive) triple `bake()` used — so they are cache hits on
 * instances that already exist, never new materials.
 *
 * It is a hard error for a bucket to have no mesh, or for the damage layer to
 * share a bucket with visible geometry: the first would mean a part silently
 * never rendered, the second would hide something that must always be seen.
 */
function finish(body: readonly Part[], dmg: readonly Part[]): Finished {
  const all: Part[] = body.slice();
  for (const p of dmg) all.push(p);
  const baked = bake(all);

  const bloom = new Set<THREE.Material>();
  const noCast = new Set<THREE.Material>();
  const visible = new Set<THREE.Material>();
  for (const p of body) {
    const m = partMaterial(p.surface, p.tint, p.emissive);
    visible.add(m);
    // Gold blooms off the environment's specular anchor with no emissive of its
    // own (STYLE_BIBLE §6); an emissive part blooms because that is what an
    // emissive is for. Everything else stays out of the pass.
    if (p.emissive !== undefined || p.surface === 'gold') bloom.add(m);
    // AMENDMENT_3 §D.2 shadow-caster whitelist — see the header.
    if (p.emissive !== undefined || p.surface === 'cloth' || p.surface === 'fern') noCast.add(m);
  }
  const damaged = new Set<THREE.Material>();
  for (const p of dmg) {
    const m = partMaterial(p.surface, p.tint, p.emissive);
    if (visible.has(m)) {
      throw new Error(
        'rift structures: the damage layer shares a bucket with visible geometry — ' +
          'hiding it would hide part of the healthy read',
      );
    }
    damaged.add(m);
  }

  let seen = 0;
  let top = Number.NEGATIVE_INFINITY;
  for (const child of baked.group.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    seen++;
    const m = child.material;
    if (Array.isArray(m)) throw new Error('rift structures: bake() emitted a multi-material mesh');
    if (damaged.has(m)) {
      child.name = 'rift:structDamage';
      child.userData['riftDamage'] = true;
      child.visible = false;
    } else {
      child.geometry.computeBoundingBox();
      const bb = child.geometry.boundingBox;
      if (bb !== null) top = Math.max(top, bb.max.y);
    }
    if (bloom.has(m)) markBloom(child);
    if (noCast.has(m)) child.castShadow = false;
    // Metal buckets are skipped: metalness 1 zeroes the diffuse term and a
    // vertex colour cannot reach it. The glow bucket is skipped: darkening the
    // albedo under an emissive that strong changes nothing on screen.
    if (!bloom.has(m) && m instanceof THREE.MeshStandardMaterial && m.metalness === 0) {
      bakeVertexAO(child.geometry, AO_STRENGTH);
    }
  }
  if (seen !== baked.parts.length) {
    throw new Error(
      `rift structures: ${baked.parts.length} baked buckets but ${seen} meshes — a bucket ` +
        'would never have rendered',
    );
  }
  if (top === Number.NEGATIVE_INFINITY) {
    throw new Error('rift structures: no visible geometry in the bake');
  }
  // Diagnostics, not an interface: the §7 part budget stamped on the artifact
  // so the suite can check it against the SHIPPED geometry instead of against a
  // comment that can drift. `camps.ts` stamps `riftPartCount` the same way.
  // Nothing downstream is required to read either; the one `userData` key
  // R_UNITS does read is `riftDamage`, on the hidden bucket.
  baked.group.userData['riftBodyParts'] = body.length;
  baked.group.userData['riftDamageParts'] = dmg.length;
  return { mesh: baked, top };
}

/**
 * The map's landmarks. Pure: same arguments produce the same geometry, all
 * variation drawn from the kit's seeded `rng`, so a caller may cache per key —
 * but a cached `BakedMesh` cannot be added to the scene twice, since its
 * `group` has one parent. R_UNITS calls this once per archetype and pools.
 *
 * ---- WHAT IS ACTUALLY DRAWN ------------------------------------------------
 * The hidden damage layer is NEVER drawn on a healthy structure, so it is
 * quoted apart from the body rather than folded into one number the way the
 * first cut of this module folded it:
 *
 *   | archetype | body parts | body tris | + damage parts | + damage tris |
 *   | tower     |         64 |      1316 |             10 |           168 |
 *   | guard     |         61 |      1340 |             10 |           168 |
 *   | ancient   |        113 |      2832 |             12 |           208 |
 *
 * Body parts are inside STYLE_BIBLE §7's 55–80 (towers) and 110–160 (ancients),
 * and `finish()` stamps both counts on `group.userData` so the suite checks
 * them against the shipped geometry rather than against this comment. Eighteen
 * structures on a 3-lane map (12 lane towers, 4 guards, 2 Ancients) draw 27 552
 * triangles of the 1.2 M budget — 26 816 of body plus 736 of anim — with every
 * damage layer hidden.
 *
 * ---- DRAW CALLS, MEASURED THROUGH renderer.info ----------------------------
 * A real WebGL2 context in headless Chrome, `shadowMap.enabled`, one
 * directional light casting, `info.autoReset = false` and one `reset()` per
 * frame — so these INCLUDE the shadow pass, which is the correction
 * AMENDMENT_3 §D makes and the reason the first cut's "114" was the object
 * count and less than half the truth. Same harness, same scene, both columns:
 *
 *              pass                              at HEAD   now
 *              colour ..........................    114     92
 *              + shadow ........................    210    132   (shadow 96 -> 40)
 *              selective-bloom pre-pass alone ..     38     34
 *              ACCUMULATED over one frame ......    248    166
 *
 * 166 of the 700 gate, down from 248: 24% of the budget instead of 35%. The
 * shadow half falls hardest because the caster count per tower goes 5 -> 2.
 * One lever is deliberately left unpulled and belongs to whoever integrates:
 * merging `cliffRock` into `monumentStone` on the towers would take another 32
 * draws (16 colour, 16 shadow) at the cost of the quarried-foot / dressed-shaft
 * read on the map's most repeated landmark.
 *
 * ---- COLD LOAD, MEASURED IN A FRESH PAGE (AMENDMENT_3 §E) ------------------
 * Same headless Chrome, fresh process, empty `matCache`, and a REAL canvas — in
 * node the kit's texture generators take their no-canvas branch and the cost
 * simply does not occur, so a node number here would be a fiction.
 *
 *   first `partMaterial()` on the 7 families used ... 67.0 / 66.5 ms  (R_SCENE's, §E.3)
 *   all three archetypes built, after that .......... 22.2 / 26.2 ms  (this module's)
 *   all three rebuilt for the other team ............ 10.9 / 13.1 ms  (warm)
 *   all three built with NOBODY pre-warming ......... 82.2 ms
 *
 * Two fresh-page runs each, quoted as measured rather than as a best-of; the
 * spread is software rasterisation. 22–27 ms against the 80 ms §E.4 gives the
 * four mesh builders between them, and the 67 ms of texture generation in front
 * of it is the shared cost §E.3 hoists to R_SCENE — it is paid once for the
 * whole render layer by whoever builds first, and this module is only ever the
 * one that happens to be first.
 *
 * ---- CLEARANCE, FOR R_MAPMESH ----------------------------------------------
 * `GUARD_FLANK_DIST` is 7.51 m and is derived from HITBOX radii (ancient 2.3 +
 * guard 1.2 + STRUCTURE_MARGIN 4). The VISUAL half-widths do not fit inside it:
 *
 *   ancient 5.07 + guard 2.94 = 8.01 m needed against 7.51 m available
 *                             = 0.50 m of interpenetration, both ways loose
 *                               ground rubble (the Ancient's spoil ring against
 *                               the guard's kerb ring), no solid mass involved.
 *
 * That is down from 1.21 m — both rings were pulled in and cut a size step, and
 * the Ancient's damage ring came from 4.7–6.4 m to 4.5–5.5 m so a wounded
 * Ancient does not reach further than a healthy one. The last 0.50 m cannot be
 * closed from inside this file: DAIS_T1 alone is 4.40 m and any spoil at its
 * foot puts the Ancient past 4.7, while the guard's own plinth is 2.38 m at
 * B 1.22. Closing it needs either `GUARD_FLANK_DIST` (frozen, `config.ts`) or a
 * smaller dais, and neither is R_MESH_STRUCT's to change. Reported upstream.
 * An earlier revision of this comment claimed "~1.3 m of clearance"; the sign
 * was wrong and the number was never measured.
 *
 * `barH` is MEASURED off the baked geometry (`Finished.top + BAR_CLEAR`), not
 * typed, so it cannot drift from the mesh. `barW` is an art choice and tracks
 * the footprint difference between the two towers.
 *
 * Structures are never neutral, which is why this takes `TeamId`, not `EntTeam`.
 */
export function buildStructure(kind: StructureKind, team: TeamId): UnitBuild {
  const t = tintsOf(team);

  if (kind === 'ancient') {
    const built = ancientParts(t, `rift:ancient:${team}`);
    const done = finish(built.body, built.dmg);
    return {
      body: done.mesh,
      anim: crystalAnim(heartGeo(), t, HEART_GLOW),
      animKind: 'bob',
      // the heart hangs in the ring the arms and the bowed helm close around,
      // directly over the gold pool that reflects it
      animY: 6.55,
      barH: done.top + BAR_CLEAR,
      barW: 3.4,
    };
  }

  const guard = kind === 'guard';
  const built = towerParts(t, guard, `rift:${kind}:${team}`);
  const done = finish(built.body, built.dmg);
  if (guard) {
    // No orbiting crystal. The guard's beacon is the fire sitting between its
    // horns, and an identical light turning over both towers at 10.1 m and
    // 10.2 m was the single strongest reason the two read as the same building.
    return {
      body: done.mesh,
      anim: null,
      animKind: null,
      animY: 0,
      barH: done.top + BAR_CLEAR,
      barW: 2.6,
    };
  }
  return {
    body: done.mesh,
    anim: crystalAnim(towerCrystalGeo(), t, TOWER_CRYSTAL_GLOW),
    animKind: 'orbit',
    animY: 10.2,
    barH: done.top + BAR_CLEAR,
    barW: 2.4,
  };
}
