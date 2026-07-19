// ============================================================================
// S1 — transport: http static + SPA fallback, WebSocketServer on /ws, Session
// plumbing over `ws`. Invariants: every inbound payload passes parseC2S or is
// dropped silently (never throw on wire data); app-level 'ping' is answered
// here (transport concern, never reaches hooks); a throwing hook must never
// kill the process. rtt comes from ws protocol-level ping/pong.
// ============================================================================
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
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
};

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

export class NetServer {
  private readonly hooks: NetHooks;
  private readonly sessions = new Map<PlayerId, Session>();
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(hooks: NetHooks) {
    this.hooks = hooks;
  }

  start(port: number, staticDir: string | null): void {
    const http = createServer((req, res) => {
      serveStatic(req, res, staticDir).catch((err: unknown) => {
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
        wss.handleUpgrade(req, socket, head, (ws2) => wss.emit('connection', ws2, req));
      } else {
        socket.destroy();
      }
    });

    // ws protocol-level ping to every socket; pongs update per-session rtt
    this.pingTimer = setInterval(() => {
      for (const sess of this.sessions.values()) sess.heartbeat();
    }, NET.pingEveryMs);
    this.pingTimer.unref();

    http.listen(port, () => {
      console.log(`[net] listening on http://localhost:${port} (ws at /ws, static: ${staticDir ?? 'none'})`);
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

// ---- http: serve staticDir, SPA fallback to index.html on any miss ----
async function serveStatic(req: IncomingMessage, res: ServerResponse, staticDir: string | null): Promise<void> {
  if (staticDir === null) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('fps server running (no client build found)');
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';

  const root = path.resolve(staticDir);
  let filePath = path.resolve(root, `.${pathname}`);
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
  res.writeHead(200, { 'content-type': contentType });
  res.end(data);
}
