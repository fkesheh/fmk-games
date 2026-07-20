// ============================================================================
// BANK client — tiny WebAudio synth (BANK.md: dice clatter, bank chime, bust
// thud, turn tick). Pure synthesis: oscillators + ONE shared seeded-noise
// buffer, envelopes + filters. No audio asset files. Everything is a safe
// no-op until resume() creates the AudioContext on a user gesture (browser
// autoplay policy). Noise + clatter variation come from rng(seed) —
// Math.random is a contract violation everywhere.
// ============================================================================
import { rng } from '@platform/shared';

export type BankSfx = 'clatter' | 'bank' | 'bust' | 'turn' | 'win' | 'lose';

// ---- tuning constants -------------------------------------------------------
const MASTER_GAIN = 0.5;
const ENV_FLOOR = 0.0001; // exponential ramps may never target 0
const NOISE_SEED = 0x5eed; // shared noise buffer fill (same stream as fps)
const CLATTER_SEED = 0xc1a77e; // per-clatter variation stream, reseeded per call

interface BeepOpts {
  type: OscillatorType; f0: number; f1?: number;
  t0: number; dur: number; peak: number;
}

interface BurstOpts {
  type: BiquadFilterType; f0: number; f1?: number; q?: number;
  t0: number; dur: number; peak: number;
}

export class BankAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private clatterCount = 0; // advances the deterministic clatter-variation stream

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

  /** One-shot effect. No-op until resume() has run and the context is running. */
  sfx(kind: BankSfx): void {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    try {
      switch (kind) {
        case 'clatter': { // 3-4 short noise taps: dice bouncing on felt
          // deterministic per-call variation (tap count, spacing, pitch) from a
          // reseeded stream — no two clatters identical, still no Math.random
          this.clatterCount = (this.clatterCount + 1) | 0;
          const next = rng(CLATTER_SEED ^ Math.imul(this.clatterCount, 2654435761));
          const taps = 3 + Math.floor(next() * 2);
          let t = t0;
          for (let i = 0; i < taps; i++) {
            // level note: filtered noise keeps only ~15% RMS of a same-peak
            // osc, so burst peaks sit well above the beep levels
            const f0 = 1600 + next() * 1800; // higher tap = die edge, lower = face
            const dur = 0.025 + next() * 0.02;
            const peak = 0.5 - i * 0.07; // each bounce lands softer
            this.burst(ctx, nbuf, master, { type: 'bandpass', f0, q: 1.1, t0: t, dur, peak });
            t += 0.045 + next() * 0.05; // bounce gaps settle like real dice
          }
          break;
        }
        case 'bank': // bright cash chime: 2 ascending notes (register cha-ching)
          this.beep(ctx, master, { type: 'triangle', f0: 987.77, t0, dur: 0.09, peak: 0.3 });
          this.beep(ctx, master, { type: 'triangle', f0: 1318.51, t0: t0 + 0.08, dur: 0.22, peak: 0.34 });
          this.beep(ctx, master, { type: 'sine', f0: 2637.02, t0: t0 + 0.08, dur: 0.14, peak: 0.1 }); // octave sparkle
          break;
        case 'bust': // low thud + descending groan: the pot dies
          this.beep(ctx, master, { type: 'sine', f0: 130, f1: 50, t0, dur: 0.18, peak: 0.55 });
          this.burst(ctx, nbuf, master, { type: 'lowpass', f0: 280, t0, dur: 0.12, peak: 0.25 });
          this.beep(ctx, master, { type: 'triangle', f0: 330, f1: 165, t0: t0 + 0.12, dur: 0.3, peak: 0.26 });
          break;
        case 'turn': // soft tick: your turn (two gentle taps, reads as a nudge)
          this.beep(ctx, master, { type: 'sine', f0: 1600, t0, dur: 0.03, peak: 0.18 });
          this.beep(ctx, master, { type: 'sine', f0: 2100, t0: t0 + 0.07, dur: 0.035, peak: 0.14 });
          break;
        case 'win': // rising 3-note
          this.beep(ctx, master, { type: 'triangle', f0: 523.25, t0, dur: 0.18, peak: 0.3 });
          this.beep(ctx, master, { type: 'triangle', f0: 659.25, t0: t0 + 0.14, dur: 0.18, peak: 0.3 });
          this.beep(ctx, master, { type: 'triangle', f0: 783.99, t0: t0 + 0.28, dur: 0.32, peak: 0.32 });
          break;
        case 'lose': // falling 2-note
          this.beep(ctx, master, { type: 'triangle', f0: 392, t0, dur: 0.28, peak: 0.3 });
          this.beep(ctx, master, { type: 'triangle', f0: 311.13, t0: t0 + 0.24, dur: 0.42, peak: 0.3 });
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
