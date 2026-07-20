// ============================================================================
// Platform entry: wire NetServer <-> Lobby over the game registry, serve the
// generated launcher page at / and every registered game under /<gameId>/ —
// PROXIED to its vite dev server when GameModule.devPort answers (dev mode,
// per-prefix HMR included), else its built client dist with SPA fallback
// (production; games without a build on disk are listed but not mounted) —
// run the 1s stale sweep (closes sockets of input-stale/kicked players; the
// lobby reaps empty rooms in the same poll), and shut down cleanly on
// SIGTERM/SIGINT. A throwing hook must never kill the process: net.ts wraps
// hook calls, the lobby wraps its bodies, and the sweep wraps its poll.
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { GameModule } from '@platform/shared';
import { NetServer, probeDevServer, type Mount } from './net.js';
import { Lobby } from './lobby.js';
import { GAMES } from './registry.js';

const PORT = Number(process.env.PORT ?? 8080);

/**
 * Mounts for the multi-game layout: one '/<id>/' prefix per registered
 * module. A module whose devPort answers the one-shot probe is proxied to
 * that vite dev server (single dev entry point through this server);
 * otherwise its built client (index.html on disk) is served statically —
 * the only mode possible in production, where no vite server runs. A game
 * with neither is skipped here but still appears on the launcher (404s).
 */
async function resolveMounts(modules: readonly GameModule[]): Promise<Mount[]> {
  const resolved = await Promise.all(
    modules.map(async (mod): Promise<Mount | null> => {
      const prefix = `/${mod.id}/`;
      if (mod.devPort !== undefined && (await probeDevServer(mod.devPort, prefix))) {
        return { kind: 'proxy', prefix, port: mod.devPort };
      }
      if (existsSync(path.join(mod.clientDist, 'index.html'))) {
        return { kind: 'static', prefix, dir: mod.clientDist };
      }
      return null;
    }),
  );
  return resolved.filter((m): m is Mount => m !== null);
}

/** Registry values are trusted constants; escape anyway before inlining into HTML. */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The launcher page, generated inline (no build step): a dark arcade menu
 * with one card per registered game linking to its /<id>/ client.
 */
function launcherHtml(modules: readonly GameModule[]): string {
  const cards = modules
    .map(
      (m) =>
        `      <a class="card" href="/${escapeHtml(m.id)}/">\n` +
        `        <span class="name">${escapeHtml(m.name)}</span>\n` +
        `        <span class="id">${escapeHtml(m.id)}</span>\n` +
        `      </a>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ARCADE</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 48px;
        background: #0b0e14; color: #e8eaf0;
        font-family: system-ui, -apple-system, sans-serif;
      }
      h1 { margin: 0; font-size: 40px; font-weight: 800; letter-spacing: 0.5em; text-indent: 0.5em; color: #f5c542; }
      .grid { display: flex; flex-wrap: wrap; justify-content: center; gap: 24px; padding: 0 24px; }
      .card {
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        width: 220px; padding: 32px 16px; border: 1px solid #2a3142; border-radius: 12px;
        background: #131826; color: inherit; text-decoration: none;
        transition: border-color 120ms, transform 120ms;
      }
      .card:hover { border-color: #f5c542; transform: translateY(-2px); }
      .card .name { font-size: 20px; font-weight: 700; letter-spacing: 0.15em; }
      .card .id { font-size: 12px; color: #8a93a8; }
    </style>
  </head>
  <body>
    <h1>ARCADE</h1>
    <main class="grid">
${cards}
    </main>
  </body>
</html>
`;
}

const lobby = new Lobby(GAMES);
const net = new NetServer({
  onMessage: (sess, msg) => lobby.handleMessage(sess, msg),
  onDisconnect: (sess) => lobby.handleDisconnect(sess),
});

// Probing dev servers is async; everything else (lobby, sweep, signals) is
// safe to set up now — net.close() tolerates a never-started NetServer.
resolveMounts(GAMES)
  .then((mounts) => net.start(PORT, mounts, launcherHtml(GAMES)))
  .catch((err: unknown) => {
    console.error('[server] startup failed', err);
    process.exit(1);
  });

// 1s sweep: rooms report input-stale players; their sockets are closed here.
// The same poll reaps empty rooms.
const sweep = setInterval(() => {
  try {
    for (const sess of lobby.pollStaleSessions()) sess.close();
  } catch (err) {
    console.error('[server] stale sweep failed', err);
  }
}, 1000);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal}: shutting down`);
  clearInterval(sweep);
  lobby.close(); // stop room tick intervals
  net.close(); // terminate sockets, close ws + http
  setTimeout(() => process.exit(0), 200).unref(); // let close frames flush
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
