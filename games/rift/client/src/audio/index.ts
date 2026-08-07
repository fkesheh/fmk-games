/**
 * RIFT AUDIO — index.ts (T10)
 *
 * The assembly point. Wires the engine, the deriver, ambience, music and the four cue
 * modules into `createAudio: CreateAudio`, the drop-in replacement for the old
 * `ui/audio.ts` factory. See AUDIO_CONTRACT.md's T10 spec for the frozen behavioural
 * rules this file implements, in particular the `AudioEvent` -> `SoundId` routing table
 * and the structure-allegiance binding note reproduced at `routeStructure` below.
 *
 * Every public `RiftAudioHandle` method is individually try/catch'd and degrades to a
 * silent no-op — audio must never crash the client and must never log (AUDIO_CONTRACT.md
 * rule 8). The `AudioContext` itself is constructed lazily, on first use, never inside
 * `createAudio()` (autoplay policy).
 */

import type {
  AmbienceHandle,
  AudioEvent,
  AudioPhase,
  AudioSettings,
  AudioWorldCtx,
  CueSpec,
  DeriverHandle,
  EngineHandle,
  EntSnap,
  HeroId,
  ItemId,
  ListenerState,
  MusicHandle,
  MusicIntensity,
  PlayOptions,
  Priority,
  RiftAudioHandle,
  RiftEvent,
  SnapMsg,
  SoundId,
  UiCue,
  CreateAudio,
} from './contract.js';
import {
  AMBIENCE,
  DEFAULT_SETTINGS,
  DERIVE,
  EVENT_PRIORITY,
  MAX_PLAYS_PER_SNAPSHOT,
  STORAGE_KEY,
  TENSION,
} from './config.js';
import { createAmbience } from './ambience.js';
import { ABILITY_CUES } from './cues/abilities.js';
import { COMBAT_CUES } from './cues/combat.js';
import { OBJECTIVE_CUES } from './cues/objectives.js';
import { UI_CUES } from './cues/ui.js';
import { createDeriver } from './derive.js';
import { createEngine } from './engine.js';
import { createMusic } from './music.js';

// ---------------------------------------------------------------------------
// The total registry. This IS the exhaustiveness check: `Record<SoundId, CueSpec>` (no
// `Partial`) means any unregistered `SoundId` is a compile error, not a silent gap.
// ---------------------------------------------------------------------------

const REGISTRY: Readonly<Record<SoundId, CueSpec>> = {
  ...ABILITY_CUES,
  ...COMBAT_CUES,
  ...OBJECTIVE_CUES,
  ...UI_CUES,
};

// ---------------------------------------------------------------------------
// Static lookup tables for the routing switch below.
// ---------------------------------------------------------------------------

/** Every hero's 4 cast cue ids, slot-indexed. Record-typed so a missing hero is a
 *  compile error, same trick as `REGISTRY` above. */
const HERO_CAST_IDS: Readonly<Record<HeroId, readonly [SoundId, SoundId, SoundId, SoundId]>> = {
  bullwark: ['cast.bullwark.0', 'cast.bullwark.1', 'cast.bullwark.2', 'cast.bullwark.3'],
  longbow: ['cast.longbow.0', 'cast.longbow.1', 'cast.longbow.2', 'cast.longbow.3'],
  reaver: ['cast.reaver.0', 'cast.reaver.1', 'cast.reaver.2', 'cast.reaver.3'],
  hex: ['cast.hex.0', 'cast.hex.1', 'cast.hex.2', 'cast.hex.3'],
  mender: ['cast.mender.0', 'cast.mender.1', 'cast.mender.2', 'cast.mender.3'],
  shade: ['cast.shade.0', 'cast.shade.1', 'cast.shade.2', 'cast.shade.3'],
};

function itemCastId(item: ItemId | null): SoundId {
  if (item === 'blinkstone') return 'cast.item.blink';
  if (item === 'warhorn') return 'cast.item.horn';
  if (item === 'wardstone') return 'cast.item.ward';
  return 'cast.item.generic';
}

const UI_CUE_IDS: Readonly<Record<UiCue, SoundId>> = {
  click: 'ui.click',
  buy: 'ui.buy',
  error: 'ui.error',
  levelup: 'ui.levelUp',
  shopOpen: 'ui.shopOpen',
  shopClose: 'ui.shopClose',
  pick: 'ui.pick',
  toast: 'ui.toast',
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// Settings persistence. Every field validated; anything malformed falls back to
// `DEFAULT_SETTINGS` (AUDIO_CONTRACT.md T10: "validate every field ... fall back on
// anything malformed").
// ---------------------------------------------------------------------------

function readNumber01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : fallback;
}

function readBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function loadSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SETTINGS;
    const p = parsed as Record<string, unknown>;
    return {
      master: readNumber01(p.master, DEFAULT_SETTINGS.master),
      sfx: readNumber01(p.sfx, DEFAULT_SETTINGS.sfx),
      music: readNumber01(p.music, DEFAULT_SETTINGS.music),
      ambience: readNumber01(p.ambience, DEFAULT_SETTINGS.ambience),
      muted: readBool(p.muted, DEFAULT_SETTINGS.muted),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(s: AudioSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Private-mode / quota failures degrade to "not persisted", never a crash.
  }
}

// ---------------------------------------------------------------------------
// createAudio
// ---------------------------------------------------------------------------

export const createAudio: CreateAudio = (): RiftAudioHandle => {
  let settings: AudioSettings = loadSettings();

  let audioCtx: AudioContext | null = null;
  let engine: EngineHandle | null = null;
  let ambienceHandle: AmbienceHandle | null = null;
  let musicHandle: MusicHandle | null = null;
  let initFailed = false;
  let disposed = false;

  const deriver: DeriverHandle = createDeriver();

  let world: AudioWorldCtx | null = null;
  let latestSnap: SnapMsg | null = null;
  let phase: AudioPhase = 'menu';

  // Per-snapshot engine.play() budget (MAX_PLAYS_PER_SNAPSHOT), `Infinity` outside the
  // snapshot() routing pass so wire()-derived events (rare, discrete) are never capped.
  let playBudget = Infinity;

  // Music tension hysteresis (TENSION.holdS): only meaningful while phase === 'live'.
  let currentTension: MusicIntensity = 0;
  let tensionRaisedAt = -Infinity;

  // Death-cam submerge edge-tracking, re-derived every snapshot from `you.respawnAtTick`.
  let wasDead = false;

  // The `hit.heartbeat` re-trigger timer. -1 = not currently low-HP.
  let heartbeatBand = -1;
  let nextHeartbeatAt = Infinity;

  // -------------------------------------------------------------------------
  // Lazy AudioContext / graph construction. Never called from createAudio() itself.
  // -------------------------------------------------------------------------

  function ensureEngine(): boolean {
    if (disposed || initFailed) return false;
    if (engine !== null) return true;
    try {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        initFailed = true;
        return false;
      }
      const ctx = new Ctor();
      const e = createEngine(ctx, ctx.destination, REGISTRY, settings);
      const amb = createAmbience(e.graph);
      const mus = createMusic(e.graph);
      audioCtx = ctx;
      engine = e;
      ambienceHandle = amb;
      musicHandle = mus;
      return true;
    } catch {
      initFailed = true;
      return false;
    }
  }

  function playSound(id: SoundId, opt: PlayOptions): void {
    if (engine === null || playBudget <= 0) return;
    playBudget -= 1;
    engine.play(id, opt);
  }

  function resetTension(): void {
    currentTension = 0;
    tensionRaisedAt = -Infinity;
  }

  // -------------------------------------------------------------------------
  // Continuous state driven from `snapshot()`.
  // -------------------------------------------------------------------------

  function computeTension(snap: SnapMsg): MusicIntensity {
    for (const e of snap.ents) {
      if (e.k === 'ancient' && e.maxHp > 0 && e.hp / e.maxHp < TENSION.ancientRiskHpFrac) return 4;
    }
    const you = snap.you;
    if (you === null) return 1;
    let nearby = 0;
    for (const e of snap.ents) {
      if (e.k !== 'hero') continue;
      if (Math.hypot(e.x - you.x, e.z - you.z) <= TENSION.nearbyRadius) nearby += 1;
    }
    if (nearby >= TENSION.teamfightHeroes) return 3;
    if (nearby >= TENSION.skirmishHeroes) return 2;
    return 1;
  }

  function updateMusicIntensity(snap: SnapMsg): void {
    if (engine === null || musicHandle === null || phase !== 'live') return;
    const now = engine.graph.ctx.currentTime;
    const target = computeTension(snap);
    if (target > currentTension) {
      currentTension = target;
      tensionRaisedAt = now;
      musicHandle.setIntensity(target);
    } else if (target < currentTension && now - tensionRaisedAt >= TENSION.holdS) {
      currentTension = target;
      musicHandle.setIntensity(target);
    }
  }

  function updateAmbienceScene(snap: SnapMsg): void {
    if (ambienceHandle === null || phase !== 'live' || world === null) return;
    const you = snap.you;
    if (you === null) return;
    let ancient: EntSnap | null = null;
    for (const e of snap.ents) {
      if (e.k === 'ancient' && e.team === world.selfTeam) {
        ancient = e;
        break;
      }
    }
    if (ancient === null) return;
    const d = Math.hypot(you.x - ancient.x, you.z - ancient.z);
    ambienceHandle.setScene(d <= AMBIENCE.fountainRadius ? 'fountain' : 'field');
  }

  function updateDeathState(snap: SnapMsg): void {
    if (engine === null) return;
    const you = snap.you;
    const dead = you !== null && you.respawnAtTick > 0 && snap.matchTick < you.respawnAtTick;
    if (dead !== wasDead) {
      wasDead = dead;
      engine.setSubmerge(dead ? DERIVE.submergeHz : Infinity);
    }
  }

  function tickHeartbeat(nowSec: number): void {
    if (heartbeatBand === -1) return;
    if (nowSec >= nextHeartbeatAt) {
      playSound('hit.heartbeat', { intensity: heartbeatBand });
      const period = DERIVE.lowHpPulseS[heartbeatBand] ?? 1.1;
      nextHeartbeatAt = nowSec + period;
    }
  }

  // -------------------------------------------------------------------------
  // The AudioEvent -> SoundId routing table (AUDIO_CONTRACT.md §T10).
  // -------------------------------------------------------------------------

  /** `hurtFrac` is the local player's HP-loss fraction from a same-batch `hurt` event, or
   *  null when there isn't one. `hurt` has no cue of its own — it only informs the
   *  intensity of the `hit.self` cue produced by a same-batch `hit` event. */
  function routeEvent(ev: AudioEvent, hurtFrac: number | null): void {
    switch (ev.t) {
      case 'cast': {
        // Only a SELF ULTIMATE reaches priority 2 (== DUCK.bedPriority, config.ts), which
        // ducks music + ambience by DUCK.bedDb. Every other cast — self non-ultimate,
        // any enemy/ally cast — stays at the registered priority 4 and never touches the
        // bed. Ducking every self cast (not just ultimates) would pump the bed on every
        // Q/W/E during laning; only the rare, high-impact self ultimate should move it.
        const priority: Priority = ev.self && ev.ult ? 2 : 4;
        const opts: PlayOptions = { x: ev.x, z: ev.z, self: ev.self, visible: ev.visible, priority };
        if (ev.slot >= 4) {
          playSound(itemCastId(ev.item), opts);
        } else if (ev.hero !== null) {
          const id = HERO_CAST_IDS[ev.hero][ev.slot];
          if (id !== undefined) playSound(id, opts);
        }
        // else: caster unresolved and not an item slot — the deriver's documented
        // degrade-to-generic race has no dedicated cue; drop rather than fabricate one.
        break;
      }

      case 'attack': {
        const base: PlayOptions = { x: ev.x, z: ev.z, visible: ev.visible };
        switch (ev.kind) {
          case 'hero':
            playSound(ev.ranged ? 'atk.hero.ranged' : 'atk.hero.melee', { ...base, self: ev.self });
            break;
          case 'melee':
          case 'shade':
            playSound('atk.creep.melee', base);
            break;
          case 'ranged':
            playSound('atk.creep.ranged', base);
            break;
          case 'siege':
            playSound('atk.siege', base);
            break;
          case 'tower':
            playSound('atk.tower', base);
            break;
        }
        break;
      }

      case 'hit': {
        const opts: PlayOptions = { x: ev.x, z: ev.z, self: ev.self, visible: ev.visible };
        const id: SoundId = ev.crit ? 'hit.crit' : ev.school === 'magic' ? 'hit.magic' : 'hit.physical';
        playSound(id, opts);
        if (ev.self) {
          playSound('hit.self', hurtFrac === null ? opts : { ...opts, intensity: hurtFrac });
        }
        break;
      }

      case 'hurt':
        // No cue of its own — folded into the same-batch `hit.self` above.
        break;

      case 'heroDeath': {
        const opts: PlayOptions = { x: ev.x, z: ev.z, visible: ev.visible, self: ev.self };
        const id: SoundId = ev.self ? 'die.hero.self' : ev.friendly ? 'die.hero.ally' : 'die.hero';
        playSound(id, opts);
        if (ev.firstBlood) playSound('ann.firstBlood', {});
        break;
      }

      case 'unitDeath':
        playSound(ev.kind === 'ward' ? 'die.ward' : 'die.creep', {
          x: ev.x,
          z: ev.z,
          visible: ev.visible,
        });
        break;

      case 'gold':
        playSound(ev.lastHit ? 'ui.lastHit' : 'ui.gold', {});
        break;

      case 'structure':
        // BINDING: CuePlay has no `friendly` field. T6 encodes ally/enemy structure
        // colour through `intensity`: >= 0.5 means YOUR OWN structure fell (tense), < 0.5
        // means an ENEMY structure fell (good news). The default is 0 — omitting this
        // would render every structure fall, including your own ancient, as good news.
        playSound(
          ev.kind === 'tower' ? 'obj.tower' : ev.kind === 'guard' ? 'obj.guard' : 'obj.ancient',
          { x: ev.x, z: ev.z, priority: 1, intensity: ev.friendly ? 1 : 0 },
        );
        break;

      case 'levelUp':
        playSound('ui.levelUp', {});
        break;

      case 'skillPointAvailable':
        playSound('ui.skillPoint', {});
        break;

      case 'abilityReady':
        playSound('ui.abilityReady', {});
        break;

      case 'respawn':
        playSound('obj.respawn', {});
        break;

      case 'lowHp':
        if (ev.band === -1) {
          heartbeatBand = -1;
          nextHeartbeatAt = Infinity;
        } else if (heartbeatBand !== ev.band) {
          heartbeatBand = ev.band;
          if (engine !== null) {
            const now = engine.graph.ctx.currentTime;
            playSound('hit.heartbeat', { intensity: ev.band });
            const period = DERIVE.lowHpPulseS[ev.band] ?? 1.1;
            nextHeartbeatAt = now + period;
          }
        }
        break;

      case 'surge':
        playSound('obj.surge', {});
        break;

      case 'heroPick':
        playSound('ui.pick', {});
        break;

      case 'matchEnd': {
        // Ambience and music stop dead FIRST, then the sting fires into the silence —
        // the ordering is load-bearing (SONIC_BIBLE §10, AUDIO_CONTRACT.md T10).
        ambienceHandle?.stop();
        musicHandle?.stop();
        const id: SoundId = ev.draw ? 'ann.draw' : ev.won ? 'ann.victory' : 'ann.defeat';
        playSound(id, { delay: 0.35 });
        break;
      }

      case 'ancientThreat':
        playSound('obj.klaxon', {});
        break;

      default: {
        const _exhaustive: never = ev;
        return _exhaustive;
      }
    }
  }

  /** Cap `engine.play` calls at `MAX_PLAYS_PER_SNAPSHOT`, dropping by `EVENT_PRIORITY`
   *  worst-first — process the most important events first so the budget, once spent,
   *  only ever drops the least important ones. */
  function routeSnapshotEvents(events: readonly AudioEvent[]): void {
    let hurtFrac: number | null = null;
    for (const ev of events) {
      if (ev.t === 'hurt') {
        hurtFrac = clamp01(ev.frac);
        break;
      }
    }
    const ordered = events.slice().sort((a, b) => EVENT_PRIORITY[a.t] - EVENT_PRIORITY[b.t]);
    playBudget = MAX_PLAYS_PER_SNAPSHOT;
    for (const ev of ordered) routeEvent(ev, hurtFrac);
    playBudget = Infinity;
  }

  // -------------------------------------------------------------------------
  // The public handle.
  // -------------------------------------------------------------------------

  const handle: RiftAudioHandle = {
    event(ev: RiftEvent): void {
      try {
        ensureEngine();
        if (world === null) return;
        const events = deriver.wire(ev, latestSnap, world);
        for (const e of events) routeEvent(e, null);
      } catch {
        // never throw
      }
    },

    ui(kind: UiCue): void {
      try {
        ensureEngine();
        playSound(UI_CUE_IDS[kind], {});
      } catch {
        // never throw
      }
    },

    setPhase(p: AudioPhase): void {
      try {
        ensureEngine();
        const from = phase;
        phase = p;
        const changed = from !== p;
        switch (p) {
          case 'menu':
          case 'lobby':
            ambienceHandle?.setScene('menu');
            musicHandle?.setIntensity(1);
            if (changed) {
              engine?.setSubmerge(Infinity);
              resetTension();
              wasDead = false;
              deriver.reset();
            }
            break;

          case 'live':
            ambienceHandle?.setScene('field');
            musicHandle?.setIntensity(1);
            musicHandle?.start();
            if (changed) {
              engine?.setSubmerge(Infinity);
              resetTension();
              wasDead = false;
              if (from === 'menu' || from === 'lobby') playSound('obj.matchStart', {});
            }
            break;

          case 'dead':
            ambienceHandle?.setScene('dead');
            musicHandle?.setIntensity(0);
            engine?.setSubmerge(DERIVE.submergeHz);
            if (changed) {
              resetTension();
              wasDead = true;
            }
            break;

          case 'ended':
            // Stop dead first; the `matchEnd` routing fires the sting into the silence.
            ambienceHandle?.stop();
            musicHandle?.stop();
            break;
        }
      } catch {
        // never throw
      }
    },

    setWorld(ctx: AudioWorldCtx): void {
      try {
        world = ctx;
      } catch {
        // never throw
      }
    },

    snapshot(snap: SnapMsg): void {
      try {
        ensureEngine();
        latestSnap = snap;
        if (world === null) return;
        const events = deriver.snapshot(snap, world);
        routeSnapshotEvents(events);
        updateAmbienceScene(snap);
        updateMusicIntensity(snap);
        updateDeathState(snap);
      } catch {
        // never throw
      }
    },

    tick(dtMs: number, listener: ListenerState): void {
      try {
        if (engine === null) return;
        engine.setListener(listener);
        engine.tick(dtMs);
        const now = engine.graph.ctx.currentTime;
        musicHandle?.tick(now);
        ambienceHandle?.tick(now);
        tickHeartbeat(now);
      } catch {
        // never throw
      }
    },

    countdown(_secondsLeft: number): void {
      try {
        ensureEngine();
        playSound('obj.countdown', {});
      } catch {
        // never throw
      }
    },

    resume(): void {
      try {
        if (ensureEngine()) engine?.resume();
      } catch {
        // never throw
      }
    },

    settings(): AudioSettings {
      return settings;
    },

    setSettings(patch: Partial<AudioSettings>): void {
      try {
        const merged: AudioSettings = {
          master: readNumber01(patch.master, settings.master),
          sfx: readNumber01(patch.sfx, settings.sfx),
          music: readNumber01(patch.music, settings.music),
          ambience: readNumber01(patch.ambience, settings.ambience),
          muted: readBool(patch.muted, settings.muted),
        };
        settings = merged;
        engine?.setSettings(merged);
        persistSettings(merged);
      } catch {
        // never throw
      }
    },

    dispose(): void {
      try {
        disposed = true;
        ambienceHandle?.stop();
        musicHandle?.stop();
        engine?.dispose();
        const ctx = audioCtx;
        engine = null;
        ambienceHandle = null;
        musicHandle = null;
        audioCtx = null;
        if (ctx !== null) {
          try {
            void ctx.close().catch(() => {
              // never throw
            });
          } catch {
            // never throw
          }
        }
      } catch {
        // never throw
      }
    },
  };

  return handle;
};
