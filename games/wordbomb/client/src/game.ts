// ============================================================================
// WORDBOMB client — connection, lobby flow, merged state store, all rendering,
// and the frozen debug surface. Mirrors games/bank/client/src/game.ts in
// structure. Lobby protocol: platform/shared/src/protocol.ts (every create/join
// carries game:'wordbomb'; the room list is filtered to it). Room protocol and
// tuning come from the frozen @wordbomb/shared contract.
//
// THE SHAPE OF THIS FILE IS DICTATED BY I1 (docs/WORDBOMB.md §2).
// Server state arrives as TWO independent messages that are merged here and
// nowhere else:
//   wb_public  — broadcast, identical to everyone, CANNOT carry a word
//   wb_private — unicast, carries only THIS client's own `yourWord`
// They arrive in either order and either may arrive alone; every render path
// tolerates one being null. The client never learns another player's word,
// length, or validity before `wb_boom`, and never asks: there is no message it
// could send that would answer the question.
//
// Two consequences that look like omissions but are the contract:
//   * THE FUSE BAR IS DRAWN FROM `roundStartedAt + fuseMaxMs` ONLY. The real
//     fuse is uniform in [fuseMinMs, fuseMaxMs] and is never sent. The bar
//     therefore shows a WINDOW: a "cannot blow yet" zone up to fuseMinMs, then
//     an "any moment now" zone. Inferring the real value is not possible and is
//     not attempted — the uncertainty IS the game.
//   * THE SCORE PREVIEW IS `scoreWord(word, 1)` AND IS LABELLED A MAXIMUM.
//     `dupes` is unknowable before the boom by construction of I1, so the
//     preview says "up to 108 — if nobody else finds it". Asking the server for
//     a live dupe count would be a fatal I1 breach.
//
// ============================================================================
// CLASS LIST — FROZEN FOR W6 (style.css). W5 owns these names; W6 styles them.
// This block is the entire coupling between the two tasks.
//
// screens / chrome
//   .screen  .menu  .table  .hidden
//   .error-banner                       (emitted by main.ts, listed for W6)
//
// menu
//   .menu-title  .menu-sub  .menu-notice
//   .menu-name                          <input> display name
//   .menu-options  .menu-option  .menu-option-label
//   .menu-select                        <select> difficulty / rounds
//   .menu-actions  .menu-code  .menu-code-input
//   .btn  .btn-primary  .btn-small
//   .menu-rooms-title  .menu-rooms
//   .room-row  .room-row--joinable  .room-title  .room-label  .room-meta
//   .room-empty
//   .menu-rules  .menu-rule
//
// table chrome
//   .table-top  .table-round  .table-difficulty
//   .table-invite  .table-invite-code
//   .table-stage  .stage-main  .stage-side
//
// THE LOBBY — no game auto-starts, so this is a real screen, not a spinner.
// It is the FIRST child of `.stage-main` and is the only visible thing there
// while `phase === 'lobby'` (`.bomb`, `.answer-form` and `.answer-meta` are
// hidden). `--seat` is set on `.lobby-seat` exactly as on `.player-chip`.
//   .lobby  .lobby-head  .lobby-title
//   .lobby-count  .lobby-count-value  .lobby-count-min
//   .lobby-settings  .lobby-setting  .lobby-setting-label  .lobby-setting-value
//   .lobby-seats  .lobby-seat  .lobby-seat--you  .lobby-seat--empty
//   .lobby-seat-avatar  .lobby-seat-name  .lobby-seat-you  .lobby-seat-state
//   .lobby-start  .lobby-reason
//
// the bomb + the prompt
//   .bomb  .bomb--idle  .bomb--live  .bomb--armed  .bomb--boom
//   .bomb-label  .fragment  .fragment-letter  .fragment-hint
//
// the fuse (drawn from roundStartedAt + fuseMaxMs — never the real fuse)
//   .fuse  .fuse-track  .fuse-fill  .fuse-fill--danger  .fuse-mark  .fuse-label
//
// the answer input
//   .answer-form  .answer-input  .answer-input--ok  .answer-input--warn
//   .answer-meta  .answer-max  .answer-max-value  .answer-max-label
//   .answer-status  .answer-status--locked  .answer-status--rejected
//   .answer-locked  .answer-locked-word  .submits-left
//
// the player rail (locked = the ENTIRE amount other players may know)
//   .player-rail  .player-chip  .player-chip--you  .player-chip--locked
//   .player-chip--offline
//   .player-avatar  .player-name  .player-you  .player-score  .player-lock
//   .player-state  .player-delta
//
// THE REVEAL — the payoff. Every answer at once; collisions share a box.
//   .reveal  .reveal-title  .reveal-fragment  .reveal-groups
//   .reveal-group  .reveal-group--unique  .reveal-group--split
//   .reveal-group--none
//   .reveal-word  .reveal-word-mark  .reveal-badge  .reveal-points
//   .reveal-players  .reveal-player  .reveal-player--you
//   .reveal-player-name  .reveal-player-points  .reveal-empty
//
// standings / banner / log
//   .standings  .standings-title  .standings-row  .standings-row--you
//   .standings-row--winner  .standings-rank  .standings-name  .standings-score
//   .table-banner  .banner-main  .banner-sub  .banner--win  .banner--lose
//   .log-panel  .log-title  .event-log  .log-line
//   .log-kind-lock  .log-kind-boom  .log-kind-reject  .log-kind-join
//
// Seat colour is passed as the custom property `--seat` on `.player-chip`,
// `.reveal-player` and `.standings-row`, set to `var(--p1)` … `var(--p8)`.
// No hex appears in this file — every colour is a CSS custom property that
// W6 declares from WPAL.
// ============================================================================
import {
  DEFAULT_SETTINGS,
  DIFFICULTIES,
  MAX_SUBMITS_PER_ROUND,
  MAX_WORD_LEN,
  // MIN_PLAYERS is deliberately NOT imported: the threshold arrives on the wire
  // as `minPlayers`, so the lobby cannot disagree with the server that enforces it.
  MIN_WORD_LEN,
  ROUNDS_MAX,
  ROUNDS_MIN,
  scoreWord,
} from '@wordbomb/shared';
import type {
  WbAnswer,
  WbC2S,
  WbDifficulty,
  WbEvent,
  WbPhase,
  WbPlayerState,
  WbPrivate,
  WbPublicState,
  WbRejectReason,
  WbStanding,
  WordbombSettings,
} from '@wordbomb/shared';
import type { LobbyC2S, RoomInfo } from '@platform/shared';
import { cleanName, clearSession, loadName, loadSession, loadSig, NAME_MAX, saveName, saveSession } from '@platform/shared';

// ---- wire parsing (platform style: invalid => null, never throw) -------------
type LobbyMsg =
  | { t: 'welcome'; playerId: string }
  | { t: 'room_list'; rooms: RoomInfo[] }
  | { t: 'pong'; ts: number; serverTime: number }
  | { t: 'error'; code: string; message: string };

type S2C = LobbyMsg | WbPublicState | WbPrivate | WbEvent;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function str(v: unknown): v is string {
  return typeof v === 'string';
}
function bool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}
function phaseOf(v: unknown): WbPhase | null {
  return v === 'lobby' || v === 'live' || v === 'reveal' || v === 'matchEnd' ? v : null;
}
function difficultyOf(v: unknown): WbDifficulty | null {
  return v === 'easy' || v === 'normal' || v === 'hard' ? v : null;
}
function rejectReasonOf(v: unknown): WbRejectReason | null {
  switch (v) {
    case 'not_live':
    case 'too_fast':
    case 'bad_chars':
    case 'too_short':
    case 'too_long':
    case 'missing_fragment':
    case 'not_a_word':
    case 'already_used':
      return v;
    default:
      return null;
  }
}

function parsePlayer(v: unknown): WbPlayerState | null {
  if (!isObj(v) || !str(v.id) || !str(v.name) || !num(v.score)) return null;
  if (!bool(v.connected) || !bool(v.locked)) return null;
  return { id: v.id, name: v.name, score: v.score, connected: v.connected, locked: v.locked };
}

function parseAnswer(v: unknown): WbAnswer | null {
  if (!isObj(v) || !str(v.playerId) || !str(v.name)) return null;
  if (!(str(v.word) || v.word === null)) return null;
  if (!num(v.dupes) || !num(v.points)) return null;
  return { playerId: v.playerId, name: v.name, word: v.word, dupes: v.dupes, points: v.points };
}

function parseStanding(v: unknown): WbStanding | null {
  if (!isObj(v) || !str(v.playerId) || !str(v.name) || !num(v.score)) return null;
  return { playerId: v.playerId, name: v.name, score: v.score };
}

function parseRoomInfo(v: unknown): RoomInfo | null {
  if (!isObj(v) || !str(v.id) || !str(v.game) || !str(v.label) || !str(v.phase)) return null;
  if (!(str(v.code) || v.code === null)) return null;
  if (!num(v.players) || !num(v.maxPlayers)) return null;
  if (v.visibility !== 'public' && v.visibility !== 'private') return null;
  return {
    id: v.id,
    code: v.code,
    game: v.game,
    label: v.label,
    players: v.players,
    maxPlayers: v.maxPlayers,
    phase: v.phase,
    visibility: v.visibility,
  };
}

function parsePublic(v: Record<string, unknown>): WbPublicState | null {
  const phase = phaseOf(v.phase);
  const difficulty = difficultyOf(v.difficulty);
  if (phase === null || difficulty === null) return null;
  if (!str(v.roomId)) return null; // §2.2 — always present, unlike `code`
  if (!(str(v.code) || v.code === null)) return null;
  if (!(str(v.fragment) || v.fragment === null)) return null;
  if (!(str(v.winnerId) || v.winnerId === null)) return null;
  if (!num(v.round) || !num(v.rounds)) return null;
  if (!num(v.fuseMinMs) || !num(v.fuseMaxMs)) return null;
  if (!num(v.roundStartedAt) || !num(v.revealEndsAt)) return null;
  if (!num(v.countdownEndsAt) || !num(v.matchEndsAt)) return null;
  // the manual-start lobby fields — required, so an old server is rejected
  // outright rather than rendering a START button whose state is a guess
  if (!num(v.seated) || !num(v.minPlayers) || !bool(v.canStart)) return null;
  if (!Array.isArray(v.players)) return null;
  const players: WbPlayerState[] = [];
  for (const raw of v.players) {
    const p = parsePlayer(raw);
    if (p === null) return null;
    players.push(p);
  }
  return {
    t: 'wb_public',
    code: v.code,
    roomId: v.roomId,
    phase,
    round: v.round,
    rounds: v.rounds,
    fragment: v.fragment,
    fuseMinMs: v.fuseMinMs,
    fuseMaxMs: v.fuseMaxMs,
    roundStartedAt: v.roundStartedAt,
    revealEndsAt: v.revealEndsAt,
    countdownEndsAt: v.countdownEndsAt,
    matchEndsAt: v.matchEndsAt,
    difficulty,
    players,
    winnerId: v.winnerId,
    seated: v.seated,
    minPlayers: v.minPlayers,
    canStart: v.canStart,
  };
}

function parsePrivate(v: Record<string, unknown>): WbPrivate | null {
  if (!str(v.you)) return null;
  if (!(str(v.yourWord) || v.yourWord === null)) return null;
  if (!num(v.submitsLeft)) return null;
  return { t: 'wb_private', you: v.you, yourWord: v.yourWord, submitsLeft: v.submitsLeft };
}

function parseS2C(raw: unknown): S2C | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'welcome':
      return str(raw.playerId) ? { t: 'welcome', playerId: raw.playerId } : null;
    case 'room_list': {
      if (!Array.isArray(raw.rooms)) return null;
      const rooms: RoomInfo[] = [];
      for (const r of raw.rooms) {
        const room = parseRoomInfo(r);
        if (room !== null) rooms.push(room);
      }
      return { t: 'room_list', rooms };
    }
    case 'pong':
      return num(raw.ts) && num(raw.serverTime)
        ? { t: 'pong', ts: raw.ts, serverTime: raw.serverTime }
        : null;
    case 'error':
      return str(raw.code) && str(raw.message)
        ? { t: 'error', code: raw.code, message: raw.message }
        : null;
    case 'wb_public':
      return parsePublic(raw);
    case 'wb_private':
      return parsePrivate(raw);
    case 'wb_locked':
      return str(raw.playerId) ? { t: 'wb_locked', playerId: raw.playerId } : null;
    case 'wb_reject': {
      const reason = rejectReasonOf(raw.reason);
      return reason === null ? null : { t: 'wb_reject', reason };
    }
    case 'wb_boom': {
      if (!str(raw.fragment) || !Array.isArray(raw.answers)) return null;
      const answers: WbAnswer[] = [];
      for (const a of raw.answers) {
        const answer = parseAnswer(a);
        if (answer === null) return null;
        answers.push(answer);
      }
      return { t: 'wb_boom', fragment: raw.fragment, answers };
    }
    case 'wb_match_end': {
      if (!(str(raw.winnerId) || raw.winnerId === null)) return null;
      if (!Array.isArray(raw.standings)) return null;
      const standings: WbStanding[] = [];
      for (const s of raw.standings) {
        const standing = parseStanding(s);
        if (standing === null) return null;
        standings.push(standing);
      }
      return { t: 'wb_match_end', winnerId: raw.winnerId, standings };
    }
    case 'event':
      // the server wraps game events as {t:'event', ev} (platform convention)
      return parseS2C(raw.ev);
    default:
      return null; // unknown envelope: drop, never throw on wire data
  }
}

// ---- frozen e2e surface (docs/WORDBOMB.md §4.3) -----------------------------
/** The merged public+private view — the one place the two messages meet. */
type WbMergedState = WbPublicState & { you: string; yourWord: string | null };

interface WordbombApi {
  /** Latest merged public+private view, or null before the first snapshot. */
  state(): WbMergedState | null;
  createPrivate(name: string, settings?: Partial<WordbombSettings>): void;
  joinPrivate(name: string, code: string): void;
  /**
   * Press START. Additive to the §4.3 surface, because no game auto-starts any
   * more and without it the e2e suite can never reach `phase === 'live'`.
   * Sends `{t:'wb_start'}` unconditionally — the SERVER is the only judge of
   * whether that is legal (I2), so this deliberately does not pre-check
   * `canStart`: the suite must be able to prove an illegal press is ignored.
   */
  start(): void;
  submit(word: string): void;
  /** Most recent rejection delivered to THIS client, or null. */
  lastReject(): WbRejectReason | null;
  /** Most recent reveal, or null. */
  lastBoom(): { fragment: string; answers: WbAnswer[] } | null;
  /** Every S2C message this client has received, for the I1 mirror assertion. */
  messageLog(): unknown[];
}

declare global {
  interface Window {
    __wordbomb?: WordbombApi;
  }
}

// ---- tuning ------------------------------------------------------------------
const RECONNECT_MS = 1000; // socket dropped -> back to the menu, retry quietly
const PING_EVERY_MS = 2000; // mirrors NET.pingEveryMs (platform protocol)
const ROOMS_EVERY_MS = 3000; // menu room-list poll
const TICK_MS = 100; // fuse bar + countdowns (setInterval: survives tab blur)
const LOG_MAX = 7;
const CODE_MAX = 8;
const LOW_SUBMITS = 5; // warn about the budget below this many left
const MSG_LOG_MAX = 4000; // messageLog() ring cap — a full match is far below this
const GAME = 'wordbomb'; // this client's GameModule.id — the @platform/shared session key

type LogKind = 'lock' | 'boom' | 'reject' | 'join';
interface LogEntry {
  text: string;
  kind: LogKind;
}

type BannerTone = 'none' | 'win' | 'lose';

/** One reveal box: every player who submitted this exact word. */
interface RevealGroup {
  word: string;
  dupes: number;
  points: number;
  answers: WbAnswer[];
}

const REJECT_TEXT: Record<WbRejectReason, string> = {
  not_live: 'no round running',
  too_fast: 'too fast — submission budget spent',
  bad_chars: 'letters only',
  too_short: `at least ${MIN_WORD_LEN} letters`,
  too_long: `at most ${MAX_WORD_LEN} letters`,
  missing_fragment: 'missing the fragment',
  not_a_word: 'not in the dictionary',
  already_used: 'you already scored that word',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// `cleanName` is imported from '@platform/shared' — NAME_MAX/'Player' now live
// there (identity.ts NAME_MAX/DEFAULT_NAME) as the platform-wide rule, not a
// per-game copy of the same two numbers.

/** Seat colour as a CSS custom-property reference — never a literal. */
function seatVar(index: number): string {
  return `var(--p${String((index % 8) + 1)})`;
}

function secondsLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

class WordbombGame {
  private ws: WebSocket | null = null;
  private welcomed = false;
  private playerId: string | null = null;
  private resumeToken: string | null = null;
  private roomCode: string | null = null; // code of the room we're in/joining, when known
  private roomId: string | null = null; // id of the room we're in/joining, when known (public rejoin)
  private offset = 0; // serverNow = Date.now() + offset

  // THE MERGE. Two independent messages; either may be null, either may arrive
  // first, and every render path below tolerates both cases.
  private pub: WbPublicState | null = null;
  private priv: WbPrivate | null = null;

  private rooms: RoomInfo[] = [];
  private screen: 'menu' | 'table' = 'menu';
  private pendingJoin: { name: string; code: string } | null = null;
  private copiedTimer = 0;

  private boom: { fragment: string; answers: WbAnswer[] } | null = null;
  private reject: WbRejectReason | null = null;
  private standings: WbStanding[] = [];
  private deltas = new Map<string, number>(); // playerId -> points from the last boom
  private lastRoundKey = ''; // `${round}:${roundStartedAt}` — round-change detector
  private lastPhase: WbPhase | null = null; // lobby-entry detector (see onLobbyEntry)
  private readonly msgLog: unknown[] = [];
  private readonly logLines: LogEntry[] = [];
  private bannerTone: BannerTone = 'none';

  // ---- DOM handles (built once, updated in place) ----------------------------
  private readonly menuEl: HTMLDivElement;
  private readonly tableEl: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly difficultySelect: HTMLSelectElement;
  private readonly roundsSelect: HTMLSelectElement;
  private readonly roomsEl: HTMLDivElement;
  private readonly menuButtons: HTMLButtonElement[] = [];

  private readonly roundEl: HTMLDivElement;
  private readonly difficultyEl: HTMLDivElement;
  private readonly inviteEl: HTMLDivElement;
  private readonly inviteCodeEl: HTMLSpanElement;
  private readonly copyBtn: HTMLButtonElement;

  private readonly lobbyEl: HTMLDivElement;
  private readonly lobbyCountValueEl: HTMLSpanElement;
  private readonly lobbyCountMinEl: HTMLSpanElement;
  private readonly lobbyDifficultyEl: HTMLSpanElement;
  private readonly lobbyRoundsEl: HTMLSpanElement;
  private readonly lobbySeatsEl: HTMLDivElement;
  private readonly lobbyStartBtn: HTMLButtonElement;
  private readonly lobbyReasonEl: HTMLDivElement;

  private readonly bombEl: HTMLDivElement;
  private readonly fragmentEl: HTMLDivElement;
  private readonly fragmentHintEl: HTMLDivElement;
  private readonly fuseFillEl: HTMLDivElement;
  private readonly fuseMarkEl: HTMLDivElement;
  private readonly fuseLabelEl: HTMLDivElement;

  private readonly answerFormEl: HTMLFormElement;
  private readonly answerMetaEl: HTMLDivElement;
  private readonly answerInput: HTMLInputElement;
  private readonly answerMaxEl: HTMLDivElement;
  private readonly answerMaxValueEl: HTMLSpanElement;
  private readonly answerMaxLabelEl: HTMLSpanElement;
  private readonly answerStatusEl: HTMLDivElement;
  private readonly lockedEl: HTMLDivElement;
  private readonly lockedWordEl: HTMLSpanElement;
  private readonly submitsLeftEl: HTMLDivElement;

  private readonly railEl: HTMLDivElement;
  private readonly revealEl: HTMLDivElement;
  private readonly revealFragmentEl: HTMLSpanElement;
  private readonly revealGroupsEl: HTMLDivElement;
  private readonly standingsEl: HTMLDivElement;
  private readonly logEl: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly bannerMainEl: HTMLDivElement;
  private readonly bannerSubEl: HTMLDivElement;

  constructor(root: HTMLElement) {
    // ---- menu screen ---------------------------------------------------------
    this.menuEl = el('div', 'screen menu');
    this.menuEl.appendChild(el('h1', 'menu-title', 'WORDBOMB'));
    this.menuEl.appendChild(el('p', 'menu-sub', 'same fragment · hidden fuse · everyone revealed at once'));
    this.noticeEl = el('div', 'menu-notice hidden');
    this.menuEl.appendChild(this.noticeEl);

    this.nameInput = el('input', 'menu-name');
    this.nameInput.maxLength = NAME_MAX;
    this.nameInput.placeholder = 'your name';
    this.nameInput.autocomplete = 'off';
    this.menuEl.appendChild(this.nameInput);

    // Room settings for the CREATE flows. Zero inline styling: `.menu-options`
    // and its children are styled entirely from style.css.
    const options = el('div', 'menu-options');

    const diffOption = el('label', 'menu-option');
    diffOption.appendChild(el('span', 'menu-option-label', 'difficulty'));
    this.difficultySelect = el('select', 'menu-select');
    for (const d of DIFFICULTIES) {
      const opt = el('option', undefined, d);
      opt.value = d;
      this.difficultySelect.appendChild(opt);
    }
    this.difficultySelect.value = DEFAULT_SETTINGS.difficulty; // 'normal' — hard is never defaulted to
    diffOption.appendChild(this.difficultySelect);
    options.appendChild(diffOption);

    const roundsOption = el('label', 'menu-option');
    roundsOption.appendChild(el('span', 'menu-option-label', 'rounds'));
    this.roundsSelect = el('select', 'menu-select');
    for (const n of [ROUNDS_MIN, 10, 15, ROUNDS_MAX]) {
      const opt = el('option', undefined, `${String(n)} rounds`);
      opt.value = String(n);
      this.roundsSelect.appendChild(opt);
    }
    this.roundsSelect.value = String(DEFAULT_SETTINGS.rounds);
    roundsOption.appendChild(this.roundsSelect);
    options.appendChild(roundsOption);
    this.menuEl.appendChild(options);

    const menuActions = el('div', 'menu-actions');
    this.menuButtons.push(
      this.menuButton(menuActions, 'QUICK JOIN', 'btn btn-primary', () => this.joinQuick(this.menuName())),
      this.menuButton(menuActions, 'CREATE PUBLIC', 'btn', () => this.createPublic(this.menuName())),
      this.menuButton(menuActions, 'CREATE PRIVATE', 'btn', () => this.createPrivate(this.menuName())),
    );
    this.menuEl.appendChild(menuActions);

    const codeRow = el('div', 'menu-code');
    this.codeInput = el('input', 'menu-code-input');
    this.codeInput.maxLength = CODE_MAX;
    this.codeInput.placeholder = 'CODE';
    this.codeInput.autocomplete = 'off';
    codeRow.appendChild(this.codeInput);
    this.menuButtons.push(
      this.menuButton(codeRow, 'JOIN', 'btn', () =>
        this.joinPrivate(this.menuName(), this.codeInput.value.trim()),
      ),
    );
    this.menuEl.appendChild(codeRow);

    const rules = el('div', 'menu-rules');
    for (const line of [
      'Type any word containing the three-letter fragment.',
      'Enter locks it in. Re-lock as often as you like — your last valid word stands.',
      'The fuse length is hidden. Everyone is revealed at the same instant.',
      'Sharing a word splits the points. Alone is worth far more.',
    ]) {
      rules.appendChild(el('p', 'menu-rule', line));
    }
    this.menuEl.appendChild(rules);

    this.menuEl.appendChild(el('h2', 'menu-rooms-title', 'ROOMS'));
    this.roomsEl = el('div', 'menu-rooms');
    this.menuEl.appendChild(this.roomsEl);

    // ---- table screen --------------------------------------------------------
    this.tableEl = el('div', 'screen table hidden');
    const topBar = el('div', 'table-top');
    this.roundEl = el('div', 'table-round', 'ROUND 0/0');
    topBar.appendChild(this.roundEl);
    this.difficultyEl = el('div', 'table-difficulty', '');
    topBar.appendChild(this.difficultyEl);
    this.inviteEl = el('div', 'table-invite hidden');
    this.inviteCodeEl = el('span', 'table-invite-code');
    this.inviteEl.appendChild(this.inviteCodeEl);
    this.copyBtn = el('button', 'btn btn-small', 'COPY INVITE');
    this.copyBtn.addEventListener('click', () => this.copyInvite());
    this.inviteEl.appendChild(this.copyBtn);
    topBar.appendChild(this.inviteEl);
    const leaveBtn = el('button', 'btn btn-small', 'LEAVE');
    leaveBtn.addEventListener('click', () => this.leaveToMenu(''));
    topBar.appendChild(leaveBtn);
    this.tableEl.appendChild(topBar);

    // stage: two columns — the bomb/input/rail on the left, the log beside it.
    const stage = el('div', 'table-stage');
    const stageMain = el('div', 'stage-main');
    const stageSide = el('aside', 'stage-side');

    // ---- THE LOBBY ----------------------------------------------------------
    // Nothing auto-starts, so the wait is a screen with a decision on it, not a
    // spinner: who is here, how many are still needed, what you are about to
    // play, and one button. The button's enabled state is `s.canStart` and
    // NOTHING ELSE — the server computes it from the same predicate it judges
    // `wb_start` by, so the UI cannot promise a start the server would refuse.
    this.lobbyEl = el('div', 'lobby hidden');
    const lobbyHead = el('div', 'lobby-head');
    lobbyHead.appendChild(el('div', 'lobby-title', 'LOBBY'));
    const lobbyCount = el('div', 'lobby-count');
    this.lobbyCountValueEl = el('span', 'lobby-count-value', '0');
    this.lobbyCountMinEl = el('span', 'lobby-count-min', '');
    lobbyCount.appendChild(this.lobbyCountValueEl);
    lobbyCount.appendChild(this.lobbyCountMinEl);
    lobbyHead.appendChild(lobbyCount);
    this.lobbyEl.appendChild(lobbyHead);

    const lobbySettings = el('div', 'lobby-settings');
    const diffSetting = el('div', 'lobby-setting');
    diffSetting.appendChild(el('span', 'lobby-setting-label', 'DIFFICULTY'));
    this.lobbyDifficultyEl = el('span', 'lobby-setting-value', '');
    diffSetting.appendChild(this.lobbyDifficultyEl);
    lobbySettings.appendChild(diffSetting);
    const roundsSetting = el('div', 'lobby-setting');
    roundsSetting.appendChild(el('span', 'lobby-setting-label', 'ROUNDS'));
    this.lobbyRoundsEl = el('span', 'lobby-setting-value', '');
    roundsSetting.appendChild(this.lobbyRoundsEl);
    lobbySettings.appendChild(roundsSetting);
    this.lobbyEl.appendChild(lobbySettings);

    this.lobbySeatsEl = el('div', 'lobby-seats');
    this.lobbyEl.appendChild(this.lobbySeatsEl);

    this.lobbyStartBtn = el('button', 'btn btn-primary lobby-start', 'START MATCH');
    this.lobbyStartBtn.type = 'button';
    this.lobbyStartBtn.addEventListener('click', () => this.pressStart());
    this.lobbyEl.appendChild(this.lobbyStartBtn);
    // The reason is never colour-only: a disabled button ALWAYS has words under
    // it saying what is missing.
    this.lobbyReasonEl = el('div', 'lobby-reason', '');
    this.lobbyEl.appendChild(this.lobbyReasonEl);
    stageMain.appendChild(this.lobbyEl);

    // ---- the bomb: fragment + fuse ------------------------------------------
    this.bombEl = el('div', 'bomb bomb--idle');
    this.bombEl.appendChild(el('div', 'bomb-label', 'YOUR WORD MUST CONTAIN'));
    this.fragmentEl = el('div', 'fragment');
    this.bombEl.appendChild(this.fragmentEl);
    this.fragmentHintEl = el('div', 'fragment-hint', '');
    this.bombEl.appendChild(this.fragmentHintEl);

    const fuse = el('div', 'fuse');
    const fuseTrack = el('div', 'fuse-track');
    this.fuseFillEl = el('div', 'fuse-fill');
    fuseTrack.appendChild(this.fuseFillEl);
    // The mark sits where the bar will be when `fuseMinMs` has elapsed: to the
    // LEFT of it the bomb cannot possibly blow; to the right it can, at any
    // instant. That is the whole of what the client honestly knows.
    this.fuseMarkEl = el('div', 'fuse-mark');
    this.fuseMarkEl.setAttribute('aria-hidden', 'true');
    fuseTrack.appendChild(this.fuseMarkEl);
    fuse.appendChild(fuseTrack);
    this.fuseLabelEl = el('div', 'fuse-label', '');
    fuse.appendChild(this.fuseLabelEl);
    this.bombEl.appendChild(fuse);
    stageMain.appendChild(this.bombEl);

    // ---- the answer input ----------------------------------------------------
    const form = el('form', 'answer-form');
    this.answerFormEl = form;
    this.answerInput = el('input', 'answer-input');
    this.answerInput.maxLength = MAX_WORD_LEN;
    this.answerInput.placeholder = 'type a word · Enter to lock';
    this.answerInput.autocomplete = 'off';
    this.answerInput.autocapitalize = 'off';
    this.answerInput.spellcheck = false;
    this.answerInput.addEventListener('input', () => this.renderAnswerMeta());
    form.addEventListener('submit', (ev: SubmitEvent) => {
      ev.preventDefault(); // Enter submits; the page must never navigate
      this.submitTyped();
    });
    form.appendChild(this.answerInput);
    const submitBtn = el('button', 'btn btn-primary', 'LOCK IN');
    submitBtn.type = 'submit';
    form.appendChild(submitBtn);
    stageMain.appendChild(form);

    const meta = el('div', 'answer-meta');
    this.answerMetaEl = meta;
    this.answerMaxEl = el('div', 'answer-max');
    this.answerMaxValueEl = el('span', 'answer-max-value', '');
    this.answerMaxLabelEl = el('span', 'answer-max-label', '');
    this.answerMaxEl.appendChild(this.answerMaxValueEl);
    this.answerMaxEl.appendChild(this.answerMaxLabelEl);
    meta.appendChild(this.answerMaxEl);
    this.answerStatusEl = el('div', 'answer-status', '');
    meta.appendChild(this.answerStatusEl);
    this.submitsLeftEl = el('div', 'submits-left hidden', '');
    meta.appendChild(this.submitsLeftEl);
    stageMain.appendChild(meta);

    this.lockedEl = el('div', 'answer-locked hidden');
    this.lockedEl.appendChild(el('span', undefined, 'LOCKED'));
    this.lockedWordEl = el('span', 'answer-locked-word', '');
    this.lockedEl.appendChild(this.lockedWordEl);
    stageMain.appendChild(this.lockedEl);

    // ---- the reveal (hidden until the bomb goes off) -------------------------
    this.revealEl = el('div', 'reveal hidden');
    const revealTitle = el('div', 'reveal-title', 'BOOM · ');
    this.revealFragmentEl = el('span', 'reveal-fragment', '');
    revealTitle.appendChild(this.revealFragmentEl);
    this.revealEl.appendChild(revealTitle);
    this.revealGroupsEl = el('div', 'reveal-groups');
    this.revealEl.appendChild(this.revealGroupsEl);
    stageMain.appendChild(this.revealEl);

    this.railEl = el('div', 'player-rail');
    stageMain.appendChild(this.railEl);
    stage.appendChild(stageMain);

    this.standingsEl = el('div', 'standings hidden');
    stageSide.appendChild(this.standingsEl);
    const logPanel = el('div', 'log-panel');
    logPanel.appendChild(el('div', 'log-title', 'ROUND LOG'));
    this.logEl = el('div', 'event-log');
    logPanel.appendChild(this.logEl);
    stageSide.appendChild(logPanel);
    stage.appendChild(stageSide);

    this.bannerEl = el('div', 'table-banner hidden');
    // Text-only overlay: it must never intercept clicks (invite chip, LEAVE,
    // and above all the answer input). This is the one inline style the table
    // keeps, deliberately.
    this.bannerEl.style.pointerEvents = 'none';
    this.bannerMainEl = el('div', 'banner-main');
    this.bannerEl.appendChild(this.bannerMainEl);
    this.bannerSubEl = el('div', 'banner-sub');
    this.bannerEl.appendChild(this.bannerSubEl);
    stage.appendChild(this.bannerEl);

    this.tableEl.appendChild(stage);

    root.appendChild(this.menuEl);
    root.appendChild(this.tableEl);

    // ---- timers (setInterval everywhere: rAF pauses in background tabs) ------
    window.setInterval(() => this.tick(), TICK_MS);
    window.setInterval(() => {
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
        this.send({ t: 'ping', ts: performance.now() });
      }
    }, PING_EVERY_MS);
    window.setInterval(() => {
      if (this.screen === 'menu' && this.welcomed) this.send({ t: 'list_rooms' });
    }, ROOMS_EVERY_MS);

    // ---- frozen e2e debug surface (docs/WORDBOMB.md §4.3) --------------------
    window.__wordbomb = {
      state: () => this.mergedState(),
      createPrivate: (name, settings) => this.createPrivate(name, settings),
      joinPrivate: (name, code) => this.joinPrivate(name, code),
      start: () => this.pressStart(),
      submit: (word) => this.submit(word),
      lastReject: () => this.reject,
      lastBoom: () => (this.boom === null ? null : { fragment: this.boom.fragment, answers: this.boom.answers.map((a) => ({ ...a })) }),
      messageLog: () => this.msgLog.slice(),
    };

    // ---- shared name + rejoin record (I8: restores score + yourWord to us alone) --
    this.nameInput.value = loadName(); // may be '' — the placeholder covers that (§3)
    this.loadSessionRecord();
    if (this.roomCode !== null) this.codeInput.value = this.roomCode;

    // ---- invite link (?code=XXXXX): prefill + auto-join, then strip the param -
    // Takes priority over the stored session below — an explicit shared link is
    // a stronger signal than "wherever I happened to be last".
    const linkCode = new URLSearchParams(location.search).get('code');
    if (linkCode !== null && linkCode.length > 0) {
      history.replaceState(null, '', location.pathname + location.hash);
      this.codeInput.value = linkCode;
      const name = loadName();
      if (name !== '') this.pendingJoin = { name, code: linkCode };
    }

    this.connect();
    this.renderMenu();
  }

  // ---- connection ------------------------------------------------------------
  private connect(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(ev.data) as unknown;
      } catch {
        return; // malformed frame: drop, never throw
      }
      // Log the RAW decoded frame, before any parsing: §8.2 assertion 3 proves
      // from the browser that B never received A's word, and it can only prove
      // that over the unfiltered stream.
      this.msgLog.push(decoded);
      if (this.msgLog.length > MSG_LOG_MAX) this.msgLog.shift();
      const msg = parseS2C(decoded);
      if (msg !== null) this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // stale socket from a previous connect()
      this.ws = null;
      const wasAtTable = this.screen === 'table';
      this.welcomed = false;
      this.pub = null;
      this.priv = null;
      this.showMenu(wasAtTable ? 'Connection lost — rejoining…' : '');
      window.setTimeout(() => this.connect(), RECONNECT_MS);
    };
    ws.onerror = () => {
      // the close event follows and does the teardown
    };
  }

  /** No-op unless the socket is open (mirrors the server's Session.send). */
  private send(msg: LobbyC2S | WbC2S): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // racing a close — drop the frame
    }
  }

  private serverNow(): number {
    return Date.now() + this.offset;
  }

  // ---- rejoin record (@platform/shared SessionRecord, keyed by GAME) ---------
  /** Pull the stored pointer into memory. Absent/corrupt/blocked -> no-op (play without rejoin). */
  private loadSessionRecord(): void {
    const rec = loadSession(GAME);
    if (rec === null) return;
    this.resumeToken = rec.playerId;
    this.roomId = rec.roomId;
    this.roomCode = rec.code;
  }

  /** Write the CURRENT pointer. No-op before `welcome` (no playerId to anchor it to). */
  private persistSession(): void {
    if (this.playerId === null) return;
    saveSession(GAME, { playerId: this.playerId, roomId: this.roomId, code: this.roomCode });
  }

  /** Explicit leave ONLY (§3) — never call this on a socket drop. */
  private clearSessionRecord(): void {
    this.resumeToken = null;
    this.roomId = null;
    this.roomCode = null;
    clearSession(GAME);
  }

  /**
   * Stamp `resume` (this connection's chain, when we have one) and `sig`
   * (ALWAYS — the durable fallback the server rebinds by when `resume`
   * misses, contract §2.3) on an outgoing join message. The five join sites
   * below used to each repeat the `resume` line individually; adding a
   * second repeated `sig` line to every one of them would drift the moment
   * only four of five got updated. One helper instead.
   */
  private stampIdentity<T extends { resume?: string; sig?: string }>(msg: T): void {
    if (this.resumeToken !== null) msg.resume = this.resumeToken;
    msg.sig = loadSig();
  }

  // ---- lobby actions (game:'wordbomb' on every create/join) -------------------
  /** The create-section settings, with an optional e2e override layered on top. */
  private menuSettings(override?: Partial<WordbombSettings>): WordbombSettings {
    const parsedRounds = Number.parseInt(this.roundsSelect.value, 10);
    const menuRounds = Number.isInteger(parsedRounds) ? parsedRounds : DEFAULT_SETTINGS.rounds;
    const menuDifficulty = difficultyOf(this.difficultySelect.value) ?? DEFAULT_SETTINGS.difficulty;
    const rounds = override?.rounds ?? menuRounds;
    const difficulty = override?.difficulty ?? menuDifficulty;
    return {
      rounds: Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, Math.trunc(rounds))),
      difficulty,
    };
  }

  private joinQuick(name: string): void {
    const msg: Extract<LobbyC2S, { t: 'quick_join' }> = {
      t: 'quick_join',
      name: cleanName(name),
      game: 'wordbomb',
    };
    this.stampIdentity(msg);
    this.roomCode = null;
    this.roomId = null; // unknown until the first wb_public names it
    saveName(msg.name);
    this.send(msg);
  }

  private createPublic(name: string, settings?: Partial<WordbombSettings>): void {
    const s = this.menuSettings(settings);
    const msg: Extract<LobbyC2S, { t: 'create_public' }> = {
      t: 'create_public',
      name: cleanName(name),
      game: 'wordbomb',
      settings: { rounds: s.rounds, difficulty: s.difficulty },
    };
    this.stampIdentity(msg);
    this.roomCode = null;
    this.roomId = null; // server-generated; arrives on the first wb_public
    saveName(msg.name);
    this.send(msg);
  }

  private createPrivate(name: string, settings?: Partial<WordbombSettings>): void {
    const s = this.menuSettings(settings);
    const msg: Extract<LobbyC2S, { t: 'create_private' }> = {
      t: 'create_private',
      name: cleanName(name),
      game: 'wordbomb',
      settings: { rounds: s.rounds, difficulty: s.difficulty },
    };
    this.stampIdentity(msg);
    this.roomCode = null; // server-generated; arrives on the first wb_public
    this.roomId = null; // ditto
    saveName(msg.name);
    this.send(msg);
  }

  private joinPublic(name: string, roomId: string): void {
    const msg: Extract<LobbyC2S, { t: 'join_public' }> = {
      t: 'join_public',
      name: cleanName(name),
      roomId,
    };
    this.stampIdentity(msg);
    this.roomCode = null;
    this.roomId = roomId; // candidate; a 'no_room' error clears it again
    saveName(msg.name);
    this.send(msg);
  }

  private joinPrivate(name: string, code: string): void {
    const c = code.length > 0 ? code : (this.roomCode ?? '');
    if (c.length === 0) {
      this.setNotice('enter a room code first');
      return;
    }
    const msg: Extract<LobbyC2S, { t: 'join_private' }> = {
      t: 'join_private',
      name: cleanName(name),
      code: c,
    };
    this.stampIdentity(msg);
    this.roomCode = c; // candidate; a 'no_room' error clears it again
    this.roomId = null; // unknown until the first wb_public names it
    saveName(msg.name);
    this.send(msg);
  }

  /**
   * §3 AUTO-REJOIN — fires on every `welcome`, which covers BOTH boot and
   * reconnect (a dropped socket reconnects and gets a fresh `welcome` too).
   * A stored SessionRecord means some room is waiting for us: re-enter it
   * without the player clicking anything, preferring the exact room over a
   * random one. `code` before `roomId` mirrors the server's own §2.3 order
   * (resume before sig) — the cheaper, more specific pointer wins.
   */
  private autoRejoin(): void {
    const rec = loadSession(GAME);
    if (rec === null) return;
    const name = cleanName(loadName());
    if (rec.code !== null) this.joinPrivate(name, rec.code);
    else if (rec.roomId !== null) this.joinPublic(name, rec.roomId);
    else this.joinQuick(name); // a record with neither pointer: get back in SOME room
  }

  /** The entire client->server room surface (docs/WORDBOMB.md §4.1). */
  private submit(word: string): void {
    this.send({ t: 'wb_submit', word });
  }

  /**
   * THE MANUAL START. Sent unconditionally — the server is the only judge (I2)
   * and ignores an illegal press in silence, so there is no local gate here to
   * drift out of step with `canStart`. The button's `disabled` state is a
   * courtesy to the player, never the enforcement.
   */
  private pressStart(): void {
    this.send({ t: 'wb_start' });
  }

  /** Enter / LOCK IN: send exactly what is typed; the SERVER is the only judge (I2). */
  private submitTyped(): void {
    const word = this.answerInput.value.trim().toLowerCase();
    if (word.length === 0) return;
    this.submit(word);
  }

  // ---- message routing -------------------------------------------------------
  private onMessage(msg: S2C): void {
    switch (msg.t) {
      case 'welcome':
        this.playerId = msg.playerId;
        this.welcomed = true;
        // roll the fresh session id into the stored pointer NOW, so a reload
        // that lands before we ever rejoin still has a resume candidate (the
        // "repeated reconnects" case — see @platform/shared SessionRecord).
        this.persistSession();
        this.send({ t: 'list_rooms' });
        this.setNotice('');
        this.renderMenu();
        if (this.pendingJoin !== null) {
          const { name, code } = this.pendingJoin;
          this.pendingJoin = null; // single attempt — on failure the notice shows
          this.joinPrivate(name, code);
        } else {
          this.autoRejoin(); // boot AND reconnect alike: same event, same pointer
        }
        break;
      case 'room_list':
        this.rooms = msg.rooms.filter((r) => r.game === 'wordbomb');
        if (this.screen === 'menu') this.renderRooms();
        break;
      case 'pong': {
        const rtt = performance.now() - msg.ts;
        if (rtt >= 0) this.offset = msg.serverTime + rtt / 2 - Date.now();
        break;
      }
      case 'error':
        if (msg.code === 'no_room' && (this.roomCode !== null || this.roomId !== null)) {
          // the candidate pointer we just tried was stale — drop both; only
          // one of the two is ever a live candidate at a time (see the join
          // methods above), so clearing the pair is exact, not a guess.
          this.roomCode = null;
          this.roomId = null;
          this.persistSession();
        }
        this.setNotice(msg.message);
        break;
      case 'wb_public':
        this.onPublic(msg);
        break;
      case 'wb_private':
        this.onPrivate(msg);
        break;
      case 'wb_locked':
        // Carries a playerId and NOTHING else (I1). At most once per player per
        // round, so the log line is a fact, not a cadence side channel.
        this.pushLog(`${this.nameOf(msg.playerId)} locked in`, 'lock');
        break;
      case 'wb_reject':
        this.reject = msg.reason;
        this.pushLog(`rejected — ${REJECT_TEXT[msg.reason]}`, 'reject');
        this.renderAnswerMeta();
        break;
      case 'wb_boom':
        this.onBoom(msg);
        break;
      case 'wb_match_end':
        this.onMatchEnd(msg);
        break;
    }
  }

  private onPublic(s: WbPublicState): void {
    const first = this.pub === null;
    this.pub = s;
    // `roomId` is always present (§2.2 — it's what makes a PUBLIC room
    // reload findable at all, since public rooms have no code); `code` stays
    // null for them.
    if (s.roomId !== this.roomId || s.code !== this.roomCode) {
      this.roomId = s.roomId;
      this.roomCode = s.code;
      this.persistSession();
    }
    if (first) {
      this.showTable();
      this.pushLog('You joined the room', 'join');
      if (this.playerId !== null) {
        // joined: the CURRENT session id becomes the valid rejoin token (I8)
        this.resumeToken = this.playerId;
        this.persistSession();
      }
    }
    this.onLobbyEntry(s);
    this.onRoundBoundary(s);
    this.renderTable();
  }

  /**
   * Entering `lobby` from anywhere else. Now that a finished match returns here
   * and WAITS instead of rolling straight into the next one, this transition is
   * something a player actually sits in — so the previous match's reveal,
   * standings, deltas and round log are cleared rather than left hanging behind
   * the START button. `onRoundBoundary` cannot do this: it only fires for
   * `live`, which is exactly the phase the room is no longer going to.
   */
  private onLobbyEntry(s: WbPublicState): void {
    const wasLobby = this.lastPhase === 'lobby';
    this.lastPhase = s.phase;
    if (s.phase !== 'lobby' || wasLobby) return;
    this.boom = null;
    this.reject = null;
    this.standings = [];
    this.deltas.clear();
    this.answerInput.value = '';
    this.bannerTone = 'none';
    this.logLines.length = 0;
    this.renderLog();
  }

  private onPrivate(p: WbPrivate): void {
    const prev = this.priv?.yourWord ?? null;
    this.priv = p;
    if (p.yourWord !== null && p.yourWord !== prev) {
      this.reject = null; // an accepted word supersedes the last rejection
      this.pushLog(`you locked "${p.yourWord}"`, 'lock');
    }
    if (this.pub === null && this.screen === 'menu') {
      // private arrived first: nothing to draw yet, but the merge is already
      // live — the very next wb_public renders with `yourWord` in place.
      return;
    }
    this.renderTable();
  }

  /**
   * Detects a new round from `${round}:${roundStartedAt}`. Everything that is
   * per-round — the reveal, the rejection, the typed text, the score deltas —
   * is cleared exactly here, so no round ever renders another round's state.
   */
  private onRoundBoundary(s: WbPublicState): void {
    const key = `${String(s.round)}:${String(s.roundStartedAt)}`;
    if (key === this.lastRoundKey) return;
    this.lastRoundKey = key;
    if (s.phase !== 'live') return;
    this.boom = null;
    this.reject = null;
    this.deltas.clear();
    this.answerInput.value = '';
    this.revealEl.classList.add('hidden');
    this.standingsEl.classList.add('hidden');
    this.standings = [];
    this.bannerTone = 'none';
    this.logLines.length = 0;
    this.renderLog();
    if (s.fragment !== null) this.pushLog(`round ${String(s.round)} — ${s.fragment.toUpperCase()}`, 'join');
  }

  private onBoom(e: Extract<WbEvent, { t: 'wb_boom' }>): void {
    this.boom = { fragment: e.fragment, answers: e.answers };
    this.deltas.clear();
    for (const a of e.answers) this.deltas.set(a.playerId, a.points);
    const mine = e.answers.find((a) => a.playerId === this.playerId);
    if (mine !== undefined && mine.word !== null) {
      const tag = mine.dupes === 1 ? 'ALONE' : `shared ×${String(mine.dupes)}`;
      this.pushLog(`BOOM — "${mine.word}" ${tag} → +${String(mine.points)}`, 'boom');
    } else {
      this.pushLog('BOOM — you had nothing locked', 'boom');
    }
    this.renderReveal();
    this.renderTable();
  }

  private onMatchEnd(e: Extract<WbEvent, { t: 'wb_match_end' }>): void {
    this.standings = e.standings;
    const me = e.winnerId !== null && e.winnerId === this.playerId;
    this.bannerTone = e.winnerId === null ? 'lose' : me ? 'win' : 'lose';
    this.pushLog(
      e.winnerId === null ? 'match over — no winner' : `${this.nameOfStanding(e.winnerId)} wins the match`,
      'boom',
    );
    this.renderStandings();
    this.renderTable();
  }

  // ---- screens ---------------------------------------------------------------
  private leaveToMenu(notice: string): void {
    this.send({ t: 'leave' });
    this.clearSessionRecord(); // explicit leave ONLY (§3) — never on a socket drop
    this.pub = null;
    this.priv = null;
    this.boom = null;
    this.reject = null;
    this.standings = [];
    this.deltas.clear();
    this.lastRoundKey = '';
    this.logLines.length = 0;
    this.bannerTone = 'none';
    this.showMenu(notice);
    if (this.welcomed) this.send({ t: 'list_rooms' });
  }

  private showMenu(notice: string): void {
    this.screen = 'menu';
    this.tableEl.classList.add('hidden');
    this.menuEl.classList.remove('hidden');
    this.setNotice(notice);
    this.renderMenu();
  }

  private showTable(): void {
    this.screen = 'table';
    this.menuEl.classList.add('hidden');
    this.tableEl.classList.remove('hidden');
  }

  // ---- menu rendering --------------------------------------------------------
  private menuName(): string {
    return cleanName(this.nameInput.value);
  }

  private menuButton(
    parent: HTMLElement,
    label: string,
    className: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = el('button', className, label);
    btn.type = 'button';
    btn.addEventListener('click', onClick);
    parent.appendChild(btn);
    return btn;
  }

  private setNotice(text: string): void {
    this.noticeEl.textContent = text;
    this.noticeEl.classList.toggle('hidden', text.length === 0);
  }

  private renderMenu(): void {
    for (const btn of this.menuButtons) btn.disabled = !this.welcomed;
    this.renderRooms();
  }

  private renderRooms(): void {
    this.roomsEl.replaceChildren();
    if (this.rooms.length === 0) {
      this.roomsEl.appendChild(el('div', 'room-empty', 'no rooms yet — create one'));
      return;
    }
    for (const room of this.rooms) {
      const row = el('div', 'room-row');
      row.appendChild(
        el('span', 'room-title', room.visibility === 'private' ? 'private room' : 'public room'),
      );
      row.appendChild(el('span', 'room-label', room.label));
      row.appendChild(
        el('span', 'room-meta', `${String(room.players)}/${String(room.maxPlayers)} · ${room.phase}`),
      );
      if (room.visibility === 'public') {
        // public rows join by id; private ones need the code flow. The clickable
        // affordance is `.room-row--joinable` in style.css — no inline cursor.
        row.classList.add('room-row--joinable');
        row.addEventListener('click', () => this.joinPublic(this.menuName(), room.id));
      }
      this.roomsEl.appendChild(row);
    }
  }

  // ---- table rendering -------------------------------------------------------
  private renderTable(): void {
    const s = this.pub;
    if (s === null) return;
    this.roundEl.textContent =
      s.round > 0 ? `ROUND ${String(s.round)}/${String(s.rounds)}` : `${String(s.rounds)} ROUNDS`;
    this.difficultyEl.textContent = s.difficulty.toUpperCase();

    const inviteCode = s.code ?? this.roomCode;
    this.inviteEl.classList.toggle('hidden', inviteCode === null);
    if (inviteCode !== null) this.inviteCodeEl.textContent = `CODE ${inviteCode}`;

    // In the lobby the bomb and the input are dead weight — an idle "?" and a
    // disabled box. The lobby panel replaces them outright, so the wait has one
    // clear subject and one clear action.
    const inLobby = s.phase === 'lobby';
    this.lobbyEl.classList.toggle('hidden', !inLobby);
    this.bombEl.classList.toggle('hidden', inLobby);
    this.answerFormEl.classList.toggle('hidden', inLobby);
    this.answerMetaEl.classList.toggle('hidden', inLobby);
    this.railEl.classList.toggle('hidden', inLobby); // `.lobby-seats` IS the rail here

    this.renderLobby(s);
    this.renderFragment(s);
    this.renderRail(s);
    this.renderAnswerMeta();
    this.renderBanner(s);
    this.revealEl.classList.toggle('hidden', this.boom === null || s.phase === 'live' || inLobby);
    this.standingsEl.classList.toggle('hidden', s.phase !== 'matchEnd' || this.standings.length === 0);
    this.tick(); // fuse bar + countdowns immediately, not up to TICK_MS late
  }

  /**
   * THE LOBBY. Four questions, answered without scrolling: who is here, how many
   * more are needed, what am I about to play, and can I start it.
   *
   * `seated`, `minPlayers` and `canStart` all come off the wire. The client
   * never recomputes the threshold — the server judges `wb_start` by the same
   * predicate it fills `canStart` with, so a button that says it will work
   * cannot be refused, and one that is disabled is disabled for the server's own
   * reason rather than a guess this file made.
   */
  private renderLobby(s: WbPublicState): void {
    if (s.phase !== 'lobby') return;

    this.lobbyCountValueEl.textContent = String(s.seated);
    this.lobbyCountMinEl.textContent = `of ${String(s.minPlayers)} needed`;
    this.lobbyDifficultyEl.textContent = s.difficulty.toUpperCase();
    this.lobbyRoundsEl.textContent = String(s.rounds);

    const seats: HTMLElement[] = [];
    for (const [i, p] of s.players.entries()) {
      const seat = el('div', 'lobby-seat');
      seat.style.setProperty('--seat', seatVar(i));
      seat.classList.toggle('lobby-seat--you', p.id === this.playerId);
      seat.appendChild(
        el('span', 'lobby-seat-avatar', p.name.trim().charAt(0).toUpperCase() || '?'),
      );
      const name = el('span', 'lobby-seat-name', p.name);
      if (p.id === this.playerId) name.appendChild(el('span', 'lobby-seat-you', 'YOU'));
      seat.appendChild(name);
      seat.appendChild(el('span', 'lobby-seat-state', p.connected ? 'READY' : 'AWAY'));
      seats.push(seat);
    }
    // Pad to `minPlayers` with visible HOLES, so "one more player" is a shape on
    // the screen and not only a sentence under the button.
    for (let i = s.players.length; i < s.minPlayers; i++) {
      const seat = el('div', 'lobby-seat lobby-seat--empty');
      seat.appendChild(el('span', 'lobby-seat-avatar', '?'));
      seat.appendChild(el('span', 'lobby-seat-name', 'empty seat'));
      seat.appendChild(el('span', 'lobby-seat-state', 'WAITING'));
      seats.push(seat);
    }
    this.lobbySeatsEl.replaceChildren(...seats);

    const counting = s.countdownEndsAt > 0;
    this.lobbyStartBtn.disabled = !s.canStart;
    this.lobbyStartBtn.textContent = counting ? 'STARTING…' : 'START MATCH';
    this.lobbyReasonEl.textContent = this.startReason(s);
  }

  /**
   * Why the button is off, in words. A disabled control with no explanation is
   * the same bug as colour-only state: the player is told "no" and not "why".
   */
  private startReason(s: WbPublicState): string {
    if (s.countdownEndsAt > 0) {
      const secs = secondsLeft(s.countdownEndsAt, this.serverNow());
      return `starting in ${String(secs)}s`;
    }
    if (s.seated < s.minPlayers) {
      const missing = s.minPlayers - s.seated;
      return `waiting for ${String(missing)} more player${missing === 1 ? '' : 's'} — share the room code`;
    }
    return 'anyone here can start it';
  }

  private renderFragment(s: WbPublicState): void {
    const fragment = s.fragment;
    this.bombEl.classList.toggle('bomb--idle', fragment === null);
    this.bombEl.classList.toggle('bomb--live', s.phase === 'live');
    this.bombEl.classList.toggle('bomb--boom', s.phase === 'reveal');
    if (fragment === null) {
      this.fragmentEl.replaceChildren(el('span', 'fragment-letter', '?'));
      this.fragmentHintEl.textContent = 'waiting for the next fragment';
      return;
    }
    const upper = fragment.toUpperCase();
    const letters: HTMLElement[] = [];
    for (const ch of upper) letters.push(el('span', 'fragment-letter', ch));
    this.fragmentEl.replaceChildren(...letters);
    this.fragmentHintEl.textContent =
      s.phase === 'live' ? 'anywhere in the word' : 'the round is over';
  }

  /**
   * The rail. `locked` is the ENTIRE amount one player may know about another
   * before the boom (I1) — no word, no length, no letter count. The delta chip
   * only appears once `wb_boom` has already revealed everything.
   */
  private renderRail(s: WbPublicState): void {
    this.railEl.replaceChildren();
    for (const [i, p] of s.players.entries()) {
      const chip = el('div', 'player-chip');
      chip.style.setProperty('--seat', seatVar(i));
      chip.classList.toggle('player-chip--you', p.id === this.playerId);
      chip.classList.toggle('player-chip--locked', p.locked);
      chip.classList.toggle('player-chip--offline', !p.connected);

      chip.appendChild(el('span', 'player-avatar', p.name.trim().charAt(0).toUpperCase() || '?'));
      const name = el('span', 'player-name', p.name);
      if (p.id === this.playerId) name.appendChild(el('span', 'player-you', 'YOU'));
      chip.appendChild(name);
      chip.appendChild(el('span', 'player-score', String(p.score)));
      chip.appendChild(el('span', 'player-lock', p.locked ? '●' : '○'));
      // second, non-colour cue (accessibility): never colour alone
      const stateText = !p.connected ? 'AWAY' : p.locked ? 'LOCKED' : 'THINKING';
      chip.appendChild(el('span', 'player-state', stateText));
      const delta = this.deltas.get(p.id);
      if (delta !== undefined && s.phase !== 'live') {
        chip.appendChild(el('span', 'player-delta', `+${String(delta)}`));
      }
      this.railEl.appendChild(chip);
    }
  }

  /**
   * The score preview. `scoreWord(word, 1)` is the ONLY call the client may
   * make — `dupes` is unknowable before the boom by construction of I1 — so the
   * number is labelled a MAXIMUM and never presented as what you will score.
   */
  private renderAnswerMeta(): void {
    const s = this.pub;
    const typed = this.answerInput.value.trim().toLowerCase();
    const live = s !== null && s.phase === 'live';
    this.answerInput.disabled = !live;

    const fragment = s?.fragment ?? null;
    const hasFragment = fragment !== null && typed.includes(fragment);
    const longEnough = typed.length >= MIN_WORD_LEN;
    this.answerInput.classList.toggle('answer-input--ok', longEnough && hasFragment);
    this.answerInput.classList.toggle('answer-input--warn', longEnough && !hasFragment);

    if (longEnough) {
      this.answerMaxValueEl.textContent = `up to ${String(scoreWord(typed, 1))}`;
      this.answerMaxLabelEl.textContent = ' — if nobody else finds it';
      this.answerMaxEl.classList.remove('hidden');
    } else {
      this.answerMaxValueEl.textContent = '';
      this.answerMaxLabelEl.textContent = '';
    }

    // status line: the last rejection (ours alone), else the locked word
    const yourWord = this.priv?.yourWord ?? null;
    this.answerStatusEl.classList.toggle('answer-status--rejected', this.reject !== null);
    this.answerStatusEl.classList.toggle(
      'answer-status--locked',
      this.reject === null && yourWord !== null,
    );
    if (this.reject !== null) {
      this.answerStatusEl.textContent = REJECT_TEXT[this.reject];
    } else if (!live && s !== null && s.phase !== 'reveal') {
      this.answerStatusEl.textContent = 'waiting for the round to start';
    } else if (longEnough && !hasFragment && fragment !== null) {
      this.answerStatusEl.textContent = `must contain ${fragment.toUpperCase()}`;
    } else {
      this.answerStatusEl.textContent = '';
    }

    this.lockedEl.classList.toggle('hidden', yourWord === null);
    if (yourWord !== null) this.lockedWordEl.textContent = yourWord.toUpperCase();

    const left = this.priv?.submitsLeft ?? MAX_SUBMITS_PER_ROUND;
    const showLeft = live && left <= LOW_SUBMITS;
    this.submitsLeftEl.classList.toggle('hidden', !showLeft);
    this.submitsLeftEl.textContent = showLeft ? `${String(left)} submissions left this round` : '';
  }

  /**
   * THE REVEAL — the moment the whole design exists for.
   *
   * Every answer at once, grouped BY WORD: players who collided literally share
   * one box, so a split is impossible to miss. Groups sort by points desc, and
   * the "no answer" box always comes last.
   */
  private renderReveal(): void {
    const boom = this.boom;
    if (boom === null) return;
    this.revealFragmentEl.textContent = boom.fragment.toUpperCase();
    this.revealGroupsEl.replaceChildren();

    const seatOf = new Map<string, number>();
    const players = this.pub?.players ?? [];
    for (const [i, p] of players.entries()) seatOf.set(p.id, i);

    const groups = new Map<string, RevealGroup>();
    const silent: WbAnswer[] = [];
    for (const a of boom.answers) {
      if (a.word === null) {
        silent.push(a);
        continue;
      }
      const existing = groups.get(a.word);
      if (existing === undefined) {
        groups.set(a.word, { word: a.word, dupes: a.dupes, points: a.points, answers: [a] });
      } else {
        existing.answers.push(a);
      }
    }

    const ordered = [...groups.values()].sort(
      (x, y) => y.points - x.points || y.word.length - x.word.length || x.word.localeCompare(y.word),
    );

    if (ordered.length === 0 && silent.length === 0) {
      this.revealGroupsEl.appendChild(el('div', 'reveal-empty', 'nobody was in the room'));
      return;
    }

    for (const g of ordered) {
      const split = g.dupes > 1;
      const box = el('div', `reveal-group ${split ? 'reveal-group--split' : 'reveal-group--unique'}`);
      box.appendChild(this.revealWordEl(g.word, boom.fragment));
      box.appendChild(
        el('span', 'reveal-badge', split ? `SHARED ×${String(g.dupes)}` : 'ALONE'),
      );
      box.appendChild(
        el('span', 'reveal-points', split ? `+${String(g.points)} each` : `+${String(g.points)}`),
      );
      const who = el('div', 'reveal-players');
      for (const a of g.answers) {
        const row = el('div', 'reveal-player');
        row.style.setProperty('--seat', seatVar(seatOf.get(a.playerId) ?? 0));
        row.classList.toggle('reveal-player--you', a.playerId === this.playerId);
        row.appendChild(el('span', 'reveal-player-name', a.name));
        row.appendChild(el('span', 'reveal-player-points', `+${String(a.points)}`));
        who.appendChild(row);
      }
      box.appendChild(who);
      this.revealGroupsEl.appendChild(box);
    }

    if (silent.length > 0) {
      const box = el('div', 'reveal-group reveal-group--none');
      box.appendChild(el('span', 'reveal-word', 'no answer'));
      box.appendChild(el('span', 'reveal-badge', 'BLANK'));
      box.appendChild(el('span', 'reveal-points', '+0'));
      const who = el('div', 'reveal-players');
      for (const a of silent) {
        const row = el('div', 'reveal-player');
        row.style.setProperty('--seat', seatVar(seatOf.get(a.playerId) ?? 0));
        row.classList.toggle('reveal-player--you', a.playerId === this.playerId);
        row.appendChild(el('span', 'reveal-player-name', a.name));
        row.appendChild(el('span', 'reveal-player-points', '+0'));
        who.appendChild(row);
      }
      box.appendChild(who);
      this.revealGroupsEl.appendChild(box);
    }
  }

  /** The word with its fragment marked, so the prompt is visible inside it. */
  private revealWordEl(word: string, fragment: string): HTMLSpanElement {
    const span = el('span', 'reveal-word');
    const at = word.indexOf(fragment);
    if (at < 0) {
      span.textContent = word.toUpperCase();
      return span;
    }
    const head = word.slice(0, at);
    const mid = word.slice(at, at + fragment.length);
    const tail = word.slice(at + fragment.length);
    if (head.length > 0) span.appendChild(document.createTextNode(head.toUpperCase()));
    span.appendChild(el('span', 'reveal-word-mark', mid.toUpperCase()));
    if (tail.length > 0) span.appendChild(document.createTextNode(tail.toUpperCase()));
    return span;
  }

  private renderStandings(): void {
    this.standingsEl.replaceChildren();
    if (this.standings.length === 0) return;
    this.standingsEl.appendChild(el('div', 'standings-title', 'FINAL STANDINGS'));
    const seatOf = new Map<string, number>();
    for (const [i, p] of (this.pub?.players ?? []).entries()) seatOf.set(p.id, i);
    for (const [i, s] of this.standings.entries()) {
      const row = el('div', 'standings-row');
      row.style.setProperty('--seat', seatVar(seatOf.get(s.playerId) ?? i));
      row.classList.toggle('standings-row--you', s.playerId === this.playerId);
      row.classList.toggle('standings-row--winner', i === 0);
      row.appendChild(el('span', 'standings-rank', String(i + 1)));
      row.appendChild(el('span', 'standings-name', s.name));
      row.appendChild(el('span', 'standings-score', String(s.score)));
      this.standingsEl.appendChild(row);
    }
  }

  private renderBanner(s: WbPublicState): void {
    if (s.phase === 'lobby') {
      // No banner in the lobby: `.lobby` already occupies the stage and says all
      // of this, and an overlay across the START button would be actively worse.
      this.bannerEl.classList.add('hidden');
      this.bannerEl.classList.remove('banner--win');
      this.bannerEl.classList.remove('banner--lose');
      return;
    }
    if (s.phase === 'matchEnd') {
      const winner = s.winnerId;
      const me = winner !== null && winner === this.playerId;
      const main = winner === null ? 'MATCH OVER' : me ? 'YOU WIN!' : `${this.nameOfStanding(winner).toUpperCase()} WINS!`;
      const sub = winner === null ? 'nobody scored' : me ? 'best vocabulary in the room' : 'better luck next fragment';
      this.setBanner(main, sub, this.bannerTone === 'none' ? (me ? 'win' : 'lose') : this.bannerTone);
      return;
    }
    this.bannerEl.classList.add('hidden');
    this.bannerEl.classList.remove('banner--win');
    this.bannerEl.classList.remove('banner--lose');
  }

  private setBanner(main: string, sub: string, tone: BannerTone): void {
    this.bannerMainEl.textContent = main;
    this.bannerSubEl.textContent = sub;
    this.bannerSubEl.classList.toggle('hidden', sub.length === 0);
    this.bannerEl.classList.toggle('banner--win', tone === 'win');
    this.bannerEl.classList.toggle('banner--lose', tone === 'lose');
    this.bannerEl.classList.remove('hidden');
  }

  private renderLog(): void {
    this.logEl.replaceChildren();
    for (const entry of this.logLines) {
      this.logEl.appendChild(el('div', `log-line log-kind-${entry.kind}`, entry.text));
    }
  }

  private pushLog(text: string, kind: LogKind): void {
    this.logLines.unshift({ text, kind }); // newest first
    if (this.logLines.length > LOG_MAX) this.logLines.length = LOG_MAX;
    this.renderLog();
  }

  private nameOf(id: string): string {
    return this.pub?.players.find((p) => p.id === id)?.name ?? 'Someone';
  }

  private nameOfStanding(id: string): string {
    return (
      this.standings.find((s) => s.playerId === id)?.name ??
      this.pub?.players.find((p) => p.id === id)?.name ??
      'Someone'
    );
  }

  /** Copies the invite link; navigator.clipboard first, textarea fallback. */
  private copyInvite(): void {
    const code = this.pub?.code ?? this.roomCode;
    if (code === null || code === undefined) return;
    const url = `${location.origin}/wordbomb/?code=${code}`;
    const clip: Clipboard | undefined = navigator.clipboard;
    if (clip !== undefined) {
      clip.writeText(url).then(
        () => this.showCopied(),
        () => this.copyInviteFallback(url),
      );
    } else {
      this.copyInviteFallback(url);
    }
  }

  private copyInviteFallback(url: string): void {
    const ta = el('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      // copy unsupported — the code is still readable in the chip
    }
    ta.remove();
    this.showCopied();
  }

  private showCopied(): void {
    this.copyBtn.textContent = 'COPIED';
    window.clearTimeout(this.copiedTimer);
    this.copiedTimer = window.setTimeout(() => {
      this.copyBtn.textContent = 'COPY INVITE';
    }, 1200);
  }

  /**
   * The fuse bar and the countdowns. Fixed interval so it survives tab blur.
   *
   * THE BAR IS DRAWN FROM `roundStartedAt + fuseMaxMs` AND NOTHING ELSE. The
   * real fuse is uniform in [fuseMinMs, fuseMaxMs] and is never sent, so the
   * bar cannot mean "time remaining" — it means "how far into the window we
   * are". Before the mark the bomb CANNOT blow; after it, it can at any
   * instant. No attempt is made to infer the real value; that uncertainty is
   * the game.
   */
  private tick(): void {
    const s = this.pub;
    if (s === null) return;
    const now = this.serverNow();

    if (s.phase === 'live' && s.roundStartedAt > 0 && s.fuseMaxMs > 0) {
      const elapsed = Math.max(0, now - s.roundStartedAt);
      const frac = Math.min(1, Math.max(0, 1 - elapsed / s.fuseMaxMs));
      const armed = elapsed >= s.fuseMinMs;
      this.fuseFillEl.style.width = `${String(frac * 100)}%`;
      this.fuseFillEl.classList.toggle('fuse-fill--danger', armed);
      this.bombEl.classList.toggle('bomb--armed', armed);
      const markFrac = s.fuseMaxMs > 0 ? 1 - s.fuseMinMs / s.fuseMaxMs : 0;
      this.fuseMarkEl.style.left = `${String(Math.min(100, Math.max(0, markFrac * 100)))}%`;
      this.fuseLabelEl.textContent = armed
        ? 'ANY MOMENT NOW'
        : `SAFE FOR ${String(secondsLeft(s.roundStartedAt + s.fuseMinMs, now))}s MORE`;
    } else {
      this.fuseFillEl.style.width = '0%';
      this.fuseFillEl.classList.remove('fuse-fill--danger');
      this.bombEl.classList.remove('bomb--armed');
      if (s.phase === 'reveal' && s.revealEndsAt > 0) {
        this.fuseLabelEl.textContent = `NEXT ROUND IN ${String(secondsLeft(s.revealEndsAt, now))}s`;
      } else if (s.phase === 'matchEnd' && s.matchEndsAt > 0) {
        this.fuseLabelEl.textContent = `NEW MATCH IN ${String(secondsLeft(s.matchEndsAt, now))}s`;
      } else if (s.phase === 'lobby' && s.countdownEndsAt > 0) {
        this.fuseLabelEl.textContent = `STARTING IN ${String(secondsLeft(s.countdownEndsAt, now))}s`;
      } else {
        this.fuseLabelEl.textContent = '';
      }
    }

    // The lobby's own live text: the post-press beat counts down in the reason
    // line, under the button that is now disabled because the beat is running.
    if (s.phase === 'lobby') this.lobbyReasonEl.textContent = this.startReason(s);
  }

  /**
   * THE MERGE, exposed. `you` falls back to the welcome id so a client that has
   * a public snapshot but not yet a private one still reports a usable view;
   * `yourWord` is null until the private message says otherwise, which is
   * exactly what I1 requires of a client that knows nothing yet.
   */
  private mergedState(): WbMergedState | null {
    const s = this.pub;
    if (s === null) return null;
    return {
      ...s,
      players: s.players.map((p) => ({ ...p })),
      you: this.priv?.you ?? this.playerId ?? '',
      yourWord: this.priv?.yourWord ?? null,
    };
  }
}

/**
 * The W5 -> W7 seam (docs/WORDBOMB.md §7): `main.ts` calls this and does
 * nothing else. Idempotent-ish by construction — one game instance per call.
 */
export function boot(root: HTMLElement): void {
  new WordbombGame(root);
}
