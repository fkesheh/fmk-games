/**
 * RIFT AUDIO — cues/ui.ts (T7)
 *
 * The economy and interface `ui.*` cues: 5 economy (`ui.lastHit`, `ui.gold`, `ui.levelUp`,
 * `ui.skillPoint`, `ui.abilityReady`) and 7 interface (`ui.click`, `ui.buy`, `ui.error`,
 * `ui.shopOpen`, `ui.shopClose`, `ui.pick`, `ui.toast`). SONIC_BIBLE §5: UI cues are 1-2
 * layers, bone-dry, `<= 120ms`, except `ui.levelUp` (`<= 700ms`) and `ui.buy` (`<= 250ms`).
 *
 * Per SONIC_BIBLE §3 only SOME of these twelve may carry real `info`-register (> 800 Hz)
 * energy: `ui.lastHit`, `ui.levelUp`, `ui.skillPoint`, `ui.abilityReady`, `ui.buy`,
 * `ui.error`. The rest (`ui.click`, `ui.gold`, `ui.shopOpen`, `ui.shopClose`, `ui.pick`,
 * `ui.toast`) are deliberately kept under the info floor — every pitch they use comes
 * from `PALETTE.mid`/`PALETTE.high`, both of which top out under 800 Hz — so the info
 * register keeps its single meaning: something economically important just happened.
 *
 * `ui.lastHit` is the Dota gold chime and the most important cue in this module — see its
 * comment below for exactly how it is built to cut a full teamfight.
 */

import type { CueFn, CueGraph, CuePlay, CueRegistry } from '../contract.js';
import { db, degree, jitter, jitterDb, metal, noise, shimmer, swell, thump, tone } from '../dsp.js';
import { INTERVAL, METAL_RATIOS, PALETTE, VARY } from '../config.js';

// ---------------------------------------------------------------------------
// Small shared helpers (local to this module — no module-level mutable state)
// ---------------------------------------------------------------------------

/**
 * Deterministic round-robin pick from a non-empty literal tuple. `options[0]` is typed
 * `T`, not `T | undefined`, because tuple element 0 of a `[T, ...T[]]` is a fixed index,
 * which `noUncheckedIndexedAccess` does not widen — unlike a dynamic array index. Safe
 * without a non-null assertion.
 */
function pick<T>(options: readonly [T, ...T[]], variant: number): T {
  const idx = ((variant % options.length) + options.length) % options.length;
  return options[idx] ?? options[0];
}

/**
 * Per-cue design level: the cue's own dB target, the engine's per-cue trim (`p.gain`,
 * always 1 today but the contracted field to multiply), seeded level jitter per `VARY`,
 * and a small honouring of `p.intensity` (0 by default for every `ui.*` play site today,
 * so this is a no-op multiplier of 1 in current routing — but every `CueFn` must honour
 * `p.intensity`, not silently drop it, so a future intensity-bearing UI play degrades
 * gracefully instead of being ignored).
 */
function level(g: CueGraph, p: CuePlay, designDb: number): number {
  return p.gain * db(designDb) * jitterDb(g, VARY.levelDb) * (1 + p.intensity * 0.1);
}

/** A quiet, quick, non-info envelope shared by the small percussive UI transients. */
function quickEnv(peak: number, releaseS: number): {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  peak: number;
} {
  return { attack: 0.002, decay: 0.015, sustain: 0.05, release: releaseS, peak };
}

// ---------------------------------------------------------------------------
// ui.click — an iron click on press. Dark, tiny, non-info. Fires constantly.
// ---------------------------------------------------------------------------

const CLICK_HZ = [PALETTE.mid.A3, PALETTE.low.D3, PALETTE.mid.D3] as const;

const clickCue: CueFn = (g, at, p) => {
  const baseHz = pick(CLICK_HZ, p.variant);
  const hz = jitter(g, baseHz, VARY.pitchPct);
  metal(
    g,
    at,
    p.dest,
    {
      ratios: METAL_RATIOS.slice(0, 4),
      hz,
      bandHz: jitter(g, hz * 2.4, VARY.timbrePct),
      q: 6,
      env: quickEnv(0.75, 0.018),
    },
    level(g, p, -9),
  );
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: jitter(g, PALETTE.high.D5, VARY.timbrePct),
      q: 3,
      env: { attack: 0.0004, decay: 0.006, sustain: 0, release: 0.006, peak: 0.5 },
    },
    level(g, p, -16),
  );
};

// ---------------------------------------------------------------------------
// ui.buy — the two-tick "cha-chime". Info-legit (purchase confirm). Distinct from
// ui.lastHit by direction (descending, not ascending), timbre (metal coin clink, not an
// arcane shimmer) and a slightly longer, rounder second tick.
// ---------------------------------------------------------------------------

const buyCue: CueFn = (g, at, p) => {
  const brighten = p.variant % 2 === 1;
  const hzHi = jitter(g, PALETTE.info.D6, VARY.pitchPct);
  const hzLo = jitter(g, PALETTE.info.A5, VARY.pitchPct);

  tone(
    g,
    at,
    p.dest,
    {
      type: brighten ? 'sawtooth' : 'triangle',
      hz: hzHi,
      env: quickEnv(0.6, 0.03),
    },
    level(g, p, -12),
  );
  tone(
    g,
    at + 0.06,
    p.dest,
    {
      type: 'triangle',
      hz: hzLo,
      env: { attack: 0.003, decay: 0.03, sustain: 0.15, release: 0.06, peak: 0.6 },
    },
    level(g, p, -11),
  );
  metal(
    g,
    at + 0.06,
    p.dest,
    {
      ratios: METAL_RATIOS.slice(0, 3),
      hz: jitter(g, PALETTE.mid.D4, VARY.timbrePct),
      bandHz: PALETTE.info.A5,
      q: 4,
      env: { attack: 0.001, decay: 0.05, sustain: 0.05, release: 0.08, peak: 0.35 },
    },
    level(g, p, -18),
  );
};

// ---------------------------------------------------------------------------
// ui.error — the dry denial thud. Info-legit per the contract, but SONIC_BIBLE §11
// (accessibility) demands it read as "no", not an alarm: kept low and soft-edged, no
// bright transient, a muted minor-second dyad against the root for mild dissonance
// without harshness.
// ---------------------------------------------------------------------------

const ERROR_HZ = [PALETTE.low.A2, PALETTE.low.D2] as const;

const errorCue: CueFn = (g, at, p) => {
  const rootHz = jitter(g, pick(ERROR_HZ, p.variant), VARY.pitchPct);
  thump(
    g,
    at,
    p.dest,
    {
      hz: rootHz,
      dropHz: rootHz * 0.6,
      dropTime: 0.05,
      env: { attack: 0.002, decay: 0.03, sustain: 0.1, release: 0.05, peak: 0.7 },
    },
    level(g, p, -8),
  );
  // A muted minor-second dyad (INTERVAL.enemy[1]) reads as "wrong" without being an
  // alarm — soft triangle, no attack transient, well under the info floor. `?? 1` never
  // actually triggers: INTERVAL.enemy is a frozen 3-element literal (config.ts) and index
  // 1 always exists; the fallback only satisfies noUncheckedIndexedAccess.
  const enemySecond = INTERVAL.enemy[1] ?? 1;
  tone(
    g,
    at,
    p.dest,
    {
      type: 'triangle',
      hz: rootHz * enemySecond,
      env: { attack: 0.01, decay: 0.04, sustain: 0.1, release: 0.05, peak: 0.3 },
    },
    level(g, p, -14),
  );
};

// ---------------------------------------------------------------------------
// ui.shopOpen / ui.shopClose — leather-and-iron: a noise rustle plus a low metal click.
// Non-info. Opening sweeps the rustle up, closing sweeps it down, sharing everything else
// so the pair reads as one object (the shop) rather than two unrelated sounds.
// ---------------------------------------------------------------------------

function shopRustle(g: CueGraph, at: number, p: CuePlay, opening: boolean): void {
  const fromHz = jitter(g, opening ? PALETTE.mid.D3 : PALETTE.high.F4, VARY.timbrePct);
  const toHz = jitter(g, opening ? PALETTE.high.F4 : PALETTE.mid.D3, VARY.timbrePct);
  noise(
    g,
    at,
    p.dest,
    {
      filter: 'bandpass',
      hz: fromHz,
      sweepHz: toHz,
      sweepTime: 0.09,
      q: 1.2,
      env: { attack: 0.006, decay: 0.05, sustain: 0.1, release: 0.04, peak: 0.5 },
    },
    level(g, p, -13),
  );
  const clickAt = opening ? at : at + 0.07;
  metal(
    g,
    clickAt,
    p.dest,
    {
      ratios: METAL_RATIOS.slice(0, 3),
      hz: jitter(g, PALETTE.low.A2, VARY.timbrePct),
      bandHz: PALETTE.mid.A3,
      q: 4,
      env: quickEnv(0.55, 0.03),
    },
    level(g, p, -12),
  );
}

const shopOpenCue: CueFn = (g, at, p) => shopRustle(g, at, p, true);
const shopCloseCue: CueFn = (g, at, p) => shopRustle(g, at, p, false);

// ---------------------------------------------------------------------------
// ui.pick — a confirm stab on hero select. Non-info. Built from INTERVAL.ally (root +
// fifth) so a hero pick reads as consonant/settled per SONIC_BIBLE §3, independent of team
// colour which is not yet known at pick time.
// ---------------------------------------------------------------------------

const pickCue: CueFn = (g, at, p) => {
  const rootHz = jitter(g, PALETTE.mid.D3, VARY.pitchPct);
  const brighten = p.variant % 2 === 1;
  // `?? 1` never actually triggers: INTERVAL.ally is a frozen 3-element literal
  // (config.ts) and index 1 always exists; the fallback only satisfies
  // noUncheckedIndexedAccess, same pattern as dsp.ts's `degree()`.
  const allyFifth = INTERVAL.ally[1] ?? 1;
  tone(
    g,
    at,
    p.dest,
    {
      type: brighten ? 'triangle' : 'sine',
      hz: rootHz,
      env: { attack: 0.003, decay: 0.03, sustain: 0.2, release: 0.05, peak: 0.6 },
    },
    level(g, p, -10),
  );
  tone(
    g,
    at + 0.01,
    p.dest,
    {
      type: brighten ? 'triangle' : 'sine',
      hz: rootHz * allyFifth,
      env: { attack: 0.003, decay: 0.035, sustain: 0.2, release: 0.06, peak: 0.55 },
    },
    level(g, p, -11),
  );
};

// ---------------------------------------------------------------------------
// ui.toast — the "blocked cast" note. Non-info: a short rising glide that stays inside
// PALETTE.high (all four entries sit under the 800 Hz floor).
// ---------------------------------------------------------------------------

const toastCue: CueFn = (g, at, p) => {
  const from = jitter(g, PALETTE.high.A4, VARY.pitchPct);
  const to = jitter(g, PALETTE.high.D5, VARY.pitchPct);
  tone(
    g,
    at,
    p.dest,
    {
      type: 'triangle',
      hz: from,
      glideHz: to,
      glideTime: 0.045,
      env: { attack: 0.004, decay: 0.02, sustain: 0.15, release: 0.045, peak: 0.55 },
    },
    level(g, p, -11),
  );
  if (p.variant % 2 === 1) {
    noise(
      g,
      at,
      p.dest,
      {
        filter: 'highpass',
        hz: PALETTE.high.F5,
        q: 1,
        env: { attack: 0.001, decay: 0.008, sustain: 0, release: 0.008, peak: 0.25 },
      },
      level(g, p, -18),
    );
  }
};

// ---------------------------------------------------------------------------
// ui.lastHit — THE cue. The Dota gold chime. Two ticks (A5 -> D6) plus a coin shimmer,
// total < 180 ms, priority 2 (ducks the bed like any self-critical cue).
//
// HOW IT CUTS THROUGH A TEAMFIGHT:
//   1. Spectral placement: both ticks use a SAWTOOTH oscillator, not a sine. A sawtooth's
//      harmonic series is unbroken (1x, 2x, 3x, 4x...), so a fundamental anchored in the
//      `info` register throws real energy up into 2-4 kHz for free, from the SAME
//      PALETTE-derived pitch — no invented frequency literal needed. A5 (880 Hz): 3rd
//      harmonic 2640 Hz, 4th 3520 Hz. D6 (1174.66 Hz): 2nd harmonic 2349 Hz, 3rd 3524 Hz.
///     That 2-4 kHz band is EXACTLY the band the physical damage school is capped at
//      2 kHz to keep clear (SONIC_BIBLE §3) — nothing else in the game competes there.
//   2. Transient sharpness: attack is 2 ms, decay 12 ms — the ear locates a sharp
//      transient even under a dense bed; a slow attack would be masked before it registers.
//   3. Priority 2 means this cue ducks music AND ambience by DUCK.bedDb the instant it
//      fires, on top of the spectral headroom the physical-school cap already buys it.
//   4. The coin shimmer is a genuine ring-mod (carrier F6, mod F3) layered UNDER the two
//      ticks, not competing with their transients, adding a felt "sparkle" tail without
//      pushing the total past 180 ms.
// ---------------------------------------------------------------------------

interface LastHitLayout {
  readonly first: OscillatorType;
  readonly second: OscillatorType;
}

const LAST_HIT_LAYOUT: readonly [LastHitLayout, LastHitLayout, LastHitLayout] = [
  { first: 'sawtooth', second: 'sawtooth' },
  { first: 'sawtooth', second: 'square' },
  { first: 'square', second: 'sawtooth' },
];

const lastHitCue: CueFn = (g, at, p) => {
  const layout = pick(LAST_HIT_LAYOUT, p.variant);
  const tick1Hz = jitter(g, PALETTE.info.A5, VARY.pitchPct);
  const tick2Hz = jitter(g, PALETTE.info.D6, VARY.pitchPct);
  const tick2At = at + 0.05;

  // Tick 1 — the attack. Sharp, harmonic-rich, anchors the low end of the info register.
  tone(
    g,
    at,
    p.dest,
    {
      type: layout.first,
      hz: tick1Hz,
      env: { attack: 0.002, decay: 0.012, sustain: 0.15, release: 0.02, peak: 0.85 },
    },
    level(g, p, -6),
  );
  // Tick 2 — the resolution, a step up. Its 2nd/3rd harmonics land squarely in 2-4 kHz.
  tone(
    g,
    tick2At,
    p.dest,
    {
      type: layout.second,
      hz: tick2Hz,
      env: { attack: 0.002, decay: 0.014, sustain: 0.12, release: 0.03, peak: 0.8 },
    },
    level(g, p, -6.5),
  );
  // Coin shimmer — a short ring-mod tail glued under both ticks. Carrier F6, modulator
  // F3 (both PALETTE pitches), so the sidebands (carrier +/- mod) also land near 1.2-1.6
  // kHz while the carrier's own upper content extends toward the tail filter ceiling.
  shimmer(
    g,
    at + 0.01,
    p.dest,
    {
      hz: jitter(g, PALETTE.info.F6, VARY.pitchPct),
      modHz: jitter(g, PALETTE.mid.F3, VARY.timbrePct),
      index: 0.4,
      tailHz: degree(PALETTE.rootHz, 0, 5), // ~D7, keeps the tail's ceiling in-register
      env: { attack: 0.004, decay: 0.03, sustain: 0.08, release: 0.06, peak: 0.35 },
    },
    level(g, p, -13),
  );
};

// ---------------------------------------------------------------------------
// ui.gold — the non-last-hit grant (hero bounties). Deliberately NOT the chime: warmer,
// rounder, non-info. Overloading ui.lastHit would destroy its meaning (SONIC_BIBLE §10).
// ---------------------------------------------------------------------------

const goldCue: CueFn = (g, at, p) => {
  const from = jitter(g, PALETTE.mid.A3, VARY.pitchPct);
  const to = jitter(g, PALETTE.mid.D4, VARY.pitchPct);
  tone(
    g,
    at,
    p.dest,
    {
      type: 'triangle',
      hz: from,
      glideHz: to,
      glideTime: 0.05,
      env: { attack: 0.03, decay: 0.04, sustain: 0.3, release: 0.05, peak: 0.65 },
    },
    level(g, p, -9),
  );
  thump(
    g,
    at,
    p.dest,
    {
      hz: PALETTE.low.A2,
      dropHz: PALETTE.sub.A1,
      dropTime: 0.06,
      env: { attack: 0.02, decay: 0.05, sustain: 0.2, release: 0.06, peak: 0.4 },
    },
    level(g, p, -14),
  );
};

// ---------------------------------------------------------------------------
// ui.levelUp — a rising D-minor triad in the info register (A5 -> D6 -> F6) plus a swell
// underneath. The one exception at <= 700ms. priority 2.
// ---------------------------------------------------------------------------

const LEVEL_UP_NOTES = [PALETTE.info.A5, PALETTE.info.D6, PALETTE.info.F6] as const;

const levelUpCue: CueFn = (g, at, p) => {
  const stepS = 0.09;
  for (let i = 0; i < LEVEL_UP_NOTES.length; i++) {
    const noteHz = jitter(g, LEVEL_UP_NOTES[i] ?? PALETTE.info.A5, VARY.pitchPct);
    tone(
      g,
      at + i * stepS,
      p.dest,
      {
        type: 'triangle',
        hz: noteHz,
        env: { attack: 0.006, decay: 0.05, sustain: 0.3, release: 0.16, peak: 0.6 - i * 0.05 },
      },
      level(g, p, -8),
    );
  }
  // A soft swell underneath, opening its filter across the whole phrase — the "something
  // has grown" body under the bright triad.
  swell(
    g,
    at,
    p.dest,
    {
      type: 'triangle',
      hz: PALETTE.mid.D4,
      voices: 3,
      spreadCents: 10,
      openHz: PALETTE.mid.A3,
      sweepHz: PALETTE.high.D5,
      sweepTime: 0.5,
      env: { attack: 0.08, decay: 0.15, sustain: 0.3, release: 0.35, peak: 0.4 },
    },
    level(g, p, -12),
  );
};

// ---------------------------------------------------------------------------
// ui.skillPoint — fires once per skill point. A single bright info tick, distinct from
// ui.abilityReady (which is deliberately soft) by being the louder, crisper of the two.
// ---------------------------------------------------------------------------

const skillPointCue: CueFn = (g, at, p) => {
  const hz = jitter(g, PALETTE.info.F6, VARY.pitchPct);
  tone(
    g,
    at,
    p.dest,
    {
      type: p.variant % 2 === 1 ? 'sawtooth' : 'triangle',
      hz,
      env: { attack: 0.003, decay: 0.02, sustain: 0.2, release: 0.05, peak: 0.65 },
    },
    level(g, p, -9),
  );
  shimmer(
    g,
    at,
    p.dest,
    {
      hz: jitter(g, PALETTE.info.A6, VARY.pitchPct),
      modHz: jitter(g, PALETTE.mid.A3, VARY.timbrePct),
      index: 0.25,
      tailHz: degree(PALETTE.rootHz, 0, 5),
      env: { attack: 0.004, decay: 0.02, sustain: 0.05, release: 0.05, peak: 0.2 },
    },
    level(g, p, -17),
  );
};

// ---------------------------------------------------------------------------
// ui.abilityReady — a soft info tick, deliberately near the threshold of notice.
// ---------------------------------------------------------------------------

const abilityReadyCue: CueFn = (g, at, p) => {
  const hz = jitter(g, PALETTE.info.A5, VARY.pitchPct);
  tone(
    g,
    at,
    p.dest,
    {
      type: 'sine',
      hz,
      env: { attack: 0.008, decay: 0.03, sustain: 0.1, release: 0.04, peak: 0.35 },
    },
    level(g, p, p.variant % 2 === 1 ? -15 : -13),
  );
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const UI_CUES = {
  'ui.click': {
    fn: clickCue,
    bus: 'ui',
    priority: 3,
    tail: 0.05,
    variants: 3,
    dry: true,
  },
  'ui.buy': {
    fn: buyCue,
    bus: 'ui',
    priority: 3,
    tail: 0.22,
    variants: 2,
    dry: true,
  },
  'ui.error': {
    fn: errorCue,
    bus: 'ui',
    priority: 3,
    tail: 0.1,
    variants: 2,
    dry: true,
  },
  'ui.shopOpen': {
    fn: shopOpenCue,
    bus: 'ui',
    priority: 3,
    tail: 0.11,
    variants: 1,
    dry: true,
  },
  'ui.shopClose': {
    fn: shopCloseCue,
    bus: 'ui',
    priority: 3,
    tail: 0.11,
    variants: 1,
    dry: true,
  },
  'ui.pick': {
    fn: pickCue,
    bus: 'ui',
    priority: 3,
    tail: 0.08,
    variants: 2,
    dry: true,
  },
  'ui.toast': {
    fn: toastCue,
    bus: 'ui',
    priority: 3,
    tail: 0.09,
    variants: 2,
    dry: true,
  },
  'ui.lastHit': {
    fn: lastHitCue,
    bus: 'ui',
    priority: 2,
    tail: 0.16,
    variants: 3,
    dry: true,
  },
  'ui.gold': {
    fn: goldCue,
    bus: 'ui',
    priority: 3,
    tail: 0.11,
    variants: 2,
    dry: true,
  },
  'ui.levelUp': {
    fn: levelUpCue,
    bus: 'ui',
    priority: 2,
    tail: 0.65,
    variants: 1,
    dry: true,
  },
  'ui.skillPoint': {
    fn: skillPointCue,
    bus: 'ui',
    priority: 3,
    tail: 0.09,
    variants: 1,
    dry: true,
  },
  'ui.abilityReady': {
    fn: abilityReadyCue,
    bus: 'ui',
    priority: 3,
    tail: 0.07,
    variants: 2,
    dry: true,
  },
} satisfies CueRegistry;
