// ============================================================================
// protocol unit tests (FROZEN contract module). parseC2S accept/reject
// matrix (clamping, flooring, masking) + encode/decode round-trips.
// parseC2S must never throw: every malformed input parses to null.
// ============================================================================
import { WEAPON_ORDER } from '@fps/shared';
import { describe, expect, it } from 'vitest';
import { FENCE } from './config.js';
import { decodeS2C, encodeC2S, encodeS2C, parseC2S } from './protocol.js';
import { INPUT_INTERACT } from './types.js';
import type { C2S, DebugMsg, S2C } from './types.js';

// ---- accepts: every C2S variant round-trips, deep-equal after sanitize ----

describe('parseC2S accepts', () => {
  it('parses the fieldless variants', () => {
    expect(parseC2S({ t: 'reload' })).toEqual({ t: 'reload' });
    expect(parseC2S({ t: 'buy_ammo' })).toEqual({ t: 'buy_ammo' });
    expect(parseC2S({ t: 'start' })).toEqual({ t: 'start' });
  });

  it('parses switch/buy_weapon for every weapon id', () => {
    for (const weapon of WEAPON_ORDER) {
      expect(parseC2S({ t: 'switch', weapon })).toEqual({ t: 'switch', weapon });
      expect(parseC2S({ t: 'buy_weapon', weapon })).toEqual({ t: 'buy_weapon', weapon });
    }
  });

  it('parses ping with a finite ts', () => {
    expect(parseC2S({ t: 'ping', ts: 1234.5 })).toEqual({ t: 'ping', ts: 1234.5 });
  });

  it('parses a well-formed input message unchanged', () => {
    const msg = { t: 'input', seq: 3, moveX: 0.5, moveZ: -1, yaw: 1.2, pitch: -0.3, buttons: 5 };
    expect(parseC2S(msg)).toEqual(msg);
  });
});

// ---- sanitisation rules: each with an in-range and an out-of-range case ---

describe('parseC2S sanitises input fields', () => {
  it('floors seq to an integer', () => {
    expect(
      parseC2S({ t: 'input', seq: 7.9, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 }),
    ).toEqual({ t: 'input', seq: 7, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 });
    expect(
      parseC2S({ t: 'input', seq: 3, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 }),
    ).toEqual({ t: 'input', seq: 3, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 });
  });

  it('clamps moveX/moveZ to [-1, 1]', () => {
    expect(
      parseC2S({ t: 'input', seq: 1, moveX: 2, moveZ: -3, yaw: 0, pitch: 0, buttons: 0 }),
    ).toEqual({ t: 'input', seq: 1, moveX: 1, moveZ: -1, yaw: 0, pitch: 0, buttons: 0 });
    expect(
      parseC2S({ t: 'input', seq: 1, moveX: 0.4, moveZ: -0.4, yaw: 0, pitch: 0, buttons: 0 }),
    ).toEqual({ t: 'input', seq: 1, moveX: 0.4, moveZ: -0.4, yaw: 0, pitch: 0, buttons: 0 });
  });

  it('passes yaw through finite, rejects non-finite', () => {
    expect(
      parseC2S({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: -2.5, pitch: 0, buttons: 0 }),
    ).toEqual({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: -2.5, pitch: 0, buttons: 0 });
    expect(
      parseC2S({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: NaN, pitch: 0, buttons: 0 }),
    ).toBeNull();
  });

  it('clamps pitch to [-1.45, 1.45]', () => {
    expect(
      parseC2S({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 9, buttons: 0 }),
    ).toEqual({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 1.45, buttons: 0 });
    expect(
      parseC2S({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: -9, buttons: 0 }),
    ).toEqual({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: -1.45, buttons: 0 });
    expect(
      parseC2S({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0.7, buttons: 0 }),
    ).toEqual({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0.7, buttons: 0 });
  });

  it('masks buttons with INPUT_MASK (0x3f), keeping the INPUT_INTERACT bit and stripping a 7th bit', () => {
    // 0xff has bits 0-7 set; only bits 0-5 (0x3f) must survive.
    expect(
      parseC2S({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0xff }),
    ).toEqual({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0x3f });
    // INPUT_INTERACT (bit 5, 0x20) alone survives the mask.
    expect(
      parseC2S({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: INPUT_INTERACT }),
    ).toEqual({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: INPUT_INTERACT });
    // A 7th bit (bit 6, 0x40) is stripped even when combined with INPUT_INTERACT.
    expect(
      parseC2S({
        t: 'input',
        seq: 1,
        moveX: 0,
        moveZ: 0,
        yaw: 0,
        pitch: 0,
        buttons: INPUT_INTERACT | 0x40,
      }),
    ).toEqual({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: INPUT_INTERACT });
  });

  it('validates weapon against the real WeaponId allow-list', () => {
    expect(parseC2S({ t: 'switch', weapon: 'pistol' })).toEqual({ t: 'switch', weapon: 'pistol' });
    expect(parseC2S({ t: 'switch', weapon: 'ak47' })).toBeNull();
    expect(parseC2S({ t: 'buy_weapon', weapon: 'rifle' })).toEqual({
      t: 'buy_weapon',
      weapon: 'rifle',
    });
    expect(parseC2S({ t: 'buy_weapon', weapon: 'bazooka' })).toBeNull();
  });

  it('requires ping.ts to be a finite number', () => {
    expect(parseC2S({ t: 'ping', ts: 42 })).toEqual({ t: 'ping', ts: 42 });
    expect(parseC2S({ t: 'ping', ts: Infinity })).toBeNull();
    expect(parseC2S({ t: 'ping', ts: NaN })).toBeNull();
    expect(parseC2S({ t: 'ping', ts: '42' })).toBeNull();
  });
});

// ---- debug message (DebugMsg) sanitisation ---------------------------------

describe('parseC2S handles debug messages', () => {
  it('round-trips each of the six ops through encodeC2S -> parseC2S', () => {
    const msgs: C2S[] = [
      { t: 'debug', op: 'hurt', a: 25 },
      { t: 'debug', op: 'teleport', a: 1, b: 2, c: 3 },
      { t: 'debug', op: 'breach', a: 4 },
      { t: 'debug', op: 'spawn', a: 5, b: 0, c: 6, kind: 'runner' },
      { t: 'debug', op: 'end' },
      { t: 'debug', op: 'invuln', a: 1 },
    ];
    for (const msg of msgs) {
      expect(parseC2S(JSON.parse(encodeC2S(msg)))).toEqual(msg);
    }
  });

  it('rejects an unknown op', () => {
    expect(parseC2S({ t: 'debug', op: 'nuke' })).toBeNull();
  });

  it('rejects a missing op', () => {
    expect(parseC2S({ t: 'debug' })).toBeNull();
  });

  it('rejects non-finite a/b/c', () => {
    expect(parseC2S({ t: 'debug', op: 'teleport', a: NaN })).toBeNull();
    expect(parseC2S({ t: 'debug', op: 'teleport', a: 1, b: Infinity })).toBeNull();
    expect(parseC2S({ t: 'debug', op: 'teleport', a: 1, b: 2, c: -Infinity })).toBeNull();
    expect(parseC2S({ t: 'debug', op: 'hurt', a: NaN })).toBeNull();
  });

  it('rejects an invalid kind, accepts a valid one', () => {
    expect(parseC2S({ t: 'debug', op: 'spawn', kind: 'boss' })).toBeNull();
    expect(parseC2S({ t: 'debug', op: 'spawn', a: 1, b: 2, kind: 'brute' })).toEqual({
      t: 'debug',
      op: 'spawn',
      a: 1,
      b: 2,
      kind: 'brute',
    });
  });

  it('floors and clamps breach.a to a non-negative integer segment index', () => {
    expect(parseC2S({ t: 'debug', op: 'breach', a: 3.9 })).toEqual({
      t: 'debug',
      op: 'breach',
      a: 3,
    });
    expect(parseC2S({ t: 'debug', op: 'breach', a: -5 })).toEqual({
      t: 'debug',
      op: 'breach',
      a: 0,
    });
  });

  it('clamps invuln.a to 0 or 1', () => {
    expect(parseC2S({ t: 'debug', op: 'invuln', a: 1 })).toEqual({
      t: 'debug',
      op: 'invuln',
      a: 1,
    });
    expect(parseC2S({ t: 'debug', op: 'invuln', a: 0 })).toEqual({
      t: 'debug',
      op: 'invuln',
      a: 0,
    });
    expect(parseC2S({ t: 'debug', op: 'invuln', a: 42 })).toEqual({
      t: 'debug',
      op: 'invuln',
      a: 1,
    });
    expect(parseC2S({ t: 'debug', op: 'invuln', a: -7 })).toEqual({
      t: 'debug',
      op: 'invuln',
      a: 0,
    });
  });

  it('leaves genuinely absent optional fields absent on the parsed object (exactOptionalPropertyTypes)', () => {
    const parsed = parseC2S({ t: 'debug', op: 'end' });
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({ t: 'debug', op: 'end' });
    expect('a' in (parsed as object)).toBe(false);
    expect('b' in (parsed as object)).toBe(false);
    expect('c' in (parsed as object)).toBe(false);
    expect('kind' in (parsed as object)).toBe(false);

    const parsedWithA = parseC2S({ t: 'debug', op: 'hurt', a: 10 });
    expect(parsedWithA).not.toBeNull();
    expect('a' in (parsedWithA as object)).toBe(true);
    expect('b' in (parsedWithA as object)).toBe(false);
    expect('c' in (parsedWithA as object)).toBe(false);
    expect('kind' in (parsedWithA as object)).toBe(false);
  });

  it('never throws on a debug message with a hostile throwing getter', () => {
    const hostileDebug: unknown = Object.defineProperty({ t: 'debug', op: 'hurt' }, 'a', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    expect(() => parseC2S(hostileDebug)).not.toThrow();
    expect(parseC2S(hostileDebug)).toBeNull();
  });
});

// ---- rejects: null, never a throw -------------------------------------------

describe('parseC2S rejects without throwing', () => {
  it('rejects non-objects and missing/non-string t', () => {
    expect(parseC2S(null)).toBeNull();
    expect(parseC2S(undefined)).toBeNull();
    expect(parseC2S('input')).toBeNull();
    expect(parseC2S(42)).toBeNull();
    expect(parseC2S([])).toBeNull();
    expect(parseC2S({})).toBeNull();
    expect(parseC2S({ t: 1 })).toBeNull();
  });

  it('rejects unknown message types', () => {
    expect(parseC2S({ t: 'dance' })).toBeNull();
    expect(parseC2S({ t: 'INPUT' })).toBeNull(); // case-sensitive
  });

  it('rejects missing required fields', () => {
    expect(parseC2S({ t: 'switch' })).toBeNull();
    expect(parseC2S({ t: 'buy_weapon' })).toBeNull();
    expect(parseC2S({ t: 'ping' })).toBeNull();
    // input without pitch
    expect(parseC2S({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, buttons: 0 })).toBeNull();
  });

  it('rejects NaN / non-finite numbers anywhere in an input message', () => {
    const base = { t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };
    expect(parseC2S({ ...base, seq: NaN })).toBeNull();
    expect(parseC2S({ ...base, seq: Infinity })).toBeNull();
    expect(parseC2S({ ...base, moveX: Infinity })).toBeNull();
    expect(parseC2S({ ...base, moveZ: -Infinity })).toBeNull();
    expect(parseC2S({ ...base, yaw: NaN })).toBeNull();
    expect(parseC2S({ ...base, pitch: -Infinity })).toBeNull();
    expect(parseC2S({ ...base, buttons: NaN })).toBeNull();
  });

  // ---- hostile inputs: parseC2S MUST NEVER THROW, always returns null -------

  const throwingGetter = new Proxy(
    { t: 'input' },
    {
      get(target, prop) {
        if (prop === 't') return 'input';
        throw new Error('hostile getter');
      },
    },
  );

  const objWithThrowingGetter: unknown = Object.defineProperty({ t: 'input' }, 'seq', {
    get() {
      throw new Error('boom');
    },
    enumerable: true,
  });

  const hostileInputs: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a bare array', []],
    ['a nested array pretending to be an object', [{ t: 'input' }]],
    ['a function', () => ({ t: 'input' })],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a deeply nested junk object', { t: 'input', seq: { a: { b: { c: { d: 1 } } } } }],
    ['a circular object (t missing)', (() => {
      const o: Record<string, unknown> = {};
      o['self'] = o;
      return o;
    })()],
    ['a proxy whose property access throws', throwingGetter],
    ['an object with a throwing getter on a required field', objWithThrowingGetter],
    ['a string', 'not an object'],
    ['a number', 12345],
    ['a boolean', true],
    ['a Symbol', Symbol('x')],
  ];

  it.each(hostileInputs)('returns null and does not throw for: %s', (_label, input) => {
    expect(() => parseC2S(input)).not.toThrow();
    expect(parseC2S(input)).toBeNull();
  });
});

// ---- encode/decode round-trips ----------------------------------------------

describe('encode/decode', () => {
  it('encodeC2S produces JSON that parses back to the same message', () => {
    const msg: C2S = { t: 'input', seq: 3, moveX: 0.5, moveZ: -1, yaw: 1.2, pitch: -0.3, buttons: 5 };
    const parsed: unknown = JSON.parse(encodeC2S(msg));
    expect(parsed).toEqual(msg);
    expect(parseC2S(parsed)).toEqual(msg); // wire loopback stays valid
  });

  it('encodeC2S/parseC2S round-trips every C2S tag', () => {
    const msgs: C2S[] = [
      { t: 'input', seq: 1, moveX: 0.1, moveZ: -0.2, yaw: 0.3, pitch: -0.4, buttons: 3 },
      { t: 'reload' },
      { t: 'switch', weapon: 'smg' },
      { t: 'buy_weapon', weapon: 'shotgun' },
      { t: 'buy_ammo' },
      { t: 'start' },
      { t: 'ping', ts: 999.5 },
    ];
    for (const msg of msgs) {
      expect(parseC2S(JSON.parse(encodeC2S(msg)))).toEqual(msg);
    }
  });

  it('decodeS2C round-trips encodeS2C output', () => {
    const msg: S2C = { t: 'pong', ts: 12, serverTime: 34 };
    expect(decodeS2C(encodeS2C(msg))).toEqual(msg);
  });

  it('decodeS2C returns null on malformed JSON instead of throwing', () => {
    expect(() => decodeS2C('not json')).not.toThrow();
    expect(decodeS2C('not json')).toBeNull();
    expect(decodeS2C('{"unterminated": ')).toBeNull();
    expect(decodeS2C('42')).toBeNull();
    expect(decodeS2C('{"x":1}')).toBeNull();
    expect(decodeS2C('null')).toBeNull();
  });
});

// ---- regression: start.seed must survive the wire --------------------------
//
// `case 'start'` used to return `{ t: 'start' }` unconditionally, silently
// discarding the optional `seed` field C2S declares. It typechecked and every
// existing test passed — `seed` is what makes a capture round and a failed
// horde gate reproducible, and it was being thrown away on the wire.

describe('parseC2S start.seed', () => {
  it('start.seed survives the wire — without it no capture round is reproducible', () => {
    expect(parseC2S(JSON.parse(encodeC2S({ t: 'start', seed: 42 })))).toEqual({
      t: 'start',
      seed: 42,
    });
  });

  it('floors a fractional seed', () => {
    expect(parseC2S({ t: 'start', seed: 42.9 })).toEqual({ t: 'start', seed: 42 });
  });

  it('rejects a non-finite seed', () => {
    expect(parseC2S({ t: 'start', seed: NaN })).toBeNull();
    expect(parseC2S({ t: 'start', seed: Infinity })).toBeNull();
    expect(parseC2S({ t: 'start', seed: -Infinity })).toBeNull();
  });

  it('parses a seedless start, and the result has NO seed key (exactOptionalPropertyTypes)', () => {
    const parsed = parseC2S({ t: 'start' });
    expect(parsed).toEqual({ t: 'start' });
    expect('seed' in (parsed as object)).toBe(false);
  });
});

// ---- regression: debug numeric fields are clamped into real bounds --------
//
// Debug ops mutate server-authoritative state directly, so an unclamped
// segment index, coordinate, or damage value would be a live out-of-bounds
// write via the debug wire, not just a cosmetic glitch.

describe('parseC2S clamps debug segment index (breach.a) to a real segment', () => {
  it('clamps a huge breach.a to the last real segment, using the real FENCE.segments constant', () => {
    expect(parseC2S({ t: 'debug', op: 'breach', a: 1e9 })).toEqual({
      t: 'debug',
      op: 'breach',
      a: FENCE.segments - 1,
    });
  });

  it('clamps a negative breach.a to 0', () => {
    expect(parseC2S({ t: 'debug', op: 'breach', a: -1e9 })).toEqual({
      t: 'debug',
      op: 'breach',
      a: 0,
    });
  });

  it('floors a fractional in-range breach.a', () => {
    expect(parseC2S({ t: 'debug', op: 'breach', a: 5.7 })).toEqual({
      t: 'debug',
      op: 'breach',
      a: 5,
    });
  });
});

describe('parseC2S bounds debug coordinates and damage', () => {
  it('clamps teleport a/b/c to the finite WORLD_BOUND half-extent (200, per protocol.ts)', () => {
    const parsed = parseC2S({ t: 'debug', op: 'teleport', a: 1e308, b: -1e308, c: 0 }) as
      | DebugMsg
      | null;
    expect(parsed).not.toBeNull();
    const msg = parsed as DebugMsg;
    expect(Number.isFinite(msg.a)).toBe(true);
    expect(Number.isFinite(msg.b)).toBe(true);
    expect(Number.isFinite(msg.c)).toBe(true);
    expect(msg.a).toBe(200);
    expect(msg.b).toBe(-200);
    expect(msg.c).toBe(0);
  });

  it('clamps hurt.a damage to a non-negative, finite value', () => {
    const parsed = parseC2S({ t: 'debug', op: 'hurt', a: -50 }) as DebugMsg | null;
    expect(parsed).not.toBeNull();
    const msg = parsed as DebugMsg;
    expect(Number.isFinite(msg.a)).toBe(true);
    expect(msg.a).toBeGreaterThanOrEqual(0);
    expect(msg.a).toBe(0);
  });
});
