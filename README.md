# STRICKEN (+ BANK + KART GP + WORDBOMB + ANCIENTS) — multiplayer game platform

A browser multiplayer game platform with five games sharing one server:
- **STRICKEN** (`/fps/`) — tactical FPS in the spirit of Counter-Strike
- **BANK** (`/bank/`) — the classic push-your-luck dice party game (canonical Bank rules)
- **KART GP** (`/kart/`) — multiplayer kart racing: drift physics, 3-lap races, one circuit
- **WORDBOMB** (`/wordbomb/`) — simultaneous word game: one fragment, a hidden fuse, every
  answer revealed at once
- **ANCIENTS** (`/rift/`) — a mini MOBA: push lanes, last-hit for gold, raze towers, break
  the enemy Ancient. 2v2–8v8 with bot fill, fog of war, generated maps

`/` is a launcher page; all games ride one WebSocket (`/ws`). Everything is
procedural: no assets — flat-shaded low-poly 3D (FPS, KART), DOM/CSS 3D dice
(BANK), DOM/CSS typography (WORDBOMB), synthesized WebAudio throughout, colors
from frozen palettes.

## WORDBOMB — rules

Ten rounds, no elimination. Every player sees the same 3-letter fragment (`TIO`,
`BLE`, `STR`) at the same instant and types a word containing it; a **hidden**
fuse burns while they type. Enter locks a word in — the server validates it
instantly and **privately**, and you may re-lock as often as you like: your last
valid word stands. When the bomb blows, **every answer is revealed
simultaneously**.

Scoring rewards being both long *and* unique: `points = max(L, floor(12·L /
dupes^1.5))` with `L = min(length, 12)` — a unique 12-letter word is the 144-point
cap, but three players sharing one is worth 27 each, less than a unique 6-letter
word. No self-reuse: a word only scores once per player per match. Server is the
only judge — the ~270k-word dictionary never ships to the browser. Up to 8
players, public quick-join and private share-code rooms, 3 difficulty bands
(default `normal`).

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
npm run dev        # server :8080 · fps :5173 · bank :5174 · kart :5175 · wordbomb :5176 · rift :5177
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

WASD move · mouse look · LMB fire · RMB / F scope (AWM) · Space jump · C / Caps Lock crouch ·
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
- `games/kart/{shared,server,client}` — KART GP: kart physics contract, race room, three.js circuit
- `games/wordbomb/{shared,server,client}` — WORDBOMB: scoring/protocol contract, round room +
  binary-searched dictionary blob (`server/data/words.blob`), DOM/CSS client
- `games/rift/{shared,server,client}` — ANCIENTS mini MOBA: frozen config/heroes/items/map-gen
  contract, 20Hz sim + vision-filtered snapshots, bot brains, three.js client with fog of war
- `CONTRACT.md` — the frozen FPS contract; `docs/STRUCTURE.md` — the platform contract;
  `docs/BANK.md`, `docs/KART.md`, `docs/WORDBOMB.md` — the per-game contracts;
  `games/rift/CONTRACT.md` — the ANCIENTS contract
- `scripts/e2e.mjs` — two-browser FPS suite · `scripts/e2e-bank.mjs` — BANK suite ·
  `scripts/e2e-kart.mjs` — KART suite · `scripts/e2e-wordbomb.mjs` — WORDBOMB suite ·
  `scripts/e2e-rift.mjs` — ANCIENTS suite · `scripts/verify-rift.mjs` — ANCIENTS visual/perf gate

## Gates

```bash
npm run typecheck        # strict TS, all workspaces
npm test                 # 402 unit tests (physics, protocol, game logic, scoring, dictionary)
npm run build            # four client bundles + server bundle
node scripts/e2e.mjs     # FPS: 10/10 browser assertions, zero console errors
npm run e2e:wordbomb     # WORDBOMB: 13 numbered two-browser assertions
```
