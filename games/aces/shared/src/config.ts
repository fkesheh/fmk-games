// ============================================================================
// ACES config — FROZEN Layer-1 data. Pure constants; NO logic, no functions.
// Every tunable number in the game lives here. If a module needs a number the
// config does not have, the task STOPS and reports — it does not invent one.
//
// Balance targets these numbers encode (see CONTRACT.md §Balance):
//   - fighter-vs-fighter TTK on sustained aim ≈ 1.6 s
//   - scout dies to a fighter burst ≈ 1.1 s; gunship soaks ≈ 2.6 s
//   - a full heat bar is ~13 s of continuous fighter fire
//   - first team to 25 kills lands around minute 5–7 at 4v4 bot fill
// ============================================================================

export const GAME_ID = 'aces';
export const GAME_NAME = 'ACES';
export const DEV_PORT = 5180;
export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 8;

/** Default room fill: teams of 4, bots take empty seats. */
export const DEFAULT_TEAM_SIZE = 4;

// ---- clock -----------------------------------------------------------------
export const TICK_RATE = 30; //         server sim + input rate (Hz)
export const SNAP_RATE = 15; //          snapshot broadcast rate (Hz)
export const INTERP_MS = 120; //         remote-plane interpolation delay

// ---- world -----------------------------------------------------------------
export const WORLD = {
  W: 4200,
  H: 3000,
  /** Soft-bound repel margin: planes pushed back inside past this rim. */
  BOUND: 140,
} as const;

/** Deterministic map seed. Same seed everywhere, forever: captures reproducible. */
export const MAP_SEED = 19170401; // April 1917

// ---- match shape -------------------------------------------------------------
export const MATCH_SECONDS = 480; //     8 minutes hard cap
export const END_SECONDS = 12; //        scoreboard hold before next round
export const TICKETS_TO_WIN = 25; //     team kills to win outright

// ---- respawn -----------------------------------------------------------------
export const RESPAWN_SECONDS = 3.5;
export const SPAWN_PROTECT_SECONDS = 2.0;
export const CLASS_SWITCH_LOCK = false; // class freely re-picked each spawn

// ---- supply crates -----------------------------------------------------------
export const CRATE_INTERVAL_S = 14; //   try-spawn cadence…
export const CRATES_MAX = 2; //          …while fewer than this are active
export const CRATE_FALL_S = 6; //        parachute descent before it lands
export const CRATE_LIFE_S = 25; //       active window once landed
export const CRATE_PICKUP_R = 34;
export const CRATE_HEAL = 45; //         also clears heat and refills boost

// ---- bullets -------------------------------------------------------------------
export const BULLET_TTL_S = 1.15;
export const BULLET_HIT_R = 3; //        bullet radius for circle tests

// ---- heat (machine-gun overheat) ------------------------------------------------
export const HEAT_MAX = 1;
export const HEAT_RESUME = 0.35; //      jammed guns resume below this
export const HEAT_COOL_IDLE = 0.45; //   per second while not firing
export const HEAT_COOL_FIRING = 0.12; // per second while firing

// ---- boost -----------------------------------------------------------------------
export const BOOST_MAX = 100;
export const BOOST_DRAIN = 38; //        per second while boosting
export const BOOST_REGEN = 14; //        per second while not boosting
export const BOOST_MULT = 1.42; //       applied to speedMax & accel

// ---- streak banners ----------------------------------------------------------------
export const STREAK_ACE = 3; //          kills without dying → "ACE"
export const STREAK_LEGEND = 5; //      kills without dying → "LEGEND"

export type PlaneClassId = 'scout' | 'fighter' | 'gunship';
export type TeamId = 'royal' | 'iron';
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface GunSpec {
  readonly count: 1 | 2 | 4; //           simultaneous barrels per volley
  readonly dmg: number; //                per bullet hit
  readonly rateHz: number; //              volleys per second
  readonly spreadDeg: number; //           ± cone jitter per barrel
  readonly heatPerShot: number; //         heat added per BULLET fired
  readonly bulletSpeed: number; //         u/s, plane velocity inherited on top
  /** Lateral muzzle offsets from the nose, u (mirrored ±x across heading). */
  readonly muzzleX: readonly number[];
}

export interface ClassSpec {
  readonly id: PlaneClassId;
  readonly name: string;
  readonly hp: number;
  readonly radius: number; //             hit circle, u
  readonly speedMin: number; //            u/s floor — no stall, arcade law
  readonly speedMax: number; //            u/s at full throttle
  readonly accel: number; //               u/s² along heading
  readonly turnRate: number; //            rad/s at low speed
  readonly gun: GunSpec;
}

/**
 * The three airframes. Silhouette law (STYLE_BIBLE §7): SCOUT reads as a small
 * round-cowled biplane, FIGHTER as an equal-span twin-gun biplane, GUNSHIP as
 * a wide triple-wing bruiser. Never confusable at gameplay zoom.
 */
export const CLASSES: Readonly<Record<PlaneClassId, ClassSpec>> = {
  scout: {
    id: 'scout',
    name: 'SCOUT',
    hp: 70,
    radius: 14,
    speedMin: 120,
    speedMax: 250,
    accel: 220,
    turnRate: 3.7,
    gun: { count: 2, dmg: 4, rateHz: 13, spreadDeg: 2.2, heatPerShot: 0.052, bulletSpeed: 820, muzzleX: [-10, 10] },
  },
  fighter: {
    id: 'fighter',
    name: 'FIGHTER',
    hp: 100,
    radius: 16,
    speedMin: 110,
    speedMax: 225,
    accel: 200,
    turnRate: 3.0,
    gun: { count: 2, dmg: 6, rateHz: 11, spreadDeg: 2.0, heatPerShot: 0.06, bulletSpeed: 800, muzzleX: [-11, 11] },
  },
  gunship: {
    id: 'gunship',
    name: 'GUNSHIP',
    hp: 160,
    radius: 20,
    speedMin: 90,
    speedMax: 190,
    accel: 170,
    turnRate: 2.2,
    gun: { count: 4, dmg: 5, rateHz: 16, spreadDeg: 2.6, heatPerShot: 0.035, bulletSpeed: 760, muzzleX: [-16, -6, 6, 16] },
  },
};

export const PLANE_CLASSES: readonly PlaneClassId[] = ['scout', 'fighter', 'gunship'];

/**
 * Turn rate scales with speed fraction: full authority at speedMin, −25%
 * authority at speedMax. Encoded here so client prediction and server sim can
 * never diverge.
 */
export const TURN_LOSS_AT_MAX = 0.25;

// ---- bots -----------------------------------------------------------------------
export interface BotDifficultySpec {
  readonly aimErrDeg: number; //   ± cone around perfect lead solution
  readonly reactionMs: number; //  target-acquisition delay
  readonly turnJitter: number; //  0..1 noise on steering each tick
  readonly fireRangeU: number; //  holds trigger inside this range
}

export const BOT_DIFFICULTY: Readonly<Record<Difficulty, BotDifficultySpec>> = {
  easy: { aimErrDeg: 10, reactionMs: 650, turnJitter: 0.35, fireRangeU: 420 },
  normal: { aimErrDeg: 7, reactionMs: 420, turnJitter: 0.22, fireRangeU: 520 },
  hard: { aimErrDeg: 4.5, reactionMs: 260, turnJitter: 0.12, fireRangeU: 620 },
};

export type RoomSettings = {
  readonly teamSize?: number; //   1..4, default DEFAULT_TEAM_SIZE
  readonly difficulty?: Difficulty; // default 'normal'
  readonly botFill?: boolean; //   default true
};

// ---- damage states -----------------------------------------------------------------
/** Below this HP fraction a plane trails heavy smoke. */
export const SMOKE_BELOW = 0.5;
/** Below this HP fraction a plane burns (fire trail + BURN_DPS). */
export const FIRE_BELOW = 0.25;
export const BURN_DPS = 2;
