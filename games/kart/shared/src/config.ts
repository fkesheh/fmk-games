// ============================================================================
// FROZEN CONTRACT — KART GP: kart model + race tuning. Pure data, no logic.
// ============================================================================

// ---- kart dynamics ----
export const ROAD_HALF_W = 5; // m, centerline to road edge (10m wide road)
export const TOP_SPEED = 30; // m/s on road (~108 km/h)
export const REVERSE_TOP = 8;
export const ENGINE = 16; // base m/s^2, scaled per gear and tapering to 0 at gear top
export const BRAKE = 24; // m/s^2
export const DRAG = 0.35; // linear drag coefficient (tuned so every gear top is reachable)
export const ROLL = 0.4; // rolling resistance m/s^2
export const MAX_LOCK = 0.55; // steering angle at standstill (rad)
export const MIN_LOCK = 0.2; // steering angle at top speed (rad)
export const WHEELBASE = 1.6; // m (bicycle model)
// Automatic gearbox: per-gear top speed + engine multiplier. Shift up at gear top
// (SHIFT_TIME of engine cut), downshift 1.5 m/s below the previous top (hysteresis).
export const GEARS: ReadonlyArray<{ readonly top: number; readonly accel: number }> = [
  { top: 10, accel: 1.35 },
  { top: 16, accel: 1.15 },
  { top: 22, accel: 1.0 },
  { top: 27, accel: 0.85 },
  { top: 30, accel: 1.25 }, // overdrive: enough pull to actually reach the top
];
export const SHIFT_TIME = 0.35; // s of engine cut during an upshift
export const GRIP_ROAD = 8; // lateral velocity decay /s
export const GRIP_GRASS = 3;
export const GRIP_DRIFT = 1.2;
export const LAT_G = 11; // max lateral acceleration on road, m/s^2 (understeer cap)
export const LAT_G_GRASS = 6;
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
