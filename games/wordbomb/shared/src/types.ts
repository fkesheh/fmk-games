// ============================================================================
// FROZEN CONTRACT — WORDBOMB wire types. See docs/WORDBOMB.md.
// Where this file and the doc disagree, THIS FILE WINS — report the drift.
//
// THE INVARIANT THAT SHAPES THIS FILE (I1): until the bomb explodes, no player
// may learn ANY other player's word, its length, or whether it is valid.
//
// The first draft enforced I1 with a comment, on a single state object that
// held both `players[]` and `yourWord`. That is one typo away from broadcasting
// every word to every client, and no compiler could catch it. So the shape is
// now SPLIT: `WbPublicState` is broadcast and CANNOT hold a word; `WbPrivate`
// is unicast and holds only the recipient's own. There is no type in this
// codebase that can carry one player's word next to another player's id.
// Do not merge them back together.
// ============================================================================

/** Prompt difficulty — a BAND of common-word counts, not merely a minimum. */
export type WbDifficulty = 'easy' | 'normal' | 'hard';

export type WbPhase =
  | 'lobby' // seated, waiting for an EXPLICIT wb_start — nothing auto-starts
  | 'live' // fragment shown, fuse burning, players typing
  | 'reveal' // bomb went off, all answers visible
  | 'matchEnd'; // final standings

/** Room-creation settings. Opaque to the platform; validated in createRoom(). */
export interface WordbombSettings {
  rounds: number;
  difficulty: WbDifficulty;
}

/** Why a submission was refused. Sent to the SUBMITTER ONLY (I1). */
export type WbRejectReason =
  | 'not_live' // no round is running (and outside the grace window)
  | 'too_fast' // over the submission budget — see SUBMIT_COOLDOWN_MS
  | 'bad_chars' // not /^[a-z]+$/ after trim+lowercase
  | 'too_short' // below MIN_WORD_LEN
  | 'too_long' // above MAX_WORD_LEN (beyond dictionary scope)
  | 'missing_fragment' // a real word, but it does not contain the fragment
  | 'not_a_word' // not in the dictionary
  | 'already_used'; // this player already SCORED it this match (see I4)

// ---- per-player wire record (BROADCAST — never carries a word) ---------------
export interface WbPlayerState {
  id: string;
  name: string;
  score: number;
  connected: boolean;
  /**
   * I1: whether this player currently holds a VALID word. Never the word, never
   * its length. This is the entire amount other players may know before the boom.
   */
  locked: boolean;
}

// ---- broadcast snapshot ------------------------------------------------------
/**
 * Sent identically to every player. Deliberately has NO `you` and NO word
 * field — so a careless `broadcast(state)` cannot leak anything.
 */
export interface WbPublicState {
  t: 'wb_public';
  code: string | null;
  phase: WbPhase;
  /** 1-based; 0 while in lobby. */
  round: number;
  rounds: number;
  /** null unless phase is 'live' or 'reveal'. */
  fragment: string | null;
  /**
   * The fuse WINDOW only. The ACTUAL fuse is never sent in any field, which is
   * why there is no `phaseEndsAt` here: `live` is a phase, so a general
   * "phase ends at" field would BE the fuse. The client renders the bar from
   * `roundStartedAt + fuseMaxMs` and lives with the uncertainty — that
   * uncertainty is the game.
   */
  fuseMinMs: number;
  fuseMaxMs: number;
  /** Absolute server ms. 0 when not live. */
  roundStartedAt: number;
  /** Absolute server ms. 0 unless phase === 'reveal'. */
  revealEndsAt: number;
  /** Absolute server ms. 0 unless a lobby countdown is running. */
  countdownEndsAt: number;
  /** Absolute server ms. 0 unless phase === 'matchEnd'. */
  matchEndsAt: number;
  difficulty: WbDifficulty;
  players: WbPlayerState[];
  /** Set only at matchEnd. Ties broken by join order — see docs §1.3. */
  winnerId: string | null;

  // ---- THE MANUAL-START LOBBY (identical contract across all four games) -----
  // No game on this platform auto-starts. The room sits in `lobby` until some
  // seated player sends `{t:'wb_start'}`. These three fields are what the lobby
  // UI renders, so the client never hardcodes the threshold or re-derives the
  // acceptance rule and drifts from the server's answer.
  /** Connected seats right now — the count `canStart` is judged against. */
  seated: number;
  /** MIN_PLAYERS, mirrored on the wire. */
  minPlayers: number;
  /**
   * True iff a `wb_start` arriving right now would be ACCEPTED: phase is
   * `lobby`, no start beat is already running, and `seated >= minPlayers`.
   * The server is the only judge; the button is disabled from this field.
   */
  canStart: boolean;
}

// ---- private snapshot (unicast, one per recipient) ---------------------------
/**
 * The ONLY message that ever carries a word before the boom, and it goes to
 * that word's owner alone. Keep it minimal: every field added here is a field
 * someone could accidentally broadcast.
 */
export interface WbPrivate {
  t: 'wb_private';
  you: string;
  /** The recipient's own locked word, or null. Resets at each round start. */
  yourWord: string | null;
  /** Submissions left this round — lets the UI warn before `too_fast`. */
  submitsLeft: number;
}

// ---- events ------------------------------------------------------------------
export interface WbAnswer {
  playerId: string;
  /** Carried so the reveal renders standalone, even for a player who left. */
  name: string;
  /** null = submitted nothing. */
  word: string | null;
  /** How many players submitted this exact word. 0 when word is null. */
  dupes: number;
  points: number;
}

export interface WbStanding {
  playerId: string;
  name: string;
  score: number;
}

export type WbEvent =
  /**
   * Broadcast. Carries NO word and NO length. Fires AT MOST ONCE per player per
   * round — on their FIRST accepted submission. Re-firing on every re-lock
   * would turn it into a cadence side channel ("locked instantly, then upgraded
   * twice" ⇒ they are on a long word), which is exactly the read-the-room
   * behaviour I1 exists to prevent.
   */
  | { t: 'wb_locked'; playerId: string }
  /** To the submitter only. */
  | { t: 'wb_reject'; reason: WbRejectReason }
  /** THE REVEAL. Identical payload to every player (I7). */
  | { t: 'wb_boom'; fragment: string; answers: WbAnswer[] }
  /** `standings` sorted score DESC, then join order ASC. */
  | { t: 'wb_match_end'; winnerId: string | null; standings: WbStanding[] };

// ---- client -> server ---------------------------------------------------------
/**
 * The entire client surface. There is deliberately no "typing" or "progress"
 * message: broadcasting either would leak word length and violate I1.
 *
 * `wb_start` is the MANUAL START. No game on this platform auto-starts, so the
 * room leaves `lobby` only because a seated human asked it to. There is no host
 * concept — ANY seated player may press it — and it is accepted ONLY when
 * `phase === 'lobby'` and `seated >= MIN_PLAYERS`. Otherwise it is ignored in
 * silence (never an error, never a throw — I6).
 */
export type WbC2S = { t: 'wb_submit'; word: string } | { t: 'wb_start' };
