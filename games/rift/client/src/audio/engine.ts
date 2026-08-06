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

  // music/amb/sfx run through their duck node before summing into preMaster; ui/announcer
  // are never ducked and connect straight through (SONIC_BIBLE §8).
  music.connect(duckNodes.music);
  amb.connect(duckNodes.amb);
  sfx.connect(duckNodes.sfx);
  duckNodes.music.connect(preMaster);
  duckNodes.amb.connect(preMaster);
  duckNodes.sfx.connect(preMaster);
  ui.connect(preMaster);
  announcer.connect(preMaster);

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

  function applyLevels(s: AudioSettings): void {
    rampParam(ctx, music.gain, db(BUS_DB.music) * s.music);
    rampParam(ctx, amb.gain, db(BUS_DB.amb) * s.ambience);
    rampParam(ctx, sfx.gain, db(BUS_DB.sfx) * s.sfx);
    rampParam(ctx, ui.gain, db(BUS_DB.ui) * s.sfx);
    rampParam(ctx, announcer.gain, db(BUS_DB.announcer) * s.sfx);
    const masterTarget = s.muted ? 0 : db(MASTER_TRIM_DB) * s.master;
    rampParam(ctx, masterGain.gain, masterTarget);
  }
  applyLevels(settings);

  function triggerDuck(duckBus: DuckBus, depthDb: number, at: number, tail: number): void {
    try {
      const node = duckNodes[duckBus];
      const state = duckState[duckBus];
      const attackEnd = at + DUCK.attackS;
      const releaseEnd = attackEnd + tail + DUCK.releasePadS;

      if (at >= state.untilTime) {
        // No overlap with a still-active duck — schedule a fresh envelope from unity.
        node.gain.cancelScheduledValues(at);
        node.gain.setValueAtTime(1, at);
        node.gain.linearRampToValueAtTime(db(depthDb), attackEnd);
        node.gain.exponentialRampToValueAtTime(1, releaseEnd);
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
        if (typeof node.gain.cancelAndHoldAtTime === 'function') {
          node.gain.cancelAndHoldAtTime(at);
        } else {
          node.gain.cancelScheduledValues(at);
          node.gain.setValueAtTime(heldValue, at);
        }
        const deeperDb = Math.min(state.depthDb, depthDb);
        node.gain.linearRampToValueAtTime(db(deeperDb), attackEnd);
        const newUntil = Math.max(state.untilTime, releaseEnd);
        node.gain.exponentialRampToValueAtTime(1, newUntil);
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
        voiceGain.connect(bus[spec.bus]);

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
        applyLevels(s);
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
