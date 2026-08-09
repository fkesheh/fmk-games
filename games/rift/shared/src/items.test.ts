// ============================================================================
// ANCIENTS (rift) — ITEM/SHOP DATA GATE.
//
// Mechanical validation of the frozen ITEMS record (CONTRACT §12 T2): every
// item costs gold, carries display strings, and any active matches the frozen
// ItemActive union shape. ITEM_LIST must be exactly Object.values(ITEMS), and
// isItemId accepts exactly the 12 ids. Recipe items (item.ts header) get
// their own gate: non-empty base-item components, no self-reference, and
// recipe.cost === cost.
//
// Frozen data under test (Layer-1, IMMUTABLE): item.ts.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { ITEMS, ITEM_LIST, isItemId } from '@rift/shared';
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
];

describe('ITEMS record', () => {
  it('holds exactly the 12 frozen item ids, keyed by their own id', () => {
    const keys = Object.keys(ITEMS).sort();
    expect(
      keys,
      `ITEMS keys [${keys.join(', ')}] diverge from the frozen 12 [${[...EXPECTED_ITEM_IDS]
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
      `expected exactly 3 active items (blinkstone/warhorn/wardstone), found ` +
        `${withActive.length}: [${withActive.map((d) => d.id).join(', ')}]`,
    ).toBe(3);

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

  it('recipes are valid: base-item components, no self-reference, cost consistent', () => {
    const withRecipe = Object.values(ITEMS).filter((d) => d.recipe !== undefined);
    expect(
      withRecipe.length,
      `expected exactly 5 recipe items (fang/stormbow/aegisheart/bulwarkplate/warhorn), found ` +
        `${withRecipe.length}: [${withRecipe.map((d) => d.id).join(', ')}]`,
    ).toBe(5);

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
        const compDef = ITEMS[comp]; // ItemId-typed: a bad id is a compile error, not a runtime one
        expect(
          compDef.recipe,
          `${def.id}: component '${comp}' has its own recipe — components must be base items (one level only)`,
        ).toBeUndefined();
      }
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

  it('isItemId accepts exactly the 12 frozen ids', () => {
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
