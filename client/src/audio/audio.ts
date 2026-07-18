// ============================================================================
// C7 — synthesized audio engine. Pure WebAudio: oscillators + ONE shared
// seeded-noise buffer, envelopes + filters. No audio asset files.
// Everything is a safe no-op until resume() creates the AudioContext on a
// user gesture (browser autoplay policy). Noise is filled via rng(seed) —
// Math.random is a contract violation everywhere.
// ============================================================================
import { rng } from '@fps/shared';

export type SfxKind = 'shot_knife' | 'shot_pistol' | 'shot_smg' | 'shot_shotgun' | 'shot_rifle'
  | 'shot_sniper' | 'reload' | 'hit' | 'headshot' | 'death' | 'footstep'
  | 'round_start' | 'round_end' | 'buy' | 'deny' | 'win' | 'lose' | 'click' | 'multikill';

// ---- tuning constants -------------------------------------------------------
const MASTER_GAIN = 0.5;
const SHOT_CAP = 0.8; // shot sounds never exceed this post-attenuation gain
const DIST_FULL = 10; // m — unattenuated inside this radius
const DIST_ZERO = 45; // m — silent at/ beyond this radius (linear between)
const XFADE = 0.5; // ambient crossfade seconds
const ENV_FLOOR = 0.0001; // exponential ramps may never target 0

interface AmbientPatch {
  outdoor: boolean;
  gain: GainNode;
  sources: Array<AudioBufferSourceNode | OscillatorNode>;
}

interface BeepOpts {
  type: OscillatorType; f0: number; f1?: number;
  t0: number; dur: number; peak: number;
}

interface BurstOpts {
  type: BiquadFilterType; f0: number; f1?: number; q?: number;
  t0: number; dur: number; peak: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private amb: AmbientPatch | null = null;
  private pendingAmb: boolean | null = null; // ambient() deferred while ctx suspended
  private stepFlip = false; // footstep alternates between two slight variants

  /** Create/unlock the AudioContext. Called on first user gesture; idempotent. */
  resume(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      this.flushPendingAmbient();
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
    // shared 1s white-noise buffer, seeded (determinism rule; reused by all beds/bursts)
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    const next = rng(0x5eed);
    for (let i = 0; i < data.length; i++) data[i] = next() * 2 - 1;
    this.noiseBuf = buf;
    if (ctx.state === 'suspended') void ctx.resume();
    this.flushPendingAmbient();
  }

  /** One-shot effect. dist attenuates linearly: full ≤10m → 0 at 45m. */
  sfx(kind: SfxKind, opts?: { dist?: number; vol?: number }): void {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return;
    const g0 = (opts?.vol ?? 1) * attenuate(opts?.dist);
    if (g0 <= 0) return;
    const t0 = ctx.currentTime;
    const shot = Math.min(SHOT_CAP, g0); // shot_* kinds share the 0.8 cap
    try {
      switch (kind) {
        // ---- weapons: each must read as its weapon at distance -------------
        case 'shot_pistol': // sharp crack: noise burst 80ms + 800Hz ping, fast decay
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 2200, q: 0.7, t0, dur: 0.08, peak: 0.9 * shot });
          this.beep(ctx, master, { type: 'sine', f0: 800, f1: 720, t0, dur: 0.07, peak: 0.45 * shot });
          break;
        case 'shot_smg': // short pop 60ms, higher
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 3200, q: 1, t0, dur: 0.06, peak: 0.7 * shot });
          this.beep(ctx, master, { type: 'sine', f0: 1400, f1: 1100, t0, dur: 0.045, peak: 0.3 * shot });
          break;
        case 'shot_rifle': // heavy crack 120ms + low thump
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 1100, q: 0.5, t0, dur: 0.12, peak: shot });
          this.beep(ctx, master, { type: 'sine', f0: 130, f1: 70, t0, dur: 0.14, peak: 0.6 * shot });
          break;
        case 'shot_sniper': // boom 300ms, lowpass sweep 3k -> 200Hz
          this.burst(ctx, nbuf, master, { type: 'lowpass', f0: 3000, f1: 200, t0, dur: 0.3, peak: shot });
          this.beep(ctx, master, { type: 'sine', f0: 90, f1: 50, t0, dur: 0.3, peak: 0.55 * shot });
          break;
        case 'shot_shotgun': // wide boom 200ms, bandpass ~500Hz
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 500, q: 0.4, t0, dur: 0.2, peak: shot });
          this.beep(ctx, master, { type: 'sine', f0: 110, f1: 60, t0, dur: 0.18, peak: 0.5 * shot });
          break;
        case 'shot_knife': // whoosh: bandpass noise sweep
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 500, f1: 2600, q: 1.5, t0, dur: 0.18, peak: 0.55 * shot });
          break;
        // ---- feedback / UI --------------------------------------------------
        case 'reload': // 2 clicks + slide (short filtered noise ticks)
          this.burst(ctx, nbuf, master, { type: 'highpass', f0: 2500, t0, dur: 0.025, peak: 0.3 * g0 });
          this.burst(ctx, nbuf, master, { type: 'highpass', f0: 2500, t0: t0 + 0.16, dur: 0.025, peak: 0.3 * g0 });
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 1400, f1: 700, q: 1.2, t0: t0 + 0.34, dur: 0.11, peak: 0.26 * g0 });
          break;
        case 'hit': // 1.2kHz tick 40ms
          this.beep(ctx, master, { type: 'square', f0: 1200, t0, dur: 0.04, peak: 0.26 * g0 });
          break;
        case 'headshot': // 1.8kHz ding 80ms (+ faint octave for the "ding")
          this.beep(ctx, master, { type: 'sine', f0: 1800, t0, dur: 0.08, peak: 0.34 * g0 });
          this.beep(ctx, master, { type: 'sine', f0: 2700, t0, dur: 0.05, peak: 0.14 * g0 });
          break;
        case 'death': // low thud 150ms
          this.beep(ctx, master, { type: 'sine', f0: 140, f1: 55, t0, dur: 0.15, peak: 0.55 * g0 });
          this.burst(ctx, nbuf, master, { type: 'lowpass', f0: 300, t0, dur: 0.1, peak: 0.25 * g0 });
          break;
        case 'footstep': { // soft noise tap 40ms, two alternating variants
          // level note: filtered noise keeps only ~15% RMS of a same-peak osc,
          // so the burst peak must sit well above the beep levels to read at
          // all — and above the ambient bed (0.14) out to the 45m cutoff
          this.stepFlip = !this.stepFlip;
          const f = this.stepFlip ? 620 : 480;
          this.burst(ctx, nbuf, master, { type: 'lowpass', f0: f, t0, dur: 0.04, peak: (this.stepFlip ? 0.55 : 0.5) * g0 });
          break;
        }
        // ---- round / match stingers ----------------------------------------
        case 'round_start': // two-note chime
          this.beep(ctx, master, { type: 'triangle', f0: 660, t0, dur: 0.16, peak: 0.3 * g0 });
          this.beep(ctx, master, { type: 'triangle', f0: 880, t0: t0 + 0.15, dur: 0.22, peak: 0.3 * g0 });
          break;
        case 'round_end': // low resolve note
          this.beep(ctx, master, { type: 'triangle', f0: 220, t0, dur: 0.5, peak: 0.3 * g0 });
          break;
        case 'multikill': // heroic sting: ascending fifth A4→E5 on sawtooth (brassy —
          // deliberately not the triangle chime of the round stingers), octave sheen on the top note
          this.beep(ctx, master, { type: 'sawtooth', f0: 440, t0, dur: 0.11, peak: 0.26 * g0 });
          this.beep(ctx, master, { type: 'sawtooth', f0: 659.25, t0: t0 + 0.1, dur: 0.28, peak: 0.3 * g0 });
          this.beep(ctx, master, { type: 'sawtooth', f0: 1318.5, t0: t0 + 0.1, dur: 0.28, peak: 0.1 * g0 });
          break;
        case 'buy': // cash blip 1kHz
          this.beep(ctx, master, { type: 'sine', f0: 1000, t0, dur: 0.06, peak: 0.28 * g0 });
          this.beep(ctx, master, { type: 'sine', f0: 1500, t0: t0 + 0.05, dur: 0.05, peak: 0.16 * g0 });
          break;
        case 'deny': // buzz 180Hz (two detuned squares read harsher than one)
          this.beep(ctx, master, { type: 'square', f0: 180, t0, dur: 0.2, peak: 0.2 * g0 });
          this.beep(ctx, master, { type: 'square', f0: 184, t0, dur: 0.2, peak: 0.13 * g0 });
          break;
        case 'win': // rising 3-note
          this.beep(ctx, master, { type: 'triangle', f0: 523.25, t0, dur: 0.18, peak: 0.3 * g0 });
          this.beep(ctx, master, { type: 'triangle', f0: 659.25, t0: t0 + 0.14, dur: 0.18, peak: 0.3 * g0 });
          this.beep(ctx, master, { type: 'triangle', f0: 783.99, t0: t0 + 0.28, dur: 0.32, peak: 0.32 * g0 });
          break;
        case 'lose': // falling 2-note
          this.beep(ctx, master, { type: 'triangle', f0: 392, t0, dur: 0.28, peak: 0.3 * g0 });
          this.beep(ctx, master, { type: 'triangle', f0: 311.13, t0: t0 + 0.24, dur: 0.42, peak: 0.3 * g0 });
          break;
        case 'click': // UI tick
          this.beep(ctx, master, { type: 'sine', f0: 2000, t0, dur: 0.025, peak: 0.15 * g0 });
          break;
      }
    } catch {
      // audio must never crash the client (contract robustness rule)
    }
  }

  /** Looping ambient bed: filtered-noise wind outdoor, low hum indoor. */
  ambient(outdoor: boolean): void {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') {
      // context missing/suspended (joined before the gesture completed) —
      // remember the request; resume() applies it once running
      this.pendingAmb = outdoor;
      return;
    }
    this.pendingAmb = null;
    try {
      if (this.amb && this.amb.outdoor === outdoor) return; // bed already running
      const t0 = ctx.currentTime;
      if (this.amb) this.stopPatch(this.amb, t0); // fades over XFADE
      this.amb = this.makePatch(ctx, nbuf, master, outdoor, t0);
    } catch {
      // audio must never crash the client
    }
  }

  /** Stop the ambient bed with a 0.3s fade. Called on world teardown. */
  stopAmbient(): void {
    this.pendingAmb = null;
    const patch = this.amb;
    this.amb = null;
    if (!patch) return;
    try {
      const ctx = this.ctx;
      if (ctx && ctx.state === 'running') {
        this.stopPatch(patch, ctx.currentTime, 0.3);
      } else {
        // context gone/suspended: ramps would never run — kill immediately
        for (const s of patch.sources) {
          try {
            s.stop();
          } catch {
            // already stopped — fine
          }
        }
        try {
          patch.gain.disconnect();
        } catch {
          // already disconnected — fine
        }
      }
    } catch {
      // audio must never crash the client
    }
  }

  /** Apply a deferred ambient() request once the context is running. */
  private flushPendingAmbient(): void {
    const ctx = this.ctx;
    if (!ctx || this.pendingAmb === null) return;
    if (ctx.state === 'running') {
      const outdoor = this.pendingAmb;
      this.pendingAmb = null;
      this.ambient(outdoor);
      return;
    }
    ctx.resume().then(() => {
      if (this.pendingAmb !== null && ctx.state === 'running') {
        const outdoor = this.pendingAmb;
        this.pendingAmb = null;
        this.ambient(outdoor);
      }
    }, () => {
      // resume rejected (autoplay policy) — pending stays, next gesture retries
    });
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

  // ---- ambient beds ----------------------------------------------------------

  private makePatch(
    ctx: AudioContext, nbuf: AudioBuffer, master: GainNode, outdoor: boolean, t0: number,
  ): AmbientPatch {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(ENV_FLOOR, t0);
    gain.gain.linearRampToValueAtTime(outdoor ? 0.14 : 0.05, t0 + XFADE); // fade in
    gain.connect(master);
    const sources: Array<AudioBufferSourceNode | OscillatorNode> = [];
    if (outdoor) {
      // wind: looping noise through ~400Hz bandpass, slow LFO breathing on gain
      const src = ctx.createBufferSource();
      src.buffer = nbuf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 400;
      bp.Q.value = 0.8;
      src.connect(bp);
      bp.connect(gain);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.13;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.05;
      lfo.connect(lfoDepth);
      lfoDepth.connect(gain.gain);
      sources.push(src, lfo);
    } else {
      // indoor: 120Hz hum + faint lowpassed noise, very quiet
      const hum = ctx.createOscillator();
      hum.type = 'sine';
      hum.frequency.value = 120;
      const humG = ctx.createGain();
      humG.gain.value = 0.5;
      hum.connect(humG);
      humG.connect(gain);
      const src = ctx.createBufferSource();
      src.buffer = nbuf;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 240;
      const nG = ctx.createGain();
      nG.gain.value = 0.4;
      src.connect(lp);
      lp.connect(nG);
      nG.connect(gain);
      sources.push(hum, src);
    }
    for (const s of sources) s.start(t0);
    return { outdoor, gain, sources };
  }

  /** Fade a bed out over `fade` seconds, then stop + disconnect it. */
  private stopPatch(p: AmbientPatch, t0: number, fade: number = XFADE): void {
    p.gain.gain.cancelScheduledValues(t0);
    p.gain.gain.setTargetAtTime(0, t0, fade / 3);
    for (const s of p.sources) {
      try {
        s.stop(t0 + fade + 0.05);
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
}

/** Linear distance attenuation: 1 at ≤10m, 0 at ≥45m. */
function attenuate(dist: number | undefined): number {
  if (dist === undefined || dist <= DIST_FULL) return 1;
  if (dist >= DIST_ZERO) return 0;
  return 1 - (dist - DIST_FULL) / (DIST_ZERO - DIST_FULL);
}
