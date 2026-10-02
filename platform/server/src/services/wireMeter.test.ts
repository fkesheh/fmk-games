// P0-1 wire meter tests — pure counters, no sockets involved.
import { describe, expect, it } from 'vitest';
import { WireMeter } from './wireMeter.js';

describe('WireMeter', () => {
  it('accumulates per-room bytes/messages plus cumulative totals', () => {
    const m = new WireMeter();
    m.add('room-a', 'fps', 100);
    m.add('room-a', 'fps', 50);
    m.add('room-b', 'kart', 200);

    expect(m.snapshot()).toEqual({
      messages: 3,
      bytes: 350,
      rooms: [
        { roomId: 'room-a', gameId: 'fps', messages: 2, bytes: 150 },
        { roomId: 'room-b', gameId: 'kart', messages: 1, bytes: 200 },
      ],
    });
  });

  it('ignores non-positive and non-finite byte counts', () => {
    const m = new WireMeter();
    m.add('room-a', 'fps', 0);
    m.add('room-a', 'fps', -5);
    m.add('room-a', 'fps', Number.NaN);

    expect(m.snapshot()).toEqual({ messages: 0, bytes: 0, rooms: [] });
  });

  it('drop() forgets the room entry but keeps cumulative totals', () => {
    const m = new WireMeter();
    m.add('room-a', 'fps', 100);
    m.drop('room-a');

    const snap = m.snapshot();
    expect(snap.rooms).toEqual([]);
    expect(snap.messages).toBe(1);
    expect(snap.bytes).toBe(100);
  });

  it('reset() zeroes everything', () => {
    const m = new WireMeter();
    m.add('room-a', 'fps', 100);
    m.reset();

    expect(m.snapshot()).toEqual({ messages: 0, bytes: 0, rooms: [] });
  });
});
