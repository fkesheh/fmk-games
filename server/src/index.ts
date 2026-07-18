// ============================================================================
// S1 — entry: wire NetServer <-> Lobby, resolve the static dir, run the 1s
// stale sweep (closes sockets of input-stale/kicked players; the lobby reaps
// empty rooms in the same poll), and shut down cleanly on SIGTERM/SIGINT.
// A throwing hook must never kill the process: net.ts wraps hook calls, the
// lobby wraps its bodies, and the sweep wraps its poll.
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NetServer } from './net.js';
import { Lobby } from './rooms.js';

const PORT = Number(process.env.PORT ?? 8080);

/**
 * Client production build, when present on disk. Candidates cover cwd = the
 * server package (npm workspace scripts), cwd = repo root, tsx dev
 * (here = server/src), and the bundled layout (here = server/dist, where
 * ../../client/dist is the path the Docker image relies on).
 */
function resolveStaticDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), '../client/dist'),
    path.resolve(process.cwd(), 'client/dist'),
    path.resolve(here, '../client/dist'),
    path.resolve(here, '../../client/dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

const lobby = new Lobby();
const net = new NetServer({
  onMessage: (sess, msg) => lobby.handleMessage(sess, msg),
  onDisconnect: (sess) => lobby.handleDisconnect(sess),
});

net.start(PORT, resolveStaticDir());

// 1s sweep: rooms report input-stale players (NET.inputTimeoutMs); their
// sockets are closed here. The same poll reaps empty rooms.
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
