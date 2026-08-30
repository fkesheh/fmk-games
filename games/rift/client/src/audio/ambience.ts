/**
 * RIFT AUDIO — ambience.ts (T8)
 *
 * The valley bed. NOT a `SoundId`, NOT a `CueSpec` — `createAmbience` synthesises its own
 * long-lived graph directly through `CueGraph` + `dsp.ts` and returns an `AmbienceHandle`
 * whose lifecycle (`setScene`/`setBattleIntensity`/`tick`/`stop`) is driven by `index.ts`.
 * Putting these beds in the cue registry would give them two owners (SONIC_BIBLE design
 * note 4) — this module is their only owner.
 *
 * FIVE LAYERS, each behind its own gain node connected straight to `g.bus.amb` (the engine
 * applies `BUS_DB.amb` (-18 dB) plus the user's ambience slider downstream — this module
 * never re-applies bus trim, it only sets the RELATIVE level of its own material):
 *
 *   wind     - three de-correlated loops of the shared 1s noise buffer through one shared
 *              lowpass whose cutoff is swept by a gust LFO (AMBIENCE.gustHz,
 *              AMBIENCE.windCutoffHz). Present in every scene except 'silent'.
 *   drone    - a continuous sine at PALETTE.sub.D2, -30 dB (SONIC_BIBLE §10: "a low D drone
 *              bed"). Present in 'menu', 'field', 'fountain', 'dead'.
 *   battle   - sparse seeded noise grains ("distant battle"), gated on by scene and leveled
 *              continuously by `setBattleIntensity` through AMBIENCE.battleDb. Present in
 *              'field', 'fountain', 'dead'.
 *   fountain - two closely detuned sines at AMBIENCE.fountainHz, the water-hum layer that
 *              makes 'fountain' a superset of 'field' and therefore instantly distinct in a
 *              spectrogram (an added steady spectral line at ~55 Hz nothing else produces).
 *   pulse    - sparse seeded low `thump` grains, the "adds a low pulse only" layer that
 *              makes 'dead' a superset of 'field' and distinct in its own way (periodic
 *              sub-register bursts read as vertical stripes in a spectrogram). The engine's
 *              global submerge lowpass (owned by engine.ts, not here) darkens everything
 *              else while dead; this module's only job for that scene is the pulse.
 *
 * SCENE CROSSFADE MODEL — offline-safe, mirrors music.ts's `scheduleLayerGain`.
 *
 * `setScene`/`setBattleIntensity` never touch an `AudioParam` directly and never read a
 * clock of their own: they only record a pending target. The actual crossfade is scheduled
 * on the NEXT `tick(nowSec)` call, anchored at the caller's own injected clock — the same
 * clock the render harness pumps from `-preRollS` up through `0` in fixed steps and the
 * live frame loop pumps every frame. Because `AMBIENCE.fadeS` (1.4 s) is far shorter than
 * every scene's `preRollS` (>= 2 s, and 6 s for every scene that actually exercises a bed),
 * every crossfade started on the harness's very first tick call is fully settled well before
 * `t=0` — the scene tests measure a bed that has already reached steady state.
 *
 * Every ramp (scene crossfade, battle-intensity change, and the `stop()` fade-out below) is
 * scheduled by the same `scheduleRamp` helper, which handles TWO distinct discontinuities
 * with one mechanism — a `RampState` recording exactly what was last scheduled, and
 * `rampValueAt` interpolating the TRUE value of that ramp at an arbitrary query time:
 *   1. Negative `fromSec` (offline pre-roll) — a fade that starts, or wholly completes,
 *      before the render's `t=0` origin lands directly on its correctly-interpolated (or
 *      final) value AT `0`, never scheduling an `AudioParam` call at a negative time (which
 *      throws).
 *   2. A ramp interrupted by another before it finishes (reachable via rapid
 *      `setScene`/`setBattleIntensity` in live play) — the new ramp's start value is read
 *      from `rampValueAt(prevRamp, fromSec)`, the actual interpolated position of the
 *      in-flight ramp at the moment it is interrupted, not the value it was headed toward.
 *      Anchoring on the requested target instead of the true current value is exactly the
 *      class of bug that produces an audible jump when two fades collide.
 *
 * THE GUST LFO IS A NATIVE NODE, NOT A TICK-DRIVEN AUTOMATION LOOP. AUDIO_CONTRACT.md's
 * hard rules permit either "scheduled AudioParam automation OR LFO nodes" for continuous
 * modulation; a real `OscillatorNode` feeding the wind filter's `frequency` AudioParam is a
 * pure function of context time with zero drift between the live frame loop's ~16 ms ticks
 * and the offline harness's fixed 250 ms pump step, which a hand-rolled tick-sampled sine
 * would not guarantee bit-for-bit without extra bookkeeping this bed does not need. `tick()`
 * therefore has nothing to do to keep the gust itself moving; it is used for the three
 * things that generally DO need the injected clock: applying pending scene/intensity
 * crossfades, walking the two sparse discrete-grain schedulers (battle, dead-pulse) via the
 * same look-ahead-with-a-monotonic-pointer pattern `music.ts` uses for its percussion layer,
 * and recording `lastNowSec` so `stop()` has a clock to anchor its own fade-out on.
 *
 * LOOP-SEAM AVOIDANCE. The shared noise buffer (`g.noise`) is exactly 1 second and looped
 * (`AudioBufferSourceNode.loop = true`) per T0's contract — fine for a one-shot cue whose
 * envelope ends well inside that second, but a bed that loops it directly for an entire
 * match would produce an audible once-a-second seam. Three voices are used instead, each
 * started at a different seeded `loopStart` offset and a different seeded `playbackRate`
 * (+/-8%); with three different periods no single click repeats at one obvious period, and
 * the shared lowpass (topping out at `AMBIENCE.windCutoffHz.max`, 480 Hz) removes most of
 * the broadband energy any residual discontinuity would carry.
 *
 * `stop()` — click-free and offline-safe. Every continuous source (the three wind voices,
 * the gust LFO, the drone, both fountain oscillators) is left RUNNING and CONNECTED through
 * a short `STOP_FADE_S` fade-to-zero on the same per-layer gain nodes the scene crossfade
 * uses (via `scheduleRamp`, so an in-flight scene fade is interrupted correctly rather than
 * jumped from the wrong value — see point 2 above). Only once that fade completes are the
 * sources' own `.stop(atTime)` calls scheduled, and only their `onended` handlers — fired by
 * the audio graph itself once playback actually reaches that time, never a `setInterval` or
 * `setTimeout` — perform the disconnects. `stop()` never reads `ctx.currentTime`: its fade
 * is anchored on `lastNowSec`, the last value `tick()` was actually given, for the same
 * reason `setScene`/`setBattleIntensity` are — under `OfflineAudioContext`, `currentTime`
 * stays pinned at 0 until `startRendering()` resolves, so anchoring on it would schedule
 * every stop at time 0, silencing the bed before it ever renders and turning a real bug into
 * a passing (silent) render.
 *
 * Every continuous node (the wind voices, the gust LFO, the drone, the fountain hum) is
 * built once and `start(0)`'d in the factory body — always a literal `0`, never a negative
 * number, so it is valid whether `g.ctx` is live (already past `currentTime === 0`, in which
 * case the node simply starts immediately per spec) or offline (still pinned at
 * `currentTime === 0` before `startRendering()`). Nothing about this bed depends on
 * `Date.now()`, `performance.now()`, `setInterval`, `requestAnimationFrame`, or `window`.
 */

import type { AmbienceHandle, AmbienceScene, CreateAmbience, CueGraph, Env } from './contract.js';
import { AMBIENCE, PALETTE, VARY } from './config.js';
import { db, jitter, jitterDb, noise, thump } from './dsp.js';

type Layer = 'wind' | 'drone' | 'battle' | 'fountain' | 'pulse';
const ALL_LAYERS: readonly Layer[] = ['wind', 'drone', 'battle', 'fountain', 'pulse'];

interface LayerTargets {
  readonly wind: number;
  readonly drone: number;
  readonly battle: number;
  readonly fountain: number;
  readonly pulse: number;
}

/** Which layers are audible in each scene. `fountain` and `dead` are each a superset of
 * `field` plus exactly one distinguishing layer — see the module doc comment. */
const SCENE_LAYERS: Readonly<Record<AmbienceScene, LayerTargets>> = {
  silent: { wind: 0, drone: 0, battle: 0, fountain: 0, pulse: 0 },
  menu: { wind: 1, drone: 1, battle: 0, fountain: 0, pulse: 0 },
  field: { wind: 1, drone: 1, battle: 1, fountain: 0, pulse: 0 },
  fountain: { wind: 1, drone: 1, battle: 1, fountain: 1, pulse: 0 },
  dead: { wind: 1, drone: 1, battle: 1, fountain: 0, pulse: 1 },
};

/** How far ahead each grain scheduler looks per `tick()` call. Comfortably larger than
 * both the live frame-loop's ~16 ms cadence and the offline harness's fixed 250 ms pump
 * step, so neither caller can starve the scheduler between calls. */
const LOOKAHEAD_S = 0.5;

/** Sparse, seeded-jittered mean intervals for the two discrete grain layers. */
const BATTLE_MEAN_INTERVAL_S = 1.7;
const PULSE_MEAN_INTERVAL_S = 2.6;

/** Smoothing time for `setBattleIntensity` ramps — independent of the scene crossfade. */
const BATTLE_INTENSITY_RAMP_S = 0.6;

/** `stop()`'s own fade-to-zero — short and decisive ("stop dead"), just long enough that
 * cutting the underlying oscillators once it completes is never a sample-domain click. */
const STOP_FADE_S = 0.06;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function makeEnv(attack: number, decay: number, sustain: number, release: number, peak: number): Env {
  return { attack, decay, sustain, release, peak };
}

/** A linear ramp actually scheduled on an `AudioParam`: where it starts, where it ends, and
 * the value at each end. Kept so a LATER ramp can read the TRUE current value instead of
 * assuming this one already reached its target. */
interface RampState {
  readonly fromSec: number;
  readonly fromValue: number;
  readonly toSec: number;
  readonly toValue: number;
}

/** The true value of a linear ramp at an arbitrary query time, clamped to the ramp's own
 * endpoints (before it starts = `fromValue`; after it ends = `toValue`). */
function rampValueAt(ramp: RampState, atSec: number): number {
  if (atSec <= ramp.fromSec) return ramp.fromValue;
  if (atSec >= ramp.toSec) return ramp.toValue;
  const span = ramp.toSec - ramp.fromSec;
  const t = (atSec - ramp.fromSec) / span;
  return ramp.fromValue + (ramp.toValue - ramp.fromValue) * t;
}

/**
 * Schedule (or re-target) a linear ramp on `param`, safe against two distinct
 * discontinuities — see the module doc comment for both:
 *   - `fromSec < 0` (offline pre-roll): lands directly on the correctly-interpolated value
 *     at `t=0` rather than ever scheduling an automation call at a negative time.
 *   - `prev !== null` (this ramp interrupts one still in flight): the actual start value is
 *     read from `rampValueAt(prev, fromSec)` — the in-flight ramp's TRUE position at the
 *     moment of interruption — not `fallbackFromValue`, which is only used when there is no
 *     ramp in flight at all (the very first call for a given param).
 * Returns the `RampState` now actually scheduled, for the next call (or interruption) to
 * read back.
 */
function scheduleRamp(
  param: AudioParam,
  prev: RampState | null,
  fromSec: number,
  toValue: number,
  fadeS: number,
  fallbackFromValue: number,
): RampState {
  const fromValue = prev ? rampValueAt(prev, fromSec) : fallbackFromValue;
  const endSec = fromSec + fadeS;
  if (endSec <= 0) {
    param.cancelScheduledValues(0);
    param.setValueAtTime(toValue, 0);
    return { fromSec: 0, fromValue: toValue, toSec: 0, toValue };
  }
  if (fromSec < 0) {
    const elapsed = clamp01((0 - fromSec) / fadeS);
    const valueAtZero = fromValue + (toValue - fromValue) * elapsed;
    param.cancelScheduledValues(0);
    param.setValueAtTime(valueAtZero, 0);
    param.linearRampToValueAtTime(toValue, endSec);
    return { fromSec: 0, fromValue: valueAtZero, toSec: endSec, toValue };
  }
  param.cancelScheduledValues(fromSec);
  param.setValueAtTime(fromValue, fromSec);
  param.linearRampToValueAtTime(toValue, endSec);
  return { fromSec, fromValue, toSec: endSec, toValue };
}

/** One "distant battle" grain: a short, bandpassed noise burst well under `INFO_FLOOR_HZ`,
 * centred on a palette pitch (never a bare frequency literal) so it still reads as "of this
 * game" even muffled into the background. */
function scheduleBattleGrain(g: CueGraph, dest: AudioNode, at: number): void {
  const hz = jitter(g, PALETTE.low.D3, VARY.timbrePct);
  noise(
    g,
    at,
    dest,
    {
      filter: 'bandpass',
      hz,
      q: 2.2,
      env: makeEnv(0.02, 0.18, 0.12, 0.22, 1),
    },
    jitterDb(g, VARY.levelDb),
  );
}

/** One "dead" pulse: a slow, heavy sub thump — the one thing this module adds for that
 * scene, per the T8 spec ("dead adds a low pulse only"). */
function scheduleDeadPulse(g: CueGraph, dest: AudioNode, at: number): void {
  const hz = jitter(g, PALETTE.sub.D1, VARY.pitchPct);
  thump(
    g,
    at,
    dest,
    {
      hz,
      dropHz: hz * 0.6,
      dropTime: 0.5,
      env: makeEnv(0.01, 0.3, 0.1, 0.6, 0.9),
    },
    jitterDb(g, VARY.levelDb),
  );
}

export const createAmbience: CreateAmbience = (g) => {
  const ctx = g.ctx;

  // -------------------------------------------------------------------------------------
  // Per-layer gain nodes. These are the ONLY nodes a scene crossfade (or the stop fade)
  // ever ramps; everything else stays connected and running underneath them.
  // -------------------------------------------------------------------------------------
  const layerGain: Record<Layer, GainNode> = {
    wind: ctx.createGain(),
    drone: ctx.createGain(),
    battle: ctx.createGain(),
    fountain: ctx.createGain(),
    pulse: ctx.createGain(),
  };
  for (const layer of ALL_LAYERS) {
    layerGain[layer].gain.value = 0;
    layerGain[layer].connect(g.bus.amb);
  }

  // -------------------------------------------------------------------------------------
  // WIND — three de-correlated seeded noise loops through one shared gust-swept lowpass.
  // -------------------------------------------------------------------------------------
  const windTrim = ctx.createGain();
  windTrim.gain.value = db(-14);
  windTrim.connect(layerGain.wind);

  const windFilter = ctx.createBiquadFilter();
  windFilter.type = 'lowpass';
  windFilter.Q.value = 0.7;
  const windCenterHz = (AMBIENCE.windCutoffHz.min + AMBIENCE.windCutoffHz.max) / 2;
  const windSwingHz = (AMBIENCE.windCutoffHz.max - AMBIENCE.windCutoffHz.min) / 2;
  windFilter.frequency.setValueAtTime(windCenterHz, 0);
  windFilter.connect(windTrim);

  // Native LFO node (see module doc comment): a real oscillator is a pure function of
  // context time, so it is bit-identical between the live frame loop and the offline
  // harness's fixed pump step with zero extra bookkeeping.
  const windLfo = ctx.createOscillator();
  windLfo.type = 'sine';
  windLfo.frequency.setValueAtTime(AMBIENCE.gustHz, 0);
  const windLfoGain = ctx.createGain();
  windLfoGain.gain.value = windSwingHz;
  windLfo.connect(windLfoGain);
  windLfoGain.connect(windFilter.frequency);
  windLfo.start(0);

  const WIND_VOICES = 3;
  const windSources: AudioBufferSourceNode[] = [];
  const windVoiceTrims: GainNode[] = [];
  for (let i = 0; i < WIND_VOICES; i++) {
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    src.loop = true;
    src.loopStart = g.rnd() * g.noise.duration;
    src.loopEnd = g.noise.duration;
    // +/-8% playback-rate spread per voice: three different loop periods never re-align
    // inside any render, so no single seam click repeats at one obvious short period.
    src.playbackRate.value = 1 + (g.rnd() * 2 - 1) * 0.08;
    const voiceTrim = ctx.createGain();
    voiceTrim.gain.value = 1 / WIND_VOICES;
    src.connect(voiceTrim);
    voiceTrim.connect(windFilter);
    src.start(0);
    windSources.push(src);
    windVoiceTrims.push(voiceTrim);
  }

  // -------------------------------------------------------------------------------------
  // DRONE — continuous D2 sine, -30 dB. SONIC_BIBLE §10: "a low D drone bed".
  // -------------------------------------------------------------------------------------
  const droneTrim = ctx.createGain();
  droneTrim.gain.value = db(-30);
  droneTrim.connect(layerGain.drone);
  const droneOsc = ctx.createOscillator();
  droneOsc.type = 'sine';
  droneOsc.frequency.setValueAtTime(PALETTE.sub.D2, 0);
  droneOsc.connect(droneTrim);
  droneOsc.start(0);

  // -------------------------------------------------------------------------------------
  // FOUNTAIN — two closely detuned sines at AMBIENCE.fountainHz; the water shimmer.
  // -------------------------------------------------------------------------------------
  const fountainTrim = ctx.createGain();
  fountainTrim.gain.value = db(-20);
  fountainTrim.connect(layerGain.fountain);
  const fountainOscA = ctx.createOscillator();
  fountainOscA.type = 'sine';
  fountainOscA.frequency.setValueAtTime(AMBIENCE.fountainHz, 0);
  fountainOscA.detune.setValueAtTime(-6, 0);
  fountainOscA.connect(fountainTrim);
  fountainOscA.start(0);
  const fountainOscB = ctx.createOscillator();
  fountainOscB.type = 'sine';
  fountainOscB.frequency.setValueAtTime(AMBIENCE.fountainHz, 0);
  fountainOscB.detune.setValueAtTime(6, 0);
  fountainOscB.connect(fountainTrim);
  fountainOscB.start(0);

  // -------------------------------------------------------------------------------------
  // BATTLE — grains feed a continuous intensity gain, which feeds the scene crossfade gain.
  // -------------------------------------------------------------------------------------
  const battleLevel = ctx.createGain();
  battleLevel.gain.value = db(AMBIENCE.battleDb.min);
  battleLevel.connect(layerGain.battle);

  // -------------------------------------------------------------------------------------
  // Scene / intensity state. `setScene`/`setBattleIntensity` only record intent; `tick`
  // (given the injected clock) performs the actual offline-safe, interruption-safe
  // scheduling. `layerRamp`/`battleRamp` double as "what did we last ask for" (via
  // `.toValue`) AND "what is actually in flight right now" (for `rampValueAt`).
  // -------------------------------------------------------------------------------------
  let currentScene: AmbienceScene = 'silent';
  let pendingScene: AmbienceScene | null = null;
  const layerRamp: Record<Layer, RampState | null> = {
    wind: null,
    drone: null,
    battle: null,
    fountain: null,
    pulse: null,
  };

  let battleRamp: RampState | null = null;
  let pendingBattleIntensity: number | null = null;

  let nextBattleSec: number | null = null;
  let nextPulseSec: number | null = null;

  let lastNowSec = 0;
  let stopped = false;

  function currentLayerValue(layer: Layer): number {
    return layerRamp[layer]?.toValue ?? 0;
  }

  function currentBattleValue(): number {
    return battleRamp?.toValue ?? db(AMBIENCE.battleDb.min);
  }

  function applyScene(nowSec: number): void {
    if (pendingScene === null) return;
    const targets = SCENE_LAYERS[pendingScene];
    for (const layer of ALL_LAYERS) {
      const to = targets[layer];
      if (to !== currentLayerValue(layer)) {
        layerRamp[layer] = scheduleRamp(
          layerGain[layer].gain,
          layerRamp[layer],
          nowSec,
          to,
          AMBIENCE.fadeS,
          currentLayerValue(layer),
        );
      }
    }
    currentScene = pendingScene;
    pendingScene = null;
  }

  function applyBattleIntensity(nowSec: number): void {
    if (pendingBattleIntensity === null) return;
    const clamped = clamp01(pendingBattleIntensity);
    const targetDb =
      AMBIENCE.battleDb.min + (AMBIENCE.battleDb.max - AMBIENCE.battleDb.min) * clamped;
    const targetLinear = db(targetDb);
    battleRamp = scheduleRamp(
      battleLevel.gain,
      battleRamp,
      nowSec,
      targetLinear,
      BATTLE_INTENSITY_RAMP_S,
      currentBattleValue(),
    );
    pendingBattleIntensity = null;
  }

  /** Sparse look-ahead grain walk shared in shape by both discrete layers below: advance a
   * monotonic pointer — through negative pre-roll time too, exactly like music.ts's
   * `nextEighth`, so the first post-activation grain lands at a naturally jittered offset
   * rather than deterministically snapped to `t=0` — never revisit an index, never
   * synthesise a negative-time grain, and reset the pointer whenever the layer goes
   * inactive so re-activation starts a fresh schedule instead of bursting through a
   * backlog of stale catch-up grains. */
  function runBattleGrains(nowSec: number): void {
    if (SCENE_LAYERS[currentScene].battle !== 1) {
      nextBattleSec = null;
      return;
    }
    let cursor = nextBattleSec ?? nowSec;
    const horizon = nowSec + LOOKAHEAD_S;
    while (cursor < horizon) {
      const at = cursor;
      if (at >= 0) scheduleBattleGrain(g, battleLevel, at);
      cursor = at + jitter(g, BATTLE_MEAN_INTERVAL_S, 0.45);
    }
    nextBattleSec = cursor;
  }

  function runPulseGrains(nowSec: number): void {
    if (SCENE_LAYERS[currentScene].pulse !== 1) {
      nextPulseSec = null;
      return;
    }
    let cursor = nextPulseSec ?? nowSec;
    const horizon = nowSec + LOOKAHEAD_S;
    while (cursor < horizon) {
      const at = cursor;
      if (at >= 0) scheduleDeadPulse(g, layerGain.pulse, at);
      cursor = at + jitter(g, PULSE_MEAN_INTERVAL_S, 0.3);
    }
    nextPulseSec = cursor;
  }

  const handle: AmbienceHandle = {
    setScene(s) {
      pendingScene = s;
    },

    setBattleIntensity(v) {
      pendingBattleIntensity = v;
    },

    tick(nowSec) {
      if (stopped) return;
      lastNowSec = nowSec;
      applyScene(nowSec);
      applyBattleIntensity(nowSec);
      runBattleGrains(nowSec);
      runPulseGrains(nowSec);
    },

    stop() {
      if (stopped) return;
      stopped = true;

      // Anchor on the injected clock's last known value, never `ctx.currentTime` — under
      // `OfflineAudioContext` the latter stays pinned at 0 until `startRendering()`
      // resolves, which would schedule every stop at time 0 and silence the bed before it
      // ever renders (a silent render that still exits 0). `scheduleRamp` here reuses the
      // exact same interruption-safe machinery the scene crossfade uses, so a `stop()`
      // that lands mid-crossfade fades from the TRUE current level, not a stale target.
      const at = lastNowSec;
      for (const layer of ALL_LAYERS) {
        layerRamp[layer] = scheduleRamp(
          layerGain[layer].gain,
          layerRamp[layer],
          at,
          0,
          STOP_FADE_S,
          currentLayerValue(layer),
        );
      }
      battleRamp = scheduleRamp(battleLevel.gain, battleRamp, at, 0, STOP_FADE_S, currentBattleValue());

      // Every continuous source keeps running, connected, THROUGH the fade above — only
      // once it completes do the sources actually stop, and only their own `onended`
      // (fired by the audio graph itself, never a timer) tears down the graph. Disconnecting
      // anything synchronously here would truncate the signal before the fade reaches
      // silence, reproducing exactly the click this fix removes.
      const stopAt = at + STOP_FADE_S;
      try {
        for (const src of windSources) src.stop(stopAt);
        windLfo.stop(stopAt);
        droneOsc.stop(stopAt);
        fountainOscA.stop(stopAt);
        fountainOscB.stop(stopAt);
      } catch {
        // Already stopped/ended — degrade silently per the repo-wide audio law.
      }

      windLfo.onended = () => {
        try {
          for (const src of windSources) src.disconnect();
          for (const trim of windVoiceTrims) trim.disconnect();
          windLfo.disconnect();
          windLfoGain.disconnect();
          windFilter.disconnect();
          windTrim.disconnect();
          droneOsc.disconnect();
          droneTrim.disconnect();
          fountainOscA.disconnect();
          fountainOscB.disconnect();
          fountainTrim.disconnect();
          battleLevel.disconnect();
          for (const layer of ALL_LAYERS) layerGain[layer].disconnect();
        } catch {
          // Disconnecting an already-disconnected node is a spec no-op; guard anyway.
        }
      };
    },
  };

  return handle;
};
