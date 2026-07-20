// ============================================================================
// KART client — WebAudio synth (KART.md: engine by speed, skid, barrier thud,
// turbo whoosh, countdown beeps + go, finish stinger). Pure synthesis:
// oscillators + ONE shared seeded-noise buffer, envelopes + filters. No audio
// asset files. Everything is a safe no-op until resume() creates the
// AudioContext on a user gesture (browser autoplay policy). Noise comes from
// rng(seed) — Math.random is a contract violation everywhere.
// ============================================================================
import { rng } from '@platform/shared';

export type KartSfx = 'engine' | 'skid' | 'thud' | 'turbo' | 'beep' | 'go' | 'finish';

// ---- tuning constants -------------------------------------------------------
const MASTER_GAIN = 0.5;
const ENV_FLOOR = 0.0001; // exponential ramps may never target 0
const NOISE_SEED = 0x5eed; // shared noise buffer fill (same stream as fps/bank)
const ENGINE_IDLE_HZ = 60; // puttering at a standstill
const ENGINE_TOP_HZ = 220; // redline at TOP_SPEED
const ENGINE_LEVEL = 0.16; // base engine gain when on
const ENGINE_SMOOTH_S = 0.06; // setTargetAtTime constant: per-frame calls stay cheap

interface BeepOpts {
  type: OscillatorType; f0: number; f1?: number;
  t0: number; dur: number; peak: number;
}

interface BurstOpts {
  type: BiquadFilterType; f0: number; f1?: number; q?: number;
  t0: number; dur: number; peak: number; loop?: boolean;
}

export class KartAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  // continuous engine voice: saw osc -> lowpass -> gain, built lazily on first
  // engine() call and kept alive; on/off just gates the gain (idempotent, and
  // an OscillatorNode may only be started once)
  private engOsc: OscillatorNode | null = null;
  private engFlt: BiquadFilterNode | null = null;
  private engGain: GainNode | null = null;
  private engOn = false;

  /** Create/unlock the AudioContext. Called on first user gesture; idempotent. */
  resume(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor: typeof AudioContext | undefined = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // no WebAudio — engine stays a no-op
    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return; // construction can throw (policy, device) — stay silent
    }
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = MASTER_GAIN;
    this.master.connect(ctx.destination);
    // shared 1s white-noise buffer, seeded (determinism rule; reused by all bursts)
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    const next = rng(NOISE_SEED);
    for (let i = 0; i < data.length; i++) data[i] = next() * 2 - 1;
    this.noiseBuf = buf;
    if (ctx.state === 'suspended') void ctx.resume();
  }

  /**
   * Continuous engine synth. Called EVERY FRAME from the drive loop: all
   * parameter moves go through setTargetAtTime (cheap, click-free), and
   * start/stop is idempotent — on just gates the gain of one persistent voice.
   * speedFrac is 0..1 of TOP_SPEED; pitch runs idle ~60Hz to ~220Hz.
   */
  engine(speedFrac: number, on: boolean): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || ctx.state !== 'running') return;
    const frac = speedFrac < 0 ? 0 : speedFrac > 1 ? 1 : speedFrac;
    try {
      if (!this.engOsc || !this.engFlt || !this.engGain) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        const flt = ctx.createBiquadFilter();
        flt.type = 'lowpass';
        flt.Q.value = 1;
        const g = ctx.createGain();
        g.gain.value = 0;
        osc.connect(flt);
        flt.connect(g);
        g.connect(master);
        osc.start();
        this.engOsc = osc;
        this.engFlt = flt;
        this.engGain = g;
        this.engOn = false;
      }
      const t = ctx.currentTime;
      const hz = ENGINE_IDLE_HZ + frac * (ENGINE_TOP_HZ - ENGINE_IDLE_HZ);
      this.engOsc.frequency.setTargetAtTime(hz, t, ENGINE_SMOOTH_S);
      // muffled at idle, opens up with rpm
      this.engFlt.frequency.setTargetAtTime(300 + frac * 1800, t, ENGINE_SMOOTH_S);
      if (on !== this.engOn) {
        this.engOn = on;
        this.engGain.gain.setTargetAtTime(on ? ENGINE_LEVEL : 0, t, on ? 0.03 : 0.08);
      } else if (on) {
        // level swells slightly with rpm while running
        this.engGain.gain.setTargetAtTime(ENGINE_LEVEL * (0.7 + 0.5 * frac), t, ENGINE_SMOOTH_S);
      }
    } catch {
      // audio must never crash the client (contract robustness rule)
    }
  }

  /** One-shot effect. No-op until resume() has run and the context is running. */
  sfx(kind: KartSfx): void {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    try {
      switch (kind) {
        case 'engine': // the engine is continuous — drive it with engine()
          break;
        case 'skid': // tires sliding: ~200ms bandpassed noise, mid-high ring
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 900, q: 1.4, t0, dur: 0.2, peak: 0.4, loop: true });
          break;
        case 'thud': // barrier hit: low noise slam + low sine body
          this.burst(ctx, nbuf, master, { type: 'lowpass', f0: 220, t0, dur: 0.14, peak: 0.5 });
          this.beep(ctx, master, { type: 'sine', f0: 110, f1: 45, t0, dur: 0.16, peak: 0.5 });
          break;
        case 'turbo': // mini-turbo release: rising whoosh (bandpass sweep up)
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 500, f1: 3200, q: 1.2, t0, dur: 0.45, peak: 0.42, loop: true });
          this.beep(ctx, master, { type: 'sawtooth', f0: 180, f1: 540, t0, dur: 0.3, peak: 0.12 });
          break;
        case 'beep': // countdown 3-2-1: 880Hz, 100ms
          this.beep(ctx, master, { type: 'sine', f0: 880, t0, dur: 0.1, peak: 0.32 });
          break;
        case 'go': // GO: higher 1320Hz, 250ms
          this.beep(ctx, master, { type: 'sine', f0: 1320, t0, dur: 0.25, peak: 0.36 });
          break;
        case 'finish': // checker stinger: 2 ascending notes
          this.beep(ctx, master, { type: 'triangle', f0: 659.25, t0, dur: 0.16, peak: 0.32 });
          this.beep(ctx, master, { type: 'triangle', f0: 987.77, t0: t0 + 0.14, dur: 0.34, peak: 0.34 });
          break;
      }
    } catch {
      // audio must never crash the client (contract robustness rule)
    }
  }

  // ---- synth primitives ------------------------------------------------------

  /** Oscillator with fast-attack / exponential-decay envelope into master. */
  private beep(ctx: AudioContext, master: GainNode, o: BeepOpts): void {
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.f0, o.t0);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(o.f1, o.t0 + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(ENV_FLOOR, o.t0);
    g.gain.exponentialRampToValueAtTime(Math.max(o.peak, ENV_FLOOR), o.t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(ENV_FLOOR, o.t0 + o.dur);
    osc.connect(g);
    g.connect(master);
    osc.start(o.t0);
    osc.stop(o.t0 + o.dur + 0.02);
  }

  /** Filtered noise burst (from the shared buffer) with the same envelope. */
  private burst(ctx: AudioContext, nbuf: AudioBuffer, master: GainNode, o: BurstOpts): void {
    const src = ctx.createBufferSource();
    src.buffer = nbuf;
    src.loop = o.loop ?? false; // skid/turbo need >1s of noise: loop the 1s buffer
    const flt = ctx.createBiquadFilter();
    flt.type = o.type;
    flt.frequency.setValueAtTime(o.f0, o.t0);
    if (o.f1 !== undefined) flt.frequency.exponentialRampToValueAtTime(o.f1, o.t0 + o.dur);
    flt.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(ENV_FLOOR, o.t0);
    g.gain.exponentialRampToValueAtTime(Math.max(o.peak, ENV_FLOOR), o.t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(ENV_FLOOR, o.t0 + o.dur);
    src.connect(flt);
    flt.connect(g);
    g.connect(master);
    src.start(o.t0);
    src.stop(o.t0 + o.dur + 0.02);
  }
}
