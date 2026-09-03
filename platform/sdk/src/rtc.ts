// ============================================================================
// RTC STAR (docs/PLATFORM.md §12.6 P2) — the P2P link layer. One RtcStar per
// client per room: the HOST accepts inbound DataChannels, each GUEST dials
// the host. All signaling (offer/answer/ICE) rides the platform's
// rtc_signal relay — after a channel opens, game data NEVER touches the
// server again.
//
// Role selection is deterministic and server-free: the lowest session id in
// the room hosts (rtc_peers gives everyone the same sorted list). No
// election messages exist to lose.
//
// RTCPeerConnection/RTCSessionDescription/RTCIceCandidate are injected so
// the whole layer is testable headless (see rtc.test.ts's MockRTC world).
// ============================================================================
import type { PlayerId } from '@platform/shared';
import { isRtcSignalPayload } from '@platform/shared';

/** The slice of the platform ws the star needs (SdkNet satisfies this). */
export interface SigChannel {
  sendSignal(to: PlayerId, data: unknown): void;
  onSignal: ((from: PlayerId, data: unknown) => void) | null;
  /** Room presence pushes ({t:'rtc_peers'}) from the lobby. */
  onPeers: ((ids: readonly PlayerId[]) => void) | null;
  close(): void;
}

/** Structural surface of RTCPeerConnection the star touches. */
export interface PcLike {
  createDataChannel(label: string): DcLike;
  setRemoteDescription(d: unknown): Promise<void>;
  setLocalDescription(d?: unknown): Promise<void>;
  createOffer(): Promise<{ type: string; sdp: string }>;
  createAnswer(): Promise<{ type: string; sdp: string }>;
  addIceCandidate(c: unknown): Promise<void>;
  onicecandidate: ((ev: { candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; toJSON(): unknown } | null }) => void) | null;
  ondatachannel: ((ev: { channel: DcLike }) => void) | null;
  close(): void;
}

export interface DcLike {
  readyState: 'connecting' | 'open' | 'closed';
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface RtcDeps {
  pc(): PcLike;
  desc(sdp: string, kind: 'offer' | 'answer'): unknown; // wrap into RTCSessionDescription
  cand(c: unknown): unknown; // candidate init relayed verbatim
}

/** One live DataChannel to a peer. */
export interface RtcLink {
  readonly peerId: PlayerId;
  onMessage: ((data: unknown) => void) | null;
  onClose: (() => void) | null;
  send(data: unknown): void;
  close(): void;
}

export interface RtcStarOpts {
  /** This session's id (from welcome). */
  readonly selfId: PlayerId;
  /** Injectable RTC primitives (tests supply MockRTC). */
  readonly deps: RtcDeps;
  /** Called when a link closes — the star does not re-dial (pilot v1). */
  readonly onPeerLoss?: (peerId: PlayerId) => void;
}

export class RtcStar {
  /** Deterministic host check from a rtc_peers list. */
  static isHost(selfId: PlayerId, ids: readonly PlayerId[]): boolean {
    return ids.length > 0 && ids[0] === selfId;
  }

  readonly peerId: PlayerId;
  private readonly sig: SigChannel;
  private readonly deps: RtcDeps;
  private readonly onPeerLoss: ((peerId: PlayerId) => void) | undefined;
  /** peerId → established or negotiating link state. */
  private readonly links = new Map<
    PlayerId,
    { pc: PcLike; dc: DcLike | null; link: RtcLink | null }
  >();
  private closed = false;

  constructor(sig: SigChannel, opts: RtcStarOpts) {
    this.sig = sig;
    this.peerId = opts.selfId;
    this.deps = opts.deps;
    this.onPeerLoss = opts.onPeerLoss;
    sig.onSignal = (from, data) => this.onSignal(from, data);
  }

  /** Established links (host: guests; guest: the single host link). */
  established(): PlayerId[] {
    return [...this.links.entries()].filter(([, l]) => l.link !== null).map(([id]) => id);
  }

  link(peerId: PlayerId): RtcLink | null {
    return this.links.get(peerId)?.link ?? null;
  }

  /** Send to one peer (no-op without an open link). */
  send(peerId: PlayerId, data: unknown): void {
    this.links.get(peerId)?.link?.send(data);
  }

  /** Send to every established link. */
  broadcast(data: unknown): void {
    for (const l of this.links.values()) l.link?.send(data);
  }

  /**
   * GUEST side: dial a specific peer (the host). Host side never dials —
   * inbound offers arrive via onSignal.
   */
  dial(peerId: PlayerId): void {
    if (this.closed || this.links.has(peerId)) return;
    try {
      const pc = this.deps.pc();
      const state = { pc, dc: null as DcLike | null, link: null as RtcLink | null };
      this.links.set(peerId, state);
      const dc = pc.createDataChannel('game');
      state.dc = dc;
      this.wireDc(peerId, dc, state);
      this.wireIce(peerId, pc);
      void (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          this.sig.sendSignal(peerId, { v: 1, kind: 'offer', sdp: offer.sdp });
        } catch {
          this.drop(peerId); // negotiation failed — pilot v1: drop silently
        }
      })();
    } catch (err) {
      this.drop(peerId);
    }
  }

  /**
   * Forget one peer (dead link cleanup so a later dial() recreates it).
   * Safe to call for unknown ids.
   */
  dropPeer(peerId: PlayerId): void {
    this.drop(peerId);
  }

  /** Leave the room's P2P plane; closes every pc. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sig.onSignal = null;
    for (const [id] of this.links) this.drop(id);
  }

  // ---- internals ------------------------------------------------------------

  private onSignal(from: PlayerId, data: unknown): void {
    if (this.closed || !isRtcSignalPayload(data)) {
      console.log('[rtc-debug] star drop', this.closed, JSON.stringify(data)?.slice(0, 40));
      return;
    }

    switch (data.kind) {
      case 'offer':
        void this.acceptOffer(from, data.sdp);
        return;
      case 'answer':
        void this.links.get(from)?.pc.setRemoteDescription(this.deps.desc(data.sdp, 'answer'));
        return;
      case 'ice': {
        const remote = this.links.get(from)?.pc;
        if (remote === undefined) return;
        remote.addIceCandidate(this.deps.cand(data.cand)).catch(() => {
          // late/stray candidates after close are routine — ignore
        });
        return;
      }
    }
  }

  private async acceptOffer(from: PlayerId, sdp: string): Promise<void> {
    if (this.closed || this.links.has(from)) return; // one link per peer
    let pc: PcLike;
    try {
      pc = this.deps.pc();
    } catch (err) {
      console.error('[rtc] host pc factory failed', err);
      return;
    }
    const state = { pc, dc: null as DcLike | null, link: null as RtcLink | null };
    this.links.set(from, state);
    pc.ondatachannel = (ev) => {
      state.dc = ev.channel;
      this.wireDc(from, ev.channel, state);
    };
    this.wireIce(from, pc);
    try {
      await pc.setRemoteDescription(this.deps.desc(sdp, 'offer'));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.sig.sendSignal(from, { v: 1, kind: 'answer', sdp: answer.sdp });
    } catch (err) {
      this.drop(from);
    }
  }

  /** Trickle-ICE relay: every local candidate rides rtc_signal to the peer. */
  private wireIce(peerId: PlayerId, pc: PcLike): void {
    pc.onicecandidate = (ev) => {
      if (ev.candidate === null || this.closed) return;
      // Full candidate init — addIceCandidate needs sdpMid/sdpMLineIndex.
      this.sig.sendSignal(peerId, { v: 1, kind: 'ice', cand: ev.candidate.toJSON() });
    };
  }

  private wireDc(peerId: PlayerId, dc: DcLike, state: { link: RtcLink | null }): void {
    dc.onopen = () => {
      const link: RtcLink = {
        peerId,
        onMessage: null,
        onClose: null,
        send: (data) => {
          if (dc.readyState === 'open') {
            try {
              dc.send(JSON.stringify(data));
            } catch {
              // racing a close — drop
            }
          }
        },
        close: () => dc.close(),
      };
      state.link = link;
    };
    dc.onmessage = (ev) => {
      try {
        const parsed: unknown = JSON.parse(ev.data);
        state.link?.onMessage?.(parsed);
      } catch {
        // malformed frame: drop, never throw
      }
    };
    dc.onclose = () => {
      const link = state.link;
      state.link = null;
      if (link !== null) link.onClose?.();
      this.onPeerLoss?.(peerId);
    };
  }

  private drop(peerId: PlayerId): void {
    const state = this.links.get(peerId);
    if (state === undefined) return;
    this.links.delete(peerId);
    try {
      state.pc.close();
    } catch {
      // already closed
    }
    state.link?.onClose?.();
  }
}
