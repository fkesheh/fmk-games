import { describe, expect, it } from 'vitest';
// ============================================================================
// SUMO room tests — the server-authoritative loop driven through a FAKE
// RoomIO and an injected virtual clock (no setInterval, no Date.now).
// Covers: join/leave/bot-fill, input seq acks, snapshot shape + per-tick
// cadence, phone-pad frames resolved via io.padOwner, KO stats attribution
// including the 3s pusher-window expiry, and round end via elimination and
// via the shrink timer.
//
// NOTE on shared wire objects: the room binds ONE pooled events array into
// every snapshot and clears it after each broadcast (kart precedent — real
// sends JSON-encode synchronously). The harness therefore deep-copies each
// tick's snapshot before the next tick runs.
// ============================================================================
import { COUNTDOWN_S, MAX_PLAYERS, ROUND_SHRINK_S, SIM_DT } from '@sumo/shared';
import type { SumoEvent, SumoSnapMsg } from '@sumo/shared';
import type { PlayerId, RoomIO, StatsDelta } from '@platform/shared';
import { SumoRoom } from './room.js';

const TICK_MS = 1000 / 30;

/** Records everything the room broadcasts/pays out; maps pad sessions. */
class FakeIO implements RoomIO {
  readonly sent: Array<{ id: PlayerId; msg: Record<string, unknown> }> = [];
  readonly stats: Array<{ playerId: PlayerId; delta: StatsDelta }> = [];
  readonly padOwnerMap = new Map<PlayerId, PlayerId>();

  send(id: PlayerId, msg: unknown): void {
    // The real Session.send JSON-encodes SYNCHRONOUSLY (platform/server
    // net.ts), and the room reuses + CLEARS its pooled wire objects after the
    // broadcast — so a faithful fake must snapshot the message here, not at
    // read time.
    this.sent.push({ id, msg: JSON.parse(JSON.stringify(msg)) as Record<string, unknown> });
  }

  rttMs(): number {
    return 0;
  }

  profileId(): string {
    return ''; // anonymous: reportStats records but the lobby would no-op
  }

  reportStats(playerId: PlayerId, delta: StatsDelta): void {
    this.stats.push({ playerId, delta });
  }

  padOwner(padSessionId: PlayerId): PlayerId | null {
    return this.padOwnerMap.get(padSessionId) ?? null;
  }
}

interface Harness {
  io: FakeIO;
  room: SumoRoom;
  nowMs(): number;
  advance(ms: number): void;
}

function harness(): Harness {
  let now = 1_000_000;
  const io = new FakeIO();
  const room = new SumoRoom('public', io, () => now);
  return { io, room, nowMs: () => now, advance: (ms: number) => (now += ms) };
}

type Snap = SumoSnapMsg;

interface Capture {
  /** One deep copy per tick (when a snap was addressed to listenId). */
  snaps: Snap[];
  /** Flattened deep copies of every event seen across those ticks. */
  events: SumoEvent[];
}

function lastSnapFor(h: Harness, id: PlayerId): Snap | null {
  for (let i = h.io.sent.length - 1; i >= 0; i--) {
    const m = h.io.sent[i];
    if (m !== undefined && m.id === id && m.msg.t === 'snap') return m.msg as unknown as Snap;
  }
  return null;
}

/** Advance `ticks` simulated ticks, capturing snaps/events for listenId. */
function drive(h: Harness, listenId: PlayerId, ticks: number, before?: (i: number) => void): Capture {
  const out: Capture = { snaps: [], events: [] };
  for (let i = 0; i < ticks; i++) {
    before?.(i);
    h.advance(TICK_MS);
    h.room.tickOnce();
    const snap = lastSnapFor(h, listenId);
    if (snap !== null) {
      // send() already deep-copied — safe to retain and read any time.
      out.snaps.push(snap);
      for (const ev of snap.events) out.events.push(ev);
    }
  }
  return out;
}

/** Seat the given humans, roll the countdown, and confirm 'live'. */
function seatAndGoLive(h: Harness, ids: readonly PlayerId[]): void {
  ids.forEach((id, i) => h.room.addPlayer(id, `P${i + 1}`));
  h.room.tickOnce(); // warmup tick -> countdown
  drive(h, ids[0] as string, Math.ceil(COUNTDOWN_S / SIM_DT) + 2);
  expect(h.room.info().phase).toBe('live');
}

let inputSeq = 100;
function sendInput(h: Harness, id: PlayerId, mx: number, mz: number, bits = 0): void {
  inputSeq += 1;
  h.room.handleMessage(id, { t: 'input', seq: inputSeq, mx, mz, bits });
}

describe('join / leave / bot fill', () => {
  it('keeps an empty room empty (born-empty rooms do not sumo themselves)', () => {
    const h = harness();
    h.room.tickOnce();
    expect(h.room.playerCount()).toBe(0);
    expect(h.room.info().phase).toBe('warmup');
  });

  it('fills to >= 2 with a bot when a lone human joins, and unwinds it', () => {
    const h = harness();
    h.room.addPlayer('p1', 'Alice');
    h.room.tickOnce();
    expect(h.room.playerCount()).toBe(2); // Alice + one bot
    const roster = lastSnapFor(h, 'p1');
    expect(roster?.players.length).toBe(2);
    expect(roster?.players.some((pl) => pl.id.startsWith('bot-'))).toBe(true);

    h.room.addPlayer('p2', 'Bob'); // second human: the bot is surplus now
    h.room.tickOnce();
    expect(h.room.playerCount()).toBe(2);
    const names = lastSnapFor(h, 'p1')?.players.map((pl) => pl.id).sort();
    expect(names).toEqual(['p1', 'p2']);
  });

  it('seats debug_bot requests up to the MAX_PLAYERS cap', () => {
    const h = harness();
    h.room.addPlayer('p1', 'Alice');
    for (let i = 0; i < MAX_PLAYERS + 3; i++) h.room.handleMessage('p1', { t: 'debug_bot' });
    expect(h.room.playerCount()).toBe(MAX_PLAYERS);
  });

  it('handles explicit leave and re-seats a bot for the next arrival', () => {
    const h = harness();
    h.room.addPlayer('p1', 'Alice');
    h.room.addPlayer('p2', 'Bob');
    h.room.tickOnce();
    expect(h.room.playerCount()).toBe(2);
    h.room.removePlayer('p1', true);
    h.room.removePlayer('p2', true);
    h.room.tickOnce();
    expect(h.room.playerCount()).toBe(0);
    expect(h.room.info().phase).toBe('warmup');
    h.room.addPlayer('p3', 'Cara');
    h.room.tickOnce();
    expect(h.room.playerCount()).toBe(2); // p3 + fresh bot
  });
});

describe('input seq acks', () => {
  it('echoes the newest consumed seq as you.ack and drops stale replays', () => {
    const h = harness();
    seatAndGoLive(h, ['p1', 'p2']);
    sendInput(h, 'p1', 0, 1); // seq 101
    sendInput(h, 'p1', 0, 1); // seq 102
    sendInput(h, 'p1', 1, 0); // seq 103
    h.advance(TICK_MS);
    h.room.tickOnce();
    const snap = lastSnapFor(h, 'p1');
    expect(snap?.you.ack).toBe(inputSeq); // 103 consumed
    expect(snap?.you.seq).toBe(inputSeq); // echo of the newest QUEUED seq
    // stale replay: below the monotonic gate -> queued nowhere, ack unmoved
    h.room.handleMessage('p1', { t: 'input', seq: inputSeq - 1, mx: 0, mz: 0, bits: 0 });
    h.advance(TICK_MS);
    h.room.tickOnce();
    expect(lastSnapFor(h, 'p1')?.you.ack).toBe(inputSeq);
  });
});

describe('snapshot shape + cadence', () => {
  it('sends exactly one snap per tick with the frozen field sets', () => {
    const h = harness();
    h.room.addPlayer('p1', 'Alice');
    h.room.addPlayer('p2', 'Bob');
    h.room.tickOnce();
    const cap = drive(h, 'p1', 10);
    expect(cap.snaps.length).toBe(10);

    const s = cap.snaps[0] as Snap;
    expect(s.t).toBe('snap');
    expect(Object.keys(s).sort()).toEqual(
      ['events', 'phase', 'phaseEndsAt', 'players', 'radius', 'round', 'serverTime', 't', 'tick', 'wins', 'you'],
    );
    expect(Object.keys(s.you).sort()).toEqual(['ack', 'cooldowns', 'seq', 'vy', 'x', 'y', 'z']);
    expect(Object.keys(s.you.cooldowns)).toEqual(['dash']);
    expect(s.players.length).toBe(2);
    expect(Object.keys(s.players[0] as object).sort()).toEqual(
      ['alive', 'color', 'dashing', 'id', 'name', 'vy', 'x', 'y', 'yaw', 'z'],
    );
    expect(s.wins.length).toBe(2);
    expect(Object.keys(s.wins[0] as object).sort()).toEqual(['id', 'name', 'wins']);
    expect(Array.isArray(s.events)).toBe(true);
    expect(s.radius).toBeGreaterThan(0);
  });

  it('mirrors joined identity: roomId/code/you/roster with colors', () => {
    const h = harness();
    h.room.addPlayer('p1', 'Alice');
    const joined = h.io.sent.find((m) => m.id === 'p1' && m.msg.t === 'sumo_joined');
    expect(joined).toBeDefined();
    const msg = joined?.msg as Record<string, unknown>;
    expect(msg['you']).toBe('p1');
    expect(msg['roomId']).toBe(h.room.id);
    expect(msg['code']).toBeNull(); // public room
    expect(Array.isArray(msg['players'])).toBe(true);
  });
});

describe('knockout credit', () => {
  it('credits {"sumo.ko":1} to the ring-out pusher and pays the round win', () => {
    const h = harness();
    seatAndGoLive(h, ['p1', 'p2']); // p1 spawns at +x rim, p2 opposite
    // p1 thunders straight through p2 and out the far side.
    const cap = drive(h, 'p1', Math.round(30 / SIM_DT), () => sendInput(h, 'p1', -1, 0));
    const ko = cap.events.find((ev) => ev.kind === 'ko');
    expect(ko).toMatchObject({ kind: 'ko', victim: 'p2', by: 'p1' });
    const roundEnd = cap.events.find((ev) => ev.kind === 'round_end');
    expect(roundEnd).toMatchObject({ kind: 'round_end', winner: 'p1', draw: false });
    expect(h.io.stats).toContainEqual({ playerId: 'p1', delta: { 'sumo.ko': 1 } });
    expect(h.io.stats).toContainEqual({ playerId: 'p1', delta: { 'sumo.win': 1 } });
    expect(h.io.stats.some((s) => 'sumo.self' in s.delta)).toBe(false);
    // The round-end broadcast was a results snap; the 30s window has long
    // since looped back through countdown, so check the captured history.
    expect(cap.snaps.some((s) => s.phase === 'results')).toBe(true);
  }, 20_000);

  it('expires the 3s pusher window: a late self-walk pays {"sumo.self":1}', () => {
    const h = harness();
    seatAndGoLive(h, ['p1', 'p2']);
    // Phase A: p1 walks into p2 (~1.7s to cross the 15.4u gap; contact stamps
    // the pusher window), then PARKS with explicit neutral frames — intents
    // are latest-wins, so silence alone would never stop him.
    drive(h, 'p1', Math.round(2.2 / SIM_DT), () => sendInput(h, 'p1', -1, 0));
    drive(h, 'p1', Math.round(0.4 / SIM_DT), () => sendInput(h, 'p1', 0, 0));
    // Phase B: p2 wiggles in place for >3s — no re-contact, window lapses.
    drive(h, 'p1', Math.round(3.6 / SIM_DT), (i) => {
      sendInput(h, 'p2', Math.floor(i / 15) % 2 === 0 ? 1 : -1, 0);
    });
    // Phase C: p2 (spawned on the -x rim) strolls off the shrinking edge.
    const cap = drive(h, 'p1', Math.round(6 / SIM_DT), () => sendInput(h, 'p2', -1, 0));
    const ko = cap.events.find((ev) => ev.kind === 'ko' && ev.victim === 'p2');
    expect(ko).toBeDefined();
    expect(ko?.kind === 'ko' ? ko.by : undefined).toBeNull(); // unattributed
    expect(h.io.stats).toContainEqual({ playerId: 'p2', delta: { 'sumo.self': 1 } });
    expect(h.io.stats.some((s) => 'sumo.ko' in s.delta)).toBe(false);
  }, 20_000);

  it('ends the round on the shrink timer, crowning the most centered survivor', () => {
    const h = harness();
    seatAndGoLive(h, ['p1', 'p2']);
    // Park BOTH inside the final 4u radius so nobody falls before the timer:
    // p1 walks straight in from +7.7 and brakes near the middle; p2 takes a
    // slanted lane (keeps ~3u clear of p1) ending at dist ~3.3 < radius 4.
    drive(h, 'p1', Math.round(0.97 / SIM_DT), () => sendInput(h, 'p1', -1, 0));
    drive(h, 'p1', Math.round(0.8 / SIM_DT), () => sendInput(h, 'p1', 0, 0));
    drive(h, 'p1', Math.round(0.95 / SIM_DT), () => sendInput(h, 'p2', 1, 0.38));
    drive(h, 'p1', Math.round(0.8 / SIM_DT), () => sendInput(h, 'p2', 0, 0));
    const cap = drive(h, 'p1', Math.round((ROUND_SHRINK_S + 2) / SIM_DT));
    const roundEnd = cap.events.find((ev) => ev.kind === 'round_end');
    expect(roundEnd).toMatchObject({ kind: 'round_end', winner: 'p1', draw: false });
    expect(h.io.stats).toContainEqual({ playerId: 'p1', delta: { 'sumo.win': 1 } });
    expect(h.io.stats.filter((s) => 'sumo.ko' in s.delta || 'sumo.self' in s.delta).length).toBe(0);
  }, 20_000);
});

describe('phone pads (io.padOwner)', () => {
  it('applies a bound pad_input frame to its owner every tick', () => {
    const h = harness();
    seatAndGoLive(h, ['p1', 'p2']);
    h.io.padOwnerMap.set('pad-sess-1', 'p1');
    const zBefore = lastSnapFor(h, 'p1')?.you.z ?? 0;
    // Left stick fully forward (ly = -1 => mz = +1) with a DASH press.
    h.room.handleMessage('pad-sess-1', {
      t: 'pad_input',
      seq: 900,
      lx: 0,
      ly: -1,
      rx: 0,
      ry: 0,
      buttons: 1,
    });
    drive(h, 'p1', 12);
    const snap = lastSnapFor(h, 'p1');
    expect((snap?.you.z ?? 0)).toBeGreaterThan(zBefore + 1); // moved +z, fast
    expect(snap?.you.ack).toBe(900); // pad frames ack through the same channel

    // Unbound pad sessions are inert (no owner => no seat => no motion): the
    // rogue frame must not touch p1's x, which the sticky pad stick never
    // steers (lx = 0).
    h.room.handleMessage('rogue-pad', { t: 'pad_input', seq: 1, lx: 1, ly: 0, rx: 0, ry: 0, buttons: 0 });
    drive(h, 'p1', 6);
    expect(Math.abs((lastSnapFor(h, 'p1')?.you.x ?? 0) - (snap?.you.x ?? 0))).toBeLessThan(3);
  });
});
