// ============================================================================
// KART client — WebAudio synth. Pure synthesis (no audio asset files):
//   engine — two detuned saws through one lowpass (chorus-thick body), a sine
//            gear-whine pair at 6x/9x revs (tracks per-gear revs, so upshifts
//            audibly drop the whine), and a deterministic fixed-rate LFO pitch
//            wobble. The optional throttle argument is the LOAD axis: lift-off
//            at speed closes the filter, thins the level and calms the wobble
//            (audible overrun); depth/filter/level all respond to it
//   skid   — a CONTINUOUS tire voice (looped noise -> bandpass -> gate) driven
//            per frame by slip amount; filter and gain follow grip, and the
//            character morphs between asphalt screech and grass/dirt tear.
//            No one-shot retrigger — the app gates the voice, sfx('skid')
//            remains only as a legacy short-burst fallback
//   wind   — looped noise through a bandpass that opens with speed, on its own
//            chain straight to master (independent of the engine voice)
//   crowd  — a distant-crowd bed while racing (muffled looped noise + a high
//            airy shimmer band, each with a slow deterministic swell LFO), and
//            a slow-attack crowd roar swelling under the finish stinger
//   turbo  — nitro: low ignition thump + deep whoosh with a high sheen
//   thud / beep / go / finish — barrier slam, countdown, GO, checker stinger
// Ambient looped voices share the ONE seeded-noise buffer but run at detuned
// playbackRates (0.93/1.0/1.07/1.13) so they never phase-lock. One-shots take
// an optional distance in meters with a smooth 1/(1+d/12) gain curve (remote
// nitro etc.). A gentle DynamicsCompressor sits between master and destination
// as glue so stacked one-shots over the engine never clip. Everything is a
// safe no-op until resume() creates the AudioContext on a user gesture
// (browser autoplay policy). Noise comes from rng(seed) and every LFO rate is
// a fixed constant — Math.random is a contract violation everywhere.
// ============================================================================
import { rng } from '@platform/shared';

export type KartSfx = 'engine' | 'skid' | 'thud' | 'turbo' | 'beep' | 'go' | 'finish';

/** Surface a skid happens on; asphalt stays the default when unspecified. */
export type SkidSurface = 'asphalt' | 'grass';

/**
 * Optional per-call sfx modifiers (backward compatible: all fields optional).
 * distance is in meters; gain follows 1/(1 + distance/12) — smooth, never 0.
 */
export interface SfxOpts {
  readonly surface?: SkidSurface; // skid only; ignored by other kinds
  readonly distance?: number; // remote one-shots (e.g. another kart's nitro)
}

// ---- tuning constants -------------------------------------------------------
const MASTER_GAIN = 0.5;
const ENV_FLOOR = 0.0001; // exponential ramps may never target 0
const NOISE_SEED = 0x5eed; // shared noise buffer fill (same stream as fps/bank)
const ENGINE_IDLE_HZ = 60; // puttering at a standstill
const ENGINE_TOP_HZ = 220; // redline at TOP_SPEED
const ENGINE_LEVEL = 0.16; // base engine gain when on
const ENGINE_SMOOTH_S = 0.06; // setTargetAtTime constant: per-frame calls stay cheap
const ENGINE_DETUNE_CENTS = 9; // second saw layer, fixed chorus offset
const ENGINE_DETUNE_MIX = 0.55; // detuned layer level relative to the main saw
const ENGINE_WHINE_LEVEL = 0.045; // gear-whine pair peak level (well under the saws)
const ENGINE_WHINE_LO = 6; // whine voice 1: 6x engine hz (360..1320Hz)
const ENGINE_WHINE_HI = 9; // whine voice 2: 9x engine hz, a fifth up (540..1980Hz)
const ENGINE_WOBBLE_HZ = 8; // fixed LFO rate for the under-load pitch wobble
const ENGINE_WOBBLE_BASE = 0.3; // wobble depth in Hz at no load
const ENGINE_WOBBLE_LOAD = 1.7; // extra wobble depth in Hz at full load
const ENGINE_LOAD_FLT_FLOOR = 0.55; // overrun closes the filter to 55% of its sweep
const ENGINE_LOAD_LVL_FLOOR = 0.7; // overrun thins the level to 70%
const SKID_LEVEL = 0.34; // continuous skid voice at full slip
const SKID_SMOOTH_S = 0.03; // skid gate/filter response: immediate, click-free
const SKID_LOOP_RATE = 1.13; // playbackRate detune vs the other looped voices
const WIND_LEVEL = 0.09; // wind gain at top speed (rises with speed^2)
const WIND_BASE_HZ = 600; // bandpass center at a standstill
const WIND_SPAN_HZ = 2400; // bandpass center sweep across full speed
const CROWD_LEVEL = 0.03; // distant-crowd bed level while racing (very quiet)
const CROWD_LOOP_RATE = 0.93; // playbackRate detune: de-phases bed vs wind/skid
const CROWD_SWELL_HZ = 0.13; // slow crowd swell rate (~7.7s cycle)
const CROWD_SWELL_DEPTH = 0.35; // swell swings the bed x0.65..x1.35
const SHIMMER_LEVEL = 0.009; // airy high band level (birds-ish shimmer, fainter)
const SHIMMER_HZ = 4600; // shimmer band center
const SHIMMER_LOOP_RATE = 1.07; // playbackRate detune vs the crowd bed
const SHIMMER_SWELL_HZ = 0.31; // shimmer pulse rate (detuned vs the crowd swell)
const SHIMMER_SWELL_DEPTH = 0.5; // shimmer swings x0.5..x1.5
const AMBIENT_SMOOTH_S = 0.4; // ambient beds fade in/out slowly, never click
const DISTANCE_REF_M = 12; // remote sfx gain = 1/(1 + distance/12)
const COMP_THRESHOLD_DB = -12; // glue compressor: catches one-shot stacking
const COMP_KNEE_DB = 18;
const COMP_RATIO = 4;
const COMP_ATTACK_S = 0.003;
const COMP_RELEASE_S = 0.24;

interface BeepOpts {
  type: OscillatorType; f0: number; f1?: number;
  t0: number; dur: number; peak: number;
}

interface BurstOpts {
  type: BiquadFilterType; f0: number; f1?: number; q?: number;
  t0: number; dur: number; peak: number; loop?: boolean;
  attack?: number; // seconds to swell to peak (default 0.005 — near-instant)
}

/** Persistent per-frame voices, built once and gated by gain thereafter. */
interface EngineRig {
  osc: OscillatorNode; // main saw
  osc2: OscillatorNode; // detuned saw layer
  flt: BiquadFilterNode;
  gain: GainNode;
  whine1: OscillatorNode; // gear whine, 6x revs
  whine2: OscillatorNode; // gear whine, 9x revs
  whineGain: GainNode;
  wobbleGain: GainNode; // LFO -> saw frequency depth (load-dependent)
  skidFlt: BiquadFilterNode; // continuous tire voice
  skidGate: GainNode;
  windFlt: BiquadFilterNode;
  windGain: GainNode;
  crowdGate: GainNode; // on/off + level for the crowd bed
  shimmerGate: GainNode; // on/off + level for the shimmer band
}

export class KartAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  // continuous voices: built lazily on first engine()/skid() call and kept
  // alive; on/off just gates the gains (idempotent, and an OscillatorNode may
  // only be started once)
  private rig: EngineRig | null = null;
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
    // glue compressor between master and destination: stacked one-shots over
    // the engine (nitro + skid + wind at redline) must not clip
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
  }

  /**
   * Continuous engine synth. Called EVERY FRAME from the drive loop: all
   * parameter moves go through setTargetAtTime (cheap, click-free), and
   * start/stop is idempotent — on just gates the gains of persistent voices.
   * speedFrac is 0..1 of TOP_SPEED (per-gear revs, so pitch and whine drop on
   * every upshift); it also drives the wind and the racing ambience beds.
   * throttle (0..1, optional) is the load axis: lift-off at speed closes the
   * filter, thins the level and calms the wobble — audible overrun. Legacy
   * callers that omit it get load = revs (the original behavior).
   */
  engine(speedFrac: number, on: boolean, throttle?: number): void {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return;
    const frac = speedFrac < 0 ? 0 : speedFrac > 1 ? 1 : speedFrac;
    const load = throttle === undefined ? frac : throttle < 0 ? 0 : throttle > 1 ? 1 : throttle;
    try {
      if (!this.rig) this.rig = this.buildRig(ctx, master, nbuf);
      const rig = this.rig;
      const t = ctx.currentTime;
      const hz = ENGINE_IDLE_HZ + frac * (ENGINE_TOP_HZ - ENGINE_IDLE_HZ);
      rig.osc.frequency.setTargetAtTime(hz, t, ENGINE_SMOOTH_S);
      // detune lives on the constant detune param; the carrier tracks hz 1:1
      rig.osc2.frequency.setTargetAtTime(hz, t, ENGINE_SMOOTH_S);
      // gear whine: sine pair at fixed multiples of revs — drops on upshifts
      rig.whine1.frequency.setTargetAtTime(hz * ENGINE_WHINE_LO, t, ENGINE_SMOOTH_S);
      rig.whine2.frequency.setTargetAtTime(hz * ENGINE_WHINE_HI, t, ENGINE_SMOOTH_S);
      // muffled at idle, opens with rpm — and with load: overrun stays darker
      rig.flt.frequency.setTargetAtTime(
        300 + frac * 1800 * (ENGINE_LOAD_FLT_FLOOR + (1 - ENGINE_LOAD_FLT_FLOOR) * load),
        t, ENGINE_SMOOTH_S,
      );
      // pitch wobble deepens under load (fixed-rate LFO, depth in Hz)
      rig.wobbleGain.gain.setTargetAtTime(
        on ? ENGINE_WOBBLE_BASE + load * ENGINE_WOBBLE_LOAD : 0, t, 0.1,
      );
      // whine is faint at idle and clears its throat with revs
      rig.whineGain.gain.setTargetAtTime(
        on ? ENGINE_WHINE_LEVEL * (0.15 + 0.85 * frac) : 0, t, ENGINE_SMOOTH_S,
      );
      // wind: independent of the engine, rising with speed^2
      rig.windFlt.frequency.setTargetAtTime(WIND_BASE_HZ + frac * WIND_SPAN_HZ, t, ENGINE_SMOOTH_S);
      rig.windGain.gain.setTargetAtTime(on ? WIND_LEVEL * frac * frac : 0, t, 0.12);
      // racing ambience: crowd bed + shimmer fade in slowly, out on the menu
      rig.crowdGate.gain.setTargetAtTime(on ? CROWD_LEVEL : 0, t, AMBIENT_SMOOTH_S);
      rig.shimmerGate.gain.setTargetAtTime(on ? SHIMMER_LEVEL : 0, t, AMBIENT_SMOOTH_S);
      if (on !== this.engOn) {
        this.engOn = on;
        rig.gain.gain.setTargetAtTime(on ? ENGINE_LEVEL : 0, t, on ? 0.03 : 0.08);
      } else if (on) {
        // level swells with rpm — and thins on lift-off (load axis)
        rig.gain.gain.setTargetAtTime(
          ENGINE_LEVEL * (0.7 + 0.5 * frac) * (ENGINE_LOAD_LVL_FLOOR + (1 - ENGINE_LOAD_LVL_FLOOR) * load),
          t, ENGINE_SMOOTH_S,
        );
      }
    } catch {
      // audio must never crash the client (contract robustness rule)
    }
  }

  /**
   * Continuous tire-slide voice. Called EVERY FRAME from the drive loop with
   * the current slip amount (0 = gripping/silent, 1 = full slide); the app
   * gates the voice directly instead of retriggering one-shots. Gain follows
   * slip, the bandpass center rises as grip lets go, and surface morphs the
   * character: asphalt screech (high, ringing) vs grass/dirt tear (low, dull).
   */
  skid(amount: number, surface: SkidSurface = 'asphalt'): void {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return;
    const slip = amount < 0 ? 0 : amount > 1 ? 1 : amount;
    const grass = surface === 'grass';
    try {
      if (!this.rig) this.rig = this.buildRig(ctx, master, nbuf);
      const rig = this.rig;
      const t = ctx.currentTime;
      rig.skidFlt.frequency.setTargetAtTime(
        grass ? 260 + slip * 240 : 700 + slip * 500, t, SKID_SMOOTH_S,
      );
      rig.skidFlt.Q.setTargetAtTime(grass ? 0.9 : 1.6, t, SKID_SMOOTH_S);
      rig.skidGate.gain.setTargetAtTime(slip > 0 ? SKID_LEVEL * slip : 0, t, SKID_SMOOTH_S);
    } catch {
      // audio must never crash the client (contract robustness rule)
    }
  }

  /**
   * One-shot effect. No-op until resume() has run and the context is running.
   * opts.surface selects the skid character ('asphalt' default, 'grass' for
   * off-track); opts.distance (meters) scales the gain by 1/(1 + d/12) for
   * remote karts' effects — both optional, ignored where irrelevant.
   */
  sfx(kind: KartSfx, opts?: SfxOpts): void {
    const ctx = this.ctx;
    const master = this.master;
    const nbuf = this.noiseBuf;
    if (!ctx || !master || !nbuf || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    const d = opts?.distance;
    const dm = d === undefined ? 1 : 1 / (1 + (d > 0 ? d : 0) / DISTANCE_REF_M);
    try {
      switch (kind) {
        case 'engine': // the engine is continuous — drive it with engine()
          break;
        case 'skid': {
          // legacy short burst — the continuous skid() voice is the real path
          const surface = opts?.surface ?? 'asphalt';
          if (surface === 'grass') {
            // grass/dirt: low rough tearing, no ring — rumble + a clod tear
            this.burst(ctx, nbuf, master, { type: 'lowpass', f0: 520, f1: 340, q: 0.8, t0, dur: 0.26, peak: 0.36, loop: true }, dm);
            this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 240, q: 2.2, t0: t0 + 0.02, dur: 0.16, peak: 0.22 }, dm);
          } else {
            // asphalt: mid-high screech sliding down as the tire bites
            this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 1000, f1: 700, q: 1.6, t0, dur: 0.2, peak: 0.4, loop: true }, dm);
          }
          break;
        }
        case 'thud': // barrier hit: low noise slam + low sine body
          this.burst(ctx, nbuf, master, { type: 'lowpass', f0: 220, t0, dur: 0.14, peak: 0.5 }, dm);
          this.beep(ctx, master, { type: 'sine', f0: 110, f1: 45, t0, dur: 0.16, peak: 0.5 }, dm);
          break;
        case 'turbo': // nitro: low ignition thump, deep whoosh, high sheen on top
          this.beep(ctx, master, { type: 'sine', f0: 64, f1: 30, t0, dur: 0.22, peak: 0.55 }, dm);
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 260, f1: 1400, q: 0.9, t0, dur: 0.6, peak: 0.5, loop: true }, dm);
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 1400, f1: 3600, q: 1.3, t0, dur: 0.4, peak: 0.16, loop: true }, dm);
          this.beep(ctx, master, { type: 'triangle', f0: 140, f1: 380, t0, dur: 0.35, peak: 0.1 }, dm);
          break;
        case 'beep': // countdown 3-2-1: 880Hz, 100ms
          this.beep(ctx, master, { type: 'sine', f0: 880, t0, dur: 0.1, peak: 0.32 }, dm);
          break;
        case 'go': // GO: higher 1320Hz, 250ms
          this.beep(ctx, master, { type: 'sine', f0: 1320, t0, dur: 0.25, peak: 0.36 }, dm);
          break;
        case 'finish': // checker stinger + crowd roar swelling under it
          this.beep(ctx, master, { type: 'triangle', f0: 659.25, t0, dur: 0.16, peak: 0.32 }, dm);
          this.beep(ctx, master, { type: 'triangle', f0: 987.77, t0: t0 + 0.14, dur: 0.34, peak: 0.34 }, dm);
          this.burst(ctx, nbuf, master, { type: 'lowpass', f0: 500, t0, dur: 1.6, peak: 0.13, attack: 0.4, loop: true }, dm);
          this.burst(ctx, nbuf, master, { type: 'bandpass', f0: 1500, q: 0.7, t0: t0 + 0.08, dur: 1.8, peak: 0.08, attack: 0.55, loop: true }, dm);
          break;
      }
    } catch {
      // audio must never crash the client (contract robustness rule)
    }
  }

  // ---- synth primitives ------------------------------------------------------

  /**
   * Build every persistent voice once (first engine()/skid() call):
   *   engine:  saw + detuned saw -> mix -> lowpass -> gain -> master
   *            fixed-rate wobble LFO -> both saw frequencies (depth per frame)
   *   whine:   sine(6x) + sine(9x) -> gate -> master
   *   skid:    looped noise(1.13x) -> bandpass -> gate -> master (continuous,
   *            gated by skid(); never retriggered)
   *   wind:    looped noise(1.0x) -> bandpass -> gate -> master
   *   crowd:   looped noise(0.93x) -> lowpass -> gate -> swell -> master
   *            (swell gain sits at 1 with a slow LFO around it; the gate does
   *            the on/off so the LFO never leaks sound while off)
   *   shimmer: looped noise(1.07x) -> high bandpass -> gate -> swell -> master
   * The detuned playbackRates keep the beds from phase-locking to the same
   * 1s buffer loop.
   */
  private buildRig(ctx: AudioContext, master: GainNode, nbuf: AudioBuffer): EngineRig {
    // engine body: two detuned saws into one filter for a thick chorus tone
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.detune.value = ENGINE_DETUNE_CENTS;
    const mix2 = ctx.createGain();
    mix2.gain.value = ENGINE_DETUNE_MIX;
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.Q.value = 1;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(flt);
    osc2.connect(mix2);
    mix2.connect(flt);
    flt.connect(gain);
    gain.connect(master);
    // gear whine: sine-rich high layer at fixed multiples of revs
    const whine1 = ctx.createOscillator();
    whine1.type = 'sine';
    const whine2 = ctx.createOscillator();
    whine2.type = 'sine';
    const whineMix2 = ctx.createGain();
    whineMix2.gain.value = 0.5;
    const whineGain = ctx.createGain();
    whineGain.gain.value = 0;
    whine1.connect(whineGain);
    whine2.connect(whineMix2);
    whineMix2.connect(whineGain);
    whineGain.connect(master);
    // deterministic pitch wobble: fixed-rate LFO, per-frame depth under load
    const wobble = ctx.createOscillator();
    wobble.type = 'sine';
    wobble.frequency.value = ENGINE_WOBBLE_HZ;
    const wobbleGain = ctx.createGain();
    wobbleGain.gain.value = 0;
    wobble.connect(wobbleGain);
    wobbleGain.connect(osc.frequency);
    wobbleGain.connect(osc2.frequency);
    // continuous tire voice: one persistent loop, gated by slip per frame
    const skidSrc = ctx.createBufferSource();
    skidSrc.buffer = nbuf;
    skidSrc.loop = true;
    skidSrc.playbackRate.value = SKID_LOOP_RATE;
    const skidFlt = ctx.createBiquadFilter();
    skidFlt.type = 'bandpass';
    skidFlt.Q.value = 1.6;
    skidFlt.frequency.value = 900;
    const skidGate = ctx.createGain();
    skidGate.gain.value = 0;
    skidSrc.connect(skidFlt);
    skidFlt.connect(skidGate);
    skidGate.connect(master);
    // wind at speed, on its own chain
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
    // distant-crowd bed: muffled noise with a slow deterministic swell
    const crowdSrc = ctx.createBufferSource();
    crowdSrc.buffer = nbuf;
    crowdSrc.loop = true;
    crowdSrc.playbackRate.value = CROWD_LOOP_RATE;
    const crowdFlt = ctx.createBiquadFilter();
    crowdFlt.type = 'lowpass';
    crowdFlt.frequency.value = 380;
    crowdFlt.Q.value = 0.4;
    const crowdGate = ctx.createGain();
    crowdGate.gain.value = 0;
    const crowdSwell = ctx.createGain();
    crowdSwell.gain.value = 1;
    const crowdLfo = ctx.createOscillator();
    crowdLfo.type = 'sine';
    crowdLfo.frequency.value = CROWD_SWELL_HZ;
    const crowdDepth = ctx.createGain();
    crowdDepth.gain.value = CROWD_SWELL_DEPTH;
    crowdLfo.connect(crowdDepth);
    crowdDepth.connect(crowdSwell.gain);
    crowdSrc.connect(crowdFlt);
    crowdFlt.connect(crowdGate);
    crowdGate.connect(crowdSwell);
    crowdSwell.connect(master);
    // airy shimmer on its own detuned loop (birds-ish, very quiet)
    const shimSrc = ctx.createBufferSource();
    shimSrc.buffer = nbuf;
    shimSrc.loop = true;
    shimSrc.playbackRate.value = SHIMMER_LOOP_RATE;
    const shimFlt = ctx.createBiquadFilter();
    shimFlt.type = 'bandpass';
    shimFlt.frequency.value = SHIMMER_HZ;
    shimFlt.Q.value = 2.5;
    const shimmerGate = ctx.createGain();
    shimmerGate.gain.value = 0;
    const shimSwell = ctx.createGain();
    shimSwell.gain.value = 1;
    const shimLfo = ctx.createOscillator();
    shimLfo.type = 'sine';
    shimLfo.frequency.value = SHIMMER_SWELL_HZ;
    const shimDepth = ctx.createGain();
    shimDepth.gain.value = SHIMMER_SWELL_DEPTH;
    shimLfo.connect(shimDepth);
    shimDepth.connect(shimSwell.gain);
    shimSrc.connect(shimFlt);
    shimFlt.connect(shimmerGate);
    shimmerGate.connect(shimSwell);
    shimSwell.connect(master);
    // every voice starts exactly once and lives for the session
    osc.start();
    osc2.start();
    whine1.start();
    whine2.start();
    wobble.start();
    skidSrc.start();
    windSrc.start();
    crowdSrc.start();
    crowdLfo.start();
    shimSrc.start();
    shimLfo.start();
    return {
      osc, osc2, flt, gain, whine1, whine2, whineGain, wobbleGain,
      skidFlt, skidGate, windFlt, windGain, crowdGate, shimmerGate,
    };
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
    src.loop = o.loop ?? false; // skid/turbo need >1s of noise: loop the 1s buffer
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
