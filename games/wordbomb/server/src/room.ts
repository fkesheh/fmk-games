// ============================================================================
// WORDBOMB room (docs/WORDBOMB.md) — authoritative, simultaneous, event-driven
// (no tick loop). Every player gets the SAME fragment at the SAME moment, a
// HIDDEN fuse burns, and every answer is revealed at once when it blows.
//
// Phase ladder:  lobby -(wb_start, then LOBBY_COUNTDOWN_MS)-> live
//                -(hidden fuse)-> reveal -(revealMsFor)-> live ...
//                -> matchEnd -(MATCH_END_MS)-> lobby (and WAITS)
//
// NOTHING AUTO-STARTS. The room leaves `lobby` only because a seated player
// sent `{t:'wb_start'}`. Filling the room does not start it, and finishing a
// match does not roll into another one — `fullReset` returns to `lobby` and
// stops there. `LOBBY_COUNTDOWN_MS` survives as the beat AFTER the press, so
// round 1 is not a cold start; it is never scheduled by anything else.
//
// ONE `setTimeout` slot at a time (countdown | fuse | grace | reveal | matchEnd)
// and every deadline the client is allowed to know is an ABSOLUTE server
// `Date.now()` ms in the public snapshot. The fuse is the one deadline that is
// never sent in any field — that is the whole game (I1 / WbPublicState docs).
//
// I1 (NO EARLY LEAK) shapes every send in this file:
//   - `WbPublicState` is built ONCE per broadcast and sent byte-identically to
//     everyone; it structurally cannot hold a word.
//   - `WbPrivate` is unicast, one object per recipient, carrying only that
//     recipient's own word.
//   - `wb_locked` fires AT MOST ONCE per player per round, and a re-lock
//     triggers NO broadcast at all (a re-broadcast is a typing-cadence side
//     channel even when its payload is unchanged).
//   - `wb_reject` goes to the submitter alone.
//
// I6: no member of GameRoomHandle throws — the platform does not catch.
// ============================================================================
import {
  DEFAULT_SETTINGS,
  FUSE_MAX_MS,
  FUSE_MIN_MS,
  LOBBY_COUNTDOWN_MS,
  MATCH_END_MS,
  MAX_PLAYERS,
  MAX_SUBMITS_PER_ROUND,
  MAX_WORD_LEN,
  MIN_PLAYERS,
  MIN_WORD_LEN,
  revealMsFor,
  STALE_MS,
  SUBMIT_COOLDOWN_MS,
  SUBMIT_GRACE_MS,
  parseWordbombC2S,
  resolveRound,
  standingsOf,
} from '@wordbomb/shared';
import type {
  WbEvent,
  WbPhase,
  WbPlayerState,
  WbPrivate,
  WbPublicState,
  WbRejectReason,
  WordbombSettings,
} from '@wordbomb/shared';
import { rng, rngInt } from '@platform/shared';
import type {
  GameRoomHandle,
  PlayerId,
  RoomId,
  RoomInfo,
  RoomIO,
  Visibility,
} from '@platform/shared';
import type { RoomDeps } from './ports.js';

const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PRIVATE_CODE_LEN = 5; // A-Z0-9 join code, same convention as bank/fps
let roomSeq = 0; // mixes into the rng seed so same-ms rooms still differ

/** §5 step 2a — checked on its own, BEFORE either length bound. */
const LETTERS_ONLY = /^[a-z]+$/;

function randomToken(next: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET.charAt(rngInt(next, 0, ROOM_ALPHABET.length - 1));
  return s;
}

/**
 * Server-side player record; Map insertion order IS join order (the standings
 * tie-break, §1.3). Entries persist with `connected: false` when a socket drops
 * so a disconnected player's locked word is still scored (§2.1) and a resume
 * token can re-bind them; ghosts are purged at the next round start.
 */
interface Player {
  id: PlayerId;
  name: string;
  score: number;
  connected: boolean;
  lastMsgAt: number; // Date.now() of last room-level message; stale sweep
  /** Last VALID word this round, or null. A rejection never clears it (I3). */
  word: string | null;
  /** `wb_locked` already broadcast for this player this round (I1 cadence). */
  lockedAnnounced: boolean;
  /** Submissions consumed this round — the §5 step 0 budget. */
  submits: number;
  lastSubmitAt: number;
  /** false for a mid-match joiner until the NEXT round starts (§2.1). */
  eligible: boolean;
  /** Words this player has SCORED this match. Committed at the boom (I4). */
  used: Set<string>;
}

type Validation = { ok: true; word: string } | { ok: false; reason: WbRejectReason };

export class WordbombRoom implements GameRoomHandle {
  readonly id: RoomId;
  readonly code: string | null;
  readonly visibility: Visibility;

  private readonly io: RoomIO;
  private readonly settings: WordbombSettings; // frozen for this room's lifetime
  private readonly deps: RoomDeps; // dict + picker + rand, injected (see ports.ts)
  private readonly players = new Map<PlayerId, Player>(); // insertion order = join order

  private phase: WbPhase = 'lobby';
  private round = 0; // 0 outside a match, 1..settings.rounds during play
  private fragment: string | null = null;
  /** Fragments already used THIS match — I5 forbids a repeat within a match. */
  private readonly usedFragments = new Set<string>();

  private roundStartedAt = 0; // absolute ms; 0 when not live
  private revealEndsAt = 0; // absolute ms; 0 unless phase === 'reveal'
  private countdownEndsAt = 0; // absolute ms; 0 unless a lobby countdown runs
  private matchEndsAt = 0; // absolute ms; 0 unless phase === 'matchEnd'
  private winnerId: PlayerId | null = null;

  /** Fuse expiry (the visible explosion) — the SUBMIT_GRACE_MS anchor. */
  private boomAt = 0;
  /** True from round start until the round is RESOLVED (grace end). */
  private scoringOpen = false;

  private timer: ReturnType<typeof setTimeout> | null = null; // one phase timer at a time
  private stopped = false;

  constructor(
    visibility: Visibility,
    io: RoomIO,
    settings: WordbombSettings = DEFAULT_SETTINGS,
    deps: RoomDeps,
  ) {
    this.visibility = visibility;
    this.io = io;
    this.settings = { ...settings }; // defensive copy: settings never mutate
    this.deps = deps;
    // non-gameplay generation (room id, private code) uses rng(Date.now());
    // `deps.rand` is reserved for the fuse so tests can pin it.
    const next = rng((Date.now() ^ (roomSeq++ * 0x9e3779b9)) >>> 0);
    this.id = randomToken(next, 8);
    this.code = visibility === 'private' ? randomToken(next, PRIVATE_CODE_LEN) : null;
  }

  // -------------------------------------------------------------------------
  // GameRoomHandle surface — none of these may throw (I6)
  // -------------------------------------------------------------------------

  info(): RoomInfo {
    return {
      id: this.id,
      code: this.code,
      game: 'wordbomb',
      label: `${this.settings.rounds} rounds · ${this.settings.difficulty}`,
      players: this.playerCount(),
      maxPlayers: MAX_PLAYERS,
      phase: this.phase,
      visibility: this.visibility,
    };
  }

  /** Connected players only — disconnected entries hold no slot. */
  playerCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  /**
   * SEATS held, connected or not — a ghost still occupies one.
   *
   * This exists because `playerCount()` (connected only) is the wrong question
   * for "should the match abort". §2.1 says a disconnected player's entry
   * PERSISTS and their locked word is still scored; I8 says reconnecting
   * mid-round restores your score and your word. But the abort test used the
   * CONNECTED count, so at MIN_PLAYERS = 2 — the smallest legal table — one
   * player reloading dropped it to 1, aborted the match, and nulled EVERY
   * player's word. I8 was unreachable at a 2-player table, and the two rules
   * contradicted each other.
   *
   * A DISCONNECT IS NOT A LEAVE. Only a permanent leave frees a seat (it
   * deletes the entry), so only a permanent leave can take the room below the
   * minimum and end the match.
   */
  private seatedCount(): number {
    return this.players.size;
  }

  /**
   * Connected players with no room-level message for STALE_MS. The platform
   * closes their sockets (lobby.ts `pollStaleSessions`).
   *
   * NOBODY IS SWEPT WHILE THE ROOM IS IN `lobby`. The sweep exists to evict a
   * player who has stopped playing a match in progress; a player waiting for a
   * friend is not idle, they are waiting, and `wb_submit` is the only room-level
   * message this game has — `ping` is a LOBBY tag and never reaches us, so a
   * seated player in a lobby CANNOT refresh `lastMsgAt` even in principle.
   *
   * This was latent before the manual-start contract only because the room
   * auto-started within LOBBY_COUNTDOWN_MS and nobody could sit in a lobby for
   * five minutes. Now that lobbies wait indefinitely, sweeping them would kick
   * exactly the people the START button is waiting on.
   */
  stalePlayers(): PlayerId[] {
    if (this.phase === 'lobby') return [];
    const now = Date.now();
    const out: PlayerId[] = [];
    for (const p of this.players.values()) {
      if (p.connected && now - p.lastMsgAt > STALE_MS) out.push(p.id);
    }
    return out;
  }

  addPlayer(id: PlayerId, name: string, resume?: PlayerId): void {
    try {
      const now = Date.now();
      const existing = this.players.get(id);
      if (existing !== undefined) {
        // same-session rejoin: score, locked word and join-order slot all survive (I8)
        existing.connected = true;
        existing.name = name;
        existing.lastMsgAt = now;
      } else if (resume !== undefined && this.rebindGhost(resume, id, name, now)) {
        // resume matched a disconnected entry: re-bound in place above (I8)
      } else {
        if (this.playerCount() >= MAX_PLAYERS) {
          // unreachable via the lobby (it guards room_full first); never throws
          this.io.send(id, { t: 'error', code: 'room_full', message: 'room is full' });
          return;
        }
        // §2.1: a mid-match joiner is SEATED at score 0 with no word, and may
        // not submit until the next round starts — so their wb_boom row for the
        // round in progress is {word: null, points: 0} by construction.
        this.players.set(id, {
          id,
          name,
          score: 0,
          connected: true,
          lastMsgAt: now,
          word: null,
          lockedAnnounced: false,
          submits: 0,
          lastSubmitAt: 0,
          eligible: this.phase === 'lobby',
          used: new Set<string>(),
        });
      }
      // A full lobby is STILL just a lobby. Reaching MIN_PLAYERS only flips
      // `canStart` in the next snapshot; somebody has to press START.
      this.broadcastState();
    } catch (err) {
      console.error('[wordbomb] addPlayer failed', err);
    }
  }

  /**
   * permanent=false/omitted: ghost — the entry, score, used-word set and any
   * locked word persist (§2.1: a disconnected player's word IS scored and DOES
   * appear in `answers`) until the purge at the next round start.
   * permanent=true (explicit leave): the entry is REMOVED at once, so the
   * leaver vanishes from the rail and from the coming reveal immediately.
   */
  removePlayer(id: PlayerId, permanent?: boolean): void {
    try {
      const p = this.players.get(id);
      if (p === undefined || !p.connected) return;
      p.connected = false;
      if (permanent === true) this.players.delete(id);

      if (this.seatedCount() === 0) {
        // §2.1: room empty — no SEATS left (not merely nobody online). Stop
        // every timer; the platform drops the room.
        this.clearTimer();
        this.countdownEndsAt = 0;
        this.scoringOpen = false;
        return;
      }
      if (this.phase === 'live' || this.phase === 'reveal') {
        // §2.1: below MIN_PLAYERS mid-match -> abort to lobby, SCORES KEPT.
        // SEATS, not connections: a reload must not kill the match (I8).
        if (this.seatedCount() < MIN_PLAYERS) this.abortToLobby();
      } else if (this.phase === 'lobby' && this.countdownEndsAt !== 0) {
        if (this.playerCount() < MIN_PLAYERS) {
          this.clearTimer();
          this.countdownEndsAt = 0;
        }
      }
      this.broadcastState();
    } catch (err) {
      console.error('[wordbomb] removePlayer failed', err);
    }
  }

  handleMessage(id: PlayerId, msg: unknown): void {
    try {
      const parsed = parseWordbombC2S(msg);
      if (parsed === null) return;
      const p = this.players.get(id);
      if (p === undefined || !p.connected) return;
      p.lastMsgAt = Date.now();
      if (parsed.t === 'wb_start') {
        this.tryStart();
        return;
      }
      this.trySubmit(p, parsed.word);
    } catch (err) {
      console.error('[wordbomb] handleMessage failed', err);
    }
  }

  start(): void {
    this.stopped = false; // idempotent — event-driven, no loop to start
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  // -------------------------------------------------------------------------
  // Match flow
  // -------------------------------------------------------------------------

  /**
   * THE MANUAL START — the only door out of `lobby`.
   *
   * ANY seated player may press it: there is no host, so the room cannot be
   * held hostage by whoever happened to create it (or by whoever left). The
   * acceptance rule is exactly `canStart` on the wire, so a client that renders
   * an enabled button and a server that accepts the press can never disagree.
   *
   * Every other case is ignored IN SILENCE — no error, no throw (I6). A second
   * press during the beat, a press mid-match, a press at matchEnd and a press
   * with one player seated are all indistinguishable no-ops, which is what makes
   * a double-click harmless.
   */
  private tryStart(): void {
    if (!this.startAllowed()) return;
    this.startCountdown();
  }

  /** The single source of truth for `wb_start` acceptance AND `canStart`. */
  private startAllowed(): boolean {
    return (
      this.phase === 'lobby' && this.countdownEndsAt === 0 && this.playerCount() >= MIN_PLAYERS
    );
  }

  /**
   * The beat AFTER the press, so round 1 is not a cold start — the fragment
   * does not appear under the fingers of whoever clicked. Scheduled from
   * `tryStart()` and nowhere else. `countdownEndsAt` is public and is zero in
   * every lobby that is merely waiting.
   */
  private startCountdown(): void {
    this.countdownEndsAt = Date.now() + LOBBY_COUNTDOWN_MS;
    this.setTimer(() => {
      this.countdownEndsAt = 0;
      if (this.playerCount() >= MIN_PLAYERS) this.startMatch();
      else this.broadcastState();
    }, LOBBY_COUNTDOWN_MS);
    this.broadcastState();
  }

  /** A NEW match: scores AND used-word sets zeroed, fragment history cleared. */
  private startMatch(): void {
    for (const p of this.players.values()) {
      p.score = 0;
      p.used.clear();
    }
    this.usedFragments.clear();
    this.winnerId = null;
    this.matchEndsAt = 0;
    this.startRound(1);
  }

  /**
   * Open a round: purge ghosts, reset every per-round player field (`yourWord`
   * and `locked` reset at the START of a round, §2.1), pick an unused fragment
   * and arm the HIDDEN fuse.
   */
  private startRound(n: number): void {
    this.purgeGhosts();
    for (const p of this.players.values()) {
      p.word = null;
      p.lockedAnnounced = false;
      p.submits = 0;
      p.lastSubmitAt = 0;
      p.eligible = true; // a mid-match joiner becomes eligible exactly here
    }

    let fragment: string | null = null;
    try {
      fragment = this.deps.picker.pick(this.settings.difficulty, this.usedFragments, this.deps.rand);
    } catch (err) {
      console.error('[wordbomb] fragment pick failed', err);
    }
    if (fragment === null || fragment === '') {
      // I5 makes this unreachable (pools are 512/969/851 against ROUNDS_MAX 20).
      // If it ever happens we end the match cleanly rather than throw (I6).
      this.round = n;
      this.endMatch();
      return;
    }
    this.usedFragments.add(fragment);
    this.fragment = fragment;

    this.round = n;
    this.phase = 'live';
    this.roundStartedAt = Date.now();
    this.revealEndsAt = 0;
    this.matchEndsAt = 0;
    this.boomAt = 0;
    this.scoringOpen = true;

    // THE FUSE: uniform in [FUSE_MIN_MS, FUSE_MAX_MS], drawn from the injected
    // rand so tests can pin it. It is never written into any wire field.
    const fuseMs = rngInt(this.deps.rand, FUSE_MIN_MS, FUSE_MAX_MS);
    this.setTimer(() => this.explode(), fuseMs);
    this.broadcastState();
  }

  /**
   * Fuse expiry. The bomb VISUALLY explodes NOW (phase -> reveal, broadcast),
   * but SCORING CLOSES SUBMIT_GRACE_MS later: a `wb_submit` sent before the
   * boom and arriving inside that window folds into the round that just closed.
   * Without it a 180ms-RTT player loses words a 20ms-RTT player keeps, in a
   * game whose whole tension is the last second.
   */
  private explode(): void {
    if (this.phase !== 'live') return;
    this.boomAt = Date.now();
    this.phase = 'reveal';
    this.roundStartedAt = 0; // 0 when not live (WbPublicState)
    // scales with the table — see revealMsFor()
    this.revealEndsAt = this.boomAt + SUBMIT_GRACE_MS + revealMsFor(this.playerCount());
    this.setTimer(() => this.resolve(), SUBMIT_GRACE_MS);
    this.broadcastPublic(); // no answers yet — this is the flash, not the reveal
  }

  /**
   * Grace expired: score the round and REVEAL. I7 holds by construction —
   * `resolveRound` takes the roster separately, so a player who locked nothing
   * still gets a row. I4 is committed HERE, from the word that actually scored.
   */
  private resolve(): void {
    if (this.phase !== 'reveal' || !this.scoringOpen) return;
    this.scoringOpen = false;

    const roster = [...this.players.values()];
    const words = new Map<PlayerId, string>();
    for (const p of roster) if (p.word !== null) words.set(p.id, p.word);

    const answers = resolveRound(roster, words);
    for (const a of answers) {
      if (a.word === null) continue;
      const p = this.players.get(a.playerId);
      if (p === undefined) continue;
      p.score += a.points;
      p.used.add(a.word); // I4: committed at BOOM RESOLUTION, never at lock time
    }

    const fragment = this.fragment ?? '';
    this.broadcastEvent({ t: 'wb_boom', fragment, answers }); // identical to everyone (I7)
    this.broadcastState(); // scores updated; yourWord persists through reveal
    this.setTimer(() => this.afterReveal(), Math.max(0, this.revealEndsAt - Date.now()));
  }

  /** Reveal window over: next round, or the end of the match. */
  private afterReveal(): void {
    this.revealEndsAt = 0;
    // Seats, not connections — a player reloading between rounds keeps the match
    // alive and rejoins into it (I8).
    if (this.seatedCount() < MIN_PLAYERS) {
      this.abortToLobby();
      this.broadcastState();
      return;
    }
    if (this.round >= this.settings.rounds) {
      this.endMatch();
      return;
    }
    this.startRound(this.round + 1);
  }

  /** Final standings hold for MATCH_END_MS, then a full reset (§1.3). */
  private endMatch(): void {
    const standings = standingsOf([...this.players.values()]);
    this.winnerId = standings[0]?.playerId ?? null;
    this.phase = 'matchEnd';
    this.fragment = null;
    this.roundStartedAt = 0;
    this.revealEndsAt = 0;
    this.countdownEndsAt = 0;
    this.scoringOpen = false;
    this.boomAt = 0;
    this.matchEndsAt = Date.now() + MATCH_END_MS;
    this.broadcastEvent({ t: 'wb_match_end', winnerId: this.winnerId, standings });
    this.setTimer(() => this.fullReset(), MATCH_END_MS);
    this.broadcastState(); // timer-driven transition: no caller broadcasts after us
  }

  /**
   * §1.3 — purge disconnected entries, zero scores AND every used-word set, and
   * return to `lobby`, where the room WAITS.
   *
   * This used to auto-start the next match if >= MIN_PLAYERS remained. It no
   * longer does: a table that just finished ten rounds is exactly the moment
   * people want to leave, change the difficulty, or wait for a friend, and
   * silently dealing them into another match takes that choice away. The
   * standings stay readable until somebody presses START again.
   */
  private fullReset(): void {
    this.purgeGhosts();
    for (const p of this.players.values()) {
      p.score = 0;
      p.used.clear();
      p.word = null;
      p.lockedAnnounced = false;
      p.submits = 0;
      p.lastSubmitAt = 0;
      p.eligible = true;
    }
    this.usedFragments.clear();
    this.resetPhaseFields();
    this.broadcastState(); // back in the lobby, waiting for an explicit START
  }

  /** Low pop mid-match: abort to the lobby with scores KEPT, timers cleared. */
  private abortToLobby(): void {
    this.clearTimer();
    for (const p of this.players.values()) {
      p.word = null;
      p.lockedAnnounced = false;
      p.submits = 0;
      p.lastSubmitAt = 0;
    }
    this.usedFragments.clear(); // the aborted match is over; the next one is fresh
    this.resetPhaseFields();
  }

  private resetPhaseFields(): void {
    this.phase = 'lobby';
    this.round = 0;
    this.fragment = null;
    this.roundStartedAt = 0;
    this.revealEndsAt = 0;
    this.countdownEndsAt = 0;
    this.matchEndsAt = 0;
    this.winnerId = null;
    this.boomAt = 0;
    this.scoringOpen = false;
  }

  // -------------------------------------------------------------------------
  // Submission — §5, in EXACTLY this order, first failure wins
  // -------------------------------------------------------------------------

  private trySubmit(p: Player, raw: string): void {
    const now = Date.now();

    // §5 step 0 — THE BUDGET, before everything including the dictionary probe.
    // A rejection that still costs a lookup does not throttle the oracle at all.
    if (p.submits >= MAX_SUBMITS_PER_ROUND || now - p.lastSubmitAt < SUBMIT_COOLDOWN_MS) {
      this.sendReject(p, 'too_fast'); // budget untouched: no private resend needed
      return;
    }
    p.submits++;
    p.lastSubmitAt = now;

    const v = this.validate(p, raw, now);
    if (!v.ok) {
      this.sendReject(p, v.reason);
      this.sendPrivate(p); // submitsLeft moved; unicast, so nothing leaks (I3: word kept)
      return;
    }

    p.word = v.word; // I3: last valid wins
    if (!p.lockedAnnounced) {
      // I1: at most ONCE per player per round. A re-lock broadcasts NOTHING —
      // even an identical payload would be a typing-cadence side channel.
      p.lockedAnnounced = true;
      this.broadcastEvent({ t: 'wb_locked', playerId: p.id });
      this.broadcastPublic();
    }
    this.sendPrivate(p); // the submitter's own yourWord, to the submitter alone
  }

  /** §5 steps 1-5. Step 0 (budget) is handled by the caller. */
  private validate(p: Player, raw: string, now: number): Validation {
    // 1 — a round must be open, and open FOR THIS PLAYER (§2.1 mid-match joiner)
    if (!this.submissionsOpen(now) || !p.eligible) return { ok: false, reason: 'not_live' };

    const word = raw.trim().toLowerCase();
    // 2a/2b/2c are three SEPARATE checks: "a1" fails 2a, not 2b.
    if (!LETTERS_ONLY.test(word)) return { ok: false, reason: 'bad_chars' };
    if (word.length < MIN_WORD_LEN) return { ok: false, reason: 'too_short' };
    if (word.length > MAX_WORD_LEN) return { ok: false, reason: 'too_long' };

    // 3 BEFORE 4: a real word that simply misses the fragment must be told so,
    // rather than being called "not a word", which players read as a bug.
    const fragment = this.fragment;
    if (fragment === null || !word.includes(fragment)) {
      return { ok: false, reason: 'missing_fragment' };
    }
    if (!this.deps.dict.has(word)) return { ok: false, reason: 'not_a_word' };
    // 5 — I4: only words this player actually SCORED are burned. Re-locking a
    // word abandoned earlier in THIS round is legal — it never scored.
    if (p.used.has(word)) return { ok: false, reason: 'already_used' };

    return { ok: true, word };
  }

  /** §5 step 1: `phase === 'live'`, OR inside the SUBMIT_GRACE_MS window. */
  private submissionsOpen(now: number): boolean {
    if (this.phase === 'live') return true;
    return (
      this.phase === 'reveal' &&
      this.scoringOpen &&
      this.boomAt > 0 &&
      now - this.boomAt <= SUBMIT_GRACE_MS
    );
  }

  // -------------------------------------------------------------------------
  // Membership helpers
  // -------------------------------------------------------------------------

  /**
   * Resume-token rejoin (I8): `oldId` names an existing entry that is currently
   * disconnected — re-bind it to the new session id, keeping its exact
   * join-order slot, score, used-word set and locked word. Returns false when
   * there is no such entry or it is still connected (the caller joins as new).
   */
  private rebindGhost(oldId: PlayerId, newId: PlayerId, name: string, now: number): boolean {
    const ghost = this.players.get(oldId);
    if (ghost === undefined || ghost.connected) return false;
    ghost.id = newId;
    ghost.name = name;
    ghost.connected = true;
    ghost.lastMsgAt = now;
    // rebuild the map so the re-bound entry keeps its exact join-order slot
    const entries = [...this.players.entries()];
    this.players.clear();
    for (const [key, p] of entries) this.players.set(key === oldId ? newId : key, p);
    return true;
  }

  /**
   * Round-boundary cleanup. A disconnected entry survives the round it dropped
   * in — that is what makes "disconnects holding a locked word: the word IS
   * scored" true (§2.1) — and dies here, at the next round start / match reset.
   */
  private purgeGhosts(): void {
    for (const p of [...this.players.values()]) {
      if (!p.connected) this.players.delete(p.id);
    }
  }

  // -------------------------------------------------------------------------
  // Timers — ONE slot, absolute deadlines live in the state, never a tick loop
  // -------------------------------------------------------------------------

  private setTimer(fn: () => void, ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      try {
        fn();
      } catch (err) {
        console.error('[wordbomb] timer failed', err);
      }
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Wire — the I1 boundary. Public is shared; private is per-recipient.
  // -------------------------------------------------------------------------

  /**
   * ONE object, sent byte-identically to every connected player. It has no
   * `you` and no word field, so this method cannot leak anything (I1).
   */
  private publicState(): WbPublicState {
    const players: WbPlayerState[] = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        // I1: whether they hold a valid word. Never the word, never its length.
        locked: p.word !== null,
      });
    }
    return {
      t: 'wb_public',
      code: this.code,
      phase: this.phase,
      round: this.round,
      rounds: this.settings.rounds,
      fragment: this.phase === 'live' || this.phase === 'reveal' ? this.fragment : null,
      fuseMinMs: FUSE_MIN_MS,
      fuseMaxMs: FUSE_MAX_MS,
      roundStartedAt: this.roundStartedAt,
      revealEndsAt: this.phase === 'reveal' ? this.revealEndsAt : 0,
      countdownEndsAt: this.countdownEndsAt,
      matchEndsAt: this.phase === 'matchEnd' ? this.matchEndsAt : 0,
      difficulty: this.settings.difficulty,
      players,
      winnerId: this.winnerId,
      // The manual-start lobby. `canStart` is computed from the SAME predicate
      // `wb_start` is judged by, so an enabled button and an accepted press can
      // never disagree.
      seated: this.playerCount(),
      minPlayers: MIN_PLAYERS,
      canStart: this.startAllowed(),
    };
  }

  /** Unicast only. The single message shape that may carry a word. */
  private privateFor(p: Player): WbPrivate {
    return {
      t: 'wb_private',
      you: p.id,
      yourWord: p.word,
      submitsLeft: p.eligible ? Math.max(0, MAX_SUBMITS_PER_ROUND - p.submits) : 0,
    };
  }

  private broadcastPublic(): void {
    const msg = this.publicState();
    for (const p of this.players.values()) {
      if (p.connected) this.io.send(p.id, msg);
    }
  }

  private sendPrivate(p: Player): void {
    if (!p.connected) return;
    this.io.send(p.id, this.privateFor(p));
  }

  /** Public snapshot to everyone, then each player's own private snapshot. */
  private broadcastState(): void {
    this.broadcastPublic();
    for (const p of this.players.values()) {
      if (p.connected) this.io.send(p.id, this.privateFor(p));
    }
  }

  // one shared message object per event: Session.send JSON-encodes synchronously
  private broadcastEvent(ev: WbEvent): void {
    const msg = { t: 'event', ev };
    for (const p of this.players.values()) {
      if (p.connected) this.io.send(p.id, msg);
    }
  }

  /** I1: a rejection reason is the submitter's business and nobody else's. */
  private sendReject(p: Player, reason: WbRejectReason): void {
    this.io.send(p.id, { t: 'event', ev: { t: 'wb_reject', reason } });
  }
}
