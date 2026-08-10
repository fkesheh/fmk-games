// ============================================================================
// SKI SPLAT — WIRE TYPES + SHARED SHAPE TYPES. Frozen (CONTRACT §5). Pure
// types, no logic. Conventions: +Z downhill; yaw 0 = fall line, + toward +x;
// times are ms. Sim-time fields are SIM ms (accumulated dt*1000), identical
// on both peers because both replay the same (steer, dt) sequence.
// ============================================================================

export type Phase = 'lobby' | 'countdown' | 'racing' | 'results';

// ------------------------------------------------------------- slope shape --
// The SlopeDef INTERFACE is frozen here (it crosses the P1/P2 boundary);
// genSlope/validateSlope bodies land with task P2 (CONTRACT §7).
export type PlantKind = 'pine' | 'bush' | 'thorn';

export interface Plant {
  readonly x: number;
  readonly z: number;
  readonly r: number;      // contact radius (config PLANT_RADIUS by kind)
  readonly kind: PlantKind;
}

export interface SlopeDef {
  readonly seed: number;
  readonly length: number;
  readonly width: number;
  readonly finishZ: number;
  readonly plants: readonly Plant[];
  /** Terrain height at (x,z). Analytic, deterministic. */
  height(x: number, z: number): number;
  /** Downhill grade along `heading` at (x,z). Always >= GRADE_MIN. */
  gradeAt(x: number, z: number, heading: number): number;
  /** Plants with floor(z / PLANT_BAND_M) === zBand. Callers must query
   *  zBand-1..zBand+1 and circle-test with plant.r + SKIER_RADIUS. */
  plantGrid(zBand: number): readonly Plant[];
}

// ---------------------------------------------------------------- C -> S ---
export interface SplatInputMsg {
  readonly t: 'splat_input';
  readonly seq: number;
  readonly steer: number;   // -1..1, post-ramp, post-assist-EMA — THE ONLY input
  readonly dt: number;      // seconds of client sim time this input covers
}

export type SplatC2S =
  | SplatInputMsg
  | { readonly t: 'splat_assist'; readonly on: boolean }
  | { readonly t: 'start' };

// ---------------------------------------------------------------- S -> C ---
export interface RosterEntry {
  readonly id: string;
  readonly name: string;
  readonly slot: number;    // 0..7, stable for the match; indexes SKIER_COLORS/GLYPHS
}

/** Authoritative per-skier sim state. Echoed whole in `you` for rebasing;
 *  pooled and mutated in place on the server (kart pattern). */
export interface SkierSim {
  x: number;
  z: number;
  yaw: number;
  v: number;                    // m/s, MIN_SPEED..MAX_SPEED (halved while snared)
  simMs: number;                // sim clock: accumulated dt*1000 (deterministic)
  snareUntilMs: number;         // sim ms; max speed halved while simMs < this
  lastPlantIx: number;          // -1 = none (indexes SlopeDef.plants)
  lastPlantHitMs: number;       // sim ms; drives rearm + PLANT_IMMUNITY_MS
  finished: boolean;
  finishMs: number;             // simMs at the moment of finishing, 0 while racing
}

/** Remote-render view of a skier. Identity (name/color/glyph) is NOT here —
 *  the client maps slot -> RosterEntry from splat_joined / splat_roster. */
export interface SkierSnap {
  id: string;
  slot: number;
  x: number;
  z: number;
  yaw: number;
  v: number;
  steer: number;      // last known, for remote lean animation
  finished: boolean;
  finishMs: number;
  place: number;      // 1-based, computed server-side each tick
}

export type SplatEvent =
  | { readonly t: 'plant_hit'; readonly id: string; readonly plantIx: number;
      readonly x: number; readonly z: number }
  | { readonly t: 'finished'; readonly id: string; readonly place: number;
      readonly finishMs: number }
  | { readonly t: 'player_left'; readonly id: string };

export interface SplatJoined {
  readonly t: 'splat_joined';
  readonly code: string | null;
  readonly you: string;
  readonly slot: number;
  readonly phase: Phase;
  readonly seed: number;        // current slope seed; -1 = no race yet (lobby)
  readonly serverTime: number;
  readonly players: readonly RosterEntry[];
}

/** Full roster refresh, sent on any join/leave. */
export interface SplatRoster {
  readonly t: 'splat_roster';
  readonly players: readonly RosterEntry[];
}

export interface SplatSnapshot {
  readonly t: 'splat_snapshot';
  readonly tick: number;
  readonly serverTime: number;
  readonly phase: Phase;
  readonly seed: number;        // slope seed; rebuild terrain when it changes
  readonly countdown: number;   // 3..1 during countdown else 0
  readonly phaseEndsAt: number; // serverTime ms
  readonly playerCount: number;
  readonly minPlayers: number;
  readonly canStart: boolean;
  readonly you: { lastProcessedSeq: number; sim: SkierSim };
  /** Racers only, INCLUDING the recipient (the place chip reads it here).
   *  Waiting late-joiners are excluded until the next countdown. */
  readonly players: readonly SkierSnap[];
}

export type SplatS2C =
  | SplatJoined
  | SplatRoster
  | SplatSnapshot
  | { readonly t: 'splat_event'; readonly ev: SplatEvent };
