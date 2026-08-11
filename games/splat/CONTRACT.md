# SKI SPLAT — FROZEN CONTRACT

First-person downhill ski racing. 2–8 players race one procedurally generated
slope per round; first across the finish wins. Steering is the ONLY input;
plants slow you on contact. Tablet (two thumb zones) is a primary device.

This document + the files listed below are the **immutable contract**. Every
implementer works against it. **You may not modify contract files, another
task's files, or add files outside your ownership list.** You implement bodies
and private helpers inside your own files only.

Siblings: `DESIGN_BIBLE.md` (intent + balance targets), `STYLE_BIBLE.md`
(art direction), `UX_BIBLE.md` (comprehension + control). They are frozen too.

*(Post-gauntlet revision: sim clock, yaw clamp, drag/density retune, wire
slimming, ownership closures, wave plan. The prep panel's fatal/major findings
are all resolved in this text.)*

---

## §0 Envelope

**In:** multiplayer rooms (2–8) on the existing platform; one seeded
procedural slope per match; first-person descent; plants that slow on contact;
race to a finish line; assist mode; keyboard + tablet touch; per-game PWA;
synthesized audio.

**Out (v1):** paint/territory (the old SPLAT), teams, items, tricks,
lifts, repeated runs, ghosts, leaderboards, persistence, chat, bots, day/night.

---

## §1 Frozen files (Layer 1 — code)

- `games/splat/shared/src/config.ts` — every constant (tick rates, sim tuning,
  slope params incl. frozen undulation octaves + cluster params, plant params,
  race flow). Pure data, no logic. FROZEN NOW.
- `games/splat/shared/src/types.ts` — wire types, `SkierSim`, `SlopeDef`/
  `Plant`/`PlantKind` interfaces. FROZEN NOW. (The SlopeDef interface lives
  here precisely so P1's sim and P2's slope generator never block each other.)
- `games/splat/shared/src/protocol.ts` — `parseSplatC2S` (total, clamping,
  never throws). FROZEN NOW.
- `games/splat/shared/src/palette.ts` — `SPAL`, `SKIER_COLORS` (8, verified
  vs snow + protan/deutan), `SKIER_GLYPHS`. Pure data. FROZEN NOW.
- `games/splat/shared/src/slope.ts` — bodies are task P2's; the exported
  signatures in §7 are frozen here. Lands in wave 1.
- `games/splat/shared/src/sim.ts` — bodies are task P1's; the exported
  signatures in §7 are frozen here. Lands in wave 1.
- `games/splat/shared/src/index.ts` — barrel. FROZEN NOW: it re-exports only
  config/palette/protocol/types. Tasks import slope/sim directly
  (`@splat/shared/slope.ts` — the package's `"./*": "./src/*.ts"` exports map
  makes deep imports legal). **Nobody edits the barrel after freeze.**
- `games/splat/client/src/contract/visual.ts` — the shared visual vocabulary:
  `box/cyl/cone/sphere/at/bake` factories + `SPAL` re-export for the client
  (cloned from the kart `trackMesh.ts` pattern). Lands with task R1.

**Scaffold is not a task.** The orchestrator produces, BEFORE any fan-out:
per-package `package.json`/`tsconfig.json`, `client/vite.config.ts`,
`client/index.html` skeleton, `client/src/main.ts` boot skeleton, root
`package.json` dev/build wiring, `vitest.config.ts` alias + include globs for
all three splat packages. No implementer creates or edits these.

## §2 RULES (every implementer, no exceptions)

1. **No contract edits.** Missing something? Private helpers in YOUR files.
2. **No stubs, no TODOs, no placeholder returns.** Complete implementations.
3. **Strict TypeScript.** No `any`, no `@ts-ignore`, no non-null `!` unless
   provably safe. `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`.
4. **Imports:** `@splat/shared` (incl. deep imports of slope.ts/sim.ts),
   `@platform/shared`, `three` (client only), `node:*` (server only), and the
   exact exports in your module-table entry. Nothing else crosses module
   boundaries. Type-only imports of frozen types are always legal.
5. **All colours from SPAL.** Meshes only via `contract/visual.ts` factories;
   static geometry baked via `bake()`; plants instanced via R2's `PlantField`.
   Exemptions (colours still from SPAL): sky-dome `MeshBasicMaterial`,
   **terrain heightmap geometry**, **distant-peak horizon cards**, particle
   `THREE.Points` (incl. snow sparkle), HUD DOM, and **skier chest-glyph decal
   sprites** (CanvasTexture, one per skier).
6. **Determinism:** gameplay + procedural layout use `rng(seed)` from
   `@platform/shared` only. `Math.random` is a violation everywhere; the
   server's non-gameplay picks (room ids, codes, slope seed) use
   `rng(Date.now())`.
7. **No per-frame allocation in hot paths** (render loop, sim tick, snapshot
   build): reuse objects, pool particles, mutate pooled wire objects.
8. **Robustness:** one bad message/exception never kills the server or
   white-screens the client. Handlers wrapped; window blur clears held input;
   resize handled; WebGL failure shows a readable error div; audio init
   failures are silent no-ops.
9. **Gates** (proven able to fail before their green is trusted). Per-task
   gate = `node node_modules/typescript/bin/tsc --noEmit -p <your workspace>`
   (invoked directly, `$?` captured — never trust rtk) + your own vitest
   suites. Root `npx vitest run` and `npm run build` are INTEGRATION gates
   (orchestrator-run), not per-task gates — they stay red until every package
   exists.
10. **The design law** (DESIGN_BIBLE pillars): if a change plays better for an
    adult but worse for a 4-year-old, it does not ship. No wipeout, no stuck
    state, no elimination, no shame on the results screen.

## §3 Architecture overview

- **Server** (`games/splat/server`): authoritative room on the platform's
  `GameModule` contract. Sim tick 30 Hz, snapshots 20 Hz, intent-only wire,
  per-player input queues with seq watermarks, speedhack budget.
- **Client** (`games/splat/client`): Vite + three.js. Prediction for own
  skier (shared step + replay), interpolation for remotes, first-person camera
  rig, DOM HUD/menus, WebAudio-synthesized SFX, touch + keyboard input.
- **Shared** (`games/splat/shared`): the slope generator, the ski step, the
  predictor, wire protocol, palette, config. **Pure:** no `window`, no `Date`,
  no `Math.random`, no I/O.

## §4 Conventions

- `serverTime` = server `Date.now()` ms. Client estimates offset from
  `joined.serverTime` + `pong.serverTime` (EMA 0.2), like kart.
- Coordinates: metres. **+Z is downhill** (the fall line). x is lateral
  (positive = skier's right facing downhill). y = terrain height.
- `yaw`: radians, 0 = facing +Z (straight down the fall line), positive =
  turning toward +x. Soft-clamped to ±YAW_MAX (§6).
- Skier state is FEET position. Eye = y + EYE_HEIGHT.
- **Sim time:** `SkierSim.simMs` accumulates `dt*1000` inside stepSki. Both
  peers replay the same (steer, dt) sequence, so sim-ms fields are bit-
  deterministic across server and client prediction. ALL gameplay timers
  (snare, rearm, immunity, finishMs) are sim ms, never wall clock, never ticks.
- Room phases: `'lobby' —[{t:'start'}]→ 'countdown' (3s) → 'racing' →
  'results' (8s) → 'lobby'`. Manual start only, any seated player, ≥
  MIN_PLAYERS, silently ignored otherwise. Nothing auto-starts.
- **Late joiners** wait for the next round: they receive `splat_joined` with
  the live phase, are EXCLUDED from `players[]` and place computation, get a
  parked `you.sim` at the gate, and the client shows the lobby screen. They
  become racers at the next countdown.
- **Disconnects mid-race:** the seat ghosts (sim keeps its last state, no
  `player_left` until results). On rejoin the platform's `resume` param rebinds
  the seat (same slot, sim intact); the client restores its predictor from the
  next snapshot's `you.sim`. Ghost seats are swept at results.
- Slope: generated from a seed the server picks at countdown entry
  (`rng(Date.now())`), or from room settings `{seed}` when provided (dev/e2e
  only). The seed rides every snapshot; clients regenerate the identical slope
  locally and rebuild terrain when the seed changes (rematch = new mountain).
  `-1` = no race yet.
- Message tags are `splat_*` prefixed, EXCEPT the bare `{t:'start'}` (the
  repo's frozen start convention). Rooms are per-game; no cross-game collision.
- Start grid: slot i → `row = floor(i / START_PER_ROW)`,
  `x = (i % 4 - 1.5) * START_ROW_SPACING`, `z = -row * START_ROW_SPACING`.

## §5 Wire protocol (frozen — full text in shared/src/types.ts)

```ts
// Client -> server
| { t: 'splat_input'; seq: number; steer: number; dt: number }
   // steer -1..1, POST-ramp and POST-assist-EMA (input layer owns both).
   // The sim applies no ramp and no EMA; server trusts wire steer.
| { t: 'splat_assist'; on: boolean }   // any time, incl. mid-race
| { t: 'start' }

// Server -> client
| { t: 'splat_joined'; code; you; slot; phase; seed; serverTime;
    players: RosterEntry[] }            // RosterEntry = {id, name, slot}
| { t: 'splat_roster'; players: RosterEntry[] }   // on any join/leave
| { t: 'splat_snapshot'; tick; serverTime; phase; seed; countdown;
    phaseEndsAt; playerCount; minPlayers; canStart;
    you: { lastProcessedSeq; sim: SkierSim };
    players: SkierSnap[] }              // racers, INCLUDING the recipient
| { t: 'splat_event'; ev: SplatEvent }  // plant_hit | gate | finished | player_left
```

`SkierSnap` carries `slot` but NOT name/color/glyph — the client maps
slot → identity from the roster (bandwidth law). `plantIx`/`gateIx` ALWAYS
index `SlopeDef.plants`/`SlopeDef.gates` (R2 precomputes the per-kind
instance remap at build). Places are computed server-side each tick (finished
by finishMs, racing by z, ties by slot). Wire objects are pooled and mutated
in place, bound once per recipient (the kart pattern).

## §6 The sim (frozen semantics — body is P1's)

`stepSki(sim, steer, dt, slope, opts?)` per input:

- **Sim clock first:** `sim.simMs += dt * 1000`.
- **Gravity along heading:** `a = G_ACCEL * slope.gradeAt(x, z, yaw)
  - DRAG * v²`. gradeAt ≥ GRADE_MIN everywhere by construction (config),
  so a skier never rolls backward.
- **Steering:** yaw rate = `steer * TURN_RATE(v)` — TURN_RATE lerps
  TURN_RATE_BASE → TURN_RATE_MIN as v goes 0 → MAX_SPEED (wider carve when
  fast). Carving scrubs speed: `v *= 1 - CARVE_SCRUB * |steer| * dt *
  (v / MAX_SPEED)`. **Yaw is soft-clamped:** beyond ±YAW_MAX a spring
  (`YAW_SPRING` rad/s² per rad) pushes yaw back toward the fall line — a
  full-lock skier spirals out and rejoins the descent, never donuts.
- **Motion:** position integrates along heading:
  `x += sin(yaw) * v * dt; z += cos(yaw) * v * dt` (yaw 0 = +Z downhill).
- **Bounds:** `MIN_SPEED ≤ v ≤ MAX_SPEED` (halved while snared). MIN_SPEED
  > 0 everywhere (no stopped state).
- **Plant contact (server + prediction, same code):** query
  `plantGrid(k-1..k+1)` for `k = floor(z / PLANT_BAND_M)`; circle-test with
  `plant.r * (assist ? ASSIST_PLANT_RADIUS_MUL : 1) + SKIER_RADIUS`. On
  contact with plant `ix` when BOTH `ix ≠ lastPlantIx` (or rearm expired:
  `simMs - lastPlantHitMs ≥ PLANT_REARM_MS`) AND `simMs - lastPlantHitMs ≥
  PLANT_IMMUNITY_MS`: `v *= PLANT_HIT_SPEED_MUL`;
  `snareUntilMs = simMs + PLANT_SNARE_MS * (assist ? ASSIST_SNARE_MUL : 1)`;
  `lastPlantIx = ix`; `lastPlantHitMs = simMs`; the SERVER emits
  `plant_hit { id, plantIx: ix, x, z }`. Contact never zeroes v. The immunity
  window bounds event/FX spam in dense clusters.
- **Assist in the sim is ONLY:** plant radius ×0.8, snare duration ×0.75,
  edge pushback ×1.4. Steer EMA + steer-rate narrowing live in the CLIENT
  input layer (§5: wire steer is already smoothed).
- **Soft edges:** beyond `|x| > width/2 - EDGE_ZONE`, an inward lateral
  acceleration grows quadratically with depth
  (× `ASSIST_EDGE_MUL` when assisting), curving a full-lock skier back
  inside. No wall, no stop.
- **Slalom gates (server + prediction, same code):** `slope.gates` is
  ascending-z. When the skier's z crosses gate `ix`'s z this step
  (`prevZ < g.z ≤ newZ`), `ix > lastGateIx`, AND `|x - g.x| ≤ g.halfWidth`:
  `v = min(v + GATE_BOOST_V, current cap)`, `boostUntilMs = simMs +
  GATE_BOOST_MS`, `lastGateIx = ix`; the SERVER emits `gate { id, gateIx,
  x, z }`. While `simMs < boostUntilMs` the speed cap is GATE_BOOST_MAX
  instead of MAX_SPEED (the snare half-cap still wins if both apply: cap =
  min(half-cap, boost-cap)). Crossing OUTSIDE the opening still advances
  `lastGateIx` (a missed gate is gone — no circling back), grants nothing.
  Gates never interact with plants' rearm/immunity.
- **Skier-skier (server only, `resolveSkiPair`):** soft pairwise push apart,
  momentum kept, never a disable.
- **Finish:** `z ≥ finishZ` → `finished = true`, `finishMs = simMs`, sim
  freezes (input still acked; the client camera keeps gliding on runout).

## §7 Module table (tasks + exclusive file ownership)

**Wave 1** (depend on frozen types/config only): P1 ∥ P2.
**Wave 2** (need wave-1 bodies for tests): V1, R1, R2, C1, C2, C3, C4.
**Wave 3** (need a registered game): P3, E2E.
Per-task gates are workspace-scoped (§2.9); integration gates are the
orchestrator's.

### P1 — shared sim (`games/splat/shared/src/sim.ts`, `sim.test.ts`)
```ts
export interface SkiInput { steer: number; dt: number }
export interface SkiStepOpts { assist?: boolean }
export function makeSim(x: number, z: number, yaw: number): SkierSim;
export function resetSim(s: SkierSim, x: number, z: number, yaw: number): void;
export function copySim(dst: SkierSim, src: Readonly<SkierSim>): void;
export function stepSki(s: SkierSim, steer: number, dt: number,
  slope: SlopeDef, opts?: SkiStepOpts): void;   // §6 semantics, exactly
export function resolveSkiPair(a: SkierSim, b: SkierSim): void;  // server-only
export class SkiPredictor {
  constructor(slope: SlopeDef, opts?: SkiStepOpts);
  setAssist(on: boolean): void;   // C1 calls on splat_assist toggle
  push(inp: SkiInput): void;                 // apply now + queue for replay
  reconcile(auth: Readonly<SkierSim>, ackSeq: number): number;  // correction m
  state(): SkierSim;
  pendingCount(): number;
  reset(x: number, z: number, yaw: number): void;
}
```
`SkierSim`/`SlopeDef` come from types.ts. Tests: determinism (same
seed/inputs → bit-identical), never-stops (v ≥ MIN_SPEED for 10k random
inputs on 5 seeds), plant hit + immunity + rearm semantics, snare binding,
edge containment AND yaw-clamp (full-lock both directions always finishes —
the 4-year-old test — on fixture slopes), predictor convergence, NaN-free
10k inputs. Fixtures: construct plain SlopeDef objects (the interface is
frozen; no dependency on P2).

### P2 — shared slope (`games/splat/shared/src/slope.ts`, `slope.test.ts`)
```ts
export function genSlope(seed: number): SlopeDef;
export function validateSlope(s: SlopeDef): string[];  // violations; [] = ok
```
Terrain: `-GRADE_BASE*z` + the frozen undulation octaves (config), phases
from `rng(seed)`. Plants: seeded cluster-Poisson using the frozen cluster
params; density ramping PLANT_DENSITY_START → FULL across the first
PLANT_DENSITY_RAMP of the planted zone; ZERO plants within START_CLEAR of the
gate or FINISH_CLEAR of the line. Kinds: solo plants lean bush/thorn at full
density, clusters lean pine — exact mix is P2's within the style law.
`validateSlope` asserts: gradeAt ≥ GRADE_MIN on a dense sample grid; zero
plants in both clear zones; a CONNECTED plant-free corridor of width ≥
PLANT_CORRIDOR_M exists from gate to finish whose centreline moves ≤
CORRIDOR_MAX_SHIFT_M per PLANT_BAND_M band (a weaving line can hit zero);
full-lock-both-directions reaches the finish on 20 seeds (uses P1's stepSki —
cross-import legal in TESTS only; this suite runs in wave 2 at integration).
P2's own gate = the analytic validators + density/clear-zone tests.

### V1 — server room (`games/splat/server/src/{room.ts, room.test.ts, module.ts}`)
`module.ts` exports `splatModule: GameModule` — id `'splat'`, name
`'SKI SPLAT'`, devPort **5178**, minPlayers 2, maxPlayers 8, `clientDist` via
the repo's multi-candidate probe pattern. Settings: accept `undefined`,
`{}`, or `{seed: number}` (dev/e2e slope override); throw otherwise.
Room: the kart room.ts discipline — own `setInterval`s (sim 30 Hz, snapshots
20 Hz), per-player input queues (seq-gated FIFO, INPUT_QUEUE_CAP), speedhack
sim-time budget, plant-hit + finished events, places, the §4 phase machine,
late-joiner parking and ghost-seat rebind per §4, pooled snapshots,
`stalePlayers()` (INPUT_STALE_MS). Handles `splat_assist` at any phase:
stored per player, fed to stepSki opts, NEVER broadcast (invisible to others).
Broadcasts `splat_roster` on join/leave. Tests: join/start/race/finish flow
with a fake RoomIO; plant + finished event emission; places; results→lobby;
start-invariants; late joiner parked then racing next round; rematch new
seed; `{seed}` settings override; **snapshot size ≤ 2 KB at 8 players**
(JSON.stringify assert).

### R1 — client scene & terrain (`render/scene.ts`, `render/terrain.ts`,
`contract/visual.ts`, `render/gates.ts`)
`visual.ts`: the frozen factories (kart `trackMesh.ts` pattern, SPAL-bound).
`SplatScene` class: WebGLRenderer (ACES, sRGB, PCFSoft), sky dome, sun +
hemisphere fill, FogExp2 matched to `skyHorizon`, grade/vignette post,
`buildTerrain(slope)` (baked heightmap mesh, vertex-coloured snow:
`snowLit` sun-facing / `snowShade` shadow side from `height()` normals),
mountain dressing (rock outcrops, distant peak cards, instanced mature-pine
forest walls OUTSIDE the piste — up to ~3k visual instances total with R2's
plants), `gates.ts`: start gate, FINISH GATE (`sunGold` pennants — the goal
read) and the lodge with chimney smoke (STYLE_BIBLE model sheets).
`setCamera(...)`: the first-person rig — FOV-speed (BASE_FOV + up to
SPEED_FOV_MAX), carve roll ≤ ~4°, micro-shake by speed, dip-spring (plant
hits retrigger it), teleport guard. `prewarm()`, `resize()` (DPR ≤ 2),
`render()`, `drawCalls()` (telemetry for e2e).

### R2 — plants & skiers (`render/plants.ts`, `render/skiers.ts`,
`render/fx.ts`)
`PlantField`: one `InstancedMesh` per kind (pine/bush/thorn) from
`slope.plants`, archetypes per STYLE_BIBLE model sheets (snow-dusted tips),
per-instance squash/shake on `hitPlant(plantIx)` (plants are NOT consumed),
precomputed plants[]-index → (kind, instance) remap, distance culling beyond
150 m. `Skiers`: remote skier visuals (per-material-merged per skier — the
kart pattern; articulation via pivot groups, NOT per-primitive meshes, so 7
remotes stay within the draw-call budget), colour + chest glyph decal sprite,
lean-into-carve from snap.steer; own first-person skis + boots at frame
bottom, angling with steer. `fx.ts`: pooled `THREE.Points` systems — carve
snow spray, plant-hit powder puff, finish confetti, snow sparkle near camera;
`burst(kind, x, y, z)`; zero per-frame allocation; ≤ 512 live particles.

### C1 — input (`client/src/drive.ts`, `drive.test.ts`)
`DriveController`: keyboard (←/→, A/D) + `TouchPointers` (the kart class,
cloned and trimmed to two zones: left/right half of screen) + external
`setInput()` latch (debug/e2e), merged additively. Both keyboard and touch
ramp to full lock over STEER_RAMP_S. Assist mode: steer EMA
(ASSIST_STEER_EMA) + narrowed max steer rate, applied HERE — the wire carries
the smoothed value. Owns the `SkiPredictor`: immediate `push` per SIM_DT
accumulated from rAF dt; outbox `flush(send)`; `reconcile(auth, ackSeq)` with
the kart visual-error decay; `setAssist` forwarded to the predictor on toggle.
DOM-free and unit-tested (the four multi-touch cases: both down / lift one /
slide across / pointercancel).

### C2 — app orchestrator (`client/src/app.ts`, `style.css`)
Net (ws `/ws`, clock offset EMA, pong), roster map (slot → identity from
splat_joined/splat_roster), lobby/menu/settings screens (QUICK PLAY, room
code, player list with colours + glyphs, settings chips: TABLET CONTROLS,
LEFT-HANDED — mirrors HUD chip layout only, ASSIST), phase screens, interp
buffers for remotes (`serverNow() - INTERP_DELAY_MS`, velocity extrapolation
≤ EXTRAPOLATE_MAX_MS), reconnect (persist player id in localStorage, rejoin
with the platform `resume` field, restore predictor from next `you.sim`),
terrain rebuild on seed change, the `window.__splat` debug surface
(`state()/telemetry()/joinQuick/startRace(seed?)/setInput(steer)` —
startRace forwards `{seed}` in create settings when provided), wake lock.
`style.css`: global/menu/lobby/screens CSS, touch-safety (touch-action none,
no zoom, no overscroll), safe-area vars, the kart scrim/chip system.

### C3 — HUD (`client/src/ui/hud.ts`, `client/src/ui/hud.css`, `hud.test.ts`)
DOM HUD per UX_BIBLE: place chip (28px+ numeral, scrim), speed chip, progress
rail (2D canvas, 4 Hz, player dots by slot colour), countdown overlay,
finished banner ("Finished — 42.3s", race continues behind), results panel
(proportional time bars + glyphs + crown on the winner; unfinished shown "on
the mountain" with distance covered, no shame), first-run steer hint (thumb
outlines, 3 s, once per localStorage). `hud.css` is C3's own stylesheet (the
scaffold links it from index.html). Built once, updated in place with
change-guards; no per-frame allocation.

### C4 — audio (`client/src/audio.ts`)
`SplatAudio` (kart WebAudio shape): `resume()` on gesture, idempotent, never
throws; continuous voices — wind (v² gain), carve noise (steer × v);
one-shots — plant rustle, countdown beeps, GO, finish fanfare, results sting;
distance attenuation for remote events. Gate: typecheck + a headless test
that `resume()` without a gesture is a safe no-op.

### P3 — plumbing & PWA (`platform/server/src/{registry.ts, index.ts}`,
`platform/server/package.json`, `platform/server/tsconfig.json`,
`deploy/Dockerfile`, `scripts/gen-pwa-assets.mjs`,
`games/splat/client/public/*`, `games/splat/shared/src/valueLadder.test.ts`)
Register `splatModule` (+ `@splat/server` dep and tsconfig path; root
package-lock rides along). Launcher: LPAL accent/tint, COPY, IDENTITY.splat,
`.card--splat`/`.mark--splat` CSS, and update the stale "four games" count
copy (there are six with splat). Dockerfile COPY lines (all three stages).
Icon/manifest generation: `GLYPHS.splat` + `GAMES` entry (paint-guard hex
from index.html, palette keys from palette.ts), run it, commit
`client/public/`. `valueLadder.test.ts`: clone the kart suite against
SPAL/SKIER_COLORS — ΔL* ≥ 25 plants vs snow, every skier colour ≥ 2.8:1 vs
snow, pairwise distinguishability under protan/deutan (worst pair ≥ 0.10),
SKIER_COLORS length === MAX_PLAYERS.

### E2E — `scripts/e2e-splat.mjs`
Clone the e2e-kart shell: build → spawn dist server → two puppeteer processes
→ zero page errors → private room via code → assert no-auto-start → START →
countdown → racing. Drive via `__splat`: own sim moves > 10 m; remote interp
sees it; with `startRace(seed)` fixed seed: a plant event fires; a full-lock
player finishes (SwiftShader note: SIM_DT_MAX clamps sim time under low fps —
assert finish OR hard-cap-with-progress, per §9.5); results shown; rematch
gets a new seed; `telemetry().drawCalls < 80`. Captures the §9.6 screenshot
set to `screenshots/`. Add `"e2e:splat"` to root package.json — via the
orchestrator, not by editing it yourself.

## §7a Client-internal API seams (frozen — wave 2 codes against these)

These freeze the boundaries BETWEEN client tasks so C2 never has to guess.
Implementations may add methods; these exact signatures may not change.

```ts
// R1 render/scene.ts
export class SplatScene {
  constructor(parent: HTMLElement);
  readonly world: THREE.Scene;              // R2 attaches here
  buildTerrain(slope: SlopeDef): void;      // idempotent, disposes prior
  setCamera(x: number, y: number, z: number, yaw: number,
            v: number, steer: number, dt: number): void;
  plantHit(): void;                         // retriggers the dip spring
  prewarm(): boolean;
  resize(): void;
  render(): void;
  drawCalls(): number;
}

// R2 render/plants.ts
export class PlantField {
  constructor(world: THREE.Scene, slope: SlopeDef);
  hitPlant(plantIx: number): void;          // squash/shake; not consumed
  update(dt: number, camZ: number): void;   // anims + distance culling
}
// R2 render/skiers.ts
export class SkierVisuals {
  constructor(world: THREE.Scene);
  add(id: string, slot: number): void;
  remove(id: string): void;
  update(id: string, x: number, y: number, z: number,
         yaw: number, steer: number, dt: number): void;
  setOwnSkis(steer: number, v: number, dt: number): void;
}
// R2 render/fx.ts
export type FxKind = 'spray' | 'puff' | 'confetti';
export class SplatFx {
  constructor(world: THREE.Scene);
  burst(kind: FxKind, x: number, y: number, z: number): void;
  update(dt: number, camX: number, camZ: number): void;
}

// C3 ui/hud.ts — C2 builds the state; render() is change-guarded
export interface HudRacer { slot: number; z: number; finished: boolean; finishMs: number }
export interface HudState {
  phase: Phase; countdown: number; speedKmh: number; place: number;
  total: number; you: HudRacer; racers: readonly HudRacer[];
  results: readonly HudRacer[] | null;      // non-null only in results
  colorFor(slot: number): string; glyphFor(slot: number): string;
}
export class SplatHud {
  constructor(parent: HTMLElement);
  render(s: HudState): void;
  showSteerHint(): void;                    // first-run, UX_BIBLE
}

// C4 audio.ts
export type SplatSfx = 'rustle' | 'beep' | 'go' | 'finish' | 'sting';
export class SplatAudio {
  resume(): void;                           // on every user gesture
  wind(speedFrac: number): void;            // per frame, 0..1
  carve(amount: number): void;              // per frame, 0..1
  sfx(kind: SplatSfx, opts?: { distance?: number }): void;
}

// C1 drive.ts — keyboard internal; touch wired by C2 through `touch`;
// debug/e2e via setInput (merged additively, the kart ext-latch pattern)
export class DriveController {
  constructor(slope: SlopeDef);
  readonly touch: {
    press(pointerId: number, side: 'left' | 'right' | null): void;
    retarget(pointerId: number, side: 'left' | 'right' | null): void;
    release(pointerId: number): void;
    clear(): void;
    isDown(side: 'left' | 'right'): boolean;
  };
  setInput(steer: number): void;            // external latch, -1..1
  setAssist(on: boolean): void;             // forwards to predictor
  step(dtMs: number): void;                 // per rAF
  flush(send: (m: SplatC2S) => void): number;
  reconcile(auth: Readonly<SkierSim>, ackSeq: number): number;
  reset(x: number, z: number, yaw: number): void;
  state(): SkierSim;
  steerVisual(): number;                    // ramped steer for skis/roll
}
```

---

## §8 Non-functional budgets (frozen)

- **Performance:** 60 fps on iPad Air-class hardware at 8 players (measured on
  device in Phase 4, reported honestly — headless CI cannot measure fps).
  Draw calls < 80 (scored: E2E telemetry assert). In-piste sim plants ≈ 150;
  visual instances (plants + forest walls + dressing) ≤ 3k. Terrain ≤
  128×256 segments. Pooled particles ≤ 512 live. Snapshot build
  allocation-free on the steady path. Memory: no growth over 10 races.
- **Load:** client bundle ≤ 1.5 MB (three.js included; kart ships 716 KB).
  Cold load to menu < 3 s on wifi. `prewarm()` before join.
- **Bandwidth:** intent-only wire; snapshot ≤ 2 KB at 8 players/20 Hz
  (scored: V1 room.test).
- **Robustness:** §2 rule 8. Sim NaN-free over 10k inputs (P1 test).

## §9 Gates & required evidence

1. Typecheck all workspaces green (§2.9 method) — integration.
2. `npx vitest run` — prior floor plus every new suite; collection verified
   explicitly (`--collect` lists the splat suites).
3. `npm run build` exit 0; `/splat/` served by the platform with SPA
   fallback; manifest + icons present in `games/splat/client/dist`;
   `/splat/sw.js` served by the PLATFORM (pwa.ts), not by the client dist.
4. `node scripts/e2e-splat.mjs` green.
5. **The 4-year-old test:** full-lock-both-directions finishes on 20 seeds
   (P1/P2 unit) AND in the e2e run (or hard-cap-with-progress under
   SwiftShader); report its time and plant hits honestly.
6. **Screenshots, looked at** (captured by the E2E task): first-person
   mid-descent at speed, a plant close-up, the finish gate, the results
   screen, the touch zones on an emulated iPad. Verified on pixels.
7. **Art-director + UX-director judge loops** (Phase 4) clear their bars
   against the STYLE_BIBLE benchmark and UX_BIBLE task list.

## §10 Precedence

DESIGN_BIBLE law > §1–§7 contract > budgets > prose > any task's judgement.
On conflict, stop and report — never renegotiate with a sibling task.

## §11 V2 AMENDMENT — JUMPS + GRAPHICS OVERHAUL (frozen with §1–§10)

This amendment extends the frozen contract. Where it conflicts with §1–§10 the
amendment wins for the v2 feature surface ONLY; everything else stands.

### 11.1 What changed (v2 delta)

- **Jumps are IN.** Two launch sources share ONE ballistic model: a MANUAL HOP
  (jump edge on the wire) and a KICKER RAMP (seeded ramps in the corridor).
  Air is pure upside — plants don't touch you mid-air, gates still boost, and
  landing is always safe (tiny scrub, no wipeout, no stuck state — the
  4-year-old law holds). Steering is damped in air (hold your line, correct on
  landing) — the decision is when and where to jump, never a hazard.
- **Wire:** `splat_input` gains an OPTIONAL `jump?: boolean` (edge: true on
  exactly ONE input per press; the sim consumes the edge). `SkierSnap` gains
  `airborne: boolean` (remote posing + landing FX; edge-derived, no new events
  — the bandwidth law stands: no jump/land events on the wire).
- **New slope entity:** `SlopeDef.kickers` (ascending z, seeded, corridor-
  anchored). `validateSlope` asserts the kicker placement laws (11.3).
- **New sim fields:** `airborne`, `airStartMs`, `airVy`, `airStartY`,
  `lastKickerIx` on `SkierSim` (11.2). `copySim`/`makeSim`/`resetSim` cover
  them. New pure helper `airHeight(s, x, z, slope): number` (shared/sim.ts —
  height above the CURRENT terrain; import via the deep path
  `@splat/shared/sim.js`).
- **New seam methods** (additive only — §7a signatures stand):
  - `scene.setAirborne(on: boolean): void` — camera air pose (FOV/shake/pitch)
  - `scene.land(): void` — landing dip spring + soft flash (plantHit stays)
  - `skiers.setRemoteAirborne(id: string, on: boolean): void`
  - `skiers.setOwnAirborne(on: boolean): void` — own-skis air tuck
  - `drive.setJump(): void` — one-shot jump edge latch (Space/↑ handled inside)
  - `hud.onJump(fn: () => void): void` — DOM JUMP button → drive.setJump()
  - `fx` gains `FxKind` members `'land'` and `'launch'`; pool budget rebalanced,
    still ≤ 512 live (§8)
  - `audio` gains `SplatSfx` members `'jump'` and `'land'`
- **Debug surface:** `window.__splat` gains `setJump()` (one-shot edge, like
  setInput but fires once). E2E drives jumps through it.

### 11.2 The jump sim (frozen semantics — body lands with P1v2)

New `SkierSim` fields and their invariants:

```
airborne: boolean     // true from launch until the arc returns to the terrain
airStartMs: number    // sim ms of launch; also the cooldown clock
airVy: number         // m/s VERTICAL velocity at launch (arc shape); 0 grounded
airStartY: number     // world-space terrain height at the launch position (m)
lastKickerIx: number  // -1 = none; indexes SlopeDef.kickers (consumed-on-cross)
```

`makeSim`/`resetSim`: `airborne=false, airStartMs=-J_COOLDOWN_MS, airVy=0,
airStartY=0, lastKickerIx=-1`. `copySim` copies all five.

**Arc (world-space, deterministic — both peers compute identically):**

```
t      = (simMs - airStartMs) / 1000         // sim seconds since launch
arc    = airVy * t - 0.5 * G_ACCEL * t * t   // height ABOVE THE LAUNCH POINT
worldY = airStartY + arc                     // the skier's world-space y
airHeight(s, x, z, slope) = airborne ? max(0, worldY - slope.height(x, z)) : 0
```

(GAUNTLET-CORRECTED: the pre-gauntlet draft said `slope.height(x,z) +
airHeight` with `airHeight` launch-relative — wrong on a descending piste,
the skier rendered underground. The helper measures height above the CURRENT
terrain; the RENDERED eye/skier y is `slope.height(x, z) + airHeight(...)`,
and the landing test uses `worldY` directly. On a 15° slope the piste drops
~0.26·v m/s under the flight — the tuning note in config.ts and the empirical
verification in docs/splat-v2/prototype-v2.mts account for it: hop apex
~1.5–2.5 m above the snow at race speed, kicker apex ~3–5 m, flights
30–50 m, always land, always contained.)

**stepSki, v2 order** (the exact insertion points into §6):

1. Clock, NaN guard, finished no-op (unchanged). Capture `prevZ`.
2. Gravity along heading, steering, carve, yaw soft-clamp, motion, bounds —
   **UNCHANGED**, except while `s.airborne` at this step's start:
   - yaw rate is multiplied by `J_AIR_STEER_MUL`,
   - carve scrub is multiplied by `J_AIR_CARVE_MUL`,
   - the drag term is unchanged (v is roughly held; air is FAST).
3. **Plant pass — SKIPPED while `s.airborne`** (the reward: fly over plants).
   A skier grounded at this step's start takes the normal plant pass.
4. Slalom gates — UNCHANGED, applies while airborne (fly through the flags).
5. Soft edges — UNCHANGED (a skier who drifts off-piste in the air is pushed
   back on landing, never trapped).
6. **Jump state machine** (runs at the END of the step, on the post-motion
   position — so launches use `prevZ < k.z <= s.z` exactly like gates):
   - If `s.airborne`:
     - compute `t`, `worldY`; if `worldY <= slope.height(s.x, s.z)` or
       `t >= J_MAX_AIRTIME_S`: **LAND** — `airborne=false, airVy=0`,
       `s.v = max(MIN_SPEED, s.v * J_LAND_SPEED_MUL)`. (A plant at the landing
       spot snare-checks NEXT step as grounded — one tick later, imperceptible.)
   - **Kicker scan — runs EVERY step, airborne or grounded** (GAUNTLET-
     CORRECTED): ascending z, from `lastKickerIx+1`, the same loop shape as
     gates: for the first kicker with `prevZ < k.z <= s.z`: `lastKickerIx =
     ix` (consumed on ANY crossing — a ramp cleared mid-air is consumed and
     can never re-launch you after landing; a hop that carries you over a
     kicker wastes it — timing is the skill); if GROUNDED AND `simMs -
     airStartMs >= J_COOLDOWN_MS` AND `|s.x - k.x| <= k.halfWidth`: **LAUNCH**
     — `airborne=true, airVy = J_KICKER_VY_BASE + J_KICKER_VY_SPEED * s.v,
     airStartMs = simMs, airStartY = slope.height(s.x, s.z)`; break.
   - **Manual hop** (only if still grounded AND off cooldown AND not launched
     this step): if `opts.jump === true`: **LAUNCH** with `airVy =
     J_HOP_VY` (same field writes). A hop and a kicker on the same step: the
     kicker wins (checked first).
   - **Cooldown-denied feedback** (UX_BIBLE §V2): a jump press while the
     cooldown holds is a silent no-op in the sim; the CLIENT plays a quiet
     denied thud + button pulse (the app reads the sim state).
7. Finish (unchanged; crossing `finishZ` in the air finishes — fly across the
   line).

**resolveSkiPair:** skip the pair if EITHER sim is airborne (no mid-air
collision — you fly over other skiers).

**Determinism:** everything above is a pure function of (steer, dt, jump,
simMs, position, fields) and `slope.height` — the SAME code the client
predicts with. `SkiPredictor.push`/`reconcile` replay the `jump` edge exactly
like steer (the pending queue entry stores it). `SkiInput` and `SkiStepOpts`
gain optional `jump?: boolean`.

**Containment (gauntlet-verified empirically, docs/splat-v2/prototype-v2.mts):**
max lateral displacement while airborne is bounded by the air-steer damping
(0.35×) + the soft-edge curvature (which applies in air) — a full-lock skier
who launches stays within ~3.5 m of the piste edge and always lands/finishes.
The v2 4-year-old test (P1v2 unit + E2Ev2) re-verifies this on 20 seeds each
run — it is a GATE, not an assertion.

**The 4-year-old law, v2:** a full-lock skier who hits kickers launches and
lands safely (scrub, damped steer, edges push back) — still finishes. Jumps
can never wipe out, stall, or shame. `J_MAX_AIRTIME_S` + the cooldown bound
every flight.

### 11.3 Kicker placement (frozen — body lands with P2v2)

`genSlope` lays `KICKER_COUNT` kickers along the same woven corridor
centreline the slalom gates use: `z = KICKER_Z0 + i*KICKER_SPACING +
jitter(±KICKER_Z_JITTER)` (clamped inside the planted zone, clear of both
clear zones), `x` = corridor centreline at that band ± `KICKER_X_JITTER` —
so a corridor-following skier rides them and a full-lock skier may cross them
(safe). `validateSlope` asserts, on every generated slope (GAUNTLET-CLARIFIED:
centreline membership is guaranteed by construction in genSlope — the
validator does NOT need to re-check it, only the four laws below):
- kickers strictly ascending z; none in `START_CLEAR` or `FINISH_CLEAR`;
- every kicker fully on-piste (`|x| + halfWidth <= width/2 - 1`);
- no plant within `KICKER_PLANT_CLEAR` of a kicker's (x, z) — the launch and
  landing zones stay readable;
- count within ±1 of `KICKER_COUNT`.

### 11.4 Graphics overhaul (v2 style bible — frozen art direction)

The full per-asset brief lives in `STYLE_BIBLE.md` §V2. In one line per
module: terrain gains groomed-piste + powder + snow banks + richer rocks +
a nearer foothill layer; plants gain drooping pine tiers + layered snow +
thorn crotch-snow; skiers gain jacket/backpack/visor detail + the AIR POSE;
the scene gains low-poly clouds + a visible sun disc + air camera feel; gates
gain kicker ramp meshes + a festive finish; fx gains land/launch bursts; HUD
gains the JUMP button. All colors still trace to SPAL; meshes still come only
from `contract/visual.ts` factories; draw calls stay < 80; particles ≤ 512.

### 11.5 v2 ownership (additive to §7; no file is shared between two tasks)

| Task | Files | Body |
|---|---|---|
| P1v2 | `shared/src/sim.ts`, `sim.test.ts` | jump state machine (11.2) + tests |
| P2v2 | `shared/src/slope.ts`, `slope.test.ts` | kicker placement (11.3) + tests |
| V1v2 | `server/src/room.ts`, `room.test.ts` | jump opts passthrough, `snap.airborne`, air-contact skip |
| C1v2 | `client/src/drive.ts`, `drive.test.ts` | Space/↑ jump, `setJump()` latch, edge on the wire |
| C2v2 | `client/src/app.ts` | air height for camera/skis, `setAirborne`/`land`, jump/land FX + audio, `setJump()` on `__splat`, hud button wiring |
| C3v2 | `client/src/ui/hud.ts`, `hud.css` | JUMP button + hint (seam `onJump`) |
| C4v2 | `client/src/audio.ts` | `jump`/`land` SFX |
| R1v2 | `render/scene.ts` | `setAirborne`/`land`, clouds + sun disc, air camera feel |
| R2v2 | `render/terrain.ts` | groomed piste, powder, banks, rocks, foothills |
| R3v2 | `render/plants.ts` | pine/bush/thorn model-sheet upgrade |
| R4v2 | `render/skiers.ts` | detail pass + air poses + own-skis tuck |
| R5v2 | `render/gates.ts` | kicker meshes + finish/lodge upgrade |
| R6v2 | `render/fx.ts` | `land`/`launch` bursts (≤512 budget) |
| E2Ev2 | `scripts/e2e-splat.mjs` | jump assertions + new screenshots |

Integration (wiring, gate fixes) is the orchestrator's, per §10 — it may edit
any file outside the frozen contract files after fan-out. The frozen contract
FILES (Layer 1, §1) are the orchestrator's own v2 edits in this amendment; no
implementer edits them.

### 11.6 v2 gates (additive to §9)

- P1v2 unit: jump determinism (same inputs → bit-identical), hop + kicker
  launch, air height arc shape, landing safety (never stuck; a skier launched
  on 20 seeds always lands and finishes — the 4-year-old test v2), fly-over-
  plants (a plant dead-centre under the arc never triggers while airborne),
  cooldown (no double-launch), landing-on-plant snares next tick, air-steer
  damping, `airHeight` helper shape.
- P2v2 unit: kicker placement laws (11.3) on 20 seeds.
- E2E v2: `setJump()` makes `state().sim.airborne` true then false; remotes
  see the airborne flag; **a full-lock skier with `startRace(seed)` finishes
  on the generated slope WITH kickers present** (the v2 4-year-old gate —
  assert `state().sim.finished` or hard-cap-with-progress); screenshots:
  jump mid-air, kicker close-up, landing, plus the §9.6 set. Draw calls
  still < 80. Snapshot still ≤ 2 KB (the wire grew one bool + one optional
  edge — assert the size budget still holds at 8 players).
