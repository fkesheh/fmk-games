/**
 * RIFT AUDIO — FROZEN CONFIG. Pure data. Zero logic, zero imports of runtime code.
 *
 * IMMUTABLE. No implementer may change a value here. These numbers are the mix, and the
 * mix is art-directed, not emergent. If a cue sounds wrong, fix the cue — not the table.
 *
 * Every frequency a cue uses must come from `PALETTE` or be derived from it via the
 * documented ratios. A bare frequency literal in cue code is a contract violation, exactly
 * as an ad-hoc hex colour would be in a visual build. See SONIC_BIBLE §3.
 */

import type {
  AudioEventTag,
  AudioSettings,
  BusId,
  MusicLayer,
  Priority,
  SceneDef,
} from './contract.js';

// ---------------------------------------------------------------------------
// 1. The tonal palette — D natural minor, five registers. SONIC_BIBLE §3.
// ---------------------------------------------------------------------------

export const PALETTE = {
  /** Root of the entire game. Everything tonal is tuned to D. */
  rootHz: 73.42,

  /** Structures, ultimates, objective weight. */
  sub: { D1: 36.71, A1: 55.0, D2: 73.42 },

  /** Impacts, hero deaths, tower attacks. */
  low: { D2: 73.42, F2: 87.31, A2: 110.0, D3: 146.83 },

  /** Casts, steel, the body of the fight. */
  mid: { D3: 146.83, F3: 174.61, A3: 220.0, C4: 261.63, D4: 293.66 },

  /** Arcane shimmer, healing, magic tails. */
  high: { F4: 349.23, A4: 440.0, D5: 587.33, F5: 698.46 },

  /**
   * RESERVED FOR INFORMATION ONLY: last-hit, level-up, skill point, cooldown ready,
   * purchase, error, announcer. No other cue may put significant energy above
   * `INFO_FLOOR_HZ`. This is what makes the gold chime cut a teamfight.
   */
  info: { A5: 880.0, D6: 1174.66, F6: 1396.91, A6: 1760.0 },
} as const;

/** Above this, only `info`-register cues may carry meaningful energy. */
export const INFO_FLOOR_HZ = 800;

/**
 * "Meaningful energy", made adjudicable so the harness can gate it instead of leaving it
 * to taste: a NON-info cue may put at most this percentage of its total energy above
 * `INFO_FLOOR_HZ` (i.e. in the 800-2000 + 2000-4000 + 4000-20000 bands combined).
 * Brief transients are what the allowance is for.
 */
export const INFO_BAND_MAX_PCT = 8;

/**
 * D natural minor (Aeolian), 12-TET — the SAME tuning system as the `PALETTE` tables.
 * These MUST agree: a just-intonation set here (9/8, 6/5, 4/3, 3/2, 8/5, 9/5) drifts up
 * to 17.6 cents from the 12-TET palette entries, so a music layer built with `degree()`
 * would beat audibly against an announcer sting built from `PALETTE.mid.C4`. The whole
 * point of the palette is that independently-written cues agree; two tuning systems
 * defeats it. `degree(PALETTE.rootHz, n, k)` reproduces the palette to within 1 cent.
 */
export const MINOR_STEPS: readonly number[] = [
  1, 1.122462, 1.189207, 1.334840, 1.498307, 1.587401, 1.781797,
];

/**
 * Allegiance intervals. Team is carried by INTERVAL, never by loudness or pitch height.
 * SONIC_BIBLE §3 + §11 (accessibility).
 */
export const INTERVAL = {
  /** Perfect fifth + octave: consonant, settled, "mine". */
  ally: [1, 1.498307, 2] as readonly number[],
  /** Minor second + tritone: tense, unsettled, "theirs". */
  enemy: [1, 1.059463, 1.414214] as readonly number[],
} as const;

/** Inharmonic partial ratios for the `metal` archetype. Non-integer on purpose. */
export const METAL_RATIOS: readonly number[] = [1, 1.73, 2.41, 3.17, 4.61, 5.83];

// ---------------------------------------------------------------------------
// 2. Bus levels and the limiter. SONIC_BIBLE §8.
// ---------------------------------------------------------------------------

/** Static bus trim in dBFS, applied before user volume. */
export const BUS_DB: Readonly<Record<BusId, number>> = {
  sfx: 0,
  ui: -3,
  announcer: -2,
  amb: -18,
  music: -14,
};

/** Glue compressor on `preMaster`. Not a mix tool — a safety net with character. */
export const GLUE = {
  thresholdDb: -12,
  kneeDb: 14,
  ratio: 3,
  attackS: 0.004,
  releaseS: 0.22,
} as const;

/**
 * Soft-clip limiter asymptote, in the SAMPLE domain. Deliberately 1 dB below the
 * true-peak gate: waveshaping flat-tops peaks, and 4x-oversampled reconstruction of a
 * flat-topped wave overshoots the sample peak by roughly 0.5-1.5 dB. A sample ceiling
 * set AT the true-peak gate would make the gate unpassable on any dense scene.
 */
export const LIMIT_CEILING_DB = -2.0;

/** What the render harness asserts on the rendered output. True-peak, 4x oversampled. */
export const TRUE_PEAK_GATE_DBTP = -1.0;

/** Master gain at settings.master === 1. Leaves headroom for the sum of busses. */
export const MASTER_TRIM_DB = -3;

// ---------------------------------------------------------------------------
// 3. Priority and ducking. SONIC_BIBLE §8.
// ---------------------------------------------------------------------------

export const PRIORITY_CLASS: Readonly<Record<Priority, string>> = {
  0: 'match-defining',
  1: 'objective',
  2: 'self-critical',
  3: 'self-action',
  4: 'nearby-combat',
  5: 'ambient-combat',
  6: 'texture',
};

/**
 * Culling order for `DERIVE.maxPerSnap` and the routing default in `index.ts`. Frozen
 * here so the deriver's drop order and the engine's steal order cannot disagree — they
 * are two halves of one policy and were previously left for two agents to invent twice.
 */
export const EVENT_PRIORITY: Readonly<Record<AudioEventTag, Priority>> = {
  matchEnd: 0,
  structure: 1,
  ancientThreat: 1,
  surge: 1,
  heroDeath: 2,
  levelUp: 2,
  lowHp: 2,
  respawn: 2,
  gold: 3,
  cast: 3,
  hurt: 3,
  skillPointAvailable: 3,
  abilityReady: 4,
  hit: 4,
  heroPick: 4,
  attack: 5,
  unitDeath: 5,
};

export const DUCK = {
  /** A cue of priority <= this ducks music + ambience. */
  bedPriority: 2 as Priority,
  bedDb: -9,
  /** A cue of priority <= this additionally ducks the sfx bus. */
  sfxPriority: 1 as Priority,
  sfxDb: -4,
  attackS: 0.03,
  /** Release is `cue.tail + this`. */
  releasePadS: 0.25,
} as const;

/** Hard cap on simultaneous voices. Over cap, steal oldest of lowest priority. */
export const POLYPHONY_CAP = 24;

/**
 * Never steal a voice whose priority number is at or BELOW this (0 is the highest
 * priority, so "at or below 2" means the match-defining, objective and self-critical
 * classes are protected). Named for the numeric comparison, not the importance.
 */
export const NEVER_STEAL_AT_OR_BELOW: Priority = 2;

/**
 * Cap on `engine.play` calls per snapshot. The existing e2e and verify gates run the
 * match at `speed: 20`, which delivers snapshots ~400x/second; without a cap the audio
 * layer becomes the reason those gates go red. Derivation itself is pure and cheap and
 * always runs — it is the WebAudio node construction that is bounded here.
 */
export const MAX_PLAYS_PER_SNAPSHOT = 8;

// ---------------------------------------------------------------------------
// 4. Space. SONIC_BIBLE §6.
// ---------------------------------------------------------------------------

export const SPATIAL = {
  /** Beyond this many metres from the listener, a cue is not scheduled at all. */
  audibleRadius: 46,
  /** Metres of half-screen used to normalise pan. */
  panHalfWidth: 26,
  /** Never hard-pan; a hard-panned event in a top-down game reads as broken headphones. */
  panMax: 0.85,
  /** Distance rolloff: gain = 1 / (1 + (d/ref)^2), floored. */
  refDistance: 12,
  gainFloor: 0.06,
  /** Reverb send rises with distance: send = min(sendMax, d / audibleRadius * sendScale). */
  sendMax: 0.55,
  sendScale: 0.9,
  /** Camera height scales effective distance: d *= 1 + (h - camRefHeight) * heightScale. */
  camRefHeight: 36,
  heightScale: 0.012,
  /** The player's own actions: no attenuation, centred pan bias, this much louder. */
  selfBiasDb: 3,
  selfPanScale: 0.25,
  /** Under fog: attenuated and lowpassed, NEVER muted. You hear it happen in the dark. */
  fogAttenDb: -9,
  fogCutoffHz: 1200,
} as const;

// ---------------------------------------------------------------------------
// 5. Variation. SONIC_BIBLE §7.
// ---------------------------------------------------------------------------

export const VARY = {
  pitchPct: 0.03,
  attackPitchPct: 0.06,
  levelDb: 1.5,
  timingS: 0.008,
  timbrePct: 0.1,
  /** Round-robin depth for the highest-frequency cues. */
  roundRobin: 4,
} as const;

/** One seeded stream for the whole audio module. `Math.random` is a repo-wide violation. */
export const AUDIO_SEED = 0x51f7;

// ---------------------------------------------------------------------------
// 6. Reverb impulse responses (generated, never loaded).
// ---------------------------------------------------------------------------

export const IR = {
  valley: { seconds: 1.6, decay: 3.2, dampHz: 2400, preDelayS: 0.012 },
  hall: { seconds: 2.8, decay: 2.4, dampHz: 4200, preDelayS: 0.02 },
} as const;

// ---------------------------------------------------------------------------
// 7. Music. SONIC_BIBLE §10.
// ---------------------------------------------------------------------------

export const MUSIC = {
  bpm: 84,
  beatsPerBar: 4,
  /** Look-ahead scheduling window, the standard WebAudio pattern. */
  lookaheadS: 0.35,
  /** Fixed pump step the offline renderer uses; must be < lookaheadS for determinism. */
  offlineStepS: 0.25,
  /** Intensity changes land on the next bar boundary, never mid-phrase. */
  barSynced: true,
  /** Which layers are active at each intensity 0..4. */
  layers: [
    [] as readonly MusicLayer[],
    ['pad'] as readonly MusicLayer[],
    ['pad', 'pulse'] as readonly MusicLayer[],
    ['pad', 'pulse', 'perc'] as readonly MusicLayer[],
    ['pad', 'pulse', 'perc', 'lead'] as readonly MusicLayer[],
  ] as readonly (readonly MusicLayer[])[],
  /** Crossfade time when a layer enters or leaves. */
  layerFadeS: 1.2,
} as const;

/**
 * Tension -> intensity mapping, evaluated per snapshot by index.ts. First match wins,
 * top to bottom. All thresholds are on values the client already has.
 */
export const TENSION = {
  /** Own ancient or enemy ancient below this HP fraction -> intensity 4. */
  ancientRiskHpFrac: 0.6,
  /** Heroes within this radius of self count toward the thresholds below. */
  nearbyRadius: 22,
  /** >= this many heroes (any team) within `nearbyRadius` -> intensity 3. */
  teamfightHeroes: 4,
  /** >= this many -> intensity 2. */
  skirmishHeroes: 2,
  /** Hysteresis: intensity may not drop for this many seconds after rising. */
  holdS: 6,
} as const;

// ---------------------------------------------------------------------------
// 8. Ambience.
// ---------------------------------------------------------------------------

export const AMBIENCE = {
  fadeS: 1.4,
  /** Wind gust LFO. */
  gustHz: 1 / 7,
  windCutoffHz: { min: 220, max: 480 },
  /** Distant-battle layer level range, driven by `setBattleIntensity`. */
  battleDb: { min: -34, max: -20 },
  /** Fountain hum; the `fountain` scene is set within this radius of the own ancient. */
  fountainHz: 55,
  fountainRadius: 6,
} as const;

// ---------------------------------------------------------------------------
// 9. Derived-event thresholds. Consumed by derive.ts.
// ---------------------------------------------------------------------------

export const DERIVE = {
  /** Ignore own-HP deltas below this absolute amount (regen noise). */
  hurtMinHp: 0.5,
  /** Ignore other-entity HP deltas below this absolute amount, for `hit` events. */
  hitMinHp: 1.0,
  /**
   * Minimum gold delta that emits a `gold` event AT ALL. Passive income is
   * `PASSIVE_GOLD_PER_S / TICK_RATE` gold PER TICK and is fractional, so `gold > prevGold`
   * is true on literally every snapshot — without this floor the audio layer would
   * schedule a UI cue 20x a second (400x at the gates' `speed: 20`) for the whole match.
   */
  goldMinDelta: 4,
  /** At or above this in one snapshot, alongside a creep death, it is a last-hit. */
  lastHitMinGold: 8,
  /** Low-HP bands, descending. Crossing into a band emits `lowHp` with that band index. */
  lowHpBands: [0.3, 0.15] as readonly number[],
  /** Heartbeat pulse period in seconds at each band. */
  lowHpPulseS: [1.1, 0.62] as readonly number[],
  /** Death-cam global lowpass. Restored to Infinity on respawn. */
  submergeHz: 800,
  /** Ancient HP fraction below which the klaxon fires (once per crossing). */
  ancientThreatFrac: 0.5,
  /** Max derived events per snapshot; excess dropped by `EVENT_PRIORITY`, worst first. */
  maxPerSnap: 24,
} as const;

// ---------------------------------------------------------------------------
// 10. Per-hero timbre signatures. SONIC_BIBLE §5 — "distinct per hero" is the bar.
//     This is DIRECTION, not parameters: the cue author picks the numbers, but the
//     archetype mix and the character are fixed here so six agents cannot converge.
// ---------------------------------------------------------------------------

export const HERO_TIMBRE = {
  bullwark: {
    character: 'metal and stone — a shield wall moving',
    archetypes: ['metal', 'thump', 'noise'],
    register: 'low',
    note: 'weight first: every cue lands before it rings. No shimmer, ever.',
  },
  longbow: {
    character: 'tension and release — creak, then a sharp snap',
    archetypes: ['noise', 'tone', 'metal'],
    register: 'mid',
    note: 'the bowstring creak is a rising bandpass sweep BEFORE the transient, 60-90ms.',
  },
  reaver: {
    character: "butcher's steel — wet, heavy, unclean",
    archetypes: ['noise', 'metal', 'thump'],
    register: 'low',
    note: 'noise-forward with a wet low thump. Slightly longer, dirtier tails than bullwark.',
  },
  hex: {
    character: 'pure arcane — cold, detuned, out of tune with itself',
    archetypes: ['shimmer', 'tone', 'swell'],
    register: 'high',
    note: 'detuned oscillator pairs + ring mod. Almost no noise. The most tonal hero.',
  },
  mender: {
    character: 'the only warmth in the game',
    archetypes: ['tone', 'swell'],
    register: 'mid',
    note: 'sine/triangle only, soft attacks 30-60ms, rising perfect fifths. Zero noise.',
  },
  shade: {
    character: 'absence — a sound that pulls inward instead of striking out',
    archetypes: ['swell', 'noise', 'shimmer'],
    register: 'mid',
    note: 'reversed-feeling swell, minimal transient, CLOSING filter sweep (sweepHz < filterHz).',
  },
} as const;

// ---------------------------------------------------------------------------
// 11. Settings.
// ---------------------------------------------------------------------------

export const STORAGE_KEY = 'rift.audio';

export const DEFAULT_SETTINGS: AudioSettings = {
  master: 0.8,
  sfx: 1,
  music: 0.7,
  ambience: 0.8,
  muted: false,
};

// ---------------------------------------------------------------------------
// 12. Render-harness scenes — the composite mixes the headroom/ducking judge scores.
//     Positions assume a 112 m map (2 lanes) with the listener at mid.
//
//     `preRollS` is not optional garnish: music at intensity 3 does not reach level until
//     the first bar boundary (2.86 s at 84 bpm) plus a 1.2 s layer fade, and the ambience
//     bed needs 1.4 s to cross-fade in. Every measurement below lands inside that window,
//     so without a pre-roll the ducking test would duck silence and the cut-through test
//     would measure a chime against no bed at all — and both would pass.
// ---------------------------------------------------------------------------

const L = { x: 56, z: 56, height: 36 } as const;
const PRE_ROLL = 6;

export const SCENES: readonly SceneDef[] = [
  {
    name: 'menuBed',
    seconds: 6,
    listener: L,
    music: 1,
    ambience: 'menu',
    preRollS: PRE_ROLL,
    steps: [
      { atSec: 1.0, id: 'ui.click' },
      { atSec: 2.4, id: 'ui.pick' },
      { atSec: 4.0, id: 'obj.countdown' },
    ],
  },
  {
    name: 'laning',
    seconds: 8,
    listener: L,
    music: 1,
    ambience: 'field',
    preRollS: PRE_ROLL,
    steps: [
      { atSec: 0.4, id: 'atk.creep.melee', opt: { x: 60, z: 58 } },
      { atSec: 0.52, id: 'hit.physical', opt: { x: 61, z: 59 } },
      { atSec: 1.1, id: 'atk.creep.ranged', opt: { x: 62, z: 55 } },
      { atSec: 1.9, id: 'atk.creep.melee', opt: { x: 59, z: 59 } },
      { atSec: 2.6, id: 'die.creep', opt: { x: 60, z: 58 } },
      { atSec: 2.66, id: 'ui.lastHit' },
      { atSec: 4.2, id: 'atk.hero.melee', opt: { x: 56, z: 56, self: true } },
      { atSec: 5.5, id: 'atk.creep.melee', opt: { x: 74, z: 70 } },
    ],
  },
  {
    name: 'skirmish',
    seconds: 8,
    listener: L,
    music: 2,
    ambience: 'field',
    preRollS: PRE_ROLL,
    steps: [
      { atSec: 0.3, id: 'cast.longbow.0', opt: { x: 52, z: 54 } },
      { atSec: 0.9, id: 'hit.physical', opt: { x: 60, z: 58 } },
      { atSec: 1.4, id: 'cast.hex.0', opt: { x: 62, z: 60 } },
      { atSec: 2.0, id: 'hit.magic', opt: { x: 56, z: 56, self: true } },
      { atSec: 2.1, id: 'hit.self', opt: { x: 56, z: 56, self: true } },
      { atSec: 3.2, id: 'cast.mender.0', opt: { x: 54, z: 52, self: true } },
      { atSec: 4.6, id: 'cast.reaver.2', opt: { x: 61, z: 57 } },
      { atSec: 5.4, id: 'die.hero', opt: { x: 61, z: 57 } },
    ],
  },
  {
    name: 'teamfight',
    seconds: 10,
    listener: L,
    music: 3,
    ambience: 'field',
    preRollS: PRE_ROLL,
    steps: [
      { atSec: 0.2, id: 'cast.bullwark.0', opt: { x: 58, z: 57 } },
      { atSec: 0.5, id: 'cast.hex.3', opt: { x: 62, z: 60 } },
      { atSec: 0.8, id: 'hit.magic', opt: { x: 56, z: 56, self: true } },
      { atSec: 1.0, id: 'atk.hero.ranged', opt: { x: 50, z: 52 } },
      { atSec: 1.3, id: 'cast.reaver.3', opt: { x: 59, z: 58 } },
      { atSec: 1.6, id: 'hit.crit', opt: { x: 59, z: 58 } },
      { atSec: 2.0, id: 'cast.longbow.3', opt: { x: 48, z: 50 } },
      { atSec: 2.4, id: 'atk.creep.melee', opt: { x: 64, z: 62 } },
      { atSec: 2.9, id: 'die.hero', opt: { x: 59, z: 58 } },
      { atSec: 3.4, id: 'cast.shade.3', opt: { x: 63, z: 61 } },
      { atSec: 4.1, id: 'cast.mender.3', opt: { x: 54, z: 54, self: true, priority: 2 } },
      { atSec: 4.8, id: 'atk.tower', opt: { x: 70, z: 68 } },
      { atSec: 5.5, id: 'die.hero.self', opt: { x: 56, z: 56, self: true } },
    ],
  },
  {
    name: 'lastHitInFight',
    seconds: 6,
    listener: L,
    music: 3,
    ambience: 'field',
    preRollS: PRE_ROLL,
    steps: [
      { atSec: 0.2, id: 'cast.hex.3', opt: { x: 60, z: 58 } },
      { atSec: 0.6, id: 'atk.hero.ranged', opt: { x: 52, z: 54 } },
      { atSec: 0.9, id: 'hit.physical', opt: { x: 58, z: 57 } },
      { atSec: 1.2, id: 'cast.reaver.0', opt: { x: 59, z: 59 } },
      /** THE test: this chime must be unmistakably audible over everything above. */
      { atSec: 1.35, id: 'die.creep', opt: { x: 57, z: 57 } },
      { atSec: 1.4, id: 'ui.lastHit' },
      { atSec: 2.2, id: 'atk.tower', opt: { x: 68, z: 66 } },
    ],
  },
  {
    name: 'towerFallInFight',
    seconds: 10,
    listener: L,
    music: 3,
    ambience: 'field',
    preRollS: PRE_ROLL,
    steps: [
      { atSec: 0.2, id: 'cast.bullwark.2', opt: { x: 58, z: 57 } },
      { atSec: 0.7, id: 'atk.hero.melee', opt: { x: 56, z: 56, self: true } },
      { atSec: 1.1, id: 'hit.physical', opt: { x: 60, z: 58 } },
      /** Ducking test: everything above must audibly step aside for this. */
      { atSec: 1.5, id: 'obj.tower', opt: { x: 66, z: 64 } },
      { atSec: 2.2, id: 'cast.hex.0', opt: { x: 62, z: 60 } },
      { atSec: 3.0, id: 'die.creep', opt: { x: 64, z: 62 } },
    ],
  },
  {
    name: 'ancientFall',
    seconds: 12,
    listener: L,
    music: 4,
    ambience: 'field',
    preRollS: PRE_ROLL,
    steps: [
      { atSec: 0.3, id: 'obj.klaxon' },
      { atSec: 1.5, id: 'atk.tower', opt: { x: 70, z: 68 } },
      { atSec: 2.4, id: 'cast.reaver.3', opt: { x: 68, z: 66 } },
      { atSec: 3.5, id: 'obj.ancient', opt: { x: 72, z: 72 } },
      { atSec: 6.0, id: 'ann.victory' },
    ],
  },
  {
    name: 'victory',
    seconds: 10,
    listener: L,
    music: 0,
    ambience: 'silent',
    preRollS: 2,
    steps: [{ atSec: 0.8, id: 'ann.victory' }],
  },
];
