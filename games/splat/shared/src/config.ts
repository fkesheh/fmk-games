// ============================================================================
// SKI SPLAT — CONFIG. Pure data, no logic. Every tunable lives here; balance
// numbers are checkable against games/splat/DESIGN_BIBLE.md targets.
// (Post-gauntlet revision: sim clock, drag/density/undulation retune.)
// ============================================================================

// --- Clocks -----------------------------------------------------------------
export const TICK_HZ = 30;               // server sim tick
export const SIM_DT = 1 / TICK_HZ;
export const SIM_DT_MIN = 1 / 240;       // clamp for client-reported dt
export const SIM_DT_MAX = 1 / 15;
export const SNAPSHOT_HZ = 20;           // server broadcast rate
export const SIM_BUDGET_MUL = 1.3;       // sim seconds per real second (speedhack cap)
export const MAX_INPUTS_PER_TICK = 4;
export const INPUT_QUEUE_CAP = 60;
export const PENDING_INPUT_CAP = 120;    // client replay queue
export const INPUT_STALE_MS = 10_000;    // stalePlayers() threshold

// --- Room / race flow (CONTRACT §4) -----------------------------------------
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const COUNTDOWN_MS = 3000;
export const RESULTS_MS = 8000;
export const RACE_FIRST_FINISH_GRACE_MS = 45_000; // results this long after 1st finisher
export const RACE_HARD_CAP_MS = 150_000;          // results no matter what

// --- Slope geometry (metres; +Z downhill, x lateral) -------------------------
export const SLOPE_LENGTH = 800;         // start gate z=0 -> finish
export const SLOPE_WIDTH = 56;
export const FINISH_Z = SLOPE_LENGTH;
export const START_CLEAR = 25;           // no plants within this of the gate
export const FINISH_CLEAR = 40;          // no plants in the sprint corridor
export const GRADE_BASE = 0.26;          // ~15 deg mean downhill grade (rise/run)
export const GRADE_MIN = 0.08;           // never flatter than this anywhere (never stuck)
export const EDGE_ZONE = 6;              // soft-edge band width at each side
export const EDGE_PUSH = 14;             // inward accel scale (m/s^2 at full depth)

// Terrain undulation octaves, frozen (gauntlet: balance-critical). h(x,z) =
// -GRADE_BASE*z + sum of sines; worst-case downhill-directed gradient of the
// undulations (0.1485+0.0228 = 0.1714) stays under GRADE_BASE-GRADE_MIN =
// 0.18 (frozen budget ceiling <= 0.171, per CONTRACT_V3 §12.2a), so
// gradeAt >= GRADE_MIN holds everywhere by construction.
// CONTRACT_V3 §12.2a — amplitudes retuned (UND_LONG_1_AMP 2.0->5.2,
// UND_LONG_2_AMP 1.0->0.4, UND_LAT_AMP 1.5->2.5). NOT a uniform scale: each
// value was set independently against the grade-safety budget above.
export const UND_LONG_1_AMP = 5.2;  export const UND_LONG_1_LEN = 220;
export const UND_LONG_2_AMP = 0.4;  export const UND_LONG_2_LEN = 110;
export const UND_LAT_AMP = 2.5;     export const UND_LAT_LEN = 140;

// --- Skier physics (DESIGN_BIBLE balance targets) -----------------------------
// Terminal velocity at GRADE_BASE: v* = sqrt(G*grade/DRAG) = sqrt(9.8*0.26/0.005)
// = 22.6 m/s (~81 km/h) -> clean 800 m run ~= 40 s (target band 35-55 s).
export const SKIER_RADIUS = 0.5;
export const EYE_HEIGHT = 1.55;
export const MIN_SPEED = 3;              // >0 everywhere: no stopped state
export const MAX_SPEED = 26;             // ~94 km/h cap for steep undulation dips
export const G_ACCEL = 9.8;              // scaled by gradeAlong
export const DRAG = 0.005;               // v^2 drag
export const TURN_RATE_BASE = 1.9;       // rad/s at low speed
export const TURN_RATE_MIN = 0.95;       // rad/s at MAX_SPEED (wider carve)
export const YAW_MAX = 1.35;             // rad; soft yaw clamp (spring return)
export const YAW_SPRING = 6;             // rad/s^2 per rad beyond YAW_MAX
export const CARVE_SCRUB = 0.55;         // speed shed while turning
export const STEER_RAMP_S = 0.18;        // CLIENT input ramp only — sim sees post-ramp steer
export const SKIER_PUSH = 3.5;           // skier-skier soft nudge accel

// --- Slalom gates (flag checkpoints — pure upside, DESIGN_BIBLE) ---------------
// Crossing a gate's z within its opening boosts speed; missing costs NOTHING.
export const GATE_SPACING_M = 50;        // one gate per ~50 m of descent
export const GATE_JITTER_M = 8;          // z jitter per gate (seeded)
export const GATE_HALF_WIDTH = 2.2;      // opening half-width (m)
export const GATE_FIRST_Z = 60;          // first gate after the learning zone
export const GATE_BOOST_MS = 2500;       // boost window (sim ms)
export const GATE_BOOST_V = 2.5;         // instant speed granted on pass (m/s)
export const GATE_BOOST_MAX = 30;        // speed cap while boosted (~108 km/h)

// --- Jumps (v2) -------------------------------------------------------------------
// ONE shared ballistic model: the skier flies a WORLD-SPACE arc
//   worldY(t) = airStartY + airVy*t - 0.5*G_ACCEL*t^2,  t = (simMs-airStartMs)/1000
// and lands when the arc returns to the (descending) terrain:
//   airStartY + arc <= slope.height(x, z). Both peers compute identically.
// TUNING NOTE (gauntlet-verified): the piste drops ~0.26*v m/s under the
// flight, so the height ABOVE the snow at time t is
//   h(t) = (airVy + grade*v)*t - 0.5*G_ACCEL*t^2  (approx)
// — the terrain-drop term AMPLIFIES launch vy. These v2 numbers are tuned
// for the world frame (empirically verified: hop apex ~1.5-2.5 m above the
// snow at race speed, kicker apex ~3-5 m, flights 30-50 m, always land,
// always contained; see docs/splat-v2/prototype-v2.mts).
export const J_HOP_VY = 1.1;             // manual hop launch vy (m/s, world frame):
                                         // a quick dodge — ~1.5-2.5 m of air at race
                                         // speed, never a stun
export const J_KICKER_VY_BASE = 1.8;     // kicker launch vy at zero speed (m/s)
export const J_KICKER_VY_SPEED = 0.05;   // +vy per m/s of speed (fast = bigger air)
// CONTRACT_V3 §12.1 / §12.2 — air steering is DELIBERATELY REVERSED from the
// v2 report: damped air steering is NOT "the skill". Zeroed, not tuned down.
export const J_AIR_STEER_MUL = 0;        // steering effectiveness while airborne
                                         // (hold your line; correct on landing)
export const J_AIR_CARVE_MUL = 0;        // carve-scrub multiplier while airborne
export const J_COOLDOWN_MS = 1800;       // sim ms between launches (hops are a
                                         // tactical tool, not a plant-immunity
                                         // button — the DESIGN_BIBLE line stays
                                         // the decision)
export const J_LAND_SPEED_MUL = 0.97;    // landing scrub (never below MIN_SPEED)
export const J_MAX_AIRTIME_S = 3.5;      // absolute airtime cap — landing is always
                                         // eventual (the 4-year-old law: no stuck)

// Kicker layout (seeded, corridor-anchored like the slalom gates).
export const KICKER_COUNT = 9;           // jump ramps per run
export const KICKER_HALF_WIDTH = 1.6;    // capture half-width (m)
export const KICKER_Z0 = 90;             // first kicker after the learning zone
export const KICKER_SPACING = 85;        // mean z spacing (m) — > max flight
                                         // (~52 m at 26 m/s) so a fast skier never
                                         // overshoots the next ramp (gauntlet)
export const KICKER_Z_JITTER = 10;       // per-kicker z jitter (m, seeded)
export const KICKER_X_JITTER = 3;        // lateral offset off the corridor centre (m)
export const KICKER_PLANT_CLEAR = 2.2;   // no plant within this of a kicker (m)
export const KICKER_HEIGHT = 0.85;       // ramp height (m) — visual + air feel
                                         // (the sim launches from the arc, the
                                         // ramp mesh is decoration)

// --- Plants (the opponent) ----------------------------------------------------
// Density target: a straight fall-line run hits 3-6 plants (DESIGN_BIBLE).
// Contact corridor ~2.5 m wide x ~615 m full-density length x 0.004 = ~6 hits.
// (Gauntlet note: GRADE_BASE - GRADE_MIN = 0.26 - 0.08 = 0.18, and the
// worst-case downhill-directed undulation gradient is 0.1485+0.0228 = 0.1714
// (see header above, CONTRACT_V3 §12.2a) — but that is a clamp-margin budget,
// not a fall-line-grade floor: measured minimum unclamped fall-line grade
// (finite-difference sampling, 20 seeds incl. 42, dz=0.5m over z=[0,800)) is
// ~0.089, not 0.146. gradeAt's GRADE_MIN=0.08 clamp — not construction — is
// what keeps the grade >= GRADE_MIN for any reachable heading.)
export const PLANT_REARM_MS = 3000;      // per-plant rearm window (sim ms)
export const PLANT_IMMUNITY_MS = 400;    // global post-hit immunity (cluster guard)
export const PLANT_HIT_SPEED_MUL = 0.7;  // velocity kept on contact
export const PLANT_SNARE_MS = 900;       // max speed halved while snared
export const PLANT_DENSITY_START = 0.001;// plants/m2 in the learning zone
export const PLANT_DENSITY_FULL = 0.004; // plants/m2 at full density
export const PLANT_DENSITY_RAMP = 0.15;  // fraction of length that ramps start->full
export const PLANT_CLUSTER_PCT = 0.55;   // share of plants in clusters (rest solo)
export const PLANT_CLUSTER_RADIUS = 7;   // cluster scatter radius (m)
export const PLANT_CLUSTER_MIN = 3;      // plants per cluster
export const PLANT_CLUSTER_MAX = 7;
export const PLANT_BAND_M = 10;          // spatial-hash z band
export const PLANT_CORRIDOR_M = 3;       // guaranteed plant-free corridor width
export const CORRIDOR_MAX_SHIFT_M = 4;   // corridor centreline max lateral move per band
export const PLANT_RADIUS: Readonly<Record<'pine' | 'bush' | 'thorn', number>> = {
  pine: 0.55,
  bush: 0.75,
  thorn: 0.9,
};
// Hit-cost target: ~0.7-1.2 s per touch (speed scrub + snare), per DESIGN_BIBLE.

// --- Assist mode (per player, invisible) --------------------------------------
// stepSki applies ONLY these three. Steer EMA + steer-rate narrowing live in
// the CLIENT input layer (wire steer is already-smoothed; the server trusts it).
export const ASSIST_STEER_EMA = 0.35;    // input smoothing factor (client-side)
export const ASSIST_PLANT_RADIUS_MUL = 0.8;
export const ASSIST_SNARE_MUL = 0.75;
export const ASSIST_EDGE_MUL = 1.4;

// --- Start grid: slot i -> row = floor(i/4), x = (i%4 - 1.5)*START_ROW_SPACING,
//     z = -row * START_ROW_SPACING. --------------------------------------------
export const START_ROW_SPACING = 3;      // metres between skiers
export const START_PER_ROW = 4;

// --- Client --------------------------------------------------------------------
export const INTERP_DELAY_MS = Math.round(1800 / SNAPSHOT_HZ);
export const EXTRAPOLATE_MAX_MS = 250;
export const BASE_FOV = 65;
export const SPEED_FOV_MAX = 18;
export const CAM_SHAKE_AMP = 0.004;
