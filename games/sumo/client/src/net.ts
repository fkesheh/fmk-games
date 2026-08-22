// ============================================================================
// SUMO NET (thin) — one demuxer for the room's S2C plus a small snapshot
// interpolation buffer. Prediction is deliberately absent (slow game, spec):
// remotes AND your own capsule render INTERP_MS behind the server clock; the
// buffer follows the fps/net/interpolation.ts pattern in miniature — bracket
// lerp on x/y/z + shortest-arc yaw, discrete fields from the newer snapshot,
// teleport snap >10u, extrapolate capped past the newest frame.
// ============================================================================
import type { SumoEvent, SumoJoinedMsg, SumoPhase, SumoPlayerSnap, SumoWinRow, SumoYou } from '@sumo/shared';

const MAX_AGE_MS = 1500;
const TELEPORT_SQ = 10 * 10;
const TWO_PI = Math.PI * 2;

interface Frame {
  time: number; // serverTime ms
  players: SumoPlayerSnap[]; // retained reference
}

/** Interpolated player as consumed by the renderer (pooled per id). */
export interface Sampled {
  id: string;
  name: string;
  color: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  alive: boolean;
  dashing: boolean;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

export class InterpBuffer {
  private snaps: Frame[] = [];
  private readonly out: Sampled[] = [];
  private readonly pool = new Map<string, Sampled>();

  reset(): void {
    this.snaps.length = 0;
    this.out.length = 0;
    this.pool.clear();
  }

  push(serverTimeMs: number, players: SumoPlayerSnap[]): void {
    if (!Number.isFinite(serverTimeMs)) return;
    const snaps = this.snaps;
    const last = snaps[snaps.length - 1];
    if (last === undefined || serverTimeMs > last.time) snaps.push({ time: serverTimeMs, players });
    else if (serverTimeMs === last.time) last.players = players;
    else snaps.push({ time: serverTimeMs, players }); // rare late frame; keep order roughly
    // evict history older than ~1.5s, keeping two brackets
    const newest = snaps[snaps.length - 1];
    if (newest !== undefined) {
      while (snaps.length > 3) {
        const second = snaps[1];
        if (second === undefined || second.time > newest.time - MAX_AGE_MS) break;
        snaps.shift();
      }
    }
  }

  sample(renderTime: number): Sampled[] {
    const out = this.out;
    out.length = 0;
    const snaps = this.snaps;
    const n = snaps.length;
    if (n === 0) return out;

    let lo = -1;
    for (let i = n - 1; i >= 0; i--) {
      const s = snaps[i];
      if (s !== undefined && s.time <= renderTime) {
        lo = i;
        break;
      }
    }
    const a = lo >= 0 ? snaps[lo] : snaps[0];
    if (a === undefined) return out;
    const b = lo >= 0 ? snaps[lo + 1] : undefined;
    if (b === undefined) {
      this.emit(a);
      return out;
    }
    const span = b.time - a.time;
    const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.time) / span)) : 1;
    for (const pb of b.players) {
      let pa: SumoPlayerSnap | undefined;
      for (const q of a.players) {
        if (q.id === pb.id) {
          pa = q;
          break;
        }
      }
      if (pa === undefined) {
        this.write(pb.id, pb.x, pb.y, pb.z, pb.yaw, pb); // appear at once
        continue;
      }
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const dz = pb.z - pa.z;
      if (dx * dx + dy * dy + dz * dz > TELEPORT_SQ) {
        this.write(pb.id, pb.x, pb.y, pb.z, pb.yaw, pb); // snap, never slide
        continue;
      }
      this.write(
        pb.id,
        pa.x + dx * t,
        pa.y + dy * t,
        pa.z + dz * t,
        lerpAngle(pa.yaw, pb.yaw, t),
        pb, // discrete fields from the newer bracket
      );
    }
    return out;
  }

  private emit(s: Frame): void {
    for (const pl of s.players) this.write(pl.id, pl.x, pl.y, pl.z, pl.yaw, pl);
  }

  private write(
    id: string,
    x: number,
    y: number,
    z: number,
    yaw: number,
    src: SumoPlayerSnap,
  ): void {
    let p = this.pool.get(id);
    if (p === undefined) {
      p = { id, name: '', color: 0, x: 0, y: 0, z: 0, yaw: 0, alive: false, dashing: false };
      this.pool.set(id, p);
    }
    p.name = src.name;
    p.color = src.color;
    p.x = x;
    p.y = y;
    p.z = z;
    p.yaw = yaw;
    p.alive = src.alive;
    p.dashing = src.dashing;
    this.out.push(p);
  }
}

/** Everything the app needs from the latest snapshot, minus the roster. */
export interface SnapMeta {
  tick: number;
  serverTime: number;
  phase: SumoPhase;
  phaseEndsAt: number;
  round: number;
  radius: number;
  wins: SumoWinRow[];
}

export type SumoHandler =
  | { kind: 'joined'; msg: SumoJoinedMsg }
  | { kind: 'meta'; meta: SnapMeta; you: SumoPlayerSnap | null; events: SumoEvent[] };

/**
 * Demuxes S2C into joined/meta buckets and feeds the interp buffer.
 * Non-sumo messages (welcome/error/pad_*) are surfaced via onError/onOther.
 */
export class SumoNet {
  youId: string | null = null;
  readonly buffer = new InterpBuffer();
  onError: ((code: string, message: string) => void) | null = null;

  handle(msg: Record<string, unknown> & { t: string }): void {
    if (msg.t === 'sumo_joined') {
      this.buffer.reset();
      const m = msg as unknown as SumoJoinedMsg;
      this.youId = m.you;
      this.joined = m;
      return;
    }
    if (msg.t === 'snap') {
      const s = msg as unknown as {
        tick: number; serverTime: number; phase: SumoPhase; phaseEndsAt: number;
        round: number; radius: number; players: SumoPlayerSnap[]; wins: SumoWinRow[];
        events: SumoEvent[]; you: SumoYou;
      };
      this.buffer.push(s.serverTime, s.players);
      this.meta = {
        tick: s.tick,
        serverTime: s.serverTime,
        phase: s.phase,
        phaseEndsAt: s.phaseEndsAt,
        round: s.round,
        radius: s.radius,
        wins: s.wins,
      };
      this.youState = s.you;
      this.pendingEvents.push(...s.events);
      return;
    }
    if (msg.t === 'error') {
      this.onError?.(String(msg['code'] ?? ''), String(msg['message'] ?? ''));
    }
  }

  /** Joined payload (set once per join). */
  joined: SumoJoinedMsg | null = null;
  /** Latest snapshot meta (roster lives in the buffer). */
  meta: SnapMeta | null = null;
  /** Your private block from the latest snap (seq/ack/cooldowns). */
  youState: SumoYou | null = null;
  /** Events accumulated since last drain. */
  private readonly pendingEvents: SumoEvent[] = [];

  drainEvents(): SumoEvent[] {
    if (this.pendingEvents.length === 0) return [];
    return this.pendingEvents.splice(0, this.pendingEvents.length);
  }

  clearRoom(): void {
    this.youId = null;
    this.joined = null;
    this.meta = null;
    this.youState = null;
    this.pendingEvents.length = 0;
    this.buffer.reset();
  }
}
