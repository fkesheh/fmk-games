// ============================================================================
// ANCIENTS (rift) — PROTOCOL GATE.
//
// parseRiftC2S is the only door into the sim: every message kind must
// round-trip, and every malformed input must return null WITHOUT throwing.
// parseRiftSettings is the opposite: it THROWS Error(message) on bad input
// so the platform can convert it to {t:'error',code:'bad_settings'}.
//
// The S2C direction has no parser by design — the server authors it. Two
// consequences this file states out loud rather than papering over:
//
//  1. NOTHING IN shared/ CAN ENFORCE THE [0,1] RANGE OF `rift_snap.dayPhase`.
//     Nothing here ever reads an inbound snapshot, so there is no door at which
//     to reject one. AMENDMENT_1 §B.1 makes the range the PRODUCER's
//     obligation: `server/src/room.ts` fills the field from the frozen
//     `dayPhase(matchTick)` in config.ts and from nowhere else. That gap is
//     deliberate and it lives in room.ts, not here. What this file can gate,
//     and does, is the frozen producer itself — it never leaves [0,1], never
//     steps discontinuously, and never emits a value JSON cannot carry.
//  2. A JSON round-trip of an object literal written two lines above it is not
//     a test: no production code is on that path, so it cannot fail for any
//     implementation of this game. Every S2C case below therefore either
//     drives frozen code (`dayPhase`, `nightVisionScale`, `isCampKind`,
//     `isPlayerTeam`, `parseRiftC2S`) or is an explicit COMPILE-TIME pin whose
//     failure mode is a red `tsc` — and says which of the two it is.
//
// That covers `rift_snap.dayPhase` (TERRAIN_CONTRACT §6, AMENDMENT_1 §B.1/§C),
// the neutral camp EntKinds and `EntSnap.team === NEUTRAL_TEAM` (§5), and
// `rift_miss` (§4).
//
// Frozen code under test (Layer-1, IMMUTABLE): protocol.ts, config.ts,
// hero.ts, item.ts, types.ts, terrain.ts.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  DAY_PERIOD_S,
  INVENTORY_SLOTS,
  MAP_COORD_MAX,
  MAX_TEAM_SIZE,
  MIN_TEAM_SIZE,
  NEUTRAL_TEAM,
  NIGHT_VISION_MULT,
  TICK_RATE,
  dayPhase,
  isCampKind,
  isPlayerTeam,
  nightVisionScale,
  parseRiftC2S,
  parseRiftSettings,
} from '@rift/shared';
import type { EntKind, EntSnap, EntTeam, RiftC2S, RiftEvent, RiftS2C } from '@rift/shared';

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
  'bulwarkplate',
  'blinkstone',
  'warhorn',
  'wardstone',
  'reaperedge',
  'aegiscolossus',
  'stormherald',
  'wraithblade',
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

describe('parseRiftC2S — rift_sell / rift_drop (inventory exit doors)', () => {
  // rift_sell refunds 60% of the item's TOTAL gold cost and is gated to your
  // own fountain radius + alive; rift_drop destroys the item from anywhere
  // while alive, no refund. Both gates live in room.ts on the SERVER — the
  // parser only sanitises the slot, exactly like rift_item's slot handling.
  // Every case below drives parseRiftC2S; none of it round-trips a bare
  // literal the way the file's header disdains.

  it('rift_sell accepts every legal slot 0..INVENTORY_SLOTS-1 with no extra keys on the result', () => {
    for (let slotIdx = 0; slotIdx < INVENTORY_SLOTS; slotIdx++) {
      const msg = parseRiftC2S({ t: 'rift_sell', slot: slotIdx });
      expect(msg, `rift_sell slot ${slotIdx} parsed to ${JSON.stringify(msg)}`).toEqual({
        t: 'rift_sell',
        slot: slotIdx,
      });
      if (msg === null) throw new Error(`expected rift_sell, got null for slot ${slotIdx}`);
      expect(
        Object.keys(msg).sort(),
        `rift_sell output must carry exactly t and slot — got ${JSON.stringify(msg)}`,
      ).toEqual(['slot', 't']);
    }
  });

  it('rift_drop accepts every legal slot 0..INVENTORY_SLOTS-1 with no extra keys on the result', () => {
    for (let slotIdx = 0; slotIdx < INVENTORY_SLOTS; slotIdx++) {
      const msg = parseRiftC2S({ t: 'rift_drop', slot: slotIdx });
      expect(msg, `rift_drop slot ${slotIdx} parsed to ${JSON.stringify(msg)}`).toEqual({
        t: 'rift_drop',
        slot: slotIdx,
      });
      if (msg === null) throw new Error(`expected rift_drop, got null for slot ${slotIdx}`);
      expect(
        Object.keys(msg).sort(),
        `rift_drop output must carry exactly t and slot — got ${JSON.stringify(msg)}`,
      ).toEqual(['slot', 't']);
    }
  });

  it('rift_sell and rift_drop are never confused with each other', () => {
    const sold = parseRiftC2S({ t: 'rift_sell', slot: 2 });
    const dropped = parseRiftC2S({ t: 'rift_drop', slot: 2 });
    expect(sold?.t, `rift_sell must parse with t:'rift_sell' — got ${JSON.stringify(sold)}`).toBe(
      'rift_sell',
    );
    expect(
      dropped?.t,
      `rift_drop must parse with t:'rift_drop' — got ${JSON.stringify(dropped)}`,
    ).toBe('rift_drop');
    expect(sold, 'a sell and a drop of the same slot must not be equal payloads').not.toEqual(
      dropped,
    );
  });

  it('rift_sell and rift_drop reject out-of-range or wrong-typed slots, never throwing', () => {
    // The bound comes from INVENTORY_SLOTS (imported), not a hard-coded 6, so
    // this loop tracks config.ts if the inventory size ever changes.
    const badSlotValues: readonly unknown[] = [
      INVENTORY_SLOTS, // one past the top — the boundary itself is excluded
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0.0001,
      '0', // string, not number
      true,
      null,
      {}, // object
      [], // array
    ];
    for (const t of ['rift_sell', 'rift_drop'] as const) {
      for (const bad of badSlotValues) {
        const payload = { t, slot: bad };
        expect(
          () => parseRiftC2S(payload),
          `parseRiftC2S(${JSON.stringify(payload)}) must not throw`,
        ).not.toThrow();
        expect(
          parseRiftC2S(payload),
          `${t} with slot ${JSON.stringify(bad)} should be null, got ` +
            JSON.stringify(parseRiftC2S(payload)),
        ).toBeNull();
      }
      // slot present but explicitly undefined — distinct from the key being absent
      const explicitUndefined = { t, slot: undefined };
      expect(() => parseRiftC2S(explicitUndefined)).not.toThrow();
      expect(
        parseRiftC2S(explicitUndefined),
        `${t} with slot: undefined should be null, got ` +
          JSON.stringify(parseRiftC2S(explicitUndefined)),
      ).toBeNull();
      // slot key missing entirely
      const missing = { t };
      expect(() => parseRiftC2S(missing)).not.toThrow();
      expect(
        parseRiftC2S(missing),
        `${t} with no slot key at all should be null, got ${JSON.stringify(parseRiftC2S(missing))}`,
      ).toBeNull();
    }
  });

  it('rift_sell and rift_drop with extra junk keys still parse, and the junk is not copied through', () => {
    for (const t of ['rift_sell', 'rift_drop'] as const) {
      const msg = parseRiftC2S({ t, slot: 1, junk: 'nope', extra: 42, x: 5 });
      expect(msg, `${t} with junk keys parsed to ${JSON.stringify(msg)}`).toEqual({ t, slot: 1 });
      if (msg === null) throw new Error(`expected ${t}, got null`);
      expect(
        Object.hasOwn(msg, 'junk') || Object.hasOwn(msg, 'extra') || Object.hasOwn(msg, 'x'),
        `${t} output must not carry through junk keys — got ${JSON.stringify(msg)}`,
      ).toBe(false);
    }
  });

  it('a fuzz spread of malformed rift_sell/rift_drop payloads never throws and always yields null', () => {
    const hostile: readonly unknown[] = [
      { t: 'rift_sell', slot: { deep: true } },
      { t: 'rift_sell', slot: [1] },
      { t: 'rift_sell', slot: () => 1 },
      { t: 'rift_sell', slot: Symbol('x') },
      { t: 'rift_sell' },
      { t: 'rift_drop', slot: { deep: true } },
      { t: 'rift_drop', slot: [1] },
      { t: 'rift_drop', slot: () => 1 },
      { t: 'rift_drop', slot: Symbol('x') },
      { t: 'rift_drop' },
    ];
    for (const h of hostile) {
      expect(() => parseRiftC2S(h), `parseRiftC2S(${String(h)}) must not throw`).not.toThrow();
      expect(
        parseRiftC2S(h),
        `parseRiftC2S(${String(h)}) should be null, got ${JSON.stringify(parseRiftC2S(h))}`,
      ).toBeNull();
    }
  });

  it('RiftC2S includes both rift_sell and rift_drop with slot:number — a COMPILE-TIME pin', () => {
    // Typed literals assigned to RiftC2S: if either variant is ever dropped
    // from the union, or its `slot` field's type changes, this fails to
    // compile — the failure mode is a red `tsc`, not a red vitest.
    const sell: RiftC2S = { t: 'rift_sell', slot: 0 };
    const drop: RiftC2S = { t: 'rift_drop', slot: 0 };
    // @ts-expect-error — rift_sell carries no refund field; the server computes it
    const sellWithGold: RiftC2S = { t: 'rift_sell', slot: 0, gold: 100 };

    // A narrowing switch over RiftC2S['t'] that must handle every variant,
    // rift_sell/rift_drop included — the `never` in the default branch is
    // the exhaustiveness pin: add a tenth C2S variant and forget a case here
    // and `msg` in `default` stops being `never`, which fails to compile.
    function narrow(msg: RiftC2S): string {
      switch (msg.t) {
        case 'rift_pick':
        case 'rift_start':
        case 'rift_order':
        case 'rift_cast':
        case 'rift_item':
        case 'rift_buy':
        case 'rift_skill':
          return 'other';
        case 'rift_sell':
          return `sell:${msg.slot}`;
        case 'rift_drop':
          return `drop:${msg.slot}`;
        default: {
          const exhaustive: never = msg;
          throw new Error(`unhandled RiftC2S variant: ${JSON.stringify(exhaustive)}`);
        }
      }
    }

    expect(narrow(sell), 'the switch must route rift_sell to its own case').toBe('sell:0');
    expect(narrow(drop), 'the switch must route rift_drop to its own case').toBe('drop:0');
    expect(sellWithGold.t, 'the @ts-expect-error literal above is still a valid rift_sell').toBe(
      'rift_sell',
    );
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

// ============================================================================
// S2C — the server-authored direction (TERRAIN_CONTRACT §4, §5, §6).
// ============================================================================

/** One trip through the wire: exactly what a WebSocket does to a message.
 *  Used ONLY on a value a frozen producer computed — a round-trip of a literal
 *  written two lines above it asserts something about JSON, not about rift. */
function overWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Every EntKind, as a Record so the compiler rejects this list the moment a
 *  kind is added to or removed from the union — a new kind that nobody
 *  classifies is a kind the client silently fails to draw. This one is a
 *  COMPILE-TIME pin: its failure mode is a red `tsc`, not a red vitest. */
const ALL_ENT_KINDS: Readonly<Record<EntKind, true>> = {
  hero: true,
  melee: true,
  ranged: true,
  siege: true,
  shade: true,
  tower: true,
  guard: true,
  ancient: true,
  ward: true,
  proj: true,
  campPack: true,
  campBrute: true,
  campHive: true,
};
const ENT_KINDS = Object.keys(ALL_ENT_KINDS) as readonly EntKind[];

/** The three neutral jungle tiers (TERRAIN_CONTRACT §5), spelled out here so
 *  the expectation is independent of the `isCampKind` it is used to check. */
const CAMP_KINDS: readonly EntKind[] = ['campPack', 'campBrute', 'campHive'];

function entSnap(over: Partial<EntSnap> & Pick<EntSnap, 'k' | 'team'>): EntSnap {
  return { id: 1, x: 10, z: 20, hp: 400, maxHp: 400, ...over };
}

/** A snapshot built the way room.ts must build one: `dayPhase` is not a free
 *  parameter, it is `dayPhase(matchTick)` and nothing else (AMENDMENT_1 §B.1). */
function snapAtTick(matchTick: number, ents: readonly EntSnap[] = []): RiftS2C {
  return {
    t: 'rift_snap',
    tick: matchTick + TICK_RATE,
    serverTime: 1_700_000_000_000,
    phase: 'live',
    matchTick,
    overtime: false,
    dayPhase: dayPhase(matchTick),
    wardStock: 2,
    kills: [3, 5],
    board: [],
    you: null,
    ents,
  };
}

/** One full day -> night -> day cycle, in ticks, and its midpoint (full night). */
const CYCLE_TICKS = DAY_PERIOD_S * TICK_RATE;
const HALF_CYCLE = CYCLE_TICKS / 2;

describe('dayPhase — the frozen day/night cycle (config.ts, AMENDMENT_1 §B.1)', () => {
  it('never leaves [0,1], and sweeps all of it, over two cycles and before tick 0', () => {
    // This producer IS the [0,1] enforcement: there is no S2C parser to reject
    // an out-of-range phase (see the file header), so the invariant is checked
    // here over the whole domain room.ts can hand it — negative matchTicks
    // included, because the cycle runs during the pre-match phase too.
    let offender = '';
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let t = -CYCLE_TICKS; t < 2 * CYCLE_TICKS && offender === ''; t++) {
      const p = dayPhase(t);
      if (p < lo) lo = p;
      if (p > hi) hi = p;
      if (!Number.isFinite(p) || p < 0 || p > 1) offender = `dayPhase(${t}) = ${String(p)}`;
    }
    expect(offender, `outside [0,1]: ${offender}`).toBe('');
    // ...and it is not a constant: a stuck 0.5 would satisfy the bound above
    // while leaving the map in permanent dusk.
    expect(lo, 'the cycle never reaches full day').toBe(0);
    expect(hi, 'the cycle never reaches full night').toBe(1);
  });

  it('is a wrapping triangle: 0 at the start, 1 at the half period, 0 at the wrap', () => {
    expect(dayPhase(0), 'a match starts at full day').toBe(0);
    expect(dayPhase(HALF_CYCLE), 'full night is the peak of the triangle').toBe(1);
    expect(dayPhase(CYCLE_TICKS), 'the cycle wraps back to full day').toBe(0);
    for (const t of [1, 137, HALF_CYCLE - 1, HALF_CYCLE + 1, CYCLE_TICKS - 1]) {
      expect(
        dayPhase(t + CYCLE_TICKS),
        `tick ${t} and tick ${t + CYCLE_TICKS} are one cycle apart and must be the same phase`,
      ).toBe(dayPhase(t));
      expect(dayPhase(t - CYCLE_TICKS), `tick ${t - CYCLE_TICKS} is one cycle back`).toBe(
        dayPhase(t),
      );
    }
  });

  it('falls exactly as it rose — a triangle, not a sawtooth', () => {
    // The divergence AMENDMENT_1 §B.1 closed: a sawtooth ((t / cycle) % 1)
    // agrees with the triangle at t = 0 and nowhere else, which put client
    // lighting at 0.99 where the server's night read 0.02 near every boundary.
    for (const d of [1, 60, 600, HALF_CYCLE - 1, HALF_CYCLE]) {
      expect(
        dayPhase(HALF_CYCLE + d),
        `the ramp down ${d} ticks after full night must mirror the ramp up ${d} ticks before it`,
      ).toBeCloseTo(dayPhase(HALF_CYCLE - d), 12);
    }
  });

  it('is continuous: no tick moves the phase by more than one tick is worth', () => {
    // AMENDMENT_1 §C: the phase drives a ramp, so a discontinuity anywhere pops
    // every unit's vision radius in a single tick. A sawtooth or a boolean snap
    // jumps a whole 1.0 at its boundary and dies here.
    const step = 1 / HALF_CYCLE;
    let worst = 0;
    let at = 0;
    for (let t = -1; t < 2 * CYCLE_TICKS; t++) {
      const d = Math.abs(dayPhase(t + 1) - dayPhase(t));
      if (d > worst) {
        worst = d;
        at = t;
      }
    }
    expect(
      worst,
      `the phase jumps ${worst} between tick ${at} and tick ${at + 1}; one tick is worth ${step}`,
    ).toBeLessThanOrEqual(step + 1e-12);
  });

  it('every phase it produces survives the wire as a finite number', () => {
    // The one JSON assertion worth making here: the VALUE is computed by the
    // frozen producer, and JSON.stringify turns a NaN or an Infinity into null
    // — a reconnecting client lit by `null` is a black screen. matchTick 0 also
    // pins that a full-day 0 travels as a present key rather than being elided.
    for (const matchTick of [
      0,
      1,
      HALF_CYCLE - 1,
      HALF_CYCLE,
      HALF_CYCLE + 1,
      CYCLE_TICKS - 1,
      CYCLE_TICKS,
      5 * CYCLE_TICKS + 4321,
    ]) {
      const wire = overWire(snapAtTick(matchTick));
      if (wire.t !== 'rift_snap') throw new Error(`expected rift_snap, got ${wire.t}`);
      expect(
        typeof wire.dayPhase,
        `the phase at matchTick ${matchTick} arrived as ${JSON.stringify(wire.dayPhase)}`,
      ).toBe('number');
      expect(wire.dayPhase).toBe(dayPhase(matchTick));
      expect(
        Object.hasOwn(wire, 'dayPhase'),
        `dayPhase ${dayPhase(matchTick)} must travel as a present key, not be elided as falsy`,
      ).toBe(true);
    }
  });

  it('is a REQUIRED key on rift_snap — a COMPILE-TIME pin, not a runtime one', () => {
    // Nothing can reject an inbound snapshot that omits the field, so the pin
    // is tsc: the @ts-expect-error below itself fails the build the moment the
    // omission becomes legal — dayPhase made optional, or dropped from RiftS2C.
    // @ts-expect-error — RiftS2C requires dayPhase; omitting it must not compile
    const missing: RiftS2C = {
      t: 'rift_snap',
      tick: 20,
      serverTime: 1_700_000_000_000,
      phase: 'live',
      matchTick: 0,
      overtime: false,
      wardStock: 2,
      kills: [3, 5],
      board: [],
      you: null,
      ents: [],
    };
    expect(missing.t).toBe('rift_snap');
  });

  it('cannot be injected by a client — protocol.ts exposes no S2C parser at all', () => {
    // parseRiftC2S is the ONLY door into the sim and has no 'rift_snap' case,
    // so a hostile client cannot post a dayPhase — in range or wildly out of
    // it — into the simulation. That is precisely why protocol.ts performs no
    // range check on the field, and why shared/ has no place to enforce [0,1]
    // on an inbound value: the field is server-authored, derived from matchTick
    // by the frozen `dayPhase` above, and the invariant is the PRODUCER's
    // obligation, discharged in server/src/room.ts (AMENDMENT_1 §B.1).
    // If an S2C parser is ever added, it must reject out-of-range values and
    // this test must be replaced by that rejection case.
    const outOfRange: readonly number[] = [
      -0.001,
      -1,
      1.001,
      2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const dayPhase of [0, 0.5, 1, ...outOfRange]) {
      expect(
        parseRiftC2S({ t: 'rift_snap', dayPhase, tick: 1 }),
        `a rift_snap carrying dayPhase ${dayPhase} must not parse as a client command`,
      ).toBeNull();
    }
    // Nor through the settings door, which is the only other parser here.
    expect(() => parseRiftSettings({ dayPhase: 5 })).not.toThrow();
    expect(parseRiftSettings({ dayPhase: 5 })).toEqual({}); // unknown keys are ignored
  });
});

describe('nightVisionScale — the ramp the phase drives (AMENDMENT_1 §C)', () => {
  it('is 1 at full day and NIGHT_VISION_MULT at full night', () => {
    expect(nightVisionScale(0), 'full day must not shrink anything').toBe(1);
    expect(nightVisionScale(1)).toBeCloseTo(NIGHT_VISION_MULT, 12);
  });

  it('is a RAMP, not a boolean snap: it decreases strictly across the phase', () => {
    // TERRAIN_CONTRACT §4.3 had written this as a snap; §C ratified the ramp.
    // A snap returns one of two values, so at least one of these strict
    // inequalities collapses into an equality and this test goes red.
    const samples = [0, 0.25, 0.5, 0.75, 1].map((p) => nightVisionScale(p));
    for (let i = 1; i < samples.length; i++) {
      expect(
        samples[i]!,
        `vision scale at phase ${0.25 * i} (${samples[i]!}) is not strictly below the scale at ` +
          `phase ${0.25 * (i - 1)} (${samples[i - 1]!}) — that is a snap, not a ramp`,
      ).toBeLessThan(samples[i - 1]!);
    }
  });

  it('clamps a phase outside [0,1] instead of extrapolating', () => {
    // shared/ cannot police the wire, but this function is total: it is the
    // last line of defence if a producer ever hands it a bad phase.
    expect(nightVisionScale(-0.5), 'a negative phase must read as full day').toBe(1);
    expect(nightVisionScale(2), 'a phase past 1 must read as full night').toBeCloseTo(
      NIGHT_VISION_MULT,
      12,
    );
    expect(nightVisionScale(2)).toBeGreaterThan(0);
  });

  it('composed with dayPhase, vision never pops between two consecutive ticks', () => {
    // The composition is what the sim actually evaluates every tick. One tick
    // of the cycle may move vision by at most one tick's worth of the ramp.
    const perTick = (1 - NIGHT_VISION_MULT) / HALF_CYCLE;
    let worst = 0;
    let at = 0;
    for (let t = 0; t < 2 * CYCLE_TICKS; t++) {
      const d = Math.abs(nightVisionScale(dayPhase(t + 1)) - nightVisionScale(dayPhase(t)));
      if (d > worst) {
        worst = d;
        at = t;
      }
    }
    expect(
      worst,
      `vision scale moves ${worst} between tick ${at} and tick ${at + 1}; one tick of the ramp ` +
        `is worth ${perTick} — anything larger pops every unit's radius in a single tick`,
    ).toBeLessThanOrEqual(perTick + 1e-12);
  });
});

describe('EntSnap — neutral jungle camps (TERRAIN_CONTRACT §5, AMENDMENT_1 §B.4)', () => {
  it('isCampKind classifies exactly the three camp tiers, across the whole union', () => {
    // ENT_KINDS is derived from a Record<EntKind, true>, so the LIST is pinned
    // at compile time; isCampKind is the frozen classifier every consumer must
    // call instead of re-listing the tiers inline. Add a fourth camp tier and
    // forget to classify it, and this goes red at runtime while the Record goes
    // red at compile time.
    for (const k of ENT_KINDS) {
      expect(
        isCampKind(k),
        `isCampKind('${k}') disagrees with TERRAIN_CONTRACT §5's camp census`,
      ).toBe(CAMP_KINDS.includes(k));
    }
    expect(ENT_KINDS.filter((k) => isCampKind(k))).toEqual(CAMP_KINDS);
  });

  it('EntSnap.team admits exactly 0, 1 and NEUTRAL_TEAM — a COMPILE-TIME pin', () => {
    const neutral: EntSnap = entSnap({ id: 77, k: 'campPack', team: NEUTRAL_TEAM });
    // @ts-expect-error — 3 is not an EntTeam; if this compiles, kills[] indexing is unsound
    const alien: EntSnap = entSnap({ id: 78, k: 'campPack', team: 3 });
    expect(neutral.team).toBe(NEUTRAL_TEAM);
    expect(alien.k).toBe('campPack');
  });

  it('in a mixed snapshot, camp kinds are neutral and only players index kills[]', () => {
    const ents: readonly EntSnap[] = [
      entSnap({ id: 1, k: 'hero', team: 0, lvl: 6, hero: 'reaver', pid: 'p1' }),
      entSnap({ id: 2, k: 'melee', team: 1 }),
      entSnap({ id: 3, k: 'campPack', team: NEUTRAL_TEAM }),
      entSnap({ id: 4, k: 'campBrute', team: NEUTRAL_TEAM }),
      entSnap({ id: 5, k: 'campHive', team: NEUTRAL_TEAM }),
    ];
    const wire = snapAtTick(8_000, ents);
    if (wire.t !== 'rift_snap') throw new Error(`expected rift_snap, got ${wire.t}`);
    // The tuple hazard: kills is [team0, team1] and a neutral team indexes off
    // the end of it. isPlayerTeam is the only sanctioned narrowing, and
    // isCampKind is the only sanctioned camp test — the two must agree on every
    // entity in a snapshot.
    for (const e of wire.ents) {
      const team: EntTeam = e.team;
      if (isPlayerTeam(team)) {
        expect(isCampKind(e.k), `'${e.k}' is on player team ${team} but classifies as a camp`).toBe(
          false,
        );
        expect(wire.kills[team], `kills[${team}] must exist for a player team`).toBeTypeOf('number');
      } else {
        expect(team, `entity #${e.id} is on no player team, so it must be NEUTRAL_TEAM`).toBe(
          NEUTRAL_TEAM,
        );
        expect(isCampKind(e.k), `'${e.k}' is neutral but is not classified as a camp kind`).toBe(
          true,
        );
      }
    }
    expect(wire.ents.filter((e) => isCampKind(e.k)), 'the three camp tiers').toHaveLength(3);
  });

  it('isPlayerTeam narrows exactly the two player teams', () => {
    expect(isPlayerTeam(0)).toBe(true);
    expect(isPlayerTeam(1)).toBe(true);
    expect(isPlayerTeam(NEUTRAL_TEAM)).toBe(false);
    expect(NEUTRAL_TEAM).toBe(2);
  });
});

describe('rift_miss (TERRAIN_CONTRACT §4, AMENDMENT_1 §B.2)', () => {
  it('is server-authored: the only parser refuses a client-fabricated miss', () => {
    // The typed literal is the COMPILE-TIME pin on the event's shape — attacker
    // and target are ENTITY ids, like rift_cast's target, not player ids. The
    // runtime assertion is that parseRiftC2S refuses it: rift_miss has no C2S
    // case, and if one is ever added a client can fake every miss in the match.
    const ev: RiftEvent = { t: 'rift_miss', attacker: 1042, target: 1043 };
    expect(parseRiftC2S(ev), `parseRiftC2S accepted ${JSON.stringify(ev)}`).toBeNull();
  });
});
