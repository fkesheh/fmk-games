// ============================================================================
// SDK HOSTED CLIENT — the player-side half of hosted authority (P2-2,
// docs/PLATFORM.md §12). Attaches to SdkNet as an internal listener (sees
// lease traffic BEFORE the game), tracks our lease, and runs the renew loop
// while we hold it.
//
// Rules (client-side split-brain prevention):
//   - a lease is adopted ONLY when host_lease.hostId === our welcome id — a
//     leaked/echoed lease for someone else must never start a second sim;
//   - host_change naming anyone else (or null) while we hold a lease drops it
//     IMMEDIATELY (fast depose; the server's host_revoked echo is the backstop);
//   - host_revoked halts us ONLY when its id === our live id (a re-elected
//     holder must ignore the echo for its previous loop).
// The GAME owns the sim itself: onLease starts it, onHostChange re-points
// input/render at the new holder (null = render server snapshots again),
// onRevoked halts it. Snapshot upload stays game-shaped via net.send.
// Owner: P1/P2 hosted foundations — consumed by the pilot (no game wires it yet).
// ============================================================================

import { isValidLeaseId } from '@platform/shared';
import type { C2S, LobbyS2C, PlayerId } from '@platform/shared';

/** The SdkNet surface HostedClient needs (SdkNet satisfies this structurally). */
export interface HostedNet {
  send(msg: C2S): void;
  addInternalListener(fn: (msg: LobbyS2C & Record<string, unknown>) => void): () => void;
}

export interface HostedLease {
  leaseId: string;
  ttlMs: number;
}

export interface HostedClientOpts {
  /** Current authoritative sim tick, sampled on every renew. */
  tickProvider?: () => number;
  /** WE gained the lease: start the authoritative sim. */
  onLease?: (lease: HostedLease) => void;
  /** Holder changed: re-point input/render (null = the server sims again). */
  onHostChange?: (newHostId: PlayerId | null, resumeTick: number) => void;
  /** OUR loop was revoked/deposed: halt the sim now. */
  onRevoked?: () => void;
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 64;
}

export class HostedClient {
  private readonly net: HostedNet;
  private readonly opts: HostedClientOpts;
  private readonly unsubscribe: () => void;

  private myId = '';
  private holder: PlayerId | null = null; // last host_change, null = server/unknown
  private lease: HostedLease | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(net: HostedNet, opts: HostedClientOpts = {}) {
    this.net = net;
    this.opts = opts;
    this.unsubscribe = net.addInternalListener((msg) => this.onMsg(msg));
  }

  /** Last known holder (null = server-authoritative or nothing heard yet). */
  get hostId(): PlayerId | null {
    return this.holder;
  }

  /** True while WE hold a live lease (our sim should be ticking). */
  get isHost(): boolean {
    return this.lease !== null;
  }

  /** Our live bearer id, or null. Never log this beyond debugging. */
  get leaseId(): string | null {
    return this.lease?.leaseId ?? null;
  }

  /** Idempotent: stop the renew loop, detach the listener, drop the lease. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopRenew();
    this.lease = null;
    this.unsubscribe();
  }

  // ---- internals ---------------------------------------------------------------

  private onMsg(msg: LobbyS2C & Record<string, unknown>): void {
    if (this.closed) return;
    switch (msg.t) {
      case 'welcome':
        if (isId(msg.playerId)) this.myId = msg.playerId;
        break;
      case 'host_lease':
        this.onLease(msg.leaseId, msg.hostId, msg.ttlMs);
        break;
      case 'host_change':
        this.onChange(msg.newHostId, msg.resumeTick);
        break;
      case 'host_revoked':
        this.onRevoke(msg.leaseId);
        break;
      default:
        break; // not lease traffic
    }
  }

  private onLease(leaseId: unknown, hostId: unknown, ttlMs: unknown): void {
    if (!isValidLeaseId(leaseId) || !isId(hostId)) return;
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 60000) return;
    if (hostId !== this.myId || this.myId === '') return; // not addressed to us: never adopt
    this.stopRenew();
    this.lease = { leaseId, ttlMs };
    this.holder = hostId;
    const every = Math.max(1, Math.floor(ttlMs / 2)); // renew at TTL/2, per the wire contract
    this.renewTimer = setInterval(() => this.renew(), every);
    try {
      this.opts.onLease?.({ leaseId, ttlMs });
    } catch {
      // consumer errors must not kill the renew loop
    }
  }

  private onChange(newHostId: unknown, resumeTick: unknown): void {
    if (!(newHostId === null || isId(newHostId))) return;
    if (typeof resumeTick !== 'number' || !Number.isFinite(resumeTick) || resumeTick < 0) return;
    this.holder = newHostId;
    if (this.lease !== null && newHostId !== this.myId) {
      // Deposed (or server took over): halt NOW, don't wait for the echo.
      this.dropLease();
      try {
        this.opts.onRevoked?.();
      } catch {
        // consumer errors must not break state convergence
      }
    }
    try {
      this.opts.onHostChange?.(newHostId, Math.trunc(resumeTick));
    } catch {
      // consumer errors must not break state convergence
    }
  }

  private onRevoke(leaseId: unknown): void {
    if (!isValidLeaseId(leaseId)) return;
    if (this.lease === null || leaseId !== this.lease.leaseId) return; // stale echo: ignore
    this.dropLease();
    try {
      this.opts.onRevoked?.();
    } catch {
      // consumer errors must not break state convergence
    }
  }

  private renew(): void {
    const lease = this.lease;
    if (lease === null || this.closed) return;
    let tick = 0;
    try {
      tick = this.opts.tickProvider?.() ?? 0;
    } catch {
      tick = 0; // a throwing provider must not stop renewals (0 is a valid tick)
    }
    if (typeof tick !== 'number' || !Number.isFinite(tick) || tick < 0) tick = 0;
    this.net.send({ t: 'host_renew', leaseId: lease.leaseId, tick: Math.trunc(Math.min(tick, 0xffffffff)) });
  }

  private dropLease(): void {
    this.stopRenew();
    this.lease = null;
  }

  private stopRenew(): void {
    if (this.renewTimer !== null) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }
}
