// ============================================================================
// C3 — SKI SPLAT HUD suite. This workspace has no jsdom, so (mirroring the
// rift hud.test.ts pattern) the suite installs a small deliberate DOM double
// below and drives the real SplatHud through it. The double implements only
// what hud.ts touches — elements, classList, guarded style/text writes, a
// recording 2D canvas context, window listeners/timers and localStorage; it
// is not a DOM, and layout/cascade/paint are not faked here.
//
// Every test names the UX_BIBLE / CONTRACT §7a rule it pins.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SKIER_COLORS, SKIER_GLYPHS, SPAL } from '@splat/shared';

import type { HudRacer, HudState } from './hud.js';

// ---------------------------------------------------------------------------
// The DOM double
// ---------------------------------------------------------------------------

interface Timer {
  readonly id: number;
  readonly fn: () => void;
  readonly ms: number;
}

const timers: Timer[] = [];
let timerSeq = 0;
let nowMs = 1000;

const winHandlers = new Map<string, Array<() => void>>();

const store = new Map<string, string>();

/** Recording 2D context: every op lands in `ops` as a compact string so tests
 *  can assert WHAT was drawn (all racers, colours, the white rim) and WHEN
 *  (the <= 4 Hz schedule) without a real canvas. */
class CtxDouble {
  readonly ops: string[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  scale(x: number, y: number): void {
    this.ops.push(`scale:${x},${y}`);
  }
  clearRect(): void {
    this.ops.push('clear');
  }
  beginPath(): void {
    this.ops.push('begin');
  }
  moveTo(x: number, y: number): void {
    this.ops.push(`move:${x},${y}`);
  }
  lineTo(x: number, y: number): void {
    this.ops.push(`line:${x},${y}`);
  }
  arc(x: number, y: number, r: number): void {
    this.ops.push(`arc:${x},${y},${r}`);
  }
  stroke(): void {
    this.ops.push(`stroke:${this.strokeStyle}`);
  }
  fill(): void {
    this.ops.push(`fill:${this.fillStyle}`);
  }
}

class El {
  className = '';
  readonly childNodes: El[] = [];
  parentNode: El | null = null;
  private text = '';

  /** Write counters: a write is counted only when it CHANGES the value, which
   *  is what a MutationObserver over the subtree would report — the metric
   *  the "no per-frame DOM writes" rule is actually about. */
  textWrites = 0;
  classWrites = 0;
  readonly styleWrites: string[] = [];
  readonly style: Record<string, string>;

  constructor(readonly tagName: string) {
    const own: Record<string, string> = {};
    this.style = new Proxy(own, {
      set: (t, k, v: unknown) => {
        const key = String(k);
        const val = String(v);
        if (t[key] !== val) {
          this.styleWrites.push(`${key}=${val}`);
          t[key] = val;
        }
        return true;
      },
    });
  }

  private names(): string[] {
    return this.className.split(/\s+/).filter((s) => s !== '');
  }

  readonly classList = {
    add: (c: string): void => {
      if (!this.classList.contains(c)) {
        this.classWrites += 1;
        this.className = `${this.className} ${c}`.trim();
      }
    },
    remove: (c: string): void => {
      if (this.classList.contains(c)) {
        this.classWrites += 1;
        this.className = this.names().filter((n) => n !== c).join(' ');
      }
    },
    contains: (c: string): boolean => this.names().includes(c),
    toggle: (c: string, force?: boolean): void => {
      const on = force ?? !this.classList.contains(c);
      if (on) this.classList.add(c);
      else this.classList.remove(c);
    },
  };

  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    if (this.text !== v) this.textWrites += 1;
    this.text = v;
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes.length = 0;
  }

  appendChild(c: El): El {
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  removeChild(c: El): void {
    const at = this.childNodes.indexOf(c);
    if (at >= 0) this.childNodes.splice(at, 1);
    c.parentNode = null;
  }

  /** Depth-first walk of descendants, for assertions about what rendered. */
  *walk(): Generator<El> {
    for (const c of this.childNodes) {
      yield c;
      yield* c.walk();
    }
  }
}

class CanvasEl extends El {
  width = 0;
  height = 0;
  readonly ctx = new CtxDouble();
  constructor() {
    super('canvas');
  }
  getContext(kind: string): CtxDouble | null {
    return kind === '2d' ? this.ctx : null;
  }
}

function installDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { createElement: (tag: string) => (tag === 'canvas' ? new CanvasEl() : new El(tag)) };
  g.window = {
    addEventListener: (type: string, fn: () => void): void => {
      const list = winHandlers.get(type) ?? [];
      list.push(fn);
      winHandlers.set(type, list);
    },
    removeEventListener: (type: string, fn: () => void): void => {
      const list = winHandlers.get(type) ?? [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    setTimeout: (fn: () => void, ms: number): number => {
      timerSeq += 1;
      timers.push({ id: timerSeq, fn, ms });
      return timerSeq;
    },
    clearTimeout: (id: number): void => {
      const at = timers.findIndex((t) => t.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
  };
  g.localStorage = {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      store.set(k, v);
    },
    removeItem: (k: string): void => {
      store.delete(k);
    },
  };
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
}
installDom();

const { SplatHud } = await import('./hud.js');

// ---- fixtures ---------------------------------------------------------------

function racer(slot: number, z: number, over: Partial<HudRacer> = {}): HudRacer {
  return { slot, z, finished: false, finishMs: 0, ...over };
}

function state(over: Partial<HudState> = {}): HudState {
  const you = racer(0, 300);
  return {
    phase: 'racing',
    countdown: 0,
    speedKmh: 40,
    place: 2,
    total: 3,
    you,
    racers: [you, racer(1, 350), racer(2, 250)],
    results: null,
    colorFor: (slot) => SKIER_COLORS[slot] ?? '#000000',
    glyphFor: (slot) => SKIER_GLYPHS[slot] ?? '?',
    ...over,
  };
}

function mk(): { hud: InstanceType<typeof SplatHud>; root: El } {
  const parent = new El('div');
  const hud = new SplatHud(parent as unknown as HTMLElement);
  return { hud, root: hud.root as unknown as El };
}

// ---- find helpers -----------------------------------------------------------

function find(root: El, pred: (e: El) => boolean): El | null {
  if (pred(root)) return root;
  for (const e of root.walk()) if (pred(e)) return e;
  return null;
}
function findAll(root: El, pred: (e: El) => boolean): El[] {
  const out: El[] = [];
  if (pred(root)) out.push(root);
  for (const e of root.walk()) if (pred(e)) out.push(e);
  return out;
}
const hasClass = (e: El, cls: string): boolean => e.className.split(/\s+/).includes(cls);
const byClass = (root: El, cls: string): El | null => find(root, (e) => hasClass(e, cls));
const allByClass = (root: El, cls: string): El[] => findAll(root, (e) => hasClass(e, cls));
const railCanvas = (root: El): CanvasEl => {
  const c = find(root, (e) => e instanceof CanvasEl);
  if (c === null) throw new Error('no rail canvas');
  return c as CanvasEl;
};
/** Every text leaf under root, joined — the "no shame words" net. */
function allText(root: El): string {
  return [root.textContent, ...[...root.walk()].map((e) => e.textContent)].join(' | ');
}

beforeEach(() => {
  timers.length = 0;
  winHandlers.clear();
  store.clear();
  nowMs = 1000;
});

// ---- (1) place chip ---------------------------------------------------------

describe('place chip (UX_BIBLE hierarchy #2: ordinal text, slot colour, crown)', () => {
  it('shows the ordinal as TEXT in your slot colour — never colour alone', () => {
    const { hud, root } = mk();
    hud.render(state({ place: 2 }));
    const num = byClass(root, 'sh-place-num');
    expect(num?.textContent).toBe('2nd');
    expect(num?.style.color).toBe(SKIER_COLORS[0]);
    // 2nd place: no crown
    expect(byClass(root, 'sh-crown')?.classList.contains('hidden')).toBe(true);
  });

  it('toggles the crown exactly at 1st place, and updates the ordinal in place', () => {
    const { hud, root } = mk();
    hud.render(state({ place: 3 }));
    expect(byClass(root, 'sh-place-num')?.textContent).toBe('3rd');
    expect(byClass(root, 'sh-crown')?.classList.contains('hidden')).toBe(true);

    hud.render(state({ place: 1 }));
    expect(byClass(root, 'sh-place-num')?.textContent).toBe('1st');
    expect(byClass(root, 'sh-crown')?.classList.contains('hidden')).toBe(false);

    hud.render(state({ place: 2 }));
    expect(byClass(root, 'sh-crown')?.classList.contains('hidden')).toBe(true);
  });
});

// ---- (2) progress rail ------------------------------------------------------

describe('progress rail (UX_BIBLE hierarchy #3: 2D canvas, all racers, <= 4 Hz)', () => {
  it('draws one dot per racer in slot colour, YOU larger with a white rim', () => {
    const { hud, root } = mk();
    hud.render(state());
    const ops = railCanvas(root).ctx.ops;

    // 2x backing store baked in at construction
    expect(ops[0]).toBe('scale:2,2');
    // three racers -> three dots (arc ops)
    const arcs = ops.filter((o) => o.startsWith('arc:'));
    expect(arcs).toHaveLength(3);
    // every slot colour was filled
    for (const slot of [0, 1, 2]) {
      expect(ops).toContain(`fill:${SKIER_COLORS[slot] ?? ''}`);
    }
    // the YOU dot is the larger one (radius 7 vs 5) with a snow-white rim
    expect(arcs.some((a) => a.endsWith(',7'))).toBe(true);
    expect(ops).toContain(`stroke:${SPAL.snowLit}`);
  });

  it('is throttled to <= 4 Hz and skips redraws when nothing moved', () => {
    const { hud, root } = mk();
    const s = state();
    hud.render(s);
    const canvas = railCanvas(root);
    const drawn = canvas.ctx.ops.length;
    expect(drawn).toBeGreaterThan(0);

    // same state, same tick: no redraw at all
    hud.render(s);
    expect(canvas.ctx.ops.length).toBe(drawn);

    // a racer moved but the 250 ms window has not elapsed: still no redraw
    const moved = state({ racers: [racer(0, 300), racer(1, 400), racer(2, 250)] });
    hud.render(moved);
    expect(canvas.ctx.ops.length).toBe(drawn);

    // past the window with real movement: exactly one redraw happens
    nowMs += 300;
    hud.render(moved);
    expect(canvas.ctx.ops.length).toBeGreaterThan(drawn);

    // and inside that redraw window an unchanged frame is free
    const after = canvas.ctx.ops.length;
    hud.render(moved);
    expect(canvas.ctx.ops.length).toBe(after);
  });
});

// ---- (4) countdown overlay --------------------------------------------------

describe('countdown overlay (UX_BIBLE states: big 3-2-1 numerals then GO!)', () => {
  it('walks 3 -> 2 -> 1, fires GO! on the racing edge, then clears', () => {
    const { hud, root } = mk();
    const overlay = (): El => {
      const e = byClass(root, 'sh-countdown');
      if (e === null) throw new Error('no countdown overlay');
      return e;
    };

    hud.render(state({ phase: 'countdown', countdown: 3 }));
    expect(overlay().textContent).toBe('3');
    expect(overlay().classList.contains('hidden')).toBe(false);

    hud.render(state({ phase: 'countdown', countdown: 2 }));
    expect(overlay().textContent).toBe('2');

    hud.render(state({ phase: 'countdown', countdown: 1 }));
    expect(overlay().textContent).toBe('1');

    // the countdown -> racing edge shows GO! (no words needed beyond GO!)
    hud.render(state({ phase: 'racing' }));
    expect(overlay().textContent).toBe('GO!');
    expect(overlay().classList.contains('hidden')).toBe(false);

    // after the linger window the overlay steps out of the world's way
    nowMs += 1000;
    hud.render(state({ phase: 'racing' }));
    expect(overlay().classList.contains('hidden')).toBe(true);
  });
});

// ---- (5) finished banner ----------------------------------------------------

describe('finished banner (UX_BIBLE: "Finished — 42.3s", race runs behind it)', () => {
  it('formats the finish time to a tenth of a second', () => {
    const { hud, root } = mk();
    const you = racer(0, 800, { finished: true, finishMs: 42_300 });
    hud.render(state({ you, racers: [you, racer(1, 500)] }));
    const banner = byClass(root, 'sh-finished');
    expect(banner?.classList.contains('hidden')).toBe(false);
    expect(banner?.textContent).toBe('Finished — 42.3s');
  });

  it('stays hidden while you are still racing', () => {
    const { hud, root } = mk();
    hud.render(state());
    expect(byClass(root, 'sh-finished')?.classList.contains('hidden')).toBe(true);
  });
});

// ---- (6) results panel ------------------------------------------------------

describe('results panel (UX_BIBLE: proportional bars, crown, no shame)', () => {
  const RESULTS: HudRacer[] = [
    racer(1, 800, { finished: true, finishMs: 45_000 }),
    racer(2, 500), // still on the mountain
    racer(0, 800, { finished: true, finishMs: 42_300 }), // the winner
  ];

  it('orders winner-first, crowns only the winner, and scales time bars to the win', () => {
    const { hud, root } = mk();
    hud.render(state({ phase: 'results', results: RESULTS, place: 1 }));
    const rows = allByClass(root, 'sh-row');
    expect(rows).toHaveLength(3);

    const glyphOf = (row: El): string =>
      find(row, (e) => hasClass(e, 'sh-row-glyph'))?.textContent ?? '';
    const timeOf = (row: El): string =>
      find(row, (e) => hasClass(e, 'sh-row-time'))?.textContent ?? '';
    const barOf = (row: El): string =>
      find(row, (e) => hasClass(e, 'sh-row-bar-fill'))?.style.width ?? '';

    // winner (slot 0, 42.3s) first even though it arrived last in the array
    expect(glyphOf(rows[0] ?? new El('div'))).toBe(SKIER_GLYPHS[0] ?? '');
    expect(timeOf(rows[0] ?? new El('div'))).toBe('42.3s');
    expect(barOf(rows[0] ?? new El('div'))).toBe('100%'); // winner = full bar
    expect(find(rows[0] ?? new El('div'), (e) => hasClass(e, 'sh-row-crown'))).not.toBeNull();

    // second finisher: proportional to the win (42300/45000 -> 94%), no crown
    expect(glyphOf(rows[1] ?? new El('div'))).toBe(SKIER_GLYPHS[1] ?? '');
    expect(timeOf(rows[1] ?? new El('div'))).toBe('45.0s');
    expect(barOf(rows[1] ?? new El('div'))).toBe('94%');
    expect(find(rows[1] ?? new El('div'), (e) => hasClass(e, 'sh-row-crown'))).toBeNull();
  });

  it('shows unfinished racers as "on the mountain" with distance covered — no rank shame', () => {
    const { hud, root } = mk();
    hud.render(state({ phase: 'results', results: RESULTS, place: 1 }));
    const rows = allByClass(root, 'sh-row');
    const last = rows[2] ?? new El('div');

    const time = find(last, (e) => hasClass(e, 'sh-row-time'))?.textContent ?? '';
    expect(time).toContain('on the mountain');
    expect(time).toContain('500 m'); // distance covered, not a blank bar
    // their bar is progress down the mountain (500/800 -> 63%), never zero
    expect(find(last, (e) => hasClass(e, 'sh-row-bar-fill'))?.style.width).toBe('63%');
    expect(find(last, (e) => hasClass(e, 'sh-row-crown'))).toBeNull();
  });

  it('never shows the word "loser" (or rank-shame kin) anywhere in the HUD', () => {
    const { hud, root } = mk();
    hud.render(state({ phase: 'results', results: RESULTS, place: 3 }));
    expect(allText(root)).not.toMatch(/loser|last place|disqualified/i);
  });
});

// ---- (7) steer hint ---------------------------------------------------------

describe('steer hint (UX_BIBLE first 60 s: once ever, dismissible by any input)', () => {
  it('shows thumb outlines + the steer line on first run, then marks localStorage', () => {
    const { hud, root } = mk();
    hud.showSteerHint();
    const hint = byClass(root, 'sh-hint');
    expect(hint?.classList.contains('hidden')).toBe(false);
    expect(byClass(root, 'sh-hint-left')).not.toBeNull();
    expect(byClass(root, 'sh-hint-right')).not.toBeNull();
    expect(byClass(root, 'sh-hint-label')?.textContent).toBe('hold a side to steer');
    expect(store.get('splat.hintseen')).toBe('1');
    // a 3 s auto-dismiss timer is armed
    expect(timers.some((t) => t.ms === 3000)).toBe(true);
  });

  it('dismisses on any pointer input and unhooks its listeners', () => {
    const { hud, root } = mk();
    hud.showSteerHint();
    const pointerHandlers = winHandlers.get('pointerdown') ?? [];
    expect(pointerHandlers.length).toBeGreaterThan(0);
    for (const fn of [...pointerHandlers]) fn();
    expect(byClass(root, 'sh-hint')?.classList.contains('hidden')).toBe(true);
    expect(winHandlers.get('pointerdown') ?? []).toHaveLength(0);
    expect(winHandlers.get('keydown') ?? []).toHaveLength(0);
    // and the 3 s timer was cancelled with the dismissal
    expect(timers).toHaveLength(0);
  });

  it('dismisses on any key input', () => {
    const { hud, root } = mk();
    hud.showSteerHint();
    for (const fn of [...(winHandlers.get('keydown') ?? [])]) fn();
    expect(byClass(root, 'sh-hint')?.classList.contains('hidden')).toBe(true);
  });

  it('auto-dismisses after 3 s with no input', () => {
    const { hud, root } = mk();
    hud.showSteerHint();
    const t = timers.find((x) => x.ms === 3000);
    if (t === undefined) throw new Error('no 3 s hint timer');
    t.fn();
    expect(byClass(root, 'sh-hint')?.classList.contains('hidden')).toBe(true);
  });

  it('never shows again once localStorage says seen — at most once ever', () => {
    store.set('splat.hintseen', '1');
    const { hud, root } = mk();
    hud.showSteerHint();
    expect(byClass(root, 'sh-hint')?.classList.contains('hidden')).toBe(true);
    expect(timers).toHaveLength(0); // no timer, no listeners armed
    expect(winHandlers.get('pointerdown') ?? []).toHaveLength(0);
  });
});

// ---- per-frame DOM traffic (CONTRACT §2.7) -----------------------------------

describe('change guards', () => {
  it('render() with an unchanged state performs no DOM writes at all', () => {
    const { hud, root } = mk();
    const s = state();
    hud.render(s);
    hud.render(s); // settle every baseline
    const nodes = [root, ...root.walk()];
    const mark = nodes.map((e) => ({
      text: e.textWrites,
      cls: e.classWrites,
      style: e.styleWrites.length,
    }));
    const opsBefore = railCanvas(root).ctx.ops.length;

    hud.render(s);

    const churn = nodes
      .map((e, i) => ({
        el: e.className || e.tagName,
        dText: e.textWrites - (mark[i]?.text ?? 0),
        dCls: e.classWrites - (mark[i]?.cls ?? 0),
        dStyle: e.styleWrites.length - (mark[i]?.style ?? 0),
      }))
      .filter((x) => x.dText > 0 || x.dCls > 0 || x.dStyle > 0);
    expect(churn).toEqual([]);
    expect(railCanvas(root).ctx.ops.length).toBe(opsBefore);
  });

  it('a settled results frame is write-free too (results rebuild is content-gated)', () => {
    const { hud, root } = mk();
    const s = state({
      phase: 'results',
      results: [racer(0, 800, { finished: true, finishMs: 42_300 }), racer(1, 500)],
    });
    hud.render(s);
    hud.render(s);
    const nodes = [root, ...root.walk()];
    const mark = nodes.map((e) => e.textWrites + e.classWrites + e.styleWrites.length);
    hud.render(s);
    nodes.forEach((e, i) => {
      expect(e.textWrites + e.classWrites + e.styleWrites.length).toBe(mark[i]);
    });
  });
});

// ---- robustness (CONTRACT §2.8) ----------------------------------------------

describe('robustness', () => {
  it('the lobby phase hides the whole HUD root', () => {
    const { hud, root } = mk();
    hud.render(state({ phase: 'lobby' }));
    expect(root.classList.contains('hidden')).toBe(true);
  });

  it('renders every phase without throwing', () => {
    const { hud } = mk();
    expect(() => {
      hud.render(state({ phase: 'lobby' }));
      hud.render(state({ phase: 'countdown', countdown: 3 }));
      hud.render(state({ phase: 'racing' }));
      hud.render(
        state({ phase: 'results', results: [racer(0, 800, { finished: true, finishMs: 42_300 })] }),
      );
    }).not.toThrow();
  });
});
