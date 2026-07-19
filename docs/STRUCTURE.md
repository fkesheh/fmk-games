# STRUCTURE — platform + games (multi-game monorepo)

This repo is a game platform. The **platform** owns transport, matchmaking, and room lifecycle;
**games** are self-contained modules (shared contract + server logic + client app) registered in
one server-side registry. Adding a new game = new `games/<id>/` directory + one registry entry.

## Layout

```
platform/
  shared/     @platform/shared — game-agnostic: rng, envelope protocol, GameModule contract
  server/     @platform/server — ws/http transport (net.ts), matchmaking (lobby.ts), entry (index.ts)
games/
  fps/        STRICKEN (tactical FPS)
    shared/   @fps/shared   — frozen game contract (types/config/physics/maps/palette)
    server/   @fps/server   — GameRoom, combat, economy, bots (no entry point here!)
    client/   @fps/client   — three.js game client (Vite app)
scripts/      e2e + capture tooling (per-game scripts live in games/<id>/ later if needed)
deploy/       Dockerfile + fly config (serves the platform server + game client dists)
```

## The GameModule contract (platform/shared/src/module.ts — frozen)

```ts
export interface RoomIO {
  send(id: PlayerId, msg: unknown): void;  // no-op for unknown ids (e.g. bots)
  rttMs(id: PlayerId): number;             // 0 for unknown ids
}
export type Visibility = 'public' | 'private';
export interface RoomInfo {
  id: string; code: string | null; game: string; label: string;
  players: number; maxPlayers: number; phase: string; visibility: Visibility;
}
export interface GameRoomHandle {
  readonly id: string;
  info(): RoomInfo;
  playerCount(): number;
  stalePlayers(): PlayerId[];              // platform closes their sockets
  addPlayer(id: PlayerId, name: string): void;   // sends the game's own join payload
  removePlayer(id: PlayerId): void;
  handleMessage(id: PlayerId, msg: unknown): void; // GAME parses its own room-level protocol
  start(): void; stop(): void;
}
export interface GameModule {
  readonly id: string;          // 'fps'
  readonly name: string;        // display name
  readonly clientDist: string;  // absolute path to the built client (served at /)
  createRoom(opts: { visibility: Visibility; io: RoomIO; settings?: Record<string, unknown> }): GameRoomHandle;
  // throws Error(message) on invalid settings — lobby forwards as {t:'error', code:'bad_settings'}
}
```

## Protocol envelope (split)

- **Lobby-level** (parsed + handled by the platform lobby): `list_rooms`, `quick_join {name, game?}`,
  `create_public {name, game?, settings?}`, `create_private {name, game?, settings?}`,
  `join_private {name, code}`, `leave`, `ping`. `game` defaults to the first registered module.
- **Room-level** (everything else): the lobby parses only the envelope `{t: string}` and routes the
  RAW parsed object to `GameRoomHandle.handleMessage`. The game validates with its own parser
  (fps: `parseC2S` from `@fps/shared`).
- Lobby errors: `no_room`, `room_full`, `rooms_full`, `unknown_game`, `bad_settings`.

## Rules

1. Platform code imports NOTHING from `games/*`. Games import `@platform/shared` freely.
2. A game's server package has NO entry point; the platform entry owns http/ws/static.
3. The platform serves the client dist of the game the client will play (single-game: serve at /;
   multi-game: later a launcher page links to per-game paths — do not build the launcher yet).
4. Game code keeps its existing package names (`@fps/*`) — only directories move; game-internal
   imports and the fps client are unchanged.
5. Root gates must stay green: typecheck, unit tests, build, e2e (19/19).

## Migration map (what moved)

- `shared/` → `games/fps/shared/` (rng.ts re-exports `@platform/shared` rng for compat)
- `server/src/{game,combat,economy,bots}.ts` + `game.test.ts` → `games/fps/server/src/`
- `server/src/{net,rooms,index}.ts` → `platform/server/src/{net,lobby,index}.ts`
  (rooms.ts is generalized into lobby.ts: registry-driven room creation, opaque room routing)
- `client/` → `games/fps/client/`
- NEW: `platform/shared/` (rng moved here, module.ts contract, envelope protocol)
```
