// ============================================================================
// FROZEN CONTRACT — KART GP: kart model + race tuning. Pure data, no logic.
// ============================================================================

// ---- kart dynamics ----
export const ROAD_HALF_W = 5; // m, centerline to road edge (10m wide road)
export const TOP_SPEED = 36; // m/s on road (~130 km/h)
export const REVERSE_TOP = 8;
export const ENGINE = 16; // base m/s^2, scaled per gear
export const BRAKE = 24; // m/s^2
export const DRAG = 0.35; // linear drag coefficient (tuned so every gear top is reachable)
export const ROLL = 0.4; // rolling resistance m/s^2
export const MAX_LOCK = 0.55; // steering angle at standstill (rad)
export const MIN_LOCK = 0.2; // steering angle at top speed (rad)
export const WHEELBASE = 1.6; // m (bicycle model)
// Automatic gearbox: per-gear top speed + engine multiplier. Shift up at gear top
// (SHIFT_TIME of engine cut), downshift DOWNSHIFT_HYST below the previous top —
// the hysteresis MUST exceed the speed lost during a shift cut (≈3.5m/s at top gears)
// or the box oscillates up/down around every top.
export const GEARS: ReadonlyArray<{ readonly top: number; readonly accel: number }> = [
  { top: 12, accel: 1.35 },
  { top: 18, accel: 1.15 },
  { top: 25, accel: 1.0 },
  { top: 31, accel: 0.85 },
  { top: 36, accel: 1.25 }, // overdrive: enough pull to actually reach the top
];
export const SHIFT_TIME = 0.12; // s of engine cut during an upshift (short — long cuts feel like phantom braking)
export const DOWNSHIFT_HYST = 4.5; // m/s below previous top before a downshift
export const GRIP_ROAD = 8; // lateral velocity decay /s
export const GRIP_GRASS = 3;
export const GRIP_DRIFT = 1.5; // handbrake slides but doesn't pirouette
export const LAT_G = 12.5; // max lateral acceleration on road, m/s^2 (understeer cap —
// raised so standard cornering stays competitive with the handbrake)
export const LAT_G_GRASS = 6;
export const DRIFT_MIN_SPEED = 8; // m/s needed to initiate a drift
export const DRIFT_STEER_MUL = 1.25; // sharper steering while drifting (was 1.5 = 'magic turns')
export const DRIFT_DECEL = 12; // m/s^2 of handbrake deceleration while drifting (drifting a
// corner must cost REAL speed — it is a rotation tool, not a better brake pedal)
export const DRIFT_THROTTLE_MUL = 0.25; // clutch slip: engine force while drifting (handbrake fights throttle, never loses)
export const GRASS_ENGINE_MUL = 0.55;
export const GRASS_DRAG = 2.5; // extra drag off-road
export const BARRIER_DAMP = 0.4; // velocity kept along the normal after a barrier hit
export const KART_RADIUS = 0.9; // collision circle (kart-kart repulsion + barriers)
export const BARRIER_OUT = 1.2; // barrier wall offset past the road edge (m)
// Kart-vs-kart contact (SERVER-RESOLVED, shared/sim.ts resolveKartPair). Equal
// masses: the normal impulse is split evenly, so both karts see the SAME impact
// at the same tick — a bump is momentum exchange, not a one-sided position shove.
export const KART_RESTITUTION = 0.35; // bounciness of a kart-kart hit (0 = dead stop, 1 = elastic)
export const BUMP_MIN_SPEED = 2; // m/s of approach speed before a 'bump' race event fires
export const BUMP_COOLDOWN_MS = 250; // per-player minimum spacing between bump events

// ---- race rules ----
export const GATES = 8; // checkpoints incl. start/finish at gate 0
export const GATE_RADIUS = 9; // m
export const LAPS_TO_WIN = 3;
export const MIN_PLAYERS = 2;
// 20-kart grid. Three things are TIED to this number and must move with it:
// KART_COLORS.length (palette.ts — one distinct livery per slot, gated in
// valueLadder.test.ts), fx.HEAT_STREAMS (client — one drift-heat envelope per
// simultaneously sliding kart), and GRID_ROWS below (which sizes the arc of
// road gridSlot() walks back from the start line).
export const MAX_PLAYERS = 20;

// ---- starting grid (track.ts gridSlot; laid out BY ARC LENGTH along the road) ----
// Slots are placed by walking the centreline backward from the start line, so
// these are metres of ROAD, not metres along a straight ray. GRID_DEPTH_M
// (= 42 m at MAX_PLAYERS 20) is derived in track.ts and validated against the
// circuit length so a grid can never wrap past its own start line.
export const GRID_ROW_BACK0 = 6; // m of arc from the line to row 0
export const GRID_ROW_GAP = 4; // m of arc between rows
export const GRID_LATERAL = 2.2; // m either side of the centreline (two columns)
export const GRID_ROWS = Math.ceil(MAX_PLAYERS / 2); // 10 rows of 2
// Keep-off-the-barriers margin: the stagger is clamped to roadHalfW - this, so
// a narrower circuit narrows the grid instead of starting karts in the wall.
export const GRID_EDGE_MARGIN = 1.5; // > KART_RADIUS (0.9) plus a shoulder
export const READY_SECONDS = 5; // 'ready' before countdown
export const COUNTDOWN_SECONDS = 3;
export const RESULTS_SECONDS = 10;
export const RACE_TIMEOUT_S = 300; // hard cap per race
export const NITRO_CHARGES = 3; // per player per race
export const NITRO_TIME = 1.5; // s of boost per charge
export const NITRO_BOOST = 10; // extra engine m/s^2 during nitro

// ---- netcode (SERVER-AUTHORITATIVE simulation) ----
// The wire carries INPUTS, never coordinates: the server integrates the shared
// sim (shared/sim.ts stepDrive) from the input stream and owns every position.
// The client runs the SAME step on the same input for prediction and replays
// unacknowledged inputs on top of the server's state (fps/net/prediction.ts).
//
// SIM_HZ is the authority AND input rate: one input message covers exactly one
// SIM_DT of simulation, so "how many inputs the server consumed" IS "how much
// time that kart simulated" — there is no clock to spoof. 30Hz matches the FPS
// tick and keeps steering response at 33ms (20Hz would add a felt 50ms).
export const SIM_HZ = 30;
export const SIM_DT = 1 / SIM_HZ;
// Physics still integrates at 120Hz: one sim tick runs SIM_SUBSTEPS substeps,
// so the handling model (kartPhysics.ts) is bit-identical to the pre-netcode
// client sim. SIM_SUBSTEP_HZ must stay an integer multiple of SIM_HZ.
export const SIM_SUBSTEP_HZ = 120;
export const SIM_SUBSTEPS = SIM_SUBSTEP_HZ / SIM_HZ; // 4
// A malformed/hostile dt is clamped into this band before it reaches the sim,
// and the per-second SIM_BUDGET_MUL cap below bounds total simulated time.
export const SIM_DT_MIN = 1 / 240;
export const SIM_DT_MAX = 1 / 15;
// Speedhack budget: a player may not have more than this multiple of REAL time
// integrated on their behalf in any 1s window (honest clients sit at 1.0;
// jitter/catch-up needs the headroom). Inputs past the budget are dropped
// UNACKNOWLEDGED, so an honest client would simply replay them.
export const SIM_BUDGET_MUL = 1.3;
export const MAX_INPUTS_PER_TICK = 4; // catch-up cap: 1 nominal + 3 of recovered jitter
export const INPUT_QUEUE_CAP = 60; // ~2s of queued inputs; oldest dropped beyond this
export const PENDING_INPUT_CAP = 120; // client-side replay queue (~4s at SIM_HZ)

// Snapshot rate: raised 15 -> 20. At TOP_SPEED that cuts the per-frame
// quantisation a remote kart is rendered with from 2.4m to 1.8m; the cost is
// linear in bandwidth (~1.5 -> ~2.0 MiB/s aggregate at MAX_PLAYERS 20), which
// is why it is not 30Hz (that would be ~3.0 MiB/s for another 0.6m).
export const SNAPSHOT_HZ = 20;
export const INPUT_STALE_MS = 10_000; // no kart_input for this long => stale
