// ============================================================================
// RtcStar tests — headless via a MockRTC world: two stars negotiate through
// a direct-relay SigChannel (standing in for the platform rtc_signal hop),
// MockPCs exchange offer/answer synchronously, and paired MockDCs pipe
// JSON both ways. Proves the handshake, data plane, and teardown semantics
// without a browser.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { RtcStar } from './rtc.js';
import type { DcLike, PcLike, RtcDeps, SigChannel } from './rtc.js';

// ---- mock world -------------------------------------------------------------

export class MockDc implements DcLike {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  peer: MockDc | null = null;

  send(data: string): void {
    if (this.readyState !== 'open' || this.peer === null) return;
    this.peer.onmessage?.({ data });
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.peer?.close();
    this.onclose?.();
  }

  /** Test hook: flip both ends open. */
  static openPair(a: MockDc, b: MockDc): void {
    a.peer = b;
    b.peer = a;
    a.readyState = 'open';
    b.readyState = 'open';
    a.onopen?.();
    b.onopen?.();
  }
}

export class MockPc implements PcLike {
  readonly world: MockWorld;
  readonly who: 'a' | 'b';
  localDesc: unknown = null;
  remoteDesc: unknown = null;
  createdDc: MockDc | null = null;
  inboundDc: MockDc | null = null;
  onicecandidate: ((ev: { candidate: { candidate: string } | null }) => void) | null = null;
  ondatachannel: ((ev: { channel: DcLike }) => void) | null = null;
  closed = false;

  constructor(world: MockWorld, who: 'a' | 'b') {
    this.world = world;
    this.who = who;
  }

  createDataChannel(_label: string): DcLike {
    this.createdDc = new MockDc();
    this.world.offererDc = this.createdDc;
    return this.createdDc;
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: `offer-from-${this.who}` };
  }

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: 'answer', sdp: `answer-from-${this.who}` };
  }

  async setRemoteDescription(d: unknown): Promise<void> {
    this.remoteDesc = d;
    // WebRTC semantics: the guest applying the remote ANSWER is the moment
    // both data channels go live. The mock opens the pair right here.
    const sdp = (d as { sdp?: string }).sdp ?? '';
    if (sdp.startsWith('answer-from')) {
      this.world.answerApplied = true;
      this.world.tryOpen();
    }
  }

  async setLocalDescription(d?: unknown): Promise<void> {
    this.localDesc = d ?? null;
  }

  async addIceCandidate(_c: unknown): Promise<void> {
    // recorded implicitly via remoteDesc flow; nothing to do
  }

  close(): void {
    this.closed = true;
    this.createdDc?.close();
    this.inboundDc?.close();
  }

  /** Test hook: host side fires ondatachannel when the offer is applied. */
  deliverInboundDc(): void {
    this.inboundDc = new MockDc();
    this.ondatachannel?.({ channel: this.inboundDc });
    this.world.tryOpen(); // channel may open the moment the host side exists
  }
}

export class MockWorld {
  /** Real-WebRTC opening discipline: the channel goes live only when the
   *  answer has been applied AND the host side has its inbound channel. */
  answerApplied = false;
  tryOpen(): void {
    if (this.answerApplied && this.offererDc !== null && this.pcs[1]?.inboundDc != null) {
      MockDc.openPair(this.offererDc, this.pcs[1].inboundDc);
    }
  }
  offererDc: MockDc | null = null;
  /** Creation order: [0] = guest dial pc, [1] = host accept pc. */
  readonly pcs: MockPc[] = [];

  pc(): PcLike {
    const pc = new MockPc(this, this.pcs.length % 2 === 0 ? 'a' : 'b');
    this.pcs.push(pc);
    return pc;
  }
}

interface SigEnd {
  channel: SigChannel;
  deliver(from: string, data: unknown): void;
}

/** Two directly-wired signaling ends (the rtc_signal relay, mocked). */
export function sigPair(idA: string, idB: string): [SigEnd, SigEnd] {
  const mk = (): SigEnd => {
    const end: SigEnd = {
      channel: {
        sendSignal: () => {},
        onSignal: null,
        onPeers: null,
        close: () => {},
      },
      deliver: () => {},
    };
    return end;
  };
  const a = mk();
  const b = mk();
  // Two-party world: the relay always reaches the other end (it is the
  // platform's same-room guarantee, mocked).
  a.channel.sendSignal = (to, data) => {
    if (to === idB) b.channel.onSignal?.(idA, data);
  };
  b.channel.sendSignal = (to, data) => {
    if (to === idA) a.channel.onSignal?.(idB, data);
  };
  a.deliver = (from, data) => a.channel.onSignal?.(from, data);
  b.deliver = (from, data) => b.channel.onSignal?.(from, data);
  return [a, b];
}

export function deps(world: MockWorld): RtcDeps {
  return {
    pc: () => world.pc(),
    desc: (sdp: string) => ({ sdp }),
    cand: (c: string) => ({ candidate: c }),
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---- tests --------------------------------------------------------------------

describe('RtcStar (mock RTC world)', () => {
  it('guest dials, host accepts, link opens on both sides', async () => {
    const world = new MockWorld();
    const [sigA, sigB] = sigPair('aaa1-guest', 'bbb1-host'); // a = guest 'aaa1', b = host 'bbb1'
    const guest = new RtcStar(sigA.channel, { selfId: 'aaa1-guest', deps: deps(world) });
    const host = new RtcStar(sigB.channel, { selfId: 'bbb1-host', deps: deps(world) });

    guest.dial('bbb1-host');
    await flush(); // offer travels, host applies + answers
    expect(host.link('aaa1-guest')).toBeNull(); // not open until dc handshake
    world.pcs[1]!.deliverInboundDc();
    await flush(); // answer travels, guest applies → pair opens

    expect(guest.established()).toEqual(['bbb1-host']);
    expect(host.established()).toEqual(['aaa1-guest']);
  });

  it('data flows both ways over the established link', async () => {
    const world = new MockWorld();
    const [sigA, sigB] = sigPair('aaa1-guest', 'bbb1-host');
    const guest = new RtcStar(sigA.channel, { selfId: 'aaa1-guest', deps: deps(world) });
    const host = new RtcStar(sigB.channel, { selfId: 'bbb1-host', deps: deps(world) });
    guest.dial('bbb1-host');
    await flush();
    world.pcs[1]!.deliverInboundDc();
    await flush();

    const atHost: unknown[] = [];
    const atGuest: unknown[] = [];
    host.link('aaa1-guest')!.onMessage = (d) => atHost.push(d);
    guest.link('bbb1-host')!.onMessage = (d) => atGuest.push(d);

    guest.send('bbb1-host', { t: 'input', seq: 1 });
    host.broadcast({ t: 'snap', tick: 7 });
    expect(atHost).toEqual([{ t: 'input', seq: 1 }]);
    expect(atGuest).toEqual([{ t: 'snap', tick: 7 }]);
  });

  it('isHost is the lowest-id rule', () => {
    expect(RtcStar.isHost('a1', ['a1', 'b2', 'c3'])).toBe(true);
    expect(RtcStar.isHost('b2', ['a1', 'b2', 'c3'])).toBe(false);
    expect(RtcStar.isHost('a1', [])).toBe(false);
  });

  it('close() tears down every pc and silences signaling', async () => {
    const world = new MockWorld();
    const [sigA, sigB] = sigPair('aaa1-guest', 'bbb1-host');
    const guest = new RtcStar(sigA.channel, { selfId: 'aaa1-guest', deps: deps(world) });
    const host = new RtcStar(sigB.channel, { selfId: 'bbb1-host', deps: deps(world) });
    guest.dial('bbb1-host');
    await flush();
    world.pcs[1]!.deliverInboundDc();
    await flush();
    const guestPc = world.pcs[0]!;

    guest.close();
    expect(guestPc.closed).toBe(true); // the closing star tears down its own pc
    // signaling dead: a further offer from the closed star does nothing
    const before = host.established().length;
    sigA.channel.sendSignal?.('bbb1-host', { v: 1, kind: 'offer', sdp: 'zombie' });
    expect(host.established().length).toBe(before);
  });

  it('drops silently on failed negotiation (no throw to the caller)', async () => {
    const world = new MockWorld();
    const [sigA, sigB] = sigPair('aaa1-guest', 'bbb1-host');
    const guest = new RtcStar(sigA.channel, {
      selfId: 'aaa1-guest',
      deps: {
        ...deps(world),
        pc: () => {
          throw new Error('no rtc support');
        },
      },
    });
    expect(() => guest.dial('bbb1-host')).not.toThrow();
  });
});
