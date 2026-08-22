// ============================================================================
// FROZEN CONTRACT — SUMO: wire types. See specs/P10.md.
// The C2S surface carries INTENT ONLY: axes + a button bitmask + a monotonic
// seq. No message a client can send names a coordinate — the server owns
// every body through @sumo/server sim.ts.
// ============================================================================

/** Room phases. 'warmup' is what the lobby's quick-join prefers to match into. */
export type SumoPhase = 'warmup' | 'countdown' | 'live' | 'results';

/** Button bits inside SumoInputMsg.bits / PadFrame.buttons (mirrors padLayout). */
export const BIT_DASH = 1 << 0;
export const BIT_JUMP = 1 << 1;

/**
 * One tick of player intent — the ONLY gameplay message a client may send.
 * `seq` is per-client monotonic; the room echoes the last consumed value as
 * you.ack. Axes are -1..1 (analog stick / WASD), bits is the DASH/JUMP mask.
 */
export interface SumoInputMsg {
  t: 'input';
  seq: number;
  mx: number;
  mz: number;
  bits: number;
}

/** Test/e2e hook: ask the room to seat one bot (capped at MAX_PLAYERS). */
export interface SumoDebugBotMsg {
  t: 'debug_bot';
}

export type SumoC2S = SumoInputMsg | SumoDebugBotMsg;

// ---- S2C ---------------------------------------------------------------------

/** One player's line in the per-tick roster (interpolated client-side). */
export interface SumoPlayerSnap {
  id: string;
  name: string;
  /** Index into SUMO_COLORS (shared/config) — slot-stable candy color. */
  color: number;
  x: number;
  y: number; // feet height; < FALL_Y means gone
  z: number;
  vy: number;
  yaw: number;
  alive: boolean;
  /** True briefly after a dash lands (afterimage/emissive flash on remotes). */
  dashing: boolean;
}

/** Per-recipient block: your ack + your authoritative state + cooldowns. */
export interface SumoYou {
  seq: number; // last seq YOU sent (echo for lag UI)
  ack: number; // last input seq the server CONSUMED for you
  x: number;
  y: number;
  z: number;
  vy: number;
  cooldowns: { dash: number }; // seconds remaining, 0 = ready
}

/** Match scoreboard row (sorted wins-desc by the room). */
export interface SumoWinRow {
  id: string;
  name: string;
  wins: number;
}

/** Killfeed-style round events, delivered in the tick they happened. */
export type SumoEvent =
  | { kind: 'countdown'; n: number }
  | { kind: 'go' }
  /** A player went out. by=null => unattributed fall (no pusher within window). */
  | { kind: 'ko'; victim: string; by: string | null }
  | { kind: 'round_end'; winner: string | null; draw: boolean }
  /** Someone reached WINS_TO_MATCH round wins; wins reset when results end. */
  | { kind: 'match_end'; champion: string };

/**
 * The ONE snapshot, sent every sim tick (30Hz). Positions are authoritative —
 * clients interpolate ~INTERP_MS behind serverTime and never predict.
 * `radius` is the live platform radius so late joiners render the right disc.
 */
export interface SumoSnapMsg {
  t: 'snap';
  tick: number;
  serverTime: number; // epoch ms (Date.now() at the room)
  phase: SumoPhase;
  /** Epoch ms the current phase ends at (live: shrink deadline); 0 in warmup. */
  phaseEndsAt: number;
  round: number; // 1-based round within the running match
  radius: number; // live platform radius, u
  you: SumoYou;
  players: SumoPlayerSnap[];
  wins: SumoWinRow[];
  events: SumoEvent[];
}

/** Sent to a joiner (and only then): identity + full seated roster. */
export interface SumoJoinedMsg {
  t: 'sumo_joined';
  you: string;
  roomId: string;
  code: string | null;
  phase: SumoPhase;
  players: ReadonlyArray<{ id: string; name: string; color: number; wins: number }>;
}

export type SumoS2C =
  | SumoJoinedMsg
  | SumoSnapMsg
  | { t: 'sumo_event'; ev: SumoEvent }; // reserved: room currently embeds events in snaps
