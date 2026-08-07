/**
 * RIFT AUDIO — lab.ts (T11, the render seam)
 *
 * Assigns `window.__riftAudio` (`AudioLabApi`) and `window.__riftAudioBaseline`
 * (`BaselineLabApi`), the two globals `scripts/audio-render-rift.mjs` (T12) drives to render
 * every cue, every scene, and every legacy baseline id through an `OfflineAudioContext` and
 * dump WAV + spectrogram + metrics. Without this seam there is no way to hear, measure, or
 * judge anything the audio build produced — see AUDIO_CONTRACT.md's T11 spec.
 *
 * EVERYTHING here renders through `OfflineAudioContext`. No real-time `AudioContext` is ever
 * constructed. `createAudio()` (index.ts) is NOT used — it lazily owns a live `AudioContext`
 * and is unsuitable for offline, deterministic rendering — so this module builds the engine
 * + registry directly, exactly as `index.ts` does, against the same frozen `dsp.ts`/
 * `engine.ts`/`ambience.ts`/`music.ts` factories.
 */

import type { RiftEvent } from '@rift/shared';
import type {
  AudioLabApi,
  BaselineLabApi,
  CueSpec,
  ListenerState,
  RenderedAudio,
  SceneDef,
  SceneName,
  SoundId,
} from './contract.js';
import { DEFAULT_SETTINGS, MUSIC, SCENES } from './config.js';
import { createAmbience } from './ambience.js';
import { createBaselineAudio } from './baseline.legacy.js';
import { ABILITY_CUES } from './cues/abilities.js';
import { COMBAT_CUES } from './cues/combat.js';
import { OBJECTIVE_CUES } from './cues/objectives.js';
import { UI_CUES } from './cues/ui.js';
import { createEngine } from './engine.js';
import { createMusic } from './music.js';

const SAMPLE_RATE = 48000;

/** The scene listener position, per AUDIO_CONTRACT.md T11 — used for every isolated cue
 *  render too, so a cue rendered at `offsetM: 0` sits exactly at the listener (centred, no
 *  reverb send) and `offsetM: 18` evidences pan and distance-scaled reverb. */
const LAB_LISTENER: ListenerState = { x: 56, z: 56, height: 36 };

// ---------------------------------------------------------------------------
// The total registry — mirrors index.ts's assembly exactly (that module's own `REGISTRY`
// constant is private, so the render harness builds its own rather than reaching into T10's
// territory). `Record<SoundId, CueSpec>` (no `Partial`) makes a missing cue a compile error.
// ---------------------------------------------------------------------------

const REGISTRY: Readonly<Record<SoundId, CueSpec>> = {
  ...ABILITY_CUES,
  ...COMBAT_CUES,
  ...OBJECTIVE_CUES,
  ...UI_CUES,
};

// Object.keys on an exhaustive Record<SoundId, CueSpec> yields exactly the SoundId key
// space by construction — the totality of REGISTRY above is what makes this safe.
const SOUND_IDS: readonly SoundId[] = Object.keys(REGISTRY) as readonly SoundId[];

function ids(): readonly SoundId[] {
  return SOUND_IDS;
}

// ---------------------------------------------------------------------------
// renderCue — one cue, isolated, through a 2-channel OfflineAudioContext.
// ---------------------------------------------------------------------------

async function renderCue(id: SoundId, seconds: number, offsetM: number): Promise<RenderedAudio> {
  const length = Math.max(1, Math.round(seconds * SAMPLE_RATE));
  const octx = new OfflineAudioContext(2, length, SAMPLE_RATE);

  const engine = createEngine(octx, octx.destination, REGISTRY, DEFAULT_SETTINGS);
  // Must precede play(): an unset listener defaults to the origin, which puts every world
  // cue ~79m away (beyond SPATIAL.audibleRadius) and silently renders nothing.
  engine.setListener(LAB_LISTENER);
  engine.play(id, { x: LAB_LISTENER.x + offsetM, z: LAB_LISTENER.z });

  const rendered = await octx.startRendering();
  return {
    sampleRate: rendered.sampleRate,
    left: rendered.getChannelData(0),
    right: rendered.getChannelData(1),
    preLimitLeft: null,
    preLimitRight: null,
  };
}

// ---------------------------------------------------------------------------
// renderScene — a scripted multi-event scene through a 4-channel OfflineAudioContext:
// post-limiter on channels 0/1, the pre-limiter tap (EngineHandle.preLimit) on 2/3, so the
// headroom judge can measure limiter activity that a WaveShaper would otherwise hide.
// ---------------------------------------------------------------------------

function findScene(name: SceneName): SceneDef {
  for (const s of SCENES) {
    if (s.name === name) return s;
  }
  // SCENES (config.ts) is exhaustive over SceneName by construction; this only fires if
  // that invariant is ever broken, and a loud failure beats a silent, wrong render.
  throw new Error(`audio-lab: no SceneDef for scene "${name}"`);
}

async function renderScene(name: SceneName, seconds: number): Promise<RenderedAudio> {
  const sceneDef = findScene(name);
  const length = Math.max(1, Math.round(seconds * SAMPLE_RATE));
  const octx = new OfflineAudioContext(4, length, SAMPLE_RATE);

  // post-limiter (engine's own `dest`) -> channels 0/1.
  const merger = octx.createChannelMerger(4);
  merger.connect(octx.destination);
  const postSplitter = octx.createChannelSplitter(2);
  postSplitter.connect(merger, 0, 0);
  postSplitter.connect(merger, 1, 1);

  const engine = createEngine(octx, postSplitter, REGISTRY, DEFAULT_SETTINGS);

  // engine.preLimit (pre-soft-clip tap) -> channels 2/3.
  const preSplitter = octx.createChannelSplitter(2);
  engine.preLimit.connect(preSplitter);
  preSplitter.connect(merger, 0, 2);
  preSplitter.connect(merger, 1, 3);

  const ambience = createAmbience(engine.graph);
  const music = createMusic(engine.graph);

  engine.setListener(sceneDef.listener);

  // BINDING ORDER (AUDIO_CONTRACT.md T11): start/setIntensity/setScene MUST be issued before
  // the first tick. Both modules only act on a pending target when a tick arrives — issuing
  // the target after the pump has already crossed the fade window would still be mid-fade at
  // t=0, and every mix/ducking/cut-through assertion would measure near-silence while still
  // exiting 0.
  music.start();
  music.setIntensity(sceneDef.music);
  ambience.setScene(sceneDef.ambience);

  const step = MUSIC.offlineStepS;

  // Pre-roll: walk the injected clock from -preRollS up to (not including) 0. Bar/beat and
  // grain bookkeeping in music.ts/ambience.ts advance correctly through this negative span;
  // neither module schedules any actual audio before t=0 (they guard that internally), so by
  // the time the loop below reaches 0 both beds are already at steady state.
  for (let t = -sceneDef.preRollS; t < 0; t += step) {
    music.tick(t);
    ambience.tick(t);
  }

  // Measured window: fire every SceneStep at its own atSec, interleaved with the same
  // fixed-step clock pump. `sceneDef.steps` is authored in ascending atSec order (config.ts),
  // and engine.ts's duck/voice-steal bookkeeping keys off the ORDER `play()` is called in —
  // so steps must be issued in ascending time order, which this walk preserves.
  let stepIdx = 0;
  const fireStepsUpTo = (uptoSec: number): void => {
    for (;;) {
      const s = sceneDef.steps[stepIdx];
      if (s === undefined || s.atSec > uptoSec) return;
      engine.play(s.id, { ...s.opt, delay: s.atSec });
      stepIdx += 1;
    }
  };
  for (let t = 0; t < seconds; t += step) {
    fireStepsUpTo(t);
    music.tick(t);
    ambience.tick(t);
  }
  fireStepsUpTo(Infinity); // flush any step whose atSec fell after the last pump tick

  const rendered = await octx.startRendering();
  return {
    sampleRate: rendered.sampleRate,
    left: rendered.getChannelData(0),
    right: rendered.getChannelData(1),
    preLimitLeft: rendered.getChannelData(2),
    preLimitRight: rendered.getChannelData(3),
  };
}

// ---------------------------------------------------------------------------
// Baseline (legacy) rendering — drives baseline.legacy.ts's createBaselineAudio with a
// synthetic RiftEvent or ui() call matching the requested legacy id. Ids here are the OLD
// module's trigger names, not SoundIds. `rift_roster` is intentionally excluded: the legacy
// module treats it as silent (a genuine no-op), and including it would fail the harness's
// own silence-floor gate on a case that is silent by design, not by defect.
// ---------------------------------------------------------------------------

const BASELINE_IDS: readonly string[] = [
  'rift_cast',
  'rift_kill',
  'rift_structure',
  'rift_surge',
  'rift_end',
  'rift_pick',
  'click',
  'buy',
  'error',
  'levelup',
];

function baselineIds(): readonly string[] {
  return BASELINE_IDS;
}

function makeBaselineEvent(id: string): RiftEvent | null {
  switch (id) {
    case 'rift_cast':
      return { t: 'rift_cast', id: 0, slot: 0, x: 0, z: 0 };
    case 'rift_kill':
      return { t: 'rift_kill', killer: null, victim: 'baseline-victim', gold: 0, firstBlood: false };
    case 'rift_structure':
      return { t: 'rift_structure', team: 0, kind: 'tower', lane: null };
    case 'rift_surge':
      return { t: 'rift_surge' };
    case 'rift_end':
      return { t: 'rift_end', winner: 0, reason: 'ancient', stats: [] };
    case 'rift_pick':
      return { t: 'rift_pick', id: 'baseline-player', hero: 'bullwark' };
    default:
      return null;
  }
}

async function renderBaseline(id: string, seconds: number): Promise<RenderedAudio> {
  const length = Math.max(1, Math.round(seconds * SAMPLE_RATE));
  const octx = new OfflineAudioContext(2, length, SAMPLE_RATE);
  const audio = createBaselineAudio(octx, octx.destination);

  const ev = makeBaselineEvent(id);
  if (ev !== null) {
    audio.event(ev);
  } else if (id === 'click' || id === 'buy' || id === 'error' || id === 'levelup') {
    audio.ui(id);
  } else {
    throw new Error(`audio-lab baseline: unknown id "${id}"`);
  }

  const rendered = await octx.startRendering();
  return {
    sampleRate: rendered.sampleRate,
    left: rendered.getChannelData(0),
    right: rendered.getChannelData(1),
    preLimitLeft: null,
    preLimitRight: null,
  };
}

// ---------------------------------------------------------------------------
// The binding globals. Both must exist before the page signals ready; this is a plain
// `type="module"` script, which the HTML spec runs after DOM parsing but before
// `DOMContentLoaded` fires, and this assignment is synchronous top-level module code.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __riftAudio: AudioLabApi;
    __riftAudioBaseline: BaselineLabApi;
  }
}

const labApi: AudioLabApi = { ids, renderCue, renderScene };
const baselineApi: BaselineLabApi = { ids: baselineIds, render: renderBaseline };

window.__riftAudio = labApi;
window.__riftAudioBaseline = baselineApi;
