// ============================================================================
// ACES client — synthesized audio engine (C_AUDIO). 100% WebAudio, ZERO
// assets (RULES 12: no image/font assets, everything drawn or synthesized).
//
// Structure follows the house engines (games/outpost/client/src/audio/audio.ts,
// games/splat/client/src/audio.ts): ONE shared white-noise buffer filled from
// a seeded rng (RULES 3 — Math.random is a contract violation; the seed goes
// through visual.ts's makeRng, the only sanctioned randomness under games/
// aces), oscillator/beep + filtered-burst/burst envelope primitives, a
// masterGain -> DynamicsCompressor -> destination limiter bus with a
// direct-connect fallback, and setTargetAtTime for every per-frame param move
// (cheap, click-free, per-frame safe).
//
// Graph inventory (built once at unlock()):
//   master ──> compressor ──> destination          (limiter; fallback: direct)
//   engine: sawtooth ─> lowpass ─> gate ─> master  (+slow LFO on the cutoff =
//        propeller wobble; pitched by throttle/speedFrac via engineFreq())
//   wind:   looped noise ─> bandpass ─> gate ─> master (+two slow drift LFOs
//        on cutoff and gain so the bed breathes instead of sitting still)
//   one-shots: scheduled per event straight into master, each event admitted
//        through admitVoice() against the global VOICE_CAP FIFO — when the
//        cap is hit the OLDEST voice is stolen (stopped) so a crossfire storm
//        can never pile up unbounded node counts. Why a cap at all: CLASSES'
//        guns volley at 9–11 Hz per shooter (config.ts rateHz; the volley
//        CADENCE is the caller's job — shot() fires once per volley), eight
//        brawling planes can therefore request ~80+ voices/second; 24 slots
//        ≈ a quarter second of the densest crossfire, plenty for ear-salience.
//
// Distance law: ONE curve, attenuation(d) = 1/(1 + d/600) — smooth, never
// zero, monotone — used for remote gunfire gain AND muffle (the lowpass
// cutoff interpolates toward a dull thump as the curve falls), and for
// explosions. Own guns bypass it deliberately: your ears sit at the breech.
//
// Mute: master-gain ramp only (continuous voices keep running under a silent
// bus so unmute is instant); one-shot scheduling is SKIPPED while muted —
// no point allocating dozens of doomed nodes per second during a muted
// firefight. Preference persists in localStorage 'aces.muted' (guarded,
// try/catch'd — blocked storage degrades to session-only, kart/splat
// precedent).
//
// Robustness (RULES 5): unlock() feature-tests AudioContext behind the first
// gesture; construction is try/catch'd; EVERY method guards context presence
// + 'running' state and swallows its own exceptions. Without WebAudio the
// whole API degrades to silent no-ops — audio must never crash the client.
// ============================================================================
import type { AudioApi } from '../contract/seams.js';
import { makeRng } from '../contract/visual.js';
import { BOOST_MULT, STREAK_ACE, STREAK_LEGEND } from '@aces/shared/config.js';

// ---- master bus -------------------------------------------------------------
const MASTER_GAIN = 0.5; //     house-standard bus level (outpost/splat)
const MUTE_GAIN = 0.0001; //    exponential-ramp-safe silence (never target 0)
const MUTE_TAU_S = 0.03; //     fast dip on mute…
const UNMUTE_TAU_S = 0.08; //   …slightly softer swell back in (no pop)
const ENV_FLOOR = 0.0001; //    envelope floors for exponential ramps
const NOISE_SEED = 0xace5; //   shared noise-buffer fill stream (makeRng)
const COMP_THRESHOLD_DB = -14; // glue limiter: stacked one-shots never clip
const COMP_KNEE_DB = 20;
const COMP_RATIO = 6;
const COMP_ATTACK_S = 0.003; // fast enough to catch MG transients
const COMP_RELEASE_S = 0.22;

/** Global concurrent one-shot voice budget; the oldest voice is stolen past
    this. Pure bookkeeping lives in admitVoice() (unit-tested headlessly). */
export const VOICE_CAP = 24;

// ---- distance ---------------------------------------------------------------
/** Reference distance for attenuation(): gain = 1/(1 + d/600). At 600 u the
    report is half; the 4200×3000 map's far corner (~5100 u diagonal) lands
    near 0.12 — audible context, zero clutter. */
export const DIST_REF_U = 600;

// ---- engine voice -------------------------------------------------------------
export const ENGINE_MIN_HZ = 55; // idle drone floor (brief: ≈55–115 Hz)
export const ENGINE_MAX_HZ = 115; // full-throttle top (pre-boost)
/** Throttle vs speedFrac weights in the pitch blend: the LEVER is what the
    pilot moves, so it dominates; speed confirms (prop load). */
const ENGINE_THROTTLE_W = 0.6;
const ENGINE_LEVEL = 0.17; // modest — the drone sits under every one-shot
const ENGINE_TAU_S = 0.09; // per-frame smoothing; call ownEngine() every frame
const ENGINE_CUT_BASE_HZ = 420; // lowpass seat of the drone…
const ENGINE_CUT_SPAN_HZ = 520; // …opening with drive (brighter at speed)
const PROP_LFO_HZ = 7.5; // slow wobble on the cutoff = propeller feel
const PROP_LFO_DEPTH_HZ = 55;

// ---- wind bed -----------------------------------------------------------------
const WIND_LEVEL = 0.12; // gain at full speedFrac (scaled by frac²)
const WIND_BASE_HZ = 300; // bandpass center parked at
const WIND_SPAN_HZ = 1500; // …sweeping open with airspeed
const WIND_Q = 0.65; // wide band — rushing air, not a whistle
const WIND_TAU_S = 0.15; // smooth speed tracking, click-free
const WIND_DRIFT_F_HZ = 0.17; // slow LFO drift on the cutoff…
const WIND_DRIFT_F_DEPTH = 55; // …so the bed breathes
const WIND_DRIFT_G_HZ = 0.11; // …and a second, slower one on the gain
const WIND_DRIFT_G_DEPTH = 0.018;

// ---- mute persistence -----------------------------------------------------------
/** localStorage key for the persisted M-mute flag (values '1'/'0'). */
export const MUTED_KEY = 'aces.muted';
const MUTED_ON = '1';
const MUTED_OFF = '0';

/** Minimal storage face we need — injectable so tests can round-trip without
    a real localStorage (and production can survive blocked storage). */
export type MutedStore = Pick<Storage, 'getItem' | 'setItem'>;

/** The ambient storage when none is injected; undefined when absent/blocked
    (headless tests, privacy modes). typeof guard first: touching a bare
    `localStorage` identifier in a storage-less realm THROWS. */
function globalStore(): MutedStore | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined; // accessing storage itself threw (exotic embeds)
  }
}

/** Read the persisted mute flag. Anything but the exact '1' reads as unmuted
    (missing key, corrupted value, throwing store). */
export function loadMuted(store: MutedStore | undefined = globalStore()): boolean {
  if (!store) return false;
  try {
    return store.getItem(MUTED_KEY) === MUTED_ON;
  } catch {
    return false;
  }
}

/** Persist the mute flag. Best-effort: blocked/quota'd storage silently
    degrades to a session-only toggle (kart 'kart.kids' precedent). */
export function saveMuted(muted: boolean, store: MutedStore | undefined = globalStore()): void {
  if (!store) return;
  try {
    store.setItem(MUTED_KEY, muted ? MUTED_ON : MUTED_OFF);
  } catch {
    // storage unavailable — the toggle still works for this session
  }
}

// ---- pure curves -----------------------------------------------------------------

/** Clamp to 0..1; non-finite input (NaN/±Inf from upstream math gone wrong)
    collapses to 0 rather than poisoning the audio graph with NaN params. */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Remote-event gain for a distance in world units: 1/(1 + d/DIST_REF_U).
 * Smooth, strictly decreasing, never zero — distant fights stay faintly
 * legible (readable sky, D4, extends to ears). Pure and exported so the
 * curve is unit-testable headless. Non-finite/negative distances mean
 * "at the ear": full gain.
 */
export function attenuation(distU: number): number {
  const d = Number.isFinite(distU) && distU > 0 ? distU : 0;
  return 1 / (1 + d / DIST_REF_U);
}

/**
 * Own-engine pitch in Hz. Blends throttle (weight ENGINE_THROTTLE_W) with
 * speedFrac into the ≈55–115 Hz band; boosting multiplies by config
 * BOOST_MULT (1.42) — the same factor the physics applies to speedMax, so
 * the ear hears the surge the airframe performs. Inputs clamp to 0..1;
 * boosted results intentionally exceed ENGINE_MAX_HZ (that IS the bump).
 */
export function engineFreq(throttle: number, speedFrac: number, boosting: boolean): number {
  const th = clamp01(throttle);
  const sf = clamp01(speedFrac);
  const drive = ENGINE_THROTTLE_W * th + (1 - ENGINE_THROTTLE_W) * sf;
  const base = ENGINE_MIN_HZ + (ENGINE_MAX_HZ - ENGINE_MIN_HZ) * drive;
  return boosting ? base * BOOST_MULT : base;
}

/**
 * Voice-cap bookkeeping: append `incoming` to a FIFO of live voices; if that
 * pushes past `cap`, evict (steal) the OLDEST entry. Returns the new queue
 * plus the evicted element (null when there was room). Generic + pure so
 * tests exercise the eviction order with bare numbers. A cap < 1 is coerced
 * to 1 — the incoming voice always plays; only its predecessor can be stolen.
 */
export function admitVoice<T>(
  queue: readonly T[],
  incoming: T,
  cap: number,
): { queue: T[]; evicted: T | null } {
  const limit = Math.max(1, Math.floor(cap));
  const next = [...queue, incoming];
  if (next.length <= limit) return { queue: next, evicted: null };
  const evicted = next.shift();
  return { queue: next, evicted: evicted ?? null };
}

// ---- synth-primitive plumbing -----------------------------------------------------

interface BeepOpts {
  type: OscillatorType; f0: number; f1?: number;
  t0: number; dur: number; peak: number;
}

interface BurstOpts {
  type: BiquadFilterType; f0: number; f1?: number; q?: number;
  t0: number; dur: number; peak: number;
  attack?: number; // seconds swelling to peak (default ~instant)
}

/** Everything one one-shot event scheduled, so the FIFO cap can steal the
    whole event (all its layers) at once — eviction is per EVENT, not per
    node, or a half-killed explosion would buzz. */
interface OneShotHandle {
  readonly stops: Array<() => void>;
  stop(): void;
}

/** Persistent voices, built ONCE at unlock and gated by gain thereafter (an
    AudioBufferSourceNode/OscillatorNode may only start once — retriggering
    would throw; gating avoids that class of bug entirely). */
interface EngineRig {
  osc: OscillatorNode;
  flt: BiquadFilterNode;
  gain: GainNode;
}

interface WindRig {
  flt: BiquadFilterNode;
  gain: GainNode;
}

// ---- distant-gunfire muffle seats --------------------------------------------------
/** Remote reports lowpass between these seats, interpolated by attenuation():
    close-in remote fire keeps a 1000 Hz bite, map-edge fire slumps to a 170
    Hz thump. Sweeping DOWN from the seat during the burst sells "energy
    leaving". */
const FAR_CUT_NEAR_HZ = 1000;
const FAR_CUT_FLOOR_HZ = 170;

/**
 * Lowpass SEAT for a remote gunshot at distance distU: the muffle rides the
 * same attenuation() curve as the gain, so quiet implies dull (one law, two
 * ears-worth of cues). Pure and exported for headless tests.
 */
export function farCutoff(distU: number): number {
  return FAR_CUT_FLOOR_HZ + (FAR_CUT_NEAR_HZ - FAR_CUT_FLOOR_HZ) * attenuation(distU);
}

export class AcesAudio implements AudioApi {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private engine: EngineRig | null = null;
  private windRig: WindRig | null = null;
  private muted = false;
  /** Set once the USER toggles this session; afterwards the stored value is
      never re-adopted (a stale '1' must not override a fresh click). */
  private muteTouched = false;
  /** Live one-shot events, oldest first — the VOICE_CAP FIFO. */
  private events: OneShotHandle[] = [];

  /**
   * Create/unlock the AudioContext on the first user gesture (autoplay
   * policy). Idempotent: later calls only resume a suspended context, they
   * never rebuild the graph. Resolves even when WebAudio is missing —
   * callers may await blindly.
   */
  async unlock(): Promise<void> {
    try {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
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
      // master chain: masterGain -> compressor (limiter) -> destination,
      // direct-connect fallback when DynamicsCompressor is unavailable
      const master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      this.master = master;
      let comp: DynamicsCompressorNode | null = null;
      try {
        comp = ctx.createDynamicsCompressor();
        comp.threshold.value = COMP_THRESHOLD_DB;
        comp.knee.value = COMP_KNEE_DB;
        comp.ratio.value = COMP_RATIO;
        comp.attack.value = COMP_ATTACK_S;
        comp.release.value = COMP_RELEASE_S;
      } catch {
        comp = null;
      }
      if (comp) {
        master.connect(comp);
        comp.connect(ctx.destination);
      } else {
        master.connect(ctx.destination);
      }
      // shared 1 s white-noise buffer, SEEDED (RULES 3; reused by every burst)
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = buf.getChannelData(0);
      const nextNoise = makeRng(NOISE_SEED);
      for (let i = 0; i < data.length; i++) data[i] = nextNoise() * 2 - 1;
      this.noiseBuf = buf;
      // adopt the persisted mute (session toggle wins once the user touched it)
      if (!this.muteTouched) this.muted = loadMuted();
      this.rampMaster(ctx.currentTime, 0.02);
      this.buildEngine(ctx, master);
      this.buildWind(ctx, master, buf);
      if (ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    } catch {
      // audio must never crash the client (RULES 5)
    }
  }

  /** Toggle the master mute: ramps the bus (click-free) and persists the
      preference. Works before unlock() too — the flag rides along until the
      context exists, then the ramp applies. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.muteTouched = true;
    saveMuted(muted);
    const r = this.ready();
    if (!r) return;
    try {
      this.rampMaster(r.ctx.currentTime, muted ? MUTE_TAU_S : UNMUTE_TAU_S);
    } catch {
      // audio must never crash the client
    }
  }

  /** Own-plane engine voice — called EVERY FRAME with smoothed values, so
      every param move is a setTargetAtTime (never a jump). Pitch from
      engineFreq(); cutoff and gain open with drive so throttle is felt, not
      just heard as pitch. The propeller-LFO wobbles the cutoff continuously
      (built at unlock); this method only trims targets. */
  ownEngine(throttle: number, speedFrac: number, boosting: boolean): void {
    const r = this.ready();
    const eng = this.engine;
    if (!r || !eng || r.ctx.state !== 'running') return;
    const th = clamp01(throttle);
    const sf = clamp01(speedFrac);
    const drive = ENGINE_THROTTLE_W * th + (1 - ENGINE_THROTTLE_W) * sf;
    const t = r.ctx.currentTime;
    try {
      eng.osc.frequency.setTargetAtTime(engineFreq(th, sf, boosting), t, ENGINE_TAU_S);
      eng.flt.frequency.setTargetAtTime(
        ENGINE_CUT_BASE_HZ + drive * ENGINE_CUT_SPAN_HZ,
        t,
        ENGINE_TAU_S,
      );
      eng.gain.gain.setTargetAtTime(ENGINE_LEVEL * (0.55 + 0.45 * drive), t, ENGINE_TAU_S);
    } catch {
      // audio must never crash the client
    }
  }

  /**
   * One machine-gun VOLLEY (the cadence — CLASSES rateHz 9–11 — is the
   * caller's business; this fires exactly once per volley). Own guns are
   * crisp at the breech: highpassed snap + bandpass body, no distance law.
   * Remote volleys collapse along attenuation(): quieter AND duller (cutoff
   * interpolates toward FAR_CUT_FLOOR). Every call is admitted against
   * VOICE_CAP; the oldest stolen voice dies instantly.
   */
  shot(own: boolean, distU: number): void {
    const r = this.ready();
    if (!r || this.muted || r.ctx.state !== 'running') return;
    try {
      const h = this.beginEvent();
      const t0 = r.ctx.currentTime;
      if (own) {
        this.burst(r.ctx, r.nbuf, r.master, { type: 'highpass', f0: 3400, t0, dur: 0.018, peak: 0.36 }, h);
        this.burst(r.ctx, r.nbuf, r.master, { type: 'bandpass', f0: 950, f1: 480, q: 0.8, t0, dur: 0.06, peak: 0.3 }, h);
      } else {
        const att = attenuation(distU);
        const cut = farCutoff(distU);
        this.burst(
          r.ctx,
          r.nbuf,
          r.master,
          { type: 'lowpass', f0: cut, f1: cut * 0.45, q: 0.7, t0, dur: 0.16, peak: 0.5 * att },
          h,
        );
      }
    } catch {
      // audio must never crash the client
    }
  }

  /** YOU landed a hit: metallic ping (sine dropping 2300→1750) over a tiny
      highpass tick — the reward channel, kept bright and short so rapid
      confirms stack into a satisfying rattle instead of mud. */
  hitConfirm(): void {
    const r = this.ready();
    if (!r || this.muted || r.ctx.state !== 'running') return;
    try {
      const h = this.beginEvent();
      const t0 = r.ctx.currentTime;
      this.beep(r.ctx, r.master, { type: 'sine', f0: 2300, f1: 1750, t0, dur: 0.07, peak: 0.3 }, h);
      this.burst(r.ctx, r.nbuf, r.master, { type: 'highpass', f0: 5000, t0, dur: 0.012, peak: 0.14 }, h);
    } catch {
      // audio must never crash the client
    }
  }

  /** YOU took a hit: low thud (150→62) + grit noise — weight and alarm,
      pitched BELOW the hit-confirm pair so damage and success never blur. */
  hurt(): void {
    const r = this.ready();
    if (!r || this.muted || r.ctx.state !== 'running') return;
    try {
      const h = this.beginEvent();
      const t0 = r.ctx.currentTime;
      this.beep(r.ctx, r.master, { type: 'sine', f0: 150, f1: 62, t0, dur: 0.18, peak: 0.5 }, h);
      this.burst(r.ctx, r.nbuf, r.master, { type: 'lowpass', f0: 700, f1: 180, t0, dur: 0.16, peak: 0.28 }, h);
    } catch {
      // audio must never crash the client
    }
  }

  /** Kill confirmed: two layers — a chest thunk (triangle 170→75) and a thin
      ring blooming 30 ms later. Thunk says "hit", ring says "scored". */
  killConfirm(): void {
    const r = this.ready();
    if (!r || this.muted || r.ctx.state !== 'running') return;
    try {
      const h = this.beginEvent();
      const t0 = r.ctx.currentTime;
      this.beep(r.ctx, r.master, { type: 'triangle', f0: 170, f1: 75, t0, dur: 0.13, peak: 0.5 }, h);
      this.beep(r.ctx, r.master, { type: 'sine', f0: 1174.66, t0: t0 + 0.03, dur: 0.34, peak: 0.22 }, h);
    } catch {
      // audio must never crash the client
    }
  }

  /** Plane death: big lowpass-swept noise mass + a sub sine dropping 90→40
      Hz, all scaled by attenuation(distU), long decay — the map-wide "look
      now" beat (D4 readable sky, for ears). */
  explosion(distU: number): void {
    const r = this.ready();
    if (!r || this.muted || r.ctx.state !== 'running') return;
    try {
      const h = this.beginEvent();
      const t0 = r.ctx.currentTime;
      const m = attenuation(distU);
      this.burst(
        r.ctx,
        r.nbuf,
        r.master,
        { type: 'lowpass', f0: 1500, f1: 120, t0, dur: 0.85, peak: 0.75 * m, attack: 0.008 },
        h,
      );
      this.beep(r.ctx, r.master, { type: 'sine', f0: 90, f1: 40, t0, dur: 0.7, peak: 0.6 * m }, h);
      this.burst(
        r.ctx,
        r.nbuf,
        r.master,
        { type: 'bandpass', f0: 400, f1: 250, q: 0.8, t0: t0 + 0.04, dur: 0.35, peak: 0.3 * m },
        h,
      );
    } catch {
      // audio must never crash the client
    }
  }

  /** Supply crate secured: two-note wood/bell chime (perfect fifth) with a
      woody bandpass tick under the strike — warm, unmistakably positive. */
  pickup(): void {
    const r = this.ready();
    if (!r || this.muted || r.ctx.state !== 'running') return;
    try {
      const h = this.beginEvent();
      const t0 = r.ctx.currentTime;
      this.beep(r.ctx, r.master, { type: 'triangle', f0: 660, t0, dur: 0.09, peak: 0.28 }, h);
      this.beep(r.ctx, r.master, { type: 'triangle', f0: 990, t0: t0 + 0.09, dur: 0.22, peak: 0.3 }, h);
      this.burst(r.ctx, r.nbuf, r.master, { type: 'bandpass', f0: 1400, q: 2, t0, dur: 0.02, peak: 0.12 }, h);
    } catch {
      // audio must never crash the client
    }
  }

  /** Guns jammed (heat maxed): mechanical clunk + a two-tap rattle — the
      "release the trigger NOW" lesson (D2 burst discipline), distinct from
      every musical cue by being deliberately ugly. */
  overheatJam(): void {
    const r = this.ready();
    if (!r || this.muted || r.ctx.state !== 'running') return;
    try {
      const h = this.beginEvent();
      const t0 = r.ctx.currentTime;
      this.beep(r.ctx, r.master, { type: 'square', f0: 95, f1: 48, t0, dur: 0.09, peak: 0.4 }, h);
      this.burst(r.ctx, r.nbuf, r.master, { type: 'bandpass', f0: 1100, q: 2, t0: t0 + 0.05, dur: 0.03, peak: 0.2 }, h);
      this.burst(r.ctx, r.nbuf, r.master, { type: 'bandpass', f0: 900, q: 2, t0: t0 + 0.11, dur: 0.03, peak: 0.14 }, h);
    } catch {
      // audio must never crash the client
    }
  }

  /** Kill-streak stinger, tiered by config thresholds (pairing C_UI's ACE /
      LEGEND banners): a plain two-note lift, a brighter pair at ACE, and a
      three-note major triad at LEGEND — you HEAR the ladder you're climbing. */
  streak(n: number): void {
    const r = this.ready();
    if (!r || this.muted || r.ctx.state !== 'running') return;
    try {
      const h = this.beginEvent();
      const t0 = r.ctx.currentTime;
      if (n >= STREAK_LEGEND) {
        // LEGEND: bright D-major triad climb
        this.beep(r.ctx, r.master, { type: 'triangle', f0: 587.33, t0, dur: 0.1, peak: 0.26 }, h);
        this.beep(r.ctx, r.master, { type: 'triangle', f0: 739.99, t0: t0 + 0.09, dur: 0.1, peak: 0.26 }, h);
        this.beep(r.ctx, r.master, { type: 'triangle', f0: 880, t0: t0 + 0.18, dur: 0.45, peak: 0.3 }, h);
      } else if (n >= STREAK_ACE) {
        // ACE: brighter fourth-span lift than the base pair
        this.beep(r.ctx, r.master, { type: 'triangle', f0: 440, t0, dur: 0.1, peak: 0.26 }, h);
        this.beep(r.ctx, r.master, { type: 'triangle', f0: 659.25, t0: t0 + 0.1, dur: 0.3, peak: 0.3 }, h);
      } else {
        // warming up: modest fifth lift
        this.beep(r.ctx, r.master, { type: 'triangle', f0: 392, t0, dur: 0.1, peak: 0.24 }, h);
        this.beep(r.ctx, r.master, { type: 'triangle', f0: 587.33, t0: t0 + 0.1, dur: 0.3, peak: 0.28 }, h);
      }
    } catch {
      // audio must never crash the client
    }
  }

  /** UI vocabulary: menu blip, spawn whoosh (rising air — wheels-up feeling),
      victory major lift and defeat minor fall (≤4 notes each per contract). */
  ui(kind: 'click' | 'spawn' | 'win' | 'lose'): void {
    const r = this.ready();
    if (!r || this.muted || r.ctx.state !== 'running') return;
    try {
      const h = this.beginEvent();
      const t0 = r.ctx.currentTime;
      switch (kind) {
        case 'click':
          this.beep(r.ctx, r.master, { type: 'sine', f0: 1900, t0, dur: 0.03, peak: 0.18 }, h);
          break;
        case 'spawn':
          // pure air, no body: a band sweeping UP is the inverse of every
          // "impact" cue on this bus — leaving the ground, not hitting it
          this.burst(
            r.ctx,
            r.nbuf,
            r.master,
            { type: 'bandpass', f0: 380, f1: 2100, q: 1.1, t0, dur: 0.32, peak: 0.28, attack: 0.05 },
            h,
          );
          break;
        case 'win':
          // C4–E4–G4–C5: a major lift home
          this.beep(r.ctx, r.master, { type: 'triangle', f0: 261.63, t0, dur: 0.16, peak: 0.26 }, h);
          this.beep(r.ctx, r.master, { type: 'triangle', f0: 329.63, t0: t0 + 0.12, dur: 0.16, peak: 0.26 }, h);
          this.beep(r.ctx, r.master, { type: 'triangle', f0: 392, t0: t0 + 0.24, dur: 0.16, peak: 0.26 }, h);
          this.beep(r.ctx, r.master, { type: 'triangle', f0: 523.25, t0: t0 + 0.36, dur: 0.5, peak: 0.3 }, h);
          break;
        case 'lose':
          // E4–C4–A3–F3: a minor fall onto the airstrip
          this.beep(r.ctx, r.master, { type: 'sine', f0: 329.63, t0, dur: 0.18, peak: 0.26 }, h);
          this.beep(r.ctx, r.master, { type: 'sine', f0: 261.63, t0: t0 + 0.14, dur: 0.18, peak: 0.26 }, h);
          this.beep(r.ctx, r.master, { type: 'sine', f0: 220, t0: t0 + 0.28, dur: 0.18, peak: 0.26 }, h);
          this.beep(r.ctx, r.master, { type: 'sine', f0: 174.61, t0: t0 + 0.42, dur: 0.6, peak: 0.3 }, h);
          break;
        default: {
          // exhaustiveness guard: a new ui kind fails typecheck, not silence
          const exhaustive: never = kind;
          void exhaustive;
        }
      }
    } catch {
      // audio must never crash the client
    }
  }

  /** Ambient wind bed — called EVERY FRAME. The looping voice was built at
      unlock; this only tracks targets: gain ∝ speedFrac² (parked quiet on
      the strip, roaring wide open) and a bandpass opening with speed. Two
      slow LFOs (built at unlock) drift cutoff and gain so the bed never
      sits perfectly still. */
  wind(speedFrac: number): void {
    const r = this.ready();
    const rig = this.windRig;
    if (!r || !rig || r.ctx.state !== 'running') return;
    const frac = clamp01(speedFrac);
    const t = r.ctx.currentTime;
    try {
      rig.flt.frequency.setTargetAtTime(WIND_BASE_HZ + frac * WIND_SPAN_HZ, t, WIND_TAU_S);
      rig.gain.gain.setTargetAtTime(WIND_LEVEL * frac * frac, t, WIND_TAU_S);
    } catch {
      // audio must never crash the client
    }
  }

  // ---- internals --------------------------------------------------------------

  /** Common guard: graph present AND runnable. One-shots additionally refuse
      while muted (silent bus + skipped scheduling = zero wasted nodes during
      a muted firefight); continuous voices keep running under the mute ramp
      so unmute is instant. */
  private ready(): { ctx: AudioContext; master: GainNode; nbuf: AudioBuffer } | null {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return null;
    return { ctx, master, nbuf };
  }

  /** Click-free master mute/unmute ramp. */
  private rampMaster(t: number, tau: number): void {
    const master = this.master;
    if (!master) return;
    master.gain.setTargetAtTime(this.muted ? MUTE_GAIN : MASTER_GAIN, t, tau);
  }

  /** Admit a new one-shot event into the VOICE_CAP FIFO, stealing (fully
      stopping) the oldest event when the budget is full. */
  private beginEvent(): OneShotHandle {
    const handle: OneShotHandle = {
      stops: [],
      stop() {
        for (const s of this.stops) {
          try {
            s();
          } catch {
            // already stopped — fine
          }
        }
      },
    };
    const res = admitVoice(this.events, handle, VOICE_CAP);
    this.events = res.queue;
    const evicted = res.evicted;
    if (evicted) evicted.stop();
    return handle;
  }

  /** Sawtooth -> lowpass -> gate drone, started once at unlock; a slow LFO
      wobbles the cutoff (propeller feel). Gain parks at 0 until the first
      ownEngine() call raises it — silent until the app actually flies. */
  private buildEngine(ctx: AudioContext, master: GainNode): void {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = ENGINE_MIN_HZ;
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.Q.value = 0.8;
    flt.frequency.value = ENGINE_CUT_BASE_HZ;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(flt);
    flt.connect(gain);
    gain.connect(master);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = PROP_LFO_HZ;
    const depth = ctx.createGain();
    depth.gain.value = PROP_LFO_DEPTH_HZ;
    lfo.connect(depth);
    depth.connect(flt.frequency);
    osc.start();
    lfo.start();
    this.engine = { osc, flt, gain };
  }

  /** Looped noise -> bandpass -> gate wind bed, started once at unlock, plus
      the two slow drift LFOs (cutoff + gain) that keep it alive. */
  private buildWind(ctx: AudioContext, master: GainNode, nbuf: AudioBuffer): void {
    const src = ctx.createBufferSource();
    src.buffer = nbuf;
    src.loop = true;
    src.playbackRate.value = 1;
    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.Q.value = WIND_Q;
    flt.frequency.value = WIND_BASE_HZ;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(flt);
    flt.connect(gain);
    gain.connect(master);
    const lfoF = ctx.createOscillator();
    lfoF.frequency.value = WIND_DRIFT_F_HZ;
    const depthF = ctx.createGain();
    depthF.gain.value = WIND_DRIFT_F_DEPTH;
    lfoF.connect(depthF);
    depthF.connect(flt.frequency);
    const lfoG = ctx.createOscillator();
    lfoG.frequency.value = WIND_DRIFT_G_HZ;
    const depthG = ctx.createGain();
    depthG.gain.value = WIND_DRIFT_G_DEPTH;
    lfoG.connect(depthG);
    depthG.connect(gain.gain);
    src.start();
    lfoF.start();
    lfoG.start();
    this.windRig = { flt, gain };
  }

  /** Oscillator layer with fast-attack / exponential-decay envelope; its kill
      closure joins the owning event's eviction handle. */
  private beep(ctx: AudioContext, dest: AudioNode, o: BeepOpts, h: OneShotHandle): void {
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
    h.stops.push(() => {
      try {
        osc.stop();
      } catch {
        // already stopped — fine
      }
    });
  }

  /** Filtered noise layer (from the shared seeded buffer), same envelope. */
  private burst(ctx: AudioContext, nbuf: AudioBuffer, dest: AudioNode, o: BurstOpts, h: OneShotHandle): void {
    const src = ctx.createBufferSource();
    src.buffer = nbuf;
    const flt = ctx.createBiquadFilter();
    flt.type = o.type;
    flt.frequency.setValueAtTime(o.f0, o.t0);
    if (o.f1 !== undefined) flt.frequency.exponentialRampToValueAtTime(o.f1, o.t0 + o.dur);
    flt.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(ENV_FLOOR, o.t0);
    g.gain.exponentialRampToValueAtTime(Math.max(o.peak, ENV_FLOOR), o.t0 + (o.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(ENV_FLOOR, o.t0 + o.dur);
    src.connect(flt);
    flt.connect(g);
    g.connect(dest);
    src.start(o.t0);
    src.stop(o.t0 + o.dur + 0.02);
    h.stops.push(() => {
      try {
        src.stop();
      } catch {
        // already stopped — fine
      }
    });
  }
}

/** Creator signature frozen in seams.ts — C_APP's composition root calls
    exactly this. */
export function createAudio(): AudioApi {
  return new AcesAudio();
}
