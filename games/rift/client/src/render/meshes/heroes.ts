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
//   LONGBOW   narrow spindle + a 1.5 m recurve bow arc off the left + quiver
//   REAVER    broad torso + a greatsword bar crossing the whole back diagonally
//   HEX       a circle: flared robe hem inside three concentric orbit rings
//   MENDER    narrow robe + an antlered staff crown offset well to the right
//   SHADE     a crouched X of twin daggers with a forked scarf trailing behind
//
// Those six plan shapes are distinguishable as pure black cutouts, which is the
// §7 bar. Part budget is 45-70 each (§7); the exact count is stamped onto the
// baked group as `userData.riftPartCount` so a reviewer or a harness can check
// the budget against the shipped geometry instead of against this comment.
//
// LAWS OBSERVED HERE (GRAPHICS_CONTRACT §1, §2; STYLE_BIBLE §2, §7, §11):
//
//  * MATERIAL LAW. Every material comes from the kit's `surface()` /
//    `emissiveSurface()`. There is no `new THREE.Mesh*Material` in this file.
//  * VERTEX-COLOUR LAW. Body geometry goes through `bake()`, which writes the
//    white default itself. The one geometry that does NOT — `UnitBuild.anim`,
//    which stays unbaked so R_UNITS can transform it per frame — is passed
//    through `whiteVertexColors()` here. Without it that part renders black.
//  * UV LAW. Parts keep the kit's default world-space projection (1 UV unit =
//    1 world metre), so a hero's texel density matches the ground it stands on.
//    No `uvLocal`, no `texture.repeat`, no per-object texture scale.
//  * BLOOM. Emissive alone does not glow: only the crystal buckets (and gold,
//    which SURFACES documents as "marked into BLOOM_LAYER by its builder") are
//    passed to `markBloom`. Nothing else on a hero is a bloom target — bloom on
//    armour is the amateur tell STYLE_BIBLE §6 names.
//  * PALETTE. No ad-hoc hex. Every tint is an APAL entry.
//  * TEAM IDENTITY is tinted trim on a small number of parts — cloth (cape,
//    banner, scarf, stole) plus one small team-coloured emissive (visor slit,
//    eye glow) — never a whole-model tint, which would erase the hero read.
//    Hero identity is carried separately by `heroById(id).visual.accent`, an
//    APAL key that becomes this hero's emissive core.
//
// DRAW CALLS. `bake()` merges one geometry per (surface, tint) pair, so a hero
// costs one draw call per distinct material, not per part. Every hero here is
// held to at most SEVEN buckets; at a 10-hero peak that is ~65 of the 700-call
// budget (GRAPHICS_CONTRACT §5). Adding an eighth material to a hero costs ten
// draw calls at peak, which is why the per-hero palettes below are deliberately
// short and why MENDER is built with no metal at all.
//
// ORIENTATION, matching the house convention in units.ts: origin at the feet,
// +Y up, and the model faces +Z (R_UNITS writes `rotation.y = atan2(dx, dz)`).
// ============================================================================
import * as THREE from 'three';
import { APAL } from '@rift/shared/palette.js';
import { heroById, type HeroId } from '@rift/shared/hero.js';
import { isPlayerTeam, type EntTeam } from '@rift/shared/types.js';
import type { SurfaceId } from '@rift/shared/surfaces.js';
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
  sphere,
  surface,
  type BakedMesh,
  type BakedPart,
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
  const accent = emissiveSurfaceTint(accentKey);
  const teamGlow = emissiveSurfaceTint(skin.glowKey);

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
  add(p, box(0.26, 0.035, 0.05, { y: 1.82, z: 0.17 }), 'crystal', teamGlow);
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
  add(p, ico(0.08, 0, { x: -0.85, y: 1.14, z: 0.06 }), 'crystal', accent);
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
    add(p, ico(0.055, 0, { x: s * 0.52, y: 1.86, z: 0.1 }), 'crystal', teamGlow);
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
// falling behind. Envelope-breakers: a 1.5 m recurve bow carried out on the
// left (a plan-view LINE nothing else on the roster has) and a quiver slung
// diagonally over the right shoulder with fletchings standing proud of it.
//
// Palette: iron / bronze / leather / bark / team cloth / crystal(frost) /
// crystal(team) = 7 buckets.
// ============================================================================
function longbowParts(skin: TeamSkin, accentKey: string): Part[] {
  const p: Part[] = [];
  const team = skin.cloth;
  const accent = emissiveSurfaceTint(accentKey);
  const teamGlow = emissiveSurfaceTint(skin.glowKey);

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
    add(p, box(0.09, 0.1, 0.13, { x: s * 0.46, y: 0.79 }), 'leather');
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
  add(p, box(0.11, 0.028, 0.03, { y: 1.645, z: 0.157 }), 'crystal', teamGlow);
  add(p, box(0.14, 0.24, 0.05, { y: 1.62, z: -0.2, rx: 0.35 }), 'cloth', team);
  add(p, box(0.11, 0.22, 0.05, { y: 1.44, z: -0.31, rx: 0.55 }), 'cloth', team);
  add(p, box(0.08, 0.18, 0.05, { y: 1.28, z: -0.4, rx: 0.75 }), 'cloth', team);

  // --- quiver, worn high on the right so the fletchings clear the shoulder --
  add(p, cyl(0.075, 0.085, 0.48, 10, { x: 0.17, y: 1.3, z: -0.22, rx: 0.3, rz: -0.28 }), 'leather');
  add(p, cyl(0.085, 0.085, 0.05, 10, { x: 0.29, y: 1.53, z: -0.16, rz: -0.28 }), 'bronze');
  add(p, box(0.42, 0.05, 0.06, { y: 1.28, z: 0.02, rz: 0.9 }), 'leather');
  for (let i = 0; i < 3; i++) {
    const dx = 0.29 + (i - 1) * 0.045;
    const dz = -0.16 + (i - 1) * 0.035;
    add(p, cyl(0.024, 0.024, 0.32, 5, { x: dx, y: 1.7, z: dz, rz: -0.28 }), 'bark');
    add(p, box(0.032, 0.12, 0.1, { x: dx + 0.05, y: 1.85, z: dz, rz: -0.28 }), 'cloth', team);
  }

  // --- the bow: seven segments so the recurve is a curve, not a stick -------
  const bowX = -0.62;
  add(p, cyl(0.04, 0.04, 0.24, 8, { x: bowX, y: 1.03, z: 0.1 }), 'leather');
  add(p, cyl(0.035, 0.038, 0.28, 8, { x: bowX + 0.015, y: 1.28, z: 0.1, rz: -0.14 }), 'bark');
  add(p, cyl(0.031, 0.035, 0.28, 8, { x: bowX + 0.065, y: 1.53, z: 0.1, rz: -0.3 }), 'bark');
  add(p, cyl(0.027, 0.031, 0.24, 8, { x: bowX + 0.145, y: 1.74, z: 0.1, rz: -0.55 }), 'bark');
  add(p, cyl(0.038, 0.035, 0.28, 8, { x: bowX + 0.015, y: 0.78, z: 0.1, rz: 0.14 }), 'bark');
  add(p, cyl(0.035, 0.031, 0.28, 8, { x: bowX + 0.065, y: 0.53, z: 0.1, rz: 0.3 }), 'bark');
  add(p, cyl(0.031, 0.027, 0.24, 8, { x: bowX + 0.145, y: 0.32, z: 0.1, rz: 0.55 }), 'bark');
  add(p, sphere(0.035, 6, { x: bowX + 0.205, y: 1.84, z: 0.1 }), 'bronze');
  add(p, sphere(0.035, 6, { x: bowX + 0.205, y: 0.22, z: 0.1 }), 'bronze');
  // The string is deliberately 3 cm thick: thinner aliases into a crawling
  // dotted line at gameplay zoom (STYLE_BIBLE §7, last line).
  add(p, box(0.03, 1.62, 0.03, { x: bowX + 0.205, y: 1.03, z: 0.1 }), 'iron');
  add(p, cyl(0.022, 0.022, 0.55, 6, { x: bowX + 0.205, y: 1.03, z: 0.34, rx: Math.PI / 2 }), 'bark');
  add(p, cone(0.035, 0.1, 6, { x: bowX + 0.205, y: 1.03, z: 0.64, rx: Math.PI / 2 }), 'iron');

  // --- frost accents + half-cloak ---------------------------------------------
  add(p, ico(0.045, 0, { x: bowX - 0.05, y: 1.03, z: 0.1 }), 'crystal', accent);
  add(p, ico(0.04, 0, { x: 0.29, y: 1.53, z: -0.21 }), 'crystal', accent);
  add(p, ico(0.035, 0, { y: 1.01, z: 0.21 }), 'crystal', accent);
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
// (from above, a bar crossing the whole body at ~35 degrees, unique on the
// roster) and a trophy chain swinging off the chest harness.
//
// Palette: iron / bronze / gold / leather / team cloth / crystal(gold) /
// crystal(team) = 7 buckets. He is the only hero carrying real `gold`, which is
// also his accent — the treasure read STYLE_BIBLE §2 wants somewhere in frame.
// ============================================================================
function reaverParts(skin: TeamSkin, accentKey: string): Part[] {
  const p: Part[] = [];
  const team = skin.cloth;
  const accent = emissiveSurfaceTint(accentKey);
  const teamGlow = emissiveSurfaceTint(skin.glowKey);

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

  // --- trophy chain -----------------------------------------------------------
  for (let i = 0; i < 4; i++) {
    const x = -0.165 + i * 0.11;
    add(p, ring(0.055, 0.018, 8, { x, y: 1.42 - Math.abs(i - 1.5) * 0.04, z: 0.24, rx: 1.4 }), 'bronze');
  }
  for (const s of SIDES) {
    add(p, ico(0.07, 1, { x: s * 0.3, y: 1.34, z: 0.24 }), 'bronze');
  }

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
  add(p, box(0.19, 0.032, 0.03, { y: 1.755, z: 0.19 }), 'crystal', teamGlow);
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
  add(p, ico(0.05, 0, { x: -0.44, y: 1.62, z: 0.02 }), 'crystal', accent);
  add(p, ico(0.045, 0, { y: 1.02, z: 0.3 }), 'crystal', accent);
  for (const s of SIDES) {
    add(p, sphere(0.028, 6, { x: s * 0.13, y: 1.42, z: -0.27 }), 'bronze');
    add(p, sphere(0.028, 6, { x: s * 0.13, y: 1.16, z: -0.27 }), 'bronze');
  }
  return p;
}

// ============================================================================
// HEX — the Hollow Star. Mage, lithe, 1.85 m, accent `void`.
//
// Silhouette: THE outlier. No legs at all — a flared robe cone hovering 10 cm
// off the ground, which makes his plan view a filled CIRCLE where every other
// hero is a cross or a bar. Envelope-breakers: three concentric tilted orbit
// rings (0.46-0.68 m radius, well outside the body) and a five-spike crown with
// a halo. From directly above he is unmistakable and nobody else is close.
//
// Palette: iron / bronze / leather / night cloth / team cloth / crystal(void) /
// crystal(team) = 7 buckets.
// ============================================================================
function hexParts(skin: TeamSkin, accentKey: string): Part[] {
  const p: Part[] = [];
  const team = skin.cloth;
  const dark = CLOTH_NIGHT;
  const accent = emissiveSurfaceTint(accentKey);
  const teamGlow = emissiveSurfaceTint(skin.glowKey);

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
      { y: 0.12 },
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
  add(p, ring(0.5, 0.035, 20, { y: 0.13 }), 'cloth', team);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    add(
      p,
      cone(0.07, 0.2, 6, { x: Math.sin(a) * 0.45, y: 0.11, z: Math.cos(a) * 0.45, rx: Math.PI }),
      'cloth',
      dark,
    );
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 1.45;
    add(
      p,
      cone(0.05, 0.18, 6, { x: Math.sin(a) * 0.3, y: 0.09, z: Math.cos(a) * 0.3, rx: Math.PI }),
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
    add(p, box(0.045, 0.03, 0.03, { x: s * 0.05, y: 1.67, z: 0.14 }), 'crystal', teamGlow);
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
  add(p, ico(0.055, 0, { y: 1.96, z: 0.14 }), 'crystal', accent);
  add(p, ring(0.26, 0.022, 20, { y: 1.86, rx: 0.3 }), 'bronze');

  // --- the three orbit rings: envelope-breaker, and his whole plan read -----
  add(p, ring(0.56, 0.028, 24, { y: 1.15, rx: 0.42, rz: 0.12 }), 'bronze');
  add(p, ring(0.68, 0.024, 26, { y: 1.05, rx: -0.3, rz: -0.22 }), 'bronze');
  add(p, ring(0.46, 0.026, 22, { y: 1.3, rx: 0.75 }), 'bronze');

  // --- void core and rune shards ------------------------------------------------
  add(p, ico(0.13, 1, { y: 1.28, z: 0.22 }), 'crystal', accent);
  add(p, ico(0.05, 0, { x: 0.55, y: 1.28, z: 0.05 }), 'crystal', accent);
  add(p, ico(0.05, 0, { x: -0.5, y: 1.02, z: 0.24 }), 'crystal', accent);
  add(p, ico(0.045, 0, { x: 0.2, y: 0.9, z: -0.62 }), 'crystal', accent);
  add(p, ico(0.045, 0, { x: -0.24, y: 1.44, z: -0.4 }), 'crystal', accent);
  for (const s of SIDES) {
    add(p, ico(0.04, 0, { x: s * 0.14, y: 1.06, z: 0.13 }), 'crystal', accent);
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
// and the twin stoles hanging down the front.
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
  const accent = emissiveSurfaceTint(accentKey);
  const teamGlow = emissiveSurfaceTint(skin.glowKey);

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
  add(p, box(0.16, 0.6, 0.04, { y: 0.52, z: 0.27, rx: 0.05 }), 'cloth', team);
  for (const s of SIDES) {
    add(p, box(0.13, 0.52, 0.04, { x: s * 0.24, y: 0.54, z: 0.2, rx: 0.05, rz: s * 0.06 }), 'cloth', team);
  }

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

  // --- torso, mantle, stoles ---------------------------------------------------
  add(p, cyl(0.17, 0.2, 0.42, 12, { y: 1.26, sz: 0.8 }), 'cloth', dark);
  add(p, box(0.22, 0.3, 0.05, { y: 1.26, z: 0.16 }), 'cloth', team);
  for (const s of SIDES) {
    add(p, box(0.1, 0.62, 0.04, { x: s * 0.1, y: 1.14, z: 0.19, rx: 0.03 }), 'cloth', team);
  }
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
  add(p, ico(0.05, 0, { y: 1.56, z: 0.13 }), 'crystal', accent);

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
  add(p, box(0.11, 0.026, 0.03, { y: 1.645, z: 0.147 }), 'crystal', teamGlow);
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

  // --- the staff: envelope-breaker, carried well clear of the body ----------
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
  const accent = emissiveSurfaceTint(accentKey);
  const teamGlow = emissiveSurfaceTint(skin.glowKey);

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
    add(p, box(0.05, 0.026, 0.03, { x: s * 0.045, y: 1.46, z: 0.197 }), 'crystal', teamGlow);
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
    add(p, ico(0.045, 0, { x: s * 0.26, y: 1.28, z: -0.06 }), 'crystal', accent);
  }
  add(p, ico(0.04, 0, { y: 0.78, z: 0.17 }), 'crystal', accent);
  return p;
}

// ============================================================================
// Assembly
// ============================================================================

/**
 * The APAL hex behind an APAL key name, used as the `tint` on a crystal part.
 *
 * CONTRACT GAP this works around: `Part` carries only `{geo, surface, tint}`
 * and `bake()` resolves every bucket through `surface(id, tint)`, so there is
 * no way to put an `emissiveSurface()` material into a baked unit. Tinting the
 * crystal part is how a hero's accent core and its team lamps are kept in two
 * DIFFERENT buckets (bake keys on (surface, tint)); `buildHero` then re-points
 * those two buckets at the matching `emissiveSurface()` material. Mirroring the
 * key here is what keeps the two keyings in step, and the tint stays legal
 * because it is an APAL entry, never ad-hoc hex.
 *
 * Unknown keys fall back to the crystal family's own `ward` rather than throw:
 * a builder must never white-screen the game (GRAPHICS_CONTRACT §7.7).
 */
function emissiveSurfaceTint(colorKey: string): string {
  const hex = (APAL as unknown as Record<string, string>)[colorKey];
  return hex ?? APAL.ward;
}

/** One hero's animated carve-out: a single kit primitive, so it needs no merge,
 *  and `whiteVertexColors` because it never sees `bake()`. R_UNITS owns its
 *  material and its motion; this is geometry only. */
interface HeroAnim {
  readonly geo: THREE.BufferGeometry;
  readonly kind: 'orbit' | 'bob' | 'spin';
  readonly y: number;
}

/** Per-hero build metadata that is not derivable from the parts list. Heights
 *  are chosen against the HEAD, not against the tallest prop: a bar that clears
 *  BULLWARK's banner or MENDER's antlers would float half a metre off every
 *  hero and read as detached, so props are allowed to cross the bar exactly as
 *  they do in the game this is benchmarked against. */
interface HeroFit {
  readonly barH: number;
  readonly barW: number;
}

const HERO_FIT: Record<HeroId, HeroFit> = {
  bullwark: { barH: 2.52, barW: 1.32 },
  longbow: { barH: 2.08, barW: 1.08 },
  reaver: { barH: 2.36, barW: 1.2 },
  hex: { barH: 2.34, barW: 1.08 },
  mender: { barH: 2.1, barW: 1.2 },
  shade: { barH: 1.98, barW: 1.08 },
};

/**
 * The floating carve-out per hero, positioned clear of the body. `orbit` sweeps
 * a 0.55 m circle at `y` (R_UNITS' constant), which is wider than every hero's
 * arms — so every orbit here sits ABOVE the head or, for HEX, deliberately
 * inside his ring cage where the weave is the effect. `bob` and `spin` sit on
 * the unit's own axis and are therefore only legible above the headgear.
 */
function heroAnim(id: HeroId): HeroAnim {
  switch (id) {
    case 'bullwark':
      // A rally beacon riding high over the banner — the Rampart's ult, made
      // visible from across the map.
      return { geo: ico(0.14, 1), kind: 'bob', y: 2.7 };
    case 'longbow':
      return { geo: ico(0.11, 0, { sy: 1.6 }), kind: 'orbit', y: 2.02 };
    case 'reaver':
      return { geo: ring(0.2, 0.03, 16, { rx: Math.PI / 2 }), kind: 'spin', y: 2.48 };
    case 'hex':
      // Weaves through the three orbit rings rather than above them: the rings
      // ARE his silhouette and a mote threading them sells that they are real.
      return { geo: ico(0.13, 0, { sy: 1.8 }), kind: 'orbit', y: 1.35 };
    case 'mender':
      return { geo: sphere(0.13, 12), kind: 'bob', y: 2.35 };
    case 'shade':
      return { geo: ico(0.1, 0, { sy: 1.4 }), kind: 'orbit', y: 2.05 };
  }
}

function heroParts(id: HeroId, skin: TeamSkin, accentKey: string): Part[] {
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
  const def = heroById(id);
  const skin = teamSkin(team);
  const accentKey = def.visual.accent;
  const parts = heroParts(id, skin, accentKey);

  const baked = bake(parts);

  // ---- glow + bloom, in ONE pass over the baked buckets --------------------
  //
  // `bake()` has no emissive path: it resolves every bucket through
  // `surface(id, tint)`, and `surface('crystal', tint)` carries the family's
  // default PALE WARD emissive at intensity 2.2 — which at that strength swamps
  // the tint and renders every team crystal white. So the two crystal buckets
  // are re-pointed here, at build time, once, never per frame, at the
  // `emissiveSurface()` material of the same colour. No material is minted:
  // both come out of the kit's own factories and its cache. (Recorded as a
  // CONTRACT_GAP — see the note on `emissiveSurfaceTint`.)
  //
  // The re-point is applied to the MESH and to the returned `BakedPart` in the
  // same step, and `parts` is rebuilt rather than mutated: `BakedMesh.parts` is
  // readonly and a consumer reading a material out of it must see the material
  // that actually renders, not the one `bake()` happened to start with.
  //
  // Bloom is layer-masked, so only genuine light sources go on BLOOM_LAYER: the
  // two crystal glows, plus `gold`, which SURFACES documents as "marked into
  // BLOOM_LAYER by its builder" because the environment's sun disc is genuinely
  // bright in it. Armour and cloth must NOT be marked — bloom on everything is
  // the amateur tell STYLE_BIBLE §6 names by hand.
  const accentFlat = surface('crystal', emissiveSurfaceTint(accentKey));
  const teamFlat = surface('crystal', emissiveSurfaceTint(skin.glowKey));
  const accentGlow = emissiveSurface('crystal', accentKey, ACCENT_GLOW);
  const teamGlowMat = emissiveSurface('crystal', skin.glowKey, TEAM_GLOW);
  const goldMat = surface('gold');

  const buckets: BakedPart[] = [];
  for (const bucket of baked.parts) {
    const glow =
      bucket.material === accentFlat
        ? accentGlow
        : bucket.material === teamFlat
          ? teamGlowMat
          : null;
    const material = glow ?? bucket.material;
    const mesh = baked.group.children.find(
      (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.geometry === bucket.geo,
    );
    if (mesh !== undefined) {
      mesh.material = material;
      if (glow !== null || material === goldMat) markBloom(mesh);
    }
    buckets.push({ geo: bucket.geo, material });
  }
  const body: BakedMesh = { group: baked.group, parts: buckets };

  // The §7 part budget, stamped on the artifact so it can be checked against
  // the shipped geometry rather than against a comment that can drift.
  body.group.userData['riftPartCount'] = parts.length;
  body.group.name = `rift:hero:${id}`;

  const anim = heroAnim(id);
  const fit = HERO_FIT[id];
  return {
    body,
    // VERTEX-COLOUR LAW: this geometry never sees `bake()`, so it carries no
    // `color` attribute of its own and would render black without this.
    anim: whiteVertexColors(anim.geo),
    animKind: anim.kind,
    animY: anim.y,
    barH: fit.barH,
    barW: fit.barW,
  };
}
