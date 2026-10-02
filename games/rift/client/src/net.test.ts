// createNet send-while-CONNECTING regression coverage. Same race as the
// STRICKEN "Reserving a slot…" hang: send() used to drop every frame fired
// during the handshake, so a menu join clicked before the socket opened
// vanished with zero errors. (ANCIENTS reuses this net via wire(), so this
// covers both games.)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNet } from './net.js';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(String(data));
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const reconnects: Array<() => void> = [];
vi.stubGlobal('WebSocket', FakeWebSocket);
vi.stubGlobal('location', { protocol: 'http:', host: 'test' });
vi.stubGlobal('window', {
  setTimeout: (fn: () => void) => {
    reconnects.push(fn);
    return reconnects.length;
  },
  setInterval: () => 0,
});

afterEach(() => {
  FakeWebSocket.instances = [];
  reconnects.length = 0;
  vi.useRealTimers();
});

function latestSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error('no socket created');
  return ws;
}

function tags(ws: FakeWebSocket): string[] {
  return ws.sent.map((s) => (JSON.parse(s) as { t: string }).t);
}

const HOOKS = { onMessage: () => undefined, onClose: () => undefined };

describe('createNet send-while-CONNECTING', () => {
  it('queues frames sent before open and flushes them FIFO on open', () => {
    const net = createNet(HOOKS);
    net.send({ t: 'quick_join', name: 'A', game: 'rift' } as never);
    net.send({ t: 'list_rooms' } as never);
    expect(latestSocket().sent).toEqual([]);

    latestSocket().open();
    expect(tags(latestSocket())).toEqual(['quick_join', 'list_rooms']);
  });

  it('flushes onOpenExtra (auth) before queued game traffic', () => {
    const net = createNet(HOOKS, { onOpenExtra: () => [{ t: 'auth', token: 'tok' }] });
    net.send({ t: 'quick_join', name: 'A', game: 'ancients' } as never);

    latestSocket().open();
    expect(tags(latestSocket())).toEqual(['auth', 'quick_join']);
  });

  it('bridges the reconnect gap: pre-open queue + null-gap sends flush on the redial', () => {
    // e2e-rift check-4 regression: B's joinPrivate executed in the ~1.3s null
    // gap after socket1's drop and vanished (no retry for explicit joins) —
    // the queue must carry such frames across the gap to the redial's open.
    const net = createNet(HOOKS);
    net.send({ t: 'quick_join', name: 'A', game: 'rift' } as never); // CONNECTING queue
    latestSocket().drop(); // pre-open close: triggers the reconnect timer
    expect(reconnects.length).toBe(1);
    net.send({ t: 'list_rooms' } as never); // NULL-GAP send (ws===null)

    reconnects[0]?.(); // run the scheduled redial
    expect(FakeWebSocket.instances.length).toBe(2);
    latestSocket().open();
    expect(tags(latestSocket())).toEqual(['quick_join', 'list_rooms']); // both flush, FIFO
    expect(net.connected).toBe(true);
  });

  it('still sends immediately when the socket is already open', () => {
    const net = createNet(HOOKS);
    latestSocket().open();
    net.send({ t: 'list_rooms' } as never);
    expect(tags(latestSocket())).toEqual(['list_rooms']);
  });
});
