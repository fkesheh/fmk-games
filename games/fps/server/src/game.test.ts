// ============================================================================
// T1 — GameRoom (S2) integration tests over a fake RoomIO. The room's own
// setInterval is driven by vi fake timers (which also fake Date.now), rttMs()
// is 0, and crafted fire inputs are aimed from real snapshot state against the
// same dustbowl solids the server sim uses — fully deterministic.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ECONOMY, INPUT_FIRE, MAPS, MULTIKILL_WINDOW, PLAYER, WEAPONS, boxToAABB, hitscan } from '@fps/shared';
import type { C2S, GameEvent, HitscanTarget, PlayerId, RoomPhase, S2C, Team, Vec3 } from '@fps/shared';
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

function setupDuel(io: FakeIO): GameRoom {
  const room = new GameRoom('dustbowl', 'public', io);
  room.addPlayer('p1', 'Alpha');
  room.addPlayer('p2', 'Bravo');
  room.start();
  return room;
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
    const pitch = Math.atan2(dy, dist);

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

describe('GameRoom stats', () => {
  it('headshot kill lands in the roster; a quick follow-up kill broadcasts multikill 2', () => {
    const io = new FakeIO();
    const room = new GameRoom('dustbowl', 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.addPlayer('p3', 'Carol');
    room.start();
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

    // kill 2: v2 was lured to the fight, so it dies well inside MULTIKILL_WINDOW
    fightUntilKill(room, io, feed, killer, v2, { cadence: 6, strict: true });
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
    const feed = new InputFeed();
    advanceToPhase(io, 'p1', 'live'); // 1 human + 1 bot = MIN_PLAYERS_FOR_MATCH

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

    const changes = eventsOfType(io, 'p1', 'team_changed');
    expect(changes.length).toBe(1);
    expect(changes[0]?.id).toBe('p1');
    expect(changes[0]?.team).toBe(to);

    // round-2 freeze teleported p1 to a spawn of its NEW team
    const self = io.lastSnap('p1').players.find((p) => p.id === 'p1');
    if (self === undefined) throw new Error('p1 missing from snapshot');
    expect(MAPS.dustbowl.spawns[to].some((s) => s.x === self.x && s.z === self.z)).toBe(true);
    room.stop();
  });
});
