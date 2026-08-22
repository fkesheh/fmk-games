// ============================================================================
// ACES — C_FX/planes: vector airframes ×3 classes ×2 liveries + supply crates.
//
// Everything here draws in WORLD UNITS — ctx arrives already camera-
// transformed by C_APP (seams.ts footer), so this module never touches
// zoom/pan/DPR.
//
// Art law implemented here (STYLE_BIBLE):
//   §2  flat ink on paper: at most ONE highlight + ONE shadow tone per
//       material, both derived via shadeA from APAL endpoints. Aircraft carry
//       the hairline INK_STROKE outline so they sit ON the world; the terrain
//       beneath them carries none.
//   §3  one low sun fixed at screen-WEST. Every part is painted as a STATIC
//       two-tone fill pair: the half of the part leaning west takes the
//       highlight tone, the other half the shadow tone. "Static" is the
//       recipe's point — cheap, consistent, poster-flat. No dynamic lights.
//   §5  silhouettes must read in PURE BLACK across CAMERA.ZOOM_MIN..MAX.
//       Part budgets below count LOGICAL SHAPES; per the bible's own recipe a
//       shape renders as its two-tone fill pair (lit half + shadow half), so
//       canvas fill calls ≈ 2× parts. Bands:
//         SCOUT    11 parts (band 10–14): stubby equal-stagger biplane,
//                  round cowl, single-seat hump, high rudder.
//         FIGHTER  14 parts (band 12–18): larger equal-span biplane, twin MG
//                  muzzles breaking the cowl line, tapered deck.
//         GUNSHIP  21 parts (band 16–22): triple-wing stack with the MID wing
//                  set far forward, deep slab fuselage, twin rudders.
//       Team marks double-encode identity (D4): ROYAL = royalNavy airframe +
//       royalDeck ROUNDEL RING mid-wing; IRON = ironRed airframe + near-black
//       ironDeck BAR-CROSS. Mark shapes are geometric inventions.
//   §9  no ad-hoc hex (everything flows PAL/shadeA/withAlpha), no Math.random
//       (variation comes from hashStr of stable ids), gradients only via the
//       shared softPuff (damage soot + chute shadow here — nothing else).
//
// PERF LAW (RULES 4/11): all local-frame geometry is CONSTANT, built ONCE at
// module init. drawPlane/drawCrate only translate/rotate, pick cached fill
// STRINGS from livery tables and trace prebuilt polygons — zero allocation in
// the per-frame path. The one piece of mutable state is the control-surface
// memory map keyed by sp.id (RENDER STATE ONLY — never game truth).
// ============================================================================

import type { SnapPlane } from '@aces/shared/protocol.js';
import type { CrateState } from '@aces/shared/types.js';
import type { PlaneClassId, TeamId } from '@aces/shared/config.js';
import { CLASSES, CRATE_FALL_S, CRATE_PICKUP_R } from '@aces/shared/config.js';
import {
  INK_STROKE,
  PAL,
  hashStr,
  poly,
  shadeA,
  softPuff,
  withAlpha,
} from '../contract/visual.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

type Pt = [number, number];

// ---- materials: one highlight + one shadow tone each, shadeA-derived --------

interface Tone {
  readonly hi: string;
  readonly base: string;
  readonly sh: string;
}

/** shadeA toward paper (hi) / ink (sh) — §2's ONLY sanctioned derivation. */
function tone(key: keyof typeof PAL, f = 0.22): Tone {
  return { hi: shadeA(key, f), base: PAL[key], sh: shadeA(key, -f) };
}

const WOOD = tone('wood');
const DOPE = tone('dope');

/**
 * Per-team airframe livery. Body = team PRIMARY (the loud color, §1), mark =
 * team SECONDARY. Baked once at module init — drawing only reads strings.
 */
interface Livery {
  readonly body: Tone;
  readonly mark: string;
}

const LIVERIES: Readonly<Record<TeamId, Livery>> = {
  royal: { body: tone('royalNavy'), mark: PAL.royalDeck },
  iron: { body: tone('ironRed'), mark: PAL.ironDeck },
};

/** Prop blur + crate ropes/gores: alpha-suffixed palette constants (§2). */
const PROP_ARC = withAlpha('prop', 0.85);
const ROPE_STROKE = withAlpha('wood', 0.8);
const GORE_STROKE = withAlpha('dope', 0.9); // canopy seams stay in-family
const CHUTE_SHADOW_IN = withAlpha('seaDark', 0.18); // §3 cloud-shadow family
const CHUTE_SHADOW_OUT = withAlpha('seaDark', 0);

/**
 * Damage-soot alpha ladder — quantized styles built once (house idiom, cf.
 * world.ts GLINT_STYLES). Index = floor(damageFrac × N): no per-frame string
 * math, and the eye reads N discrete scorch stages instead of a smear.
 */
const SOOT_LAD: string[] = [];
for (let i = 0; i < 7; i++) SOOT_LAD.push(withAlpha('smokeDk', 0.14 + (i / 6) * 0.66)); // cap 0.80 (art round 2)
const SOOT_OUT = withAlpha('smokeDk', 0);

/** Landed-crate foam pulse ring ladder (alpha oscillation, quantized). */
const FOAM_RINGS: string[] = [];
for (let i = 0; i < 10; i++) FOAM_RINGS.push(withAlpha('foam', 0.1 + (i / 9) * 0.38));

// ---- static geometry ---------------------------------------------------------
//
// Each two-tone logical part contributes TWO constant half-polygons (the s=+1
// half and its y-mirror), tagged with material + polarity. At draw time the
// heading decides which half takes the highlight: local +y maps to world
// (−sin h, cos h) whose westward component is sin h — so sin h > 0 ⇒ the +1
// halves lean WEST and take `hi`.

interface HalfPart {
  readonly pts: readonly Pt[];
  readonly mat: 'body' | 'wood' | 'dope';
  /** +1: this poly is the s=+1 half; −1: its y-mirror. */
  readonly pol: 1 | -1;
  /** Tail-group halves rotate with control-surface tilt around tailPivotX. */
  readonly tail: boolean;
}

/** Small single-tone hardware: muzzles, pods, exhausts, struts. */
interface SolidPart {
  readonly pts: readonly Pt[];
  readonly mat: 'tire' | 'wood';
}

interface ClassArt {
  readonly parts: readonly HalfPart[];
  /** Full-outline polys stroked with INK_STROKE after fills (§2). */
  readonly outlines: readonly (readonly Pt[])[];
  /** Outline polys that live in the tilted tail group. */
  readonly tailOutlines: readonly (readonly Pt[])[];
  /** Two-tone discs [x, y, r, material] — cowl, hump, cockpit. */
  readonly discs: readonly (readonly [number, number, number, 'wood' | 'dope'])[];
  readonly solids: readonly SolidPart[];
  /** Twin-rudder gunship: solid body-base quads inside the tail group. */
  readonly rudders: readonly (readonly Pt[])[];
  readonly tailPivotX: number;
  readonly propX: number;
  readonly propR: number;
  /** Prop angular rate rad/s at cruise — scaled by speed fraction at draw. */
  readonly propRate: number;
  /** Team-mark anchor on the (mid-)wing. */
  readonly markX: number;
  readonly markR: number;
  /** Soot anchor (engine bay) + heavy-damage tail-scorch anchor. */
  readonly sootX: number;
  readonly scorchX: number;
}

function mirror(pts: readonly Pt[]): Pt[] {
  return pts.map(([x, y]) => [x, -y] as Pt);
}

/**
 * Split a symmetric trapezoid (half-width wf at x=xf, wb at xb) into its two
 * lit-candidate halves along the local Y centerline. Halves overlap 0.5u past
 * the centerline to hide the antialiasing seam — flat ink must not read as
 * two stripes glued across a paper-colored crack.
 */
function trapHalves(xf: number, xb: number, wf: number, wb: number): [Pt[], Pt[]] {
  const OV = 0.5;
  const pos: Pt[] = [
    [xf, wf],
    [xb, wb],
    [xb, -OV],
    [xf, -OV],
  ];
  return [pos, mirror(pos)];
}

function fullTrap(xf: number, xb: number, wf: number, wb: number): Pt[] {
  return [
    [xf, wf],
    [xb, wb],
    [xb, -wb],
    [xf, -wf],
  ];
}

/** Solid quad from center + half-extents. */
function quad(cx: number, cy: number, hx: number, hy: number): Pt[] {
  return [
    [cx - hx, cy - hy],
    [cx + hx, cy - hy],
    [cx + hx, cy + hy],
    [cx - hx, cy + hy],
  ];
}

// ---- airframe builders (run ONCE at module init) ----------------------------

class ArtBuild {
  readonly parts: HalfPart[] = [];
  readonly outlines: Pt[][] = [];
  readonly tailOutlines: Pt[][] = [];

  /** Register one two-tone trapezoid part; tail=true joins the tilted group. */
  trap(mat: HalfPart['mat'], xf: number, xb: number, wf: number, wb: number, tail = false): void {
    const [pos, neg] = trapHalves(xf, xb, wf, wb);
    this.parts.push({ pts: pos, mat, pol: 1, tail }, { pts: neg, mat, pol: -1, tail });
    (tail ? this.tailOutlines : this.outlines).push(fullTrap(xf, xb, wf, wb));
  }
}

// SCOUT — stubby equal-stagger biplane (§5). 11 logical parts:
// fuselage · round cowl · upper wing · lower wing · strut ×2 · seat hump ·
// tailplane · HIGH rudder · prop arc · wing mark.
const SCOUT: ClassArt = (() => {
  const b = new ArtBuild();
  b.trap('body', 15, -14, 2.6, 1.5); // fuselage — stubby, nose-heavy
  b.trap('body', 4.8, 0.2, 13, 13); // upper wing (span 26)
  b.trap('body', 6.6, 2.4, 11.5, 11.5); // lower wing — near-equal stagger
  b.trap('body', -10.5, -14.5, 5.2, 4.2, true); // tailplane
  b.trap('body', -14.5, -17.2, 1.1, 0.7, true); // HIGH rudder — busy-tail read
  return {
    parts: b.parts,
    outlines: b.outlines,
    tailOutlines: b.tailOutlines,
    discs: [
      [12.8, 0, 3.3, 'wood'], // ROUND cowl — the scout's signature
      [-1.5, 0, 2.5, 'dope'], // single-seat hump
    ],
    solids: [
      { pts: quad(4.4, 7.1, 1, 1.6), mat: 'wood' }, // interplane struts
      { pts: quad(4.4, -7.1, 1, 1.6), mat: 'wood' },
    ],
    rudders: [],
    tailPivotX: -10.5,
    propX: 15.9,
    propR: 3.6,
    propRate: 26,
    markX: 2.5,
    markR: 3,
    sootX: 8,
    scorchX: -12,
  };
})();

// FIGHTER — classic duelist (§5). 14 logical parts:
// fuselage · tapered deck · cowl · muzzle ×2 (BREAK the cowl line) · upper
// wing · lower wing · strut ×2 · hump · tailplane · rudder · prop · mark.
const FIGHTER: ClassArt = (() => {
  const b = new ArtBuild();
  b.trap('body', 16.5, -15.5, 2.8, 1.5); // fuselage, tapering aft
  b.trap('dope', 14.5, 6, 1.5, 1.1); // tapered fore-deck (linen dope)
  b.trap('body', 4.8, -0.4, 15, 15); // upper wing (span 30)
  b.trap('body', 6.6, 1.8, 14.4, 14.4); // lower wing — EQUAL-span read
  b.trap('body', -12, -16.5, 6.2, 5, true); // tailplane
  b.trap('body', -16.5, -19, 1.2, 0.8, true); // rudder
  return {
    parts: b.parts,
    outlines: b.outlines,
    tailOutlines: b.tailOutlines,
    discs: [
      [14.6, 0, 3.1, 'wood'], // cowl…
      [-2.2, 0, 2.6, 'dope'], // …with twin muzzles breaking its line (solids)
    ],
    solids: [
      { pts: quad(17.6, 2.2, 1.2, 0.55), mat: 'tire' }, // straight twin MGs
      { pts: quad(17.6, -2.2, 1.2, 0.55), mat: 'tire' },
      { pts: quad(3.4, 8.3, 1.1, 1.7), mat: 'wood' }, // struts
      { pts: quad(3.4, -8.3, 1.1, 1.7), mat: 'wood' },
    ],
    rudders: [],
    tailPivotX: -12,
    propX: 18.2,
    propR: 3.4,
    propRate: 23,
    markX: 2.2,
    markR: 3.4,
    sootX: 9,
    scorchX: -13,
  };
})();

// GUNSHIP — wide + slow + armored (§5). 21 logical parts:
// fuselage slab · armored deck · cowl block · muzzle ×2 · TOP/MID/LOWER wings
// (MID far forward) · strut ×3 · gun pod ×2 · exhaust ×2 · cockpit ·
// tailplane · TWIN rudders · prop · mid-wing mark.
const GUNSHIP: ClassArt = (() => {
  const b = new ArtBuild();
  b.trap('body', 15, -16, 4.4, 2.6); // DEEP SLAB fuselage — the armor read
  b.trap('dope', 13, 4, 2.6, 2.2); // armored deck plate
  b.trap('body', 1.2, -4.2, 18, 18); // TOP wing (span 36; ≈40u with pods)
  b.trap('body', 11, 5.6, 16.5, 16.5); // MID wing set FAR FORWARD — signature
  b.trap('body', -3.2, -8.4, 15, 15); // LOWER wing — completes the stack
  b.trap('body', -13, -17.5, 7.6, 6.2, true); // broad tailplane
  const rudders: Pt[][] = [quad(-18.9, 1.9, 1.4, 0.85), quad(-18.9, -1.9, 1.4, 0.85)];
  return {
    parts: b.parts,
    outlines: b.outlines,
    tailOutlines: [...b.tailOutlines, ...rudders],
    discs: [
      [13.6, 0, 4, 'wood'], // armored cowl block
      [-5, 0, 2.8, 'dope'], // cockpit slab
    ],
    solids: [
      { pts: quad(16.2, 2.4, 1.2, 0.6), mat: 'tire' }, // paired nose muzzles…
      { pts: quad(16.2, -2.4, 1.2, 0.6), mat: 'tire' },
      { pts: quad(9.2, 6.5, 1.3, 0.85), mat: 'tire' }, // …wing gun pods on the
      { pts: quad(9.2, -6.5, 1.3, 0.85), mat: 'tire' }, // forward mid wing
      { pts: quad(12.4, 5.1, 1.1, 0.45), mat: 'tire' }, // exhaust stubs
      { pts: quad(12.4, -5.1, 1.1, 0.45), mat: 'tire' },
      { pts: quad(-1.5, 8.6, 1.2, 1.8), mat: 'wood' }, // three cabane struts
      { pts: quad(-1.5, -8.6, 1.2, 1.8), mat: 'wood' },
      { pts: quad(-1.5, 0, 1.2, 1.5), mat: 'wood' },
    ],
    rudders, // TWIN rudders — the second silhouette signature after the stack
    tailPivotX: -13,
    propX: 16.7,
    propR: 4.6,
    propRate: 19,
    markX: 8.3,
    markR: 3.8,
    sootX: 10,
    scorchX: -14,
  };
})();

const ART: Readonly<Record<PlaneClassId, ClassArt>> = {
  scout: SCOUT,
  fighter: FIGHTER,
  gunship: GUNSHIP,
};

/** §5 bands kept beside the art so drift fails loudly in review/tests. */
export const PART_BANDS: Readonly<Record<PlaneClassId, [number, number]>> = {
  scout: [10, 14],
  fighter: [12, 18],
  gunship: [16, 22],
};

// ---- control-surface memory (render state ONLY — never game truth) ----------

interface TiltMem {
  h: number;
  t: number;
  tilt: number; // smoothed −1..1 fraction of full deflection
}

/** Roster churn bound; ids are stable within a match but matches are long. */
const TILT_MEM_CAP = 128;
const tiltMem = new Map<string, TiltMem>();

function shortestArc(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * Heading-change rate → smoothed tilt in −1..1, keyed by sp.id exactly as the
 * brief specifies. The 0.25 blend keeps surfaces from buzzing on interp
 * jitter; gaps > 0.5 s (hitch, first sighting) reseed instead of dividing by
 * a bogus dt and spiking the elevators.
 */
function updateTilt(id: string, h: number, t: number): number {
  const prev = tiltMem.get(id);
  if (!prev || t <= prev.t || t - prev.t > 0.5) {
    if (tiltMem.size > TILT_MEM_CAP) tiltMem.clear();
    tiltMem.set(id, { h, t, tilt: prev ? prev.tilt : 0 });
    return prev ? prev.tilt : 0;
  }
  const dt = t - prev.t;
  const rate = shortestArc(prev.h, h) / dt; // rad/s, signed by turn direction
  const target = Math.max(-1, Math.min(1, rate / 6));
  const tilt = prev.tilt + (target - prev.tilt) * 0.25;
  prev.h = h;
  prev.t = t;
  prev.tilt = tilt;
  return tilt;
}

// ---- shared draw helpers (allocation-free) -----------------------------------

/**
 * Two-tone disc: shadow full-circle underneath, highlight half-disc toward the
 * sun. `litAng` is the lit direction in LOCAL space — planes derive it from
 * heading, the un-rotated crate passes a fixed west-facing π.
 */
function toneDisc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, tn: Tone, litAng: number): void {
  ctx.fillStyle = tn.sh;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = tn.hi;
  ctx.beginPath();
  ctx.arc(x, y, r, litAng - HALF_PI, litAng + HALF_PI);
  ctx.closePath();
  ctx.fill();
}

/** ROYAL roundel RING — deck-cream ring + center dot on the navy wing. */
function roundelRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, mark: string): void {
  ctx.strokeStyle = mark;
  ctx.lineWidth = 1.9;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
  ctx.fillStyle = mark;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.42, 0, TAU);
  ctx.fill();
}

/** IRON BAR-CROSS — near-black geometric cross; fillRect keeps it alloc-free. */
function barCross(ctx: CanvasRenderingContext2D, x: number, y: number, arm: number, w: number, mark: string): void {
  const ah = arm * 1.2;
  ctx.fillStyle = mark;
  ctx.fillRect(x - w, y - arm, w * 2, arm * 2); // spanwise bar
  ctx.fillRect(x - ah, y - w, ah * 2, w * 2); // chordwise bar
}

/** Cached tone strings per material × lit/shadow — no branching below. */
function fillFor(p: HalfPart, lv: Livery, litSign: 1 | -1): string {
  const lit = p.pol === litSign;
  switch (p.mat) {
    case 'body':
      return lit ? lv.body.hi : lv.body.sh;
    case 'wood':
      return lit ? WOOD.hi : WOOD.sh;
    case 'dope':
      return lit ? DOPE.hi : DOPE.sh;
  }
}

// ---- drawPlane -----------------------------------------------------------------

export function drawPlane(ctx: CanvasRenderingContext2D, sp: SnapPlane, t: number): void {
  // Dead planes are NEVER drawn here — the wreck belongs to effects.ts.
  if (sp.dead) return;

  const art = ART[sp.cls];
  const lv = LIVERIES[sp.team];
  const tilt = updateTilt(sp.id, sp.h, t);

  ctx.save();
  ctx.translate(sp.x, sp.y);

  // Invulnerability blink: smooth alpha oscillation (~2.7 Hz), phase-offset by
  // id hash so a freshly spawned flight doesn't pulse in lockstep.
  if (sp.invulnT > 0) {
    const ph = (hashStr(sp.id) % 628) / 100;
    ctx.globalAlpha = 0.42 + 0.5 * (0.5 + 0.5 * Math.sin(t * 17 + ph));
  }

  ctx.rotate(sp.h);

  // Sun geometry in LOCAL space: world-west (−1,0) inverse-rotated by h gives
  // the lit direction atan2(sin h, −cos h); sin h > 0 means the s=+1 halves
  // lean west and take the highlight (see HalfPart).
  const litAng = Math.atan2(Math.sin(sp.h), -Math.cos(sp.h));
  const litSign: 1 | -1 = Math.sin(sp.h) > 0 ? 1 : -1;

  // 1. two-tone half-polys — fuselage, wings, deck (tail waits for its group).
  for (let i = 0; i < art.parts.length; i++) {
    const p = art.parts[i]!;
    if (p.tail) continue;
    ctx.fillStyle = fillFor(p, lv, litSign);
    poly(ctx, p.pts);
    ctx.fill();
  }

  // 2. two-tone discs — cowls, hump, cockpit; highlight chases the sun.
  for (let i = 0; i < art.discs.length; i++) {
    const d = art.discs[i]!;
    toneDisc(ctx, d[0], d[1], d[2], d[3] === 'wood' ? WOOD : DOPE, litAng);
  }

  // 3. single-tone hardware: fighter muzzles BREAK the cowl line, gunship pods
  //    and exhausts widen the slab read, struts stitch the wing stack.
  for (let i = 0; i < art.solids.length; i++) {
    const s = art.solids[i]!;
    ctx.fillStyle = s.mat === 'tire' ? PAL.tire : WOOD.base;
    poly(ctx, s.pts);
    ctx.fill();
  }

  // 4. tilted tail group: surfaces respond to heading-change rate. Pivot at
  //    the tailplane root; the whole group rotates while twin rudders also
  //    shear so a hard turn reads even at CAMERA.ZOOM_MIN.
  if (Math.abs(tilt) > 0.02) {
    ctx.save();
    ctx.translate(art.tailPivotX, 0);
    ctx.rotate(-tilt * 0.3);
    const dy = tilt * 0.9;
    for (let i = 0; i < art.parts.length; i++) {
      const p = art.parts[i]!;
      if (!p.tail) continue;
      ctx.fillStyle = fillFor(p, lv, litSign);
      ctx.translate(0, dy);
      poly(ctx, p.pts);
      ctx.fill();
      ctx.translate(0, -dy);
    }
    ctx.fillStyle = lv.body.base;
    for (let i = 0; i < art.rudders.length; i++) {
      ctx.translate(0, dy);
      poly(ctx, art.rudders[i]!);
      ctx.fill();
      ctx.translate(0, -dy);
    }
    ctx.strokeStyle = INK_STROKE;
    ctx.lineWidth = 0.8;
    for (let i = 0; i < art.tailOutlines.length; i++) {
      ctx.translate(0, dy);
      poly(ctx, art.tailOutlines[i]!);
      ctx.stroke();
      ctx.translate(0, -dy);
    }
    ctx.restore();
  } else {
    // Steady flight: same fills, zero transform — identical ink either way.
    for (let i = 0; i < art.parts.length; i++) {
      const p = art.parts[i]!;
      if (!p.tail) continue;
      ctx.fillStyle = fillFor(p, lv, litSign);
      poly(ctx, p.pts);
      ctx.fill();
    }
    ctx.fillStyle = lv.body.base;
    for (let i = 0; i < art.rudders.length; i++) {
      poly(ctx, art.rudders[i]!);
      ctx.fill();
    }
  }

  // 5. hairline ink outline over every major silhouette shape (§2) — what
  //    lifts aircraft OFF the printed page of the world.
  ctx.strokeStyle = INK_STROKE;
  ctx.lineWidth = 0.8;
  for (let i = 0; i < art.outlines.length; i++) {
    poly(ctx, art.outlines[i]!);
    ctx.stroke();
  }

  // 6. team mark on the (mid-)wing — identity channel #2 behind body color.
  if (sp.team === 'royal') roundelRing(ctx, art.markX, 0, art.markR, lv.mark);
  else barCross(ctx, art.markX, 0, art.markR, art.markR * 0.32, lv.mark);

  // 7. prop-blur arc: phase = t·rateFrac + hashStr(id) per the brief; rate
  //    scales with speed fraction so a boosting disc visibly spins faster.
  const rateFrac = art.propRate * (0.55 + 0.45 * (sp.sp / CLASSES[sp.cls].speedMax));
  const phase = t * rateFrac + (hashStr(sp.id) % 628) / 100;
  ctx.strokeStyle = PROP_ARC;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(art.propX, 0, art.propR, phase, phase + 2.1);
  ctx.stroke();

  // 8. damage soot: engine-bay stain scaling with missing HP (quantized
  //    ladder), plus a tail scorch past half-health. softPuff is the ONE
  //    sanctioned soft-mass path (§2) and the only gradient touch here.
  const dmg = 1 - sp.hp / sp.maxHp;
  if (dmg > 0.04) {
    const idx = Math.min(SOOT_LAD.length - 1, Math.floor(dmg * SOOT_LAD.length));
    softPuff(ctx, art.sootX, 0, 3.5 + dmg * 8, SOOT_LAD[idx]!, SOOT_OUT);
    if (dmg > 0.55) softPuff(ctx, art.scorchX, 0, 2 + dmg * 3, SOOT_LAD[idx]!, SOOT_OUT);
  }

  ctx.restore();
}

// ---- drawCrate ------------------------------------------------------------------
//
// Crates are ENTITIES rendered from CrateState (CONTRACT §5 C_FX). FALL reads
// as a top-down parachute descent: dope canopy dome, wood gore seams and rope
// lines, the box swinging beneath on a gentle pendulum, plus a soft sea shadow
// that sells altitude. ACTIVE: landed wood crate (§3 color binding: canopy =
// dope, ropes = wood), collapsed chute heap beside it, and a foam-ring pulse
// whose alpha oscillates to pull the eye without ever reaching HUD loudness.

const BOX = tone('wood');
const CANOPY = tone('dope');

// Crate geometry is static AND un-rotated, so local == world and the lit side
// is simply WEST — an axis-'x' split (highlight toward −x), unlike planes.
const BOX_WEST: readonly Pt[] = [
  [-4, 4.4],
  [-4, -4.4],
  [-0.5, -4.4],
  [-0.5, 4.4],
];
const BOX_EAST: readonly Pt[] = [
  [0.5, 4.4],
  [0.5, -4.4],
  [4, -4.4],
  [4, 4.4],
];
/** Slat seams, drawn as strokes across the lid. */
const BOX_SLATS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-2.6, -4.2, -2.6, 4.2],
  [2.6, -4.2, 2.6, 4.2],
];
/** Tire straps over the lid — the "supply drop" read at gameplay zoom. */
const BOX_STRAPS: readonly (readonly Pt[])[] = [
  [
    [-1.5, -4.6],
    [1.5, -4.6],
    [1.5, 4.6],
    [-1.5, 4.6],
  ],
];
/** Collapsed canopy heap beside the landed crate. */
const CHUTE_HEAP: readonly Pt[] = [
  [-8.2, 5.4],
  [-11.6, 7.6],
  [-13.8, 10.8],
  [-10.2, 12.2],
  [-7.4, 9.4],
];

function drawBox(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = BOX.hi; // west half lit — fixed sun, fixed crate
  poly(ctx, BOX_WEST);
  ctx.fill();
  ctx.fillStyle = BOX.sh;
  poly(ctx, BOX_EAST);
  ctx.fill();
  ctx.strokeStyle = ROPE_STROKE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < BOX_SLATS.length; i++) {
    const s = BOX_SLATS[i]!;
    ctx.moveTo(s[0], s[1]);
    ctx.lineTo(s[2], s[3]);
  }
  ctx.stroke();
  ctx.fillStyle = PAL.tire;
  for (let i = 0; i < BOX_STRAPS.length; i++) {
    poly(ctx, BOX_STRAPS[i]!);
    ctx.fill();
  }
}

export function drawCrate(ctx: CanvasRenderingContext2D, c: CrateState, t: number): void {
  const ph = ((hashStr(`crate:${c.id}`) % 1000) / 1000) * TAU;

  ctx.save();
  ctx.translate(c.x, c.y);

  if (c.phase === 'fall') {
    // Descent progress: t counts DOWN from CRATE_FALL_S to 0.
    const p = 1 - Math.max(0, Math.min(1, c.t / CRATE_FALL_S));
    // Altitude shadow east-south of the drop point, tightening as it nears
    // the water (the §3 cloud-shadow family — seaDark, alpha ≤ 0.25).
    softPuff(ctx, 4 + p * 5, 8 + p * 6, 7 + p * 3, CHUTE_SHADOW_IN, CHUTE_SHADOW_OUT);
    // Canopy dome: dope two-tone, lit toward fixed west (π in local space).
    toneDisc(ctx, 0, 0, 13 - p * 1.2, CANOPY, Math.PI);
    // Gore seams radiating from the crown — six spokes, phase-varied per id.
    ctx.strokeStyle = GORE_STROKE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = ph + (k * TAU) / 6;
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * 11.2, Math.sin(a) * 11.2);
    }
    ctx.stroke();
    // Box pendulum beneath the canopy: sway grows slightly as it descends
    // (drag stabilizes the chute), phase-offset so crates never sync.
    const sw = Math.sin(t * 1.7 + ph);
    ctx.save();
    ctx.translate(sw * (2 + p * 1.8), Math.cos(t * 1.7 + ph) * 1.1);
    ctx.rotate(sw * 0.11);
    ctx.strokeStyle = ROPE_STROKE;
    ctx.lineWidth = 1;
    ctx.beginPath(); // four ropes: box corners → canopy rim diagonals
    ctx.moveTo(-4, -4);
    ctx.lineTo(-9.2, -9.2);
    ctx.moveTo(4, -4);
    ctx.lineTo(9.2, -9.2);
    ctx.moveTo(4, 4);
    ctx.lineTo(9.2, 9.2);
    ctx.moveTo(-4, 4);
    ctx.lineTo(-9.2, 9.2);
    ctx.stroke();
    drawBox(ctx);
    ctx.restore();
  } else {
    // Landed: collapsed chute heap just west of the box…
    ctx.fillStyle = CANOPY.base;
    poly(ctx, CHUTE_HEAP);
    ctx.fill();
    ctx.strokeStyle = ROPE_STROKE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-8, 6);
    ctx.lineTo(-14.5, 11);
    ctx.stroke();
    drawBox(ctx);
    // …and the eye-attracting foam pulse: period ≈1.15 s, radius breathing
    // out toward the CRATE_PICKUP_R hint, alpha brightest at ring birth.
    const cyc = (t * 0.87 + ph) % 1;
    const r = 13 + cyc * CRATE_PICKUP_R * 0.55;
    const aIdx = Math.round((1 - cyc) * (FOAM_RINGS.length - 1));
    ctx.strokeStyle = FOAM_RINGS[aIdx]!;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
  }

  ctx.restore();
}



