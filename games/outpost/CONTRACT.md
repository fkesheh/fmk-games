# CONTRACT — OUTPOST

**Frozen.** Embedded verbatim in every implementer's prompt. You fill bodies and privates. You may
never change a public exported shape, a file's ownership, or anything in the immutable files.

## Immutable files — never edit these

```
games/outpost/shared/src/types.ts      every cross-module type + the protocol + the debug API
games/outpost/shared/src/config.ts     every balance/tuning constant (pure data)
games/outpost/shared/src/map.ts        the RIDGELINE layout, segment geometry, feature points
games/outpost/shared/src/palette.ts    the colour ramp
games/outpost/shared/src/index.ts      the barrel
games/outpost/shared/src/protocol.ts   wire validation (parseC2S / encode / decode — never throws)
games/outpost/shared/src/palette.test.ts      frozen value-ladder guard on the palette
games/outpost/shared/src/protocol.test.ts     frozen guard on wire validation
games/outpost/shared/src/mapTopology.test.ts  frozen guard on the map's reachability
games/outpost/client/src/contract/visual.ts   the shared visual vocabulary
games/outpost/STYLE_BIBLE.md · DESIGN_BIBLE.md · UX_BIBLE.md
```

If you need something these do not expose, that is a **contract gap** — report it in your summary.
Do not edit the contract, and do not reach into a sibling module's internals to work around it.

## Engine reuse — what comes from STRICKEN unchanged

OUTPOST is a new game that **imports STRICKEN's engine**. `games/fps/**` is read-only: you may
import from `@fps/shared`, you may never modify it.

| From `@fps/shared` | Used for |
| --- | --- |
| `stepBody`, `makeBody`, `eyePos`, `BodyState`, `MoveInput`, `AABB` | ALL movement + collision, server and client prediction alike |
| `hitscan`, `raycastSolids`, `raycastAABB`, `playerHitboxes`, `HitscanTarget`, `HitResult`, `falloffMul`, `aimDir`, `applySpread`, `rewindTicks`, `HEAD_BOX_H` | ALL shooting. `HitscanTarget.id` is a plain `string`, so zombies drop straight in |
| `WEAPONS`, `WeaponDef`, `WeaponId`, `WEAPON_ORDER`, `shotSeed` | the guns, verbatim. Only PRICES differ (`ECONOMY.weaponPrice`) |
| `PLAYER`, `TICK_RATE` | movement tuning, tick rate |
| `PALETTE` | inherited colours (re-exported through `@outpost/shared/palette`) |
| `rng` (via `@platform/shared`) | ALL randomness. `Math.random` is a contract violation repo-wide |

`@fps/shared`'s own `boxToAABB` is NOT reused: OUTPOST exports its own `outpostBoxToAABB` from
`map.ts`, deliberately renamed to avoid a duplicate-identifier clash where both barrels are imported
together.

**Why this matters:** the previous OUTPOST hand-rolled physics whose ground query ran after gravity,
so every floor of its tower was a trapdoor and players fell from the spawn deck to y=0 in 1.5 s —
"until this is fixed, no screenshot of this map is evidence of anything." `stepBody` is AABB
collide-and-slide with step-up, shipped on six maps. Every walkable surface in `map.ts` is the top
face of an AABB and every rise is ≤ `PLAYER.stepUp`. Do not write a custom ground query.

### What `stepBody` actually does, and does not, honour

Every actor in this game — survivor or zombie, shambler or brute — collides as the SAME 0.6 m-wide,
1.8 m-tall box. `stepBody` force-resets `body.height` to `PLAYER.heightStand` on every call, and
overlap tests read the module constant `PLAYER.radius`; neither is parameterised per-actor, and
`@fps/shared` is read-only so this cannot be fixed here — only documented. Concretely:

- `Zombie.height` / `Zombie.radius` (and `ZombieStats.height` / `.radius`) are **presentation and
  melee-reach only**. They drive the model scale and the melee-reach check, never collision.
- `HitscanTarget.height` **is** honoured by `@fps/shared`'s hitscan — so a brute really is a taller
  target to shoot, just not a wider one. Its hitbox is never 2.5 m across.

## Conventions (all files)

- **Coordinates**: x east, z south, y up, ground plane y=0. Positions are FEET positions.
  `yaw 0 = -Z`, increases CCW from above, forward = `(-sin yaw, -cos yaw)`.
- **Time**: the server's `serverTime` is `Date.now()` in ms. Simulation systems never call
  `Date.now()` themselves — the room samples it once per tick into `SimContext.serverTime`.
- **Determinism**: no `Math.random()` anywhere. Server randomness comes from `SimContext.rand()`;
  client cosmetic variation from `ClientCtx.rand(seed)`. Spread uses `shotSeed(tick, shotSeq)` so
  client and server agree.
- **No hot-path allocation.** Preallocate wire objects and mutate in place; reuse scratch vectors and
  arrays; pool particles and projectiles. This is enforced by the performance review lens.
- **Never throw across a boundary.** Every public room method is try/catch. `parseC2S` returns
  `null` on bad input and never throws. One bad tick must not kill the interval; one render error
  must not white-screen the client.
- **Colours**: every colour is a `PALETTE` key. Zero hex literals outside the frozen palette.
- **Static geometry materials**: resolve every `MatKind` through `MAT_COLORS: Record<MatKind,
  MatColors>` from `@outpost/shared` — the sole `MatKind` → palette-tier mapping, which every art
  module must use rather than inventing its own.
- **Draw-call exceptions (frozen, exhaustive)**: (a) far-LOD zombies render as ONE
  `THREE.InstancedMesh`, never N separate meshes; (b) a character's contact shadow is baked into its
  model, not a live sibling mesh; (c) `THREE.InstancedMesh` is an explicitly permitted exception to
  the visual.ts-only construction rule, and ONLY in `render/zombies.ts` and `render/world.ts`.
- Strict TypeScript: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are all on.
  Index access yields `T | undefined` — handle it, never `!`-assert it away.
- **Projectiles must be swept, not stepped.** A spitter glob at `SPIT.speed` 18 m/s advances 0.6 m
  per tick, while the thinnest solid on the map is a 0.3 m parapet and the fence is 0.35 — a discrete
  position-increment-then-overlap-test passes straight through both. Advance projectiles via
  `raycastSolids` over the sub-step. (Bodies are safe: 0.16 m/tick against a 0.3 m radius.)

---

# Server

Systems are **pure with respect to I/O**: no sockets, no timers, no `Date.now()`. They take
`SimContext` and mutate it. The room owns the clock, the socket and the pool arrays. This is the
split that makes STRICKEN's server fully unit-testable under fake timers, and it is mandatory here.

### `server/src/waves.ts` — pure

```ts
export const waveSize: WaveSizeFn;               // (wave, players) => number
export const waveComposition: WaveCompositionFn; // (wave, count, rand) => ZombieKind[]
export const zombieStats: ZombieStatsFn;         // (kind, wave) => ZombieStats
```
Reads `WAVES` and `ZOMBIE_BASE` from config. Never invents a number — including the kill reward:
`ZombieStats.scrap` is read from `ECONOMY.killScrap[kind]`. `waveComposition` respects
`WAVES.unlock` (a kind not yet unlocked NEVER appears) and weights by `WAVES.weight`; the returned
array's length is exactly `count`, and wave 1 is 100% shamblers.

### `server/src/horde.ts` — pure

```ts
export const spawnZombie: SpawnZombieFn; // (ctx, kind, wave) => ZombieId | -1
export const stepHorde: StepHordeFn;     // (ctx) => void
export const stepSpits: StepSpitsFn;     // (ctx) => void
```
`stepHorde` per living zombie: retarget at most every `HORDE.retargetSec`; steer toward the attack
spot of its target segment (`segmentAttackSpot`), or toward a pursued survivor once inside; apply
separation (`HORDE.separationRadius/Force`) so the horde spreads instead of stacking into one
column; collide against `ctx.solids` — **use the same `stepBody` the players use**, stepping the
zombie's **persistent `Zombie.body: BodyState`** (never a per-tick scratch body), so a zombie can
never walk through the fence or the tower and can climb rubble or stairs via step-up. Persistent is
not optional: `stepBody`'s step-up assist is gated on `b.onGround`, so rebuilding the body every tick
silently breaks rubble/stair traversal, and `HORDE.maxAlive` zombies allocating a fresh body 30
times a second is a hot-path allocation the contract forbids. Fence damage is CONTINUOUS, not
per-swing: apply `damageSegment` with `ZOMBIE_BASE[kind].fenceDps * dt` every tick a zombie is in
contact with a segment — `meleeInterval` governs swings at SURVIVORS only, via `damageSurvivor`.
Retire corpses after `HORDE.corpseSec`.

**Dangling references are the #1 crash class here.** A zombie MUST clear `targetSeg` when that
segment breaches and MUST null `targetPlayer` when that survivor dies, goes down, or disconnects.
Every state exits on death.

### `server/src/fence.ts` — pure

```ts
export const damageSegment: DamageSegmentFn;   // (ctx, seg, dmg) => void
export const repairSegment: RepairSegmentFn;   // (ctx, s, seg) => number (hp restored)
export const fenceSolids: FenceSolidsFn;       // (segments) => AABB[]
export const nearestSegment: NearestSegmentFn; // (x, z) => { seg, dist }
```
Breaching sets `breached`, clears every zombie's `targetSeg` pointing at it, emits `seg_breached`,
and calls `ctx.rebuildSolids()`. Repair charges `ECONOMY.repairScrapPerHp` continuously and returns
0 when unaffordable (the caller emits the deny). Rebuilding a breached segment uses
`rebuildRateMul`/`rebuildCostMul` and only un-breaches at full rebuild. `nearestSegment` (and every
other segment-proximity check) measures with the frozen `segmentDistance(x, z, seg)` helper from
`@outpost/shared/map` — perpendicular distance to the segment's WALL, clamped to its 10 m span —
NEVER distance to `SegmentGeom.cx/cz` (a centre point). Under a centre-point reading, `INTERACT.repairRange`
2.6 would only reach the middle ~49% of each 10 m segment, and no compiler or unit test would
surface it.

### `server/src/survivors.ts` — pure

```ts
export const damageSurvivor: DamageSurvivorFn;
export const stepDowned: StepDownedFn;
export const stepRevives: StepRevivesFn;
export const resolveInteract: ResolveInteractFn;
export const isSquadWiped: IsSquadWipedFn;
```
`alive` at ≤0 HP → `downed` with `DOWNED.bleedoutSec`, emit `downed`. `downed` at ≤0 HP → `dead`,
emit `died`. A downed survivor takes `DOWNED.damageMul` damage and cannot move. `stepRevives`
accumulates progress only while the reviver holds INTERACT within `DOWNED.range` and is itself
alive; progress resets if either condition breaks. `resolveInteract` picks the NEAREST valid
interactable and writes `s.interactKind` / `s.interactTarget` / `s.reviveTargetId`; segment proximity
for this is measured with the same `segmentDistance(x, z, seg)` helper `fence.ts` uses — perpendicular
distance to the segment WALL, clamped to its 10 m span, never `SegmentGeom.cx/cz` (a centre point).

### `server/src/combat.ts` — pure

```ts
export interface ZombieTarget extends HitscanTarget { zid: ZombieId }
export function zombieTargets(ctx: SimContext, out: ZombieTarget[]): ZombieTarget[];
export function resolveShot(ctx: SimContext, s: Survivor, def: WeaponDef): void;
```
Builds hitscan targets from living zombies (id = `String(zid)`), calls `@fps/shared`'s `hitscan`
against `ctx.solids`, applies `falloffMul` and `headshotMul`, awards scrap and stats, emits `shot`
/ `hit` / `zombie_died`. Pellet loops use `shotSeed(tick, shotSeq)` + `rng` so spread is
deterministic. Reuse a module-level scratch array for targets — never allocate per shot.

### `server/src/room.ts` — the server integrator

```ts
export class OutpostRoom implements GameRoomHandle { … }
export interface RoomDeps { rand(): number; now(): number }
constructor(visibility: Visibility, io: RoomIO, deps?: RoomDeps)
```
Owns: the `SimContext`, the zombie/spit pools (preallocated to `HORDE.maxAlive` and never resized),
`setInterval` at `SIM_HZ` wrapped in try/catch, the phase machine
(`lobby → wave → intermission → ended`), the spawn drip at `WAVES.spawnPerSecBase * (WAVES.playerBase +
WAVES.playerStep * players)` — the same headcount factor that scales wave size — snapshot assembly
every `NETCODE.snapshotEveryTicks` ticks into preallocated per-player wire objects, `rebuildSolids()`
(= `STATIC_SOLIDS` + `fenceSolids(intact)`), input ingestion with STRICKEN's anti-speedhack bucket,
`stalePlayers()`, and rejoin. **The room never auto-starts** — `handleStart` is the only way out of
`lobby`. When `isSquadWiped` becomes true, emit `run_end` with `RunStats[]` and go `ended`.

**`room.ts` is the sole handler of `DebugMsg`** (the `{ t: 'debug', op: … }` variant of `C2S`). It
calls into fence/horde/survivors through their normal public functions and never reaches past them.
The wire exists because every op it carries (`hurt`, `teleport`, `breach`, `spawn`, `end`, `invuln`)
mutates server-authoritative state — a client-side fake of any of it would be overwritten by the next
snapshot, which is exactly the "a screenshot is a lie" failure the debug surface exists to prevent.

**Authorization — a decision, not an oversight.** `DebugMsg` is accepted ONLY when the room was
created with `settings.debug === true`; in any other room `room.ts` silently drops it, exactly as
`parseC2S` drops malformed input. Both harnesses create their rooms with that setting. Without this
gate any player in a public room could send `{t:'debug',op:'end'}` and end everyone's run, or
`{op:'invuln',a:1}` and be unkillable — and 24 parallel implementers would each have assumed someone
else had thought about it. `parseC2S` still sanitises every field (segment index clamped to
`FENCE.segments`, coordinates and damage bounded) so `room.ts` can trust what reaches it.

Tick order (fixed — several bugs in the previous build were ordering bugs):
```
advancePhase → ingest inputs & step survivors (stepBody) → resolveInteract
→ stepRevives → stepDowned → stepHorde → stepSpits → checkSquadWipe → snapshot
```

### `server/src/module.ts`

```ts
export const outpostModule: GameModule;  // id 'outpost', devPort DEV_PORT, min/max from config
```
Mirrors `games/fps/server/src/module.ts` including its multi-candidate `resolveClientDist()` probe.
Already imported by `platform/server/src/registry.ts` — do not edit the registry.

---

# Client

### `client/src/contract/visual.ts` — IMMUTABLE shared visual vocabulary

```ts
export { PALETTE }; export type { PaletteKey };
export interface MatOpts { emissive?: string; transparent?: boolean; opacity?: number }
export function mat(hex: string, opts?: MatOpts): THREE.MeshLambertMaterial  // cached, flatShading
export function box(w,h,d, hex: string, opts?: MatOpts): THREE.Mesh
export function cyl(rTop,rBottom,h,seg, hex: string, opts?: MatOpts): THREE.Mesh
export function cone(r,h,seg, hex: string, opts?: MatOpts): THREE.Mesh
export function sphere(r,seg, hex: string, opts?: MatOpts): THREE.Mesh
export function at<T extends THREE.Object3D>(o: T, x: number, y: number, z: number): T
export const COPLANAR_EPS: number;
export interface ArticulateColors { body: string; trim: string | null; dark?: string | null; contact: string | null }
export interface ArticulateOpts { plinthH?, corniceH?, pilasterEvery?, plinthProud?, corniceProud?, pilasterProud?: number; midRail?: boolean }
export function articulate(w,h,d, colors: ArticulateColors, opts?: ArticulateOpts): THREE.Group
export const CONTACT_Y: number;
export function contactShadow(radius: number, opacity?: number): THREE.Mesh
export function bake(root: THREE.Group): THREE.Group   // merges to ONE mesh per material
export function vrng(seed: number): () => number       // seeded, deterministic
```
Every renderer goes through these. `bake()` skips descendants marked `userData.animate === true`.

### Renderer modules — public shapes

```ts
// render/scene.ts  (art: scene & lighting)
export class SceneRig {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  constructor(canvas: HTMLCanvasElement);
  setTimeOfDay(tod: TimeOfDay): void;      // moods + fog + sky + practicals
  applyCamera(x,y,z: number, yaw: number, pitch: number, fovDeg: number): void;
  shake(amount: number): void;
  resize(): void;
  render(): void;
  dispose(): void;
  static showContextError(): void; static clearContextError(): void;
}

// render/world.ts  (art: world/environment)
export function buildWorld(): THREE.Group;   // ground, paths, treeline, ridges, sky dome, scatter
export function animateWorld(root: THREE.Group, t: number): void;  // crown drift, puddle shimmer

// render/outpost.ts  (art: structures)
export function buildOutpost(): OutpostBuild;
export interface OutpostBuild {
  root: THREE.Group;
  /** Called every frame with each segment's 0..1 health so the fence shows its state. */
  setSegment(id: SegmentId, hp01: number, breached: boolean, rebuild: number): void;
  /** Sub-group of the segment, for FX anchoring. */
  segmentAnchor(id: SegmentId): THREE.Object3D;
  animate(t: number): void;   // flags, tarps, gate sway, brazier hardware
}

// render/zombies.ts  (art: characters 1)
export class ZombieModels {
  constructor(scene: THREE.Scene);
  sync(zs: readonly ZombieSnap[], camPos: THREE.Vector3, dt: number): void;  // owns LOD + pooling
  clear(): void; dispose(): void;
}

// render/survivors.ts  (art: characters 2)
export class SurvivorModels {
  constructor(scene: THREE.Scene);
  sync(ss: readonly SurvivorSnap[], localId: PlayerId | null, dt: number): void;
  muzzle(id: PlayerId): void;
  clear(): void; dispose(): void;
}
export class ViewModel {
  constructor(camera: THREE.Camera);
  setWeapon(id: WeaponId): void;
  update(dt: number, moving: boolean, scoped: boolean, interactProgress: number): void;
  fire(): void; reload(durSec: number): void; dispose(): void;
}

// render/effects.ts  (art: fx)
export class Effects {
  constructor(scene: THREE.Scene);
  tracer(from: Vec3W, to: Vec3W): void;
  bloodHit(p: Vec3W, headshot: boolean): void;
  zombieDeath(p: Vec3W, kind: ZombieKind): void;
  fenceHit(p: Vec3W): void;      // splinters
  fenceBreak(p: Vec3W): void;
  spitTrail(p: Vec3W): void; spitLand(p: Vec3W): void;
  reviveBeacon(id: PlayerId, p: Vec3W, on: boolean): void;
  scrapPop(p: Vec3W, amount: number): void;
  muzzleSmoke(p: Vec3W, dir: Vec3W): void;
  footDust(p: Vec3W): void;
  update(dt: number): void; clear(): void; dispose(): void;
}
```

### `client/src/net.ts`

```ts
export class Net {
  constructor(onEvent: (ev: OutpostEvent) => void, onJoined: (m: JoinedMsg) => void);
  connect(): void; leave(): void; dispose(): void;
  send(m: C2S | LobbyC2S): void;
  quickJoin(name: string): void; createPrivate(name: string): void; joinPrivate(name: string, code: string): void;
  createPublic(name: string): void;
  /** Correlates the `room_list` reply internally so ui-menus/cl-game never invent their own promise-correlation scheme. */
  listRooms(): Promise<RoomInfo[]>;
  snap(): SnapshotMsg | null;
  /** Interpolated at serverNow() - NETCODE.interpDelayMs. Reused arrays — do not retain. */
  survivors(): readonly SurvivorSnap[];
  zombies(): readonly ZombieSnap[];
  serverNow(): number; pingMs(): number;
  predictor(): PredictorApi;   // PredictorApi — frozen in shared/src/types.ts; wraps @fps/shared stepBody exactly as STRICKEN does
}
```
Interpolates survivors AND zombies. Zombies appear/disappear on the newer bracket; a jump over 10 m
snaps rather than sliding. Reconciles local movement from `YouSnap.vy` + `ack`.

### `client/src/input.ts`

```ts
export type InputEdge = 'reload' | 'slot1' | 'slot2' | 'slot3' | 'scoreboard' | 'menu' | 'qswitch';
export class InputController {
  yaw: number; pitch: number;
  constructor(canvas: HTMLCanvasElement);
  start(): void; stop(): void; locked(): boolean;
  frame(): { moveX: number; moveZ: number; buttons: number };  // reused object
  edges(): readonly InputEdge[];
  clearHeld(): void;
  setZoomed(on: boolean): void;
}
```
Pointer lock; blur and lock-loss both `clearHeld()`. **Blur must NOT pause the game.** INTERACT is
a held button with a short release grace so repairing under fire is not miserable.

### `client/src/game.ts` — the client integrator

```ts
export class OutpostGame {
  constructor(opts: { canvas: HTMLCanvasElement; hud: Hud; menus: Menus });
  frame(dt: number): void;
  ctx(): ClientCtx;
  resize(): void; leave(): void; dispose(): void;
  // the debug-surface backing methods main.ts exposes
  debugState(): OutpostDebugState; telemetry(): OutpostTelemetry;
  freeCam(...): void; releaseCam(): void; setTimeOfDay(tod: TimeOfDay): void;
}
```
The ONLY file allowed broad concrete imports. Builds the `ClientCtx`, owns the frame order, routes
events to FX/audio/HUD, and disposes the whole world on leave.

### `client/src/ui/hud.ts`, `client/src/ui/menus.ts`

DOM overlays, each injecting its own `<style>` once and mirroring `PALETTE` onto CSS custom
properties. `#hud` is `pointer-events: none` except explicitly interactive controls.

`HudApi`, `HudState`, `MenuCallbacks`, `MenusApi`, `PredictorApi` and `AudioApi` are all frozen in
`shared/src/types.ts` — see there for the exact fields, not here; a `{ … }` in a frozen contract is
not a contract. `HudApi.rects()` and `HudApi.visible()` are load-bearing, not incidental: they feed
`telemetry().hudRect` / `.hudVisible`, and every visual gate is measured over "the 3D region" (canvas
minus the HUD rects) — without them the aesthetic gate has no defined measurement area.

```ts
export class Hud implements HudApi {   // HudApi — shared/src/types.ts
  onStart: (() => void) | null;
  constructor(root: HTMLElement);
  update(s: HudState): void;   // HudState — shared/src/types.ts
  hitmarker(headshot: boolean, killed: boolean): void;
  damageFrom(yawRelative: number, dmg: number): void;
  banner(title: string, sub: string): void;
  teammateDown(id: PlayerId, name: string, on: boolean): void;
  runEnd(info: { wave: number; stats: readonly RunStats[] } | null): void;
  show(on: boolean): void;
  rects(): readonly { x: number; y: number; w: number; h: number }[];
  visible(): boolean;
}
export class Menus implements MenusApi {   // MenusApi — shared/src/types.ts
  constructor(root: HTMLElement, cb: MenuCallbacks);   // MenuCallbacks — shared/src/types.ts
}
```
The **fence ring** (16 ticks, oriented to player facing, colour + fill + icon) is the signature HUD
element — see the UX bible's information hierarchy.

### `client/src/audio/audio.ts`

Implements the frozen `AudioApi` interface (`shared/src/types.ts`). 100% synthesized WebAudio, no
asset files, seeded noise (`Math.random` is a violation). Safe no-op until `resume()` on first
gesture. Every `SfxKind` in the contract has a distinct, deliberate sound; plus a wind/insect
ambience bed that thins into a low drone as `night` arrives.

### `client/src/main.ts`

Boot, `PALETTE` → CSS vars, rAF loop with per-frame try/catch, error banner, boot splash, and
installs `window.__outpost` implementing `OutpostDebugApi` **in full**. Both harnesses assert the
whole surface exists before running.

`OutpostDebugApi` (`shared/src/types.ts`) is intentionally larger than "control the game": it adds
scenario-staging methods — `hurtSelf`, `teleport`, `breachSegment`, `spawnAt`, `endRun`,
`setInvulnerable`, `start(seed?)` — plus telemetry additions `segments[]` (per-segment hp/breached,
not just counts), `zombiesWithin(r)`, `interactProgress`, `hudRect`, `hudVisible`, `recentSfx`. They
exist because, without them, not one scenario the contract demands of its own harnesses can be
staged: a two-client revive would otherwise mean walking a player down two flights to a segment and
waiting on emergent, server-random shambler swings to put them down — an assertion that gets written
flaky and then deleted. These are debug-only affordances on a debug-only surface, staging real
behaviour instead of hoping for it.

---

# Verification tooling — first-class deliverables, not afterthoughts

The previous build lost an entire judging round to a capture script that photographed three stacked
modals over a black rectangle, with an AFK player who had already been eaten, aimed by stale
hard-coded coordinates. These two scripts are held to the same bar as game code.

### `scripts/capture-outpost.mjs`

Puppeteer. Frames every shot from `window.__outpost.mapInfo()` — **never a coordinate literal**.
Uses `freeCam`/`setTimeOfDay`/`clearOverlays` so a shot is always of the thing it claims to be.

**The 3D region** is defined as the full canvas MINUS every rect in `telemetry().hudRect`. It is not
"the frame" — the HUD is never an "overlay"; overlays are modal layers under `#menu` only, and the
always-on HUD is masked out of the 3D region instead so every gate below is measured against the
scene, not against bright HUD chrome.

After each capture it MUST verify against `VISUAL_GATES` and **fail the run** (non-zero exit), not
warn, when: `telemetry().overlays !== 0`; file size < `minShotBytes`; median luma < `minMedianLuma`;
shadow share > `maxShadowShare`; near-field blowout share > `maxBlowoutShare` (threshold
`blowoutLuma` **200**, not 240); surface stddev < `minSurfaceStddev`, measured over each shot
descriptor's own declared `sampleRect`; or, for horde shots with ≥ `hordeMinZombiesForGate` zombies
within `hordeGateRadius`, horde pixel share — classified by `hordePixel` (luma/saturation/hue
thresholds) — below `minHordePixelShare`. The horde gate is an **assertion**, not a conditional
exemption: a capture run where the horde never arrived within `hordeGateRadius` is a FAILED run, not
an exempt one. It prints the measured numbers for every shot so a judging round is auditable.

### `scripts/e2e-outpost.mjs`

Puppeteer, modelled on the mature `scripts/e2e-splat.mjs`: separate browser per client (no cross-tab
rAF throttling), four error channels (`console`, `pageerror`, `error`/crash, `requestfailed`), an
in-page phase recorder so fast transitions cannot be missed, bounded screenshots with retry, port
cleanup, and a `finally` that always reaps the server. Asserts at minimum:
the full debug surface exists · lobby does NOT auto-start · START → wave 1 · a shot kills a zombie ·
scrap increases on a kill · a segment takes damage and can be repaired · **two clients: one goes
down and the other revives them** · a breach opens and zombies path inside · draw calls ≤
`PERF.maxDrawCalls` and frame time ≤ `PERF.maxFrameMsUnderLoad`, measured with `HORDE.maxAlive`
zombies alive (spawned via `spawnAt`) — NOT with whatever two test clients happen to have populated,
which measures nothing · squad wipe ends the run with stats · every screenshot is non-trivial · zero
console/page errors on all pages.
