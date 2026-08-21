// ============================================================================
// ACES wire protocol — FROZEN Layer-1.
// Room-level messages only (the platform lobby owns join/create envelopes).
// parseC2S is the single validation gate: it returns a fully-typed message or
// null — the server NEVER trusts raw client JSON beyond this function.
//
// Snapshot shape note: planes/bullets/crates are plain arrays of the shared
// state types with the same field names, so client code renders straight off
// snapshot objects and prediction reuses PlaneState verbatim. `seq` on the
// player's own row echoes the last input seq the server had applied.
// ============================================================================

import type { Difficulty, PlaneClassId, RoomSettings, TeamId } from './config.js';
import { DEFAULT_TEAM_SIZE } from './config.js';
import type { CrateState, GameEvent, MatchPhase, ScoreRow } from './types.js';

/** One plane as seen in a snapshot (subset of PlaneState + echo fields). */
export interface SnapPlane {
  id: string;
  name: string;
  team: TeamId;
  cls: PlaneClassId;
  bot: boolean;
  x: number;
  y: number;
  h: number;
  /** speed magnitude, u/s — enough for remote interpolation */
  sp: number;
  hp: number;
  maxHp: number;
  heat: number;
  jammed: boolean;
  boost: number;
  boosting: boolean;
  throttle: number;
  invulnT: number;
  dead: boolean;
  streak: number;
  /** echoed last-applied input seq — OWN plane only; 0 for everyone else */
  seq: number;
}

export interface SnapshotMsg {
  t: 'snapshot';
  tick: number;
  phase: MatchPhase;
  timeLeftS: number;
  tickets: { royal: number; iron: number };
  you?: SnapPlane; //    omitted while dead/spectating
  planes: SnapPlane[];
  bullets: Array<{ id: number; team: TeamId; x: number; y: number; vx: number; vy: number }>;
  crates: CrateState[];
}

export interface WelcomeMsg {
  t: 'welcome';
  id: string; //         your plane/player id
  seed: number; //       map seed — client rebuilds identical terrain
  tickRate: number;
  snapRate: number;
  phase: MatchPhase;
  timeLeftS: number;
  tickets: { royal: number; iron: number };
  settings: Required<RoomSettings>;
  roster: ScoreRow[];
}

export type EventMsg = { t: 'event'; e: GameEvent };
export type PhaseMsg = { t: 'phase'; phase: MatchPhase; endsAtS: number; winner?: TeamId };
export type ScoreMsg = { t: 'score'; board: ScoreRow[] };
export type PongMsg = { t: 'pong'; ts: number };

export type S2C = SnapshotMsg | WelcomeMsg | EventMsg | PhaseMsg | ScoreMsg | PongMsg;

// ---- client → server -------------------------------------------------------------

export interface JoinMsg {
  t: 'join';
  name: string; //       1..16 chars after trim
}
export interface InputMsg {
  t: 'input';
  seq: number;
  th: number; //        −0.3..1
  tr: number; //        −1..1
  fire: boolean;
  boost: boolean;
}
export interface SpawnMsg {
  t: 'spawn';
  cls: PlaneClassId;
}
export interface PingMsg {
  t: 'ping';
  ts: number;
}

export type C2S = JoinMsg | InputMsg | SpawnMsg | PingMsg;

/**
 * Validate one parsed room message. Returns a typed C2S or null.
 * Strictness law: numbers must be finite and within range, strings trimmed to
 * length bounds, unknown `t` rejected. No exceptions thrown for bad input —
 * null means "ignore".
 */
export function parseC2S(msg: unknown): C2S | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (typeof m.t !== 'string') return null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  switch (m.t) {
    case 'join': {
      if (typeof m.name !== 'string') return null;
      const name = m.name.trim().slice(0, 16);
      if (name.length < 1) return null;
      return { t: 'join', name };
    }
    case 'input': {
      const seq = num(m.seq);
      const th = num(m.th);
      const tr = num(m.tr);
      if (seq === null || th === null || tr === null) return null;
      if (typeof m.fire !== 'boolean' || typeof m.boost !== 'boolean') return null;
      return {
        t: 'input',
        seq,
        th: Math.max(-0.3, Math.min(1, th)),
        tr: Math.max(-1, Math.min(1, tr)),
        fire: m.fire,
        boost: m.boost,
      };
    }
    case 'spawn':
      if (m.cls !== 'scout' && m.cls !== 'fighter' && m.cls !== 'gunship') return null;
      return { t: 'spawn', cls: m.cls };
    case 'ping': {
      const ts = num(m.ts);
      if (ts === null) return null;
      return { t: 'ping', ts };
    }
    default:
      return null;
  }
}

/** Server-side settings validation (lobby forwards bad_settings errors). */
export function validateSettings(s: Record<string, unknown> | undefined): Required<RoomSettings> {
  let teamSize: number = DEFAULT_TEAM_SIZE;
  let difficulty: Difficulty = 'normal';
  let botFill = true;
  if (s) {
    if (typeof s.teamSize === 'number' && Number.isInteger(s.teamSize) && s.teamSize >= 1 && s.teamSize <= 4) {
      teamSize = s.teamSize;
    }
    if (s.difficulty === 'easy' || s.difficulty === 'normal' || s.difficulty === 'hard') {
      difficulty = s.difficulty;
    }
    if (typeof s.botFill === 'boolean') botFill = s.botFill;
  }
  return { teamSize, difficulty, botFill };
}
