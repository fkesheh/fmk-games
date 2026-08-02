// ============================================================================
// T1 — GameRoom (S2) integration tests over a fake RoomIO. The room's own
// setInterval is driven by vi fake timers (which also fake Date.now), rttMs()
// is 0, and crafted fire inputs are aimed from real snapshot state against the
// same dustbowl solids the server sim uses — fully deterministic.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ECONOMY, GEAR, INPUT_FIRE, MAPS, MAX_PLAYERS, MIN_PLAYERS_FOR_MATCH, MULTIKILL_WINDOW, PLAYER, ROUNDS, WEAPONS, boxToAABB, hitscan } from '@fps/shared';
import type { C2S, GameEvent, HitscanTarget, MapId, PlayerId, RoomPhase, S2C, Team, Vec3, WeaponDef } from '@fps/shared';
import { GameRoom } from './game.js';
import type { RoomIO } from './game.js';
import type { ShotHit } from './combat.js';

type SnapshotMsg = Extract<S2C, { t: 'snapshot' }>;
type JoinedMsg = Extract<S2C, { t: 'joined' }>;
type InputMsg = Extract<C2S, { t: 'input' }>;

// ---- fake RoomIO -------------------------------------------------------------
// Snapshots are reused/mutated by the room across ticks, so everything is
// captured through structuredClone: history stays stable for assertions.

class FakeIO implements RoomIO {
  private readonly log = new Map<PlayerId, S2C[]>();

  send(id: PlayerId, msg: S2C): void {
    let msgs = this.log.get(id);
    if (msgs === undefined) {
      msgs = [];
      this.log.set(id, msgs);
    }
    msgs.push(structuredClone(msg));
  }

  rttMs(): number {
    return 0;
  }

  private lastOf<T extends S2C['t']>(id: PlayerId, t: T): Extract<S2C, { t: T }> {
    const msgs = this.log.get(id) ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m !== undefined && m.t === t) return m as Extract<S2C, { t: T }>;
    }
    throw new Error(`no '${t}' captured for ${id}`);
  }

  lastSnap(id: PlayerId): SnapshotMsg {
    return this.lastOf(id, 'snapshot');
  }

  joined(id: PlayerId): JoinedMsg {
    return this.lastOf(id, 'joined');
  }

  events(id: PlayerId): GameEvent[] {
    return (this.log.get(id) ?? [])
      .filter((m): m is Extract<S2C, { t: 'event' }> => m.t === 'event')
      .map((m) => m.ev);
  }

  errors(id: PlayerId): Array<Extract<S2C, { t: 'error' }>> {
    return (this.log.get(id) ?? []).filter((m): m is Extract<S2C, { t: 'error' }> => m.t === 'error');
  }
}

// ---- drive helpers -----------------------------------------------------------

/** Solids exactly as the server builds them for a dustbowl room. */
const SOLIDS = MAPS.dustbowl.boxes.map(boxToAABB);

/** Advance the room's interval one-ish tick (1000/30 = 33.33ms). */
function tick(): void {
  vi.advanceTimersByTime(34);
}

/** Advance until cond holds; false when the step budget ran out. */
function advanceUntil(cond: () => boolean, maxSteps = 500): boolean {
  for (let i = 0; i < maxSteps; i++) {
    tick(); // tick first: cond reads snapshots, which only exist after a tick
    if (cond()) return true;
  }
  return cond();
}

/** Monotonic per-player input seqs (stale/duplicate seqs are dropped server-side). */
class InputFeed {
  private readonly seqs = new Map<PlayerId, number>();

  send(room: GameRoom, id: PlayerId, over: Partial<Omit<InputMsg, 't' | 'seq'>> = {}): void {
    const seq = (this.seqs.get(id) ?? 0) + 1;
    this.seqs.set(id, seq);
    room.handleInput(id, { t: 'input', seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, ...over });
  }
}

/**
 * The explicit manual start. Warmup is this game's lobby and it never ends by
 * itself, so any test that wants a match has to ask for one — from a SEATED
 * player (there is no host). beginFreeze runs synchronously inside the call, so
 * the room is already in freeze when this returns.
 */
function startMatch(room: GameRoom, id: PlayerId): void {
  room.handleMessage(id, { t: 'start' });
}

/** Two players, the tick loop running, and the match explicitly started. */
function setupDuel(io: FakeIO): GameRoom {
  const room = new GameRoom('dustbowl', 'public', io);
  room.addPlayer('p1', 'Alpha');
  room.addPlayer('p2', 'Bravo');
  room.start();
  startMatch(room, 'p1'); // no auto-start: the room would sit in warmup forever
  return room;
}

/**
 * Aim point at `aimHeight` on the target's NEAR FACE rather than at its centre.
 * A ray to the centre crosses the near face LOWER than the aim point, and the
 * error grows with the vertical angle: point-blank against a target standing on
 * a 0.9m block, a head-height aim enters the box at chest height and a
 * `headshot: true` fight driver never fires. Pulling the aim point back by
 * PLAYER.radius puts the intended band on the face the ray actually meets.
 */
function nearFaceAim(
  me: { x: number; z: number },
  tgt: { x: number; y: number; z: number },
  aimHeight: number,
): Vec3 {
  const toX = tgt.x - me.x;
  const toZ = tgt.z - me.z;
  const flat = Math.hypot(toX, toZ) || 1e-9;
  return {
    x: tgt.x - (toX / flat) * PLAYER.radius,
    y: tgt.y + aimHeight,
    z: tgt.z - (toZ / flat) * PLAYER.radius,
  };
}

function advanceToPhase(io: FakeIO, id: PlayerId, phase: RoomPhase, maxSteps = 500): void {
  const ok = advanceUntil(() => io.lastSnap(id).phase === phase, maxSteps);
  expect(ok, `room reaches phase ${phase}`).toBe(true);
}

// ---- nav grid over dustbowl (test-only pathing for the fight driver) --------
// BFS on a 0.6m cell grid; cells overlapping a solid the body can't step onto
// are blocked. A BFS path never crosses a wall, so the walker cannot wedge.

const NAV_CELL = 0.6;
const NAV_X0 = -33;
const NAV_Z0 = -25;
const NAV_NX = Math.ceil(66 / NAV_CELL);
const NAV_NZ = Math.ceil(50 / NAV_CELL);

function navCellBlocked(cx: number, cz: number): boolean {
  const r = PLAYER.radius + 0.08;
  for (const s of SOLIDS) {
    if (s.maxY <= PLAYER.stepUp) continue; // low ledge: the body steps up
    if (cx + r > s.minX && cx - r < s.maxX && cz + r > s.minZ && cz - r < s.maxZ) return true;
  }
  return false;
}

const NAV_BLOCKED: readonly boolean[] = (() => {
  const out: boolean[] = [];
  for (let iz = 0; iz < NAV_NZ; iz++) {
    for (let ix = 0; ix < NAV_NX; ix++) {
      out.push(navCellBlocked(NAV_X0 + (ix + 0.5) * NAV_CELL, NAV_Z0 + (iz + 0.5) * NAV_CELL));
    }
  }
  return out;
})();

interface NavCell {
  ix: number;
  iz: number;
}

function navCellOf(x: number, z: number): NavCell {
  return {
    ix: Math.min(NAV_NX - 1, Math.max(0, Math.floor((x - NAV_X0) / NAV_CELL))),
    iz: Math.min(NAV_NZ - 1, Math.max(0, Math.floor((z - NAV_Z0) / NAV_CELL))),
  };
}

function navFree(ix: number, iz: number): boolean {
  return NAV_BLOCKED[iz * NAV_NX + ix] === false;
}

/** Spiral out to the closest free cell (a body can stand on a stepped-up box). */
function navNearestFree(cell: NavCell): NavCell {
  if (navFree(cell.ix, cell.iz)) return cell;
  for (let ring = 1; ring < 10; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const jx = cell.ix + dx;
        const jz = cell.iz + dz;
        if (jx >= 0 && jx < NAV_NX && jz >= 0 && jz < NAV_NZ && navFree(jx, jz)) return { ix: jx, iz: jz };
      }
    }
  }
  return cell;
}

/** BFS shortest path of cell-center waypoints; empty when already there. */
function navPath(x0: number, z0: number, x1: number, z1: number): Array<{ x: number; z: number }> {
  const start = navNearestFree(navCellOf(x0, z0));
  const goal = navNearestFree(navCellOf(x1, z1));
  const startIdx = start.iz * NAV_NX + start.ix;
  const goalIdx = goal.iz * NAV_NX + goal.ix;
  if (startIdx === goalIdx) return [];
  const prev = new Int32Array(NAV_NX * NAV_NZ).fill(-2);
  const queue = new Int32Array(NAV_NX * NAV_NZ);
  let head = 0;
  let tail = 0;
  queue[tail++] = startIdx;
  prev[startIdx] = -1;
  while (head < tail) {
    const cur = queue[head++];
    if (cur === undefined) break;
    if (cur === goalIdx) break;
    const cx = cur % NAV_NX;
    const cz = Math.floor(cur / NAV_NX);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const jx = cx + dx;
        const jz = cz + dz;
        if (jx < 0 || jx >= NAV_NX || jz < 0 || jz >= NAV_NZ || !navFree(jx, jz)) continue;
        // no corner cutting: diagonal moves need both orthogonal cells free
        if (dx !== 0 && dz !== 0 && (!navFree(cx + dx, cz) || !navFree(cx, cz + dz))) continue;
        const j = jz * NAV_NX + jx;
        if (prev[j] !== -2) continue;
        prev[j] = cur;
        queue[tail++] = j;
      }
    }
  }
  if (prev[goalIdx] === -2) return [];
  const cells: number[] = [];
  for (let c = goalIdx; c >= 0; ) {
    cells.push(c);
    const p = prev[c];
    if (p === undefined || p < 0) break;
    c = p;
  }
  cells.reverse();
  return cells.map((c) => ({
    x: NAV_X0 + ((c % NAV_NX) + 0.5) * NAV_CELL,
    z: NAV_Z0 + (Math.floor(c / NAV_NX) + 0.5) * NAV_CELL,
  }));
}

interface FightOpts {
  /** aim height above target feet (default 0.75 = chest; ~1.65 = head-band center) */
  aimHeight?: number;
  /** stand-and-fire horizontal distance (default 12) */
  fireDist?: number;
  /** loop iterations between trigger pulls (default 8; >= 6 respects the 0.17s fire interval) */
  cadence?: number;
  /** probe against ALL alive players and fire only when the closest hit is the target */
  strict?: boolean;
  /** with strict: fire only when the probe hit on the target is a headshot */
  headshot?: boolean;
  /** extra player who BFS-walks toward the shooter for the whole fight */
  lure?: PlayerId;
}

/**
 * Drive `shooter` until `target` dies: BFS-path toward the target (repath when
 * wedged or stale), stand and fire the pistol at the aim point whenever the shared
 * hitscan says the line is clear at <= fireDist. Throws if the budget runs out.
 */
function fightUntilKill(
  room: GameRoom,
  io: FakeIO,
  feed: InputFeed,
  shooter: PlayerId,
  target: PlayerId,
  opts: FightOpts = {},
): void {
  const aimHeight = opts.aimHeight ?? 0.75;
  const fireDist = opts.fireDist ?? 12;
  const cadence = opts.cadence ?? 8;
  const strict = opts.strict ?? false;
  const needHead = opts.headshot ?? false;
  const lureId = opts.lure;
  let lastX = 0;
  let lastZ = 0;
  let stuck = 0;
  let path: Array<{ x: number; z: number }> = [];
  let pathIdx = 0;
  let lastPathAt = -1000;
  let lurePath: Array<{ x: number; z: number }> = [];
  let lurePathIdx = 0;
  let lureLastPathAt = -1000;
  let lureLastX = 0;
  let lureLastZ = 0;
  let lureStuck = 0;
  for (let i = 0; i < 2500; i++) {
    const snap = io.lastSnap(shooter);
    const me = snap.players.find((p) => p.id === shooter);
    const tgt = snap.players.find((p) => p.id === target);
    if (me === undefined || tgt === undefined) throw new Error('snapshot missing duel players');
    if (!tgt.alive) return;

    const eye: Vec3 = { x: me.x, y: me.y + PLAYER.heightStand - PLAYER.eyeOffset, z: me.z };
    const aim: Vec3 = { x: tgt.x, y: tgt.y + aimHeight, z: tgt.z };
    const dx = aim.x - eye.x;
    const dy = aim.y - eye.y;
    const dz = aim.z - eye.z;
    const dist = Math.hypot(dx, dz) || 1e-9;
    const aimFlat = dist;
    const len = Math.hypot(dx, dy, dz) || 1e-9;
    const dir: Vec3 = { x: dx / len, y: dy / len, z: dz / len };
    let clear: boolean;
    if (strict) {
      // probe everyone: the trigger is pulled only when the TARGET eats the bullet
      const others: HitscanTarget[] = [];
      for (const pl of snap.players) {
        if (pl.id !== shooter && pl.alive) {
          others.push({ id: pl.id, x: pl.x, y: pl.y, z: pl.z, height: PLAYER.heightStand });
        }
      }
      const probe = hitscan(eye, dir, others, SOLIDS, 200);
      clear = probe !== null && probe.targetId === target && (!needHead || probe.headshot);
    } else {
      clear =
        hitscan(eye, dir, [{ id: 'tgt', x: tgt.x, y: tgt.y, z: tgt.z, height: PLAYER.heightStand }], SOLIDS, 200) !==
        null;
    }
    // input yaw/pitch so the server's aimDir(yaw,pitch) equals `dir`
    let yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, aimFlat);

    const moved = Math.hypot(me.x - lastX, me.z - lastZ);
    lastX = me.x;
    lastZ = me.z;
    const walking = !(clear && dist <= fireDist);
    if (walking && moved < 0.01) stuck++;
    else stuck = 0;

    if (pathIdx >= path.length || i - lastPathAt > 120 || stuck > 20) {
      path = navPath(me.x, me.z, tgt.x, tgt.z);
      pathIdx = 0;
      lastPathAt = i;
      stuck = 0;
    }

    let moveZ = 0;
    let buttons = 0;
    if (clear && dist <= fireDist && snap.you.mag > 0 && i % cadence === 0) {
      // semi-auto: one edge per shot, well over the 0.17s fire interval
      buttons = INPUT_FIRE;
    } else if (walking) {
      const wp = path[pathIdx];
      if (wp !== undefined) {
        if (Math.hypot(wp.x - me.x, wp.z - me.z) < 0.5) {
          pathIdx++;
        } else {
          yaw = Math.atan2(-(wp.x - me.x), -(wp.z - me.z)); // face the waypoint
          moveZ = 1;
        }
      } else if (dist > 3) {
        moveZ = 1; // no path (unreachable exact cell): close straight in
      }
    }
    if (snap.you.mag === 0) room.handleReload(shooter);
    feed.send(room, shooter, { moveX: 0, moveZ, yaw, pitch, buttons });
    if (i % 30 === 0) feed.send(room, target); // keep the target's input clock fresh

    if (lureId !== undefined) {
      // the lure converges on the shooter so a follow-up kill fits MULTIKILL_WINDOW
      const lm = snap.players.find((p) => p.id === lureId);
      if (lm !== undefined && lm.alive) {
        const ldx = me.x - lm.x;
        const ldz = me.z - lm.z;
        const ldist = Math.hypot(ldx, ldz);
        const lmoved = Math.hypot(lm.x - lureLastX, lm.z - lureLastZ);
        lureLastX = lm.x;
        lureLastZ = lm.z;
        if (ldist > 2 && lmoved < 0.01) lureStuck++;
        else lureStuck = 0;
        if (lurePathIdx >= lurePath.length || i - lureLastPathAt > 90 || lureStuck > 20) {
          lurePath = navPath(lm.x, lm.z, me.x, me.z);
          lurePathIdx = 0;
          lureLastPathAt = i;
          lureStuck = 0;
        }
        let lureYaw = Math.atan2(-ldx, -ldz);
        let lureMove = 0;
        if (ldist > 2) {
          const wp = lurePath[lurePathIdx];
          if (wp !== undefined) {
            if (Math.hypot(wp.x - lm.x, wp.z - lm.z) < 0.5) {
              lurePathIdx++;
            } else {
              lureYaw = Math.atan2(-(wp.x - lm.x), -(wp.z - lm.z));
              lureMove = 1;
            }
          } else {
            lureMove = 1; // no path: close straight in
          }
        }
        feed.send(room, lureId, { moveX: 0, moveZ: lureMove, yaw: lureYaw, pitch: 0, buttons: 0 });
      }
    }
    tick();
  }
  throw new Error('fight did not resolve within the tick budget');
}

/**
 * Drive `shooter` until ONE of its shots damages `target` (an hp or armor drop
 * on the target's own snapshot), then stop before a second trigger pull. Same
 * BFS walking + probe discipline as fightUntilKill, minus the lure. Throws if
 * the target dies (the absorb tests need it alive) or the budget runs out.
 */
function fightUntilHit(
  room: GameRoom,
  io: FakeIO,
  feed: InputFeed,
  shooter: PlayerId,
  target: PlayerId,
  opts: FightOpts = {},
): void {
  const aimHeight = opts.aimHeight ?? 0.75;
  const fireDist = opts.fireDist ?? 12;
  const cadence = opts.cadence ?? 8;
  const strict = opts.strict ?? false;
  const needHead = opts.headshot ?? false;
  let baseHp: number | null = null;
  let baseArmor: number | null = null;
  let lastX = 0;
  let lastZ = 0;
  let stuck = 0;
  let path: Array<{ x: number; z: number }> = [];
  let pathIdx = 0;
  let lastPathAt = -1000;
  let dbgDist = -1;
  let dbgClear = false;
  let dbgX = 0;
  let dbgZ = 0;
  let dbgTX = 0;
  let dbgTZ = 0;
  let dbgPhase = '';
  for (let i = 0; i < 2500; i++) {
    const snap = io.lastSnap(shooter);
    const me = snap.players.find((p) => p.id === shooter);
    const tgt = snap.players.find((p) => p.id === target);
    if (me === undefined || tgt === undefined) throw new Error('snapshot missing duel players');
    if (!me.alive) throw new Error('shooter died');
    if (!tgt.alive) throw new Error('target died: expected exactly one non-lethal hit');

    const tgtYou = io.lastSnap(target).you;
    if (baseHp === null || baseArmor === null) {
      baseHp = tgtYou.hp;
      baseArmor = tgtYou.armor;
    } else if (tgtYou.hp < baseHp || tgtYou.armor < baseArmor) {
      return; // first damaging hit observed — stop before a second one lands
    }

    const eye: Vec3 = { x: me.x, y: me.y + PLAYER.heightStand - PLAYER.eyeOffset, z: me.z };
    const aim = nearFaceAim(me, tgt, aimHeight);
    const dx = aim.x - eye.x;
    const dy = aim.y - eye.y;
    const dz = aim.z - eye.z;
    const dist = Math.hypot(tgt.x - me.x, tgt.z - me.z) || 1e-9; // to the target CENTRE
    const aimFlat = Math.hypot(dx, dz) || 1e-9;
    const len = Math.hypot(dx, dy, dz) || 1e-9;
    const dir: Vec3 = { x: dx / len, y: dy / len, z: dz / len };
    dbgDist = dist;
    dbgX = me.x;
    dbgZ = me.z;
    dbgTX = tgt.x;
    dbgTZ = tgt.z;
    dbgPhase = snap.phase;
    let clear: boolean;
    if (strict) {
      // probe everyone: the trigger is pulled only when the TARGET eats the bullet
      const others: HitscanTarget[] = [];
      for (const pl of snap.players) {
        if (pl.id !== shooter && pl.alive) {
          others.push({ id: pl.id, x: pl.x, y: pl.y, z: pl.z, height: PLAYER.heightStand });
        }
      }
      const probe = hitscan(eye, dir, others, SOLIDS, 200);
      clear = probe !== null && probe.targetId === target && (!needHead || probe.headshot);
    } else {
      clear =
        hitscan(eye, dir, [{ id: 'tgt', x: tgt.x, y: tgt.y, z: tgt.z, height: PLAYER.heightStand }], SOLIDS, 200) !==
        null;
    }
    dbgClear = clear;
    // input yaw/pitch so the server's aimDir(yaw,pitch) equals `dir`
    let yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, aimFlat);

    const moved = Math.hypot(me.x - lastX, me.z - lastZ);
    lastX = me.x;
    lastZ = me.z;
    const walking = !(clear && dist <= fireDist);
    if (walking && moved < 0.01) stuck++;
    else stuck = 0;

    if (pathIdx >= path.length || i - lastPathAt > 120 || stuck > 20) {
      path = navPath(me.x, me.z, tgt.x, tgt.z);
      pathIdx = 0;
      lastPathAt = i;
      stuck = 0;
    }

    let moveX = 0;
    let moveZ = 0;
    let buttons = 0;
    if (clear && dist <= fireDist && snap.you.mag !== 0 && i % cadence === 0) {
      // semi-auto: one edge per shot; mag -1 (knife) never blocks the trigger
      buttons = INPUT_FIRE;
    } else if (walking) {
      const wp = path[pathIdx];
      if (wp !== undefined && dist > fireDist) {
        if (Math.hypot(wp.x - me.x, wp.z - me.z) < 0.5) {
          pathIdx++;
        } else {
          yaw = Math.atan2(-(wp.x - me.x), -(wp.z - me.z)); // face the waypoint
          moveZ = 1;
        }
      } else {
        // close (or path exhausted) but the line is blocked: orbit the target —
        // forward pressure closes in, alternating strafe circles around cover.
        // Below 2 * PLAYER.radius the two AABBs interpenetrate and the shooter's
        // eye sits inside the target's box, which hitscan cannot report a hit on
        // (the entry t is behind the origin) — so back off instead of grinding
        // into it. Reachable whenever the target is pinned against cover it
        // cannot be pushed off, e.g. a spawn flush with a low block.
        moveZ = dist > 0.95 ? 1 : dist < 0.8 ? -1 : 0;
        moveX = Math.floor(i / 40) % 2 === 0 ? 1 : -1;
      }
    }
    feed.send(room, shooter, { moveX, moveZ, yaw, pitch, buttons });
    if (i % 30 === 0) feed.send(room, target); // keep the target's input clock fresh
    tick();
  }
  throw new Error(
    `no hit landed within the tick budget (dist=${dbgDist.toFixed(2)} clear=${dbgClear} ` +
      `me=(${dbgX.toFixed(1)},${dbgZ.toFixed(1)}) tgt=(${dbgTX.toFixed(1)},${dbgTZ.toFixed(1)}) phase=${dbgPhase})`,
  );
}

function teamOf(io: FakeIO, id: PlayerId): Team {
  return io.joined(id).team;
}

/**
 * Lose one whole round on purpose, without a firefight: wait for 'live', have
 * `losers` kill themselves (console 'kill' — no killer, so no kill reward
 * distorts the money curve), then settle in 'roundEnd'. Two losers on opposite
 * sides is a mutual elimination, i.e. a draw. `watcher` must be a player whose
 * snapshots keep arriving (any seated player does).
 */
function loseRound(room: GameRoom, io: FakeIO, watcher: PlayerId, losers: PlayerId[]): void {
  advanceToPhase(io, watcher, 'live');
  for (const id of losers) room.handleMessage(id, { t: 'suicide' });
  advanceToPhase(io, watcher, 'roundEnd');
}

function eventsOfType<T extends GameEvent['t']>(io: FakeIO, id: PlayerId, t: T): Array<Extract<GameEvent, { t: T }>> {
  return io.events(id).filter((e): e is Extract<GameEvent, { t: T }> => e.t === t);
}

// ---- tests -------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// THE MANUAL-START LOBBY. No game on this platform auto-starts. fps's lobby is
// `warmup` — still fully playable — and the ONLY way out of it is an explicit
// {t:'start'} from a seated player.
// ---------------------------------------------------------------------------

describe('GameRoom manual start', () => {
  it('warmup never ends by itself, not even once the minimum is met', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();

    vi.advanceTimersByTime(200);
    expect(io.lastSnap('p1').phase).toBe('warmup'); // < MIN_PLAYERS_FOR_MATCH
    expect(room.info().phase).toBe('warmup');
    expect(io.lastSnap('p1').seated).toBe(1);
    expect(io.lastSnap('p1').minPlayers).toBe(MIN_PLAYERS_FOR_MATCH);
    expect(io.lastSnap('p1').canStart).toBe(false);

    // reaching the minimum makes a start POSSIBLE; it does not perform one.
    // The old auto-start fired on the very first tick after this join.
    room.addPlayer('p2', 'Bravo');
    vi.advanceTimersByTime(5000); // ~150 ticks of doing nothing about it
    expect(io.lastSnap('p1').phase).toBe('warmup');
    expect(room.info().phase).toBe('warmup');
    expect(io.lastSnap('p1').seated).toBe(2);
    expect(io.lastSnap('p1').canStart).toBe(true);
    expect(eventsOfType(io, 'p1', 'round_start').length).toBe(0);
    expect(io.lastSnap('p1').you.alive).toBe(true); // and warmup is still playable
    room.stop();
  });

  it('an explicit start from any seated player begins the round-1 freeze', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.start();
    vi.advanceTimersByTime(200);
    expect(io.lastSnap('p1').phase).toBe('warmup');

    // p2, not p1: there is no host — any seated player may start the match
    startMatch(room, 'p2');
    expect(room.info().phase).toBe('freeze'); // applied synchronously, not on a timer

    tick();
    expect(io.lastSnap('p1').phase).toBe('freeze');
    expect(io.lastSnap('p1').canStart).toBe(false); // out of the lobby: no longer startable
    expect(room.playerCount()).toBe(2);

    const starts = eventsOfType(io, 'p1', 'round_start');
    expect(starts.length).toBe(1);
    expect(starts[0]?.round).toBe(1);
    expect(starts[0]?.scoreT).toBe(0);
    expect(starts[0]?.scoreCT).toBe(0);
    expect(starts[0]?.freezeUntil).toBeGreaterThan(io.lastSnap('p1').serverTime - 3000);
    room.stop();
  });

  it('start below the minimum is ignored in silence, from a seat or from nobody', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();
    vi.advanceTimersByTime(200);
    expect(io.lastSnap('p1').canStart).toBe(false);

    startMatch(room, 'p1'); // solo: below MIN_PLAYERS_FOR_MATCH
    startMatch(room, 'ghost'); // not even in the room
    vi.advanceTimersByTime(200);

    expect(io.lastSnap('p1').phase).toBe('warmup');
    expect(room.info().phase).toBe('warmup');
    expect(eventsOfType(io, 'p1', 'round_start').length).toBe(0);
    expect(io.errors('p1').length).toBe(0); // ignored, never an error, never a throw
    room.stop();
  });

  it('a bot counts toward the minimum: solo + one bot may start', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();
    vi.advanceTimersByTime(200);
    expect(io.lastSnap('p1').canStart).toBe(false);

    expect(room.addBot()).not.toBeNull(); // bots hold real roster slots
    vi.advanceTimersByTime(200);
    expect(io.lastSnap('p1').phase).toBe('warmup'); // still no auto-start
    expect(io.lastSnap('p1').seated).toBe(2);
    expect(io.lastSnap('p1').canStart).toBe(true);

    startMatch(room, 'p1');
    tick();
    expect(io.lastSnap('p1').phase).toBe('freeze');
    room.stop();
  });

  it('dropping below the minimum re-disables start, and the wire state says so', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();
    expect(room.addBot()).not.toBeNull();
    vi.advanceTimersByTime(200);
    expect(io.lastSnap('p1').canStart).toBe(true);

    expect(room.removeBot()).toBe(true); // back down to a lone player
    tick();
    expect(io.lastSnap('p1').seated).toBe(1);
    expect(io.lastSnap('p1').canStart).toBe(false);

    startMatch(room, 'p1'); // and the start really is refused now
    vi.advanceTimersByTime(200);
    expect(io.lastSnap('p1').phase).toBe('warmup');
    expect(eventsOfType(io, 'p1', 'round_start').length).toBe(0);
    room.stop();
  });

  it('start outside warmup is ignored — freeze and live never restart the match', () => {
    const io = new FakeIO();
    const room = setupDuel(io); // seated and explicitly started

    advanceToPhase(io, 'p1', 'freeze');
    expect(io.lastSnap('p1').canStart).toBe(false);
    startMatch(room, 'p1');
    tick();
    expect(io.lastSnap('p1').phase).toBe('freeze');
    expect(eventsOfType(io, 'p1', 'round_start').length).toBe(1); // no second round 1

    advanceToPhase(io, 'p1', 'live');
    expect(io.lastSnap('p1').canStart).toBe(false);
    startMatch(room, 'p1');
    tick();
    expect(io.lastSnap('p1').phase).toBe('live');
    expect(eventsOfType(io, 'p1', 'round_start').length).toBe(1);
    expect(io.errors('p1').length).toBe(0);
    room.stop();
  });

  it('a finished match returns to warmup and STAYS there until someone starts again', () => {
    const io = new FakeIO();
    const room = setupDuel(io);

    // p1 throws every round: the other side takes winRounds and the match ends.
    // (halftime swaps sides and side-scores together, so the winner keeps its
    // tally across the swap and still gets there on round `winRounds`.)
    for (let r = 0; r < ROUNDS.winRounds; r++) {
      advanceToPhase(io, 'p2', 'live', 300);
      room.handleSuicide('p1');
      advanceToPhase(io, 'p2', 'roundEnd', 60);
      if (r < ROUNDS.winRounds - 1) advanceToPhase(io, 'p2', 'freeze', 300);
    }
    advanceToPhase(io, 'p2', 'matchEnd', 300);
    expect(eventsOfType(io, 'p2', 'match_end').length).toBe(1);
    expect(io.lastSnap('p2').canStart).toBe(false); // matchEnd is not the lobby

    // the post-match reset drops the room back into the lobby...
    advanceToPhase(io, 'p2', 'warmup', 300);
    expect(io.lastSnap('p2').seated).toBe(2);
    expect(io.lastSnap('p2').canStart).toBe(true);
    const startsAfterMatch = eventsOfType(io, 'p2', 'round_start').length;

    // ...and it sits there: no second match starts itself, however long we wait
    vi.advanceTimersByTime(10_000); // ~300 ticks
    expect(io.lastSnap('p2').phase).toBe('warmup');
    expect(room.info().phase).toBe('warmup');
    expect(eventsOfType(io, 'p2', 'round_start').length).toBe(startsAfterMatch);

    // only an explicit start opens match two, from round 1 with the scores clear
    startMatch(room, 'p2');
    tick();
    expect(io.lastSnap('p2').phase).toBe('freeze');
    const starts = eventsOfType(io, 'p2', 'round_start');
    expect(starts.length).toBe(startsAfterMatch + 1);
    expect(starts[starts.length - 1]?.round).toBe(1);
    expect(starts[starts.length - 1]?.scoreT).toBe(0);
    expect(starts[starts.length - 1]?.scoreCT).toBe(0);
    room.stop();
  }, 30_000);
});

describe('GameRoom combat + rounds', () => {
  it('elimination ends the round with the correct winner, score, and kill reward', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    const feed = new InputFeed();
    advanceToPhase(io, 'p1', 'live');

    fightUntilKill(room, io, feed, 'p1', 'p2');

    const kills = eventsOfType(io, 'p1', 'kill');
    expect(kills.length).toBe(1);
    expect(kills[0]?.killerId).toBe('p1');
    expect(kills[0]?.victimId).toBe('p2');
    expect(kills[0]?.weapon).toBe('pistol');
    expect(kills[0]?.headshot).toBe(false);

    // shooter got per-hit confirms, all full damage (fired well inside rangeStart)
    const hits = eventsOfType(io, 'p1', 'hit');
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.dmg).toBe(WEAPONS.pistol.damage);
    expect(hits[hits.length - 1]?.killed).toBe(true);
    // victim saw the damage direction at least once
    expect(eventsOfType(io, 'p2', 'dmg_taken').length).toBeGreaterThan(0);

    const winner = teamOf(io, 'p1');
    const ends = eventsOfType(io, 'p1', 'round_end');
    expect(ends.length).toBe(1);
    expect(ends[0]?.winner).toBe(winner);
    expect(ends[0]?.reason).toBe('elimination');
    expect(ends[0]?.scoreT).toBe(winner === 'T' ? 1 : 0);
    expect(ends[0]?.scoreCT).toBe(winner === 'CT' ? 1 : 0);

    // kill reward + win reward land on top of the starting money
    const ok = advanceUntil(() => io.lastSnap('p1').phase === 'roundEnd');
    expect(ok).toBe(true);
    expect(io.lastSnap('p1').you.money).toBe(ECONOMY.start + ECONOMY.killReward + ECONOMY.winReward);
    // first loss of the match: the escalating ladder pays its base rung
    expect(io.lastSnap('p2').you.money).toBe(ECONOMY.start + ECONOMY.lossRewardBase);
    room.stop();
  });

  it('warmup: a lone player stays in warmup and respawns after dying', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    const feed = new InputFeed();
    advanceToPhase(io, 'p2', 'live');

    fightUntilKill(room, io, feed, 'p2', 'p1');
    expect(eventsOfType(io, 'p2', 'kill').length).toBe(1);

    // p2 leaves: low-population abort drops the room straight back to warmup
    room.removePlayer('p2');
    advanceToPhase(io, 'p1', 'warmup');
    expect(io.lastSnap('p1').you.alive).toBe(false); // round-dead, waiting on the warmup timer

    // ~3s of solo ticking: never leaves warmup, and the respawn timer revives p1
    let respawned = false;
    for (let i = 0; i < 90; i++) {
      tick();
      const snap = io.lastSnap('p1');
      expect(snap.phase).toBe('warmup');
      if (snap.you.alive) respawned = true;
    }
    expect(respawned).toBe(true);
    expect(io.lastSnap('p1').you.hp).toBe(PLAYER.maxHp);
    expect(room.info().phase).toBe('warmup');
    room.stop();
  });
});

describe('GameRoom economy', () => {
  it('a buy is refused while broke and succeeds in freeze once round rewards land', () => {
    // Deliberately NOT a rifle any more. Under the escalating ladder one lost
    // round banks start + lossRewardBase = $2200, which is short of the $2700
    // rifle — that refusal is the intended balance, not a regression. What the
    // test is actually about survives: broke => refused, funded => bought.
    const io = new FakeIO();
    const room = setupDuel(io);
    const feed = new InputFeed();

    // freeze round 1: buy menu is open, the SMG is unaffordable on $800
    advanceToPhase(io, 'p2', 'freeze');
    room.handleBuy('p2', 'smg');
    const first = eventsOfType(io, 'p2', 'buy_result');
    expect(first.length).toBe(1);
    expect(first[0]?.ok).toBe(false);
    expect(first[0]?.reason).toBe('insufficient funds');
    expect(first[0]?.weapon).toBeNull();

    // p1 eliminates p2 in round 1: p2 banks the base rung of the loss ladder
    advanceToPhase(io, 'p1', 'live');
    fightUntilKill(room, io, feed, 'p1', 'p2');
    advanceToPhase(io, 'p2', 'freeze'); // round 2 freeze
    const banked = ECONOMY.start + ECONOMY.lossRewardBase;
    expect(io.lastSnap('p2').you.money).toBe(banked);

    // one lost round is NOT a rifle round any more
    room.handleBuy('p2', 'rifle');
    const denied = eventsOfType(io, 'p2', 'buy_result');
    expect(denied.length).toBe(2);
    expect(denied[1]?.ok).toBe(false);
    expect(denied[1]?.reason).toBe('insufficient funds');

    // ...but it does cover SMG + vest, with change to spare
    room.handleBuy('p2', 'smg');
    const results = eventsOfType(io, 'p2', 'buy_result');
    expect(results.length).toBe(3);
    expect(results[2]?.ok).toBe(true);
    expect(results[2]?.weapon).toBe('smg');
    expect(results[2]?.reason).toBeNull();
    room.handleMessage('p2', { t: 'buy_gear', item: 'kevlar' });
    expect(eventsOfType(io, 'p2', 'buy_result')[3]?.ok).toBe(true);

    tick(); // let a snapshot reflect the purchases
    const you = io.lastSnap('p2').you;
    expect(you.money).toBe(banked - WEAPONS.smg.price - GEAR.kevlarPrice);
    expect(you.money).toBeGreaterThanOrEqual(0);
    expect(you.weapons).toEqual(['pistol', 'knife', 'smg']); // held weapon stays first
    expect(you.weapon).toBe('pistol');
    expect(you.armor).toBe(GEAR.armorStart);
    expect(you.canBuy).toBe(true);
    room.stop();
  });

  it('gear: kevlar $650 ok at start; helmet needs funds + the vest; death drops gear', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    const feed = new InputFeed();

    // freeze round 1: kevlar is affordable on the $800 starting money
    advanceToPhase(io, 'p1', 'freeze');
    room.handleMessage('p1', { t: 'buy_gear', item: 'kevlar' });
    let results = eventsOfType(io, 'p1', 'buy_result');
    expect(results.length).toBe(1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.weapon).toBeNull(); // gear buys report weapon null
    expect(results[0]?.reason).toBeNull();

    tick(); // let a snapshot reflect the purchase
    let you = io.lastSnap('p1').you;
    expect(you.money).toBe(ECONOMY.start - GEAR.kevlarPrice);
    expect(you.armor).toBe(GEAR.armorStart);
    expect(you.helmet).toBe(false);

    // the vest leaves $150: the $1000 helmet is unaffordable
    room.handleMessage('p1', { t: 'buy_gear', item: 'helmet' });
    results = eventsOfType(io, 'p1', 'buy_result');
    expect(results.length).toBe(2);
    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.reason).toBe('insufficient funds');
    expect(results[1]?.weapon).toBeNull();

    // round 1: p1 eliminates p2 and banks kill + win rewards on top of the $150
    advanceToPhase(io, 'p1', 'live');
    fightUntilKill(room, io, feed, 'p1', 'p2');
    advanceToPhase(io, 'p1', 'freeze'); // round 2 freeze
    expect(io.lastSnap('p1').you.money).toBe(
      ECONOMY.start - GEAR.kevlarPrice + ECONOMY.killReward + ECONOMY.winReward,
    );

    // p1 survived (kevlar kept): the helmet buy now succeeds
    room.handleMessage('p1', { t: 'buy_gear', item: 'helmet' });
    results = eventsOfType(io, 'p1', 'buy_result');
    expect(results.length).toBe(3);
    expect(results[2]?.ok).toBe(true);
    expect(results[2]?.weapon).toBeNull();
    expect(results[2]?.reason).toBeNull();
    tick();
    you = io.lastSnap('p1').you;
    expect(you.helmet).toBe(true);
    expect(you.armor).toBe(GEAR.armorStart); // untouched in round 1, not refilled
    expect(you.money).toBe(
      ECONOMY.start - GEAR.kevlarPrice + ECONOMY.killReward + ECONOMY.winReward - GEAR.helmetPrice,
    );

    // p2 died in round 1 (death drops gear): its helmet buy is rejected even
    // though the loss reward covers the price — the vest must come first
    expect(io.lastSnap('p2').you.money).toBe(ECONOMY.start + ECONOMY.lossRewardBase);
    room.handleMessage('p2', { t: 'buy_gear', item: 'helmet' });
    const p2results = eventsOfType(io, 'p2', 'buy_result');
    expect(p2results.length).toBe(1);
    expect(p2results[0]?.ok).toBe(false);
    expect(p2results[0]?.reason).toBe('requires kevlar');
    expect(p2results[0]?.weapon).toBeNull();
    room.stop();
  });

  // --- escalating loss bonus (contract C2/C3) --------------------------------
  // The room owns two loss-streak counters that never reach the wire. They are
  // read BEFORE a round's result is applied, so the side that has already lost
  // twice is paid the third rung for losing the third. These tests read the
  // money curve through real rounds, which is the only place the wiring shows.

  it('consecutive losses climb the ladder, and halftime puts both sides back on the base rung', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    // p2 throws every round; p1's side takes them all
    const curve: number[] = [];
    for (let r = 0; r < ROUNDS.halftimeAfter + 1; r++) {
      loseRound(room, io, 'p1', ['p2']);
      curve.push(io.lastSnap('p2').you.money);
    }
    const gains = curve.map((m, i) => m - (i === 0 ? ECONOMY.start : (curve[i - 1] ?? 0)));
    expect(gains).toEqual([
      ECONOMY.lossRewardBase, // streak 0
      ECONOMY.lossRewardBase + ECONOMY.lossRewardStep, // streak 1
      ECONOMY.lossRewardBase + 2 * ECONOMY.lossRewardStep, // streak 2
      ECONOMY.lossRewardMax, // streak 3 — the cap
      ECONOMY.lossRewardMax, // streak 4, still capped
      ECONOMY.lossRewardBase, // round 6: halftime wiped the streak
    ]);
    room.stop();
  });

  it('a round win resets that side back to the base rung', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    loseRound(room, io, 'p1', ['p2']); // streak 0 -> base
    expect(io.lastSnap('p2').you.money).toBe(ECONOMY.start + ECONOMY.lossRewardBase);
    loseRound(room, io, 'p1', ['p2']); // streak 1 -> base + step
    const afterTwo = ECONOMY.start + 2 * ECONOMY.lossRewardBase + ECONOMY.lossRewardStep;
    expect(io.lastSnap('p2').you.money).toBe(afterTwo);

    loseRound(room, io, 'p2', ['p1']); // p2's side WINS this one
    expect(io.lastSnap('p2').you.money).toBe(afterTwo + ECONOMY.winReward);

    loseRound(room, io, 'p1', ['p2']); // back to losing: the streak restarted
    expect(io.lastSnap('p2').you.money).toBe(afterTwo + ECONOMY.winReward + ECONOMY.lossRewardBase);
    room.stop();
  });

  it('a draw pays both sides their own rung and climbs both streaks', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    loseRound(room, io, 'p1', ['p1', 'p2']); // mutual elimination
    const afterOne = ECONOMY.start + ECONOMY.lossRewardBase;
    expect(io.lastSnap('p1').you.money).toBe(afterOne);
    expect(io.lastSnap('p2').you.money).toBe(afterOne);
    expect(eventsOfType(io, 'p1', 'round_end')[0]?.winner).toBeNull();

    loseRound(room, io, 'p1', ['p1', 'p2']); // both were already on streak 1
    const afterTwo = afterOne + ECONOMY.lossRewardBase + ECONOMY.lossRewardStep;
    expect(io.lastSnap('p1').you.money).toBe(afterTwo);
    expect(io.lastSnap('p2').you.money).toBe(afterTwo);
    room.stop();
  });

  it('a fresh match starts both sides on the base rung again', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    // p2 loses enough rounds to be deep in the ladder, then p1 takes the match
    for (let r = 0; r < ROUNDS.winRounds; r++) loseRound(room, io, 'p1', ['p2']);
    advanceToPhase(io, 'p1', 'matchEnd');
    advanceToPhase(io, 'p1', 'warmup', 400); // fullReset 6s later
    expect(io.lastSnap('p2').you.money).toBe(ECONOMY.start);

    startMatch(room, 'p1');
    loseRound(room, io, 'p1', ['p2']);
    expect(io.lastSnap('p2').you.money).toBe(ECONOMY.start + ECONOMY.lossRewardBase);
    room.stop();
  });
});

describe('GameRoom armor absorb', () => {
  it('body splits hp/armor; head bypasses without helmet, splits with it', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    const feed = new InputFeed();

    // round 1 freeze: the victim-to-be buys the kevlar vest
    advanceToPhase(io, 'p2', 'freeze');
    room.handleMessage('p2', { t: 'buy_gear', item: 'kevlar' });
    expect(eventsOfType(io, 'p2', 'buy_result')[0]?.ok).toBe(true);
    tick();
    expect(io.lastSnap('p2').you.armor).toBe(GEAR.armorStart);

    // live: p1 fights with the knife — flat 40 dmg inside 2.2m, zero spread
    advanceToPhase(io, 'p1', 'live');
    room.handleSwitch('p1', 'knife');

    const knifeDmg = WEAPONS.knife.damage; // 40
    const headDmg = Math.round(knifeDmg * WEAPONS.knife.headshotMul); // 60
    const soak = (dmg: number): number => Math.round(dmg * GEAR.absorb);
    const through = (dmg: number): number => Math.round(dmg * (1 - GEAR.absorb));
    const hitsOn = (victim: PlayerId): Array<Extract<GameEvent, { t: 'hit' }>> =>
      eventsOfType(io, 'p1', 'hit').filter((h) => h.victimId === victim);

    // (1) body shot vs armor 100: hp and armor each soak half of the 40
    fightUntilHit(room, io, feed, 'p1', 'p2', { aimHeight: 0.75, fireDist: 1.8, strict: true });
    let you = io.lastSnap('p2').you;
    expect(you.hp).toBe(PLAYER.maxHp - through(knifeDmg)); // 80
    expect(you.armor).toBe(GEAR.armorStart - soak(knifeDmg)); // 80
    expect(you.helmet).toBe(false);
    let hits = hitsOn('p2');
    expect(hits.length).toBe(1);
    expect(hits[0]?.dmg).toBe(knifeDmg);
    expect(hits[0]?.headshot).toBe(false);
    expect(hits[0]?.killed).toBe(false);

    // (2) head shot with NO helmet: armor is bypassed — hp eats the full 60
    fightUntilHit(room, io, feed, 'p1', 'p2', {
      aimHeight: PLAYER.heightStand - 0.15,
      fireDist: 1.8,
      strict: true,
      headshot: true,
    });
    you = io.lastSnap('p2').you;
    expect(you.hp).toBe(PLAYER.maxHp - through(knifeDmg) - headDmg); // 20
    expect(you.armor).toBe(GEAR.armorStart - soak(knifeDmg)); // still 80
    hits = hitsOn('p2');
    expect(hits.length).toBe(2);
    expect(hits[1]?.dmg).toBe(headDmg);
    expect(hits[1]?.headshot).toBe(true);
    expect(hits[1]?.killed).toBe(false);

    // the victim survives and wins the round: kill + win rewards fund a helmet
    fightUntilKill(room, io, feed, 'p2', 'p1');
    advanceToPhase(io, 'p2', 'freeze'); // round 2 freeze
    room.handleMessage('p2', { t: 'buy_gear', item: 'helmet' });
    expect(eventsOfType(io, 'p2', 'buy_result')[1]?.ok).toBe(true);
    tick();
    const before = io.lastSnap('p2').you;
    expect(before.helmet).toBe(true);
    expect(before.hp).toBe(PLAYER.maxHp); // round reset heals hp (armor kept)

    // (3) the SAME head shot now splits like a body shot
    advanceToPhase(io, 'p1', 'live');
    room.handleSwitch('p1', 'knife'); // round death reset p1 to the pistol
    fightUntilHit(room, io, feed, 'p1', 'p2', {
      aimHeight: PLAYER.heightStand - 0.15,
      fireDist: 1.8,
      strict: true,
      headshot: true,
    });
    you = io.lastSnap('p2').you;
    expect(you.hp).toBe(before.hp - through(headDmg));
    expect(you.armor).toBe(before.armor - soak(headDmg));
    expect(you.helmet).toBe(true);
    hits = hitsOn('p2');
    expect(hits.length).toBe(3);
    expect(hits[2]?.dmg).toBe(headDmg);
    expect(hits[2]?.headshot).toBe(true);
    expect(hits[2]?.killed).toBe(false);
    room.stop();
  });
});

describe('GameRoom stats', () => {
  it('headshot kill lands in the roster; a quick follow-up kill broadcasts multikill 2', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.addPlayer('p3', 'Carol');
    room.start();
    startMatch(room, 'p1');
    const feed = new InputFeed();
    advanceToPhase(io, 'p1', 'live');

    // 3 players => 2v1: the lone player is the killer (a 1v1 kill would end the
    // round, and the streak resets at freeze — the follow-up needs a live round)
    const ids: PlayerId[] = ['p1', 'p2', 'p3'];
    const onTeam = (t: Team): PlayerId[] => ids.filter((id) => teamOf(io, id) === t);
    const solo = onTeam('T').length === 1 ? onTeam('T') : onTeam('CT');
    const killer = solo[0];
    if (killer === undefined) throw new Error('expected a solo player in a 2v1');
    const victims = ids.filter((id) => id !== killer);
    const v1 = victims[0];
    const v2 = victims[1];
    if (v1 === undefined || v2 === undefined) throw new Error('expected two victims in a 2v1');

    // kill 1: the killing blow must be a headshot — aim at the head-band center
    // (top 0.3m) from <= 4m, where even max spread (1.6 deg with one shot of
    // bloom => 0.11m) cannot leave the band; strict probing guarantees v1 eats it
    fightUntilKill(room, io, feed, killer, v1, {
      aimHeight: PLAYER.heightStand - 0.15,
      fireDist: 4,
      strict: true,
      headshot: true,
      lure: v2,
    });
    const kill1At = io.lastSnap(killer).serverTime;

    const kills = eventsOfType(io, killer, 'kill');
    expect(kills.length).toBe(1);
    expect(kills[0]?.killerId).toBe(killer);
    expect(kills[0]?.victimId).toBe(v1);
    expect(kills[0]?.weapon).toBe('pistol');
    expect(kills[0]?.headshot).toBe(true);

    // roster-carrying message: a fresh joiner's `joined` carries the full roster
    room.addPlayer('p4', 'Delta');
    const entry = io.joined('p4').roster.find((e) => e.id === killer);
    expect(entry?.kills).toBe(1);
    expect(entry?.headshots).toBe(1);

    // kill 2: v2 keeps converging on the killer (it was already being lured
    // during kill 1), so the follow-up lands well inside MULTIKILL_WINDOW no
    // matter which of the seven spawns the three players drew.
    fightUntilKill(room, io, feed, killer, v2, { cadence: 6, strict: true, lure: v2 });
    const kill2At = io.lastSnap(killer).serverTime;
    expect(kill2At - kill1At).toBeLessThanOrEqual(MULTIKILL_WINDOW * 1000);

    const multis = eventsOfType(io, killer, 'multikill');
    expect(multis.length).toBe(1);
    expect(multis[0]?.playerId).toBe(killer);
    expect(multis[0]?.count).toBe(2);
    room.stop();
  });
});

describe('GameRoom bots', () => {
  it('addBot rosters a teamed bot that patrols or engages; removeBot shrinks the room', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');

    const botId = room.addBot();
    if (botId === null) throw new Error('addBot returned null with a free slot');
    expect(room.botCount()).toBe(1);
    expect(room.playerCount()).toBe(2);

    // roster entry broadcast to the human: bot flag set, team auto-assigned
    const entry = eventsOfType(io, 'p1', 'player_joined')
      .map((e) => e.entry)
      .find((e) => e.id === botId);
    expect(entry?.bot).toBe(true);
    expect(entry?.team === 'T' || entry?.team === 'CT').toBe(true);

    room.start();
    startMatch(room, 'p1'); // 1 human + 1 bot = MIN_PLAYERS_FOR_MATCH, started by hand
    const feed = new InputFeed();
    advanceToPhase(io, 'p1', 'live');

    // spawn = where the round-1 freeze teleported the bot
    const spawn = io.lastSnap('p1').players.find((p) => p.id === botId);
    if (spawn === undefined) throw new Error('bot missing from snapshot');

    // ~10s of live with the human idle (heartbeat inputs only, never moves/fires).
    // roundTime is 100s, so no time-limit round end can teleport anyone mid-test.
    let maxDist = 0;
    for (let i = 0; i < 300; i++) {
      if (i % 30 === 0) feed.send(room, 'p1');
      tick();
      const b = io.lastSnap('p1').players.find((p) => p.id === botId);
      if (b !== undefined) maxDist = Math.max(maxDist, Math.hypot(b.x - spawn.x, b.z - spawn.z));
    }

    // patrol moves the bot; engaging the idle human makes it fire — either proves the brain runs
    const botShots = eventsOfType(io, 'p1', 'shot').filter((e) => e.shooterId === botId).length;
    const botHits = eventsOfType(io, 'p1', 'dmg_taken').filter((e) => e.fromId === botId).length;
    expect(
      maxDist > 1 || botShots > 0 || botHits > 0,
      `bot brain runs (moved ${maxDist.toFixed(2)}m from spawn, ${botShots} shots, ${botHits} hits on the human)`,
    ).toBe(true);

    expect(room.removeBot()).toBe(true);
    expect(room.botCount()).toBe(0);
    expect(room.playerCount()).toBe(1);
    room.stop();
  });

  it('a bot EQUIPS the primary it buys — a successful buy alone never re-arms it', () => {
    // THE DEFECT this guards. `handleBuy` re-equips only when the currently
    // HELD weapon leaves the owned list; a pistol is never replaced by a rifle,
    // so it stayed equipped. Combined with a BotCommand that had no weapon
    // field at all, a bot had no mechanism to ever change weapons: measured, two
    // bots completed 23 successful rifle/SMG purchases and the only weapon
    // either was ever seen holding was 'pistol'. Fixed by BotCommand.switchTo,
    // routed through the same handleSwitch a client's { t: 'switch' } hits.
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');
    const botId = room.addBot();
    if (botId === null) throw new Error('addBot returned null with a free slot');
    room.start();
    startMatch(room, 'p1');

    const botHolds = (): string | undefined =>
      io.lastSnap('p1').players.find((p) => p.id === botId)?.weapon;

    // Round 1 is a genuine pistol round: 800 start money buys no primary.
    advanceToPhase(io, 'p1', 'live');
    expect(botHolds()).toBe('pistol');

    // Hand round 1 to the bot's team. winReward 3250 on top of ECONOMY.start
    // 800 puts a rifle (2700) inside its budget for round 2's freeze. The
    // suicide leaves the bot alive, so it also keeps whatever it buys.
    room.handleMessage('p1', { t: 'suicide' });
    advanceToPhase(io, 'p1', 'roundEnd');
    advanceToPhase(io, 'p1', 'freeze');

    const feed = new InputFeed();
    const held = new Set<string>();
    for (let i = 0; i < 150; i++) {
      if (i % 30 === 0) feed.send(room, 'p1');
      tick();
      const w = botHolds();
      if (w !== undefined) held.add(w);
    }

    // Bought AND holding it. Holding is the whole assertion: ownership without
    // equipping is exactly the state the bug left every bot in.
    expect(botHolds()).toBe('rifle');
    expect(held.has('rifle')).toBe(true);
    room.stop();
  });

  it('kill_bots: both bots die in place (killerId null), human untouched, bots stay and respawn', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();
    vi.advanceTimersByTime(200); // settle into solo warmup
    expect(io.lastSnap('p1').phase).toBe('warmup');

    const b1 = room.addBot();
    const b2 = room.addBot();
    if (b1 === null || b2 === null) throw new Error('addBot returned null with free slots');
    expect(room.playerCount()).toBe(3);
    // seats never start a match: the room stays in warmup until someone asks
    expect(room.info().phase).toBe('warmup');

    room.handleMessage('p1', { t: 'kill_bots' });

    // both bots die through the normal death path: kill event with no killer
    const kills = eventsOfType(io, 'p1', 'kill');
    expect(kills.length).toBe(2);
    for (const k of kills) {
      expect(k.killerId).toBeNull();
      expect(k.weapon).toBe('knife');
      expect(k.headshot).toBe(false);
    }
    expect(new Set(kills.map((k) => k.victimId))).toEqual(new Set([b1, b2]));

    // the human is untouched: not killed, no damage direction shown
    expect(eventsOfType(io, 'p1', 'dmg_taken').length).toBe(0);
    expect(io.lastSnap('p1').you.alive).toBe(true);

    // the bots stay in the room — kill_bots is not a removal
    expect(room.botCount()).toBe(2);
    expect(room.playerCount()).toBe(3);

    // nobody started a match, so the room is still in warmup and the bots come
    // back on the normal warmup respawn timer. Advance past that delay: both
    // bots are alive again and nothing else died.
    vi.advanceTimersByTime(ROUNDS.warmupRespawnDelay * 1000 + 200);
    expect(io.lastSnap('p1').phase).toBe('warmup');
    const snap = io.lastSnap('p1');
    expect(snap.players.find((p) => p.id === b1)?.alive).toBe(true);
    expect(snap.players.find((p) => p.id === b2)?.alive).toBe(true);
    expect(snap.players.find((p) => p.id === 'p1')?.alive).toBe(true);
    expect(eventsOfType(io, 'p1', 'kill').length).toBe(2);
    room.stop();
  });
});

describe('GameRoom team switching', () => {
  it('warmup: a switch applies immediately — team_changed, roster, respawn on the new team', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();
    vi.advanceTimersByTime(200); // settle into solo warmup
    expect(io.lastSnap('p1').phase).toBe('warmup');

    const from = teamOf(io, 'p1');
    const to: Team = from === 'T' ? 'CT' : 'T';
    room.handleSwitchTeam('p1', to); // solo room: target 0 < own 1 + 1, guard passes

    // the broadcast is synchronous: one team_changed carrying the new team
    const changes = eventsOfType(io, 'p1', 'team_changed');
    expect(changes.length).toBe(1);
    expect(changes[0]?.id).toBe('p1');
    expect(changes[0]?.team).toBe(to);

    // respawned at the NEW team's spawns: placeAtSpawn sets exact spawn coords
    // and p1 never sends an input, so the body is never stepped off them
    tick();
    const self = io.lastSnap('p1').players.find((p) => p.id === 'p1');
    if (self === undefined) throw new Error('p1 missing from snapshot');
    expect(MAPS.dustbowl.spawns[to].some((s) => s.x === self.x && s.z === self.z)).toBe(true);

    // roster reflects the switch: a fresh joiner's `joined` carries it
    room.addPlayer('p2', 'Bravo');
    expect(io.joined('p2').roster.find((e) => e.id === 'p1')?.team).toBe(to);
    room.stop();
  });

  it('guard: in a 2v1 the solo player joining the 2-player team is denied team_full', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.addPlayer('p3', 'Carol');
    room.start();
    startMatch(room, 'p1');
    advanceToPhase(io, 'p1', 'freeze'); // 3 players => always 2v1

    const ids: PlayerId[] = ['p1', 'p2', 'p3'];
    const onTeam = (t: Team): PlayerId[] => ids.filter((id) => teamOf(io, id) === t);
    const soloTeam: Team = onTeam('T').length === 1 ? 'T' : 'CT';
    const solo = onTeam(soloTeam)[0];
    if (solo === undefined) throw new Error('expected a solo player in a 2v1');
    const bigTeam: Team = soloTeam === 'T' ? 'CT' : 'T';

    room.handleSwitchTeam(solo, bigTeam); // 2 >= 1 + 1: the balance guard must deny it

    // queued during the round: the room idles and the clock gives round 1 to
    // the bigger team (2 alive vs 1); the denial lands when the guard is
    // re-evaluated at round 2's beginFreeze — never a team_changed mid-round
    advanceToPhase(io, solo, 'roundEnd', 3500); // freeze 3s + live 100s on the clock
    expect(eventsOfType(io, solo, 'team_changed').length).toBe(0);
    advanceToPhase(io, solo, 'freeze'); // round 2: queued request re-evaluated, denied

    expect(io.errors(solo).filter((e) => e.code === 'team_full').length).toBe(1);

    // no team_changed for the denied request, and a fresh roster shows the old team
    for (const id of ids) {
      expect(eventsOfType(io, id, 'team_changed').filter((e) => e.id === solo).length).toBe(0);
    }
    room.addPlayer('p4', 'Delta');
    expect(io.joined('p4').roster.find((e) => e.id === solo)?.team).toBe(soloTeam);
    room.stop();
  });

  it('queued: a freeze/live switch request is applied at the next freeze', () => {
    const io = new FakeIO();
    const room = setupDuel(io); // p2 takes the team p1 didn't: always 1v1
    const feed = new InputFeed();
    advanceToPhase(io, 'p1', 'freeze');

    const to = teamOf(io, 'p2');
    room.handleSwitchTeam('p1', to); // 1 < 1 + 1: guard passes, queued for the next freeze

    advanceToPhase(io, 'p1', 'live'); // the whole round-1 freeze passed: nothing applied
    expect(eventsOfType(io, 'p1', 'team_changed').length).toBe(0);

    // p2 eliminates p1: round 1 ends and round 2's beginFreeze applies the switch
    fightUntilKill(room, io, feed, 'p2', 'p1');
    advanceToPhase(io, 'p1', 'freeze');

    // The switch is applied first and IS honoured. It leaves a 2v0, which the
    // freeze-time auto-balance immediately repairs by moving the OTHER player
    // (p2: same rank, joined later) to the empty side — 2v0 -> 1v1, and p1
    // still gets the team it asked for.
    const changes = eventsOfType(io, 'p1', 'team_changed');
    expect(changes.length).toBe(2);
    expect(changes[0]?.id).toBe('p1');
    expect(changes[0]?.team).toBe(to);
    expect(changes[1]?.id).toBe('p2');
    expect(changes[1]?.team).toBe(to === 'T' ? 'CT' : 'T');

    // round-2 freeze teleported p1 to a spawn of its NEW team
    const self = io.lastSnap('p1').players.find((p) => p.id === 'p1');
    if (self === undefined) throw new Error('p1 missing from snapshot');
    expect(MAPS.dustbowl.spawns[to].some((s) => s.x === self.x && s.z === self.z)).toBe(true);
    room.stop();
  });
});

describe('GameRoom suicide (console kill command)', () => {
  it('kills the sender (kill event, killerId null) and is ignored while dead', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    advanceToPhase(io, 'p1', 'live');

    room.handleMessage('p1', { t: 'suicide' }); // wire-level entry: parse + dispatch
    tick();

    const kills = eventsOfType(io, 'p1', 'kill');
    expect(kills.length).toBe(1);
    expect(kills[0]?.killerId).toBeNull();
    expect(kills[0]?.victimId).toBe('p1');
    expect(io.lastSnap('p1').you.alive).toBe(false);

    // a repeat while still dead (round not yet reset) is a no-op
    room.handleMessage('p1', { t: 'suicide' });
    tick();
    expect(eventsOfType(io, 'p1', 'kill').length).toBe(1);
    room.stop();
  });
});

// ---- 7v7 roster + spawn separation -------------------------------------------
// MAX_PLAYERS is 14, so a full room is 7 a side over 7 spawn points per side.
// That leaves zero slack: picking a spawn WITH REPLACEMENT (the old behaviour)
// collides teammates onto one point, i.e. two bodies inside one AABB.

const MAP_IDS: MapId[] = ['dustbowl', 'crossfire', 'office', 'frostbite', 'urbana', 'bunker'];

/** Closest two spawn points on one side — the hard floor any placement can hit. */
function minSpawnSeparation(mapId: MapId, team: Team): number {
  const list = MAPS[mapId].spawns[team];
  let m = Infinity;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a === undefined || b === undefined) continue;
      m = Math.min(m, Math.hypot(a.x - b.x, a.z - b.z));
    }
  }
  return m;
}

/** Seat `n` players in a fresh room and run it to the round-1 freeze wave. */
function seatRoom(mapId: MapId, n: number): { io: FakeIO; room: GameRoom; ids: PlayerId[] } {
  const io = new FakeIO();
  const room = new GameRoom(mapId, 'public', io);
  const ids: PlayerId[] = [];
  for (let i = 0; i < n; i++) {
    const id: PlayerId = `s${i}`;
    room.addPlayer(id, `Seat ${i}`);
    ids.push(id);
  }
  room.start();
  startMatch(room, 's0'); // seating a full room does not start it; a player must
  return { io, room, ids };
}

/** Spawn positions of every seated player at the room's current tick, by team. */
function positionsByTeam(io: FakeIO, ids: PlayerId[]): Record<Team, Array<{ x: number; z: number }>> {
  const first = ids[0];
  if (first === undefined) throw new Error('no seats');
  const snap = io.lastSnap(first);
  const out: Record<Team, Array<{ x: number; z: number }>> = { T: [], CT: [] };
  for (const id of ids) {
    const s = snap.players.find((p) => p.id === id);
    if (s === undefined) throw new Error(`${id} missing from snapshot`);
    out[teamOf(io, id)].push({ x: s.x, z: s.z });
  }
  return out;
}

/** Assert a placement wave: real spawn points, all distinct, never overlapping. */
function assertWave(mapId: MapId, spots: Record<Team, Array<{ x: number; z: number }>>, wave: number): void {
  for (const team of ['T', 'CT'] as Team[]) {
    const mine = spots[team];
    const points = MAPS[mapId].spawns[team];
    expect(mine.length, `${mapId} wave ${wave}: ${team} seat count`).toBe(MAX_PLAYERS / 2);
    // every body sits exactly on one of the side's spawn points
    for (const p of mine) {
      expect(
        points.some((s) => s.x === p.x && s.z === p.z),
        `${mapId} wave ${wave}: ${team} body at (${p.x}, ${p.z}) is a real spawn point`,
      ).toBe(true);
    }
    // 7 players over 7 points => every point used exactly once (the regression)
    const distinct = new Set(mine.map((p) => `${p.x},${p.z}`));
    expect(distinct.size, `${mapId} wave ${wave}: ${team} distinct spawn points`).toBe(mine.length);
    // and no pair closer than the separation target. 1.5m is the goal; where the
    // map's own two closest spawn points sit nearer than that (bunker: 0.80m),
    // that data-imposed floor is the best any placement can do.
    const floor = Math.min(1.5, minSpawnSeparation(mapId, team));
    let closest = Infinity;
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length; j++) {
        const a = mine[i];
        const b = mine[j];
        if (a === undefined || b === undefined) continue;
        closest = Math.min(closest, Math.hypot(a.x - b.x, a.z - b.z));
      }
    }
    expect(
      closest + 1e-9,
      `${mapId} wave ${wave}: closest ${team} teammates ${closest.toFixed(2)}m (floor ${floor.toFixed(2)}m)`,
    ).toBeGreaterThanOrEqual(floor);
  }
}

describe('GameRoom 7v7 roster', () => {
  it('14 players seat as 7v7; a 15th human is refused and bots find no slot', () => {
    const { io, room, ids } = seatRoom('dustbowl', MAX_PLAYERS);
    vi.advanceTimersByTime(200);

    expect(MAX_PLAYERS).toBe(14);
    expect(room.playerCount()).toBe(14);
    expect(room.info().maxPlayers).toBe(14);

    const teams = ids.map((id) => teamOf(io, id));
    expect(teams.filter((t) => t === 'T').length).toBe(7);
    expect(teams.filter((t) => t === 'CT').length).toBe(7);

    // full of humans: no bot to displace, so the join is refused outright
    room.addPlayer('overflow', 'Fifteen');
    expect(room.playerCount()).toBe(14);
    expect(() => io.joined('overflow')).toThrow();
    expect(room.addBot()).toBeNull();

    // a full room still runs the match, and everyone is placed
    expect(io.lastSnap('s0').phase).toBe('freeze');
    expect(io.lastSnap('s0').players.length).toBe(14);
    room.stop();
  });
});

describe('GameRoom spawn separation at 7v7', () => {
  // Every wave is a fresh room, so every wave draws a different rng seed
  // (roomSeq mixes into the seed). 50 waves x 6 maps = 300 independent 7v7
  // placements per run. Note the round-1 freeze is the adversarial case: all 14
  // bodies are already standing on spawn points from their drop-in placement,
  // so the wave has to re-seat everyone with every point already occupied.
  for (const mapId of MAP_IDS) {
    it(`${mapId}: 50 seeded 7v7 waves never double up a spawn point`, () => {
      for (let wave = 0; wave < 50; wave++) {
        const { io, room, ids } = seatRoom(mapId, MAX_PLAYERS);
        vi.advanceTimersByTime(120); // >= 3 ticks of the round-1 freeze seatRoom started
        expect(io.lastSnap('s0').phase).toBe('freeze');
        assertWave(mapId, positionsByTeam(io, ids), wave);
        room.stop();
      }
      // 50 rooms x 14 players is ~60ms unloaded, but the default 5s budget is
      // tight when the whole suite runs in parallel on a busy machine.
    }, 30_000);
  }

  it('a mid-match respawn wave (round 2, everyone dead) still hands out 14 distinct points', () => {
    const { io, room, ids } = seatRoom('bunker', MAX_PLAYERS);
    advanceToPhase(io, 's0', 'freeze');
    advanceToPhase(io, 's0', 'live');

    // mutual elimination: every body dies in place, so the round-2 wave starts
    // with no living teammate anywhere near a spawn point
    for (const id of ids) room.handleMessage(id, { t: 'suicide' });
    advanceToPhase(io, 's0', 'roundEnd');
    advanceToPhase(io, 's0', 'freeze', 300); // roundEnd is 4s => ~120 ticks

    expect(io.lastSnap('s0').you.alive).toBe(true);
    assertWave('bunker', positionsByTeam(io, ids), 2);
    room.stop();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Mid-round joins + freeze-time auto-balance.
// ---------------------------------------------------------------------------

/** Roster flag as it stood at the instant `id` joined (before any tick ran). */
function joinedPending(io: FakeIO, id: PlayerId): boolean {
  return io.joined(id).roster.find((e) => e.id === id)?.joiningNextRound === true;
}

/** Current team, following every team_changed anyone has seen for `id`. */
function liveTeam(io: FakeIO, watcher: PlayerId, id: PlayerId): Team {
  let team = teamOf(io, id);
  for (const ev of eventsOfType(io, watcher, 'team_changed')) {
    if (ev.id === id) team = ev.team;
  }
  return team;
}

describe('GameRoom mid-round join', () => {
  it('joining a live round seats you as a spectator, then spawns you at the next freeze', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    advanceToPhase(io, 'p1', 'live');

    room.addPlayer('p3', 'Charlie');
    // decided at the join instant, before any tick could have re-placed them
    expect(joinedPending(io, 'p3')).toBe(true);
    tick();

    // --- one coherent state: seated, spectating, NOT in the world -----------
    const you = io.lastSnap('p3').you;
    expect(you.alive).toBe(false);
    expect(you.joiningNextRound).toBe(true);
    expect(you.respawnAt).toBeNull(); // not "respawning": waiting for the round

    // told why, in words
    const notices = eventsOfType(io, 'p3', 'notice');
    expect(notices.length).toBe(1);
    expect(notices[0]?.code).toBe('joining_next_round');
    expect(notices[0]?.text.length).toBeGreaterThan(0);

    // seated on a team and on everyone's scoreboard, flagged as joining
    const joinEv = eventsOfType(io, 'p1', 'player_joined').find((e) => e.entry.id === 'p3');
    expect(joinEv?.entry.team === 'T' || joinEv?.entry.team === 'CT').toBe(true);
    expect(joinEv?.entry.joiningNextRound).toBe(true);
    expect(io.joined('p3').roster.length).toBe(3);

    // --- next freeze: a normal player, spawned on their team's spawns ------
    advanceToPhase(io, 'p1', 'roundEnd', 3500);
    advanceToPhase(io, 'p1', 'freeze', 300);

    const spawned = io.lastSnap('p3');
    expect(spawned.you.alive).toBe(true);
    expect(spawned.you.joiningNextRound).toBe(false);
    expect(spawned.you.canBuy).toBe(true); // full buy access, per the usual rules
    const self = spawned.players.find((p) => p.id === 'p3');
    if (self === undefined) throw new Error('p3 missing from the freeze snapshot');
    const team = liveTeam(io, 'p1', 'p3');
    expect(MAPS.dustbowl.spawns[team].some((s) => s.x === self.x && s.z === self.z)).toBe(true);
    // and everyone else can see them again
    expect(io.lastSnap('p1').players.some((p) => p.id === 'p3')).toBe(true);
    room.stop();
  });

  it('a mid-round joiner is absent from every snapshot, inert, and cannot be damaged', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    const feed = new InputFeed();
    advanceToPhase(io, 'p1', 'live');
    room.addPlayer('p3', 'Charlie');

    // hammer the joiner's inputs: full-forward + trigger held, for ~2s
    for (let i = 0; i < 60; i++) {
      tick();
      feed.send(room, 'p3', { moveZ: 1, buttons: INPUT_FIRE });
      // nobody, at any tick, sees the joiner in the world
      for (const watcher of ['p1', 'p2', 'p3'] as const) {
        expect(io.lastSnap(watcher).players.some((p) => p.id === 'p3')).toBe(false);
      }
    }
    // inert: no shot ever left their gun, and they still hold a full magazine
    expect(eventsOfType(io, 'p1', 'shot').some((e) => e.shooterId === 'p3')).toBe(false);
    expect(io.lastSnap('p3').you.mag).toBe(WEAPONS.pistol.mag);

    // a real fight runs to a kill while they spectate: never a target
    const victim = teamOf(io, 'p1') === teamOf(io, 'p2') ? null : 'p1';
    if (victim !== null) fightUntilKill(room, io, feed, 'p2', victim);
    expect(eventsOfType(io, 'p3', 'dmg_taken').length).toBe(0);
    expect(eventsOfType(io, 'p1', 'kill').some((e) => e.victimId === 'p3')).toBe(false);
    expect(io.lastSnap('p3').you.hp).toBe(0); // spectating, never "hurt" down to it
    room.stop();
  });

  it('joining during warmup still spawns you immediately', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha'); // one player: the room stays in warmup
    room.start();
    vi.advanceTimersByTime(200);
    expect(io.lastSnap('p1').phase).toBe('warmup');

    room.addPlayer('p2', 'Bravo');
    expect(joinedPending(io, 'p2')).toBe(false); // placed at the join instant
    tick();

    expect(io.lastSnap('p2').you.alive).toBe(true);
    expect(io.lastSnap('p2').you.joiningNextRound).toBe(false);
    expect(eventsOfType(io, 'p2', 'notice').length).toBe(0);
    expect(io.lastSnap('p1').players.some((p) => p.id === 'p2')).toBe(true);
    room.stop();
  });

  it('joining during a freeze also spawns immediately — freeze IS the next round', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    advanceToPhase(io, 'p1', 'freeze');

    room.addPlayer('p3', 'Charlie');
    expect(joinedPending(io, 'p3')).toBe(false);
    tick();
    expect(io.lastSnap('p3').phase).toBe('freeze');
    expect(io.lastSnap('p3').you.alive).toBe(true);
    expect(io.lastSnap('p3').you.canBuy).toBe(true);
    expect(io.lastSnap('p1').players.some((p) => p.id === 'p3')).toBe(true);
    room.stop();
  });

  it('a spectating joiner never blocks elimination or the round clock', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    const feed = new InputFeed();
    advanceToPhase(io, 'p1', 'live');
    room.addPlayer('p3', 'Charlie');
    tick();

    // p1 dies; its team is now empty of LIVING players, so the round must end
    // even though the pending joiner may be seated on that same team.
    room.handleSuicide('p1');
    const ended = advanceUntil(() => io.lastSnap('p1').phase === 'roundEnd', 60);
    expect(ended).toBe(true);
    feed.send(room, 'p2');
    room.stop();
  });
});

describe('GameRoom auto-balance', () => {
  /** n humans, then `bots` bots, all seated during warmup (no ticks yet). */
  function seatMixed(nHumans: number, nBots: number): { io: FakeIO; room: GameRoom; bots: PlayerId[] } {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    for (let i = 0; i < nHumans; i++) room.addPlayer(`h${i}`, `Human ${i}`);
    const bots: PlayerId[] = [];
    for (let i = 0; i < nBots; i++) {
      const id = room.addBot();
      if (id === null) throw new Error('bot slot refused');
      bots.push(id);
    }
    return { io, room, bots };
  }

  function idsOn(io: FakeIO, all: PlayerId[], team: Team): PlayerId[] {
    return all.filter((id) => teamOf(io, id) === team);
  }

  it('repairs a roster gone lopsided through leavers, at the next freeze, and says why', () => {
    const { io, room } = seatMixed(6, 0);
    const all = ['h0', 'h1', 'h2', 'h3', 'h4', 'h5'];
    const big: Team = idsOn(io, all, 'T').length >= 3 ? 'T' : 'CT';
    const small: Team = big === 'T' ? 'CT' : 'T';
    // 3v3 -> 3v1 by two leavers on one side: pickTeam never sees this happen
    for (const id of idsOn(io, all, small).slice(0, 2)) room.removePlayer(id);
    const remaining = all.filter((id) => io.errors(id).length === 0);
    expect(idsOn(io, remaining, big).length).toBe(3);

    room.start();
    const survivor = idsOn(io, all, small)[2] ?? 'h0';
    startMatch(room, survivor);
    advanceToPhase(io, survivor, 'freeze');

    const watcher = idsOn(io, all, big)[0] as PlayerId;
    const changes = eventsOfType(io, watcher, 'team_changed');
    expect(changes.length).toBe(1); // one move: 3v1 -> 2v2, never an overshoot
    expect(changes[0]?.team).toBe(small);

    // the mover is the most recently joined player of the oversized team
    const bigIds = idsOn(io, all, big);
    expect(changes[0]?.id).toBe(bigIds[bigIds.length - 1]);

    // and they are told, personally, that it happened and why
    const moved = changes[0]?.id as PlayerId;
    const notices = eventsOfType(io, moved, 'notice').filter((n) => n.code === 'team_rebalanced');
    expect(notices.length).toBe(1);
    expect(notices[0]?.text).toContain(small);
    room.stop();
  });

  it('prefers moving a bot over a human, even a more recently joined human', () => {
    // pickTeam fills the smaller side and coin-flips ties, so an even seat count
    // is always balanced: the two bots split one per side, and the two late
    // humans (joined AFTER the bots) also split one per side.
    const { io, room, bots } = seatMixed(4, 2); // 3v3
    room.addPlayer('late0', 'Late Zero');
    room.addPlayer('late1', 'Late One'); // 4v4
    const b0 = bots[0] as PlayerId;
    const all = ['h0', 'h1', 'h2', 'h3', ...bots, 'late0', 'late1'];
    const big = teamOf(io, b0);
    const small: Team = big === 'T' ? 'CT' : 'T';
    // the oversized side really does hold a human who joined after the bot,
    // so "most recently joined" alone would NOT pick the bot
    expect(idsOn(io, ['late0', 'late1'], big).length).toBe(1);
    for (const id of idsOn(io, all, small).slice(0, 3)) room.removePlayer(id); // 4v1

    room.start();
    const watcher = idsOn(io, all, big)[0] as PlayerId;
    startMatch(room, watcher);
    advanceToPhase(io, watcher, 'freeze');

    const changes = eventsOfType(io, watcher, 'team_changed');
    expect(changes.length).toBe(1); // 4v1 -> 3v2
    expect(changes[0]?.id).toBe(b0); // the bot went, not the newer human
    room.stop();
  });

  it('leaves a roster that is already within one player alone', () => {
    const { io, room } = seatMixed(3, 0);
    room.start();
    startMatch(room, 'h0');
    advanceToPhase(io, 'h0', 'freeze'); // 2v1: nothing to repair
    expect(eventsOfType(io, 'h0', 'team_changed').length).toBe(0);
    expect(eventsOfType(io, 'h0', 'notice').length).toBe(0);
    room.stop();
  });

  it('does not move the same player two freezes in a row when another candidate exists', () => {
    const { io, room } = seatMixed(8, 0);
    const all = ['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'];
    const big: Team = idsOn(io, all, 'T').length >= 4 ? 'T' : 'CT';
    const small: Team = big === 'T' ? 'CT' : 'T';
    const smallIds = idsOn(io, all, small);
    room.removePlayer(smallIds[0] as PlayerId);
    room.removePlayer(smallIds[1] as PlayerId); // 4v2
    const survivors = [smallIds[2] as PlayerId, smallIds[3] as PlayerId];

    room.start();
    const watcher = survivors[0] as PlayerId;
    startMatch(room, watcher);
    advanceToPhase(io, watcher, 'freeze');
    const firstMove = eventsOfType(io, watcher, 'team_changed')[0]?.id;
    expect(firstMove).toBeDefined(); // round 1: 4v2 -> 3v3

    // now shrink the OTHER side, so the team holding the round-1 mover is the
    // oversized one at round 2's freeze — with untouched candidates on it too
    const bigLeft = idsOn(io, all, big).filter((id) => id !== firstMove);
    room.removePlayer(bigLeft[0] as PlayerId);
    room.removePlayer(bigLeft[1] as PlayerId); // 1v3
    advanceToPhase(io, watcher, 'roundEnd', 3500);
    advanceToPhase(io, watcher, 'freeze', 300);

    const moves = eventsOfType(io, watcher, 'team_changed');
    expect(moves.length).toBe(2); // exactly one more move: 1v3 -> 2v2
    expect(moves[1]?.id).not.toBe(firstMove); // ping-pong avoided
    expect(survivors).toContain(moves[1]?.id); // an untouched candidate went
    room.stop();
  });
});

// ---------------------------------------------------------------------------
// C5 — end-of-match stats. damageDealt / shotsFired / shotsHit are siblings of
// kills/deaths/headshots on PlayerState, and only `match_end` puts them on the
// wire. These tests read them off the room directly so a single hit can be
// weighed exactly, and the last test proves the wire shape end to end.
// ---------------------------------------------------------------------------

/** The six per-match counters, read straight off the room's PlayerState. */
interface MatchCounters {
  kills: number;
  deaths: number;
  headshots: number;
  damageDealt: number;
  shotsFired: number;
  shotsHit: number;
}

/** applyDamage is private; the guard tests call it with crafted participants. */
interface RoomInternals {
  players: Map<PlayerId, MatchCounters & { hp: number; alive: boolean; team: Team }>;
  applyDamage(victim: unknown, shooter: unknown, hit: ShotHit, def: WeaponDef, now: number): number;
}

function internals(room: GameRoom): RoomInternals {
  return room as unknown as RoomInternals;
}

function statsOf(room: GameRoom, id: PlayerId): MatchCounters {
  const p = internals(room).players.get(id);
  if (p === undefined) throw new Error(`no player ${id} in the room`);
  return p;
}

function expectZeroed(room: GameRoom, id: PlayerId): void {
  const s = statsOf(room, id);
  expect(
    [s.kills, s.deaths, s.headshots, s.damageDealt, s.shotsFired, s.shotsHit],
    `every counter of ${id} is zeroed`,
  ).toEqual([0, 0, 0, 0, 0, 0]);
}

/**
 * Exactly ONE trigger pull, aimed by default at the sky (nothing to hit): the
 * FIRE edge, then release, then enough idle ticks to clear the fire interval of
 * any weapon in the table (0.9s for the shotgun).
 */
function pullTrigger(
  room: GameRoom,
  feed: InputFeed,
  id: PlayerId,
  opts: { pitch?: number; gapTicks?: number } = {},
): void {
  const pitch = opts.pitch ?? 1.4; // straight up, well inside the +-1.45 clamp
  feed.send(room, id, { pitch, buttons: INPUT_FIRE });
  tick();
  feed.send(room, id, { pitch, buttons: 0 });
  for (let i = 0; i < (opts.gapTicks ?? 7); i++) tick();
}

describe('GameRoom match stats (C5)', () => {
  it('damageDealt is the HP the victim actually lost, through every armor path', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    const feed = new InputFeed();

    const knifeDmg = WEAPONS.knife.damage; // 40
    const headDmg = Math.round(knifeDmg * WEAPONS.knife.headshotMul); // 60
    const through = (dmg: number): number => Math.round(dmg * (1 - GEAR.absorb));
    const hpOf = (id: PlayerId): number => io.lastSnap(id).you.hp;
    const dealt = (): number => statsOf(room, 'p1').damageDealt;

    // ---- (1) NO VEST: the whole roll lands on hp, and all of it is credited --
    advanceToPhase(io, 'p1', 'live');
    room.handleSwitch('p1', 'knife'); // flat 40 inside 2.2m, zero spread
    fightUntilHit(room, io, feed, 'p1', 'p2', { aimHeight: 0.75, fireDist: 1.8, strict: true });
    expect(hpOf('p2')).toBe(PLAYER.maxHp - knifeDmg); // 60
    expect(dealt()).toBe(knifeDmg);

    // ---- OVERKILL: finishing p2 credits the HP that was there, not the roll --
    // p2 started the round at 100 and p1 is its only source of damage, so once
    // p2 is dead p1 must be credited exactly 100 however the 100 was taken —
    // while the weapon ROLLS (the `hit` events) add up to strictly more.
    room.handleSwitch('p1', 'pistol'); // the knife's 2.2m reach cannot chase a runner
    fightUntilKill(room, io, feed, 'p1', 'p2', { strict: true });
    expect(dealt()).toBe(PLAYER.maxHp);
    const rolled = eventsOfType(io, 'p1', 'hit')
      .filter((h) => h.victimId === 'p2')
      .reduce((sum, h) => sum + h.dmg, 0);
    expect(rolled).toBeGreaterThan(PLAYER.maxHp); // the last hit over-rolled...
    expect(dealt()).toBeLessThan(rolled); // ...and the overkill was NOT credited

    // ---- (2) VEST: the vest's share is not damage dealt --------------------
    advanceToPhase(io, 'p2', 'freeze'); // round 2
    room.handleMessage('p2', { t: 'buy_gear', item: 'kevlar' });
    expect(eventsOfType(io, 'p2', 'buy_result')[0]?.ok).toBe(true);
    tick();
    expect(io.lastSnap('p2').you.armor).toBe(GEAR.armorStart);

    advanceToPhase(io, 'p1', 'live');
    room.handleSwitch('p1', 'knife'); // the round death reset p1 to the pistol
    let before = dealt();
    let hpBefore = hpOf('p2');
    fightUntilHit(room, io, feed, 'p1', 'p2', { aimHeight: 0.75, fireDist: 1.8, strict: true });
    expect(hpBefore - hpOf('p2')).toBe(through(knifeDmg)); // 20 of the 40
    expect(dealt() - before).toBe(through(knifeDmg)); // credited 20, NOT 40

    // ---- (3) HEADSHOT, NO HELMET: armor is bypassed, so all 60 is credited --
    before = dealt();
    hpBefore = hpOf('p2');
    fightUntilHit(room, io, feed, 'p1', 'p2', {
      aimHeight: PLAYER.heightStand - 0.15,
      fireDist: 1.8,
      strict: true,
      headshot: true,
    });
    expect(hpBefore - hpOf('p2')).toBe(headDmg);
    expect(dealt() - before).toBe(headDmg);

    // the victim survives and wins the round: kill + win rewards fund a helmet
    fightUntilKill(room, io, feed, 'p2', 'p1');
    advanceToPhase(io, 'p2', 'freeze'); // round 3
    room.handleMessage('p2', { t: 'buy_gear', item: 'helmet' });
    expect(eventsOfType(io, 'p2', 'buy_result')[1]?.ok).toBe(true);
    tick();
    expect(io.lastSnap('p2').you.helmet).toBe(true);

    // ---- (4) HEADSHOT + HELMET: the same head shot now splits like a body one
    advanceToPhase(io, 'p1', 'live');
    room.handleSwitch('p1', 'knife');
    before = dealt();
    hpBefore = hpOf('p2');
    fightUntilHit(room, io, feed, 'p1', 'p2', {
      aimHeight: PLAYER.heightStand - 0.15,
      fireDist: 1.8,
      strict: true,
      headshot: true,
    });
    expect(hpBefore - hpOf('p2')).toBe(through(headDmg)); // 30 of the 60
    expect(dealt() - before).toBe(through(headDmg));
    room.stop();
  }, 60_000);

  it('the shotgun counts PULLS, not pellets: 9 pellets in a blast are one fired, one hit', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    const feed = new InputFeed();
    expect(WEAPONS.shotgun.pellets).toBeGreaterThan(1); // the premise of the test

    // round 1: p2 throws it, so p1 banks the win reward and can afford the gun
    loseRound(room, io, 'p1', ['p2']);
    advanceToPhase(io, 'p1', 'freeze');
    room.handleMessage('p1', { t: 'buy', weapon: 'shotgun' });
    expect(eventsOfType(io, 'p1', 'buy_result').pop()?.ok).toBe(true);
    room.handleSwitch('p1', 'shotgun');
    advanceToPhase(io, 'p1', 'live');
    expect(io.lastSnap('p1').you.weapon).toBe('shotgun');

    // ---- a blast that lands NOTHING: one fired, zero hit -------------------
    const beforeSky = { ...statsOf(room, 'p1') };
    pullTrigger(room, feed, 'p1', { pitch: 1.4, gapTicks: 30 }); // at the sky
    expect(statsOf(room, 'p1').shotsFired - beforeSky.shotsFired).toBe(1);
    expect(statsOf(room, 'p1').shotsHit - beforeSky.shotsHit).toBe(0);

    // ---- the blast that kills: MANY pellets, still exactly ONE hit ---------
    const before = { ...statsOf(room, 'p1') };
    const hitsBefore = eventsOfType(io, 'p1', 'hit').length;
    // cadence 30 ticks (~1.0s) clears the shotgun's 0.9s fire interval, so every
    // pull the driver takes is a real one rather than a silently gated no-op
    fightUntilKill(room, io, feed, 'p1', 'p2', { fireDist: 6, cadence: 30, strict: true });
    const after = statsOf(room, 'p1');
    const pelletHits = eventsOfType(io, 'p1', 'hit').length - hitsBefore;
    const pulls = after.shotsFired - before.shotsFired;
    const landed = after.shotsHit - before.shotsHit;

    expect(landed).toBe(1); // ONE pull landed: the killing blast
    expect(pelletHits).toBeGreaterThan(1); // ...and it was several pellets
    expect(pelletHits).toBeGreaterThan(landed); // the pellet count is NOT the hit count
    expect(pulls).toBeGreaterThanOrEqual(landed); // hits can never exceed pulls
    expect(after.shotsHit).toBeLessThanOrEqual(after.shotsFired); // accuracy <= 100%
    // the blast rolled 9 x 14 = 126 into a 100 hp player: only 100 is credited
    expect(after.damageDealt).toBe(PLAYER.maxHp);
    room.stop();
  }, 60_000);

  it('a pull dropped on an empty magazine increments neither counter', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    const feed = new InputFeed();
    advanceToPhase(io, 'p1', 'live');

    const mag = WEAPONS.pistol.mag; // 12
    for (let i = 0; i < mag; i++) pullTrigger(room, feed, 'p1');
    expect(io.lastSnap('p1').you.mag).toBe(0);
    expect(statsOf(room, 'p1').shotsFired).toBe(mag);
    const shotEvents = eventsOfType(io, 'p1', 'shot').length;
    expect(shotEvents).toBe(mag); // one wire `shot` per counted pull

    // the trigger is pulled twice more on a dead-empty magazine
    pullTrigger(room, feed, 'p1');
    pullTrigger(room, feed, 'p1');
    expect(io.lastSnap('p1').you.mag).toBe(0);
    expect(statsOf(room, 'p1').shotsFired).toBe(mag); // dropped, not fired
    expect(statsOf(room, 'p1').shotsHit).toBe(0);
    expect(eventsOfType(io, 'p1', 'shot').length).toBe(shotEvents); // no shot went out
    room.stop();
  }, 30_000);

  it('self- and team damage move neither damageDealt nor shotsHit', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    for (const id of ['p1', 'p2', 'p3', 'p4']) room.addPlayer(id, id.toUpperCase());
    room.start();
    startMatch(room, 'p1');
    advanceToPhase(io, 'p1', 'live');

    const mate = (['p2', 'p3', 'p4'] as PlayerId[]).find((id) => teamOf(io, id) === teamOf(io, 'p1'));
    const foe = (['p2', 'p3', 'p4'] as PlayerId[]).find((id) => teamOf(io, id) !== teamOf(io, 'p1'));
    if (mate === undefined || foe === undefined) throw new Error('expected a 2v2');

    const room2 = internals(room);
    const shooter = room2.players.get('p1');
    const friend = room2.players.get(mate);
    const enemy = room2.players.get(foe);
    if (shooter === undefined || friend === undefined || enemy === undefined) throw new Error('missing players');
    // far past every spawn-protection window; the 10s below never kill anyone
    const now = io.lastSnap('p1').serverTime + 60_000;
    const probe = (victimId: PlayerId): ShotHit => ({
      targetId: victimId, dmg: 10, headshot: false, point: { x: 0, y: 0, z: 0 }, dist: 1,
    });

    // ---- team damage: it still LANDS, it simply earns the shooter nothing ---
    const friendHp = friend.hp;
    expect(room2.applyDamage(friend, shooter, probe(mate), WEAPONS.knife, now)).toBe(0);
    expect(friend.hp).toBe(friendHp - 10); // accounting-only guard, not a damage veto
    expect(shooter.damageDealt).toBe(0);
    expect(shooter.shotsHit).toBe(0);

    // ---- self damage: same ------------------------------------------------
    const selfHp = shooter.hp;
    expect(room2.applyDamage(shooter, shooter, probe('p1'), WEAPONS.knife, now)).toBe(0);
    expect(shooter.hp).toBe(selfHp - 10);
    expect(shooter.damageDealt).toBe(0);
    expect(shooter.shotsHit).toBe(0);

    // ---- the control: the identical call against an ENEMY does credit ------
    expect(room2.applyDamage(enemy, shooter, probe(foe), WEAPONS.knife, now)).toBe(10);
    expect(shooter.damageDealt).toBe(10);

    // ---- and a suicide is not damage dealt by anyone -----------------------
    const beforeDeaths = shooter.deaths;
    room.handleSuicide('p1');
    expect(shooter.deaths).toBe(beforeDeaths + 1);
    expect(shooter.damageDealt).toBe(10); // unmoved by its own death
    room.stop();
  }, 30_000);

  it('reset: warmup practice never lands in the match that follows', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.start();
    const feed = new InputFeed();
    tick();
    expect(io.lastSnap('p1').phase).toBe('warmup');

    fightUntilKill(room, io, feed, 'p1', 'p2'); // warmup is fully playable
    const warm = statsOf(room, 'p1');
    expect(warm.kills).toBe(1);
    expect(warm.damageDealt).toBeGreaterThan(0);
    expect(warm.shotsFired).toBeGreaterThan(0);
    expect(warm.shotsHit).toBeGreaterThan(0);
    expect(statsOf(room, 'p2').deaths).toBe(1);

    startMatch(room, 'p1'); // match one begins from a clean scoreboard
    expectZeroed(room, 'p1');
    expectZeroed(room, 'p2');
    room.stop();
  }, 30_000);

  it('reset: the lobby return after a match clears the scoreboard', () => {
    const io = new FakeIO();
    const room = setupDuel(io);

    for (let r = 0; r < ROUNDS.winRounds; r++) {
      advanceToPhase(io, 'p2', 'live', 300);
      room.handleSuicide('p1');
      advanceToPhase(io, 'p2', 'roundEnd', 60);
      if (r < ROUNDS.winRounds - 1) advanceToPhase(io, 'p2', 'freeze', 300);
    }
    advanceToPhase(io, 'p2', 'matchEnd', 300);
    // the match ends with the scoreboard still standing — that IS the end screen
    expect(statsOf(room, 'p1').deaths).toBe(ROUNDS.winRounds);
    const ended = eventsOfType(io, 'p2', 'match_end');
    expect(ended.length).toBe(1);
    expect(ended[0]?.stats.find((s) => s.id === 'p1')?.deaths).toBe(ROUNDS.winRounds);

    advanceToPhase(io, 'p2', 'warmup', 300); // fullReset, 6s later
    expectZeroed(room, 'p1');
    expectZeroed(room, 'p2');
    room.stop();
  }, 60_000);

  it('reset: a low-population abort clears the scoreboard too', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    const feed = new InputFeed();
    advanceToPhase(io, 'p1', 'live');
    fightUntilKill(room, io, feed, 'p1', 'p2');
    expect(statsOf(room, 'p1').kills).toBe(1);
    expect(statsOf(room, 'p1').damageDealt).toBe(PLAYER.maxHp);

    room.removePlayer('p2'); // 1 seated < MIN_PLAYERS_FOR_MATCH: the match collapses
    advanceToPhase(io, 'p1', 'warmup', 300);
    expectZeroed(room, 'p1');
    room.stop();
  }, 30_000);

  it('match_end carries every player, both teams, in the server order', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    const feed = new InputFeed();

    // one real round so the two lines are not identical: p1 frags, p2 does not
    advanceToPhase(io, 'p1', 'live');
    fightUntilKill(room, io, feed, 'p1', 'p2');
    advanceToPhase(io, 'p1', 'roundEnd', 60);
    // then p1 throws the rest away and the other side takes the match
    for (let r = 0; r < ROUNDS.winRounds; r++) {
      advanceToPhase(io, 'p2', 'freeze', 300);
      advanceToPhase(io, 'p2', 'live', 300);
      room.handleSuicide('p1');
      advanceToPhase(io, 'p2', 'roundEnd', 60);
    }
    advanceToPhase(io, 'p2', 'matchEnd', 300);

    const ev = eventsOfType(io, 'p2', 'match_end')[0];
    if (ev === undefined) throw new Error('no match_end');
    expect(ev.stats.length).toBe(2); // EVERY player present, not a top-3 slice
    expect(new Set(ev.stats.map((s) => s.id))).toEqual(new Set(['p1', 'p2']));
    expect(new Set(ev.stats.map((s) => s.team))).toEqual(new Set(['T', 'CT'])); // both sides
    // both recipients get the identical, server-ordered list
    expect(eventsOfType(io, 'p1', 'match_end')[0]?.stats).toEqual(ev.stats);

    // ordering: kills DESC, then damage DESC, then deaths ASC
    for (let i = 1; i < ev.stats.length; i++) {
      const a = ev.stats[i - 1];
      const b = ev.stats[i];
      if (a === undefined || b === undefined) throw new Error('sparse stats');
      expect(a.kills).toBeGreaterThanOrEqual(b.kills);
      if (a.kills === b.kills) expect(a.damage).toBeGreaterThanOrEqual(b.damage);
    }
    const p1 = ev.stats.find((s) => s.id === 'p1');
    const p2 = ev.stats.find((s) => s.id === 'p2');
    expect(ev.stats[0]?.id).toBe('p1'); // the only fragger sorts first
    expect(p1?.name).toBe('Alpha');
    expect(p1?.kills).toBe(1);
    expect(p1?.damage).toBe(PLAYER.maxHp);
    expect(p1?.deaths).toBe(ROUNDS.winRounds); // six suicides
    expect(p1?.shotsFired).toBeGreaterThan(0);
    expect(p1?.shotsHit).toBeGreaterThan(0);
    expect(p1?.shotsHit).toBeLessThanOrEqual(p1?.shotsFired ?? 0);
    // p2 never pulled a trigger: the client renders accuracy as '—', and the
    // server sends no float for it to divide by zero on
    expect(p2?.shotsFired).toBe(0);
    expect(p2?.shotsHit).toBe(0);
    expect(p2?.damage).toBe(0);
    expect(p2?.deaths).toBe(1);
    expect(Object.keys(ev).sort()).toEqual(['scoreCT', 'scoreT', 'stats', 't', 'winner']);
    room.stop();
  }, 60_000);
});
