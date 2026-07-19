// ============================================================================
// C10 — ClientState: plain client-side session data + server clock estimate.
// Frozen shape per CONTRACT.md. clientGame is the only writer; main.ts reads
// it for the ?debug surface. serverOffset rides on Connection's min-RTT
// sample (seeded from 'joined'.serverTime until the first pong lands).
// ============================================================================
import type {
  MapId,
  PlayerId,
  RoomId,
  RoomPhase,
  RosterEntry,
  Team,
  YouSnap,
} from '@fps/shared';

export class ClientState {
  youId: PlayerId | null = null;
  team: Team | null = null;
  roomId: RoomId | null = null;
  code: string | null = null;
  mapId: MapId | null = null;
  phase: RoomPhase = 'warmup';
  phaseEndsAt = 0; // serverTime ms; 0 = no timer (warmup/matchEnd)
  round = 0;
  scoreT = 0;
  scoreCT = 0;
  roster: Map<PlayerId, RosterEntry> = new Map();
  latestYou: YouSnap | null = null;
  serverOffset = 0; // ms; serverNow() = performance.now() + offset

  serverNow(): number {
    return performance.now() + this.serverOffset;
  }
}
