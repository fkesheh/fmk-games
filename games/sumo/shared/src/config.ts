// ============================================================================
// FROZEN CONTRACT — SUMO: tuning + rules. Pure data, no logic. Every number
// comes from specs/P10.md ("Rules (server-authoritative, 30Hz)"); anything
// the spec left open is marked. Server sim, server room and client renderer
// all import from here so none of them can drift.
// ============================================================================

// ---- simulation ----
export const SIM_HZ = 30;
export const SIM_DT = 1 / SIM_HZ;
export const MOVE_ACCEL = 40; // u/s²
export const FRICTION = 6; // /s exponential damping (v *= e^(-6·dt))
export const MAX_SPEED = 9; // u/s — soft cap: never ACCELERATE past it; dash
// overshoot decays back through friction (~0.12s from 18 to 9)
export const BODY_RADIUS = 0.6; // cylinder body radius, u

// ---- actions ----
export const DASH_IMPULSE = 18; // u/s added along move dir on bit-0 press
export const DASH_COOLDOWN_S = 1.5;
export const DASH_FLASH_S = 0.25; // how long `dashing` stays true (visual only)
export const JUMP_VY = 8; // u/s up on bit-1 press
export const GRAVITY = -22; // u/s²
// Airborne players cannot dash and keep horizontal control (spec: "no air-dash").

// ---- arena ----
export const PLATFORM_R_START = 14; // u at round start
export const PLATFORM_R_END = 4; // u once the shrink completes
export const ROUND_SHRINK_S = 45; // R_START -> R_END linearly over this
export const FALL_Y = -12; // feet below this => out

// ---- match / round rules ----
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const WINS_TO_MATCH = 3; // first to N round wins takes the match,
// then wins reset and play continues (endless room, spec: "match = first to 3")
export const PUSHER_WINDOW_MS = 3000; // KO credit: last pusher within this
export const INPUT_STALE_MS = 15_000; // no input for this long => platform evicts
export const COUNTDOWN_S = 3; // spec leaves phase lengths open; house defaults
export const RESULTS_S = 4;

// ---- contact (elastic circle pushout, equal masses) ----
// Restitution < 1 keeps shoves readable instead of pinbally; a full-speed dash
// into a stander still launches the stander at ~17 u/s (> MAX_SPEED).
export const PUSH_RESTITUTION = 0.9;
/** Approach speed (u/s) along the pair normal before a thud is worth playing. */
export const BUMP_MIN_SPEED = 2;

// ---- client ----
export const INTERP_MS = 120; // render this far behind serverTime
export const INPUT_SEND_HZ = 30; // client sends inputs at the sim rate
/** Extrapolation cap past the newest snapshot when sampling the interp buffer. */
export const INTERP_MAX_EXTRAPOLATE_MS = 100;

/** Slot -> candy color (flat-shaded capsules). Index = join slot % length. */
export const SUMO_COLORS: ReadonlyArray<string> = [
  '#ff5d73', // candy red
  '#4fc3f7', // sky blue
  '#aeea00', // lime
  '#ffb300', // amber
  '#ba68c8', // grape
  '#26a69a', // teal
  '#ff7043', // tangerine
  '#eceff1', // snow
];
