// HostedClient tests (P2-2) — lease adoption/renew/depose/revoke over a fake
// net. Fake timers drive the renew loop; no sockets involved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { C2S, LobbyS2C, PlayerId } from '@platform/shared';
import { HostedClient } from './hosted.js';
import type { HostedNet } from './hosted.js';

type Frame = LobbyS2C & Record<string, unknown>;

class FakeNet implements HostedNet {
  readonly sent: C2S[] = [];
  private readonly listeners: Array<(msg: Frame) => void> = [];

  send(msg: C2S): void {
    this.sent.push(msg);
  }

  addInternalListener(fn: (msg: Frame) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  emit(msg: Frame): void {
    for (const fn of [...this.listeners]) fn(msg);
  }

  renews(): Array<Extract<C2S, { t: 'host_renew' }>> {
    return this.sent.filter((m): m is Extract<C2S, { t: 'host_renew' }> => m.t === 'host_renew');
  }
}

const LEASE_A = 'LEASEAAAAAAA1';
const LEASE_B = 'LEASEBBBBBBB2';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HostedClient (P2-2)', () => {
  it('adopts a lease addressed to us and renews at TTL/2 with provider ticks', () => {
    const net = new FakeNet();
    let tick = 100;
    const leased: string[] = [];
    const c = new HostedClient(net, {
      tickProvider: () => tick,
      onLease: (l) => leased.push(l.leaseId),
    });
    net.emit({ t: 'welcome', playerId: 'me' });
    net.emit({ t: 'host_lease', leaseId: LEASE_A, hostId: 'me', ttlMs: 6000 });

    expect(c.isHost).toBe(true);
    expect(c.leaseId).toBe(LEASE_A);
    expect(c.hostId).toBe('me');
    expect(leased).toEqual([LEASE_A]);

    tick = 101;
    vi.advanceTimersByTime(3000);
    expect(net.renews()).toEqual([{ t: 'host_renew', leaseId: LEASE_A, tick: 101 }]);
    tick = 102;
    vi.advanceTimersByTime(3000);
    expect(net.renews().length).toBe(2);
    expect(net.renews()[1]).toEqual({ t: 'host_renew', leaseId: LEASE_A, tick: 102 });
    c.close();
  });

  it('ignores a lease addressed to someone else (never start a second sim)', () => {
    const net = new FakeNet();
    let leased = 0;
    const c = new HostedClient(net, { onLease: () => (leased += 1) });
    net.emit({ t: 'welcome', playerId: 'me' });

    net.emit({ t: 'host_lease', leaseId: LEASE_A, hostId: 'other', ttlMs: 6000 });

    expect(c.isHost).toBe(false);
    expect(c.leaseId).toBeNull();
    expect(leased).toBe(0);
    vi.advanceTimersByTime(30000);
    expect(net.renews()).toEqual([]);
    c.close();
  });

  it('host_change fires onHostChange (holder id + tick; null = server sims)', () => {
    const net = new FakeNet();
    const seen: Array<{ id: PlayerId | null; tick: number }> = [];
    const c = new HostedClient(net, { onHostChange: (id, tick) => seen.push({ id, tick }) });
    net.emit({ t: 'welcome', playerId: 'me' });

    net.emit({ t: 'host_change', newHostId: 'peer', resumeTick: 55 });

    expect(c.hostId).toBe('peer');
    expect(c.isHost).toBe(false);
    expect(seen).toEqual([{ id: 'peer', tick: 55 }]);

    net.emit({ t: 'host_change', newHostId: null, resumeTick: 60 });
    expect(c.hostId).toBeNull();
    expect(seen.at(-1)).toEqual({ id: null, tick: 60 });
    c.close();
  });

  it('host_change naming another holder while we hold the lease deposes us immediately', () => {
    const net = new FakeNet();
    let revoked = 0;
    const c = new HostedClient(net, { onRevoked: () => (revoked += 1) });
    net.emit({ t: 'welcome', playerId: 'me' });
    net.emit({ t: 'host_lease', leaseId: LEASE_A, hostId: 'me', ttlMs: 6000 });
    expect(c.isHost).toBe(true);

    net.emit({ t: 'host_change', newHostId: 'peer', resumeTick: 70 });

    expect(c.isHost).toBe(false);
    expect(c.leaseId).toBeNull();
    expect(revoked).toBe(1);
    vi.advanceTimersByTime(30000);
    expect(net.renews()).toEqual([]); // the loop is dead
    c.close();
  });

  it('host_revoked halts only on an exact id match (stale echoes ignored)', () => {
    const net = new FakeNet();
    let revoked = 0;
    const c = new HostedClient(net, { onRevoked: () => (revoked += 1) });
    net.emit({ t: 'welcome', playerId: 'me' });
    net.emit({ t: 'host_lease', leaseId: LEASE_A, hostId: 'me', ttlMs: 6000 });

    net.emit({ t: 'host_revoked', leaseId: LEASE_B }); // previous loop's echo
    expect(c.isHost).toBe(true);
    expect(revoked).toBe(0);

    net.emit({ t: 'host_revoked', leaseId: LEASE_A });
    expect(c.isHost).toBe(false);
    expect(revoked).toBe(1);
    vi.advanceTimersByTime(30000);
    expect(net.renews()).toEqual([]);
    c.close();
  });

  it('malformed lease traffic is ignored, never throws, never adopts', () => {
    const net = new FakeNet();
    let leased = 0;
    const c = new HostedClient(net, { onLease: () => (leased += 1) });
    net.emit({ t: 'welcome', playerId: 'me' });

    expect(() => {
      net.emit({ t: 'host_lease', leaseId: 'short', hostId: 'me', ttlMs: 6000 });
      net.emit({ t: 'host_lease', leaseId: LEASE_A, hostId: 'me', ttlMs: -5 });
      net.emit({ t: 'host_lease', leaseId: LEASE_A, hostId: 'me', ttlMs: Number.NaN });
      net.emit({ t: 'host_lease', leaseId: LEASE_A, hostId: '', ttlMs: 6000 });
      net.emit({ t: 'host_change', newHostId: 'peer', resumeTick: -1 });
      net.emit({ t: 'host_change', newHostId: 42, resumeTick: 1 } as unknown as Frame);
      net.emit({ t: 'host_revoked', leaseId: 'x' });
    }).not.toThrow();

    expect(c.isHost).toBe(false);
    expect(leased).toBe(0);
    c.close();
  });

  it('close() stops the renew loop and detaches (no renews, no adoption after)', () => {
    const net = new FakeNet();
    let leased = 0;
    const c = new HostedClient(net, { onLease: () => (leased += 1) });
    net.emit({ t: 'welcome', playerId: 'me' });
    net.emit({ t: 'host_lease', leaseId: LEASE_A, hostId: 'me', ttlMs: 6000 });
    expect(c.isHost).toBe(true);

    c.close();
    c.close(); // idempotent

    expect(c.isHost).toBe(false);
    vi.advanceTimersByTime(30000);
    expect(net.renews()).toEqual([]);
    net.emit({ t: 'host_lease', leaseId: LEASE_B, hostId: 'me', ttlMs: 6000 });
    expect(leased).toBe(1); // the late lease never arrived (detached)
    expect(c.isHost).toBe(false);
  });

  it('a throwing tickProvider degrades to tick 0 instead of stopping renewals', () => {
    const net = new FakeNet();
    const c = new HostedClient(net, {
      tickProvider: () => {
        throw new Error('sim gone');
      },
    });
    net.emit({ t: 'welcome', playerId: 'me' });
    net.emit({ t: 'host_lease', leaseId: LEASE_A, hostId: 'me', ttlMs: 6000 });

    vi.advanceTimersByTime(3000);

    expect(net.renews()).toEqual([{ t: 'host_renew', leaseId: LEASE_A, tick: 0 }]);
    c.close();
  });
});
