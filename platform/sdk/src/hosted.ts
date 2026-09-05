// ============================================================================
// HOSTED LOBBY (docs/PLATFORM.md §12.6) — the reusable host-tab runtime.
// BankP2pLobby proved the pattern; this is the game-agnostic extraction so
// the NEXT hosted game wires ~20 lines instead of ~200.
//
// One instance lives in the HOST tab. It owns exactly one game room and a
// set of sinks (the host's loopback + one DataChannel sink per guest):
//
//   attach(id, sink)            — plug a seat's transport in
//   detach(id)                  — unplug (ghost: the room keeps the seat)
//   sync(id)                    — replay the last snapshot (join/attach race)
//   handleFrame(id, jsonString) — route one client frame: create_*,
//                                 join_private, ping, leave, or room-level
//
// The GAME supplies three things: how to build its room, where new-room
// codes come from, and (optionally) which message tag carries snapshots.
// ============================================================================
import type { GameRoomHandle, PlayerId, RoomIO, Visibility } from '@platform/shared';
import { CLAIM_ALPHABET, rng } from '@platform/shared';

export interface HostedSink {
  deliver(data: string): void;
}

export interface HostedLobbyOpts {
  /** Build the game's room (e.g. `io => new BankRoom('private', io, settings)`). */
  createRoom: (io: RoomIO, settings: Record<string, unknown>) => GameRoomHandle;
  /** Joinable code for a fresh room (shell code, local mint, …). */
  newRoomCode: () => string;
  /**
   * Snapshot message tag whose payload is cached + code-rewritten, e.g.
   * 'bank_state'. Omit when the game has no snapshot/code concept.
   */
  snapshotTag?: string;
}

/** 6-char unambiguous code (same alphabet as claim codes). */
export function mintRoomCode(): string {
  const next = rng((((Date.now() ^ Math.floor(performance.now())) >>> 0) || 1) >>> 0);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += CLAIM_ALPHABET[Math.floor(next() * CLAIM_ALPHABET.length)];
  }
  return out;
}

export class HostedLobby {
  private readonly sinks = new Map<PlayerId, HostedSink>();
  private room: GameRoomHandle | null = null;
  private code: string | null = null;
  private lastSnapshot: string | null = null;
  private readonly io: RoomIO;

  constructor(private readonly opts: HostedLobbyOpts) {
    const self = this;
    this.io = {
      send: (id, msg) => {
        let json = JSON.stringify(msg);
        if (
          self.opts.snapshotTag !== undefined &&
          typeof msg === 'object' && msg !== null &&
          (msg as { t?: string }).t === self.opts.snapshotTag
        ) {
          const rewritten = { ...(msg as Record<string, unknown>), code: self.code };
          json = JSON.stringify(rewritten);
          self.lastSnapshot = json;
        }
        self.sinks.get(id)?.deliver(json);
      },
      rttMs: () => 0,
    };
  }

  attach(id: PlayerId, sink: HostedSink): void {
    this.sinks.set(id, sink);
  }

  has(id: PlayerId): boolean {
    return this.sinks.has(id);
  }

  detach(id: PlayerId): void {
    this.sinks.delete(id);
    // Ghost, don't purge: the room keeps seat + score so a reconnect
    // re-binds in place (same session id).
    this.room?.removePlayer(id);
  }

  get joinCode(): string | null {
    return this.code;
  }

  /** Seat/snapshot counts for diagnostics. */
  debugRoom(): { members: number; hasRoom: boolean } {
    return { members: this.sinks.size, hasRoom: this.room !== null };
  }

  /** Frames seen, newest last (diagnostics for e2e + `__p2pDbg`). */
  readonly debugFrames: string[] = [];

  /** Re-send the current snapshot to a just-attached sink (join/attach race). */
  sync(id: PlayerId): void {
    const sink = this.sinks.get(id);
    if (sink !== undefined && this.lastSnapshot !== null) {
      sink.deliver(this.lastSnapshot);
    }
  }

  /** Route one raw client frame from a seat (local loopback or guest DC). */
  handleFrame(id: PlayerId, data: string): void {
    this.debugFrames.push(id + ':' + data.slice(0, 60));
    if (this.debugFrames.length > 20) this.debugFrames.shift();
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const m = parsed as Record<string, unknown>;
    switch (m.t) {
      case 'create_private':
      case 'create_public':
      case 'quick_join': {
        if (this.room !== null) {
          this.room.addPlayer(id, String(m.name ?? 'Player'));
          return;
        }
        const settings = (typeof m.settings === 'object' && m.settings !== null
          ? (m.settings as Record<string, unknown>)
          : {});
        const room = this.opts.createRoom(this.io, settings);
        this.room = room;
        this.code = this.opts.newRoomCode();
        this.room.addPlayer(id, String(m.name ?? 'Player'));
        return;
      }
      case 'join_private': {
        const room = this.room;
        if (room === null || m.code !== this.code) {
          this.sinks.get(id)?.deliver(JSON.stringify({ t: 'error', code: 'no_room', message: 'no such hosted game' }));
          return;
        }
        room.addPlayer(id, String(m.name ?? 'Player'));
        return;
      }
      case 'ping':
        this.sinks.get(id)?.deliver(JSON.stringify({ t: 'pong', ts: m.ts, serverTime: Date.now() }));
        return;
      case 'leave':
        this.detach(id);
        return;
      default:
        this.room?.handleMessage(id, parsed);
    }
  }
}
