// ============================================================================
// BANK — dice view. Two TRUE CSS 3D dice: six-faced cubes (real 3x3 pip
// layouts, opposite faces sum to 7: 1/6, 2/5, 3/4) thrown with a physically
// consistent three-hop bounce, a multi-axis tumble that decelerates onto the
// rolled faces exactly as the last hop lands, and a damped settle rock on two
// axes. Each die casts a real ground-plane contact shadow (a horizontal disc
// under the cube) that tracks the throw: it spreads and fades as the die
// rises, tightens and darkens as it lands.
//
// rollTo() drives both dice concurrently from a single rAF loop writing only
// `transform` and `opacity` — both compositor-friendly, no layout reads, no
// forced reflows. Every per-roll variation (spin counts, spin directions, arc
// height, restitution, lateral offset, rock amplitudes) comes from a seeded
// stream (@platform/shared rng, seeded from a private roll counter) — never
// Math.random. The dice VALUES are the server's; the RNG only styles the
// throw, so rolls stay deterministic and server-consistent.
//
// All colour comes from the frozen BPAL palette (@bank/shared) by name, read
// through its CSS custom property with the palette value as the fallback —
// there is no hex literal in this file. Styling lives in the injected <style>
// block below (style.css is another task's file — not touched). The `bd3d-*`
// class namespace belongs to this file alone. Die size: --bd-size (default
// 64px).
// ============================================================================

import { rng, rngInt, rngRange } from '@platform/shared';
import { BPAL, BPAL_CSS_VARS } from '@bank/shared';
import type { BankPaletteKey } from '@bank/shared';

const STYLE_ID = 'bank-dice-style';
const ROLL_DEFAULT_MS = 900;

/** The dice are back on the felt (and fully oriented) at this fraction of the
 *  roll; the remainder is the settle rock. */
const AIR_END = 0.86;

/** Peak impact squash, as a fraction of the die's height. Deliberately small —
 *  it reads as weight, not as rubber. */
const SQUASH = 0.055;

/** Contact-shadow opacity with the die at rest on the felt. */
const SHADOW_ALPHA = 0.68;

/** How much the shadow spreads / lifts off at the apex of the throw. */
const SHADOW_SPREAD = 0.55;
const SHADOW_FADE = 0.55;

// Pip cells lit per face value (3x3 grid, row-major indices 0..8).
const PIPS: readonly (readonly number[])[] = [
  [],                 // 0 — unused
  [4],                // 1
  [0, 8],             // 2
  [0, 4, 8],          // 3
  [0, 2, 6, 8],       // 4
  [0, 2, 4, 6, 8],    // 5
  [0, 2, 3, 5, 6, 8], // 6
];

// ---- palette access ---------------------------------------------------------
// Every colour is a BPAL entry named through its frozen CSS custom property
// (mirrored at boot by main.ts), with the palette's own value as the fallback
// so the dice are never unstyled if the mirror has not run yet.

/** e.g. pal('diceFace') -> `var(--dice-face, <BPAL.diceFace>)` — by name only. */
function pal(key: BankPaletteKey): string {
  return `var(${BPAL_CSS_VARS[key]}, ${BPAL[key]})`;
}

/** A palette entry at partial alpha — for bevel highlights, AO and shadows.
 *  The colour is still a named palette entry; only its coverage varies. */
function tint(key: BankPaletteKey, a: number): string {
  const n = Number.parseInt(BPAL[key].slice(1), 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${a})`;
}

interface Rot {
  x: number; // deg, written as rotateX
  y: number; // deg, written as rotateY (composed R = Rx · Ry)
}

/**
 * Face placement (see the CSS cube below): 1 front (+Z), 6 back (−Z),
 * 2 right (+X), 5 left (−X), 3 up (−Y), 4 down (+Y) — opposites sum to 7.
 * With the die transform `rotateX(x) rotateY(y)` these Eulers bring face v's
 * normal exactly to (0,−1,0), the scene-up direction:
 *   1: +Z → Rx(90)          4: +Y → Rx(180)
 *   2: +X → Ry(−90)·Rx(90)  5: −X → Ry(90)·Rx(90)
 *   3: −Y → identity        6: −Z → Rx(−90)
 * (Verified empirically in a headless browser: after settle, the face whose
 * composed die×face matrix has normal (0,−1,0) is exactly the rolled value.)
 * The settle rock adds a rotateZ in FRONT of this pair, so it tilts the whole
 * die in the scene frame and decays to exactly 0 — the landed face is never
 * disturbed.
 */
function targetFor(v: number): Rot {
  switch (v) {
    case 1: return { x: 90, y: 0 };
    case 2: return { x: 90, y: -90 };
    case 3: return { x: 0, y: 0 };
    case 4: return { x: 180, y: 0 };
    case 5: return { x: 90, y: 90 };
    default: return { x: -90, y: 0 }; // 6
  }
}

/** Clamp to a valid d6 face (defensive; the server always sends 1..6). */
function norm(v: number): number {
  return Math.min(6, Math.max(1, Math.round(v)));
}

/** Angle into [0, 360). */
function norm360(v: number): number {
  return ((v % 360) + 360) % 360;
}

/** Cycle a spin count within {2,3,4} to a different one (2→3→4→2). */
function otherSpin(n: number): number {
  return 2 + ((n - 1) % 3);
}

/**
 * Signed delta from `current` to an angle congruent with `target` (mod 360),
 * covering `spins` full extra turns in direction `dir` (+1 / −1).
 */
function spinDelta(current: number, target: number, spins: number, dir: number): number {
  const mod = norm360(target - current);
  return dir >= 0 ? mod + spins * 360 : -((360 - mod) % 360) - spins * 360;
}

// ---- easings ----------------------------------------------------------------
/** Tumble decay. Quart lands with zero angular velocity, so the die arrives at
 *  its exact face at the moment of the last impact instead of creeping. */
const easeOutQuart = (t: number): number => 1 - Math.pow(1 - t, 4);

/** Duration of the first hop, given a restitution. Hop k lasts d0·rᵏ and peaks
 *  at h·r²ᵏ — the relation a constant gravity imposes — and the three hops
 *  exactly fill [0, AIR_END]. */
function hop0(rest: number): number {
  return AIR_END / (1 + rest + rest * rest);
}

/**
 * Throw arc, px (negative = up). Three parabolic hops under constant gravity:
 * a big launch, a solid second bounce, a small third that dies on the felt at
 * AIR_END. That decay — not an ad-hoc easing — is what gives the throw weight.
 */
function arcY(t: number, height: number, rest: number): number {
  if (t <= 0 || t >= AIR_END) return 0;
  let start = 0; // the first hop begins at t = 0
  let dur = hop0(rest);
  let h = height;
  for (let k = 0; k < 3; k++) {
    if (t < start + dur) {
      const u = (t - start) / dur;
      return -h * 4 * u * (1 - u);
    }
    start += dur;
    dur *= rest;
    h *= rest * rest;
  }
  return 0;
}

/**
 * Impact squash, 0..1: a short triangular pulse at each of the three landings,
 * decaying with the energy of the hop that caused it. Applied as a world-space
 * scale in FRONT of the rotation, so the die flattens against the felt.
 */
function squashAt(t: number, rest: number): number {
  const d0 = hop0(rest);
  let at = d0;         // first impact
  let step = d0 * rest; // gap to the next impact
  let width = 0.045;
  let amp = 1;
  let out = 0;
  for (let k = 0; k < 3; k++) {
    const dt = Math.abs(t - at);
    if (dt < width) out = Math.max(out, amp * (1 - dt / width));
    at += step;
    step *= rest;
    width *= rest;
    amp *= rest;
  }
  return out;
}

/** Settle rock about the scene X axis: 1.5 damped oscillations over the tail,
 *  starting and ending at exactly 0 so the landed face is preserved. */
function rockAt(t: number, amp: number): number {
  if (t < AIR_END) return 0;
  const u = (t - AIR_END) / (1 - AIR_END);
  return amp * Math.sin(u * Math.PI * 3) * Math.pow(1 - u, 1.6);
}

/** Settle rock about the scene Z axis: a slower single wobble, out of phase
 *  with rockAt() so the die traces a small ellipse as it beds in. */
function rockZAt(t: number, amp: number): number {
  if (t < AIR_END) return 0;
  const u = (t - AIR_END) / (1 - AIR_END);
  return amp * Math.sin(u * Math.PI * 2) * Math.pow(1 - u, 1.4);
}

interface DieState {
  slot: HTMLElement;   // .bd3d-slot — the die's cell; holds the cube + its shadow
  el: HTMLElement;     // .bd3d-die — the cube; its transform is written per frame
  shadow: HTMLElement; // .bd3d-shadow — ground-plane contact disc
  rx: number;          // last written orientation (continuity across superseded rolls)
  ry: number;
  rz: number;          // settle-rock tilt only; always 0 at rest
}

interface RollPlan {
  spinsX: number; // full X turns (kept so die 2 can differ from die 1)
  spinsY: number; // full Y turns
  fromX: number;
  fromY: number;
  deltaX: number; // signed: |delta| = spins*360 + shortest residual
  deltaY: number;
  endX: number;   // exact landing Euler = from + delta
  endY: number;
  height: number;  // throw apex, px (64..104)
  rest: number;    // restitution: hop k peaks at height*rest^(2k) (0.50..0.60)
  lateral: number; // starting sideways offset, px (±10..26)
  rock: number;    // settle rock amplitude about X, deg (±4..5.5)
  rockZ: number;   // settle rock amplitude about Z, deg (±2..3.5)
}

/** Draw one die's roll from the seeded stream; `avoid` forces die 2's spin
 * counts to differ from die 1's (adjustment is a pure function of the drawn
 * values, so the stream stays deterministic). */
function plan(next: () => number, die: DieState, v: number, avoid: RollPlan | null): RollPlan {
  const target = targetFor(v);
  let spinsX = rngInt(next, 2, 4);
  let spinsY = rngInt(next, 2, 4);
  if (avoid !== null) {
    if (spinsX === avoid.spinsX) spinsX = otherSpin(spinsX);
    if (spinsY === avoid.spinsY) spinsY = otherSpin(spinsY);
  }
  const deltaX = spinDelta(die.rx, target.x, spinsX, next() < 0.5 ? 1 : -1);
  const deltaY = spinDelta(die.ry, target.y, spinsY, next() < 0.5 ? 1 : -1);
  return {
    spinsX,
    spinsY,
    fromX: die.rx,
    fromY: die.ry,
    deltaX,
    deltaY,
    endX: die.rx + deltaX,
    endY: die.ry + deltaY,
    height: rngRange(next, 64, 104),
    rest: rngRange(next, 0.5, 0.6),
    lateral: rngRange(next, 10, 26) * (next() < 0.5 ? 1 : -1),
    rock: rngRange(next, 4, 5.5) * (next() < 0.5 ? 1 : -1),
    rockZ: rngRange(next, 2, 3.5) * (next() < 0.5 ? 1 : -1),
  };
}

function buildDie(): DieState {
  const slot = document.createElement('div');
  slot.className = 'bd3d-slot';

  // The contact shadow is a sibling of the cube, laid flat in the scene's
  // ground plane (rotateX(90deg) in the CSS-written part of its transform).
  const shadow = document.createElement('div');
  shadow.className = 'bd3d-shadow';

  const el = document.createElement('div');
  el.className = 'bd3d-die';
  for (let v = 1; v <= 6; v++) {
    const face = document.createElement('div');
    face.className = 'bd3d-face';
    face.dataset.v = String(v);
    const lit = PIPS[v] ?? [];
    for (let i = 0; i < 9; i++) {
      const pip = document.createElement('span');
      pip.className = lit.includes(i) ? 'bd3d-pip on' : 'bd3d-pip';
      face.appendChild(pip);
    }
    el.appendChild(face);
  }
  slot.append(shadow, el);
  // rest pose: face 1 on top (targetFor(1) = {x:90, y:0})
  return { slot, el, shadow, rx: 90, ry: 0, rz: 0 };
}

export class DiceView {
  private readonly dice: [DieState, DieState];
  private settled: [number, number] = [1, 1];
  private rolls = 0;                    // private counter seeding each roll's stream
  private raf = 0;                      // in-flight roll's frame handle
  private done: (() => void) | null = null; // resolve of the in-flight roll

  constructor(container: HTMLElement) {
    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const scene = document.createElement('div');
    scene.className = 'bd3d-dice';
    const row = document.createElement('div');
    row.className = 'bd3d-row';
    this.dice = [buildDie(), buildDie()];
    row.append(this.dice[0].slot, this.dice[1].slot);
    scene.appendChild(row);
    container.appendChild(scene);
    this.write(this.dice[0], 0, 0, 0, 0);
    this.write(this.dice[1], 0, 0, 0, 0);
  }

  /** The values the dice have settled on (the in-flight roll's target, if any). */
  faces(): [number, number] {
    return [this.settled[0], this.settled[1]];
  }

  /**
   * Throw both dice: a three-hop bounce with a slight lateral drift while they
   * tumble 2–4 full turns per axis (different counts per die), decelerating
   * onto (d1, d2) so the tumble stops exactly as the last hop lands, then a
   * damped two-axis settle rock. Resolves once settled. durationMs <= 0 snaps
   * instantly. A new rollTo() supersedes one in flight: its promise resolves
   * immediately and the new roll takes over from the current mid-tumble
   * orientation.
   */
  rollTo(d1: number, d2: number, durationMs: number = ROLL_DEFAULT_MS): Promise<void> {
    const targets: [number, number] = [norm(d1), norm(d2)];
    this.settled = targets;
    this.rolls += 1;
    this.endRoll(); // supersede: resolve the previous roll's promise now

    const next = rng(Math.imul(this.rolls, 2654435761) >>> 0);
    const p0 = plan(next, this.dice[0], targets[0], null);
    // die 2's spin counts are forced to differ from die 1's (see plan())
    const plans: [RollPlan, RollPlan] = [p0, plan(next, this.dice[1], targets[1], p0)];

    if (durationMs <= 0) {
      this.land(this.dice[0], plans[0]);
      this.land(this.dice[1], plans[1]);
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.done = resolve;
      let start = -1; // first frame's timestamp (the whole loop keys off rAF time)
      const frame = (now: number): void => {
        if (start < 0) start = now;
        const t = Math.min(1, (now - start) / durationMs);
        this.apply(this.dice[0], plans[0], t);
        this.apply(this.dice[1], plans[1], t);
        if (t >= 1) {
          this.land(this.dice[0], plans[0]);
          this.land(this.dice[1], plans[1]);
          this.endRoll();
          return;
        }
        this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
    });
  }

  /** Write one frame of the throw: tumble + settle rock, bounce arc, lateral
   *  drift, impact squash, and the tracking contact shadow. */
  private apply(die: DieState, p: RollPlan, t: number): void {
    const e = easeOutQuart(Math.min(1, t / AIR_END));
    die.rx = p.fromX + p.deltaX * e + rockAt(t, p.rock);
    die.ry = p.fromY + p.deltaY * e;
    die.rz = rockZAt(t, p.rockZ);
    const y = arcY(t, p.height, p.rest);
    this.write(die, p.lateral * (1 - e), y, -y / p.height, squashAt(t, p.rest));
  }

  /** Snap a die to its exact landing Euler (normalized to keep angles small). */
  private land(die: DieState, p: RollPlan): void {
    die.rx = norm360(p.endX);
    die.ry = norm360(p.endY);
    die.rz = 0;
    this.write(die, 0, 0, 0, 0);
  }

  /**
   * The only per-frame DOM writes: `transform` on the cube and on its shadow,
   * plus `opacity` on the shadow. All three are compositor properties — no
   * layout is read or invalidated.
   *
   * `lift` is 0 on the felt and 1 at the apex: the shadow spreads and fades
   * with it, which is what makes the dice read as objects ON a table rather
   * than stickers over it.
   */
  private write(die: DieState, x: number, y: number, lift: number, squash: number): void {
    const sy = 1 - SQUASH * squash;
    const sx = 1 + SQUASH * squash * 0.55;
    die.el.style.transform =
      `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0px) ` +
      `scale3d(${sx.toFixed(4)}, ${sy.toFixed(4)}, 1) ` +
      `rotateZ(${die.rz.toFixed(2)}deg) ` +
      `rotateX(${die.rx.toFixed(2)}deg) rotateY(${die.ry.toFixed(2)}deg)`;
    die.shadow.style.transform =
      `translate3d(${x.toFixed(2)}px, 0px, 0px) rotateX(90deg) ` +
      `scale(${(1 + SHADOW_SPREAD * lift).toFixed(4)})`;
    die.shadow.style.opacity = (SHADOW_ALPHA * (1 - SHADOW_FADE * lift)).toFixed(3);
  }

  /** Stop the in-flight roll (if any) and resolve its promise. */
  private endRoll(): void {
    if (this.done === null) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const done = this.done;
    this.done = null;
    done();
  }
}

// ---- styling ----------------------------------------------------------------
// Named palette entries only (see pal()/tint()). `S` is the die edge length.

const S = 'var(--bd-size, 64px)';
const FACE = pal('diceFace');
const SHADE = pal('diceFaceShade');
const BEVEL = pal('diceBevel');
const PIP = pal('dicePip');
const PIP_DEEP = pal('dicePipDeep');

const CSS = `
.bd3d-dice, .bd3d-dice * { box-sizing: border-box; margin: 0; padding: 0; }
/* ---- scene: perspective for the 3D; the row carries a static tilt so we look
   DOWN onto the dice and onto the ground plane their shadows lie in ---- */
.bd3d-dice {
  display: flex; justify-content: center;
  perspective: 1400px; perspective-origin: 50% 40%;
}
.bd3d-row {
  display: flex; align-items: center; justify-content: center;
  gap: calc(${S} * 0.62);
  transform: rotateX(-26deg);
  transform-style: preserve-3d;
}
/* ---- slot: one die's cell — the cube plus the ground-plane disc it sits on -- */
.bd3d-slot {
  position: relative;
  width: ${S}; height: ${S};
  transform-style: preserve-3d;
}
/* ---- contact shadow: a disc lying FLAT in the ground plane (rotateX(90deg)),
   parked one half-die below the cube's centre. JS writes its lateral offset,
   its spread and its opacity every frame, so it tracks the bounce arc ---- */
.bd3d-shadow {
  position: absolute; left: 50%; top: 50%;
  width: calc(${S} * 1.95); height: calc(${S} * 1.95);
  margin-left: calc(${S} * -0.975);
  /* -0.975 (centring) + 0.56 (drop to the felt). 0.56 is a floor, not taste:
     the settle rock tilts the cube by up to ~6.5 deg, whose half-diagonal
     reaches 0.553 of the die — any closer and a corner would cut through the
     shadow plane and CSS would split the disc along the intersection. */
  margin-top: calc(${S} * -0.415);
  border-radius: 50%;
  background: radial-gradient(closest-side,
    ${tint('inkDeep', 0.94)} 0%,
    ${tint('inkDeep', 0.86)} 22%,
    ${tint('inkDeep', 0.5)} 42%,
    ${tint('inkDeep', 0.16)} 66%,
    ${tint('inkDeep', 0)} 88%);
  transform: translate3d(0px, 0px, 0px) rotateX(90deg) scale(1);
  transform-origin: 50% 50%;
  opacity: ${SHADOW_ALPHA};
  will-change: transform, opacity;
  pointer-events: none;
}
/* ---- die: the cube; JS writes translate3d/scale3d/rotateZ/rotateX/rotateY -- */
.bd3d-die {
  position: absolute; inset: 0;
  transform-style: preserve-3d;
  will-change: transform;
}
/* ---- face: warm cream, chamfered edge, 3x3 pip grid; placed by data-v ------
   The outer box paints the CHAMFER (a bevel ramp running bevel -> face ->
   shade); ::before paints the flat top surface inset inside it; ::after is the
   glossy sheen. Both pseudo-elements are absolutely positioned, so they take
   no grid cell and the nine pip spans lay out exactly as before. */
.bd3d-face {
  --bd-lit: 152deg;
  /* 1.5% oversize: adjacent faces overlap at every cube edge, so the felt
     never shows through the hairline seam between two quads */
  position: absolute; inset: -1.5%;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
  padding: 14%;
  /* small radius: a big one notches the felt through at every cube edge and
     the die reads as loose plates instead of one solid */
  border-radius: 9%;
  background: linear-gradient(var(--bd-lit),
    ${BEVEL} 0%, ${FACE} 40%, ${FACE} 66%, ${SHADE} 100%);
  box-shadow:
    inset 0 0 0 1px ${tint('railDeep', 0.3)},
    inset 0 0 calc(${S} * 0.1) ${tint('railDeep', 0.1)};
  backface-visibility: hidden;
}
/* the flat top surface inside the chamfer; the ramp between the two IS the
   bevel, so it needs no hard rim of its own */
.bd3d-face::before {
  content: '';
  z-index: 0;
  position: absolute; inset: 6%;
  border-radius: 11%;
  background: linear-gradient(var(--bd-lit),
    ${FACE} 0%, ${FACE} 58%, ${SHADE} 100%);
  box-shadow:
    inset 0 1px 0 ${tint('diceBevel', 0.55)},
    inset 0 calc(${S} * -0.02) calc(${S} * 0.04) ${tint('railDeep', 0.12)};
}
/* specular sheen across the lit corner (above the pips — the die is glossy) */
.bd3d-face::after {
  content: '';
  z-index: 2;
  position: absolute; inset: 0;
  border-radius: 9%;
  background: linear-gradient(var(--bd-lit),
    ${tint('diceBevel', 0.22)} 0%, ${tint('diceBevel', 0)} 40%);
  pointer-events: none;
}
/* Per-face light direction. Neighbouring faces are lit from different angles,
   so every shared edge is a value break — that is what makes the cube read as
   a solid instead of a folded net. */
.bd3d-face[data-v="1"] { --bd-lit: 152deg; }
.bd3d-face[data-v="2"] { --bd-lit: 118deg; }
.bd3d-face[data-v="3"] { --bd-lit: 168deg; }
.bd3d-face[data-v="4"] { --bd-lit: 196deg; }
.bd3d-face[data-v="5"] { --bd-lit: 236deg; }
.bd3d-face[data-v="6"] { --bd-lit: 104deg; }
/* cube placement — translateZ(half size); opposite faces sum to 7 */
.bd3d-face[data-v="1"] { transform: rotateY(0deg) translateZ(calc(${S} / 2)); }
.bd3d-face[data-v="6"] { transform: rotateY(180deg) translateZ(calc(${S} / 2)); }
.bd3d-face[data-v="2"] { transform: rotateY(90deg) translateZ(calc(${S} / 2)); }
.bd3d-face[data-v="5"] { transform: rotateY(-90deg) translateZ(calc(${S} / 2)); }
.bd3d-face[data-v="3"] { transform: rotateX(90deg) translateZ(calc(${S} / 2)); }
.bd3d-face[data-v="4"] { transform: rotateX(-90deg) translateZ(calc(${S} / 2)); }
/* ---- pip: a drilled hole — dark walls, an occluded top, a lit far wall and a
   bright lip on the felt-facing side, so it reads as depth, not as a dot ---- */
.bd3d-pip {
  /* positioned so it paints ABOVE the ::before top surface and BELOW the
     ::after sheen — absolutely positioned pseudo-elements otherwise paint over
     every in-flow grid item, which would hide the pips entirely */
  position: relative; z-index: 1;
  place-self: center;
  width: 66%; height: 66%;
  border-radius: 50%;
  background: radial-gradient(circle at 34% 26%,
    ${tint('dicePip', 0.8)} 0%, ${PIP} 46%, ${PIP_DEEP} 100%);
  box-shadow:
    inset 0 calc(${S} * 0.03) calc(${S} * 0.05) ${tint('dicePipDeep', 0.85)},
    inset 0 calc(${S} * -0.022) calc(${S} * 0.03) ${tint('diceBevel', 0.24)},
    0 calc(${S} * 0.016) 0 ${tint('diceBevel', 0.6)},
    0 0 0 calc(${S} * 0.007) ${tint('dicePipDeep', 0.22)};
  opacity: 0;
}
.bd3d-pip.on { opacity: 1; }
`;
