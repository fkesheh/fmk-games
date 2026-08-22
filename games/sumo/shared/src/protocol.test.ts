import { describe, expect, it } from 'vitest';
// ============================================================================
// SUMO wire validation — accept/reject matrix for parseSumoC2S and the pad
// funnel. House rules: never throw, clamp axes, reject non-finite.
// ============================================================================
import { BIT_DASH, BIT_JUMP } from './types.js';
import { parseSumoC2S, padFrameToInput } from './protocol.js';

describe('parseSumoC2S', () => {
  it('accepts a well-formed input frame', () => {
    const m = parseSumoC2S({ t: 'input', seq: 42, mx: -0.5, mz: 1, bits: BIT_DASH | BIT_JUMP });
    expect(m).toEqual({ t: 'input', seq: 42, mx: -0.5, mz: 1, bits: 3 });
  });

  it('clamps out-of-range axes into [-1,1]', () => {
    const m = parseSumoC2S({ t: 'input', seq: 0, mx: 7, mz: -9, bits: 0 });
    expect(m).toEqual({ t: 'input', seq: 0, mx: 1, mz: -1, bits: 0 });
  });

  it('truncates fractional seq and masks bits into uint32', () => {
    const m = parseSumoC2S({ t: 'input', seq: 3.7, mx: 0, mz: 0, bits: 5.9 });
    if (m === null || m.t !== 'input') throw new Error('expected an input frame');
    expect(m.seq).toBe(3);
    expect(m.bits).toBe(5);
  });

  it('rejects garbage shapes without throwing', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'input',
      42,
      {},
      { t: 'unknown_tag', x: 1 },
      { t: 'input' },
      { t: 'input', seq: 0 },
      { t: 'input', seq: '1', mx: 0, mz: 0, bits: 0 },
      { t: 'input', seq: NaN, mx: 0, mz: 0, bits: 0 },
      { t: 'input', seq: Infinity, mx: 0, mz: 0, bits: 0 },
      { t: 'input', seq: -1, mx: 0, mz: 0, bits: 0 },
      { t: 'input', seq: 2 ** 32, mx: 0, mz: 0, bits: 0 },
      { t: 'input', seq: 0, mx: NaN, mz: 0, bits: 0 },
      { t: 'input', seq: 0, mx: 0, mz: Infinity, bits: 0 },
      { t: 'input', seq: 0, mx: 0, mz: 0, bits: '3' },
      { t: 'input', seq: 0, mx: 0, mz: 0, bits: NaN },
    ];
    for (const raw of bad) {
      expect(parseSumoC2S(raw)).toBeNull();
    }
  });

  it('accepts the debug_bot hook and rejects junk around it', () => {
    expect(parseSumoC2S({ t: 'debug_bot' })).toEqual({ t: 'debug_bot' });
    expect(parseSumoC2S({ t: 'debug_bot', extra: 'junk' })).toEqual({ t: 'debug_bot' });
  });
});

describe('padFrameToInput', () => {
  it('maps left stick to movement with ly inverted (stick up = forward)', () => {
    const f = padFrameToInput({ lx: 1, ly: -1, rx: 0, ry: 0, buttons: BIT_JUMP });
    expect(f).toEqual({ mx: 1, mz: 1, bits: BIT_JUMP, seq: -1 });
  });

  it('carries an optional seq through when sane', () => {
    const f = padFrameToInput({ lx: 0, ly: 0, rx: 0, ry: 0, buttons: 0, seq: 99 });
    expect(f?.seq).toBe(99);
  });

  it('rejects non-finite axes/buttons defensively', () => {
    expect(padFrameToInput({ lx: NaN, ly: 0, rx: 0, ry: 0, buttons: 0 })).toBeNull();
    expect(padFrameToInput({ lx: 0, ly: Infinity, rx: 0, ry: 0, buttons: 0 })).toBeNull();
    expect(padFrameToInput({ lx: 0, ly: 0, rx: 0, ry: 0, buttons: NaN })).toBeNull();
  });
});
