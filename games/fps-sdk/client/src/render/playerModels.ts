// ============================================================================
// C4 — soldier models + animation. One blocky humanoid per remote player,
// driven by interpolated PlayerSnaps.
//
// DENSITY: 58 body prims + 2 flash quads + 1 contact-shadow disc.
// VISUAL_UPGRADE.md §3c raises the soldier budget to 45-60 and §10 makes that
// supersede CONTRACT.md's old 22-32 / "<= 28" figure. 58 is deliberate: every
// limb carries a value break, and the gear that used to be painted on in one
// flat tone is now real geometry.
//
// FOUR-TONE TEAM SCRIPT (VISUAL_UPGRADE.md §1 value ladder, applied to the
// character instead of a wall). Every tone is a named PALETTE team tier, so
// the side reads at 30m in sun AND in shade, and the value ladder reads at 3m:
//   - PALE   (helmet shell)                    CT `ctPale` / T `tPale`
//     the brightest thing on the model: the long-range silhouette read.
//   - LIT    (helmet brim, shoulder patches,    CT `ctLit`  / T `tLit`
//            upper-arm stripes)
//     the saturated team hue, placed on the shoulders and head where a player
//     sees an enemy first. This is the "team colours pop harder" lever.
//   - BASE   (chest, shins, forearms)           CT `ctBlue` / T `tAmber`
//     the high-chroma uniform body, shade-lifted (emissive = team DARK) so the
//     silhouette never dies against same-hue walls, without washing out in sun.
//   - DARK   (waist, shoulder pads, thighs,     CT `ctDark` / T `tDark`
//            upper arms, ankle cuffs)
//     THE LIMB VALUE BREAK §3c demands: thigh in the Dark tier against a shin
//     in the base tier, upper arm Dark against forearm base. No limb is one
//     flat colour any more.
//
// ALL EIGHT TONES ARE NOW REAL TEAM TIERS. They used to borrow from elsewhere:
// PALE was `ice` (a snow MatId — invisible against Frostbite's walls, 13 L* and
// 13 deg from `snow`) and `muzzle`, BASE-T was `fire` (an explosion colour, 14.5
// L* / 25.8 deg from Dustbowl's sand), DARK-T was `tBrown` (also the world's
// sandbag brown, so it could never be retuned without repainting the props).
// Every one of those borrowings pinned a tone to a colour chosen for a different
// job. The palette's §1 L6 law is stated on the team tiers, so the model reads
// team tiers — and `valueLadder.test.ts` proves all four CT and all four T tones
// clear every map's ground and reference wall.
//
// GEAR LADDER — team-independent webbing/armour, resolved from the FROZEN
// ladder tables (`MAT_COLORS` / `CONTACT_MAT` / `TRIM_MAT` keyed on `metalDark`)
// rather than eyeballed, and null-safe at the ends of the ladder:
//   GEAR (metalDark) rig, pouches, pads, boot uppers, helmet band
//   GEAR_DEEP (metalDeep, the CONTACT_MAT partner) straps, pouch flaps, boot
//     SOLES (§3c: "boots get a sole in a Deep tier"), gloves, knee lips
//   GEAR_LIT (metal/steel, the TRIM_MAT partner) belt buckle
// plus `ink` visor and `skin` head.
//
// The contact-shadow disc is the frozen `contactShadow()` helper: PALETTE.ink
// at the 0.6 opacity whose composite is verified against every map ground in
// visual.ts (§1 L2b). It was 0.5 before this pass — darkening it is the fix.
//
// Invariants:
// - root group sits at FEET with yaw; `body` child carries crouch offset +
//   death tilt so the two never fight over one Euler.
// - `aim` group at shoulder height carries BOTH arms + the weapon and pitches
//   with snap.pitch (±0.6 clamp); the head group follows at 0.5× so aim
//   direction reads through the head too.
// - HIT FLINCH: an hp drop between sync() calls kicks a 100ms backward-pitch
//   impulse on the torso group that decays linearly (small jolt).
// - meshes come only from contract factories; nameplate sprite is the
//   sanctioned CanvasTexture exception (colors still PALETTE-derived).
// - limb/weapon pivots stay unbaked (animated); nothing allocates per frame —
//   models, pivots, flash quads are all reused, scalars only in sync().
// - factory geometries/materials are shared caches: on removal dispose ONLY
//   nameplate textures/materials, never geometries.
// - `makeWeaponModel` is F10's (seam rule 3); this file owns only the mount.
// ============================================================================
import * as THREE from 'three';
import {
  CONTACT_MAT,
  MAT_COLORS,
  PALETTE,
  TRIM_MAT,
  type PlayerId,
  type PlayerSnap,
  type Team,
  type WeaponId,
} from '@fps/shared';
import { at, box, contactShadow, mat } from '../contract/visual.js';
import { makeWeaponModel } from './viewModel.js';

// ---- frozen animation tuning (from CONTRACT.md / C4 spec) -------------------
const WALK_SWING_RAD = (25 * Math.PI) / 180; // thigh swing amplitude
const KNEE_SWING = 0.5; // shins counter-swing at a fraction of the thigh
const ARM_SWING = 0.35; // subtle arm counter-swing (hands stay on the weapon)
const PHASE_RATE = 2.2; // walk phase advance per (m/s * s)
const PITCH_CLAMP = 0.6; // rad, applied to the whole arms+weapon aim group
const HEAD_PITCH_FOLLOW = 0.5; // head tracks aim pitch at half rate
const FLINCH_S = 0.1; // hit flinch impulse duration
const FLINCH_RAD = 0.14; // peak backward torso pitch on a hit
const BREATHE_HZ = 2;
const BREATHE_AMP = 0.02; // torso scaleY ±
const CROUCH_THIGH_RAD = 1.3; // thigh rotates forward into a squat
const CROUCH_KNEE_RAD = -1.15; // shin folds back, foot stays planted
const CROUCH_DROP = 0.35; // body y offset (contract: torso -0.35u)
const DEATH_FALL_S = 0.4; // rotate to lying
const DEATH_SINK_AT = 2; // sink starts
const DEATH_SINK_S = 1; // 1u over this long
const DEATH_KEEP_S = 3; // corpse hidden after this
const MUZZLE_FLASH_S = 0.05;
const WEAPON_SCALE = 0.9;

// two-hand weapon hold: upper arms rotated forward, forearms folded at the
// elbow — right hand ends at the grip, left hand up under the forend
const ARM_BASE_R = 1.15;
const ELBOW_R = 0.55;
const ARM_BASE_L = 0.95;
const ELBOW_L = 0.45;

// ---- geometry layout (units, total height ~1.8u) ----------------------------
const HIP_Y = 0.85;
const THIGH_H = 0.45;
const SHIN_H = 0.4; // thigh + shin = leg length to the ground
const SHOULDER_Y = 1.42;
const SHOULDER_X = 0.34; // just outside the wider chest box (broad shoulders)
const UPPER_ARM_H = 0.3;
const FOREARM_H = 0.28;
const HEAD_Y = 1.58;
const HELMET_Y = 1.69;
const NAMEPLATE_Y = 2.1; // ~0.35u above the head
const MUZZLE_TIP_Z = -0.55; // gun tip inside weapon-holder space
const CONTACT_R = 0.34; // contact-shadow disc radius
const CONTACT_STRETCH = 1.3; // disc is an ellipse, longer along the facing axis

// ---- four-tone team script (VISUAL_UPGRADE.md §3c) --------------------------
/** Brightest tone: helmet shell. Carries the silhouette at long range. */
function teamPaleHex(team: Team): string {
  return team === 'CT' ? PALETTE.ctPale : PALETTE.tPale;
}
/** Saturated team hue: helmet brim, shoulder patch, upper-arm stripe. */
function teamLitHex(team: Team): string {
  return team === 'CT' ? PALETTE.ctLit : PALETTE.tLit;
}
/** Uniform body: chest, shins, forearms. Shade-lifted by the DARK emissive. */
function teamBaseHex(team: Team): string {
  return team === 'CT' ? PALETTE.ctBlue : PALETTE.tAmber;
}
/** The limb value break: waist, shoulder pads, thighs, upper arms, cuffs. */
function teamDarkHex(team: Team): string {
  return team === 'CT' ? PALETTE.ctDark : PALETTE.tDark;
}

// ---- gear ladder, resolved from the frozen partner tables -------------------
// Keyed on the `metalDark` MatId. CONTACT_MAT / TRIM_MAT are nullable at the
// ends of a ladder (§1 L2a/L3) — fall back to the body tone rather than emit a
// zero-contrast piece. `metalDark` sits mid-ladder, so both resolve.
const GEAR_ID = 'metalDark' as const;
const GEAR = MAT_COLORS[GEAR_ID];
const GEAR_DEEP_ID = CONTACT_MAT[GEAR_ID];
const GEAR_DEEP = GEAR_DEEP_ID ? MAT_COLORS[GEAR_DEEP_ID] : GEAR;
const GEAR_LIT_ID = TRIM_MAT[GEAR_ID];
const GEAR_LIT = GEAR_LIT_ID ? MAT_COLORS[GEAR_LIT_ID] : GEAR;

// ---- nameplate (CanvasTexture sprite — contract exception) -------------------
function hexRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** team-color-tinted ink strip, as `rgb()` css; both inputs from PALETTE. */
function tintCss(inkHex: string, teamHex: string): string {
  const [ir, ig, ib] = hexRgb(inkHex);
  const [tr, tg, tb] = hexRgb(teamHex);
  const m = (a: number, b: number): number => Math.round(a * 0.45 + b * 0.55);
  return `rgb(${m(ir, tr)},${m(ig, tg)},${m(ib, tb)})`;
}

function drawNameplate(canvas: HTMLCanvasElement, name: string, team: Team): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return; // canvas unsupported: sprite keeps a blank texture, model still works
  const teamHex = teamBaseHex(team);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // translucent team-tinted ink strip + solid team accent bar (never color alone:
  // white text carries the name, bar carries the team)
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = tintCss(PALETTE.ink, teamHex);
  ctx.fillRect(0, 8, canvas.width, 48);
  ctx.globalAlpha = 1;
  ctx.fillStyle = teamHex;
  ctx.fillRect(0, 50, canvas.width, 6);
  ctx.fillStyle = PALETTE.hudText;
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name.trim().slice(0, 14) || '?', canvas.width / 2, 33);
}

function makeNameplate(name: string, team: Team): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  drawNameplate(canvas, name, team);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(1.4, 0.35, 1);
  return sprite;
}

function disposeNameplate(sprite: THREE.Sprite): void {
  const material = sprite.material;
  if (material.map) material.map.dispose();
  material.dispose();
}

// ---- per-player model --------------------------------------------------------
interface Soldier {
  root: THREE.Group; // feet anchor: position + yaw (+ corpse sink)
  body: THREE.Group; // crouch drop + death tilt
  torsoGroup: THREE.Group; // waist+chest+rig+pack; origin at hip so breathe scales upward
  paleMeshes: THREE.Mesh[]; // helmet shell — long-range read (retinted on side swap)
  litMeshes: THREE.Mesh[]; // saturated team hue: brim, shoulder patches, arm stripes
  baseMeshes: THREE.Mesh[]; // rim-lit uniform body: chest, shins, forearms
  darkMeshes: THREE.Mesh[]; // the limb value break: waist, pads, thighs, upper arms
  thighL: THREE.Group; // hip pivots
  thighR: THREE.Group;
  shinL: THREE.Group; // knee pivots (children of the thighs)
  shinR: THREE.Group;
  armL: THREE.Group; // shoulder pivots (elbows hold a fixed two-hand pose)
  armR: THREE.Group;
  aim: THREE.Group; // arms + weapon; pitches with snap.pitch
  headGroup: THREE.Group; // head+helmet kit+visor; follows pitch at 0.5×
  weaponHolder: THREE.Group; // at the right hand; counter-rotated so pitch reads clean
  weaponMesh: THREE.Group;
  weapon: WeaponId;
  nameplate: THREE.Sprite;
  muzzleGroup: THREE.Group;
  team: Team;
  name: string;
  // animation state (scalars only)
  walkPhase: number;
  swingAmp: number; // eased 0..1 walk-vs-idle blend
  breathe: number;
  crouchAmt: number;
  dead: boolean;
  deathT: number;
  flashT: number;
  flashRoll: number; // deterministic roll steps, no Math.random
  lastHp: number; // hp at previous sync; a drop triggers the flinch
  flinchT: number; // remaining flinch impulse time (0 = idle)
  lastX: number;
  lastZ: number;
  seen: number; // frame stamp for mark-and-sweep removal
}

export class PlayerModels {
  private readonly scene: THREE.Scene;
  private readonly models = new Map<PlayerId, Soldier>();
  private frame = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  private create(p: PlayerSnap & { team: Team; name: string }): Soldier {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    const pale = teamPaleHex(p.team);
    const lit = teamLitHex(p.team);
    const base = teamBaseHex(p.team);
    const dark = teamDarkHex(p.team);
    // rim pop without shader patches or shell prims: the DARK team tone as
    // the base uniform's emissive — a shade-floor lift that keeps the
    // silhouette off same-hue walls without washing the body out in full sun.
    // NOT applied to the DARK meshes themselves: self-emitting them would lift
    // them back up to the base tier and erase the limb value break.
    const rim = { emissive: dark };

    // contact shadow: the frozen PALETTE.ink helper at the L2b-verified 0.6
    // opacity (was a hand-rolled 0.5 cylinder). rotation.x = -PI/2 means the
    // disc's local +Y runs along world Z, so scale.y stretches it along the
    // facing axis of the (yawed) root.
    const blob = contactShadow(CONTACT_R);
    blob.scale.y = CONTACT_STRETCH;
    root.add(blob);

    // ---- TORSO (20 prims) ---------------------------------------------------
    // tapered torso: DARK waist, deep belt band, BASE chest. The chest rig is
    // real geometry now — plate + seam, 3 discrete pouches with Deep flaps,
    // 2 shoulder straps, a pack with a Deep lid.
    const torsoGroup = at(new THREE.Group(), 0, HIP_Y, 0);
    const waist = at(box(0.42, 0.26, 0.26, dark), 0, 0.13, 0);
    const belt = at(box(0.44, 0.075, 0.28, GEAR_DEEP), 0, 0.285, 0);
    const buckle = at(box(0.09, 0.06, 0.035, GEAR_LIT), 0, 0.285, -0.15);
    const chestMesh = at(box(0.56, 0.34, 0.3, base, rim), 0, 0.47, 0);
    const rig = at(box(0.44, 0.3, 0.08, GEAR), 0, 0.46, -0.17);
    const rigSeam = at(box(0.45, 0.04, 0.1, GEAR_DEEP), 0, 0.53, -0.175);
    const pouchL = at(box(0.11, 0.13, 0.075, GEAR), -0.145, 0.39, -0.243);
    const pouchC = at(box(0.12, 0.11, 0.075, GEAR), 0, 0.355, -0.243);
    const pouchR = at(box(0.11, 0.13, 0.075, GEAR), 0.145, 0.39, -0.243);
    const flapL = at(box(0.118, 0.032, 0.085, GEAR_DEEP), -0.145, 0.462, -0.246);
    const flapC = at(box(0.128, 0.032, 0.085, GEAR_DEEP), 0, 0.417, -0.246);
    const flapR = at(box(0.118, 0.032, 0.085, GEAR_DEEP), 0.145, 0.462, -0.246);
    const strapL = at(box(0.08, 0.065, 0.46, GEAR_DEEP), -0.155, 0.655, 0); // over the shoulder
    const strapR = at(box(0.08, 0.065, 0.46, GEAR_DEEP), 0.155, 0.655, 0);
    const backpack = at(box(0.36, 0.34, 0.13, GEAR), 0, 0.44, 0.215);
    const packLid = at(box(0.375, 0.075, 0.145, GEAR_DEEP), 0, 0.625, 0.215);
    const padL = at(box(0.2, 0.1, 0.26, dark), -SHOULDER_X, 0.62, 0);
    const padR = at(box(0.2, 0.1, 0.26, dark), SHOULDER_X, 0.62, 0);
    const patchL = at(box(0.21, 0.04, 0.27, lit), -SHOULDER_X, 0.665, 0); // team patch
    const patchR = at(box(0.21, 0.04, 0.27, lit), SHOULDER_X, 0.665, 0);
    torsoGroup.add(
      waist, belt, buckle, chestMesh, rig, rigSeam,
      pouchL, pouchC, pouchR, flapL, flapC, flapR,
      strapL, strapR, backpack, packLid, padL, padR, patchL, patchR,
    );

    // ---- HEAD (10 prims) ----------------------------------------------------
    // head group pitches with aim at 0.5×. PALE helmet shell with a GEAR band,
    // a LIT front brim, a rear counterweight, two chin straps + a chin cup,
    // a nape flap and an ink visor.
    const headGroup = at(new THREE.Group(), 0, HEAD_Y, 0);
    const head = at(box(0.26, 0.26, 0.26, PALETTE.skin), 0, 0, 0);
    const helmet = at(box(0.3, 0.15, 0.3, pale), 0, HELMET_Y - HEAD_Y, 0);
    const helmetBand = at(box(0.315, 0.045, 0.315, GEAR), 0, 0.05, 0);
    const brim = at(box(0.32, 0.05, 0.11, lit), 0, 0.062, -0.185);
    const counterweight = at(box(0.15, 0.1, 0.1, GEAR), 0, 0.085, 0.185);
    const chinStrapL = at(box(0.035, 0.2, 0.04, GEAR_DEEP), -0.128, -0.02, -0.09);
    const chinStrapR = at(box(0.035, 0.2, 0.04, GEAR_DEEP), 0.128, -0.02, -0.09);
    const chinCup = at(box(0.145, 0.05, 0.07, GEAR_DEEP), 0, -0.125, -0.1);
    const napeCover = at(box(0.26, 0.12, 0.045, GEAR), 0, -0.07, 0.15);
    const visor = at(box(0.28, 0.055, 0.03, PALETTE.ink), 0, 0.02, -0.145);
    headGroup.add(
      head, helmet, helmetBand, brim, counterweight,
      chinStrapL, chinStrapR, chinCup, napeCover, visor,
    );
    body.add(torsoGroup, headGroup);

    // ---- LEGS (16 prims) ----------------------------------------------------
    // two-segment legs: thigh pivot at the hip, shin pivot at the knee (child
    // of the thigh so the whole leg swings together). VALUE BREAK: DARK thigh
    // over a BASE shin, with a Deep cuff at the knee seam. Knee pad + Deep lip,
    // DARK trouser cuff over a GEAR boot upper on a GEAR_DEEP sole.
    const thighL = at(new THREE.Group(), -0.12, HIP_Y, 0);
    const thighR = at(new THREE.Group(), 0.12, HIP_Y, 0);
    const thighLMesh = at(box(0.17, THIGH_H, 0.19, dark), 0, -THIGH_H / 2, 0);
    const thighRMesh = at(box(0.17, THIGH_H, 0.19, dark), 0, -THIGH_H / 2, 0);
    const thighCuffL = at(box(0.178, 0.055, 0.198, GEAR_DEEP), 0, -THIGH_H + 0.025, 0);
    const thighCuffR = at(box(0.178, 0.055, 0.198, GEAR_DEEP), 0, -THIGH_H + 0.025, 0);
    const shinL = at(new THREE.Group(), 0, -THIGH_H, 0);
    const shinR = at(new THREE.Group(), 0, -THIGH_H, 0);
    const shinLMesh = at(box(0.14, SHIN_H, 0.16, base, rim), 0, -SHIN_H / 2, 0);
    const shinRMesh = at(box(0.14, SHIN_H, 0.16, base, rim), 0, -SHIN_H / 2, 0);
    const kneePadL = at(box(0.16, 0.13, 0.06, GEAR), 0, -0.05, -0.1);
    const kneePadR = at(box(0.16, 0.13, 0.06, GEAR), 0, -0.05, -0.1);
    const kneeLipL = at(box(0.165, 0.035, 0.075, GEAR_DEEP), 0, -0.125, -0.1);
    const kneeLipR = at(box(0.165, 0.035, 0.075, GEAR_DEEP), 0, -0.125, -0.1);
    const ankleCuffL = at(box(0.155, 0.06, 0.18, dark), 0, -0.245, -0.01);
    const ankleCuffR = at(box(0.155, 0.06, 0.18, dark), 0, -0.245, -0.01);
    const bootL = at(box(0.16, 0.115, 0.25, GEAR), 0, -SHIN_H + 0.0825, -0.03);
    const bootR = at(box(0.16, 0.115, 0.25, GEAR), 0, -SHIN_H + 0.0825, -0.03);
    const soleL = at(box(0.17, 0.05, 0.28, GEAR_DEEP), 0, -SHIN_H + 0.025, -0.035);
    const soleR = at(box(0.17, 0.05, 0.28, GEAR_DEEP), 0, -SHIN_H + 0.025, -0.035);
    shinL.add(shinLMesh, kneePadL, kneeLipL, ankleCuffL, bootL, soleL);
    shinR.add(shinRMesh, kneePadR, kneeLipR, ankleCuffR, bootR, soleR);
    thighL.add(thighLMesh, thighCuffL, shinL);
    thighR.add(thighRMesh, thighCuffR, shinR);
    body.add(thighL, thighR);

    // aim group: both arms + weapon pitch together with the player's pitch
    const aim = at(new THREE.Group(), 0, SHOULDER_Y, 0);

    // ---- ARMS (12 prims) ----------------------------------------------------
    // two-segment arms posed into the two-handed hold. VALUE BREAK: DARK upper
    // arm (wearing a LIT team stripe) over a BASE forearm, GEAR elbow pad and
    // wrist cuff, GEAR_DEEP glove on the grip.
    const armL = at(new THREE.Group(), -SHOULDER_X, 0, 0);
    const armR = at(new THREE.Group(), SHOULDER_X, 0, 0);
    const upperLMesh = at(box(0.12, UPPER_ARM_H, 0.14, dark), 0, -UPPER_ARM_H / 2, 0);
    const upperRMesh = at(box(0.12, UPPER_ARM_H, 0.14, dark), 0, -UPPER_ARM_H / 2, 0);
    const stripeL = at(box(0.128, 0.045, 0.148, lit), 0, -0.085, 0);
    const stripeR = at(box(0.128, 0.045, 0.148, lit), 0, -0.085, 0);
    const elbowL = at(new THREE.Group(), 0, -UPPER_ARM_H, 0);
    const elbowR = at(new THREE.Group(), 0, -UPPER_ARM_H, 0);
    const foreLMesh = at(box(0.11, FOREARM_H, 0.12, base, rim), 0, -FOREARM_H / 2, 0);
    const foreRMesh = at(box(0.11, FOREARM_H, 0.12, base, rim), 0, -FOREARM_H / 2, 0);
    const elbowPadL = at(box(0.12, 0.11, 0.06, GEAR), 0, -0.02, 0.075);
    const elbowPadR = at(box(0.12, 0.11, 0.06, GEAR), 0, -0.02, 0.075);
    const cuffL = at(box(0.118, 0.045, 0.128, GEAR), 0, -FOREARM_H + 0.065, 0);
    const cuffR = at(box(0.118, 0.045, 0.128, GEAR), 0, -FOREARM_H + 0.065, 0);
    const gloveL = at(box(0.115, 0.1, 0.135, GEAR_DEEP), 0, -FOREARM_H - 0.01, -0.01);
    const gloveR = at(box(0.115, 0.1, 0.135, GEAR_DEEP), 0, -FOREARM_H - 0.01, -0.01);
    elbowL.add(foreLMesh, elbowPadL, cuffL, gloveL);
    elbowR.add(foreRMesh, elbowPadR, cuffR, gloveR);
    armL.add(upperLMesh, stripeL, elbowL);
    armR.add(upperRMesh, stripeR, elbowR);
    armL.rotation.x = ARM_BASE_L;
    armL.rotation.z = 0.3; // reaches in toward the forend
    elbowL.rotation.x = ELBOW_L;
    armR.rotation.x = ARM_BASE_R;
    armR.rotation.z = -0.08;
    elbowR.rotation.x = ELBOW_R;
    aim.add(armL, armR);
    body.add(aim);

    // weapon rides the right hand (grip); holder undoes the static arm pose so
    // the weapon sits level and only the aim group's pitch tilts it.
    // Geometry is F10's (seam rule 3) — this file owns the mount only.
    const weaponHolder = at(new THREE.Group(), 0, -FOREARM_H + 0.04, 0);
    weaponHolder.rotation.x = -(ARM_BASE_R + ELBOW_R);
    const weaponMesh = makeWeaponModel(p.weapon);
    weaponMesh.scale.setScalar(WEAPON_SCALE);
    weaponMesh.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    weaponHolder.add(weaponMesh);
    elbowR.add(weaponHolder);

    // muzzle flash: 2 crossed emissive quads (thin boxes stay factory-legal),
    // pre-built hidden and toggled — no allocation on fire
    const muzzleGroup = at(new THREE.Group(), 0, 0.05, MUZZLE_TIP_Z);
    const flashMat = { emissive: PALETTE.muzzle };
    muzzleGroup.add(box(0.02, 0.3, 0.34, PALETTE.muzzle, flashMat));
    muzzleGroup.add(box(0.3, 0.02, 0.34, PALETTE.muzzle, flashMat));
    muzzleGroup.visible = false;
    weaponHolder.add(muzzleGroup);

    const nameplate = at(makeNameplate(p.name, p.team), 0, NAMEPLATE_Y, 0);
    body.add(nameplate);

    // four-tone team script — retinted on side swap
    const paleMeshes = [helmet];
    const litMeshes = [brim, patchL, patchR, stripeL, stripeR];
    const baseMeshes = [chestMesh, shinLMesh, shinRMesh, foreLMesh, foreRMesh];
    const darkMeshes = [
      waist,
      padL,
      padR,
      thighLMesh,
      thighRMesh,
      ankleCuffL,
      ankleCuffR,
      upperLMesh,
      upperRMesh,
    ];
    const gearMeshes = [
      belt, buckle, rig, rigSeam, pouchL, pouchC, pouchR, flapL, flapC, flapR,
      strapL, strapR, backpack, packLid,
      helmetBand, counterweight, chinStrapL, chinStrapR, chinCup, napeCover,
      thighCuffL, thighCuffR, kneePadL, kneePadR, kneeLipL, kneeLipR,
      bootL, bootR, soleL, soleR,
      elbowPadL, elbowPadR, cuffL, cuffR, gloveL, gloveR,
    ];
    for (const mesh of [
      ...paleMeshes, ...litMeshes, ...baseMeshes, ...darkMeshes, ...gearMeshes,
      head, visor,
    ]) {
      mesh.castShadow = true;
    }

    root.position.set(p.x, p.y, p.z);
    root.rotation.y = p.yaw;
    this.scene.add(root);

    return {
      root,
      body,
      torsoGroup,
      paleMeshes,
      litMeshes,
      baseMeshes,
      darkMeshes,
      thighL,
      thighR,
      shinL,
      shinR,
      armL,
      armR,
      aim,
      headGroup,
      weaponHolder,
      weaponMesh,
      weapon: p.weapon,
      nameplate,
      muzzleGroup,
      team: p.team,
      name: p.name,
      walkPhase: 0,
      swingAmp: 0,
      breathe: 0,
      crouchAmt: p.crouch ? 1 : 0,
      dead: false,
      deathT: 0,
      flashT: 0,
      flashRoll: 0,
      lastHp: p.hp,
      flinchT: 0,
      lastX: p.x,
      lastZ: p.z,
      seen: 0,
    };
  }

  private remove(m: Soldier): void {
    this.scene.remove(m.root);
    disposeNameplate(m.nameplate); // factory geoms/materials are shared caches — never disposed
  }

  /** halftime side swap (or roster fixup): retint body + redraw the plate. */
  private retint(m: Soldier, team: Team, name: string): void {
    const dark = teamDarkHex(team);
    const paleMat = mat(teamPaleHex(team));
    const litMat = mat(teamLitHex(team));
    const baseMat = mat(teamBaseHex(team), { emissive: dark }); // same rim cache as create()
    const darkMat = mat(dark);
    for (const mesh of m.paleMeshes) mesh.material = paleMat;
    for (const mesh of m.litMeshes) mesh.material = litMat;
    for (const mesh of m.baseMeshes) mesh.material = baseMat;
    for (const mesh of m.darkMeshes) mesh.material = darkMat;
    disposeNameplate(m.nameplate);
    m.body.remove(m.nameplate);
    m.nameplate = at(makeNameplate(name, team), 0, NAMEPLATE_Y, 0);
    m.body.add(m.nameplate);
    m.team = team;
    m.name = name;
  }

  sync(players: Array<PlayerSnap & { team: Team; name: string }>, localId: PlayerId, dt: number): void {
    this.frame += 1;
    for (const p of players) {
      let m = this.models.get(p.id);
      if (!m) {
        m = this.create(p);
        this.models.set(p.id, m);
      }
      m.seen = this.frame;

      if (p.team !== m.team || p.name !== m.name) this.retint(m, p.team, p.name);

      // weapon swap: rebuild only that sub-group
      if (p.weapon !== m.weapon) {
        m.weaponHolder.remove(m.weaponMesh);
        m.weaponMesh = makeWeaponModel(p.weapon);
        m.weaponMesh.scale.setScalar(WEAPON_SCALE);
        m.weaponMesh.traverse((o) => {
          if (o instanceof THREE.Mesh) o.castShadow = true;
        });
        m.weaponHolder.add(m.weaponMesh);
        m.weapon = p.weapon;
      }

      // hit flinch: an hp drop between syncs kicks the torso impulse (alive only —
      // a lethal drop plays the death anim instead)
      if (p.alive && p.hp < m.lastHp) m.flinchT = FLINCH_S;
      m.lastHp = p.hp;

      // root: feet position + yaw
      m.root.position.set(p.x, p.y, p.z);
      m.root.rotation.y = p.yaw;

      // horizontal speed from interpolated positions (snapshots arrive pre-smoothed)
      const dx = p.x - m.lastX;
      const dz = p.z - m.lastZ;
      m.lastX = p.x;
      m.lastZ = p.z;
      const speed = dt > 0 ? Math.min(Math.hypot(dx, dz) / dt, 12) : 0;

      // muzzle flash decay (runs dead or alive so a dying shot never sticks on)
      if (m.flashT > 0) {
        m.flashT -= dt;
        if (m.flashT <= 0) m.muzzleGroup.visible = false;
      }

      if (!p.alive) {
        // ---- death: fall over 0.4s, sink 1u after 2s, gone at 3s ----
        if (!m.dead) {
          m.dead = true;
          m.deathT = 0;
        }
        m.deathT += dt;
        const fall = Math.min(m.deathT / DEATH_FALL_S, 1);
        const ease = 1 - (1 - fall) * (1 - fall);
        m.body.rotation.x = (-Math.PI / 2) * ease;
        const sink = Math.min(Math.max((m.deathT - DEATH_SINK_AT) / DEATH_SINK_S, 0), 1);
        m.root.position.y = p.y - sink;
        m.thighL.rotation.x = 0;
        m.thighR.rotation.x = 0;
        m.shinL.rotation.x = 0;
        m.shinR.rotation.x = 0;
        m.armL.rotation.x = ARM_BASE_L;
        m.armR.rotation.x = ARM_BASE_R;
        m.aim.rotation.x = 0;
        m.headGroup.rotation.x = 0;
        m.torsoGroup.rotation.x = 0;
        m.flinchT = 0;
        m.root.visible = p.id !== localId && m.deathT < DEATH_KEEP_S;
        continue;
      }
      if (m.dead) {
        m.dead = false; // respawned: stand back up
        m.body.rotation.x = 0;
      }
      m.root.visible = p.id !== localId;

      // ---- crouch ease (used by both the squat bend and the body drop) ----
      m.crouchAmt += ((p.crouch ? 1 : 0) - m.crouchAmt) * Math.min(1, dt * 12);

      // ---- walk swing eased against idle breathe ----
      m.swingAmp += ((p.moving ? 1 : 0) - m.swingAmp) * Math.min(1, dt * 10);
      if (p.moving) m.walkPhase += speed * dt * PHASE_RATE;
      m.breathe += dt * Math.PI * 2 * BREATHE_HZ;
      const swing = Math.sin(m.walkPhase) * WALK_SWING_RAD * m.swingAmp;
      // thighs counter-swing, shins counter-swing against their thigh (knee
      // articulation); crouch folds both into a squat on top of the swing
      m.thighL.rotation.x = swing + m.crouchAmt * CROUCH_THIGH_RAD;
      m.thighR.rotation.x = -swing + m.crouchAmt * CROUCH_THIGH_RAD;
      m.shinL.rotation.x = -swing * KNEE_SWING + m.crouchAmt * CROUCH_KNEE_RAD;
      m.shinR.rotation.x = swing * KNEE_SWING + m.crouchAmt * CROUCH_KNEE_RAD;
      m.armL.rotation.x = ARM_BASE_L - swing * ARM_SWING; // arms counter-swing their leg, subtly
      m.armR.rotation.x = ARM_BASE_R + swing * ARM_SWING;
      // AIM POSE: whole arms+weapon group pitches so the aim direction reads,
      // and the head follows at half rate so it reads through the head too
      const pitchC = Math.max(-PITCH_CLAMP, Math.min(PITCH_CLAMP, p.pitch));
      m.aim.rotation.x = pitchC;
      m.headGroup.rotation.x = pitchC * HEAD_PITCH_FOLLOW;
      m.torsoGroup.scale.y = 1 + BREATHE_AMP * Math.sin(m.breathe) * (1 - m.swingAmp);

      // hit flinch decay: backward torso pitch, linear falloff over 100ms
      if (m.flinchT > 0) {
        m.flinchT = Math.max(0, m.flinchT - dt);
        m.torsoGroup.rotation.x = FLINCH_RAD * (m.flinchT / FLINCH_S);
      } else {
        m.torsoGroup.rotation.x = 0;
      }

      // ---- crouch: legs bend (thigh forward, shin down), torso -0.35u ----
      m.body.position.y = -CROUCH_DROP * m.crouchAmt;
    }

    // sweep models whose ids left the snapshot
    for (const [id, m] of this.models) {
      if (m.seen !== this.frame) {
        this.remove(m);
        this.models.delete(id);
      }
    }
  }

  muzzle(id: PlayerId): void {
    const m = this.models.get(id);
    if (!m) return;
    m.flashT = MUZZLE_FLASH_S;
    m.flashRoll += 1;
    m.muzzleGroup.rotation.z = (m.flashRoll % 8) * (Math.PI / 4); // vary the cross roll deterministically
    m.muzzleGroup.visible = true;
  }

  clear(): void {
    for (const m of this.models.values()) this.remove(m);
    this.models.clear();
  }
}
