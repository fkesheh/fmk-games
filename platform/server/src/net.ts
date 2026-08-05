// ============================================================================
// S1 — transport: http static + per-game SPA fallback, WebSocketServer on /ws,
// Session plumbing over `ws`. Static layout (multi-game): the generated
// launcher page is served at / and each registered game's client dist under
// its /<gameId>/ prefix (falls back to that dist's index.html on any miss).
// Dev mode: a game whose vite dev server answers probeDevServer is mounted as
// a reverse PROXY to that server (plain node:http, no deps) instead of the
// static dist, so one port serves launcher + both HMR clients; vite's HMR
// websocket targets the page origin (its own base path), so matching upgrade
// requests are tunneled to the vite server too. Invariants: every inbound
// payload passes parseC2S or is dropped silently (never throw on wire data);
// app-level 'ping' is answered here (transport concern, never reaches hooks);
// a throwing hook must never kill the process. rtt comes from ws
// protocol-level ping/pong.
// ============================================================================
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createServer,
  get as httpGet,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect as tcpConnect } from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { NET, encodeS2C, parseC2S } from '@platform/shared';
import type { C2S, PlayerId, S2C } from '@platform/shared';

// ---- static content types (spec: html/js/css/json/png/ico) ----
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  // A game's manifest ships in its own dist (docs/TOUCH_PWA.md §2.0). Served
  // as application/octet-stream it is rejected as a manifest and the install
  // silently degrades to a browser bookmark.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

// Cache policy for the game dists. Vite content-hashes everything under
// assets/, so those URLs are immutable and may be cached forever; a document
// must NEVER be, or an HTTP-level cache strands a device on an old build just
// as effectively as a bad service worker would (docs/TOUCH_PWA.md §2.1).
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const DOC_CACHE = 'no-cache';
const SHORT_CACHE = 'public, max-age=3600';

function cachePolicy(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.webmanifest') return DOC_CACHE;
  if (filePath.includes(`${path.sep}assets${path.sep}`)) return IMMUTABLE_CACHE;
  return SHORT_CACHE;
}

const MAX_PAYLOAD = 16 * 1024; // wire messages are tiny; bigger frames are abuse

// Liveness policy: heartbeat pings double as a dead-peer detector. A pong
// clears the count; 2 consecutive unanswered protocol pings (≈2 heartbeat
// intervals, well under NET.inputTimeoutMs) mean the connection is hard-dropped
// and the socket is terminated so the close path frees the player slot.
const MAX_MISSED_PONGS = 2;

export class Session {
  readonly id: PlayerId;
  private readonly ws: WebSocket;
  private pingSentAt = 0;
  private missedPongs = 0;
  private rtt = 0;

  constructor(id: PlayerId, ws: WebSocket) {
    this.id = id;
    this.ws = ws;
  }

  /** JSON via encodeS2C; no-op when the socket is not open. */
  send(msg: S2C): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(encodeS2C(msg));
    } catch {
      // socket died mid-send; the 'close' event drives cleanup
    }
  }

  /** Last measured protocol-level round trip; 0 until the first pong. */
  rttMs(): number {
    return this.rtt;
  }

  /** Graceful close frame; used by the lobby for stale/speedhack drops. */
  close(): void {
    try {
      this.ws.close();
    } catch {
      // already gone
    }
  }

  // ---- internal plumbing for NetServer (same-module use only) ----

  /** Send a ws protocol ping and stamp the clock for the next rtt sample. */
  heartbeat(): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.pingSentAt > 0) {
      // previous ping was never answered
      this.missedPongs += 1;
      if (this.missedPongs >= MAX_MISSED_PONGS) {
        // dead peer: terminate — the 'close' event drives the single
        // onDisconnect path, same as any other drop (no double-report)
        this.terminate();
        return;
      }
    }
    this.pingSentAt = Date.now();
    try {
      this.ws.ping();
    } catch {
      // the 'close' event follows and drives cleanup
    }
  }

  /** Record a protocol pong against the last heartbeat. */
  notePong(): void {
    if (this.pingSentAt > 0) this.rtt = Math.max(0, Date.now() - this.pingSentAt);
    this.pingSentAt = 0;
    this.missedPongs = 0;
  }

  /** Hard terminate: dead-peer liveness drops and server shutdown. */
  terminate(): void {
    try {
      this.ws.terminate();
    } catch {
      // already gone
    }
  }
}

export interface NetHooks {
  onMessage(sess: Session, msg: C2S): void; // already parseC2S-validated
  onDisconnect(sess: Session): void;
}

/** One game's static mount: its built client dist served under `prefix`. */
export interface StaticMount {
  readonly kind: 'static';
  readonly prefix: string; // '/fps/' — leading + trailing slash
  readonly dir: string; // absolute path to the built client dist
}

/**
 * One game's dev mount: `prefix` is reverse-proxied to the vite dev server on
 * localhost (http requests piped through, websocket upgrades tunneled for HMR).
 */
export interface ProxyMount {
  readonly kind: 'proxy';
  readonly prefix: string; // '/fps/' — leading + trailing slash
  readonly port: number; // vite dev-server port
}

export type Mount = StaticMount | ProxyMount;

/**
 * One generated (not on-disk) asset: the PWA surface — service workers, the
 * launcher manifest and icons, the offline card (docs/TOUCH_PWA.md §2.0).
 */
export interface AssetResponse {
  readonly body: string | Buffer;
  readonly contentType: string;
  readonly cacheControl: string;
}

/**
 * Resolves a generated asset for a pathname, or null to fall through to the
 * normal routing. Consulted BEFORE the game mounts, because a mount answers
 * every miss under its prefix with its own index.html (SPA fallback) and would
 * otherwise swallow `/<gameId>/sw.js`.
 */
export type AssetResolver = (pathname: string) => Promise<AssetResponse | null>;

// Response headers that describe the upstream hop, not the resource — node
// re-chunks/re-frames the piped body for the downstream connection itself.
const HOP_BY_HOP_HEADERS = new Set(['connection', 'transfer-encoding', 'keep-alive']);

/**
 * One-shot liveness probe for a vite dev server: GET its game base path with
 * a short timeout. Any http status under 500 means a live server (even a 404
 * proves something is listening); connection errors and timeouts mean it is
 * not running. Probing the base path (not just the port) keeps a foreign
 * process on the same port from looking like vite only when it 500s there.
 */
export function probeDevServer(port: number, prefix: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet({ host: 'localhost', port, path: prefix, timeout: 500 }, (res) => {
      res.resume(); // drain so the socket can be reused/closed cleanly
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

export class NetServer {
  private readonly hooks: NetHooks;
  private readonly sessions = new Map<PlayerId, Session>();
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(hooks: NetHooks) {
    this.hooks = hooks;
  }

  start(
    port: number,
    mounts: readonly Mount[],
    launcherHtml: string,
    assets: AssetResolver | null = null,
  ): void {
    const http = createServer((req, res) => {
      serveHttp(req, res, mounts, launcherHtml, assets).catch((err: unknown) => {
        console.error('[net] http error', err);
        if (!res.headersSent) res.writeHead(500);
        res.end('Internal Server Error');
      });
    });
    this.http = http;

    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
    this.wss = wss;
    wss.on('connection', (ws) => this.onConnection(ws));
    wss.on('error', (err) => console.error('[net] wss error', err));

    http.on('upgrade', (req, socket, head) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname === '/ws') {
        // the game websocket — always the platform's own, never proxied
        wss.handleUpgrade(req, socket, head, (ws2) => wss.emit('connection', ws2, req));
        return;
      }
      // vite HMR sockets target the page origin at the game's base path
      // (e.g. ws://host/fps/?token=...), so they must be tunneled upstream
      const proxy = mounts.find((m): m is ProxyMount => m.kind === 'proxy' && pathname.startsWith(m.prefix));
      if (proxy) {
        proxyUpgrade(req, socket, head, proxy);
        return;
      }
      socket.destroy();
    });

    // ws protocol-level ping to every socket; pongs update per-session rtt
    this.pingTimer = setInterval(() => {
      for (const sess of this.sessions.values()) sess.heartbeat();
    }, NET.pingEveryMs);
    this.pingTimer.unref();

    http.listen(port, () => {
      const games =
        mounts
          .map((m) => (m.kind === 'proxy' ? `${m.prefix} (proxy :${m.port})` : `${m.prefix} (static)`))
          .join(' ') || 'none';
      console.log(`[net] listening on http://localhost:${port} (ws at /ws, games: ${games})`);
    });
  }

  close(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const sess of this.sessions.values()) sess.terminate();
    this.sessions.clear();
    this.wss?.close();
    this.http?.close();
    this.wss = null;
    this.http = null;
  }

  // ---- connection lifecycle ----

  private onConnection(ws: WebSocket): void {
    const sess = new Session(this.newSessionId(), ws);
    this.sessions.set(sess.id, sess);
    ws.on('pong', () => sess.notePong());
    ws.on('message', (data: RawData, isBinary: boolean) => this.onRawMessage(sess, data, isBinary));
    ws.on('close', () => {
      this.sessions.delete(sess.id);
      try {
        this.hooks.onDisconnect(sess);
      } catch (err) {
        console.error('[net] onDisconnect hook threw', err);
      }
    });
    ws.on('error', (err) => console.error('[net] socket error', err));
    sess.send({ t: 'welcome', playerId: sess.id });
  }

  /** Validate at the door; malformed or invalid payloads die here silently. */
  private onRawMessage(sess: Session, data: RawData, isBinary: boolean): void {
    if (isBinary) return;
    let raw: unknown;
    try {
      raw = JSON.parse(rawText(data));
    } catch {
      return;
    }
    const msg = parseC2S(raw);
    if (msg === null) return;
    if (msg.t === 'ping') {
      // app-level RTT / clock-offset probe — answered at the transport layer
      sess.send({ t: 'pong', ts: msg.ts, serverTime: Date.now() });
      return;
    }
    try {
      this.hooks.onMessage(sess, msg);
    } catch (err) {
      console.error('[net] onMessage hook threw', err);
    }
  }

  /** 8-char ids from the first uuid segment; retried on (astronomical) collision. */
  private newSessionId(): PlayerId {
    for (;;) {
      const id = randomUUID().slice(0, 8);
      if (!this.sessions.has(id)) return id;
    }
  }
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

// ---- http: launcher at /, per-game mounts under /<id>/ with SPA fallback ----
async function serveHttp(
  req: IncomingMessage,
  res: ServerResponse,
  mounts: readonly Mount[],
  launcherHtml: string,
  assets: AssetResolver | null,
): Promise<void> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': DOC_CACHE });
    res.end(launcherHtml);
    return;
  }

  if (assets !== null && (req.method === 'GET' || req.method === 'HEAD')) {
    const asset = await assets(pathname);
    if (asset !== null) {
      const body = Buffer.isBuffer(asset.body) ? asset.body : Buffer.from(asset.body, 'utf8');
      // content-length is explicit because of HEAD: ending a HEAD with no body
      // and no length makes node fall back to chunked framing, and Chromium
      // reports the (correct, empty) response as net::ERR_ABORTED — which
      // scripts/e2e.mjs counts as a page error. A declared length terminates
      // the response cleanly for both methods.
      res.writeHead(200, {
        'content-type': asset.contentType,
        'cache-control': asset.cacheControl,
        'content-length': body.byteLength,
      });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
      return;
    }
  }

  for (const mount of mounts) {
    if (pathname === mount.prefix.slice(0, -1)) {
      // '/fps' -> '/fps/' so the client's relative asset URLs stay under the prefix
      res.writeHead(301, { location: mount.prefix });
      res.end();
      return;
    }
    if (pathname.startsWith(mount.prefix)) {
      if (mount.kind === 'proxy') {
        proxyRequest(req, res, mount);
        return;
      }
      await serveGameFile(mount.dir, pathname.slice(mount.prefix.length), res);
      return;
    }
  }

  res.writeHead(404);
  res.end('Not Found');
}

/**
 * Forward one http request to the game's vite dev server (original method,
 * url — path + query — and headers) and pipe its response back, minus
 * hop-by-hop headers. An unreachable upstream answers 502 with instructions;
 * that can only race in if vite dies between the startup probe and now.
 */
function proxyRequest(req: IncomingMessage, res: ServerResponse, mount: ProxyMount): void {
  const upstream = httpRequest(
    {
      host: 'localhost',
      port: mount.port,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (upRes) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (value === undefined || HOP_BY_HOP_HEADERS.has(name)) continue;
        headers[name] = value;
      }
      res.writeHead(upRes.statusCode ?? 502, headers);
      upRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      `Bad Gateway: the vite dev server for ${mount.prefix} is not reachable on :${mount.port}.\n` +
        'Start it with `npm run dev` from the repo root (it launches platform + both games).\n',
    );
  });
  req.pipe(upstream);
}

/**
 * Tunnel a websocket upgrade to the game's vite dev server (HMR client). The
 * original request line and headers are replayed verbatim — vite 8 only
 * accepts the upgrade when the path equals the client base (`/fps/`) and the
 * `vite-hmr` subprotocol + token query pass through, so nothing is rewritten.
 */
function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, mount: ProxyMount): void {
  const upstream = tcpConnect(mount.port, 'localhost', () => {
    let requestHead = `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = req.rawHeaders[i + 1];
      if (name === undefined || value === undefined) continue;
      requestHead += `${name}: ${value}\r\n`;
    }
    upstream.write(requestHead + '\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
}

/** Serve one file from a game dist; any miss falls back to its index.html (SPA). */
async function serveGameFile(dir: string, rel: string, res: ServerResponse): Promise<void> {
  if (rel === '') rel = 'index.html';

  const root = path.resolve(dir);
  let filePath = path.resolve(root, rel);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch {
    filePath = path.join(root, 'index.html'); // SPA fallback
    try {
      data = await readFile(filePath);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
  }
  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType, 'cache-control': cachePolicy(filePath) });
  res.end(data);
}
