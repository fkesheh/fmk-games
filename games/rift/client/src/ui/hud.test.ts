// ============================================================================
// R_HUD regression suite. Two halves, both of which exist because a defect got
// through without one:
//
//   1. THE STYLESHEET MIRROR. `style.css`'s :root duplicates palette.ts's 74
//      APAL entries as hand-typed fallback hex. Nothing read that file.
//      `shared/src/valueLadder.test.ts` sounds like it does — it is the
//      "ladder test" style.css used to cite — but it asserts APAL against
//      APAL_CSS_VARS, and both of those live in palette.ts, so it would stay
//      green with every literal in this stylesheet wrong. The tests below open
//      style.css and diff it against the palette for real.
//
//   2. HUD BEHAVIOUR. `createHud` is pure DOM, and this workspace has no jsdom,
//      so the suite installs a small deliberate DOM double (below) and drives
//      the real `render()` through it. The double implements only what hud.ts
//      touches; it is not a DOM, and anything needing layout, cascade or paint
//      is measured in the scratchpad harness instead, not faked here.
//
// Every behavioural test names the rule it pins and was verified by reverting
// that rule and confirming the test goes RED (AMENDMENT_2 §E).
// ============================================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { APAL, APAL_CSS_VARS, TICK_DT } from '@rift/shared';
import type { AncientsPaletteKey, EntSnap, RiftEvent, YouSnap } from '@rift/shared';

// ---------------------------------------------------------------------------
// PART 1 — style.css reads as the palette says it should
// ---------------------------------------------------------------------------

const CSS_PATH = fileURLToPath(new URL('../style.css', import.meta.url));
const CSS = readFileSync(CSS_PATH, 'utf8');

/** The FIRST `:root { … }` block, which is the palette mirror. Comments are
 *  stripped first so a hex quoted inside a doc comment is not mistaken for a
 *  declaration (and, in the outside-:root test below, does not produce a false
 *  positive — measured colours are discussed in prose all over this file). */
function stripComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

function rootBlock(css: string): string {
  const bare = stripComments(css);
  const at = bare.indexOf(':root');
  if (at < 0) throw new Error('style.css has no :root block');
  const open = bare.indexOf('{', at);
  const close = bare.indexOf('}', open);
  return bare.slice(open + 1, close);
}

/** `--name: value;` pairs of the :root block, in source order. */
function rootDecls(css: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const m of rootBlock(css).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.push({ name: m[1] ?? '', value: (m[2] ?? '').trim() });
  }
  return out;
}

describe('style.css :root mirrors APAL (the test the header used to claim existed)', () => {
  const decls = rootDecls(CSS);
  const hexDecls = decls.filter((d) => /^#[0-9a-fA-F]{3,8}$/.test(d.value));
  const byName = new Map(hexDecls.map((d) => [d.name, d.value]));
  const palKeys = Object.keys(APAL) as AncientsPaletteKey[];

  it('declares every APAL entry, with no entry missing', () => {
    const missing = palKeys.filter((k) => !byName.has(APAL_CSS_VARS[k]));
    expect(missing.map((k) => `${k} (${APAL_CSS_VARS[k]})`)).toEqual([]);
    expect(hexDecls).toHaveLength(palKeys.length);
  });

  it('carries the exact APAL value for every entry', () => {
    const wrong: string[] = [];
    for (const k of palKeys) {
      const varName = APAL_CSS_VARS[k];
      const got = byName.get(varName);
      if (got === undefined) continue; // reported by the test above
      if (got.toLowerCase() !== APAL[k].toLowerCase()) {
        wrong.push(`${varName}: css ${got} != APAL.${k} ${APAL[k]}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('has no hex declaration in :root that is not an APAL var', () => {
    const known = new Set(palKeys.map((k) => APAL_CSS_VARS[k] as string));
    expect(hexDecls.filter((d) => !known.has(d.name)).map((d) => d.name)).toEqual([]);
  });

  it('has no hex literal anywhere outside :root', () => {
    const bare = stripComments(CSS);
    const open = bare.indexOf('{', bare.indexOf(':root'));
    const close = bare.indexOf('}', open);
    const outside = bare.slice(0, open) + bare.slice(close + 1);
    expect(outside.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });
});

describe('style.css rules the review pinned', () => {
  const bare = stripComments(CSS);

  /** Every declaration that lands on `sel`, concatenated: a selector can
   *  appear in several rules (`.minimap` is in a shared box-shadow group AND
   *  in its own rule), and asserting against only the first one would depend
   *  on source order. */
  function ruleBody(sel: string): string {
    let out = '';
    for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = (m[1] ?? '').split(',').map((s) => s.trim());
      if (selectors.includes(sel)) out += `${m[2] ?? ''}\n`;
    }
    if (out === '') throw new Error(`no rule for ${sel}`);
    return out;
  }

  it('the death shroud gradient does not run from a colour to itself', () => {
    const body = ruleBody('.death-overlay');
    const grad = /background:\s*radial-gradient\(([^;]*)\)/.exec(body)?.[1] ?? '';
    expect(grad).not.toBe('');
    const stops = grad.match(/var\(--[a-z-]+\)|transparent/g) ?? [];
    expect(stops.length).toBeGreaterThanOrEqual(2);
    // resolve every var through APAL; `transparent` is its own distinct stop
    const resolved = stops.map((s) => {
      if (s === 'transparent') return 'transparent';
      const varName = s.slice(4, -1);
      const key = (Object.keys(APAL_CSS_VARS) as AncientsPaletteKey[]).find(
        (k) => APAL_CSS_VARS[k] === varName,
      );
      return key === undefined ? varName : APAL[key].toLowerCase();
    });
    expect(new Set(resolved).size).toBe(resolved.length);
  });

  it('the glass plates transmit meaningfully more than a tenth of the world', () => {
    // --plate-opacity 0.9 measured 6-12% transmission: a slab. Anything at or
    // above 0.85 is back there. The upper bound is the §8 7:1 contrast floor,
    // measured in the scratchpad harness at 0.78 -> 8.34:1 worst stop.
    const v = /--plate-opacity:\s*([\d.]+)/.exec(bare)?.[1];
    expect(v).toBeDefined();
    const n = Number(v);
    expect(n).toBeLessThanOrEqual(0.82);
    expect(n).toBeGreaterThanOrEqual(0.7);
  });

  it('an empty item socket is not dimmed into the plate', () => {
    const body = ruleBody('.item-slot--empty');
    // the 0.4 fade was half the reason five of six sockets vanished
    expect(/opacity:\s*0?\.[0-6]/.test(body)).toBe(false);
    // and it must name a border colour of its own: inheriting --stone-deep on
    // the --slot-face gradient measured 1.01:1
    expect(/border-color:\s*var\(--[a-z-]+\)/.test(body)).toBe(true);
  });

  it('.minimap declares touch-action so a drag-order survives a finger', () => {
    expect(/touch-action:\s*none/.test(ruleBody('.minimap'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PART 2 — a DOM double, then the real createHud driven through it
// ---------------------------------------------------------------------------

interface Timer {
  readonly fn: () => void;
  readonly at: number;
}

const timers: Timer[] = [];

class El {
  className = '';
  title = '';
  innerHTML = '';
  onclick: ((ev: unknown) => void) | null = null;
  onpointerenter: ((ev: unknown) => void) | null = null;
  onpointerleave: ((ev: unknown) => void) | null = null;
  onfocus: ((ev: unknown) => void) | null = null;
  onblur: ((ev: unknown) => void) | null = null;
  readonly attrs: Record<string, string> = {};
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  readonly dataset: Record<string, string> = {};
  readonly childNodes: El[] = [];
  parentNode: El | null = null;
  private text = '';
  /** Every element is laid out; `floatFrom` bails on a zero-size anchor, and a
   *  test that silently exercised that bail would be worthless. */
  rect = { left: 100, top: 200, width: 64, height: 64, right: 164, bottom: 264, x: 100, y: 200 };

  /** CHANGING style writes only, in `prop=value` form.
   *
   *  Blink does not dirty the style attribute when a property is assigned the
   *  value it already holds, so a raw set count would flag two dozen harmless
   *  `display = 'none'` re-assignments and say nothing. Recording only writes
   *  that change the value makes this double agree with what a real
   *  MutationObserver over the .hud subtree reports, which is what the §5
   *  per-frame rule is actually about. */
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

  readonly classList = {
    add: (c: string): void => {
      if (!this.classNames().includes(c)) this.className = `${this.className} ${c}`.trim();
    },
    remove: (c: string): void => {
      this.className = this.classNames().filter((n) => n !== c).join(' ');
    },
    contains: (c: string): boolean => this.classNames().includes(c),
    toggle: (c: string, force?: boolean): void => {
      const on = force ?? !this.classNames().includes(c);
      if (on) this.classList.add(c);
      else this.classList.remove(c);
    },
  };

  private classNames(): string[] {
    return this.className.split(/\s+/).filter((s) => s !== '');
  }

  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    this.childNodes.length = 0;
  }
  get children(): El[] {
    return this.childNodes;
  }
  get childElementCount(): number {
    return this.childNodes.length;
  }
  get firstChild(): El | null {
    return this.childNodes[0] ?? null;
  }
  get nextSibling(): El | null {
    const p = this.parentNode;
    if (p === null) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
  }
  appendChild(c: El): El {
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  insertBefore(c: El, ref: El | null): El {
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    const at = ref === null ? this.childNodes.length : this.childNodes.indexOf(ref);
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, c);
    return c;
  }
  removeChild(c: El): void {
    const at = this.childNodes.indexOf(c);
    if (at >= 0) this.childNodes.splice(at, 1);
    c.parentNode = null;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  replaceChildren(...nodes: El[]): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes.length = 0;
    for (const n of nodes) this.appendChild(n);
  }
  getBoundingClientRect(): typeof this.rect {
    return this.rect;
  }
  /** Depth-first walk, for assertions about what ended up on screen. */
  *walk(): Generator<El> {
    for (const c of this.childNodes) {
      yield c;
      yield* c.walk();
    }
  }
}

function installDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { createElement: (tag: string) => new El(tag) };
  g.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: (): void => {},
    setTimeout: (fn: () => void, ms: number): number => {
      timers.push({ fn, at: ms });
      return timers.length;
    },
  };
}
installDom();

const { createHud } = await import('./hud.js');

// ---- fixtures ---------------------------------------------------------------

function you(over: Partial<YouSnap> = {}): YouSnap {
  return {
    hero: 'bullwark',
    x: 20,
    z: 20,
    hp: 800,
    maxHp: 1200,
    mana: 300,
    maxMana: 500,
    level: 5,
    xp: 900,
    gold: 1200,
    kills: 3,
    deaths: 1,
    assists: 4,
    skillPoints: 0,
    respawnAtTick: 0,
    abilities: [
      { rank: 1, cdUntilTick: 0 },
      { rank: 1, cdUntilTick: 0 },
      { rank: 1, cdUntilTick: 0 },
      { rank: 0, cdUntilTick: 0 },
    ],
    items: [null, null, null, null, null, null],
    itemCharges: [0, 0, 0, 0, 0, 0],
    itemCdUntilTick: [0, 0, 0, 0, 0, 0],
    ...over,
  };
}

const HERO_ENT: EntSnap = { id: 77, k: 'hero', team: 0, x: 20, z: 20, hp: 800, maxHp: 1200, pid: 'p1' };

// `begin` identity is the match boundary hud.ts watches: a new object means a
// new match and resets every baseline (events, gold, ranks). These must be
// stable across the frames of one test or nothing that diffs can ever fire.
const HELLO = {
  t: 'rift_hello',
  you: 'p1',
  roomId: 'r',
  code: null,
  team: 0,
  teamSize: 1,
  roster: [],
} as const;
const BEGIN = {
  t: 'rift_begin',
  lanes: 3,
  teamSize: 1,
  startAtTick: 0,
  laneAssignment: { p1: 0 },
} as const;

interface StateOver {
  youSnap?: YouSnap | null;
  events?: readonly RiftEvent[];
  overtime?: boolean;
  dayPhase?: number;
  matchTick?: number;
}

function state(over: StateOver = {}): Parameters<ReturnType<typeof createHud>['render']>[0] {
  const y = over.youSnap === undefined ? you() : over.youSnap;
  return {
    phase: 'live',
    connected: true,
    error: null,
    hello: HELLO,
    lobby: null,
    begin: BEGIN,
    snap: {
      t: 'rift_snap',
      tick: 100,
      serverTime: 0,
      phase: 'live',
      matchTick: over.matchTick ?? 600,
      overtime: over.overtime ?? false,
      dayPhase: over.dayPhase ?? 0,
      wardStock: 2,
      kills: [3, 2],
      board: [
        { id: 'p1', hero: 'bullwark', team: 0, level: 5, kills: 3, deaths: 1, assists: 4, bot: false, connected: true },
      ],
      you: y,
      ents: [HERO_ENT],
    },
    interp: null,
    fog: null,
    end: null,
    events: over.events ?? [],
    shopOpen: false,
    scoreboardOpen: false,
    cameraX: 20,
    cameraZ: 20,
    cameraHeight: 20,
    toast: null,
  };
}

const ACTIONS = {
  send: (): void => {},
  toggleShop: (): void => {},
  setScoreboard: (): void => {},
  centerCamera: (): void => {},
  panCameraTo: (): void => {},
  leaveToMenu: (): void => {},
};

function mk(): { hud: ReturnType<typeof createHud>; root: El } {
  const parent = new El('div');
  const hud = createHud(parent as unknown as HTMLElement);
  return { hud, root: hud.root as unknown as El };
}

function find(root: El, pred: (e: El) => boolean): El | null {
  for (const e of root.walk()) if (pred(e)) return e;
  return null;
}
function findAll(root: El, pred: (e: El) => boolean): El[] {
  const out: El[] = [];
  for (const e of root.walk()) if (pred(e)) out.push(e);
  return out;
}
const byClass = (root: El, cls: string): El | null =>
  find(root, (e) => e.className.split(/\s+/).includes(cls));
const floats = (root: El): El[] => findAll(root, (e) => e.className === 'dmg-number');

beforeEach(() => {
  timers.length = 0;
});

// ---- the MISS float ---------------------------------------------------------

describe('MISS float (defects 1, 2, 10)', () => {
  const miss = (attacker: number, target: number): RiftEvent => ({ t: 'rift_miss', attacker, target });

  it('is never colour-alone: the two directions differ in WORD and ANCHOR too', () => {
    const { hud, root } = mk();
    hud.render(state({ events: [] }), ACTIONS); // baseline the event tail
    hud.render(state({ events: [miss(77, 41), miss(41, 77)] }), ACTIONS);

    const f = floats(root);
    expect(f).toHaveLength(2);
    const mine = f.find((e) => e.style.color === APAL.danger);
    const theirs = f.find((e) => e.style.color === APAL.heal);
    expect(mine?.textContent).toBe('MISS');
    expect(theirs?.textContent).toBe('EVADED');
    // and the words are genuinely different, which is the whole defect
    expect(mine?.textContent).not.toBe(theirs?.textContent);

    // the anchors differ too — the portrait and the hp bar are separate boxes
    const portrait = byClass(root, 'hud-portrait');
    const barHp = byClass(root, 'bar-hp');
    expect(portrait).not.toBeNull();
    expect(barHp).not.toBeNull();
    portrait!.rect = { ...portrait!.rect, left: 300, top: 900, width: 64, height: 64 };
    barHp!.rect = { ...barHp!.rect, left: 500, top: 905, width: 200, height: 14 };
    const { hud: h2, root: r2 } = mk();
    const p2 = byClass(r2, 'hud-portrait')!;
    const b2 = byClass(r2, 'bar-hp')!;
    p2.rect = { ...p2.rect, left: 300, top: 900, width: 64, height: 64 };
    b2.rect = { ...b2.rect, left: 500, top: 905, width: 200, height: 14 };
    h2.render(state({ events: [] }), ACTIONS);
    h2.render(state({ events: [miss(77, 41), miss(41, 77)] }), ACTIONS);
    const g = floats(r2);
    const gm = g.find((e) => e.textContent === 'MISS');
    const ge = g.find((e) => e.textContent === 'EVADED');
    expect(gm?.style.left).toBe('332px'); // portrait centre
    expect(ge?.style.left).toBe('600px'); // hp-bar centre
    expect(gm?.style.left).not.toBe(ge?.style.left);
  });

  it('a miss flood cannot starve the gold pill (per-channel budgets)', () => {
    const { hud, root } = mk();
    hud.render(state({ events: [] }), ACTIONS);
    // twelve of my own whiffs in one drain — far past any single-channel cap
    const flood: RiftEvent[] = [];
    for (let i = 0; i < 12; i++) flood.push(miss(77, 41));
    hud.render(state({ events: flood }), ACTIONS);
    const missPills = floats(root).filter((e) => e.textContent === 'MISS');
    expect(missPills.length).toBeGreaterThan(0);
    expect(missPills.length).toBeLessThanOrEqual(4); // capped, not unbounded

    // now spend gold on the very next frame, with the miss channel still full
    hud.render(state({ events: flood, youSnap: you({ gold: 700 }) }), ACTIONS);
    const goldPills = floats(root).filter((e) => e.textContent?.endsWith('g'));
    expect(goldPills).toHaveLength(1);
    expect(goldPills[0]?.style.color).toBe(APAL.gold);
  });

  it('CONTRACT DEPENDENCY: the float stays labelled unreachable until the wire carries it', () => {
    // A tripwire, and a real one: it must be possible for it to go RED.
    //
    // The chain is room.ts (SimEvent 'miss' -> RiftEvent) -> net.ts parseEvent
    // -> ClientState.events -> drainMisses. Two links are missing today, and
    // neither file is R_HUD's. The rule this pins is the reporting rule from
    // AMENDMENT_3 §G: a feature that cannot fire must not be presented as
    // working. So while EITHER link is missing, hud.ts must carry the note
    // that says so — delete the note and this fails. Once both links land the
    // note is no longer required and the test passes either way.
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const parses = /case 'rift_miss'/.test(read('../net.ts'));
    const emits = /case 'miss'/.test(
      read('../../../server/src/room.ts'),
    );
    const reachable = parses && emits;
    const hud = read('./hud.ts');
    const declared = /THIS CANNOT FIRE YET/.test(hud);
    expect({ reachable, declared: reachable || declared }).toEqual({
      reachable,
      declared: true,
    });
    // and the shape the HUD consumes is the frozen one either way
    const ev: RiftEvent = { t: 'rift_miss', attacker: 1, target: 2 };
    expect(ev.t).toBe('rift_miss');
  });
});

// ---- the SURGE tooltip ------------------------------------------------------

describe('clock tooltip (defect 5)', () => {
  it('explains SURGE, and the day/night phase does not erase it', () => {
    const { hud, root } = mk();
    const clock = byClass(root, 'match-clock')!;
    hud.render(state({ overtime: true, dayPhase: 0 }), ACTIONS);
    expect(clock.title).toContain('SURGE');
    expect(clock.title).toContain('Full day'); // both halves present
    // walk the dial several rungs: renderDayNight fires and must COMPOSE
    for (const p of [0.2, 0.4, 0.6, 0.8, 1]) {
      hud.render(state({ overtime: true, dayPhase: p }), ACTIONS);
      expect(clock.title).toContain('SURGE');
    }
    // and leaving overtime drops it again
    hud.render(state({ overtime: false, dayPhase: 1 }), ACTIONS);
    expect(clock.title).not.toContain('SURGE');
    expect(clock.title).toContain('NIGHT');
  });
});

// ---- the terrain chips ------------------------------------------------------

describe('terrain state chips (defect 6)', () => {
  function chipRow(root: El): El {
    const bars = byClass(root, 'hud-bars')!;
    const row = bars.childNodes.find((c) => c.className === '' && c.tagName === 'div');
    if (!row) throw new Error('no chip row');
    return row;
  }

  it('shows while the hero is alive', () => {
    const { hud, root } = mk();
    hud.render(state(), ACTIONS);
    expect(chipRow(root).style.visibility ?? '').not.toBe('hidden');
    expect(chipRow(root).childNodes[0]?.textContent).toMatch(/HIGH|LOW/);
  });

  it('is hidden while the hero is dead, so no LOW chip reads under the overlay', () => {
    const { hud, root } = mk();
    hud.render(state(), ACTIONS);
    hud.render(state({ youSnap: you({ respawnAtTick: 900 }), matchTick: 600 }), ACTIONS);
    expect(byClass(root, 'death-overlay')?.style.display).toBe('');
    expect(chipRow(root).style.visibility).toBe('hidden');
    // the same 300 ticks the overlay is up for are the ones it counts down
    expect(byClass(root, 'respawn-count')?.textContent).toBe(
      String(Math.ceil(300 * TICK_DT)),
    );
  });

  it('is hidden when the you-snapshot is null', () => {
    const { hud, root } = mk();
    hud.render(state(), ACTIONS);
    hud.render(state({ youSnap: null }), ACTIONS);
    expect(chipRow(root).style.visibility).toBe('hidden');
  });

  it('comes back, freshly written, on respawn', () => {
    const { hud, root } = mk();
    hud.render(state(), ACTIONS);
    hud.render(state({ youSnap: you({ respawnAtTick: 900 }), matchTick: 600 }), ACTIONS);
    hud.render(state({ youSnap: you({ x: 20, z: 20 }), matchTick: 950 }), ACTIONS);
    expect(chipRow(root).style.visibility).toBe('');
    expect(chipRow(root).childNodes[0]?.textContent).toMatch(/HIGH|LOW/);
  });

  it('does not change the bars column height when it hides (visibility, not display)', () => {
    const { hud, root } = mk();
    hud.render(state(), ACTIONS);
    hud.render(state({ youSnap: null }), ACTIONS);
    // display:none would take the row out of flow and slide the bars down 16px
    expect(chipRow(root).style.display ?? '').not.toBe('none');
  });
});

// ---- the kill feed ----------------------------------------------------------

describe('kill feed (defect 9)', () => {
  const kill = (victim: string, gold: number): RiftEvent => ({
    t: 'rift_kill',
    killer: 'p1',
    victim,
    gold,
    firstBlood: false,
  });

  it('keeps existing row elements when one new kill arrives', () => {
    const { hud, root } = mk();
    const feed = byClass(root, 'killfeed')!;
    hud.render(state({ events: [kill('a', 100), kill('b', 110)] }), ACTIONS);
    expect(feed.childNodes).toHaveLength(2);
    const before = [...feed.childNodes];

    hud.render(state({ events: [kill('a', 100), kill('b', 110), kill('c', 120)] }), ACTIONS);
    expect(feed.childNodes).toHaveLength(3);
    // the two survivors are the SAME objects — a recreated element replays the
    // one-shot rift-feed-in slide, which is the defect
    expect(feed.childNodes).toContain(before[0]);
    expect(feed.childNodes).toContain(before[1]);
    // and the newcomer is at the front (newest first)
    expect(before).not.toContain(feed.childNodes[0]);
  });

  it('drops rows that left the events window without touching the rest', () => {
    const { hud, root } = mk();
    const feed = byClass(root, 'killfeed')!;
    hud.render(state({ events: [kill('a', 100), kill('b', 110)] }), ACTIONS);
    // rows are keyed `killer>victim>gold>firstBlood#ordinal`; match on the key
    // rather than the rendered text, which is identical for both rows here
    const kept = feed.childNodes.find((e) => e.dataset.key?.includes('>a>100>'));
    expect(kept).toBeDefined();
    hud.render(state({ events: [kill('a', 100)] }), ACTIONS);
    expect(feed.childNodes).toHaveLength(1);
    expect(feed.childNodes[0]).toBe(kept);
  });
});

// ---- the vision readout (defect 14, kept) -----------------------------------

describe('day/night vision readout (defect 14 — the ramp, not the flat multiplier)', () => {
  it('quotes the ramp value at the phase, not NIGHT_VISION_MULT from the midpoint', () => {
    const { hud, root } = mk();
    const clock = byClass(root, 'match-clock')!;
    const tag = clock.childNodes.find((c) => c.tagName === 'em')!;
    // NIGHT_VISION_MULT is 0.75, so a boolean reading of TERRAIN_CONTRACT
    // §4.3 would print a flat -25% from phase 0.5 onward. The frozen ramp
    // `nightVisionScale(0.5)` is 0.875, i.e. -12.5% -> -13%: HALF the penalty
    // the flat figure would have claimed.
    hud.render(state({ dayPhase: 0.5 }), ACTIONS);
    expect(tag.textContent).toContain('13%');
    expect(tag.textContent).not.toContain('25%');
    hud.render(state({ dayPhase: 1 }), ACTIONS);
    expect(tag.textContent).toContain('25%'); // only at full night
  });
});

// ---- per-frame DOM traffic --------------------------------------------------

describe('per-frame DOM traffic (GRAPHICS_CONTRACT §5)', () => {
  it('a settled frame changes no style property, ult sweep included', () => {
    // A level-5 hero has the ult locked (ULT_LEVEL_REQ), which is the state
    // that used to write the sweep overlay twice per frame — once as a 0%
    // cooldown wipe, then again as the 100% 'LV 6' plate. Two frames to settle,
    // then a third that must be silent.
    const { hud, root } = mk();
    const s = state({ youSnap: you({ level: 5 }) });
    hud.render(s, ACTIONS);
    hud.render(s, ACTIONS);
    const nodes = findAll(root, () => true);
    const mark = nodes.map((e) => e.styleWrites.length);
    hud.render(s, ACTIONS);
    const churn = nodes
      .map((e, i) => ({ el: e.className || e.tagName, writes: e.styleWrites.slice(mark[i]) }))
      .filter((x) => x.writes.length > 0);
    expect(churn).toEqual([]);
    // and the slot still ends up showing the unlock level, not a cooldown
    const locked = findAll(root, (e) => e.className === 'ability-cd').at(3);
    expect(locked?.style.height).toBe('100%');
    expect(locked?.textContent).toBe('LV 6');
  });
});

// ---- the ability tooltip (rich card replacing the native title) -------------

describe('ability tooltip', () => {
  const abilitySlots = (root: El): El[] =>
    findAll(root, (e) => e.className.split(/\s+/).includes('ability-slot'));
  /** The card's whole text — the double's textContent does not roll children
   *  up into the parent, so walk and join. */
  const tipText = (tip: El): string =>
    [tip.textContent, ...[...tip.walk()].map((e) => e.textContent)].join(' | ');

  it('shows on hover with current-rank numbers and the next rank after an arrow', () => {
    // the fixture: bullwark, Q (Shield Crash) at rank 1 of 4
    const { hud, root } = mk();
    hud.render(state(), ACTIONS);
    const q = abilitySlots(root)[0]!;
    q.onpointerenter?.(null);
    const tip = byClass(root, 'tooltip')!;
    expect(tip).not.toBeNull();
    expect(tip.style.display).not.toBe('none');
    const text = tipText(tip);
    expect(text).toContain('Shield Crash');
    expect(text).toContain('⬢');
    expect(text).toContain('Q');
    expect(text).toContain('Dash to a point'); // the blurb line
    expect(text).toContain('1 of 4');
    expect(text).toContain('Cooldown');
    expect(text).toContain('14s → 13s'); // rank 1 → rank 2
    expect(text).toContain('Mana cost');
    expect(text).not.toContain('70 → 70'); // flat across ranks: no empty arrow
    expect(text).toContain('Cast range');
    expect(text).toContain('7m');
    expect(text).toContain('Effect radius');
    expect(text).toContain('2.2m');
    expect(text).toContain('Physical damage');
    expect(text).toContain('70 → 120');
    expect(text).toContain('Stun');
    expect(text).toContain('0.8s → 1s');
    expect(text).toContain('Dash');
    // positioned above the slot, horizontally clamped inside the viewport
    expect(tip.style.top).toMatch(/^\d+px$/);
    expect(Number((tip.style.left ?? '').replace('px', ''))).toBeGreaterThanOrEqual(8);
  });

  it('sets no native title on the ability slots and carries a one-line aria-label', () => {
    const { hud, root } = mk();
    hud.render(state(), ACTIONS);
    const slots = abilitySlots(root);
    expect(slots).toHaveLength(4);
    for (const s of slots) expect(s.title).toBe('');
    expect(slots[0]!.attrs['aria-label']).toBe('Shield Crash (Q)');
  });

  it('hides on pointerleave and shows/hides on focus/blur for keyboard users', () => {
    const { hud, root } = mk();
    hud.render(state(), ACTIONS);
    const q = abilitySlots(root)[0]!;
    const tip = byClass(root, 'tooltip')!;
    expect(tip.style.display).toBe('none'); // hidden by default
    q.onpointerenter?.(null);
    expect(tip.style.display).not.toBe('none');
    q.onpointerleave?.(null);
    expect(tip.style.display).toBe('none');
    q.onfocus?.(null);
    expect(tip.style.display).not.toBe('none');
    q.onblur?.(null);
    expect(tip.style.display).toBe('none');
  });

  it('an unlearned ability previews rank-1 values and says so (no next-rank arrow)', () => {
    // the fixture leaves the ult (Rally) at rank 0
    const { hud, root } = mk();
    hud.render(state(), ACTIONS);
    abilitySlots(root)[3]!.onpointerenter?.(null);
    const text = tipText(byClass(root, 'tooltip')!);
    expect(text).toContain('Rally');
    expect(text).toContain('ULT');
    expect(text).toContain('not learned — rank 1 of 2');
    expect(text).toContain('80s'); // rank-1 cooldown
    expect(text).toContain('200'); // rank-1 heal
    expect(text).not.toContain('→'); // no next-rank preview while unlearned
  });

  it('a passive shows the PASSIVE tag and no cooldown/mana rows', () => {
    // Bulwark (W) at rank 1: a flat armor aura, radius 8
    const { hud, root } = mk();
    hud.render(state(), ACTIONS);
    abilitySlots(root)[1]!.onpointerenter?.(null);
    const text = tipText(byClass(root, 'tooltip')!);
    expect(text).toContain('Bulwark');
    expect(text).toContain('PASSIVE');
    expect(text).toContain('Aura — Armour');
    expect(text).toContain('+3 · 8m → +5 · 8m');
    expect(text).not.toContain('Cooldown');
    expect(text).not.toContain('Mana cost');
  });

  it('a max-rank ability shows no next-rank preview', () => {
    const { hud, root } = mk();
    hud.render(
      state({
        youSnap: you({
          abilities: [
            { rank: 4, cdUntilTick: 0 },
            { rank: 1, cdUntilTick: 0 },
            { rank: 1, cdUntilTick: 0 },
            { rank: 0, cdUntilTick: 0 },
          ],
        }),
      }),
      ACTIONS,
    );
    abilitySlots(root)[0]!.onpointerenter?.(null);
    const text = tipText(byClass(root, 'tooltip')!);
    expect(text).toContain('4 of 4');
    expect(text).toContain('11s'); // rank-4 cooldown
    expect(text).not.toContain('→');
  });
});

// ---- sanity: the render loop survives a bare frame ---------------------------

describe('robustness', () => {
  it('renders a live frame with no you-snapshot and no events without throwing', () => {
    const { hud } = mk();
    expect(() => hud.render(state({ youSnap: null, events: [] }), ACTIONS)).not.toThrow();
  });

  it('a non-live phase hides the root and does no work', () => {
    const { hud, root } = mk();
    const s = { ...state(), phase: 'menu' as const };
    hud.render(s, ACTIONS);
    expect(root.style.display).toBe('none');
  });
});
