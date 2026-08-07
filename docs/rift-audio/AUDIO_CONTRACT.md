# RIFT AUDIO — CONTRACT (frozen)

*Embedded verbatim in every implementer brief. Read all of it before writing a line.*

---

## RULES — these bind every implementer, no exceptions

1. **`games/rift/client/src/audio/contract.ts` and `games/rift/client/src/audio/config.ts` are
   IMMUTABLE.** Do not edit, extend, or re-declare anything in them. If something you need is
   missing, STOP and report it — do not work around it, do not add a local type that duplicates a
   contract type, do not cast.
2. **You create and edit ONLY the files listed in your brief's `Owns` line.** Not one line in any
   other file. If your code needs a change elsewhere, report it; the integrator will make it.
3. **No stubs, no TODOs, no placeholder comments, no `throw new Error('not implemented')`.** Every
   function you own ships finished.
4. **No `any`, no `@ts-ignore`, no non-null `!`** unless provably safe with a comment saying why.
   The project runs `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. Indexing
   an array or record yields `T | undefined` — handle it, don't assert it away.
5. **No `Math.random`, anywhere.** Use `CueGraph.rnd()` (seeded). This is a repo-wide law and it is
   also what makes the render harness reproducible.
6. **No audio asset files, no `fetch`, no base64 buffers, no external libraries.** Pure synthesis
   from oscillators, the shared noise buffer, and generated impulse responses.
7. **Never touch a global `AudioContext`.** Everything comes through `CueGraph.ctx`, which is an
   `OfflineAudioContext` when the render harness is driving. Reaching for `new AudioContext()`,
   `ctx.destination`, or `performance.now()` inside a cue makes it unrenderable and therefore
   unjudgeable. Use the `at` parameter for all scheduling, never "now".
8. **Audio must never crash the client.** Every public entry point wraps its body in try/catch and
   degrades to silence. A thrown WebAudio error must not white-screen the game.
9. **Every frequency traces to `PALETTE` in `config.ts`.** A bare frequency literal in cue code is a
   contract violation and a reviewer will flag it, exactly as an ad-hoc hex colour would be in a
   visual build. Derive with the documented ratios (`MINOR_STEPS`, `INTERVAL`, `METAL_RATIOS`) when
   you need a pitch that is not literally in the table.
10. **Only `info`-register cues may put meaningful energy above `INFO_FLOOR_HZ` (800 Hz).** That
    register is reserved for information: last-hit, level-up, skill point, cooldown ready, purchase,
    error, announcer. Nothing else competes there. This is the single most important mix law.
11. **Every repeatable cue varies** per `VARY` in config: pitch, level, timing, and one timbral
    parameter. Cues with `variants > 1` must produce genuinely different waveforms per variant, not
    the same one transposed.
12. **Clean up after yourself.** Every node you create must be disconnected or stopped when its
    envelope ends (`osc.stop(endTime)`, `src.onended`). A leaked node per attack is a memory leak in
    a 40-minute match. No per-frame allocation in `tick()` paths.
13. **Import style:** named exports only, `.js` extensions on relative imports (the project uses
    `moduleResolution: Bundler` with ESM specifiers, and every existing file does this).
14. **Read the SONIC BIBLE** (`docs/rift-audio/SONIC_BIBLE.md`) before writing a cue. It is not
    background reading — it is the spec for what things must sound like.

---

## The frozen `dsp.ts` API — signatures every cue module codes against

`audio/dsp.ts` is implemented by task T0 **concurrently with you**. You do not wait for it and you
do not implement any of it yourself — you import these and call them. The signatures below are
frozen; T0 fills the bodies.

```ts
import type {
  CueGraph, Env, MetalSpec, NoiseSpec, ShimmerSpec, SwellSpec, ThumpSpec, ToneSpec,
} from './contract.js';

/** Oscillator voice with ADSR + optional glide. Returns the node to connect onward. */
export function tone(g: CueGraph, at: number, dest: AudioNode, spec: ToneSpec, gain: number): void;

/** Filtered burst from the shared seeded noise buffer, with optional filter sweep. */
export function noise(g: CueGraph, at: number, dest: AudioNode, spec: NoiseSpec, gain: number): void;

/** Sine sub with a fast downward pitch envelope. The weight archetype — use it under anything that lands. */
export function thump(g: CueGraph, at: number, dest: AudioNode, spec: ThumpSpec, gain: number): void;

/** Inharmonic partial stack through a bandpass. Steel, armour, structures. */
export function metal(g: CueGraph, at: number, dest: AudioNode, spec: MetalSpec, gain: number): void;

/** Ring-mod / FM pair with a long filtered tail. Arcane magic only, `high` register only. */
export function shimmer(g: CueGraph, at: number, dest: AudioNode, spec: ShimmerSpec, gain: number): void;

/** Slow-attack detuned cluster. Ultimates, objectives, music pads. */
export function swell(g: CueGraph, at: number, dest: AudioNode, spec: SwellSpec, gain: number): void;

/** Apply an ADSR to a GainNode's gain param starting at `at`. Returns the envelope end time. */
export function applyEnv(param: AudioParam, at: number, env: Env, scale: number): number;

/** dB -> linear gain. */
export function db(v: number): number;

/** Seeded symmetric jitter: returns `base * (1 +/- pct)`. */
export function jitter(g: CueGraph, base: number, pct: number): number;

/** Seeded jitter in dB, returns a LINEAR gain multiplier for +/- `dbRange`. */
export function jitterDb(g: CueGraph, dbRange: number): number;

/** Pick a scale degree: root * MINOR_STEPS[degree % 7] * 2^octave. */
export function degree(root: number, deg: number, octave: number): number;

/** Build the shared 1s seeded white-noise buffer. Called once by the engine. */
export function makeNoiseBuffer(ctx: BaseAudioContext, seed: number): AudioBuffer;

/** Generate a decaying, damped impulse response. Called once per IR by the engine. */
export function makeImpulse(
  ctx: BaseAudioContext, seed: number,
  spec: { seconds: number; decay: number; dampHz: number; preDelayS: number },
): AudioBuffer;

/** Soft-clip curve for the limiter WaveShaper, ceiling in dB. */
export function makeLimiterCurve(ceilingDb: number): Float32Array;
```

**`Env`, `ToneSpec`, `NoiseSpec`, `ThumpSpec`, `MetalSpec`, `ShimmerSpec`, `SwellSpec`** are all
declared in `contract.ts` — read them there, they are the parameter surface you author against.

---

## Module specs

Every module below owns a disjoint file set. `SoundId`, `CueSpec`, `CueRegistry`, `CueFn`,
`CueGraph`, `CuePlay` are from `./contract.js`.

### T0 — `audio/dsp.ts`

Implement every signature above. This is the shared vocabulary; six other agents call it, so
correctness and cleanliness matter more than cleverness.

Requirements:
- `tone`/`noise`/`thump`/`metal`/`shimmer`/`swell` each build their nodes, connect to `dest`,
  schedule the envelope from `at`, and **stop and disconnect** at envelope end. No leaks.
- `applyEnv` uses `setValueAtTime` + `linearRampToValueAtTime` for attack and
  `exponentialRampToValueAtTime` toward a small epsilon (never to 0 — that throws) for decay/release.
- `makeNoiseBuffer` produces a mono 1-second buffer from `rng(seed)`.
- `makeImpulse` produces a **stereo** buffer: decorrelated L/R noise, exponential decay of
  `decay` slope over `seconds`, a one-pole lowpass at `dampHz` applied over the tail, and
  `preDelayS` of leading silence.
- `makeLimiterCurve` returns a 2049-point odd-symmetric soft-clip (tanh-shaped) curve whose output
  asymptotes at `db(ceilingDb)`.
- `degree` must handle negative and >6 degrees by wrapping and adjusting the octave.
- Every function is pure with respect to module state — no module-level mutable variables.

Gate: `npx tsc --noEmit -p games/rift/client/tsconfig.json` clean.

### T1 — `audio/engine.ts`

Export `createEngine: CreateEngine` (signature frozen in `contract.ts`), returning `EngineHandle`.

Build the graph exactly as SONIC_BIBLE §8 specifies:
```
music ─┐
amb   ─┤
sfx   ─┼─→ preMaster (DynamicsCompressor, GLUE) ─→ master (Gain) ─→ limiter (WaveShaper) ─→ dest
ui    ─┤
announcer ─┘
sendValley ─→ ConvolverNode(irValley) ─→ sfx
sendHall   ─→ ConvolverNode(irHall)   ─→ announcer
```
Plus one **global lowpass** between `master` and `limiter` for `setSubmerge` (death cam), default
open (`Infinity` → set frequency to Nyquist).

Requirements:
- `createEngine` receives `ctx` and `dest` — it must work identically under `OfflineAudioContext`.
  Never call `ctx.resume()` on an offline context (guard on `'resume' in ctx && ctx instanceof ...`
  is fragile; instead check `typeof (ctx as { resume?: unknown }).resume === 'function'` and that
  `ctx.state === 'suspended'`).
- Bus gains: `BUS_DB[bus]` combined with the matching user setting (`sfx`→sfx, `music`→music,
  `amb`→ambience, `ui`/`announcer`→sfx setting) and `master`. Muted ⇒ master gain 0. Apply changes
  with a 20 ms ramp, never a discontinuity (which clicks).
- `play(id, opt)`:
  1. Look up `CueSpec` in the merged registry; unknown id ⇒ return false (never throw).
  2. If `opt.x`/`opt.z` are present and the cue is not `dry`, call the spatial handle; if
     `audible === false`, return false without scheduling.
  3. Build the per-voice chain: `StereoPannerNode` (skip when `dry`) → `BiquadFilterNode` lowpass
     (skip when `cutoffHz === Infinity`) → `GainNode` (distance gain × `db(opt.gainDb ?? 0)` ×
     `jitterDb`) → the cue's bus. Additionally tap the gain node into `sendValley` scaled by
     `SpatialResult.send`.
  4. Enforce `POLYPHONY_CAP`: if at cap, steal the **oldest voice of the lowest priority present**,
     and never steal a voice whose priority is numerically ≤ `NEVER_STEAL_AT_OR_ABOVE`. If no
     stealable voice exists, drop the new cue (return false) unless the new cue's priority is ≤ 2,
     in which case play it anyway.
  5. Trigger ducking per `DUCK`: when `spec.priority <= DUCK.bedPriority`, ramp `music` and `amb`
     bus gains down by `DUCK.bedDb` over `DUCK.attackS` and back up starting at
     `at + spec.tail + DUCK.releasePadS`. When `spec.priority <= DUCK.sfxPriority`, additionally
     duck `sfx` by `DUCK.sfxDb`. **Overlapping ducks must not stack** — track a duck depth and only
     apply the deepest active one, restoring when it expires.
  6. Round-robin: maintain a per-`SoundId` counter and pass `variant = counter % spec.variants`.
  7. Call `spec.fn(graph, at, play)` inside try/catch.
- `tick(dtMs)` advances the voice bookkeeping and retires finished voices. **No allocation in
  `tick`** — reuse arrays, iterate backwards and splice, or use a fixed pool.
- `dispose()` disconnects everything and closes the context if it owns one (it does not — `index.ts`
  owns the context; `dispose` only tears down nodes).

Gate: typecheck clean; the engine must construct successfully against an `OfflineAudioContext` (the
lab entry proves this).

### T2 — `audio/spatial.ts`

Export `createSpatial: CreateSpatial` → `SpatialHandle`. Implement exactly SONIC_BIBLE §6 with the
`SPATIAL` constants:
- effective distance `d = hypot(sx - lx, sz - lz) * (1 + (listener.height - camRefHeight) * heightScale)`
- `audible = d <= audibleRadius` (self is always audible)
- `gain = max(gainFloor, 1 / (1 + (d / refDistance)^2))`; self ⇒ `gain = 1`
- `pan = clamp((sx - lx) / panHalfWidth, -1, 1) * panMax`; self ⇒ `pan *= selfPanScale`
- `send = min(sendMax, d / audibleRadius * sendScale)`; self ⇒ `send = 0`
- `!visible` ⇒ `gain *= db(fogAttenDb)` and `cutoffHz = fogCutoffHz`; otherwise `cutoffHz = Infinity`
- self additionally ⇒ `gain *= db(selfBiasDb)`

Pure and allocation-free: `resolve` must not allocate beyond the returned object. Deterministic —
no RNG here.

Gate: typecheck clean.

### T3 — `audio/derive.ts`

Export `createDeriver: CreateDeriver` → `DeriverHandle`. **This module must not import any WebAudio
type and must not touch the DOM.** It is pure, and T13 unit-tests it in node.

`snapshot(snap, ctx)` diffs against the previously-seen snapshot and emits, in this order:

| Emission | Derivation |
|---|---|
| `attack` | For each `EntSnap` with `atk !== undefined` whose `atk` differs from its previous snapshot value (and `k !== 'proj'`). `kind` from `e.k` (`tower`/`guard`/`ancient` → `'tower'`); `ranged` true for `'ranged'`, `'siege'`, `'tower'`, and heroes whose `heroById(hero).base.attackRange > 3`. `self` when `e.id === ctx.selfEntId`. Mirror the existing precedent in `game.ts:544-580` (`combatFx`). |
| `unitDeath` | Entities present in the previous snapshot, absent now, with `pid === undefined`, `k` not in `tower/guard/ancient/proj`, and `ctx.isVisible(p.x, p.z)` true. Same rule the visual layer already uses. |
| `hurt` | `you.hp < prev.hp - DERIVE.hurtMinHp`. `frac = drop / max(1, you.maxHp)`, `hpFrac = you.hp / you.maxHp`. |
| `lowHp` | On crossing DOWN into a band in `DERIVE.lowHpBands`. Emit once per crossing; re-arm when HP rises back above the band. |
| `gold` | `you.gold > prev.gold`. `lastHit = delta >= DERIVE.lastHitMinGold` **and** a `unitDeath` was emitted this same snapshot. Otherwise `lastHit = false` (passive income must not chime). |
| `levelUp` | `you.level > prev.level` and `you.level > 1`. |
| `skillPointAvailable` | `you.skillPoints > prev.skillPoints`. |
| `abilityReady` | For each slot, previous `cdUntilTick > snap.tick` and now `cdUntilTick <= snap.tick`, and `rank > 0`. |
| `respawn` | Previous `respawnAtTick > 0` and now `0`, and previous snapshot had `you.hp <= 0` or a pending respawn. |
| `ancientThreat` | Own team's `ancient` entity crossing below `DERIVE.ancientThreatFrac` of `maxHp`. Once per crossing. |

`wire(ev, snap, ctx)` maps the 7 wire events:
- `rift_cast` → `cast`. Resolve the caster from `snap.ents` by `id`; if it is a hero, read
  `heroById(e.hero)` and take `abilities[slot]` to compute `colour` (precedence in `contract.ts`
  `CastColour` docs) and `ult`. When `slot >= 4` it is an item active: `item` is
  `snap.you?.items[slot - 4] ?? null` **only when the caster is the local player** (you cannot see
  other players' inventories), else `null` and colour `'buff'`. `self` when
  `e.pid === ctx.selfPid`. `visible = ctx.isVisible(ev.x, ev.z)`.
- `rift_kill` → `heroDeath`. Position from the victim's entity in `snap` (by `pid`); when the victim
  is not in the snapshot, use the local player's position if it is their own death, else skip
  positioning by emitting at the listener (x/z of `snap.you` when available, otherwise `0,0` with
  `visible: false`). `self = victim === ctx.selfPid`, `byMe = killer === ctx.selfPid`.
- `rift_structure` → `structure`. Position by scanning `snap.ents` for a matching
  `k === ev.kind && team === ev.team && hp <= 0` (same lookup `game.ts:600-609` already does);
  fall back to `0,0` when not found. `friendly = ev.team === ctx.selfTeam`.
- `rift_surge` → `surge`. `rift_pick` → `heroPick`. `rift_end` → `matchEnd`
  (`won = ev.winner === ctx.selfTeam`, `draw = ev.reason === 'draw' || ev.winner === null`).
  `rift_roster` → emits nothing.

`reset()` clears every diff baseline. Cap output at `DERIVE.maxPerSnap`, dropping the
numerically-highest-priority-number (least important) events first — use the same priority ordering
as SONIC_BIBLE §8.

**Edge cases you must handle:** first snapshot ever (no baseline ⇒ emit nothing but record state);
`snap.you === null`; entity ids reused across matches (`reset` on phase change is the integrator's
job, but `reset` must be total); a snapshot arriving out of order (`snap.tick <= prevTick` ⇒ ignore
and return empty); `you.maxHp === 0`.

Gate: typecheck clean; T13's vitest suite green.

### T4 — `audio/cues/abilities.ts`

Export `const ABILITY_CUES: CueRegistry`. Implement **all 28** keys: `cast.<hero>.<0..3>` for all
six heroes, plus `cast.item.blink`, `cast.item.horn`, `cast.item.ward`, `cast.item.generic`.

This is the largest single quality lever in the build. Requirements:
- Follow `HERO_TIMBRE` in `config.ts` — it fixes each hero's character, archetype mix, and register.
  Six heroes must be immediately distinguishable from each other **blind**.
- Within a hero, the four slots must be distinguishable too. Read the real ability list (below) and
  make the cue *describe the ability*: a dash sweeps, a stun cuts off, a heal rises, an AoE spreads,
  a projectile has a launch transient.
- **Ultimates (slot 3) are 4–6 layers, 0.8–1.6 s, and always carry a `sub` element and a `swell`.**
  A player must know an ultimate went off without looking.
- Non-ults: 3–4 layers, 250–700 ms.
- Passives (bullwark W, longbow W, shade E) never fire a cast event in practice; still register a
  short, restrained cue for them (they can fire via item/edge paths) — do not leave the key missing.
- `priority`: ults `2` when self / `4` otherwise is NOT expressible per-play, so register ults at
  `2` and non-ults at `4`; the engine's self-bias handles loudness.
- `bus: 'sfx'`, `dry: false`, `variants: 2` (ults `1`), `tail` = your real tail length.

The abilities, by hero and slot (`q w e r`):
- **bullwark** — Shield Crash (point, physical, dash+stun) / Bulwark (passive armour aura) /
  Ground Slam (magic AoE, slow) / **Rally** (ult: heal + armour aura)
- **longbow** — Piercing Arrow (point, physical, piercing projectile) / Focus (passive attack-speed) /
  Frost Arrow (unit, magic, slow) / **Rain of Arrows** (ult: point AoE magic, slow)
- **reaver** — Cleave (AoE physical) / Frenzy (self attack-speed) / Lunge (unit, physical, dash) /
  **Dismember** (ult: unit, physical, stun)
- **hex** — Hexbolt (unit, magic projectile) / Cripple (point AoE magic slow) / Blink (point dash 8 m) /
  **Annihilate** (ult: point AoE magic, stun)
- **mender** — Mend (ally heal) / Smite (unit magic, slow) / Sanctuary (point heal + regen aura) /
  **Guardian** (ult: heal + armour aura)
- **shade** — Shadow Strike (unit, physical, dash) / Smoke (point AoE magic slow) / Mark (passive
  damage aura) / **Phantoms** (ult: summons shades + move-speed aura)

Item actives: `blinkstone` = 8 m dash, `warhorn` = damage aura horn, `wardstone` = ward placement.

Gate: typecheck clean; all 28 keys present (T10's exhaustiveness check enforces this).

### T5 — `audio/cues/combat.ts`

Export `const COMBAT_CUES: CueRegistry` covering: `atk.hero.melee`, `atk.hero.ranged`,
`atk.creep.melee`, `atk.creep.ranged`, `atk.siege`, `atk.tower`, `hit.physical`, `hit.magic`,
`hit.self`, `hit.crit`, `die.hero`, `die.hero.self`, `die.creep`, `die.ward`.

Requirements:
- **Attacks are the most-fired cues in the game.** 2 layers, attack time < 8 ms, total length
  < 200 ms, crest factor > 8 dB, `variants: VARY.roundRobin` (4). Four genuinely different
  waveforms, not one transposed four ways. This is explicitly measured by the judge.
- `atk.tower` is the heaviest attack: a mid-register launch with a `sub` component.
- `hit.self` is what the local player hears when *they* take damage: a filtered thud plus a body
  component, `priority: 3`, and it must read as "that was me" — distinct from `hit.physical`.
- `die.hero` = a body-fall `thump` + a team-coloured tail using `INTERVAL.enemy` (an enemy died) —
  the deriver tells you `self`, but the cue itself cannot branch on it, so register **two** cues:
  `die.hero` (enemy fell, `INTERVAL.ally` resolution — it is good news) and `die.hero.self`
  (`INTERVAL.enemy` colour, plus the low-end weight of a real loss, `priority: 2`).
- `die.creep` must be small — it fires constantly. ≤ 220 ms, `priority: 5`, 4 variants. It must sit
  *below* the last-hit chime it accompanies and never mask it (nothing above `INFO_FLOOR_HZ`).
- `hit.crit` layers a bright transient over the physical hit — but stays under `INFO_FLOOR_HZ`
  except for a brief (<25 ms) transient. The info register is not yours.

Gate: typecheck clean; all 14 keys present.

### T6 — `audio/cues/objectives.ts`

Export `const OBJECTIVE_CUES: CueRegistry` covering: `obj.tower`, `obj.guard`, `obj.ancient`,
`obj.surge`, `obj.klaxon`, `obj.respawn`, `obj.countdown`, `obj.matchStart`, `ann.firstBlood`,
`ann.victory`, `ann.defeat`, `ann.draw`.

Requirements:
- **`obj.ancient` is the biggest sound in the game.** 5–7 layers, 2.5–3.0 s, ≥ 45 % of total energy
  below 120 Hz. `obj.tower`/`obj.guard`: 5–7 layers, 1.5–2.2 s, ≥ 35 % below 120 Hz. These numbers
  are measured by the harness — build to them.
- Structure collapse anatomy: a sub drop, a `metal` stress layer, a filtered noise sweep for the
  collapse, a debris tail (repeated short noise grains over 1–2 s, seeded), and a low `swell` under
  it all.
- `ann.*` are `bus: 'announcer'`, `dry: true`, `priority: 0`, and route to `sendHall`. They are the
  only cues that may sound "composed": `ann.victory` resolves a D-minor cadence; `ann.defeat`
  collapses through a detuned fall; `ann.draw` is unresolved (tritone, no cadence).
- `obj.klaxon` uses `INTERVAL.enemy` and repeats 3 times over ~1.6 s. `priority: 1`.
- `obj.countdown` is a single `info` tick — the caller fires it once per second; the cue must **not**
  loop internally. `obj.matchStart` is the horn in D.
- `obj.respawn` re-opens the world: a rising filter sweep + a fountain-flavoured hum onset.

Gate: typecheck clean; all 12 keys present.

### T7 — `audio/cues/ui.ts`

Export `const UI_CUES: CueRegistry` covering: `ui.click`, `ui.hover`, `ui.buy`, `ui.error`,
`ui.shopOpen`, `ui.shopClose`, `ui.pick`, `ui.toast`, `ui.lastHit`, `ui.gold`, `ui.levelUp`,
`ui.skillPoint`, `ui.abilityReady`.

Requirements:
- All are `dry: true`, `bus: 'ui'` (except `ui.lastHit`/`ui.levelUp` which stay `'ui'` but at
  `priority: 3` and `2` respectively). ≤ 120 ms except `ui.levelUp` (≤ 700 ms) and `ui.buy` (≤ 250 ms).
- **`ui.lastHit` is the most important cue in this module and possibly the game.** It is the Dota
  gold chime: two ticks in the `info` register (`A5` → `D6`), a coin shimmer, total < 180 ms, and
  its 2–4 kHz band energy must sit **≥ 8 dB above** the bed in the `lastHitInFight` scene. It must be
  physically impossible to miss in a teamfight. Nothing else you write matters as much.
- `ui.error` is the dry thud — no `info` content above a brief transient; it must read as "no",
  not as an alarm.
- `ui.hover` is very quiet (−18 dB design level) and ≤ 40 ms; it fires on every pointer move across
  a grid and must never become fatiguing.
- `ui.abilityReady` is a *soft* tick, deliberately near the threshold of notice.
- `ui.shopOpen`/`ui.shopClose` are leather-and-iron: a short noise rustle plus a low `metal` click.

Gate: typecheck clean; all 13 keys present.

### T8 — `audio/ambience.ts`

Export `createAmbience: CreateAmbience` → `AmbienceHandle`, plus
`const AMBIENCE_CUES: CueRegistry` for `amb.menu`, `amb.field`, `amb.battle`, `amb.fountain`,
`amb.death` (registered as looping bed generators; the handle owns their lifecycle).

Requirements:
- Beds are **continuous looping graphs**, not repeated one-shots: a looped noise source through a
  filter modulated by a slow LFO, plus for `menu`/`field` a low D drone (`PALETTE.sub.D2`) at
  −30 dB, plus for `field` a "distant battle" layer of sparse seeded noise grains whose level maps
  `AMBIENCE.battleDb` from `setBattleIntensity(0..1)`.
- `setScene` crossfades over `AMBIENCE.fadeS`. Idempotent — setting the current scene does nothing.
  Never hard-cut, never click.
- `dead` scene is the death-cam bed: everything else is already lowpassed by the engine's submerge
  filter; this bed adds a low pulse only.
- `fountain` layers a `AMBIENCE.fountainHz` hum over `field`.
- `tick(nowSec)` advances the gust LFO **without allocating**.
- `stop()` must silence and disconnect everything; calling it twice is safe.
- Under an `OfflineAudioContext` the beds must still render (the `menuBed` scene depends on it), so
  all modulation must be scheduled `AudioParam` automation or LFO nodes, **never `setInterval`**.

Gate: typecheck clean.

### T9 — `audio/music.ts`

Export `createMusic: CreateMusic` → `MusicHandle`, plus `const MUSIC_CUES: CueRegistry` for
`mus.pad`, `mus.pulse`, `mus.perc`, `mus.lead`.

Requirements:
- A **look-ahead scheduler**: `tick(nowSec)` schedules every note that falls within
  `MUSIC.lookaheadS` of now and never re-schedules one. Standard WebAudio pattern. No `setInterval`,
  no `setTimeout` — `tick` is pumped from the frame loop and from the offline renderer.
- `MUSIC.bpm` = 84, 4/4. All pitches from `PALETTE` in D natural minor via `degree()`.
- Four layers, entering/leaving per `MUSIC.layers[intensity]` with `MUSIC.layerFadeS` crossfades:
  - `mus.pad` — a slow `swell` drone on D, moving D→Bb→F→C across four bars.
  - `mus.pulse` — an eighth-note filtered pulse on the root, low register, felt not heard.
  - `mus.perc` — a seeded, sparse percussive pattern from `noise` + `thump`. Not a drum kit; a war
    drum. Downbeat-heavy.
  - `mus.lead` — a restrained 4-note modal motif in the `mid` register, only at intensity 4.
- **`setIntensity` lands on the next bar boundary**, never mid-phrase. Store the pending value.
- The music bus is already at −14 dB and gets ducked; do not compensate by writing louder music.
  If it feels quiet in isolation, it is correct.
- `start`/`stop` are idempotent; `stop` must not leave scheduled notes ringing beyond their tails.

Gate: typecheck clean.

### T10 — `audio/index.ts`

Export `createAudio: CreateAudio` → `RiftAudioHandle`. This is the drop-in replacement for the old
`ui/audio.ts` factory and the module's assembly point.

Requirements:
- Lazily create one `AudioContext` on the first `resume()`/`ui()`/`event()` call (never in
  `createAudio()` — autoplay policy). Feature-detect `webkitAudioContext`. Wrap in try/catch; on
  failure every method becomes a silent no-op and the game plays on.
- Build `CueGraph` (noise buffer, both IRs, sends, busses), then `createEngine`, `createSpatial`,
  `createAmbience`, `createMusic`.
- Merge the five cue registries. **Include a compile-time exhaustiveness check** that every
  `SoundId` has a `CueSpec`:
  ```ts
  const REGISTRY: Readonly<Record<SoundId, CueSpec>> = { ...ABILITY_CUES, ... };
  ```
  Typing the merged object as `Record<SoundId, CueSpec>` (not `Partial<...>`) makes a missing cue a
  compile error. That is the mechanism — use it.
- `snapshot(snap, ctx)`: run the deriver, route every `AudioEvent` to `engine.play(...)` with the
  right `SoundId`, position, `self`, `visible`, and `intensity`. Also:
  - update `MusicIntensity` from `TENSION` (with `TENSION.holdS` hysteresis),
  - update `AmbienceHandle.setBattleIntensity` from nearby combat density,
  - set `engine.setSubmerge(DERIVE.submergeHz)` while dead and `Infinity` on respawn,
  - drive the low-HP heartbeat at `DERIVE.lowHpPulseS` for the current band.
- `event(ev)` feeds the deriver's `wire()` path. `ui(kind)` maps `UiCue` → `SoundId`.
- `setPhase(p)` drives ambience scene + music start/stop. `'menu'`/`'lobby'` → `amb.menu` +
  intensity 1; `'live'` → `amb.field`; `'dead'` → `amb.death` + submerge; `'ended'` → silence then
  the announcer sting (the caller fires `ann.victory`/`ann.defeat` via `event`).
- `tick(dtMs, listener)`: forward the listener, pump `engine.tick`, `music.tick`, `ambience.tick`.
  **No allocation in this path.**
- Settings: load from `localStorage[STORAGE_KEY]` inside try/catch, validate every field
  (clamp 0..1, boolean check) and fall back to `DEFAULT_SETTINGS` on any malformed value. Persist on
  `setSettings`. Settings must be honoured **before the first sound plays**.
- `dispose()` stops everything and closes the context.

Gate: typecheck clean; the merged registry compiles as a total `Record<SoundId, CueSpec>`.

### T11 — `audio/lab.ts` + `games/rift/client/audio-lab.html` + `games/rift/client/vite.config.ts` + `audio/baseline.legacy.ts`

The render seam. **Without this there is no judge loop, so this task is as important as the cues.**

- `audio/baseline.legacy.ts`: a **verbatim copy** of the current `games/rift/client/src/ui/audio.ts`,
  mechanically modified in exactly two ways: (a) `createAudio()` becomes
  `createBaselineAudio(ctx: BaseAudioContext, dest: AudioNode)` and uses the injected context and
  destination instead of creating its own and connecting to `ctx.destination`; (b) any `ctx.resume()`
  call is guarded. **Change nothing else** — not a gain value, not a frequency. It is the "before"
  picture in the blind A/B and must be an honest one.
- `audio/lab.ts`: assigns `window.__riftAudio: AudioLabApi` and
  `window.__riftAudioBaseline: BaselineLabApi`.
  - `renderCue(id, seconds)`: build an `OfflineAudioContext(2, seconds * 48000, 48000)`, construct
    the full graph + engine with `DEFAULT_SETTINGS`, `engine.play(id, {})` at t=0 (for world cues
    pass `x/z` at the listener so they are audible and centred), `startRendering()`, return channel
    data.
  - `renderScene(name, seconds)`: same, but set the scene's listener, ambience scene and music
    intensity, then schedule every `SceneStep` via `engine.play(step.id, {...step.opt, delay:
    step.atSec})`, pumping `music.tick`/`ambience.tick` across the timeline before rendering.
  - `ids()` returns every `SoundId` in the merged registry.
  - Baseline `render(id, seconds)` drives `createBaselineAudio` with a synthetic `RiftEvent` or
    `ui()` call matching `id`.
- `audio-lab.html`: a bare page loading `src/audio/lab.ts` as a module. No styling needed.
- `vite.config.ts`: add `build.rollupOptions.input` with both `index.html` and `audio-lab.html`.
  **Change nothing else in that file.**

Gate: typecheck clean; `npm run build -w @rift/client` emits both `index.html` and `audio-lab.html`.

### T12 — `scripts/audio-render-rift.mjs`

The capture harness — the audio equivalent of the screenshot script. Follow the shape of
`scripts/verify-rift.mjs` (read it first): serve the built platform, drive puppeteer, print a JSON
manifest as the **last stdout line**, exit non-zero on failure.

Requirements:
- Serve the **built** client (do not build; assume `npm run build -w @rift/client` already ran).
  Launch puppeteer with the same args as `verify-rift.mjs` **minus `--mute-audio`** (irrelevant for
  offline rendering, but its presence is confusing — drop it) and navigate to `/rift/audio-lab.html`.
- For every `SoundId` from `window.__riftAudio.ids()`, and every `SceneName` in `SCENES`, and every
  baseline id: render, then compute **in-page** and return:
  `peakDbfs`, `truePeakDbtp` (4× oversampled), `rmsDbfs`, `crestDb`, `attackMs` (time to 90 % of
  peak), `lengthMs` (to −60 dB), `spectralCentroidHz`, `bandEnergyPct` for bands
  `[0-120, 120-400, 400-800, 800-2000, 2000-4000, 4000-20000]`, `stereoCorrelation`,
  `clippedSamples`, and for scenes additionally `limiterActivePct` (samples where |x| > limiter
  ceiling pre-limit).
- Write per-item: a 16-bit stereo **WAV** to `screenshots/rift-audio/wav/<id>.wav`, and a **PNG**
  containing a stacked waveform + log-frequency spectrogram (rendered to an offscreen canvas
  in-page, `toDataURL`, written to `screenshots/rift-audio/png/<id>.png`). Label the PNG with the id
  and the key metrics — the judge reads these images, so axes and labels must be legible: minimum
  1200×700, dark background, and a dB colour scale.
- Emit `screenshots/rift-audio/metrics.json` with every measurement, plus a `pairs` array pairing
  each baseline id with its closest new-build counterpart for the blind A/B (mapping:
  `rift_kill`→`die.hero`, `rift_structure`→`obj.tower`, `rift_cast`→`cast.hex.0`,
  `rift_surge`→`obj.surge`, `rift_end`→`ann.victory`, `click`→`ui.click`, `buy`→`ui.buy`,
  `error`→`ui.error`, `levelup`→`ui.levelUp`).
- Assert and fail (non-zero exit) on: any `truePeakDbtp > -1.0`, any `clippedSamples > 0`, any
  missing `SoundId`, any page/console error, any scene `limiterActivePct > 2`.
- Add an `npm run audio:rift` script to the **root `package.json`** — you own that one line; add
  nothing else to that file.

Gate: the script runs end to end against the built client and writes a complete manifest.

### T13 — `audio/derive.test.ts`

Vitest suite for T3, node environment, **no WebAudio, no DOM**. Build small synthetic `SnapMsg`
objects and assert the derived events. Cover, at minimum:
- first snapshot emits nothing but establishes the baseline;
- an `atk` transition emits exactly one `attack`, and the same `atk` value on the next snapshot
  emits none;
- a vanished creep inside vision emits `unitDeath`; outside vision emits nothing;
- gold delta ≥ `lastHitMinGold` **with** a same-snapshot `unitDeath` ⇒ `lastHit: true`; without ⇒
  `false`; passive trickle ⇒ `false`;
- crossing 0.3 and 0.15 HP emits `lowHp` once each; recovering and re-crossing re-arms;
- an ability coming off cooldown emits `abilityReady` exactly once;
- `snap.you === null` never throws;
- out-of-order snapshot (`tick` not increasing) returns empty;
- `reset()` makes the next snapshot behave like the first;
- `wire()` on `rift_cast` for each of the six heroes' four slots produces the documented
  `CastColour` and correct `ult` flag — this is the table that most easily rots, so assert all 24.

Gate: `npx vitest run games/rift/client/src/audio` green.

### T14 — `audio/settingsPanel.ts` + `games/rift/client/src/style.css`

The settings UI. Export `createAudioSettingsPanel(parent: HTMLElement, audio: RiftAudioHandle):
{ readonly root: HTMLElement; setOpen(open: boolean): void; destroy(): void }`.

Requirements:
- Follow the repo's panel convention exactly (read `games/rift/client/src/ui/shop.ts` first): an
  `el()`-style builder, a single top-level class `.audio-panel`, child classes
  `.audio-panel-row`, `.audio-panel-slider`, `.audio-panel-mute`. Descendant selectors for
  everything else — the repo deliberately minimises class surface.
- Four sliders (master / SFX / music / ambience) and a mute toggle, each wired to
  `audio.setSettings({...})` live, reading initial values from `audio.settings()`.
- Every slider must have a visible label and a visible numeric percentage. Text ≥ 12 px (repo's
  `FONT_MIN_PX` law). Keyboard-operable (native `<input type="range">`, do not hand-roll).
- Colours come from the existing CSS variables in `style.css` (`--ink`, `--stone-deep`, etc.) — no
  new hex values.
- Append your CSS to the END of `style.css` under a clearly delimited comment block. **Do not modify
  any existing rule in that file.**
- Moving a slider must give immediate audible feedback: fire `ui.click` on release, and while
  dragging the change must apply within one frame.

Gate: typecheck clean; panel renders and is keyboard-operable.

---

## Integration (orchestrator/integrator only — no implementer touches these)

`client/src/contract.ts` (re-export `RiftAudioHandle` as `AudioHandle`), `client/src/wire.ts`
(construct from `./audio/index.js`), `client/src/game.ts` (add `audio.snapshot(...)` in `onSnap`,
`audio.tick(...)` in `step`, `audio.resume()` on first gesture, widen `setPhase` calls, mount the
settings panel), and deleting the old `client/src/ui/audio.ts`.
