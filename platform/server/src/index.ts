// ============================================================================
// Platform entry: wire NetServer <-> Lobby over the game registry, serve the
// first registered game's client dist at /, run the 1s stale sweep (closes
// sockets of input-stale/kicked players; the lobby reaps empty rooms in the
// same poll), and shut down cleanly on SIGTERM/SIGINT. A throwing hook must
// never kill the process: net.ts wraps hook calls, the lobby wraps its bodies,
// and the sweep wraps its poll.
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import { NetServer } from './net.js';
import { Lobby } from './lobby.js';
import { GAMES } from './registry.js';

const PORT = Number(process.env.PORT ?? 8080);

/**
 * Single-game platform: the first registered module's built client is served
 * at /. Falls back to the plain-text placeholder when no build is on disk.
 */
function resolveStaticDir(): string | null {
  const dist = GAMES[0]?.clientDist;
  if (dist === undefined) return null;
  return existsSync(path.join(dist, 'index.html')) ? dist : null;
}

const lobby = new Lobby(GAMES);
const net = new NetServer({
  onMessage: (sess, msg) => lobby.handleMessage(sess, msg),
  onDisconnect: (sess) => lobby.handleDisconnect(sess),
});

net.start(PORT, resolveStaticDir());

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
