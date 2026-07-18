# STRICKEN

A browser multiplayer tactical FPS in the spirit of Counter-Strike — three.js client,
authoritative Node.js WebSocket server, zero assets (all geometry procedural, all audio
synthesized, all colors from one frozen palette).

## Features

- **Round-based team elimination** (T vs CT, up to 5v5): freeze-time buys → live round →
  halftime side swap → first to 6 rounds wins. CS-style economy: kill/round rewards, save/buy
  decisions. Stats: per-player headshots (scoreboard HS column) and multikill announcements
  (double/triple/quad/ace).
- **6 weapons**: knife, P9 pistol (issued), K90 SMG, M870 shotgun, AK-4 rifle, AWM sniper
  (right-click scope) — distinct damage/range/spread/price profiles.
- **6 maps**: Dustbowl (dusk desert), Crossfire (industrial yard), Office (indoor cubicles),
  Frostbite (snow valley), Urbana (old town), Bunker (underground CQB with skylights).
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

WASD move · mouse look · LMB fire · RMB scope (AWM) · Space jump · Ctrl/C crouch ·
R reload · B buy menu · Tab scoreboard · 1-6 / wheel weapons · Esc pause

## Repo layout

- `shared/` — frozen contract: wire types, balance config, palette, physics, 6 map data files
- `server/` — authoritative server: transport (`net.ts`), matchmaking (`rooms.ts`),
  game room (`game.ts`), combat/economy (`combat.ts`, `economy.ts`)
- `client/` — three.js game: prediction/interp (`net/`), renderer (`render/`), HUD/menus
  (`ui/`), orchestration (`game/`), synthesized audio (`audio/`)
- `CONTRACT.md` — the frozen module/balance/visual contract everything was built against
- `scripts/e2e.mjs` — two-browser end-to-end suite (join, phases, movement, kill, buy)

## Gates

```bash
npm run typecheck    # strict TS, all workspaces
npm test             # 37 unit tests (physics, protocol, game logic)
npm run build        # client bundle + server bundle
node scripts/e2e.mjs # 10/10 browser assertions, zero console errors
```
