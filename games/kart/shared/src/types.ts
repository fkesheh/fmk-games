// ============================================================================
// FROZEN CONTRACT — KART GP: wire types. See docs/KART.md.
// ============================================================================

export type KartPhase = 'lobby' | 'ready' | 'countdown' | 'racing' | 'results';

/** Room-level messages (platform lobby handles join/leave/list itself). */
export type KartC2S = {
  t: 'kart_state';
  seq: number; // per-client monotonic
  p: [number, number, number]; // kart origin (y ~0)
  yaw: number;
  v: [number, number]; // velocity x/z m/s
  steer: number; // -1..1
  drift: boolean;
};

export interface KartPlayerInfo {
  id: string;
  name: string;
  slot: number; // grid slot (join order)
  color: number; // index into KART_COLORS (shared/palette)
}

export interface KartPlayerSnap extends KartPlayerInfo {
  p: [number, number, number];
  yaw: number;
  v: [number, number];
  steer: number;
  drift: boolean;
  lap: number; // 1-based current lap
  nextGate: number; // next expected gate index (0 == start/finish)
  progress: number; // (lap-1)*GATES + nextGate
  place: number; // 1-based race position
  finished: boolean;
  finishMs: number; // race time at finish, -1 while racing
}

export interface KartYou {
  lap: number;
  nextGate: number;
  progress: number;
  place: number;
  finished: boolean;
  finishMs: number;
  bestLapMs: number; // -1 until a lap completes
}

export type RaceEvent =
  | { kind: 'countdown'; n: number } // 3,2,1
  | { kind: 'go' }
  | { kind: 'gate'; playerId: string; gate: number }
  | { kind: 'lap'; playerId: string; lap: number; lapMs: number }
  | { kind: 'finish'; playerId: string; place: number }
  | { kind: 'timeout' }
  | { kind: 'restart' };

export type KartS2C =
  | { t: 'kart_joined'; you: string; slot: number; color: number; phase: KartPhase; players: KartPlayerInfo[] }
  | {
      t: 'kart_snapshot';
      tick: number;
      serverTime: number;
      phase: KartPhase;
      countdown: number; // current countdown number during 'countdown', else 0
      phaseEndsAt: number; // serverTime ms; 0 when no phase timer
      you: KartYou;
      players: KartPlayerSnap[];
    }
  | { t: 'race_event'; ev: RaceEvent };
