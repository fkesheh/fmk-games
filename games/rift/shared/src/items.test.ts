// ============================================================================
// ANCIENTS (rift) — ITEM/SHOP DATA GATE.
//
// Mechanical validation of the frozen ITEMS record (CONTRACT §12 T2): every
// item costs gold, carries display strings, and any active matches the frozen
// ItemActive union shape. ITEM_LIST must be exactly Object.values(ITEMS), and
// isItemId accepts exactly the 16 ids.
//
// THREE TIERS (amended; the old rule was "components must be base items, one
// level only" — deliberately relaxed so tier-3 ultimates can fuse two tier-2
// items). The relaxation is only safe because it is replaced here by a
// STRICTLY STRONGER guard, walked INDEPENDENTLY of item.ts's own production
// walkers (walkTotal/walkDepth), which carry their own cycle guard and would
// silently absorb a malformed graph instead of reporting it:
//   (a) recipe DEPTH is in [1, MAX_RECIPE_DEPTH] and matches ITEM_TIER/itemTier;
//   (b) the recipe graph is ACYCLIC, proved by a test-local 3-colour DFS that
//       reports the actual cycle path on failure, and is itself proven capable
//       of detecting a cycle against a synthetic fixture graph;
//   (c) TOTAL cost (test-local recursion) matches ITEM_TOTAL_COST/itemTotalCost
//       at every tier, recipe.cost === cost always, and the 9 recipe items'
//       documented totals are pinned so a silent re-price fails red;
//   (d) tier-3 items fuse EXACTLY 2 tier-2 components and tier-2 items take
//       only tier-1 components — a component's tier is always exactly one
//       less than its item's.
// Also gated: slot economics (buying an ultimate must be slot-positive against
// INVENTORY_SLOTS) and sell economics (sellValue is always a strict loss vs.
// TOTAL cost, refunding the whole fused item, not just its last recipe step).
//
// Frozen data under test (Layer-1, IMMUTABLE): item.ts.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  ITEMS,
  ITEM_LIST,
  ITEM_TIER,
  ITEM_TOTAL_COST,
  INVENTORY_SLOTS,
  MAX_RECIPE_DEPTH,
  SELL_REFUND,
  isItemId,
  itemTier,
  itemTotalCost,
  sellValue,
} from '@rift/shared';
import type { ItemId } from '@rift/shared';

const EXPECTED_ITEM_IDS: readonly ItemId[] = [
  'bladestone',
  'warmail',
  'plategirdle',
  'swiftboots',
  'manacharm',
  'fang',
  'stormbow',
  'aegisheart',
  'bulwarkplate',
  'blinkstone',
  'warhorn',
  'wardstone',
  'reaperedge',
  'aegiscolossus',
  'stormherald',
  'wraithblade',
];

describe('ITEMS record', () => {
  it('holds exactly the 16 frozen item ids, keyed by their own id', () => {
    const keys = Object.keys(ITEMS).sort();
    expect(
      keys,
      `ITEMS keys [${keys.join(', ')}] diverge from the frozen 16 [${[...EXPECTED_ITEM_IDS]
        .sort()
        .join(', ')}]`,
    ).toEqual([...EXPECTED_ITEM_IDS].sort());
    for (const [key, def] of Object.entries(ITEMS)) {
      expect(def.id, `ITEMS['${key}'].id is '${def.id}' — key and id must match`).toBe(key);
    }
  });

  it('every item costs > 0 gold and carries non-empty name/icon/blurb', () => {
    for (const def of Object.values(ITEMS)) {
      expect(
        Number.isFinite(def.cost) && def.cost > 0,
        `${def.id}: cost ${def.cost} must be a finite number > 0`,
      ).toBe(true);
      expect(def.name.length, `${def.id}: name must be non-empty`).toBeGreaterThan(0);
      expect(def.icon.length, `${def.id}: icon glyph must be non-empty`).toBeGreaterThan(0);
      expect(def.blurb.length, `${def.id}: blurb must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('active shapes are valid per the ItemActive union', () => {
    const withActive = Object.values(ITEMS).filter((d) => d.active !== undefined);
    expect(
      withActive.length,
      `expected exactly 5 active items (blinkstone/warhorn/wardstone/stormherald/wraithblade), found ` +
        `${withActive.length}: [${withActive.map((d) => d.id).join(', ')}]`,
    ).toBe(5);

    for (const def of withActive) {
      const active = def.active;
      if (active === undefined) continue;
      switch (active.kind) {
        case 'dash':
          expect(
            Number.isFinite(active.distance) && active.distance > 0,
            `${def.id}: dash distance ${active.distance} must be finite and > 0`,
          ).toBe(true);
          expect(
            Number.isFinite(active.cooldown) && active.cooldown > 0,
            `${def.id}: dash cooldown ${active.cooldown} must be finite and > 0`,
          ).toBe(true);
          break;
        case 'ward':
          expect(
            Number.isInteger(active.charges) && active.charges >= 1,
            `${def.id}: ward charges ${active.charges} must be an integer >= 1`,
          ).toBe(true);
          break;
        case 'aura':
          expect(active.stat, `${def.id}: aura stat must be 'damage'`).toBe('damage');
          expect(active.pct, `${def.id}: aura pct must be true (fraction)`).toBe(true);
          expect(
            Number.isFinite(active.amount) && active.amount > 0,
            `${def.id}: aura amount ${active.amount} must be finite and > 0`,
          ).toBe(true);
          expect(
            Number.isFinite(active.radius) && active.radius > 0,
            `${def.id}: aura radius ${active.radius} must be finite and > 0`,
          ).toBe(true);
          expect(
            Number.isFinite(active.duration) && active.duration > 0,
            `${def.id}: aura duration ${active.duration} must be finite and > 0`,
          ).toBe(true);
          expect(
            Number.isFinite(active.cooldown) && active.cooldown > 0,
            `${def.id}: aura cooldown ${active.cooldown} must be finite and > 0`,
          ).toBe(true);
          break;
      }
    }
  });

  it('recipes are valid: non-empty components, no self-reference, cost consistent', () => {
    const withRecipe = Object.values(ITEMS).filter((d) => d.recipe !== undefined);
    expect(
      withRecipe.length,
      `expected exactly 9 recipe items (fang/stormbow/aegisheart/bulwarkplate/warhorn/` +
        `reaperedge/aegiscolossus/stormherald/wraithblade), found ` +
        `${withRecipe.length}: [${withRecipe.map((d) => d.id).join(', ')}]`,
    ).toBe(9);

    for (const def of withRecipe) {
      const recipe = def.recipe;
      if (recipe === undefined) continue;
      expect(
        recipe.components.length,
        `${def.id}: recipe must list at least one component`,
      ).toBeGreaterThan(0);
      expect(
        recipe.cost === def.cost && def.cost > 0,
        `${def.id}: recipe.cost ${recipe.cost} must equal the top-level cost ${def.cost} (and cost > 0)`,
      ).toBe(true);
      for (const comp of recipe.components) {
        expect(comp, `${def.id}: a recipe may not consume itself`).not.toBe(def.id);
      }
      // NOTE: the old rule stopped here with
      //   expect(compDef.recipe, '... components must be base items (one level
      //   only)').toBeUndefined()
      // That rule was deliberately RELAXED (item.ts header) so tier-3
      // ultimates can fuse two tier-2 items. It is replaced by the strictly
      // stronger "recipe graph invariants" describe block below: a depth
      // ceiling, an independently-walked acyclicity proof, cost arithmetic
      // pinned at every tier, and an exact tier-shape check on every recipe's
      // components — together a superset of what the base-only rule bought.
    }
  });

  it('ITEM_LIST is exactly Object.values(ITEMS), element-for-element', () => {
    const values = Object.values(ITEMS);
    expect(
      ITEM_LIST.length,
      `ITEM_LIST.length=${ITEM_LIST.length} != Object.values(ITEMS).length=${values.length}`,
    ).toBe(values.length);
    values.forEach((def, i) => {
      expect(
        ITEM_LIST[i],
        `ITEM_LIST[${i}] is not ITEMS.${def.id} — the list must be the record's values ` +
          `in order (shop renders from it)`,
      ).toBe(def);
    });
  });

  it('isItemId accepts exactly the 16 frozen ids', () => {
    for (const id of EXPECTED_ITEM_IDS) {
      expect(isItemId(id), `isItemId('${id}') should be true`).toBe(true);
    }
    const bad: readonly unknown[] = [
      'Blinkstone', // case-sensitive
      '',
      'boots',
      'ward stone',
      5,
      null,
      undefined,
      {},
      [],
      'constructor', // prototype-chain trap: must not read inherited keys
    ];
    for (const v of bad) {
      expect(isItemId(v), `isItemId(${JSON.stringify(v)}) should be false`).toBe(false);
    }
  });
});

// ============================================================================
// Recipe graph invariants — the replacement for the deleted base-only rule.
// Every helper below is TEST-LOCAL and re-derives its answer from ITEMS from
// scratch; none of it calls into item.ts's walkTotal/walkDepth, because those
// production walkers carry their own path-based cycle guard (item.ts lines
// ~220-244) and would silently absorb a cyclic or malformed graph instead of
// failing loudly the way a test must.
// ============================================================================

/** base = 1, otherwise 1 + max(depth of components). No cycle guard by
 *  design: if the data were cyclic this recurses without termination and the
 *  test fails loudly (stack overflow) rather than silently — acyclicity is
 *  proven independently below. */
function localDepth(id: ItemId): number {
  const recipe = ITEMS[id].recipe;
  if (recipe === undefined) return 1;
  let deepest = 0;
  for (const comp of recipe.components) {
    const d = localDepth(comp);
    if (d > deepest) deepest = d;
  }
  return deepest + 1;
}

/** base -> its own cost, otherwise recipe.cost + sum(component totals). */
function localTotalCost(id: ItemId): number {
  const recipe = ITEMS[id].recipe;
  if (recipe === undefined) return ITEMS[id].cost;
  let sum = recipe.cost;
  for (const comp of recipe.components) sum += localTotalCost(comp);
  return sum;
}

type Colour = 'white' | 'grey' | 'black';

/** Iterative-in-spirit (recursive) 3-colour DFS over an explicit adjacency
 *  map. white = unvisited, grey = on the current path, black = fully
 *  explored. A grey node reached again is a back-edge, i.e. a cycle; the
 *  function returns the actual cycle path (for the failure message) or null
 *  if the graph is acyclic. Generic over string node ids so it can run both
 *  over the real ITEMS recipe graph and over a synthetic fixture graph. */
function findCycle(adjacency: ReadonlyMap<string, readonly string[]>): readonly string[] | null {
  const colour = new Map<string, Colour>();
  for (const node of adjacency.keys()) colour.set(node, 'white');
  const stack: string[] = [];

  function visit(node: string): readonly string[] | null {
    colour.set(node, 'grey');
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const c = colour.get(next) ?? 'white';
      if (c === 'grey') {
        const idx = stack.indexOf(next);
        return [...stack.slice(idx === -1 ? 0 : idx), next];
      }
      if (c === 'white') {
        const found = visit(next);
        if (found !== null) return found;
      }
    }
    stack.pop();
    colour.set(node, 'black');
    return null;
  }

  for (const node of adjacency.keys()) {
    if (colour.get(node) === 'white') {
      const found = visit(node);
      if (found !== null) return found;
    }
  }
  return null;
}

describe('recipe graph invariants (replaces the deleted base-only rule)', () => {
  it('recipe depth is within [1, MAX_RECIPE_DEPTH] and matches ITEM_TIER / itemTier', () => {
    for (const id of EXPECTED_ITEM_IDS) {
      const depth = localDepth(id);
      expect(
        depth >= 1 && depth <= MAX_RECIPE_DEPTH,
        `${id}: recipe depth ${depth} must be within [1, ${MAX_RECIPE_DEPTH}]`,
      ).toBe(true);
      expect(
        depth,
        `${id}: locally-computed depth ${depth} must equal ITEM_TIER['${id}']=${ITEM_TIER[id]}`,
      ).toBe(ITEM_TIER[id]);
      expect(
        depth,
        `${id}: locally-computed depth ${depth} must equal itemTier('${id}')=${itemTier(id)}`,
      ).toBe(itemTier(id));
    }
  });

  it('at least one item exists at each of tiers 1, 2, and 3', () => {
    const tiersPresent = new Set(EXPECTED_ITEM_IDS.map((id) => localDepth(id)));
    for (const tier of [1, 2, 3]) {
      expect(
        tiersPresent.has(tier),
        `expected at least one item at tier ${tier}, found tiers [${[...tiersPresent].sort().join(', ')}]`,
      ).toBe(true);
    }
  });

  it('the recipe graph is acyclic (proved by walking it, not by trusting ITEM_TIER/itemTotalCost)', () => {
    const adjacency = new Map<string, readonly string[]>(
      EXPECTED_ITEM_IDS.map((id) => [id, ITEMS[id].recipe?.components ?? []]),
    );
    const cycle = findCycle(adjacency);
    expect(
      cycle,
      `recipe graph has a cycle: ${cycle === null ? '' : cycle.join(' -> ')}`,
    ).toBeNull();
  });

  it('the local cycle detector actually detects cycles (synthetic fixture — a guard that cannot fail is not a guard)', () => {
    const cyclicFixture = new Map<string, readonly string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']], // back-edge: closes the cycle a -> b -> c -> a
      ['d', []], // an unrelated acyclic node must not confuse the walk
    ]);
    const cycle = findCycle(cyclicFixture);
    expect(
      cycle,
      'the local DFS detector must report a cycle for a synthetic graph that contains one',
    ).not.toBeNull();
    if (cycle !== null) {
      expect(
        cycle.length,
        `reported cycle path must contain at least 2 nodes, got [${cycle.join(', ')}]`,
      ).toBeGreaterThanOrEqual(2);
      expect(
        new Set(cycle).size,
        `reported cycle path [${cycle.join(', ')}] should repeat its closing node`,
      ).toBeLessThan(cycle.length);
    }

    const acyclicFixture = new Map<string, readonly string[]>([
      ['x', ['y']],
      ['y', ['z']],
      ['z', []],
    ]);
    expect(
      findCycle(acyclicFixture),
      'the same detector must NOT report a cycle for a synthetic graph that has none',
    ).toBeNull();
  });

  it('locally recomputed TOTAL cost matches ITEM_TOTAL_COST and itemTotalCost for every item', () => {
    for (const id of EXPECTED_ITEM_IDS) {
      const total = localTotalCost(id);
      expect(
        total,
        `${id}: locally recomputed total ${total} must equal ITEM_TOTAL_COST['${id}']=${ITEM_TOTAL_COST[id]}`,
      ).toBe(ITEM_TOTAL_COST[id]);
      expect(
        total,
        `${id}: locally recomputed total ${total} must equal itemTotalCost('${id}')=${itemTotalCost(id)}`,
      ).toBe(itemTotalCost(id));
    }
  });

  const EXPECTED_RECIPE_TOTALS: ReadonlyArray<readonly [ItemId, number]> = [
    ['fang', 700],
    ['stormbow', 800],
    ['aegisheart', 900],
    ['bulwarkplate', 1200],
    ['warhorn', 800],
    ['reaperedge', 2400],
    ['aegiscolossus', 3000],
    ['stormherald', 2600],
    ['wraithblade', 2600],
  ];

  it('pins the documented total-cost literals for all 9 recipe items (a silent re-price must fail this)', () => {
    for (const [id, expectedTotal] of EXPECTED_RECIPE_TOTALS) {
      expect(
        ITEM_TOTAL_COST[id],
        `${id}: ITEM_TOTAL_COST must be the documented ${expectedTotal}, got ${ITEM_TOTAL_COST[id]}`,
      ).toBe(expectedTotal);
    }
  });

  it('tier-3 items fuse exactly 2 tier-2 components; tier-2 items take only tier-1 components (component tier is always item tier - 1)', () => {
    for (const id of EXPECTED_ITEM_IDS) {
      const def = ITEMS[id];
      const tier = ITEM_TIER[id];
      if (tier === 1) {
        expect(def.recipe, `${id}: tier-1 (base) item must not have a recipe`).toBeUndefined();
        continue;
      }
      const recipe = def.recipe;
      expect(recipe, `${id}: tier-${tier} item must have a recipe`).toBeDefined();
      if (recipe === undefined) continue;
      if (tier === 3) {
        expect(
          recipe.components.length,
          `${id}: tier-3 ultimate must have exactly 2 components, found ${recipe.components.length}`,
        ).toBe(2);
      }
      for (const comp of recipe.components) {
        const compTier = ITEM_TIER[comp];
        expect(
          compTier,
          `${id} (tier ${tier}): component '${comp}' has tier ${compTier}, expected exactly tier ${tier - 1}`,
        ).toBe(tier - 1);
      }
    }
  });
});

// ============================================================================
// Slot economics — buying an ultimate must never make the inventory worse.
// A full 6-slot (INVENTORY_SLOTS) inventory is otherwise a dead end: if a
// tier-3 fusion did not free at least one slot, reaching the ultimate tier
// would require dropping an item with zero refund just to have room to buy.
// ============================================================================
describe('slot economics', () => {
  it('INVENTORY_SLOTS is 6 (frozen contract)', () => {
    expect(INVENTORY_SLOTS, `INVENTORY_SLOTS must be 6, got ${INVENTORY_SLOTS}`).toBe(6);
  });

  it('every tier-3 recipe consumes >= 2 slots worth of components and yields 1 item (slot-positive)', () => {
    const tier3 = EXPECTED_ITEM_IDS.filter((id) => ITEM_TIER[id] === 3);
    expect(tier3.length, 'expected at least one tier-3 item to check slot economics on').toBeGreaterThan(0);
    for (const id of tier3) {
      const recipe = ITEMS[id].recipe;
      expect(recipe, `${id}: tier-3 item must have a recipe to check slot economics`).toBeDefined();
      if (recipe === undefined) continue;
      const slotsConsumed = recipe.components.length;
      const slotsProduced = 1;
      expect(
        slotsConsumed,
        `${id}: recipe must consume >= 2 inventory slots' worth of components, consumed ${slotsConsumed}`,
      ).toBeGreaterThanOrEqual(2);
      expect(
        slotsConsumed - slotsProduced,
        `${id}: buying it must free >= 1 inventory slot (consumed ${slotsConsumed}, produced ${slotsProduced})`,
      ).toBeGreaterThanOrEqual(1);
    }
  });
});

// ============================================================================
// Sell economics — selling must always be a strict loss vs. TOTAL cost, so it
// is a corrective action (fixing a bad build, freeing a slot), never a
// profitable gold shuffle; and it must refund the whole fused investment, not
// just the last recipe step, or fusing an ultimate would be a gold trap.
// ============================================================================
describe('sell economics', () => {
  it('sellValue is a non-negative integer, equals floor(total * SELL_REFUND), and is strictly less than total, for every item', () => {
    for (const id of EXPECTED_ITEM_IDS) {
      const sell = sellValue(id);
      const total = itemTotalCost(id);
      expect(
        Number.isInteger(sell) && sell >= 0,
        `${id}: sellValue ${sell} must be a non-negative integer`,
      ).toBe(true);
      expect(
        sell,
        `${id}: sellValue ${sell} must equal floor(${total} * ${SELL_REFUND}) = ${Math.floor(total * SELL_REFUND)}`,
      ).toBe(Math.floor(total * SELL_REFUND));
      expect(
        sell,
        `${id}: sellValue ${sell} must be strictly less than total cost ${total} (selling must never be profitable)`,
      ).toBeLessThan(total);
    }
  });

  it('SELL_REFUND is strictly between 0 and 1, and equals 0.6', () => {
    expect(
      SELL_REFUND > 0 && SELL_REFUND < 1,
      `SELL_REFUND=${SELL_REFUND} must be strictly between 0 and 1`,
    ).toBe(true);
    expect(SELL_REFUND, `SELL_REFUND must be exactly 0.6, got ${SELL_REFUND}`).toBe(0.6);
  });

  const PINNED_SELL_VALUES: ReadonlyArray<readonly [ItemId, number]> = [
    ['wardstone', 90], // cheapest item — where flooring bites hardest
    ['reaperedge', 1440],
    ['aegiscolossus', 1800],
    ['stormherald', 1560],
    ['wraithblade', 1560],
  ];

  it('pins sellValue literals for the 4 ultimates and wardstone', () => {
    for (const [id, expected] of PINNED_SELL_VALUES) {
      expect(
        sellValue(id),
        `${id}: sellValue must be the documented ${expected}, got ${sellValue(id)}`,
      ).toBe(expected);
    }
  });

  it('selling a tier-3 ultimate refunds from its TOTAL cost, not just its recipe step', () => {
    const tier3: readonly ItemId[] = ['reaperedge', 'aegiscolossus', 'stormherald', 'wraithblade'];
    for (const id of tier3) {
      const recipe = ITEMS[id].recipe;
      expect(recipe, `${id}: tier-3 item must have a recipe`).toBeDefined();
      if (recipe === undefined) continue;
      const sell = sellValue(id);
      const recipeStepThreshold = recipe.cost * SELL_REFUND;
      expect(
        sell,
        `${id}: sellValue ${sell} must exceed 0.6 * recipe.cost (${recipeStepThreshold}) — ` +
          `proving the fused components' totals are included in the refund, not just the fusion step`,
      ).toBeGreaterThan(recipeStepThreshold);
    }
  });
});
