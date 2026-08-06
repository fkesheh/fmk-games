# RIFT AUDIO — CONTRACT (frozen)

*Embedded verbatim in every implementer brief. Read all of it before writing a line.*

*This is revision 2. Revision 1 was rejected 3/3 by an adversarial review panel; every fix below
exists because a reviewer proved the previous wording would produce broken or dishonest output.
Where a rule looks oddly specific, that is why — do not "simplify" it.*

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
8. **Audio must never crash the client, and must never log.** Every public entry point wraps its
   body in try/catch and degrades to silence. **Catch silently — no `console.error`, no
   `console.warn`, no `console.log` from any audio path.** `scripts/e2e-rift.mjs` and
   `scripts/verify-rift.mjs` both fail the build on *any* console error, so a well-meaning
   diagnostic log turns two green gates red.
9. **Every frequency traces to `PALETTE` in `config.ts`.** A bare frequency literal in cue code is a
   contract violation and a reviewer will flag it, exactly as an ad-hoc hex colour would be in a
   visual build. Derive with the documented ratios (`MINOR_STEPS`, `INTERVAL`, `METAL_RATIOS`) when
   you need a pitch that is not literally in the table. `MINOR_STEPS` is 12-TET, matching the
   `PALETTE` tables to within 1 cent — the two are one tuning system, deliberately.

   **Ruling (post-fan-out, after four authors read this four different ways):** the rule governs
   PITCH — anything a listener hears as a note, including oscillator frequencies, ring-mod carriers,
   and any tone whose interval carries meaning. It does NOT govern filter cutoffs, noise band
   centres, or sweep endpoints: those are *timbre placement*, and the bible specifies them as ranges
   ("physical: band-passed 300–2000 Hz"), not as palette members. A bare literal is therefore legal
   for `filterHz` / `bandHz` / `sweepHz` / `openHz`, and illegal for a pitch. Pulling filter corners
   from `PALETTE` is still welcome where it reads naturally — it is simply not required.

   The one hard constraint that survives regardless: a sustained band centre in a non-`ui`/`ann` cue
   must sit below `INFO_FLOOR_HZ`. Timbre freedom does not license squatting in the reserved
   information register.
10. **Only `info`-register cues may put meaningful energy above `INFO_FLOOR_HZ` (800 Hz).** That
    register is reserved for information: last-hit, level-up, skill point, cooldown ready, purchase,
    error, announcer. "Meaningful" is `INFO_BAND_MAX_PCT` (8 % of total energy above 800 Hz) and the
    harness asserts it. This is the single most important mix law.
11. **Every repeatable cue varies** per `VARY` in config: pitch, level, timing, and one timbral
    parameter. Cues with `variants > 1` must produce genuinely different waveforms per variant, not
    the same one transposed.
12. **Clean up after yourself.** Every node you create must be disconnected or stopped when its
    envelope ends (`osc.stop(endTime)`, `src.onended`). A leaked node per attack is a memory leak in
    a 40-minute match. No per-frame allocation in `tick()` paths.
13. **Import style:** named exports only, `.js` extensions on relative imports.
14. **Declare cue registries with `satisfies`, never with a type annotation.**
    `export const X_CUES = { ... } satisfies CueRegistry;` — **not** `const X_CUES: CueRegistry`.
    Annotating erases the literal keys (`CueRegistry` is a `Partial`), and the total
    `Record<SoundId, CueSpec>` merge in `index.ts` then fails to compile no matter how complete your
    registry actually is. This is the mechanism that makes a missing cue a compile error; annotating
    breaks it.
15. **Read the SONIC BIBLE** (`docs/rift-audio/SONIC_BIBLE.md`) before writing a cue. It is not
    background reading — it is the spec for what things must sound like.

### Your gate is scoped to YOUR file

Do **not** treat a whole-project `tsc` run as your gate: fifteen files land concurrently and you
would be reading other agents' errors as your own. Your gate is:

```sh
npx tsc --noEmit -p games/rift/client/tsconfig.json 2>&1 | grep '<your file path>'
```

producing **no output**. (Errors from `./dsp.js` not existing yet are expected and are T0's, not
yours — code against the frozen signatures below and move on.) The full-project typecheck is the
*integration* gate, run by the orchestrator.

---

## The frozen `dsp.ts` API — signatures every cue module codes against

`audio/dsp.ts` is implemented by task T0 **concurrently with you**. You do not wait for it and you
do not implement any of it yourself — you import these and call them.

```ts
import type {
  CueGraph, Env, MetalSpec, NoiseSpec, ShimmerSpec, SwellSpec, ThumpSpec, ToneSpec,
} from './contract.js';

/** Oscillator voice with ADSR + optional glide + optional swept lowpass. */
export function tone(g: CueGraph, at: number, dest: AudioNode, spec: ToneSpec, gain: number): void;

/** Filtered burst from the shared seeded noise buffer, with optional filter sweep. */
export function noise(g: CueGraph, at: number, dest: AudioNode, spec: NoiseSpec, gain: number): void;

/** Sine sub with a fast downward pitch envelope. The weight archetype. */
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

/** Pick a scale degree: root * MINOR_STEPS[degree mod 7] * 2^octave, wrapping correctly. */
export function degree(root: number, deg: number, octave: number): number;

/** Build the shared 1s seeded white-noise buffer. Called once by the engine. */
export function makeNoiseBuffer(ctx: BaseAudioContext, seed: number): AudioBuffer;

/** Generate a decaying, damped STEREO impulse response. Called once per IR by the engine. */
export function makeImpulse(
  ctx: BaseAudioContext, seed: number,
  spec: { seconds: number; decay: number; dampHz: number; preDelayS: number },
): AudioBuffer;

/** Soft-clip curve for the limiter WaveShaper. `ceilingDb` is a SAMPLE-domain asymptote. */
export function makeLimiterCurve(ceilingDb: number): Float32Array<ArrayBuffer>;
```

`Env`, `FilterSweep`, `ToneSpec`, `NoiseSpec`, `ThumpSpec`, `MetalSpec`, `ShimmerSpec`, `SwellSpec`
are declared in `contract.ts` — read them there. Note that `ToneSpec`, `MetalSpec`, `ShimmerSpec`
and `SwellSpec` all extend `FilterSweep`, so **any tonal archetype can open or close a lowpass**.
A *closing* sweep (`sweepHz < filterHz`) is how the `control` school and SHADE's whole character are
built; do not hand-roll a `BiquadFilterNode` for it.

---

## Module specs

Every module below owns a disjoint file set.

### T0 — `audio/dsp.ts`

Implement every signature above. Six other agents call it, so correctness and cleanliness matter
more than cleverness.

- `tone`/`noise`/`thump`/`metal`/`shimmer`/`swell` each build their nodes, connect to `dest`,
  schedule the envelope from `at`, and **stop and disconnect** at envelope end. No leaks.
- **`noise()` must always set `src.loop = true` and `src.loopEnd = buffer.duration`.** The shared
  noise buffer is 1 second; the structure-collapse sweeps and debris tails run 1.5–3.0 s and would
  otherwise fall silent at exactly t+1.0 s while their envelope kept running. The envelope, not the
  buffer length, bounds the layer. (The module being replaced learned this the hard way and carries
  the comment `loop?: boolean; // required for any dur > the 1s noise buffer`.)
- `applyEnv` uses `setValueAtTime` + `linearRampToValueAtTime` for attack and
  `exponentialRampToValueAtTime` toward a small epsilon (never to 0 — that throws) for decay/release.
- `FilterSweep` handling, shared by `tone`/`metal`/`shimmer`/`swell`: when any of the three fields is
  present, insert a 12 dB/oct lowpass and ramp `filterHz → sweepHz` over `sweepTime`. Absent fields
  default sensibly (`filterHz` = Nyquist, `sweepTime` = envelope length). All three absent = no
  filter node at all.
- `makeNoiseBuffer` produces a mono 1-second buffer from `rng(seed)`.
- `makeImpulse` produces a **stereo** buffer: decorrelated L/R noise, exponential decay of `decay`
  slope over `seconds`, a one-pole lowpass at `dampHz` over the tail, `preDelayS` leading silence.
- `makeLimiterCurve` returns a 2049-point odd-symmetric tanh-shaped curve asymptoting at
  `db(ceilingDb)`. `ceilingDb` is a **sample-domain** ceiling; the harness gates on **true peak**,
  and `LIMIT_CEILING_DB` (−2 dBFS) sits 1 dB below `TRUE_PEAK_GATE_DBTP` (−1 dBTP) precisely to
  leave room for inter-sample overshoot. Do not "fix" that gap.
- `degree` handles negative and >6 degrees by wrapping and adjusting the octave.
- Every function is pure with respect to module state — no module-level mutable variables.

### T1 — `audio/engine.ts`

Export `createEngine: CreateEngine`. **The engine owns the `CueGraph` AND the `SpatialHandle`** —
it calls `makeNoiseBuffer`, `makeImpulse` ×2, builds every bus and send, and imports
`createSpatial` from `./spatial.js` itself. `index.ts` builds neither; it reads `engine.graph`.
(Revision 1 left this ambiguous and both T1 and T10 would have built one, leaving the music and
ambience connected to orphan nodes.)

Graph:
```
music ─┐
amb   ─┤
sfx   ─┼─→ preMaster (DynamicsCompressor, GLUE) ─→ submergeLP ─→ master (Gain) ─→ limiter ─→ dest
ui    ─┤                                                             │
announcer ─┘                                                         └─→ (EngineHandle.preLimit)
sendValley ─→ Convolver(irValley) ─→ sfx
sendHall   ─→ Convolver(irHall)   ─→ announcer
```
- `EngineHandle.preLimit` is the `master` node itself, exposed so the render harness can measure the
  signal **before** soft-clipping. A WaveShaper leaves no other way to know how hard the limiter is
  working; without this the headroom gate would be a permanent vacuous green. Nothing connects to it
  in the live game.
- `submergeLP` is the global death-cam lowpass, default open (frequency = Nyquist).
- Works identically under `OfflineAudioContext`. Guard resume with
  `typeof (ctx as { resume?: unknown }).resume === 'function' && ctx.state === 'suspended'`.
- Bus gains: `BUS_DB[bus]` × the matching user setting (`sfx`→sfx, `music`→music, `amb`→ambience,
  `ui`/`announcer`→sfx) × master (`MASTER_TRIM_DB` at 1.0). Muted ⇒ master 0. Apply with a 20 ms
  ramp, never a discontinuity (which clicks).
- `play(id, opt)`:
  1. Look up the `CueSpec`; unknown id ⇒ return false, never throw.
  2. **Effective priority is `opt.priority ?? spec.priority`.** Everything below uses the effective
     value.
  3. If `opt.x`/`opt.z` are present and the cue is not `dry`, resolve spatially; if
     `audible === false`, return false without scheduling.
  4. Voice chain: `StereoPanner` (skip when `dry`) → lowpass (skip when `cutoffHz === Infinity`) →
     `Gain` (distance gain × `db(opt.gainDb ?? 0)` × `jitterDb(g, VARY.levelDb)`) → the cue's bus.
     Tap that gain node into `sendValley` scaled by `SpatialResult.send`.
  5. **Set `CuePlay.gain = 1`.** The chain above has already applied the mix; `CuePlay.gain` is a
     per-cue trim, not the mix. (Left unspecified in revision 1, which would have had cue authors
     squaring the distance gain.)
  6. Enforce `POLYPHONY_CAP`: at cap, steal the oldest voice of the highest priority *number*
     present, never stealing one whose priority is at or below `NEVER_STEAL_AT_OR_BELOW`. If nothing
     is stealable, drop the new cue unless its effective priority is ≤ 2, in which case play anyway.
  7. Ducking per `DUCK`, keyed on effective priority. **Overlapping ducks must not stack** — track a
     duck depth and apply only the deepest active one, restoring when it expires.
  8. Round-robin: per-`SoundId` counter, pass `variant = counter % spec.variants`.
  9. Call `spec.fn(graph, at, play)` inside try/catch. `at = ctx.currentTime + (opt.delay ?? 0)`.
- `tick(dtMs)` retires finished voices with **no allocation** — reuse arrays, iterate backwards.
- `dispose()` disconnects everything. It does not own the context and must not close it.

### T2 — `audio/spatial.ts`

Export `createSpatial: CreateSpatial`. Implement SONIC_BIBLE §6 with the `SPATIAL` constants:
- `d = hypot(sx - lx, sz - lz) * (1 + (listener.height - camRefHeight) * heightScale)`
- `audible = d <= audibleRadius` (self is always audible)
- `gain = max(gainFloor, 1 / (1 + (d / refDistance)^2))`; self ⇒ 1
- `pan = clamp((sx - lx) / panHalfWidth, -1, 1) * panMax`; self ⇒ `pan *= selfPanScale`
- `send = min(sendMax, d / audibleRadius * sendScale)`; self ⇒ 0
- `!visible` ⇒ `gain *= db(fogAttenDb)` and `cutoffHz = fogCutoffHz`; else `cutoffHz = Infinity`
- self additionally ⇒ `gain *= db(selfBiasDb)`

Deterministic, no RNG. `resolve` allocates nothing beyond the returned object.

### T3 — `audio/derive.ts`

Export `createDeriver: CreateDeriver`. **No WebAudio type, no DOM.** Pure; T13 unit-tests it in node.

**Tick domains — get this right.** `snap.tick` is a snapshot SEQUENCE NUMBER; `snap.matchTick` is
the sim clock. `shared/src/types.ts` says so explicitly: *"All tick fields (cdUntilTick,
respawnAtTick, itemCdUntilTick) are in the MATCH-TICK domain — compare against `rift_snap.matchTick`,
never against `snap.tick` drift."* Every cooldown/respawn comparison uses `matchTick`. `snap.tick` is
used for exactly one thing: the out-of-order guard.

`snapshot(snap, ctx)` diffs against the previous snapshot and emits:

| Emission | Derivation |
|---|---|
| `attack` | Each `EntSnap` with `atk !== undefined` whose `atk` differs from its previous value (and `k !== 'proj'`). `kind` from `e.k` (`tower`/`guard`/`ancient` → `'tower'`). `ranged` for `'ranged'`, `'siege'`, `'tower'`, and heroes with `heroById(hero).base.attackRange > 3`. `self` when `e.id === ctx.selfEntId`. Mirrors `Game.combatFx`. |
| `hit` | Each entity present in both snapshots whose `hp` dropped by ≥ `DERIVE.hitMinHp`. Position = the victim's current x/z. `school`: `'physical'` when some attacker's `atk` targets it and that attacker is `melee`/`siege`/`hero`-melee/`tower`, else `'magic'`. `crit` when the drop exceeds 1.6× the median drop seen this snapshot. `self` when the victim is `ctx.selfEntId`. This is the impact half of combat — `attack` is only the swing. |
| `unitDeath` | Present in the previous snapshot, absent now, `pid === undefined`, `k` not in `tower/guard/ancient/proj`, and `ctx.isVisible(p.x, p.z)`. Same rule the visual layer uses. |
| `hurt` | `you.hp < prev.hp - DERIVE.hurtMinHp`. `frac = drop / max(1, you.maxHp)`, `hpFrac = you.hp / you.maxHp`, `x`/`z` = `you.x`/`you.z` (the attacker is NOT knowable from an hp delta — do not try). |
| `lowHp` | On crossing DOWN into a band in `DERIVE.lowHpBands`, emit with that band index. On rising back above band 0, emit once with `band: -1` to stop the heartbeat. Re-arms on recovery. |
| `gold` | **Only when `delta >= DERIVE.goldMinDelta`.** Passive income is fractional and lands every single tick, so `gold > prevGold` is true on every snapshot; without this floor the module would schedule a UI cue 20×/s all match (400×/s at the gates' `speed: 20`). `lastHit = delta >= DERIVE.lastHitMinGold` **and** a `unitDeath` was emitted this same snapshot. |
| `levelUp` | `you.level > prev.level` and `you.level > 1`. |
| `skillPointAvailable` | `you.skillPoints > prev.skillPoints`. Emits once per increase. |
| `abilityReady` | Per slot: previously `prevCdUntilTick > prev.matchTick`, now `cdUntilTick <= snap.matchTick`, and `rank > 0`. **Each side compares against its OWN snapshot's `matchTick`.** Using `snap.matchTick` on both sides is wrong: on natural expiry `cdUntilTick` does not change, so both sides evaluate identically and the cue never fires. |
| `respawn` | Previously `respawnAtTick > 0` with `snap.matchTick < respawnAtTick`, now `respawnAtTick === 0`. |
| `ancientThreat` | Own team's `ancient` entity crossing below `DERIVE.ancientThreatFrac` of `maxHp`. Once per crossing. |

`wire(ev, snap, ctx)`:
- `rift_cast` → `cast`. Resolve the caster from `snap.ents` by `id`. If a hero, `heroById(e.hero)`
  and `abilities[slot]` give `colour` (precedence documented on `CastColour`) and `ult`. When
  `slot >= 4` it is an item active: `item = snap.you?.items[slot - 4] ?? null` **only when the caster
  is the local player** (you cannot see others' inventories), else `null` with colour `'buff'`.
  `self` when `e.pid === ctx.selfPid`. `visible = ctx.isVisible(ev.x, ev.z)`.
- `rift_kill` → `heroDeath`. Position from the victim's entity in `snap` by `pid`; if absent, use
  `snap.you` when it is your own death, else `0,0` with `visible: false`.
  `self = victim === ctx.selfPid`, `byMe = killer === ctx.selfPid`. **`friendly` = the victim's team,
  read from `snap.board` (which carries `{id, team}` per seat) or `snap.ents` by `pid`,
  `=== ctx.selfTeam`; `false` when unresolvable.** Without this every teammate's death would play the
  cue authored as "good news".
- `rift_structure` → `structure`. Position by scanning `snap.ents` for
  `k === ev.kind && team === ev.team && hp <= 0` — the same lookup the `rift_structure` case of
  `Game.onEvent` already does. Fall back to `0,0`. `friendly = ev.team === ctx.selfTeam`.
- `rift_surge` → `surge`. `rift_pick` → `heroPick`; **`hero === null` (a deselect) emits nothing**.
- `rift_end` → `matchEnd` (`won = ev.winner === ctx.selfTeam`,
  `draw = ev.reason === 'draw' || ev.winner === null`). `rift_roster` → nothing.

`reset()` clears every diff baseline, totally. Cap output at `DERIVE.maxPerSnap`, dropping by
**`EVENT_PRIORITY` from `config.ts`** (highest number first) — that table is frozen precisely so
your drop order and the engine's steal order cannot disagree.

**Edge cases you must handle:** first snapshot (record state, emit nothing); `snap.you === null`;
out-of-order snapshot (`snap.tick <= prevTick` ⇒ return empty, change nothing); `you.maxHp === 0`;
entity ids reused across matches (`reset` must be total).

### T4 — `audio/cues/abilities.ts`

Export `const ABILITY_CUES = { ... } satisfies CueRegistry;` — **28** keys: `cast.<hero>.<0..3>` for
all six heroes, plus `cast.item.blink`, `cast.item.horn`, `cast.item.ward`, `cast.item.generic`.

This is the largest single quality lever in the build.
- Follow `HERO_TIMBRE` in `config.ts`. Six heroes must be immediately distinguishable **blind**.
- Within a hero the four slots must differ too. Make the cue *describe the ability*: a dash sweeps,
  a stun cuts off (closing `FilterSweep`), a heal rises, an AoE spreads, a projectile has a launch
  transient.
- **Ultimates (slot 3): 4–6 layers, 0.8–1.6 s, always a `sub` element and a `swell`.**
- Non-ults: 3–4 layers, 250–700 ms.
- Passives (bullwark W, longbow W, shade E) rarely fire; still register a short restrained cue —
  the key must not be missing.
- **Register ALL casts at `priority: 4`, including ultimates.** `index.ts` passes
  `priority: 2` per-play when the cast is the local player's. Registering ults at 2 would have every
  enemy ult in a teamfight hold the music and ambience ducked for its whole tail.
- `bus: 'sfx'`, `dry: false`, `variants: 2` (ults 1), `tail` = your real tail length.
- Respect rule 10: casts are not `info` cues. Keep ≤ 8 % of energy above 800 Hz. HEX's ring-mod
  sidebands are the trap here — filter the tail.

Abilities by hero and slot (`q w e r`):
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

Item actives: `blinkstone` = 8 m dash, `warhorn` = damage-aura horn, `wardstone` = ward placement.

### T5 — `audio/cues/combat.ts`

Export `const COMBAT_CUES = { ... } satisfies CueRegistry;` — **16** keys: `atk.hero.melee`,
`atk.hero.ranged`, `atk.creep.melee`, `atk.creep.ranged`, `atk.siege`, `atk.tower`, `hit.physical`,
`hit.magic`, `hit.self`, `hit.crit`, `hit.heartbeat`, `die.hero`, `die.hero.ally`, `die.hero.self`,
`die.creep`, `die.ward`.

- **Attacks are the most-fired cues in the game.** 2 layers, attack < 8 ms, total < 200 ms, crest
  factor > 8 dB, `variants: VARY.roundRobin` (4). Four genuinely different waveforms, not one
  transposed four ways. The harness measures all three numbers and fails the build on them.
- `atk.tower` is the heaviest attack: a mid-register launch with a `sub` component.
- `hit.physical` / `hit.magic` / `hit.crit` are the **impact** cues, fired at the victim's position
  whenever any unit loses HP. They fire often — keep them ≤ 180 ms, `priority: 4`, 4 variants.
  `hit.crit` layers a brighter transient but stays under `INFO_FLOOR_HZ` except for a <25 ms
  transient; the info register is not yours.
- `hit.self` is what the local player hears when *they* take damage: a filtered thud plus a body
  component, `priority: 3`, positioned at the player. It must read as "that was me" — distinct from
  `hit.physical`.
- **`hit.heartbeat`** is the low-HP pulse: a sub-register double-thump, `priority: 2`, `bus: 'sfx'`,
  `dry: true`, ≤ 400 ms, no content above 300 Hz. `index.ts` re-fires it on a
  `DERIVE.lowHpPulseS[band]` timer. `CuePlay.intensity` carries the band (0 = 30 % HP, 1 = 15 %) —
  band 1 is more urgent, tighter, and slightly louder.
- The three hero-death cues, all with a body-fall `thump` (SONIC_BIBLE §3 team-interval law):
  `die.hero` = an enemy fell, `INTERVAL.ally` resolution, it is good news, `priority: 4`.
  `die.hero.ally` = a teammate fell, `INTERVAL.enemy` colour, `priority: 4`.
  `die.hero.self` = you fell, `INTERVAL.enemy` plus the low-end weight of a real loss, `priority: 2`.
- `die.creep` fires constantly: ≤ 220 ms, `priority: 5`, 4 variants. It must sit *below* the
  last-hit chime it accompanies and never mask it — nothing above `INFO_FLOOR_HZ`.

### T6 — `audio/cues/objectives.ts`

Export `const OBJECTIVE_CUES = { ... } satisfies CueRegistry;` — **12** keys: `obj.tower`,
`obj.guard`, `obj.ancient`, `obj.surge`, `obj.klaxon`, `obj.respawn`, `obj.countdown`,
`obj.matchStart`, `ann.firstBlood`, `ann.victory`, `ann.defeat`, `ann.draw`.

- **`obj.ancient` is the biggest sound in the game.** 5–7 layers, **2.5–3.0 s**, ≥ 45 % of total
  energy below 120 Hz. `obj.tower`/`obj.guard`: 5–7 layers, **1.5–2.2 s**, ≥ 35 % below 120 Hz.
  The harness asserts these percentages — build to them.
- Collapse anatomy: a sub drop, a `metal` stress layer, a filtered noise sweep for the collapse, a
  debris tail (repeated short seeded noise grains over 1–2 s), and a low `swell` underneath. Note
  T0's looping rule — your noise layers may exceed 1 s.
- `ann.*` are `bus: 'announcer'`, `dry: true`, `priority: 0`, routed to `sendHall`. They are the only
  cues that may sound "composed": `ann.victory` resolves a D-minor cadence; `ann.defeat` collapses
  through a detuned fall; `ann.draw` is unresolved (tritone, no cadence).
- `obj.klaxon` uses `INTERVAL.enemy` and repeats 3× over ~1.6 s. `priority: 1`.
- `obj.countdown` is a **single** `info` tick; the caller fires it once per whole second for both the
  lobby countdown and the respawn timer. It must **not** loop internally.
- `obj.matchStart` is the horn in D. `obj.respawn` re-opens the world: a rising filter sweep plus a
  fountain-flavoured hum onset.

### T7 — `audio/cues/ui.ts`

Export `const UI_CUES = { ... } satisfies CueRegistry;` — **12** keys: `ui.click`, `ui.buy`,
`ui.error`, `ui.shopOpen`, `ui.shopClose`, `ui.pick`, `ui.toast`, `ui.lastHit`, `ui.gold`,
`ui.levelUp`, `ui.skillPoint`, `ui.abilityReady`.

(There is no `ui.hover`. `game.ts` is the only module that can reach audio, and it sees no hover
events; a hover cue would be dead code.)

- All `dry: true`, `bus: 'ui'`. ≤ 120 ms except `ui.levelUp` (≤ 700 ms) and `ui.buy` (≤ 250 ms).
- **`ui.lastHit` is the most important cue in this module and possibly the game.** It is the Dota
  gold chime: two ticks in the `info` register (`A5` → `D6`), a coin shimmer, total < 180 ms.
  **`priority: 2`** — it ducks the bed like any self-critical cue, which together with the physical
  school's 2 kHz cap is what makes its 2–4 kHz band land ≥ 8 dB above the bed in the
  `lastHitInFight` scene. It must be physically impossible to miss in a teamfight. Nothing else you
  write matters as much.
- `ui.levelUp` `priority: 2`; the rest `priority: 3`.
- `ui.error` is the dry thud — it must read as "no", not as an alarm.
- `ui.abilityReady` is a *soft* tick, deliberately near the threshold of notice.
- `ui.shopOpen`/`ui.shopClose` are leather-and-iron: a short noise rustle plus a low `metal` click.
- `ui.gold` is the non-last-hit grant (hero bounties, big payouts): warmer and rounder than
  `ui.lastHit`, and deliberately *not* the chime — overloading the chime would destroy its meaning.

### T8 — `audio/ambience.ts`

Export `createAmbience: CreateAmbience`. **Ambience is NOT in the cue registry** — it owns its beds
outright and synthesises them directly through `CueGraph` + `dsp.ts`. Export no registry.
(Revision 1 gave the beds two owners and made `engine.play('amb.field')` a legal call that would
double the bed.)

- Beds are **continuous looping graphs**, not repeated one-shots: a looped noise source through a
  filter modulated by a slow LFO, plus for `menu`/`field` a low D drone (`PALETTE.sub.D2`) at −30 dB,
  plus for `field` a "distant battle" layer of sparse seeded noise grains whose level maps
  `AMBIENCE.battleDb` from `setBattleIntensity(0..1)`.
- `setScene` crossfades over `AMBIENCE.fadeS`. Idempotent. Never hard-cut, never click.
- `dead` adds a low pulse only (the engine's submerge filter already darkens everything else).
- `fountain` layers an `AMBIENCE.fountainHz` hum over `field`.
- `tick(nowSec)` advances the gust LFO **without allocating**, from the injected clock.
- `stop()` silences and disconnects everything; calling it twice is safe.
- **All modulation must be scheduled `AudioParam` automation or LFO nodes — never `setInterval` or
  `setTimeout`.** The beds must render under `OfflineAudioContext`; the `menuBed` scene depends on it.

### T9 — `audio/music.ts`

Export `createMusic: CreateMusic`. **Music is NOT in the cue registry** either — the scheduler calls
its own synthesis directly. Layers are keyed by the `MusicLayer` type (`'pad' | 'pulse' | 'perc' |
'lead'`), matching `MUSIC.layers` in config.

- A **look-ahead scheduler**: `tick(nowSec)` schedules every note within `MUSIC.lookaheadS` of
  `nowSec` and never re-schedules one. No `setInterval`, no `setTimeout` — `tick` is pumped from the
  frame loop and from the offline renderer (at a fixed `MUSIC.offlineStepS`).
- `MUSIC.bpm` 84, 4/4. All pitches from `PALETTE` in D natural minor via `degree()`.
- Layers, entering/leaving per `MUSIC.layers[intensity]` with `MUSIC.layerFadeS` crossfades:
  - `pad` — a slow `swell` drone on D, moving D→Bb→F→C across four bars.
  - `pulse` — an eighth-note filtered pulse on the root, low register, felt not heard.
  - `perc` — a seeded, sparse percussive pattern from `noise` + `thump`. Not a drum kit; a war drum.
    Downbeat-heavy.
  - `lead` — a restrained 4-note modal motif in the `mid` register, only at intensity 4.
- **`setIntensity` lands on the next bar boundary**, never mid-phrase. Store the pending value.
- The music bus is already at −14 dB and gets ducked; do not compensate by writing louder music. If
  it feels quiet in isolation, it is correct.
- `start`/`stop` idempotent; `stop` leaves nothing ringing beyond its tail.

### T10 — `audio/index.ts`

Export `createAudio: CreateAudio`. The assembly point and the drop-in replacement for the old
`ui/audio.ts` factory.

**BINDING — structure allegiance is carried on `CuePlay.intensity`.** `CuePlay` has no `friendly`
field, so T6 encodes ally/enemy structure colour through `intensity`: `>= 0.5` means *your own*
structure fell (tense `INTERVAL.enemy` colour), `< 0.5` means an *enemy* structure fell (consonant
`INTERVAL.ally` colour). The `structure` routing row in `index.ts` MUST therefore pass
`intensity: friendly ? 1 : 0`.

This is not optional polish. The default is `0`, so omitting it renders **every** structure fall —
including your own ancient collapsing — as good news. That is the identical failure the pre-freeze
review already caught on `heroDeath.friendly`, and it is inaudible in a typecheck. Wire it, and
confirm by ear in the scene renders that a friendly tower loss reads as a loss.

- Lazily create one `AudioContext` on the first `resume()`/`ui()`/`event()` call (never in
  `createAudio()` — autoplay policy). Feature-detect `webkitAudioContext`. On failure every method
  becomes a silent no-op and the game plays on.
- `createEngine(ctx, ctx.destination, REGISTRY, settings)`; read `engine.graph` and pass it to
  `createAmbience` and `createMusic`. **Do not call `createSpatial`** — the engine owns it.
- Merge the four cue registries and **type the merge as a total record**, which is what makes a
  missing cue a compile error:
  ```ts
  const REGISTRY: Readonly<Record<SoundId, CueSpec>> = {
    ...ABILITY_CUES, ...COMBAT_CUES, ...OBJECTIVE_CUES, ...UI_CUES,
  };
  ```
- **The `AudioEvent` → `SoundId` routing table. This is yours and it is the most intricate thing you
  own; it was left implicit in revision 1 and that was a defect.**

| `AudioEvent` | `SoundId` | `PlayOptions` |
|---|---|---|
| `cast` (hero) | `cast.<hero>.<slot>` | `{x, z, self, visible, priority: self ? 2 : 4}` |
| `cast` (item, `slot>=4`) | `blinkstone`→`cast.item.blink`, `warhorn`→`cast.item.horn`, `wardstone`→`cast.item.ward`, else `cast.item.generic` | as above |
| `attack` `kind:'hero'` | `ranged ? 'atk.hero.ranged' : 'atk.hero.melee'` | `{x, z, self, visible}` |
| `attack` `kind:'melee'` | `atk.creep.melee` | `{x, z, visible}` |
| `attack` `kind:'ranged'` | `atk.creep.ranged` | `{x, z, visible}` |
| `attack` `kind:'siege'` | `atk.siege` | `{x, z, visible}` |
| `attack` `kind:'shade'` | `atk.creep.melee` | `{x, z, visible}` |
| `attack` `kind:'tower'` | `atk.tower` | `{x, z, visible}` |
| `hit` | `crit ? 'hit.crit' : school === 'magic' ? 'hit.magic' : 'hit.physical'`; **plus** `hit.self` when `self` | `{x, z, self, visible}` |
| `hurt` | (no cue of its own — `hit` with `self` covers it; use `hurt.frac` only to drive `fx`-free intensity on `hit.self`) | — |
| `heroDeath` | `self ? 'die.hero.self' : friendly ? 'die.hero.ally' : 'die.hero'`; **plus** `ann.firstBlood` when `firstBlood` | `{x, z, visible, self}` |
| `unitDeath` | `kind === 'ward' ? 'die.ward' : 'die.creep'` | `{x, z, visible}` |
| `gold` | `lastHit ? 'ui.lastHit' : 'ui.gold'` | `{}` |
| `structure` | `obj.tower` / `obj.guard` / `obj.ancient` by `kind` | `{x, z, priority: 1}` |
| `levelUp` | `ui.levelUp` | `{}` |
| `skillPointAvailable` | `ui.skillPoint` | `{}` |
| `abilityReady` | `ui.abilityReady` | `{}` |
| `respawn` | `obj.respawn` | `{}` |
| `lowHp` | starts/stops the `hit.heartbeat` timer; `band === -1` stops it | `{intensity: band}` |
| `surge` | `obj.surge` | `{}` |
| `heroPick` | `ui.pick` | `{}` |
| `matchEnd` | `draw ? 'ann.draw' : won ? 'ann.victory' : 'ann.defeat'` | `{delay: 0.35}` after stopping music+ambience |
| `ancientThreat` | `obj.klaxon` | `{}` |

- **Cap `engine.play` calls at `MAX_PLAYS_PER_SNAPSHOT` per snapshot**, dropping by `EVENT_PRIORITY`
  worst-first. The e2e and verify gates run the match at `speed: 20` (~400 snapshots/s); derivation
  is pure and cheap and always runs, but unbounded WebAudio node construction at that rate is what
  would turn those two green gates red.
- `snapshot(snap)` additionally: updates `MusicIntensity` from `TENSION` with `TENSION.holdS`
  hysteresis; updates `setBattleIntensity` from nearby combat density; sets
  `engine.setSubmerge(DERIVE.submergeHz)` while dead and `Infinity` on respawn; sets the ambience
  scene to `'fountain'` when within `AMBIENCE.fountainRadius` of your own team's ancient entity and
  back to `'field'` outside it; drives the `hit.heartbeat` timer.
- `setWorld(ctx)` stores the `AudioWorldCtx` for use by `wire()` **and** `snapshot()`. Lobby-phase
  hero picks arrive before any snapshot, so without this stored identity `heroPick.self` could never
  be true.
- `event(ev)` feeds `deriver.wire()`. `ui(kind)` maps `UiCue` → `SoundId`. `countdown(n)` plays
  `obj.countdown`.
- `setPhase(p)`: `'menu'`/`'lobby'` → `amb.menu` + music intensity 1; `'live'` → `amb.field`, music
  start, and fire `obj.matchStart` on the menu/lobby→live transition only; `'dead'` → `amb.death` +
  submerge; `'ended'` → **stop music and ambience immediately**, then let the `matchEnd` routing fire
  the sting into the silence. Ordering is the point.
- `tick(dtMs, listener)`: forward the listener, pump `engine.tick`, `music.tick`, `ambience.tick`,
  and the heartbeat timer. **No allocation in this path.**
- Settings: load from `localStorage[STORAGE_KEY]` in try/catch, validate every field (clamp 0..1,
  boolean check), fall back to `DEFAULT_SETTINGS` on anything malformed. Persist on `setSettings`.
  Honoured **before the first sound plays**.
- `dispose()` stops everything and closes the context.

### T11 — `audio/lab.ts` + `audio/baseline.legacy.ts` + `games/rift/client/audio-lab.html` + `games/rift/client/vite.config.ts`

The render seam. **Without this there is no judge loop, so this task is as important as the cues.**

**Binding interface with T12 (the harness is already written against these — they are not negotiable):**

| Requirement | Exact value |
| --- | --- |
| Page path served by the platform server | `/rift/audio-lab.html` |
| `document.title` | `RIFT AUDIO LAB` — verbatim, all caps |
| New-build API global | `window.__riftAudio` implementing `AudioLabApi` |
| Baseline API global | `window.__riftAudioBaseline` implementing `BaselineLabApi` |

The title check exists because the platform server serves the game's `index.html` with HTTP 200 on
any miss — without it, a missing lab page looks like a successful load and the harness would grade
the wrong document. Both globals must be assigned before the page signals ready.

**`audio/baseline.legacy.ts`** — a copy of the current `games/rift/client/src/ui/audio.ts`, modified
in exactly these ways and no others (**no gain value, frequency, envelope or node topology may
change** — it is the "before" picture and must be an honest one):
1. `createAudio()` → `createBaselineAudio(ctx: BaseAudioContext, dest: AudioNode)`, using the
   injected context and destination.
2. Retype every internal `AudioContext` annotation (there are nine, including the
   `ctx: AudioContext | null` field) to `BaseAudioContext`. `BaseAudioContext` has no `resume`, so
   leaving them is a type error, not a nicety.
3. Delete the `new Ctor()` construction; use the injected `ctx`.
4. Replace `comp.connect(ctx.destination)` with `comp.connect(dest)`.
5. **Replace `ensure()`'s body with graph construction followed by `return true`**, deleting the
   `ctx.state === 'suspended' → resume()` gate and the `ctx.state !== 'running'` guard in `setWind`.
   An `OfflineAudioContext` is `'suspended'` until `startRendering()`, so leaving those guards makes
   the baseline schedule **nothing** — every "before" render would be digital silence, every
   spectrogram blank, and the blind A/B would be run against an empty image while the harness
   reported green.

**`audio/lab.ts`** — assigns `window.__riftAudio: AudioLabApi` and
`window.__riftAudioBaseline: BaselineLabApi`.
- `renderCue(id, seconds, offsetM)`: `new OfflineAudioContext(2, seconds * 48000, 48000)`, build the
  full graph + engine with `DEFAULT_SETTINGS`, **call `engine.setListener(...)` with the scene
  listener `{x: 56, z: 56, height: 36}` first**, then `engine.play(id, {x: 56 + offsetM, z: 56})`,
  `startRendering()`. `preLimit*` are null here. (Forgetting the listener leaves it at the origin,
  puts every world cue 79 m away — beyond `audibleRadius` — and renders silence that passes.)
- `renderScene(name, seconds)`: `new OfflineAudioContext(4, (seconds) * 48000, 48000)` with a
  `ChannelMerger`: post-limiter → channels 0/1, `engine.preLimit` → channels 2/3. Set the scene's
  listener, ambience scene and music intensity; **pump `music.tick`/`ambience.tick` from
  `-preRollS` to `0` in fixed `MUSIC.offlineStepS` increments before scheduling any step** (the
  fixed step also keeps the RNG draw order identical run to run); then schedule every `SceneStep`
  via `engine.play(step.id, {...step.opt, delay: step.atSec})` and continue pumping across the
  timeline. Return all four channels.
- `ids()` returns every `SoundId` in the merged registry.
- Baseline `render(id, seconds)` drives `createBaselineAudio` with a synthetic `RiftEvent` or `ui()`
  call matching `id`.

**`audio-lab.html`** — a bare page loading `src/audio/lab.ts` as a module, with
`<title>RIFT AUDIO LAB</title>` (the harness asserts on this title; the platform server falls back
to the game's `index.html` with a 200 on any miss, so without a title check a misconfigured build
silently serves the game and fails with a confusing error).

**`vite.config.ts`** — add `build.rollupOptions.input` listing **both** `index.html` and
`audio-lab.html`. Omitting `index.html` would delist the game. Change nothing else in that file.

Gate: your files typecheck; `npm run build -w @rift/client` emits both HTML files.

### T12 — `scripts/audio-render-rift.mjs`

The capture harness — the audio equivalent of the screenshot script. Follow the shape of
`scripts/verify-rift.mjs` (read it first): serve the built platform, drive puppeteer, print a JSON
manifest as the **last stdout line**, exit non-zero on failure. Do **not** add anything to the root
`package.json`; that file is orchestrator-owned and the integrator adds the script entry.

- Serve the **built** client (assume `npm run build -w @rift/client` already ran). Launch puppeteer
  with `verify-rift.mjs`'s args minus `--mute-audio`, navigate to `/rift/audio-lab.html`, and
  **assert `document.title === 'RIFT AUDIO LAB'`** before anything else.
- For every `SoundId`, every `SceneName`, and every baseline id, render and compute **in-page**:
  `peakDbfs`, `truePeakDbtp` (4× oversampled), `rmsDbfs`, `crestDb`, `attackMs` (to 90 % of peak),
  `lengthMs` (to −60 dB), `spectralCentroidHz`, `bandEnergyPct` over
  `[0-120, 120-400, 400-800, 800-2000, 2000-4000, 4000-20000]`, `stereoCorrelation`,
  `clippedSamples`; for scenes additionally `limiterActivePct` computed from the **pre-limit**
  channels (`|x| > db(LIMIT_CEILING_DB)`).
- Render every world cue **twice**: at the listener (`offsetM: 0`) and at `offsetM: 18`. The offset
  render is what evidences pan and distance-scaled reverb.
- Write per item: 16-bit stereo **WAV** to `screenshots/rift-audio/wav/<id>.wav`, and a **PNG** with
  a stacked waveform + log-frequency spectrogram (offscreen canvas in-page, `toDataURL`) to
  `screenshots/rift-audio/png/<id>.png`. Minimum 1200×700, dark background, dB colour scale,
  legible axes — the judge reads these images.
- **Also write an anonymised blind set**: for each entry in `pairs`, emit
  `screenshots/rift-audio/ab/<n>-A.png` and `<n>-B.png` captioned only "A"/"B" plus the metric
  sheet — **no id, no vocabulary tell** — with the A/B side chosen by the seeded RNG and the key
  recorded only in `metrics.json`. Labelled panels (`rift_kill` vs `die.hero`) would identify the
  legacy side in every pair and reduce the pass/fail bar to a caption.
- `pairs` mapping: `rift_kill`→`die.hero`, `rift_structure`→`obj.tower`, `rift_cast`→`cast.hex.0`,
  `rift_surge`→`obj.surge`, `rift_end`→`ann.victory`, `click`→`ui.click`, `buy`→`ui.buy`,
  `error`→`ui.error`, `levelup`→`ui.levelUp`.
- Emit `screenshots/rift-audio/metrics.json` with every measurement plus `pairs`.
- **Assert and fail (non-zero exit) on all of the following.** Revision 1's assert list was entirely
  upper bounds, so a build in which every single cue rendered silence would have exited 0:
  - *Silence floors (every rendered item, including baselines):* `rmsDbfs > -70` and `peakDbfs > -60`.
  - *Headroom:* any `truePeakDbtp > TRUE_PEAK_GATE_DBTP`; any `clippedSamples > 0`; any scene
    `limiterActivePct > 2`.
  - *Sub-bass weight:* `obj.ancient.bandEnergyPct[0-120] >= 45`; `obj.tower` and `obj.guard` `>= 35`.
  - *Attack crispness:* every `atk.*` — `attackMs < 8`, `lengthMs < 200`, `crestDb > 8`.
  - *The info-register law:* every non-`info` cue (everything not in `ui.*`/`ann.*`) —
    `bandEnergyPct[800-2000] + [2000-4000] + [4000-20000] <= INFO_BAND_MAX_PCT`.
  - *The chime cuts through:* in `lastHitInFight`, the 2–4 kHz band energy in the 120 ms window at
    the chime onset is `>= 8 dB` above the same band in the 500 ms preceding it.
  - *Dynamic range:* `laning.rmsDbfs <= -30` and `teamfight.rmsDbfs >= -18`.
  - *Hero distinctness:* within each hero, the minimum pairwise `spectralCentroidHz` separation
    across its four slots `>= 15 %`.
  - *Space:* every world cue's `offsetM: 18` render has `|stereoCorrelation| < 0.98`.
  - Any page or console error; any `SoundId` that failed to render.

### T13 — `audio/derive.test.ts`

Vitest suite for T3, node environment, **no WebAudio, no DOM**. Build small synthetic `SnapMsg`
objects and assert the derived events. Cover at minimum:
- first snapshot emits nothing but establishes the baseline;
- an `atk` transition emits exactly one `attack`; the same `atk` next snapshot emits none;
- an entity losing ≥ `hitMinHp` emits `hit`; losing less emits none;
- a vanished creep inside vision emits `unitDeath`; outside vision emits nothing;
- **passive gold trickle (a fractional delta below `goldMinDelta`) emits NOTHING** — assert this
  across 20 consecutive snapshots, because the failure mode is a UI cue 20×/s all match;
- gold delta ≥ `lastHitMinGold` **with** a same-snapshot `unitDeath` ⇒ `lastHit: true`; without ⇒ false;
- crossing 0.3 and 0.15 HP emits `lowHp` with band 0 then 1, once each; recovering emits `band: -1`
  and re-arms;
- **`abilityReady` is computed against `matchTick`, not `tick`** — construct a snapshot where the two
  differ and assert the event fires on the matchTick crossing and not the tick one. This is the
  single easiest thing in the whole build to get silently wrong;
- `hurt` carries the player's own x/z;
- `heroDeath.friendly` resolves correctly from `snap.board` for an ally, an enemy, and an
  unresolvable victim;
- `wire()` on `rift_pick` with `hero: null` emits nothing;
- `snap.you === null` never throws; out-of-order snapshot returns empty; `reset()` restores
  first-snapshot behaviour;
- `wire()` on `rift_cast` for **all 24** hero/slot combinations produces the documented `CastColour`
  and `ult` flag — this is the table most likely to rot.

Gate: `npx vitest run games/rift/client/src/audio` green.

### T14 — `audio/settingsPanel.ts` + `games/rift/client/src/style.css`

Export `createAudioSettingsPanel(parent: HTMLElement, audio: RiftAudioHandle):
{ readonly root: HTMLElement; setOpen(open: boolean): void; destroy(): void }`.

- Follow the repo's panel convention exactly (read `games/rift/client/src/ui/shop.ts` first): an
  `el()`-style builder, a single top-level class `.audio-panel`, children `.audio-panel-row`,
  `.audio-panel-slider`, `.audio-panel-mute`, `.audio-panel-toggle`. Descendant selectors for
  everything else. These four classes are added to the game's DOM class contract by the Audio
  amendment in `games/rift/CONTRACT.md` — do not invent a fifth.
- **The panel is self-contained and includes its own toggle button** (`.audio-panel-toggle`, a small
  fixed-position speaker glyph) that opens and closes it. Nothing else in the client can reach it —
  `UiActions` has no audio verb and adding one would mean editing modules nobody owns.
- Four sliders (master / SFX / music / ambience) and a mute toggle, wired to `audio.setSettings`
  live, initialised from `audio.settings()`.
- Every slider has a visible label and a visible percentage. Text ≥ 12 px. Keyboard-operable —
  native `<input type="range">`, do not hand-roll.
- Colours from the existing CSS variables (`--ink`, `--stone-deep`, …). No new hex values.
- Append your CSS to the END of `style.css` under a clearly delimited comment block. **Do not modify
  any existing rule in that file.**
- Fire `ui.click` on slider release; the gain change itself applies within one frame.

---

## Integration (orchestrator only — no implementer touches these)

Authorised by the **Audio amendment** in `games/rift/CONTRACT.md`.

1. `client/src/contract.ts` — re-export `RiftAudioHandle` as `AudioHandle`.
2. `client/src/wire.ts` — construct from `./audio/index.js`; mount `createAudioSettingsPanel(root,
   audio)`. The panel is mounted **here**, not in `game.ts`: `game.ts` is architecturally forbidden
   from importing an implementation module.
3. `client/src/game.ts`:
   - hoist a preallocated `AudioWorldCtx` field and a preallocated `ListenerState` field, mutated in
     place — the repo forbids per-frame allocation in hot paths;
   - call `audio.setWorld(ctx)` once `rift_hello` lands and whenever `selfEntId` changes;
   - call `audio.snapshot(msg)` in `onSnap` **immediately after the `selfEntId` loop and before the
     fog refresh** — earlier and `self` is wrong by one snapshot, later and the audio and the visual
     burst disagree about whether a death was visible;
   - call `audio.tick(dtMs, listener)` in `step`;
   - call `audio.resume()` on the first pointer/key event;
   - add `audio.setPhase('lobby')` on lobby entry, and a `wasDead` transition computing
     `you.respawnAtTick > 0 && msg.matchTick < you.respawnAtTick` to drive `setPhase('dead')` /
     `setPhase('live')`;
   - in the `rift_end` case, reorder so `audio.setPhase('ended')` runs **before**
     `audio.event(ev)` — the sting must land in silence — and add the same `setPhase('ended')` to the
     `msg.phase === 'ended'` branch of `onSnap`;
   - drive `audio.countdown(n)` once per whole second from `lobby.countdownEndsAt` and from
     `you.respawnAtTick - snap.matchTick`;
   - route `toggleShop` to `ui('shopOpen')`/`ui('shopClose')` and the cast-denied path to
     `ui('toast')`.
4. Delete `client/src/ui/audio.ts`.
5. Root `package.json` — add `"audio:rift": "node scripts/audio-render-rift.mjs"`.
