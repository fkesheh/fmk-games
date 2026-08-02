// ============================================================================
// FROZEN CONTRACT — KART GP: wire types. See docs/KART.md.
// ============================================================================

import type { KartSim } from './sim.js';
import type { TrackId } from './track.js';

export type KartPhase = 'lobby' | 'ready' | 'countdown' | 'racing' | 'results';

/**
 * One tick of driver intent. THE ONLY THING A CLIENT MAY ASSERT about its kart
 * — this message replaced `kart_state`, which carried absolute world
 * coordinates the server copied in verbatim. Positions are now derived, never
 * received: the server integrates shared/sim.ts stepDrive from this stream, so
 * "teleport to the next gate" is not a message that exists.
 *
 * `seq` is per-client monotonic and increments once per SIM_DT of client sim
 * time; the server echoes the last one it consumed as you.lastProcessedSeq,
 * which is what the client replays from. `dt` is the sim time this input
 * accounts for (honest clients always send SIM_DT) — it is clamped to
 * [SIM_DT_MIN, SIM_DT_MAX] on arrival and bounded in aggregate by
 * SIM_BUDGET_MUL of real time.
 */
export interface KartInputMsg {
  t: 'kart_input';
  seq: number; // per-client monotonic, +1 per sim tick
  throttle: number; // 0..1
  brake: number; // 0..1 (also reverses from standstill)
  steer: number; // -1..1 (positive = RIGHT)
  drift: boolean; // handbrake held
  respawn: boolean; // R / kids-mode stuck recovery: teleport to the last gate
  dt: number; // sim seconds this input covers
}

/** Room-level messages (platform lobby handles join/leave/list itself). */
export type KartC2S =
  | KartInputMsg
  | { t: 'nitro' } // consume one nitro charge (NITRO_CHARGES per race)
  /**
   * Explicit lobby start (frozen lobby contract, identical in every game): the
   * room NEVER auto-starts. Accepted only while the phase is 'lobby' AND at
   * least MIN_PLAYERS are seated; ignored silently otherwise. ANY seated player
   * may send it — KART has no host.
   */
  | { t: 'start' };

export interface KartPlayerInfo {
  id: string;
  name: string;
  slot: number; // grid slot (join order)
  color: number; // index into KART_COLORS (shared/palette)
}

export interface KartPlayerSnap extends KartPlayerInfo {
  p: [number, number, number];
  yaw: number;
  v: [number, number];
  steer: number;
  drift: boolean;
  lap: number; // 1-based current lap
  nextGate: number; // next expected gate index (0 == start/finish)
  progress: number; // (lap-1)*GATES + nextGate
  place: number; // 1-based race position
  finished: boolean;
  finishMs: number; // race time at finish, -1 while racing
  nitroActive: boolean; // currently boosting (remote flame/skid visual)
}

export interface KartYou {
  lap: number;
  nextGate: number;
  progress: number;
  place: number;
  finished: boolean;
  finishMs: number;
  bestLapMs: number; // -1 until a lap completes
  nitroLeft: number; // charges remaining this race (NITRO_CHARGES at GO)
  gapAheadMs: number; // est. ms behind the player one place ahead; 0 for the leader
  /**
   * Ack: the last kart_input seq the server actually consumed for THIS player.
   * The client drops everything up to it and replays the rest on top of `sim`.
   *
   * It is a WATERMARK, NOT A COUNT of inputs simulated: when a client's backlog
   * overruns INPUT_QUEUE_CAP the server drops from the FRONT, so the ack can
   * step over seqs that were never integrated. That is exactly what the client
   * needs — everything at or below it is settled, one way or another, and
   * re-basing on `sim` is what makes the dropped ones harmless — but nothing
   * downstream may treat `lastProcessedSeq` as "how much I have simulated".
   */
  lastProcessedSeq: number;
  /**
   * The server's authoritative sim state for this player at `lastProcessedSeq`
   * — the full KartSim, not just a position, because the replay has to restart
   * from the same gear/shift/drift/anchor the server was in or the two peers
   * integrate different karts. Per-recipient (never in the shared roster), so
   * it costs one block per snapshot, not one per player per player.
   */
  sim: KartSim;
}

/**
 * One driver's line in the championship table. Every driver who has SAT in the
 * room this season has a row, including one who has left (they keep their
 * points, as in F1) and one who joined a moment ago on zero.
 */
export interface KartStandingRow {
  id: string;
  name: string;
  /** Championship position after the tie-break; 1-based, ascending in the array. */
  pos: number;
  /** Season total after the most recently SCORED round. */
  points: number;
  /**
   * Points scored in the most recently scored round — the "+18" the results
   * screen shows next to the total. 0 for a DNF, an absentee, or before any
   * round has been scored.
   */
  delta: number;
  /** Race wins this season (the tie-break's first countback rung). */
  wins: number;
  /** Best (lowest) finishing place this season; 0 = has never finished a race. */
  bestFinish: number;
  /** Still seated in the room right now (a departed driver keeps their row). */
  here: boolean;
  /** The round this driver first appeared in — 1-based. > 1 means mid-season. */
  joinedRound: number;
}

/**
 * The room's championship, mirrored onto every snapshot. `null` on a room
 * booked with `{ championship: false }` — that room behaves exactly as it did
 * before championships existed and the client renders nothing extra.
 */
export interface KartSeason {
  /**
   * 1-based round. During 'results' this is the round that was just SCORED;
   * in every other phase it is the round about to be raced. (The room advances
   * it on the way back to the lobby, together with the circuit.)
   */
  round: number;
  rounds: number; // total rounds this season
  trackId: TrackId; // circuit of `round`
  nextTrackId: TrackId | null; // circuit of round+1; null on the final round
  /** The final round has been scored: `standings` is final and `championId` is set. */
  over: boolean;
  championId: string | null;
  /** Sorted by `pos` ascending (points desc, then the documented tie-break). */
  standings: KartStandingRow[];
}

export type RaceEvent =
  | { kind: 'countdown'; n: number } // 3,2,1
  | { kind: 'go' }
  | { kind: 'gate'; playerId: string; gate: number }
  | { kind: 'lap'; playerId: string; lap: number; lapMs: number }
  | { kind: 'nitro'; playerId: string; left: number } // a charge was consumed (remote sfx/visual)
  /**
   * Server-resolved kart-vs-kart contact. Both drivers receive the SAME event
   * for the same tick — the impact is one fact about the race, not two clients
   * each guessing. `impulse` is the approach speed (m/s) the collision removed.
   */
  | { kind: 'bump'; a: string; b: string; impulse: number }
  | { kind: 'finish'; playerId: string; place: number }
  | { kind: 'timeout' }
  | { kind: 'restart' };

export type KartS2C =
  /**
   * `trackId` is the room's circuit, and it is the FIRST thing the client can
   * act on: the joiner builds that TrackDef and its mesh before the first
   * snapshot lands. It is repeated on every snapshot (one short string at
   * SNAPSHOT_HZ) so a client that missed or mis-parsed the join — or that is
   * resuming into a room mid-race — still converges on the right circuit
   * instead of driving a road nobody else is on.
   */
  | {
      t: 'kart_joined';
      you: string;
      slot: number;
      color: number;
      phase: KartPhase;
      trackId: TrackId;
      players: KartPlayerInfo[];
    }
  | {
      t: 'kart_snapshot';
      tick: number;
      serverTime: number;
      phase: KartPhase;
      trackId: TrackId;
      countdown: number; // current countdown number during 'countdown', else 0
      phaseEndsAt: number; // serverTime ms; 0 when no phase timer
      // ---- lobby contract (additive) ----
      // The three values a lobby needs to render the start control without
      // guessing: how many are seated, how many it takes, and whether a
      // `{t:'start'}` sent right now would be accepted.
      playerCount: number; // seated players (== players.length)
      minPlayers: number; // MIN_PLAYERS, mirrored so the UI needs no config import
      canStart: boolean; // phase === 'lobby' && playerCount >= minPlayers
      // ---- championship contract (additive) ----
      // The room's season: where we are in the calendar and the running points
      // table. Mirrored on EVERY snapshot (not just results) so the lobby can
      // say "ROUND 3 OF 8 · RIVERSIDE" and a mid-season joiner can see the
      // table they just walked into. `null` on a championship-disabled room.
      championship: KartSeason | null;
      you: KartYou;
      players: KartPlayerSnap[];
    }
  | { t: 'race_event'; ev: RaceEvent };
