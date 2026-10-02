// ============================================================================
// P0-1 wire meter: cumulative byte/message counters for room-originated
// sends, attributed per open room. The lobby records Session.send's returned
// frame length here on every io.send; snapshots dominate room traffic
// (30Hz/20Hz vs rare events), so per-room bytes ≈ snapshot cost — the number
// the hosted-authority work is gated on (bytes/room/tick ÷ tick Hz).
//
// Shape: totals are cumulative since construction/reset (a soak harness
// samples deltas); `rooms` covers OPEN rooms only (entries drop on room
// close, so the map never grows with churn). Read via Lobby.wireStats().
// ============================================================================

export interface WireRoomStat {
  roomId: string;
  gameId: string;
  messages: number;
  bytes: number;
}

export interface WireSnapshot {
  messages: number;
  bytes: number;
  rooms: WireRoomStat[];
}

export class WireMeter {
  private readonly rooms = new Map<string, { gameId: string; messages: number; bytes: number }>();
  private totalMessages = 0;
  private totalBytes = 0;

  /** Record one attributed send. Non-positive/NaN byte counts are ignored. */
  add(roomId: string, gameId: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    let entry = this.rooms.get(roomId);
    if (entry === undefined) {
      entry = { gameId, messages: 0, bytes: 0 };
      this.rooms.set(roomId, entry);
    }
    entry.messages += 1;
    entry.bytes += bytes;
    this.totalMessages += 1;
    this.totalBytes += bytes;
  }

  /** Forget one room's entry (room closed); cumulative totals are kept. */
  drop(roomId: string): void {
    this.rooms.delete(roomId);
  }

  snapshot(): WireSnapshot {
    const rooms: WireRoomStat[] = [];
    for (const [roomId, e] of this.rooms) {
      rooms.push({ roomId, gameId: e.gameId, messages: e.messages, bytes: e.bytes });
    }
    return { messages: this.totalMessages, bytes: this.totalBytes, rooms };
  }

  reset(): void {
    this.rooms.clear();
    this.totalMessages = 0;
    this.totalBytes = 0;
  }
}
