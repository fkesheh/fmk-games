// ============================================================================
// ANCIENTS (rift) — PROTOCOL GATE.
//
// parseRiftC2S is the only door into the sim: every message kind must
// round-trip, and every malformed input must return null WITHOUT throwing.
// parseRiftSettings is the opposite: it THROWS Error(message) on bad input
// so the platform can convert it to {t:'error',code:'bad_settings'}.
//
// Frozen code under test (Layer-1, IMMUTABLE): protocol.ts, config.ts,
// hero.ts, item.ts.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  INVENTORY_SLOTS,
  MAP_COORD_MAX,
  MAX_TEAM_SIZE,
  MIN_TEAM_SIZE,
  parseRiftC2S,
  parseRiftSettings,
} from '@rift/shared';
import type { RiftC2S } from '@rift/shared';

const HERO_IDS = ['bullwark', 'longbow', 'reaver', 'hex', 'mender', 'shade'] as const;
const ITEM_IDS = [
  'bladestone',
  'warmail',
  'plategirdle',
  'swiftboots',
  'manacharm',
  'fang',
  'stormbow',
  'aegisheart',
  'blinkstone',
  'warhorn',
  'wardstone',
] as const;

describe('parseRiftC2S — valid messages round-trip', () => {
  it('rift_pick accepts every hero id', () => {
    for (const hero of HERO_IDS) {
      const msg = parseRiftC2S({ t: 'rift_pick', hero });
      expect(msg, `rift_pick ${hero} parsed to ${JSON.stringify(msg)}`).toEqual({
        t: 'rift_pick',
        hero,
      });
    }
  });

  it('rift_start round-trips', () => {
    expect(parseRiftC2S({ t: 'rift_start' })).toEqual({ t: 'rift_start' });
  });

  it('rift_order move/attackmove carry clamped-in-range coords', () => {
    for (const kind of ['move', 'attackmove'] as const) {
      const msg = parseRiftC2S({ t: 'rift_order', kind, x: 12.5, z: -40 });
      expect(msg, `rift_order ${kind} parsed to ${JSON.stringify(msg)}`).toEqual({
        t: 'rift_order',
        kind,
        x: 12.5,
        z: -40,
      });
    }
  });

  it('rift_order attack/stop round-trip', () => {
    expect(parseRiftC2S({ t: 'rift_order', kind: 'attack', target: 1042 })).toEqual({
      t: 'rift_order',
      kind: 'attack',
      target: 1042,
    });
    expect(parseRiftC2S({ t: 'rift_order', kind: 'stop' })).toEqual({
      t: 'rift_order',
      kind: 'stop',
    });
  });

  it('rift_cast round-trips with coords and/or target', () => {
    expect(parseRiftC2S({ t: 'rift_cast', slot: 0, x: 10, z: 20 })).toEqual({
      t: 'rift_cast',
      slot: 0,
      x: 10,
      z: 20,
    });
    expect(parseRiftC2S({ t: 'rift_cast', slot: 3, target: 1001 })).toEqual({
      t: 'rift_cast',
      slot: 3,
      target: 1001,
    });
    expect(parseRiftC2S({ t: 'rift_cast', slot: 1, x: -5, z: 5, target: 7 })).toEqual({
      t: 'rift_cast',
      slot: 1,
      x: -5,
      z: 5,
      target: 7,
    });
  });

  it('rift_item round-trips with and without a ground point', () => {
    expect(parseRiftC2S({ t: 'rift_item', slot: 0 })).toEqual({ t: 'rift_item', slot: 0 });
    expect(parseRiftC2S({ t: 'rift_item', slot: INVENTORY_SLOTS - 1, x: 3, z: 4 })).toEqual({
      t: 'rift_item',
      slot: INVENTORY_SLOTS - 1,
      x: 3,
      z: 4,
    });
  });

  it('rift_buy accepts every item id', () => {
    for (const item of ITEM_IDS) {
      const msg = parseRiftC2S({ t: 'rift_buy', item });
      expect(msg, `rift_buy ${item} parsed to ${JSON.stringify(msg)}`).toEqual({
        t: 'rift_buy',
        item,
      });
    }
  });

  it('rift_skill accepts slots 0..3', () => {
    for (let slot = 0; slot < 4; slot++) {
      expect(parseRiftC2S({ t: 'rift_skill', slot })).toEqual({ t: 'rift_skill', slot });
    }
  });
});

describe('parseRiftC2S — coordinate clamp boundary at MAP_COORD_MAX', () => {
  it(`|coord| == MAP_COORD_MAX (${MAP_COORD_MAX}) is accepted`, () => {
    expect(
      parseRiftC2S({ t: 'rift_order', kind: 'move', x: MAP_COORD_MAX, z: -MAP_COORD_MAX }),
    ).toEqual({ t: 'rift_order', kind: 'move', x: MAP_COORD_MAX, z: -MAP_COORD_MAX });
  });

  it('|coord| just past MAP_COORD_MAX returns null (clamped out, not clamped to)', () => {
    const past = MAP_COORD_MAX + 0.001;
    expect(
      parseRiftC2S({ t: 'rift_order', kind: 'move', x: past, z: 0 }),
      `x=${past} (>${MAP_COORD_MAX}) must be rejected, not silently clamped`,
    ).toBeNull();
    expect(parseRiftC2S({ t: 'rift_order', kind: 'move', x: 0, z: -past })).toBeNull();
    expect(parseRiftC2S({ t: 'rift_cast', slot: 0, x: past, z: 0 })).toEqual({
      // cast drops the invalid coord PAIR but keeps the cast — see shape test
      t: 'rift_cast',
      slot: 0,
    });
  });

  it('non-finite coords return null', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        parseRiftC2S({ t: 'rift_order', kind: 'attackmove', x: bad, z: 0 }),
        `x=${bad} must be rejected`,
      ).toBeNull();
    }
  });
});

describe('parseRiftC2S — malformed input returns null, never throws', () => {
  it('non-objects return null', () => {
    const garbage: readonly unknown[] = [null, undefined, 42, 'rift_start', true, []];
    for (const g of garbage) {
      expect(parseRiftC2S(g), `parseRiftC2S(${JSON.stringify(g)}) should be null`).toBeNull();
    }
  });

  it('unknown tags return null', () => {
    expect(parseRiftC2S({ t: 'rift_hack' })).toBeNull();
    expect(parseRiftC2S({ t: 42 })).toBeNull();
    expect(parseRiftC2S({})).toBeNull();
  });

  it('wrong-typed fields return null', () => {
    const cases: readonly unknown[] = [
      { t: 'rift_pick', hero: 'BULLWARK' }, // case-sensitive id
      { t: 'rift_pick', hero: 3 },
      { t: 'rift_order', kind: 'move', x: '10', z: 0 },
      { t: 'rift_order', kind: 'move', x: 10 }, // missing z
      { t: 'rift_order', kind: 'teleport' }, // unknown order kind
      { t: 'rift_order', kind: 'attack', target: '1001' },
      { t: 'rift_order', kind: 'attack', target: -1 },
      { t: 'rift_order', kind: 'attack', target: 1_000_000 }, // ent id ceiling
      { t: 'rift_order', kind: 'attack', target: 1000.5 }, // non-integer
      { t: 'rift_cast', slot: 4 }, // slots are 0..3
      { t: 'rift_cast', slot: -1 },
      { t: 'rift_cast', slot: 1.5 },
      { t: 'rift_cast', slot: 'q' },
      { t: 'rift_cast' }, // missing slot
      { t: 'rift_item', slot: INVENTORY_SLOTS }, // slots are 0..5
      { t: 'rift_item', slot: -1 },
      { t: 'rift_buy', item: 'boots' },
      { t: 'rift_buy', item: 'Blinkstone' }, // case-sensitive id
      { t: 'rift_skill', slot: 4 },
      { t: 'rift_skill', slot: 'r' },
    ];
    for (const c of cases) {
      expect(
        parseRiftC2S(c),
        `parseRiftC2S(${JSON.stringify(c)}) should be null, got ` +
          JSON.stringify(parseRiftC2S(c)),
      ).toBeNull();
    }
  });

  it('a spread of hostile input never throws', () => {
    const hostile: readonly unknown[] = [
      { t: 'rift_order', kind: 'move', x: { deep: true }, z: [1] },
      { t: 'rift_cast', slot: {}, x: 'a', z: null, target: [] },
      { t: 'rift_buy', item: { toString: 'warhorn' } },
      { t: 'rift_pick', hero: undefined },
    ];
    for (const h of hostile) {
      expect(() => parseRiftC2S(h)).not.toThrow();
    }
  });
});

describe('parseRiftC2S — exactOptionalPropertyTypes-safe output shape', () => {
  it('rift_cast without coords/target has the keys ABSENT, not undefined', () => {
    const msg = parseRiftC2S({ t: 'rift_cast', slot: 2 });
    if (msg === null || msg.t !== 'rift_cast') {
      throw new Error(`expected rift_cast, got ${JSON.stringify(msg)}`);
    }
    expect(
      Object.hasOwn(msg, 'x'),
      `rift_cast output must not carry an own 'x' key when no coords were sent ` +
        `(exactOptionalPropertyTypes: absent !== undefined) — got ${JSON.stringify(msg)}`,
    ).toBe(false);
    expect(Object.hasOwn(msg, 'z')).toBe(false);
    expect(Object.hasOwn(msg, 'target')).toBe(false);
  });

  it('rift_cast drops an invalid coord PAIR as a pair (x valid, z invalid -> neither)', () => {
    const msg = parseRiftC2S({ t: 'rift_cast', slot: 0, x: 10, z: 'bogus' });
    if (msg === null || msg.t !== 'rift_cast') {
      throw new Error(`expected rift_cast, got ${JSON.stringify(msg)}`);
    }
    expect(
      Object.hasOwn(msg, 'x') || Object.hasOwn(msg, 'z'),
      `half-valid coord pairs must be dropped wholesale — got ${JSON.stringify(msg)}`,
    ).toBe(false);
  });

  it('rift_cast keeps a valid target even when coords are absent', () => {
    const msg = parseRiftC2S({ t: 'rift_cast', slot: 1, target: 1005 });
    if (msg === null || msg.t !== 'rift_cast') {
      throw new Error(`expected rift_cast, got ${JSON.stringify(msg)}`);
    }
    expect(msg.target).toBe(1005);
    expect(Object.hasOwn(msg, 'x')).toBe(false);
  });

  it('rift_item without a ground point has the keys ABSENT, not undefined', () => {
    const msg = parseRiftC2S({ t: 'rift_item', slot: 3 });
    if (msg === null || msg.t !== 'rift_item') {
      throw new Error(`expected rift_item, got ${JSON.stringify(msg)}`);
    }
    expect(
      Object.hasOwn(msg, 'x'),
      `rift_item output must not carry an own 'x' key when no point was sent — ` +
        `got ${JSON.stringify(msg)}`,
    ).toBe(false);
    expect(Object.hasOwn(msg, 'z')).toBe(false);
  });

  it('rift_item drops a half-valid ground point as a pair', () => {
    const msg = parseRiftC2S({ t: 'rift_item', slot: 0, x: 'nope', z: 5 });
    if (msg === null || msg.t !== 'rift_item') {
      throw new Error(`expected rift_item, got ${JSON.stringify(msg)}`);
    }
    expect(Object.hasOwn(msg, 'x') || Object.hasOwn(msg, 'z')).toBe(false);
  });

  it('rift_order attack carries the parsed integer target, not the raw value', () => {
    const msg: RiftC2S | null = parseRiftC2S({ t: 'rift_order', kind: 'attack', target: 42 });
    expect(msg).toEqual({ t: 'rift_order', kind: 'attack', target: 42 });
  });
});

describe('parseRiftSettings', () => {
  it('undefined/null yields the defaults (empty settings object)', () => {
    expect(parseRiftSettings(undefined)).toEqual({});
    expect(parseRiftSettings(null)).toEqual({});
  });

  it('teamSize 0 (auto) is accepted and stored as absent', () => {
    const s = parseRiftSettings({ teamSize: 0 });
    expect(s).toEqual({});
    expect(
      Object.hasOwn(s, 'teamSize'),
      `teamSize 0 means auto and must be stored as ABSENT — got ${JSON.stringify(s)}`,
    ).toBe(false);
  });

  it(`teamSize ${MIN_TEAM_SIZE}..${MAX_TEAM_SIZE} accepted, boundaries included`, () => {
    for (let size = MIN_TEAM_SIZE; size <= MAX_TEAM_SIZE; size++) {
      expect(parseRiftSettings({ teamSize: size })).toEqual({ teamSize: size });
    }
  });

  it('speed 1..20 accepted, boundaries included', () => {
    expect(parseRiftSettings({ speed: 1 })).toEqual({ speed: 1 });
    expect(parseRiftSettings({ speed: 20 })).toEqual({ speed: 20 });
    expect(parseRiftSettings({ speed: 7.5 })).toEqual({ speed: 7.5 });
  });

  it('both fields together round-trip', () => {
    expect(parseRiftSettings({ teamSize: 4, speed: 3 })).toEqual({ teamSize: 4, speed: 3 });
  });

  it('bad values throw Error with a message', () => {
    const bad: readonly unknown[] = [
      42,
      'settings',
      [],
      { teamSize: 1 }, // below MIN_TEAM_SIZE (and not 0/auto)
      { teamSize: MAX_TEAM_SIZE + 1 },
      { teamSize: 2.5 }, // non-integer
      { teamSize: '4' },
      { teamSize: Number.NaN },
      { speed: 0 },
      { speed: 21 },
      { speed: '2' },
      { speed: Number.NaN },
      { speed: Number.POSITIVE_INFINITY },
    ];
    for (const b of bad) {
      let thrown: unknown = null;
      try {
        parseRiftSettings(b);
      } catch (e) {
        thrown = e;
      }
      expect(
        thrown instanceof Error,
        `parseRiftSettings(${JSON.stringify(b)}) must throw an Error, got ${String(thrown)}`,
      ).toBe(true);
      if (thrown instanceof Error) {
        expect(
          thrown.message.length,
          `parseRiftSettings(${JSON.stringify(b)}) threw with an EMPTY message — ` +
            `the platform surfaces this text as bad_settings`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
