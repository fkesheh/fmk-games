/**
 * RIFT AUDIO — cues/objectives.ts (T6)
 *
 * The `obj.*` and `ann.*` cues: towers, guard, the ancient, the surge, the ancient-under-
 * attack klaxon, respawn/countdown/match-start, and the four announcer stings. These are
 * the biggest, rarest, most consequential sounds in the game — SONIC_BIBLE §5 calls the
 * ancient's death "the biggest sound in the game", and §9's Dota-2 benchmark is measured
 * mechanically on the structure-death cues: real, dominant sub-bass, not midrange crunch.
 *
 * Collapse anatomy for `obj.tower`/`obj.guard`/`obj.ancient` (SONIC_BIBLE §4-5):
 *   sub drop (thump) -> low swell underneath -> metal stress layer -> collapsing noise
 *   sweep -> debris tail (repeated seeded grains) -> a quiet allegiance-identity chord.
 * The sub layers (thump + swell) carry the design weight; the metal/noise/debris layers
 * are deliberately lower-gain and get filtered toward the sub band as they decay, so the
 * required "≥35% / ≥45% of energy below 120 Hz" (AUDIO_CONTRACT.md T6) is a property of
 * the mix, not a coincidence.
 *
 * Allegiance colour (SONIC_BIBLE §3 + §11): `CuePlay.intensity` is repurposed by this
 * module, for the three structure cues only, as the friendly/enemy flag — see
 * `allegianceRatios` below for why and for the flagged integration risk.
 *
 * `ann.*` are the one family explicitly permitted to occupy the reserved `info` register
 * (AUDIO_CONTRACT.md rule 10, SONIC_BIBLE §3): they are bone-dry, `bus: 'announcer'`,
 * `priority: 0`, and lean on `PALETTE.info` plus bright shimmer tails so they cut through
 * a full teamfight.
 */

import type { CueFn, CueGraph, CuePlay, CueRegistry } from '../contract.js';
import { degree, jitter, jitterDb, metal, noise, shimmer, swell, thump, tone } from '../dsp.js';
import { INTERVAL, METAL_RATIOS, PALETTE, VARY } from '../config.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Safe read of a fixed interval/ratio table under `noUncheckedIndexedAccess`. */
function ratioAt(arr: readonly number[], i: number): number {
  return arr[i] ?? 1;
}

/**
 * Team-allegiance interval for a structure fall (SONIC_BIBLE §3: allegiance is carried by
 * INTERVAL, never by loudness or pitch height alone). `CueFn`'s signature is fixed at
 * `(g, at, p)` and `PlayOptions`/`AudioEvent.structure` carry no dedicated friendly field
 * reaching the cue, so this module repurposes `CuePlay.intensity` — the one free per-play
 * channel the contract exposes — as that flag: `>= 0.5` means the LOCAL team's own
 * structure fell (bad news -> `INTERVAL.enemy`, tense); `< 0.5`, including the default
 * `0` an omitted `PlayOptions.intensity` resolves to, means an enemy structure fell (good
 * news -> `INTERVAL.ally`, consonant). Flagged as an integration risk: the
 * AUDIO_CONTRACT.md T9 routing table's `structure` row currently reads
 * `{x, z, priority: 1}` with no intensity, so today every structure fall renders with the
 * default (ally/consonant) colour until index.ts is wired to pass
 * `intensity: friendly ? 1 : 0`.
 */
function allegianceRatios(intensity: number): readonly number[] {
  return intensity >= 0.5 ? INTERVAL.enemy : INTERVAL.ally;
}

/**
 * A layer's absolute schedule time: `at + offset`, jittered by up to `VARY.timingS`, but
 * NEVER earlier than `at` itself. `AudioParam` scheduling (`setValueAtTime` and friends)
 * throws a `RangeError` for a negative absolute time. In live play `at` is normally
 * seconds into the match, so a stray -8ms jitter on a zero-offset layer is invisible; but
 * the render harness's isolated single-cue render always starts at `ctx.currentTime ===
 * 0`, and `g.rnd()` is seeded, so a layer with no positive offset ahead of `at` (e.g. the
 * first blast of a repeated cue) can deterministically draw a negative jitter EVERY run.
 * That throw propagates out of the whole synchronous `CueFn` and `engine.ts`'s per-cue
 * try/catch swallows it silently by contract ("a cue that fails must not break the
 * frame") — the confirmed root cause of `obj.klaxon` rendering complete digital silence.
 * Every layer in this module that schedules at or near `at` goes through this instead of
 * a bare jitter.
 */
function jitteredAt(g: CueGraph, at: number, offset = 0): number {
  return Math.max(at, at + offset + (g.rnd() * 2 - 1) * VARY.timingS);
}

interface CollapseCfg {
  readonly subHz: number;
  readonly subDropHz: number;
  readonly subDropTime: number;
  readonly extraSub?: { readonly hz: number; readonly dropHz: number; readonly dropTime: number };
  readonly swellHz: number;
  readonly metalHz: number;
  readonly metalBandHz: number;
  readonly noiseStartHz: number;
  readonly noiseEndHz: number;
  readonly debrisCount: number;
  readonly identityHz: number;
  readonly duckLevel: number;
  readonly tailS: number;
}

/** The shared collapse builder behind `obj.tower` / `obj.guard` / `obj.ancient`. */
function structureCollapse(g: CueGraph, at: number, p: CuePlay, cfg: CollapseCfg): void {
  const dest = p.dest;
  const level = p.gain * cfg.duckLevel;

  // 1) The sub drop — the weight archetype, dominant low-end, fires right on the beat.
  thump(
    g,
    at,
    dest,
    {
      hz: jitter(g, cfg.subHz, VARY.pitchPct),
      dropHz: cfg.subDropHz,
      dropTime: cfg.subDropTime,
      env: {
        attack: 0.006,
        decay: cfg.subDropTime * 0.6,
        sustain: 0.55,
        release: cfg.tailS * 0.55,
        peak: 1.0,
      },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  // 1b) Ancient only: a second, deeper sub layer — the extra margin that clears the
  // stricter 45% "energy below 120 Hz" target without touching the tower/guard mix.
  if (cfg.extraSub) {
    thump(
      g,
      jitteredAt(g, at),
      dest,
      {
        hz: jitter(g, cfg.extraSub.hz, VARY.pitchPct),
        dropHz: cfg.extraSub.dropHz,
        dropTime: cfg.extraSub.dropTime,
        env: {
          attack: 0.01,
          decay: cfg.extraSub.dropTime * 0.7,
          sustain: 0.6,
          release: cfg.tailS * 0.6,
          peak: 0.85,
        },
      },
      level * jitterDb(g, VARY.levelDb),
    );
  }

  // 2) Low swell underneath — sustains the sub energy through the whole tail.
  swell(
    g,
    at + 0.02,
    dest,
    {
      type: 'sine',
      hz: jitter(g, cfg.swellHz, VARY.pitchPct),
      voices: 3,
      spreadCents: jitter(g, 6, VARY.timbrePct),
      openHz: 220,
      sweepHz: 55,
      sweepTime: cfg.tailS,
      env: { attack: 0.12, decay: 0.3, sustain: 0.7, release: cfg.tailS * 0.75, peak: 0.85 },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  // 3) Metal stress layer — the structure groaning before it gives, then settling.
  metal(
    g,
    jitteredAt(g, at),
    dest,
    {
      ratios: METAL_RATIOS.slice(0, 5),
      hz: jitter(g, cfg.metalHz, VARY.timbrePct),
      bandHz: cfg.metalBandHz,
      q: 3.2,
      filterHz: cfg.metalBandHz * 2,
      sweepHz: cfg.metalBandHz * 0.35,
      sweepTime: cfg.tailS * 0.6,
      env: { attack: 0.01, decay: 0.18, sustain: 0.25, release: cfg.tailS * 0.4, peak: 0.5 },
    },
    level * 0.6 * jitterDb(g, VARY.levelDb),
  );

  // 4) Collapsing noise sweep — masonry giving way, filtered down into the sub band by
  // the time it decays, so its tail reinforces the low-end energy target rather than
  // fighting it.
  noise(
    g,
    jitteredAt(g, at, 0.03),
    dest,
    {
      filter: 'lowpass',
      hz: cfg.noiseStartHz,
      sweepHz: cfg.noiseEndHz,
      sweepTime: cfg.tailS * 0.85,
      q: 0.9,
      env: { attack: 0.02, decay: cfg.tailS * 0.3, sustain: 0.4, release: cfg.tailS * 0.6, peak: 0.55 },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  // 5) Debris tail — repeated short seeded grains over the back half of the collapse.
  // T0's noise() loops the shared 1s buffer, so this is bounded only by each grain's own
  // envelope, never the buffer length.
  const debrisSpan = cfg.tailS * 0.55;
  for (let i = 0; i < cfg.debrisCount; i++) {
    const frac = cfg.debrisCount > 1 ? i / (cfg.debrisCount - 1) : 0;
    const t0 = jitteredAt(g, at, cfg.tailS * 0.3 + frac * debrisSpan);
    noise(
      g,
      t0,
      dest,
      {
        filter: 'bandpass',
        hz: jitter(g, cfg.metalBandHz * (0.35 + frac * 0.25), VARY.timbrePct),
        q: 1.4,
        env: { attack: 0.002, decay: 0.05, sustain: 0.05, release: 0.09, peak: 0.35 },
      },
      level * 0.4 * jitterDb(g, VARY.levelDb),
    );
  }

  // 6) Identity chord — the allegiance colour, quiet and low-register so it never
  // threatens the sub-energy target, just enough to be felt as consonant or tense.
  const ratios = allegianceRatios(p.intensity);
  for (const r of ratios) {
    tone(
      g,
      jitteredAt(g, at, 0.05),
      dest,
      {
        type: 'triangle',
        hz: cfg.identityHz * r,
        env: { attack: 0.02, decay: 0.4, sustain: 0.2, release: cfg.tailS * 0.5, peak: 0.18 },
        filterHz: 900,
        sweepHz: 300,
        sweepTime: cfg.tailS * 0.7,
      },
      level * 0.5 * jitterDb(g, VARY.levelDb),
    );
  }
}

const OBJ_TOWER: CueFn = (g, at, p) => {
  structureCollapse(g, at, p, {
    subHz: PALETTE.low.D2,
    subDropHz: PALETTE.sub.D1,
    subDropTime: 0.45,
    swellHz: PALETTE.sub.A1,
    metalHz: PALETTE.mid.D3,
    metalBandHz: 420,
    noiseStartHz: 1800,
    noiseEndHz: 90,
    debrisCount: 5,
    identityHz: PALETTE.low.D3,
    duckLevel: 0.9,
    tailS: 2.0,
  });
};

const OBJ_GUARD: CueFn = (g, at, p) => {
  structureCollapse(g, at, p, {
    subHz: PALETTE.low.F2,
    subDropHz: PALETTE.sub.A1,
    subDropTime: 0.4,
    swellHz: PALETTE.sub.D2,
    metalHz: PALETTE.mid.F3,
    metalBandHz: 520,
    noiseStartHz: 2000,
    noiseEndHz: 100,
    debrisCount: 4,
    identityHz: PALETTE.low.A2,
    duckLevel: 0.85,
    tailS: 1.7,
  });
};

const OBJ_ANCIENT: CueFn = (g, at, p) => {
  structureCollapse(g, at, p, {
    subHz: PALETTE.sub.A1,
    subDropHz: PALETTE.sub.D1,
    subDropTime: 0.6,
    extraSub: { hz: PALETTE.sub.D1, dropHz: degree(PALETTE.rootHz, 0, -2), dropTime: 0.9 },
    swellHz: PALETTE.sub.D1,
    metalHz: PALETTE.mid.D3,
    metalBandHz: 340,
    noiseStartHz: 2400,
    noiseEndHz: 70,
    debrisCount: 7,
    identityHz: PALETTE.low.D2,
    duckLevel: 1.0,
    tailS: 2.8,
  });
};

/** Own ancient under attack: a repeated warning blast in `INTERVAL.enemy` — always tense. */
const OBJ_KLAXON: CueFn = (g, at, p) => {
  const dest = p.dest;
  const blastGap = 0.52;
  const tritone = ratioAt(INTERVAL.enemy, 2);
  const minorSecond = ratioAt(INTERVAL.enemy, 1);

  for (let i = 0; i < 3; i++) {
    const t0 = jitteredAt(g, at, i * blastGap);
    const hz = jitter(g, PALETTE.mid.D3, VARY.pitchPct);

    tone(
      g,
      t0,
      dest,
      {
        type: 'sawtooth',
        hz,
        glideHz: hz * tritone,
        glideTime: 0.14,
        detune: (g.rnd() * 2 - 1) * 8,
        filterHz: 1400,
        sweepHz: 700,
        sweepTime: 0.32,
        env: { attack: 0.008, decay: 0.05, sustain: 0.55, release: 0.22, peak: 0.8 },
      },
      p.gain * jitterDb(g, VARY.levelDb),
    );

    metal(
      g,
      t0,
      dest,
      {
        ratios: METAL_RATIOS.slice(0, 4),
        hz: hz * minorSecond,
        bandHz: 900,
        q: 4,
        env: { attack: 0.004, decay: 0.06, sustain: 0.2, release: 0.15, peak: 0.35 },
      },
      p.gain * 0.5 * jitterDb(g, VARY.levelDb),
    );
  }
};

/** A power surge: rising empowerment swell resolving into a consonant flourish. */
const OBJ_SURGE: CueFn = (g, at, p) => {
  const dest = p.dest;
  const level = p.gain;

  thump(
    g,
    at,
    dest,
    {
      hz: jitter(g, PALETTE.low.A2, VARY.pitchPct),
      dropHz: PALETTE.sub.A1,
      dropTime: 0.24,
      env: { attack: 0.006, decay: 0.14, sustain: 0.4, release: 0.5, peak: 0.8 },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  swell(
    g,
    at,
    dest,
    {
      type: 'sawtooth',
      hz: jitter(g, PALETTE.sub.A1, VARY.pitchPct),
      voices: 4,
      spreadCents: 14,
      openHz: 300,
      sweepHz: 2200,
      sweepTime: 1.0,
      env: { attack: 0.5, decay: 0.25, sustain: 0.6, release: 0.55, peak: 0.75 },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  for (const r of INTERVAL.ally) {
    tone(
      g,
      jitteredAt(g, at, 0.85),
      dest,
      {
        type: 'triangle',
        hz: PALETTE.mid.A3 * r,
        env: { attack: 0.015, decay: 0.2, sustain: 0.3, release: 0.4, peak: 0.3 },
        filterHz: 2400,
        sweepHz: 1000,
        sweepTime: 0.5,
      },
      level * 0.6 * jitterDb(g, VARY.levelDb),
    );
  }
};

/** Death-cam filter opens back up: a rising sweep plus a fountain-flavoured sub hum. */
const OBJ_RESPAWN: CueFn = (g, at, p) => {
  const dest = p.dest;
  const level = p.gain;

  swell(
    g,
    at,
    dest,
    {
      type: 'triangle',
      hz: jitter(g, PALETTE.sub.A1, VARY.pitchPct),
      voices: 2,
      spreadCents: 5,
      openHz: 150,
      sweepHz: 1600,
      sweepTime: 0.9,
      env: { attack: 0.35, decay: 0.2, sustain: 0.55, release: 0.5, peak: 0.7 },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  noise(
    g,
    at + 0.05,
    dest,
    {
      filter: 'highpass',
      hz: 200,
      sweepHz: 1400,
      sweepTime: 0.6,
      q: 0.7,
      env: { attack: 0.05, decay: 0.25, sustain: 0.2, release: 0.4, peak: 0.3 },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  tone(
    g,
    at + 0.1,
    dest,
    {
      type: 'sine',
      hz: jitter(g, PALETTE.sub.A1, VARY.pitchPct),
      env: { attack: 0.4, decay: 0.3, sustain: 0.7, release: 0.6, peak: 0.5 },
    },
    level * 0.6 * jitterDb(g, VARY.levelDb),
  );
};

/**
 * A once-per-second tick, fired for both the lobby start countdown and the respawn timer;
 * no internal loop. NOT an `info`-register cue (it dropped that first attempt: a 3 kHz
 * highpass click measured 100% of its energy above `INFO_FLOOR_HZ` against an 8% budget —
 * `obj.*` is not licensed for that band the way `ui.*`/`ann.*` are). It still needs to stay
 * clearly distinguishable from `ui.abilityReady`'s bare `PALETTE.info.A5` sine, so the
 * differentiation now lives entirely below the info floor instead: a mid-register
 * (`PALETTE.mid.A3`, an octave-plus below `abilityReady`'s pitch) triangle tick with a
 * harder attack, plus a short low bandpassed noise knock for a mechanical "clock tick"
 * body that a soft single sine has none of.
 *
 * Genuinely non-positional: fired via `RiftAudioHandle.countdown(secondsLeft)` with no
 * world position (same as `hit.heartbeat`'s low-HP timer), so `dry: true` here is by
 * design, not an oversight — see the registry note on the stereo-correlation assertion.
 */
const OBJ_COUNTDOWN: CueFn = (g, at, p) => {
  const dest = p.dest;
  const level = p.gain;

  tone(
    g,
    at,
    dest,
    {
      type: 'triangle',
      hz: jitter(g, PALETTE.mid.A3, VARY.pitchPct),
      env: { attack: 0.002, decay: 0.03, sustain: 0.1, release: 0.05, peak: 0.5 },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  noise(
    g,
    at,
    dest,
    {
      filter: 'bandpass',
      hz: 380,
      q: 2.2,
      env: { attack: 0.001, decay: 0.015, sustain: 0.02, release: 0.025, peak: 0.3 },
    },
    level * jitterDb(g, VARY.levelDb),
  );
};

/** The horn in D. */
const OBJ_MATCH_START: CueFn = (g, at, p) => {
  const dest = p.dest;
  const level = p.gain;

  tone(
    g,
    at,
    dest,
    {
      type: 'sawtooth',
      hz: jitter(g, PALETTE.low.D2, VARY.pitchPct),
      detune: -6,
      env: { attack: 0.05, decay: 0.2, sustain: 0.75, release: 0.9, peak: 0.85 },
      filterHz: 3200,
      sweepHz: 1400,
      sweepTime: 1.1,
    },
    level * jitterDb(g, VARY.levelDb),
  );

  tone(
    g,
    at + 0.02,
    dest,
    {
      type: 'sawtooth',
      hz: jitter(g, PALETTE.low.D3, VARY.pitchPct),
      detune: 6,
      env: { attack: 0.06, decay: 0.2, sustain: 0.7, release: 0.85, peak: 0.55 },
      filterHz: 2800,
      sweepHz: 1100,
      sweepTime: 1.0,
    },
    level * 0.8 * jitterDb(g, VARY.levelDb),
  );

  thump(
    g,
    at,
    dest,
    {
      hz: PALETTE.sub.D2,
      dropHz: PALETTE.sub.D1,
      dropTime: 0.3,
      env: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.7, peak: 0.6 },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  noise(
    g,
    at,
    dest,
    {
      filter: 'bandpass',
      hz: 600,
      q: 1.2,
      env: { attack: 0.02, decay: 0.1, sustain: 0.05, release: 0.15, peak: 0.15 },
    },
    level * 0.5 * jitterDb(g, VARY.levelDb),
  );
};

/** First blood: a bright three-tick `info` flourish over a sub thump. */
const ANN_FIRST_BLOOD: CueFn = (g, at, p) => {
  const dest = p.dest;
  const level = p.gain;

  thump(
    g,
    at,
    dest,
    {
      hz: PALETTE.low.D2,
      dropHz: PALETTE.sub.D1,
      dropTime: 0.22,
      env: { attack: 0.006, decay: 0.12, sustain: 0.3, release: 0.5, peak: 0.7 },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  const ticks = [PALETTE.info.A5, PALETTE.info.D6, PALETTE.info.F6];
  ticks.forEach((hz, i) => {
    tone(
      g,
      at + 0.05 + i * 0.09,
      dest,
      {
        type: 'triangle',
        hz: jitter(g, hz, VARY.pitchPct),
        env: { attack: 0.004, decay: 0.06, sustain: 0.2, release: 0.22, peak: 0.6 - i * 0.08 },
      },
      level * jitterDb(g, VARY.levelDb),
    );
  });

  shimmer(
    g,
    at + 0.1,
    dest,
    {
      hz: PALETTE.info.A5,
      modHz: 6,
      index: 40,
      tailHz: 3000,
      env: { attack: 0.02, decay: 0.4, sustain: 0.3, release: 0.9, peak: 0.35 },
    },
    level * jitterDb(g, VARY.levelDb),
  );
};

/** Victory: sub, rising swell, and a resolved D-minor cadence (D, F, A). */
const ANN_VICTORY: CueFn = (g, at, p) => {
  const dest = p.dest;
  const level = p.gain;

  thump(
    g,
    at,
    dest,
    {
      hz: PALETTE.sub.D2,
      dropHz: PALETTE.sub.D1,
      dropTime: 0.5,
      env: { attack: 0.01, decay: 0.3, sustain: 0.6, release: 1.6, peak: 0.9 },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  swell(
    g,
    at,
    dest,
    {
      type: 'sawtooth',
      hz: PALETTE.sub.D1,
      voices: 4,
      spreadCents: 10,
      openHz: 200,
      sweepHz: 2600,
      sweepTime: 1.6,
      env: { attack: 0.7, decay: 0.4, sustain: 0.7, release: 1.8, peak: 0.8 },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  // The resolved D-minor triad: degrees 0/2/4 of D natural minor (D, F, A).
  const cadenceDegrees = [0, 2, 4];
  cadenceDegrees.forEach((deg, i) => {
    tone(
      g,
      at + 0.5 + i * 0.04,
      dest,
      {
        type: 'triangle',
        hz: degree(PALETTE.rootHz, deg, 1),
        env: { attack: 0.06, decay: 0.3, sustain: 0.7, release: 1.5, peak: 0.5 - i * 0.05 },
        filterHz: 4000,
        sweepHz: 2200,
        sweepTime: 1.4,
      },
      level * jitterDb(g, VARY.levelDb),
    );
  });

  shimmer(
    g,
    at + 0.55,
    dest,
    {
      hz: PALETTE.info.D6,
      modHz: 4,
      index: 30,
      tailHz: 5000,
      env: { attack: 0.05, decay: 0.5, sustain: 0.4, release: 1.6, peak: 0.3 },
    },
    level * jitterDb(g, VARY.levelDb),
  );
};

/** Defeat: a sub drop into a detuned, closing-filter fall through `INTERVAL.enemy`. */
const ANN_DEFEAT: CueFn = (g, at, p) => {
  const dest = p.dest;
  const level = p.gain;

  thump(
    g,
    at,
    dest,
    {
      hz: PALETTE.low.D2,
      dropHz: degree(PALETTE.rootHz, 0, -2),
      dropTime: 0.9,
      env: { attack: 0.02, decay: 0.4, sustain: 0.5, release: 1.6, peak: 0.85 },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  INTERVAL.enemy.forEach((r, i) => {
    tone(
      g,
      at + i * 0.05,
      dest,
      {
        type: 'sawtooth',
        hz: PALETTE.low.D3 * r,
        glideHz: PALETTE.sub.D1 * r,
        glideTime: 1.8,
        detune: (g.rnd() * 2 - 1) * 14,
        env: { attack: 0.03, decay: 0.5, sustain: 0.55, release: 1.4, peak: 0.5 },
        filterHz: 1800,
        sweepHz: 260,
        sweepTime: 1.8,
      },
      level * jitterDb(g, VARY.levelDb),
    );
  });

  swell(
    g,
    at + 0.1,
    dest,
    {
      type: 'sawtooth',
      hz: PALETTE.sub.D1,
      voices: 3,
      spreadCents: 20,
      openHz: 900,
      sweepHz: 120,
      sweepTime: 2.0,
      env: { attack: 0.3, decay: 0.5, sustain: 0.6, release: 1.8, peak: 0.7 },
    },
    level * jitterDb(g, VARY.levelDb),
  );
};

/** Draw: an unresolved tritone drone — no cadence, just holds and fades. */
const ANN_DRAW: CueFn = (g, at, p) => {
  const dest = p.dest;
  const level = p.gain;

  thump(
    g,
    at,
    dest,
    {
      hz: PALETTE.low.D2,
      dropHz: PALETTE.sub.A1,
      dropTime: 0.4,
      env: { attack: 0.015, decay: 0.3, sustain: 0.5, release: 1.4, peak: 0.6 },
    },
    level * jitterDb(g, VARY.levelDb),
  );

  const tritone = ratioAt(INTERVAL.enemy, 2);
  [1, tritone].forEach((r, i) => {
    tone(
      g,
      at + i * 0.03,
      dest,
      {
        type: 'triangle',
        hz: PALETTE.mid.D3 * r,
        detune: i === 0 ? -4 : 4,
        env: { attack: 0.5, decay: 0.4, sustain: 0.75, release: 1.6, peak: 0.4 },
        filterHz: 2200,
        sweepHz: 1400,
        sweepTime: 2.0,
      },
      level * jitterDb(g, VARY.levelDb),
    );
  });

  swell(
    g,
    at + 0.2,
    dest,
    {
      type: 'sine',
      hz: PALETTE.sub.D1,
      voices: 2,
      spreadCents: 4,
      openHz: 400,
      sweepHz: 900,
      sweepTime: 1.8,
      env: { attack: 0.6, decay: 0.4, sustain: 0.7, release: 1.6, peak: 0.5 },
    },
    level * jitterDb(g, VARY.levelDb),
  );
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const OBJECTIVE_CUES = {
  'obj.tower': { fn: OBJ_TOWER, bus: 'sfx', priority: 1, tail: 2.0, variants: 1, dry: false },
  // Real tail (swell layer): 1.715 s. Declared 1.8 s for an honest ~85 ms cushion —
  // 1.7 undershot it by 15 ms and would have truncated the swell's release.
  'obj.guard': { fn: OBJ_GUARD, bus: 'sfx', priority: 1, tail: 1.8, variants: 1, dry: false },
  'obj.ancient': { fn: OBJ_ANCIENT, bus: 'sfx', priority: 1, tail: 2.8, variants: 1, dry: false },
  'obj.surge': { fn: OBJ_SURGE, bus: 'sfx', priority: 1, tail: 1.6, variants: 1, dry: false },
  'obj.klaxon': { fn: OBJ_KLAXON, bus: 'sfx', priority: 1, tail: 1.7, variants: 1, dry: false },
  // Real tail (tone layer): 1.4 s. Declared 1.45 s — 1.2 truncated the fountain-hum onset.
  'obj.respawn': { fn: OBJ_RESPAWN, bus: 'sfx', priority: 2, tail: 1.45, variants: 1, dry: false },
  // dry:true is intentional — countdown is fired with no world position (a timer tick,
  // not a placed event), same class as combat.ts's hit.heartbeat. The render harness's
  // isWorldCue() (audio-render-rift.mjs) exempts only the `ui.`/`ann.` id prefixes from
  // its @18m stereo-decorrelation check, so it still asserts decorrelation on this
  // legitimately-dry, non-`ui`/`ann`-prefixed cue and fails at 1.000 correlation — flagged
  // for the coordinator to rule on (harness heuristic vs. this cue's dry classification),
  // not silently special-cased here.
  'obj.countdown': { fn: OBJ_COUNTDOWN, bus: 'sfx', priority: 4, tail: 0.15, variants: 1, dry: true },
  'obj.matchStart': { fn: OBJ_MATCH_START, bus: 'sfx', priority: 1, tail: 1.6, variants: 1, dry: false },
  'ann.firstBlood': { fn: ANN_FIRST_BLOOD, bus: 'announcer', priority: 0, tail: 1.6, variants: 1, dry: true },
  'ann.victory': { fn: ANN_VICTORY, bus: 'announcer', priority: 0, tail: 3.0, variants: 1, dry: true },
  'ann.defeat': { fn: ANN_DEFEAT, bus: 'announcer', priority: 0, tail: 3.0, variants: 1, dry: true },
  // Real tail (swell layer): 2.8 s. Declared 2.9 s — 2.5 truncated the "holds and fades"
  // moment that is the entire character of an unresolved draw.
  'ann.draw': { fn: ANN_DRAW, bus: 'announcer', priority: 0, tail: 2.9, variants: 1, dry: true },
} satisfies CueRegistry;
