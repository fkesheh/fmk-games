// ============================================================================
// C7 — synthesized audio engine. Pure WebAudio: oscillators + ONE shared
// seeded-noise buffer, envelopes + filters. No audio asset files.
// Everything is a safe no-op until resume() creates the AudioContext on a
// user gesture (browser autoplay policy). Noise is filled via rng(seed) —
// Math.random is a contract violation everywhere.
//
// AAA layering model (references: CoD gunfire tails, Valorant clean foley):
// - firearms = crack (fast noise transient) + body (low-mid osc thump) + tail
//   (filtered decay echo). Crack/body use the standard 45m distance law; the
//   tail runs the SAME law against a 1.8x radius and stretches + muffles with
//   distance, so past 45m only the echo remains — distant fire reads as
//   rolling reports while close fire keeps its snap.
// - foley: reload is a timed 3-element sequence (mag-out click / mag-in click
//   / rack slide), footsteps alternate two variants per surface family (hard
//   taps with a heel click vs soft muffled thuds), knife whoosh is 3-layer.
// - ambient beds are per-map (desert wind / shimmer / cold whistle /
//   industrial hum / office AC) behind the generic outdoor/indoor fallbacks;
//   the resolved theme also picks the footstep surface family.
// ============================================================================
import { rng } from '@fps/shared';
import type { MapId } from '@fps/shared';

export type SfxKind = 'shot_knife' | 'shot_pistol' | 'shot_smg' | 'shot_shotgun' | 'shot_rifle'
  | 'shot_sniper' | 'reload' | 'hit' | 'headshot' | 'death' | 'footstep'
  | 'round_start' | 'round_end' | 'buy' | 'deny' | 'win' | 'lose' | 'click' | 'multikill';

/** Ambient bed selector: a MapId picks that map's bed, 'outdoor'/'indoor' the
    generic fallbacks, and a boolean is the legacy form (true = outdoor). */
export type AmbientTheme = MapId | 'outdoor' | 'indoor';

/** Footstep surface family: hard (concrete/metal) vs soft (carpet/sand/snow). */
export type StepSurface = 'hard' | 'soft';

// ---- tuning constants -------------------------------------------------------
const MASTER_GAIN = 0.5;
const SHOT_CAP = 0.8; // shot sounds never exceed this post-attenuation gain
const DIST_FULL = 10; // m — unattenuated inside this radius
const DIST_ZERO = 45; // m — silent at/ beyond this radius (linear between)
const TAIL_REACH = 1.8; // gunfire tail distance-law multiplier (audible to ~81m)
const TAIL_OFFSET = 0.02; // s — echo sits a hair behind the report
const XFADE = 0.5; // ambient crossfade seconds
const ENV_FLOOR = 0.0001; // exponential ramps may never target 0

/** Firearm kinds (shot_knife excluded: melee, no muzzle report to echo). */
const GUN_KINDS: ReadonlySet<SfxKind> = new Set([
  'shot_pistol', 'shot_smg', 'shot_rifle', 'shot_sniper', 'shot_shotgun',
]);

/** Bed gain per theme (post-fade target, pre-master). */
const BED_LEVELS: Record<AmbientTheme, number> = {
  outdoor: 0.14,
  indoor: 0.05,
  dustbowl: 0.14,
  urbana: 0.1,
  frostbite: 0.13,
  crossfire: 0.075,
  bunker: 0.06,
  office: 0.05,
};

/** Themes whose ground reads soft underfoot (office carpet, sand, snow).
    Generic 'indoor' defaults soft (office is the common indoor map); passing a
    MapId resolves every map exactly (bunker/crossfire/urbana stay hard). */
const SOFT_STEP_THEMES: ReadonlySet<AmbientTheme> = new Set(['office', 'dustbowl', 'frostbite', 'indoor']);

interface AmbientPatch {
  key: AmbientTheme;
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

/** Layered firearm recipe: crack transient + body thump + tail echo. */
interface GunRecipe {
  crack: { f0: number; q: number; dur: number; peak: number };
  body: { f0: number; f1: number; dur: number; peak: number };
  tail: { type: BiquadFilterType; f0: number; f1: number; q: number; dur: number; peak: number };
}

type GunKind = 'shot_pistol' | 'shot_smg' | 'shot_rifle' | 'shot_sniper' | 'shot_shotgun';

// Per-weapon characters (each must still read as its weapon at distance):
// pistol = snappy mid crack, smg = high tight pop, rifle = heavy full crack,
// sniper = huge boom with the longest tail, shotgun = wide low blast.
const GUN_RECIPES: Record<GunKind, GunRecipe> = {
  shot_pistol: {
    crack: { f0: 2400, q: 0.7, dur: 0.03, peak: 0.85 },
    body: { f0: 780, f1: 640, dur: 0.07, peak: 0.42 },
    tail: { type: 'bandpass', f0: 1050, f1: 480, q: 0.8, dur: 0.26, peak: 0.4 },
  },
  shot_smg: {
    crack: { f0: 3400, q: 1, dur: 0.022, peak: 0.7 },
    body: { f0: 1350, f1: 1000, dur: 0.045, peak: 0.3 },
    tail: { type: 'bandpass', f0: 1800, f1: 850, q: 1, dur: 0.17, peak: 0.34 },
  },
  shot_rifle: {
    crack: { f0: 1250, q: 0.5, dur: 0.04, peak: 1 },
    body: { f0: 130, f1: 65, dur: 0.14, peak: 0.6 },
    tail: { type: 'lowpass', f0: 1500, f1: 240, q: 1, dur: 0.42, peak: 0.5 },
  },
  shot_sniper: {
    crack: { f0: 2700, q: 0.6, dur: 0.05, peak: 0.9 },
    body: { f0: 95, f1: 48, dur: 0.3, peak: 0.55 },
    tail: { type: 'lowpass', f0: 2600, f1: 150, q: 1, dur: 0.7, peak: 0.55 },
  },
  shot_shotgun: {
    crack: { f0: 750, q: 0.35, dur: 0.055, peak: 0.95 },
    body: { f0: 110, f1: 58, dur: 0.18, peak: 0.5 },
    tail: { type: 'bandpass', f0: 460, f1: 210, q: 0.5, dur: 0.48, peak: 0.5 },
  },
};

/** Looping-noise bed layer options (trem = slow AM, freq = filter wander). */
interface BedNoiseOpts {
  type: BiquadFilterType; f0: number; q?: number; level: number;
  tremRate?: number; tremDepth?: number;
  freqRate?: number; freqDepth?: number;
}

interface BedOscOpts {
  type: OscillatorType; f0: number; level: number;
  tremRate?: number; tremDepth?: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private amb: AmbientPatch | null = null;
  private pendingAmb: boolean | AmbientTheme | null = null; // ambient() deferred while ctx suspended
  private stepFlip = false; // footstep alternates between two slight variants
  private stepSurface: StepSurface = 'hard'; // derived from the ambient theme

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

  /** One-shot effect. dist attenuates linearly: full ≤10m → 0 at 45m. Gunfire
      keeps a far echo: the tail layer runs the same law against a 1.8x radius,
      stretches and muffles with distance, and is all that remains past 45m. */
  sfx(kind: SfxKind, opts?: { dist?: number; vol?: number; surface?: StepSurface }): void {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return;
    const vol = opts?.vol ?? 1;
    const dist = opts?.dist;
    const g0 = vol * attenuate(dist);
    const gun = GUN_KINDS.has(kind);
    const gFar = Math.min(SHOT_CAP, vol * attenuate(dist === undefined ? undefined : dist / TAIL_REACH));
    if (g0 <= 0 && (!gun || gFar <= 0)) return;
    // 0 near .. 1 at/beyond 45m — drives tail stretch + muffle
    const dist01 = dist === undefined ? 0 : Math.min(1, Math.max(0, (dist - DIST_FULL) / (DIST_ZERO - DIST_FULL)));
    const t0 = ctx.currentTime;
    const shot = Math.min(SHOT_CAP, g0); // shot_* kinds share the 0.8 cap
    try {
      switch (kind) {
        // ---- weapons: crack + body + tail, per-weapon character -------------
        case 'shot_pistol':
        case 'shot_smg':
        case 'shot_rifle':
        case 'shot_sniper':
        case 'shot_shotgun':
          this.gunfire(ctx, nbuf, master, t0, shot, gFar, dist01, GUN_RECIPES[kind]);
          break;
        case 'shot_knife': // richer whoosh: low body + main sweep + air sheen
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 480, f1: 2800, q: 1.4, t0, dur: 0.17, peak: 0.5 * shot });
          this.burst(ctx, nbuf, master, { type: 'highpass', f0: 2600, f1: 4200, t0: t0 + 0.02, dur: 0.11, peak: 0.13 * shot });
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 240, f1: 900, q: 1, t0, dur: 0.15, peak: 0.18 * shot });
          break;
        // ---- feedback / UI --------------------------------------------------
        case 'reload': // foley sequence: mag-out click, mag-in click, rack slide
          // mag-out: release tick + spring thunk
          this.burst(ctx, nbuf, master, { type: 'highpass', f0: 2400, t0, dur: 0.02, peak: 0.28 * g0 });
          this.beep(ctx, master, { type: 'sine', f0: 260, f1: 175, t0, dur: 0.045, peak: 0.16 * g0 });
          // mag-in: heavier seat tick + handling rustle
          this.burst(ctx, nbuf, master, { type: 'highpass', f0: 1900, t0: t0 + 0.17, dur: 0.022, peak: 0.3 * g0 });
          this.beep(ctx, master, { type: 'sine', f0: 215, f1: 150, t0: t0 + 0.17, dur: 0.05, peak: 0.18 * g0 });
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 900, q: 0.9, t0: t0 + 0.155, dur: 0.03, peak: 0.1 * g0 });
          // rack slide: metallic travel, then the bolt-close clack
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 2000, f1: 950, q: 1.3, t0: t0 + 0.37, dur: 0.09, peak: 0.24 * g0 });
          this.burst(ctx, nbuf, master, { type: 'highpass', f0: 3200, t0: t0 + 0.46, dur: 0.018, peak: 0.26 * g0 });
          this.beep(ctx, master, { type: 'sine', f0: 320, f1: 205, t0: t0 + 0.46, dur: 0.032, peak: 0.12 * g0 });
          break;
        case 'hit': // crisp tick: 1.65kHz 28ms + a bright 2.5k edge
          this.beep(ctx, master, { type: 'square', f0: 1650, t0, dur: 0.028, peak: 0.24 * g0 });
          this.beep(ctx, master, { type: 'sine', f0: 2500, t0, dur: 0.018, peak: 0.1 * g0 });
          break;
        case 'headshot': // shorter, brighter ding: 2.1k/3.15k + noise attack tick
          this.beep(ctx, master, { type: 'sine', f0: 2100, t0, dur: 0.055, peak: 0.32 * g0 });
          this.beep(ctx, master, { type: 'sine', f0: 3150, t0, dur: 0.04, peak: 0.15 * g0 });
          this.burst(ctx, nbuf, master, { type: 'highpass', f0: 5200, t0, dur: 0.008, peak: 0.12 * g0 });
          break;
        case 'death': // low thud 150ms
          this.beep(ctx, master, { type: 'sine', f0: 140, f1: 55, t0, dur: 0.15, peak: 0.55 * g0 });
          this.burst(ctx, nbuf, master, { type: 'lowpass', f0: 300, t0, dur: 0.1, peak: 0.25 * g0 });
          break;
        case 'footstep': { // two alternating variants per surface family
          // level note: filtered noise keeps only ~15% RMS of a same-peak osc,
          // so the burst peak must sit well above the beep levels to read at
          // all — and above the ambient bed out to the 45m cutoff
          this.stepFlip = !this.stepFlip;
          const surface = opts?.surface ?? this.stepSurface;
          if (surface === 'soft') {
            // carpet/sand/snow: muffled low thud, no heel click
            const f = this.stepFlip ? 340 : 280;
            this.burst(ctx, nbuf, master, { type: 'lowpass', f0: f, t0, dur: 0.055, peak: (this.stepFlip ? 0.55 : 0.5) * g0 });
          } else {
            // concrete/metal: brighter tap + faint heel click
            const f = this.stepFlip ? 980 : 820;
            this.burst(ctx, nbuf, master, { type: 'bandpass', f0: f, q: 0.8, t0, dur: 0.035, peak: (this.stepFlip ? 0.5 : 0.46) * g0 });
            this.burst(ctx, nbuf, master, { type: 'highpass', f0: 2900, t0, dur: 0.012, peak: 0.14 * g0 });
          }
          break;
        }
        // ---- round / match stingers ----------------------------------------
        case 'round_start': // 3-note chime over a low root+fifth bed
          this.beep(ctx, master, { type: 'sine', f0: 130.81, t0, dur: 0.7, peak: 0.1 * g0 }); // C3 bed
          this.beep(ctx, master, { type: 'sine', f0: 196, t0, dur: 0.7, peak: 0.07 * g0 }); // G3 fifth
          this.beep(ctx, master, { type: 'triangle', f0: 523.25, t0, dur: 0.15, peak: 0.28 * g0 });
          this.beep(ctx, master, { type: 'triangle', f0: 659.25, t0: t0 + 0.13, dur: 0.15, peak: 0.28 * g0 });
          this.beep(ctx, master, { type: 'triangle', f0: 783.99, t0: t0 + 0.26, dur: 0.3, peak: 0.3 * g0 });
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
        case 'win': // rising 3-note over a low root+fifth bed
          this.beep(ctx, master, { type: 'sine', f0: 130.81, t0, dur: 0.95, peak: 0.11 * g0 }); // C3 bed
          this.beep(ctx, master, { type: 'sine', f0: 196, t0, dur: 0.95, peak: 0.08 * g0 }); // G3 fifth
          this.beep(ctx, master, { type: 'triangle', f0: 523.25, t0, dur: 0.18, peak: 0.3 * g0 });
          this.beep(ctx, master, { type: 'triangle', f0: 659.25, t0: t0 + 0.14, dur: 0.18, peak: 0.3 * g0 });
          this.beep(ctx, master, { type: 'triangle', f0: 783.99, t0: t0 + 0.28, dur: 0.34, peak: 0.32 * g0 });
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

  /** Looping ambient bed. Accepts a MapId (per-map bed), 'outdoor'/'indoor'
      (generic fallbacks), or the legacy boolean (true = outdoor). The resolved
      theme also selects the footstep surface family. */
  ambient(theme: boolean | AmbientTheme): void {
    const key: AmbientTheme = typeof theme === 'boolean' ? (theme ? 'outdoor' : 'indoor') : theme;
    this.stepSurface = SOFT_STEP_THEMES.has(key) ? 'soft' : 'hard';
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') {
      // context missing/suspended (joined before the gesture completed) —
      // remember the request; resume() applies it once running
      this.pendingAmb = theme;
      return;
    }
    this.pendingAmb = null;
    try {
      if (this.amb && this.amb.key === key) return; // bed already running
      const t0 = ctx.currentTime;
      if (this.amb) this.stopPatch(this.amb, t0); // fades over XFADE
      this.amb = this.makePatch(ctx, nbuf, master, key, t0);
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
      const theme = this.pendingAmb;
      this.pendingAmb = null;
      this.ambient(theme);
      return;
    }
    ctx.resume().then(() => {
      if (this.pendingAmb !== null && ctx.state === 'running') {
        const theme = this.pendingAmb;
        this.pendingAmb = null;
        this.ambient(theme);
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

  /** Firearm layer stack: crack transient + body thump (near field only) and
      the tail echo — started a hair late, stretched and muffled by distance,
      gained by the 1.8x-reach law so it dominates at range. */
  private gunfire(
    ctx: AudioContext, nbuf: AudioBuffer, master: GainNode, t0: number,
    near: number, far: number, dist01: number, r: GunRecipe,
  ): void {
    if (near > 0) {
      this.burst(ctx, nbuf, master, {
        type: 'bandpass', f0: r.crack.f0, q: r.crack.q, t0, dur: r.crack.dur, peak: r.crack.peak * near,
      });
      this.beep(ctx, master, {
        type: 'sine', f0: r.body.f0, f1: r.body.f1, t0, dur: r.body.dur, peak: r.body.peak * near,
      });
    }
    this.burst(ctx, nbuf, master, {
      type: r.tail.type,
      f0: r.tail.f0 * (1 - dist01 * 0.3), // distant echo muffle
      f1: r.tail.f1,
      q: r.tail.q,
      t0: t0 + TAIL_OFFSET,
      dur: r.tail.dur * (1 + dist01 * 0.7), // distant echo stretch
      peak: r.tail.peak * far,
    });
  }

  // ---- ambient beds ----------------------------------------------------------

  private makePatch(
    ctx: AudioContext, nbuf: AudioBuffer, master: GainNode, key: AmbientTheme, t0: number,
  ): AmbientPatch {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(ENV_FLOOR, t0);
    gain.gain.linearRampToValueAtTime(BED_LEVELS[key], t0 + XFADE); // fade in
    gain.connect(master);
    const sources: Array<AudioBufferSourceNode | OscillatorNode> = [];
    switch (key) {
      case 'outdoor': // generic wind (legacy boolean true)
        this.bedNoise(ctx, nbuf, gain, sources, { type: 'bandpass', f0: 400, q: 0.8, level: 1 });
        this.lfoInto(ctx, gain.gain, sources, 0.13, 0.05);
        break;
      case 'indoor': // generic hum (legacy boolean false)
        this.bedOsc(ctx, gain, sources, { type: 'sine', f0: 120, level: 0.5 });
        this.bedNoise(ctx, nbuf, gain, sources, { type: 'lowpass', f0: 240, level: 0.4 });
        break;
      case 'dustbowl': // desert wind: dry mid-band gusts wander, faint dust hiss
        this.bedNoise(ctx, nbuf, gain, sources, {
          type: 'bandpass', f0: 360, q: 0.7, level: 0.9, freqRate: 0.05, freqDepth: 110,
        });
        this.bedNoise(ctx, nbuf, gain, sources, { type: 'bandpass', f0: 950, q: 0.5, level: 0.28 });
        this.lfoInto(ctx, gain.gain, sources, 0.11, 0.05);
        break;
      case 'urbana': // birds-ish shimmer: tremolo'd high sines + air over city rumble
        this.bedNoise(ctx, nbuf, gain, sources, { type: 'lowpass', f0: 150, level: 0.5 });
        this.bedNoise(ctx, nbuf, gain, sources, {
          type: 'highpass', f0: 5400, level: 0.045, tremRate: 2.2, tremDepth: 0.02,
        });
        this.bedOsc(ctx, gain, sources, { type: 'sine', f0: 2900, level: 0.016, tremRate: 0.9, tremDepth: 0.012 });
        this.bedOsc(ctx, gain, sources, { type: 'sine', f0: 3350, level: 0.012, tremRate: 1.4, tremDepth: 0.009 });
        break;
      case 'frostbite': // cold wind whistle: narrow wandering band + low body
        this.bedNoise(ctx, nbuf, gain, sources, {
          type: 'bandpass', f0: 820, q: 4.5, level: 0.5,
          freqRate: 0.07, freqDepth: 260, tremRate: 0.09, tremDepth: 0.2,
        });
        this.bedNoise(ctx, nbuf, gain, sources, { type: 'bandpass', f0: 280, q: 0.8, level: 0.55 });
        this.lfoInto(ctx, gain.gain, sources, 0.13, 0.04);
        break;
      case 'crossfire': // industrial hum, open-air: mains stack + pumps + soft wind
        this.industrial(ctx, nbuf, gain, sources);
        this.bedNoise(ctx, nbuf, gain, sources, { type: 'bandpass', f0: 500, q: 0.7, level: 0.22 });
        break;
      case 'bunker': // industrial hum, enclosed: mains stack + pumps + vent rumble
        this.industrial(ctx, nbuf, gain, sources);
        this.bedNoise(ctx, nbuf, gain, sources, { type: 'lowpass', f0: 200, level: 0.3 });
        break;
      case 'office': // office AC: broadband air-handler noise + faint mains hum
        this.bedNoise(ctx, nbuf, gain, sources, { type: 'lowpass', f0: 520, level: 0.5 });
        this.bedNoise(ctx, nbuf, gain, sources, { type: 'highpass', f0: 3800, level: 0.025 });
        this.bedOsc(ctx, gain, sources, { type: 'sine', f0: 100, level: 0.16 });
        this.bedOsc(ctx, gain, sources, { type: 'sine', f0: 200, level: 0.05 });
        this.lfoInto(ctx, gain.gain, sources, 0.2, 0.015);
        break;
    }
    for (const s of sources) s.start(t0);
    return { key, gain, sources };
  }

  /** Shared industrial bed: 60Hz mains stack + slowly pumping machinery band. */
  private industrial(
    ctx: AudioContext, nbuf: AudioBuffer, bed: GainNode,
    sources: Array<AudioBufferSourceNode | OscillatorNode>,
  ): void {
    this.bedOsc(ctx, bed, sources, { type: 'sine', f0: 60, level: 0.4 });
    this.bedOsc(ctx, bed, sources, { type: 'sine', f0: 120, level: 0.2 });
    this.bedOsc(ctx, bed, sources, { type: 'sine', f0: 240, level: 0.07 });
    this.bedNoise(ctx, nbuf, bed, sources, {
      type: 'bandpass', f0: 470, q: 1.2, level: 0.16, tremRate: 0.4, tremDepth: 0.08,
    });
  }

  /** Bed layer: looping noise → filter → pre-gain → bed, with optional slow
      tremolo (gain) and frequency wander (filter) LFOs. */
  private bedNoise(
    ctx: AudioContext, nbuf: AudioBuffer, bed: GainNode,
    sources: Array<AudioBufferSourceNode | OscillatorNode>, o: BedNoiseOpts,
  ): void {
    const src = ctx.createBufferSource();
    src.buffer = nbuf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = o.type;
    flt.frequency.value = o.f0;
    flt.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    g.gain.value = o.level;
    src.connect(flt);
    flt.connect(g);
    g.connect(bed);
    sources.push(src);
    if (o.tremRate !== undefined && o.tremDepth !== undefined) {
      this.lfoInto(ctx, g.gain, sources, o.tremRate, o.tremDepth);
    }
    if (o.freqRate !== undefined && o.freqDepth !== undefined) {
      this.lfoInto(ctx, flt.frequency, sources, o.freqRate, o.freqDepth);
    }
  }

  /** Bed layer: plain oscillator → pre-gain → bed, optional tremolo. */
  private bedOsc(
    ctx: AudioContext, bed: GainNode,
    sources: Array<AudioBufferSourceNode | OscillatorNode>, o: BedOscOpts,
  ): void {
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.value = o.f0;
    const g = ctx.createGain();
    g.gain.value = o.level;
    osc.connect(g);
    g.connect(bed);
    sources.push(osc);
    if (o.tremRate !== undefined && o.tremDepth !== undefined) {
      this.lfoInto(ctx, g.gain, sources, o.tremRate, o.tremDepth);
    }
  }

  /** Slow LFO → depth gain → target AudioParam (wind breathing, whistles). */
  private lfoInto(
    ctx: AudioContext, target: AudioParam,
    sources: Array<AudioBufferSourceNode | OscillatorNode>, rate: number, depth: number,
  ): void {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rate;
    const d = ctx.createGain();
    d.gain.value = depth;
    lfo.connect(d);
    d.connect(target);
    sources.push(lfo);
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
