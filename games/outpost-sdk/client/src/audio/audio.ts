// ============================================================================
// Synthesized audio engine for OUTPOST. 100% WebAudio: oscillators + ONE
// shared seeded white-noise buffer, envelopes + biquad filters — no asset
// files. Architecture ported from games/fps/client/src/audio/audio.ts:
// layered firearm crack/body/tail/slapback, a linear distance law, a
// per-call StereoPannerNode for bearing, and a master-gain -> compressor bus
// with a direct-connect fallback. Everything is a safe no-op until resume()
// creates the AudioContext on the first user gesture (browser autoplay
// policy). All randomness — noise fill, per-call pitch variance — goes
// through rng() from @platform/shared; Math.random is a contract violation.
//
// CONTRACT NOTE: OUTPOST's SfxOpts (shared/src/types.ts) is
// { dist?, vol?, bearing? } only — it carries no `occluded` flag the way
// STRICKEN's SfxOpts does, so there is no per-call occlusion lowpass here.
// This is a contract gap (worth adding `occluded?: boolean` to SfxOpts in a
// future revision); reported in the module summary, not worked around here.
//
// Horde readability (UX_BIBLE): zombie_groan / zombie_scream vary pitch per
// call via a seeded RNG, so many playing at once read as a crowd rather than
// a stutter of one identical loop. brute_roar, fence_break and wave_start
// each run their OWN much longer distance law (FAR_DIST_ZERO below) so they
// stay legible as "something changed, look now" across the whole ~40x40 m
// compound (FENCE_HALF = 20) out toward the ~60 m treeline, cutting through
// closer, quieter sounds that use the normal 45 m cutoff.
// ============================================================================
import { rng } from '@platform/shared';
import type { AudioApi, SfxKind, SfxOpts, TimeOfDay } from '@outpost/shared';

// ---- tuning constants -------------------------------------------------------
const MASTER_GAIN = 0.5;
const SHOT_CAP = 0.8; // shot_* kinds never exceed this post-attenuation gain
const DIST_FULL = 10; // m — unattenuated inside this radius
const DIST_ZERO = 45; // m — silent at/beyond this radius (linear between)
const TAIL_REACH = 1.8; // gunfire tail distance-law multiplier (audible to ~81m)
const TAIL_OFFSET = 0.02; // s — echo sits a hair behind the report
const SLAP_OFFSET = 0.07; // s — second tail tap (slapback) after the report
const SLAP_PEAK = 0.3; // slapback level relative to the tail peak
const PAN_MAX = 0.85; // stereo clamp — never hard-panned (keeps center image)
const XFADE = 1.6; // s — ambient dusk<->night crossfade (a time-of-day change, not a room cut)
const ENV_FLOOR = 0.0001; // exponential ramps may never target 0
const RECENT_CAP = 16; // recent() ring-buffer length

/** Kinds whose distance law reaches far past the normal 45 m cutoff — the
    compound-wide "something changed, look now" signals. */
const FAR_DIST_ZERO: Partial<Record<SfxKind, number>> = {
  brute_roar: 115,
  fence_break: 100,
  wave_start: 70,
};

type GunKind = 'shot_pistol' | 'shot_smg' | 'shot_rifle' | 'shot_sniper' | 'shot_shotgun';

const GUN_KINDS: ReadonlySet<SfxKind> = new Set<SfxKind>([
  'shot_pistol', 'shot_smg', 'shot_rifle', 'shot_sniper', 'shot_shotgun',
]);

interface GunRecipe {
  crack: { f0: number; q: number; dur: number; peak: number };
  body: { f0: number; f1: number; dur: number; peak: number };
  tail: { type: BiquadFilterType; f0: number; f1: number; q: number; dur: number; peak: number };
}

// Same 5-weapon character set as STRICKEN (pistol snap / smg pop / rifle
// crack / sniper boom / shotgun blast), reused near-verbatim per the port
// brief. OUTPOST's guns ARE @fps/shared WEAPONS verbatim, so their reports
// should sound like the same guns.
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

interface BeepOpts {
  type: OscillatorType; f0: number; f1?: number;
  t0: number; dur: number; peak: number;
}

interface BurstOpts {
  type: BiquadFilterType; f0: number; f1?: number; q?: number;
  t0: number; dur: number; peak: number; rate?: number;
}

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

interface AmbientPatch {
  key: TimeOfDay;
  gain: GainNode;
  sources: Array<AudioBufferSourceNode | OscillatorNode>;
}

/** Ambient bed gain per time of day (post-fade target, pre-master). */
const BED_LEVELS: Record<TimeOfDay, number> = { dusk: 0.16, night: 0.11 };

/** Footstep cycle: three variants so the compound's dirt/gravel ground never
    machine-guns on repeat. Plain switch (not array indexing) to stay clean
    under noUncheckedIndexedAccess. */
interface StepVariant { f0: number; peak: number }
function stepVariantAt(i: 0 | 1 | 2): StepVariant {
  switch (i) {
    case 0: return { f0: 620, peak: 0.42 };
    case 1: return { f0: 540, peak: 0.4 };
    default: return { f0: 580, peak: 0.44 };
  }
}

export class AudioEngine implements AudioApi {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private amb: AmbientPatch | null = null;
  private pendingAmb: TimeOfDay | null = null; // ambient() deferred while ctx suspended
  private stepVariant: 0 | 1 | 2 = 0; // footstep cycles three variants
  private readonly recentLog: SfxKind[] = []; // feeds recent() / telemetry().recentSfx
  private readonly pitchNext: () => number = rng(0x017e5); // seeded per-call pitch variance (horde crowd read)
  private readonly jitterNext: () => number = rng(0xf017e); // seeded ±10% footstep-rate jitter

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
    // bus glue: master -> compressor -> destination, direct-connect fallback
    let comp: DynamicsCompressorNode | null = null;
    try {
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 20;
      comp.ratio.value = 4;
      comp.attack.value = 0.003; // fast: catches shot transients, not the beds
      comp.release.value = 0.2;
    } catch {
      comp = null;
    }
    if (comp) {
      this.master.connect(comp);
      comp.connect(ctx.destination);
    } else {
      this.master.connect(ctx.destination);
    }
    // shared 1s white-noise buffer, seeded (determinism rule; reused by everything)
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    const nextNoise = rng(0x5eed);
    for (let i = 0; i < data.length; i++) data[i] = nextNoise() * 2 - 1;
    this.noiseBuf = buf;
    if (ctx.state === 'suspended') void ctx.resume();
    this.flushPendingAmbient();
  }

  /** One-shot effect. dist attenuates linearly: full <=10m, 0 at the kind's
      distance-zero (45m normally; brute_roar/fence_break/wave_start reach much
      farther — see FAR_DIST_ZERO). Gunfire keeps a far echo: the tail +
      slapback layers run the same law against a 1.8x radius. bearing pans the
      whole one-shot (sin, clamped +-0.85). */
  sfx(kind: SfxKind, opts?: SfxOpts): void {
    this.recentLog.push(kind);
    if (this.recentLog.length > RECENT_CAP) this.recentLog.shift();
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return;
    const vol = opts?.vol ?? 1;
    const dist = opts?.dist;
    const distZero = FAR_DIST_ZERO[kind] ?? DIST_ZERO;
    const g0 = vol * attenuate(dist, distZero);
    const gun = GUN_KINDS.has(kind);
    const gFar = gun
      ? Math.min(SHOT_CAP, vol * attenuate(dist === undefined ? undefined : dist / TAIL_REACH, distZero))
      : 0;
    if (g0 <= 0 && (!gun || gFar <= 0)) return;
    // 0 near .. 1 at/beyond distZero — drives tail stretch + muffle
    const dist01 = dist === undefined ? 0 : Math.min(1, Math.max(0, (dist - DIST_FULL) / (distZero - DIST_FULL)));
    const t0 = ctx.currentTime;
    const shot = Math.min(SHOT_CAP, g0); // shot_* kinds share the 0.8 cap
    try {
      const bearing = opts?.bearing;
      const pan = bearing !== undefined && Number.isFinite(bearing)
        ? Math.max(-PAN_MAX, Math.min(PAN_MAX, Math.sin(bearing)))
        : 0;
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      panner.connect(master);
      this.play(kind, ctx, nbuf, panner, t0, g0, gFar, shot, dist01);
    } catch {
      // audio must never crash the client (contract robustness rule)
    }
  }

  /** Looping ambient bed: wind + insects at dusk, thinning into a low drone
      at night (STYLE_BIBLE mood). `false` fades the bed out. */
  ambient(tod: TimeOfDay | false): void {
    if (tod === false) {
      this.stopAmbient();
      return;
    }
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') {
      // context missing/suspended (joined before the gesture completed) —
      // remember the request; resume() applies it once running
      this.pendingAmb = tod;
      return;
    }
    this.pendingAmb = null;
    try {
      if (this.amb && this.amb.key === tod) return; // bed already running
      const t0 = ctx.currentTime;
      if (this.amb) this.stopPatch(this.amb, t0);
      this.amb = this.makePatch(ctx, nbuf, master, tod, t0);
    } catch {
      // audio must never crash the client
    }
  }

  /** Stop the ambient bed with a fade. Called on world teardown. */
  stopAmbient(): void {
    this.pendingAmb = null;
    const patch = this.amb;
    this.amb = null;
    if (!patch) return;
    try {
      const ctx = this.ctx;
      if (ctx && ctx.state === 'running') {
        this.stopPatch(patch, ctx.currentTime, 0.6);
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

  /** Rolling log of the last SfxKinds played — feeds telemetry().recentSfx so
      the run-phase harness can assert a core action produced audible feedback. */
  recent(): readonly SfxKind[] {
    return this.recentLog.slice();
  }

  /** Tear down the context. Safe to call multiple times. */
  dispose(): void {
    this.pendingAmb = null;
    const patch = this.amb;
    this.amb = null;
    if (patch) {
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
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    if (ctx) {
      try {
        void ctx.close();
      } catch {
        // already closed / closing — fine
      }
    }
  }

  // ---- kind dispatch -----------------------------------------------------

  /** Every SfxKind gets a distinct, deliberate recipe. `dest` is the per-call
      spatial chain (stereo panner) already connected to the master bus. */
  private play(
    kind: SfxKind, ctx: AudioContext, nbuf: AudioBuffer, dest: AudioNode,
    t0: number, g0: number, gFar: number, shot: number, dist01: number,
  ): void {
    switch (kind) {
      // ---- weapons: crack + body + tail + slapback, per-weapon character --
      case 'shot_pistol':
      case 'shot_smg':
      case 'shot_rifle':
      case 'shot_sniper':
      case 'shot_shotgun':
        this.gunfire(ctx, nbuf, dest, t0, shot, gFar, dist01, GUN_RECIPES[kind]);
        break;
      case 'shot_knife': // low body + main sweep + air sheen
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 480, f1: 2800, q: 1.4, t0, dur: 0.17, peak: 0.5 * shot });
        this.burst(ctx, nbuf, dest, { type: 'highpass', f0: 2600, f1: 4200, t0: t0 + 0.02, dur: 0.11, peak: 0.13 * shot });
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 240, f1: 900, q: 1, t0, dur: 0.15, peak: 0.18 * shot });
        break;
      case 'reload': // foley sequence: mag-out click, mag-in click, rack slide
        this.burst(ctx, nbuf, dest, { type: 'highpass', f0: 2400, t0, dur: 0.02, peak: 0.28 * g0 });
        this.beep(ctx, dest, { type: 'sine', f0: 260, f1: 175, t0, dur: 0.045, peak: 0.16 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'highpass', f0: 1900, t0: t0 + 0.17, dur: 0.022, peak: 0.3 * g0 });
        this.beep(ctx, dest, { type: 'sine', f0: 215, f1: 150, t0: t0 + 0.17, dur: 0.05, peak: 0.18 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 900, q: 0.9, t0: t0 + 0.155, dur: 0.03, peak: 0.1 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 2000, f1: 950, q: 1.3, t0: t0 + 0.37, dur: 0.09, peak: 0.24 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'highpass', f0: 3200, t0: t0 + 0.46, dur: 0.018, peak: 0.26 * g0 });
        this.beep(ctx, dest, { type: 'sine', f0: 320, f1: 205, t0: t0 + 0.46, dur: 0.032, peak: 0.12 * g0 });
        break;

      // ---- combat feedback ------------------------------------------------
      case 'hit_flesh': // soft wet tick — quieter/duller than headshot's ding
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 950, q: 1.1, t0, dur: 0.03, peak: 0.22 * g0 });
        this.beep(ctx, dest, { type: 'sine', f0: 260, f1: 150, t0, dur: 0.04, peak: 0.12 * g0 });
        break;
      case 'headshot': // bright ding + noise attack tick
        this.beep(ctx, dest, { type: 'sine', f0: 2100, t0, dur: 0.055, peak: 0.32 * g0 });
        this.beep(ctx, dest, { type: 'sine', f0: 3150, t0, dur: 0.04, peak: 0.15 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'highpass', f0: 5200, t0, dur: 0.008, peak: 0.12 * g0 });
        break;

      // ---- zombies ----------------------------------------------------------
      case 'zombie_die': { // descending growl collapsing into a low thud
        this.beep(ctx, dest, { type: 'sawtooth', f0: 220, f1: 70, t0, dur: 0.32, peak: 0.4 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'lowpass', f0: 600, f1: 150, t0, dur: 0.28, peak: 0.3 * g0 });
        this.beep(ctx, dest, { type: 'sine', f0: 90, f1: 40, t0: t0 + 0.05, dur: 0.25, peak: 0.25 * g0 });
        break;
      }
      case 'zombie_groan': { // low moan; pitch varies per call so a crowd reads as many
        const mul = this.pitchMul(4);
        const f0 = 118 * mul;
        const f1 = 92 * mul;
        this.beep(ctx, dest, { type: 'sawtooth', f0, f1, t0, dur: 0.55, peak: 0.4 * g0 });
        this.beep(ctx, dest, { type: 'sine', f0: f0 * 1.5, f1: f1 * 1.5, t0, dur: 0.5, peak: 0.15 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 480 * mul, q: 0.6, t0, dur: 0.4, peak: 0.12 * g0 });
        break;
      }
      case 'zombie_scream': { // sharp shriek; pitch varies per call
        const mul = this.pitchMul(5);
        const f0 = 900 * mul;
        const f1 = 1500 * mul;
        this.beep(ctx, dest, { type: 'sawtooth', f0, f1, t0, dur: 0.28, peak: 0.5 * g0 });
        this.beep(ctx, dest, { type: 'square', f0: f0 * 0.5, f1: f1 * 0.5, t0, dur: 0.2, peak: 0.18 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'highpass', f0: 2200 * mul, t0, dur: 0.22, peak: 0.28 * g0 });
        break;
      }
      case 'brute_roar': // massive: sub rumble + growl + roar sweep — must cut through everything
        this.beep(ctx, dest, { type: 'sine', f0: 48, f1: 36, t0, dur: 1.1, peak: 0.7 * g0 });
        this.beep(ctx, dest, { type: 'sawtooth', f0: 95, f1: 60, t0, dur: 0.9, peak: 0.55 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 320, f1: 900, q: 0.5, t0, dur: 0.8, peak: 0.5 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'lowpass', f0: 200, t0: t0 + 0.05, dur: 0.6, peak: 0.35 * g0 });
        break;
      case 'spit_launch': // wet, quick whoosh
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 700, f1: 1600, q: 1.2, t0, dur: 0.1, peak: 0.4 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'highpass', f0: 3500, t0, dur: 0.05, peak: 0.12 * g0 });
        break;
      case 'spit_land': // wet splat impact
        this.burst(ctx, nbuf, dest, { type: 'lowpass', f0: 350, t0, dur: 0.14, peak: 0.45 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 1400, q: 2, t0, dur: 0.03, peak: 0.18 * g0 });
        break;

      // ---- fence -------------------------------------------------------------
      case 'fence_hit': // wood+wire impact clank
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 550, q: 1.4, t0, dur: 0.05, peak: 0.35 * g0 });
        this.beep(ctx, dest, { type: 'triangle', f0: 150, f1: 95, t0, dur: 0.09, peak: 0.3 * g0 });
        break;
      case 'fence_break': // big multi-layer crash — must be unmistakable compound-wide
        this.beep(ctx, dest, { type: 'sawtooth', f0: 110, f1: 40, t0, dur: 0.4, peak: 0.4 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'lowpass', f0: 900, f1: 150, t0, dur: 0.35, peak: 0.7 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'highpass', f0: 2800, t0, dur: 0.15, peak: 0.35 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 1200, q: 1, t0: t0 + 0.09, dur: 0.1, peak: 0.25 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 900, q: 1, t0: t0 + 0.18, dur: 0.1, peak: 0.2 * g0 });
        break;
      case 'repair_tick': // brisk mechanical tap
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 1300, q: 1.5, t0, dur: 0.025, peak: 0.3 * g0 });
        this.beep(ctx, dest, { type: 'square', f0: 500, t0, dur: 0.025, peak: 0.15 * g0 });
        break;
      case 'repair_done': // satisfied 2-note rise
        this.beep(ctx, dest, { type: 'triangle', f0: 660, t0, dur: 0.1, peak: 0.3 * g0 });
        this.beep(ctx, dest, { type: 'triangle', f0: 990, t0: t0 + 0.09, dur: 0.18, peak: 0.32 * g0 });
        break;

      // ---- teammates: the emotional beats -----------------------------------
      case 'downed': // heavy sinking thud + a groan underneath
        this.beep(ctx, dest, { type: 'sine', f0: 180, f1: 70, t0, dur: 0.5, peak: 0.55 * g0 });
        this.beep(ctx, dest, { type: 'sawtooth', f0: 140, f1: 55, t0: t0 + 0.03, dur: 0.45, peak: 0.22 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'lowpass', f0: 260, t0, dur: 0.3, peak: 0.3 * g0 });
        break;
      case 'revive_tick': // soft rhythmic pulse, distinct from heartbeat's low thump
        this.beep(ctx, dest, { type: 'sine', f0: 340, t0, dur: 0.06, peak: 0.22 * g0 });
        break;
      case 'revive_done': // warm ascending major arpeggio — the relief beat
        this.beep(ctx, dest, { type: 'triangle', f0: 392, t0, dur: 0.16, peak: 0.28 * g0 });
        this.beep(ctx, dest, { type: 'triangle', f0: 493.88, t0: t0 + 0.13, dur: 0.18, peak: 0.3 * g0 });
        this.beep(ctx, dest, { type: 'triangle', f0: 587.33, t0: t0 + 0.26, dur: 0.32, peak: 0.34 * g0 });
        this.beep(ctx, dest, { type: 'sine', f0: 783.99, t0: t0 + 0.26, dur: 0.3, peak: 0.12 * g0 });
        break;

      // ---- wave / match stingers ----------------------------------------------
      case 'wave_start': // rising detuned alarm — reads across the whole compound
        this.beep(ctx, dest, { type: 'sawtooth', f0: 180, f1: 260, t0, dur: 0.5, peak: 0.4 * g0 });
        this.beep(ctx, dest, { type: 'sawtooth', f0: 184, f1: 266, t0, dur: 0.5, peak: 0.28 * g0 });
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: 600, q: 0.6, t0, dur: 0.4, peak: 0.2 * g0 });
        break;
      case 'wave_clear': // 3-note chime over a low root+fifth bed
        this.beep(ctx, dest, { type: 'sine', f0: 130.81, t0, dur: 0.7, peak: 0.1 * g0 });
        this.beep(ctx, dest, { type: 'sine', f0: 196, t0, dur: 0.7, peak: 0.07 * g0 });
        this.beep(ctx, dest, { type: 'triangle', f0: 523.25, t0, dur: 0.15, peak: 0.28 * g0 });
        this.beep(ctx, dest, { type: 'triangle', f0: 659.25, t0: t0 + 0.13, dur: 0.15, peak: 0.28 * g0 });
        this.beep(ctx, dest, { type: 'triangle', f0: 783.99, t0: t0 + 0.26, dur: 0.3, peak: 0.3 * g0 });
        break;
      case 'run_end': // solemn falling resolve — the run is over
        this.beep(ctx, dest, { type: 'triangle', f0: 329.63, t0, dur: 0.4, peak: 0.28 * g0 });
        this.beep(ctx, dest, { type: 'triangle', f0: 261.63, t0: t0 + 0.32, dur: 0.6, peak: 0.3 * g0 });
        this.beep(ctx, dest, { type: 'sine', f0: 130.81, t0: t0 + 0.32, dur: 0.6, peak: 0.12 * g0 });
        break;

      // ---- economy / UI --------------------------------------------------------
      case 'buy': // cash blip
        this.beep(ctx, dest, { type: 'sine', f0: 1000, t0, dur: 0.06, peak: 0.28 * g0 });
        this.beep(ctx, dest, { type: 'sine', f0: 1500, t0: t0 + 0.05, dur: 0.05, peak: 0.16 * g0 });
        break;
      case 'deny': // buzz — two detuned squares read harsher than one
        this.beep(ctx, dest, { type: 'square', f0: 180, t0, dur: 0.2, peak: 0.2 * g0 });
        this.beep(ctx, dest, { type: 'square', f0: 184, t0, dur: 0.2, peak: 0.13 * g0 });
        break;
      case 'click': // UI tick
        this.beep(ctx, dest, { type: 'sine', f0: 2000, t0, dur: 0.025, peak: 0.15 * g0 });
        break;

      // ---- footstep + health -----------------------------------------------
      case 'footstep': { // three cycled variants + seeded rate jitter (no machine-gun repeat)
        this.stepVariant = ((this.stepVariant + 1) % 3) as 0 | 1 | 2;
        const v = stepVariantAt(this.stepVariant);
        this.burst(ctx, nbuf, dest, { type: 'bandpass', f0: v.f0, q: 0.8, t0, dur: 0.045, peak: v.peak * g0, rate: this.stepRate() });
        this.burst(ctx, nbuf, dest, { type: 'lowpass', f0: v.f0 * 0.6, t0, dur: 0.06, peak: v.peak * 0.5 * g0, rate: this.stepRate() });
        break;
      }
      case 'heartbeat': // low-health pulse: the non-colour danger channel (UX_BIBLE)
        this.beep(ctx, dest, { type: 'sine', f0: 70, f1: 45, t0, dur: 0.11, peak: 0.4 * g0 });
        this.beep(ctx, dest, { type: 'sine', f0: 55, f1: 35, t0: t0 + 0.16, dur: 0.13, peak: 0.3 * g0 });
        break;

      default: {
        // exhaustiveness guard: a new SfxKind added to the contract without a
        // recipe here fails typecheck instead of silently playing nothing
        const exhaustive: never = kind;
        void exhaustive;
      }
    }
  }

  // ---- synth primitives ----------------------------------------------------

  /** Oscillator with fast-attack / exponential-decay envelope into `dest`. */
  private beep(ctx: AudioContext, dest: AudioNode, o: BeepOpts): void {
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.f0, o.t0);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(o.f1, o.t0 + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(ENV_FLOOR, o.t0);
    g.gain.exponentialRampToValueAtTime(Math.max(o.peak, ENV_FLOOR), o.t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(ENV_FLOOR, o.t0 + o.dur);
    osc.connect(g);
    g.connect(dest);
    osc.start(o.t0);
    osc.stop(o.t0 + o.dur + 0.02);
  }

  /** Filtered noise burst (from the shared buffer) with the same envelope.
      rate jitters playbackRate (footstep de-repeat); default 1. */
  private burst(ctx: AudioContext, nbuf: AudioBuffer, dest: AudioNode, o: BurstOpts): void {
    const src = ctx.createBufferSource();
    src.buffer = nbuf;
    src.playbackRate.value = o.rate ?? 1;
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
    g.connect(dest);
    src.start(o.t0);
    src.stop(o.t0 + o.dur + 0.02);
  }

  /** Firearm layer stack: crack transient + body (triangle thump + detuned
      sine shadow, near field only), the tail echo (started a hair late,
      stretched and muffled by distance, gained by the far-field law) and a
      quieter slapback tap 70ms out (early reflection off far walls). */
  private gunfire(
    ctx: AudioContext, nbuf: AudioBuffer, dest: AudioNode, t0: number,
    near: number, far: number, dist01: number, r: GunRecipe,
  ): void {
    if (near > 0) {
      this.burst(ctx, nbuf, dest, {
        type: 'bandpass', f0: r.crack.f0, q: r.crack.q, t0, dur: r.crack.dur, peak: r.crack.peak * near,
      });
      this.beep(ctx, dest, {
        type: 'triangle', f0: r.body.f0, f1: r.body.f1, t0, dur: r.body.dur, peak: r.body.peak * near,
      });
      this.beep(ctx, dest, { // detuned shadow thickens the body (~14 cents up)
        type: 'sine', f0: r.body.f0 * 1.008, f1: r.body.f1 * 1.008, t0, dur: r.body.dur, peak: r.body.peak * 0.5 * near,
      });
    }
    this.burst(ctx, nbuf, dest, {
      type: r.tail.type,
      f0: r.tail.f0 * (1 - dist01 * 0.3), // distant echo muffle
      f1: r.tail.f1,
      q: r.tail.q,
      t0: t0 + TAIL_OFFSET,
      dur: r.tail.dur * (1 + dist01 * 0.7), // distant echo stretch
      peak: r.tail.peak * far,
    });
    this.burst(ctx, nbuf, dest, { // slapback: second, quieter tail tap at +70ms
      type: r.tail.type,
      f0: r.tail.f0 * 0.5 * (1 - dist01 * 0.3),
      f1: r.tail.f1,
      q: r.tail.q,
      t0: t0 + SLAP_OFFSET,
      dur: r.tail.dur * 0.55 * (1 + dist01 * 0.7),
      peak: r.tail.peak * SLAP_PEAK * far,
    });
  }

  /** Seeded ±10% playbackRate jitter — kills machine-gun footstep repetition. */
  private stepRate(): number {
    return 1 + (this.jitterNext() * 0.2 - 0.1);
  }

  /** Seeded pitch multiplier within +-`semitones` — the horde "crowd" read:
      many zombie_groan/zombie_scream calls each land on a slightly different
      pitch instead of all sounding like one looped sample. */
  private pitchMul(semitones: number): number {
    const x = (this.pitchNext() * 2 - 1) * semitones;
    return Math.pow(2, x / 12);
  }

  // ---- ambient beds ----------------------------------------------------------

  private makePatch(
    ctx: AudioContext, nbuf: AudioBuffer, master: GainNode, key: TimeOfDay, t0: number,
  ): AmbientPatch {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(ENV_FLOOR, t0);
    gain.gain.linearRampToValueAtTime(BED_LEVELS[key], t0 + XFADE);
    gain.connect(master);
    const sources: Array<AudioBufferSourceNode | OscillatorNode> = [];
    if (key === 'dusk') {
      // wind: wandering mid-low band with a slow breathing tremolo
      this.bedNoise(ctx, nbuf, gain, sources, {
        type: 'bandpass', f0: 380, q: 0.8, level: 0.85, freqRate: 0.06, freqDepth: 90,
      });
      this.lfoInto(ctx, gain.gain, sources, 0.12, 0.03);
      // insects: a chirpy high band gated by a fast tremolo, plus two thin
      // cricket-ish sines at slightly different rates so it never locks into
      // one obvious loop
      this.bedNoise(ctx, nbuf, gain, sources, {
        type: 'bandpass', f0: 4600, q: 5, level: 0.09, tremRate: 6.5, tremDepth: 0.07,
      });
      this.bedOsc(ctx, gain, sources, { type: 'sine', f0: 5200, level: 0.02, tremRate: 4.8, tremDepth: 0.018 });
      this.bedOsc(ctx, gain, sources, { type: 'sine', f0: 6100, level: 0.014, tremRate: 3.9, tremDepth: 0.012 });
    } else {
      // night: a low drone dominates; insects thin to a faint residue rather
      // than vanishing outright
      this.bedOsc(ctx, gain, sources, { type: 'sine', f0: 52, level: 0.4 });
      this.bedOsc(ctx, gain, sources, { type: 'sine', f0: 104, level: 0.14 });
      this.bedNoise(ctx, nbuf, gain, sources, {
        type: 'lowpass', f0: 160, level: 0.34, tremRate: 0.08, tremDepth: 0.06,
      });
      this.bedNoise(ctx, nbuf, gain, sources, {
        type: 'bandpass', f0: 4200, q: 5, level: 0.02, tremRate: 5.5, tremDepth: 0.015,
      });
    }
    for (const s of sources) s.start(t0);
    return { key, gain, sources };
  }

  /** Bed layer: looping noise -> filter -> pre-gain -> bed, with optional slow
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

  /** Bed layer: plain oscillator -> pre-gain -> bed, optional tremolo. */
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

  /** Slow LFO -> depth gain -> target AudioParam (wind breathing, cricket chirp). */
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
}

/** Linear distance attenuation: 1 at <= DIST_FULL, 0 at/beyond `distZero`. */
function attenuate(dist: number | undefined, distZero: number): number {
  if (dist === undefined || dist <= DIST_FULL) return 1;
  if (dist >= distZero) return 0;
  return 1 - (dist - DIST_FULL) / (distZero - DIST_FULL);
}
