// ============================================================================
// WORDBOMB client — tiny WebAudio synth. Pure synthesis (oscillators + ONE
// shared seeded-noise buffer, envelopes + filters). NO audio asset files.
//
// The voices, and why each exists:
//   fuse       — CONTINUOUS. A burning hiss bed (looped noise -> bandpass) plus
//                a tick train that ACCELERATES as the window elapses. The fuse
//                length is hidden (WORDBOMB.md §1.2 / I1) so the client drives
//                this from `progress` = elapsed / fuseMaxMs — it is the honest
//                worst case, and the boom can always land early. That mismatch
//                is the game.
//   accept     — soft blip: a valid word locked in (I3 "last valid wins").
//   reject     — dull thunk: refused. Deliberately unpitched and short so it
//                never reads as "you scored".
//   boom       — THE punctuation. Sub drop + body saw + wide noise blast +
//                crack transient + long scorch tail. Loudest thing in the game
//                by a wide margin; the glue compressor exists for this.
//   reveal     — per-answer tick during the reveal walk; `opts.index` steps the
//                pitch up the row so a long standings list reads as a run.
//   matchEnd   — the closing sting.
//
// Volume discipline mirrors games/bank/client/src/audio.ts: ONE master gain at
// MASTER_GAIN, every voice's peak expressed relative to it, exponential ramps
// that never target 0, and a DynamicsCompressor as glue between master and
// destination so a boom stacked over reveal ticks never clips.
//
// Everything is a safe no-op until resume() creates the AudioContext on a user
// gesture (browser autoplay policy), and every entry point is wrapped so audio
// can never crash the client. Noise comes from rng(seed) — Math.random is a
// contract violation everywhere.
//
// SEAM (client/src/game.ts, W5): construct once, call resume() on the first
// user gesture, then
//     audio.fuse(true, progress)  per frame while phase === 'live'
//     audio.stopFuse()            when the round closes
//     audio.sfx('accept' | 'reject' | 'boom' | 'matchEnd')
//     audio.sfx('reveal', { index })
//     audio.stop()                on teardown
// ============================================================================
import { rng } from '@platform/shared';

export type WordbombSfx = 'accept' | 'reject' | 'boom' | 'reveal' | 'matchEnd';

/** Optional per-call modifiers. All fields optional — `sfx(kind)` stays valid. */
export interface WbSfxOpts {
  /** reveal only: 0-based row index; steps the tick up a semitone ladder. */
  readonly index?: number;
}

// ---- tuning constants -------------------------------------------------------
const MASTER_GAIN = 0.5;
const ENV_FLOOR = 0.0001; // exponential ramps may never target 0
const NOISE_SEED = 0x5eed; // shared noise buffer fill (same stream as fps/bank/kart)

// glue compressor: catches the boom stacking over ticks/reveal blips
const COMP_THRESHOLD_DB = -10;
const COMP_KNEE_DB = 16;
const COMP_RATIO = 4;
const COMP_ATTACK_S = 0.003;
const COMP_RELEASE_S = 0.25;

// fuse bed
const FUSE_SMOOTH_S = 0.08; // setTargetAtTime constant: per-frame calls stay cheap
const FUSE_LOOP_RATE = 1.07; // playbackRate detune so the bed never phase-locks
const FUSE_HISS_LO_HZ = 700; // bandpass center at progress 0
const FUSE_HISS_SPAN_HZ = 1900; // ...sweeping up to 2600Hz as the fuse burns down
const FUSE_HISS_Q = 0.9;
const FUSE_HISS_LEVEL_LO = 0.030; // barely there at the start of the window
const FUSE_HISS_LEVEL_HI = 0.085; // audible urgency at the far end
const FUSE_FADE_S = 0.05; // hiss fade-out on stop: no click

// fuse tick train
const FUSE_TICK_SLOW_S = 0.46; // tick period at progress 0
const FUSE_TICK_FAST_S = 0.075; // tick period at progress 1 (exponential between)
const FUSE_LOOKAHEAD_S = 0.15; // schedule this far ahead of currentTime
const FUSE_TICK_MAX_PER_CALL = 8; // hard cap: a stalled tab must not dump a burst
const FUSE_TICK_LO_HZ = 880; // tick pitch at progress 0
const FUSE_TICK_HI_HZ = 1760; // ...one octave up by progress 1
const FUSE_TICK_PEAK_LO = 0.14;
const FUSE_TICK_PEAK_HI = 0.30;
const FUSE_TICK_DUR_S = 0.028;

// reveal ladder
const REVEAL_ROOT_HZ = 784; // G5
const REVEAL_STEPS = 12; // ladder wraps after an octave

interface BeepOpts {
  type: OscillatorType; f0: number; f1?: number;
  t0: number; dur: number; peak: number;
}

interface BurstOpts {
  type: BiquadFilterType; f0: number; f1?: number; q?: number;
  t0: number; dur: number; peak: number;
  attack?: number; // seconds to swell to peak (default 0.004 — near-instant)
  loop?: boolean; // required for any dur > the 1s noise buffer
}

/** The persistent fuse bed: built once, then gated by gain (a source may only start once). */
interface FuseRig {
  src: AudioBufferSourceNode;
  flt: BiquadFilterNode;
  gate: GainNode;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class WordbombAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private rig: FuseRig | null = null;
  private fuseOn = false;
  private nextTickAt = 0; // ctx time of the next scheduled fuse tick

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
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = COMP_THRESHOLD_DB;
    comp.knee.value = COMP_KNEE_DB;
    comp.ratio.value = COMP_RATIO;
    comp.attack.value = COMP_ATTACK_S;
    comp.release.value = COMP_RELEASE_S;
    master.connect(comp);
    comp.connect(ctx.destination);
    this.master = master;
    // shared 1s white-noise buffer, seeded (determinism rule; reused by every burst)
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    const next = rng(NOISE_SEED);
    for (let i = 0; i < data.length; i++) data[i] = next() * 2 - 1;
    this.noiseBuf = buf;
    if (ctx.state === 'suspended') void ctx.resume();
  }

  /**
   * The continuous fuse. Call every frame while the fuse burns.
   * `progress` is 0..1 across [roundStartedAt, roundStartedAt + fuseMaxMs] —
   * the honest worst case, since the real fuse is hidden (I1). Ticks accelerate
   * exponentially and the hiss bed opens up as it approaches 1.
   */
  fuse(on: boolean, progress: number): void {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return;
    try {
      if (!on) {
        this.gateFuseOff(ctx);
        return;
      }
      const p = clamp01(progress);
      const now = ctx.currentTime;
      const rig = this.ensureRig(ctx, master, nbuf);
      if (!this.fuseOn) {
        this.fuseOn = true;
        this.nextTickAt = now; // first tick lands immediately on (re)start
      }
      rig.flt.frequency.setTargetAtTime(FUSE_HISS_LO_HZ + FUSE_HISS_SPAN_HZ * p, now, FUSE_SMOOTH_S);
      rig.gate.gain.setTargetAtTime(
        FUSE_HISS_LEVEL_LO + (FUSE_HISS_LEVEL_HI - FUSE_HISS_LEVEL_LO) * p,
        now,
        FUSE_SMOOTH_S,
      );
      // exponential acceleration between the slow and fast tick periods
      const period = FUSE_TICK_SLOW_S * Math.pow(FUSE_TICK_FAST_S / FUSE_TICK_SLOW_S, p);
      // a backgrounded tab leaves nextTickAt far in the past — resync instead of
      // dumping every missed tick at once
      if (this.nextTickAt < now) this.nextTickAt = now;
      const horizon = now + FUSE_LOOKAHEAD_S;
      let scheduled = 0;
      while (this.nextTickAt <= horizon && scheduled < FUSE_TICK_MAX_PER_CALL) {
        const t = this.nextTickAt;
        const hz = FUSE_TICK_LO_HZ + (FUSE_TICK_HI_HZ - FUSE_TICK_LO_HZ) * p;
        const peak = FUSE_TICK_PEAK_LO + (FUSE_TICK_PEAK_HI - FUSE_TICK_PEAK_LO) * p;
        // pitched tap = the clock; the noise click on top = the spark
        this.beep(ctx, master, { type: 'square', f0: hz, f1: hz * 0.72, t0: t, dur: FUSE_TICK_DUR_S, peak: peak * 0.55 });
        this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 2600 + 1400 * p, q: 2.2, t0: t, dur: 0.016, peak: peak });
        this.nextTickAt = t + period;
        scheduled++;
      }
    } catch {
      // audio must never crash the client
    }
  }

  /** Silence the fuse bed and stop scheduling ticks. Idempotent. */
  stopFuse(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      this.gateFuseOff(ctx);
    } catch {
      // audio must never crash the client
    }
  }

  /** Silence everything continuous (teardown / navigating away). */
  stop(): void {
    this.stopFuse();
  }

  /** One-shot effect. No-op until resume() has run and the context is running. */
  sfx(kind: WordbombSfx, opts?: WbSfxOpts): void {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    try {
      switch (kind) {
        case 'accept': {
          // soft two-note blip, up a fifth: your word is in
          this.beep(ctx, master, { type: 'sine', f0: 880, t0, dur: 0.055, peak: 0.24 });
          this.beep(ctx, master, { type: 'sine', f0: 1318.51, t0: t0 + 0.045, dur: 0.13, peak: 0.20 });
          this.beep(ctx, master, { type: 'triangle', f0: 2637.02, t0: t0 + 0.045, dur: 0.07, peak: 0.05 }); // sparkle
          break;
        }
        case 'reject': {
          // dull unpitched thunk — a closed door, not a note
          this.beep(ctx, master, { type: 'sine', f0: 190, f1: 96, t0, dur: 0.13, peak: 0.42 });
          this.burst(ctx, nbuf, master, { type: 'lowpass', f0: 360, f1: 170, t0, dur: 0.11, peak: 0.30 });
          break;
        }
        case 'boom': {
          // THE punctuation. Five stacked layers; the fuse is cut underneath it.
          this.gateFuseOff(ctx);
          // 1. crack — the ignition transient, first 25ms, wide open
          this.burst(ctx, nbuf, master, { type: 'highpass', f0: 2600, f1: 900, t0, dur: 0.05, peak: 0.85 });
          // 2. blast — the body of the explosion, a huge downward-swept noise wall
          this.burst(ctx, nbuf, master, { type: 'lowpass', f0: 2400, f1: 180, q: 0.6, t0, dur: 0.85, peak: 0.95 });
          // 3. sub drop — the thing you feel; 130Hz collapsing to near-DC
          this.beep(ctx, master, { type: 'sine', f0: 130, f1: 26, t0, dur: 0.9, peak: 1.0 });
          // 4. body saw — grit between the sub and the noise so it reads as a bang
          this.beep(ctx, master, { type: 'sawtooth', f0: 220, f1: 42, t0, dur: 0.36, peak: 0.5 });
          // 5. scorch tail — long low rumble swelling in behind the blast
          this.burst(ctx, nbuf, master, {
            type: 'lowpass', f0: 300, f1: 90, q: 0.4,
            t0: t0 + 0.06, dur: 1.5, peak: 0.34, attack: 0.09, loop: true,
          });
          break;
        }
        case 'reveal': {
          // per-answer tick, walking up a semitone ladder across the standings
          const idx = opts?.index ?? 0;
          const step = Number.isFinite(idx) ? ((Math.trunc(idx) % REVEAL_STEPS) + REVEAL_STEPS) % REVEAL_STEPS : 0;
          const hz = REVEAL_ROOT_HZ * Math.pow(2, step / REVEAL_STEPS);
          this.beep(ctx, master, { type: 'triangle', f0: hz, t0, dur: 0.075, peak: 0.22 });
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: hz * 3, q: 3, t0, dur: 0.02, peak: 0.14 });
          break;
        }
        case 'matchEnd': {
          // closing sting: rising four-note over a low bloom
          this.beep(ctx, master, { type: 'sine', f0: 98, t0, dur: 1.1, peak: 0.34 });
          this.beep(ctx, master, { type: 'triangle', f0: 523.25, t0, dur: 0.2, peak: 0.30 });
          this.beep(ctx, master, { type: 'triangle', f0: 659.25, t0: t0 + 0.15, dur: 0.2, peak: 0.30 });
          this.beep(ctx, master, { type: 'triangle', f0: 783.99, t0: t0 + 0.30, dur: 0.22, peak: 0.31 });
          this.beep(ctx, master, { type: 'triangle', f0: 1046.5, t0: t0 + 0.45, dur: 0.55, peak: 0.34 });
          this.beep(ctx, master, { type: 'sine', f0: 2093, t0: t0 + 0.45, dur: 0.4, peak: 0.09 }); // octave sheen
          this.burst(ctx, nbuf, master, {
            type: 'bandpass', f0: 3600, q: 0.8, t0, dur: 0.5, peak: 0.10, attack: 0.16,
          });
          break;
        }
      }
    } catch {
      // audio must never crash the client (contract robustness rule)
    }
  }

  // ---- fuse rig ---------------------------------------------------------------

  private ensureRig(ctx: AudioContext, master: GainNode, nbuf: AudioBuffer): FuseRig {
    const existing = this.rig;
    if (existing) return existing;
    const src = ctx.createBufferSource();
    src.buffer = nbuf;
    src.loop = true;
    src.playbackRate.value = FUSE_LOOP_RATE;
    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.value = FUSE_HISS_LO_HZ;
    flt.Q.value = FUSE_HISS_Q;
    const gate = ctx.createGain();
    gate.gain.value = 0;
    src.connect(flt);
    flt.connect(gate);
    gate.connect(master);
    src.start();
    const rig: FuseRig = { src, flt, gate };
    this.rig = rig;
    return rig;
  }

  private gateFuseOff(ctx: AudioContext): void {
    this.fuseOn = false;
    this.nextTickAt = 0;
    const rig = this.rig;
    if (!rig) return;
    const now = ctx.currentTime;
    rig.gate.gain.cancelScheduledValues(now);
    rig.gate.gain.setValueAtTime(rig.gate.gain.value, now);
    rig.gate.gain.linearRampToValueAtTime(0, now + FUSE_FADE_S);
  }

  // ---- synth primitives ------------------------------------------------------

  /** Oscillator with fast-attack / exponential-decay envelope into master. */
  private beep(ctx: AudioContext, master: GainNode, o: BeepOpts): void {
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.f0, o.t0);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(o.f1, 1), o.t0 + o.dur);
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
    if (o.loop === true) src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = o.type;
    flt.frequency.setValueAtTime(o.f0, o.t0);
    if (o.f1 !== undefined) flt.frequency.exponentialRampToValueAtTime(Math.max(o.f1, 1), o.t0 + o.dur);
    flt.Q.value = o.q ?? 1;
    const attack = o.attack ?? 0.004;
    const g = ctx.createGain();
    g.gain.setValueAtTime(ENV_FLOOR, o.t0);
    g.gain.exponentialRampToValueAtTime(Math.max(o.peak, ENV_FLOOR), o.t0 + Math.min(attack, o.dur * 0.9));
    g.gain.exponentialRampToValueAtTime(ENV_FLOOR, o.t0 + o.dur);
    src.connect(flt);
    flt.connect(g);
    g.connect(master);
    src.start(o.t0);
    src.stop(o.t0 + o.dur + 0.02);
  }
}
