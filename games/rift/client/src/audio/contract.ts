/**
 * RIFT AUDIO — FROZEN CONTRACT (types only, zero logic).
 *
 * This file is IMMUTABLE for the duration of the audio build. No implementer may
 * add, remove, widen, narrow, or rename anything here. If you believe something is
 * missing, STOP and report it to the orchestrator — do not work around it.
 *
 * Companion documents (also frozen):
 *   - docs/rift-audio/SONIC_BIBLE.md    — mood, tonal palette, timbre archetypes, mix law
 *   - docs/rift-audio/AUDIO_CONTRACT.md — the per-file spec every implementer receives
 *   - ./config.ts                        — all constants and tables (pure data, also immutable)
 *
 * Amendment to `games/rift/CONTRACT.md` authorising this build: see that file's
 * "Audio amendment" block. `client/src/contract.ts` is Layer-1 normative and is
 * modified ONLY by the orchestrator, ONLY to re-export `RiftAudioHandle`.
 *
 * DESIGN NOTES THAT EXPLAIN THE SHAPE OF THIS FILE
 *
 * 1. Everything is renderable offline. Every synthesis path takes a `BaseAudioContext`
 *    and an explicit destination node, never a module-global `AudioContext`. This is what
 *    lets `scripts/audio-render-rift.mjs` render each cue deterministically through an
 *    `OfflineAudioContext` and produce the spectrograms the audio-director judge scores.
 *    A cue that reaches for a global context is unrenderable and therefore unjudgeable.
 *
 * 2. Event derivation is PURE. `DeriverHandle` turns snapshots + wire events into
 *    `AudioEvent`s with no WebAudio involvement at all, so it is unit-testable under
 *    vitest's node environment (the repo has no jsdom). This is deliberate: the richest
 *    part of the new audio surface — last-hits, hit impacts, cooldown-ready, respawn,
 *    low-HP — is derived, not networked, and it is the part most likely to regress.
 *
 * 3. The wire protocol is NOT changing. RIFT ships 7 event kinds; everything else the
 *    player hears is derived client-side from snapshot diffs. No server file is touched.
 *
 * 4. Ambience and music are NOT in the cue registry. They are continuous graphs with
 *    their own lifecycle handles, not one-shots. Putting them in a `Record<SoundId, CueSpec>`
 *    would give the same sound two owners and make `engine.play('amb.field')` a legal call
 *    that doubles the bed. They synthesise directly through `CueGraph` + `dsp.ts`.
 */

import type {
  EntKind,
  EntSnap,
  HeroId,
  ItemId,
  RiftEvent,
  TeamId,
  YouSnap,
} from '@rift/shared';
import type { SnapMsg } from '../contract.js';

// ---------------------------------------------------------------------------
// 1. Mix topology
// ---------------------------------------------------------------------------

/** The five busses. Every voice is routed to exactly one. See SONIC_BIBLE §8. */
export type BusId = 'music' | 'amb' | 'sfx' | 'ui' | 'announcer';

/**
 * 0 = highest. Drives ducking (P<=2 ducks music/amb; P<=1 also ducks sfx) and
 * voice-stealing at the polyphony cap (never steal P<=2). See SONIC_BIBLE §8.
 */
export type Priority = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** User-facing mix settings, persisted to localStorage under `STORAGE_KEY`. */
export interface AudioSettings {
  /** 0..1 linear, applied to the master gain. */
  readonly master: number;
  readonly sfx: number;
  readonly music: number;
  readonly ambience: number;
  readonly muted: boolean;
}

// ---------------------------------------------------------------------------
// 2. Space
// ---------------------------------------------------------------------------

/** The listener is the camera's ground point. Updated every frame from game.ts. */
export interface ListenerState {
  readonly x: number;
  readonly z: number;
  /** Camera height in metres; scales effective distance (zoomed out = further). */
  readonly height: number;
}

/**
 * Resolved spatial treatment for one world cue. Produced by `SpatialHandle.resolve`,
 * consumed by the engine when it builds the voice's output chain.
 */
export interface SpatialResult {
  /** Stereo pan, -1..1, never beyond `SPATIAL.panMax`. */
  readonly pan: number;
  /** Linear gain multiplier from distance rolloff, 0..1. */
  readonly gain: number;
  /** Reverb send amount 0..1 — rises with distance (far things are wetter). */
  readonly send: number;
  /** Lowpass cutoff in Hz applied to the voice; Infinity means "no filter". */
  readonly cutoffHz: number;
  /** False when the cue is beyond `SPATIAL.audibleRadius` and must not be scheduled. */
  readonly audible: boolean;
}

export interface SpatialHandle {
  setListener(l: ListenerState): void;
  /**
   * @param x,z     world position of the sound
   * @param self    true for the local player's own actions: no attenuation, centre-biased
   *                pan, +`SPATIAL.selfBiasDb`. See SONIC_BIBLE §2 law 5.
   * @param visible false when the position is under fog of war: `SPATIAL.fogAttenDb` and
   *                lowpassed to `SPATIAL.fogCutoffHz`, never muted. See SONIC_BIBLE §6.
   */
  resolve(x: number, z: number, self: boolean, visible: boolean): SpatialResult;
}

// ---------------------------------------------------------------------------
// 3. Derived event surface — what the game can actually make a sound about
// ---------------------------------------------------------------------------

/**
 * Damage/utility colour for a cast, derived from `AbilityDef.effects[]`. RIFT's ability
 * schema has no dedicated school field; this classification is the audio layer's own and
 * mirrors the existing visual precedent (`Game.castFxKind` -> 'phys' | 'magic' | 'heal').
 * Order of precedence when an ability has several effects:
 *   damage(physical) > damage(magic) > heal > dash > stun|slow (control) > summon > buff
 *
 * CONSUMED BY: `index.ts` uses it to pick `cast.item.*` for item actives and to select
 * `hit.physical` vs `hit.magic` for ability-driven damage. It is not decoration.
 */
export type CastColour =
  | 'physical'
  | 'magic'
  | 'heal'
  | 'control'
  | 'dash'
  | 'summon'
  | 'buff';

/** Which unit archetype swung, for auto-attack cue selection. */
export type AttackerKind = 'hero' | 'melee' | 'ranged' | 'siege' | 'shade' | 'tower';

/**
 * The internal audio event stream. `DeriverHandle` produces these from snapshots and wire
 * events; `index.ts` routes each to a `SoundId` via the table in AUDIO_CONTRACT.md §T10.
 *
 * EVERY world variant carries position, `self` and `visible` so it can be spatialised
 * without a second lookup. That redundancy is intentional: cue modules must never reach
 * back into game state, and `index.ts` must never re-derive.
 */
export type AudioEvent =
  /** A hero/item ability was cast. `hero`/`slot` select the cue; 24 hero combos + items. */
  | {
      readonly t: 'cast';
      readonly hero: HeroId | null;
      readonly slot: number;
      readonly item: ItemId | null;
      readonly colour: CastColour;
      readonly ult: boolean;
      readonly x: number;
      readonly z: number;
      readonly self: boolean;
      readonly visible: boolean;
    }
  /** A unit swung. Derived from the transient `EntSnap.atk` field. */
  | {
      readonly t: 'attack';
      readonly kind: AttackerKind;
      readonly ranged: boolean;
      readonly x: number;
      readonly z: number;
      readonly self: boolean;
      readonly visible: boolean;
    }
  /**
   * A blow LANDED on some unit. Derived from an entity's hp decreasing between snapshots.
   * This is the other half of combat audio: `attack` is the swing, `hit` is the impact.
   */
  | {
      readonly t: 'hit';
      readonly school: 'physical' | 'magic';
      readonly crit: boolean;
      readonly x: number;
      readonly z: number;
      /** True when the victim is the local player's hero. */
      readonly self: boolean;
      readonly visible: boolean;
    }
  /**
   * The local player took damage. Carries the player's OWN position — the attacker is not
   * knowable from an hp delta, so this is positioned at the victim, not the source.
   */
  | {
      readonly t: 'hurt';
      readonly frac: number;
      readonly hpFrac: number;
      readonly x: number;
      readonly z: number;
    }
  /** A hero died. `friendly` is true when the victim was on the local player's team. */
  | {
      readonly t: 'heroDeath';
      readonly self: boolean;
      readonly friendly: boolean;
      readonly byMe: boolean;
      readonly firstBlood: boolean;
      readonly x: number;
      readonly z: number;
      readonly visible: boolean;
    }
  /** A creep/ward died. Position is its last known one. */
  | {
      readonly t: 'unitDeath';
      readonly kind: EntKind;
      readonly x: number;
      readonly z: number;
      readonly visible: boolean;
    }
  /**
   * A meaningful gold grant. NEVER emitted for the fractional per-tick passive trickle —
   * see `DERIVE.goldMinDelta`. `lastHit` marks the discrete creep-kill grant.
   */
  | { readonly t: 'gold'; readonly amount: number; readonly lastHit: boolean }
  /** A structure fell. */
  | {
      readonly t: 'structure';
      readonly kind: 'tower' | 'guard' | 'ancient';
      readonly friendly: boolean;
      readonly x: number;
      readonly z: number;
    }
  | { readonly t: 'levelUp'; readonly level: number }
  | { readonly t: 'skillPointAvailable'; readonly count: number }
  /** An ability came off cooldown. Soft info tick. */
  | { readonly t: 'abilityReady'; readonly slot: number }
  | { readonly t: 'respawn' }
  /**
   * Crossed DOWN into a low-HP band. `band` indexes `DERIVE.lowHpBands` /
   * `DERIVE.lowHpPulseS`; -1 means "left the low-HP state, stop the heartbeat".
   */
  | { readonly t: 'lowHp'; readonly band: number; readonly hpFrac: number }
  | { readonly t: 'surge' }
  | { readonly t: 'heroPick'; readonly hero: HeroId; readonly self: boolean }
  | { readonly t: 'matchEnd'; readonly won: boolean; readonly draw: boolean }
  /** Own ancient is under attack — drives the klaxon and music intensity 4. */
  | { readonly t: 'ancientThreat'; readonly hpFrac: number };

/** Every `AudioEvent` tag. Used to key the frozen `EVENT_PRIORITY` table in config.ts. */
export type AudioEventTag = AudioEvent['t'];

/**
 * Everything the deriver needs that is not on the snapshot itself. Supplied by game.ts.
 * `isVisible` is `FogHandle.isVisible`; passing it as a function keeps `derive.ts` free of
 * any dependency on the fog module and therefore unit-testable in node.
 *
 * NOTE: the object game.ts passes is a single preallocated instance mutated in place —
 * these fields are `readonly` to the callee, not immutable to the caller.
 */
export interface AudioWorldCtx {
  readonly selfPid: string | null;
  readonly selfEntId: number;
  readonly selfTeam: TeamId | null;
  isVisible(x: number, z: number): boolean;
}

/**
 * PURE. No WebAudio. No DOM. Fully unit-testable under vitest's node environment.
 * Call `snapshot` once per `rift_snap` and `wire` once per `RiftEvent`; both return the
 * events to play, newest last. `reset` clears all diff state between matches.
 */
export interface DeriverHandle {
  snapshot(snap: SnapMsg, ctx: AudioWorldCtx): readonly AudioEvent[];
  wire(ev: RiftEvent, snap: SnapMsg | null, ctx: AudioWorldCtx): readonly AudioEvent[];
  reset(): void;
}

// ---------------------------------------------------------------------------
// 4. Synthesis substrate — the shared vocabulary every cue module imports
// ---------------------------------------------------------------------------

/** Envelope shape shared by every archetype. Times in seconds, peak in linear gain. */
export interface Env {
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
  readonly peak: number;
}

/**
 * Optional swept lowpass, available on every tonal archetype. Omitting all three fields
 * bypasses the filter entirely. A CLOSING filter (`sweepHz` < `filterHz`) is how the
 * `control` damage school and SHADE's whole character are built — see SONIC_BIBLE §3.
 */
export interface FilterSweep {
  readonly filterHz?: number;
  readonly sweepHz?: number;
  readonly sweepTime?: number;
}

export interface ToneSpec extends FilterSweep {
  readonly type: OscillatorType;
  readonly hz: number;
  /** Optional glide target; the oscillator ramps hz -> glideHz over `glideTime`. */
  readonly glideHz?: number;
  readonly glideTime?: number;
  /** Detune in cents, for the deliberately-out-of-tune magic colour. */
  readonly detune?: number;
  readonly env: Env;
}

export interface NoiseSpec {
  readonly filter: BiquadFilterType;
  readonly hz: number;
  /** Optional filter sweep target over `sweepTime`. */
  readonly sweepHz?: number;
  readonly sweepTime?: number;
  readonly q?: number;
  readonly env: Env;
}

export interface ThumpSpec {
  readonly hz: number;
  readonly dropHz: number;
  readonly dropTime: number;
  readonly env: Env;
}

export interface MetalSpec extends FilterSweep {
  /** 4-6 non-integer partial ratios against `hz`. Inharmonic on purpose. */
  readonly ratios: readonly number[];
  readonly hz: number;
  readonly bandHz: number;
  readonly q: number;
  readonly env: Env;
}

export interface ShimmerSpec extends FilterSweep {
  readonly hz: number;
  readonly modHz: number;
  readonly index: number;
  readonly tailHz: number;
  readonly env: Env;
}

export interface SwellSpec extends FilterSweep {
  readonly type: OscillatorType;
  readonly hz: number;
  readonly voices: number;
  readonly spreadCents: number;
  /** Filter start; use `FilterSweep.sweepHz` to open (up) or close (down) from here. */
  readonly openHz: number;
  readonly env: Env;
}

/**
 * The frozen graph handle every cue function receives. Cue code touches WebAudio ONLY
 * through this object and the `dsp.ts` archetype functions — never `new AudioContext`,
 * never `ctx.destination`.
 */
export interface CueGraph {
  /** `AudioContext` live, `OfflineAudioContext` under the render harness. */
  readonly ctx: BaseAudioContext;
  /** Bus inputs. A voice connects to exactly one, or to `CuePlay.dest` when spatialised. */
  readonly bus: Readonly<Record<BusId, GainNode>>;
  /** Shared 1 s seeded white-noise buffer. Never allocate another one. */
  readonly noise: AudioBuffer;
  /** Generated impulse responses, shared. */
  readonly irValley: AudioBuffer;
  readonly irHall: AudioBuffer;
  /** Reverb send inputs; the engine scales these per voice by `SpatialResult.send`. */
  readonly sendValley: GainNode;
  readonly sendHall: GainNode;
  /** Seeded RNG stream, 0..1. `Math.random` is a repo-wide violation. */
  rnd(): number;
}

/**
 * Per-play parameters handed to a cue function. `dest` is where the cue's output must go
 * (the engine has already inserted panning/attenuation/filtering for world cues).
 */
export interface CuePlay {
  /** Node the cue must connect its output to. Never connect to `ctx.destination`. */
  readonly dest: AudioNode;
  /**
   * Per-cue trim. The engine has ALREADY applied distance, self-bias and level jitter in
   * the voice chain; the engine always passes 1 here today. Multiply your design level by
   * it so the field stays usable, but do not treat it as the mix.
   */
  readonly gain: number;
  /** Variation index 0..spec.variants-1 for round-robin cues. */
  readonly variant: number;
  /** Free intensity parameter 0..1; meaning is per-cue (e.g. damage magnitude). */
  readonly intensity: number;
}

/** Every cue in the game has this signature. `at` is an absolute `ctx.currentTime`-based time. */
export type CueFn = (g: CueGraph, at: number, p: CuePlay) => void;

export interface CueSpec {
  readonly fn: CueFn;
  readonly bus: BusId;
  /** Default priority. `PlayOptions.priority` overrides it per play (e.g. self ultimates). */
  readonly priority: Priority;
  /** Approximate tail length in seconds; drives duck release and voice bookkeeping. */
  readonly tail: number;
  /** Number of round-robin variants this cue implements. 1 = jitter only. */
  readonly variants: number;
  /** True for UI/announcer cues that must stay bone-dry and unpanned. */
  readonly dry: boolean;
}

/**
 * What a cue module exports. Declare it with `satisfies CueRegistry` and NO type
 * annotation — annotating with this type erases the literal keys, and the total
 * `Record<SoundId, CueSpec>` merge in `index.ts` (the missing-cue compile check) then
 * fails no matter how complete the registry actually is.
 */
export type CueRegistry = Readonly<Partial<Record<SoundId, CueSpec>>>;

// ---------------------------------------------------------------------------
// 5. The cue registry key space
// ---------------------------------------------------------------------------

/**
 * Every one-shot the game can make. Split across cue modules by prefix:
 *   `cast.*`                              -> cues/abilities.ts
 *   `atk.*`, `hit.*`, `die.*`             -> cues/combat.ts
 *   `obj.*`, `ann.*`                      -> cues/objectives.ts
 *   `ui.*`                                -> cues/ui.ts
 * Ability cues are keyed `cast.<heroId>.<slot>` so all 24 are distinct by construction.
 *
 * Ambience and music beds are deliberately NOT here — see design note 4 at the top.
 */
export type SoundId =
  // --- abilities: 6 heroes x 4 slots -------------------------------------------------
  | 'cast.bullwark.0' | 'cast.bullwark.1' | 'cast.bullwark.2' | 'cast.bullwark.3'
  | 'cast.longbow.0'  | 'cast.longbow.1'  | 'cast.longbow.2'  | 'cast.longbow.3'
  | 'cast.reaver.0'   | 'cast.reaver.1'   | 'cast.reaver.2'   | 'cast.reaver.3'
  | 'cast.hex.0'      | 'cast.hex.1'      | 'cast.hex.2'      | 'cast.hex.3'
  | 'cast.mender.0'   | 'cast.mender.1'   | 'cast.mender.2'   | 'cast.mender.3'
  | 'cast.shade.0'    | 'cast.shade.1'    | 'cast.shade.2'    | 'cast.shade.3'
  // --- item actives ------------------------------------------------------------------
  | 'cast.item.blink' | 'cast.item.horn' | 'cast.item.ward' | 'cast.item.generic'
  // --- combat ------------------------------------------------------------------------
  | 'atk.hero.melee' | 'atk.hero.ranged' | 'atk.creep.melee' | 'atk.creep.ranged'
  | 'atk.siege' | 'atk.tower'
  | 'hit.physical' | 'hit.magic' | 'hit.self' | 'hit.crit' | 'hit.heartbeat'
  | 'die.hero' | 'die.hero.ally' | 'die.hero.self' | 'die.creep' | 'die.ward'
  // --- economy / progression ---------------------------------------------------------
  | 'ui.lastHit' | 'ui.gold' | 'ui.levelUp' | 'ui.skillPoint' | 'ui.abilityReady'
  // --- objectives / announcer --------------------------------------------------------
  | 'obj.tower' | 'obj.guard' | 'obj.ancient' | 'obj.surge' | 'obj.klaxon'
  | 'obj.respawn' | 'obj.countdown' | 'obj.matchStart'
  | 'ann.firstBlood' | 'ann.victory' | 'ann.defeat' | 'ann.draw'
  // --- ui ----------------------------------------------------------------------------
  | 'ui.click' | 'ui.buy' | 'ui.error' | 'ui.shopOpen' | 'ui.shopClose'
  | 'ui.pick' | 'ui.toast';

// ---------------------------------------------------------------------------
// 6. Long-running layers — own their synthesis, NOT in the cue registry
// ---------------------------------------------------------------------------

/** Which ambience bed is active. Crossfaded, never hard-cut. */
export type AmbienceScene = 'silent' | 'menu' | 'field' | 'fountain' | 'dead';

export interface AmbienceHandle {
  /** Crossfade to a scene over `AMBIENCE.fadeS`. Idempotent. */
  setScene(s: AmbienceScene): void;
  /** 0..1 proximity-to-combat, raises the distant-battle layer. */
  setBattleIntensity(v: number): void;
  /** Injected clock, in seconds. Pumped from the frame loop AND from the offline renderer. */
  tick(nowSec: number): void;
  stop(): void;
}

/** 0 = dead/menu silence, 1 = laning, 2 = skirmish, 3 = teamfight, 4 = ancient at risk. */
export type MusicIntensity = 0 | 1 | 2 | 3 | 4;

/** The four score layers. Internal to music.ts — deliberately not `SoundId`s. */
export type MusicLayer = 'pad' | 'pulse' | 'perc' | 'lead';

export interface MusicHandle {
  /** Transitions are bar-synced; the change lands on the next bar, never mid-phrase. */
  setIntensity(i: MusicIntensity): void;
  /** Look-ahead scheduler pump; schedules up to `MUSIC.lookaheadS` ahead of `nowSec`. */
  tick(nowSec: number): void;
  start(): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// 7. The engine
// ---------------------------------------------------------------------------

/**
 * Owns the AudioContext graph, the `CueGraph`, the `SpatialHandle`, ducking, the voice
 * pool and the polyphony cap. Cue modules never see it — they see `CueGraph`/`CuePlay`.
 */
export interface EngineHandle {
  /** Built BY the engine. `index.ts` reads it and passes it to ambience and music. */
  readonly graph: CueGraph;
  /**
   * Pre-limiter tap, for the render harness only. The headroom judge needs the signal
   * BEFORE soft-clipping; a WaveShaper leaves no other way to measure how hard the
   * limiter is working. In the live game nothing connects to this.
   */
  readonly preLimit: AudioNode;
  /** Resume-on-gesture. Safe to call repeatedly; no-ops when already running or offline. */
  resume(): void;
  /**
   * Schedule a cue. Applies spatialisation when a position is given, enforces the
   * polyphony cap with priority stealing, and triggers ducking per SONIC_BIBLE §8.
   * Returns false when the cue was dropped (inaudible, or stolen at the cap).
   */
  play(id: SoundId, opt?: PlayOptions): boolean;
  setSettings(s: AudioSettings): void;
  getSettings(): AudioSettings;
  /** Global lowpass for the death-cam "underwater" state. Infinity = open. */
  setSubmerge(cutoffHz: number): void;
  setListener(l: ListenerState): void;
  tick(dtMs: number): void;
  dispose(): void;
}

export interface PlayOptions {
  /** World position. Omit for UI/announcer cues. */
  readonly x?: number;
  readonly z?: number;
  readonly self?: boolean;
  readonly visible?: boolean;
  /** 0..1, passed through to `CuePlay.intensity`. */
  readonly intensity?: number;
  /** Extra gain in dB on top of the cue's design level. */
  readonly gainDb?: number;
  /** Delay from now, in seconds. Used to space multi-part stingers and to script scenes. */
  readonly delay?: number;
  /**
   * Overrides `CueSpec.priority` for this play only. This is how "own ultimate is
   * self-critical (P2) but an enemy's is nearby-combat (P4)" is expressed — without it,
   * every ult in a teamfight would hold the music bed ducked for its whole tail.
   */
  readonly priority?: Priority;
}

// ---------------------------------------------------------------------------
// 8. Public seam — what game.ts sees
// ---------------------------------------------------------------------------

/** Widened from the original 4 kinds. `game.ts`'s existing calls remain valid. */
export type UiCue =
  | 'click' | 'buy' | 'error' | 'levelup'
  | 'shopOpen' | 'shopClose' | 'pick' | 'toast';

export type AudioPhase = 'menu' | 'lobby' | 'live' | 'dead' | 'ended';

/**
 * The extended `AudioHandle`. `client/src/contract.ts` re-exports this as `AudioHandle`
 * (orchestrator-only edit, authorised by the Audio amendment in games/rift/CONTRACT.md).
 * `event`, `ui`, and `setPhase` keep their original meaning so existing `game.ts` call
 * sites keep working unchanged.
 *
 * EVERY method must be individually try/catch'd and must degrade to silence. No method
 * may log to the console — the e2e and verify gates fail the build on any console error.
 */
export interface RiftAudioHandle {
  /** Wire events, exactly as today. */
  event(ev: RiftEvent): void;
  ui(kind: UiCue): void;
  /** Widened from 'menu' | 'live'. Passing the old two values still behaves as before. */
  setPhase(p: AudioPhase): void;

  /**
   * NEW. Identity + fog access, set once as soon as `rift_hello` lands and updated when
   * `selfEntId` changes. Without this, lobby-phase events (hero picks) cannot know whether
   * they are the local player's, because no snapshot has arrived yet.
   */
  setWorld(ctx: AudioWorldCtx): void;
  /** NEW. Call once per `rift_snap`, from `Game.onSnap`. Runs the deriver. */
  snapshot(snap: SnapMsg): void;
  /** NEW. Call once per frame from `Game.step` with the camera ground point. */
  tick(dtMs: number, listener: ListenerState): void;
  /** NEW. Whole-second countdown tick: lobby start countdown and respawn timer. */
  countdown(secondsLeft: number): void;
  /** NEW. Resume-on-gesture hook, wired to the first pointer/key event. */
  resume(): void;

  settings(): AudioSettings;
  setSettings(s: Partial<AudioSettings>): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 9. Harness seam — how the render/judge loop reaches the synthesis
// ---------------------------------------------------------------------------

/**
 * Exposed on `window.__riftAudio` by the audio-lab entry point. `scripts/audio-render-rift.mjs`
 * drives this to render every cue and every scene through an OfflineAudioContext and dump
 * WAV + spectrogram + metrics. Without this seam there is no aesthetic feedback loop.
 */
export interface AudioLabApi {
  /** Every registered cue id, for exhaustive rendering. */
  ids(): readonly SoundId[];
  /**
   * Render one cue in isolation, positioned AT the listener (centred, dry).
   * @param offsetM when non-zero, place the cue this many metres to the +x side of the
   *        listener instead, so the harness can evidence pan and distance-scaled reverb.
   */
  renderCue(id: SoundId, seconds: number, offsetM: number): Promise<RenderedAudio>;
  /** Render a scripted multi-event scene (see `SCENES` in config.ts) through the real engine. */
  renderScene(name: SceneName, seconds: number): Promise<RenderedAudio>;
}

export interface RenderedAudio {
  readonly sampleRate: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
  /**
   * The pre-limiter signal, present for scene renders (4-channel offline context) and
   * null for single-cue renders. The headroom gate measures how often the limiter is
   * actually engaged, which is unmeasurable from the post-limiter buffer alone.
   */
  readonly preLimitLeft: Float32Array | null;
  readonly preLimitRight: Float32Array | null;
}

/**
 * Exposed on `window.__riftAudioBaseline`. Renders the PRE-BUILD audio module (a copy of
 * the old `ui/audio.ts`, patched to accept an injected context) so the blind A/B judge can
 * be shown old-vs-new pairs. Without this there is no before/after evidence.
 *
 * Ids here are the OLD module's trigger names ('rift_kill', 'click', ...), not `SoundId`s.
 */
export interface BaselineLabApi {
  ids(): readonly string[];
  render(id: string, seconds: number): Promise<RenderedAudio>;
}

/** The composite mixes the headroom/ducking judge scores. Defined in config.ts. */
export type SceneName =
  | 'laning'
  | 'skirmish'
  | 'teamfight'
  | 'towerFallInFight'
  | 'lastHitInFight'
  | 'ancientFall'
  | 'victory'
  | 'menuBed';

/** One scripted event in a scene timeline. `atSec` is relative to t=0, after the pre-roll. */
export interface SceneStep {
  readonly atSec: number;
  readonly id: SoundId;
  readonly opt?: PlayOptions;
}

export interface SceneDef {
  readonly name: SceneName;
  readonly seconds: number;
  readonly listener: ListenerState;
  readonly music: MusicIntensity;
  readonly ambience: AmbienceScene;
  /**
   * Seconds of silent warm-up pumped through `music.tick`/`ambience.tick` BEFORE t=0, so
   * the beds are at full level when the first step fires. Without it the music bus is
   * still digital silence at the instant the ducking and cut-through tests measure it,
   * and both tests pass against nothing. Must exceed 2 bars + `MUSIC.layerFadeS`.
   */
  readonly preRollS: number;
  readonly steps: readonly SceneStep[];
}

// ---------------------------------------------------------------------------
// 10. Factory signatures — frozen. Implementers match these exactly.
// ---------------------------------------------------------------------------

/**
 * ./engine.ts — the engine BUILDS the `CueGraph` (noise buffer, both IRs, busses, sends)
 * and OWNS the `SpatialHandle` (it imports `./spatial.js` itself). `index.ts` must not
 * build a second one of either.
 */
export type CreateEngine = (
  ctx: BaseAudioContext,
  dest: AudioNode,
  registry: Readonly<Record<SoundId, CueSpec>>,
  settings: AudioSettings,
) => EngineHandle;

/** ./spatial.ts */
export type CreateSpatial = () => SpatialHandle;

/** ./derive.ts */
export type CreateDeriver = () => DeriverHandle;

/** ./ambience.ts — synthesises its own beds through the graph; needs no registry. */
export type CreateAmbience = (g: CueGraph) => AmbienceHandle;

/** ./music.ts — synthesises its own layers through the graph; needs no registry. */
export type CreateMusic = (g: CueGraph) => MusicHandle;

/** ./index.ts — the drop-in replacement for the old `ui/audio.ts` factory. */
export type CreateAudio = () => RiftAudioHandle;

// ---------------------------------------------------------------------------
// 11. Re-exports so cue modules need only one import
// ---------------------------------------------------------------------------

export type { EntKind, EntSnap, HeroId, ItemId, RiftEvent, TeamId, YouSnap, SnapMsg };
