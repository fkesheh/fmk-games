// ============================================================================
// ANCIENTS (rift) — ITEMS + SHOP. Pure data. Flat-stat items plus actives and
// the ward consumable. Recipes: buying a recipe item COMBINES — it consumes
// every listed component from inventory plus `cost` gold (which equals the
// top-level `cost`).
//
// THREE TIERS (amended; the old rule was "components must be base items"):
//   tier 1  base            bought outright
//   tier 2  fused           base + base + gold
//   tier 3  ULTIMATE        fused + fused + gold
// A component MAY now itself have a recipe. That relaxation is only safe
// because it is replaced by a strictly stronger guard in items.test.ts:
//   (a) recipe DEPTH is at most MAX_RECIPE_DEPTH (3) — nothing deeper;
//   (b) the recipe graph is ACYCLIC, asserted by walking it. A cycle would
//       make the total-cost walk below (and any future recursive resolver)
//       non-terminating, so this is the invariant the old base-only rule was
//       really buying;
//   (c) every `cost` still equals the stated arithmetic at EVERY tier:
//       total = sum(component totals) + recipe.cost, and recipe.cost === cost.
// Fusing two tier-2s into one tier-3 FREES an inventory slot (INVENTORY_SLOTS
// is 6) — that is a large part of why ultimates exist.
//
// Shop is reachable only inside your own fountain radius; gold is spent at buy
// time. SELLING (also fountain-only) refunds SELL_REFUND of an item's TOTAL
// cost; DROPPING works anywhere and refunds nothing.
// ============================================================================

export type ItemId =
  // --- tier 1: base ---------------------------------------------------------
  | 'bladestone'
  | 'warmail'
  | 'plategirdle'
  | 'swiftboots'
  | 'manacharm'
  | 'blinkstone'
  | 'wardstone'
  // --- tier 2: fused (base + gold) ------------------------------------------
  | 'fang'
  | 'stormbow'
  | 'aegisheart'
  | 'bulwarkplate'
  | 'warhorn'
  // --- tier 3: ultimate (fused + fused + gold) ------------------------------
  | 'reaperedge'
  | 'aegiscolossus'
  | 'stormherald'
  | 'wraithblade';

/** Flat stats an item grants while held. attackSpeed / lifesteal / moveSpeed
 *  are fractions except moveSpeed, which is flat metres/second. */
export interface ItemStats {
  readonly damage?: number;
  readonly maxHp?: number;
  readonly armor?: number;
  readonly moveSpeed?: number; // flat m/s
  readonly attackSpeed?: number; // fraction, 0.3 = +30%
  readonly mana?: number;
  readonly manaRegen?: number; // per second
  readonly hpRegen?: number; // per second
  readonly lifesteal?: number; // fraction of physical attack damage returned
}

export type ItemActive =
  | { readonly kind: 'dash'; readonly distance: number; readonly cooldown: number }
  | {
      readonly kind: 'aura';
      readonly stat: 'damage';
      readonly pct: true;
      readonly amount: number;
      readonly radius: number;
      readonly duration: number;
      readonly cooldown: number;
    }
  | { readonly kind: 'ward'; readonly charges: number };

export interface ItemDef {
  readonly id: ItemId;
  readonly name: string;
  readonly icon: string; // single unicode glyph, no assets
  readonly cost: number;
  readonly stats?: ItemStats;
  /** Present = the item is usable via rift_item. 'ward' items are consumed
   *  per charge; the slot clears when charges reach 0. Other actives have a
   *  cooldown and are never consumed. */
  readonly active?: ItemActive;
  /** Present = buying COMBINES: every listed component is consumed from
   *  inventory plus `cost` gold, and the result takes the lowest freed slot.
   *  `cost` must equal the top-level `cost` (the gold charged at buy time);
   *  total investment = sum(component TOTAL costs) + cost — see
   *  `itemTotalCost`. A component MAY itself have a recipe (tier-3 ultimates
   *  fuse two tier-2s), bounded by MAX_RECIPE_DEPTH and by acyclicity; see the
   *  file header. */
  readonly recipe?: { readonly components: readonly ItemId[]; readonly cost: number };
  readonly blurb: string;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  bladestone: {
    id: 'bladestone', name: 'Bladestone', icon: '🗡', cost: 400,
    stats: { damage: 12 },
    blurb: '+12 damage.',
  },
  warmail: {
    id: 'warmail', name: 'Warmail', icon: '🛡', cost: 450,
    stats: { maxHp: 250 },
    blurb: '+250 health.',
  },
  plategirdle: {
    id: 'plategirdle', name: 'Plategirdle', icon: '⛓', cost: 400,
    stats: { armor: 6 },
    blurb: '+6 armour.',
  },
  swiftboots: {
    id: 'swiftboots', name: 'Swiftboots', icon: '👢', cost: 400,
    stats: { moveSpeed: 0.55 },
    blurb: '+0.55 move speed.',
  },
  manacharm: {
    id: 'manacharm', name: 'Manacharm', icon: '🔷', cost: 400,
    stats: { mana: 150, manaRegen: 0.8 },
    blurb: '+150 mana, +0.8 mana regen.',
  },
  fang: {
    id: 'fang', name: 'Lifedrinker Fang', icon: '🩸', cost: 300,
    stats: { damage: 8, lifesteal: 0.12 },
    recipe: { components: ['bladestone'], cost: 300 }, // 400 + 300 = 700
    blurb: '+8 damage, 12% lifesteal.',
  },
  stormbow: {
    id: 'stormbow', name: 'Stormbow', icon: '🏹', cost: 400,
    stats: { damage: 10, attackSpeed: 0.3 },
    recipe: { components: ['bladestone'], cost: 400 }, // 400 + 400 = 800
    blurb: '+10 damage, +30% attack speed.',
  },
  aegisheart: {
    id: 'aegisheart', name: 'Aegis Heart', icon: '💚', cost: 450,
    stats: { maxHp: 400, hpRegen: 4 },
    recipe: { components: ['warmail'], cost: 450 }, // 450 + 450 = 900
    blurb: '+400 health, +4 health regen.',
  },
  bulwarkplate: {
    id: 'bulwarkplate', name: 'Bulwark Plate', icon: '🏰', cost: 350,
    stats: { maxHp: 300, armor: 8, hpRegen: 2 },
    recipe: { components: ['warmail', 'plategirdle'], cost: 350 }, // 450 + 400 + 350 = 1200
    blurb: '+300 health, +8 armour, +2 health regen.',
  },
  blinkstone: {
    id: 'blinkstone', name: 'Blinkstone', icon: '✨', cost: 650,
    active: { kind: 'dash', distance: 8, cooldown: 14 },
    blurb: 'Active: blink 8m. 14s cooldown.',
  },
  warhorn: {
    id: 'warhorn', name: 'Warhorn', icon: '📯', cost: 400,
    active: { kind: 'aura', stat: 'damage', pct: true, amount: 0.2, radius: 10, duration: 6, cooldown: 45 },
    recipe: { components: ['manacharm'], cost: 400 }, // 400 + 400 = 800
    blurb: 'Active: nearby allies deal +20% damage for 6s. 45s cooldown.',
  },
  wardstone: {
    id: 'wardstone', name: 'Wardstone', icon: '👁', cost: 150,
    active: { kind: 'ward', charges: 2 },
    blurb: 'Consumable, 2 charges: place an observer ward.',
    // WARD RULE (frozen): buying needs no stock; PLACING consumes 1 item
    // charge AND 1 team stock (WARD_TEAM_STOCK / WARD_RESTOCK_S in config).
    // A place attempt with 0 team stock silently no-ops.
  },

  // --- tier 3: ULTIMATES ----------------------------------------------------
  // Each fuses exactly TWO tier-2 items plus gold, so it turns two occupied
  // slots into one. Totals land at 2400-3000: heroes reach ~2200-5500 gold by
  // ten minutes and matches run 12-25, so an ultimate is one genuine late-game
  // commitment per hero, not a routine purchase. The recipe STEP is 900-1000,
  // which is what you actually save up for once both halves are already held.
  reaperedge: {
    id: 'reaperedge', name: "Reaper's Edge", icon: '⚔', cost: 900,
    stats: { damage: 40, attackSpeed: 0.5, lifesteal: 0.22 },
    recipe: { components: ['fang', 'stormbow'], cost: 900 }, // 700 + 800 + 900 = 2400
    blurb: '+40 damage, +50% attack speed, 22% lifesteal.',
  },
  aegiscolossus: {
    id: 'aegiscolossus', name: 'Aegis Colossus', icon: '🗿', cost: 900,
    stats: { maxHp: 900, armor: 16, hpRegen: 9 },
    recipe: { components: ['aegisheart', 'bulwarkplate'], cost: 900 }, // 900 + 1200 + 900 = 3000
    blurb: '+900 health, +16 armour, +9 health regen.',
  },
  stormherald: {
    id: 'stormherald', name: 'Storm Herald', icon: '🌩', cost: 1000,
    stats: { damage: 18, attackSpeed: 0.35, mana: 150, manaRegen: 0.8 },
    // Inherits Warhorn's aura and widens it: the team-fight ultimate.
    active: { kind: 'aura', stat: 'damage', pct: true, amount: 0.35, radius: 14, duration: 8, cooldown: 35 },
    recipe: { components: ['stormbow', 'warhorn'], cost: 1000 }, // 800 + 800 + 1000 = 2600
    blurb: 'Active: nearby allies deal +35% damage for 8s. 35s cooldown. +18 damage, +35% attack speed.',
  },
  wraithblade: {
    id: 'wraithblade', name: 'Wraithblade', icon: '🌑', cost: 1000,
    stats: { damage: 22, maxHp: 400, moveSpeed: 0.5, lifesteal: 0.15 },
    // A shorter-cooldown, longer blink than Blinkstone — the bruiser's
    // in-and-out ultimate, paid for with a 2600g total instead of 650g.
    active: { kind: 'dash', distance: 11, cooldown: 9 },
    recipe: { components: ['fang', 'aegisheart'], cost: 1000 }, // 700 + 900 + 1000 = 2600
    blurb: 'Active: blink 11m. 9s cooldown. +22 damage, +400 health, 15% lifesteal.',
  },
};

export const ITEM_LIST: readonly ItemDef[] = Object.values(ITEMS);

export function isItemId(v: unknown): v is ItemId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ITEMS, v);
}

// --- tiers, totals, and the sell refund --------------------------------------

/** The deepest recipe chain the data is allowed to express: base -> fused ->
 *  ultimate. A base item has depth 1. Enforced in items.test.ts, which also
 *  proves the graph is acyclic — together they are the replacement for the old
 *  "components must be base items" rule. */
export const MAX_RECIPE_DEPTH = 3;

const ITEM_IDS = Object.keys(ITEMS) as readonly ItemId[];

/** Walks components, carrying the current path so a MALFORMED (cyclic) graph
 *  terminates instead of hanging. The path check can never fire on the shipped
 *  data — items.test.ts asserts acyclicity independently — it exists so that a
 *  bad edit fails as a red test rather than as a locked-up server. */
function walkTotal(id: ItemId, path: readonly ItemId[]): number {
  const def = ITEMS[id];
  const recipe = def.recipe;
  if (recipe === undefined || path.includes(id)) return def.cost;
  const next = [...path, id];
  let sum = recipe.cost;
  for (const comp of recipe.components) sum += walkTotal(comp, next);
  return sum;
}

function walkDepth(id: ItemId, path: readonly ItemId[]): number {
  const recipe = ITEMS[id].recipe;
  if (recipe === undefined || path.includes(id)) return 1;
  const next = [...path, id];
  let deepest = 0;
  for (const comp of recipe.components) {
    const d = walkDepth(comp, next);
    if (d > deepest) deepest = d;
  }
  return deepest + 1;
}

function tabulate(f: (id: ItemId) => number): Record<ItemId, number> {
  const out = {} as Record<ItemId, number>;
  for (const id of ITEM_IDS) out[id] = f(id);
  return out;
}

/** TOTAL gold sunk into an item: its own cost for a base item, otherwise
 *  recipe.cost plus the total of every component, recursively. This is the
 *  number sell refunds from — never the recipe step alone. */
export const ITEM_TOTAL_COST: Readonly<Record<ItemId, number>> = tabulate((id) => walkTotal(id, []));

/** 1 = base, 2 = fused, 3 = ultimate. */
export const ITEM_TIER: Readonly<Record<ItemId, number>> = tabulate((id) => walkDepth(id, []));

export function itemTotalCost(id: ItemId): number {
  return ITEM_TOTAL_COST[id];
}

export function itemTier(id: ItemId): number {
  return ITEM_TIER[id];
}

/** Fraction of an item's TOTAL cost returned when it is sold at your fountain.
 *  0.6 — a 40% haircut. Low enough that selling is a corrective action (fixing
 *  a bad build, freeing a slot) and never a profitable gold shuffle, high
 *  enough that a mis-buy is not a dead item you are stuck carrying for the rest
 *  of the match. Dropping (anywhere, no fountain needed) refunds nothing at
 *  all, which is what pays for its lack of a location gate. */
export const SELL_REFUND = 0.6;

/** Gold returned for selling `id`. Floored, so it is an integer and identical
 *  on every machine — rift is deterministic and its balance harness replays
 *  seeds. Charges are deliberately NOT prorated: a part-used Wardstone refunds
 *  the same 90 as a fresh one, which is worth less than the fountain trip. */
export function sellValue(id: ItemId): number {
  return Math.floor(ITEM_TOTAL_COST[id] * SELL_REFUND);
}
