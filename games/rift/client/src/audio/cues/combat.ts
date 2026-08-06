/**
 * RIFT AUDIO — cues/combat.ts (T5)
 *
 * `atk.*` (the swing), `hit.*` (the impact, including the low-HP heartbeat) and `die.*`
 * (creep/ward/hero deaths, including the team-interval hero-death family). These are the
 * highest-repetition cues in the whole build — thousands of plays per match — so every
 * cue here stays small (SONIC_BIBLE §5: auto-attacks/small hits are 2 layers, <=200ms)
 * and every repeatable cue genuinely varies per SONIC_BIBLE §7 / AUDIO_CONTRACT rule 11:
 * round-robin picks a structurally different base (register note, filter centre) per
 * `p.variant`, and `jitter()` adds a fresh pitch/timbre nudge on every single play on top
 * of that, so the same variant never sounds identical twice in a row either.
 *
 * Damage-school colour (SONIC_BIBLE §3): physical is noise-forward, band-passed inside
 * 300-2000 Hz; magic is tonal-forward via detuned/ring-modulated `shimmer` with a filtered
 * tail. Every noise/shimmer centre and sideband in this file is kept at or below ~780 Hz
 * (comfortably under `INFO_FLOOR_HZ` = 800) except `hit.crit`'s deliberate <25 ms bright
 * accent — the one place SONIC_BIBLE explicitly allows a brief transient into that band.
 * The `info` register itself (`PALETTE.info`) is never touched here; it belongs to `ui.*`.
 */

import type { CueFn, CueGraph, CuePlay, CueRegistry, Env } from '../contract.js';
import { jitter, noise, shimmer, thump, tone } from '../dsp.js';
import { INTERVAL, PALETTE, VARY } from '../config.js';

const SUB = PALETTE.sub;
const LOW = PALETTE.low;
const MID = PALETTE.mid;
const HIGH = PALETTE.high;

// ---------------------------------------------------------------------------
// Small local helpers — variation plumbing shared by every cue below.
// ---------------------------------------------------------------------------

/**
 * Round-robin over exactly 4 structurally different picks, selected by `p.variant`. A
 * `switch`, not array indexing, so `noUncheckedIndexedAccess` never enters the picture and
 * every branch is exhaustively a real value — this is what makes "genuinely different
 * waveforms per variant" true by construction rather than by luck.
 */
function rr4<T>(variant: number, a: T, b: T, c: T, d: T): T {
  switch (((variant % 4) + 4) % 4) {
    case 0:
      return a;
    case 1:
      return b;
    case 2:
      return c;
    default:
      return d;
  }
}

/** Forward-only layer-offset jitter: 0..VARY.timingS seconds late (SONIC_BIBLE §7). */
function layerOffset(g: CueGraph): number {
  return g.rnd() * VARY.timingS;
}

// ---------------------------------------------------------------------------
// atk.* — the swing. Attacks are the most-fired cues in the game: 2 layers, attack
// < 8 ms, total < 200 ms, crest > 8 dB (the render harness measures all three and fails
// the build on them). Physical/noise-forward throughout — nothing here is a damage school
// choice, it is the mechanical sound of the weapon leaving.
// ---------------------------------------------------------------------------

const atkHeroMelee: CueFn = (g, at, p) => {
  const bandHz = jitter(g, rr4(p.variant, 560, 640, 720, 780), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.6,
      sweepTime: 0.045,
      q: 1.4,
      env: { attack: 0.0025, decay: 0.022, sustain: 0.04, release: 0.032, peak: 1 },
    },
    0.85 * p.gain,
  );
  const hz = jitter(g, rr4(p.variant, LOW.D2, LOW.F2, LOW.A2, LOW.D3), VARY.attackPitchPct);
  // No layerOffset here: the attack-crispness gate (< 8ms to 90% of peak, measured on the
  // summed signal) leaves no room for a staggered second layer — see the note atop the
  // atk.* section.
  thump(
    g,
    at,
    p.dest,
    {
      hz,
      dropHz: hz * 0.5,
      dropTime: 0.045,
      env: { attack: 0.0025, decay: 0.028, sustain: 0.08, release: 0.045, peak: 1 },
    },
    0.55 * p.gain,
  );
};

const atkHeroRanged: CueFn = (g, at, p) => {
  const bandHz = jitter(g, rr4(p.variant, 600, 660, 720, 780), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.45,
      sweepTime: 0.05,
      q: 2.0,
      env: { attack: 0.0025, decay: 0.02, sustain: 0.03, release: 0.03, peak: 1 },
    },
    0.8 * p.gain,
  );
  const hz = jitter(g, rr4(p.variant, LOW.A2, LOW.D2, LOW.F2, LOW.D3), VARY.attackPitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz,
      dropHz: hz * 0.55,
      dropTime: 0.035,
      env: { attack: 0.003, decay: 0.02, sustain: 0.05, release: 0.03, peak: 1 },
    },
    0.35 * p.gain,
  );
};

const atkCreepMelee: CueFn = (g, at, p) => {
  const bandHz = jitter(g, rr4(p.variant, 420, 480, 540, 600), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.6,
      sweepTime: 0.04,
      q: 1.3,
      env: { attack: 0.003, decay: 0.02, sustain: 0.04, release: 0.03, peak: 1 },
    },
    0.5 * p.gain,
  );
  const hz = jitter(g, rr4(p.variant, LOW.D2, LOW.F2, LOW.A2, LOW.D3), VARY.attackPitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz,
      dropHz: hz * 0.5,
      dropTime: 0.04,
      env: { attack: 0.003, decay: 0.025, sustain: 0.07, release: 0.035, peak: 1 },
    },
    0.32 * p.gain,
  );
};

const atkCreepRanged: CueFn = (g, at, p) => {
  const bandHz = jitter(g, rr4(p.variant, 460, 520, 580, 640), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.5,
      sweepTime: 0.045,
      q: 1.8,
      env: { attack: 0.003, decay: 0.018, sustain: 0.03, release: 0.028, peak: 1 },
    },
    0.46 * p.gain,
  );
  const hz = jitter(g, rr4(p.variant, LOW.A2, LOW.D2, LOW.F2, LOW.D3), VARY.attackPitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz,
      dropHz: hz * 0.55,
      dropTime: 0.03,
      env: { attack: 0.003, decay: 0.018, sustain: 0.05, release: 0.028, peak: 1 },
    },
    0.22 * p.gain,
  );
};

const atkSiege: CueFn = (g, at, p) => {
  const bandHz = jitter(g, rr4(p.variant, 380, 440, 500, 560), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.55,
      sweepTime: 0.05,
      q: 1.1,
      env: { attack: 0.003, decay: 0.028, sustain: 0.06, release: 0.04, peak: 1 },
    },
    0.7 * p.gain,
  );
  const hz = jitter(g, rr4(p.variant, LOW.F2, LOW.A2, LOW.D2, LOW.D3), VARY.attackPitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz,
      dropHz: hz * 0.48,
      dropTime: 0.05,
      env: { attack: 0.003, decay: 0.032, sustain: 0.09, release: 0.05, peak: 1 },
    },
    0.6 * p.gain,
  );
};

/** Heaviest attack: a mid-register launch with a sub component (AUDIO_CONTRACT T5). */
const atkTower: CueFn = (g, at, p) => {
  const launchHz = jitter(g, rr4(p.variant, MID.D3, MID.F3, MID.A3, MID.D4), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: launchHz,
      sweepHz: launchHz * 1.3,
      sweepTime: 0.05,
      q: 1.6,
      env: { attack: 0.003, decay: 0.03, sustain: 0.06, release: 0.05, peak: 1 },
    },
    0.75 * p.gain,
  );
  const subHz = jitter(g, rr4(p.variant, SUB.D1, SUB.A1, SUB.D2, SUB.A1), VARY.attackPitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz: subHz,
      dropHz: subHz * 0.55,
      dropTime: 0.06,
      env: { attack: 0.003, decay: 0.035, sustain: 0.1, release: 0.06, peak: 1 },
    },
    0.75 * p.gain,
  );
};

// ---------------------------------------------------------------------------
// hit.* — the impact. Fired at the victim's position whenever any unit loses HP.
// hit.physical / hit.magic / hit.crit are the three "what landed" cues; hit.self is what
// the local player hears taking damage; hit.heartbeat is the low-HP dread pulse.
// ---------------------------------------------------------------------------

const hitPhysical: CueFn = (g, at, p) => {
  const bandHz = jitter(g, rr4(p.variant, 480, 560, 620, 700), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.55,
      sweepTime: 0.07,
      q: 1.3,
      env: { attack: 0.003, decay: 0.04, sustain: 0.07, release: 0.075, peak: 1 },
    },
    0.75 * p.gain,
  );
  const hz = jitter(g, rr4(p.variant, LOW.D2, LOW.F2, LOW.A2, LOW.D3), VARY.pitchPct);
  thump(
    g,
    at + layerOffset(g),
    p.dest,
    {
      hz,
      dropHz: hz * 0.45,
      dropTime: 0.08,
      env: { attack: 0.004, decay: 0.05, sustain: 0.1, release: 0.08, peak: 1 },
    },
    0.6 * p.gain,
  );
};

/** Magic school: tonal-forward ring-mod shimmer + a body thump. No noise layer. */
const hitMagic: CueFn = (g, at, p) => {
  const hz = jitter(g, rr4(p.variant, HIGH.F4, HIGH.A4, HIGH.D5, HIGH.F5), VARY.pitchPct);
  const tailHz = jitter(g, rr4(p.variant, 600, 640, 680, 650), VARY.timbrePct);
  shimmer(
    g,
    at,
    p.dest,
    {
      hz,
      modHz: rr4(p.variant, 42, 58, 66, 74),
      index: 0.55,
      tailHz,
      env: { attack: 0.004, decay: 0.05, sustain: 0.12, release: 0.09, peak: 1 },
    },
    0.55 * p.gain,
  );
  const bodyHz = jitter(g, rr4(p.variant, LOW.D2, LOW.F2, LOW.A2, LOW.D3), VARY.pitchPct);
  thump(
    g,
    at + layerOffset(g),
    p.dest,
    {
      hz: bodyHz,
      dropHz: bodyHz * 0.45,
      dropTime: 0.09,
      env: { attack: 0.004, decay: 0.05, sustain: 0.1, release: 0.08, peak: 1 },
    },
    0.6 * p.gain,
  );
};

/**
 * A bigger version of hit.physical plus a <25 ms bright accent. The accent is the one
 * deliberate exception to "stay under INFO_FLOOR_HZ" (SONIC_BIBLE: "the info register is
 * not yours") — kept brief and quiet enough that it stays inside `INFO_BAND_MAX_PCT`.
 */
const hitCrit: CueFn = (g, at, p) => {
  const bandHz = jitter(g, rr4(p.variant, 520, 600, 680, 760), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.5,
      sweepTime: 0.07,
      q: 1.5,
      env: { attack: 0.003, decay: 0.045, sustain: 0.09, release: 0.08, peak: 1 },
    },
    0.85 * p.gain,
  );
  const hz = jitter(g, rr4(p.variant, LOW.F2, LOW.A2, LOW.D3, LOW.D2), VARY.pitchPct);
  thump(
    g,
    at + layerOffset(g),
    p.dest,
    {
      hz,
      dropHz: hz * 0.4,
      dropTime: 0.09,
      env: { attack: 0.004, decay: 0.055, sustain: 0.14, release: 0.09, peak: 1 },
    },
    0.85 * p.gain,
  );
  const accentHz = jitter(g, rr4(p.variant, 1600, 1750, 1850, 1950), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: accentHz,
      q: 3.5,
      env: { attack: 0.001, decay: 0.008, sustain: 0, release: 0.01, peak: 1 },
    },
    0.25 * p.gain,
  );
};

/** What the local player hears taking damage: a duller, lower, filtered thud. */
const hitSelf: CueFn = (g, at, p) => {
  const hz = jitter(g, rr4(p.variant, LOW.D2, SUB.A1, LOW.F2, SUB.D2), VARY.pitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz,
      dropHz: hz * 0.4,
      dropTime: 0.1,
      env: { attack: 0.005, decay: 0.06, sustain: 0.14, release: 0.11, peak: 1 },
    },
    0.85 * p.gain,
  );
  const cutoff = jitter(g, rr4(p.variant, 340, 300, 380, 260), VARY.timbrePct);
  noise(
    g,
    at + layerOffset(g),
    p.dest,
    {
      filter: 'lowpass',
      hz: cutoff,
      sweepHz: cutoff * 0.6,
      sweepTime: 0.1,
      q: 0.8,
      env: { attack: 0.006, decay: 0.07, sustain: 0.1, release: 0.1, peak: 1 },
    },
    0.5 * p.gain,
  );
};

/**
 * The low-HP dread pulse: a sub-register double-thump ("lub-dub"), always < 300 Hz, always
 * inside a 400 ms budget. `p.intensity` carries the band from `index.ts`'s heartbeat timer
 * (0 = 30% HP, 1 = 15% HP); band 1 is tighter, louder and more urgent. Every firing draws a
 * fresh `jitter()` value, so a heartbeat repeated every 0.62-1.1 s all match never locks
 * into a mechanically identical tick — it stays dread, not a metronome.
 */
const hitHeartbeat: CueFn = (g, at, p) => {
  const urgent = p.intensity >= 1;
  const gap = urgent ? 0.11 : 0.16;
  const level = (urgent ? 1.15 : 1.0) * p.gain;
  const hz1 = jitter(g, SUB.A1, VARY.pitchPct);
  const hz2 = jitter(g, SUB.D1, VARY.pitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz: hz1,
      dropHz: hz1 * 0.55,
      dropTime: 0.09,
      env: { attack: 0.006, decay: 0.05, sustain: 0.15, release: 0.09, peak: 1 },
    },
    0.9 * level,
  );
  thump(
    g,
    at + gap,
    p.dest,
    {
      hz: hz2,
      dropHz: hz2 * 0.5,
      dropTime: 0.08,
      env: { attack: 0.006, decay: 0.045, sustain: 0.1, release: 0.08, peak: 1 },
    },
    0.65 * level,
  );
};

// ---------------------------------------------------------------------------
// die.* — deaths. The three hero-death cues share one body-fall shape and differ only in
// the SONIC_BIBLE §3 team-interval colour: `die.hero` resolves consonant (good news, an
// enemy fell), `die.hero.ally` and `die.hero.self` colour dissonant (bad news), and
// `die.hero.self` additionally carries extra low-end weight for the real loss.
// ---------------------------------------------------------------------------

function heroDeathChord(
  g: CueGraph,
  at: number,
  p: CuePlay,
  interval: readonly number[],
  weight: number,
): void {
  // INTERVAL.ally / INTERVAL.enemy are both frozen 3-entry arrays (config.ts) widened to
  // `readonly number[]`, so indexing is `number | undefined` under noUncheckedIndexedAccess
  // even though a 3rd element always exists. The `?? 1` fallback documents that and is
  // never actually exercised — the same pattern dsp.ts's own `degree()` uses.
  const i0 = interval[0] ?? 1;
  const i1 = interval[1] ?? 1;
  const i2 = interval[2] ?? 1;
  const root = jitter(g, LOW.D2, VARY.pitchPct);

  thump(
    g,
    at,
    p.dest,
    {
      hz: root,
      dropHz: root * 0.42,
      dropTime: 0.2 * weight,
      env: { attack: 0.004, decay: 0.12, sustain: 0.22, release: 0.4 * weight, peak: 1 },
    },
    0.95 * weight * p.gain,
  );

  if (weight > 1) {
    // die.hero.self only: an extra sub layer for the low-end weight of a real loss.
    const subHz = jitter(g, SUB.A1, VARY.pitchPct);
    thump(
      g,
      at + layerOffset(g),
      p.dest,
      {
        hz: subHz,
        dropHz: subHz * 0.5,
        dropTime: 0.32,
        env: { attack: 0.006, decay: 0.16, sustain: 0.3, release: 0.55, peak: 1 },
      },
      0.7 * p.gain,
    );
  }

  const chordEnv: Env = {
    attack: 0.02,
    decay: 0.16,
    sustain: 0.3,
    release: 0.5 * weight,
    peak: 1,
  };
  const cutoff = jitter(g, 1400, VARY.timbrePct);
  tone(
    g,
    at + layerOffset(g),
    p.dest,
    { type: 'triangle', hz: root * i0, filterHz: cutoff, env: chordEnv },
    0.4 * p.gain,
  );
  tone(
    g,
    at + layerOffset(g),
    p.dest,
    { type: 'triangle', hz: root * i1, filterHz: cutoff, env: chordEnv },
    0.32 * p.gain,
  );
  tone(
    g,
    at + layerOffset(g),
    p.dest,
    { type: 'triangle', hz: root * i2, filterHz: cutoff, env: chordEnv },
    0.28 * p.gain,
  );
}

/** An enemy fell — good news, resolved with INTERVAL.ally (fifth + octave). */
const dieHero: CueFn = (g, at, p) => heroDeathChord(g, at, p, INTERVAL.ally, 1);

/** A teammate fell — bad news, coloured with INTERVAL.enemy (minor 2nd + tritone). */
const dieHeroAlly: CueFn = (g, at, p) => heroDeathChord(g, at, p, INTERVAL.enemy, 1);

/** You fell — INTERVAL.enemy plus extra low-end weight for the real loss. */
const dieHeroSelf: CueFn = (g, at, p) => heroDeathChord(g, at, p, INTERVAL.enemy, 1.4);

/**
 * Fires constantly — must sit below the last-hit chime it accompanies and never mask it:
 * nothing above `INFO_FLOOR_HZ`.
 */
const dieCreep: CueFn = (g, at, p) => {
  const bandHz = jitter(g, rr4(p.variant, 420, 480, 540, 600), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'lowpass',
      hz: bandHz,
      sweepHz: bandHz * 0.5,
      sweepTime: 0.09,
      q: 0.9,
      env: { attack: 0.004, decay: 0.05, sustain: 0.08, release: 0.09, peak: 1 },
    },
    0.55 * p.gain,
  );
  const hz = jitter(g, rr4(p.variant, LOW.D2, LOW.F2, LOW.A2, SUB.A1), VARY.pitchPct);
  thump(
    g,
    at + layerOffset(g),
    p.dest,
    {
      hz,
      dropHz: hz * 0.45,
      dropTime: 0.1,
      env: { attack: 0.005, decay: 0.06, sustain: 0.12, release: 0.1, peak: 1 },
    },
    0.65 * p.gain,
  );
};

/** A ward breaking: a brittle crack rather than a body-fall, kept well under 800 Hz. */
const dieWard: CueFn = (g, at, p) => {
  const bandHz = jitter(g, rr4(p.variant, 560, 640, 700, 760), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.55,
      sweepTime: 0.05,
      q: 2.2,
      env: { attack: 0.002, decay: 0.02, sustain: 0.03, release: 0.05, peak: 1 },
    },
    0.6 * p.gain,
  );
  const hz = jitter(g, rr4(p.variant, LOW.D2, LOW.F2, LOW.A2, SUB.A1), VARY.pitchPct);
  thump(
    g,
    at + layerOffset(g),
    p.dest,
    {
      hz,
      dropHz: hz * 0.5,
      dropTime: 0.06,
      env: { attack: 0.003, decay: 0.03, sustain: 0.05, release: 0.06, peak: 1 },
    },
    0.35 * p.gain,
  );
};

// ---------------------------------------------------------------------------
// Registry — `satisfies`, never a type annotation (AUDIO_CONTRACT rule 14). Annotating
// with `CueRegistry` would erase the literal SoundId keys and break `index.ts`'s total
// `Record<SoundId, CueSpec>` merge no matter how complete this registry actually is.
// ---------------------------------------------------------------------------

export const COMBAT_CUES = {
  'atk.hero.melee': {
    fn: atkHeroMelee,
    bus: 'sfx',
    priority: 4,
    tail: 0.1,
    variants: VARY.roundRobin,
    dry: false,
  },
  'atk.hero.ranged': {
    fn: atkHeroRanged,
    bus: 'sfx',
    priority: 4,
    tail: 0.09,
    variants: VARY.roundRobin,
    dry: false,
  },
  'atk.creep.melee': {
    fn: atkCreepMelee,
    bus: 'sfx',
    priority: 5,
    tail: 0.08,
    variants: VARY.roundRobin,
    dry: false,
  },
  'atk.creep.ranged': {
    fn: atkCreepRanged,
    bus: 'sfx',
    priority: 5,
    tail: 0.07,
    variants: VARY.roundRobin,
    dry: false,
  },
  'atk.siege': {
    fn: atkSiege,
    bus: 'sfx',
    priority: 5,
    tail: 0.11,
    variants: VARY.roundRobin,
    dry: false,
  },
  'atk.tower': {
    fn: atkTower,
    bus: 'sfx',
    priority: 5,
    tail: 0.12,
    variants: VARY.roundRobin,
    dry: false,
  },
  'hit.physical': {
    fn: hitPhysical,
    bus: 'sfx',
    priority: 4,
    tail: 0.15,
    variants: VARY.roundRobin,
    dry: false,
  },
  'hit.magic': {
    fn: hitMagic,
    bus: 'sfx',
    priority: 4,
    tail: 0.15,
    variants: VARY.roundRobin,
    dry: false,
  },
  'hit.self': {
    fn: hitSelf,
    bus: 'sfx',
    priority: 3,
    // Real synthesis end: thump 0.005+0.06+0.11=0.175s; noise layer (offset <=0.008s late)
    // 0.008+0.006+0.07+0.1=0.184s. Declare the honest worst case with a small margin.
    tail: 0.19,
    variants: VARY.roundRobin,
    dry: false,
  },
  'hit.crit': {
    fn: hitCrit,
    bus: 'sfx',
    priority: 4,
    tail: 0.17,
    variants: VARY.roundRobin,
    dry: false,
  },
  'hit.heartbeat': {
    fn: hitHeartbeat,
    bus: 'sfx',
    priority: 2,
    tail: 0.35,
    variants: 1,
    dry: true,
  },
  'die.hero': {
    fn: dieHero,
    bus: 'sfx',
    priority: 4,
    tail: 0.75,
    variants: 1,
    dry: false,
  },
  'die.hero.ally': {
    fn: dieHeroAlly,
    bus: 'sfx',
    priority: 4,
    tail: 0.75,
    variants: 1,
    dry: false,
  },
  'die.hero.self': {
    fn: dieHeroSelf,
    bus: 'sfx',
    priority: 2,
    tail: 1.0,
    variants: 1,
    dry: false,
  },
  'die.creep': {
    fn: dieCreep,
    bus: 'sfx',
    priority: 5,
    tail: 0.2,
    variants: VARY.roundRobin,
    dry: false,
  },
  'die.ward': {
    fn: dieWard,
    bus: 'sfx',
    priority: 5,
    tail: 0.15,
    variants: VARY.roundRobin,
    dry: false,
  },
} satisfies CueRegistry;
