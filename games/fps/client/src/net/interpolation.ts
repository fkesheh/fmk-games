// ============================================================================
// C1 — InterpBuffer: ~1s of server snapshots, sampled at renderServerTime.
// sample() lerps the two bracketing snapshots (position + yaw shortest-arc +
// pitch; discrete fields from the NEWER snapshot), extrapolates position only
// up to NET.interpMaxExtrapolateMs past the newest, and snaps (never slides)
// on teleports > 10m. Presence is governed by the newer bracket: players in
// only one snapshot appear/disappear immediately. Hot path is allocation-free:
// push retains the decoded array; sample reuses pooled PlayerSnap objects in
// one reused output array — callers must NOT retain the returned reference.
// ============================================================================
import { NET } from '@fps/shared';
import type { PlayerId, PlayerSnap } from '@fps/shared';

// ---- tuning (frozen by CONTRACT.md / C1 spec) --------------------------------
const MAX_AGE_MS = 1000; // keep ~1s of snapshots
const TELEPORT_SQ = 10 * 10; // m² — bigger jumps snap, never lerp/extrapolate
const TWO_PI = Math.PI * 2;

interface Snap {
  time: number; // serverTime ms
  players: PlayerSnap[]; // retained reference — caller must not mutate after push
}

/** Shortest-arc lerp for wrapped radians. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

export class InterpBuffer {
  private snaps: Snap[] = []; // ascending by time, ≤ ~34 entries
  private readonly out: PlayerSnap[] = []; // reused result — do not retain
  private readonly pool = new Map<PlayerId, PlayerSnap>(); // per-id reusable output objects

  reset(): void {
    this.snaps.length = 0;
    this.out.length = 0;
    this.pool.clear();
  }

  /** Retains `players` (fresh decode per snapshot); caller must not mutate it. */
  push(serverTimeMs: number, players: PlayerSnap[]): void {
    if (!Number.isFinite(serverTimeMs)) return; // malformed server frame: drop
    const snaps = this.snaps;
    const last = snaps[snaps.length - 1];
    if (last === undefined || serverTimeMs > last.time) {
      snaps.push({ time: serverTimeMs, players }); // in-order fast path
    } else if (serverTimeMs === last.time) {
      last.players = players; // duplicate tick: newest data wins
    } else {
      // rare out-of-order arrival: insert keeping times ascending
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
    // evict beyond ~1s of history, keeping one older entry for bracketing
    const newest = snaps[snaps.length - 1];
    if (newest !== undefined) {
      while (snaps.length > 2) {
        const second = snaps[1];
        if (second === undefined || second.time > newest.time - MAX_AGE_MS) break;
        snaps.shift();
      }
    }
  }

  sample(renderServerTime: number): PlayerSnap[] {
    const out = this.out;
    out.length = 0;
    const snaps = this.snaps;
    const n = snaps.length;
    if (n === 0) return out;

    // newest snapshot at or before the render time (linear from the end; n ≤ ~34)
    let lo = -1;
    for (let i = n - 1; i >= 0; i--) {
      const s = snaps[i];
      if (s !== undefined && s.time <= renderServerTime) {
        lo = i;
        break;
      }
    }
    if (lo < 0) {
      // render time older than everything we have: clamp to the oldest
      const oldest = snaps[0];
      if (oldest !== undefined) this.emitCopy(oldest);
      return out;
    }
    const a = snaps[lo];
    if (a === undefined) return out; // unreachable; satisfies noUncheckedIndexedAccess
    const b = snaps[lo + 1];
    if (b === undefined) {
      // at/after the newest snapshot: extrapolate from the newest pair
      this.emitExtrapolate(a, snaps[lo - 1], renderServerTime);
      return out;
    }
    this.emitLerp(a, b, renderServerTime);
    return out;
  }

  // ---- internal -----------------------------------------------------------------
  /** Overwrite the pooled output object for id and append it to the result. */
  private write(
    id: PlayerId,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    src: PlayerSnap, // discrete fields (hp/alive/crouch/moving/weapon) come from here
  ): void {
    let p = this.pool.get(id);
    if (p === undefined) {
      p = {
        id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
        hp: 0, alive: false, crouch: false, moving: false, weapon: 'knife',
      };
      this.pool.set(id, p);
    }
    p.x = x;
    p.y = y;
    p.z = z;
    p.yaw = yaw;
    p.pitch = pitch;
    p.hp = src.hp;
    p.alive = src.alive;
    p.crouch = src.crouch;
    p.moving = src.moving;
    p.weapon = src.weapon;
    this.out.push(p);
  }

  private emitCopy(s: Snap): void {
    for (const pl of s.players) this.write(pl.id, pl.x, pl.y, pl.z, pl.yaw, pl.pitch, pl);
  }

  /** Lerp a→b at renderTime. Result set = b's players (newer bracket governs). */
  private emitLerp(a: Snap, b: Snap, renderTime: number): void {
    const span = b.time - a.time;
    const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.time) / span)) : 1;
    for (const pb of b.players) {
      let pa: PlayerSnap | undefined;
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

  /** Past the newest snapshot: linear velocity from the newest pair, position only. */
  private emitExtrapolate(latest: Snap, prev: Snap | undefined, renderTime: number): void {
    const dtMs = Math.min(NET.interpMaxExtrapolateMs, Math.max(0, renderTime - latest.time));
    const span = prev !== undefined ? latest.time - prev.time : 0;
    const k = dtMs > 0 && span > 0 ? dtMs / span : 0;
    for (const pl of latest.players) {
      let pp: PlayerSnap | undefined;
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
