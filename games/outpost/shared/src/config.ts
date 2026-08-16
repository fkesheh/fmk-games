// ============================================================================
// FROZEN CONTRACT — OUTPOST balance & tuning.
//
// PURE DATA. No logic, no functions, no imports of game systems. Every number
// a system uses is read from here — an implementer that invents a balance
// constant in a body has violated the contract.
//
// Each block states the DESIGN INTENT its numbers must produce, so the numbers
// are checkable against intent rather than being loose magic. See DESIGN_BIBLE.md.
// ============================================================================

import { PLAYER, TICK_RATE, WEAPONS } from '@fps/shared';
import type { WeaponId } from '@fps/shared';
import type { ZombieKind } from './types.js';

export const GAME_ID = 'outpost';
export const GAME_NAME = 'OUTPOST';
/** Vite dev server port; the platform dev proxy probes this exact number. */
export const DEV_PORT = 5179;

// ---------------------------------------------------------------------------
// Simulation & netcode
// ---------------------------------------------------------------------------

/**
 * MUST equal STRICKEN's TICK_RATE. The shared `stepBody` is tuned for a fixed
 * TICK_DT and the client replays prediction at exactly this rate; a different
 * value silently desyncs prediction from the server.
 */
export const SIM_HZ = TICK_RATE; // 30
export const TICK_DT = 1 / SIM_HZ;

export const NETCODE = {
  /** Send a snapshot every Nth tick: 30 / 2 = 15 Hz. */
  snapshotEveryTicks: 2,
  /**
   * Remote-entity render delay. MUST exceed one snapshot interval (66.7ms) with
   * margin or remote zombies stutter between snapshots.
   */
  interpDelayMs: 150,
  interpMaxExtrapolateMs: 100,
  pingEveryMs: 2000,
  lagCompMaxMs: 250,
  lagBufferTicks: 64,
  maxInputPerTick: 4,
  inputQueueCap: 90,
  inputTimeoutMs: 5000,
} as const;

export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 16;

// ---------------------------------------------------------------------------
// Survivors
//
// INTENT: a survivor is fragile in melee and durable at range. Two shambler
// swings hurt; four put you down. The tower is safe from melee entirely, which
// is why the economy (below) has to drag you off it.
// ---------------------------------------------------------------------------

export const SURVIVOR = {
  maxHp: PLAYER.maxHp, // 100
  /** Health regenerates only out of combat, and never past `regenCap`. */
  regenDelaySec: 6, // since last damage taken
  regenPerSec: 4,
  regenCap: 100,
  /** Firearm slots (the knife is always carried and does not occupy one). */
  firearmSlots: 2,
  /** Issued on spawn, in order. */
  startWeapons: ['knife', 'pistol'] as readonly WeaponId[],
  /**
   * Survivors arrive with a stake, not empty-handed. At 0 the first wave was
   * spent entirely unable to interact with either the crate or the rack, so
   * neither economy verb existed until wave 2 — the player met the systems
   * only after the moment they were meant to teach them.
   *
   * NOTE: 1000 is a PLAYTEST value — it buys the rifle (550) outright on wave 1
   * and short-circuits the intended progression (shotgun ~w3, rifle ~w6). Fine
   * for exercising the rack and the guns; drop it back toward ~150 before this
   * is balanced for real.
   */
  startScrap: 1000,
  /** Speed multiplier while downed-crawling. 0 = fully immobile. */
  downedMoveMul: 0,
} as const;

export const DOWNED = {
  /** Seconds from going down to dying with nobody reviving. */
  bleedoutSec: 45,
  /** HP restored to a revived survivor. */
  reviveHp: 40,
  /** Seconds a teammate must hold INTERACT, uninterrupted. */
  holdSec: 4,
  /** Max centre-to-centre distance to start/continue a revive. */
  range: 2.2,
  /**
   * A downed survivor still takes damage; zombies finish them. This is the
   * pressure that makes reviving a real risk rather than a free action.
   */
  damageMul: 0.5,
} as const;

// ---------------------------------------------------------------------------
// Economy
//
// INTENT (the core decision, checkable): the tower is safe but the ammo crate
// is on its GROUND floor and the fence can only be repaired from the ground.
// A player who never descends runs dry and watches the fence fall. Solo pacing
// target: shotgun affordable by ~wave 3, rifle by ~wave 6, sniper by ~wave 10.
// ---------------------------------------------------------------------------

export const ECONOMY = {
  /** Scrap per kill, by kind. Headshots multiply by `headshotMul`. */
  killScrap: {
    shambler: 12,
    runner: 16,
    brute: 45,
    spitter: 28,
  } as Record<ZombieKind, number>,
  headshotMul: 1.5,
  /** Scrap for damaging a zombie you did not kill, per 100 damage. */
  assistScrapPer100: 4,

  /** Weapon rack prices (tower deck 1). Independent of STRICKEN's PvP prices. */
  weaponPrice: {
    knife: 0,
    pistol: 0,
    shotgun: 200,
    smg: 300,
    rifle: 550,
    sniper: 900,
  } as Record<WeaponId, number>,

  /**
   * Ammo crate (tower GROUND floor): buys ONE magazine of reserve for the
   * currently-held weapon, repeatable while INTERACT is held.
   *
   * Was a single 60-scrap "fill everything" lump, which competed head-on with a
   * 200-scrap gun and made hoarding the correct play — you either committed a
   * third of a shotgun to ammo or you were locked out entirely. A small
   * repeatable tick turns restocking into a trickle you can stop at any point,
   * and lets a broke player top up with 10 instead of nothing.
   */
  ammoRefillCost: 10,
  /** Seconds between successive magazine purchases while holding INTERACT. */
  ammoRefillIntervalSec: 0.35,

  /** Fence repair, charged continuously while holding INTERACT. */
  repairScrapPerHp: 0.35,
  repairHpPerSec: 26,
  /** A breached segment rebuilds at this fraction of the normal rate/cost-efficiency. */
  rebuildRateMul: 0.5,
  rebuildCostMul: 1.5,
} as const;

// ---------------------------------------------------------------------------
// Waves
//
// INTENT: wave 1 is survivable solo with the issued pistol and no repairs.
// The first breach lands around wave 4-6 for a squad that never repairs.
// Runners break the "stand still and aim" habit, brutes break the fence fast
// enough to force a repair trip, spitters break turtling on the top deck.
// ---------------------------------------------------------------------------

export const WAVES = {
  /** count = round(base * growth^(wave-1) * (playerBase + playerStep * players)) */
  baseCount: 8,
  growth: 1.22,
  playerBase: 0.6,
  playerStep: 0.4, // 1 player -> x1.0, 4 -> x2.2, 16 -> x7.0

  /** Zombie HP multiplier per wave: 1 + hpGrowth*(wave-1), capped. */
  hpGrowth: 0.09,
  hpCapMul: 3.5,

  /** Wave at which each kind first appears. */
  unlock: {
    shambler: 1,
    runner: 3,
    brute: 6,
    spitter: 8,
  } as Record<ZombieKind, number>,

  /**
   * Relative weights once unlocked. Shamblers stay the bulk of the horde so the
   * silhouette language of a wave stays readable.
   */
  weight: {
    shambler: 100,
    runner: 45,
    brute: 12,
    spitter: 16,
  } as Record<ZombieKind, number>,

  /** Seconds between clearing a wave and the next one starting. */
  intermissionSec: 22,
  /**
   * Waves are on a CLOCK, not on clearing. Wave N+1 lands `wavePeriodSec`
   * after wave N started whether or not you finished N, so a wave you cannot
   * clear becomes accumulating pressure instead of a stalled run. Clearing
   * early still buys the leftover time as an intermission — it just cannot
   * postpone the next wave. `intermissionSec` is now only the OPENING lull
   * and a ceiling on that earned breather.
   */
  wavePeriodSec: 60,
  /** Seconds after START before wave 1 spawns (lets everyone orient). */
  openingLullSec: 8,
  /**
   * Spawn drip, PER PLAYER-SCALED WAVE: zombies enter at
   *   spawnPerSecBase * (playerBase + playerStep * players)
   * so the drip scales with the wave it is feeding.
   *
   * A flat rate was a silent difficulty collapse at high headcount: wave size
   * scales x7.0 at 16 players, so a fixed 2.4/s meant a 16-player wave 10 (339
   * zombies) took 141 SECONDS to spawn in and wave 20 took 17 minutes, with the
   * alive count pinned far below HORDE.maxAlive by the drip rather than by the
   * squad's guns. The headline player count would have had no pressure, only
   * length.
   */
  spawnPerSecBase: 2.4,
  /** The run darkens: waves >= this render with the 'night' mood. */
  nightFromWave: 4,
} as const;

// ---------------------------------------------------------------------------
// The horde
//
// INTENT: four silhouettes readable at 40m by shape alone (see STYLE_BIBLE).
// Speeds are chosen against the REAL approach distance: HORDE.spawnRing 58 minus
// FENCE_HALF 20 = 38 m on a cardinal. A runner closes it in ~8.6 s, a shambler
// in ~22.4 s — the wave arrives as a spread, not a block. (These read 32 m / 7 s
// / 19 s while spawnRing was 52; a stale intent block is worse than none, because
// config.ts's header makes intent normative and a tuning agent would have moved
// the speeds ~19% to satisfy a clock that no longer exists.)
// ---------------------------------------------------------------------------

export const ZOMBIE_BASE: Record<ZombieKind, {
  hp: number;
  speed: number;
  height: number;
  radius: number;
  meleeDmg: number;
  meleeReach: number;
  meleeInterval: number;
  fenceDps: number;
}> = {
  shambler: { hp: 90, speed: 1.7, height: 1.85, radius: 0.34, meleeDmg: 12, meleeReach: 1.6, meleeInterval: 1.3, fenceDps: 22 },
  runner: { hp: 55, speed: 4.4, height: 1.75, radius: 0.3, meleeDmg: 9, meleeReach: 1.5, meleeInterval: 0.8, fenceDps: 14 },
  brute: { hp: 420, speed: 1.9, height: 2.5, radius: 0.55, meleeDmg: 30, meleeReach: 2.0, meleeInterval: 1.8, fenceDps: 70 },
  spitter: { hp: 110, speed: 2.2, height: 1.9, radius: 0.34, meleeDmg: 14, meleeReach: 1.6, meleeInterval: 1.4, fenceDps: 10 },
};

export const HORDE = {
  /** Hard cap on concurrently-alive zombies. Excess queue and drip in as
   *  others die — this is what keeps the draw-call budget reachable. */
  maxAlive: 48,
  /**
   * Radius of the spawn ring. MUST sit just inside the treeline's leading edge
   * (STYLE_BIBLE places conifers at r = 56..84) so the horde genuinely emerges
   * FROM the trees — the whole readability thesis is `rotPale` figures against
   * `pineDeep` trunks, and the first draft's 52 put them 10 m out in open mud
   * with the forest as distant backdrop, i.e. visible pop-in and no contrast
   * read at spawn.
   */
  spawnRing: 58,
  /** Zombies inside this radius get the animated near-LOD model. */
  nearLodDist: 20,
  /** Max simultaneous near-LOD zombies (nearest N). The rest use the baked LOD. */
  nearLodMax: 14,
  /** Seconds a corpse stays before the pool slot is freed. */
  corpseSec: 6,
  /** A zombie repaths/retargets at most this often (seconds). */
  retargetSec: 1.5,
  /**
   * How strongly the horde is drawn to where the SURVIVORS are.
   *
   * A zombie outside the fence used to pick the segment nearest ITSELF, which
   * made the wave spread evenly around a 40 m perimeter and read as "the dead
   * care about timber, not about me". Segment choice is now scored as
   *   dist(zombie -> spot) + survivorPull * dist(spot -> nearest survivor)
   * so the horde converges on the wall the squad is actually standing behind,
   * while still preferring segments it can reach quickly. 0 = old behaviour.
   */
  survivorPull: 1.35,
  /**
   * A survivor caught OUTSIDE the fence (or through a breach) is hunted
   * directly from this range, instead of the zombie plodding on to the wall.
   */
  pursueRadius: 14,
  /** Separation steering radius so the horde spreads instead of stacking. */
  separationRadius: 1.1,
  separationForce: 2.6,
} as const;

export const SPIT = {
  /** Spitter opens fire inside this range and stops closing. */
  range: 22,
  minRange: 8,
  cooldownSec: 3.4,
  speed: 18, // m/s launch
  gravity: 14, // m/s^2 (lighter than the player's 20 — a readable lazy arc)
  ttlSec: 4,
  directDmg: 18,
  splashDmg: 12,
  splashRadius: 2.6,
} as const;

// ---------------------------------------------------------------------------
// The fence
//
// INTENT: one brute alone chews through a segment in ~4.6s of uninterrupted
// contact (320 / 70). Two shamblers take ~7.3s. That is the clock a defender
// is racing, and it is short enough that ignoring a side has visible cost.
// ---------------------------------------------------------------------------

export const FENCE = {
  /** 4 sides x 4 segments, indexed clockwise from the north-west corner. */
  segments: 16,
  segmentHp: 320,
  /**
   * Height of an intact segment (metres).
   *
   * 1.6, NOT 2.0. At 2.0 the geometry silently deleted a design pillar: a
   * survivor on the 0.4 m firing step has an eye at 0.4 + heightStand(1.8) -
   * eyeOffset(0.18) = 2.02, which cleared a 2.0 m fence by TWO CENTIMETRES.
   * That allows a maximum depression of 1.76 deg, so at the 1.575 m range a
   * zombie actually stands from the eye, the lowest reachable point was y=1.97
   * and the shambler (head-top 1.85), runner (1.75) and spitter (1.90) were all
   * literally unhittable from the firing step. Only the brute could be shot.
   * The gauntlet measured this; it is not a taste call.
   *
   * At 1.6 the eye clears by 0.42 m over a 0.65 m run to the outer face — a
   * ~33 deg depression, putting the lowest reachable point at y=1.00 at that
   * range. Head and torso of every kind are hittable. Still unclimbable by
   * anything: PLAYER.stepUp is 0.42 and the jump apex from the step is 1.27.
   */
  height: 1.6,
  thickness: 0.35,
  /** Inside firing step: walkable via PLAYER.stepUp (0.42), puts eyes over the top. */
  stepHeight: 0.4,
  stepDepth: 1.4,
  /**
   * RENDER-ONLY. A breached segment contributes NO collision (see
   * `segmentAABB`'s doc) — both sides simply walk through the gap at ground
   * level. This is the height the art department draws the rubble scatter at;
   * no simulation code reads it.
   */
  rubbleHeight: 0.3,
  /**
   * Fence damage is CONTINUOUS, not per-swing: a zombie in contact deals
   * exactly `ZOMBIE_BASE[kind].fenceDps` per second, applied as
   * `fenceDps * dt` every tick it is in reach. `meleeInterval` governs swings
   * at SURVIVORS only.
   *
   * Frozen here because the first draft said "chew the fence on the melee
   * interval" in one place and quoted continuous-dps clocks in another — a
   * 1.8-2.3x swing on the game's central clock, with the test and the
   * implementation written by different agents who cannot read each other.
   */
  damageIsContinuous: true,
} as const;

/**
 * Interaction ranges. Frozen here because config.ts forbids implementers from
 * inventing constants, and the first draft only defined the revive range —
 * leaving `resolveInteract` to invent the other two in a body.
 */
export const INTERACT = {
  /**
   * Max distance to a segment's WALL to repair it, measured with
   * `segmentDistance()` from map.ts — perpendicular distance clamped to the
   * segment span, NOT distance to its centre point. See that helper for why
   * the distinction is load-bearing (a centre-point reading leaves 51% of every
   * segment un-repairable).
   */
  repairRange: 2.6,
  /** Max distance to the weapon rack / ammo crate feature points. */
  stationRange: 2.4,
  /** Mirrors DOWNED.range so all four kinds are resolved against one table. */
  reviveRange: 2.2,
} as const;

// ---------------------------------------------------------------------------
// Performance budget
//
// The previous build measured 81-121 draw calls against a 220 budget and 1-1.9
// ms frames — it was never the perf that failed, it was the look. These stay
// generous on purpose: spend the headroom on density and lighting.
// ---------------------------------------------------------------------------

export const PERF = {
  /**
   * 420, not 200. The gauntlet did the arithmetic the first draft did not:
   * 14 articulated near-LOD zombies (>=6 unbakeable limb sub-meshes each) = 84,
   * 34 far-LOD zombies = 34, 16 animated survivors ~= 96, per-character contact
   * shadows = 64, 16 fence segments that cannot share a bake because each shows
   * its own damage state ~= 80, plus the baked world/fort/sky/viewmodel/FX ~= 40.
   * That is ~400 before the shadow pass — against a cap the draft had LOWERED
   * to 200 while multiplying the density the style bible demands. The budget
   * would have been discovered by a judge instead of a gate, and the only lever
   * left would have been cutting exactly the density that makes it look good.
   *
   * To make 420 comfortable rather than tight, two things are MANDATED:
   *   - far-LOD zombies render as ONE THREE.InstancedMesh, not N meshes;
   *   - a character's contact shadow is part of its baked model, not a sibling.
   * `InstancedMesh` is an explicitly permitted exception to the visual.ts-only
   * rule, in `render/zombies.ts` and `render/world.ts`.
   */
  maxDrawCalls: 420,
  targetFrameMs: 16.7,
  /**
   * Hard ceiling asserted by the e2e harness during a live wave. The harness
   * MUST measure this with HORDE.maxAlive zombies alive (spawn them via the
   * debug API) — measuring with whatever two test clients happen to have
   * populated is measuring nothing.
   */
  maxFrameMsUnderLoad: 33,
} as const;

// ---------------------------------------------------------------------------
// MEASURED VISUAL ACCEPTANCE GATES
//
// The previous build's art thesis failed silently because nothing measured the
// rendered pixels: an intended "one saturated element" horde came out at
// 0.00%, and 65% of every frame was functionally black while the constants
// "looked right" in source. Reading a constant back is not evidence. The
// capture harness computes these from the PNG and FAILS the shot when they
// are not met.
// ---------------------------------------------------------------------------

export const VISUAL_GATES = {
  /**
   * THE 3D REGION is defined as: the full canvas, MINUS every rect reported by
   * `telemetry().hudRect`. It is not "the frame". Both previous post-mortems
   * computed their histograms with the HUD masked out and said so; the first
   * draft of this file shipped no mask at all, which left four different agents
   * to each decide whether HUD chrome counts — and a dark scene can pass on
   * bright HUD pixels alone.
   */
  minMedianLuma: 48,
  /** Share of pixels below luma 20. STRICKEN measures 2-3%; the old build hit 65%. */
  maxShadowShare: 0.08,
  /**
   * Near-field blowout. Threshold is luma 200, NOT 240: the blowout the fort
   * review condemned measured #dcc5bd (luma 201) and #dbc3bc (luma 200) on
   * geometry a metre from the camera, so a 240 cut-off passed the exact frame
   * it existed to catch.
   */
  blowoutLuma: 200,
  maxBlowoutShare: 0.02,
  /**
   * Flat-surface guard. Measured over the `sampleRect` each shot descriptor
   * declares — NOT "any patch", which is unsatisfiable (a smooth sky gradient
   * fails it by design) and unmeasurable (nothing can tell the harness which
   * pixels are "built surface"). The previous build measured stddev-luma 7.3
   * over a 300x220 wall patch and was called "a solid colour swatch"; that is
   * the failure this catches, and it MUST appear in the capture harness's fail
   * list — in the first draft it was defined and then never checked.
   */
  minSurfaceStddev: 12,
  /**
   * THE HORDE GATE — the measurement that exists so the previous build's
   * "0.00% of the intended horde colour, in every frame, with zombies alive"
   * cannot recur silently.
   *
   * A pixel counts as horde iff, in the 3D region:
   *   luma >= hordePixel.minLuma
   *   AND HSV saturation <= hordePixel.maxSat
   *   AND HSV hue in [minHueDeg, maxHueDeg]
   * This is a real classifier, not prose. Verified to admit `rotPale`
   * (luma 207, sat 0.19, hue 74) and `rotFlesh` (luma 159, sat 0.26, hue 79)
   * while excluding `floodBeam` (hue 38), `sandbagLit` (hue 45),
   * `moonlight` (hue 220) and all sky/fog/pine keys.
   *
   * The harness MUST ASSERT the precondition rather than skipping when it is
   * not met: a capture run where the horde never arrived is a FAILED run, not
   * an exempt one. The first draft made the gate conditional on the very fact
   * it existed to prove.
   */
  hordePixel: { minLuma: 150, maxSat: 0.4, minHueDeg: 62, maxHueDeg: 110 },
  // 62, not 55: a full sweep of the merged 125-key palette found exactly one
  // false positive at 55 — "concreteLit" (#b9b9ac, luma 184, sat 0.07, hue
  // EXACTLY 60.0). "concrete" is a live MatKind, so a lit hard-standing filling
  // the frame would have satisfied the horde gate with zero zombies on screen.
  // rotPale is 73.5 deg and rotFlesh 79.1, so 62 keeps ~11 deg of margin.
  // MEASURED, not guessed. At the previously-specified 25 m, six zombies
  // occupy ~665 classifiable px of a 783k-px 3D region = 0.085% — the gate was
  // unreachable by 4x at its own stated radius, which means the harness author
  // hits an unpassable assertion and deletes the one defence against the
  // previous build's 0.00%-horde failure. At 12 m the same six measure 0.368%.
  minHordePixelShare: 0.0025,
  hordeMinZombiesForGate: 6,
  /** ...and they must be this close, or 6 distant zombies satisfy it trivially. */
  hordeGateRadius: 12,
  /** A kept screenshot must be at least this large — blank frames compress tiny. */
  minShotBytes: 30 * 1024,
  /**
   * Modal overlays permitted over a kept 3D frame. Exactly zero.
   * NOTE: an "overlay" is a modal layer under `#menu` ONLY. The always-on HUD
   * (`#hud`) is NEVER an overlay — it is masked out of the 3D region instead,
   * which is what lets the `hud-play` shot exist at all.
   */
  maxOverlays: 0,
} as const;

// ---------------------------------------------------------------------------
// Re-export the weapon table unchanged — OUTPOST uses STRICKEN's guns verbatim.
// Only the PRICES differ (ECONOMY.weaponPrice); everything ballistic is shared.
// ---------------------------------------------------------------------------
export { WEAPONS };
