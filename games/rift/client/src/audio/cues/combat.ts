/**
 * RIFT AUDIO — cues/combat.ts (T5)
 *
 * `atk.*` (the swing), `hit.*` (the impact, including the low-HP heartbeat) and `die.*`
 * (creep/ward/hero deaths, including the team-interval hero-death family). These are the
 * highest-repetition cues in the whole build — thousands of plays per match — so every
 * cue here stays small (SONIC_BIBLE §5: auto-attacks/small hits are 2-3 layers, <=200ms)
 * and every repeatable cue genuinely varies per SONIC_BIBLE §7 / AUDIO_CONTRACT rule 11:
 * round-robin picks a structurally different base (register note, filter centre) per
 * `p.variant`, and `jitter()` adds a fresh pitch/timbre nudge on every single play on top
 * of that, so the same variant never sounds identical twice in a row either.
 *
 * BAND POLICY (amended): the protected lane is 2000-4000 Hz ONLY — that is where
 * `ui.lastHit` and the announcer live, and it stays clear. 120-2000 Hz is OPEN and
 * EXPECTED here: a rendered-audio review found the previous "everything under ~780 Hz"
 * reading of the old rule dumped 98-99% of every impact cue's energy below 120 Hz, where
 * most speakers roll off — the most-fired sounds in the game were reading as silent on a
 * laptop, and two death cues that must never be confused (ally vs self) were a 1 Hz
 * centroid apart because their only audible content was a sub-bass thump. Every impact cue
 * below is now a genuine THREE-layer sound:
 *   - SUB   (`thump`, low/sub register) — weight underneath, capped to a MINORITY of the
 *     cue's total energy. It is a layer under the sound, not the sound.
 *   - BODY  (`noise` band-passed 300-750 Hz, or `metal` for a steel/structural material) —
 *     the DOMINANT layer. This is what makes the cue audible on a phone speaker and what
 *     tells the player WHAT was hit; material (tonal/metallic via `metal` vs broadband/dull
 *     via `noise`) is the primary differentiator between e.g. a hero's weapon and a
 *     creep's, not loudness.
 *   - TRANSIENT (`noise`, brief, high-passed/band-passed) — real edge for impact percept,
 *     placed at 4-6 kHz specifically to sit clear of `ui.lastHit`'s 2-4 kHz lane.
 * Damage-school colour (SONIC_BIBLE §3) still holds for `hit.physical`/`hit.magic`:
 * physical stays noise/broadband-forward, magic stays tonal via `shimmer`. `hit.self` is a
 * deliberate exception to the "bright transient" rule — it is described as a duller,
 * muffled thud ("that was me"), so it carries no 4-6 kHz edge on purpose (its body layer is
 * a low-Q bandpass, not a lowpass, so it still excludes the deep sub rather than diluting
 * into it). `hit.heartbeat` is sub/body only, no transient — it is an interoceptive
 * body-pulse cue, not a positioned impact, so brightness would read as alarm rather than
 * dread — but it DOES carry a soft 150-400 Hz body under the sub (amended spec: the
 * original "no content above 300 Hz" line made the cue inaudible on speakers that roll off
 * below ~120 Hz, which is most laptops/phones/headsets).
 */

import type { CueFn, CueGraph, CuePlay, CueRegistry, Env } from '../contract.js';
import { jitter, metal, noise, shimmer, thump, tone } from '../dsp.js';
import { INTERVAL, METAL_RATIOS, PALETTE, VARY } from '../config.js';

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
// atk.* — the swing. Attacks are the most-fired cues in the game: attack < 8 ms (measured
// on the summed signal), total < 200 ms, crest > 8 dB. No layer here uses `layerOffset` —
// even a few ms of stagger on a second layer pushes the measured onset out; every layer
// starts at exactly `at`. Material, not loudness, tells hero apart from creep: `metal`
// (tonal, ringing partials) reads as steel; `noise` at a low Q reads as dull wood/leather.
// ---------------------------------------------------------------------------

const atkHeroMelee: CueFn = (g, at, p) => {
  // SUB — weight underneath, capped low.
  const subHz = jitter(g, rr4(p.variant, SUB.A1, SUB.D1, SUB.D2, SUB.A1), VARY.attackPitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz: subHz,
      dropHz: subHz * 0.5,
      dropTime: 0.05,
      env: { attack: 0.003, decay: 0.03, sustain: 0.06, release: 0.05, peak: 1 },
    },
    0.28 * p.gain,
  );
  // BODY — metallic clang: the hero's material identity, dominant layer.
  const bodyHz = jitter(g, rr4(p.variant, MID.D3, MID.F3, MID.A3, MID.D4), VARY.timbrePct);
  metal(
    g,
    at,
    p.dest,
    {
      ratios: METAL_RATIOS,
      hz: bodyHz,
      bandHz: bodyHz * 2.1,
      q: 1.8,
      env: { attack: 0.003, decay: 0.05, sustain: 0.12, release: 0.08, peak: 1 },
    },
    1.0 * p.gain,
  );
  // TRANSIENT — bright metallic edge, 4-6 kHz, clear of ui.lastHit's 2-4 kHz lane.
  const edgeHz = jitter(g, rr4(p.variant, 4200, 4600, 4900, 5200), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: edgeHz,
      q: 3,
      env: { attack: 0.001, decay: 0.006, sustain: 0, release: 0.01, peak: 1 },
    },
    0.45 * p.gain,
  );
};

const atkHeroRanged: CueFn = (g, at, p) => {
  const subHz = jitter(g, rr4(p.variant, SUB.D1, SUB.A1, SUB.D2, SUB.A1), VARY.attackPitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz: subHz,
      dropHz: subHz * 0.55,
      dropTime: 0.035,
      env: { attack: 0.0025, decay: 0.02, sustain: 0.05, release: 0.035, peak: 1 },
    },
    0.1 * p.gain,
  );
  // BODY — the launch/air "whoosh", broadband (not tonal) but still brighter-leaning than
  // a creep's bow, matching the hero-family's edge. Tighter Q than the creep bow to
  // concentrate more of its energy in-band against the sub thump.
  const bandHz = jitter(g, rr4(p.variant, 550, 610, 660, 710), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.75,
      sweepTime: 0.05,
      q: 1.9,
      env: { attack: 0.0025, decay: 0.03, sustain: 0.08, release: 0.06, peak: 1 },
    },
    1.3 * p.gain,
  );
  // TRANSIENT — thin bowstring snap, higher/thinner than melee's clang.
  const edgeHz = jitter(g, rr4(p.variant, 5000, 5400, 5700, 6000), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: edgeHz,
      q: 3.5,
      env: { attack: 0.001, decay: 0.005, sustain: 0, release: 0.008, peak: 1 },
    },
    0.4 * p.gain,
  );
};

const atkCreepMelee: CueFn = (g, at, p) => {
  const subHz = jitter(g, rr4(p.variant, SUB.D1, SUB.A1, SUB.D2, SUB.A1), VARY.attackPitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz: subHz,
      dropHz: subHz * 0.5,
      dropTime: 0.04,
      env: { attack: 0.003, decay: 0.022, sustain: 0.05, release: 0.035, peak: 1 },
    },
    0.13 * p.gain,
  );
  // BODY — dull wood/leather club: broadband noise, low-ish Q so it still reads as
  // flat/aperiodic (never ringing the way the hero's `metal` layer does), but tight enough
  // to concentrate its energy against the sub thump.
  const bandHz = jitter(g, rr4(p.variant, 420, 480, 540, 600), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.65,
      sweepTime: 0.045,
      q: 1.15,
      env: { attack: 0.003, decay: 0.03, sustain: 0.07, release: 0.055, peak: 1 },
    },
    1.35 * p.gain,
  );
  // TRANSIENT — present but subdued and lower than the hero's bright edge: duller.
  const edgeHz = jitter(g, rr4(p.variant, 3200, 3400, 3600, 3800), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: edgeHz,
      q: 2.2,
      env: { attack: 0.001, decay: 0.005, sustain: 0, release: 0.008, peak: 1 },
    },
    0.15 * p.gain,
  );
};

const atkCreepRanged: CueFn = (g, at, p) => {
  const subHz = jitter(g, rr4(p.variant, SUB.A1, SUB.D1, SUB.D2, SUB.A1), VARY.attackPitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz: subHz,
      dropHz: subHz * 0.55,
      dropTime: 0.03,
      env: { attack: 0.0025, decay: 0.018, sustain: 0.04, release: 0.028, peak: 1 },
    },
    0.11 * p.gain,
  );
  const bandHz = jitter(g, rr4(p.variant, 460, 520, 580, 640), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.6,
      sweepTime: 0.04,
      q: 1.2,
      env: { attack: 0.0025, decay: 0.025, sustain: 0.06, release: 0.045, peak: 1 },
    },
    1.2 * p.gain,
  );
  const edgeHz = jitter(g, rr4(p.variant, 3000, 3200, 3400, 3600), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: edgeHz,
      q: 2.2,
      env: { attack: 0.001, decay: 0.004, sustain: 0, release: 0.007, peak: 1 },
    },
    0.12 * p.gain,
  );
};

const atkSiege: CueFn = (g, at, p) => {
  const subHz = jitter(g, rr4(p.variant, SUB.D2, SUB.A1, SUB.D2, SUB.D1), VARY.attackPitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz: subHz,
      dropHz: subHz * 0.48,
      dropTime: 0.05,
      env: { attack: 0.003, decay: 0.03, sustain: 0.07, release: 0.05, peak: 1 },
    },
    0.15 * p.gain,
  );
  // BODY — heavier and lower than a hand creep weapon: a war machine's timber/iron frame.
  const bandHz = jitter(g, rr4(p.variant, 340, 400, 460, 520), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.6,
      sweepTime: 0.05,
      q: 1.2,
      env: { attack: 0.003, decay: 0.04, sustain: 0.09, release: 0.07, peak: 1 },
    },
    1.4 * p.gain,
  );
  // TRANSIENT — a mechanical crunch, duller than the hero's clang, more present than a
  // hand-creep's tap.
  const edgeHz = jitter(g, rr4(p.variant, 3400, 3600, 3800, 4000), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: edgeHz,
      q: 2.5,
      env: { attack: 0.001, decay: 0.006, sustain: 0, release: 0.01, peak: 1 },
    },
    0.25 * p.gain,
  );
};

/** Heaviest attack: a structural steel body over a sub component (AUDIO_CONTRACT T5). */
const atkTower: CueFn = (g, at, p) => {
  const subHz = jitter(g, rr4(p.variant, SUB.D1, SUB.A1, SUB.D2, SUB.A1), VARY.attackPitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz: subHz,
      dropHz: subHz * 0.55,
      dropTime: 0.06,
      env: { attack: 0.0022, decay: 0.03, sustain: 0.08, release: 0.05, peak: 1 },
    },
    0.2 * p.gain,
  );
  // BODY — structural steel via `metal` (SONIC_BIBLE §4: metal = "steel, armour,
  // STRUCTURES"), the heaviest, lowest-centred body in the atk.* family. This is the
  // loudest cue in the atk.* family (heaviest design intent) and it pushes hardest into
  // the shared bus compressor, which measurably softens onset — total level trimmed here
  // (not just the sub/body ratio) to bring its peak in line with the rest of the family,
  // which is what actually recovers the sub-8ms onset.
  const bodyHz = jitter(g, rr4(p.variant, MID.D3, MID.F3, MID.A3, MID.D3), VARY.timbrePct);
  metal(
    g,
    at,
    p.dest,
    {
      ratios: METAL_RATIOS,
      hz: bodyHz,
      bandHz: bodyHz * 2.0,
      q: 1.9,
      env: { attack: 0.0022, decay: 0.042, sustain: 0.11, release: 0.075, peak: 1 },
    },
    0.85 * p.gain,
  );
  // TRANSIENT — the mechanical release clank.
  const edgeHz = jitter(g, rr4(p.variant, 4600, 4900, 5200, 5500), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: edgeHz,
      q: 3,
      env: { attack: 0.001, decay: 0.007, sustain: 0, release: 0.012, peak: 1 },
    },
    0.3 * p.gain,
  );
};

// ---------------------------------------------------------------------------
// hit.* — the impact. Fired at the victim's position whenever any unit loses HP.
// hit.physical / hit.magic / hit.crit are the three "what landed" cues, now the same
// three-layer sub/body/transient shape as atk.*; hit.self is the deliberate muffled
// exception (no bright transient — it is written to sound duller, not sharper);
// hit.heartbeat is sub+soft-body only, no transient (its own spec: no bright content —
// dread, not alarm — but a 150-400 Hz body layer keeps it audible on small speakers).
// ---------------------------------------------------------------------------

const hitPhysical: CueFn = (g, at, p) => {
  const bandHz = jitter(g, rr4(p.variant, 400, 480, 560, 640), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.6,
      sweepTime: 0.07,
      q: 1.2,
      env: { attack: 0.003, decay: 0.045, sustain: 0.08, release: 0.075, peak: 1 },
    },
    1.4 * p.gain,
  );
  const hz = jitter(g, rr4(p.variant, LOW.D2, LOW.F2, LOW.A2, LOW.D3), VARY.pitchPct);
  thump(
    g,
    at + layerOffset(g),
    p.dest,
    {
      hz,
      dropHz: hz * 0.45,
      dropTime: 0.07,
      env: { attack: 0.004, decay: 0.05, sustain: 0.09, release: 0.07, peak: 1 },
    },
    0.13 * p.gain,
  );
  const edgeHz = jitter(g, rr4(p.variant, 4000, 4300, 4600, 4900), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: edgeHz,
      q: 3,
      env: { attack: 0.001, decay: 0.006, sustain: 0, release: 0.012, peak: 1 },
    },
    0.35 * p.gain,
  );
};

/** Magic school: tonal-forward ring-mod shimmer (body + identity) + a sub thump + a spark. */
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
      env: { attack: 0.004, decay: 0.05, sustain: 0.14, release: 0.1, peak: 1 },
    },
    0.75 * p.gain,
  );
  const bodyHz = jitter(g, rr4(p.variant, LOW.D2, LOW.F2, LOW.A2, LOW.D3), VARY.pitchPct);
  thump(
    g,
    at + layerOffset(g),
    p.dest,
    {
      hz: bodyHz,
      dropHz: bodyHz * 0.45,
      dropTime: 0.06,
      env: { attack: 0.004, decay: 0.04, sustain: 0.08, release: 0.065, peak: 1 },
    },
    0.3 * p.gain,
  );
  const sparkHz = jitter(g, rr4(p.variant, 4500, 4800, 5100, 5500), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: sparkHz,
      q: 3.2,
      env: { attack: 0.001, decay: 0.007, sustain: 0, release: 0.012, peak: 1 },
    },
    0.3 * p.gain,
  );
};

/**
 * A bigger version of hit.physical plus a brighter accent. The accent now lives at 4-6 kHz
 * (clear of ui.lastHit's 2-4 kHz lane, and free to be bigger now that the protected lane is
 * 2-4 kHz only, not "everything above 800 Hz").
 */
const hitCrit: CueFn = (g, at, p) => {
  const bandHz = jitter(g, rr4(p.variant, 420, 500, 580, 660), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.55,
      sweepTime: 0.07,
      q: 1.25,
      env: { attack: 0.003, decay: 0.05, sustain: 0.1, release: 0.08, peak: 1 },
    },
    1.4 * p.gain,
  );
  const hz = jitter(g, rr4(p.variant, LOW.F2, LOW.A2, LOW.D3, LOW.D2), VARY.pitchPct);
  thump(
    g,
    at + layerOffset(g),
    p.dest,
    {
      hz,
      dropHz: hz * 0.4,
      dropTime: 0.08,
      env: { attack: 0.004, decay: 0.05, sustain: 0.1, release: 0.075, peak: 1 },
    },
    0.14 * p.gain,
  );
  const accentHz = jitter(g, rr4(p.variant, 4500, 4900, 5300, 5700), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: accentHz,
      q: 3.5,
      env: { attack: 0.001, decay: 0.008, sustain: 0, release: 0.014, peak: 1 },
    },
    0.45 * p.gain,
  );
};

/**
 * What the local player hears taking damage: a duller, lower, filtered thud. Deliberately
 * carries NO bright transient — "duller/muffled" is the whole point ("that was me", not a
 * clean readable clang), so it stays a sub+body pair by design, not an oversight.
 */
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
      env: { attack: 0.005, decay: 0.05, sustain: 0.1, release: 0.09, peak: 1 },
    },
    0.16 * p.gain,
  );
  // BODY — bandpass, not lowpass: a lowpass still passes everything below its cutoff,
  // which dilutes straight back into the 0-120Hz bin alongside the sub thump. A bandpass
  // centred just below hit.physical's (duller, lower) excludes the deep sub explicitly
  // while staying muffled — no highpass skirt, no bright transient, still "that was me".
  const cutoff = jitter(g, rr4(p.variant, 340, 380, 420, 460), VARY.timbrePct);
  noise(
    g,
    at + layerOffset(g),
    p.dest,
    {
      filter: 'bandpass',
      hz: cutoff,
      sweepHz: cutoff * 0.6,
      sweepTime: 0.1,
      q: 1.1,
      env: { attack: 0.006, decay: 0.06, sustain: 0.09, release: 0.09, peak: 1 },
    },
    1.4 * p.gain,
  );
};

/**
 * The low-HP dread pulse: a sub-register double-thump ("lub-dub") plus a soft, non-
 * percussive low-mid body (150-400 Hz) so the pulse is audible — not just felt — on a
 * speaker that rolls off below ~120 Hz. Amended spec (was "no content above 300 Hz", which
 * made the cue read as silence on exactly the hardware most players use): still `dry: true`
 * and still exempt from the stereo-decorrelation gate (non-positional is correct — this is
 * the player's own pulse, not a world event) — only audibility changed. The body layer uses
 * a SOFT attack (14 ms, not the crisp <3 ms transients used elsewhere in this file) and a
 * low Q so it reads as a dull thud riding under the sub, never a click or a bright ping —
 * dread, not alarm — which matters doubly here because this cue repeats every
 * `DERIVE.lowHpPulseS` while the player is near death and fatigue is the real risk.
 * `p.intensity` carries the band from `index.ts`'s heartbeat timer (0 = 30% HP, 1 = 15%
 * HP); band 1 is tighter, louder and more urgent. Every firing draws a fresh `jitter()`
 * value, so a heartbeat repeated every 0.62-1.1 s all match never locks into a mechanically
 * identical tick.
 */
const hitHeartbeat: CueFn = (g, at, p) => {
  const urgent = p.intensity >= 1;
  const gap = urgent ? 0.11 : 0.16;
  const level = (urgent ? 1.15 : 1.0) * p.gain;
  const hz1 = jitter(g, SUB.A1, VARY.pitchPct);
  const hz2 = jitter(g, SUB.D1, VARY.pitchPct);
  // SUB — the felt weight. A sine's energy concentrates almost entirely into one narrow
  // bin, so even a "modest" gain here out-competes a much louder broadband body layer for
  // share of energy (the same lesson from the atk.*/die.* rebuild) — trimmed hard (0.9/0.65
  // -> 0.2/0.15) so the new body layer, not this, sets the cue's spectral centre of mass.
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
    0.2 * level,
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
    0.15 * level,
  );
  // BODY — a soft low-mid thud under each beat, never bright, never sharp. Gain set well
  // above the sub layer's (the pattern that actually moves the balance, per the same
  // lesson) and Q tightened (1.1 -> 2.2) to concentrate its energy competitively.
  const bodyHz1 = jitter(g, 230, VARY.pitchPct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bodyHz1,
      q: 2.2,
      env: { attack: 0.014, decay: 0.06, sustain: 0.16, release: 0.1, peak: 1 },
    },
    1.5 * level,
  );
  const bodyHz2 = jitter(g, 190, VARY.pitchPct);
  noise(
    g,
    at + gap,
    p.dest,
    {
      filter: 'bandpass',
      hz: bodyHz2,
      q: 2.2,
      env: { attack: 0.014, decay: 0.055, sustain: 0.13, release: 0.09, peak: 1 },
    },
    1.15 * level,
  );
};

// ---------------------------------------------------------------------------
// die.* — deaths. The three hero-death cues share one shape and differ only in the
// SONIC_BIBLE §3 team-interval colour: `die.hero` resolves consonant (good news, an enemy
// fell), `die.hero.ally` and `die.hero.self` colour dissonant (bad news). The interval
// chord's root now sits in the audible MID register (was LOW.D2, ~73 Hz — inaudible on
// small speakers and the reason die.hero.ally/die.hero.self were a 1 Hz centroid apart);
// the SUB thump stays underneath as weight, not as the whole sound. `die.hero.self` gets
// the hardest onset of the three plus extra low-end weight for the real loss.
// ---------------------------------------------------------------------------

function heroDeathChord(
  g: CueGraph,
  at: number,
  p: CuePlay,
  interval: readonly number[],
  weight: number,
  hardOnset: boolean,
): void {
  // INTERVAL.ally / INTERVAL.enemy are both frozen 3-entry arrays (config.ts) widened to
  // `readonly number[]`, so indexing is `number | undefined` under noUncheckedIndexedAccess
  // even though a 3rd element always exists. The `?? 1` fallback documents that and is
  // never actually exercised — the same pattern dsp.ts's own `degree()` uses.
  const i0 = interval[0] ?? 1;
  const i1 = interval[1] ?? 1;
  const i2 = interval[2] ?? 1;
  // Chord root moved to the audible MID register — this is the fix. At the old LOW.D2 root
  // (~73 Hz) the whole ally/enemy interval colouring rode under 120 Hz alongside the sub
  // thump; nobody could hear which interval was even playing.
  const root = jitter(g, MID.A3, VARY.pitchPct);

  // SUB — body-fall weight, underneath, capped.
  const subRoot = jitter(g, LOW.D2, VARY.pitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz: subRoot,
      dropHz: subRoot * 0.42,
      dropTime: 0.18 * weight,
      env: {
        attack: hardOnset ? 0.0025 : 0.004,
        decay: 0.1,
        sustain: 0.18,
        release: 0.3 * weight,
        peak: 1,
      },
    },
    0.4 * weight * p.gain,
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
        dropTime: 0.3,
        env: { attack: 0.003, decay: 0.14, sustain: 0.28, release: 0.5, peak: 1 },
      },
      0.42 * p.gain,
    );
  }

  // BODY/CHORD — the team-interval colour, now dominant and audible.
  const chordEnv: Env = {
    attack: hardOnset ? 0.006 : 0.015,
    decay: 0.14,
    sustain: 0.35,
    release: 0.45 * weight,
    peak: 1,
  };
  const cutoff = jitter(g, 1800, VARY.timbrePct);
  tone(
    g,
    at + layerOffset(g),
    p.dest,
    { type: 'triangle', hz: root * i0, filterHz: cutoff, env: chordEnv },
    0.65 * p.gain,
  );
  tone(
    g,
    at + layerOffset(g),
    p.dest,
    { type: 'triangle', hz: root * i1, filterHz: cutoff, env: chordEnv },
    0.55 * p.gain,
  );
  tone(
    g,
    at + layerOffset(g),
    p.dest,
    { type: 'triangle', hz: root * i2, filterHz: cutoff, env: chordEnv },
    0.48 * p.gain,
  );

  // TRANSIENT — the fall's impact edge. die.hero.self gets a harsher, higher, louder crack
  // for the hardest onset of the three; the other two get a modest, softer one.
  const edgeHz = hardOnset
    ? jitter(g, 5200, VARY.timbrePct)
    : jitter(g, 4200, VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: edgeHz,
      q: hardOnset ? 3.4 : 2.6,
      env: {
        attack: 0.001,
        decay: hardOnset ? 0.01 : 0.008,
        sustain: 0,
        release: hardOnset ? 0.016 : 0.013,
        peak: 1,
      },
    },
    (hardOnset ? 0.4 : 0.25) * p.gain,
  );
}

/** An enemy fell — good news, resolved with INTERVAL.ally (fifth + octave). */
const dieHero: CueFn = (g, at, p) => heroDeathChord(g, at, p, INTERVAL.ally, 1, false);

/** A teammate fell — bad news, coloured with INTERVAL.enemy (minor 2nd + tritone). */
const dieHeroAlly: CueFn = (g, at, p) => heroDeathChord(g, at, p, INTERVAL.enemy, 1, false);

/** You fell — INTERVAL.enemy, extra low-end weight, and the hardest onset of the three. */
const dieHeroSelf: CueFn = (g, at, p) => heroDeathChord(g, at, p, INTERVAL.enemy, 1.4, true);

/**
 * Fires constantly — must sit below the last-hit chime it accompanies and never mask it:
 * nothing in the 2-4 kHz protected lane.
 */
const dieCreep: CueFn = (g, at, p) => {
  const subHz = jitter(g, rr4(p.variant, SUB.D1, SUB.A1, SUB.D2, SUB.A1), VARY.pitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz: subHz,
      dropHz: subHz * 0.45,
      dropTime: 0.04,
      env: { attack: 0.004, decay: 0.04, sustain: 0.08, release: 0.06, peak: 1 },
    },
    0.13 * p.gain,
  );
  // BODY — organic thud/squelch: broadband, low-ish Q, dull but concentrated enough to
  // dominate the sub thump.
  const bandHz = jitter(g, rr4(p.variant, 380, 440, 500, 560), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.55,
      sweepTime: 0.09,
      q: 1.15,
      env: { attack: 0.005, decay: 0.05, sustain: 0.09, release: 0.08, peak: 1 },
    },
    1.35 * p.gain,
  );
  const edgeHz = jitter(g, rr4(p.variant, 3200, 3400, 3600, 3800), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: edgeHz,
      q: 2.2,
      env: { attack: 0.001, decay: 0.005, sustain: 0, release: 0.009, peak: 1 },
    },
    0.15 * p.gain,
  );
};

/** A ward breaking: a brittle crystalline crack rather than a body-fall. */
const dieWard: CueFn = (g, at, p) => {
  const subHz = jitter(g, rr4(p.variant, SUB.A1, SUB.D1, SUB.D2, SUB.A1), VARY.pitchPct);
  thump(
    g,
    at + layerOffset(g),
    p.dest,
    {
      hz: subHz,
      dropHz: subHz * 0.5,
      dropTime: 0.05,
      env: { attack: 0.003, decay: 0.028, sustain: 0.045, release: 0.045, peak: 1 },
    },
    0.08 * p.gain,
  );
  // BODY — the crack itself, with enough Q to ring like brittle material.
  const bandHz = jitter(g, rr4(p.variant, 520, 580, 650, 720), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: bandHz,
      sweepHz: bandHz * 0.6,
      sweepTime: 0.045,
      q: 2.0,
      env: { attack: 0.002, decay: 0.024, sustain: 0.04, release: 0.055, peak: 1 },
    },
    1.3 * p.gain,
  );
  // TRANSIENT — a thin glassy snap, higher/thinner than an organic death's edge.
  const edgeHz = jitter(g, rr4(p.variant, 5200, 5600, 5900, 6200), VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: edgeHz,
      q: 3.6,
      env: { attack: 0.001, decay: 0.006, sustain: 0, release: 0.011, peak: 1 },
    },
    0.35 * p.gain,
  );
};

// ---------------------------------------------------------------------------
// Registry — `satisfies`, never a type annotation (AUDIO_CONTRACT rule 14). Annotating
// with `CueRegistry` would erase the literal SoundId keys and break `index.ts`'s total
// `Record<SoundId, CueSpec>` merge no matter how complete this registry actually is.
//
// `tail` is the real synthesis end time (max layer end, including any `layerOffset`
// worst case), not a round number — see the hit.self lesson: an under-declared tail gets
// the cue's own release clipped by the harness's duck-release/truncation bookkeeping.
// ---------------------------------------------------------------------------

export const COMBAT_CUES = {
  'atk.hero.melee': {
    fn: atkHeroMelee,
    bus: 'sfx',
    priority: 4,
    tail: 0.14,
    variants: VARY.roundRobin,
    dry: false,
  },
  'atk.hero.ranged': {
    fn: atkHeroRanged,
    bus: 'sfx',
    priority: 4,
    tail: 0.1,
    variants: VARY.roundRobin,
    dry: false,
  },
  'atk.creep.melee': {
    fn: atkCreepMelee,
    bus: 'sfx',
    priority: 5,
    tail: 0.1,
    variants: VARY.roundRobin,
    dry: false,
  },
  'atk.creep.ranged': {
    fn: atkCreepRanged,
    bus: 'sfx',
    priority: 5,
    tail: 0.08,
    variants: VARY.roundRobin,
    dry: false,
  },
  'atk.siege': {
    fn: atkSiege,
    bus: 'sfx',
    priority: 5,
    tail: 0.12,
    variants: VARY.roundRobin,
    dry: false,
  },
  'atk.tower': {
    fn: atkTower,
    bus: 'sfx',
    priority: 5,
    tail: 0.15,
    variants: VARY.roundRobin,
    dry: false,
  },
  'hit.physical': {
    fn: hitPhysical,
    bus: 'sfx',
    priority: 4,
    tail: 0.19,
    variants: VARY.roundRobin,
    dry: false,
  },
  'hit.magic': {
    fn: hitMagic,
    bus: 'sfx',
    priority: 4,
    tail: 0.17,
    variants: VARY.roundRobin,
    dry: false,
  },
  'hit.self': {
    fn: hitSelf,
    bus: 'sfx',
    priority: 3,
    // Real synthesis end: thump 0.005+0.05+0.09=0.145s; noise layer (offset <=0.008s late)
    // 0.008+0.006+0.06+0.09=0.164s. Declared with a small margin.
    tail: 0.18,
    variants: VARY.roundRobin,
    dry: false,
  },
  'hit.crit': {
    fn: hitCrit,
    bus: 'sfx',
    priority: 4,
    tail: 0.15,
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
    tail: 0.65,
    variants: 1,
    dry: false,
  },
  'die.hero.ally': {
    fn: dieHeroAlly,
    bus: 'sfx',
    priority: 4,
    tail: 0.65,
    variants: 1,
    dry: false,
  },
  'die.hero.self': {
    fn: dieHeroSelf,
    bus: 'sfx',
    priority: 2,
    tail: 0.85,
    variants: 1,
    dry: false,
  },
  'die.creep': {
    fn: dieCreep,
    bus: 'sfx',
    priority: 5,
    tail: 0.17,
    variants: VARY.roundRobin,
    dry: false,
  },
  'die.ward': {
    fn: dieWard,
    bus: 'sfx',
    priority: 5,
    tail: 0.14,
    variants: VARY.roundRobin,
    dry: false,
  },
} satisfies CueRegistry;
