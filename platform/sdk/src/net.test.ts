// SdkNet send-while-CONNECTING regression coverage. Same race as the STRICKEN
// "Reserving a slot…" hang: send() used to drop every frame fired during the
// handshake, so a fast join vanished with zero errors. SdkNet has no game
// consumers yet, but it is the migration target — the queue must be proven
// before the first game moves onto it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SdkNet } from './net.js';

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
  onclose: ((ev: { code: number }) => void) | null = null;

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
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
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

function tags(ws: FakeWebSocket): string[] {
  return ws.sent.map((s) => (JSON.parse(s) as { t: string }).t);
}

describe('SdkNet send-while-CONNECTING', () => {
  it('queues frames sent before open and flushes them FIFO after ping+auth', async () => {
    const net = new SdkNet({ authPayload: () => ({ t: 'auth', token: 'tok' }) as never });
    const opened = net.connect('ws://test/');
    net.send({ t: 'quick_join', name: 'A' } as never);
    net.send({ t: 'list_rooms' } as never);
    expect(latestSocket().sent).toEqual([]);

    latestSocket().open();
    await opened;
    expect(tags(latestSocket())).toEqual(['ping', 'auth', 'quick_join', 'list_rooms']);
    net.close();
  });

  it('drops the oldest queued frame past the cap', async () => {
    const net = new SdkNet();
    const opened = net.connect('ws://test/');
    for (let i = 0; i < 33; i++) net.send({ t: 'list_rooms', n: i } as never);
    latestSocket().open();
    await opened;
    const frames = latestSocket().sent.map((s) => JSON.parse(s) as { t: string; n?: number });
    expect(frames.length).toBe(33); // seed ping + 32 queued (cap)
    expect(frames[1]).toEqual({ t: 'list_rooms', n: 1 }); // n:0 was shed
    net.close();
  });

  it('discards the queue when connect fails — nothing is sent late', async () => {
    const net = new SdkNet();
    const opened = net.connect('ws://test/');
    net.send({ t: 'quick_join', name: 'A' } as never);
    latestSocket().refuse();
    await expect(opened).rejects.toThrow('connection refused');
    expect(latestSocket().sent).toEqual([]);
    net.close();
  });

  it('still sends immediately when the socket is already open', async () => {
    const net = new SdkNet();
    const opened = net.connect('ws://test/');
    latestSocket().open();
    await opened;
    latestSocket().sent.length = 0;
    net.send({ t: 'list_rooms' } as never);
    expect(tags(latestSocket())).toEqual(['list_rooms']);
    net.close();
  });

  it('never transmits frames sent after an explicit close (next connect discards them)', async () => {
    const net = new SdkNet();
    const opened = net.connect('ws://test/');
    latestSocket().open();
    await opened;
    net.close();
    net.send({ t: 'list_rooms' } as never); // queued, but no redial follows a user close
    const reopened = net.connect('ws://test/'); // manual re-connect discards the stale queue
    latestSocket().open();
    await reopened;
    expect(tags(latestSocket())).toEqual(['ping']); // seed ping only — stale frame never flushes
    net.close();
  });

  it('bridges the reconnect gap when autoReconnect redials', async () => {
    vi.useFakeTimers();
    try {
      const net = new SdkNet({ autoReconnect: true });
      const opened = net.connect('ws://test/');
      latestSocket().open();
      await opened;
      latestSocket().close(); // post-open drop: redial scheduled in 500ms
      net.send({ t: 'quick_join', name: 'A' } as never); // NULL-GAP send (ws===null)
      expect(FakeWebSocket.instances.length).toBe(1);

      await vi.advanceTimersByTimeAsync(500); // the redial fires
      expect(FakeWebSocket.instances.length).toBe(2);
      latestSocket().open();
      expect(tags(latestSocket())).toEqual(['ping', 'quick_join']); // gap bridged
      net.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
