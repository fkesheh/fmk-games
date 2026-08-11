// ============================================================================
// SKI SPLAT client — WebAudio synth (structure cloned from kart audio.ts; no
// audio asset files, everything is synthesized). Voices:
//   wind  — CONTINUOUS looped filtered noise, gain follows speedFrac^2: tucked
//           quiet at the start gate, roaring at terminal speed. Bandpass opens
//           with speed so the character brightens as you accelerate.
//   carve — a SECOND continuous noise voice with a different filter character
//           (higher, tighter bandpass — skis hissing on edge, not wind), gated
//           per frame by C2's |steer| x v-scaled amount. Never retriggered.
//   rustle/beep/go/finish/sting/whoosh — one-shots: plant hit (leafy noise
//           burst + soft thud), countdown beep, brighter/higher GO, a short
//           fanfare arpeggio on the finish line, a results sting, and the
//           slalom-gate whoosh (a fast airy sweep UP — a clean pass has no
//           thud, and the rising band is the inverse of rustle's falling one).
// Both looped voices share the ONE seeded noise buffer (rng(0x5eed) —
// Math.random is a contract violation) at detuned playbackRates so they never
// phase-lock. All per-frame param moves go through setTargetAtTime (cheap,
// click-free). One-shots take an optional distance in meters with a smooth
// 1/(1+d/12) gain curve for remote players' events. A DynamicsCompressor sits
// between master and destination as glue so stacked one-shots never clip.
// resume() creates/unlocks the AudioContext on a user gesture and is
// idempotent; every method is a safe silent no-op before/without a context,
// and no exception ever escapes — audio must never crash the client.
// ============================================================================
import { rng } from '@platform/shared';

export type SplatSfx = 'rustle' | 'beep' | 'go' | 'finish' | 'sting' | 'whoosh';

/** Optional per-call sfx modifiers; distance is in meters. */
export interface SplatSfxOpts {
  readonly distance?: number;
}

// ---- tuning constants -------------------------------------------------------
const MASTER_GAIN = 0.5;
const ENV_FLOOR = 0.0001; // exponential ramps may never target 0
const NOISE_SEED = 0x5eed; // shared noise buffer fill (same stream as kart/fps)
const WIND_LEVEL = 0.11; // wind gain at terminal speed (rises with speed^2)
const WIND_BASE_HZ = 420; // bandpass center at the gate
const WIND_SPAN_HZ = 2100; // bandpass center sweep across full speed
const WIND_SMOOTH_S = 0.12; // wind follows speed smoothly, never clicks
const CARVE_LEVEL = 0.2; // carve hiss at full edge
const CARVE_BASE_HZ = 1600; // ski-on-edge band center (vs wind's low airy band)
const CARVE_SPAN_HZ = 1000; // band rises a little as the bite hardens
const CARVE_Q = 1.9; // tighter, narrower band than wind — hiss, not roar
const CARVE_LOOP_RATE = 1.09; // playbackRate detune: de-phases vs the wind loop
const CARVE_SMOOTH_S = 0.04; // carve responds fast but click-free
const DISTANCE_REF_M = 12; // remote sfx gain = 1/(1 + distance/12)
const COMP_THRESHOLD_DB = -12; // glue compressor: catches one-shot stacking
const COMP_KNEE_DB = 18;
const COMP_RATIO = 4;
const COMP_ATTACK_S = 0.003;
const COMP_RELEASE_S = 0.24;

/**
 * Remote-event gain for a distance in meters: 1/(1 + d/12) — smooth, never 0.
 * Undefined/negative distance means "own event": full gain. Pure and exported
 * so the curve is unit-testable headless.
 */
export function distanceGain(distance?: number): number {
  if (distance === undefined) return 1;
  const d = distance > 0 ? distance : 0;
  return 1 / (1 + d / DISTANCE_REF_M);
}

interface BeepOpts {
  type: OscillatorType; f0: number; f1?: number;
  t0: number; dur: number; peak: number;
}

interface BurstOpts {
  type: BiquadFilterType; f0: number; f1?: number; q?: number;
  t0: number; dur: number; peak: number;
  attack?: number; // seconds to swell to peak (default 0.005 — near-instant)
}

/** Persistent per-frame voices, built once and gated by gain thereafter. */
interface SplatRig {
  windFlt: BiquadFilterNode;
  windGain: GainNode;
  carveFlt: BiquadFilterNode;
  carveGain: GainNode;
}

export class SplatAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  // continuous voices: built lazily on the first wind()/carve() call and kept
  // alive; on/off just gates the gains (an AudioBufferSourceNode may only be
  // started once)
  private rig: SplatRig | null = null;

  /** Create/unlock the AudioContext. Called on every user gesture; idempotent. */
  resume(): void {
    try {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') void this.ctx.resume();
        return;
      }
      if (typeof window === 'undefined') return; // headless: stay a no-op
      const Ctor: typeof AudioContext | undefined = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return; // no WebAudio — everything stays a silent no-op
      let ctx: AudioContext;
      try {
        ctx = new Ctor();
      } catch {
        return; // construction can throw (policy, device) — stay silent
      }
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = MASTER_GAIN;
      // glue compressor between master and destination: stacked one-shots over
      // the wind voice (rustle + GO at terminal speed) must not clip
      try {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = COMP_THRESHOLD_DB;
        comp.knee.value = COMP_KNEE_DB;
        comp.ratio.value = COMP_RATIO;
        comp.attack.value = COMP_ATTACK_S;
        comp.release.value = COMP_RELEASE_S;
        this.master.connect(comp);
        comp.connect(ctx.destination);
      } catch {
        this.master.connect(ctx.destination); // no glue, still sound
      }
      // shared 1s white-noise buffer, seeded (determinism rule; reused by all bursts)
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = buf.getChannelData(0);
      const next = rng(NOISE_SEED);
      for (let i = 0; i < data.length; i++) data[i] = next() * 2 - 1;
      this.noiseBuf = buf;
      if (ctx.state === 'suspended') void ctx.resume();
    } catch {
      // audio must never crash the client (contract robustness rule)
    }
  }

  /**
   * Continuous wind voice. Called EVERY FRAME from the drive loop with the
   * speed fraction (0..1 of MAX_SPEED): gain follows speedFrac^2 — tucked
   * quiet at the gate, roaring at terminal — and the bandpass opens with
   * speed. All moves go through setTargetAtTime (click-free).
   */
  wind(speedFrac: number): void {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return;
    const frac = speedFrac < 0 ? 0 : speedFrac > 1 ? 1 : speedFrac;
    try {
      if (!this.rig) this.rig = this.buildRig(ctx, master, nbuf);
      const rig = this.rig;
      const t = ctx.currentTime;
      rig.windFlt.frequency.setTargetAtTime(WIND_BASE_HZ + frac * WIND_SPAN_HZ, t, WIND_SMOOTH_S);
      rig.windGain.gain.setTargetAtTime(WIND_LEVEL * frac * frac, t, WIND_SMOOTH_S);
    } catch {
      // audio must never crash the client (contract robustness rule)
    }
  }

  /**
   * Continuous carve voice (skis on edge). Called EVERY FRAME with the amount
   * C2 computes (|steer| x v-scaled, 0..1): the gate follows the amount and
   * the tight band rises a little as the edge bites harder. Same persistent
   * rig as the wind — gated, never retriggered.
   */
  carve(amount: number): void {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return;
    const a = amount < 0 ? 0 : amount > 1 ? 1 : amount;
    try {
      if (!this.rig) this.rig = this.buildRig(ctx, master, nbuf);
      const rig = this.rig;
      const t = ctx.currentTime;
      rig.carveFlt.frequency.setTargetAtTime(CARVE_BASE_HZ + a * CARVE_SPAN_HZ, t, CARVE_SMOOTH_S);
      rig.carveGain.gain.setTargetAtTime(CARVE_LEVEL * a, t, CARVE_SMOOTH_S);
    } catch {
      // audio must never crash the client (contract robustness rule)
    }
  }

  /**
   * One-shot effect. No-op until resume() has run and the context is running.
   * opts.distance (meters) scales the gain by 1/(1 + d/12) for remote players'
   * events (a distant rival's rustle) — optional, ignored where irrelevant.
   */
  sfx(kind: SplatSfx, opts?: SplatSfxOpts): void {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    const dm = distanceGain(opts?.distance);
    try {
      switch (kind) {
        case 'rustle': {
          // plant hit: leafy noise burst (high band sliding down through the
          // foliage) + a soft low thud for the body of the impact
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 2400, f1: 900, q: 0.9, t0, dur: 0.16, peak: 0.34 }, dm);
          this.beep(ctx, master, { type: 'sine', f0: 130, f1: 55, t0, dur: 0.13, peak: 0.42 }, dm);
          break;
        }
        case 'beep': // countdown 3-2-1: 880Hz, 100ms
          this.beep(ctx, master, { type: 'sine', f0: 880, t0, dur: 0.1, peak: 0.32 }, dm);
          break;
        case 'go': // GO: brighter and higher than the countdown beeps
          this.beep(ctx, master, { type: 'triangle', f0: 1567.98, t0, dur: 0.3, peak: 0.34 }, dm);
          this.beep(ctx, master, { type: 'sine', f0: 3135.96, t0, dur: 0.22, peak: 0.1 }, dm);
          break;
        case 'finish': {
          // short fanfare arpeggio: C5-E5-G5-C6 climbing over the line
          this.beep(ctx, master, { type: 'triangle', f0: 523.25, t0, dur: 0.14, peak: 0.3 }, dm);
          this.beep(ctx, master, { type: 'triangle', f0: 659.25, t0: t0 + 0.11, dur: 0.14, peak: 0.3 }, dm);
          this.beep(ctx, master, { type: 'triangle', f0: 783.99, t0: t0 + 0.22, dur: 0.14, peak: 0.3 }, dm);
          this.beep(ctx, master, { type: 'triangle', f0: 1046.5, t0: t0 + 0.33, dur: 0.42, peak: 0.34 }, dm);
          break;
        }
        case 'sting': // results panel: a warm two-chord sting, no shame in it
          this.beep(ctx, master, { type: 'sine', f0: 392, t0, dur: 0.5, peak: 0.2 }, dm);
          this.beep(ctx, master, { type: 'sine', f0: 523.25, t0: t0 + 0.02, dur: 0.5, peak: 0.2 }, dm);
          this.beep(ctx, master, { type: 'triangle', f0: 659.25, t0: t0 + 0.24, dur: 0.7, peak: 0.24 }, dm);
          break;
        case 'whoosh': {
          // gate pass: air ripping past the ears for a beat — a fast airy
          // noise sweep UP through a wide band (the inverse of rustle's fall),
          // plus a thin highpass shimmer on top. No body thud: a pass is
          // clean. Distinct from the wind voice, which is continuous, lower
          // and never sweeps this fast.
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 700, f1: 3400, q: 1.1, t0, dur: 0.24, peak: 0.3, attack: 0.03 }, dm);
          this.burst(ctx, nbuf, master, { type: 'highpass', f0: 2600, f1: 5200, q: 0.7, t0: t0 + 0.02, dur: 0.16, peak: 0.12, attack: 0.02 }, dm);
          break;
        }
      }
    } catch {
      // audio must never crash the client (contract robustness rule)
    }
  }

  // ---- synth primitives ------------------------------------------------------

  /**
   * Build both persistent voices once (first wind()/carve() call):
   *   wind:  looped noise(1.0x)  -> wide low bandpass -> gate -> master
   *   carve: looped noise(1.09x) -> tight high bandpass -> gate -> master
   * The detuned playbackRates keep the two loops from phase-locking to the
   * same 1s buffer. Every voice starts exactly once and lives for the session.
   */
  private buildRig(ctx: AudioContext, master: GainNode, nbuf: AudioBuffer): SplatRig {
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = nbuf;
    windSrc.loop = true;
    windSrc.playbackRate.value = 1;
    const windFlt = ctx.createBiquadFilter();
    windFlt.type = 'bandpass';
    windFlt.Q.value = 0.5;
    windFlt.frequency.value = WIND_BASE_HZ;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    windSrc.connect(windFlt);
    windFlt.connect(windGain);
    windGain.connect(master);
    // carve hiss: the same noise at a detuned rate through a tighter, higher band
    const carveSrc = ctx.createBufferSource();
    carveSrc.buffer = nbuf;
    carveSrc.loop = true;
    carveSrc.playbackRate.value = CARVE_LOOP_RATE;
    const carveFlt = ctx.createBiquadFilter();
    carveFlt.type = 'bandpass';
    carveFlt.Q.value = CARVE_Q;
    carveFlt.frequency.value = CARVE_BASE_HZ;
    const carveGain = ctx.createGain();
    carveGain.gain.value = 0;
    carveSrc.connect(carveFlt);
    carveFlt.connect(carveGain);
    carveGain.connect(master);
    windSrc.start();
    carveSrc.start();
    return { windFlt, windGain, carveFlt, carveGain };
  }

  /** Oscillator with fast-attack / exponential-decay envelope into master. */
  private beep(ctx: AudioContext, master: GainNode, o: BeepOpts, mul = 1): void {
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.f0, o.t0);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(o.f1, o.t0 + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(ENV_FLOOR, o.t0);
    g.gain.exponentialRampToValueAtTime(Math.max(o.peak * mul, ENV_FLOOR), o.t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(ENV_FLOOR, o.t0 + o.dur);
    osc.connect(g);
    g.connect(master);
    osc.start(o.t0);
    osc.stop(o.t0 + o.dur + 0.02);
  }

  /** Filtered noise burst (from the shared buffer) with the same envelope. */
  private burst(ctx: AudioContext, nbuf: AudioBuffer, master: GainNode, o: BurstOpts, mul = 1): void {
    const src = ctx.createBufferSource();
    src.buffer = nbuf;
    const flt = ctx.createBiquadFilter();
    flt.type = o.type;
    flt.frequency.setValueAtTime(o.f0, o.t0);
    if (o.f1 !== undefined) flt.frequency.exponentialRampToValueAtTime(o.f1, o.t0 + o.dur);
    flt.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(ENV_FLOOR, o.t0);
    g.gain.exponentialRampToValueAtTime(Math.max(o.peak * mul, ENV_FLOOR), o.t0 + (o.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(ENV_FLOOR, o.t0 + o.dur);
    src.connect(flt);
    flt.connect(g);
    g.connect(master);
    src.start(o.t0);
    src.stop(o.t0 + o.dur + 0.02);
  }
}
