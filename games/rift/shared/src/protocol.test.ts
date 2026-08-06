// ============================================================================
// ANCIENTS (rift) — PROTOCOL GATE.
//
// parseRiftC2S is the only door into the sim: every message kind must
// round-trip, and every malformed input must return null WITHOUT throwing.
// parseRiftSettings is the opposite: it THROWS Error(message) on bad input
// so the platform can convert it to {t:'error',code:'bad_settings'}.
//
// The S2C direction has no parser by design — the server authors it — so its
// gate is different in kind: the shapes must survive the wire byte for byte
// (JSON round-trip), the fields the terrain build added must be present and
// unlossy, and nothing on the S2C side may be reachable through parseRiftC2S.
// That covers `rift_snap.dayPhase` (TERRAIN_CONTRACT §6), the neutral camp
// EntKinds and `EntSnap.team === NEUTRAL_TEAM` (§5), and `rift_miss` (§4).
//
// Frozen code under test (Layer-1, IMMUTABLE): protocol.ts, config.ts,
// hero.ts, item.ts, types.ts.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  INVENTORY_SLOTS,
  MAP_COORD_MAX,
  MAX_TEAM_SIZE,
  MIN_TEAM_SIZE,
  NEUTRAL_TEAM,
  isPlayerTeam,
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

// ============================================================================
// S2C — the server-authored direction (TERRAIN_CONTRACT §4, §5, §6).
// ============================================================================

/** One trip through the wire: exactly what a WebSocket does to a message. */
function overWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Every EntKind, as a Record so the compiler rejects this list the moment a
 *  kind is added to or removed from the union — a new kind that nobody
 *  round-trips is a kind the client silently fails to draw. */
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

/** The three neutral jungle tiers (TERRAIN_CONTRACT §5). */
const CAMP_KINDS: readonly EntKind[] = ['campPack', 'campBrute', 'campHive'];

function entSnap(over: Partial<EntSnap> & Pick<EntSnap, 'k' | 'team'>): EntSnap {
  return { id: 1, x: 10, z: 20, hp: 400, maxHp: 400, ...over };
}

function snap(dayPhase: number, ents: readonly EntSnap[] = []): RiftS2C {
  return {
    t: 'rift_snap',
    tick: 900,
    serverTime: 1_700_000_000_000,
    phase: 'live',
    matchTick: 880,
    overtime: false,
    dayPhase,
    wardStock: 2,
    kills: [3, 5],
    board: [],
    you: null,
    ents,
  };
}

describe('rift_snap.dayPhase (TERRAIN_CONTRACT §6)', () => {
  it('survives the wire exactly, at both ends of the cycle and in between', () => {
    // 0 = full day, 1 = full night, continuous and WRAPPING. The client feeds
    // it straight to SceneHandle.setTimeOfDay, so any lossy step here is a
    // reconnecting client lit for the wrong half of the cycle.
    for (const dayPhase of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
      const wire = overWire(snap(dayPhase));
      if (wire.t !== 'rift_snap') throw new Error(`expected rift_snap, got ${wire.t}`);
      expect(wire.dayPhase, `dayPhase ${dayPhase} did not survive the wire`).toBe(dayPhase);
    }
  });

  it('is a REQUIRED key — full day (0) is not dropped as falsy', () => {
    const wire = overWire(snap(0));
    expect(
      Object.hasOwn(wire, 'dayPhase'),
      `dayPhase 0 (full day) must travel as a present key, not be elided — got ` +
        `${JSON.stringify(wire)}`,
    ).toBe(true);
    if (wire.t !== 'rift_snap') throw new Error(`expected rift_snap, got ${wire.t}`);
    expect(wire.dayPhase).toBe(0);
    expect(typeof wire.dayPhase).toBe('number');
  });

  it('is never interpolated into existence: two snaps carry two independent phases', () => {
    const a = overWire(snap(0.98));
    const b = overWire(snap(0.02));
    if (a.t !== 'rift_snap' || b.t !== 'rift_snap') throw new Error('expected rift_snap');
    // A wrap looks like a huge jump; the contract forbids interpolating across
    // it, so both endpoints must arrive intact for the client to detect one.
    expect(a.dayPhase).toBe(0.98);
    expect(b.dayPhase).toBe(0.02);
  });

  it('cannot be injected by a client — protocol.ts exposes no S2C parser at all', () => {
    // parseRiftC2S is the ONLY door into the sim and has no 'rift_snap' case,
    // so a hostile client cannot post a dayPhase — in range or wildly out of
    // it — into the simulation. That is precisely why protocol.ts performs no
    // range check on the field: it is server-authored, derived from matchTick
    // and DAY_PERIOD_S, and the [0,1] invariant is the PRODUCER's obligation
    // (TERRAIN_CONTRACT §6), pinned by the capture harness's setDayPhase.
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

describe('EntSnap — neutral jungle camps on the wire (TERRAIN_CONTRACT §5)', () => {
  it('every EntKind round-trips, including the three camp tiers', () => {
    for (const k of ENT_KINDS) {
      const wire = overWire(entSnap({ k, team: CAMP_KINDS.includes(k) ? NEUTRAL_TEAM : 0 }));
      expect(wire.k, `EntKind '${k}' did not survive the wire`).toBe(k);
    }
    for (const k of CAMP_KINDS) {
      expect(ENT_KINDS, `camp kind '${k}' is missing from EntKind`).toContain(k);
    }
  });

  it('team === NEUTRAL_TEAM (2) round-trips and is not coerced to a player team', () => {
    for (const k of CAMP_KINDS) {
      const wire = overWire(entSnap({ id: 77, k, team: NEUTRAL_TEAM }));
      expect(wire.team, `'${k}' arrived on team ${wire.team}, not NEUTRAL_TEAM`).toBe(2);
      expect(wire.team).not.toBe(0);
      expect(wire.team).not.toBe(1);
    }
  });

  it('a whole snapshot of mixed teams keeps every entity on its own team', () => {
    const ents: readonly EntSnap[] = [
      entSnap({ id: 1, k: 'hero', team: 0, lvl: 6, hero: 'reaver', pid: 'p1' }),
      entSnap({ id: 2, k: 'melee', team: 1 }),
      entSnap({ id: 3, k: 'campPack', team: NEUTRAL_TEAM }),
      entSnap({ id: 4, k: 'campBrute', team: NEUTRAL_TEAM }),
      entSnap({ id: 5, k: 'campHive', team: NEUTRAL_TEAM }),
    ];
    const wire = overWire(snap(0.4, ents));
    if (wire.t !== 'rift_snap') throw new Error(`expected rift_snap, got ${wire.t}`);
    expect(wire.ents.map((e) => [e.id, e.k, e.team])).toEqual([
      [1, 'hero', 0],
      [2, 'melee', 1],
      [3, 'campPack', 2],
      [4, 'campBrute', 2],
      [5, 'campHive', 2],
    ]);
    // The tuple hazard: kills is [team0, team1] and a neutral team would index
    // off the end of it. isPlayerTeam is the only sanctioned narrowing.
    for (const e of wire.ents) {
      const team: EntTeam = e.team;
      if (isPlayerTeam(team)) {
        expect(wire.kills[team], `kills[${team}] must exist`).toBeTypeOf('number');
      } else {
        expect(team).toBe(NEUTRAL_TEAM);
        expect(CAMP_KINDS).toContain(e.k);
      }
    }
  });

  it('isPlayerTeam narrows exactly the two player teams', () => {
    expect(isPlayerTeam(0)).toBe(true);
    expect(isPlayerTeam(1)).toBe(true);
    expect(isPlayerTeam(NEUTRAL_TEAM)).toBe(false);
    expect(NEUTRAL_TEAM).toBe(2);
  });
});

describe('rift_miss (TERRAIN_CONTRACT §4)', () => {
  it('round-trips with ENTITY ids, like rift_cast', () => {
    const ev: RiftEvent = { t: 'rift_miss', attacker: 1042, target: 1043 };
    expect(overWire(ev)).toEqual({ t: 'rift_miss', attacker: 1042, target: 1043 });
  });

  it('is not a client command: a client cannot fabricate a miss', () => {
    expect(parseRiftC2S({ t: 'rift_miss', attacker: 1, target: 2 })).toBeNull();
  });
});
