// Regression: Connection.send() silently dropped every frame sent while the
// socket was CONNECTING. ClientGame.ensureConn() returns the existing
// Connection without awaiting its in-flight connect(), so a fast joinQuick()
// (or the boot-time auto-rejoin) fired quick_join/join_public into a
// CONNECTING socket — the frame vanished, no 'joined'/'error' ever arrived,
// and the client sat on "Reserving a slot…"/"Reconnecting…" forever with zero
// console errors. send() must queue while CONNECTING and flush on open.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Connection } from './connection';

// Minimal controllable WebSocket double: Connection only touches the
// constructor, the OPEN static, readyState, send, close, and the four
// on* handler slots.
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
  refuse(): void {
    // pre-open close: the server refused the handshake
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

vi.stubGlobal('WebSocket', FakeWebSocket);

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.useRealTimers();
});

function latestSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error('no socket created');
  return ws;
}

describe('Connection send-while-CONNECTING', () => {
  it('queues frames sent before open and flushes them FIFO on open', async () => {
    const conn = new Connection();
    const opened = conn.connect('ws://test/');
    conn.send({ t: 'quick_join', name: 'ProbeA', sig: 'x' } as never);
    conn.send({ t: 'list_rooms' } as never);
    expect(latestSocket().sent).toEqual([]); // nothing on the wire yet

    latestSocket().open();
    await opened;
    const tags = latestSocket().sent.map((s) => (JSON.parse(s) as { t: string }).t);
    // seed ping first (existing onopen behavior), then the queued frames in order
    expect(tags).toEqual(['ping', 'quick_join', 'list_rooms']);
    conn.close();
  });

  it('discards the queue when connect fails — nothing is sent late', async () => {
    const conn = new Connection();
    const opened = conn.connect('ws://test/');
    conn.send({ t: 'quick_join', name: 'ProbeA', sig: 'x' } as never);
    latestSocket().refuse();
    await expect(opened).rejects.toThrow('connection refused');
    expect(latestSocket().sent).toEqual([]);
    conn.close();
  });

  it('drops ephemeral input while CONNECTING instead of queueing a stale burst', async () => {
    const conn = new Connection();
    const opened = conn.connect('ws://test/');
    conn.send({ t: 'input', seq: 1 } as never);
    conn.send({ t: 'input', seq: 2 } as never);
    latestSocket().open();
    await opened;
    const tags = latestSocket().sent.map((s) => (JSON.parse(s) as { t: string }).t);
    expect(tags).toEqual(['ping']); // seed ping only — stale inputs never flush
    conn.close();
  });

  it('still sends immediately when the socket is already open', async () => {
    const conn = new Connection();
    const opened = conn.connect('ws://test/');
    latestSocket().open();
    await opened;
    latestSocket().sent.length = 0; // ignore the seed ping
    conn.send({ t: 'list_rooms' } as never);
    expect(latestSocket().sent.map((s) => (JSON.parse(s) as { t: string }).t)).toEqual([
      'list_rooms',
    ]);
    conn.close();
  });

  it('drops frames after an explicit close', async () => {
    const conn = new Connection();
    const opened = conn.connect('ws://test/');
    latestSocket().open();
    await opened;
    conn.close();
    conn.send({ t: 'list_rooms' } as never);
    expect(latestSocket().sent.map((s) => (JSON.parse(s) as { t: string }).t)).toEqual([
      'ping',
    ]);
  });
});
