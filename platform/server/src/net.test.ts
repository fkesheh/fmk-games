// Session.send byte accounting (P0-1) — the ws socket is faked; only
// readyState/send/close behavior is exercised, never a real connection.
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { S2C } from '@platform/shared';
import { Session } from './net.js';

function fakeSocket(
  readyState: number,
  send: (frame: string) => void,
  bufferedAmount = 0,
): WebSocket {
  return { readyState, send, bufferedAmount } as unknown as WebSocket;
}

describe('Session.send byte accounting (P0-1)', () => {
  it('returns the encoded frame length and delivers the exact frame', () => {
    const frames: string[] = [];
    const sess = new Session('p1', fakeSocket(WebSocket.OPEN, (f) => frames.push(String(f))));
    const msg: S2C = { t: 'error', code: 'x', message: 'y' };

    const n = sess.send(msg);

    expect(n).toBe(JSON.stringify(msg).length);
    expect(frames).toEqual([JSON.stringify(msg)]);
  });

  it('returns 0 and sends nothing when the socket is not open', () => {
    const send = vi.fn();
    const sess = new Session('p1', fakeSocket(WebSocket.CLOSED, send));

    expect(sess.send({ t: 'error', code: 'x', message: 'y' })).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 0 when the socket dies mid-send instead of throwing', () => {
    const sess = new Session(
      'p1',
      fakeSocket(WebSocket.OPEN, () => {
        throw new Error('socket gone');
      }),
    );

    expect(sess.send({ t: 'error', code: 'x', message: 'y' })).toBe(0);
  });
});

describe('Session.send flood coalescing', () => {
  const snap = (tick: number): S2C => ({ t: 'rift_snap', tick }) as unknown as S2C;

  it('drops a same-tag repeat while backlogged past 64KB (returns 0, sends nothing)', () => {
    const frames: string[] = [];
    const sock = fakeSocket(WebSocket.OPEN, (f) => frames.push(String(f)));
    const sess = new Session('p1', sock);

    expect(sess.send(snap(1))).toBeGreaterThan(0); // first frame always flushes
    (sock as unknown as { bufferedAmount: number }).bufferedAmount = 128 * 1024; // backlog!

    expect(sess.send(snap(2))).toBe(0); // superseded: the next tick re-sends fresher
    expect(sess.send(snap(3))).toBe(0);
    expect(frames).toHaveLength(1);
  });

  it('a different tag still flushes through backlog (rare tags never starve)', () => {
    const frames: string[] = [];
    const sock = fakeSocket(WebSocket.OPEN, (f) => frames.push(String(f)));
    const sess = new Session('p1', sock);
    sess.send(snap(1));
    (sock as unknown as { bufferedAmount: number }).bufferedAmount = 2 * 1024 * 1024; // deep flood

    const n = sess.send({ t: 'error', code: 'x', message: 'y' });

    expect(n).toBeGreaterThan(0);
    expect(frames).toHaveLength(2);
  });

  it('sending resumes once the backlog drains below the cap', () => {
    const frames: string[] = [];
    const sock = fakeSocket(WebSocket.OPEN, (f) => frames.push(String(f)));
    const sess = new Session('p1', sock);
    sess.send(snap(1));
    const buf = sock as unknown as { bufferedAmount: number };
    buf.bufferedAmount = 1024 * 1024;
    expect(sess.send(snap(2))).toBe(0);

    buf.bufferedAmount = 0; // drained
    expect(sess.send(snap(3))).toBeGreaterThan(0);
    expect(frames).toHaveLength(2);
  });

  it('at most one stale copy is skipped per tag: a fresh tag resets the repeat latch', () => {
    const frames: string[] = [];
    const sock = fakeSocket(WebSocket.OPEN, (f) => frames.push(String(f)), 1024 * 1024);
    const sess = new Session('p1', sock);

    sess.send(snap(1)); // first send: lastSent=null, flushes, latches 'rift_snap'
    expect(sess.send(snap(2))).toBe(0); // same tag + backlog: dropped
    sess.send({ t: 'error', code: 'x', message: 'y' }); // different tag: flushes, latches 'error'
    expect(sess.send(snap(3))).toBeGreaterThan(0); // tag differs from latch: the FRESH snap flushes
    expect(frames).toHaveLength(3);
  });
});
