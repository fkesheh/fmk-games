/**
 * RIFT AUDIO — dsp.ts (T0)
 *
 * The six timbre archetypes (SONIC_BIBLE §4) plus the shared envelope/filter/jitter/RNG
 * primitives every cue module builds cues from. Every function takes an injected
 * `BaseAudioContext` (via `CueGraph.ctx` or directly) and never touches a global
 * `AudioContext`, `ctx.state`, `resume()`, or `window` — this is what makes the module
 * work identically under `OfflineAudioContext` and therefore renderable/testable.
 *
 * Every function here is pure with respect to module state: no module-level mutable
 * variables, only frozen constants.
 */

import { rng } from '@platform/shared';
import type {
  CueGraph,
  Env,
  FilterSweep,
  MetalSpec,
  NoiseSpec,
  ShimmerSpec,
  SwellSpec,
  ThumpSpec,
  ToneSpec,
} from './contract.js';
import { MINOR_STEPS } from './config.js';

/** WebAudio forbids `exponentialRampToValueAtTime` targeting exactly 0 (it throws). */
const EPS_GAIN = 0.0001;

/** Floors every automation segment above zero so ramps never collapse to zero length. */
const MIN_SEG_S = 0.0001;

/**
 * WebAudio throws a RangeError on any NEGATIVE absolute schedule time. Callers legitimately
 * compute `at + jitter` where `jitter` can be negative (timing variation, SONIC_BIBLE §7);
 * in an isolated render `at` can be exactly `ctx.currentTime === 0`, so that sum goes
 * negative. Every scheduling primitive below normalises its incoming `at` (and therefore
 * every time derived from it) through this before making a single AudioParam/start/stop
 * call, so a formerly-throwing call now schedules at 0 instead of silently aborting the
 * whole synchronous cue function. A negative absolute time is never valid, so this is a
 * normalisation, not a workaround.
 */
function t0(at: number): number {
  return Math.max(0, at);
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** dB -> linear gain. */
export function db(v: number): number {
  return 10 ** (v / 20);
}

/** Seeded symmetric jitter: returns `base * (1 +/- pct)`. */
export function jitter(g: CueGraph, base: number, pct: number): number {
  const spread = g.rnd() * 2 - 1;
  return base * (1 + spread * pct);
}

/** Seeded jitter in dB, returns a LINEAR gain multiplier for +/- `dbRange`. */
export function jitterDb(g: CueGraph, dbRange: number): number {
  const offsetDb = (g.rnd() * 2 - 1) * dbRange;
  return db(offsetDb);
}

/** Pick a scale degree: root * MINOR_STEPS[degree mod 7] * 2^octave, wrapping correctly. */
export function degree(root: number, deg: number, octave: number): number {
  const span = MINOR_STEPS.length;
  const octaveOffset = Math.floor(deg / span);
  const idx = deg - octaveOffset * span;
  // `idx` is always in [0, span) by construction (a floor-divide remainder against a
  // positive span), and MINOR_STEPS always has exactly `span` entries, so this index
  // access can never actually be undefined. The `?? 1` keeps noUncheckedIndexedAccess
  // satisfied without asserting the type away.
  const step = MINOR_STEPS[idx] ?? 1;
  return root * step * 2 ** (octave + octaveOffset);
}

/**
 * Apply an ADSR to a GainNode's gain param starting at `at`. Attack uses a linear ramp;
 * decay and release use exponential ramps, floored at `EPS_GAIN` (never literally 0, which
 * throws). Returns the envelope end time.
 */
export function applyEnv(param: AudioParam, at: number, env: Env, scale: number): number {
  const start = t0(at);
  const peakVal = Math.max(EPS_GAIN, env.peak * scale);
  const sustainVal = Math.max(EPS_GAIN, env.peak * env.sustain * scale);

  // Every subsequent time is `start` plus a non-negative duration, so once `start` itself
  // is clamped, attackEnd/decayEnd/releaseEnd can never go negative either.
  const attackEnd = start + Math.max(env.attack, MIN_SEG_S);
  const decayEnd = attackEnd + Math.max(env.decay, MIN_SEG_S);
  const releaseEnd = decayEnd + Math.max(env.release, MIN_SEG_S);

  param.cancelScheduledValues(start);
  param.setValueAtTime(EPS_GAIN, start);
  param.linearRampToValueAtTime(peakVal, attackEnd);
  param.exponentialRampToValueAtTime(sustainVal, decayEnd);
  param.exponentialRampToValueAtTime(EPS_GAIN, releaseEnd);

  return releaseEnd;
}

/**
 * Shared `FilterSweep` handling for `tone`/`metal`/`shimmer`. Inserts a 12 dB/oct lowpass
 * (the standard order of a WebAudio BiquadFilterNode) when any of the three fields is
 * present, ramping `filterHz -> sweepHz` over `sweepTime`. Absent fields default sensibly
 * (`filterHz` = Nyquist, `sweepTime` = envelope length). All three absent = no filter node.
 * `swell` does not use this helper: its filter is mandatory (`openHz` is the start point),
 * not optional.
 */
function filterSweep(
  ctx: BaseAudioContext,
  at: number,
  sweep: FilterSweep,
  envLength: number,
): BiquadFilterNode | null {
  if (
    sweep.filterHz === undefined &&
    sweep.sweepHz === undefined &&
    sweep.sweepTime === undefined
  ) {
    return null;
  }
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = Math.SQRT1_2;
  const nyquist = ctx.sampleRate / 2;
  const startHz = sweep.filterHz ?? nyquist;
  const start = t0(at);
  filter.frequency.setValueAtTime(startHz, start);
  if (sweep.sweepHz !== undefined) {
    const sweepTime = Math.max(sweep.sweepTime ?? envLength, MIN_SEG_S);
    filter.frequency.linearRampToValueAtTime(sweep.sweepHz, start + sweepTime);
  }
  return filter;
}

// ---------------------------------------------------------------------------
// Timbre archetypes (SONIC_BIBLE §4)
// ---------------------------------------------------------------------------

/** Oscillator voice with ADSR + optional glide + optional swept lowpass. */
export function tone(g: CueGraph, at: number, dest: AudioNode, spec: ToneSpec, gain: number): void {
  const ctx = g.ctx;
  const start = t0(at);
  const envLength = spec.env.attack + spec.env.decay + spec.env.release;

  const osc = ctx.createOscillator();
  osc.type = spec.type;
  osc.frequency.setValueAtTime(spec.hz, start);
  if (spec.glideHz !== undefined) {
    const glideTime = Math.max(spec.glideTime ?? envLength, MIN_SEG_S);
    osc.frequency.linearRampToValueAtTime(spec.glideHz, start + glideTime);
  }
  osc.detune.value = spec.detune ?? 0;

  const filter = filterSweep(ctx, start, spec, envLength);
  const env = ctx.createGain();

  osc.connect(filter ?? env);
  if (filter) filter.connect(env);
  env.connect(dest);

  const endTime = applyEnv(env.gain, start, spec.env, gain);
  osc.start(start);
  osc.stop(endTime);
  osc.onended = (): void => {
    osc.disconnect();
    filter?.disconnect();
    env.disconnect();
  };
}

/** Filtered burst from the shared seeded noise buffer, with optional filter sweep. */
export function noise(g: CueGraph, at: number, dest: AudioNode, spec: NoiseSpec, gain: number): void {
  const ctx = g.ctx;
  const start = t0(at);
  const envLength = spec.env.attack + spec.env.decay + spec.env.release;

  const src = ctx.createBufferSource();
  src.buffer = g.noise;
  // required for any dur > the 1s noise buffer — the envelope, not the buffer length,
  // bounds the layer (structure-collapse sweeps and debris tails run 1.5-3.0 s).
  src.loop = true;
  src.loopEnd = g.noise.duration;

  const filter = ctx.createBiquadFilter();
  filter.type = spec.filter;
  filter.frequency.setValueAtTime(spec.hz, start);
  filter.Q.value = spec.q ?? 1;
  if (spec.sweepHz !== undefined) {
    const sweepTime = Math.max(spec.sweepTime ?? envLength, MIN_SEG_S);
    filter.frequency.linearRampToValueAtTime(spec.sweepHz, start + sweepTime);
  }

  const env = ctx.createGain();
  src.connect(filter);
  filter.connect(env);
  env.connect(dest);

  const endTime = applyEnv(env.gain, start, spec.env, gain);
  src.start(start);
  src.stop(endTime);
  src.onended = (): void => {
    src.disconnect();
    filter.disconnect();
    env.disconnect();
  };
}

/** Sine sub with a fast downward pitch envelope. The weight archetype. */
export function thump(g: CueGraph, at: number, dest: AudioNode, spec: ThumpSpec, gain: number): void {
  const ctx = g.ctx;
  const start = t0(at);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(spec.hz, start);
  const dropTime = Math.max(spec.dropTime, MIN_SEG_S);
  osc.frequency.exponentialRampToValueAtTime(Math.max(spec.dropHz, EPS_GAIN), start + dropTime);

  const env = ctx.createGain();
  osc.connect(env);
  env.connect(dest);

  const envEnd = applyEnv(env.gain, start, spec.env, gain);
  const stopAt = Math.max(envEnd, start + dropTime);
  osc.start(start);
  osc.stop(stopAt);
  osc.onended = (): void => {
    osc.disconnect();
    env.disconnect();
  };
}

/** Inharmonic partial stack through a bandpass. Steel, armour, structures. */
export function metal(g: CueGraph, at: number, dest: AudioNode, spec: MetalSpec, gain: number): void {
  const ctx = g.ctx;
  const start = t0(at);
  const envLength = spec.env.attack + spec.env.decay + spec.env.release;

  const mix = ctx.createGain();
  mix.gain.value = 1 / Math.max(spec.ratios.length, 1);

  const oscillators: OscillatorNode[] = [];
  for (const ratio of spec.ratios) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(spec.hz * ratio, start);
    osc.connect(mix);
    oscillators.push(osc);
  }

  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.setValueAtTime(spec.bandHz, start);
  band.Q.value = spec.q;

  const sweep = filterSweep(ctx, start, spec, envLength);
  const env = ctx.createGain();

  mix.connect(band);
  band.connect(sweep ?? env);
  if (sweep) sweep.connect(env);
  env.connect(dest);

  const endTime = applyEnv(env.gain, start, spec.env, gain);
  const cleanup = (): void => {
    for (const osc of oscillators) osc.disconnect();
    mix.disconnect();
    band.disconnect();
    sweep?.disconnect();
    env.disconnect();
  };
  for (const osc of oscillators) {
    osc.start(start);
    osc.stop(endTime);
    osc.onended = cleanup;
  }
}

/** Ring-mod / FM pair with a long filtered tail. Arcane magic only, `high` register only. */
export function shimmer(
  g: CueGraph,
  at: number,
  dest: AudioNode,
  spec: ShimmerSpec,
  gain: number,
): void {
  const ctx = g.ctx;
  const start = t0(at);
  const envLength = spec.env.attack + spec.env.decay + spec.env.release;

  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.setValueAtTime(spec.hz, start);

  const modulator = ctx.createOscillator();
  modulator.type = 'sine';
  modulator.frequency.setValueAtTime(spec.modHz, start);

  const modDepth = ctx.createGain();
  modDepth.gain.value = spec.index;

  // True ring modulation: the modulator drives the ring gain's `gain` AudioParam, so the
  // carrier's output is multiplied by `index * sin(modHz * t)`.
  const ring = ctx.createGain();
  ring.gain.setValueAtTime(0, start);
  modulator.connect(modDepth);
  modDepth.connect(ring.gain);
  carrier.connect(ring);

  const tail = ctx.createBiquadFilter();
  tail.type = 'lowpass';
  tail.frequency.setValueAtTime(spec.tailHz, start);

  const sweep = filterSweep(ctx, start, spec, envLength);
  const env = ctx.createGain();

  ring.connect(tail);
  tail.connect(sweep ?? env);
  if (sweep) sweep.connect(env);
  env.connect(dest);

  const endTime = applyEnv(env.gain, start, spec.env, gain);
  carrier.start(start);
  carrier.stop(endTime);
  modulator.start(start);
  modulator.stop(endTime);

  const cleanup = (): void => {
    carrier.disconnect();
    modulator.disconnect();
    modDepth.disconnect();
    ring.disconnect();
    tail.disconnect();
    sweep?.disconnect();
    env.disconnect();
  };
  carrier.onended = cleanup;
  modulator.onended = cleanup;
}

/** Slow-attack detuned cluster. Ultimates, objectives, music pads. */
export function swell(g: CueGraph, at: number, dest: AudioNode, spec: SwellSpec, gain: number): void {
  const ctx = g.ctx;
  const start = t0(at);
  const envLength = spec.env.attack + spec.env.decay + spec.env.release;

  const mix = ctx.createGain();
  const voiceCount = Math.max(spec.voices, 1);
  mix.gain.value = 1 / voiceCount;

  const oscillators: OscillatorNode[] = [];
  for (let i = 0; i < voiceCount; i++) {
    const osc = ctx.createOscillator();
    osc.type = spec.type;
    const spread =
      voiceCount > 1 ? -spec.spreadCents / 2 + (spec.spreadCents * i) / (voiceCount - 1) : 0;
    osc.detune.value = spread;
    osc.frequency.setValueAtTime(spec.hz, start);
    osc.connect(mix);
    oscillators.push(osc);
  }

  // The swell's filter is not optional — the opening/closing filter IS the archetype.
  // `openHz` is the start point; `FilterSweep.sweepHz` (if present) is where it moves to.
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(spec.openHz, start);
  if (spec.sweepHz !== undefined) {
    const sweepTime = Math.max(spec.sweepTime ?? envLength, MIN_SEG_S);
    filter.frequency.linearRampToValueAtTime(spec.sweepHz, start + sweepTime);
  }

  const env = ctx.createGain();
  mix.connect(filter);
  filter.connect(env);
  env.connect(dest);

  const endTime = applyEnv(env.gain, start, spec.env, gain);
  const cleanup = (): void => {
    for (const osc of oscillators) osc.disconnect();
    mix.disconnect();
    filter.disconnect();
    env.disconnect();
  };
  for (const osc of oscillators) {
    osc.start(start);
    osc.stop(endTime);
    osc.onended = cleanup;
  }
}

// ---------------------------------------------------------------------------
// Shared buffers (noise, impulse responses) and the limiter curve
// ---------------------------------------------------------------------------

/** Build the shared 1s seeded white-noise buffer. Called once by the engine. */
export function makeNoiseBuffer(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.round(sampleRate * 1);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const next = rng(seed);
  for (let i = 0; i < length; i++) {
    data[i] = next() * 2 - 1;
  }
  return buffer;
}

/** Generate a decaying, damped STEREO impulse response. Called once per IR by the engine. */
export function makeImpulse(
  ctx: BaseAudioContext,
  seed: number,
  spec: { seconds: number; decay: number; dampHz: number; preDelayS: number },
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const totalLength = Math.max(1, Math.round(sampleRate * spec.seconds));
  const preDelaySamples = Math.min(
    totalLength,
    Math.max(0, Math.round(sampleRate * spec.preDelayS)),
  );
  const tailLength = Math.max(1, totalLength - preDelaySamples);

  const buffer = ctx.createBuffer(2, totalLength, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  // Two independent seeded streams so L and R are decorrelated but still deterministic.
  const nextL = rng(seed);
  const nextR = rng((seed ^ 0x9e3779b9) >>> 0);

  // One-pole lowpass coefficient at `dampHz`, applied across the whole tail.
  const a = Math.exp((-2 * Math.PI * spec.dampHz) / sampleRate);
  let lpL = 0;
  let lpR = 0;

  for (let i = 0; i < preDelaySamples; i++) {
    left[i] = 0;
    right[i] = 0;
  }
  for (let i = 0; i < tailLength; i++) {
    const rawL = nextL() * 2 - 1;
    const rawR = nextR() * 2 - 1;
    lpL = lpL * a + rawL * (1 - a);
    lpR = lpR * a + rawR * (1 - a);
    const t = i / sampleRate;
    const decayEnv = Math.exp((-spec.decay * t) / spec.seconds);
    left[preDelaySamples + i] = lpL * decayEnv;
    right[preDelaySamples + i] = lpR * decayEnv;
  }

  return buffer;
}

/** Soft-clip curve for the limiter WaveShaper. `ceilingDb` is a SAMPLE-domain asymptote. */
export function makeLimiterCurve(ceilingDb: number): Float32Array<ArrayBuffer> {
  const points = 2049;
  // Back the array with an explicit `ArrayBuffer` (never `ArrayBufferLike`/`SharedArrayBuffer`)
  // so the return type is concretely `Float32Array<ArrayBuffer>`, matching what
  // `WaveShaperNode.curve` requires — relying on `new Float32Array(points)` alone widens to
  // `Float32Array<ArrayBufferLike>` and fails that assignment at every consumer.
  const curve = new Float32Array(new ArrayBuffer(points * Float32Array.BYTES_PER_ELEMENT));
  const ceiling = db(ceilingDb);
  // Drive pushes the tanh saturation well before the edges of the [-1, 1] domain so the
  // curve genuinely asymptotes toward `ceiling` rather than merely reaching ~0.76 of it.
  const drive = 3;
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = ceiling * Math.tanh(drive * x);
  }
  return curve;
}
