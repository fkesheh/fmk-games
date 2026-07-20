// ============================================================================
// FROZEN CONTRACT — KART GP: kart model + race tuning. Pure data, no logic.
// ============================================================================

// ---- kart dynamics ----
export const ROAD_HALF_W = 5; // m, centerline to road edge (10m wide road)
export const TOP_SPEED = 30; // m/s on road (~108 km/h)
export const REVERSE_TOP = 8;
export const ENGINE = 16; // m/s^2 at standstill, tapering to 0 at TOP_SPEED
export const BRAKE = 24; // m/s^2
export const DRAG = 0.6; // quadratic-ish linear drag coefficient
export const ROLL = 0.4; // rolling resistance m/s^2
export const MAX_LOCK = 0.55; // steering angle at standstill (rad)
export const MIN_LOCK = 0.2; // steering angle at top speed (rad)
export const WHEELBASE = 1.6; // m (bicycle model)
export const GRIP_ROAD = 8; // lateral velocity decay /s
export const GRIP_GRASS = 3;
export const GRIP_DRIFT = 1.2;
export const DRIFT_MIN_SPEED = 8; // m/s needed to initiate a drift
export const DRIFT_STEER_MUL = 1.5; // sharper steering while drifting
export const TURBO_MIN_S = 1.2; // drift duration that charges a mini-turbo
export const TURBO_S = 1.2; // turbo duration
export const TURBO_BOOST = 8; // extra engine m/s^2 during turbo
export const GRASS_ENGINE_MUL = 0.55;
export const GRASS_DRAG = 2.5; // extra drag off-road
export const BARRIER_DAMP = 0.4; // velocity kept along the normal after a barrier hit
export const KART_RADIUS = 0.9; // collision circle (kart-kart repulsion + barriers)

// ---- race rules ----
export const GATES = 8; // checkpoints incl. start/finish at gate 0
export const GATE_RADIUS = 9; // m
export const LAPS_TO_WIN = 3;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const READY_SECONDS = 5; // 'ready' before countdown
export const COUNTDOWN_SECONDS = 3;
export const RESULTS_SECONDS = 10;
export const RACE_TIMEOUT_S = 300; // hard cap per race
export const SNAPSHOT_HZ = 15;
export const INPUT_STALE_MS = 10_000; // no kart_state for this long => stale
