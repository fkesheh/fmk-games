// ============================================================================
// SDK CONNECTION — ws facade: envelope passthrough, app-level ping/pong for
// RTT + min-RTT clock offset, optional auto-reconnect w/ backoff + auth
// replay (docs/PLATFORM.md §4.5). Pattern proven in STRICKEN connection.ts.
// Owner: P6_SDK_CORE — implement SdkConnection from types.ts.
//
// Semantics:
//   - connect() resolves on open, rejects on error/refuse/timeout (5s).
//   - App-level ping every NET.pingEveryMs; 'pong' is consumed here and never
//     forwarded. RTT EMA α=0.2; clock offset uses the frozen min-RTT filter:
//       offset = pong.serverTime + rtt/2 − performance.now()
//   - autoReconnect: exponential backoff 0.5s→8s, RESET on successful open;
//     after every open authPayload() is sent when it returns non-null (the
//     facade supplies `{t:'auth',token}` — this replays it on reconnect).
//   - send() sends when OPEN and queues (bounded, flushed FIFO on the next
//     open) while CONNECTING or in the reconnect-backoff null gap; drops only
//     on a CLOSING/CLOSED socket object. onClose(clean) fires ONCE per drop
//     and is suppressed for explicit close().
//
// DOM-free where possible: the only browser globals touched are WebSocket,
// performance (Node has both) and `location` — read through guarded globalThis.
// ============================================================================

import { NET } from '@platform/shared';
import type { C2S, LobbyS2C } from '@platform/shared';
import type { SdkConnection } from './types.js';

const CONNECT_TIMEOUT_MS = 5000;
const PING_EMA_ALPHA = 0.2;
const BACKOFF_FIRST_MS = 500;
const BACKOFF_MAX_MS = 8000;
const SEND_QUEUE_CAP = 32; // outbound frames held while the socket is CONNECTING

export interface SdkNetOpts {
  /** Retry dropped connections with exp backoff (default false). */
  readonly autoReconnect?: boolean;
  /**
   * Sent after every successful open (initial + reconnects) when non-null —
   * the facade returns `{t:'auth',token}` from the stored profile token.
   */
  readonly authPayload?: () => C2S | null;
}

/** Structural slices of browser globals — no ambient DOM assumptions here. */
interface LocationLike {
  readonly protocol?: unknown;
  readonly host?: unknown;
}

function defaultWsUrl(): string | null {
  try {
    const loc = (globalThis as { location?: LocationLike }).location;
    if (typeof loc?.protocol !== 'string' || typeof loc.host !== 'string') return null;
    const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${loc.host}/ws`;
  } catch {
    return null;
  }
}

/** Envelope check only ({t:string}) — lobby tags validated server-side, room tags RAW. */
function parseFrame(data: string): (LobbyS2C & Record<string, unknown>) | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  if (typeof (raw as Record<string, unknown>).t !== 'string') return null;
  return raw as LobbyS2C & Record<string, unknown>;
}

export class SdkNet implements SdkConnection {
  onMessage: ((msg: LobbyS2C & Record<string, unknown>) => void) | null = null;
  onClose: ((clean: boolean) => void) | null = null;
  onOpen: (() => void) | null = null;

  private readonly opts: SdkNetOpts;

  /** Service-level listeners (facade wires profile auth_ok / pad pairing); run BEFORE the game's slot. */
  private readonly internalListeners: Array<(msg: LobbyS2C & Record<string, unknown>) => void> = [];

  private ws: WebSocket | null = null;
  private url: string | null = null;
  private generation = 0; // increments per socket; stale events are ignored

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = BACKOFF_FIRST_MS;

  private emaPing = 0; // ms; 0 until the first pong
  private offset = 0; // ms; 0 until the first pong (serverNow then = perf clock)
  private bestRtt = Infinity;
  private userClosed = false;
  // Frames sent while there is no healthy-open socket — CONNECTING handshake
  // or the reconnect-backoff null gap — flushed FIFO on the next open. Without
  // this a join fired during the handshake silently vanished (the STRICKEN
  // "Reserving a slot…" hang — same race, same fix; outpost's Net already had
  // the bounded-queue shape this mirrors), and a join fired in the null gap
  // after a drop vanished the same way. The queue bridges auto-redial gaps
  // (never cleared by teardown/closeSocket); only a manual connect(), a dial
  // failure, or an explicit close() discards it. Bounded: oldest drops past
  // the cap.
  private sendQueue: C2S[] = [];

  constructor(opts: SdkNetOpts = {}) {
    this.opts = opts;
  }

  /**
   * Subscribe a service-level handler (profile hydration, pad pairing).
   * Returns an unsubscribe fn. Runs before the game's onMessage slot.
   */
  addInternalListener(fn: (msg: LobbyS2C & Record<string, unknown>) => void): () => void {
    this.internalListeners.push(fn);
    return () => {
      const i = this.internalListeners.indexOf(fn);
      if (i >= 0) this.internalListeners.splice(i, 1);
    };
  }

  /** Resolves on open; rejects on refuse/error/timeout. Manual connects cancel pending retries. */
  connect(url?: string): Promise<void> {
    const target = url ?? defaultWsUrl();
    if (target === null) return Promise.reject(new Error('SdkNet: no ws url'));
    if (typeof WebSocket === 'undefined') return Promise.reject(new Error('SdkNet: no WebSocket'));

    this.userClosed = false;
    this.backoffMs = BACKOFF_FIRST_MS;
    this.cancelReconnect();
    this.sendQueue = []; // fresh manual intent supersedes anything bridged
    this.url = target; // the auto-redial target (teardown redials this url)
    return this.dial(target);
  }

  /**
   * Sends when the socket is open; queues (bounded, flushed FIFO on the next
   * open) while CONNECTING or in the reconnect-backoff null gap; drops only
   * on a CLOSING/CLOSED socket object.
   */
  send(msg: C2S): void {
    const ws = this.ws;
    if (ws === null || ws.readyState === WebSocket.CONNECTING) {
      // no healthy-open socket: hold for the next open. With autoReconnect a
      // redial is scheduled and the flush is guaranteed; without one the next
      // manual connect() discards the queue (fresh intent supersedes).
      if (this.sendQueue.length >= SEND_QUEUE_CAP) this.sendQueue.shift();
      this.sendQueue.push(msg);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return; // CLOSING/CLOSED: drop
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // racing a close — drop the frame
    }
  }

  /** Smoothed RTT EMA (α=0.2) in ms; 0 before the first pong. */
  pingMs(): number {
    return this.emaPing;
  }

  /** Server-clock time in ms via min-RTT offset; local perf clock before the first pong. */
  serverNow(): number {
    return performance.now() + this.offset;
  }

  /** Idempotent explicit close: no onClose fire, no reconnect scheduling. */
  close(): void {
    this.userClosed = true;
    this.generation++;
    this.stopPing();
    this.cancelReconnect();
    this.sendQueue = [];
    const ws = this.ws;
    this.ws = null;
    if (ws !== null && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close();
      } catch {
        // already tearing down
      }
    }
  }

  // ---- internals ---------------------------------------------------------------

  private dial(target: string): Promise<void> {
    this.closeSocket(); // defensive: never two live sockets
    const gen = ++this.generation;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let opened = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(target);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        this.sendQueue = []; // dead socket: queued frames must never send late
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // irrelevant
        }
        if (this.generation === gen) this.ws = null;
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('connection timeout')), CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        if (settled || this.generation !== gen) return;
        settled = true;
        opened = true;
        clearTimeout(timer);
        this.onSocketOpened();
        resolve();
      };
      ws.onerror = () => {
        // pre-open this decides the promise; post-open the close event follows
        if (!opened) fail(new Error('connection failed'));
      };
      ws.onclose = (ev: CloseEvent) => {
        if (this.generation !== gen) return; // stale socket
        if (!opened) {
          fail(new Error('connection refused'));
          return;
        }
        this.teardown(ev.code === 1000);
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (this.generation !== gen || typeof ev.data !== 'string') return;
        const msg = parseFrame(ev.data);
        if (msg === null) return; // malformed frame: drop, never throw
        if (msg.t === 'pong') {
          this.onPong(msg.ts, msg.serverTime);
          return;
        }
        for (const fn of this.internalListeners) {
          try {
            fn(msg);
          } catch {
            // a bad consumer handler must not take the socket down
          }
        }
        try {
          this.onMessage?.(msg);
        } catch {
          // ditto
        }
      };
    });
  }

  private onSocketOpened(): void {
    this.backoffMs = BACKOFF_FIRST_MS; // reset backoff on every successful open
    this.startPing();
    this.send({ t: 'ping', ts: performance.now() }); // seed RTT/offset immediately
    const auth = this.opts.authPayload?.();
    if (auth !== null && auth !== undefined) this.send(auth);
    const queued = this.sendQueue; // auth first: queued joins may depend on it
    this.sendQueue = [];
    for (const msg of queued) this.send(msg); // socket is open: sends inline
    try {
      this.onOpen?.();
    } catch {
      // consumer errors must not take the socket down
    }
  }

  /** One drop: stop liveness, fire onClose once, maybe schedule the retry. */
  private teardown(clean: boolean): void {
    const wasOpen = this.ws !== null;
    this.generation++;
    this.stopPing();
    // the queue BRIDGES this gap (never cleared here): when autoReconnect is
    // on, the redial below follows and its open flushes whatever was sent
    // meanwhile; when off, the next manual connect() discards it
    this.ws = null;
    if (!wasOpen || this.userClosed) return;
    try {
      this.onClose?.(clean);
    } catch {
      // consumer errors must not take the socket down
    }
    if (this.opts.autoReconnect === true && this.url !== null) {
      const target = this.url;
      const wait = this.backoffMs;
      this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.userClosed) void this.dial(target).catch(() => undefined);
      }, wait);
    }
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.generation++;
    // no queue clear: auto-redials must inherit the bridged gap; manual
    // connect() clears explicitly before dialling (fresh intent supersedes)
    this.ws = null;
    if (ws !== null && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ t: 'ping', ts: performance.now() });
    }, NET.pingEveryMs);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private onPong(ts: number, serverTime: number): void {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return;
    if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return;
    const now = performance.now();
    const rtt = now - ts;
    if (!Number.isFinite(rtt) || rtt < 0) return; // clock weirdness / bad echo
    this.emaPing = this.emaPing === 0 ? rtt : this.emaPing + PING_EMA_ALPHA * (rtt - this.emaPing);
    // min-RTT filter: only the best round trip seen so far moves the offset —
    // queuing delay only ever inflates RTT, so the smallest sample is closest
    // to true one-way time.
    if (rtt < this.bestRtt) {
      this.bestRtt = rtt;
      this.offset = serverTime + rtt / 2 - now;
    }
  }
}
