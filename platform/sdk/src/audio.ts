// ============================================================================
// SDK AUDIO — SynthKit: pure WebAudio synth (oscillators + ONE shared seeded
// noise buffer, envelopes + filters; zero samples — docs/PLATFORM.md §4.5).
// Style follows the house reference (games/fps/client/src/audio/audio.ts):
// everything is a safe no-op until resume() builds the AudioContext on a user
// gesture; noise is filled via rng(seed) — Math.random is a contract
// violation everywhere. Every one of the ten voices is a DISTINCT recipe and
// tuned to stay pleasant under high repetition.
// Owner: P7_SDK_INPUT_AUDIO.
// ============================================================================

import { rng } from '@platform/shared';
import type { AudioKit, SfxOpts, SfxVoice } from './types.js';

const MASTER_GAIN = 0.5;
const ENV_FLOOR = 0.0001; // exponential ramps may never target 0
const ATTACK_SEC = 0.005;
const XFADE_SEC = 0.5; // ambient bed crossfade seconds
const NOISE_SEED = 0x51eed;
const DIST_FULL = 10; // world units — unattenuated inside this radius
const DIST_ZERO = 45; // silent at/beyond this radius (linear between)

interface BeepOpts {
  readonly type: OscillatorType;
  readonly f0: number;
  readonly f1?: number;
  readonly t0: number;
  readonly dur: number;
  readonly peak: number;
}

interface BurstOpts {
  readonly type: BiquadFilterType;
  readonly f0: number;
  readonly f1?: number;
  readonly q?: number;
  readonly t0: number;
  readonly dur: number;
  readonly peak: number;
}

interface AmbPatch {
  readonly key: 'wind' | 'hum';
  readonly gain: GainNode;
  readonly sources: Array<AudioBufferSourceNode | OscillatorNode>;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear distance attenuation: UI (null/undefined) or ≤10u → 1, ≥45u → 0. */
function attenuate(dist: number | null | undefined): number {
  if (dist == null) return 1;
  if (dist <= DIST_FULL) return 1;
  if (dist >= DIST_ZERO) return 0;
  return 1 - (dist - DIST_FULL) / (DIST_ZERO - DIST_FULL);
}

function audioCtor(): typeof AudioContext | null {
  const w = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  return Ctor ?? null;
}

export class SynthKit implements AudioKit {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private amb: AmbPatch | null = null;
  private pendingAmb: 'wind' | 'hum' | 'off' | null = null;

  /** Create/unlock the AudioContext on the first user gesture; idempotent;
      silently no-op where WebAudio is unavailable. */
  resume(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
      this.flushPendingAmbient();
      return;
    }
    const Ctor = audioCtor();
    if (!Ctor) return; // no WebAudio — the kit stays a no-op
    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return; // construction can throw (policy, device) — stay silent
    }
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);
    this.master = master;
    // shared 1s white-noise buffer, seeded (determinism rule); reused by all
    // bursts and the wind bed.
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    const next = rng(NOISE_SEED);
    for (let i = 0; i < data.length; i++) data[i] = next() * 2 - 1;
    this.noiseBuf = buf;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    this.flushPendingAmbient();
  }

  /** One-shot synthesized voice. dist=null (default) means UI sound; a number
      applies linear falloff: full ≤10u, silent ≥45u. Never throws. */
  sfx(voice: SfxVoice, opts?: SfxOpts): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noiseBuf;
    if (!ctx || !master || !noise || ctx.state !== 'running') return;
    const vol = clamp01(opts?.vol ?? 1);
    const g = vol * attenuate(opts?.dist);
    if (g <= 0) return;
    const fq = opts?.freq;
    const durSec = opts?.durSec;
    try {
      this.play(ctx, master, noise, voice, ctx.currentTime, g, fq, durSec);
    } catch {
      // audio must never crash the client
    }
  }

  /** Looping ambience bed; calling again switches with a crossfade; 'off'
      fades out and stops. Deferred until the context is running. */
  ambient(kind: 'wind' | 'hum' | 'off'): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuf || ctx.state !== 'running') {
      this.pendingAmb = kind; // resume() replays it once running
      return;
    }
    try {
      if (kind !== 'off' && this.amb && this.amb.key === kind) return;
      const t0 = ctx.currentTime;
      if (this.amb) this.stopPatch(this.amb, t0);
      this.amb =
        kind === 'off'
          ? null
          : kind === 'wind'
            ? this.windPatch(ctx, this.master, this.noiseBuf, t0)
            : this.humPatch(ctx, this.master, this.noiseBuf, t0);
      this.pendingAmb = null;
    } catch {
      // audio must never crash the client
    }
  }

  // ---- voice recipes -----------------------------------------------------------

  private play(
    ctx: AudioContext,
    dest: AudioNode,
    noise: AudioBuffer,
    voice: SfxVoice,
    t0: number,
    g: number,
    fq: number | undefined,
    durSec: number | undefined,
  ): void {
    switch (voice) {
      case 'click': // tiny glassy tick
        this.beep(ctx, dest, { type: 'sine', f0: fq ?? 1900, t0, dur: durSec ?? 0.03, peak: 0.18 * g });
        break;
      case 'deny': // harsh detuned-square buzz behind a lowpass
        this.deny(ctx, dest, t0, g, fq ?? 175, durSec ?? 0.2);
        break;
      case 'jump': // bright rising chirp
        this.jump(ctx, dest, t0, g, fq ?? 280, durSec ?? 0.13);
        break;
      case 'land': // soft body thump + faint dust tick
        this.land(ctx, dest, noise, t0, g, fq ?? 150, durSec);
        break;
      case 'hit': // crisp filtered-noise slap + square edge
        this.hit(ctx, dest, noise, t0, g, fq ?? 1500, durSec ?? 0.05);
        break;
      case 'explode': // big lowpass noise roar + sub drop
        this.explode(ctx, dest, noise, t0, g, fq ?? 1200, durSec ?? 0.45);
        break;
      case 'pickup': // quick two-note sparkle up
        this.arp(ctx, dest, 'triangle', fq ?? 660, [1, 1.335], durSec ?? 0.14, 0.22 * g, 0.55);
        break;
      case 'score': // three-note staccato fanfare up
        this.arp(ctx, dest, 'sine', fq ?? 523.25, [1, 1.26, 1.5], durSec ?? 0.27, 0.26 * g, 0.33);
        break;
      case 'win': // rising four-note arpeggio (up), long final note
        this.arp(ctx, dest, 'triangle', fq ?? 392, [1, 4 / 3, 5 / 3, 2], durSec ?? 0.42, 0.28 * g, 0.21, 1.9);
        break;
      case 'lose': // falling four-note arpeggio (down), heavy last note
        this.arp(ctx, dest, 'sine', fq ?? 523.25, [1, 5 / 6, 2 / 3, 1 / 2], durSec ?? 0.52, 0.28 * g, 0.24, -1.6);
        break;
    }
  }

  /** Two slightly-detuned squares through a closing lowpass — reads as "no". */
  private deny(ctx: AudioContext, dest: AudioNode, t0: number, g: number, f0: number, dur: number): void {
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(900, t0);
    flt.frequency.exponentialRampToValueAtTime(320, t0 + dur);
    flt.connect(dest);
    this.beep(ctx, flt, { type: 'square', f0, t0, dur, peak: 0.16 * g });
    this.beep(ctx, flt, { type: 'square', f0: f0 * 1.04, t0, dur, peak: 0.11 * g });
  }

  /** Square sweep upward with a quick tail — reads as "launch". */
  private jump(ctx: AudioContext, dest: AudioNode, t0: number, g: number, f0: number, dur: number): void {
    this.beep(ctx, dest, { type: 'square', f0, f1: f0 * 2.3, t0, dur, peak: 0.14 * g });
    this.beep(ctx, dest, { type: 'sine', f0: f0 * 2, f1: f0 * 4.6, t0, dur: dur * 0.8, peak: 0.08 * g });
  }

  /** Low triangle thump + a whisper of highpassed noise on impact. */
  private land(
    ctx: AudioContext, dest: AudioNode, noise: AudioBuffer,
    t0: number, g: number, f0: number, durSec: number | undefined,
  ): void {
    const dur = durSec ?? 0.12;
    this.beep(ctx, dest, { type: 'triangle', f0, f1: f0 * 0.42, t0, dur, peak: 0.4 * g });
    this.burst(ctx, noise, dest, { type: 'highpass', f0: 2600, t0, dur: Math.min(dur * 0.25, 0.03), peak: 0.08 * g });
  }

  /** Filtered-noise slap centered at f0 + a short square edge tick. */
  private hit(
    ctx: AudioContext, dest: AudioNode, noise: AudioBuffer,
    t0: number, g: number, f0: number, dur: number,
  ): void {
    this.burst(ctx, noise, dest, { type: 'bandpass', f0, q: 1.2, f1: f0 * 0.6, t0, dur, peak: 0.5 * g });
    this.beep(ctx, dest, { type: 'square', f0: f0 * 0.75, t0, dur: dur * 0.5, peak: 0.12 * g });
  }

  /** Long lowpass noise roar sweeping down into rumble + sine sub-drop. */
  private explode(
    ctx: AudioContext, dest: AudioNode, noise: AudioBuffer,
    t0: number, g: number, f0: number, dur: number,
  ): void {
    this.burst(ctx, noise, dest, { type: 'lowpass', f0, f1: 90, q: 0.7, t0, dur, peak: 0.85 * g });
    this.beep(ctx, dest, { type: 'sine', f0: 110, f1: 38, t0, dur: dur * 0.7, peak: 0.5 * g });
    this.burst(ctx, noise, dest, { type: 'bandpass', f0: 2400, f1: 500, q: 0.8, t0, dur: dur * 0.3, peak: 0.2 * g });
  }

  /** Evenly-spaced arpeggio; `tail` stretches (>1) or drops (<0) the last note. */
  private arp(
    ctx: AudioContext, dest: AudioNode, type: OscillatorType, base: number,
    ratios: readonly number[], total: number, peak: number, stepFrac: number, tail = 1,
  ): void {
    const t0 = ctx.currentTime;
    const step = total * stepFrac;
    ratios.forEach((r, i) => {
      const isLast = i === ratios.length - 1;
      const dur = isLast && tail < 0 ? step * -tail : step * (isLast ? tail : 1);
      this.beep(ctx, dest, { type, f0: base * r, t0: t0 + i * step, dur, peak });
    });
  }

  // ---- synth primitives (lean house clones) -------------------------------------

  /** Oscillator with fast-attack / exponential-decay envelope into `dest`. */
  private beep(ctx: AudioContext, dest: AudioNode, o: BeepOpts): void {
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(Math.max(20, o.f0), o.t0);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), o.t0 + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(ENV_FLOOR, o.t0);
    g.gain.exponentialRampToValueAtTime(Math.max(o.peak, ENV_FLOOR), o.t0 + ATTACK_SEC);
    g.gain.exponentialRampToValueAtTime(ENV_FLOOR, o.t0 + o.dur);
    osc.connect(g);
    g.connect(dest);
    osc.start(o.t0);
    osc.stop(o.t0 + o.dur + 0.02);
  }

  /** Filtered noise burst (from the shared buffer) with the same envelope. */
  private burst(ctx: AudioContext, nbuf: AudioBuffer, dest: AudioNode, o: BurstOpts): void {
    const src = ctx.createBufferSource();
    src.buffer = nbuf;
    const flt = ctx.createBiquadFilter();
    flt.type = o.type;
    flt.frequency.setValueAtTime(Math.max(20, o.f0), o.t0);
    if (o.f1 !== undefined) flt.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), o.t0 + o.dur);
    flt.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(ENV_FLOOR, o.t0);
    g.gain.exponentialRampToValueAtTime(Math.max(o.peak, ENV_FLOOR), o.t0 + ATTACK_SEC);
    g.gain.exponentialRampToValueAtTime(ENV_FLOOR, o.t0 + o.dur);
    src.connect(flt);
    flt.connect(g);
    g.connect(dest);
    src.start(o.t0);
    src.stop(o.t0 + o.dur + 0.02);
  }

  // ---- ambient beds -----------------------------------------------------------------

  /** Outdoor wind: looping bandpass noise that slowly wanders + breathes. */
  private windPatch(ctx: AudioContext, master: GainNode, nbuf: AudioBuffer, t0: number): AmbPatch {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(ENV_FLOOR, t0);
    gain.gain.linearRampToValueAtTime(0.16, t0 + XFADE_SEC); // fade in
    gain.connect(master);
    const sources: Array<AudioBufferSourceNode | OscillatorNode> = [];

    const src = ctx.createBufferSource();
    src.buffer = nbuf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.value = 420;
    flt.Q.value = 0.7;
    const pre = ctx.createGain();
    pre.gain.value = 0.9;
    src.connect(flt);
    flt.connect(pre);
    pre.connect(gain);

    // slow gust LFOs: filter wander + level breathing
    sources.push(...this.lfoInto(ctx, flt.frequency, 0.06, 150));
    sources.push(...this.lfoInto(ctx, gain.gain, 0.13, 0.05));

    src.start(t0);
    return { key: 'wind', gain, sources };
  }

  /** Machine-room hum: 55Hz sine bed + harmonic + faint air noise. */
  private humPatch(ctx: AudioContext, master: GainNode, nbuf: AudioBuffer, t0: number): AmbPatch {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(ENV_FLOOR, t0);
    gain.gain.linearRampToValueAtTime(0.12, t0 + XFADE_SEC);
    gain.connect(master);
    const sources: Array<AudioBufferSourceNode | OscillatorNode> = [];
    this.bedOsc(ctx, gain, sources, 55, 0.5);
    this.bedOsc(ctx, gain, sources, 110, 0.15);

    const src = ctx.createBufferSource();
    src.buffer = nbuf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = 220;
    const pre = ctx.createGain();
    pre.gain.value = 0.06;
    src.connect(flt);
    flt.connect(pre);
    pre.connect(gain);
    sources.push(src); // typed as oscillator for the stop list — both have .stop

    src.start(t0);
    return { key: 'hum', gain, sources };
  }

  private bedOsc(
    ctx: AudioContext, bed: GainNode,
    sources: Array<AudioBufferSourceNode | OscillatorNode>, f0: number, level: number,
  ): void {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f0;
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(g);
    g.connect(bed);
    osc.start(ctx.currentTime);
    sources.push(osc);
  }

  /** Slow LFO pair → depth gain → target param; returns nodes to stop later. */
  private lfoInto(
    ctx: AudioContext, target: AudioParam, rate: number, depth: number,
  ): OscillatorNode[] {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rate;
    const d = ctx.createGain();
    d.gain.value = depth;
    lfo.connect(d);
    d.connect(target);
    lfo.start(ctx.currentTime);
    return [lfo];
  }

  /** Crossfade a bed out over XFADE_SEC, then stop + disconnect it. */
  private stopPatch(p: AmbPatch, t0: number): void {
    p.gain.gain.cancelScheduledValues(t0);
    p.gain.gain.setTargetAtTime(0, t0, XFADE_SEC / 3.5);
    for (const s of p.sources) {
      try {
        s.stop(t0 + XFADE_SEC + 0.05);
      } catch {
        // already stopped — fine
      }
    }
    const last = p.sources[p.sources.length - 1];
    if (last) {
      last.onended = () => {
        try {
          p.gain.disconnect();
        } catch {
          // already disconnected — fine
        }
      };
    }
  }

  /** Apply a deferred ambient() request once the context is running. */
  private flushPendingAmbient(): void {
    const ctx = this.ctx;
    if (!ctx || this.pendingAmb === null) return;
    if (ctx.state === 'running') {
      const kind = this.pendingAmb;
      this.pendingAmb = null;
      this.ambient(kind);
      return;
    }
    void ctx.resume().then(
      () => {
        if (this.pendingAmb !== null) this.ambient(this.pendingAmb);
      },
      () => {
        // resume rejected (autoplay policy) — stays pending for next gesture
      },
    );
  }
}
