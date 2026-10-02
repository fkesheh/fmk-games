// protocol.ts unit tests — hosted-authority wire validation (P1). The lobby
// tags predate this file and are covered behaviorally in lobby.test.ts; what
// is pinned HERE is the security-sensitive seam: lease-id shape validation
// and host_renew parsing (bearer-token hygiene starts at the parser).
import { describe, expect, it } from 'vitest';
import { isValidLeaseId, parseC2S } from './protocol.js';

describe('hosted-authority wire validation (P1)', () => {
  it('isValidLeaseId accepts the 12-char minted shape, rejects the rest', () => {
    expect(isValidLeaseId('ABCDEF123456')).toBe(true);
    expect(isValidLeaseId('short')).toBe(false);
    expect(isValidLeaseId('x'.repeat(33))).toBe(false);
    expect(isValidLeaseId('')).toBe(false);
    expect(isValidLeaseId(null)).toBe(false);
    expect(isValidLeaseId(42)).toBe(false);
  });

  it('host_renew parses with a valid id + u32 tick (fractional ticks truncate)', () => {
    expect(parseC2S({ t: 'host_renew', leaseId: 'ABCDEF123456', tick: 42 })).toEqual({
      t: 'host_renew',
      leaseId: 'ABCDEF123456',
      tick: 42,
    });
    expect(parseC2S({ t: 'host_renew', leaseId: 'ABCDEF123456', tick: 42.9 })).toEqual({
      t: 'host_renew',
      leaseId: 'ABCDEF123456',
      tick: 42,
    });
  });

  it('host_renew rejects bad ids, negative/huge/NaN ticks, and non-objects', () => {
    expect(parseC2S({ t: 'host_renew', leaseId: 'short', tick: 1 })).toBeNull();
    expect(parseC2S({ t: 'host_renew', leaseId: 'ABCDEF123456' })).toBeNull();
    expect(parseC2S({ t: 'host_renew', leaseId: 'ABCDEF123456', tick: -1 })).toBeNull();
    expect(parseC2S({ t: 'host_renew', leaseId: 'ABCDEF123456', tick: 0xffffffff + 1 })).toBeNull();
    expect(parseC2S({ t: 'host_renew', leaseId: 'ABCDEF123456', tick: Number.NaN })).toBeNull();
    expect(parseC2S(null)).toBeNull();
  });

  it('host_snap passes through as an unparsed RAW envelope (the lobby validates it)', () => {
    const frame = { t: 'host_snap', leaseId: 'ABCDEF123456', tick: 7, snap: { players: [] } };
    expect(parseC2S(frame)).toBe(frame); // same object, RAW passthrough
  });
});
