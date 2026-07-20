// ============================================================================
// BANK — dice view. Two TRUE CSS 3D dice: six-faced cubes (real 3x3 pip
// layouts, opposite faces sum to 7: 1/6, 2/5, 3/4) thrown with a bouncing
// drop arc, a multi-axis tumble that decelerates cubic-out onto the rolled
// faces, and a small settle rock. rollTo() drives both dice concurrently from
// a single rAF loop writing transforms only (no layout reads, no forced
// reflows). Every per-roll variation (spin counts, spin directions, arc
// height, lateral offset, rock angle) comes from a seeded stream
// (@platform/shared rng, seeded from a private roll counter) — never
// Math.random. Styling lives in the injected <style> block below (style.css
// is another task's file — not touched). Die size: --bd-size (default 64px).
// ============================================================================

import { rng, rngInt, rngRange } from '@platform/shared';

const STYLE_ID = 'bank-dice-style';
const ROLL_DEFAULT_MS = 900;
const ROCK_START = 0.88; // settle rock occupies the last 12% of the roll

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
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeOutQuad = (t: number): number => 1 - (1 - t) * (1 - t);
const easeInQuad = (t: number): number => t * t;

/**
 * Throw arc, px (negative = up): hop to the apex with a decelerating rise,
 * accelerate back down (fast in), one softer bounce, then rest on the felt.
 */
function arcY(t: number, height: number, bounce2: number): number {
  if (t < 0.3) return -height * easeOutQuad(t / 0.3);
  if (t < 0.55) return -height * (1 - easeInQuad((t - 0.3) / 0.25));
  if (t < 0.7) return -height * bounce2 * easeOutQuad((t - 0.55) / 0.15);
  if (t < 0.82) return -height * bounce2 * (1 - easeInQuad((t - 0.7) / 0.12));
  return 0;
}

/** Settle rock: one damped oscillation (±amp deg) over the last 12%. */
function rockAt(t: number, amp: number): number {
  if (t < ROCK_START) return 0;
  const u = (t - ROCK_START) / (1 - ROCK_START);
  return amp * Math.sin(u * Math.PI * 2) * (1 - u);
}

interface DieState {
  el: HTMLElement; // .bd3d-die — the cube; its transform is written per frame
  rx: number;      // last written orientation (continuity across superseded rolls)
  ry: number;
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
  height: number;  // throw apex, px (60..100)
  bounce2: number; // second bounce height factor (0.32..0.42)
  lateral: number; // starting sideways offset, px (±10..26)
  rock: number;    // settle rock amplitude, deg (±3..4)
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
    height: rngRange(next, 60, 100),
    bounce2: rngRange(next, 0.32, 0.42),
    lateral: rngRange(next, 10, 26) * (next() < 0.5 ? 1 : -1),
    rock: rngRange(next, 3, 4) * (next() < 0.5 ? 1 : -1),
  };
}

function buildDie(): DieState {
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
  // rest pose: face 1 on top (targetFor(1) = {x:90, y:0})
  return { el, rx: 90, ry: 0 };
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
    row.append(this.dice[0].el, this.dice[1].el);
    scene.appendChild(row);
    container.appendChild(scene);
    this.write(this.dice[0], 0, 0);
    this.write(this.dice[1], 0, 0);
  }

  /** The values the dice have settled on (the in-flight roll's target, if any). */
  faces(): [number, number] {
    return [this.settled[0], this.settled[1]];
  }

  /**
   * Throw both dice: a bouncing drop arc with a slight lateral drift while
   * they tumble 2–4 full turns per axis (different counts per die),
   * decelerating cubic-out onto (d1, d2) with a tiny settle rock. Resolves
   * once settled. durationMs <= 0 snaps instantly. A new rollTo() supersedes
   * one in flight: its promise resolves immediately and the new roll takes
   * over from the current mid-tumble orientation.
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

  /** Write one frame of the throw: rotation + rock, drop arc, lateral drift. */
  private apply(die: DieState, p: RollPlan, t: number): void {
    const e = easeOutCubic(t);
    die.rx = p.fromX + p.deltaX * e + rockAt(t, p.rock);
    die.ry = p.fromY + p.deltaY * e;
    this.write(die, p.lateral * (1 - e), arcY(t, p.height, p.bounce2));
  }

  /** Snap a die to its exact landing Euler (normalized to keep angles small). */
  private land(die: DieState, p: RollPlan): void {
    die.rx = norm360(p.endX);
    die.ry = norm360(p.endY);
    this.write(die, 0, 0);
  }

  private write(die: DieState, x: number, y: number): void {
    die.el.style.transform =
      `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0px) ` +
      `rotateX(${die.rx.toFixed(2)}deg) rotateY(${die.ry.toFixed(2)}deg)`;
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

const CSS = `
.bd3d-dice, .bd3d-dice * { box-sizing: border-box; margin: 0; padding: 0; }
/* ---- scene: perspective for the 3D; the row carries a static tilt so the
   top face of each resting die reads (dice on a table, seen from above) ---- */
.bd3d-dice { display: flex; justify-content: center; perspective: 700px; }
.bd3d-row {
  display: flex; align-items: center; justify-content: center;
  gap: calc(var(--bd-size, 64px) * 0.55);
  transform: rotateX(-22deg);
  transform-style: preserve-3d;
}
/* ---- die: the cube; JS writes translate3d(...) rotateX(...) rotateY(...) -- */
.bd3d-die {
  position: relative;
  width: var(--bd-size, 64px); height: var(--bd-size, 64px);
  transform-style: preserve-3d;
  will-change: transform;
}
/* ---- face: white rounded square with a 3x3 pip grid; placed by data-v ---- */
.bd3d-face {
  position: absolute; inset: 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
  padding: 13%;
  border: 1px solid rgba(0, 0, 0, 0.16);
  border-radius: 14%;
  background: linear-gradient(145deg, #ffffff 0%, #f1ede4 100%);
  box-shadow: inset 0 0 calc(var(--bd-size, 64px) * 0.1) rgba(0, 0, 0, 0.12);
  backface-visibility: hidden;
}
/* subtle bevel shading — the sides sit a touch darker than the bright faces */
.bd3d-face[data-v="3"], .bd3d-face[data-v="4"] { background: linear-gradient(145deg, #fcfaf5 0%, #ede9dd 100%); }
.bd3d-face[data-v="2"], .bd3d-face[data-v="5"] { background: linear-gradient(145deg, #f8f6f0 0%, #e9e5d9 100%); }
.bd3d-face[data-v="6"] { background: linear-gradient(145deg, #f6f4ee 0%, #e5e1d5 100%); }
/* cube placement — translateZ(half size); opposite faces sum to 7 */
.bd3d-face[data-v="1"] { transform: rotateY(0deg) translateZ(calc(var(--bd-size, 64px) / 2)); }
.bd3d-face[data-v="6"] { transform: rotateY(180deg) translateZ(calc(var(--bd-size, 64px) / 2)); }
.bd3d-face[data-v="2"] { transform: rotateY(90deg) translateZ(calc(var(--bd-size, 64px) / 2)); }
.bd3d-face[data-v="5"] { transform: rotateY(-90deg) translateZ(calc(var(--bd-size, 64px) / 2)); }
.bd3d-face[data-v="3"] { transform: rotateX(90deg) translateZ(calc(var(--bd-size, 64px) / 2)); }
.bd3d-face[data-v="4"] { transform: rotateX(-90deg) translateZ(calc(var(--bd-size, 64px) / 2)); }
/* ---- pip: drilled dark dot ----------------------------------------------- */
.bd3d-pip {
  place-self: center;
  width: 68%; height: 68%;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #494952 0%, #15151a 70%);
  box-shadow:
    inset 0 calc(var(--bd-size, 64px) * 0.02) calc(var(--bd-size, 64px) * 0.04) rgba(0, 0, 0, 0.7);
  opacity: 0;
}
.bd3d-pip.on { opacity: 1; }
`;
