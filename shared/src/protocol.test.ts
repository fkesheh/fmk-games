// ============================================================================
// T1 — protocol unit tests (FROZEN contract module). parseC2S accept/reject
// matrix (clamping, trimming, case fixes) + encode/decode round-trips.
// parseC2S must never throw: every malformed input parses to null.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { decodeS2C, encodeC2S, encodeS2C, parseC2S } from './protocol.js';
import type { C2S, S2C } from './types.js';

// ---- accepts: every valid C2S variant, deep-equal after sanitize ------------

describe('parseC2S accepts', () => {
  it('parses the fieldless variants', () => {
    expect(parseC2S({ t: 'list_rooms' })).toEqual({ t: 'list_rooms' });
    expect(parseC2S({ t: 'leave' })).toEqual({ t: 'leave' });
    expect(parseC2S({ t: 'reload' })).toEqual({ t: 'reload' });
  });

  it('trims names and falls back to Player when the trim is empty', () => {
    expect(parseC2S({ t: 'quick_join', name: '  Bob  ' })).toEqual({ t: 'quick_join', name: 'Bob' });
    expect(parseC2S({ t: 'quick_join', name: '   ' })).toEqual({ t: 'quick_join', name: 'Player' });
    expect(parseC2S({ t: 'create_private', name: 'Ada', mapId: 'dustbowl' })).toEqual({
      t: 'create_private',
      name: 'Ada',
      mapId: 'dustbowl',
    });
  });

  it('uppercases private join codes', () => {
    expect(parseC2S({ t: 'join_private', name: 'Ada', code: 'ab1cd' })).toEqual({
      t: 'join_private',
      name: 'Ada',
      code: 'AB1CD',
    });
  });

  it('accepts every map id', () => {
    for (const mapId of ['dustbowl', 'crossfire', 'office', 'frostbite', 'urbana', 'bunker'] as const) {
      expect(parseC2S({ t: 'create_private', name: 'A', mapId })).toEqual({
        t: 'create_private',
        name: 'A',
        mapId,
      });
    }
  });

  it('clamps input axes/pitch, floors seq, masks buttons', () => {
    expect(
      parseC2S({ t: 'input', seq: 7.9, moveX: 2, moveZ: -3, yaw: 0.25, pitch: 9, buttons: 0xff }),
    ).toEqual({ t: 'input', seq: 7, moveX: 1, moveZ: -1, yaw: 0.25, pitch: 1.45, buttons: 0xf });
    expect(
      parseC2S({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: -2.5, pitch: -9, buttons: 0 }),
    ).toEqual({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: -2.5, pitch: -1.45, buttons: 0 });
  });

  it('parses switch/buy for every weapon id', () => {
    for (const weapon of ['knife', 'pistol', 'smg', 'shotgun', 'rifle', 'sniper'] as const) {
      expect(parseC2S({ t: 'switch', weapon })).toEqual({ t: 'switch', weapon });
      expect(parseC2S({ t: 'buy', weapon })).toEqual({ t: 'buy', weapon });
    }
  });

  it('parses ping with a finite ts', () => {
    expect(parseC2S({ t: 'ping', ts: 1234.5 })).toEqual({ t: 'ping', ts: 1234.5 });
  });
});

// ---- rejects: null, never a throw -------------------------------------------

describe('parseC2S rejects', () => {
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
    expect(parseC2S({ t: 'quick_join' })).toBeNull();
    expect(parseC2S({ t: 'create_private', name: 'A' })).toBeNull();
    expect(parseC2S({ t: 'join_private', name: 'A' })).toBeNull();
    // input without pitch
    expect(parseC2S({ t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, buttons: 0 })).toBeNull();
    expect(parseC2S({ t: 'ping' })).toBeNull();
  });

  it('rejects NaN / non-finite numbers anywhere', () => {
    const base = { t: 'input', seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };
    expect(parseC2S({ ...base, yaw: NaN })).toBeNull();
    expect(parseC2S({ ...base, seq: NaN })).toBeNull();
    expect(parseC2S({ ...base, moveX: Infinity })).toBeNull();
    expect(parseC2S({ ...base, pitch: -Infinity })).toBeNull();
    expect(parseC2S({ t: 'ping', ts: NaN })).toBeNull();
  });

  it('rejects bad weapon and map ids', () => {
    expect(parseC2S({ t: 'buy', weapon: 'ak47' })).toBeNull();
    expect(parseC2S({ t: 'switch', weapon: 'knife2' })).toBeNull();
    expect(parseC2S({ t: 'create_private', name: 'A', mapId: 'narnia' })).toBeNull();
  });

  it('rejects overlong names and codes', () => {
    expect(parseC2S({ t: 'quick_join', name: 'x'.repeat(17) })).toBeNull();
    expect(parseC2S({ t: 'join_private', name: 'A', code: 'y'.repeat(9) })).toBeNull();
    // boundary: exactly 16 chars is still fine
    expect(parseC2S({ t: 'quick_join', name: 'x'.repeat(16) })).not.toBeNull();
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

  it('decodeS2C round-trips encodeS2C output', () => {
    const msg: S2C = {
      t: 'event',
      ev: { t: 'round_end', winner: 'CT', reason: 'elimination', scoreT: 2, scoreCT: 3 },
    };
    expect(decodeS2C(encodeS2C(msg))).toEqual(msg);
  });

  it('decodeS2C returns null on garbage instead of throwing', () => {
    expect(decodeS2C('not json')).toBeNull();
    expect(decodeS2C('42')).toBeNull();
    expect(decodeS2C('{"x":1}')).toBeNull();
    expect(decodeS2C('null')).toBeNull();
  });
});
