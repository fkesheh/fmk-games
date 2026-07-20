// ============================================================================
// BANK — dice view. Two DOM dice (CSS grid pips, no canvas/three.js) with a
// tumble-then-settle roll animation. rollTo() cycles cosmetic faces (~70ms,
// hashed from the frame clock — never Math.random) for durationMs, then
// settles deterministically on (d1, d2) with a slight per-settle tilt.
// Styling lives in the injected <style> block below (style.css is another
// task's file — not touched). Self-contained: zero imports.
// ============================================================================

const STYLE_ID = 'bank-dice-style';
const ROLL_DEFAULT_MS = 600;
const TICK_MS = 70; // cosmetic face cadence during the tumble

// Pip cells lit per face value (3x3 grid, row-major indices 0..8).
const PIPS: readonly (readonly number[])[] = [
  [],                    // 0 — unused
  [4],                   // 1
  [0, 8],                // 2
  [0, 4, 8],             // 3
  [0, 2, 6, 8],          // 4
  [0, 2, 4, 6, 8],       // 5
  [0, 2, 3, 5, 6, 8],    // 6
];

interface Die {
  wrap: HTMLElement;    // carries the settle tilt (transform)
  face: HTMLElement;    // white die body + pip grid; carries the tumble animation
  pips: HTMLElement[];  // 9 cells, always in the DOM (layout-stable), toggled by class
}

/** Clamp to a valid d6 face (defensive; the server always sends 1..6). */
function norm(v: number): number {
  return Math.min(6, Math.max(1, Math.round(v)));
}

/** Pseudo-random-looking face (1..6) from the tumble tick — cosmetic only. */
function scramble(tick: number, die: number): number {
  let h = Math.imul(tick + 1, 2654435761) ^ Math.imul(die + 1, 40503);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return 1 + ((h >>> 0) % 6);
}

/** Small deterministic tilt in degrees (-9..9); varies per settle + per die. */
function tilt(d1: number, d2: number, settles: number, die: number): number {
  return ((d1 * 7 + d2 * 13 + settles * 29 + die * 41) % 19) - 9;
}

function buildDie(): Die {
  const wrap = document.createElement('div');
  wrap.className = 'bd-die';
  const face = document.createElement('div');
  face.className = 'bd-face';
  const pips: HTMLElement[] = [];
  for (let i = 0; i < 9; i++) {
    const pip = document.createElement('span');
    pip.className = 'bd-pip';
    face.appendChild(pip);
    pips.push(pip);
  }
  wrap.appendChild(face);
  return { wrap, face, pips };
}

function paint(die: Die, v: number): void {
  const lit = PIPS[v] ?? [];
  let i = 0;
  for (const pip of die.pips) {
    pip.classList.toggle('on', lit.includes(i));
    i += 1;
  }
}

export class DiceView {
  private readonly dice: [Die, Die];
  private shown: [number, number] = [1, 1];
  private settles = 0;                    // deterministic tilt varies per settle
  private raf = 0;                        // in-flight tumble frame handle
  private done: (() => void) | null = null; // resolve of the in-flight roll

  constructor(container: HTMLElement) {
    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const root = document.createElement('div');
    root.className = 'bd-dice';
    this.dice = [buildDie(), buildDie()];
    root.append(this.dice[0].wrap, this.dice[1].wrap);
    container.appendChild(root);
    this.show(1, 1);
  }

  /** Currently displayed faces (cosmetic mid-tumble; (d1, d2) once settled). */
  faces(): [number, number] {
    return [this.shown[0], this.shown[1]];
  }

  /**
   * Tumble for durationMs (faces cycling every ~70ms + shake), then settle on
   * (d1, d2) and resolve. A new rollTo() supersedes one in flight: its promise
   * resolves immediately and the new roll takes over.
   */
  rollTo(d1: number, d2: number, durationMs: number = ROLL_DEFAULT_MS): Promise<void> {
    this.endRoll(); // supersede any in-flight roll
    this.dice[0].face.classList.add('bd-rolling');
    this.dice[1].face.classList.add('bd-rolling');
    const start = performance.now();
    let lastTick = -1;
    return new Promise<void>((resolve) => {
      this.done = resolve;
      const frame = (now: number): void => {
        const elapsed = now - start;
        if (elapsed >= durationMs) {
          this.settle(norm(d1), norm(d2));
          this.endRoll();
          return;
        }
        const tick = Math.floor(elapsed / TICK_MS);
        if (tick !== lastTick) {
          lastTick = tick;
          this.show(scramble(tick, 0), scramble(tick, 1));
        }
        this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
    });
  }

  private show(d1: number, d2: number): void {
    this.shown = [d1, d2];
    paint(this.dice[0], d1);
    paint(this.dice[1], d2);
  }

  private settle(d1: number, d2: number): void {
    this.settles += 1;
    this.show(d1, d2);
    this.dice[0].wrap.style.transform = `rotate(${tilt(d1, d2, this.settles, 0)}deg)`;
    this.dice[1].wrap.style.transform = `rotate(${tilt(d1, d2, this.settles, 1)}deg)`;
  }

  /** Stop the tumble (if any), drop the shake class, resolve its promise. */
  private endRoll(): void {
    if (this.done === null) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dice[0].face.classList.remove('bd-rolling');
    this.dice[1].face.classList.remove('bd-rolling');
    const done = this.done;
    this.done = null;
    done();
  }
}

const CSS = `
.bd-dice, .bd-dice * { box-sizing: border-box; margin: 0; padding: 0; }
.bd-dice {
  display: flex; align-items: center; justify-content: center;
  gap: calc(var(--bd-size, 64px) * 0.28);
}
/* ---- die wrapper: settle tilt (inline transform), eased in ---------------- */
.bd-die { transition: transform 160ms ease-out; }
/* ---- die body: white rounded square, subtle shadow, 3x3 pip grid --------- */
.bd-face {
  width: var(--bd-size, 64px); height: var(--bd-size, 64px);
  display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr);
  padding: 12%;
  background: linear-gradient(145deg, #ffffff 0%, #efece4 100%);
  border: 1px solid rgba(0, 0, 0, 0.18);
  border-radius: 14%;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.9);
}
.bd-pip {
  place-self: center; width: 72%; height: 72%; border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #3a3a42, #141418);
  opacity: 0; transform: scale(0.3);
  transition: opacity 80ms linear, transform 80ms linear;
}
.bd-pip.on { opacity: 1; transform: scale(1); }
/* ---- tumble: small shake/translate while faces cycle ---------------------- */
.bd-face.bd-rolling { animation: bd-tumble 150ms linear infinite; }
@keyframes bd-tumble {
  0%   { transform: translate(0, 0) rotate(0deg); }
  25%  { transform: translate(-4%, 3%) rotate(-16deg); }
  50%  { transform: translate(4%, -4%) rotate(12deg); }
  75%  { transform: translate(-3%, -3%) rotate(-8deg); }
  100% { transform: translate(0, 0) rotate(0deg); }
}
`;
