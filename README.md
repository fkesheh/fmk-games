# STRICKEN (+ BANK + KART GP) — multiplayer game platform

A browser multiplayer game platform with three games sharing one server:
- **STRICKEN** (`/fps/`) — tactical FPS in the spirit of Counter-Strike
- **BANK** (`/bank/`) — the classic push-your-luck dice party game (canonical Bank rules)
- **KART GP** (`/kart/`) — multiplayer kart racing: drift physics, 3-lap races, one circuit

`/` is a launcher page; all games ride one WebSocket (`/ws`). Everything is
procedural: no assets — flat-shaded low-poly 3D (FPS, KART), DOM/CSS 3D dice
(BANK), synthesized WebAudio throughout, colors from frozen palettes.

## KART GP — driving model & rules

Arcade-sim kart physics (client-simulated, server-refereed): engine/brake curves,
bicycle steering with speed-sensitive lock, surface grip (asphalt vs grass),
barrier collisions, and handbrake **drift** — hold a drift ≥1.2s to charge a
mini-turbo. Races: 5s grid → 3-2-1-GO → 3 laps → results. Up to 8 karts, ranked
by checkpoint progress (gates in order, server-authoritative), best-lap tracking,
mid-race join at the back, public/private rooms. Controls: WASD/arrows drive,
Space/Shift drift, R respawn at last gate.

## BANK — rules (canonical)

Two dice per turn into a shared pot, players rolling in join order. The first 3
rolls of a round are safe — a 7 there is worth **70**. After that: **a 7 busts the
round** (pot lost), **doubles double the pot**. Anyone may **BANK** at any time —
pocket the current pot value and sit out the round (the pot keeps growing for the
rest). Round ends on a bust or when everyone's banked. 10 rounds, highest banked
total wins. 30s turn timer (server auto-rolls), up to 8 players, private rooms
with share codes, quick-join public rooms.

## Features

- **Round-based team elimination** (T vs CT, up to 5v5): freeze-time buys → live round →
  halftime side swap → first to 6 rounds wins. CS-style economy: kill/round rewards, save/buy
  decisions. Stats: per-player headshots (scoreboard HS column) and multikill announcements
  (double/triple/quad/ace).
- **6 weapons**: knife, P9 pistol (issued), K90 SMG, M870 shotgun, AK-4 rifle, AWM sniper
  (right-click scope) — distinct damage/range/spread/price profiles.
- **6 maps**: Dustbowl (dusk desert), Crossfire (industrial yard), Office (indoor cubicles),
  Frostbite (snow valley), Urbana (old town), Bunker (underground CQB with skylights).
- **Server-side bots** — add/remove from the pause menu (Esc) to fill a game (e.g. 4v4); they
  patrol with BFS pathfinding, engage on sight with reaction time/burst discipline, buy rifles,
  take normal roster slots (BOT tag), and yield their slot when a human joins a full room.
- **Public rooms** (quick join + room list + create-public with map picker) and **private rooms**
  (5-char share code, pick the map).
- **Feel**: client prediction + lag-compensated hits, tracers, bullet-hole decals, hit markers,
  directional damage indicators, screen shake, footsteps and shots audible by distance.
- **Server-authoritative physics**: movement, collision, and lag-compensated hitscan all run
  server-side at 30Hz; the client runs the same shared physics for prediction, with 120ms
  interpolation for remote players. Warmup with free respawn until 2+ players.

## Quick start

```bash
npm install
npm run dev        # server on :8080, client on :5173 (open http://localhost:5173)
```

Production (single process serves both HTTP and WS):

```bash
npm run build && npm start   # http://localhost:8080
```

## Deploy (Fly.io)

Deploy-ready config is included (`deploy/Dockerfile`, `fly.toml`):

```bash
fly launch --no-deploy   # or edit fly.toml app name first
fly deploy
```

The server serves the built client and the `/ws` endpoint on port 8080.

## Controls

WASD move · mouse look · LMB fire · RMB / F scope (AWM) · Space jump · C crouch ·
R reload · B buy menu · Tab scoreboard · 1-6 / wheel weapons · Esc pause

## Repo layout (platform + games)

This is a multi-game monorepo (see `docs/STRUCTURE.md`). The platform owns transport,
matchmaking, and rooms; games plug in via one registry entry. Adding a new game = a new
`games/<id>/` directory + registering it in `platform/server/src/registry.ts`.

- `platform/shared/` — game-agnostic contract: rng, lobby protocol, the `GameModule` interface
- `platform/server/` — ws/http transport (`net.ts`), matchmaking (`lobby.ts`), entry (`index.ts`)
- `games/fps/shared/` — STRICKEN's frozen contract: wire types, balance config, palette,
  physics, 6 map data files
- `games/fps/server/` — the FPS game module: game room (`game.ts`), combat/economy
  (`combat.ts`, `economy.ts`), bot brains (`bots.ts`), registry plug (`module.ts`)
- `games/fps/client/` — three.js game client: prediction/interp (`net/`), renderer (`render/`),
  HUD/menus (`ui/`), orchestration (`game/`), synthesized audio (`audio/`)
- `games/bank/{shared,server,client}` — BANK dice: rules contract, turn-based room, felt-table UI
- `CONTRACT.md` — the frozen FPS contract; `docs/STRUCTURE.md` — the platform contract;
  `docs/BANK.md` — the BANK game contract
- `scripts/e2e.mjs` — two-browser FPS suite · `scripts/e2e-bank.mjs` — two-browser BANK suite

## Gates

```bash
npm run typecheck    # strict TS, all workspaces
npm test             # 37 unit tests (physics, protocol, game logic)
npm run build        # client bundle + server bundle
node scripts/e2e.mjs # 10/10 browser assertions, zero console errors
```
