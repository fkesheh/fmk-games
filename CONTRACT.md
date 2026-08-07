# CONTRACT — "STRICKEN" browser tactical FPS (FROZEN)

This document + the files listed below are the **immutable contract**. Every implementer works
against it. **You may not modify contract files, another task's files, or add files outside your
ownership list.** You implement bodies and private helpers inside your own files only.

## Frozen files (Layer 1 — code)

- `games/fps/shared/src/types.ts` — all wire types, ids, enums, events
- `games/fps/shared/src/config.ts` — tick rate, player physics constants, economy, rounds, WEAPONS table
- `games/fps/shared/src/palette.ts` — the named palette (ALL colors trace here), organised in
  `…Lit / base / …Dark / …Deep` value tiers per VISUAL_UPGRADE.md §2
- `games/fps/shared/src/matColors.ts` — `MatId` → PALETTE plus the ladder-partner tables
- `games/fps/shared/src/rng.ts` — seeded RNG (mulberry32)
- `games/fps/shared/src/physics.ts` — stepBody collide-and-slide, AABB/raycast, hitscan, spread, falloff
- `games/fps/shared/src/protocol.ts` — parseC2S / encode / decode
- `games/fps/shared/src/maps/types.ts`, `games/fps/shared/src/maps/index.ts`, `games/fps/shared/src/maps/dustbowl.ts` (reference map)
- `games/fps/shared/src/maps/{crossfire,office,frostbite,urbana,bunker}.ts` — placeholder data; owned by tasks M1–M5 (they replace file CONTENTS, never the format)
- `games/fps/client/src/contract/visual.ts` — mat/box/cyl/cone/sphere/at/bake visual vocabulary,
  plus the articulation helpers `articulate()` / `contactShadow()` / `CONTACT_Y`

## RULES (every implementer, no exceptions)

1. **No contract edits.** Missing something? Implement around it with private helpers in YOUR files.
2. **No stubs, no TODOs, no placeholder returns.** Complete implementations only.
3. **Strict TypeScript.** No `any`, no `@ts-ignore`, no non-null `!` unless provably safe.
   `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are ON — code accordingly.
4. **Imports:** you may import from `@fps/shared`, `three` (client), `ws`/`node:*` (server), and the
   exact exports listed in the module table below. No other cross-module imports.
5. **All colors from PALETTE.** Meshes only via `games/fps/client/src/contract/visual.ts` factories
   (`box/cyl/cone/sphere/at/mat/bake`, plus `articulate/contactShadow`). Exceptions allowed:
   sky-dome `MeshBasicMaterial` with vertex colors, particle `THREE.Points` materials, nameplate
   `CanvasTexture` sprites — colors still from PALETTE.
6. **Bake all static geometry** via `bake()`. Dynamic pivots (limbs, weapon, rotor) stay unbaked.
7. **Determinism:** gameplay + procedural visual layout use `rng(seed)` from shared only.
   `Math.random` is a violation everywhere; server-side non-gameplay generation (room ids, private
   codes, random map pick) uses `rng(Date.now())`.
8. **No per-frame allocation in hot paths** (render loop, tick loop): reuse objects/arrays, pool particles.
9. **Robustness:** one bad message/exception must never kill the server or white-screen the client.
   Wrap handlers in try/catch. Window blur clears held keys. Handle resize. Guard WebGL context failure
   with a readable error div.
10. **Gates:** `npm run typecheck` at repo root must pass with your files present. Keep it green.

## Architecture overview

- **Server** (Node + ws): authoritative. Tick 30Hz. Snapshot every tick (30Hz JSON). Rooms:
  public (quick-join/list) + private (5-char code). Warmup until ≥2 players, then round-based
  team elimination (freeze → live → roundEnd → … → matchEnd → warmup), halftime side swap.
  Lag-compensated hitscan (rewind ≤250ms). Economy + buy menu.
- **Client** (Vite + three.js): prediction for own player (shared stepBody + input replay),
  120ms interpolation for remotes, DOM HUD/menus, WebAudio-synthesized SFX.
- **Shared**: everything both sides need. Client and server MUST use the same stepBody/hitscan.

## Conventions

- serverTime = server `Date.now()` ms. Client estimates offset from `joined.serverTime` and `pong`.
- yaw: radians, 0 = looking towards -Z ("north"), increases counter-clockwise seen from above.
  Forward vector = (-sin(yaw), -cos(yaw)); pitch positive = looking up. Matches `aimDir()`.
- Positions are FEET (y of the ground under the player). Eye = y + height - eyeOffset.
- Player collision body: AABB, half-extent 0.3, height 1.8 stand / 1.3 crouch.

## Module table — server (task S1/S2/S3)

### `games/fps/server/src/net.ts` (S1)
```ts
export class Session {
  readonly id: PlayerId;
  send(msg: S2C): void;          // JSON via encodeS2C; no-op if socket closed
  rttMs(): number;               // from ws protocol-level ping/pong, default 0
}
export interface NetHooks {
  onMessage(sess: Session, msg: C2S): void;   // already parseC2S-validated; invalid dropped here
  onDisconnect(sess: Session): void;
}
export class NetServer {
  constructor(hooks: NetHooks);
  start(port: number, staticDir: string | null): void;
  // http: serves staticDir (client build) with correct content types + SPA fallback to index.html;
  // ws: WebSocketServer on path /ws attached to the same http server.
  // pings every socket every NET.pingEveryMs (ws built-in ping) and records rtt per Session.
  close(): void;
}
```

### `games/fps/server/src/game.ts` (S2)
```ts
export interface RoomIO {
  send(id: PlayerId, msg: S2C): void;
  rttMs(id: PlayerId): number;
}
export class GameRoom {
  readonly id: RoomId; readonly code: string | null; readonly visibility: RoomVisibility;
  constructor(mapId: MapId, visibility: RoomVisibility, io: RoomIO);
  info(): RoomInfo;
  addPlayer(id: PlayerId, name: string): void;   // auto-assign smaller team; sends 'joined'
  removePlayer(id: PlayerId): void;
  playerCount(): number;
  handleInput(id: PlayerId, msg: Extract<C2S, { t: 'input' }>): void;
  handleReload(id: PlayerId): void;
  handleSwitch(id: PlayerId, weapon: WeaponId): void;
  handleBuy(id: PlayerId, weapon: WeaponId): void;
  addBot(): PlayerId | null;      // null if room full; bot named 'Bot N', team auto-balanced
  removeBot(): boolean;           // removes the most recently added bot; false if none
  botCount(): number;
  handleSwitchTeam(id: PlayerId, team: Team): void; // semantics under Bot integration invariants
  start(): void;   // own setInterval at TICK_RATE; idempotent
  stop(): void;
}
```
Bot integration invariants (frozen):
- Bots hold normal player slots (roster `bot: true`); identical spawn/round/damage/stats rules.
- Each tick (before movement), for every bot: build its BotPercept (enemies = alive players of the
  other team), call its BotBrain, and apply the returned BotCommand through the SAME code path as
  a client `input` message (seq increments per bot) plus reload/buy handling.
- Bots are exempt from stalePlayers() and the inputs/s kick (they emit exactly 1 input/tick).
- Bots have no session: RoomIO.send/rttMs for a bot id must no-op / return 0 (S1 guarantees).
- addPlayer into a FULL room containing bots: kick the longest-connected bot first, then join.
- **Team switch (frozen):** `handleSwitchTeam(id, team)` — no-op if already on that team. Balance
  guard: deny with `{t:'error', code:'team_full'}` (to the requester) if the target team already
  has ≥ (other team count + 1) players. In `warmup` the switch applies IMMEDIATELY: set team,
  broadcast `team_changed`, respawn the player at their new team's spawns. During freeze/live/
  roundEnd the request is QUEUED and applied at the next beginFreeze (guard re-evaluated then;
  broadcast `team_changed` when applied). At halftime the side swap happens first, then queued
  requests are re-evaluated against post-swap teams.
Behavioral invariants (S2, uses S3 helpers):
- **Phases:** `warmup` (free respawn after ROUNDS.warmupRespawnDelay s, damage on, no economy) →
  when connected ≥ MIN_PLAYERS_FOR_MATCH: `freeze` (round 1..N; players teleported to spawns, healed,
  can't move/shoot; buy allowed) → `live` (buy allowed for ROUNDS.buyTime s) → ends on elimination
  (one team has 0 alive), time (winner = more alive; tie ⇒ CT), or forfeit (a team has 0 connected)
  → `roundEnd` (ROUNDS.roundEndTime s) → next freeze. After ROUNDS.halftimeAfter rounds: swap all
  teams + `halftime` event (carries the full new roster). Match ends at ROUNDS.winRounds wins or
  ROUNDS.maxRounds played (tie ⇒ CT) → `matchEnd` → 6s later: full reset to `warmup`
  (money=ECONOMY.start, scores 0).
- **Movement/damage invariant (frozen):** player bodies are stepped and damage is applied ONLY in
  `warmup` and `live`; in `freeze`/`roundEnd`/`matchEnd` inputs are acknowledged (ack advances) but
  bodies and hp never change — this is what lets clients gate prediction on phase.
- **Movement:** queue inputs per player; consume ≤ NET.maxInputPerTick per tick, each applied with
  stepBody(TICK_DT). Inputs older than the queue cap are dropped. Speedhack guard: a player sending
  >90 inputs/s is disconnected (return them via removePlayer; S1 handles the socket).
- **Spawn:** pick a random spawn of the player's team; retry up to 4× if an alive enemy is within
  10m; else accept. Spawn protection: no damage for ROUNDS.spawnProtection s after spawn.
- **Disconnect/afk:** no input for NET.inputTimeoutMs ⇒ treat as disconnect (S1 owns the socket close;
  S2 exposes the stale-check via its tick; call `io.send` nothing — S1 polls `room.stalePlayers()`).
```ts
  stalePlayers(): PlayerId[];   // players with no input for NET.inputTimeoutMs (add to GameRoom)
```
- **Snapshots** every tick to all players: players (all), you (per-recipient), ack (per-recipient),
  phase/phaseEndsAt (0 during warmup/matchEnd), spectateTarget for dead players (first alive
  teammate, recomputed on change).
- **Events:** shot/kill/hit/dmg_taken/round_*/match_*/player_joined/left/buy_result per types.ts.
  Every resolved shot volley (one per trigger pull, not per pellet) ALSO broadcasts a `shot` event:
  from = shooter eye, to = closest hit point across pellets or wallEndPoint of the aim ray. This is
  what drives remote muzzle flash, tracers, and shot sounds — without it fights are silent.
- Uses `resolveShot`/`LagBuffer` (S3) for fire; `tryBuy`/rewards (S3) for economy. Lag-comp rewind
  uses the frozen formula: `lagBuffer.at(currentTick - rewindTicks(rttMs))` (physics.ts).
- **Weapon/ammo lifecycle (frozen):** death drops the current primary — the dead player's owned list
  resets to knife+pistol. At every freeze (round start), ALL owned weapons of every player refill to
  default mag+reserve for free. Survivors keep their primary into the next round. Warmup deaths
  change nothing (owned list persists).
- **Armor / gear (frozen):** players may buy `kevlar` ($650 → armor = 100, `hasKevlar = true`) and
  `helmet` ($1000, requires hasKevlar) via `buy_gear` in the same canBuy window. Damage model:
  with armor > 0, body shots split — hp loses round(dmg × (1 − GEAR.absorb)) and armor loses
  round(dmg × GEAR.absorb) (if armor < the soaked part, the remainder rolls into hp); armor never
  blocks without points left. Headshots BYPASS armor entirely unless the victim owns a helmet
  (helmet → headshots absorb the same way). Death drops armor and helmet (like primaries); round
  start does NOT refill armor (survivors keep what's left). `buy_result` covers gear buys
  (weapon field null, item reported in reason on failure: 'buy time expired' / 'insufficient
  funds' / 'already owned' (helmet) / 'requires kevlar' (helmet without vest)). `kill_bots` kills
  every bot in place through the normal death path (killerId null; warmup respawn rules apply),
  without removing them from the room.
- **Stats (frozen):** every kill with headshot=true increments the killer's `headshots` (roster).
  Multikill streak: a kill within MULTIKILL_WINDOW seconds of the killer's previous kill increments
  the streak (dying or the window lapsing resets it); on reaching streak 2/3/4/5+ broadcast
  `multikill` with count = min(streak, 5). Kills/deaths/headshots persist across matches (only
  money/scores/round reset); the multikill streak resets every freeze.
- **Low-population abort (frozen):** if connected players < MIN_PLAYERS_FOR_MATCH at any point in
  freeze/live/roundEnd, immediately abort to warmup: scores reset to 0, money to ECONOMY.start,
  round to 0. Forfeit (one team has 0 connected but MIN is still met) is checked in freeze AND live
  and awards the round to the other team.
- **Mutual elimination:** if both teams reach 0 alive in the same tick, round_end with winner null;
  roundRewards(null) applies (both teams get loss reward).
- Input queue per player capped at NET.inputQueueCap; older inputs dropped.

### `games/fps/server/src/combat.ts` (S3)
```ts
export class LagBuffer {
  constructor(maxTicks: number);
  push(tick: number, entries: Array<{ id: PlayerId; x: number; y: number; z: number; height: number }>): void;
  at(tick: number, excludeId: PlayerId): HitscanTarget[]; // stored state nearest to tick (<= tick)
}
export interface ShotContext {
  tick: number; shooterId: PlayerId; origin: Vec3; yaw: number; pitch: number;
  weapon: WeaponDef; bloomDeg: number; scoped: boolean;
  targets: HitscanTarget[]; solids: AABB[]; maxDist: number;
}
export interface ShotHit { targetId: PlayerId; dmg: number; headshot: boolean; point: Vec3; dist: number; }
export function resolveShot(ctx: ShotContext, seed: number): ShotHit[];
// per pellet: dir = applySpread(aimDir(yaw,pitch), effectiveSpread, rng(seed+i)) where
// effectiveSpread = scoped && weapon.scopedSpreadDeg != null ? scopedSpreadDeg : min(spread+bloom, max)
// hit = hitscan(origin, dir, targets, solids, maxDist) (knife maxDist = weapon.rangeEnd)
// dmg = round(damage * falloffMul(dist, ...) * (headshot ? headshotMul : 1)); dmg >= 1
export function wallEndPoint(origin: Vec3, dir: Vec3, solids: AABB[], maxDist: number): Vec3;
```

### `games/fps/server/src/bots.ts` (S4 — server-driven bot players)

Bots are server-side players: the room feeds each bot's `BotCommand` through the exact same
input/reload/buy path as human clients. Bots appear as normal roster entries with `bot: true`.

```ts
export interface BotPercept {
  self: { x: number; y: number; z: number; yaw: number; pitch: number; hp: number;
          mag: number; reserve: number; reloading: boolean; crouch: boolean };
  enemies: Array<{ id: PlayerId; x: number; y: number; z: number; height: number; alive: boolean }>;
  solids: AABB[];
  map: MapDef;
  tick: number;
  phase: RoomPhase;
  money: number;
  owned: WeaponId[];
  canBuy: boolean;
}
export interface BotCommand {
  moveX: number; moveZ: number; yaw: number; pitch: number; buttons: number; // INPUT_* bits
  reload: boolean;
  buy: WeaponId | null;
}
export class BotBrain {
  constructor(seed: number);
  tick(p: BotPercept): BotCommand; // deterministic per seed; once per server tick per bot
}
```

Behavior invariants (frozen):
- **Perception:** nearest alive enemy with clear LOS (raycastSolids between the two eye positions
  has no hit) within 45m; 360° awareness (no FOV cone — keeps bots fun and code simple).
- **Engage:** turn toward the target's chest (y + height×0.65) at ≤ 6 rad/s; fire only when aim
  error < 3° AND a 300ms reaction time since acquiring the target has passed. Auto weapons: bursts
  of 4–8 fire ticks separated by 8–15 tick pauses; semi: single fire ticks every ~10 ticks. Reload
  when mag === 0 (reload flag; never while firing). Strafe while engaging: moveX = sin(tick/20)
  clamped to [-1,1].
- **Patrol (no target):** walk a BFS path over a 0.75m walkability grid derived from map solids
  (grid built once per brain, cached) to a seeded-random reachable waypoint; repath on arrival,
  after 5s, or when blocked > 0.5s; face the walk direction; press jump when blocked on the ground.
  In 'live', waypoint choice biases toward the enemy team's half of the map (z sign of their spawns).
- **Buy:** when canBuy: rifle if money ≥ price, else smg if affordable, else null.
- **Determinism:** one seeded rng stream per brain; no Math.random, no Date, no I/O.

### `games/fps/server/src/economy.ts` (S3)```ts
export function tryBuy(money: number, owned: WeaponId[], want: WeaponId, canBuy: boolean):
  { ok: true; money: number; owned: WeaponId[] } | { ok: false; reason: string };
// knife+pistol are always owned & never buyable. Primary slots: smg/shotgun/rifle/sniper —
// buying one REPLACES the current primary (no refund). Checks in order:
// !canBuy -> 'buy time expired'; !buyable -> 'not for sale'; owned -> 'already owned';
// money < price -> 'insufficient funds'.
export function killReward(money: number): number;                    // +ECONOMY.killReward, clamp max
export function roundRewards(winner: Team | null): { t: number; ct: number }; // win/lossReward, clamp handled by caller
```

### `games/fps/server/src/rooms.ts` (S1)
```ts
export class Lobby {
  constructor();
  handleMessage(sess: Session, msg: C2S): void; // list_rooms/quick_join/create_public/create_private/
  // join_private/leave/add_bot/remove_bot + routes input/reload/switch/buy to the session's room
  handleDisconnect(sess: Session): void;
  roomCount(): number;
}
```
- quick_join: first public room with players < MAX_PLAYERS (players = connected humans only, never bot fill; prefer warmup), else create (random map
  via rng(Date.now()) — server-side only exception to the seeded-rng rule).
- create_public: new PUBLIC room on the requested map (appears in list_rooms), then join it.
- create_private: new room, code = 5 chars [A-Z0-9] via same rng; join_private validates code (error
  msg `{t:'error', code:'no_room'}`). Room full ⇒ `{t:'error', code:'room_full'}`.
- Empty private room ⇒ closed immediately. Empty public room ⇒ closed after 30s.
- If MAX_ROOMS rooms exist, quick_join/create_private fail with `{t:'error', code:'rooms_full'}`.
- A session is in ≤1 room; `leave` returns it to lobby state (can rejoin/list).

### `games/fps/server/src/index.ts` (S1)
Entry: `PORT = env PORT ?? 8080`; creates NetServer + Lobby, wires hooks, staticDir =
`../client/dist` relative to server dist when it exists (production), else null. Closes sockets of
players reported by `room.stalePlayers()` (poll every 1s via each room's tick — S1 may poll
`lobby` every 1s; expose nothing extra, S1 iterates its own session↔room map and calls
`stalePlayers()` on the rooms it created).

## Frozen visual contract surfaces (architect-owned; implementers consume, never edit)

### `games/fps/shared/src/matColors.ts`
```ts
export const MAT_COLORS: Record<MatId, string>;        // every MatId -> a PALETTE entry
// Ladder partners, keyed by MatId (VISUAL_UPGRADE.md §1). CONTACT_MAT and TRIM_MAT are NULLABLE:
// null means the material already sits at the bottom / top of its own value ladder, and
// articulate() then SKIPS that element instead of emitting zero-contrast trim.
export const CONTACT_MAT: Record<MatId, MatId | null>; // plinth / contact band, >= 8 L* BELOW (L2a)
export const TRIM_MAT: Record<MatId, MatId | null>;    // cornice / mid rail, >= 8 L* ABOVE (L3)
export const DARK_MAT: Record<MatId, MatId>;           // alternating pilaster tier; never null
export type ImpactKind = 'dust' | 'spark' | 'snow' | 'chip' | 'leaf';
export const IMPACT_MAT: Record<MatId, ImpactKind>;    // impact particle family per material
```
Every table covers the FULL `MatId` union in `games/fps/shared/src/maps/types.ts` (value-tiered:
`…Lit / base / …Dark / …Deep` per family). Adding a `MatId` means adding a row to every table here
as well as to the union.

### `games/fps/client/src/contract/visual.ts` — articulation helpers
The `mat/box/cyl/cone/sphere/at/bake` factories are unchanged (rule 5). Added for wall articulation:
```ts
export interface ArticulateColors {
  body: string;           // the wall's own colour — MAT_COLORS[b.mat]
  trim: string | null;    // cornice / mid rail, >= 8 L* above body — TRIM_MAT; null to skip
  dark?: string | null;   // alternating pilaster tier — DARK_MAT; falls back to body
  contact: string | null; // plinth, >= 8 L* below body — CONTACT_MAT; null to skip
}
export interface ArticulateOpts {
  plinthH?: number;       // default 0.32 m (0 disables)
  corniceH?: number;      // default 0.18 m (0 disables)
  pilasterEvery?: number; // default 5 m along the long axis (0 disables)
  plinthProud?: number;   // default 0.04 m per face
  corniceProud?: number;  // default 0.06 m per face
  pilasterProud?: number; // default 0.05 m per face
  midRail?: boolean;      // auto-enabled for walls taller than 4 m
}
export function articulate(
  w: number, h: number, d: number, colors: ArticulateColors, opts?: ArticulateOpts,
): THREE.Group;
// Trim set (VISUAL_UPGRADE.md §3b) for a w x h x d box centred on the origin — add it as a SIBLING
// of the wall at the same position. Returns an EMPTY group below h 0.9, so callers may add it
// unconditionally. mapRenderer.ts ONLY: trim must never be authored as extra BoxDefs, because
// MapDef.boxes is the server's collision source.
export const CONTACT_Y: number; // 0.02 — contact-shadow height above the ground plane
export function contactShadow(radius: number, opacity?: number): THREE.Mesh;
// Flat PALETTE.ink disc under a prop or character (opacity default 0.5) — the texture-free stand-in
// for ambient occlusion. Every scattered prop and every character gets one.
```

## Module table — client (tasks C1..C11)

### `games/fps/client/src/net/connection.ts` (C1)
```ts
export class Connection {
  onMessage: ((msg: S2C) => void) | null = null;
  onClose: (() => void) | null = null;
  connect(url?: string): Promise<void>; // default `${wss?}://${location.host}/ws`
  send(msg: C2S): void;
  pingMs(): number;            // smoothed EMA (α=0.2), from app-level ping/pong every NET.pingEveryMs
  serverOffsetMs(): number;    // frozen formula: offset = pong.serverTime + rtt/2 − performance.now();
  // keep the sample with the lowest RTT seen so far (min-RTT filter); serverNow = performance.now() + offset
  close(): void;
}
```

### `games/fps/client/src/net/interpolation.ts` (C1)
```ts
export class InterpBuffer {
  push(serverTimeMs: number, players: PlayerSnap[]): void;
  sample(renderServerTime: number): PlayerSnap[]; // lerp between the two snapshots bracketing
  // renderServerTime; extrapolate position only, <= NET.interpMaxExtrapolateMs; snap if > 10m teleport
  reset(): void;
}
```

### `games/fps/client/src/net/prediction.ts` (C1)
```ts
export interface PendingInput { seq: number; input: MoveInput; }
export class Predictor {
  constructor(solids: AABB[]);
  reset(x: number, y: number, z: number): void;
  pushInput(p: PendingInput, speedMul: number): void; // local stepBody(TICK_DT) + store
  reconcile(x: number, y: number, z: number, height: number, vy: number, ackSeq: number, speedMul: number): void;
  // set authoritative state (INCLUDING vy from YouSnap.vy so gravity replays correctly mid-jump),
  // replay stored inputs with seq > ackSeq; snap if error > 1m
  body(): BodyState;   // live reference, read-only by convention
}
```

### `games/fps/client/src/input/input.ts` (C2)
```ts
export type InputEdge =
  | { kind: 'reload' } | { kind: 'slot'; n: number } | { kind: 'buy' }
  | { kind: 'scoreboard'; down: boolean } | { kind: 'menu' };
export class InputController {
  yaw: number; pitch: number;
  constructor(canvas: HTMLElement);
  start(): void; stop(): void;
  frame(): { moveX: number; moveZ: number; buttons: number }; // WASD/jump/crouch/fire/alt held state
  edges(): InputEdge[];    // drains queue (R, 1-6, B, Tab, Esc, wheel = slot +/-)
  locked(): boolean;
  setZoomed(z: boolean): void;  // reduces sensitivity while scoped
  onLockChange: ((locked: boolean) => void) | null;
}
```
Keys: WASD move · Space jump · C crouch · Shift walk (slow + quiet) · LMB fire · RMB **or F** alt
(scope) · R reload · B buy · Tab scoreboard (preventDefault) · Esc menu · 1-6 / wheel weapon
slots · **Q quick-switch** (previous weapon) · **`~` developer console**. Blur clears all held state.
`contextmenu` is preventDefault'd at the DOCUMENT level while pointer-locked (belt-and-braces —
canvas-only suppression loses to browser edge cases).
Ctrl is deliberately UNBOUND: Ctrl+W / Ctrl+R / Ctrl+Tab are unpreventable browser shortcuts
(close/reload/switch tab) and Ctrl+click is right-click on macOS — binding crouch to Ctrl kills
the game tab the first time someone crouches while moving forward.

## Developer console (frozen)

CS-style console on the `~`/Backquote key: toggles a DOM overlay (pointer unlocked while open;
game input suppressed except Esc, which closes it; Enter executes). While open, keystrokes go
to its input. Commands (case-insensitive, `/`-prefix optional):
- `help` — list commands in the output log
- `addbot [n]` / `bot_add [n]` — add n bots (default 1)
- `removebot` / `bot_kick` — remove the most recent bot
- `jointeam t|ct` — request a team switch (same guard as the pause-menu buttons)
- `buy <weapon>` — buy by weapon id (knife/pistol/smg/shotgun/rifle/sniper)
- `kill` — suicide (server: C2S 'suicide', death with killerId null)
The console echoes `> cmd` then the result line (ok or the error reason). e2e hook:
`__fps.debug.console(text)` executes a command exactly like Enter (clientGame.consoleExec).
Quick-switch (frozen): Q swaps to the previously HELD weapon (client tracks the last two held;
server 'switch' message as usual).
Semi-auto fire latch: a fire press that begins AND ends between two frame() samples must still be
reported once — latch INPUT_FIRE until it has been included in exactly one frame() result.

### `games/fps/client/src/render/scene.ts` (C3)
```ts
export class SceneRig {
  readonly renderer: THREE.WebGLRenderer; readonly scene: THREE.Scene; readonly camera: THREE.PerspectiveCamera;
  constructor(canvas: HTMLCanvasElement);
  setTheme(theme: MapTheme): void; // hemisphere+sun(shadows 2048 PCFSoft, frustum sized to map),
  // FogExp2(theme.fog, fogDensity), clear color theme.sky
  applyCamera(pos: Vec3, yaw: number, pitch: number, fovDeg: number): void; // + shake decay
  shake(amount: number): void;  // trauma 0..1, decays ~2.5/s, offset = small rotational noise
  resize(): void; render(): void; dispose(): void;
}
```
Renderer: ACESFilmicToneMapping, SRGB output, antialias, pixelRatio ≤ 2, shadowMap enabled PCFSoft.

### `games/fps/client/src/render/mapRenderer.ts` (C3)
```ts
export function buildMap(map: MapDef): { root: THREE.Group; solids: AABB[] };
// ground plane (sizeX+8 x sizeZ+8, floorMat color, receiveShadow)
// sky dome: r=400 inverted sphere, vertex-color gradient theme.sky -> theme.horizon
// (MeshBasicMaterial with fog:false; raw BufferGeometry permitted for the dome as a factory exception)
// boxes -> box() meshes at exact BoxDef coords, color = MAT_COLORS[mat], then bake()
// deco: per DecoZone scatter via rng(decoSeed(map.id, zoneIndex)); reject < minSpacing, inside a
//   solid, or < 2.5m from any spawn; all props baked into the same static group
```
`MAT_COLORS`, `CONTACT_MAT` and `TRIM_MAT` are owned by `games/fps/shared/src/matColors.ts` (above)
and merely **re-exported** here for existing importers — never redefined.
`MapTheme` also carries `skyHigh` (the zenith stop) per VISUAL_UPGRADE.md §1 S1.

### `games/fps/client/src/render/playerModels.ts` (C4)
```ts
export class PlayerModels {
  constructor(scene: THREE.Scene);
  sync(players: Array<PlayerSnap & { team: Team; name: string }>, localId: PlayerId, dt: number): void;
  // creates/removes models; localId model hidden. Per-frame: position/yaw, walk swing when moving,
  // crouch pose, death fall (0.4s) + sink after 2s. Nameplate sprite above head (team color).
  muzzle(id: PlayerId): void;  // brief muzzle-flash quad at gun tip
  clear(): void;
}
```

### `games/fps/client/src/render/viewModel.ts` (C5)
```ts
export function makeWeaponModel(id: WeaponId): THREE.Group; // used by viewmodel AND playerModels (C4)
export class ViewModel {
  constructor(camera: THREE.Camera);
  setWeapon(id: WeaponId): void;   // swap with 0.25s lower/raise
  update(dt: number, moving: boolean, scoped: boolean): void; // walk bob + idle sway; hidden when scoped
  fire(): void;                    // recoil kick (recovering spring) + muzzle flash quad 40ms
  reload(durSec: number): void;    // dip + tilt animation
}
```

### `games/fps/client/src/render/effects.ts` (C6)
```ts
export class Effects {
  constructor(scene: THREE.Scene);
  tracer(from: Vec3, to: Vec3): void;   // 60ms fading line (tracer color)
  impact(p: Vec3, mat?: MatId): void;   // 6-10 particles; family from IMPACT_MAT[mat] (@fps/shared)
  decal(p: Vec3): void;                 // bullet mark: small dark splat quad at the hit point,
  // camera-facing, offset slightly along (camera - p) so it doesn't z-fight; pooled 64, fade out
  // after 45s, oldest recycled. Spawned for wall hits only (NOT on player hits).
  blood(p: Vec3): void;                 // 5-8 blood particles
  death(p: Vec3, team: Team): void;     // 12 team-colored burst particles
  update(dt: number): void;             // advances pools; zero allocation after warmup
  clear(): void;
  dispose(): void;                      // teardown: dispose non-cached materials/geometries
}
```
Pooled: ≤ 64 tracers, ≤ 256 particles total. `THREE.Points` + small quad meshes; reuse.

### `games/fps/client/src/audio/audio.ts` (C7)
```ts
export type SfxKind = 'shot_knife' | 'shot_pistol' | 'shot_smg' | 'shot_shotgun' | 'shot_rifle'
  | 'shot_sniper' | 'reload' | 'hit' | 'headshot' | 'death' | 'footstep'
  | 'round_start' | 'round_end' | 'buy' | 'deny' | 'win' | 'lose' | 'click' | 'multikill';
export class AudioEngine {
  constructor();
  resume(): void;  // creates/unlocks AudioContext on first user gesture; all calls safe before that (no-op)
  sfx(kind: SfxKind, opts?: { dist?: number; vol?: number }): void; // dist: full <10m .. 0 at 45m
  ambient(outdoor: boolean): void; // soft filtered-noise wind loop outside, low hum inside
}
```
Fully synthesized (oscillators + noise buffers, envelopes, filters). Each shot kind distinct
(crack/boom/pop). `hit` = short tick, `headshot` = higher ding, `death` = thud, round/win stingers.

### `games/fps/client/src/ui/hud.ts` (C8)
```ts
export interface HudState {
  hp: number; alive: boolean; money: number; canBuy: boolean;
  weapon: WeaponId; weaponName: string; mag: number; reserve: number;
  phase: RoomPhase; phaseEndsInSec: number; round: number; scoreT: number; scoreCT: number;
  spreadPx: number; scoped: boolean; spectating: string | null;
}
export class Hud {
  constructor(root: HTMLElement);
  update(s: HudState): void;
  killfeed(killer: string | null, victim: string, weapon: WeaponId, headshot: boolean): void; // ≤5, fade 5s
  hitmarker(headshot: boolean, killed: boolean): void; // 120ms flash, red on kill/headshot
  damageFrom(yawRelative: number): void;  // red arc segment towards damage source, 0.8s fade
  banner(title: string, sub: string): void; // big center text 2.5s (round start/end)
  show(on: boolean): void;
}
```
DOM-based, pointer-events none. Crosshair: 4 lines, gap = spreadPx; hidden while scoped; scope
overlay = black vignette + thin cross + circle when scoped. Layout/colors per UX_BIBLE.md.

### `games/fps/client/src/ui/menus.ts` (C9)
```ts
export interface MenuCallbacks {
  onQuickJoin(name: string): void;
  onCreatePublic(name: string, mapId: MapId): void;
  onCreatePrivate(name: string, mapId: MapId): void;
  onJoinPrivate(name: string, code: string): void;
  onListRooms(): Promise<RoomInfo[]>;
  onBuy(weapon: WeaponId): void;
  onAddBot(): void;
  onRemoveBot(): void;
  onSwitchTeam(team: Team): void; // request team change (server guards balance)
  onResume(): void;  // re-request pointer lock
  onLeave(): void;   // leave room -> main menu
}
export class Menus {
  constructor(root: HTMLElement, cb: MenuCallbacks);
  showMain(errorText?: string): void; // name field, Quick Join, ONE map picker grid (6 maps) with
  // two buttons: Create Public (listed) + Create Private (code), Join Private (+code), public room
  // list with refresh. Out-of-room only (Esc in-room = showPause).
  showInRoom(roomLabel: string, code: string | null): void; // small top-left chip while playing
  showBuy(money: number, owned: WeaponId[], canBuy: boolean): void;
  hideBuy(): void;
  showScoreboard(roster: RosterEntry[], you: PlayerId, scoreT: number, scoreCT: number): void;
  // columns: NAME (bot entries get a 'BOT' tag), K, D, HS (headshots), $ (own row only)
  hideScoreboard(): void;
  showMatchEnd(winner: Team, scoreT: number, scoreCT: number, youTeam: Team | null, roster: RosterEntry[]): void;
  // includes top-3 players by kills from roster
  showJoining(): void;   // dim overlay "Joining…" — required state, shown during connect+join
  showPause(botCount: number, youTeam: Team | null): void; // in-room Esc surface: Resume (re-lock),
  // ADD BOT, REMOVE BOT (disabled at 0 bots), JOIN T / JOIN CT (your current team disabled),
  // Leave Room; NOT the main menu
  hideAll(): void;
}
```
Buy menu: cards for smg/shotgun/rifle/sniper with name, price, dmg/rpm/mag stats; disabled state
when unaffordable or !canBuy; knife+pistol shown as "issued". Styling per UX_BIBLE.md.

### `games/fps/client/src/game/state.ts` (C10)
```ts
export class ClientState {
  youId: PlayerId | null; team: Team | null; roomId: RoomId | null; code: string | null;
  mapId: MapId | null; phase: RoomPhase; phaseEndsAt: number; round: number;
  scoreT: number; scoreCT: number;
  roster: Map<PlayerId, RosterEntry>;
  latestYou: YouSnap | null;
  serverOffset: number; // ms; serverNow() = performance.now() + offset
  serverNow(): number;
}
```

### `games/fps/client/src/game/clientGame.ts` (C10)
```ts
export class ClientGame {
  constructor(opts: { canvas: HTMLCanvasElement; hud: Hud; menus: Menus; state: ClientState });
  joinQuick(name: string): void; createPublic(name: string, mapId: MapId): void;
  createPrivate(name: string, mapId: MapId): void;
  joinPrivate(name: string, code: string): void; listRooms(): Promise<RoomInfo[]>; leave(): void;
  frame(nowMs: number): void;  // rAF: input->send at TICK_RATE, prediction, interp, scene update,
  // models/viewmodel/effects/hud update, audio listener
  dispose(): void;
}
```
Wires Connection + InputController + SceneRig + buildMap + PlayerModels + ViewModel + Effects +
AudioEngine against ClientState, per this contract. Handles all S2C messages and GameEvents
(sounds, killfeed, hitmarkers, shake, banners, spectate). Own weapon switch cancels reload client-side.
Fire events: local fire animation immediately; server hit event confirms.

### `games/fps/client/src/main.ts` + `games/fps/client/src/style.css` + `client/index.html` (C11)
App shell: full-viewport canvas, #hud + #menu overlay roots, creates Menus/Hud/ClientState/ClientGame,
rAF loop, resize handler, first-gesture audio resume, `?debug` overlay (tick/ping/pos/fps).
Exposes the frozen debug surface (used by e2e):
```ts
window.__fps = {
  state(): unknown; // JSON-safe: { phase, roomId, code, mapId, team, hp, alive, pos:[x,y,z],
  // players, rosterSize, ping, money, mag, reserve, round, scoreT, scoreCT, weapon }
  joinQuick(name: string): void;
  createPublic(name: string, mapId: MapId): void;
  createPrivate(name: string, mapId: MapId): void;
  joinPrivate(name: string, code: string): void;
  addBot(): void; removeBot(): void;
  debug: {
    setLook(yaw: number, pitch: number): void;
    setMove(x: number, z: number): void;
    press(btn: 'fire' | 'jump' | 'crouch' | 'alt', down: boolean): void;
    reload(): void; buy(w: WeaponId): void;
    scoreboard(down: boolean): void; // e2e-only mirror of the Tab edge
    switchTeam(team: Team): void;    // e2e-only mirror of the pause-menu team buttons
  };
};
declare global { interface Window { __fps?: ... } }
```

## Per-asset visual spec (model sheets — silhouettes + parts + storytelling)

**Soldier** (`playerModels.ts`, 22–32 prims, ~1.8u tall): blocky humanoid, more realistic
proportions (not a cube-stack): torso box slightly tapered (two stacked boxes, chest wider than
waist) in team uniform (CT ctBlue chest/ctDark limbs; T tAmber chest/tBrown limbs); a vest plate
box on the chest (team dark); shoulder pads (small team-dark boxes on the shoulders); a backpack
box on the back (team dark); head box (skin) + helmet with a brim (slightly wider box + thin brim
slab, team dark) + a visor/goggle strip across the eyes (ink); TWO-SEGMENT arms (upper arm +
forearm pivot at elbow) angled forward holding the weapon two-handed (right at grip, left at
forend); two-segment legs (thigh + shin pivots) with boot boxes (ink); weapon =
makeWeaponModel(current) scaled 0.9 in hands; nameplate sprite 0.35u above head (name text, team
color on translucent ink bg). Walk: thighs/shins counter-swing ±25° sin(phase), arms counter-swing
subtly, phase from distance travelled; idle: subtle torso breathe; AIM POSE: the arms+weapon pivot
group pitches with the player's pitch (±0.6 rad clamp) AND the head follows pitch at 0.5× so you
can read where someone aims; HIT FLINCH: when a model's hp drops between snapshots, a 100ms torso
jolt (small backward pitch impulse) — sell the hit; crouch: legs bend (thigh forward, shin down),
torso -0.35u; death: whole group rotates to lying over 0.4s, sinks 1u after 2s.

**Weapons** (`viewModel.ts` `makeWeaponModel`, 6–12 prims each, metalDark/charcoal bodies):
- knife: 0.5u blade (steel box, tapered tip via scaled cone) + woodDark grip; held tilted.
- pistol: compact box slide + grip + short barrel; charcoal/steel.
- smg: stubby receiver, vented barrel shroud (3 thin boxes), curved mag (angled box), stock; charcoal.
- shotgun: long tube + barrel (2 cyls), wood pump + stock; wood/metalDark.
- rifle: long barrel + front sight post, curved wood mag, wood stock + grip; metalDark/wood.
- sniper: longest thin barrel, scope tube (cyl) on two mounts, bipod stubs, woodDark stock; ink/woodDark.
Viewmodel: arms (team sleeve box + skin-tone? no — glove boxes, charcoal) holding weapon bottom-right
of camera, fov-independent (rendered in camera space, scale ~0.6).

**Deco props** (`mapRenderer.ts` factories, 3–10 prims each):
- crate: wood box + 4 edge battens (woodDark), slight rng rotation.
- barrel: cyl (steel or tBrown by rng) + 2 rim rings (torus? no — thin cyl bands).
- pallet: 3 slats over 2 beams, wood.
- pipe: horizontal cyl (steel) + 2 ring flanges + elbow bend (second cyl at 90°).
- rock: 2–3 overlapping squashed spheres (rockDark), rng scale/squash.
- shrub: 2–3 small leaf/leafDark spheres on tiny trunk.
- cactus: green column + 1–2 arm columns (cactus), 5–7 prims.
- snowRock: rock recipe in snowShadow + snow cap sphere on top.
- plant: thin cyl pot (brick) + 3 leaf spheres.
- paperStack: 2–4 thin paper boxes, slight rotation offsets, on/under desks zones.

**FX**: muzzle flash = 2 crossed emissive quads (muzzle) 40–60ms; tracer = thin additive line/box
(tracer) fading in 60ms; impact = dust puff (concrete) + 2 sparks (muzzle); blood = small blood
burst; death burst = 12 team-color particles; all pooled.

## Map specs (tasks M1–M5) — replace placeholder file CONTENTS, keep format

Invariants for every map (checked by reviewers): enclosed outer walls h≥4 (indoor: h≥3 + ceiling);
≥3 distinct routes between spawns (bunker/office: ≥2 + a loop); no T spawn visible from any CT spawn;
cover (box or prop-height ≥0.9) at least every 8m along each route; longest open sightline ≤ 42m
(office/bunker ≤ 25m); ≥6 spawns/team on y=0 outside all boxes; corridors ≥1.4m wide;
40–90 boxes each; deco zones totalling 40–100 props. Floor + theme per STYLE_BIBLE.md section.

- **M1 crossfire** (industrial yard, 56×40): concrete/metal world. Warehouse block with a loading
  dock (0.8-high platform + step boxes), container stacks (metal, 2.6 high, some double-stacked),
  pipe runs, pallet piles; mid crane-leg gantry. Deco: barrel/pallet/pipe.
- **M2 office** (indoor office floor, 40×32): cubicle grid (1.1-high partitions = chest cover),
  desk rows with paperStacks/plants, a server room (metal racks), corridor ring, 2 meeting rooms.
  Ceiling y≈3.2. Deco: paperStack/plant. carpet/plaster/desk mats.
- **M3 frostbite** (snowfield, 60×44): ice ridge lanes, rock clusters, a frozen creek gully
  (0.6-deep trench with ice floor — walkable via slopes of 0.4 steps), snowdrifts (low wide snow
  boxes). Deco: snowRock/shrub. Strong cold fog.
- **M4 urbana** (old town, 56×44): brick/plaster buildings (solid blocks, no interiors) forming a
  central street + two alleys + plaza; market crates/barrels; a cart (box + cyl wheels); roofline
  variety via roofRed caps (visual height only, not reachable). Deco: barrel/shrub.
- **M5 bunker** (underground CQB, 32×32): concreteDark/metalDark corridors 2–2.5m wide, 4 rooms,
  central hub, crate stacks, pipe runs along walls, ceiling y≈2.8, darkest map. Deco: pipe/barrel.

## Non-functional budgets

- 60 FPS on a 2020 laptop at 1080p with 10 players: draw calls ≤ 550 at peak (map+deco ≤ 30 baked,
  soldier ≤ 28, weapon ≤ 12, fx pooled), shadow map 2048 one cascade, particles pooled, zero
  per-frame allocations in render/tick hot paths.
- Server: one room tick ≤ 2ms at 10 players; JSON snapshots OK at this scale.
- Cold load: client bundle ≤ 1.5MB gz (three is most of it — no other heavy deps).
- Robustness: server survives any malformed ws payload; client survives server restart (show main
  menu with error text); blur clears keys; resize never breaks aspect.
- Accessibility: HUD text ≥ 12px at 1080p, team identity never by color alone (nameplates have
  team-colored bg + white text; scoreboard has team labels), hit feedback visual AND audio.

## Debug & test surface

- `window.__fps` as specced under C11 — required by scripts/e2e.mjs.
- Unit tests (task T1): `games/fps/shared/src/physics.test.ts` (walk, wall slide, step-up, crouch-block-stand,
  hitscan head/body/wall-block, falloff, spread determinism), `games/fps/shared/src/protocol.test.ts`
  (accept/ reject cases), `games/fps/server/src/game.test.ts` (buy flow ok/fail, elimination ends round,
  kill reward, warmup→freeze transition at 2 players) using a fake RoomIO.
