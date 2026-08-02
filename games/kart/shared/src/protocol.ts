// ============================================================================
// FROZEN CONTRACT — KART GP: room-level wire validation.
//
// The C2S surface carries INTENT ONLY. `kart_state` (absolute world position,
// yaw and velocity, copied straight into the room) is GONE: no message a
// client can send names a coordinate, so the entire class of "report yourself
// 800m down the road" cheats has nothing to attach to. What remains is a
// bounded control input the server integrates itself.
// ============================================================================
import {
  CHAMPIONSHIP_DEFAULT,
  DEFAULT_SEASON_ROUNDS,
  POINTS_TABLE,
  SEASON_ROUNDS_MAX,
  SEASON_ROUNDS_MIN,
  SIM_DT,
  SIM_DT_MAX,
  SIM_DT_MIN,
} from './config.js';
import { DEFAULT_TRACK_ID, isTrackId, TRACK_LIST } from './tracks/index.js';
import type { TrackId } from './track.js';
import type { KartC2S } from './types.js';

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Parse + sanitize a raw decoded JSON value into a KartC2S message, or null. */
export function parseKartC2S(raw: unknown): KartC2S | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.t === 'nitro') return { t: 'nitro' };
  // explicit lobby start; the ROOM validates phase + player count (never throws)
  if (r.t === 'start') return { t: 'start' };
  if (r.t !== 'kart_input') return null;
  if (!num(r.seq) || !num(r.throttle) || !num(r.brake) || !num(r.steer)) return null;
  return {
    t: 'kart_input',
    seq: Math.floor(r.seq),
    throttle: clamp(r.throttle, 0, 1),
    brake: clamp(r.brake, 0, 1),
    steer: clamp(r.steer, -1, 1),
    drift: r.drift === true,
    respawn: r.respawn === true,
    // an absent/garbage dt means "one nominal tick"; anything else is clamped
    // into the accepted band (the room additionally caps simulated time per
    // real second, so a flood of max-dt inputs still cannot outrun the clock)
    dt: clamp(num(r.dt) ? r.dt : SIM_DT, SIM_DT_MIN, SIM_DT_MAX),
  };
}

// ============================================================================
// CHAMPIONSHIP — pure scoring, calendar and settings rules.
//
// All of it lives here, in shared, for two reasons: the room stays a phase
// machine instead of a rulebook, and every rule below is unit-testable without
// driving a kart. `module.ts` (not owned by this pass) calls
// parseKartRoomSettings; the room calls the rest.
// ============================================================================

/**
 * F1 points for a finishing place (1-based). Outside the top ten: 0.
 * A DNF never reaches this function — it is not in finishOrder — which is
 * exactly how "DNF scores 0" is implemented: by omission, not by a special case.
 */
export function pointsForPlace(place: number): number {
  if (!Number.isFinite(place) || place < 1) return 0;
  return POINTS_TABLE[Math.floor(place) - 1] ?? 0;
}

/** The four fields the championship order is decided on. See compareSeason. */
export interface SeasonSortKey {
  points: number;
  wins: number;
  /** Best (lowest) finishing place this season; 0 = never finished. */
  bestFinish: number;
  /** Unique, monotonic order of first appearance THIS season (0-based). */
  seq: number;
}

/**
 * THE TIE-BREAK — deterministic and total, so two rooms in the same state can
 * never disagree and a re-sort can never reorder equals.
 *
 *   1. most points
 *   2. most wins                      (F1 Sporting Regs art. 7.2: "countback")
 *   3. best single finishing position (the next countback rung, collapsed:
 *      a driver who has a 2nd beats one whose best is a 3rd)
 *   4. join order — earliest driver to appear in this season wins
 *
 * Real F1 walks the countback all the way down (most wins, then most 2nds,
 * then most 3rds, ...) and only then falls back to the stewards. We walk the
 * first two rungs and then use join order, which is UNIQUE per driver: rule 4
 * can never tie, so the comparator is a total order and the standings have
 * exactly one valid arrangement. Never sort standings with anything else.
 */
export function compareSeason(a: SeasonSortKey, b: SeasonSortKey): number {
  if (a.points !== b.points) return b.points - a.points;
  if (a.wins !== b.wins) return b.wins - a.wins;
  const ab = a.bestFinish > 0 ? a.bestFinish : Number.POSITIVE_INFINITY;
  const bb = b.bestFinish > 0 ? b.bestFinish : Number.POSITIVE_INFINITY;
  if (ab !== bb) return ab - bb;
  return a.seq - b.seq;
}

/**
 * The season calendar: `rounds` circuits starting at `start`, walking TRACK_LIST
 * in REGISTRY ORDER and WRAPPING at the end.
 *
 * Wraparound is what makes a short registry legal: with one circuit registered
 * an 8-round season is 8 races at that circuit, and with eight it is eight
 * different ones. A room that books FEWER rounds than the registry holds simply
 * races the first `rounds` circuits of the rotation from its own starting track
 * — the rest of the calendar is not "missing", the season is just shorter.
 */
export function buildCalendar(start: TrackId, rounds: number): TrackId[] {
  const ids = TRACK_LIST.map((t) => t.id);
  const n = ids.length;
  const first = Math.max(0, ids.indexOf(start));
  const out: TrackId[] = [];
  for (let i = 0; i < rounds; i++) out.push(ids[(first + i) % n] ?? DEFAULT_TRACK_ID);
  return out;
}

/** Championship half of a room's settings (the room takes trackId separately). */
export interface KartSeasonSettings {
  /** false => no championship at all: the room behaves as it did before. */
  championship: boolean;
  /** Rounds in the season, SEASON_ROUNDS_MIN..SEASON_ROUNDS_MAX. */
  rounds: number;
}

/** Everything a KartRoom is built from, validated off `opts.settings`. */
export interface KartRoomSettings {
  trackId: TrackId;
  season: KartSeasonSettings;
}

/** The settings a room gets when the creator supplied none (quick_join). */
export function defaultKartRoomSettings(trackId: TrackId = DEFAULT_TRACK_ID): KartRoomSettings {
  return {
    trackId,
    season: { championship: CHAMPIONSHIP_DEFAULT, rounds: DEFAULT_SEASON_ROUNDS },
  };
}

/**
 * Validate a room's opaque `settings` bag. THROWS on anything invalid — the
 * platform lobby turns the throw into `bad_settings`, which is why nothing here
 * is silently coerced:
 *   trackId     absent => DEFAULT_TRACK_ID; not a registered id => throw
 *   championship absent => CHAMPIONSHIP_DEFAULT; not a boolean => throw
 *   rounds      absent => DEFAULT_SEASON_ROUNDS; not an integer in
 *               [SEASON_ROUNDS_MIN, SEASON_ROUNDS_MAX] => throw
 * `rounds` is accepted (and ignored) on a championship-disabled room rather
 * than rejected, so a client may send both fields unconditionally.
 */
export function parseKartRoomSettings(settings: Record<string, unknown> | undefined): KartRoomSettings {
  const rawTrack = settings?.['trackId'];
  let trackId: TrackId = DEFAULT_TRACK_ID;
  if (rawTrack !== undefined) {
    if (!isTrackId(rawTrack)) throw new Error('unknown track');
    trackId = rawTrack;
  }
  const rawChamp = settings?.['championship'];
  let championship = CHAMPIONSHIP_DEFAULT;
  if (rawChamp !== undefined) {
    if (typeof rawChamp !== 'boolean') throw new Error('bad championship');
    championship = rawChamp;
  }
  const rawRounds = settings?.['rounds'];
  let rounds = DEFAULT_SEASON_ROUNDS;
  if (rawRounds !== undefined) {
    if (
      typeof rawRounds !== 'number' ||
      !Number.isInteger(rawRounds) ||
      rawRounds < SEASON_ROUNDS_MIN ||
      rawRounds > SEASON_ROUNDS_MAX
    ) {
      throw new Error('bad rounds');
    }
    rounds = rawRounds;
  }
  return { trackId, season: { championship, rounds } };
}
