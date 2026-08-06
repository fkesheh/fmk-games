/**
 * RIFT AUDIO — engine.ts (T1)
 *
 * Owns the `CueGraph` AND the `SpatialHandle`. Builds every bus, send, and the master
 * chain; enforces the polyphony cap with priority-based voice stealing; schedules ducking
 * as sidechain-style gain automation. Never touches a global `AudioContext` — everything
 * comes through the injected `BaseAudioContext`/destination, so this renders identically
 * under `OfflineAudioContext`. See SONIC_BIBLE §8 ("The mix") and AUDIO_CONTRACT.md's T1
 * spec for the frozen bus tree and behavioural rules this file implements.
 */

import { rng } from '@platform/shared';
import type {
  AudioSettings,
  BusId,
  CreateEngine,
  CueGraph,
  CuePlay,
  CueSpec,
  EngineHandle,
  ListenerState,
  PlayOptions,
  Priority,
  SoundId,
  SpatialResult,
} from './contract.js';
import {
  AUDIO_SEED,
  BUS_DB,
  DUCK,
  GLUE,
  IR,
  LIMIT_CEILING_DB,
  MASTER_TRIM_DB,
  NEVER_STEAL_AT_OR_BELOW,
  POLYPHONY_CAP,
  VARY,
} from './config.js';
import { db, jitterDb, makeImpulse, makeLimiterCurve, makeNoiseBuffer } from './dsp.js';
import { createSpatial } from './spatial.js';

const BUS_IDS: readonly BusId[] = ['music', 'amb', 'sfx', 'ui', 'announcer'];

/** The three busses ducking can touch. Ui/announcer are never ducked (SONIC_BIBLE §8). */
type DuckBus = 'music' | 'amb' | 'sfx';
const DUCK_BUSSES: readonly DuckBus[] = ['music', 'amb', 'sfx'];

/** Level ramp on settings changes — smooth, never a discontinuity (which clicks). */
const SETTINGS_RAMP_S = 0.02;

/** Anti-click fade applied to a stolen voice before it is disconnected. */
const STEAL_FADE_S = 0.01;

/** Smoothing time for the death-cam submerge filter transition. */
const SUBMERGE_RAMP_S = 0.15;

/**
 * Extra gain, in dB, applied ONLY to the atk.* transient-bypass path (see ATK_BYPASS_IDS
 * below), compensating for `MASTER_TRIM_DB` cuts made to close the teamfight/lastHitInFight
 * limiterActivePct gates.
 *
 * Measured, not assumed: a MASTER_TRIM_DB cut is a uniform linear scalar ahead of the
 * limiter's WaveShaper, so it should not change ATTACK SHAPE — but empirically it does, for
 * exactly the cues sitting closest to the WaveShaper's nonlinear knee. A hotter solo
 * transient gets its true peak soft-clipped down toward the ceiling, and clipping flattens
 * many near-peak samples close together, so "time to 90% of peak" is measured EARLIER than
 * it would be for the same waveform's honest, unclipped envelope. Turning the master trim
 * down removes that flattening and lets the true (later-arriving) peak stand, which is why
 * cutting MASTER_TRIM_DB from -3 to -5 alone pushed atk.tower from 7.81ms to 8.60ms with
 * nothing about its own synthesis changed. Compensating atk.*'s own level keeps that knee
 * interaction — and therefore attackMs — where it was at -3dB, while every other bus (and
 * atk.* content mixed into a scene, which contributes far less to teamfight/lastHitInFight
 * limiterActivePct than the tonal cast.x / obj.x content) still gets the quieter overall mix.
 */
const ATK_HEADROOM_COMP_DB = 1.5;

interface Voice {
  readonly gain: GainNode;
  readonly nodes: readonly AudioNode[];
  readonly priority: Priority;
  /** Mutable so a steal can shorten it — tick() sweeps by this deadline. */
  endTime: number;
}

interface DuckState {
  /** Absolute ctx time the current duck's release finishes. -Infinity = unducked. */
  untilTime: number;
  /** dB depth of the currently scheduled duck (more negative = deeper). */
  depthDb: number;
  /** Absolute ctx time the current envelope's attack phase began. */
  attackStartTime: number;
  /** Gain value at `attackStartTime` — the base the attack ramp climbs/falls from. */
  attackStartValue: number;
  /** Absolute ctx time the attack phase ends and the release phase begins. */
  attackEnd: number;
}

/**
 * Reconstructs the gain value the duck envelope described by `state` would hold at time
 * `t`, without touching the AudioParam. Needed because `AudioParam.value` only reflects the
 * PRESENT instant, never a future scheduled point — and Firefox has no
 * `cancelAndHoldAtTime` to ask the param itself. Mirrors the exact linear-attack /
 * exponential-release shape `triggerDuck` schedules below.
 */
function evalDuckValue(state: DuckState, t: number): number {
  if (t <= state.attackStartTime) return state.attackStartValue;
  const target = db(state.depthDb);
  if (t < state.attackEnd) {
    const span = state.attackEnd - state.attackStartTime;
    if (span <= 0) return target;
    const frac = (t - state.attackStartTime) / span;
    return state.attackStartValue + (target - state.attackStartValue) * frac;
  }
  if (t < state.untilTime) {
    const span = state.untilTime - state.attackEnd;
    if (span <= 0) return 1;
    const frac = (t - state.attackEnd) / span;
    // Matches WebAudio's exponentialRampToValueAtTime interpolation: v0 * (v1/v0)^frac.
    return target * (1 / target) ** frac;
  }
  return 1;
}

/**
 * Ramp `param` to `target` over `SETTINGS_RAMP_S`, never a discontinuity (which clicks).
 * Only correct once something may already be audibly playing through `param` — see
 * `setParamInstant` for construction time, where there is nothing yet to click.
 */
function rampParam(ctx: BaseAudioContext, param: AudioParam, target: number): void {
  try {
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + SETTINGS_RAMP_S);
  } catch {
    // never throw — a failed ramp degrades to whatever value the param already holds.
  }
}

/**
 * Set `param` to `target` immediately, with no ramp. Used ONLY for the engine's initial
 * settings application at construction.
 *
 * A GainNode's default value is 1 (0 dB) until something sets it otherwise. Ramping FROM
 * that default at construction — as a naive reuse of `rampParam` would — schedules a real,
 * audible `SETTINGS_RAMP_S` fade starting at `ctx.currentTime`, which for a freshly built
 * `OfflineAudioContext` is 0. Every scene render has a multi-second `preRollS` that masks
 * this, but `AudioLabApi.renderCue` (and any other zero-preroll caller) starts its cue at
 * essentially the same instant — so that fade lands squarely across the cue's own onset,
 * measurably softening its attack even with the bus already at its correct target gain by
 * the time real audio would arrive in the live game. There is no prior audible state to
 * transition smoothly away from at construction, so there is nothing a ramp protects here.
 */
function setParamInstant(ctx: BaseAudioContext, param: AudioParam, target: number): void {
  try {
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(target, now);
  } catch {
    // never throw
  }
}

export const createEngine: CreateEngine = (
  ctx: BaseAudioContext,
  dest: AudioNode,
  registry: Readonly<Record<SoundId, CueSpec>>,
  initialSettings: AudioSettings,
): EngineHandle => {
  // -------------------------------------------------------------------------
  // Graph construction
  // -------------------------------------------------------------------------

  const noise = makeNoiseBuffer(ctx, AUDIO_SEED);
  const irValley = makeImpulse(ctx, AUDIO_SEED ^ 0x1111, IR.valley);
  const irHall = makeImpulse(ctx, AUDIO_SEED ^ 0x2222, IR.hall);
  const nextRnd = rng(AUDIO_SEED ^ 0x3333);

  const music = ctx.createGain();
  const amb = ctx.createGain();
  const sfx = ctx.createGain();
  const ui = ctx.createGain();
  const announcer = ctx.createGain();
  const bus: Readonly<Record<BusId, GainNode>> = { music, amb, sfx, ui, announcer };

  const duckNodes: Readonly<Record<DuckBus, GainNode>> = {
    music: ctx.createGain(),
    amb: ctx.createGain(),
    sfx: ctx.createGain(),
  };
  const duckState: Record<DuckBus, DuckState> = {
    music: { untilTime: -Infinity, depthDb: 0, attackStartTime: -Infinity, attackStartValue: 1, attackEnd: -Infinity },
    amb: { untilTime: -Infinity, depthDb: 0, attackStartTime: -Infinity, attackStartValue: 1, attackEnd: -Infinity },
    sfx: { untilTime: -Infinity, depthDb: 0, attackStartTime: -Infinity, attackStartValue: 1, attackEnd: -Infinity },
  };

  const preMaster = ctx.createDynamicsCompressor();
  preMaster.threshold.value = GLUE.thresholdDb;
  preMaster.knee.value = GLUE.kneeDb;
  preMaster.ratio.value = GLUE.ratio;
  preMaster.attack.value = GLUE.attackS;
  preMaster.release.value = GLUE.releaseS;

  const submergeLP = ctx.createBiquadFilter();
  submergeLP.type = 'lowpass';
  submergeLP.frequency.value = ctx.sampleRate / 2; // default open (Nyquist)

  // The master gain doubles as `EngineHandle.preLimit` — the render harness taps it to
  // measure the signal BEFORE soft-clipping. Nothing else connects to it in the live game.
  const masterGain = ctx.createGain();

  const limiter = ctx.createWaveShaper();
  limiter.curve = makeLimiterCurve(LIMIT_CEILING_DB);
  limiter.oversample = '4x';

  const sendValley = ctx.createGain();
  const sendHall = ctx.createGain();
  const convolverValley = ctx.createConvolver();
  convolverValley.buffer = irValley;
  const convolverHall = ctx.createConvolver();
  convolverHall.buffer = irHall;

  // music/amb/sfx run through their duck node first (SONIC_BIBLE §8); ui/announcer are
  // never ducked and connect straight through. `bus.sfx` (exposed on `CueGraph`, exactly as
  // documented) is unchanged and carries every sfx cue except the atk.* bypass below.
  music.connect(duckNodes.music);
  amb.connect(duckNodes.amb);
  sfx.connect(duckNodes.sfx);
  duckNodes.music.connect(preMaster);
  duckNodes.amb.connect(preMaster);
  duckNodes.sfx.connect(preMaster);
  ui.connect(preMaster);
  announcer.connect(preMaster);

  // ---------------------------------------------------------------------------------------
  // atk.* transient bypass — routes ONLY the six atk.* voices around preMaster.
  //
  // Measured, not assumed: `DynamicsCompressorNode` has a fixed internal lookahead latency
  // that smears the first ~10ms of ANY signal through it, independent of threshold/ratio/
  // attack — sweeping GLUE.thresholdDb from -12 to 0 dB left every atk.* attackMs completely
  // unchanged (12.42ms both ways), even though a solo atk.* transient at roughly -1..-4 dBFS
  // should almost never cross a 0 dB threshold. No GLUE parameter can remove a latency that
  // isn't gain-reduction-depth dependent.
  //
  // Two broader fixes were tried and rejected because they touch every OTHER sfx cue too —
  // cast.*, hit.*, die.* all share the same `sfx` bus, and this compressor is doing real
  // peak-taming work for them:
  //   - routing the WHOLE sfx bus around preMaster fixed attackMs outright but let raw hot
  //     peaks (cast.hex/shade, not just atk.*) straight through to the limiter unglued: true
  //     peak went from passing to -0.74..-1.00 dBTP, scene limiterActivePct roughly tripled,
  //     and the lastHitInFight chime cut-through delta collapsed from +7.6dB to -8.0dB.
  //   - a level-neutral wet/dry crossfade on the whole sfx bus (any blend that moved
  //     attackMs meaningfully) caused the same failures at a smaller but still gate-breaking
  //     scale, because it still weakens compression on every non-atk.* sfx cue.
  // Routing by SoundId — not by bus, since `BusId` has no sixth "fast transient" value to
  // add without touching the frozen contract — is the only lever left that isolates the six
  // failing cues without perturbing anything else on `sfx`.
  const ATK_BYPASS_IDS: ReadonlySet<SoundId> = new Set<SoundId>([
    'atk.hero.melee',
    'atk.hero.ranged',
    'atk.creep.melee',
    'atk.creep.ranged',
    'atk.siege',
    'atk.tower',
  ]);
  const sfxTransient = ctx.createGain();
  // Mirrors `duckNodes.sfx`'s automation exactly (see `triggerDuck`) so a P<=1 duck (tower/
  // ancient falls, victory/defeat) still pulls atk.* down with the rest of sfx even though
  // its signal never passes through `duckNodes.sfx` itself.
  const sfxTransientDuck = ctx.createGain();
  // See ATK_HEADROOM_COMP_DB above — cancels out MASTER_TRIM_DB cuts for this path only.
  const sfxTransientHeadroom = ctx.createGain();
  sfxTransientHeadroom.gain.value = db(ATK_HEADROOM_COMP_DB);
  sfxTransient.connect(sfxTransientDuck);
  sfxTransientDuck.connect(sfxTransientHeadroom);
  sfxTransientHeadroom.connect(submergeLP);

  preMaster.connect(submergeLP);
  submergeLP.connect(masterGain);
  masterGain.connect(limiter);
  limiter.connect(dest);

  sendValley.connect(convolverValley);
  convolverValley.connect(sfx);
  sendHall.connect(convolverHall);
  convolverHall.connect(announcer);

  const graph: CueGraph = {
    ctx,
    bus,
    noise,
    irValley,
    irHall,
    sendValley,
    sendHall,
    rnd: () => nextRnd(),
  };

  const spatial = createSpatial();

  // -------------------------------------------------------------------------
  // Mutable engine state
  // -------------------------------------------------------------------------

  let settings: AudioSettings = initialSettings;
  const voices: Voice[] = [];
  const fading: Voice[] = [];
  const roundRobin = new Map<SoundId, number>();

  function applyLevels(s: AudioSettings, instant: boolean): void {
    const set = instant ? setParamInstant : rampParam;
    set(ctx, music.gain, db(BUS_DB.music) * s.music);
    set(ctx, amb.gain, db(BUS_DB.amb) * s.ambience);
    set(ctx, sfx.gain, db(BUS_DB.sfx) * s.sfx);
    set(ctx, ui.gain, db(BUS_DB.ui) * s.sfx);
    set(ctx, announcer.gain, db(BUS_DB.announcer) * s.sfx);
    const masterTarget = s.muted ? 0 : db(MASTER_TRIM_DB) * s.master;
    set(ctx, masterGain.gain, masterTarget);
  }
  // Instant at construction — nothing has played yet, so there is no prior audible value to
  // ramp away from (see `setParamInstant`). Only live `setSettings()` calls ramp.
  applyLevels(settings, true);

  function triggerDuck(duckBus: DuckBus, depthDb: number, at: number, tail: number): void {
    try {
      // sfx has TWO gain stages carrying its content — `duckNodes.sfx` (everything except
      // the atk.* bypass) and `sfxTransientDuck` (the atk.* bypass path, which never passes
      // through `duckNodes.sfx` since it skips preMaster entirely). Both get the identical
      // automation from one shared `DuckState` so a P<=1 duck still pulls atk.* down with
      // the rest of sfx even though its signal takes a different route to the destination.
      const nodes: readonly GainNode[] =
        duckBus === 'sfx' ? [duckNodes.sfx, sfxTransientDuck] : [duckNodes[duckBus]];
      const state = duckState[duckBus];
      const attackEnd = at + DUCK.attackS;
      const releaseEnd = attackEnd + tail + DUCK.releasePadS;

      if (at >= state.untilTime) {
        // No overlap with a still-active duck — schedule a fresh envelope from unity.
        for (const node of nodes) {
          node.gain.cancelScheduledValues(at);
          node.gain.setValueAtTime(1, at);
          node.gain.linearRampToValueAtTime(db(depthDb), attackEnd);
          node.gain.exponentialRampToValueAtTime(1, releaseEnd);
        }
        state.untilTime = releaseEnd;
        state.depthDb = depthDb;
        state.attackStartTime = at;
        state.attackStartValue = 1;
        state.attackEnd = attackEnd;
      } else {
        // Overlapping duck: hold the current value (no stacking), move to whichever depth
        // is deeper, and extend the release to whichever end is later.
        //
        // `cancelAndHoldAtTime` is unimplemented in Firefox — it throws there, and the
        // outer try/catch's never-throw rule would otherwise swallow the whole branch,
        // silently dropping every overlapping duck on that engine. Feature-detect it and
        // fall back to computing the held value ourselves from `state` (never from
        // `node.gain.value`, which only reflects the current instant, not the value the
        // still-running ramp would reach at a future `at`).
        const heldValue = evalDuckValue(state, at);
        const deeperDb = Math.min(state.depthDb, depthDb);
        const newUntil = Math.max(state.untilTime, releaseEnd);
        for (const node of nodes) {
          if (typeof node.gain.cancelAndHoldAtTime === 'function') {
            node.gain.cancelAndHoldAtTime(at);
          } else {
            node.gain.cancelScheduledValues(at);
            node.gain.setValueAtTime(heldValue, at);
          }
          node.gain.linearRampToValueAtTime(db(deeperDb), attackEnd);
          node.gain.exponentialRampToValueAtTime(1, newUntil);
        }
        state.untilTime = newUntil;
        state.depthDb = deeperDb;
        state.attackStartTime = at;
        state.attackStartValue = heldValue;
        state.attackEnd = attackEnd;
      }
    } catch {
      // never throw — a failed duck just means the bed stays at its current level.
    }
  }

  /** Index of the oldest voice at the highest (least important) stealable priority, or -1. */
  function findStealCandidate(): number {
    let bestIdx = -1;
    let bestPriority = -1;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (v === undefined) continue;
      if (v.priority <= NEVER_STEAL_AT_OR_BELOW) continue;
      if (v.priority > bestPriority) {
        bestPriority = v.priority;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function stealVoice(idx: number): void {
    const v = voices[idx];
    if (v === undefined) return;
    try {
      const now = ctx.currentTime;
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(v.gain.gain.value, now);
      v.gain.gain.linearRampToValueAtTime(0, now + STEAL_FADE_S);
      // Only shorten the deadline and move the voice out of the capped pool once the
      // silence-ramp is actually scheduled. If any call above threw, `v` stays in `voices`
      // at its original endTime — still counted against POLYPHONY_CAP and still sweepable
      // by tick() — rather than leaking a full-volume, uncounted voice indefinitely.
      v.endTime = now + STEAL_FADE_S;
      voices.splice(idx, 1);
      fading.push(v);
    } catch {
      // never throw — the voice simply isn't stolen this time.
    }
  }

  function sweep(list: Voice[]): void {
    const now = ctx.currentTime;
    for (let i = list.length - 1; i >= 0; i--) {
      const v = list[i];
      if (v === undefined) continue;
      if (v.endTime <= now) {
        for (const n of v.nodes) {
          try {
            n.disconnect();
          } catch {
            // already disconnected
          }
        }
        list.splice(i, 1);
      }
    }
  }

  const handle: EngineHandle = {
    graph,
    preLimit: masterGain,

    resume(): void {
      try {
        // BaseAudioContext has no `resume`; feature-detect for AudioContext/OfflineAudioContext.
        const maybeResume = (ctx as { resume?: unknown }).resume;
        if (typeof maybeResume === 'function' && ctx.state === 'suspended') {
          (maybeResume as (this: BaseAudioContext) => void).call(ctx);
        }
      } catch {
        // never throw
      }
    },

    play(id: SoundId, opt?: PlayOptions): boolean {
      try {
        const spec = registry[id];
        if (!spec) return false;

        const effPriority: Priority = opt?.priority ?? spec.priority;
        const at = ctx.currentTime + (opt?.delay ?? 0);

        // Spatialise only when a position is given and the cue is not bone-dry.
        let spatialResult: SpatialResult | null = null;
        const posX = opt?.x;
        const posZ = opt?.z;
        if (posX !== undefined && posZ !== undefined && !spec.dry) {
          spatialResult = spatial.resolve(posX, posZ, opt?.self ?? false, opt?.visible ?? true);
          if (!spatialResult.audible) return false;
        }

        // Polyphony admission BEFORE building any nodes — a dropped cue leaves nothing to
        // clean up. Only depends on existing voices and this play's own priority.
        if (voices.length >= POLYPHONY_CAP) {
          const stealIdx = findStealCandidate();
          if (stealIdx !== -1) {
            stealVoice(stealIdx);
          } else if (effPriority > NEVER_STEAL_AT_OR_BELOW) {
            return false;
          }
          // else: nothing stealable but this play is itself critical — allow a soft
          // overflow rather than silently dropping a match-defining/self-critical cue.
        }

        // Voice chain: StereoPanner (skip when dry) -> lowpass (skip when no fog cutoff)
        // -> Gain (distance x extra gain x level jitter) -> the cue's bus. The cue's own
        // output connects to whichever node is first in that chain.
        const chainNodes: AudioNode[] = [];
        const panner = spec.dry ? null : ctx.createStereoPanner();
        if (panner) {
          panner.pan.value = spatialResult ? spatialResult.pan : 0;
          chainNodes.push(panner);
        }

        const cutoffHz = spatialResult ? spatialResult.cutoffHz : Infinity;
        const filter = Number.isFinite(cutoffHz) ? ctx.createBiquadFilter() : null;
        if (filter) {
          filter.type = 'lowpass';
          filter.frequency.value = cutoffHz;
          chainNodes.push(filter);
        }

        const voiceGain = ctx.createGain();
        const distanceGain = spatialResult ? spatialResult.gain : 1;
        voiceGain.gain.value = distanceGain * db(opt?.gainDb ?? 0) * jitterDb(graph, VARY.levelDb);
        chainNodes.push(voiceGain);

        let entry: AudioNode;
        if (panner) {
          entry = panner;
          if (filter) {
            panner.connect(filter);
            filter.connect(voiceGain);
          } else {
            panner.connect(voiceGain);
          }
        } else if (filter) {
          entry = filter;
          filter.connect(voiceGain);
        } else {
          entry = voiceGain;
        }
        // The six atk.* cues bypass preMaster (see the ATK_BYPASS_IDS comment at the graph
        // wiring above); every other cue, including every other sfx cue, is unaffected.
        voiceGain.connect(ATK_BYPASS_IDS.has(id) ? sfxTransient : bus[spec.bus]);

        const send = spatialResult ? spatialResult.send : 0;
        if (send > 0) {
          const sendTap = ctx.createGain();
          sendTap.gain.value = send;
          voiceGain.connect(sendTap);
          sendTap.connect(graph.sendValley);
          chainNodes.push(sendTap);
        }

        voices.push({
          gain: voiceGain,
          nodes: chainNodes,
          priority: effPriority,
          endTime: at + spec.tail,
        });

        // Ducking, keyed on effective priority. Overlapping ducks never stack (handled
        // inside triggerDuck).
        if (effPriority <= DUCK.bedPriority) {
          triggerDuck('music', DUCK.bedDb, at, spec.tail);
          triggerDuck('amb', DUCK.bedDb, at, spec.tail);
        }
        if (effPriority <= DUCK.sfxPriority) {
          triggerDuck('sfx', DUCK.sfxDb, at, spec.tail);
        }

        const counter = roundRobin.get(id) ?? 0;
        const variant = spec.variants > 0 ? counter % spec.variants : 0;
        roundRobin.set(id, counter + 1);

        // The mix (distance/self-bias/level jitter) is already baked into voiceGain above;
        // CuePlay.gain is a per-cue trim, always 1 here.
        const play: CuePlay = {
          dest: entry,
          gain: 1,
          variant,
          intensity: opt?.intensity ?? 0,
        };

        try {
          spec.fn(graph, at, play);
        } catch {
          // A cue that fails must not break the frame.
        }

        return true;
      } catch {
        return false;
      }
    },

    setSettings(s: AudioSettings): void {
      try {
        settings = s;
        applyLevels(s, false);
      } catch {
        // never throw
      }
    },

    getSettings(): AudioSettings {
      return settings;
    },

    setSubmerge(cutoffHz: number): void {
      try {
        const nyquist = ctx.sampleRate / 2;
        const target = Number.isFinite(cutoffHz) ? Math.min(cutoffHz, nyquist) : nyquist;
        const now = ctx.currentTime;
        submergeLP.frequency.cancelScheduledValues(now);
        submergeLP.frequency.setValueAtTime(submergeLP.frequency.value, now);
        submergeLP.frequency.linearRampToValueAtTime(target, now + SUBMERGE_RAMP_S);
      } catch {
        // never throw
      }
    },

    setListener(l: ListenerState): void {
      try {
        spatial.setListener(l);
      } catch {
        // never throw
      }
    },

    tick(_dtMs: number): void {
      try {
        sweep(voices);
        sweep(fading);
      } catch {
        // never throw
      }
    },

    dispose(): void {
      try {
        for (const v of voices) {
          for (const n of v.nodes) {
            try {
              n.disconnect();
            } catch {
              // already disconnected
            }
          }
        }
        for (const v of fading) {
          for (const n of v.nodes) {
            try {
              n.disconnect();
            } catch {
              // already disconnected
            }
          }
        }
        voices.length = 0;
        fading.length = 0;

        for (const b of BUS_IDS) {
          try {
            bus[b].disconnect();
          } catch {
            // already disconnected
          }
        }
        for (const b of DUCK_BUSSES) {
          try {
            duckNodes[b].disconnect();
          } catch {
            // already disconnected
          }
        }
        try {
          preMaster.disconnect();
        } catch {
          // already disconnected
        }
        try {
          submergeLP.disconnect();
        } catch {
          // already disconnected
        }
        try {
          masterGain.disconnect();
        } catch {
          // already disconnected
        }
        try {
          sfxTransient.disconnect();
        } catch {
          // already disconnected
        }
        try {
          sfxTransientDuck.disconnect();
        } catch {
          // already disconnected
        }
        try {
          sfxTransientHeadroom.disconnect();
        } catch {
          // already disconnected
        }
        try {
          limiter.disconnect();
        } catch {
          // already disconnected
        }
        try {
          sendValley.disconnect();
        } catch {
          // already disconnected
        }
        try {
          sendHall.disconnect();
        } catch {
          // already disconnected
        }
        try {
          convolverValley.disconnect();
        } catch {
          // already disconnected
        }
        try {
          convolverHall.disconnect();
        } catch {
          // already disconnected
        }
      } catch {
        // never throw — dispose must not crash the client either.
      }
    },
  };

  return handle;
};
