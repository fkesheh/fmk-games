// ============================================================================
// cl-net — Net: the WebSocket connection, app-level ping/RTT + clock offset,
// snapshot interpolation for survivors AND zombies, and client-side prediction,
// folded into one class per CONTRACT.md's `net.ts` shape.
//
// Ports STRICKEN's proven trio (games/fps/client/src/net/connection.ts +
// interpolation.ts + prediction.ts), keeping their discipline: no automatic
// reconnect, min-RTT clock offset, shortest-arc yaw lerp, extrapolation capped
// at NETCODE.interpMaxExtrapolateMs, teleport SNAP (never slide) over 10 m,
// fully pooled per-id output objects, copyWithin-free (splice-free) prediction
// replay via a length-truncating `pending` array.
//
// OUTPOST differences from STRICKEN's trio:
//   - ZOMBIES interpolate exactly like survivors: their own pooled ring buffer,
//     same presence rule (appear the instant they're in only the newer
//     bracket), same teleport-snap threshold.
//   - NETCODE.interpDelayMs is 150, not STRICKEN's 120 — snapshots arrive at
//     15 Hz (NETCODE.snapshotEveryTicks = 2 of a 30 Hz sim) and the delay must
//     clear one 66.7 ms snapshot interval with margin or remote entities
//     stutter between brackets.
//   - Lobby joins go through the platform envelope: quickJoin/createPublic/
//     createPrivate/joinPrivate all stamp @platform/shared identity — `sig`
//     always, `resume` only when a stored session exists — via a private
//     withIdentity(), mirroring games/fps/client/src/game/clientGame.ts's
//     helper of the same name (that one is local to clientGame.ts, not an
//     exported utility, so it is reimplemented here against OUTPOST's own
//     session key, `GAME_ID` = 'outpost'). Net owns the full identity
//     lifecycle end to end — stamp on join, `saveSession` on `joined`,
//     `clearSession` on `leave()` — because unlike STRICKEN's bare Connection,
//     this Net already exposes the high-level join methods themselves.
//   - The prediction solids array is STATIC_SOLIDS plus every currently-INTACT
//     fence segment's AABB (`segmentAABB`), kept in sync with each snapshot's
//     `segments[].br` and rebuilt only on the rare tick a segment's breached
//     state actually flips — so local movement prediction collides with the
//     fence the same way the server does, without allocating every snapshot.
//
// Zero per-frame allocation: every pushed snapshot is retained by reference;
// every sampled output object is pooled per id and mutated in place; the
// two reused `out` arrays are truncated (`length = 0`), never reallocated.
// ============================================================================
import { PLAYER, makeBody, stepBody } from '@fps/shared';
import type { AABB, BodyState, MoveInput, WeaponId } from '@fps/shared';
import {
  GAME_ID,
  NETCODE,
  SEGMENTS,
  STATIC_SOLIDS,
  SURVIVOR,
  TICK_DT,
  WEAPONS,
  segmentAABB,
} from '@outpost/shared';

/** This port's registry id — rooms are served by the outpost-sdk variant. */
const PORT_GAME_ID = 'outpost-sdk';
import type {
  C2S,
  JoinedMsg,
  OutpostEvent,
  PredictorApi,
  SegmentSnap,
  SnapshotMsg,
  SurvivorSnap,
  ZombieId,
  ZombieSnap,
} from '@outpost/shared';

/** This port's registry id — rooms are served by the outpost-sdk variant. */
import { clearSession, loadSession, loadSig, saveSession } from '@platform/shared';
import type { LobbyC2S, PlayerId, RoomInfo } from '@platform/shared';

// ---- tuning (frozen by CONTRACT.md / this module's spec) --------------------
const PING_EMA_ALPHA = 0.2;
const MAX_AGE_MS = 1000; // keep ~1s of snapshot history per interpolated stream
const TELEPORT_SQ = 10 * 10; // m² — remote-entity jumps beyond this snap, never lerp
const TWO_PI = Math.PI * 2;
const LIST_ROOMS_TIMEOUT_MS = 4000;
const SEND_QUEUE_CAP = 32; // outbound frames queued while the socket is CONNECTING
const RECONCILE_TELEPORT_M = 2; // local-player snap threshold for prediction rebase
const PENDING_CAP = 120; // ~4s of unacked inputs at 30Hz; oldest dropped beyond this

/** Shortest-arc lerp for wrapped radians. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

// ---------------------------------------------------------------------------
// Wire union this module actually receives: OUTPOST's own S2C plus the
// platform lobby's S2C (welcome / room_list — 'pong' and 'error' are
// structurally identical between the two and only declared once here).
// Neither barrel exports a combined type, so it is assembled locally.
// ---------------------------------------------------------------------------
type AnyS2C =
  | { t: 'welcome'; playerId: PlayerId }
  | { t: 'room_list'; rooms: RoomInfo[] }
  | { t: 'pong'; ts: number; serverTime: number }
  | { t: 'error'; code: string; message: string }
  | JoinedMsg
  | SnapshotMsg
  | { t: 'event'; ev: OutpostEvent };

function isAnyS2C(v: unknown): v is AnyS2C {
  return typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string';
}

// ---------------------------------------------------------------------------
// Prediction — wraps @fps/shared stepBody exactly as STRICKEN's Predictor.
// PredictorApi is frozen in shared/src/types.ts; this is its sole implementer.
// ---------------------------------------------------------------------------
interface PendingInput {
  seq: number;
  input: MoveInput;
}

class PredictorImpl implements PredictorApi {
  private readonly b: BodyState = makeBody(0, 0, 0);
  private readonly pending: PendingInput[] = []; // seq-ordered ascending

  /** Shared reference with Net — Net mutates this array's contents as fence
   *  segments breach/rebuild; the predictor only ever reads it. */
  constructor(private readonly solids: AABB[]) {}

  reset(x: number, y: number, z: number): void {
    const b = this.b;
    b.x = x;
    b.y = y;
    b.z = z;
    b.vx = 0;
    b.vy = 0;
    b.vz = 0;
    b.height = PLAYER.heightStand;
    b.onGround = true;
    this.pending.length = 0;
  }

  pushInput(seq: number, input: MoveInput, speedMul: number): void {
    if (this.pending.length >= PENDING_CAP) this.pending.shift();
    this.pending.push({ seq, input });
    stepBody(this.b, input, speedMul, TICK_DT, this.solids);
  }

  /**
   * Authoritative correction: adopt server state, then replay unacked inputs.
   * onGround is derived from vy plus previous vertical motion — the server
   * zeroes vy exactly on land, but also on a mid-air head-bonk without
   * setting onGround — so vy === 0 alone is not proof of grounded. Mirrors
   * STRICKEN's Predictor.reconcile exactly.
   */
  reconcile(
    x: number,
    y: number,
    z: number,
    height: number,
    vy: number,
    ackSeq: number,
    speedMul: number,
  ): void {
    const b = this.b;
    const prevVy = b.vy;
    const prevOnGround = b.onGround;
    b.x = x;
    b.y = y;
    b.z = z;
    b.vx = 0; // stepBody re-derives horizontal velocity from each replayed input
    b.vz = 0;
    b.vy = vy;
    b.height = height;
    b.onGround = vy === 0 && (prevVy <= 0 || prevOnGround);
    let acked = 0;
    while (acked < this.pending.length) {
      const p = this.pending[acked];
      if (p === undefined || p.seq > ackSeq) break;
      acked++;
    }
    if (acked > 0) {
      this.pending.copyWithin(0, acked);
      this.pending.length -= acked;
    }
    for (const p of this.pending) stepBody(b, p.input, speedMul, TICK_DT, this.solids);
  }

  body(): BodyState {
    return this.b;
  }
}

// ---------------------------------------------------------------------------
// Survivor interpolation — mirrors STRICKEN's InterpBuffer<PlayerSnap>, typed
// to SurvivorSnap's wider field set.
// ---------------------------------------------------------------------------
interface SurvSnap {
  time: number;
  players: SurvivorSnap[];
}

class SurvivorInterp {
  private readonly snaps: SurvSnap[] = [];
  private readonly out: SurvivorSnap[] = [];
  private readonly pool = new Map<PlayerId, SurvivorSnap>();

  reset(): void {
    this.snaps.length = 0;
    this.out.length = 0;
    this.pool.clear();
  }

  push(serverTimeMs: number, players: SurvivorSnap[]): void {
    if (!Number.isFinite(serverTimeMs)) return;
    const snaps = this.snaps;
    const last = snaps[snaps.length - 1];
    if (last === undefined || serverTimeMs > last.time) {
      snaps.push({ time: serverTimeMs, players });
    } else if (serverTimeMs === last.time) {
      last.players = players;
    } else {
      let i = snaps.length - 1;
      while (i > 0) {
        const s = snaps[i - 1];
        if (s === undefined || s.time <= serverTimeMs) break;
        i--;
      }
      const existing = snaps[i];
      if (existing !== undefined && existing.time === serverTimeMs) existing.players = players;
      else snaps.splice(i, 0, { time: serverTimeMs, players });
    }
    const newest = snaps[snaps.length - 1];
    if (newest !== undefined) {
      while (snaps.length > 2) {
        const second = snaps[1];
        if (second === undefined || second.time > newest.time - MAX_AGE_MS) break;
        snaps.shift();
      }
    }
  }

  sample(renderServerTime: number): SurvivorSnap[] {
    const out = this.out;
    out.length = 0;
    const snaps = this.snaps;
    const n = snaps.length;
    if (n === 0) return out;
    let lo = -1;
    for (let i = n - 1; i >= 0; i--) {
      const s = snaps[i];
      if (s !== undefined && s.time <= renderServerTime) {
        lo = i;
        break;
      }
    }
    if (lo < 0) {
      const oldest = snaps[0];
      if (oldest !== undefined) this.emitCopy(oldest);
      return out;
    }
    const a = snaps[lo];
    if (a === undefined) return out;
    const b = snaps[lo + 1];
    if (b === undefined) {
      this.emitExtrapolate(a, snaps[lo - 1], renderServerTime);
      return out;
    }
    this.emitLerp(a, b, renderServerTime);
    return out;
  }

  private write(
    id: PlayerId,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    src: SurvivorSnap,
  ): void {
    let p = this.pool.get(id);
    if (p === undefined) {
      p = {
        id, n: '', x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
        hp: 0, st: 'alive', cr: false, mv: false, w: 'knife' as WeaponId,
        rev: 0, revBy: null, bl: 0, k: 0, rv: 0,
      };
      this.pool.set(id, p);
    }
    p.x = x;
    p.y = y;
    p.z = z;
    p.yaw = yaw;
    p.pitch = pitch;
    p.n = src.n;
    p.hp = src.hp;
    p.st = src.st;
    p.cr = src.cr;
    p.mv = src.mv;
    p.w = src.w;
    p.rev = src.rev;
    p.revBy = src.revBy;
    p.bl = src.bl;
    p.k = src.k;
    p.rv = src.rv;
    this.out.push(p);
  }

  private emitCopy(s: SurvSnap): void {
    for (const pl of s.players) this.write(pl.id, pl.x, pl.y, pl.z, pl.yaw, pl.pitch, pl);
  }

  private emitLerp(a: SurvSnap, b: SurvSnap, renderTime: number): void {
    const span = b.time - a.time;
    const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.time) / span)) : 1;
    for (const pb of b.players) {
      let pa: SurvivorSnap | undefined;
      for (const q of a.players) {
        if (q.id === pb.id) {
          pa = q;
          break;
        }
      }
      if (pa === undefined) {
        this.write(pb.id, pb.x, pb.y, pb.z, pb.yaw, pb.pitch, pb); // new player: appear at once
        continue;
      }
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const dz = pb.z - pa.z;
      if (dx * dx + dy * dy + dz * dz > TELEPORT_SQ) {
        this.write(pb.id, pb.x, pb.y, pb.z, pb.yaw, pb.pitch, pb); // teleport: snap
        continue;
      }
      this.write(
        pb.id,
        pa.x + dx * t,
        pa.y + dy * t,
        pa.z + dz * t,
        lerpAngle(pa.yaw, pb.yaw, t),
        pa.pitch + (pb.pitch - pa.pitch) * t,
        pb, // discrete fields from the newer snapshot
      );
    }
  }

  private emitExtrapolate(latest: SurvSnap, prev: SurvSnap | undefined, renderTime: number): void {
    const dtMs = Math.min(NETCODE.interpMaxExtrapolateMs, Math.max(0, renderTime - latest.time));
    const span = prev !== undefined ? latest.time - prev.time : 0;
    const k = dtMs > 0 && span > 0 ? dtMs / span : 0;
    for (const pl of latest.players) {
      let pp: SurvivorSnap | undefined;
      if (k > 0 && prev !== undefined) {
        for (const q of prev.players) {
          if (q.id === pl.id) {
            pp = q;
            break;
          }
        }
      }
      if (pp === undefined) {
        this.write(pl.id, pl.x, pl.y, pl.z, pl.yaw, pl.pitch, pl);
        continue;
      }
      const dx = pl.x - pp.x;
      const dy = pl.y - pp.y;
      const dz = pl.z - pp.z;
      if (dx * dx + dy * dy + dz * dz > TELEPORT_SQ) {
        this.write(pl.id, pl.x, pl.y, pl.z, pl.yaw, pl.pitch, pl); // teleport: no extrapolation
        continue;
      }
      this.write(pl.id, pl.x + dx * k, pl.y + dy * k, pl.z + dz * k, pl.yaw, pl.pitch, pl);
    }
  }
}

// ---------------------------------------------------------------------------
// Zombie interpolation — same discipline as SurvivorInterp, OUTPOST's own
// addition. A zombie present in only the newer bracket appears immediately,
// same as a survivor; no pitch (zombies have none on the wire).
// ---------------------------------------------------------------------------
interface ZombSnap {
  time: number;
  zombies: ZombieSnap[];
}

class ZombieInterp {
  private readonly snaps: ZombSnap[] = [];
  private readonly out: ZombieSnap[] = [];
  private readonly pool = new Map<ZombieId, ZombieSnap>();

  reset(): void {
    this.snaps.length = 0;
    this.out.length = 0;
    this.pool.clear();
  }

  push(serverTimeMs: number, zombies: ZombieSnap[]): void {
    if (!Number.isFinite(serverTimeMs)) return;
    const snaps = this.snaps;
    const last = snaps[snaps.length - 1];
    if (last === undefined || serverTimeMs > last.time) {
      snaps.push({ time: serverTimeMs, zombies });
    } else if (serverTimeMs === last.time) {
      last.zombies = zombies;
    } else {
      let i = snaps.length - 1;
      while (i > 0) {
        const s = snaps[i - 1];
        if (s === undefined || s.time <= serverTimeMs) break;
        i--;
      }
      const existing = snaps[i];
      if (existing !== undefined && existing.time === serverTimeMs) existing.zombies = zombies;
      else snaps.splice(i, 0, { time: serverTimeMs, zombies });
    }
    const newest = snaps[snaps.length - 1];
    if (newest !== undefined) {
      while (snaps.length > 2) {
        const second = snaps[1];
        if (second === undefined || second.time > newest.time - MAX_AGE_MS) break;
        snaps.shift();
      }
    }
  }

  sample(renderServerTime: number): ZombieSnap[] {
    const out = this.out;
    out.length = 0;
    const snaps = this.snaps;
    const n = snaps.length;
    if (n === 0) return out;
    let lo = -1;
    for (let i = n - 1; i >= 0; i--) {
      const s = snaps[i];
      if (s !== undefined && s.time <= renderServerTime) {
        lo = i;
        break;
      }
    }
    if (lo < 0) {
      const oldest = snaps[0];
      if (oldest !== undefined) this.emitCopy(oldest);
      return out;
    }
    const a = snaps[lo];
    if (a === undefined) return out;
    const b = snaps[lo + 1];
    if (b === undefined) {
      this.emitExtrapolate(a, snaps[lo - 1], renderServerTime);
      return out;
    }
    this.emitLerp(a, b, renderServerTime);
    return out;
  }

  private write(id: ZombieId, x: number, y: number, z: number, yaw: number, src: ZombieSnap): void {
    let p = this.pool.get(id);
    if (p === undefined) {
      p = { id, k: src.k, x: 0, y: 0, z: 0, yaw: 0, hp: 0, st: src.st, g: 0 };
      this.pool.set(id, p);
    }
    p.x = x;
    p.y = y;
    p.z = z;
    p.yaw = yaw;
    p.k = src.k;
    p.hp = src.hp;
    p.st = src.st;
    p.g = src.g;
    this.out.push(p);
  }

  private emitCopy(s: ZombSnap): void {
    for (const zl of s.zombies) this.write(zl.id, zl.x, zl.y, zl.z, zl.yaw, zl);
  }

  private emitLerp(a: ZombSnap, b: ZombSnap, renderTime: number): void {
    const span = b.time - a.time;
    const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.time) / span)) : 1;
    for (const zb of b.zombies) {
      let za: ZombieSnap | undefined;
      for (const q of a.zombies) {
        if (q.id === zb.id) {
          za = q;
          break;
        }
      }
      if (za === undefined) {
        this.write(zb.id, zb.x, zb.y, zb.z, zb.yaw, zb); // newly present: appear at once
        continue;
      }
      const dx = zb.x - za.x;
      const dy = zb.y - za.y;
      const dz = zb.z - za.z;
      if (dx * dx + dy * dy + dz * dz > TELEPORT_SQ) {
        this.write(zb.id, zb.x, zb.y, zb.z, zb.yaw, zb); // teleport: snap
        continue;
      }
      this.write(zb.id, za.x + dx * t, za.y + dy * t, za.z + dz * t, lerpAngle(za.yaw, zb.yaw, t), zb);
    }
  }

  private emitExtrapolate(latest: ZombSnap, prev: ZombSnap | undefined, renderTime: number): void {
    const dtMs = Math.min(NETCODE.interpMaxExtrapolateMs, Math.max(0, renderTime - latest.time));
    const span = prev !== undefined ? latest.time - prev.time : 0;
    const k = dtMs > 0 && span > 0 ? dtMs / span : 0;
    for (const zl of latest.zombies) {
      let zp: ZombieSnap | undefined;
      if (k > 0 && prev !== undefined) {
        for (const q of prev.zombies) {
          if (q.id === zl.id) {
            zp = q;
            break;
          }
        }
      }
      if (zp === undefined) {
        this.write(zl.id, zl.x, zl.y, zl.z, zl.yaw, zl);
        continue;
      }
      const dx = zl.x - zp.x;
      const dy = zl.y - zp.y;
      const dz = zl.z - zp.z;
      if (dx * dx + dy * dy + dz * dz > TELEPORT_SQ) {
        this.write(zl.id, zl.x, zl.y, zl.z, zl.yaw, zl); // teleport: no extrapolation
        continue;
      }
      this.write(zl.id, zl.x + dx * k, zl.y + dy * k, zl.z + dz * k, zl.yaw, zl);
    }
  }
}

// ---------------------------------------------------------------------------
// Net — the public surface (see CONTRACT.md client/src/net.ts).
// ---------------------------------------------------------------------------
export class Net {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private emaPing = 0; // ms; 0 until the first pong
  private offset = 0; // ms; 0 until the first pong (serverNow then = perf clock)
  private bestRtt = Infinity;
  private readonly sendQueue: (C2S | LobbyC2S)[] = []; // frames sent while CONNECTING
  private disposed = false;

  private readonly survBuf = new SurvivorInterp();
  private readonly zombieBuf = new ZombieInterp();

  // prediction solids: STATIC_SOLIDS + every currently-intact fence segment box
  private readonly solids: AABB[] = [...STATIC_SOLIDS];
  private readonly segBoxes: readonly AABB[] = SEGMENTS.map((s) => segmentAABB(s));
  private readonly segIntact: boolean[] = SEGMENTS.map(() => true);
  private readonly predictorImpl: PredictorImpl;

  private latestSnap: SnapshotMsg | null = null;
  private youId: PlayerId | null = null;
  private hadSelfSnap = false;

  private roomListResolve: ((rooms: RoomInfo[]) => void) | null = null;
  private roomListTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onEvent: (ev: OutpostEvent) => void,
    private readonly onJoined: (m: JoinedMsg) => void,
  ) {
    for (const box of this.segBoxes) this.solids.push(box); // start all-intact, mirrors server default
    this.predictorImpl = new PredictorImpl(this.solids);
  }

  // ---- lifecycle ----------------------------------------------------------

  /**
   * Opens (or re-opens) the socket. One-shot per call: an unexpected close
   * does not auto-reconnect — mirrors STRICKEN's Connection discipline. Safe
   * to call again later (e.g. after leave()) to start a fresh session.
   */
  connect(): void {
    if (this.disposed) return;
    this.teardownSocket();
    this.emaPing = 0;
    this.offset = 0;
    this.bestRtt = Infinity;
    this.sendQueue.length = 0;

    let ws: WebSocket;
    try {
      const target = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      ws = new WebSocket(target);
    } catch {
      return; // WebSocket unavailable/blocked in this environment — degrade silently
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return; // superseded by a newer connect()
      this.flushQueue();
      this.startPing();
      this.rawSend(ws, { t: 'ping', ts: performance.now() }); // seed RTT/offset immediately
    };
    ws.onerror = () => {
      // pre-open: onclose follows and tears down; post-open: same. Nothing to do here.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // stale socket from a previous connect()
      this.teardownSocket();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      this.handleRaw(ev.data);
    };
  }

  /** Explicit leave: tells the server, closes the socket, forgets the session. */
  leave(): void {
    this.send({ t: 'leave' });
    this.teardownSocket();
    clearSession(GAME_ID);
    this.resetRoomState();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.leave();
    this.failRoomList();
  }

  // ---- outbound -------------------------------------------------------------

  /** No-op unless the socket is open; queues (bounded) while it is still connecting. */
  send(m: C2S | LobbyC2S): void {
    const ws = this.ws;
    if (ws === null) return;
    if (ws.readyState === WebSocket.OPEN) {
      this.rawSend(ws, m);
      return;
    }
    if (ws.readyState === WebSocket.CONNECTING) {
      if (this.sendQueue.length >= SEND_QUEUE_CAP) this.sendQueue.shift();
      this.sendQueue.push(m);
    }
    // CLOSING/CLOSED: drop — never throw across the boundary
  }

  quickJoin(name: string): void {
    this.send(this.withIdentity({ t: 'quick_join', name, game: PORT_GAME_ID }));
  }

  /**
   * Stamps `settings: { debug: true }` on every created room (private rooms
   * are always player-created test/lobby rooms) so the DebugMsg wire — gated
   * server-side on `settings.debug === true` (room.ts) — is reachable end to
   * end through the one real entry point (window.__outpost.createPrivate)
   * both e2e-outpost.mjs and capture-outpost.mjs use. See CONTRACT.md's
   * "Both harnesses create their rooms with that setting."
   */
  createPrivate(name: string): void {
    this.send(this.withIdentity({ t: 'create_private', name, game: PORT_GAME_ID, settings: { debug: true } }));
  }

  joinPrivate(name: string, code: string): void {
    this.send(this.withIdentity({ t: 'join_private', name, code }));
  }

  createPublic(name: string): void {
    this.send(this.withIdentity({ t: 'create_public', name, game: PORT_GAME_ID, settings: { debug: true } }));
  }

  /** Correlates the `room_list` reply internally. Resolves [] on timeout/no socket. */
  listRooms(): Promise<RoomInfo[]> {
    return new Promise<RoomInfo[]>((resolve) => {
      this.failRoomList(); // a newer request supersedes a stale in-flight one
      this.roomListResolve = resolve;
      this.roomListTimer = setTimeout(() => {
        if (this.roomListResolve === resolve) {
          this.roomListResolve = null;
          this.roomListTimer = null;
          resolve([]); // server gone silent — an empty list, not a hang
        }
      }, LIST_ROOMS_TIMEOUT_MS);
      this.send({ t: 'list_rooms' });
    });
  }

  // ---- reads ------------------------------------------------------------------

  snap(): SnapshotMsg | null {
    return this.latestSnap;
  }

  /** Interpolated at serverNow() - NETCODE.interpDelayMs. Reused array — do not retain. */
  survivors(): readonly SurvivorSnap[] {
    return this.survBuf.sample(this.serverNow() - NETCODE.interpDelayMs);
  }

  /** Interpolated at serverNow() - NETCODE.interpDelayMs. Reused array — do not retain. */
  zombies(): readonly ZombieSnap[] {
    return this.zombieBuf.sample(this.serverNow() - NETCODE.interpDelayMs);
  }

  /** Server-clock estimate (min-RTT offset applied); performance.now() before the first pong. */
  serverNow(): number {
    return performance.now() + this.offset;
  }

  /** Smoothed RTT EMA (α=0.2) in ms; 0 before the first pong. */
  pingMs(): number {
    return this.emaPing;
  }

  predictor(): PredictorApi {
    return this.predictorImpl;
  }

  // ---- internal: identity ------------------------------------------------------

  /**
   * Stamps every outgoing join with `sig` (always) and `resume` (only when a
   * stored session exists) — mirrors clientGame.ts's withIdentity exactly,
   * against OUTPOST's own session key (GAME_ID).
   */
  private withIdentity<T extends { t: string }>(msg: T): T & { sig: string; resume?: PlayerId } {
    const session = loadSession(GAME_ID);
    return session === null ? { ...msg, sig: loadSig() } : { ...msg, sig: loadSig(), resume: session.playerId };
  }

  // ---- internal: socket ----------------------------------------------------------

  private rawSend(ws: WebSocket, m: C2S | LobbyC2S): void {
    try {
      ws.send(JSON.stringify(m)); // the wire is plain JSON
    } catch {
      // racing a close — drop the frame
    }
  }

  private flushQueue(): void {
    const ws = this.ws;
    if (ws === null) return;
    for (const m of this.sendQueue) this.rawSend(ws, m);
    this.sendQueue.length = 0;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ t: 'ping', ts: performance.now() });
    }, NETCODE.pingEveryMs);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private teardownSocket(): void {
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState !== WebSocket.CLOSED) {
        try {
          ws.close();
        } catch {
          // already tearing down
        }
      }
    }
    this.sendQueue.length = 0;
  }

  private onPong(ts: number, serverTime: number): void {
    const now = performance.now();
    const rtt = now - ts;
    if (!Number.isFinite(rtt) || rtt < 0) return; // clock weirdness / bad echo
    this.emaPing = this.emaPing === 0 ? rtt : this.emaPing + PING_EMA_ALPHA * (rtt - this.emaPing);
    // min-RTT filter: only the best round trip seen so far moves the offset.
    if (rtt < this.bestRtt) {
      this.bestRtt = rtt;
      this.offset = serverTime + rtt / 2 - now;
    }
  }

  // ---- internal: dispatch --------------------------------------------------------

  private handleRaw(data: string): void {
    let v: unknown;
    try {
      v = JSON.parse(data);
    } catch {
      return; // malformed frame: drop, never throw
    }
    if (!isAnyS2C(v)) return;
    try {
      this.dispatch(v);
    } catch {
      // a bad handler must never take the socket down
    }
  }

  private dispatch(msg: AnyS2C): void {
    switch (msg.t) {
      case 'pong':
        this.onPong(msg.ts, msg.serverTime);
        return;
      case 'room_list':
        this.resolveRoomList(msg.rooms);
        return;
      case 'welcome':
        return; // provisional pre-join id; unused here — `joined` carries the real one
      case 'error':
        // CONTRACT GAP: Net's frozen constructor exposes only onEvent/onJoined —
        // there is no onError/onClose channel to report a join-time rejection
        // (room_full, bad code, no_room, bad_settings) or a socket drop back to
        // the integrator. Reported in this task's summary; see net.ts header.
        return;
      case 'joined':
        this.onJoinedMsg(msg);
        return;
      case 'snapshot':
        this.onSnapshotMsg(msg);
        return;
      case 'event':
        this.onEvent(msg.ev);
        return;
    }
  }

  private onJoinedMsg(msg: JoinedMsg): void {
    this.resetRoomState();
    this.youId = msg.you;
    saveSession(GAME_ID, { playerId: msg.you, roomId: msg.roomId, code: msg.code });
    this.onJoined(msg);
  }

  private onSnapshotMsg(msg: SnapshotMsg): void {
    this.latestSnap = msg;
    this.survBuf.push(msg.serverTime, msg.players);
    this.zombieBuf.push(msg.serverTime, msg.zombies);
    this.syncSolids(msg.segments);
    this.reconcileSelf(msg);
  }

  /** Own authoritative correction: adopt server state, or hard-rebase on a big jump. */
  private reconcileSelf(msg: SnapshotMsg): void {
    if (this.youId === null) return;
    let mine: SurvivorSnap | undefined;
    for (const p of msg.players) {
      if (p.id === this.youId) {
        mine = p;
        break;
      }
    }
    if (mine === undefined) return; // not in this snapshot (e.g. spectating) — nothing to reconcile

    if (!this.hadSelfSnap) {
      this.hadSelfSnap = true;
      this.predictorImpl.reset(mine.x, mine.y, mine.z);
      return;
    }
    const b = this.predictorImpl.body();
    const dx = mine.x - b.x;
    const dy = mine.y - b.y;
    const dz = mine.z - b.z;
    if (dx * dx + dy * dy + dz * dz > RECONCILE_TELEPORT_M * RECONCILE_TELEPORT_M) {
      // a server-side teleport (spawn/return/debug): in-flight inputs predate
      // it and are meaningless to replay — rebase instead of reconciling
      this.predictorImpl.reset(mine.x, mine.y, mine.z);
      return;
    }
    const height = mine.cr ? PLAYER.heightCrouch : PLAYER.heightStand;
    // MUST mirror room.ts's applyInput / game.ts's tickInput exactly: alive
    // moves at the weapon's moveMul, downed crawls at SURVIVOR.downedMoveMul
    // (0), dead does not move at all — or replay after reconciliation
    // diverges from what the server actually simulated (queued movement
    // inputs from a downed/dead player would replay at full weapon speed).
    const speedMul =
      msg.you.status === 'alive'
        ? WEAPONS[msg.you.weapon].moveMul
        : msg.you.status === 'downed'
          ? SURVIVOR.downedMoveMul
          : 0;
    this.predictorImpl.reconcile(mine.x, mine.y, mine.z, height, msg.you.vy, msg.ack, speedMul);
  }

  /** Rebuild the prediction solids only on the rare tick a segment's breach state flips. */
  private syncSolids(segments: readonly SegmentSnap[]): void {
    let changed = false;
    for (let i = 0; i < this.segIntact.length; i++) {
      const seg = segments[i];
      const intact = seg !== undefined && !seg.br;
      if (intact !== this.segIntact[i]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    for (let i = 0; i < this.segIntact.length; i++) {
      const seg = segments[i];
      this.segIntact[i] = seg !== undefined && !seg.br;
    }
    this.solids.length = STATIC_SOLIDS.length;
    for (let i = 0; i < this.segBoxes.length; i++) {
      if (this.segIntact[i] !== true) continue;
      const box = this.segBoxes[i];
      if (box !== undefined) this.solids.push(box);
    }
  }

  private resetRoomState(): void {
    this.latestSnap = null;
    this.youId = null;
    this.hadSelfSnap = false;
    this.survBuf.reset();
    this.zombieBuf.reset();
    this.solids.length = STATIC_SOLIDS.length;
    for (let i = 0; i < this.segBoxes.length; i++) {
      this.segIntact[i] = true;
      const box = this.segBoxes[i];
      if (box !== undefined) this.solids.push(box);
    }
  }

  // ---- internal: room list correlation --------------------------------------------

  private resolveRoomList(rooms: RoomInfo[]): void {
    const r = this.roomListResolve;
    if (r === null) return;
    this.roomListResolve = null;
    if (this.roomListTimer !== null) {
      clearTimeout(this.roomListTimer);
      this.roomListTimer = null;
    }
    r(rooms);
  }

  private failRoomList(): void {
    this.resolveRoomList([]);
  }
}
