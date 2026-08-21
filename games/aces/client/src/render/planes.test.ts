// ============================================================================
// ACES — C_FX/planes tests (headless; NO canvas, NO jsdom — vitest runs plain
// node here, mirroring games/rift/client/src/ui/minimap.test.ts's approach):
// the modules are driven through a RECORDING 2D-context stub, so every
// assertion below is about what was actually painted or actually emitted.
//
// Gates implemented (task brief):
//   · §5 part budgets: fill-call counts per class ≥ band minimums,
//     scout < gunship strictly
//   · dead planes never drawn; invuln blink oscillates; soot scales w/ damage
//   · crates render in BOTH phases (falling canopy / landed + foam pulse)
//   · FX pool bound respected under flood (>FX_POOL_MAX particles demanded)
//   · explosion debris within bible band 8–14 for both sizes
//   · consumeShake accumulates then resets to 0 (SMALL/MEDIUM/LARGE mapping)
//   · trail emitter lifecycle: smoke while smoking, stops on null, ≤24 ids
//   · determinism: same seed + same emit sequence ⇒ identical particle dump
//   · §9 color law: every recorded paint string traces to an APAL endpoint
// ============================================================================

import { describe, expect, it } from 'vitest';
import { APAL } from '@aces/shared/palette.js';
import { CRATE_FALL_S, FX_POOL_MAX, SHAKE } from '@aces/shared/config.js';
import type { SnapPlane } from '@aces/shared/protocol.js';
import type { CrateState } from '@aces/shared/types.js';
import { PAL } from '../contract/visual.js';
import { PART_BANDS, drawCrate, drawPlane } from './planes.js';
import { FX, EffectsSystem, createEffects } from './effects.js';

// ---- the recording context ---------------------------------------------------

interface Op {
  readonly op: string;
  readonly a: readonly number[];
  readonly fill: unknown;
  readonly stroke: unknown;
}

class FakeCtx {
  ops: Op[] = [];
  /** Every value ever assigned to globalAlpha (blink/oscillation probe). */
  alphaSets: number[] = [];
  /** createRadialGradient(x0,y0,r0,x1,y1,r1) arg tuples (softPuff probe). */
  grads: number[][] = [];
  private stack: number[] = [];
  private _alpha = 1;

  fillStyle: unknown = '';
  strokeStyle: unknown = '';
  lineWidth = 1;

  get globalAlpha(): number {
    return this._alpha;
  }
  set globalAlpha(v: number) {
    this._alpha = v;
    this.alphaSets.push(v);
  }

  private rec(op: string, ...a: number[]): void {
    this.ops.push({ op, a, fill: this.fillStyle, stroke: this.strokeStyle });
  }
  save(): void {
    this.stack.push(this._alpha);
    this.rec('save');
  }
  restore(): void {
    this._alpha = this.stack.pop() ?? 1;
    this.rec('restore');
  }
  translate(x: number, y: number): void {
    this.rec('translate', x, y);
  }
  rotate(a: number): void {
    this.rec('rotate', a);
  }
  beginPath(): void {
    this.rec('beginPath');
  }
  closePath(): void {
    this.rec('closePath');
  }
  moveTo(x: number, y: number): void {
    this.rec('moveTo', x, y);
  }
  lineTo(x: number, y: number): void {
    this.rec('lineTo', x, y);
  }
  arc(x: number, y: number, r: number, a0 = 0, a1 = Math.PI * 2): void {
    this.rec('arc', x, y, r, a0, a1);
  }
  fill(): void {
    this.rec('fill');
  }
  stroke(): void {
    this.rec('stroke');
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rec('fillRect', x, y, w, h);
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): {
    addColorStop(): void;
  } {
    this.grads.push([x0, y0, r0, x1, y1, r1]);
    return { addColorStop(): void {} };
  }

  count(op: string): number {
    return this.ops.reduce((n, o) => (o.op === op ? n + 1 : n), 0);
  }
  clear(): void {
    this.ops.length = 0;
    this.grads.length = 0;
    this.alphaSets.length = 0;
  }
}

const asCtx = (f: FakeCtx): CanvasRenderingContext2D => f as unknown as CanvasRenderingContext2D;

// ---- fixtures -------------------------------------------------------------------

function snap(o: Partial<SnapPlane> = {}): SnapPlane {
  return {
    id: 'p-test',
    name: 'Test Pilot',
    team: 'royal',
    cls: 'scout',
    bot: true,
    x: 500,
    y: 500,
    h: 0,
    sp: 150,
    vx: 150,
    vy: 0,
    hp: 100,
    maxHp: 100,
    heat: 0,
    jammed: false,
    boost: 100,
    boosting: false,
    throttle: 1,
    invulnT: 0,
    dead: false,
    streak: 0,
    seq: 0,
    ...o,
  };
}

function crate(o: Partial<CrateState> = {}): CrateState {
  return { id: 7, x: -300, y: 220, phase: 'fall', t: CRATE_FALL_S, ...o };
}

const DT = 1 / 60;

// ---- airframes ------------------------------------------------------------------

describe('drawPlane — §5 silhouette part budgets (fill calls per class)', () => {
  const MINS: Record<string, number> = { scout: 10, fighter: 12, gunship: 16 };

  for (const team of ['royal', 'iron'] as const) {
    it(`${team}: every class paints at least its band minimum; scout < gunship`, () => {
      const counts: Record<string, number> = {};
      for (const cls of ['scout', 'fighter', 'gunship'] as const) {
        const ctx = new FakeCtx();
        drawPlane(asCtx(ctx), snap({ cls, team, h: 0.7 }), 1.234);
        const fills = ctx.count('fill');
        expect(fills).toBeGreaterThanOrEqual(MINS[cls]!);
        expect(fills).toBeGreaterThanOrEqual(PART_BANDS[cls][0]);
        counts[cls] = fills;
      }
      // The gunship is the WIDE one: strictly more painted shapes than the
      // stubby scout, both teams, no exceptions.
      expect(counts.scout!).toBeLessThan(counts.gunship!);
    });
  }
});

describe('drawPlane — state law', () => {
  it('dead planes are NEVER drawn (wreck belongs to effects)', () => {
    const ctx = new FakeCtx();
    drawPlane(asCtx(ctx), snap({ dead: true }), 1);
    expect(ctx.ops.length).toBe(0);
  });

  it('invulnT > 0 blinks via globalAlpha oscillation; healthy never touches alpha', () => {
    const blink = new FakeCtx();
    drawPlane(asCtx(blink), snap({ invulnT: 1.5 }), 0.31);
    expect(blink.alphaSets.length).toBeGreaterThan(0);
    expect(Math.min(...blink.alphaSets)).toBeLessThan(1);

    const solid = new FakeCtx();
    drawPlane(asCtx(solid), snap({}), 0.31);
    expect(solid.alphaSets.length).toBe(0);
  });

  it('damage soot overlay scales with missing HP; healthy paints no gradient', () => {
    const clean = new FakeCtx();
    drawPlane(asCtx(clean), snap({ hp: 100, maxHp: 100 }), 2);
    expect(clean.grads.length).toBe(0); // softPuff only fires once damaged

    const hurt = new FakeCtx();
    drawPlane(asCtx(hurt), snap({ hp: 70, maxHp: 100 }), 2);
    const wrecked = new FakeCtx();
    drawPlane(asCtx(wrecked), snap({ hp: 25, maxHp: 100 }), 2);
    expect(hurt.grads.length).toBeGreaterThan(0);
    expect(wrecked.grads.length).toBeGreaterThan(0);
    // softPuff's outer radius is grads[i][5]; worse damage ⇒ bigger stain.
    const rOf = (c: FakeCtx): number => Math.max(...c.grads.map((g) => g[5]!));
    expect(rOf(wrecked)).toBeGreaterThan(rOf(hurt));
  });

  it('control-surface memory: a heading-change sample engages the tail group', () => {
    const id = 'tilt-probe';
    const steady = new FakeCtx();
    drawPlane(asCtx(steady), snap({ id, h: 0 }), 0);
    expect(steady.count('rotate')).toBe(1); // just the heading

    const turning = new FakeCtx();
    drawPlane(asCtx(turning), snap({ id, h: 0.5 }), DT);
    expect(turning.count('rotate')).toBeGreaterThan(1); // + tilted tail pivot
  });
});

describe('drawCrate — entity phases', () => {
  it('FALL paints the parachute descent: canopy arcs + wood rope strokes', () => {
    const ctx = new FakeCtx();
    drawCrate(asCtx(ctx), crate({ phase: 'fall', t: CRATE_FALL_S * 0.5 }), 3.3);
    expect(ctx.count('fill')).toBeGreaterThan(3); // shadow + canopy ×2 + box
    expect(ctx.count('arc')).toBeGreaterThan(0); // canopy dome
    expect(ctx.count('stroke')).toBeGreaterThan(0); // gores + ropes
  });

  it('ACTIVE paints the landed crate with tire straps and a foam pulse ring', () => {
    const ctx = new FakeCtx();
    drawCrate(asCtx(ctx), crate({ phase: 'active', t: 10 }), 8.8);
    expect(ctx.count('fill')).toBeGreaterThan(3);
    const strapFill = ctx.ops.some((o) => o.op === 'fill' && o.fill === PAL.tire);
    expect(strapFill).toBe(true); // §9: straps trace straight to APAL
    expect(ctx.count('arc')).toBeGreaterThan(0); // foam ring oscillation
  });
});

// ---- effects system -------------------------------------------------------------

describe('effects pool bound (flood law)', () => {
  it('demanding far more than FX_POOL_MAX particles never exceeds the cap', () => {
    const fx = createEffects(9) as EffectsSystem;
    for (let i = 0; i < 60; i++) {
      fx.explosion((i * 137) % 4000, (i * 271) % 3000, i % 2 ? 'large' : 'small', i % 3 === 0);
      fx.update(DT);
      expect(fx.alive).toBeLessThanOrEqual(FX_POOL_MAX);
    }
    // Prove the cap actually BINDS (not merely that tests were lucky):
    let saturated = false;
    for (let i = 0; i < 40 && !saturated; i++) {
      fx.explosion(10, 10, 'large', true);
      if (fx.alive === FX_POOL_MAX) saturated = true;
    }
    expect(saturated).toBe(true);
  });
});

describe('explosion composition (bible §7 band)', () => {
  it('emits 8–14 debris shards for BOTH sizes into an empty pool', () => {
    for (const size of ['small', 'large'] as const) {
      const fx = createEffects(21) as EffectsSystem;
      fx.explosion(1000, 1000, size, false);
      const shards = fx.kindCount(FX.SHARD);
      expect(shards).toBeGreaterThanOrEqual(8);
      expect(shards).toBeLessThanOrEqual(14);
      expect(fx.alive).toBeGreaterThan(shards); // bloom + smoke came along
    }
  });

  it('overWater adds the foam splash ring on top of the standard blast', () => {
    const dry = createEffects(5) as EffectsSystem;
    dry.explosion(0, 0, 'small', false);
    const wet = createEffects(5) as EffectsSystem;
    wet.explosion(0, 0, 'small', true);
    expect(wet.alive).toBeGreaterThan(dry.alive);
  });
});

describe('consumeShake — accumulate then reset to 0', () => {
  it('maps hitSpark→SMALL, small blast→MEDIUM, large blast→LARGE', () => {
    const fx = createEffects(11) as EffectsSystem;
    expect(fx.consumeShake()).toBe(0);

    fx.hitSpark(0, 0, 0);
    fx.hitSpark(5, 5, 1);
    expect(fx.consumeShake()).toBe(SHAKE.SMALL * 2);
    expect(fx.consumeShake()).toBe(0); // consumed ⇒ reset

    fx.explosion(0, 0, 'small', false);
    expect(fx.consumeShake()).toBe(SHAKE.MEDIUM);
    fx.explosion(0, 0, 'large', false);
    expect(fx.consumeShake()).toBe(SHAKE.LARGE);
    expect(fx.consumeShake()).toBe(0);
  });
});

describe('event particle budgets', () => {
  it('muzzleFlash = starburst + smoke wisp; tracerStub = exactly one streak', () => {
    const fx = createEffects(13) as EffectsSystem;
    fx.muzzleFlash(10, 20, 0.4);
    expect(fx.alive).toBe(2);
    expect(fx.kindCount(FX.STAR)).toBe(1);
    fx.tracerStub(30, 30, 2);
    expect(fx.kindCount(FX.STREAK)).toBe(1);
  });

  it('hitSpark answers with spark tick + ink chips; crateFx emits for both kinds', () => {
    const fx = createEffects(15) as EffectsSystem;
    fx.hitSpark(0, 0, 0.2);
    expect(fx.alive).toBeGreaterThanOrEqual(4); // star + streak + ≥2 chips
    expect(fx.kindCount(FX.SHARD)).toBeGreaterThanOrEqual(2);
    fx.crateFx('land', 50, 50);
    fx.crateFx('pickup', 60, 60);
    expect(fx.alive).toBeGreaterThan(10);
  });
});

describe('trail emitter lifecycle', () => {
  it('smokes while smoking, stops and fully clears after null', () => {
    const fx = createEffects(17) as EffectsSystem;
    let aliveWhileSmoking = 0;
    for (let k = 0; k < 90; k++) {
      fx.trail('ace-1', 400 + k, 400, 'smoke');
      fx.update(DT);
      aliveWhileSmoking = Math.max(aliveWhileSmoking, fx.alive);
    }
    expect(aliveWhileSmoking).toBeGreaterThan(4); // puffs actually emitted

    fx.trail('ace-1', 500, 500, null); // stop
    for (let k = 0; k < 120; k++) fx.update(DT); // > max smoke ttl (~1.6 s)
    expect(fx.alive).toBe(0);
  });

  it('fire trails emit embers; emitter map stays ≤24 under id churn', () => {
    const fx = createEffects(19) as EffectsSystem;
    for (let i = 0; i < 30; i++) fx.trail(`plane-${i}`, i * 10, 0, i % 2 ? 'smoke' : 'fire');
    expect(fx.emitterCount).toBeLessThanOrEqual(24);
    for (let k = 0; k < 30; k++) fx.update(DT);
    expect(fx.kindCount(FX.EMBER)).toBeGreaterThan(0); // fire lanes burn
  });
});

describe('determinism — same seed + same sequence ⇒ identical particles', () => {
  const script = (seed: number): number[] => {
    const fx = createEffects(seed) as EffectsSystem;
    fx.explosion(1000, 800, 'large', true);
    fx.hitSpark(600, 620, 0.6);
    fx.muzzleFlash(700, 700, 1.1);
    fx.tracerStub(200, 300, 2.5);
    fx.crateFx('land', 1500, 900);
    fx.trail('d1', 300, 300, 'smoke');
    fx.trail('d2', 350, 300, 'fire');
    for (let k = 0; k < 45; k++) {
      fx.trail('d1', 300 + k * 3, 300 + (k % 5), 'smoke');
      fx.trail('d2', 350 + k * 3, 300, 'fire');
      fx.update(DT);
    }
    fx.trail('d2', 0, 0, null);
    for (let k = 0; k < 30; k++) fx.update(DT);
    return fx.debugDump();
  };

  it('two systems on the same seed produce identical dumps', () => {
    expect(script(4242)).toEqual(script(4242));
  });

  it('a different seed moves the ink somewhere else', () => {
    expect(script(4242)).not.toEqual(script(4243));
  });
});

describe('drawProjectiles — quantized amber tracers', () => {
  it('paints from a tiny precomputed style set only (no per-bullet color math)', () => {
    const ctx = new FakeCtx();
    const bullets = Array.from({ length: 90 }, (_, i) => ({
      x: i * 7,
      y: i * 3,
      vx: 500 + ((i * 37) % 500),
      vy: -200 + ((i * 53) % 400),
    }));
    (createEffects(23) as EffectsSystem).drawProjectiles(asCtx(ctx), bullets);
    expect(ctx.count('stroke')).toBeGreaterThan(100); // halo + core per bullet
    const styles = new Set(
      ctx.ops.flatMap((o) => [typeof o.fill === 'string' ? o.fill : '', typeof o.stroke === 'string' ? o.stroke : '']),
    );
    styles.delete('');
    // Quantization law: ≤4 distinct tracer styles across 90 varied bullets.
    expect(styles.size).toBeLessThanOrEqual(4);
    for (const s of styles) expect(s.startsWith(PAL.tracer.slice(0, 7))).toBe(true); // §9
  });
});

// ---- §9 ad-hoc-hex guard ----------------------------------------------------------

describe('palette law — every recorded paint string traces to APAL', () => {
  it('planes + crates never invent a hex', () => {
    const ctx = new FakeCtx();
    for (const cls of ['scout', 'fighter', 'gunship'] as const) {
      for (const team of ['royal', 'iron'] as const) {
        for (const dmg of [100, 60, 20]) {
          drawPlane(asCtx(ctx), snap({ cls, team, hp: dmg, maxHp: 100, h: 1.9 }), 4.2);
          drawCrate(asCtx(ctx), crate({ phase: dmg > 50 ? 'fall' : 'active' }), 4.2);
        }
      }
    }
    const apalHexes = Object.values(APAL);
    const seen = new Set<string>();
    for (const o of ctx.ops) {
      // Audit only ops that actually PUT INK — path-building calls legitimately
      // run with the context's unset ('') style.
      if (o.op !== 'fill' && o.op !== 'stroke' && o.op !== 'fillRect') continue;
      for (const v of [o.fill, o.stroke]) {
        if (typeof v !== 'string' || v === '') continue; // gradient objects exempt
        seen.add(v);
      }
    }
    expect(seen.size).toBeGreaterThan(6); // we really exercised many styles
    for (const s of seen) {
      const ok =
        s.startsWith('rgb(') || // shadeA/mixA derivation form
        apalHexes.some((hex) => s.startsWith(hex)); // raw key or #rrggbbaa suffix
      expect(ok).toBe(true);
    }
  });
});

