// ============================================================================
// R_SHOP regression suite. `shop.ts` was just rewritten (three tier sections
// plus a new inventory strip with sell/drop) and shipped with ZERO test
// coverage — the client suite was green only because nothing exercised it.
// A green gate that never renders the thing under test is exactly the failure
// mode this file exists to close.
//
// This workspace has no jsdom. Following hud.test.ts's "PART 2" pattern, this
// file installs a small hand-written DOM double (`El`, below) implementing
// only what shop.ts touches — createElement/className/appendChild/textContent
// /style/disabled/title/onclick — and drives the REAL `createShop` through it.
//
// One deliberate departure from hud.test.ts's double: `El.click()` enforces
// the same rule a real `<button disabled>` enforces in a browser — a disabled
// button's onclick never fires. shop.ts relies entirely on that browser
// behaviour to make its courtesy greying (insufficient gold / missing recipe
// components / outside the fountain / dead) actually block the action; a
// double that invoked `.onclick()` directly would rubber-stamp a shop.ts that
// silently sent buy/sell/drop messages from a greyed-out button. Tests below
// always click through `.click()`, never call `.onclick()` directly.
//
// Every behavioural test names the rule it pins (§ numbers refer to the
// numbered case list this file was specified against).
// ============================================================================
import { describe, expect, it } from 'vitest';

import { FOUNTAIN_RADIUS, INVENTORY_SLOTS, ITEMS, ITEM_LIST, itemTier, itemTotalCost, sellValue } from '@rift/shared';
import type { EntSnap, ItemId, RiftC2S, YouSnap } from '@rift/shared';
import type { ClientState, HelloMsg, SnapMsg, UiActions, UiHandle } from '../contract.js';

// ---------------------------------------------------------------------------
// PART 1 — the DOM double
// ---------------------------------------------------------------------------

class El {
  className = '';
  title = '';
  disabled = false;
  onclick: (() => void) | null = null;
  readonly childNodes: El[] = [];
  readonly style: Record<string, string> = {};
  private text = '';

  constructor(readonly tagName: string) {}

  appendChild(c: El): El {
    this.childNodes.push(c);
    return c;
  }

  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    this.childNodes.length = 0;
  }

  /** Real-browser semantics: a disabled button never invokes its click
   *  handler. This is what actually enforces shop.ts's courtesy greying from
   *  the outside, exactly as a real `<button disabled>` would. */
  click(): void {
    if (!this.disabled) this.onclick?.();
  }

  /** Depth-first walk of DESCENDANTS (not self), for assertions about what
   *  ended up in the tree. */
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
}
installDom();

const { createShop } = await import('./shop.js');

// ---------------------------------------------------------------------------
// PART 2 — tree helpers
// ---------------------------------------------------------------------------

function find(root: El, pred: (e: El) => boolean): El | null {
  for (const e of root.walk()) if (pred(e)) return e;
  return null;
}
function findAll(root: El, pred: (e: El) => boolean): El[] {
  const out: El[] = [];
  for (const e of root.walk()) if (pred(e)) out.push(e);
  return out;
}

/** Every classname in the tree, root included, non-empty tokens only. */
function allClassNames(root: El): Set<string> {
  const set = new Set<string>();
  const consider = (e: El): void => {
    for (const c of e.className.split(/\s+/)) if (c !== '') set.add(c);
  };
  consider(root);
  for (const e of root.walk()) consider(e);
  return set;
}

/** All text in an element's subtree, concatenated depth-first. */
function allText(e: El): string {
  let out = e.textContent;
  for (const c of e.childNodes) out += ` ${allText(c)}`;
  return out;
}

function nth(e: El, i: number): El {
  const c = e.childNodes[i];
  if (c === undefined) throw new Error(`${e.tagName}.${e.className || '(classless)'} has no child at index ${i}`);
  return c;
}

function findGrids(root: El): El[] {
  return findAll(root, (e) => e.className === 'shop-grid');
}

/** Matches on the button's OWN name element (child index 1) only — matching
 *  anywhere in the subtree is wrong because a recipe row's "Needs: …" line
 *  names its components too (e.g. fang and stormbow both name "Bladestone"),
 *  which would multi-match on the component's own name. */
function findItemButton(root: El, name: string): El {
  const matches = findAll(root, (e) => e.className === 'shop-item' && nth(e, 1).textContent === name);
  const btn = matches[0];
  if (btn === undefined) throw new Error(`no .shop-item button named "${name}"`);
  if (matches.length > 1) throw new Error(`"${name}" matched ${matches.length} .shop-item buttons, expected 1`);
  return btn;
}

/** The classless column of INVENTORY_SLOTS rows: located structurally (a
 *  classless div with exactly INVENTORY_SLOTS children, each a 4-child row
 *  ending in two buttons) rather than by a fixed tree index, so this does not
 *  silently start reading the wrong div if shop.ts's section order changes. */
function findInventoryList(root: El): El {
  const candidates = findAll(
    root,
    (e) =>
      e.tagName === 'div' &&
      e.className === '' &&
      e.childNodes.length === INVENTORY_SLOTS &&
      e.childNodes.every(
        (row) => row.childNodes.length === 4 && nth(row, 2).tagName === 'button' && nth(row, 3).tagName === 'button',
      ),
  );
  const list = candidates[0];
  if (list === undefined) throw new Error('no inventory row list found in the rendered shop tree');
  return list;
}

interface InvRowEls {
  readonly icon: El;
  readonly name: El;
  readonly sellBtn: El;
  readonly dropBtn: El;
}

function invRow(root: El, slot: number): InvRowEls {
  const list = findInventoryList(root);
  const row = list.childNodes[slot];
  if (row === undefined) throw new Error(`inventory slot ${slot} out of range (0..${INVENTORY_SLOTS - 1})`);
  return { icon: nth(row, 0), name: nth(row, 1), sellBtn: nth(row, 2), dropBtn: nth(row, 3) };
}

// ---------------------------------------------------------------------------
// PART 3 — fixtures
// ---------------------------------------------------------------------------

/** Own-team Ancient, fixed at the origin. Tests move the HERO near/far from
 *  it (via `you({ x, z })`) to control `atFountain` rather than moving the
 *  Ancient, so every fixture shares one anchor. */
function ancientEnt(): EntSnap {
  return { id: 900, k: 'ancient', team: 0, x: 0, z: 0, hp: 5000, maxHp: 5000 };
}

const AT_FOUNTAIN = { x: 0, z: 0 } as const; // distance 0 <= FOUNTAIN_RADIUS (6)
const AWAY_FROM_FOUNTAIN = { x: 500, z: 500 } as const; // distance ~707 > 6

function you(over: Partial<YouSnap> = {}): YouSnap {
  return {
    hero: 'bullwark',
    x: AT_FOUNTAIN.x,
    z: AT_FOUNTAIN.z,
    hp: 800,
    maxHp: 1200,
    mana: 300,
    maxMana: 500,
    level: 1,
    xp: 0,
    gold: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    skillPoints: 0,
    respawnAtTick: 0,
    abilities: [
      { rank: 0, cdUntilTick: 0 },
      { rank: 0, cdUntilTick: 0 },
      { rank: 0, cdUntilTick: 0 },
      { rank: 0, cdUntilTick: 0 },
    ],
    items: [null, null, null, null, null, null],
    itemCharges: [0, 0, 0, 0, 0, 0],
    itemCdUntilTick: [0, 0, 0, 0, 0, 0],
    ...over,
  };
}

const HELLO: HelloMsg = { t: 'rift_hello', you: 'p1', roomId: 'r', code: null, team: 0, teamSize: 1, roster: [] };

interface StateOver {
  you?: YouSnap | null;
  shopOpen?: boolean;
  phase?: ClientState['phase'];
  /** Bypasses the you/ents-built snap entirely — used only for the `snap ===
   *  null` robustness case. */
  snapOverride?: SnapMsg | null;
}

function state(over: StateOver = {}): ClientState {
  const snap: SnapMsg | null =
    over.snapOverride !== undefined
      ? over.snapOverride
      : {
          t: 'rift_snap',
          tick: 0,
          serverTime: 0,
          phase: 'live',
          matchTick: 0,
          overtime: false,
          dayPhase: 0,
          wardStock: 0,
          kills: [0, 0],
          board: [],
          you: over.you !== undefined ? over.you : you(),
          ents: [ancientEnt()],
        };
  return {
    phase: over.phase ?? 'live',
    connected: true,
    error: null,
    hello: HELLO,
    lobby: null,
    begin: null,
    snap,
    interp: null,
    fog: null,
    end: null,
    events: [],
    shopOpen: over.shopOpen ?? true,
    scoreboardOpen: false,
    cameraX: 0,
    cameraZ: 0,
    cameraHeight: 0,
    toast: null,
  };
}

function sentActions(): { actions: UiActions; sent: RiftC2S[] } {
  const sent: RiftC2S[] = [];
  return {
    sent,
    actions: {
      send: (msg) => {
        sent.push(msg);
      },
      toggleShop: () => {},
      setScoreboard: () => {},
      centerCamera: () => {},
      panCameraTo: () => {},
      leaveToMenu: () => {},
    },
  };
}

function mk(): { shop: UiHandle; root: El } {
  const parent = new El('div');
  const shop = createShop(parent as unknown as HTMLElement);
  return { shop, root: shop.root as unknown as El };
}

// ---------------------------------------------------------------------------
// PART 4 — structure / DOM class contract (cases 1-4)
// ---------------------------------------------------------------------------

describe('panel visibility (case 1)', () => {
  it('is hidden unless phase is live AND shopOpen, visible when both hold', () => {
    const { shop, root } = mk();
    const { actions } = sentActions();

    shop.render(state({ phase: 'lobby', shopOpen: true }), actions);
    expect(root.style.display, 'lobby phase + shopOpen should still hide the panel').toBe('none');

    shop.render(state({ phase: 'live', shopOpen: false }), actions);
    expect(root.style.display, 'live phase but shopOpen:false should hide the panel').toBe('none');

    shop.render(state({ phase: 'ended', shopOpen: true }), actions);
    expect(root.style.display, 'ended phase + shopOpen should still hide the panel').toBe('none');

    shop.render(state({ phase: 'live', shopOpen: true }), actions);
    expect(root.style.display, 'live + shopOpen should show the panel').toBe('');
  });
});

const ALLOWED_CLASSES = ['shop-cost', 'shop-grid', 'shop-item', 'shop-panel'];

describe('DOM class contract (case 2)', () => {
  it('emits ONLY shop-panel / shop-grid / shop-item / shop-cost — nothing else', () => {
    const { shop, root } = mk();
    const { actions } = sentActions();
    // Populate every branch (recipe rows, occupied + empty inventory slots)
    // so a class hiding behind an unrendered branch cannot slip through.
    shop.render(
      state({ you: you({ gold: 5000, items: ['fang', 'reaperedge', null, null, null, null] }) }),
      actions,
    );

    const classes = [...allClassNames(root)].sort();
    const offenders = classes.filter((c) => !ALLOWED_CLASSES.includes(c));
    expect(offenders, `unexpected class names rendered: ${offenders.join(', ')}`).toEqual([]);
    expect(classes, 'the exact DOM class contract from the shop.ts header comment').toEqual(ALLOWED_CLASSES);
  });
});

describe('catalogue partition (case 3)', () => {
  it('has exactly 3 .shop-grid sections and every ITEM_LIST entry exactly once, partitioned by tier', () => {
    const { root } = mk();
    const grids = findGrids(root);
    expect(grids, 'expected one .shop-grid per tier: BASE / FUSED / ULTIMATE').toHaveLength(3);

    const allItemButtons = findAll(root, (e) => e.className === 'shop-item');
    expect(allItemButtons, `every catalogue item should render exactly once (${ITEM_LIST.length} total)`).toHaveLength(
      ITEM_LIST.length,
    );

    const expectedByTier = [1, 2, 3].map((n) => ITEM_LIST.filter((d) => itemTier(d.id) === n).length);
    expect(expectedByTier, 'sanity: expected per-tier counts from the shared catalogue').toEqual([7, 5, 4]);

    const actualByTier = grids.map((g) => g.childNodes.filter((c) => c.className === 'shop-item').length);
    expect(actualByTier, 'per-tier .shop-item counts (BASE/FUSED/ULTIMATE grid order) should match ITEM_LIST').toEqual(
      expectedByTier,
    );
  });
});

describe('font size floor (case 4)', () => {
  it('every element that sets a font size sets it >= 12px', () => {
    const FONT_MIN_PX = 12; // mirrors shop.ts's own FONT_MIN_PX
    const { shop, root } = mk();
    const { actions } = sentActions();
    shop.render(state({ you: you({ gold: 5000, items: ['fang', 'reaperedge', null, null, null, null] }) }), actions);

    const offenders: string[] = [];
    const consider = (e: El): void => {
      for (const [prop, val] of Object.entries(e.style)) {
        if (prop !== 'fontSize') continue;
        const px = Number.parseFloat(val);
        if (!(px >= FONT_MIN_PX)) offenders.push(`${e.tagName}.${e.className || '(classless)'}: ${val}`);
      }
    };
    consider(root);
    for (const e of root.walk()) consider(e);
    expect(offenders, `elements below the ${FONT_MIN_PX}px floor: ${offenders.join(', ')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PART 5 — recipe legibility (cases 5-7)
// ---------------------------------------------------------------------------

describe('recipe legibility (cases 5-7)', () => {
  it('an empty inventory shows the build path with BOTH components marked missing (case 5)', () => {
    const { shop, root } = mk();
    const { actions } = sentActions();
    shop.render(state({ you: you({ gold: 5000, items: [null, null, null, null, null, null] }) }), actions);

    const btn = findItemButton(root, ITEMS.reaperedge.name);
    const cost = nth(btn, 2);
    const total = nth(btn, 3);
    const needs = nth(btn, 5);
    expect(cost.className, 'the step-cost element carries .shop-cost').toBe('shop-cost');
    expect(cost.textContent, 'step cost shown').toBe('900g');
    expect(total.textContent, 'total investment shown').toBe(`total ${itemTotalCost('reaperedge')}g`);
    expect(needs.textContent, 'both components should read missing (✗) with empty inventory').toBe(
      'Needs: ✗Lifedrinker Fang + ✗Stormbow + 900g',
    );
  });

  it('recomputes the needs line every render, not just once at construction (case 6 — the rewrite regression)', () => {
    const { shop, root } = mk();
    const { actions } = sentActions();

    shop.render(state({ you: you({ gold: 5000, items: [null, null, null, null, null, null] }) }), actions);
    const btnBefore = findItemButton(root, ITEMS.reaperedge.name);
    expect(nth(btnBefore, 5).textContent, 'both missing before holding fang').toBe(
      'Needs: ✗Lifedrinker Fang + ✗Stormbow + 900g',
    );

    // Put fang in the inventory and re-render on the SAME handle.
    shop.render(state({ you: you({ gold: 5000, items: ['fang', null, null, null, null, null] }) }), actions);
    const btnAfter = findItemButton(root, ITEMS.reaperedge.name);
    expect(nth(btnAfter, 5).textContent, 'fang should flip to held (✓) after a re-render, stormbow stays missing').toBe(
      'Needs: ✓Lifedrinker Fang + ✗Stormbow + 900g',
    );
  });

  it('shows both the step cost and the total investment (case 7)', () => {
    const { shop, root } = mk();
    const { actions } = sentActions();
    shop.render(state({ you: you({ gold: 5000 }) }), actions);

    const btn = findItemButton(root, ITEMS.reaperedge.name);
    const stepCostText = nth(btn, 2).textContent;
    const totalText = nth(btn, 3).textContent;
    expect(stepCostText, 'step cost (900) should appear').toContain('900');
    expect(totalText, 'total (2400) should appear').toContain('2400');
    expect(itemTotalCost('reaperedge'), 'sanity: itemTotalCost matches the header-comment arithmetic (700+800+900)').toBe(
      2400,
    );
  });
});

// ---------------------------------------------------------------------------
// PART 6 — buy greying, courtesy only (case 8)
// ---------------------------------------------------------------------------

describe('buy greying — courtesy only, server remains the gate (case 8)', () => {
  it('disables every catalogue button at 0 gold, even at the fountain', () => {
    const { shop, root } = mk();
    const { actions } = sentActions();
    shop.render(state({ you: you({ gold: 0, ...AT_FOUNTAIN }) }), actions);

    const buttons = findAll(root, (e) => e.className === 'shop-item');
    expect(buttons, 'sanity: all 16 items rendered').toHaveLength(ITEM_LIST.length);
    const enabled = buttons.filter((b) => !b.disabled);
    expect(enabled.map((b) => allText(b)), 'every item should be disabled with 0 gold').toEqual([]);
  });

  it('enables a row once gold, components, and fountain proximity all hold', () => {
    const { shop, root } = mk();
    const { actions } = sentActions();
    shop.render(
      state({ you: you({ gold: 5000, items: ['fang', 'stormbow', null, null, null, null], ...AT_FOUNTAIN }) }),
      actions,
    );

    const ultimate = findItemButton(root, ITEMS.reaperedge.name);
    expect(ultimate.disabled, 'reaperedge should be buyable: gold, both components, and at the fountain').toBe(false);
    const base = findItemButton(root, ITEMS.bladestone.name);
    expect(base.disabled, 'a base item with no recipe needs only gold + fountain').toBe(false);
  });

  it('disables every row away from the fountain, even with unlimited gold and every component held', () => {
    const { shop, root } = mk();
    const { actions } = sentActions();
    // One inventory of 5 slots covers every recipe's components at once:
    // reaperedge(fang,stormbow) / aegiscolossus(aegisheart,bulwarkplate) /
    // stormherald(stormbow,warhorn) / wraithblade(fang,aegisheart).
    shop.render(
      state({
        you: you({
          gold: 999_999,
          items: ['fang', 'stormbow', 'aegisheart', 'bulwarkplate', 'warhorn', null],
          ...AWAY_FROM_FOUNTAIN,
        }),
      }),
      actions,
    );

    const buttons = findAll(root, (e) => e.className === 'shop-item');
    const enabled = buttons.filter((b) => !b.disabled);
    expect(
      enabled.map((b) => allText(b)),
      'every item should be disabled away from the fountain regardless of gold/components',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PART 7 — inventory / sell (cases 9-12)
// ---------------------------------------------------------------------------

describe('inventory rows (case 9)', () => {
  it('renders exactly INVENTORY_SLOTS rows; an empty slot shows a placeholder with both buttons disabled', () => {
    const { shop, root } = mk();
    const { actions } = sentActions();
    shop.render(state({ you: you() }), actions); // default: all 6 slots empty

    const list = findInventoryList(root);
    expect(list.childNodes, `expected exactly INVENTORY_SLOTS (${INVENTORY_SLOTS}) rows`).toHaveLength(
      INVENTORY_SLOTS,
    );

    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const row = invRow(root, i);
      expect(row.name.textContent, `slot ${i} should show the empty placeholder`).toBe('— empty —');
      expect(row.sellBtn.disabled, `slot ${i} sell button should be disabled when empty`).toBe(true);
      expect(row.dropBtn.disabled, `slot ${i} drop button should be disabled when empty`).toBe(true);
    }
  });
});

describe('sell (cases 10-12)', () => {
  it('at the fountain, alive: sell label previews the refund and clicking sends exactly rift_sell for that slot (case 10)', () => {
    const { shop, root } = mk();
    const { actions, sent } = sentActions();
    const items: (ItemId | null)[] = [null, null, null, 'fang', null, null];
    shop.render(state({ you: you({ gold: 0, items, respawnAtTick: 0, ...AT_FOUNTAIN }) }), actions);

    const row = invRow(root, 3);
    expect(row.sellBtn.textContent, 'refund should be visible before committing').toContain('420');
    expect(sellValue('fang'), 'sanity: fang sells for 420').toBe(420);

    row.sellBtn.click();
    expect(sent, 'exactly one rift_sell for slot 3').toEqual([{ t: 'rift_sell', slot: 3 }]);
  });

  it('away from the fountain: sell button is disabled and clicking it sends nothing (case 11)', () => {
    const { shop, root } = mk();
    const { actions, sent } = sentActions();
    const items: (ItemId | null)[] = [null, null, null, 'fang', null, null];
    shop.render(state({ you: you({ gold: 0, items, respawnAtTick: 0, ...AWAY_FROM_FOUNTAIN }) }), actions);

    const row = invRow(root, 3);
    expect(row.sellBtn.disabled, 'sell should be disabled away from the fountain').toBe(true);

    row.sellBtn.click();
    expect(sent, 'a disabled sell button must not send').toEqual([]);
  });

  it('sell label uses sellValue(id) per item (fang 420, reaperedge 1440) (case 12)', () => {
    const { shop, root } = mk();
    const { actions } = sentActions();
    const items: (ItemId | null)[] = ['fang', 'reaperedge', null, null, null, null];
    shop.render(state({ you: you({ gold: 0, items, ...AT_FOUNTAIN }) }), actions);

    expect(sellValue('reaperedge'), 'sanity: reaperedge sells for 1440').toBe(1440);
    expect(invRow(root, 0).sellBtn.textContent, 'slot 0 (fang) sell label').toContain('420');
    expect(invRow(root, 1).sellBtn.textContent, 'slot 1 (reaperedge) sell label').toContain('1440');
  });
});

// ---------------------------------------------------------------------------
// PART 8 — drop confirm (cases 13-15)
// ---------------------------------------------------------------------------

describe('drop two-click confirm (cases 13-15)', () => {
  it('drop works anywhere (enabled away from the fountain); first click arms, second click sends exactly once (case 13)', () => {
    const { shop, root } = mk();
    const { actions, sent } = sentActions();
    const items: (ItemId | null)[] = [null, null, 'fang', null, null, null];
    const makeState = (): ClientState =>
      state({ you: you({ gold: 0, items, respawnAtTick: 0, ...AWAY_FROM_FOUNTAIN }) });

    shop.render(makeState(), actions);
    let row = invRow(root, 2);
    expect(row.dropBtn.disabled, 'drop should be ENABLED away from the fountain (alive, occupied)').toBe(false);

    row.dropBtn.click(); // arm
    expect(sent, 'the first click must not send').toEqual([]);
    shop.render(makeState(), actions); // re-render so the label reflects the arm
    row = invRow(root, 2);
    expect(row.dropBtn.textContent, 'armed slot flips its label to the confirm state').toBe('Sure?');

    row.dropBtn.click(); // confirm
    expect(sent, 'exactly one rift_drop for slot 2, and no more').toEqual([{ t: 'rift_drop', slot: 2 }]);
  });

  it('arming a different slot moves the arm and sends nothing until that new slot is confirmed (case 14)', () => {
    const { shop, root } = mk();
    const { actions, sent } = sentActions();
    const items: (ItemId | null)[] = ['fang', 'stormbow', null, null, null, null];
    shop.render(state({ you: you({ gold: 0, items, respawnAtTick: 0, ...AWAY_FROM_FOUNTAIN }) }), actions);

    const rowA = invRow(root, 0);
    const rowB = invRow(root, 1);

    rowA.dropBtn.click(); // arms slot 0
    rowB.dropBtn.click(); // moves the arm to slot 1 (does NOT confirm slot 0)
    expect(sent, 'arming a different slot must not send anything').toEqual([]);

    rowB.dropBtn.click(); // confirms slot 1
    expect(sent, 'only the confirmed slot (1) should send, exactly once').toEqual([{ t: 'rift_drop', slot: 1 }]);
  });

  it('closing then reopening the panel disarms: the next click on the previously-armed slot sends nothing (case 15)', () => {
    const { shop, root } = mk();
    const { actions, sent } = sentActions();
    const items: (ItemId | null)[] = [null, null, null, 'fang', null, null];
    const openState = (): ClientState =>
      state({ you: you({ gold: 0, items, respawnAtTick: 0, ...AWAY_FROM_FOUNTAIN }), shopOpen: true });

    shop.render(openState(), actions);
    invRow(root, 3).dropBtn.click(); // arms slot 3
    expect(sent, 'arming must not send').toEqual([]);

    shop.render(state({ you: you({ items }), shopOpen: false }), actions); // close: disarms
    shop.render(openState(), actions); // reopen

    invRow(root, 3).dropBtn.click(); // this should ARM again, not confirm
    expect(sent, 'a close/reopen cycle must disarm — this click should NOT send').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PART 9 — robustness (case 16)
// ---------------------------------------------------------------------------

describe('robustness (case 16)', () => {
  it('does not throw with snap === null, and leaves every gated button disabled', () => {
    const { shop, root } = mk();
    const { actions } = sentActions();

    expect(() => shop.render(state({ snapOverride: null }), actions), 'snap === null must not throw').not.toThrow();

    // A button gated by state (catalogue + inventory sell/drop); the header
    // close (✕) button is never state-gated, so it is excluded deliberately.
    const gated = findAll(root, (e) => e.tagName === 'button' && e.title !== 'Close the shop');
    expect(gated.length, 'sanity: there should be gated buttons to check').toBeGreaterThan(0);
    const stillEnabled = gated.filter((b) => !b.disabled);
    expect(stillEnabled.map((b) => allText(b)), 'every gated button should be disabled when snap is null').toEqual([]);
  });

  it('does not throw with snap.you === null, and leaves every gated button disabled', () => {
    const { shop, root } = mk();
    const { actions } = sentActions();

    expect(() => shop.render(state({ you: null }), actions), 'snap.you === null must not throw').not.toThrow();

    const gated = findAll(root, (e) => e.tagName === 'button' && e.title !== 'Close the shop');
    const stillEnabled = gated.filter((b) => !b.disabled);
    expect(stillEnabled.map((b) => allText(b)), 'every gated button should be disabled when you is null').toEqual([]);
  });
});
