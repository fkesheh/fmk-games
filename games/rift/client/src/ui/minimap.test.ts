// ============================================================================
// R_MINIMAP — behavioural gate for client/src/ui/minimap.ts.
//
// The repo has no DOM environment (no jsdom, no happy-dom; vitest.config.ts
// runs plain node), so this file drives the module through a recording stub of
// exactly the DOM surface minimap.ts touches: `document.createElement`, a
// canvas with a recording 2D context, pointer capture, and
// `getBoundingClientRect`. That is deliberately MORE than a jsdom run would
// give: every assertion below is about what was actually painted or actually
// called, not about a rendered pixel nobody looked at.
//
// Every `it` here names one behaviour that was a defect, and each one has been
// mutation-verified: revert the behaviour, the test goes RED. AMENDMENT_2 §E.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `buildTerrain` must never be called by the minimap: `buildMap(lanes)` already
// returns the compiled terrain (map.ts) and it is the most expensive call on
// this path. Only the BARREL binding is replaced, so map.ts's own internal call
// to './terrain.js' is untouched and buildMap still works normally.
vi.mock('@rift/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rift/shared')>();
  return { ...actual, buildTerrain: vi.fn(actual.buildTerrain) };
});

import { APAL, NEUTRAL_TEAM, buildMap, buildTerrain } from '@rift/shared';
import type { EntSnap } from '@rift/shared';
import { L, hueDistance, mix } from '@platform/shared';
import type { ClientState, FogHandle, UiActions } from '../contract.js';
import { createMinimap } from './minimap.js';

// ---- the numbers this file is written against -------------------------------
const RES = 512; // minimap.ts backing store
const CSS_SIZE = 200; // style.css `.minimap { width: 200px }`
const CSSPX = RES / CSS_SIZE; // 2.56 backing px per CSS px
const DIM_ALPHA = 0.55; // fog.ts DIM_ALPHA — the explored-not-visible mean
const DIM_ALPHA_MAX = 0.629; // fog.ts's mist modulates it over 0.471..0.629
const LADDER_L_MIN = 12; // valueLadder.test.ts LARGE_VS_MOSS_L_MIN
const LADDER_HUE_MIN = 25; // valueLadder.test.ts LARGE_VS_MOSS_HUE_MIN
/** Floors under the shroud. Value-reliant pairs (hue < 25 deg) are the ones an
 *  alpha wash can collapse — a neutral dim preserves hue — and they did
 *  collapse: 3.4 L* before this fix. 8 L* at the mean, 7 at the mist's
 *  darkest, is what the physics allows once open ground is at L* 31.6 (see the
 *  module header: the dim state halves L*, so only ~15 L* exists below open
 *  ground for cliff and jungle to share). */
const FOG_L_MIN = 8;
const FOG_L_MIN_DARKEST = 7;
/** The dimmed floor for pairs that ride on HUE. */
const FOG_HUE_MIN = 45;
/** The minimap is a 2D CANVAS: `ctx.drawImage(mask)` is a source-over in 8-bit
 *  sRGB, which is exactly `mix`. It is NOT @platform/shared's `composite`,
 *  which blends in linear light because it models a three.js material — that
 *  operator overstates every surviving separation here by ~1.6x. Verified in
 *  Chrome against the module's own terrain layer at 200 CSS px: open ground
 *  #424e38 (L* 31.56) dims to #222820 (L* 15.29), which is what this returns. */
const shroud = (fill: string, alpha: number): string => mix(fill, APAL.shroud, alpha);
const LANES = 2;

// ---- recording DOM stub -----------------------------------------------------
interface Op {
  readonly op: string;
  readonly a: readonly number[];
  readonly fill: string;
  readonly stroke: string;
  readonly lw: number;
}

class FakeCtx {
  ops: Op[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  lineCap = '';
  lineJoin = '';
  imageSmoothingEnabled = true;
  private rec(op: string, ...a: number[]): void {
    this.ops.push({ op, a, fill: this.fillStyle, stroke: this.strokeStyle, lw: this.lineWidth });
  }
  save(): void {
    this.rec('save');
  }
  restore(): void {
    this.rec('restore');
  }
  translate(x: number, y: number): void {
    this.rec('translate', x, y);
  }
  scale(x: number, y: number): void {
    this.rec('scale', x, y);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.rec('clearRect', x, y, w, h);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rec('fillRect', x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.rec('strokeRect', x, y, w, h);
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
  arc(x: number, y: number, r: number): void {
    this.rec('arc', x, y, r);
  }
  fill(): void {
    this.rec('fill');
  }
  stroke(): void {
    this.rec('stroke');
  }
  drawImage(): void {
    this.rec('drawImage');
  }
}

interface PointerLike {
  clientX: number;
  clientY: number;
  button: number;
  pointerId: number;
  preventDefault(): void;
}

class FakeEl {
  className = '';
  style: Record<string, string> = {};
  width = 0;
  height = 0;
  readonly children: FakeEl[] = [];
  readonly listeners = new Map<string, ((ev: PointerLike) => void)[]>();
  readonly captured = new Set<number>();
  rectCalls = 0;
  constructor(
    readonly tag: string,
    readonly ctx: FakeCtx | null,
  ) {}
  appendChild(c: FakeEl): void {
    this.children.push(c);
  }
  addEventListener(t: string, f: (ev: PointerLike) => void): void {
    const l = this.listeners.get(t) ?? [];
    l.push(f);
    this.listeners.set(t, l);
  }
  getContext(): FakeCtx | null {
    return this.ctx;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    this.rectCalls += 1;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  setPointerCapture(id: number): void {
    this.captured.add(id);
  }
  hasPointerCapture(id: number): boolean {
    return this.captured.has(id);
  }
  releasePointerCapture(id: number): void {
    this.captured.delete(id);
  }
  fire(t: string, ev: Partial<PointerLike>): void {
    const full: PointerLike = {
      clientX: 0,
      clientY: 0,
      button: 0,
      pointerId: 1,
      preventDefault: () => undefined,
      ...ev,
    };
    for (const f of this.listeners.get(t) ?? []) f(full);
  }
}

let created: FakeEl[] = [];
let rect = { left: 100, top: 50, width: CSS_SIZE, height: CSS_SIZE };
let nowMs = 0;
/** Which created canvases get a 2D context. Index counts canvases only. */
let canvasCtxOk: (canvasIndex: number) => boolean = () => true;
let canvasIndex = 0;

const realDocument = (globalThis as { document?: unknown }).document;
const realNow = performance.now.bind(performance);

beforeEach(() => {
  created = [];
  canvasIndex = 0;
  canvasCtxOk = () => true;
  rect = { left: 100, top: 50, width: CSS_SIZE, height: CSS_SIZE };
  nowMs = 1_000_000;
  (globalThis as { document?: unknown }).document = {
    createElement(tag: string): FakeEl {
      const isCanvas = tag === 'canvas';
      const ok = isCanvas ? canvasCtxOk(canvasIndex++) : false;
      const el = new FakeEl(tag, isCanvas && ok ? new FakeCtx() : null);
      created.push(el);
      return el;
    },
  };
  performance.now = () => nowMs;
  vi.mocked(buildTerrain).mockClear();
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = realDocument;
  performance.now = realNow;
});

// ---- fixtures ---------------------------------------------------------------
const MAP = buildMap(LANES);
const CAMPS = MAP.terrain.camps;

function ent(e: Partial<EntSnap> & Pick<EntSnap, 'id' | 'k'>): EntSnap {
  return { team: 0, x: 0, z: 0, hp: 100, maxHp: 100, ...e } as EntSnap;
}

function state(over: Partial<ClientState> = {}): ClientState {
  const base = {
    phase: 'live',
    connected: true,
    error: null,
    hello: null,
    lobby: null,
    begin: { t: 'rift_begin', lanes: LANES, teamSize: 5, startAtTick: 0, laneAssignment: {} },
    snap: null,
    interp: null,
    fog: null,
    end: null,
    events: [],
    shopOpen: false,
    scoreboardOpen: false,
    cameraX: MAP.side / 2,
    cameraZ: MAP.side / 2,
    cameraHeight: 20,
    toast: null,
  } as unknown as ClientState;
  return { ...base, ...over };
}

function actions(): UiActions & {
  pans: { x: number; z: number }[];
  sent: { x: number; z: number }[];
} {
  const pans: { x: number; z: number }[] = [];
  const sent: { x: number; z: number }[] = [];
  return {
    pans,
    sent,
    send: (m) => {
      if (m.t === 'rift_order' && m.kind === 'move') sent.push({ x: m.x ?? 0, z: m.z ?? 0 });
    },
    toggleShop: () => undefined,
    setScoreboard: () => undefined,
    centerCamera: () => undefined,
    panCameraTo: (x, z) => {
      pans.push({ x, z });
    },
    leaveToMenu: () => undefined,
  };
}

/** Build a minimap, render one live frame, return the pieces under test. */
function mount(over: Partial<ClientState> = {}): {
  root: FakeEl;
  canvas: FakeEl;
  ctx: FakeCtx;
  layer: FakeCtx | null;
  a: ReturnType<typeof actions>;
  handle: ReturnType<typeof createMinimap>;
  frame(s?: Partial<ClientState>): void;
} {
  const parent = new FakeEl('div', null);
  const a = actions();
  // `created` accumulates across mounts inside one test, so index from here
  const base = created.length;
  const handle = createMinimap(parent as unknown as HTMLElement);
  const root = created[base]!;
  const canvas = created[base + 1]!;
  handle.render(state(over), a);
  const layerEl = created[base + 2];
  const frame = (s: Partial<ClientState> = {}): void => {
    nowMs += 1000; // clear the 250 ms redraw gate
    handle.render(state({ ...over, ...s }), a);
  };
  return { root, canvas, ctx: canvas.ctx!, layer: layerEl?.ctx ?? null, a, handle, frame };
}

/** The distinct fill colours the offscreen terrain layer painted. */
function terrainFills(layer: FakeCtx): string[] {
  const out = new Set<string>();
  for (const o of layer.ops) if (o.op === 'fillRect') out.add(o.fill);
  return [...out];
}

/** The colour the jungle lattice was ACTUALLY painted in, read back off the
 *  layer rather than assumed. `buildTerrainLayer` makes exactly two top-to-
 *  bottom sweeps: the kind pass (row runs), then the dither pass (single
 *  cells). The one place where the painted y goes backwards is the boundary
 *  between them. Reading the colour is the difference between a test that pins
 *  the dither and one that merely restates the arithmetic beside it. */
function ditherFill(layer: FakeCtx): string {
  const rects = layer.ops.filter((o) => o.op === 'fillRect');
  const starts: number[] = [];
  for (let i = 1; i < rects.length; i += 1) {
    if ((rects[i]!.a[1] ?? 0) < (rects[i - 1]!.a[1] ?? 0)) starts.push(i);
  }
  expect(starts, 'the layer must be exactly two sweeps: kinds, then the lattice').toHaveLength(1);
  const cells = rects.slice(starts[0]!);
  const set = new Set(cells.map((o) => o.fill));
  expect(cells.length, 'the jungle lattice painted no cells at all').toBeGreaterThan(0);
  expect([...set], 'the lattice must be ONE colour').toHaveLength(1);
  for (const c of cells) {
    expect([c.a[2], c.a[3]], 'a lattice op paints exactly one cell').toEqual([1, 1]);
  }
  return [...set][0]!;
}

// ============================================================================
describe('R_MINIMAP terrain source', () => {
  it('takes the terrain buildMap already compiled — never calls buildTerrain again', () => {
    const m = mount();
    m.frame();
    // buildMap(LANES) at module scope for the fixtures does NOT go through the
    // mocked barrel binding, so any call here is the minimap's.
    expect(
      vi.mocked(buildTerrain).mock.calls.length,
      'minimap.ts must read map.terrain from buildMap(lanes); a second ' +
        'buildTerrain(lanes) doubles the most expensive call on this path',
    ).toBe(0);
    // and it really did get a terrain: camps were drawn
    expect(m.ctx.ops.filter((o) => o.op === 'closePath').length).toBeGreaterThanOrEqual(
      CAMPS.length,
    );
  });
});

describe('R_MINIMAP terrain value ladder', () => {
  it('paints exactly eight fills, monotone in L* in the documented order', () => {
    const m = mount();
    const fills = terrainFills(m.layer!);
    // the jungle dither reuses the GROUND fill, so the lattice adds no ninth
    expect(fills.length, `terrain layer painted ${fills.length} colours: ${fills.join(' ')}`).toBe(
      8,
    );
    const sorted = [...fills].sort((x, y) => L(x) - L(y));
    // this order is the header block's ladder; if they disagree the header lies
    const documented = [
      APAL.inkDeep, // cliff    L*  2.4
      '#161c12', // foliage  L*  9.4
      '#524231', // ramp     L* 29.2
      APAL.mossLit, // ground   L* 31.6
      APAL.water, // river    L* 42.6
      '#5e7d3f', // high     L* 48.8
      APAL.stoneLit, // lane     L* 55.9
      '#c6c0b4', // base     L* 77.9
    ];
    expect(
      sorted,
      `the documented ladder is not the measured ladder:\n  doc: ${documented
        .map((c) => `${c}=${L(c).toFixed(1)}`)
        .join(' ')}\n  got: ${sorted.map((c) => `${c}=${L(c).toFixed(1)}`).join(' ')}`,
    ).toEqual(documented);
  });

  it(`every pair clears ${LADDER_L_MIN} L* or ${LADDER_HUE_MIN} deg hue`, () => {
    const fills = terrainFills(mount().layer!);
    const failures: string[] = [];
    for (let i = 0; i < fills.length; i += 1) {
      for (let j = i + 1; j < fills.length; j += 1) {
        const a = fills[i]!;
        const b = fills[j]!;
        const dL = Math.abs(L(a) - L(b));
        const dH = hueDistance(a, b);
        if (dL < LADDER_L_MIN && dH < LADDER_HUE_MIN) {
          failures.push(`${a} vs ${b}: dL=${dL.toFixed(2)} dH=${dH.toFixed(1)}`);
        }
      }
    }
    expect(
      failures,
      `terrain fills that read the same (valueLadder.test.ts's large-surface ` +
        `law, which "may be extended, never weakened"):\n  ${failures.join('\n  ')}`,
    ).toEqual([]);
  });

  it(`survives the shroud: value pairs >= ${FOG_L_MIN} L*, hue pairs >= ${FOG_HUE_MIN} deg`, () => {
    const fills = terrainFills(mount().layer!);
    const failures: string[] = [];
    for (const [alpha, floor] of [
      [DIM_ALPHA, FOG_L_MIN],
      [DIM_ALPHA_MAX, FOG_L_MIN_DARKEST],
    ] as const) {
      for (let i = 0; i < fills.length; i += 1) {
        for (let j = i + 1; j < fills.length; j += 1) {
          const a = fills[i]!;
          const b = fills[j]!;
          const da = shroud(a, alpha);
          const db = shroud(b, alpha);
          if (hueDistance(a, b) >= LADDER_HUE_MIN) {
            // a neutral dim preserves hue — assert that it actually did
            const dh = hueDistance(da, db);
            if (dh < FOG_HUE_MIN) {
              failures.push(`@${alpha} ${a} vs ${b}: raw dH=${hueDistance(a, b).toFixed(1)} but dimmed dH=${dh.toFixed(1)}`);
            }
            continue;
          }
          const dim = Math.abs(L(da) - L(db));
          if (dim < floor) {
            failures.push(
              `@${alpha} ${a} vs ${b}: raw dL=${Math.abs(L(a) - L(b)).toFixed(2)} but ` +
                `dimmed dL=${dim.toFixed(2)} (need ${floor})`,
            );
          }
        }
      }
    }
    expect(
      failures,
      `explored-not-visible ground is most of the map for most of the match; ` +
        `these pairs collapse under it:\n  ${failures.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the dithered jungle MASS, not just the foliage fill, clears open ground', () => {
    // The lattice is 1-in-4 of the GROUND fill and the browser's downscale
    // averages the stored sRGB samples, so what a player reads at 200 px is
    // the mean — a lighter colour than the foliage fill, and therefore the one
    // that has to clear open ground. Measuring only the fill hides this.
    const layer = mount().layer!;
    const fills = terrainFills(layer);
    const sorted = [...fills].sort((a, b) => L(a) - L(b));
    const foliage = sorted[1]!; // cliff, foliage, ramp, ground, …
    const ground = sorted[3]!;
    const dither = ditherFill(layer);
    expect(
      fills,
      `the lattice painted ${dither}, which is not one of the eight terrain fills — ` +
        `a ninth colour is one more pair the ladder has to hold`,
    ).toContain(dither);
    const mass = mix(foliage, dither, 0.25);
    expect(L(ground) - L(mass), `jungle mass ${mass} vs open ground ${ground}`).toBeGreaterThanOrEqual(12);
    // These floors sit BELOW what the render measures, not above it. The ideal
    // 4:1 mean gives 8.08 / 6.59 L* of separation; Chrome's box filter at
    // 1.56-2.08 px per cell lands the rendered mass ~0.6 L* lighter, measured
    // at 7.47-7.69 L* under the shroud at 200 CSS px. A model floor above the
    // measured render is the exact mistake this test replaced.
    for (const [alpha, floor] of [
      [DIM_ALPHA, 7],
      [DIM_ALPHA_MAX, 6],
    ] as const) {
      const dim = L(shroud(ground, alpha)) - L(shroud(mass, alpha));
      expect(
        dim,
        `at shroud alpha ${alpha} the jungle mass ${mass} reads ${dim.toFixed(2)} L* ` +
          `below open ground — the dither must not spend the separation it is drawn to earn`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });
});

describe('R_MINIMAP canvas hygiene', () => {
  it('clears the canvas before every draw', () => {
    const m = mount();
    const first = m.ctx.ops[0];
    expect(first?.op, 'the first op of a draw must be clearRect').toBe('clearRect');
    expect(first?.a).toEqual([0, 0, RES, RES]);
    m.ctx.ops = [];
    m.frame();
    expect(m.ctx.ops[0]?.op, 'and of every later draw too').toBe('clearRect');
  });

  it('a terrain layer with no 2D context falls back to a filled canvas, never a smear', () => {
    // canvas 0 is the visible one; canvas 1 is the offscreen terrain layer
    canvasCtxOk = (i) => i === 0;
    const parent = new FakeEl('div', null);
    const handle = createMinimap(parent as unknown as HTMLElement);
    handle.render(state(), actions());
    const ctx = created[1]!.ctx!;
    expect(ctx.ops[0]?.op).toBe('clearRect');
    const full = ctx.ops.find(
      (o) => o.op === 'fillRect' && o.a[2] === RES && o.a[3] === RES,
    );
    expect(
      full?.fill,
      'a null-context layer must NOT be returned as a blank canvas: it is truthy, ' +
        'it takes the blit branch, and the minimap shows the previous frame forever',
    ).toBe(APAL.mossLit);
    expect(ctx.ops.some((o) => o.op === 'drawImage')).toBe(false);
  });
});

describe('R_MINIMAP stroke weights at the shipped 200 px', () => {
  it('the lane centreline is at least 2 CSS px', () => {
    const m = mount();
    const laneStroke = m.ctx.ops.find((o) => o.op === 'stroke');
    expect(laneStroke, 'the lane pass is the first stroke of a draw').toBeDefined();
    expect(
      (laneStroke?.lw ?? 0) / CSSPX,
      `lane centreline measured ${((laneStroke?.lw ?? 0) / CSSPX).toFixed(2)} CSS px; it is ` +
        `the map's primary read`,
    ).toBeGreaterThanOrEqual(2);
  });

  it('every blip outline is at least 1 CSS px', () => {
    const m = mount({
      snap: {
        you: {},
        ents: [ent({ id: 1, k: 'tower', x: 20, z: 20 }), ent({ id: 2, k: 'hero', x: 30, z: 30 })],
      } as unknown as ClientState['snap'],
    });
    const thin = m.ctx.ops.filter((o) => o.op === 'stroke' && o.lw / CSSPX < 1);
    expect(
      thin.map((o) => (o.lw / CSSPX).toFixed(2)),
      'a sub-pixel outline does not survive the browser downscale to 200 px',
    ).toEqual([]);
  });
});

describe('R_MINIMAP camp blips', () => {
  const campEnt = (i: number, hp = 100): EntSnap =>
    ent({
      id: 900 + i,
      k: 'campPack',
      team: NEUTRAL_TEAM,
      x: CAMPS[i]!.x,
      z: CAMPS[i]!.z,
      hp,
    });

  function triangleFills(ctx: FakeCtx): { fill: string; stroke: string }[] {
    // a triangle is beginPath, moveTo, lineTo, lineTo, closePath, then fill+stroke
    const out: { fill: string; stroke: string }[] = [];
    for (let i = 0; i < ctx.ops.length; i += 1) {
      if (ctx.ops[i]?.op !== 'closePath') continue;
      const f = ctx.ops[i + 1];
      const s = ctx.ops[i + 2];
      if (f?.op === 'fill' && s?.op === 'stroke') out.push({ fill: f.fill, stroke: s.stroke });
    }
    return out;
  }

  it('alive / unknown / dead are three distinct fills, and all three are stroked', () => {
    const seen: FogHandle = {
      maskCanvas: { width: 0, height: 0 } as unknown as HTMLCanvasElement,
      update: () => undefined,
      isVisible: () => true,
    };
    // frame 1: camp 0 has a living creep on it -> ALIVE; the rest are visible
    // with nothing on them -> DEAD. Camp states are sticky, so a third frame
    // with no fog leaves an unscouted camp UNKNOWN.
    const unknown = mount();
    const unknownTris = triangleFills(unknown.ctx);
    expect(unknownTris.length).toBe(CAMPS.length);
    const uFill = unknownTris[0]!.fill;

    const m = mount({
      fog: seen,
      snap: { you: {}, ents: [campEnt(0)] } as unknown as ClientState['snap'],
    });
    const tris = triangleFills(m.ctx);
    const aliveFill = tris[0]!.fill;
    const deadFill = tris[1]!.fill;

    expect(
      new Set([uFill, aliveFill, deadFill]).size,
      `unknown=${uFill} alive=${aliveFill} dead=${deadFill} — three states must be ` +
        `three fills, not fill-vs-hollow in a 5.8-8.6 CSS px triangle`,
    ).toBe(3);
    // a value ladder, not three hues
    expect(Math.abs(L(aliveFill) - L(uFill))).toBeGreaterThanOrEqual(12);
    expect(Math.abs(L(uFill) - L(deadFill))).toBeGreaterThanOrEqual(12);
    // every state keeps a contact outline
    for (const t of tris) expect(t.stroke, 'every camp state is stroked').toBeTruthy();
    expect(tris[1]!.stroke).not.toBe(deadFill);
  });

  it('a camp creep standing on its clearing is not drawn twice, and a corpse is not drawn', () => {
    const base = mount().ctx;
    const nCamps = triangleFills(base).length;
    expect(nCamps).toBe(CAMPS.length);

    const onClearing = mount({
      snap: { you: {}, ents: [campEnt(0)] } as unknown as ClientState['snap'],
    });
    expect(
      triangleFills(onClearing.ctx).length,
      'the clearing blip already reports this creep; a second stacked triangle ' +
        'makes a full camp read as a bigger one',
    ).toBe(nCamps);

    // pulled well outside every leash disc -> it earns its own marker
    const pulled = mount({
      snap: {
        you: {},
        ents: [ent({ id: 901, k: 'campBrute', team: NEUTRAL_TEAM, x: MAP.side / 2, z: 1.5 })],
      } as unknown as ClientState['snap'],
    });
    expect(triangleFills(pulled.ctx).length).toBe(nCamps + 1);

    const dead = mount({
      snap: {
        you: {},
        ents: [ent({ id: 902, k: 'campBrute', team: NEUTRAL_TEAM, x: MAP.side / 2, z: 1.5, hp: 0 })],
      } as unknown as ClientState['snap'],
    });
    expect(triangleFills(dead.ctx).length, 'a dead creep is not on the map').toBe(nCamps);
  });
});

describe('R_MINIMAP pointer gestures', () => {
  it('click-to-pan maps the canvas centre to the map centre, 180-degree rotated', () => {
    const m = mount();
    m.canvas.fire('pointerdown', {
      clientX: rect.left + CSS_SIZE / 2,
      clientY: rect.top + CSS_SIZE / 2,
    });
    expect(m.a.pans).toHaveLength(1);
    expect(m.a.pans[0]!.x).toBeCloseTo(MAP.side / 2, 6);
    expect(m.a.pans[0]!.z).toBeCloseTo(MAP.side / 2, 6);

    // top-left of the element is +x/+z, because the drawing is rotated 180°
    m.canvas.fire('pointerdown', { clientX: rect.left, clientY: rect.top });
    expect(m.a.pans[1]!.x).toBeCloseTo(MAP.side, 6);
    expect(m.a.pans[1]!.z).toBeCloseTo(MAP.side, 6);
  });

  it('drag-to-pan pans on every pointermove (AMENDMENT_3 §F: net-new, must be tested)', () => {
    const m = mount();
    m.canvas.fire('pointerdown', { clientX: rect.left + 100, clientY: rect.top + 100 });
    m.canvas.fire('pointermove', { clientX: rect.left + 150, clientY: rect.top + 100 });
    m.canvas.fire('pointermove', { clientX: rect.left + 50, clientY: rect.top + 100 });
    expect(m.a.pans).toHaveLength(3);
    expect(m.a.pans[1]!.x).toBeCloseTo(MAP.side * 0.25, 6);
    expect(m.a.pans[2]!.x).toBeCloseTo(MAP.side * 0.75, 6);
    // a move with no button down does nothing
    m.canvas.fire('pointerup', {});
    m.canvas.fire('pointermove', { clientX: rect.left + 10, clientY: rect.top + 10 });
    expect(m.a.pans).toHaveLength(3);
  });

  it('drag-to-order throttles to one order per 120 ms', () => {
    const m = mount();
    m.canvas.fire('pointerdown', { clientX: rect.left + 100, clientY: rect.top + 100, button: 2 });
    expect(m.a.sent).toHaveLength(1);
    for (let i = 0; i < 5; i += 1) {
      nowMs += 10;
      m.canvas.fire('pointermove', { clientX: rect.left + 100 + i, clientY: rect.top + 100 });
    }
    expect(m.a.sent, 'a slow sweep must not flood the socket').toHaveLength(1);
    nowMs += 200;
    m.canvas.fire('pointermove', { clientX: rect.left + 120, clientY: rect.top + 100 });
    expect(m.a.sent).toHaveLength(2);
    expect(m.a.pans, 'the order gesture never pans').toHaveLength(0);
  });

  it('reads the client rect once per gesture, not once per pointermove', () => {
    const m = mount();
    const before = m.canvas.rectCalls;
    m.canvas.fire('pointerdown', { clientX: rect.left + 10, clientY: rect.top + 10 });
    expect(m.canvas.rectCalls - before).toBe(1);
    for (let i = 0; i < 20; i += 1) {
      m.canvas.fire('pointermove', { clientX: rect.left + 10 + i, clientY: rect.top + 10 });
    }
    expect(
      m.canvas.rectCalls - before,
      'getBoundingClientRect allocates a DOMRect; pointermove can fire at display rate',
    ).toBe(1);
  });

  it('a match ending mid-drag releases the pointer capture', () => {
    const m = mount();
    m.canvas.fire('pointerdown', { clientX: rect.left + 10, clientY: rect.top + 10, pointerId: 7 });
    expect(m.canvas.hasPointerCapture(7)).toBe(true);
    m.handle.render(state({ phase: 'ended' }), m.a);
    expect(
      m.canvas.hasPointerCapture(7),
      'an unreleased capture on a hidden element swallows every later pointer event',
    ).toBe(false);
    // and the gesture really is over
    m.canvas.fire('pointermove', { clientX: rect.left + 40, clientY: rect.top + 40 });
    expect(m.a.pans).toHaveLength(1);
  });

  it('sets touch-action on the pointer target so touch does not pointercancel the drag', () => {
    const m = mount();
    expect(m.canvas.style.touchAction).toBe('none');
  });
});

describe('R_MINIMAP per-draw allocation', () => {
  it('walks lane waypoints by index — never path.entries()', () => {
    const m = mount();
    const real = Array.prototype.entries;
    let calls = 0;
    // eslint-disable-next-line no-extend-native
    Array.prototype.entries = function patched(this: unknown[]) {
      calls += 1;
      return real.call(this);
    };
    try {
      m.frame();
    } finally {
      Array.prototype.entries = real;
    }
    expect(
      calls,
      'entries() allocates an iterator AND a [i, w] tuple per waypoint per draw, ' +
        'four times a second, forever',
    ).toBe(0);
  });
});

describe('R_MINIMAP frame-hook guard', () => {
  it('a throw inside the draw is contained — game.ts renders menus after this', () => {
    const m = mount();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom: FogHandle = {
      maskCanvas: { width: 0, height: 0 } as unknown as HTMLCanvasElement,
      update: () => undefined,
      isVisible: () => {
        throw new Error('fog exploded mid-rebuild');
      },
    };
    expect(() => m.frame({ fog: boom })).not.toThrow();
    expect(err).toHaveBeenCalledTimes(1);
    // a second fault does not re-spam the console, and still does not throw
    expect(() => m.frame({ fog: boom })).not.toThrow();
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
