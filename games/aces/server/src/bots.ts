// ============================================================================
// server/src/bots.ts — S_BOTS: WWI pilot brains.
//
// One pure-ish policy call per bot per tick: (view, diff, rng, mem, dt) →
// InputFrame. Deterministic given its inputs — every bit of variation flows
// through the caller-supplied seeded rng stream (RULES 3: never Math.random,
// no clocks), and ALL memory lives in the caller-owned BotMem (three numbers),
// so the room can persist, reset or clone a brain by copying a struct.
//
// Priority ladder (CONTRACT §1 D5 "bots fly like pilots, not turrets" + §4):
//   0. dead        — emit hands-off, touch nothing
//   1. RIM         — dying on the map edge is a free kill for the enemy team;
//                    inside BOT_AI.RIM_MARGIN_U the steering wheel belongs to
//                    the map center, strongest priority of all.
//   2. EVADE       — below BOT_AI.EVADE_HP_FRACTION hp: break OFF. Hard
//                    perpendicular turn away from the nearest threat denies
//                    the enemy's lead solution; trigger stays cold (a nose
//                    sweeping across the cone would chatter the trigger and
//                    torch the heat budget that D2 makes the duel's resource).
//   3. PURSUIT     — fly at the aimLead intercept point and open fire inside
//                    the difficulty's aim cone and range window.
//
// Reaction law: acquiring a NEW target id costs diff.reactionMs, paid via
// mem.reactT as an ARM → HOLD → COMMIT cycle. mem.targetId is the COMMITTED
// mark and changes ONLY on the tick the clock reaches zero:
//   arm    — a different enemy becomes the right mark while the clock is idle:
//            start the clock, keep flying the old mark's solution;
//   hold   — while the clock runs, the tracking logic keeps resolving to the
//            old mark (or hands-off straight flight if he is gone/beyond the
//            band) — the new contact is deliberately invisible to intents;
//   commit — the tick the clock expires with the new mark still nearest, the
//            id swaps and intents snap to him that same tick.
// Committing late (instead of swapping the id up front) is load-bearing: the
// id in memory always names the plane intents are actually flying at, so the
// hold phase cannot silently drift onto the new contact. Reflex layers (rim,
// evade) are NOT gated by reaction — flinching away from a wall needs no
// target lock.
//
// rng discipline: exactly ONE rng() draw per call, taken unconditionally so
// the stream cadence never depends on which branch the world took. It funds
// the pursuit boost blip ("occasional personality" from the brief).
//
// Allocation note (RULES 4): the returned InputFrame is a fresh literal each
// call ON PURPOSE — the room stores latest-frame-per-player by reference, so
// reusing one scratch frame would corrupt every seat but the newest. Same
// exemption class as snapshots/events: it crosses a storage seam. aimLead()
// returns one small object per call; we deliberately reuse the FROZEN shared
// math instead of inlining a divergent copy (8 bots × 30 Hz = 240 calls/s —
// far outside any hot render path).
// ============================================================================

import { BOT_AI, CLASSES } from '@aces/shared/config';
import type { BotDifficultySpec } from '@aces/shared/config';
import type { AcesMap } from '@aces/shared/maps';
import { aimLead, angleDelta, clamp } from '@aces/shared/physics';
import type { BulletState, InputFrame, PlaneState } from '@aces/shared/types';

/** Everything the brain may look at this tick — assembled by the room. */
export interface BotView {
  self: PlaneState;
  /** All planes including teammates; the brain filters friendlies itself. */
  others: readonly PlaneState[];
  bullets: readonly BulletState[];
  map: AcesMap;
}

/**
 * Persistent brain state, owned and stored by the caller between calls.
 * Deliberately tiny: three numbers are enough for pursuit memory, the
 * acquisition clock, and the weave oscillator phase.
 */
export interface BotMem {
  targetId: string | null;
  /** Seconds left before the current acquisition completes (counts down). */
  reactT: number;
  weavePhase: number;
}

// --- behaviour knobs (bot POLICY, not game balance — balance lives in config,
//     and if a number the contract owns were missing we would STOP, not mint
//     gameplay constants here; these only shape how the frozen thresholds are
//     flown, same discipline as rift's bot brains). --------------------------------

/** P-gain from heading error (rad) to turn input. ~2.5 rad⁻¹ saturates past
 *  ~23°, so gross corrections slam the stick while fine tracking stays
 *  proportional — the difference between a pilot and a bang-bang servo. */
const TURN_GAIN = 2.5;

/** Keep the current target while within this multiple of our own trigger
 *  range. Beyond ~2½ fire ranges a contact is background traffic, not an
 *  engagement; reacquiring him later costs nothing worth avoiding a switch
 *  penalty over. */
const TARGET_STICKY_MULT = 2.5;

/** Weave oscillator frequency (Hz) and base amplitude (rad). The amplitude is
 *  scaled per-bot by diff.turnJitter, so hard bots fly nearly clean lines and
 *  easy ones snake visibly — difficulty reads as composure, not just aim. */
const WEAVE_HZ = 1.6;
const WEAVE_RAD = 0.55;

/** Evade boost pulses gate on the weave sine's sign: roughly half-duty-cycle
 *  burn instead of a flat drain. §Balance punishes boost spam (BOOST_DRAIN),
 *  and a pilot who dumps all his escape fuel in one breath has none left. */
const EVADE_BOOST_FUEL = 40; // config-adjacent: the brief fixes ">40" verbatim.

/** Pursuit boost blips: per-tick odds × minimum fuel. Pure personality —
 *  closure help when a shot is developing, never a fuel dump. */
const BOOST_BLIP_ODDS = 0.03;
const BOOST_BLIP_MIN_FUEL = 55;

const DEG2RAD = Math.PI / 180;

function findById(others: readonly PlaneState[], id: string | null): PlaneState | null {
  if (id === null) return null;
  for (let i = 0; i < others.length; i++) {
    const p = others[i];
    if (p && p.id === id) return p;
  }
  return null;
}

function sqDist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** Nearest living enemy plane, ties broken by view order (deterministic given
 *  the room's stable roster order). Teammates and corpses never qualify. */
function nearestLivingEnemy(others: readonly PlaneState[], self: PlaneState): PlaneState | null {
  let best: PlaneState | null = null;
  let bestD2 = Infinity;
  for (let i = 0; i < others.length; i++) {
    const p = others[i];
    if (!p || p.dead || p.team === self.team) continue;
    const d2 = sqDist(self.x, self.y, p.x, p.y);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  return best;
}

/**
 * Compute one tick of pilot intent for `view.self`.
 *
 * Mutates ONLY `mem` (weave phase, reaction clock, target id) — the caller
 * persists it. Draws exactly once from `rng`. Fires never while invulnerable
 * (spawn protection forbids shooting, mirroring fireVolley's own gate) and
 * never above RELEASE_HEAT (bots release BEFORE the jam, unlike players who
 * learn it the hard way).
 */
export function computeIntent(
  view: BotView,
  diff: BotDifficultySpec,
  rng: () => number,
  mem: BotMem,
  dt: number,
): InputFrame {
  const self = view.self;

  // Time passes even with an empty sky: the personality clock keeps ticking
  // and the acquisition clock keeps counting down, both clamped/deterministic.
  mem.weavePhase += dt * WEAVE_HZ;
  const clockWasRunning = mem.reactT > 0;
  mem.reactT = Math.max(0, mem.reactT - dt);

  // One unconditional draw keeps the rng stream cadence branch-independent.
  const roll = rng();

  if (self.dead) {
    return { seq: 0, th: 0, tr: 0, fire: false, boost: false };
  }

  // --- 1 · TARGET ACQUISITION (arm → hold → commit) ----------------------------
  //
  // Keep the remembered bandit while he lives inside the sticky band; else pay
  // diff.reactionMs for whoever is nearest instead. The id in mem.targetId is
  // never overwritten mid-window — see the reaction-law note in the header.
  const prevId = mem.targetId;
  const prev = findById(view.others, prevId);
  const prevUsable = prev !== null && !prev.dead && prev.team !== self.team;
  const stickyRangeU = TARGET_STICKY_MULT * diff.fireRangeU;
  const prevInRange =
    prevUsable && sqDist(self.x, self.y, prev.x, prev.y) <= stickyRangeU * stickyRangeU;

  let tracked: PlaneState | null = null; // what we steer/shoot at this tick
  const near = nearestLivingEnemy(view.others, self);

  if (near === null) {
    mem.targetId = null; // empty sky — forget, nothing to reacquire later
  } else if (near.id === prevId) {
    // Our remembered bandit, inside or beyond the sticky band alike: he is
    // still THE mark we remember. Reacquiring him costs nothing.
    tracked = near;
  } else if (clockWasRunning) {
    // A switch is already mid-window: HOLD LAST STEERING — keep flying the old
    // mark's solution while he lives inside the band, else hands-off straight.
    tracked = prevInRange && prev !== null ? prev : null;
  } else if (prevInRange && prev !== null) {
    // Current mark is alive and engaged, but someone ELSE is now the right
    // target: start paying for the swap, holding the old course meanwhile.
    mem.reactT = diff.reactionMs / 1000;
    tracked = prev;
  } else {
    // No held course (fresh bot / mark died / mark left the band): the new
    // contact costs the same acquisition clock, flown hands-off until paid.
    mem.reactT = diff.reactionMs / 1000;
  }

  // COMMIT: the clock just ran out with a different bandit still nearest —
  // swap the mark and track him THIS tick; the payment is complete.
  const clockJustPaid = clockWasRunning && mem.reactT === 0;
  if (near !== null && near.id !== mem.targetId && clockJustPaid) {
    mem.targetId = near.id;
    tracked = near;
  }

  // Solution anchor for steering AND fire — `tracked` already encodes the
  // whole arm/hold/commit state, so no separate reacting gate exists.
  let aim: PlaneState | null = tracked;

  // Lead solution, computed at most once per tick and shared by the pursuit
  // steerer and the trigger logic (projSpeed = OUR gun's muzzle velocity).
  let lead: { x: number; y: number } | null = null;
  if (aim !== null) {
    lead = aimLead(self.x, self.y, aim.x, aim.y, aim.vx, aim.vy, CLASSES[self.cls].gun.bulletSpeed);
  }

  let tr = 0;
  let th = 1; // full throttle otherwise (brief law)
  let boost = false;

  // --- 2 · RIM AVOIDANCE (strongest priority) ----------------------------------
  //
  // Inside BOT_AI.RIM_MARGIN_U of any edge the wheel belongs to the map
  // center. Full override (not a blend): half-hearted rim bias is how bots
  // wander off the map. Fire stays live — strafing while egressing is free.
  const m = BOT_AI.RIM_MARGIN_U;
  const nearRim =
    self.x < m || self.y < m || self.x > view.map.w - m || self.y > view.map.h - m;

  // --- 3 · EVADE -----------------------------------------------------------------
  //
  // Below BOT_AI.EVADE_HP_FRACTION: break perpendicular AWAY from the nearest
  // threat. Threats are living enemy PLANES (D5's "break off when
  // outmaneuvered" is about aircraft); individual bullets close faster than a
  // turn rate can meaningfully dodge, so chasing them reads as noise.
  const hpFrac = self.hp / CLASSES[self.cls].hp;
  const evading = !nearRim && hpFrac < BOT_AI.EVADE_HP_FRACTION && near !== null;

  if (nearRim) {
    const want = Math.atan2(view.map.h / 2 - self.y, view.map.w / 2 - self.x);
    tr = clamp(angleDelta(self.h, want) * TURN_GAIN, -1, 1);
    th = 1; // escaping the band outranks everything, speed included
  } else if (evading) {
    // Perpendicular to the threat bearing, ±90° — pick the variant closer to
    // the nose so the break starts NOW instead of through the longest arc.
    const threat = near;
    const away = Math.atan2(self.y - threat.y, self.x - threat.x);
    const candA = away + Math.PI / 2;
    const candB = away - Math.PI / 2;
    const dA = Math.abs(angleDelta(self.h, candA));
    const dB = Math.abs(angleDelta(self.h, candB));
    const want = dA <= dB ? candA : candB;
    tr = clamp(angleDelta(self.h, want) * TURN_GAIN, -1, 1); // saturates: HARD turn
    th = BOT_AI.EVADE_THROTTLE; // tighten the defensive circle
    // Pulse, don't pour: sin-gated on the weave oscillator (~half duty cycle)
    // preserves escape fuel while still opening distance every other beat.
    boost = Math.sin(mem.weavePhase) > 0 && self.boost > EVADE_BOOST_FUEL;
  } else if (aim !== null && lead !== null) {
    // --- 4 · PURSUIT: fly the INTERCEPT, not the chase -------------------------
    //
    // Desired heading aims at the predicted intercept point; the sinuous weave
    // offset rides on the desired heading (scaled by turnJitter — easy bots
    // snake, hard bots fly clean). Steering toward where he WILL be is what
    // separates a pilot from a turret (D5) and what the unit tests pin.
    const weave = Math.sin(mem.weavePhase) * WEAVE_RAD * diff.turnJitter;
    const err = angleDelta(self.h, Math.atan2(lead.y - self.y, lead.x - self.x) + weave);
    tr = clamp(err * TURN_GAIN, -1, 1);
    th = 1;
    // Occasional boost blip for closure — the single rng draw of the tick.
    boost = roll < BOOST_BLIP_ODDS && self.boost > BOOST_BLIP_MIN_FUEL;
  }
  // else: empty sky (or mid-reaction with no held course) — cruise straight,
  // full throttle, hands light on the stick.

  // --- 5 · TRIGGER -----------------------------------------------------------------
  //
  // All gates from the behavior law, evaluated against the CURRENT solution:
  //   cone < aimErrDeg · range < fireRangeU · guns not jammed · heat released
  //   before RELEASE_HEAT · spawn protection off · target alive.
  // Suppressed while evading: during a defensive break the nose sweeps across
  // the cone and would chatter the trigger, burning the heat budget D2 calls
  // the duel's resource for shots that mostly miss.
  let fire = false;
  if (aim !== null && lead !== null && !evading) {
    const distToTarget = Math.hypot(aim.x - self.x, aim.y - self.y);
    const coneErr = Math.abs(angleDelta(self.h, Math.atan2(lead.y - self.y, lead.x - self.x)));
    fire =
      coneErr < diff.aimErrDeg * DEG2RAD &&
      distToTarget < diff.fireRangeU &&
      !self.jammed &&
      self.heat <= BOT_AI.RELEASE_HEAT &&
      self.invulnT === 0 &&
      !aim.dead;
  }

  // seq is stamped by the room when it files the frame per player (same
  // convention as World.NEUTRAL_INPUT); the brain has no seat identity.
  return { seq: 0, th: clamp(th, -0.3, 1), tr: clamp(tr, -1, 1), fire, boost };
}
