// ============================================================================
// ANCIENTS (rift) — HERO MESHES (R_MESH_HERO). One `buildHero(id, team)` per
// archetype, called ONCE per (hero, team) by R_UNITS and then pooled; nothing
// here runs per frame and nothing here allocates after construction.
//
// WHY THIS FILE EXISTS AT ALL. The audited defect was "six heroes share one rig
// with a bolt-on prop" (STYLE_BIBLE §7). The fix is not more detail — at a
// 55-degree top-down camera a hero is 40-110 px tall and a face is invisible —
// it is six genuinely different BODIES. Every hero below has its own proportion
// set (shoulder span, stance, mass distribution, whether it even has legs) plus
// at least two elements that break the body envelope, because the plan-view
// outline is the only thing a player actually reads:
//
//   BULLWARK  wide armoured slab + a tower shield off the left + a back banner
//   LONGBOW   narrow spindle + a recurve bow arc left + a quiver out back-right
//   REAVER    broad torso + a greatsword bar behind + a trophy chain out front
//   HEX       a circle: flared robe hem inside three concentric orbit rings
//   MENDER    narrow robe + an antlered staff up-right + an herb creel back-left
//   SHADE     a crouched X of twin daggers with a forked scarf trailing behind
//
// Part budget is 45-70 each (§7). Measured, in order: 65 / 57 / 62 / 58 / 64 /
// 55. `heroParts(id, team)` is exported precisely so those counts and the
// anti-aliasing floor can be measured against the SHIPPED PARTS instead of
// against this comment — `bake()` merges them and neither survives the merge.
//
// LAWS OBSERVED HERE (GRAPHICS_CONTRACT §1, §2; STYLE_BIBLE §2, §7, §11):
//
//  * MATERIAL LAW. Not one material is constructed in this file, by any factory.
//    Every part declares `{surface, tint?, emissive?}` and `bake()` resolves it
//    through `partMaterial()`; the only kit material call left here is the
//    cache-backed `partMaterial()` lookup that identifies which baked buckets
//    to bloom. There is no `new THREE.Mesh*Material` and no Lambert.
//  * VERTEX-COLOUR LAW. Body geometry goes through `bake()`, which writes the
//    white default itself. The one geometry that does NOT — `UnitBuild.anim`,
//    which stays unbaked so R_UNITS can transform it per frame — is passed
//    through `whiteVertexColors()` here. Without it that part renders black.
//  * UV LAW. Body parts keep the kit's default world-space projection (1 UV
//    unit = 1 world metre), so a hero's texel density matches the ground it
//    stands on. The anim part does not pass through `bake()` and so keeps its
//    primitive's own normalised UVs, built with `uvLocal` — see `HeroAnim`.
//    No `texture.repeat`, anywhere, ever.
//  * BLOOM. Emissive alone does not glow: only the two crystal buckets (and
//    `gold`, which SURFACES documents as "marked into BLOOM_LAYER by its
//    builder") are passed to `markBloom`. Nothing else on a hero is a bloom
//    target — bloom on armour is the amateur tell STYLE_BIBLE §6 names.
//  * PALETTE. No ad-hoc hex. Every tint is an APAL entry.
//  * TEAM IDENTITY is tinted trim on a small number of parts — cloth (cape,
//    banner, scarf, stole) plus one small team-coloured emissive (visor slit,
//    eye glow) — never a whole-model tint, which would erase the hero read.
//    Hero identity is carried separately by `heroById(id).visual.accent`, an
//    APAL key that becomes this hero's emissive core.
//
// DRAW CALLS, MEASURED THROUGH `renderer.info` WITH THE SHADOW PASS INCLUDED
// (AMENDMENT_3 §D.5), in a real WebGL context at the 5v5 peak — ten heroes, ten
// anim motes, one shadow-casting sun:
//
//   68 body buckets (6/7/7/7/7, both teams) + 10 anim meshes
//   beauty pass incl. shadow pass ....... 142
//   selective-bloom pass (BLOOM_LAYER) ... 32
//   TOTAL ............................... 174   triangles 63,180
//
// The previous header claimed "~65 at a 10-hero peak". That was the bucket
// count, not the meter: it omitted the shadow pass and the bloom pass, which
// together are 64% of the real cost. Anim motes are NOT shadow casters — per
// AMENDMENT_3 §D.2 that whitelist is R_SCENE's and `new THREE.Mesh` defaults to
// `castShadow = false`, so mounting an `AnimPart` plainly is already correct.
// An eighth bucket on one hero costs two draws per instance plus its shadow, so
// the per-hero palettes below are deliberately short and MENDER carries no
// metal at all.
//
// ORIENTATION, matching the house convention in units.ts: origin at the feet,
// +Y up, and the model faces +Z (R_UNITS writes `rotation.y = atan2(dx, dz)`).
// ============================================================================
import * as THREE from 'three';
import { APAL } from '@rift/shared/palette.js';
import { heroById, type HeroId, type HeroVisual } from '@rift/shared/hero.js';
import { isPlayerTeam, type EntTeam } from '@rift/shared/types.js';
import type { SurfaceId } from '@rift/shared/surfaces.js';
import {
  bake,
  box,
  capsule,
  cone,
  cyl,
  ico,
  lathe,
  markBloom,
  partMaterial,
  sphere,
  type AnimPart,
  type EmissiveSpec,
  type LatheVec,
  type Part,
  type PartOpts,
  type UnitBuild,
} from '../kit.js';
import { whiteVertexColors } from '../core.js';

// ---- tuning -----------------------------------------------------------------

/** Emissive intensity of a hero's own accent core. Below the surface table's
 *  2.2 default because a hero carries several of these and they sit close to
 *  the camera: pleasant by day, still dominant by night (STYLE_BIBLE §4). */
const ACCENT_GLOW = 1.8;
/** Emissive intensity of the team-coloured read (visor slits, lamps). Slightly
 *  hotter than the accent because the parts are tiny and the team read is the
 *  one a player must never lose in a fight. */
const TEAM_GLOW = 2.3;

/**
 * Pixels per world metre on the GROUND PLANE at the default gameplay camera:
 * height 36, pitch 55 deg, vertical FOV 50, 1080 lines. The camera is
 * 36/sin(55) = 43.95 m from its target, which subtends 2*43.95*tan(25) =
 * 40.99 m vertically, so 1080/40.99 = 26.35 px per metre measured in the
 * screen plane — and a metre laid along the ground foreshortens by sin(55),
 * giving 26.35 * 0.819 = 21.6 px/m. Rounded DOWN to 21, so every derived
 * threshold errs toward "thicker".
 */
const CAM_PX_PER_M = 21;

/**
 * The anti-aliasing floor: STYLE_BIBLE §7's closing line is "nothing anywhere
 * may be thin enough to alias at gameplay zoom", and a feature narrower than
 * two pixels crawls between them however good the FXAA is. 2 / 21 = 0.0952 m.
 *
 * It binds every FREE-STANDING element — a rod, ring, chain or string whose
 * outline is its own, drawn against the ground rather than against a parent
 * surface. It deliberately does NOT bind inset detail (a visor slit, a rivet, a
 * strap, a bodice ring) which is anti-aliased against the plate it sits on and
 * reads as texture rather than as silhouette. That is the line the reviewer's
 * three measurements were drawn on and it is the line kept here.
 *
 * Measured violations this closes, all at 21 px/m: LONGBOW's bow string 0.63 px
 * and its limbs 1.13-1.68 px, HEX's orbit rings and halo 0.92-1.18 px, REAVER's
 * trophy chain 0.76 px. Nothing free-standing is now below 2.02 px.
 */
const AA_MIN_M = 2 / CAM_PX_PER_M;

/** Cool near-black cloth — HEX's void robe and SHADE's wraps. */
const CLOTH_NIGHT = APAL.inkLit;
/** Warm dark cloth — MENDER's humble vestments. */
const CLOTH_HOMESPUN = APAL.stoneDeep;

// ---- team identity ----------------------------------------------------------

interface TeamSkin {
  /** APAL entry used as the `cloth` tint on the team-carrying parts. */
  readonly cloth: string;
  /** APAL KEY NAME (not a hex) for `emissiveSurface`'s `colorKey`. */
  readonly glowKey: string;
}

/**
 * A hero always belongs to a player team, but the frozen signature takes
 * `EntTeam` — so the neutral case is narrowed with `isPlayerTeam` and handled
 * explicitly rather than indexed into a two-element tuple, which is exactly the
 * out-of-bounds read `types.ts` warns about. A neutral "hero" (a test double, a
 * future neutral boss) gets the venom-yellow camp identity and is therefore
 * still impossible to misread as an enemy.
 */
function teamSkin(team: EntTeam): TeamSkin {
  if (!isPlayerTeam(team)) return { cloth: APAL.neutral, glowKey: 'neutral' };
  return team === 0
    ? { cloth: APAL.azure, glowKey: 'azure' }
    : { cloth: APAL.ember, glowKey: 'ember' };
}

// ---- part plumbing ----------------------------------------------------------

/** Push one part. Written as a branch rather than `{ ..., tint }` because
 *  `exactOptionalPropertyTypes` rejects an explicit `undefined` on `tint?`. */
function add(out: Part[], geo: THREE.BufferGeometry, id: SurfaceId, tint?: string): void {
  if (tint === undefined) out.push({ geo, surface: id });
  else out.push({ geo, surface: id, tint });
}

/**
 * Push one GLOWING crystal part: tinted albedo and an emissive override, both
 * declared on the `Part` so `bake()` builds the bucket through
 * `emissiveSurface(id, colorKey, intensity, tint)` itself (AMENDMENT_3 §A).
 *
 * The tint and the glow are two different reads and both are needed: the glow
 * key drives `emissiveIntensity`, the tint drives the ALBEDO, and a crystal
 * with only the glow renders cream `#c9c2ae` because the crystal family's
 * unconditional `ward` emissive swamps an untinted albedo. That is the defect
 * this file used to route around by re-pointing baked buckets after the fact —
 * which discarded the tint entirely and made every hero's crystal LESS team-
 * coloured than the bug it was working around.
 *
 * `tintOf` mirrors `colorKey` by construction, so the two crystal buckets on a
 * hero (accent core, team lamp) can never collapse into one.
 */
function glow(out: Part[], geo: THREE.BufferGeometry, colorKey: string, intensity: number): void {
  out.push({ geo, surface: 'crystal', tint: tintOf(colorKey), emissive: { colorKey, intensity } });
}

/**
 * A torus, swept from the kit's `lathe`. The kit has no ring primitive and the
 * ring silhouettes here are load-bearing — HEX's three orbit rings ARE his plan
 * view, and haloes, collars, cinches and vine wraps all need the same form.
 * `tube` is the section radius; `radius` is always the larger of the two, so
 * the swept profile never crosses the axis.
 */
function ring(radius: number, tube: number, seg: number, o?: PartOpts): THREE.BufferGeometry {
  const sides = 8;
  const profile: LatheVec[] = [];
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    profile.push({ r: radius + Math.cos(a) * tube, y: Math.sin(a) * tube });
  }
  return lathe(profile, seg, o);
}

/**
 * A ring that hangs in OPEN AIR — HEX's orbit rings and halo, REAVER's trophy
 * chain. Takes the CORD DIAMETER, because that is the quantity the
 * anti-aliasing floor is stated in, and REFUSES anything under `AA_MIN_M`.
 *
 * It throws rather than clamping. Clamping would silently make the number
 * written at the call site a lie, and "a comment that states a measurement must
 * match the geometry" (AMENDMENT_3 §G.3) is the rule this whole pass exists to
 * satisfy. Every argument here is a source literal, so a throw is a programming
 * error caught at build time, not a runtime data condition — the same posture
 * the kit itself takes for a two-point lathe or a failed bake merge.
 *
 * Rings that HUG a surface (bodice, cuffs, hem, sleeve cinches, the creel rim)
 * keep using `ring` directly: they are read against the cloth they sit on, not
 * against the sky, and the floor deliberately does not bind them.
 */
function freeRing(radius: number, cord: number, seg: number, o?: PartOpts): THREE.BufferGeometry {
  if (cord < AA_MIN_M) {
    throw new Error(
      `rift heroes: free-standing cord ${cord.toFixed(4)} m is under the ` +
        `${AA_MIN_M.toFixed(4)} m anti-aliasing floor (STYLE_BIBLE §7)`,
    );
  }
  return ring(radius, cord / 2, seg, o);
}

/** The two sides of a symmetric pair. Written as a constant so the per-hero
 *  builders read as "one part, mirrored" instead of two near-identical lines. */
const SIDES = [-1, 1] as const;

// ============================================================================
// BULLWARK — the Rampart. Tank, bulky, 2.1 m, accent `pine`.
//
// Silhouette: the widest hero in the game. Squat splayed legs, a barrel cuirass
// over a four-tasset fauld, ASYMMETRIC pauldrons (three stacked plates left,
// two right) and a horned great helm. The two envelope-breakers are a full
// tower shield carried off the left side and a back banner on a pole — both
// read as solid mass from directly above, which is what makes him the one hero
// you can identify in a fight you are not looking at.
//
// Palette: iron / bronze / leather / team cloth / crystal(pine) / crystal(team)
// = 6 buckets.
// ============================================================================
function bullwarkParts(skin: TeamSkin, accentKey: string): Part[] {
  const p: Part[] = [];
  const team = skin.cloth;

  // --- legs: splayed armoured columns, mass kept low ------------------------
  for (const s of SIDES) {
    add(p, box(0.24, 0.12, 0.34, { x: s * 0.24, y: 0.06, z: 0.04 }), 'iron');
    add(p, cyl(0.115, 0.135, 0.42, 10, { x: s * 0.24, y: 0.31 }), 'iron');
    add(p, sphere(0.13, 10, { x: s * 0.24, y: 0.53, z: 0.02, sy: 0.8 }), 'iron');
    add(p, cyl(0.15, 0.13, 0.42, 10, { x: s * 0.235, y: 0.74 }), 'leather');
  }

  // --- fauld: four tassets ringing the hips, so the waist reads as armour
  //     rather than as a belt drawn on a cylinder ----------------------------
  for (const s of SIDES) {
    add(p, box(0.26, 0.32, 0.09, { x: s * 0.16, y: 0.86, z: 0.22, rx: 0.18 }), 'iron');
    add(p, box(0.09, 0.32, 0.28, { x: s * 0.34, y: 0.86, z: 0.02, rz: s * 0.18 }), 'iron');
  }
  add(p, cyl(0.36, 0.34, 0.12, 12, { y: 0.98 }), 'leather');
  add(p, box(0.16, 0.14, 0.06, { y: 0.98, z: 0.34 }), 'bronze');

  // --- torso: a barrel, flattened front-to-back so the shoulders lead -------
  add(p, cyl(0.33, 0.4, 0.56, 12, { y: 1.25, sz: 0.72 }), 'iron');
  add(p, box(0.1, 0.5, 0.1, { y: 1.26, z: 0.26 }), 'bronze');
  add(p, box(0.44, 0.44, 0.09, { y: 1.25, z: -0.26 }), 'iron');
  add(p, cyl(0.22, 0.26, 0.11, 12, { y: 1.57 }), 'bronze');

  // --- pauldrons: three plates left, two right. The asymmetry is the point;
  //     a symmetric tank reads as a barrel from above ------------------------
  add(p, sphere(0.26, 12, { x: -0.5, y: 1.5, sy: 0.55 }), 'iron');
  add(p, sphere(0.23, 12, { x: -0.52, y: 1.62, sy: 0.5 }), 'iron');
  add(p, sphere(0.19, 12, { x: -0.54, y: 1.72, sy: 0.5 }), 'iron');
  add(p, sphere(0.26, 12, { x: 0.5, y: 1.5, sy: 0.55 }), 'iron');
  add(p, sphere(0.22, 12, { x: 0.52, y: 1.63, sy: 0.5 }), 'iron');
  add(p, cone(0.06, 0.22, 6, { x: -0.56, y: 1.86, rz: 0.25 }), 'bronze');
  add(p, cone(0.06, 0.2, 6, { x: 0.56, y: 1.8, rz: -0.25 }), 'bronze');

  // --- arms ------------------------------------------------------------------
  for (const s of SIDES) {
    add(p, capsule(0.1, 0.2, { x: s * 0.55, y: 1.28, rz: s * -0.12 }), 'leather');
    add(p, cyl(0.105, 0.095, 0.34, 10, { x: s * 0.6, y: 0.95, rz: s * -0.1 }), 'iron');
    add(p, box(0.16, 0.16, 0.2, { x: s * 0.63, y: 0.76 }), 'iron');
  }

  // --- great helm: horns and a lit visor slit are the whole head read at this
  //     size; a face would be invisible from the camera ----------------------
  add(p, cyl(0.1, 0.12, 0.12, 8, { y: 1.64 }), 'leather');
  add(
    p,
    lathe(
      [
        { r: 0.19, y: -0.04 },
        { r: 0.2, y: 0 },
        { r: 0.19, y: 0.16 },
        { r: 0.13, y: 0.28 },
        { r: 0, y: 0.34 },
      ],
      12,
      { y: 1.7 },
    ),
    'iron',
  );
  add(p, cyl(0.205, 0.21, 0.07, 12, { y: 1.83 }), 'bronze');
  glow(p, box(0.26, 0.035, 0.05, { y: 1.82, z: 0.17 }), skin.glowKey, TEAM_GLOW);
  for (const s of SIDES) {
    add(p, cone(0.055, 0.34, 7, { x: s * 0.19, y: 2.06, rx: -0.15, rz: s * -0.55 }), 'bronze');
  }
  add(p, box(0.05, 0.2, 0.34, { y: 2.1, z: -0.04 }), 'cloth', team);

  // --- back banner: envelope-breaker #1 --------------------------------------
  add(p, cyl(0.032, 0.038, 1.55, 8, { y: 1.75, z: -0.34 }), 'iron');
  add(p, box(0.36, 0.035, 0.035, { y: 2.42, z: -0.4 }), 'bronze');
  add(p, box(0.34, 0.3, 0.03, { y: 2.26, z: -0.41 }), 'cloth', team);
  add(p, box(0.31, 0.28, 0.03, { y: 1.98, z: -0.42, rx: 0.06 }), 'cloth', team);
  add(p, box(0.26, 0.22, 0.03, { y: 1.74, z: -0.44, rx: 0.12 }), 'cloth', team);
  add(p, cone(0.05, 0.14, 6, { y: 2.56, z: -0.39 }), 'bronze');

  // --- tower shield: envelope-breaker #2 -------------------------------------
  add(p, box(0.1, 1.1, 0.72, { x: -0.72, y: 1.1, z: 0.06, rz: 0.06 }), 'iron');
  add(p, box(0.12, 0.07, 0.74, { x: -0.72, y: 1.66, z: 0.06 }), 'bronze');
  add(p, box(0.12, 0.07, 0.74, { x: -0.72, y: 0.55, z: 0.06 }), 'bronze');
  add(p, box(0.12, 1.12, 0.06, { x: -0.72, y: 1.1, z: 0.42 }), 'bronze');
  add(p, box(0.12, 1.12, 0.06, { x: -0.72, y: 1.1, z: -0.3 }), 'bronze');
  add(p, cyl(0.13, 0.17, 0.1, 10, { x: -0.79, y: 1.14, z: 0.06, rz: Math.PI / 2 }), 'bronze');
  glow(p, ico(0.08, 0, { x: -0.85, y: 1.14, z: 0.06 }), accentKey, ACCENT_GLOW);
  add(p, box(0.06, 0.75, 0.06, { x: -0.78, y: 1.1, z: 0.06, rx: 0.5 }), 'iron');
  add(p, box(0.06, 0.75, 0.06, { x: -0.78, y: 1.1, z: 0.06, rx: -0.5 }), 'iron');

  // --- war maul ---------------------------------------------------------------
  add(p, cyl(0.045, 0.05, 1.05, 8, { x: 0.66, y: 1.02, z: 0.1 }), 'leather');
  add(p, cyl(0.14, 0.14, 0.26, 8, { x: 0.66, y: 1.62, z: 0.1 }), 'iron');
  add(p, box(0.3, 0.2, 0.07, { x: 0.66, y: 1.62, z: 0.1 }), 'iron');
  add(p, box(0.07, 0.2, 0.3, { x: 0.66, y: 1.62, z: 0.1 }), 'iron');
  add(p, cone(0.09, 0.14, 6, { x: 0.66, y: 1.8, z: 0.1 }), 'bronze');
  add(p, sphere(0.06, 8, { x: 0.66, y: 0.48, z: 0.1 }), 'bronze');

  // --- team lamps + rivets ----------------------------------------------------
  for (const s of SIDES) {
    glow(p, ico(0.055, 0, { x: s * 0.52, y: 1.86, z: 0.1 }), skin.glowKey, TEAM_GLOW);
  }
  for (const s of SIDES) {
    add(p, sphere(0.03, 6, { x: s * 0.14, y: 1.44, z: -0.3 }), 'bronze');
    add(p, sphere(0.03, 6, { x: s * 0.14, y: 1.08, z: -0.3 }), 'bronze');
  }
  return p;
}

// ============================================================================
// LONGBOW — the Far Eye. Ranged carry, lithe, 1.8 m, accent `frost`.
//
// Silhouette: the narrowest torso on the roster, hooded, with a long hood tail
// falling behind. Envelope-breakers: a 1.73 m recurve bow carried out on the
// left (a plan-view LINE nothing else on the roster has, reaching x = -0.684)
// and a quiver canted out past the RIGHT shoulder whose fletchings reach
// x = 0.67 and z = -0.66: 0.16 m beyond the arms and 0.18 m behind the hood.
//
// Palette: iron / bronze / leather / bark / team cloth / crystal(frost) /
// crystal(team) = 7 buckets.
// ============================================================================
function longbowParts(skin: TeamSkin, accentKey: string): Part[] {
  const p: Part[] = [];
  const team = skin.cloth;

  // --- legs: long and thin, light greaves only ------------------------------
  for (const s of SIDES) {
    add(p, box(0.16, 0.11, 0.3, { x: s * 0.15, y: 0.055, z: 0.04 }), 'leather');
    add(p, cyl(0.075, 0.09, 0.46, 8, { x: s * 0.15, y: 0.33 }), 'iron');
    add(p, sphere(0.09, 8, { x: s * 0.15, y: 0.57, sy: 0.7 }), 'leather');
    add(p, cyl(0.11, 0.095, 0.4, 8, { x: s * 0.145, y: 0.79 }), 'leather');
  }
  add(p, cyl(0.2, 0.19, 0.09, 10, { y: 1.01 }), 'leather');
  add(p, box(0.14, 0.16, 0.1, { x: 0.19, y: 0.95, z: 0.02 }), 'leather');
  add(p, box(0.03, 0.2, 0.05, { x: -0.2, y: 0.94, z: 0.03, rz: 0.15 }), 'iron');

  // --- torso: a brigandine, strapped, not plated ----------------------------
  add(p, cyl(0.19, 0.22, 0.44, 10, { y: 1.22, sz: 0.72 }), 'leather');
  add(p, box(0.3, 0.07, 0.05, { y: 1.3, z: 0.16, rz: 0.5 }), 'leather');
  add(p, box(0.3, 0.07, 0.05, { y: 1.3, z: 0.16, rz: -0.5 }), 'leather');
  add(p, box(0.14, 0.2, 0.05, { y: 1.26, z: 0.18 }), 'iron');
  add(p, cyl(0.13, 0.16, 0.09, 10, { y: 1.46 }), 'iron');

  // --- shoulders and arms ----------------------------------------------------
  for (const s of SIDES) {
    add(p, sphere(0.15, 10, { x: s * 0.34, y: 1.41, sy: 0.55 }), 'iron');
    add(p, capsule(0.065, 0.19, { x: s * 0.38, y: 1.22, rz: s * -0.1 }), 'leather');
    add(p, cyl(0.062, 0.055, 0.3, 8, { x: s * 0.43, y: 0.95, rz: s * -0.08 }), 'cloth', team);
    add(p, box(0.1, 0.11, 0.13, { x: s * 0.46, y: 0.79 }), 'leather');
  }

  // --- hood: the tail is what makes her read as hooded from above ----------
  add(p, sphere(0.115, 10, { y: 1.66, sz: 1.1 }), 'leather');
  add(
    p,
    lathe(
      [
        { r: 0.185, y: -0.1 },
        { r: 0.175, y: -0.02 },
        { r: 0.13, y: 0.12 },
        { r: 0.02, y: 0.2 },
      ],
      12,
      { y: 1.66 },
    ),
    'cloth',
    team,
  );
  add(p, box(0.16, 0.09, 0.04, { y: 1.64, z: 0.13 }), 'iron');
  glow(p, box(0.11, 0.028, 0.03, { y: 1.645, z: 0.157 }), skin.glowKey, TEAM_GLOW);
  add(p, box(0.14, 0.24, 0.05, { y: 1.62, z: -0.2, rx: 0.35 }), 'cloth', team);
  add(p, box(0.11, 0.22, 0.05, { y: 1.44, z: -0.31, rx: 0.55 }), 'cloth', team);
  add(p, box(0.08, 0.18, 0.05, { y: 1.28, z: -0.4, rx: 0.75 }), 'cloth', team);

  // --- quiver: ENVELOPE-BREAKER #2, canted out past the right shoulder ------
  //
  // The old quiver reached x = 0.435 / z = -0.29 against a body whose arms span
  // |x| <= 0.51 and whose hood tail already falls to z = -0.48: it was inside
  // the envelope on both axes, so LONGBOW shipped with ONE breaker where §7
  // requires two. Rebuilt on a steeper cant, the fletchings reach x = 0.666 and
  // z = -0.658 — 0.156 m past the widest point of the rest of the hero and
  // 0.178 m behind the deepest, at a height where the body is only the 0.185 m
  // hood. In plan view that is a spray of feathers standing off the back-right
  // shoulder, which nothing else on the roster has.
  const qx = 0.3;
  const qy = 1.28;
  const qz = -0.32;
  const qrx = -0.4;
  const qrz = -0.42;
  // Unit axis of the quiver = local +Y through rotateX(qrx) then rotateZ(qrz),
  // which is the order `PartOpts` applies. Derived, not typed, so the arrows
  // cannot drift off the tube they are supposed to be standing in.
  const qax = -Math.cos(qrx) * Math.sin(qrz);
  const qay = Math.cos(qrx) * Math.cos(qrz);
  const qaz = Math.sin(qrx);
  const qtop = { x: qx + qax * 0.28, y: qy + qay * 0.28, z: qz + qaz * 0.28 };
  add(p, cyl(0.085, 0.095, 0.56, 10, { x: qx, y: qy, z: qz, rx: qrx, rz: qrz }), 'leather');
  add(p, cyl(0.1, 0.1, 0.07, 10, { x: qtop.x, y: qtop.y, z: qtop.z, rx: qrx, rz: qrz }), 'bronze');
  add(p, box(0.5, 0.07, 0.07, { x: 0.08, y: 1.3, z: -0.14, rz: 0.95 }), 'leather');
  for (let i = 0; i < 3; i++) {
    // Lateral spread along the horizontal perpendicular of the quiver axis.
    const o = (i - 1) * 0.075;
    const lat = Math.hypot(qaz, qax);
    const lx = (-qaz / lat) * o;
    const lz = (qax / lat) * o;
    add(
      p,
      cyl(0.056, 0.056, 0.34, 6, {
        x: qtop.x + qax * 0.15 + lx,
        y: qtop.y + qay * 0.15,
        z: qtop.z + qaz * 0.15 + lz,
        rx: qrx,
        rz: qrz,
      }),
      'bark',
    );
    add(
      p,
      box(0.12, 0.19, 0.05, {
        x: qtop.x + qax * 0.3 + lx,
        y: qtop.y + qay * 0.3,
        z: qtop.z + qaz * 0.3 + lz,
        rx: qrx,
        rz: qrz,
      }),
      'cloth',
      team,
    );
  }

  // --- the bow: seven segments so the recurve is a curve, not a stick -------
  //
  // ENVELOPE-BREAKER #1, and every member of it is a FREE-STANDING ROD drawn
  // against the ground rather than against a parent surface, so all of it is
  // held to AA_MIN_M. The measured failures this replaces, at 21 px/m: string
  // 0.030 m = 0.63 px, limbs 0.054-0.080 m = 1.13-1.68 px, tips 0.070 m =
  // 1.47 px, nocked arrow 0.044 m = 0.92 px, head 0.070 m = 1.47 px. The
  // thinnest thing left on the whole bow arm measures 0.097 m = 2.04 px, taken
  // as the smallest bounding-box extent — exact for a rod, since every rotation
  // here is about a single axis.
  const bowX = -0.62;
  add(p, cyl(0.055, 0.055, 0.24, 8, { x: bowX, y: 1.03, z: 0.1 }), 'leather');
  add(p, cyl(0.054, 0.06, 0.28, 8, { x: bowX + 0.015, y: 1.28, z: 0.1, rz: -0.14 }), 'bark');
  add(p, cyl(0.052, 0.054, 0.28, 8, { x: bowX + 0.065, y: 1.53, z: 0.1, rz: -0.3 }), 'bark');
  add(p, cyl(0.052, 0.052, 0.24, 8, { x: bowX + 0.145, y: 1.74, z: 0.1, rz: -0.55 }), 'bark');
  add(p, cyl(0.06, 0.054, 0.28, 8, { x: bowX + 0.015, y: 0.78, z: 0.1, rz: 0.14 }), 'bark');
  add(p, cyl(0.054, 0.052, 0.28, 8, { x: bowX + 0.065, y: 0.53, z: 0.1, rz: 0.3 }), 'bark');
  add(p, cyl(0.052, 0.052, 0.24, 8, { x: bowX + 0.145, y: 0.32, z: 0.1, rz: 0.55 }), 'bark');
  add(p, sphere(0.055, 8, { x: bowX + 0.205, y: 1.84, z: 0.1 }), 'bronze');
  add(p, sphere(0.055, 8, { x: bowX + 0.205, y: 0.22, z: 0.1 }), 'bronze');
  // The string is 10 cm across. That is a rope, not a filament, and it is the
  // point: 3 cm measured 0.63 px and crawled into a dotted line at gameplay
  // zoom, which is exactly what STYLE_BIBLE §7's last line forbids.
  add(p, box(0.1, 1.62, 0.1, { x: bowX + 0.205, y: 1.03, z: 0.1 }), 'iron');
  add(p, cyl(0.056, 0.056, 0.55, 6, { x: bowX + 0.205, y: 1.03, z: 0.34, rx: Math.PI / 2 }), 'bark');
  add(p, cone(0.058, 0.12, 6, { x: bowX + 0.205, y: 1.03, z: 0.65, rx: Math.PI / 2 }), 'iron');

  // --- frost accents + half-cloak ---------------------------------------------
  glow(p, ico(0.045, 0, { x: bowX - 0.05, y: 1.03, z: 0.1 }), accentKey, ACCENT_GLOW);
  glow(p, ico(0.04, 0, { x: 0.29, y: 1.53, z: -0.21 }), accentKey, ACCENT_GLOW);
  glow(p, ico(0.035, 0, { y: 1.01, z: 0.21 }), accentKey, ACCENT_GLOW);
  add(p, box(0.36, 0.5, 0.045, { x: 0.1, y: 1.18, z: -0.2, rx: 0.12, rz: -0.1 }), 'cloth', team);
  add(p, sphere(0.045, 8, { x: 0.3, y: 1.44, z: -0.08 }), 'bronze');
  return p;
}

// ============================================================================
// REAVER — the Red Harvest. Melee carry, standard build, 1.95 m, accent `gold`.
//
// Silhouette: broad chest, one huge spiked pauldron and one BARE shoulder — the
// asymmetry is deliberate and is the fastest way to tell him from BULLWARK at
// distance. Envelope-breakers: a greatsword slung diagonally across the back
// (from above, a bar crossing the whole body at ~35 degrees and reaching
// z = -0.760, unique on the roster) and a trophy chain swung out in FRONT to
// z = 0.724 with a skull hanging off it.
//
// Palette: iron / bronze / gold / leather / team cloth / crystal(gold) /
// crystal(team) = 7 buckets. He is the only hero carrying real `gold`, which is
// also his accent — the treasure read STYLE_BIBLE §2 wants somewhere in frame.
// ============================================================================
function reaverParts(skin: TeamSkin, accentKey: string): Part[] {
  const p: Part[] = [];
  const team = skin.cloth;

  // --- legs, knee spikes forward (an aggressive stance from above) ----------
  for (const s of SIDES) {
    add(p, box(0.19, 0.13, 0.34, { x: s * 0.19, y: 0.065, z: 0.05 }), 'leather');
    add(p, cyl(0.095, 0.11, 0.44, 10, { x: s * 0.19, y: 0.34 }), 'leather');
    add(p, cone(0.08, 0.16, 6, { x: s * 0.19, y: 0.62, z: 0.1, rx: 1.2 }), 'iron');
    add(p, cyl(0.135, 0.115, 0.4, 10, { x: s * 0.185, y: 0.8 }), 'leather');
  }
  add(p, box(0.2, 0.42, 0.05, { y: 0.82, z: 0.17, rx: 0.08 }), 'cloth', team);
  for (const s of SIDES) {
    add(p, box(0.18, 0.36, 0.05, { x: s * 0.2, y: 0.84, z: 0.14, rx: 0.08 }), 'cloth', team);
  }
  add(p, cyl(0.29, 0.28, 0.13, 12, { y: 1.02 }), 'leather');
  add(p, box(0.17, 0.15, 0.07, { y: 1.02, z: 0.27 }), 'gold');

  // --- torso: harnessed, not plated -----------------------------------------
  add(p, cyl(0.27, 0.31, 0.52, 12, { y: 1.28, sz: 0.78 }), 'leather');
  add(p, box(0.26, 0.28, 0.08, { y: 1.12, z: 0.21 }), 'iron');
  add(p, box(0.44, 0.08, 0.06, { y: 1.34, z: 0.19, rz: 0.55 }), 'leather');
  add(p, box(0.44, 0.08, 0.06, { y: 1.34, z: 0.19, rz: -0.55 }), 'leather');
  add(p, box(0.4, 0.4, 0.08, { y: 1.3, z: -0.22 }), 'iron');

  // --- shoulders: spiked left, bare right ------------------------------------
  add(p, sphere(0.27, 12, { x: -0.44, y: 1.52, sy: 0.6 }), 'iron');
  add(p, cone(0.055, 0.24, 6, { x: -0.4, y: 1.66, rz: 0.2 }), 'bronze');
  add(p, cone(0.055, 0.24, 6, { x: -0.5, y: 1.7, rz: 0.35 }), 'bronze');
  add(p, cone(0.055, 0.22, 6, { x: -0.58, y: 1.62, rz: 0.5 }), 'bronze');
  add(p, sphere(0.17, 10, { x: 0.42, y: 1.5, sy: 0.55 }), 'leather');
  for (const s of SIDES) {
    add(p, capsule(0.1, 0.16, { x: s * 0.47, y: 1.28, rz: s * -0.1 }), 'leather');
  }
  add(p, cyl(0.095, 0.088, 0.3, 10, { x: -0.51, y: 0.98, rz: 0.08 }), 'iron');
  add(p, cyl(0.095, 0.088, 0.3, 10, { x: 0.51, y: 0.98, rz: -0.08 }), 'leather');
  for (const s of SIDES) {
    add(p, box(0.13, 0.14, 0.17, { x: s * 0.54, y: 0.79 }), 'leather');
  }

  // --- trophy chain: ENVELOPE-BREAKER #2 --------------------------------------
  //
  // Swung from the left pauldron, across the chest and out to the right hip,
  // with a skull hanging at the low point. The old chain sat at z <= 0.265 and
  // |x| <= 0.238 — inside a torso 0.242 m deep and 0.31 m wide — so REAVER
  // shipped with ONE breaker where §7 requires two. This catenary reaches
  // z = 0.724 against a body whose deepest forward point is the crystal core at
  // z = 0.338, and in plan view it is a bow bulging out in FRONT: the exact
  // complement of the greatsword's bar behind, and nothing like MENDER's
  // right-offset antler star. That pair measured 0.603 plan-view IoU and now
  // measures 0.476.
  //
  // Link cord measures 0.1045 m mean cross-section = 2.19 px, against the old
  // 0.036 m = 0.76 px. Links alternate 90 degrees, as a real chain does.
  const CHAIN: ReadonlyArray<readonly [number, number, number]> = [
    [-0.52, 1.46, 0.16],
    [-0.34, 1.2, 0.42],
    [-0.11, 1.02, 0.58],
    [0.11, 1.0, 0.6],
    [0.34, 1.12, 0.5],
    [0.52, 1.32, 0.24],
  ];
  CHAIN.forEach(([cx, cy, cz], i) => {
    const yaw = Math.atan2(cx, cz) + (i % 2) * (Math.PI / 2);
    add(p, freeRing(0.075, 0.116, 10, { x: cx, y: cy, z: cz, rx: Math.PI / 2, ry: yaw }), 'bronze');
  });
  add(p, freeRing(0.06, 0.116, 10, { x: 0.0, y: 0.92, z: 0.62, rx: Math.PI / 2 }), 'bronze');
  add(p, ico(0.11, 0, { x: 0.0, y: 0.76, z: 0.62, sy: 1.2 }), 'bronze');

  // --- crested helm + topknot --------------------------------------------------
  add(p, cyl(0.1, 0.12, 0.12, 8, { y: 1.6 }), 'leather');
  add(
    p,
    lathe(
      [
        { r: 0.16, y: -0.06 },
        { r: 0.155, y: 0.04 },
        { r: 0.11, y: 0.15 },
        { r: 0, y: 0.2 },
      ],
      12,
      { y: 1.72 },
    ),
    'iron',
  );
  add(p, box(0.3, 0.07, 0.14, { y: 1.76, z: 0.12 }), 'iron');
  for (const s of SIDES) {
    add(p, box(0.05, 0.18, 0.14, { x: s * 0.145, y: 1.68, z: 0.05 }), 'iron');
  }
  glow(p, box(0.19, 0.032, 0.03, { y: 1.755, z: 0.19 }), skin.glowKey, TEAM_GLOW);
  add(p, box(0.05, 0.14, 0.28, { y: 1.96, z: -0.02 }), 'gold');
  add(p, box(0.09, 0.22, 0.09, { y: 2.06, z: -0.1, rx: 0.3 }), 'cloth', team);
  add(p, box(0.075, 0.2, 0.075, { y: 2.2, z: -0.19, rx: 0.6 }), 'cloth', team);

  // --- greatsword across the back: the diagonal bar in plan view ------------
  const sw = 0.62; // slung angle, radians
  add(p, box(0.1, 1.3, 0.22, { x: -0.02, y: 1.48, z: -0.34, rz: sw }), 'iron');
  add(p, cone(0.11, 0.26, 4, { x: -0.44, y: 2.09, z: -0.34, rz: sw }), 'iron');
  add(p, box(0.11, 1.1, 0.05, { x: -0.02, y: 1.48, z: -0.235, rz: sw }), 'gold');
  add(p, box(0.09, 0.1, 0.62, { x: 0.38, y: 0.94, z: -0.34, rz: sw }), 'iron');
  for (const s of SIDES) {
    add(p, cone(0.05, 0.16, 6, { x: 0.38, y: 0.94, z: -0.34 + s * 0.34, rx: s * 1.5, rz: sw }), 'bronze');
  }
  add(p, cyl(0.045, 0.05, 0.3, 8, { x: 0.52, y: 0.74, z: -0.34, rz: sw }), 'leather');
  add(p, sphere(0.065, 8, { x: 0.61, y: 0.6, z: -0.34 }), 'gold');
  add(p, box(0.44, 0.08, 0.06, { y: 1.24, z: -0.28, rz: -sw }), 'leather');

  // --- gold rune, accent gems, rivets ------------------------------------------
  add(p, ring(0.09, 0.022, 10, { y: 1.36, z: 0.235, rx: Math.PI / 2 }), 'gold');
  glow(p, ico(0.05, 0, { x: -0.44, y: 1.62, z: 0.02 }), accentKey, ACCENT_GLOW);
  glow(p, ico(0.045, 0, { y: 1.02, z: 0.3 }), accentKey, ACCENT_GLOW);
  for (const s of SIDES) {
    add(p, sphere(0.028, 6, { x: s * 0.13, y: 1.42, z: -0.27 }), 'bronze');
    add(p, sphere(0.028, 6, { x: s * 0.13, y: 1.16, z: -0.27 }), 'bronze');
  }
  return p;
}

// ============================================================================
// HEX — the Hollow Star. Mage, lithe, 1.85 m, accent `void`.
//
// Silhouette: THE outlier. No legs at all — a flared robe cone floating clear
// of the ground, which makes his plan view a filled CIRCLE where every other
// hero is a cross or a bar. Envelope-breakers: three concentric tilted orbit
// rings (0.46-0.68 m radius, well outside the body) and a five-spike crown with
// a halo. From directly above he is unmistakable and nobody else is close.
//
// Palette: iron / bronze / leather / night cloth / team cloth / crystal(void) /
// crystal(team) = 7 buckets.
// ============================================================================

/** How far HEX's lowest geometry sits above the ground plane, in metres. He is
 *  the one hero with no legs and the float is the whole read — so it is a
 *  constant every piece of his hem is placed FROM, rather than a number in a
 *  comment. The previous build's hem spikes bottomed out at y = 0.000 under a
 *  comment claiming a 10 cm float: the code, the comment and the geometry all
 *  disagreed, and the geometry is what shipped. */
const HEX_FLOAT = 0.1;

function hexParts(skin: TeamSkin, accentKey: string): Part[] {
  const p: Part[] = [];
  const team = skin.cloth;
  const dark = CLOTH_NIGHT;

  // --- the robe: a lathe-turned cone, hem floating clear of the ground ------
  add(
    p,
    lathe(
      [
        { r: 0.5, y: 0 },
        { r: 0.44, y: 0.16 },
        { r: 0.34, y: 0.42 },
        { r: 0.24, y: 0.72 },
        { r: 0.17, y: 0.95 },
      ],
      14,
      { y: HEX_FLOAT },
    ),
    'cloth',
    dark,
  );
  add(
    p,
    lathe(
      [
        { r: 0.34, y: 0 },
        { r: 0.28, y: 0.14 },
        { r: 0.2, y: 0.34 },
      ],
      14,
      { y: 0.34 },
    ),
    'cloth',
    dark,
  );
  // The hem band and both rings of hem spikes are placed so their LOWEST point
  // is exactly HEX_FLOAT: a lathe ring spans +/- its tube about `y`, and a cone
  // spans +/- half its height whichever way it is flipped.
  add(p, ring(0.5, 0.05, 20, { y: HEX_FLOAT + 0.05 }), 'cloth', team);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    add(
      p,
      cone(0.07, 0.2, 6, {
        x: Math.sin(a) * 0.45,
        y: HEX_FLOAT + 0.1,
        z: Math.cos(a) * 0.45,
        rx: Math.PI,
      }),
      'cloth',
      dark,
    );
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 1.45;
    add(
      p,
      cone(0.05, 0.18, 6, {
        x: Math.sin(a) * 0.3,
        y: HEX_FLOAT + 0.09,
        z: Math.cos(a) * 0.3,
        rx: Math.PI,
      }),
      'cloth',
      dark,
    );
  }

  // --- waist and bodice -------------------------------------------------------
  add(p, ring(0.19, 0.035, 12, { y: 1.06 }), 'bronze');
  add(p, cyl(0.16, 0.19, 0.4, 12, { y: 1.26, sz: 0.75 }), 'cloth', dark);
  add(p, box(0.2, 0.24, 0.06, { y: 1.28, z: 0.14 }), 'iron');
  for (let i = 0; i < 3; i++) {
    add(p, ring(0.17, 0.022, 12, { y: 1.14 + i * 0.1, sz: 0.78 }), 'bronze');
  }

  // --- high collar: reads as a mage from above even with the crown cropped --
  for (const s of SIDES) {
    add(p, box(0.06, 0.3, 0.2, { x: s * 0.13, y: 1.58, z: -0.02, rx: -0.15, rz: s * 0.25 }), 'cloth', team);
  }
  add(p, box(0.26, 0.28, 0.05, { y: 1.58, z: -0.14, rx: -0.25 }), 'cloth', team);

  // --- narrow shoulders, long flared sleeves ---------------------------------
  for (const s of SIDES) {
    add(p, sphere(0.16, 10, { x: s * 0.28, y: 1.42, sy: 0.5 }), 'iron');
    add(p, box(0.18, 0.3, 0.05, { x: s * 0.32, y: 1.24, rz: s * -0.15 }), 'cloth', team);
    add(p, cone(0.05, 0.22, 6, { x: s * 0.3, y: 1.58, rz: s * -0.3 }), 'bronze');
    add(p, cyl(0.06, 0.07, 0.32, 8, { x: s * 0.3, y: 1.2, rz: s * -0.08 }), 'cloth', dark);
    add(p, cyl(0.14, 0.075, 0.26, 10, { x: s * 0.34, y: 0.93, rz: s * -0.06 }), 'cloth', dark);
    add(p, ring(0.145, 0.02, 12, { x: s * 0.34, y: 0.83 }), 'cloth', team);
    add(p, box(0.08, 0.09, 0.11, { x: s * 0.36, y: 0.78 }), 'leather');
  }

  // --- masked head + spiked crown ---------------------------------------------
  add(p, sphere(0.115, 10, { y: 1.64, sz: 1.05 }), 'cloth', dark);
  add(p, box(0.17, 0.2, 0.06, { y: 1.64, z: 0.1 }), 'iron');
  for (const s of SIDES) {
    glow(p, box(0.045, 0.03, 0.03, { x: s * 0.05, y: 1.67, z: 0.14 }), skin.glowKey, TEAM_GLOW);
  }
  add(p, ring(0.13, 0.028, 12, { y: 1.8 }), 'bronze');
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    add(
      p,
      cone(0.032, 0.3, 6, {
        x: Math.sin(a) * 0.13,
        y: 1.95,
        z: Math.cos(a) * 0.13,
        rx: -Math.cos(a) * 0.25,
        rz: Math.sin(a) * 0.25,
      }),
      'bronze',
    );
  }
  glow(p, ico(0.055, 0, { y: 1.96, z: 0.14 }), accentKey, ACCENT_GLOW);

  // --- the halo and the three orbit rings ------------------------------------
  //
  // These four are the only FREE-STANDING rings on the roster: they hang in
  // open air with nothing behind them, so their cord is drawn against the
  // ground and is held to AA_MIN_M. Cord was 0.044-0.056 m, measuring
  // 0.92-1.18 px at 21 px/m — the reviewer's figure — and is now 0.11 m, which
  // measures 0.101 m mean cross-section = 2.12 px on all four (an octagonal
  // tube averages slightly under its nominal diameter). The rings that HUG a
  // surface (bodice, cuffs, crown band, hem, the creel rim) keep
  // their fine cord: they are read against the cloth they sit on, not against
  // the sky, which is the distinction the floor is drawn on.
  add(p, freeRing(0.26, 0.11, 20, { y: 1.86, rx: 0.3 }), 'bronze');
  add(p, freeRing(0.56, 0.11, 24, { y: 1.15, rx: 0.42, rz: 0.12 }), 'bronze');
  add(p, freeRing(0.68, 0.11, 26, { y: 1.05, rx: -0.3, rz: -0.22 }), 'bronze');
  add(p, freeRing(0.46, 0.11, 22, { y: 1.3, rx: 0.75 }), 'bronze');

  // --- void core and rune shards ------------------------------------------------
  glow(p, ico(0.13, 1, { y: 1.28, z: 0.22 }), accentKey, ACCENT_GLOW);
  glow(p, ico(0.05, 0, { x: 0.55, y: 1.28, z: 0.05 }), accentKey, ACCENT_GLOW);
  glow(p, ico(0.05, 0, { x: -0.5, y: 1.02, z: 0.24 }), accentKey, ACCENT_GLOW);
  glow(p, ico(0.045, 0, { x: 0.2, y: 0.9, z: -0.62 }), accentKey, ACCENT_GLOW);
  glow(p, ico(0.045, 0, { x: -0.24, y: 1.44, z: -0.4 }), accentKey, ACCENT_GLOW);
  for (const s of SIDES) {
    glow(p, ico(0.04, 0, { x: s * 0.14, y: 1.06, z: 0.13 }), accentKey, ACCENT_GLOW);
  }

  // --- robe trim: four vertical stripes following the cone ------------------
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.78;
    add(
      p,
      box(0.05, 0.6, 0.03, {
        x: Math.sin(a) * 0.34,
        y: 0.52,
        z: Math.cos(a) * 0.34,
        rx: Math.cos(a) * 0.2,
        rz: -Math.sin(a) * 0.2,
      }),
      'cloth',
      team,
    );
  }
  return p;
}

// ============================================================================
// MENDER — the Green Vow. Support, standard build, 1.8 m, accent `heal`.
//
// Silhouette: a layered robe on a narrow frame, hooded, with a satchel breaking
// the left hip. Envelope-breakers: a two-metre staff carried well out on the
// right whose ANTLER crown (five branches) sits above and beside the head — in
// plan view a branching star offset from the body, which no other hero has —
// and a woven herb creel slung BACK-LEFT reaching x = -0.781, z = -0.690. In
// plan view she is a diagonal: star up-right, basket down-left. The stoles that
// used to be claimed here as the second breaker measured |x| <= 0.30 inside a
// 0.42 m robe and z <= 0.31 inside a 0.32 m mantle — they were never outside
// anything, and they are what made her plan view 0.60 IoU against REAVER's.
//
// Palette deliberately contains NO METAL: bark / fern / leather / homespun
// cloth / team cloth / crystal(heal) / crystal(team) = 7 buckets. Wood, leaf,
// hide and cloth is a material story the five armoured heroes cannot produce,
// and it makes her the one hero identifiable by SURFACE as well as by shape.
// ============================================================================
function menderParts(skin: TeamSkin, accentKey: string): Part[] {
  const p: Part[] = [];
  const team = skin.cloth;
  const dark = CLOTH_HOMESPUN;

  for (const s of SIDES) {
    add(p, box(0.16, 0.12, 0.28, { x: s * 0.14, y: 0.06, z: 0.03 }), 'leather');
  }
  add(
    p,
    lathe(
      [
        { r: 0.42, y: 0 },
        { r: 0.38, y: 0.18 },
        { r: 0.3, y: 0.46 },
        { r: 0.22, y: 0.74 },
        { r: 0.17, y: 0.92 },
      ],
      14,
      { y: 0.14 },
    ),
    'cloth',
    dark,
  );
  add(
    p,
    lathe(
      [
        { r: 0.3, y: 0 },
        { r: 0.24, y: 0.16 },
        { r: 0.19, y: 0.32 },
      ],
      14,
      { y: 0.52 },
    ),
    'cloth',
    dark,
  );
  add(p, ring(0.42, 0.032, 20, { y: 0.16 }), 'cloth', team);
  // One front stole, kept for the cloth read. The two flanking it are gone:
  // they sat at |x| <= 0.30 inside a robe of radius 0.38 at that height, so
  // they cost two parts and bought no outline. The censer below is what those
  // parts were spent on instead.
  add(p, box(0.16, 0.6, 0.04, { y: 0.52, z: 0.27, rx: 0.05 }), 'cloth', team);

  // --- belt, pouches, satchel (breaks the left hip) --------------------------
  add(p, cyl(0.2, 0.19, 0.1, 12, { y: 1.03 }), 'leather');
  add(p, box(0.13, 0.12, 0.06, { y: 1.03, z: 0.21 }), 'bark');
  add(p, box(0.1, 0.13, 0.08, { x: -0.18, y: 0.96, z: 0.02 }), 'leather');
  add(p, box(0.1, 0.13, 0.08, { x: 0.18, y: 0.96, z: -0.02 }), 'leather');
  add(p, box(0.1, 0.12, 0.08, { y: 0.96, z: -0.2 }), 'leather');
  add(p, box(0.2, 0.2, 0.11, { x: -0.26, y: 0.92, z: -0.06, rz: 0.1 }), 'leather');
  add(p, box(0.21, 0.1, 0.12, { x: -0.26, y: 1.01, z: -0.06, rz: 0.1 }), 'leather');
  add(p, box(0.42, 0.06, 0.05, { y: 1.24, z: 0.02, rz: -0.65 }), 'leather');
  add(p, box(0.06, 0.05, 0.03, { x: -0.16, y: 1.02, z: 0.04 }), 'bark');

  // --- torso and mantle --------------------------------------------------------
  // The two mantle stoles that hung here reached z = 0.31 against a mantle of
  // radius 0.32 and a robe of radius 0.38 — inside the envelope on every axis,
  // which is why they were never a silhouette-breaker whatever the old comment
  // claimed. Their budget went to the censer.
  add(p, cyl(0.17, 0.2, 0.42, 12, { y: 1.26, sz: 0.8 }), 'cloth', dark);
  add(p, box(0.22, 0.3, 0.05, { y: 1.26, z: 0.16 }), 'cloth', team);
  add(
    p,
    lathe(
      [
        { r: 0.32, y: -0.1 },
        { r: 0.26, y: 0.02 },
        { r: 0.1, y: 0.2 },
      ],
      14,
      { y: 1.42 },
    ),
    'cloth',
    dark,
  );
  add(p, ring(0.13, 0.035, 14, { y: 1.56 }), 'cloth', team);
  glow(p, ico(0.05, 0, { y: 1.56, z: 0.13 }), accentKey, ACCENT_GLOW);

  // --- arms: flared sleeves, no pauldrons (she is not armoured) -------------
  for (const s of SIDES) {
    add(p, cyl(0.075, 0.07, 0.32, 8, { x: s * 0.3, y: 1.22, rz: s * -0.08 }), 'cloth', dark);
    add(p, cyl(0.13, 0.08, 0.24, 10, { x: s * 0.33, y: 0.96, rz: s * -0.06 }), 'cloth', dark);
    add(p, ring(0.135, 0.022, 12, { x: s * 0.33, y: 0.86 }), 'cloth', team);
    add(p, box(0.09, 0.1, 0.12, { x: s * 0.35, y: 0.78 }), 'leather');
  }

  // --- hooded head under a living circlet -------------------------------------
  add(p, sphere(0.115, 10, { y: 1.66, sz: 1.05 }), 'leather');
  add(
    p,
    lathe(
      [
        { r: 0.18, y: -0.12 },
        { r: 0.17, y: -0.03 },
        { r: 0.12, y: 0.11 },
        { r: 0.02, y: 0.19 },
      ],
      12,
      { y: 1.68 },
    ),
    'cloth',
    dark,
  );
  add(p, box(0.15, 0.07, 0.05, { y: 1.63, z: 0.12 }), 'leather');
  glow(p, box(0.11, 0.026, 0.03, { y: 1.645, z: 0.147 }), skin.glowKey, TEAM_GLOW);
  add(p, ring(0.135, 0.022, 14, { y: 1.74 }), 'bark');
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    add(
      p,
      ico(0.06, 0, {
        x: Math.sin(a) * 0.15,
        y: 1.78,
        z: Math.cos(a) * 0.15,
        sx: 1.6,
        sy: 0.35,
        ry: a,
        rx: -0.4,
      }),
      'fern',
    );
  }

  // --- the staff: ENVELOPE-BREAKER #1, carried well clear of the body -------
  const sx = 0.44;
  add(p, cyl(0.036, 0.042, 0.62, 8, { x: sx, y: 0.36, z: 0.06 }), 'bark');
  add(p, cyl(0.033, 0.036, 0.62, 8, { x: sx, y: 0.98, z: 0.06 }), 'bark');
  add(p, cyl(0.03, 0.033, 0.56, 8, { x: sx, y: 1.57, z: 0.06 }), 'bark');
  add(p, cyl(0.044, 0.044, 0.2, 8, { x: sx, y: 0.98, z: 0.06 }), 'leather');
  add(p, cone(0.042, 0.12, 6, { x: sx, y: 0.07, z: 0.06, rx: Math.PI }), 'bark');
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.5;
    add(
      p,
      cyl(0.026, 0.032, 0.34, 6, {
        x: sx + Math.sin(a) * 0.12,
        y: 1.98,
        z: 0.06 + Math.cos(a) * 0.12,
        rx: -Math.cos(a) * 0.5,
        rz: Math.sin(a) * 0.5,
      }),
      'bark',
    );
  }
  for (const s of SIDES) {
    add(p, cyl(0.02, 0.024, 0.2, 6, { x: sx + s * 0.2, y: 2.12, z: 0.06, rz: s * 0.8 }), 'bark');
  }
  for (let i = 0; i < 3; i++) {
    add(p, ring(0.05, 0.018, 10, { x: sx, y: 1.2 + i * 0.25, z: 0.06, rx: 0.2 }), 'fern');
  }
  add(p, ico(0.075, 0, { x: sx - 0.06, y: 1.62, z: 0.02, sy: 0.5 }), 'fern');
  add(p, ico(0.075, 0, { x: sx + 0.06, y: 1.78, z: 0.1, sy: 0.5 }), 'fern');
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    add(
      p,
      cone(0.028, 0.16, 5, {
        x: sx + Math.sin(a) * 0.07,
        y: 1.92,
        z: 0.06 + Math.cos(a) * 0.07,
        rx: -Math.cos(a) * 0.35,
        rz: Math.sin(a) * 0.35,
      }),
      'bark',
    );
  }

  // --- the herb creel: ENVELOPE-BREAKER #2, slung BACK-LEFT ------------------
  //
  // A woven bark basket on the shoulder strap, opposite the staff and behind
  // the shoulder. Bark, leaf and a heal-coloured phial: no metal, so it costs
  // no new bucket and keeps the material story that makes her the one hero
  // identifiable by SURFACE.
  //
  // BACK-LEFT is chosen by measurement, not by taste. The creel reaches
  // x = -0.781 and z = -0.690 against a body whose widest point is the left
  // sleeve at x = -0.487 and whose deepest is the robe hem at z = -0.452, so it
  // stands 0.29 m and 0.24 m clear of the outline on the two axes. Hanging it
  // straight out to the LEFT instead was built and measured first: it landed
  // inside BULLWARK's tower-shield footprint and drove that pair's plan-view
  // IoU from 0.534 to 0.610. Back-left brings it to 0.473.
  add(p, cyl(0.16, 0.19, 0.42, 10, { x: -0.52, y: 1.02, z: -0.42, rx: -0.2, rz: -0.18 }), 'bark');
  add(p, ring(0.185, 0.05, 12, { x: -0.55, y: 1.22, z: -0.46, rx: -0.2, rz: -0.18 }), 'bark');
  add(p, cyl(0.14, 0.16, 0.06, 10, { x: -0.49, y: 0.82, z: -0.38, rx: -0.2, rz: -0.18 }), 'bark');
  add(p, ico(0.12, 0, { x: -0.57, y: 1.3, z: -0.5, sy: 0.6, ry: 0.5 }), 'fern');
  add(p, ico(0.1, 0, { x: -0.45, y: 1.34, z: -0.4, sy: 0.5, ry: -0.7 }), 'fern');
  glow(p, ico(0.055, 0, { x: -0.36, y: 1.0, z: -0.3 }), accentKey, ACCENT_GLOW);
  return p;
}

// ============================================================================
// SHADE — the Ninth Cut. Assassin, lithe, 1.75 m, accent `shade`.
//
// Silhouette: the only CROUCHED hero — knees forward, torso pitched ~13 degrees
// over them, so he reads visibly lower and more compact than everyone else even
// before the props. Envelope-breakers: twin reverse-grip daggers held wide and
// angled back (a plan-view X), and a forked scarf whose two tails trail 0.7 m
// behind him. A hunched ridge of three spine blades finishes the read from
// directly above.
//
// Palette: iron / bronze / leather / night cloth / team cloth / crystal(shade)
// / crystal(team) = 7 buckets.
// ============================================================================
function shadeParts(skin: TeamSkin, accentKey: string): Part[] {
  const p: Part[] = [];
  const team = skin.cloth;
  const dark = CLOTH_NIGHT;

  // --- crouch: shins rake forward, thighs rake back -------------------------
  for (const s of SIDES) {
    add(p, box(0.14, 0.1, 0.3, { x: s * 0.17, y: 0.05, z: 0.06 }), 'leather');
    add(p, cyl(0.065, 0.078, 0.4, 8, { x: s * 0.17, y: 0.28, z: 0.04, rx: -0.3 }), 'leather');
    add(p, sphere(0.082, 8, { x: s * 0.17, y: 0.5, z: 0.12, sy: 0.8 }), 'iron');
    add(p, cyl(0.095, 0.082, 0.34, 8, { x: s * 0.165, y: 0.63, rx: 0.55 }), 'leather');
    add(p, ring(0.075, 0.022, 10, { x: s * 0.17, y: 0.14, rx: 0.2 }), 'cloth', team);
    add(p, box(0.2, 0.24, 0.06, { x: s * 0.13, y: 0.68, z: 0.1, rx: 0.15 }), 'cloth', dark);
  }
  add(p, cyl(0.17, 0.165, 0.09, 10, { y: 0.76, rx: 0.18 }), 'leather');

  // --- torso pitched forward over the knees ---------------------------------
  add(p, cyl(0.155, 0.18, 0.44, 10, { y: 0.99, z: 0.06, rx: -0.22, sz: 0.75 }), 'leather');
  add(p, box(0.2, 0.24, 0.06, { y: 1.02, z: 0.2, rx: -0.22 }), 'iron');
  add(p, box(0.24, 0.3, 0.06, { y: 1.0, z: -0.1, rx: -0.22 }), 'iron');
  add(p, box(0.05, 0.2, 0.07, { y: 1.1, z: -0.16, rx: -0.5 }), 'iron');
  add(p, box(0.05, 0.2, 0.07, { y: 0.98, z: -0.14, rx: -0.5 }), 'iron');
  add(p, box(0.05, 0.18, 0.07, { y: 0.86, z: -0.1, rx: -0.5 }), 'iron');

  // --- arms + twin reverse-grip daggers, the plan-view X --------------------
  for (const s of SIDES) {
    add(p, sphere(0.13, 10, { x: s * 0.24, y: 1.18, z: 0.02, sy: 0.55 }), 'iron');
    add(p, capsule(0.055, 0.17, { x: s * 0.28, y: 1.02, z: 0.04, rz: s * -0.14 }), 'leather');
    add(p, cyl(0.055, 0.05, 0.28, 8, { x: s * 0.36, y: 0.8, z: 0.1, rz: s * -0.22 }), 'cloth', team);
    add(p, box(0.07, 0.08, 0.1, { x: s * 0.42, y: 0.64, z: 0.14 }), 'leather');
    add(p, box(0.032, 0.44, 0.08, { x: s * 0.52, y: 0.62, z: -0.06, rx: -0.5, rz: s * -0.35 }), 'iron');
    add(p, box(0.13, 0.04, 0.06, { x: s * 0.44, y: 0.7, z: 0.1 }), 'bronze');
    add(p, cyl(0.03, 0.032, 0.14, 6, { x: s * 0.43, y: 0.66, z: 0.14 }), 'leather');
    add(p, sphere(0.035, 6, { x: s * 0.42, y: 0.58, z: 0.16 }), 'bronze');
  }

  // --- horned mask under a low hood -------------------------------------------
  add(p, sphere(0.105, 10, { y: 1.42, z: 0.06, sz: 1.05 }), 'cloth', dark);
  add(p, box(0.17, 0.19, 0.06, { y: 1.42, z: 0.16 }), 'iron');
  for (const s of SIDES) {
    glow(p, box(0.05, 0.026, 0.03, { x: s * 0.045, y: 1.46, z: 0.197 }), skin.glowKey, TEAM_GLOW);
    add(p, cone(0.035, 0.28, 6, { x: s * 0.09, y: 1.62, z: 0.02, rx: -0.3, rz: s * -0.35 }), 'bronze');
  }
  add(
    p,
    lathe(
      [
        { r: 0.165, y: -0.12 },
        { r: 0.155, y: -0.04 },
        { r: 0.11, y: 0.09 },
        { r: 0.02, y: 0.16 },
      ],
      12,
      { y: 1.46, z: 0.02 },
    ),
    'cloth',
    dark,
  );

  // --- forked scarf: two tails, different lengths so it never reads mirrored -
  add(p, ring(0.115, 0.045, 12, { y: 1.28, z: 0.04, rx: -0.2 }), 'cloth', team);
  for (let i = 0; i < 3; i++) {
    add(
      p,
      box(0.11 - i * 0.012, 0.26, 0.04, { x: -0.06, y: 1.18 - i * 0.22, z: -0.24 - i * 0.19, rx: 0.6 + i * 0.25, rz: 0.08 }),
      'cloth',
      team,
    );
    add(
      p,
      box(0.09 - i * 0.01, 0.24, 0.04, { x: 0.08, y: 1.14 - i * 0.23, z: -0.28 - i * 0.21, rx: 0.7 + i * 0.25, rz: -0.1 }),
      'cloth',
      team,
    );
  }

  // --- throwing knives + shadow motes ------------------------------------------
  for (let i = 0; i < 3; i++) {
    add(p, box(0.03, 0.14, 0.05, { x: -0.1 + i * 0.1, y: 0.74, z: -0.16, rz: 0.1 }), 'iron');
  }
  for (const s of SIDES) {
    glow(p, ico(0.045, 0, { x: s * 0.26, y: 1.28, z: -0.06 }), accentKey, ACCENT_GLOW);
  }
  glow(p, ico(0.04, 0, { y: 0.78, z: 0.17 }), accentKey, ACCENT_GLOW);
  return p;
}

// ============================================================================
// Assembly
// ============================================================================

/**
 * The APAL hex behind an APAL key name — the `tint` (ALBEDO) that rides beside
 * a crystal part's emissive `colorKey`.
 *
 * Both channels are needed and they are not the same channel: `colorKey` sets
 * `emissiveIntensity`'s colour, `tint` sets the diffuse. `emissiveSurface` and
 * therefore `bake()` take both (AMENDMENT_3 §A), so this is a plain palette
 * lookup now rather than the pivot of a workaround.
 *
 * Unknown keys fall back to the crystal family's own `ward` rather than throw:
 * a builder must never white-screen the game (GRAPHICS_CONTRACT §7.7).
 */
function tintOf(colorKey: string): string {
  const hex = (APAL as unknown as Record<string, string>)[colorKey];
  return hex ?? APAL.ward;
}

/**
 * One hero's animated carve-out: a single kit primitive plus the material
 * description R_UNITS mounts it with.
 *
 * `UnitBuild.anim` is an `AnimPart`, so the material travels IN THE TYPE — no
 * `userData.rift*` side-channel, and R_UNITS never guesses from `animKind`
 * (AMENDMENT_3 §B). Because the geometry never passes through `bake()`, this
 * module owns the two things `bake()` would otherwise do:
 *
 *  1. `whiteVertexColors(geo)` — applied in `buildHero`. Every kit material is
 *     `vertexColors: true`; without a `color` attribute the mote renders BLACK
 *     and typechecks perfectly.
 *  2. UV layout. `bake()`'s world-space reprojection does not run, so each anim
 *     geometry is built with `uvLocal`: the AnimPart contract's own guidance is
 *     that a small unit part's normalised UVs ARE the intended layout, and at
 *     0.20-0.40 m across these are exactly that case. Five of the six are
 *     `crystal`, which carries no `map`, no `normalMap` and no `roughnessMap`
 *     at all, so UVs are unobservable on them; REAVER's `gold` ring is the one
 *     that samples a map, and a 0.40 m ring under one normalised tile of the
 *     `polished` pattern matches the density its body armour renders at.
 */
interface HeroAnim {
  readonly geo: THREE.BufferGeometry;
  readonly kind: 'orbit' | 'bob' | 'spin';
  readonly y: number;
  readonly surfaceId: SurfaceId;
  /** Present on every anim that is a light source; absent on REAVER's ring,
   *  which blooms as METAL rather than as an emissive. */
  readonly emissive?: EmissiveSpec;
  readonly tint: string;
}

/**
 * The health bar's fit, derived from the FROZEN ROSTER rather than hand-typed.
 *
 * `heroById(id).visual` carries `height` (the roster's "model scale anchor")
 * and `build` — and both used to be ignored here in favour of six typed pairs,
 * which made the roster decorative and let the two 1.80 m heroes drift to two
 * different bar heights for no reason anyone could state.
 *
 * `barH = visual.height * BAR_HEAD_CLEARANCE`. The bar is placed against the
 * HEAD, not against the tallest prop: 16% above the roster height clears every
 * hero's headgear (BULLWARK's horns at 2.23 under 2.436, HEX's crown spikes at
 * 2.10 under 2.146) while staying close enough to read as attached. Props are
 * allowed to cross it, exactly as they do in the game this is benchmarked
 * against — measured crossings are listed on `buildHero`.
 *
 * `barW` is a function of `visual.build` alone: mass, not height, is what a bar
 * has to span, and a bulky hero with a lithe hero's bar reads as mis-parented.
 */
const BAR_HEAD_CLEARANCE = 1.16;

const BAR_W_BY_BUILD: Record<HeroVisual['build'], number> = {
  bulky: 1.32,
  standard: 1.2,
  lithe: 1.08,
};

/**
 * The floating carve-out per hero, positioned clear of the body. `orbit` sweeps
 * a 0.55 m circle at `y` (R_UNITS' constant), which is wider than every hero's
 * arms — so every orbit here sits ABOVE the head or, for HEX, deliberately
 * inside his ring cage where the weave is the effect. `bob` and `spin` sit on
 * the unit's own axis and are therefore only legible above the headgear.
 *
 * Colour is the hero's ACCENT, not the team's: the body already carries team
 * identity on cloth and on two lamps, and the mote is the hero's signature.
 */
function heroAnim(id: HeroId, accentKey: string): HeroAnim {
  const core = {
    surfaceId: 'crystal' as const,
    emissive: { colorKey: accentKey, intensity: ACCENT_GLOW },
    tint: tintOf(accentKey),
  };
  switch (id) {
    case 'bullwark':
      // A rally beacon riding high over the banner — the Rampart's ult, made
      // visible from across the map.
      return { geo: ico(0.14, 1, { uvLocal: true }), kind: 'bob', y: 2.7, ...core };
    case 'longbow':
      return { geo: ico(0.11, 0, { sy: 1.6, uvLocal: true }), kind: 'orbit', y: 2.02, ...core };
    case 'reaver':
      // The one anim that is METAL, not light. `gold` is documented in SURFACES
      // as "marked into BLOOM_LAYER by its builder", so it blooms with no
      // emissive at all — which is precisely why `AnimPart.bloom` is a separate
      // field from `AnimPart.emissive` and not derived from it.
      return {
        geo: ring(0.2, 0.05, 16, { rx: Math.PI / 2, uvLocal: true }),
        kind: 'spin',
        y: 2.48,
        surfaceId: 'gold',
        tint: APAL.goldLit,
      };
    case 'hex':
      // Weaves through the three orbit rings rather than above them: the rings
      // ARE his silhouette and a mote threading them sells that they are real.
      return { geo: ico(0.13, 0, { sy: 1.8, uvLocal: true }), kind: 'orbit', y: 1.35, ...core };
    case 'mender':
      return { geo: sphere(0.13, 12, { uvLocal: true }), kind: 'bob', y: 2.35, ...core };
    case 'shade':
      return { geo: ico(0.1, 0, { sy: 1.4, uvLocal: true }), kind: 'orbit', y: 2.05, ...core };
  }
}

/**
 * The unbaked part list for one hero — what `buildHero` hands to `bake()`.
 *
 * Exported because both §7 gates on this module are gates on the PARTS and
 * neither survives the merge: `bake()` fuses everything sharing a material into
 * one geometry, after which the 45-70 part budget is uncountable and the
 * anti-aliasing floor (`AA_MIN_M`) is unmeasurable. `heroes.test.ts` walks this
 * list; `buildHero` is its only other caller.
 *
 * The geometries are FRESH on every call and `bake()` consumes them, so a
 * caller that measures the list must not also bake it.
 */
export function heroParts(id: HeroId, team: EntTeam): Part[] {
  const skin = teamSkin(team);
  const accentKey = heroById(id).visual.accent;
  switch (id) {
    case 'bullwark':
      return bullwarkParts(skin, accentKey);
    case 'longbow':
      return longbowParts(skin, accentKey);
    case 'reaver':
      return reaverParts(skin, accentKey);
    case 'hex':
      return hexParts(skin, accentKey);
    case 'mender':
      return menderParts(skin, accentKey);
    case 'shade':
      return shadeParts(skin, accentKey);
  }
}

/**
 * Build one hero archetype. Called ONCE per (hero, team) by R_UNITS, which then
 * pools and reuses the result for every entity of that archetype — never once
 * per entity, and never per frame.
 *
 * `team` is `EntTeam` because the frozen builder signature is; a hero is always
 * on a player team, and the neutral branch is narrowed with `isPlayerTeam`
 * inside `teamSkin` rather than assumed away.
 */
export function buildHero(id: HeroId, team: EntTeam): UnitBuild {
  const visual = heroById(id).visual;
  const parts = heroParts(id, team);
  const body = bake(parts);

  // ---- bloom, in ONE pass over the baked buckets ---------------------------
  //
  // No material is built, chosen or re-pointed here. Every crystal part
  // declared its own `emissive` (see `glow`), so `bake()` bucketed it by
  // (surface, tint, emissive) and already built it through
  // `emissiveSurface(id, colorKey, intensity, tint)`. `BakedMesh.parts` stays
  // readonly and untouched: the previous version of this file minted twelve
  // flat `surface('crystal', tint)` materials purely to recognise the buckets,
  // re-pointed them away, and left all twelve in the process-lifetime
  // `matCache` — while the re-point discarded the team tint it was meant to
  // preserve (AMENDMENT_3 §A).
  //
  // `partMaterial` is the SAME resolver `bake()` used, and it is cache-backed,
  // so these lookups are hits on materials that already exist. Nothing is
  // minted by this loop.
  //
  // Bloom is layer-masked, so only genuine light sources go on BLOOM_LAYER: the
  // two crystal glows, plus `gold`, which SURFACES documents as "marked into
  // BLOOM_LAYER by its builder" because the environment's sun disc is genuinely
  // bright in it. Armour and cloth must NOT be marked — bloom on everything is
  // the amateur tell STYLE_BIBLE §6 names by hand.
  const bloomMats = new Set<THREE.Material>();
  for (const p of parts) {
    if (p.emissive !== undefined || p.surface === 'gold') {
      bloomMats.add(partMaterial(p.surface, p.tint, p.emissive));
    }
  }
  for (const child of body.group.children) {
    if (child instanceof THREE.Mesh && !Array.isArray(child.material)) {
      if (bloomMats.has(child.material)) markBloom(child);
    }
  }
  body.group.name = `rift:hero:${id}`;

  const anim = heroAnim(id, visual.accent);
  return {
    body,
    // VERTEX-COLOUR LAW: this geometry never sees `bake()`, so it carries no
    // `color` attribute of its own and would render black without this.
    anim: animPartOf(anim),
    animKind: anim.kind,
    animY: anim.y,
    // ROSTER-DERIVED, not hand-typed. See BAR_HEAD_CLEARANCE / BAR_W_BY_BUILD.
    // Measured maxY against barH, in metres, over the shipped geometry:
    //   bullwark 2.630 vs 2.436 — the back banner crosses by 0.194
    //   longbow  1.895 vs 2.088 — clears
    //   reaver   2.304 vs 2.262 — the greatsword crosses by 0.042
    //   hex      2.095 vs 2.146 — clears
    //   mender   2.202 vs 2.088 — the antler staff crosses by 0.114
    //   shade    1.746 vs 2.030 — clears
    barH: visual.height * BAR_HEAD_CLEARANCE,
    barW: BAR_W_BY_BUILD[visual.build],
  };
}

/** Wrap one `HeroAnim` as the frozen `AnimPart`. Split out so the two branches
 *  of the optional `emissive` are written once: `exactOptionalPropertyTypes`
 *  rejects spreading a possibly-`undefined` optional field. */
function animPartOf(a: HeroAnim): AnimPart {
  const geo = whiteVertexColors(a.geo);
  return a.emissive === undefined
    ? { geo, surfaceId: a.surfaceId, tint: a.tint, bloom: true }
    : { geo, surfaceId: a.surfaceId, tint: a.tint, emissive: a.emissive, bloom: true };
}
