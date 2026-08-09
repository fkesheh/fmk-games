// ============================================================================
// ANCIENTS (rift) — ITEMS + SHOP. Pure data. Flat-stat items plus two actives
// and the ward consumable. Recipes: buying a recipe item COMBINES — it
// consumes every listed component from inventory plus `cost` gold (which
// equals the top-level `cost`); components must be base items — a component
// may not itself have a recipe (enforced in items.test.ts). Shop is reachable
// only inside your own fountain radius; gold is spent at buy time; there is
// no selling in v1.
// ============================================================================

export type ItemId =
  | 'bladestone'
  | 'warmail'
  | 'plategirdle'
  | 'swiftboots'
  | 'manacharm'
  | 'fang'
  | 'stormbow'
  | 'aegisheart'
  | 'bulwarkplate'
  | 'blinkstone'
  | 'warhorn'
  | 'wardstone';

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
   *  total investment = sum(component costs) + cost. Components are base
   *  items — a component may not itself have a recipe. */
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
};

export const ITEM_LIST: readonly ItemDef[] = Object.values(ITEMS);

export function isItemId(v: unknown): v is ItemId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ITEMS, v);
}
