// ============================================================================
// T1 — GameRoom (S2) integration tests over a fake RoomIO. The room's own
// setInterval is driven by vi fake timers (which also fake Date.now), rttMs()
// is 0, and crafted fire inputs are aimed from real snapshot state against the
// same dustbowl solids the server sim uses — fully deterministic.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ECONOMY, INPUT_FIRE, MAPS, PLAYER, WEAPONS, boxToAABB, hitscan } from '@fps/shared';
import type { C2S, GameEvent, PlayerId, RoomPhase, S2C, Team, Vec3 } from '@fps/shared';
import { GameRoom } from './game.js';
import type { RoomIO } from './game.js';

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

function setupDuel(io: FakeIO): GameRoom {
  const room = new GameRoom('dustbowl', 'public', io);
  room.addPlayer('p1', 'Alpha');
  room.addPlayer('p2', 'Bravo');
  room.start();
  return room;
}

function advanceToPhase(io: FakeIO, id: PlayerId, phase: RoomPhase): void {
  const ok = advanceUntil(() => io.lastSnap(id).phase === phase);
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

/**
 * Drive `shooter` until `target` dies: BFS-path toward the target (repath when
 * wedged or stale), stand and fire the pistol at the chest whenever the shared
 * hitscan says the line is clear at <= 12m. Throws if the budget runs out.
 */
function fightUntilKill(room: GameRoom, io: FakeIO, feed: InputFeed, shooter: PlayerId, target: PlayerId): void {
  let lastX = 0;
  let lastZ = 0;
  let stuck = 0;
  let path: Array<{ x: number; z: number }> = [];
  let pathIdx = 0;
  let lastPathAt = -1000;
  for (let i = 0; i < 2500; i++) {
    const snap = io.lastSnap(shooter);
    const me = snap.players.find((p) => p.id === shooter);
    const tgt = snap.players.find((p) => p.id === target);
    if (me === undefined || tgt === undefined) throw new Error('snapshot missing duel players');
    if (!tgt.alive) return;

    const eye: Vec3 = { x: me.x, y: me.y + PLAYER.heightStand - PLAYER.eyeOffset, z: me.z };
    const chest: Vec3 = { x: tgt.x, y: tgt.y + 0.75, z: tgt.z };
    const dx = chest.x - eye.x;
    const dy = chest.y - eye.y;
    const dz = chest.z - eye.z;
    const dist = Math.hypot(dx, dz) || 1e-9;
    const len = Math.hypot(dx, dy, dz) || 1e-9;
    const dir: Vec3 = { x: dx / len, y: dy / len, z: dz / len };
    const clear =
      hitscan(eye, dir, [{ id: 'tgt', x: tgt.x, y: tgt.y, z: tgt.z, height: PLAYER.heightStand }], SOLIDS, 200) !== null;
    // input yaw/pitch so the server's aimDir(yaw,pitch) equals `dir`
    let yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, dist);

    const moved = Math.hypot(me.x - lastX, me.z - lastZ);
    lastX = me.x;
    lastZ = me.z;
    const walking = !(clear && dist <= 12);
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
    if (clear && dist <= 12 && snap.you.mag > 0 && i % 8 === 0) {
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
    tick();
  }
  throw new Error('fight did not resolve within the tick budget');
}

function teamOf(io: FakeIO, id: PlayerId): Team {
  return io.joined(id).team;
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

describe('GameRoom phase flow', () => {
  it('stays in warmup solo; a second player flips it to freeze (round 1) within a few ticks', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();

    vi.advanceTimersByTime(200);
    expect(io.lastSnap('p1').phase).toBe('warmup'); // < MIN_PLAYERS_FOR_MATCH
    expect(room.info().phase).toBe('warmup');

    room.addPlayer('p2', 'Bravo');
    vi.advanceTimersByTime(200);
    expect(io.lastSnap('p1').phase).toBe('freeze');
    expect(room.info().phase).toBe('freeze');
    expect(room.playerCount()).toBe(2);

    const starts = eventsOfType(io, 'p1', 'round_start');
    expect(starts.length).toBe(1);
    expect(starts[0]?.round).toBe(1);
    expect(starts[0]?.scoreT).toBe(0);
    expect(starts[0]?.scoreCT).toBe(0);
    expect(starts[0]?.freezeUntil).toBeGreaterThan(io.lastSnap('p1').serverTime - 3000);
    room.stop();
  });
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
    expect(io.lastSnap('p2').you.money).toBe(ECONOMY.start + ECONOMY.lossReward);
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
  it('rifle at $800 fails insufficient funds; succeeds in freeze after round rewards', () => {
    const io = new FakeIO();
    const room = setupDuel(io);
    const feed = new InputFeed();

    // freeze round 1: buy menu is open, rifle is unaffordable on starting money
    advanceToPhase(io, 'p2', 'freeze');
    room.handleBuy('p2', 'rifle');
    const first = eventsOfType(io, 'p2', 'buy_result');
    expect(first.length).toBe(1);
    expect(first[0]?.ok).toBe(false);
    expect(first[0]?.reason).toBe('insufficient funds');
    expect(first[0]?.weapon).toBeNull();

    // p1 eliminates p2 in round 1: p2 banks start + lossReward = exactly a rifle
    advanceToPhase(io, 'p1', 'live');
    fightUntilKill(room, io, feed, 'p1', 'p2');
    advanceToPhase(io, 'p2', 'freeze'); // round 2 freeze

    room.handleBuy('p2', 'rifle');
    const results = eventsOfType(io, 'p2', 'buy_result');
    expect(results.length).toBe(2);
    expect(results[1]?.ok).toBe(true);
    expect(results[1]?.weapon).toBe('rifle');
    expect(results[1]?.reason).toBeNull();

    tick(); // let a snapshot reflect the purchase
    const you = io.lastSnap('p2').you;
    expect(you.money).toBe(ECONOMY.start + ECONOMY.lossReward - WEAPONS.rifle.price);
    expect(you.weapons).toEqual(['pistol', 'knife', 'rifle']); // held weapon stays first
    expect(you.weapon).toBe('pistol');
    expect(you.canBuy).toBe(true);
    room.stop();
  });
});
