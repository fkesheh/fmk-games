# fps

Browser multiplayer FPS, npm-workspaces monorepo.

- `shared` (`@fps/shared`) — types / config / maps / physics, consumed as TypeScript source (no build step) via the `@fps/shared` specifier.
- `server` (`@fps/server`) — Node.js + `ws` authoritative game server (tsx in dev, esbuild bundle for production).
- `client` (`@fps/client`) — Vite + three.js.

## Getting started

```sh
npm install
npm run dev
```

This starts the game server on http://localhost:8080 and the Vite dev server on http://localhost:5173 (which proxies `/ws` to the server).

## Production

```sh
npm run build && npm start
```

`build` builds the client with Vite and bundles the server with esbuild; `start` runs the bundled server on :8080, which serves `client/dist` over HTTP and upgrades `/ws` to the WebSocket server.

## Gates

- `npm run typecheck` — `tsc --noEmit` in every workspace
- `npm test` — `vitest run` at the root
- `npm run build` — client + server production builds

## Utilities

```sh
node scripts/screenshot.mjs <url> <outfile.png> [width] [height] [waitMs]
```

Headless screenshot helper (puppeteer). Defaults: 1600x900, 3000 ms wait after network idle.
