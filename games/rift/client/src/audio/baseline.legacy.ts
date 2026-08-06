// ============================================================================
// ANCIENTS (rift) client — AUDIO (CONTRACT §6, T9). Pure WebAudio synthesis on
// the wordbomb pattern: ONE master gain -> DynamicsCompressor glue -> dest,
// every voice built from oscillators + ONE shared seeded-noise buffer, no
// audio asset files, no Math.random (noise comes from the seeded platform
// rng). Everything is a safe no-op until the first user gesture lets the
// AudioContext run; every entry point is wrapped so audio can never crash the
// client.
//
// FROZEN SEAM (client/src/contract.ts): createAudio(): AudioHandle with
//   event(ev)   — one contextual one-shot per RiftEvent
//   ui(kind)    — 'click' | 'buy' | 'error' | 'levelup' interface feedback
//   setPhase(p) — 'live' starts the ambient wind bed, 'menu' silences it
//
// The context unlocks lazily: the first ui()/event() call normally arrives
// from inside a user gesture (a click), which satisfies the autoplay policy;
// while the context is still suspended every voice stays silent and each
// later call nudges resume() again.
//
// SEAM LIMITATIONS (recorded for the orchestrator, NOT patched around):
//  - rift_cast carries no damage school, so "cast per school" resolves to a
//    per-SLOT pitch ladder on one cast voice (fx.ts owns the school-coloured
//    visuals; it has the proj fx tag).
//  - rift_kill carries player ids and rift_end a winner team, but AudioHandle
//    is fed no ClientState, so "you" / "your team" are unknowable here: the
//    kill sting and the end sting are team-neutral. game.ts (which knows the
//    victim id and your team) may layer ui('error') for own-death / defeat
//    and ui('levelup') for victory on top — both voices exist for exactly
//    that.
//  - No RiftEvent signals a creep last-hit; the cha-chime ships as the
//    ui('buy') gold voice, which game.ts may also fire when it diffs a gold
//    increase between snaps.
//
// AUDIO-LAB BASELINE COPY (T11, docs/rift-audio/AUDIO_CONTRACT.md): this file
// is a copy of the original `ui/audio.ts`, patched ONLY to accept an injected
// `BaseAudioContext`/destination instead of constructing its own live
// `AudioContext`, so it can render deterministically through an
// `OfflineAudioContext` for the blind A/B judge. No gain value, frequency,
// envelope or node topology was changed — this is an honest "before" picture.
// ============================================================================
import { rng } from '@platform/shared';
import type { RiftEvent } from '@rift/shared';
import type { AudioHandle } from '../contract.js';

// ---- tuning constants -------------------------------------------------------
const MASTER_GAIN = 0.5;
const ENV_FLOOR = 0.0001; // exponential ramps may never target 0
const NOISE_SEED = 0x721f7; // shared noise buffer fill (rift's own stream)

// glue compressor: keeps a tower rumble stacked over a kill sting from clipping
const COMP_THRESHOLD_DB = -10;
const COMP_KNEE_DB = 16;
const COMP_RATIO = 4;
const COMP_ATTACK_S = 0.003;
const COMP_RELEASE_S = 0.25;

// ambient wind bed (live phase)
const WIND_LOOP_RATE = 0.83; // playbackRate detune so the bed never phase-locks
const WIND_LO_HZ = 220; // lowpass body of the wind
const WIND_HI_HZ = 480; // ...swelling open at the top of each slow gust
const WIND_GUST_PERIOD_S = 7; // one swell per this many seconds
const WIND_LEVEL = 0.05; // bed peak — sits under every one-shot
const WIND_FADE_S = 0.8; // fade on phase change: no click

interface BeepOpts {
  type: OscillatorType;
  f0: number;
  f1?: number;
  t0: number;
  dur: number;
  peak: number;
  attack?: number;
}

interface BurstOpts {
  type: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  t0: number;
  dur: number;
  peak: number;
  attack?: number;
  loop?: boolean; // required for any dur > the 1s noise buffer
}

/** The persistent wind bed: built once, then gated by gain (a source may only
 *  start once). */
interface WindRig {
  gate: GainNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
}

interface RiftAudioInner {
  ctx: BaseAudioContext | null;
  master: GainNode | null;
  noiseBuf: AudioBuffer | null;
  wind: WindRig | null;
  windOn: boolean;
}

/** Cast voice: per-slot root pitch (q lowest, r highest) — the frozen
 *  rift_cast event carries no school, so the slot is the only identity a cast
 *  sound can have through this seam. */
const CAST_SLOT_HZ: readonly number[] = [320, 380, 452, 240];

export function createBaselineAudio(ctx: BaseAudioContext, dest: AudioNode): AudioHandle {
  const st: RiftAudioInner = {
    ctx: null,
    master: null,
    noiseBuf: null,
    wind: null,
    windOn: false,
  };

  /** Create/unlock the AudioContext; idempotent. Returns true when the graph
   *  is ready to schedule (context exists and is running). */
  function ensure(): boolean {
    if (!st.ctx) {
      const master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = COMP_THRESHOLD_DB;
      comp.knee.value = COMP_KNEE_DB;
      comp.ratio.value = COMP_RATIO;
      comp.attack.value = COMP_ATTACK_S;
      comp.release.value = COMP_RELEASE_S;
      master.connect(comp);
      comp.connect(dest);
      // shared 1s white-noise buffer, seeded (determinism rule; every burst reuses it)
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = buf.getChannelData(0);
      const next = rng(NOISE_SEED);
      for (let i = 0; i < data.length; i++) data[i] = next() * 2 - 1;
      st.ctx = ctx;
      st.master = master;
      st.noiseBuf = buf;
    }
    return true;
  }

  // ---- synth primitives ------------------------------------------------------

  /** Oscillator with fast-attack / exponential-decay envelope into master. */
  function beep(ctx: BaseAudioContext, master: GainNode, o: BeepOpts): void {
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.f0, o.t0);
    if (o.f1 !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(o.f1, 1), o.t0 + o.dur);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(ENV_FLOOR, o.t0);
    g.gain.exponentialRampToValueAtTime(
      Math.max(o.peak, ENV_FLOOR),
      o.t0 + Math.min(o.attack ?? 0.006, o.dur * 0.9),
    );
    g.gain.exponentialRampToValueAtTime(ENV_FLOOR, o.t0 + o.dur);
    osc.connect(g);
    g.connect(master);
    osc.start(o.t0);
    osc.stop(o.t0 + o.dur + 0.02);
  }

  /** Filtered noise burst (from the shared buffer) with the same envelope. */
  function burst(ctx: BaseAudioContext, nbuf: AudioBuffer, master: GainNode, o: BurstOpts): void {
    const src = ctx.createBufferSource();
    src.buffer = nbuf;
    if (o.loop === true) src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = o.type;
    flt.frequency.setValueAtTime(o.f0, o.t0);
    if (o.f1 !== undefined) {
      flt.frequency.exponentialRampToValueAtTime(Math.max(o.f1, 1), o.t0 + o.dur);
    }
    flt.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(ENV_FLOOR, o.t0);
    g.gain.exponentialRampToValueAtTime(
      Math.max(o.peak, ENV_FLOOR),
      o.t0 + Math.min(o.attack ?? 0.004, o.dur * 0.9),
    );
    g.gain.exponentialRampToValueAtTime(ENV_FLOOR, o.t0 + o.dur);
    src.connect(flt);
    flt.connect(g);
    g.connect(master);
    src.start(o.t0);
    src.stop(o.t0 + o.dur + 0.02);
  }

  // ---- the ambient wind bed ---------------------------------------------------

  function ensureWind(ctx: BaseAudioContext, master: GainNode, nbuf: AudioBuffer): WindRig {
    const existing = st.wind;
    if (existing) return existing;
    const src = ctx.createBufferSource();
    src.buffer = nbuf;
    src.loop = true;
    src.playbackRate.value = WIND_LOOP_RATE;
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = WIND_LO_HZ;
    flt.Q.value = 0.5;
    const gate = ctx.createGain();
    gate.gain.value = 0;
    // a slow LFO opens the filter and the gate together: gusts, not a hiss
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 1 / WIND_GUST_PERIOD_S;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = (WIND_HI_HZ - WIND_LO_HZ) / 2;
    lfo.connect(lfoGain);
    lfoGain.connect(flt.frequency);
    flt.frequency.value = (WIND_LO_HZ + WIND_HI_HZ) / 2;
    src.connect(flt);
    flt.connect(gate);
    gate.connect(master);
    src.start();
    lfo.start();
    const rig: WindRig = { gate, lfo, lfoGain };
    st.wind = rig;
    return rig;
  }

  function setWind(on: boolean): void {
    const ctx = st.ctx;
    const master = st.master;
    const nbuf = st.noiseBuf;
    if (!ctx || !master || !nbuf) return;
    if (on) {
      const rig = ensureWind(ctx, master, nbuf);
      if (st.windOn) return;
      st.windOn = true;
      const now = ctx.currentTime;
      rig.gate.gain.cancelScheduledValues(now);
      rig.gate.gain.setValueAtTime(Math.max(rig.gate.gain.value, ENV_FLOOR), now);
      rig.gate.gain.linearRampToValueAtTime(WIND_LEVEL, now + WIND_FADE_S);
    } else {
      const rig = st.wind;
      st.windOn = false;
      if (!rig) return;
      const now = ctx.currentTime;
      rig.gate.gain.cancelScheduledValues(now);
      rig.gate.gain.setValueAtTime(rig.gate.gain.value, now);
      rig.gate.gain.linearRampToValueAtTime(0, now + WIND_FADE_S);
    }
  }

  // ---- one-shot voices --------------------------------------------------------

  function castVoice(ctx: BaseAudioContext, nbuf: AudioBuffer, master: GainNode, slot: number): void {
    const t0 = ctx.currentTime;
    const root = CAST_SLOT_HZ[slot] ?? CAST_SLOT_HZ[0] ?? 320;
    // airy whoosh rising a fifth, with a grit tail — reads as a spell leaving the hand
    beep(ctx, master, { type: 'sine', f0: root, f1: root * 1.5, t0, dur: 0.16, peak: 0.20 });
    burst(ctx, nbuf, master, {
      type: 'bandpass', f0: root * 4, f1: root * 9, q: 1.4, t0, dur: 0.18, peak: 0.16,
    });
  }

  function killSting(ctx: BaseAudioContext, master: GainNode, firstBlood: boolean): void {
    const t0 = ctx.currentTime;
    const peak = firstBlood ? 0.34 : 0.26;
    // two falling fifths over a low hit — a skull, not a fanfare
    beep(ctx, master, { type: 'sine', f0: 98, t0, dur: 0.4, peak: peak * 0.9 });
    beep(ctx, master, { type: 'triangle', f0: 659.25, f1: 440, t0, dur: 0.14, peak });
    beep(ctx, master, { type: 'triangle', f0: 440, f1: 293.66, t0: t0 + 0.1, dur: 0.2, peak: peak * 0.9 });
    if (firstBlood) {
      // first blood earns an extra octave sheen
      beep(ctx, master, { type: 'sine', f0: 1318.51, f1: 880, t0: t0 + 0.1, dur: 0.24, peak: 0.10 });
    }
  }

  function towerRumble(ctx: BaseAudioContext, nbuf: AudioBuffer, master: GainNode, ancient: boolean): void {
    const t0 = ctx.currentTime;
    const scale = ancient ? 1.35 : 1;
    // masonry collapse: low noise wall + sub drop, deeper for the Ancient
    burst(ctx, nbuf, master, {
      type: 'lowpass', f0: 900 * scale, f1: 120, q: 0.5, t0, dur: 1.1 * scale, peak: 0.5,
    });
    beep(ctx, master, { type: 'sine', f0: 90, f1: 30, t0, dur: 0.9 * scale, peak: 0.55 });
    burst(ctx, nbuf, master, {
      type: 'lowpass', f0: 240, f1: 80, q: 0.4, t0: t0 + 0.08, dur: 1.6 * scale,
      peak: 0.22, attack: 0.1, loop: true,
    });
  }

  function surgeHorn(ctx: BaseAudioContext, master: GainNode): void {
    const t0 = ctx.currentTime;
    // stacked saw fifths swelling and holding — the overtime war-horn
    for (const [i, f] of [146.83, 220, 293.66].entries()) {
      beep(ctx, master, {
        type: 'sawtooth', f0: f, t0: t0 + i * 0.09, dur: 1.4, peak: 0.16, attack: 0.25,
      });
    }
    beep(ctx, master, { type: 'sine', f0: 73.42, t0, dur: 1.6, peak: 0.3, attack: 0.2 });
  }

  function endSting(ctx: BaseAudioContext, master: GainNode, draw: boolean): void {
    const t0 = ctx.currentTime;
    if (draw) {
      // unresolved: two notes a tritone apart, low and short
      beep(ctx, master, { type: 'triangle', f0: 293.66, t0, dur: 0.5, peak: 0.24 });
      beep(ctx, master, { type: 'triangle', f0: 415.3, t0: t0 + 0.35, dur: 0.8, peak: 0.22 });
      beep(ctx, master, { type: 'sine', f0: 98, t0, dur: 1.2, peak: 0.26 });
      return;
    }
    // team-neutral match-end cadence: falling fourths over a low bloom —
    // game.ts layers ui('levelup')/ui('error') for the win/lose colour
    beep(ctx, master, { type: 'sine', f0: 98, t0, dur: 1.2, peak: 0.3 });
    beep(ctx, master, { type: 'triangle', f0: 523.25, t0, dur: 0.22, peak: 0.28 });
    beep(ctx, master, { type: 'triangle', f0: 392, t0: t0 + 0.18, dur: 0.24, peak: 0.28 });
    beep(ctx, master, { type: 'triangle', f0: 261.63, t0: t0 + 0.38, dur: 0.6, peak: 0.3 });
  }

  // ---- the frozen handle --------------------------------------------------------

  return {
    event(ev: RiftEvent): void {
      try {
        if (!ensure()) return;
        const ctx = st.ctx;
        const master = st.master;
        const nbuf = st.noiseBuf;
        if (!ctx || !master || !nbuf) return;
        switch (ev.t) {
          case 'rift_cast':
            castVoice(ctx, nbuf, master, ev.slot);
            break;
          case 'rift_kill':
            killSting(ctx, master, ev.firstBlood);
            break;
          case 'rift_structure':
            towerRumble(ctx, nbuf, master, ev.kind === 'ancient');
            break;
          case 'rift_surge':
            surgeHorn(ctx, master);
            break;
          case 'rift_end':
            endSting(ctx, master, ev.winner === null);
            break;
          case 'rift_pick': {
            // soft confirm tick as lobby picks land
            const t0 = ctx.currentTime;
            beep(ctx, master, { type: 'triangle', f0: 587.33, t0, dur: 0.07, peak: 0.14 });
            break;
          }
          case 'rift_roster':
            break; // roster churn is silent — the lobby view carries it
        }
      } catch {
        // audio must never crash the client
      }
    },

    ui(kind: 'click' | 'buy' | 'error' | 'levelup'): void {
      try {
        if (!ensure()) return;
        const ctx = st.ctx;
        const master = st.master;
        const nbuf = st.noiseBuf;
        if (!ctx || !master || !nbuf) return;
        const t0 = ctx.currentTime;
        switch (kind) {
          case 'click':
            beep(ctx, master, { type: 'sine', f0: 880, t0, dur: 0.05, peak: 0.18 });
            break;
          case 'buy':
            // the cha-chime: two bright coin ticks, up a major third — gold
            // spent (and, if game.ts diffs snaps, gold EARNED on a last-hit)
            beep(ctx, master, { type: 'triangle', f0: 1567.98, t0, dur: 0.06, peak: 0.2 });
            beep(ctx, master, { type: 'triangle', f0: 1975.53, t0: t0 + 0.05, dur: 0.12, peak: 0.22 });
            burst(ctx, nbuf, master, {
              type: 'highpass', f0: 5200, t0, dur: 0.05, peak: 0.06,
            });
            break;
          case 'error':
            // dull unpitched thud — refusal, and (layered by game.ts) own death
            beep(ctx, master, { type: 'sine', f0: 180, f1: 90, t0, dur: 0.14, peak: 0.4 });
            burst(ctx, nbuf, master, { type: 'lowpass', f0: 320, f1: 150, t0, dur: 0.12, peak: 0.28 });
            break;
          case 'levelup': {
            // rising three-note arpeggio — a point earned
            beep(ctx, master, { type: 'triangle', f0: 523.25, t0, dur: 0.1, peak: 0.22 });
            beep(ctx, master, { type: 'triangle', f0: 659.25, t0: t0 + 0.08, dur: 0.1, peak: 0.22 });
            beep(ctx, master, { type: 'triangle', f0: 783.99, t0: t0 + 0.16, dur: 0.22, peak: 0.26 });
            break;
          }
        }
      } catch {
        // audio must never crash the client
      }
    },

    setPhase(p: 'menu' | 'live'): void {
      try {
        if (p === 'live') {
          if (ensure()) setWind(true);
        } else {
          setWind(false);
        }
      } catch {
        // audio must never crash the client
      }
    },
  };
}
