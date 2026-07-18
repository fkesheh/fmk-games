// ============================================================================
// C1 — Connection: WebSocket wrapper, app-level ping/pong, clock offset.
// One-shot: no automatic reconnect — an unexpected close fires onClose exactly
// once. App-level ping every NET.pingEveryMs keeps the RTT EMA (α=0.2); the
// server-clock offset uses the frozen min-RTT filter (best sample wins):
//   offset = pong.serverTime + rtt/2 − performance.now()
//   serverNow = performance.now() + offset   (see ClientState, C10)
// 'pong' is consumed here and never forwarded to onMessage.
// ============================================================================
import { decodeS2C, encodeC2S, NET } from '@fps/shared';
import type { C2S, S2C } from '@fps/shared';

// ---- tuning (frozen by CONTRACT.md) -----------------------------------------
const CONNECT_TIMEOUT_MS = 5000;
const PING_EMA_ALPHA = 0.2;

export class Connection {
  onMessage: ((msg: S2C) => void) | null = null;
  onClose: (() => void) | null = null;

  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private emaPing = 0; // ms; 0 until the first pong
  private offset = 0; // ms; 0 until the first pong (serverNow then = perf clock)
  private bestRtt = Infinity;
  private closeNotified = false;

  /** Resolves on open, rejects on error/timeout (5s). */
  connect(url?: string): Promise<void> {
    const target =
      url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.close(); // defensive: never two live sockets
    this.closeNotified = false;
    this.emaPing = 0;
    this.offset = 0;
    this.bestRtt = Infinity;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let opened = false;
      const ws = new WebSocket(target);
      this.ws = ws;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // already closing — irrelevant
        }
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('connection timeout')), CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        if (settled || this.ws !== ws) return;
        settled = true;
        opened = true;
        clearTimeout(timer);
        this.startPing();
        this.send({ t: 'ping', ts: performance.now() }); // seed RTT/offset immediately
        resolve();
      };
      ws.onerror = () => {
        // pre-open this decides the promise; post-open the close event follows
        if (!settled) fail(new Error('connection failed'));
      };
      ws.onclose = () => {
        if (this.ws !== ws) return; // stale socket from a previous connect()
        if (!opened) {
          fail(new Error('connection refused'));
          return;
        }
        this.teardown();
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (this.ws !== ws || typeof ev.data !== 'string') return;
        const msg = decodeS2C(ev.data);
        if (msg === null) return; // malformed frame: drop, never throw
        if (msg.t === 'pong') {
          this.onPong(msg.ts, msg.serverTime);
          return;
        }
        try {
          this.onMessage?.(msg);
        } catch {
          // a bad consumer handler must not take the socket down
        }
      };
    });
  }

  /** No-op unless the socket is open (mirrors the server's Session.send). */
  send(msg: C2S): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(encodeC2S(msg));
    } catch {
      // racing a close — drop the frame
    }
  }

  /** Smoothed RTT EMA (α=0.2) in ms; 0 before the first pong. */
  pingMs(): number {
    return this.emaPing;
  }

  /** Server-clock offset in ms (min-RTT sample); 0 before the first pong. */
  serverOffsetMs(): number {
    return this.offset;
  }

  /** Idempotent. Explicit close: onClose is NOT fired (the caller initiated it). */
  close(): void {
    this.closeNotified = true;
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (ws !== null && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close();
      } catch {
        // ignore — already tearing down
      }
    }
  }

  // ---- internal ---------------------------------------------------------------
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

  private onPong(ts: number, serverTime: number): void {
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

  private teardown(): void {
    this.stopPing();
    this.ws = null;
    if (!this.closeNotified) {
      this.closeNotified = true;
      try {
        this.onClose?.();
      } catch {
        // a bad consumer handler must not take the socket down
      }
    }
  }
}
