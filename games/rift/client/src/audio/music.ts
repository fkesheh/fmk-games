/**
 * RIFT AUDIO — music.ts (T9)
 *
 * The adaptive procedural score. Four layers (`pad`, `pulse`, `perc`, `lead`) enter and
 * leave as `MusicIntensity` (0-4) changes, per `MUSIC.layers` in config.ts. Music is NOT a
 * `SoundId` and is never registered as a cue — it synthesises directly through the
 * `CueGraph` + `dsp.ts` archetypes as a long-lived lifecycle object (`MusicHandle`).
 *
 * Tonal material: D natural minor only, every pitch via `degree(PALETTE.rootHz, ...)`.
 * `pad` walks the D -> Bb -> F -> C progression (scale degrees 0, 5, 2, 6) one chord per
 * bar, `pulse` and the sub half of `perc` sit on the D root, `lead` (intensity 4 only)
 * plays a restrained 4-note mid-register motif (D - F - A - G). Everything stays in the
 * sub/low/mid registers, well under `INFO_FLOOR_HZ` — the bed must never compete with the
 * `info` register reserved for gameplay information (SONIC_BIBLE §3).
 *
 * SCHEDULING MODEL — the part that must survive an offline, non-realtime render.
 *
 * `tick(nowSec)` is a classic WebAudio look-ahead scheduler: `nowSec` is an INJECTED clock
 * (never `ctx.currentTime`, `performance.now()`, `Date.now()` or a timer). Internally the
 * module walks a fixed eighth-note grid anchored at `nowSec === 0` — the origin every
 * caller already agrees on: live play starts ticking near `ctx.currentTime === 0`, and the
 * offline render harness pumps `nowSec` up from `-preRollS` through the scene using the
 * same origin. On every call, any eighth-note event whose nominal time falls within
 * `[nowSec, nowSec + MUSIC.lookaheadS)` is scheduled exactly once via a monotonically
 * advancing pointer that is never rewound and never revisits an index — the standard
 * look-ahead invariant, satisfied without ever reading a clock of its own.
 *
 * PRE-ROLL / NEGATIVE TIME. `AudioParam` automation cannot safely target a time before the
 * render's own origin, so no archetype call is ever made for a nominal event time < 0.
 * Bar/beat bookkeeping — which chord, which bar, the lead-motif position, which layers are
 * meant to be on — still advances through negative time exactly as it would through
 * positive time, so by the time `nowSec` crosses 0 the score is already at steady state:
 * mid-progression, every layer that should be audible already faded in. Layer entry/exit
 * uses `MUSIC.layerFadeS` crossfades via `scheduleLayerGain`, which detects a fade that
 * started, or wholly completed, before 0 and lands the `AudioParam` on the correct
 * interpolated (or final) value AT time 0 rather than ever calling a scheduling method
 * with a negative time.
 *
 * `setIntensity` never applies mid-phrase: it stores the requested value, and the next bar
 * boundary the scheduler crosses (`syncBar`) is the only place `currentIntensity` changes
 * and layer gains are re-targeted.
 */

import type {
  CreateMusic,
  CueGraph,
  Env,
  MusicHandle,
  MusicIntensity,
  MusicLayer,
} from './contract.js';
import { MUSIC, PALETTE, VARY } from './config.js';
import { db, degree, jitter, jitterDb, noise, swell, thump, tone } from './dsp.js';

// ---------------------------------------------------------------------------
// Tempo grid — pure arithmetic on the frozen MUSIC constants, not a re-declaration of them.
// ---------------------------------------------------------------------------

const SEC_PER_BEAT = 60 / MUSIC.bpm;
const SEC_PER_EIGHTH = SEC_PER_BEAT / 2;
const EIGHTHS_PER_BAR = MUSIC.beatsPerBar * 2;
const BAR_SEC = SEC_PER_BEAT * MUSIC.beatsPerBar;

/** How quickly `stop()` silences the layers — a short tail, not the notes' own long one. */
const STOP_FADE_S = 0.25;

const ALL_LAYERS: readonly MusicLayer[] = ['pad', 'pulse', 'perc', 'lead'];

/** D -> Bb -> F -> C: natural-minor scale degrees against the frozen root, one per bar. */
const PAD_CHORD_DEGREES: readonly number[] = [0, 5, 2, 6];

/** A restrained 4-note modal motif, mid register: D - F - A - G. Intensity 4 only. */
const LEAD_MOTIF_DEGREES: readonly number[] = [0, 2, 4, 3];

function adsr(attack: number, decay: number, sustain: number, release: number, peak: number): Env {
  return { attack, decay, sustain, release, peak };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// Layer-gain crossfade — the macro "enter/leave" fade AUDIO_CONTRACT.md T9 calls for.
// Never schedules an AudioParam call at a negative time; a fade that started, or wholly
// elapsed, before the render's origin lands directly on its (interpolated or final) value
// at time 0.
// ---------------------------------------------------------------------------

function scheduleLayerGain(node: GainNode, fromSec: number, target: number, fadeS: number): void {
  const endSec = fromSec + fadeS;
  if (endSec <= 0) {
    node.gain.cancelScheduledValues(0);
    node.gain.setValueAtTime(target, 0);
    return;
  }
  // Every fade here is binary (layer off -> on, or on -> off), so the "from" endpoint is
  // simply the opposite of the target — no separate state tracking needed.
  const from = target > 0.5 ? 0 : 1;
  if (fromSec < 0) {
    const elapsed = clamp01((0 - fromSec) / fadeS);
    const valueAtZero = from + (target - from) * elapsed;
    node.gain.cancelScheduledValues(0);
    node.gain.setValueAtTime(valueAtZero, 0);
    node.gain.linearRampToValueAtTime(target, endSec);
    return;
  }
  node.gain.cancelScheduledValues(fromSec);
  node.gain.setValueAtTime(from, fromSec);
  node.gain.linearRampToValueAtTime(target, endSec);
}

// ---------------------------------------------------------------------------
// Per-layer note generators. Each targets its own layer gain node (never the bus
// directly) — the macro fade lives on that node; these only shape the individual note.
// ---------------------------------------------------------------------------

/** The drone. One retriggered `swell` per bar; a long release overlapping the next bar's
 * attack is what makes four separate notes read as one continuous, moving chord. */
function schedulePad(g: CueGraph, dest: AudioNode, atSec: number, barIdx: number): void {
  const span = PAD_CHORD_DEGREES.length;
  const idx = ((barIdx % span) + span) % span;
  const deg = PAD_CHORD_DEGREES[idx] ?? 0;
  const hz = jitter(g, degree(PALETTE.rootHz, deg, 0), VARY.pitchPct);
  const attack = 0.5;
  const decay = 0.4;
  const release = Math.max(0.2, BAR_SEC - attack - decay + 0.6);
  swell(
    g,
    atSec,
    dest,
    {
      type: 'triangle',
      hz,
      voices: 3,
      spreadCents: 8,
      openHz: 900,
      sweepHz: 560,
      sweepTime: attack + decay + release,
      env: adsr(attack, decay, 0.82, release, 1),
    },
    db(-16) * jitterDb(g, VARY.levelDb),
  );
}

/** Eighth-note sub pulse on the root. "Felt, not heard" — slight emphasis on the beat. */
function schedulePulse(g: CueGraph, dest: AudioNode, atSec: number, eighthInBar: number): void {
  const onBeat = eighthInBar % 2 === 0;
  const hz = jitter(g, degree(PALETTE.rootHz, 0, -1), VARY.pitchPct);
  const at = Math.max(0, atSec + (g.rnd() * 2 - 1) * VARY.timingS);
  thump(
    g,
    at,
    dest,
    {
      hz,
      dropHz: hz * 0.7,
      dropTime: 0.09,
      env: adsr(0.004, 0.05, 0.12, 0.09, onBeat ? 0.55 : 0.34),
    },
    db(-20) * jitterDb(g, VARY.levelDb),
  );
}

/** The war drum: a seeded, sparse, downbeat-heavy pattern. Sub `thump` for weight, a low
 * bandpassed `noise` burst for the skin transient. Never a fixed pattern twice — beats 1-3
 * are seeded coin-flips against `g.rnd()`, the only source of variation. */
function schedulePerc(g: CueGraph, dest: AudioNode, atSec: number, beatInBar: number): void {
  const isDownbeat = beatInBar === 0;
  const hitChance = isDownbeat ? 1 : beatInBar === 2 ? 0.55 : 0.3;
  if (g.rnd() > hitChance) return;

  const at = Math.max(0, atSec + (g.rnd() * 2 - 1) * VARY.timingS);
  const subHz = jitter(g, degree(PALETTE.rootHz, 0, -1), VARY.pitchPct);
  const peak = isDownbeat ? 0.85 : 0.55;

  thump(
    g,
    at,
    dest,
    {
      hz: subHz,
      dropHz: subHz * 0.5,
      dropTime: 0.16,
      env: adsr(0.003, 0.09, 0.1, 0.15, peak),
    },
    db(-11) * jitterDb(g, VARY.levelDb),
  );
  noise(
    g,
    at,
    dest,
    {
      filter: 'bandpass',
      hz: jitter(g, PALETTE.low.A2, VARY.timbrePct),
      q: 2.2,
      env: adsr(0.001, 0.03, 0, 0.05, isDownbeat ? 0.5 : 0.3),
    },
    db(-17) * jitterDb(g, VARY.levelDb),
  );
}

/** The restrained mid-register motif. Intensity 4 only, one note every other beat. */
function scheduleLead(g: CueGraph, dest: AudioNode, atSec: number, step: number): void {
  const span = LEAD_MOTIF_DEGREES.length;
  const deg = LEAD_MOTIF_DEGREES[step % span] ?? 0;
  const hz = jitter(g, degree(PALETTE.rootHz, deg, 1), VARY.pitchPct);
  tone(
    g,
    atSec,
    dest,
    {
      type: 'triangle',
      hz,
      env: adsr(0.05, 0.15, 0.5, 0.4, 1),
    },
    db(-14) * jitterDb(g, VARY.levelDb),
  );
}

// ---------------------------------------------------------------------------
// createMusic
// ---------------------------------------------------------------------------

export const createMusic: CreateMusic = (g) => {
  const layerGain: Record<MusicLayer, GainNode> = {
    pad: g.ctx.createGain(),
    pulse: g.ctx.createGain(),
    perc: g.ctx.createGain(),
    lead: g.ctx.createGain(),
  };
  for (const layer of ALL_LAYERS) {
    layerGain[layer].gain.value = 0;
    layerGain[layer].connect(g.bus.music);
  }

  let running = false;
  let currentIntensity: MusicIntensity = 0;
  let pendingIntensity: MusicIntensity | null = null;
  let currentLayers: ReadonlySet<MusicLayer> = new Set();
  let nextEighth: number | null = null;
  let leadStep = 0;
  let lastNowSec = 0;

  /** Runs exactly at every bar boundary the scheduler crosses (including negative-time
   * ones during offline pre-roll). Applies a pending intensity change and reconciles each
   * layer's on/off state against it — the ONLY place either happens. */
  function syncBar(atSec: number): void {
    if (pendingIntensity !== null) {
      currentIntensity = pendingIntensity;
      pendingIntensity = null;
    }
    // `MUSIC.layers` is typed as a general array, not a tuple, so indexing yields
    // `readonly MusicLayer[] | undefined` under noUncheckedIndexedAccess even though every
    // `MusicIntensity` value (0..4) is always in range by construction.
    const target = new Set<MusicLayer>(MUSIC.layers[currentIntensity] ?? []);
    for (const layer of ALL_LAYERS) {
      const shouldBeOn = target.has(layer);
      const wasOn = currentLayers.has(layer);
      if (shouldBeOn !== wasOn) {
        scheduleLayerGain(layerGain[layer], atSec, shouldBeOn ? 1 : 0, MUSIC.layerFadeS);
      }
    }
    currentLayers = target;
  }

  const handle: MusicHandle = {
    setIntensity(i) {
      pendingIntensity = i;
    },

    tick(nowSec) {
      if (!running) return;
      lastNowSec = nowSec;
      if (nextEighth === null) {
        nextEighth = Math.floor(nowSec / SEC_PER_EIGHTH);
      }
      const horizon = nowSec + MUSIC.lookaheadS;
      while (nextEighth * SEC_PER_EIGHTH < horizon) {
        const eighthIdx = nextEighth;
        const t = eighthIdx * SEC_PER_EIGHTH;
        const barIdx = Math.floor(eighthIdx / EIGHTHS_PER_BAR);
        const eighthInBar = eighthIdx - barIdx * EIGHTHS_PER_BAR;
        const isBarStart = eighthInBar === 0;
        const isBeatStart = eighthInBar % 2 === 0;
        const beatInBar = Math.floor(eighthInBar / 2);

        if (isBarStart) syncBar(t);

        // Bookkeeping above always advances, even for t < 0 (pre-roll); actual synthesis
        // never targets a negative time — see the module doc comment.
        if (t >= 0) {
          if (isBarStart && currentLayers.has('pad')) {
            schedulePad(g, layerGain.pad, t, barIdx);
          }
          if (currentLayers.has('pulse')) {
            schedulePulse(g, layerGain.pulse, t, eighthInBar);
          }
          if (isBeatStart && currentLayers.has('perc')) {
            schedulePerc(g, layerGain.perc, t, beatInBar);
          }
          if (isBeatStart && beatInBar % 2 === 0 && currentLayers.has('lead')) {
            scheduleLead(g, layerGain.lead, t, leadStep);
            leadStep += 1;
          }
        }

        nextEighth += 1;
      }
    },

    start() {
      if (running) return;
      running = true;
      nextEighth = null;
    },

    stop() {
      if (running) {
        for (const layer of ALL_LAYERS) {
          scheduleLayerGain(layerGain[layer], lastNowSec, 0, STOP_FADE_S);
        }
      }
      running = false;
      // Layers are audibly silenced above; mark none as logically "on" so a later
      // `start()` re-triggers a full fade-in at the next bar boundary instead of assuming
      // the (now-silent) gain nodes are already sitting at their target value.
      currentLayers = new Set();
      nextEighth = null;
    },
  };

  return handle;
};
