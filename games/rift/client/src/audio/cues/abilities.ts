/**
 * RIFT AUDIO — cues/abilities.ts (T4)
 *
 * The 24 hero ability casts (`cast.<hero>.<slot>`) plus the 4 item actives
 * (`cast.item.*`). SONIC_BIBLE §5: "distinct per hero" is the bar. Every hero is built
 * from its `HERO_TIMBRE` archetype mix (config.ts) so six agents' worth of casts still
 * read as one game, and every slot's damage-school colour (SONIC_BIBLE §3) is audible
 * blind: physical is a fast noise-forward transient, magic is a detuned tonal pair with
 * a filtered tail, heal rises a perfect fifth on a bare sine/triangle, control closes a
 * filter over the tail, dash/blink is an air-noise sweep, summon is a sub swell rising
 * into a mid cluster.
 *
 * All pitches trace to `PALETTE` or are derived from it via `degree()` (SONIC_BIBLE §3
 * law 1). All casts stay under `INFO_FLOOR_HZ` in aggregate energy — the `info` register
 * belongs to `cues/ui.ts` alone.
 */

import {
  db,
  degree,
  jitter,
  jitterDb,
  metal,
  noise,
  shimmer,
  swell,
  thump,
  tone,
} from '../dsp.js';
import { METAL_RATIOS, PALETTE, VARY } from '../config.js';
import type { CueFn, CueGraph, CuePlay, CueSpec, Env, SoundId } from '../contract.js';

// ---------------------------------------------------------------------------
// Shared helpers — envelope shorthand + the SONIC_BIBLE §7 variation minimums.
// ---------------------------------------------------------------------------

/** ADSR shorthand. `sustain` is a LEVEL fraction of peak, not a duration (see dsp.ts). */
function env(attack: number, decay: number, sustain: number, release: number, peak = 1): Env {
  return { attack, decay, sustain, release, peak };
}

/**
 * Per-layer design level: the cue's own dB trim, the engine's per-cue gain (`p.gain`),
 * +/-`VARY.levelDb` seeded jitter (SONIC_BIBLE §7), and a mild scale from `p.intensity`
 * (0..1, default 0 for casts today — honoured here so the field stays live for any
 * future caller that passes it).
 */
function lvl(g: CueGraph, p: CuePlay, designDb: number): number {
  return db(designDb) * p.gain * jitterDb(g, VARY.levelDb) * (0.9 + 0.2 * p.intensity);
}

/** Seeded +/-`pct` pitch jitter (SONIC_BIBLE §7 minimum: +/-3%). */
function hz(base: number, g: CueGraph, pct: number = VARY.pitchPct): number {
  return jitter(g, base, pct);
}

/** Seeded +/-`VARY.timingS` layer-offset jitter (SONIC_BIBLE §7 minimum: +/-8ms). */
function tOff(g: CueGraph): number {
  return (g.rnd() * 2 - 1) * VARY.timingS;
}

/**
 * `at` plus `offset` plus timing jitter, floored so the result can never precede `at`.
 * `tOff` draws negative roughly half the time; WebAudio throws `RangeError` on a negative
 * absolute schedule time, which aborts the whole cue function (and every layer after it) —
 * silently, since the engine's per-cue try/catch swallows it per contract. Every layer
 * scheduled relative to `at` goes through this helper, never through a raw `at + tOff(g)`.
 */
function jitteredAt(g: CueGraph, at: number, offset = 0): number {
  return at + Math.max(0, offset + tOff(g));
}

// ---------------------------------------------------------------------------
// BULLWARK — metal and stone, a shield wall moving. Low register. No shimmer, ever.
// ---------------------------------------------------------------------------

/** Q — Shield Crash: point, physical, dash+stun. Noise whoosh, then thump+metal impact. */
const bullwarkShieldCrash: CueFn = (g, at, p) => {
  const root = PALETTE.low.D2;
  noise(g, at, p.dest, {
    filter: 'bandpass',
    hz: hz(220, g),
    sweepHz: hz(520, g),
    sweepTime: 0.05,
    q: 1.4,
    env: env(0.003, 0.05, 0.25, 0.09),
  }, lvl(g, p, -8));
  const impactAt = jitteredAt(g, at, 0.05);
  thump(g, impactAt, p.dest, {
    hz: hz(root * 2, g),
    dropHz: hz(root * 0.7, g),
    dropTime: 0.09,
    env: env(0.002, 0.06, 0.2, 0.12),
  }, lvl(g, p, -3));
  metal(g, impactAt, p.dest, {
    ratios: p.variant % 2 === 0 ? METAL_RATIOS : METAL_RATIOS.slice(1),
    hz: hz(root * 2, g),
    bandHz: hz(560, g),
    q: 3.5,
    filterHz: 2200,
    sweepHz: 700,
    sweepTime: 0.22,
    env: env(0.002, 0.09, 0.15, 0.18),
  }, lvl(g, p, -6));
};

/** W — Bulwark: passive armour aura. Rarely fires; a deep, resting sub-register hum. */
const bullwarkBulwark: CueFn = (g, at, p) => {
  const root = PALETTE.sub.D1;
  metal(g, at, p.dest, {
    ratios: METAL_RATIOS.slice(0, 4),
    hz: hz(root * 2, g),
    bandHz: hz(150, g),
    q: 3,
    env: env(0.006, 0.09, 0.2, 0.13),
  }, lvl(g, p, -12));
  thump(g, jitteredAt(g, at), p.dest, {
    hz: hz(root, g),
    dropHz: hz(root * 0.7, g),
    dropTime: 0.09,
    env: env(0.007, 0.09, 0.2, 0.13),
  }, lvl(g, p, -11));
};

/** E — Ground Slam: magic AoE, slow. Mid-register detuned tone pair (no shimmer) + sub crack. */
const bullwarkGroundSlam: CueFn = (g, at, p) => {
  const root = PALETTE.mid.A3;
  tone(g, at, p.dest, {
    type: 'triangle',
    hz: hz(root, g),
    detune: p.variant % 2 === 0 ? -14 : -22,
    filterHz: 1100,
    sweepHz: 450,
    sweepTime: 0.4,
    env: env(0.01, 0.18, 0.35, 0.3),
  }, lvl(g, p, -9));
  tone(g, at + 0.01, p.dest, {
    type: 'triangle',
    hz: hz(degree(root, 4, 0), g),
    detune: p.variant % 2 === 0 ? 16 : 9,
    filterHz: 950,
    sweepHz: 400,
    sweepTime: 0.42,
    env: env(0.012, 0.2, 0.3, 0.32),
  }, lvl(g, p, -10));
  metal(g, jitteredAt(g, at, 0.02), p.dest, {
    ratios: METAL_RATIOS.slice(0, 5),
    hz: hz(root, g),
    bandHz: hz(450, g),
    q: 4,
    env: env(0.004, 0.1, 0.2, 0.2),
  }, lvl(g, p, -10));
  thump(g, at, p.dest, {
    hz: hz(PALETTE.sub.A1, g),
    dropHz: hz(PALETTE.sub.A1 * 0.6, g),
    dropTime: 0.18,
    env: env(0.008, 0.15, 0.25, 0.25),
  }, lvl(g, p, -6));
};

/** R — Rally (ult): heal + armour aura. Sub + mandatory swell, heal fifth, armour clang. */
const bullwarkRally: CueFn = (g, at, p) => {
  const root = PALETTE.low.D2;
  thump(g, at, p.dest, {
    hz: hz(PALETTE.sub.D1 * 2, g),
    dropHz: hz(PALETTE.sub.D1, g),
    dropTime: 0.5,
    env: env(0.02, 0.4, 0.5, 0.6),
  }, lvl(g, p, -6));
  swell(g, at + 0.03, p.dest, {
    type: 'sawtooth',
    hz: hz(root, g),
    voices: 4,
    spreadCents: 18,
    openHz: 300,
    filterHz: 300,
    sweepHz: 900,
    sweepTime: 0.9,
    env: env(0.25, 0.4, 0.6, 0.7),
  }, lvl(g, p, -10));
  tone(g, at + 0.15, p.dest, {
    type: 'sine',
    hz: hz(root, g),
    glideHz: hz(degree(root, 4, 0), g),
    glideTime: 0.5,
    env: env(0.05, 0.3, 0.5, 0.5),
  }, lvl(g, p, -7));
  metal(g, jitteredAt(g, at, 0.05), p.dest, {
    ratios: METAL_RATIOS,
    hz: hz(root, g),
    bandHz: hz(500, g),
    q: 3,
    env: env(0.01, 0.2, 0.3, 0.4),
  }, lvl(g, p, -11));
  tone(g, at + 0.2, p.dest, {
    type: 'triangle',
    hz: hz(degree(root, 4, 1), g),
    env: env(0.06, 0.35, 0.5, 0.55),
  }, lvl(g, p, -12));
};

// ---------------------------------------------------------------------------
// LONGBOW — tension and release. Mid register. Bowstring creak before every transient.
// ---------------------------------------------------------------------------

/** Q — Piercing Arrow: point, physical, piercing projectile. Low-register creak, then snap + ping. */
const longbowPiercingArrow: CueFn = (g, at, p) => {
  const root = PALETTE.low.F2;
  const creak = 0.075;
  noise(g, at, p.dest, {
    filter: 'bandpass',
    hz: hz(200, g),
    sweepHz: hz(420, g),
    sweepTime: creak,
    q: 2.6,
    env: env(0.02, creak - 0.02, 0.3, 0.03),
  }, lvl(g, p, -12));
  const snapAt = jitteredAt(g, at, creak);
  tone(g, snapAt, p.dest, {
    type: 'sawtooth',
    hz: hz(root, g),
    glideHz: hz(root * 1.6, g),
    glideTime: 0.05,
    filterHz: 850,
    sweepHz: 320,
    sweepTime: 0.08,
    env: env(0.003, 0.05, 0.15, 0.08),
  }, lvl(g, p, -8));
  metal(g, snapAt, p.dest, {
    ratios: p.variant % 2 === 0 ? METAL_RATIOS.slice(0, 4) : METAL_RATIOS.slice(1, 5),
    hz: hz(root * 2, g),
    bandHz: hz(500, g),
    q: 4,
    env: env(0.001, 0.04, 0.1, 0.1),
  }, lvl(g, p, -11));
};

/** W — Focus: passive attack-speed. Rarely fires; a quiet high-register chime tick. */
const longbowFocus: CueFn = (g, at, p) => {
  const root = PALETTE.high.A4;
  tone(g, at, p.dest, {
    type: 'sine',
    hz: hz(root, g),
    env: env(0.008, 0.05, 0.2, 0.08),
  }, lvl(g, p, -15));
  tone(g, at + 0.012, p.dest, {
    type: 'triangle',
    hz: hz(degree(root, 4, 0), g),
    env: env(0.01, 0.05, 0.18, 0.09),
  }, lvl(g, p, -17));
  noise(g, at + 0.005, p.dest, {
    filter: 'bandpass',
    hz: hz(350, g),
    q: 2.5,
    env: env(0.004, 0.03, 0.1, 0.05),
  }, lvl(g, p, -18));
};

/** E — Frost Arrow: unit, magic, slow. Creak, then a detuned icy body, closing filter. */
const longbowFrostArrow: CueFn = (g, at, p) => {
  const root = PALETTE.mid.D4;
  const creak = 0.06;
  noise(g, at, p.dest, {
    filter: 'bandpass',
    hz: hz(240, g),
    sweepHz: hz(560, g),
    sweepTime: creak,
    q: 2,
    env: env(0.02, creak - 0.02, 0.25, 0.03),
  }, lvl(g, p, -13));
  const snapAt = jitteredAt(g, at, creak);
  tone(g, snapAt, p.dest, {
    type: 'triangle',
    hz: hz(root, g),
    detune: p.variant % 2 === 0 ? -20 : -30,
    filterHz: 1600,
    sweepHz: 380,
    sweepTime: 0.3,
    env: env(0.004, 0.16, 0.25, 0.2),
  }, lvl(g, p, -8));
  metal(g, snapAt, p.dest, {
    ratios: METAL_RATIOS.slice(0, 4),
    hz: hz(root * 1.5, g),
    bandHz: hz(700, g),
    q: 4,
    env: env(0.002, 0.05, 0.12, 0.1),
  }, lvl(g, p, -12));
};

/** R — Rain of Arrows (ult): point AoE magic, slow. Sub + swell + icy body + two volleys. */
const longbowRainOfArrows: CueFn = (g, at, p) => {
  const root = PALETTE.mid.D3;
  thump(g, at, p.dest, {
    hz: hz(PALETTE.sub.A1 * 2, g),
    dropHz: hz(PALETTE.sub.A1, g),
    dropTime: 0.4,
    env: env(0.02, 0.3, 0.4, 0.5),
  }, lvl(g, p, -7));
  swell(g, at + 0.05, p.dest, {
    type: 'sawtooth',
    hz: hz(root, g),
    voices: 3,
    spreadCents: 14,
    openHz: 260,
    filterHz: 260,
    sweepHz: 620,
    sweepTime: 0.8,
    env: env(0.3, 0.4, 0.5, 0.6),
  }, lvl(g, p, -11));
  tone(g, at + 0.08, p.dest, {
    type: 'triangle',
    hz: hz(root * 1.5, g),
    detune: -18,
    filterHz: 1200,
    sweepHz: 400,
    sweepTime: 0.5,
    env: env(0.02, 0.25, 0.3, 0.4),
  }, lvl(g, p, -10));
  const impactAAt = jitteredAt(g, at, 0.18);
  const impactBAt = jitteredAt(g, at, 0.42);
  noise(g, impactAAt, p.dest, {
    filter: 'bandpass',
    hz: hz(320, g),
    sweepHz: hz(680, g),
    sweepTime: 0.05,
    q: 2,
    env: env(0.003, 0.06, 0.15, 0.08),
  }, lvl(g, p, -10));
  noise(g, impactBAt, p.dest, {
    filter: 'bandpass',
    hz: hz(340, g),
    sweepHz: hz(700, g),
    sweepTime: 0.05,
    q: 2,
    env: env(0.003, 0.06, 0.15, 0.08),
  }, lvl(g, p, -10));
  metal(g, impactAAt, p.dest, {
    ratios: METAL_RATIOS.slice(0, 5),
    hz: hz(root * 1.4, g),
    bandHz: hz(750, g),
    q: 4.5,
    env: env(0.002, 0.05, 0.12, 0.12),
  }, lvl(g, p, -12));
};

// ---------------------------------------------------------------------------
// REAVER — butcher's steel, wet and unclean. Low register. Dirtier, longer than BULLWARK.
// ---------------------------------------------------------------------------

/** Q — Cleave: AoE physical. Wet noise swing + heavy thump + dirty clang. */
const reaverCleave: CueFn = (g, at, p) => {
  const root = PALETTE.low.F2;
  noise(g, at, p.dest, {
    filter: 'bandpass',
    hz: hz(300, g),
    sweepHz: hz(500, g),
    sweepTime: 0.07,
    q: 1.8,
    env: env(0.003, 0.09, 0.25, 0.14),
  }, lvl(g, p, -6));
  const impactAt = jitteredAt(g, at, 0.03);
  thump(g, impactAt, p.dest, {
    hz: hz(root * 1.6, g),
    dropHz: hz(root * 0.6, g),
    dropTime: 0.14,
    env: env(0.002, 0.1, 0.2, 0.18),
  }, lvl(g, p, -4));
  metal(g, impactAt, p.dest, {
    ratios: p.variant % 2 === 0 ? METAL_RATIOS : METAL_RATIOS.slice(1),
    hz: hz(root * 2.2, g),
    bandHz: hz(650, g),
    q: 2.6,
    env: env(0.003, 0.12, 0.18, 0.22),
  }, lvl(g, p, -7));
};

/** W — Frenzy: self attack-speed. Mid-register rasp + weight + steel edge. */
const reaverFrenzy: CueFn = (g, at, p) => {
  const root = PALETTE.mid.D3;
  noise(g, at, p.dest, {
    filter: 'bandpass',
    hz: hz(240, g),
    sweepHz: hz(400, g),
    sweepTime: 0.07,
    q: 2.8,
    env: env(0.008, 0.06, 0.22, 0.09),
  }, lvl(g, p, -8));
  thump(g, jitteredAt(g, at), p.dest, {
    hz: hz(root, g),
    dropHz: hz(root * 0.75, g),
    dropTime: 0.08,
    env: env(0.003, 0.06, 0.2, 0.1),
  }, lvl(g, p, -7));
  metal(g, at + 0.01, p.dest, {
    ratios: METAL_RATIOS.slice(0, 4),
    hz: hz(root, g),
    bandHz: hz(420, g),
    q: 3.5,
    env: env(0.003, 0.07, 0.15, 0.1),
  }, lvl(g, p, -10));
};

/** E — Lunge: unit, physical, dash. Upper-mid register whoosh into a landing impact + blade. */
const reaverLunge: CueFn = (g, at, p) => {
  const root = PALETTE.mid.D4;
  noise(g, at, p.dest, {
    filter: 'bandpass',
    hz: hz(240, g),
    sweepHz: hz(400, g),
    sweepTime: 0.09,
    q: 2,
    env: env(0.003, 0.07, 0.2, 0.09),
  }, lvl(g, p, -7));
  const landAt = jitteredAt(g, at, 0.09);
  thump(g, landAt, p.dest, {
    hz: hz(root, g),
    dropHz: hz(root * 0.55, g),
    dropTime: 0.1,
    env: env(0.002, 0.08, 0.2, 0.14),
  }, lvl(g, p, -4));
  metal(g, landAt, p.dest, {
    ratios: p.variant % 2 === 0 ? METAL_RATIOS.slice(0, 5) : METAL_RATIOS.slice(1),
    hz: hz(root, g),
    bandHz: hz(430, g),
    q: 3.2,
    env: env(0.002, 0.06, 0.15, 0.14),
  }, lvl(g, p, -8));
};

/** R — Dismember (ult): unit, physical, stun. Sub + swell + heavy rip + shrieking blade. */
const reaverDismember: CueFn = (g, at, p) => {
  const root = PALETTE.low.D3;
  thump(g, at, p.dest, {
    hz: hz(PALETTE.sub.D1 * 2, g),
    dropHz: hz(PALETTE.sub.D1, g),
    dropTime: 0.45,
    env: env(0.015, 0.35, 0.45, 0.55),
  }, lvl(g, p, -17));
  swell(g, at + 0.02, p.dest, {
    type: 'sawtooth',
    hz: hz(root * 1.5, g),
    voices: 4,
    spreadCents: 22,
    openHz: 770,
    env: env(0.02, 0.35, 0.4, 0.5),
  }, lvl(g, p, -5));
  noise(g, at + 0.04, p.dest, {
    filter: 'bandpass',
    hz: hz(720, g),
    sweepHz: hz(770, g),
    sweepTime: 0.1,
    q: 2.2,
    env: env(0.003, 0.12, 0.3, 0.2),
  }, lvl(g, p, -8));
  metal(g, jitteredAt(g, at, 0.06), p.dest, {
    ratios: METAL_RATIOS,
    hz: hz(root * 1.7, g),
    bandHz: hz(780, g),
    q: 4.5,
    env: env(0.003, 0.2, 0.25, 0.35),
  }, lvl(g, p, -3));
  tone(g, at + 0.12, p.dest, {
    type: 'sawtooth',
    hz: hz(root * 1.6, g),
    filterHz: 770,
    env: env(0.02, 0.3, 0.3, 0.5),
  }, lvl(g, p, -5));
};

// ---------------------------------------------------------------------------
// HEX — pure arcane, cold, out of tune with itself. High register. Almost no noise.
// ---------------------------------------------------------------------------

/** Q — Hexbolt: unit, magic projectile. Detuned launch pair + a filtered shimmer tail. */
const hexHexbolt: CueFn = (g, at, p) => {
  const root = PALETTE.high.A4;
  tone(g, at, p.dest, {
    type: 'sawtooth',
    hz: hz(root, g),
    detune: p.variant % 2 === 0 ? -16 : 20,
    glideHz: hz(root * 1.3, g),
    glideTime: 0.05,
    filterHz: 700,
    sweepHz: 300,
    sweepTime: 0.15,
    env: env(0.003, 0.06, 0.2, 0.1),
  }, lvl(g, p, -8));
  tone(g, at + 0.005, p.dest, {
    type: 'sawtooth',
    hz: hz(root * 1.005, g),
    detune: p.variant % 2 === 0 ? 12 : -18,
    filterHz: 600,
    env: env(0.004, 0.07, 0.18, 0.12),
  }, lvl(g, p, -11));
  shimmer(g, at + 0.02, p.dest, {
    hz: hz(root, g),
    modHz: hz(30, g, 0.15),
    index: 110,
    tailHz: 480,
    filterHz: 480,
    sweepHz: 200,
    sweepTime: 0.3,
    env: env(0.01, 0.15, 0.2, 0.2),
  }, lvl(g, p, -13));
};

/** W — Cripple: point AoE magic, slow. Mid-register shimmer + detuned cluster, closing filter. */
const hexCripple: CueFn = (g, at, p) => {
  const root = PALETTE.mid.F3;
  shimmer(g, at, p.dest, {
    hz: hz(root, g),
    modHz: hz(22, g, 0.2),
    index: 130,
    tailHz: 460,
    filterHz: 460,
    sweepHz: 200,
    sweepTime: 0.4,
    env: env(0.015, 0.2, 0.3, 0.25),
  }, lvl(g, p, -9));
  tone(g, at + 0.01, p.dest, {
    type: 'triangle',
    hz: hz(root * 0.5, g),
    detune: p.variant % 2 === 0 ? -20 : 24,
    filterHz: 650,
    sweepHz: 300,
    sweepTime: 0.42,
    env: env(0.015, 0.18, 0.3, 0.25),
  }, lvl(g, p, -9));
  tone(g, at + 0.02, p.dest, {
    type: 'triangle',
    hz: hz(degree(PALETTE.rootHz, 2, 1), g),
    detune: p.variant % 2 === 0 ? 15 : -12,
    filterHz: 650,
    env: env(0.02, 0.18, 0.3, 0.25),
  }, lvl(g, p, -11));
};

/** E — Blink: point dash, 8m. Doppler-ish noise sweep (up then down) + a faint flicker. */
const hexBlink: CueFn = (g, at, p) => {
  const root = PALETTE.high.D5;
  noise(g, at, p.dest, {
    filter: 'bandpass',
    hz: hz(260, g),
    sweepHz: hz(420, g),
    sweepTime: 0.06,
    q: 2.2,
    env: env(0.004, 0.05, 0.2, 0.05),
  }, lvl(g, p, -9));
  noise(g, at + 0.05, p.dest, {
    filter: 'bandpass',
    hz: hz(420, g),
    sweepHz: hz(240, g),
    sweepTime: 0.07,
    q: 2.2,
    env: env(0.003, 0.06, 0.15, 0.08),
  }, lvl(g, p, -10));
  shimmer(g, at + 0.03, p.dest, {
    hz: hz(root, g),
    modHz: hz(40, g, 0.15),
    index: 140,
    tailHz: 560,
    filterHz: 560,
    sweepHz: 220,
    sweepTime: 0.18,
    env: env(0.006, 0.08, 0.15, 0.12),
  }, lvl(g, p, -14));
};

/** R — Annihilate (ult): point AoE magic, stun. Sub + swell + heavy shimmer + detuned pair. */
const hexAnnihilate: CueFn = (g, at, p) => {
  const root = PALETTE.high.F4;
  thump(g, at, p.dest, {
    hz: hz(PALETTE.sub.D1 * 2, g),
    dropHz: hz(PALETTE.sub.D1, g),
    dropTime: 0.4,
    env: env(0.02, 0.3, 0.4, 0.5),
  }, lvl(g, p, -8));
  swell(g, at + 0.04, p.dest, {
    type: 'sawtooth',
    hz: hz(PALETTE.mid.D4, g),
    voices: 5,
    spreadCents: 26,
    openHz: 300,
    filterHz: 300,
    sweepHz: 700,
    sweepTime: 0.9,
    env: env(0.3, 0.4, 0.5, 0.7),
  }, lvl(g, p, -10));
  shimmer(g, at + 0.1, p.dest, {
    hz: hz(root, g),
    modHz: hz(18, g, 0.2),
    index: 160,
    tailHz: 520,
    filterHz: 520,
    sweepHz: 220,
    sweepTime: 0.9,
    env: env(0.05, 0.4, 0.4, 0.7),
  }, lvl(g, p, -9));
  tone(g, at + 0.06, p.dest, {
    type: 'sawtooth',
    hz: hz(root * 0.5, g),
    detune: -20,
    filterHz: 650,
    sweepHz: 280,
    sweepTime: 0.6,
    env: env(0.03, 0.3, 0.35, 0.5),
  }, lvl(g, p, -10));
  tone(g, at + 0.08, p.dest, {
    type: 'sawtooth',
    hz: hz(root * 0.503, g),
    detune: 18,
    filterHz: 650,
    env: env(0.035, 0.32, 0.35, 0.5),
  }, lvl(g, p, -12));
};

// ---------------------------------------------------------------------------
// MENDER — the only warmth in the game. Mid register. Sine/triangle only. Zero noise.
// ---------------------------------------------------------------------------

/** Q — Mend: ally heal. Low-register rising perfect fifth, soft attack. */
const menderMend: CueFn = (g, at, p) => {
  const root = PALETTE.low.D2;
  tone(g, at, p.dest, {
    type: 'sine',
    hz: hz(root, g),
    glideHz: hz(degree(root, 4, 0), g),
    glideTime: 0.3,
    env: env(0.05, 0.12, 0.4, 0.18),
  }, lvl(g, p, -6));
  swell(g, at + 0.03, p.dest, {
    type: 'triangle',
    hz: hz(root, g),
    voices: 2,
    spreadCents: 6,
    openHz: 900,
    env: env(0.05, 0.12, 0.4, 0.18),
  }, lvl(g, p, -12));
};

/** W — Smite: unit magic, slow. Two detuned sine/triangle voices, one closing filter. */
const menderSmite: CueFn = (g, at, p) => {
  const root = PALETTE.mid.D4;
  tone(g, at, p.dest, {
    type: 'triangle',
    hz: hz(root, g),
    detune: p.variant % 2 === 0 ? -16 : 14,
    filterHz: 1300,
    sweepHz: 420,
    sweepTime: 0.3,
    env: env(0.03, 0.12, 0.3, 0.18),
  }, lvl(g, p, -8));
  tone(g, at + 0.015, p.dest, {
    type: 'triangle',
    hz: hz(root * 1.004, g),
    detune: p.variant % 2 === 0 ? 20 : -18,
    env: env(0.035, 0.13, 0.3, 0.19),
  }, lvl(g, p, -10));
  swell(g, at + 0.02, p.dest, {
    type: 'triangle',
    hz: hz(root * 0.5, g),
    voices: 2,
    spreadCents: 8,
    openHz: 700,
    sweepHz: 260,
    sweepTime: 0.34,
    env: env(0.04, 0.12, 0.3, 0.18),
  }, lvl(g, p, -13));
};

/** E — Sanctuary: point heal + regen aura. High-register rising fifths + a warm pad. */
const menderSanctuary: CueFn = (g, at, p) => {
  const root = PALETTE.high.F4;
  tone(g, at, p.dest, {
    type: 'sine',
    hz: hz(root, g),
    glideHz: hz(degree(root, 4, 0), g),
    glideTime: 0.35,
    env: env(0.05, 0.15, 0.45, 0.2),
  }, lvl(g, p, -7));
  tone(g, at + 0.04, p.dest, {
    type: 'sine',
    hz: hz(degree(root, 4, 0), g),
    env: env(0.055, 0.15, 0.45, 0.2),
  }, lvl(g, p, -9));
  swell(g, at + 0.05, p.dest, {
    type: 'triangle',
    hz: hz(root * 0.5, g),
    voices: 3,
    spreadCents: 10,
    openHz: 700,
    env: env(0.06, 0.15, 0.45, 0.2),
  }, lvl(g, p, -12));
};

/** R — Guardian (ult): heal + armour aura. Sub + mandatory swell + double rising fifth. */
const menderGuardian: CueFn = (g, at, p) => {
  const root = PALETTE.mid.D3;
  thump(g, at, p.dest, {
    hz: hz(PALETTE.sub.D1 * 2, g),
    dropHz: hz(PALETTE.sub.D1, g),
    dropTime: 0.5,
    env: env(0.03, 0.35, 0.5, 0.55),
  }, lvl(g, p, -9));
  swell(g, at + 0.05, p.dest, {
    type: 'triangle',
    hz: hz(root, g),
    voices: 3,
    spreadCents: 10,
    openHz: 550,
    filterHz: 550,
    sweepHz: 260,
    sweepTime: 0.7,
    env: env(0.3, 0.35, 0.55, 0.6),
  }, lvl(g, p, -10));
  tone(g, at + 0.1, p.dest, {
    type: 'sine',
    hz: hz(root, g),
    glideHz: hz(degree(root, 4, 0), g),
    glideTime: 0.55,
    env: env(0.06, 0.35, 0.55, 0.55),
  }, lvl(g, p, -7));
  tone(g, at + 0.18, p.dest, {
    type: 'triangle',
    hz: hz(degree(root, 4, 1), g),
    env: env(0.07, 0.4, 0.5, 0.5),
  }, lvl(g, p, -15));
};

// ---------------------------------------------------------------------------
// SHADE — absence, a sound that pulls inward instead of striking out. Mid register.
// ---------------------------------------------------------------------------

/** Q — Shadow Strike: unit, physical, dash. Low-register minimal transient, closing inward swell. */
const shadeShadowStrike: CueFn = (g, at, p) => {
  const root = PALETTE.low.F2;
  noise(g, at, p.dest, {
    filter: 'bandpass',
    hz: hz(360, g),
    sweepHz: hz(1000, g),
    sweepTime: 0.02,
    q: 1.8,
    env: env(0.002, 0.03, 0.1, 0.05),
  }, lvl(g, p, -9));
  swell(g, at + 0.01, p.dest, {
    type: 'sine',
    hz: hz(root, g),
    voices: 2,
    spreadCents: 12,
    openHz: 700,
    filterHz: 700,
    sweepHz: 200,
    sweepTime: 0.28,
    env: env(0.01, 0.16, 0.15, 0.2),
  }, lvl(g, p, -11));
};

/** W — Smoke: point AoE magic, slow. Faint shimmer inside a closing, pulled-in swell. */
const shadeSmoke: CueFn = (g, at, p) => {
  const root = PALETTE.mid.C4;
  shimmer(g, at, p.dest, {
    hz: hz(root * 1.5, g),
    modHz: hz(15, g, 0.2),
    index: 70,
    tailHz: 420,
    filterHz: 420,
    sweepHz: 160,
    sweepTime: 0.3,
    env: env(0.02, 0.18, 0.2, 0.3),
  }, lvl(g, p, -12));
  swell(g, at + 0.02, p.dest, {
    type: 'sine',
    hz: hz(root, g),
    voices: 3,
    spreadCents: 14,
    openHz: 550,
    filterHz: 550,
    sweepHz: 180,
    sweepTime: 0.35,
    env: env(0.03, 0.2, 0.25, 0.35),
  }, lvl(g, p, -10));
};

/** E — Mark: passive damage aura. Rarely fires; a tiny high-register stamp + inward-pulled tail. */
const shadeMark: CueFn = (g, at, p) => {
  const root = PALETTE.high.F4;
  noise(g, at, p.dest, {
    filter: 'bandpass',
    hz: hz(500, g),
    q: 2.4,
    env: env(0.003, 0.03, 0.1, 0.05),
  }, lvl(g, p, -14));
  swell(g, at + 0.005, p.dest, {
    type: 'sine',
    hz: hz(root, g),
    voices: 2,
    spreadCents: 8,
    openHz: 600,
    filterHz: 600,
    sweepHz: 250,
    sweepTime: 0.18,
    env: env(0.008, 0.1, 0.12, 0.15),
  }, lvl(g, p, -15));
};

/** R — Phantoms (ult): summons shades + move-speed aura. Sub swell rising into a mid cluster. */
const shadePhantoms: CueFn = (g, at, p) => {
  const root = PALETTE.mid.D3;
  thump(g, at, p.dest, {
    hz: hz(PALETTE.sub.D1 * 2, g),
    dropHz: hz(PALETTE.sub.D1, g),
    dropTime: 0.45,
    env: env(0.02, 0.35, 0.45, 0.55),
  }, lvl(g, p, -9));
  swell(g, at + 0.05, p.dest, {
    type: 'sine',
    hz: hz(PALETTE.sub.A1, g),
    voices: 4,
    spreadCents: 20,
    openHz: 400,
    filterHz: 400,
    sweepHz: 750,
    sweepTime: 0.7,
    env: env(0.25, 0.35, 0.45, 0.6),
  }, lvl(g, p, -10));
  swell(g, at + 0.15, p.dest, {
    type: 'sine',
    hz: hz(root, g),
    voices: 3,
    spreadCents: 16,
    openHz: 700,
    filterHz: 700,
    sweepHz: 260,
    sweepTime: 0.55,
    env: env(0.15, 0.3, 0.4, 0.5),
  }, lvl(g, p, -11));
  shimmer(g, at + 0.2, p.dest, {
    hz: hz(PALETTE.high.A4, g),
    modHz: hz(12, g, 0.2),
    index: 80,
    tailHz: 480,
    filterHz: 480,
    sweepHz: 200,
    sweepTime: 0.5,
    env: env(0.1, 0.3, 0.35, 0.5),
  }, lvl(g, p, -14));
  noise(g, at + 0.1, p.dest, {
    filter: 'bandpass',
    hz: hz(350, g),
    sweepHz: hz(150, g),
    sweepTime: 0.5,
    q: 1.5,
    env: env(0.05, 0.3, 0.3, 0.45),
  }, lvl(g, p, -13));
};

// ---------------------------------------------------------------------------
// ITEM ACTIVES — hero-agnostic, item-flavoured.
// ---------------------------------------------------------------------------

/** blinkstone — 8m dash. Doppler noise sweep (up then down) + a stone-flick ping. */
const itemBlink: CueFn = (g, at, p) => {
  noise(g, at, p.dest, {
    filter: 'bandpass',
    hz: hz(260, g),
    sweepHz: hz(650, g),
    sweepTime: 0.05,
    q: 2.2,
    env: env(0.003, 0.04, 0.15, 0.05),
  }, lvl(g, p, -9));
  noise(g, at + 0.05, p.dest, {
    filter: 'bandpass',
    hz: hz(650, g),
    sweepHz: hz(240, g),
    sweepTime: 0.06,
    q: 2.2,
    env: env(0.003, 0.05, 0.12, 0.07),
  }, lvl(g, p, -10));
  metal(g, at + 0.05, p.dest, {
    ratios: p.variant % 2 === 0 ? METAL_RATIOS.slice(0, 4) : METAL_RATIOS.slice(1, 5),
    hz: hz(PALETTE.mid.A3, g),
    bandHz: hz(450, g),
    q: 3.5,
    env: env(0.002, 0.05, 0.1, 0.08),
  }, lvl(g, p, -13));
};

/** warhorn — damage-aura horn. A brassy sustained tone over a metal partial + weight. */
const itemHorn: CueFn = (g, at, p) => {
  const root = PALETTE.mid.D3;
  thump(g, at, p.dest, {
    hz: hz(PALETTE.low.D2, g),
    dropHz: hz(PALETTE.low.D2 * 0.8, g),
    dropTime: 0.1,
    env: env(0.008, 0.1, 0.2, 0.15),
  }, lvl(g, p, -8));
  tone(g, at + 0.01, p.dest, {
    type: p.variant % 2 === 0 ? 'sawtooth' : 'square',
    hz: hz(root, g),
    filterHz: 780,
    sweepHz: 620,
    sweepTime: 0.35,
    env: env(0.03, 0.15, 0.5, 0.3),
  }, lvl(g, p, -6));
  metal(g, at + 0.015, p.dest, {
    ratios: METAL_RATIOS.slice(0, 5),
    hz: hz(root, g),
    bandHz: hz(400, g),
    q: 2.2,
    env: env(0.02, 0.15, 0.3, 0.25),
  }, lvl(g, p, -10));
};

/** wardstone — ward placement. A soft ground thump + a light magic activation ping. */
const itemWard: CueFn = (g, at, p) => {
  thump(g, at, p.dest, {
    hz: hz(PALETTE.low.A2, g),
    dropHz: hz(PALETTE.low.A2 * 0.7, g),
    dropTime: 0.08,
    env: env(0.005, 0.06, 0.2, 0.1),
  }, lvl(g, p, -9));
  tone(g, at + 0.06, p.dest, {
    type: 'sine',
    hz: hz(PALETTE.high.F4, g),
    env: env(0.01, 0.1, 0.2, 0.15),
  }, lvl(g, p, -14));
  metal(g, jitteredAt(g, at), p.dest, {
    ratios: p.variant % 2 === 0 ? METAL_RATIOS.slice(0, 4) : METAL_RATIOS.slice(1, 5),
    hz: hz(PALETTE.low.A2, g),
    bandHz: hz(420, g),
    q: 2.6,
    env: env(0.004, 0.06, 0.15, 0.1),
  }, lvl(g, p, -13));
};

/** Any other item active — a neutral, plain "item used" click. */
const itemGeneric: CueFn = (g, at, p) => {
  metal(g, at, p.dest, {
    ratios: p.variant % 2 === 0 ? METAL_RATIOS.slice(0, 4) : METAL_RATIOS.slice(1, 5),
    hz: hz(PALETTE.mid.A3, g),
    bandHz: hz(450, g),
    q: 2.6,
    env: env(0.003, 0.05, 0.15, 0.08),
  }, lvl(g, p, -11));
  noise(g, at + 0.005, p.dest, {
    filter: 'bandpass',
    hz: hz(400, g),
    q: 1.8,
    env: env(0.003, 0.03, 0.1, 0.05),
  }, lvl(g, p, -13));
};

// ---------------------------------------------------------------------------
// Registry — 28 keys. `satisfies`, never a type annotation (AUDIO_CONTRACT.md rule 14).
// ---------------------------------------------------------------------------

export const ABILITY_CUES = {
  'cast.bullwark.0': {
    fn: bullwarkShieldCrash, bus: 'sfx', priority: 4, tail: 0.35, variants: 2, dry: false,
  },
  'cast.bullwark.1': {
    fn: bullwarkBulwark, bus: 'sfx', priority: 4, tail: 0.2, variants: 2, dry: false,
  },
  'cast.bullwark.2': {
    fn: bullwarkGroundSlam, bus: 'sfx', priority: 4, tail: 0.55, variants: 2, dry: false,
  },
  'cast.bullwark.3': {
    fn: bullwarkRally, bus: 'sfx', priority: 4, tail: 1.4, variants: 1, dry: false,
  },
  'cast.longbow.0': {
    fn: longbowPiercingArrow, bus: 'sfx', priority: 4, tail: 0.25, variants: 2, dry: false,
  },
  'cast.longbow.1': {
    fn: longbowFocus, bus: 'sfx', priority: 4, tail: 0.18, variants: 2, dry: false,
  },
  'cast.longbow.2': {
    fn: longbowFrostArrow, bus: 'sfx', priority: 4, tail: 0.45, variants: 2, dry: false,
  },
  'cast.longbow.3': {
    fn: longbowRainOfArrows, bus: 'sfx', priority: 4, tail: 1.35, variants: 1, dry: false,
  },
  'cast.reaver.0': {
    fn: reaverCleave, bus: 'sfx', priority: 4, tail: 0.4, variants: 2, dry: false,
  },
  'cast.reaver.1': {
    fn: reaverFrenzy, bus: 'sfx', priority: 4, tail: 0.2, variants: 2, dry: false,
  },
  'cast.reaver.2': {
    fn: reaverLunge, bus: 'sfx', priority: 4, tail: 0.35, variants: 2, dry: false,
  },
  'cast.reaver.3': {
    fn: reaverDismember, bus: 'sfx', priority: 4, tail: 1.0, variants: 1, dry: false,
  },
  'cast.hex.0': {
    fn: hexHexbolt, bus: 'sfx', priority: 4, tail: 0.4, variants: 2, dry: false,
  },
  'cast.hex.1': {
    fn: hexCripple, bus: 'sfx', priority: 4, tail: 0.5, variants: 2, dry: false,
  },
  'cast.hex.2': {
    fn: hexBlink, bus: 'sfx', priority: 4, tail: 0.25, variants: 2, dry: false,
  },
  'cast.hex.3': {
    fn: hexAnnihilate, bus: 'sfx', priority: 4, tail: 1.45, variants: 1, dry: false,
  },
  'cast.mender.0': {
    fn: menderMend, bus: 'sfx', priority: 4, tail: 0.4, variants: 2, dry: false,
  },
  'cast.mender.1': {
    fn: menderSmite, bus: 'sfx', priority: 4, tail: 0.4, variants: 2, dry: false,
  },
  'cast.mender.2': {
    fn: menderSanctuary, bus: 'sfx', priority: 4, tail: 0.5, variants: 2, dry: false,
  },
  'cast.mender.3': {
    fn: menderGuardian, bus: 'sfx', priority: 4, tail: 1.3, variants: 1, dry: false,
  },
  'cast.shade.0': {
    fn: shadeShadowStrike, bus: 'sfx', priority: 4, tail: 0.4, variants: 2, dry: false,
  },
  'cast.shade.1': {
    fn: shadeSmoke, bus: 'sfx', priority: 4, tail: 0.6, variants: 2, dry: false,
  },
  'cast.shade.2': {
    fn: shadeMark, bus: 'sfx', priority: 4, tail: 0.28, variants: 2, dry: false,
  },
  'cast.shade.3': {
    fn: shadePhantoms, bus: 'sfx', priority: 4, tail: 1.3, variants: 1, dry: false,
  },
  'cast.item.blink': {
    fn: itemBlink, bus: 'sfx', priority: 4, tail: 0.2, variants: 2, dry: false,
  },
  'cast.item.horn': {
    fn: itemHorn, bus: 'sfx', priority: 4, tail: 0.5, variants: 2, dry: false,
  },
  'cast.item.ward': {
    fn: itemWard, bus: 'sfx', priority: 4, tail: 0.35, variants: 2, dry: false,
  },
  'cast.item.generic': {
    fn: itemGeneric, bus: 'sfx', priority: 4, tail: 0.15, variants: 2, dry: false,
  },
} satisfies Partial<Record<SoundId, CueSpec>>;
