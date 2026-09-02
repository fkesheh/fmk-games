// ============================================================================
// BANK client — connection, lobby flow, state store, all rendering.
// Lobby protocol: platform/shared/src/protocol.ts (every lobby message carries
// game:'bank'; the room list is filtered to it). Room protocol + tuning come
// from the frozen @bank/shared contract. Dice rendering (./dice.js) and sound
// (./audio.js) are separate frozen modules — this file codes against their
// frozen signatures only. Debug surface window.__bank per docs/BANK.md.
// ============================================================================
import { MIN_PLAYERS, TURN_SECONDS } from '@bank/shared';
import type {
  BankC2S,
  BankEvent,
  BankPhase,
  BankPlayerState,
  BankSettings,
  BankState,
  RollEffect,
} from '@bank/shared';
import { cleanName, clearSession, loadName, loadSession, loadSig, saveName, saveSession } from '@platform/shared';
import type { LobbyC2S, RoomInfo } from '@platform/shared';
import { DiceView } from './dice.js';
import { BankAudio } from './audio.js';

// ---- wire parsing (mirror of the platform style: invalid => null, never throw) ----
type LobbyMsg =
  | { t: 'welcome'; playerId: string }
  | { t: 'room_list'; rooms: RoomInfo[] }
  | { t: 'pong'; ts: number; serverTime: number }
  | { t: 'error'; code: string; message: string };

/** bank_state plus the private-room code the server piggybacks alongside it. */
interface StateMsg {
  t: 'bank_state';
  state: BankState;
  code: string | null; // 5-char private-room code; null for public rooms/older servers
}

type S2C = LobbyMsg | StateMsg | BankEvent;

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
function phase(v: unknown): BankPhase | null {
  return v === 'lobby' || v === 'playing' || v === 'roundEnd' || v === 'matchEnd' ? v : null;
}
function effect(v: unknown): RollEffect | null {
  return v === 'add' || v === 'bonus70' || v === 'double' || v === 'bust7' ? v : null;
}

function parseSettings(v: unknown): BankSettings | null {
  if (!isObj(v) || !bool(v.sevenBonus) || !num(v.totalRounds)) return null;
  if (!(num(v.raceTarget) || v.raceTarget === null)) return null;
  return { sevenBonus: v.sevenBonus, totalRounds: v.totalRounds, raceTarget: v.raceTarget };
}

function parsePlayer(v: unknown): BankPlayerState | null {
  if (!isObj(v) || !str(v.id) || !str(v.name) || !num(v.score) || !bool(v.banked) || !bool(v.connected)) {
    return null;
  }
  return { id: v.id, name: v.name, score: v.score, banked: v.banked, connected: v.connected };
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

function parseState(v: Record<string, unknown>): BankState | null {
  const ph = phase(v.phase);
  if (ph === null) return null;
  const settings = parseSettings(v.settings);
  if (settings === null) return null;
  if (!num(v.round) || !num(v.totalRounds) || !num(v.pot) || !num(v.rollCount)) return null;
  if (!num(v.safeRolls) || !num(v.turnEndsAt)) return null;
  if (!(str(v.currentId) || v.currentId === null)) return null;
  if (!(str(v.winnerId) || v.winnerId === null)) return null;
  if (!str(v.you) || !str(v.roomId) || !Array.isArray(v.players)) return null;
  const players: BankPlayerState[] = [];
  for (const p of v.players) {
    const player = parsePlayer(p);
    if (player === null) return null;
    players.push(player);
  }
  let lastRoll: BankState['lastRoll'] = null;
  if (v.lastRoll !== null) {
    if (!isObj(v.lastRoll) || !num(v.lastRoll.d1) || !num(v.lastRoll.d2)) return null;
    if (!str(v.lastRoll.rollerId) || !num(v.lastRoll.potAfter)) return null;
    const eff = effect(v.lastRoll.effect);
    if (eff === null) return null;
    lastRoll = {
      d1: v.lastRoll.d1,
      d2: v.lastRoll.d2,
      rollerId: v.lastRoll.rollerId,
      effect: eff,
      potAfter: v.lastRoll.potAfter,
    };
  }
  const playerCount = num(v.playerCount) ? v.playerCount : players.filter((p) => p.connected).length;
  const minPlayers = num(v.minPlayers) ? v.minPlayers : MIN_PLAYERS;
  return {
    t: 'bank_state',
    phase: ph,
    settings,
    round: v.round,
    totalRounds: v.totalRounds,
    pot: v.pot,
    rollCount: v.rollCount,
    safeRolls: v.safeRolls,
    currentId: v.currentId,
    turnEndsAt: v.turnEndsAt,
    players,
    lastRoll,
    winnerId: v.winnerId,
    code: v.code === null ? null : str(v.code) ? v.code : null,
    // public-room rejoin target (join_public): no join code exists for a
    // public room, so this is what a reload targets instead of one.
    roomId: v.roomId,
    // additive + tolerant: a server that predates the manual-restart change
    // sends no `awaitingStart`, and `false` is exactly the old behaviour
    awaitingStart: v.awaitingStart === true,
    // additive + tolerant, same style, for the three authoritative-lobby
    // fields: a server that predates them sends none, so each falls back to
    // the best value derivable from data already parsed above.
    playerCount,
    minPlayers,
    // `v.canStart === true` alone is not a safe fallback — an omitted field
    // would then silently read as "cannot start" even when the room already
    // qualifies — so a missing value is recomputed from the server's own rule.
    canStart: typeof v.canStart === 'boolean' ? v.canStart : ph === 'lobby' && playerCount >= minPlayers,
    you: v.you,
  };
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
    case 'bank_state': {
      const state = parseState(raw);
      if (state === null) return null;
      // the code rides beside the state (not part of the frozen BankState): optional
      return { t: 'bank_state', state, code: str(raw.code) ? raw.code : null };
    }
    case 'roll': {
      if (!num(raw.d1) || !num(raw.d2) || !str(raw.rollerId) || !num(raw.potAfter)) return null;
      const eff = effect(raw.effect);
      if (eff === null) return null;
      return { t: 'roll', d1: raw.d1, d2: raw.d2, rollerId: raw.rollerId, effect: eff, potAfter: raw.potAfter };
    }
    case 'bank':
      return str(raw.playerId) && num(raw.amount)
        ? { t: 'bank', playerId: raw.playerId, amount: raw.amount }
        : null;
    case 'auto_roll':
      return str(raw.playerId) ? { t: 'auto_roll', playerId: raw.playerId } : null;
    case 'round_end': {
      if (raw.reason !== 'bust7' && raw.reason !== 'all_banked') return null;
      if (!num(raw.round)) return null;
      return { t: 'round_end', reason: raw.reason, round: raw.round };
    }
    case 'match_end':
      return str(raw.winnerId) || raw.winnerId === null
        ? { t: 'match_end', winnerId: raw.winnerId }
        : null;
    case 'event':
      // server wraps game events as {t:'event', ev} (fps/platform convention) — unwrap + re-parse
      return parseS2C(raw.ev);
    default:
      return null; // unknown envelope: drop, never throw on wire data
  }
}

// ---- frozen e2e surface (docs/BANK.md "Debug surface") ----------------------
/** JSON-safe snapshot of everything a test driver needs. */
interface BankDebugState {
  phase: BankPhase | 'none'; // 'none' before the first bank_state arrives
  settings: BankSettings | null; // the room variant; null before the first bank_state
  round: number;
  pot: number;
  rollCount: number;
  currentId: string | null;
  you: string | null;
  players: BankPlayerState[];
  score: number; // banked total of `you`
  code: string | null; // private-room code when known (state piggyback or the join code)
  resume: string | null; // the stored rejoin token (localStorage 'bank.resume'), if any
  awaitingStart: boolean; // COSMETIC ONLY: true = post-match lobby, false = cold lobby — both wait for START
  canStart: boolean; // phase === 'lobby' && playerCount >= minPlayers (server-authoritative)
  playerCount: number; // connected seats right now
}

interface BankApi {
  state(): BankDebugState;
  joinQuick(name: string): void;
  createPublic(name: string, settings?: BankSettings): void;
  createPrivate(name: string, settings?: BankSettings): void;
  joinPrivate(name: string, code: string): void;
  roll(): void;
  bank(): void;
  start(): void; // any lobby (cold or post-match); the room ignores it anywhere else
}

declare global {
  interface Window {
    __bank?: BankApi;
  }
}

// ---- tuning ------------------------------------------------------------------
const RECONNECT_MS = 1000; // socket dropped -> back to the menu, retry quietly
const PING_EVERY_MS = 2000; // mirrors NET.pingEveryMs (platform protocol)
const ROOMS_EVERY_MS = 3000; // menu room-list poll
const TICK_MS = 100; // pot counter + turn timer refresh (setInterval: blur-safe)
const POT_STEP = 0.25; // animated counter eases up by this fraction per tick
const LOG_MAX = 6; // event log keeps the last ~6 entries (docs/BANK.md)
// "UP NEXT" shows the roller + the next three; deeper than that is a rail, not a
// queue, and the rail already lists all 20 seats. The remainder becomes "+N".
const QUEUE_PEEK = 4;
// Above this many seats the rail switches to its compact form (see renderPlayers).
// 12 is where full-size chips stop fitting in two rows on a 1120 px felt.
const DENSE_SEATS = 12;
// Fraction of the turn that counts as "running out". Was a flat 5 000 ms, which
// at TURN_SECONDS = 12 would have left the bar in its urgent state for 42 % of
// every turn — the cue would stop meaning anything. Proportional keeps the
// warning the same *share* of the turn at any TURN_SECONDS.
const TIMER_LOW_FRAC = 0.28;
const NAME_MAX = 16; // lobby cleanName cap (platform protocol)
const CODE_MAX = 8;
const GAME = 'bank'; // this client's GameModule.id — the key for loadSession/saveSession/clearSession
const DICE_TUMBLE_MS = 600; // tumble frames before the dice settle on d1/d2

/**
 * Event-log entry kinds. These map 1:1 onto the frozen `log-kind-*` classes
 * (VISUAL_UPGRADE §8) so the stylesheet can accent each event type: 'roll' for
 * dice activity, 'bank' for value secured, 'bust' for the 7, and 'join' for
 * neutral system lines (seating, match wrap-up).
 */
type LogKind = 'roll' | 'bank' | 'bust' | 'join';

interface LogEntry {
  text: string;
  kind: LogKind;
}

/** Result banner tone; drives the frozen `banner-win` / `banner-lose` classes. */
type BannerTone = 'none' | 'win' | 'lose';

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

/** Variant chip text, mirroring the server's info().label (docs/BANK.md). */
function variantLabel(s: BankSettings): string {
  const bonus = s.sevenBonus ? '7=70' : 'plain 7';
  return s.raceTarget !== null ? `race to ${s.raceTarget} · ${bonus}` : `${s.totalRounds} rounds · ${bonus}`;
}

/** Structural WebSocket stand-in: P2P transports plug in here (§12.6). */
/** WebSocket.OPEN === 1; the override exposes the same numeric state. */
const WS_OPEN = 1;

export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror?: ((ev?: unknown) => void) | null;
}

export interface BankGameOpts {
  /** Post-open messages (SDK auth on the real ws path). */
  readonly onOpenExtra?: () => readonly unknown[];
  /** P2P transport override — far end is the host tab's mini-lobby. */
  readonly socket?: WsLike;
}

export class BankGame {
  /** Structural stand-in for WebSocket (P2P socket override, §12.6). */
  private ws: WsLike | null = null;
  private readonly socketOverride: WsLike | undefined;
  private welcomed = false;
  private playerId: string | null = null;
  private resumeToken: string | null = null; // rejoin token loaded from the shared session pointer
  private roomCode: string | null = null; // code of the room we're in/joining, when known
  /**
   * Public-room id we're in/joining, when known — the `join_public` target for
   * a PUBLIC room, exactly what `roomCode` is for a private one. Without this
   * a reload out of a public room (no code) could only quick_join into some
   * stranger's table, never back to its own.
   */
  private sessionRoomId: string | null = null;
  private state: BankState | null = null;
  private stateCode: string | null = null; // private-room code piggybacked on bank_state
  private pendingJoin: { name: string; code: string } | null = null; // invite-link auto-join
  private copiedTimer = 0; // 'COPIED' feedback reset handle
  private rooms: RoomInfo[] = [];
  private screen: 'menu' | 'table' = 'menu';
  private readonly logLines: LogEntry[] = [];
  private bannerText = '';
  private bannerSub = '';
  private bannerTone: BannerTone = 'none';
  private potShown = 0; // animated value; eases UP toward state.pot, snaps down
  private potTarget = 0;
  private offset = 0; // serverNow = Date.now() + offset (min-RTT would be nicer; rtt/2 estimate)
  private readonly audio = new BankAudio();
  private readonly dice: DiceView;

  // ---- DOM handles (built once in the constructor, updated in place) ----------
  private readonly menuEl: HTMLDivElement;
  private readonly tableEl: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly sevenBonusInput: HTMLInputElement;
  private readonly lengthSelect: HTMLSelectElement;
  private readonly roomsEl: HTMLDivElement;
  private readonly menuButtons: HTMLButtonElement[] = [];
  private readonly roundEl: HTMLDivElement;
  private readonly variantEl: HTMLDivElement;
  private readonly inviteEl: HTMLDivElement;
  private readonly inviteCodeEl: HTMLSpanElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly potEl: HTMLDivElement;
  private readonly potFlashEl: HTMLDivElement;
  private readonly timerFillEl: HTMLDivElement;
  private readonly queueEl: HTMLDivElement;
  private readonly queueListEl: HTMLOListElement;
  private readonly queueEtaEl: HTMLSpanElement;
  private readonly playersEl: HTMLDivElement;
  private readonly logEl: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly bannerMainEl: HTMLDivElement;
  private readonly bannerSubEl: HTMLDivElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly rollBtn: HTMLButtonElement;
  private readonly bankBtn: HTMLButtonElement;

  constructor(root: HTMLElement, opts?: BankGameOpts) {
    this.onOpenExtra = opts?.onOpenExtra;
    this.socketOverride = opts?.socket;
    // ---- menu screen ----------------------------------------------------------
    this.menuEl = el('div', 'screen menu');
    this.menuEl.appendChild(el('h1', 'menu-title', 'BANK'));
    this.menuEl.appendChild(el('p', 'menu-sub', 'the dice game of nerve'));
    this.noticeEl = el('div', 'menu-notice hidden');
    this.menuEl.appendChild(this.noticeEl);

    this.nameInput = el('input', 'menu-name');
    this.nameInput.maxLength = NAME_MAX;
    this.nameInput.placeholder = 'your name';
    this.nameInput.autocomplete = 'off';
    this.nameInput.value = loadName(); // may be '' (never typed) — placeholder covers that
    this.menuEl.appendChild(this.nameInput);

    // ---- create-section variant picker (docs/BANK.md "VARIANT UI") -----------
    // Zero inline styling here: `.menu-options` and its label/checkbox/select
    // are styled entirely from style.css. Inline rules outrank the stylesheet,
    // so writing them here would make the sheet's `.menu-options` rules dead.
    const options = el('div', 'menu-options');

    const sevenLabel = el('label');
    this.sevenBonusInput = el('input');
    this.sevenBonusInput.type = 'checkbox';
    this.sevenBonusInput.checked = true; // canonical default (DEFAULT_SETTINGS)
    sevenLabel.appendChild(this.sevenBonusInput);
    sevenLabel.appendChild(document.createTextNode('7 = 70 in first 3 rolls'));
    options.appendChild(sevenLabel);

    this.lengthSelect = el('select');
    for (const [value, text] of [
      ['10', '10 rounds'],
      ['20', '20 rounds'],
      ['race', 'First to 500'],
    ] as const) {
      const opt = el('option', undefined, text);
      opt.value = value;
      this.lengthSelect.appendChild(opt);
    }
    options.appendChild(this.lengthSelect);
    this.menuEl.appendChild(options);

    const menuActions = el('div', 'menu-actions');
    this.menuButtons.push(
      this.menuButton(menuActions, 'QUICK JOIN', 'btn btn-gold', () => this.joinQuick(this.menuName())),
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

    this.menuEl.appendChild(el('h2', 'menu-rooms-title', 'TABLES'));
    this.roomsEl = el('div', 'menu-rooms');
    this.menuEl.appendChild(this.roomsEl);

    // ---- table screen ----------------------------------------------------------
    this.tableEl = el('div', 'screen table hidden');
    const topBar = el('div', 'table-top');
    this.roundEl = el('div', 'table-round', 'ROUND 1/10');
    topBar.appendChild(this.roundEl);
    this.variantEl = el('div', 'table-variant');
    topBar.appendChild(this.variantEl);
    // Invite chip (private rooms only): 'CODE XXXXX' + copyable invite link.
    // `.table-banner` overlays the whole table while waiting/round-end, but it
    // is `pointer-events: none`, so this chip stays clickable underneath it
    // without any inline stacking rules — all four of `.table-invite`'s former
    // inline styles now live in style.css.
    this.inviteEl = el('div', 'table-invite hidden');
    this.inviteCodeEl = el('span', 'table-invite-code');
    this.inviteEl.appendChild(this.inviteCodeEl);
    this.copyBtn = el('button', 'btn btn-small', 'COPY INVITE');
    this.copyBtn.addEventListener('click', () => {
      this.audio.resume();
      this.copyInvite();
    });
    this.inviteEl.appendChild(this.copyBtn);
    topBar.appendChild(this.inviteEl);
    const leaveBtn = el('button', 'btn btn-small', 'LEAVE');
    leaveBtn.addEventListener('click', () => {
      this.audio.resume();
      this.leaveToMenu('');
    });
    topBar.appendChild(leaveBtn);
    this.tableEl.appendChild(topBar);

    // ---- stage: the viewport-filling play area --------------------------------
    // `.table-stage` wraps EVERYTHING on the table screen except `.table-top`,
    // and is the growth region that claims every pixel the top bar leaves. It is
    // a two-column grid (VISUAL_UPGRADE §5 / the frozen B1↔B2 layout contract):
    //
    //   .table-stage
    //     .stage-main   felt (dominant) + player-rail + table-actions
    //     .stage-side    log-panel > log-title + event-log
    //     .table-banner  overlay, centred over the whole stage
    //
    // Rail and actions live in the SAME column as the felt and directly beneath
    // it, so there is no orphan gap between the felt and the rail — that band was
    // BANK's single biggest compositional flaw. The log sits in the side column,
    // so its height is tied to the main column instead of being a tall empty box.
    const stage = el('div', 'table-stage');
    const stageMain = el('div', 'stage-main');
    const stageSide = el('aside', 'stage-side');

    // felt-rail (wood/leather surround) > felt (green surface) >
    //   felt-stitch (decorative inset stitch line) + felt-inner (content well)
    const feltRail = el('div', 'felt-rail');
    const felt = el('div', 'felt');
    const feltStitch = el('div', 'felt-stitch');
    feltStitch.setAttribute('aria-hidden', 'true'); // pure decoration
    felt.appendChild(feltStitch);
    const feltInner = el('div', 'felt-inner');
    feltInner.appendChild(el('div', 'pot-label', 'POT'));
    this.potEl = el('div', 'pot-value', '0');
    feltInner.appendChild(this.potEl);
    this.potFlashEl = el('div', 'pot-flash');
    feltInner.appendChild(this.potFlashEl);
    const diceArea = el('div', 'dice-area');
    feltInner.appendChild(diceArea);
    const timerBar = el('div', 'timer-bar');
    this.timerFillEl = el('div', 'timer-fill');
    timerBar.appendChild(this.timerFillEl);
    feltInner.appendChild(timerBar);
    felt.appendChild(feltInner);
    feltRail.appendChild(felt);
    stageMain.appendChild(feltRail);

    // ---- turn queue ------------------------------------------------------------
    // Structural mitigation for a 20-seat table. A round ends on the bust-7, so
    // it is ~9 rolls long no matter how many seats there are: at 20 players most
    // people never roll in a given round and can wait ~20 turns for their own
    // action. Nothing in the RULES can fix that (and we are not changing rules),
    // but a player who will not act for 15 turns must at least be able to SEE
    // where they are. This strip names who is rolling now, the next three in
    // rotation, and how many turns until you are up.
    //
    // It sits between the felt and the rail — one line tall, `auto` row — so it
    // reads at the point the eye already goes and costs the felt almost nothing.
    this.queueEl = el('div', 'turn-queue hidden');
    this.queueEl.appendChild(el('span', 'turn-queue-label', 'UP NEXT'));
    this.queueListEl = el('ol', 'turn-queue-list');
    this.queueEl.appendChild(this.queueListEl);
    this.queueEtaEl = el('span', 'turn-queue-eta');
    this.queueEl.appendChild(this.queueEtaEl);
    stageMain.appendChild(this.queueEl);

    // Rail and actions are siblings of the felt inside `.stage-main`, in document
    // order felt → queue → rail → actions, so they flow directly under the felt
    // with no dead band between them.
    this.playersEl = el('div', 'player-rail');
    stageMain.appendChild(this.playersEl);

    const actions = el('div', 'table-actions');
    this.rollBtn = el('button', 'btn btn-roll hidden', 'ROLL');
    this.rollBtn.addEventListener('click', () => {
      this.audio.resume();
      this.rollBtn.disabled = true; // one roll per turn; next bank_state re-enables
      this.roll();
    });
    this.bankBtn = el('button', 'btn btn-bank', 'BANK');
    this.bankBtn.addEventListener('click', () => {
      this.audio.resume();
      this.bankBtn.disabled = true; // you bank once per round; next bank_state re-enables
      this.bank();
    });
    //  START — the room no longer restarts itself after a match, so the lobby
    //  needs a way out. BANK has no host, so this is live for every seated
    //  player; the server ignores it outside 'lobby' or below MIN_PLAYERS, and
    //  the button states the reason rather than sitting inertly greyed out.
    //  It lives in `.table-actions` and NOT in `.table-banner`, because the
    //  banner is `pointer-events: none` by contract and nothing inside it can
    //  ever be clicked.
    this.startBtn = el('button', 'btn btn-gold btn-start hidden', 'START MATCH');
    this.startBtn.addEventListener('click', () => {
      this.audio.resume();
      this.startBtn.disabled = true; // the next bank_state re-enables or hides it
      this.startMatch();
    });
    actions.appendChild(this.startBtn);
    actions.appendChild(this.rollBtn);
    actions.appendChild(this.bankBtn);
    stageMain.appendChild(actions);
    stage.appendChild(stageMain);

    // the log gets a real home beside the felt instead of floating under it;
    // `<aside>` because it is complementary to the play area, not part of it
    const logPanel = el('div', 'log-panel');
    logPanel.appendChild(el('div', 'log-title', 'TABLE LOG'));
    this.logEl = el('div', 'event-log');
    logPanel.appendChild(this.logEl);
    stageSide.appendChild(logPanel);
    stage.appendChild(stageSide);

    this.bannerEl = el('div', 'table-banner hidden');
    // Text-only overlay: it must never intercept clicks (invite chip, LEAVE, …).
    // This is the ONE inline style the table keeps, deliberately: it is the
    // guarantee that every control under the banner stays usable regardless of
    // what stacking context the stylesheet ends up creating.
    this.bannerEl.style.pointerEvents = 'none';
    this.bannerMainEl = el('div'); // headline; inherits `.table-banner` type
    this.bannerEl.appendChild(this.bannerMainEl);
    this.bannerSubEl = el('div', 'banner-sub');
    this.bannerEl.appendChild(this.bannerSubEl);
    // the banner is a child of `.table-stage` so it can centre over the whole
    // stage (felt + rail + actions + log), not just one column
    stage.appendChild(this.bannerEl);

    this.tableEl.appendChild(stage);

    root.appendChild(this.menuEl);
    root.appendChild(this.tableEl);

    this.dice = new DiceView(diceArea);

    // ---- timers (setInterval everywhere: rAF pauses in background tabs) --------
    window.setInterval(() => this.tick(), TICK_MS);
    window.setInterval(() => {
      if (this.ws !== null && this.ws.readyState === WS_OPEN) {
        this.send({ t: 'ping', ts: performance.now() });
      }
    }, PING_EVERY_MS);
    window.setInterval(() => {
      if (this.screen === 'menu' && this.welcomed) this.send({ t: 'list_rooms' });
    }, ROOMS_EVERY_MS);

    // ---- frozen e2e debug surface ----------------------------------------------
    window.__bank = {
      state: () => this.debugState(),
      joinQuick: (name) => this.joinQuick(name),
      createPublic: (name, settings) => this.createPublic(name, settings),
      createPrivate: (name, settings) => this.createPrivate(name, settings),
      joinPrivate: (name, code) => this.joinPrivate(name, code),
      roll: () => this.roll(),
      bank: () => this.bank(),
      start: () => this.startMatch(),
    };

    // ---- rejoin record (shared @platform/shared session pointer for 'bank') ----
    const session = loadSession(GAME);
    if (session !== null) {
      this.resumeToken = session.playerId;
      this.roomCode = session.code;
      this.sessionRoomId = session.roomId;
    }
    if (this.roomCode !== null) this.codeInput.value = this.roomCode; // stored-code prefill

    // ---- invite link (?code=XXXXX): prefill + auto-join, then strip the param ----
    const linkCode = new URLSearchParams(location.search).get('code');
    if (linkCode !== null && linkCode.length > 0) {
      history.replaceState(null, '', location.pathname + location.hash); // no re-trigger on refresh
      this.codeInput.value = linkCode; // link code beats the stored-code prefill
      const name = loadName();
      if (name !== '') this.pendingJoin = { name, code: linkCode }; // attempted after welcome
    }

    this.connect();
    this.renderMenu();
  }

  // ---- connection ---------------------------------------------------------------
  private onOpenExtra: (() => readonly unknown[]) | undefined;

  private connect(): void {
    // Platform v2 P2P (docs/PLATFORM.md §12.6): the shell may supply a
    // SocketLike whose far end is the HOST TAB (loopback on the host, a
    // DataChannel relay for guests). Same wire format, same flow.
    if (this.socketOverride !== undefined) {
      const ws: WsLike = this.socketOverride;
      this.ws = ws;
      ws.onopen = () => {
        for (const m of this.onOpenExtra?.() ?? []) {
          try { ws.send(JSON.stringify(m)); } catch { break; }
        }
      };
      ws.onmessage = (ev: { data: string }) => {
        if (this.ws !== ws || typeof ev.data !== 'string') return;
        let decoded: unknown;
        try {
          decoded = JSON.parse(ev.data);
        } catch {
          return;
        }
        const msg = parseS2C(decoded);
        if (msg !== null) this.onMessage(msg);
      };
      return;
    }
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url) as unknown as WsLike;
    this.ws = ws;
    // Platform v2: shell-supplied post-open messages ({t:'auth'}).
    ws.onopen = () => {
      for (const m of this.onOpenExtra?.() ?? []) {
        try { ws.send(JSON.stringify(m)); } catch { break; }
      }
    };
    ws.onmessage = (ev: { data: string }) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(ev.data);
      } catch {
        return; // malformed frame: drop, never throw
      }
      const msg = parseS2C(decoded);
      if (msg !== null) this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // stale socket from a previous connect()
      this.ws = null;
      const wasAtTable = this.screen === 'table';
      this.welcomed = false;
      this.state = null;
      this.showMenu(wasAtTable ? 'Connection lost — rejoining…' : '');
      window.setTimeout(() => this.connect(), RECONNECT_MS);
    };
    ws.onerror = () => {
      // the close event follows and does the teardown
    };
  }

  /** No-op unless the socket is open (mirrors the server's Session.send). */
  private send(msg: LobbyC2S | BankC2S): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(msg)); // the wire is plain JSON
    } catch {
      // racing a close — drop the frame
    }
  }

  private serverNow(): number {
    return Date.now() + this.offset;
  }

  /**
   * Stamps the rejoin hints shared by every join message (contract §2.2): the
   * durable browser signature ALWAYS, and the previous session's playerId
   * when we have one. One helper instead of five near-identical inline
   * stamps — every `t:'*_join'`/`create_*` message shape carries both fields
   * as optional, so this is safe for all five call sites.
   */
  private stampJoin<T extends { resume?: string; sig?: string }>(msg: T): T {
    msg.sig = loadSig();
    if (this.resumeToken !== null) msg.resume = this.resumeToken;
    return msg;
  }

  /**
   * Boot/reconnect auto-rejoin (contract §3): re-enter the room this browser
   * was last in without the player clicking anything. `code` wins when known
   * (join_private targets one exact room); otherwise `roomId` (join_public —
   * the ONLY way back into a specific PUBLIC room, since it has no code);
   * otherwise a bare quick_join so a session that predates roomId tracking
   * still tries to rebind by resume/sig rather than stranding the player. A
   * cold boot with no stored session at all (`resumeToken === null`) does
   * nothing — the menu just waits, same as before this existed.
   */
  private autoRejoin(): void {
    if (this.resumeToken === null) return;
    const name = this.menuName();
    if (this.roomCode !== null) this.joinPrivate(name, this.roomCode);
    else if (this.sessionRoomId !== null) this.joinPublic(name, this.sessionRoomId);
    else this.joinQuick(name);
  }

  // ---- lobby actions (game filter 'bank' on every create/join) -------------------
  // Every join flow carries the stored rejoin token when we have one; the server
  // re-binds a disconnected ghost entry with that id (docs/BANK.md "Rejoin").
  private joinQuick(name: string): void {
    const msg: Extract<LobbyC2S, { t: 'quick_join' }> = {
      t: 'quick_join',
      name: cleanName(name),
      game: 'bank-sdk',
    };
    this.stampJoin(msg);
    this.roomCode = null; // public room: no code
    this.sessionRoomId = null; // unknown until bank_state reports it — any room may answer
    saveName(msg.name);
    this.send(msg);
  }
  /** Variant chosen in the create section (or the e2e override passed in). */
  private menuSettings(): BankSettings {
    const sevenBonus = this.sevenBonusInput.checked;
    const value = this.lengthSelect.value;
    if (value === 'race') return { sevenBonus, totalRounds: 10, raceTarget: 500 };
    return { sevenBonus, totalRounds: value === '20' ? 20 : 10, raceTarget: null };
  }
  private createPublic(name: string, settings?: BankSettings): void {
    const s = settings ?? this.menuSettings();
    const msg: Extract<LobbyC2S, { t: 'create_public' }> = {
      t: 'create_public',
      name: cleanName(name),
      game: 'bank-sdk',
      settings: { sevenBonus: s.sevenBonus, totalRounds: s.totalRounds, raceTarget: s.raceTarget },
    };
    this.stampJoin(msg);
    this.roomCode = null; // public room: no code
    this.sessionRoomId = null; // a brand-new room — unknown until bank_state reports it
    saveName(msg.name);
    this.send(msg);
  }
  private createPrivate(name: string, settings?: BankSettings): void {
    const s = settings ?? this.menuSettings();
    const msg: Extract<LobbyC2S, { t: 'create_private' }> = {
      t: 'create_private',
      name: cleanName(name),
      game: 'bank-sdk',
      settings: { sevenBonus: s.sevenBonus, totalRounds: s.totalRounds, raceTarget: s.raceTarget },
    };
    this.stampJoin(msg);
    this.roomCode = null; // the code is server-generated; not known client-side
    this.sessionRoomId = null; // a brand-new room — unknown until bank_state reports it
    saveName(msg.name);
    this.send(msg);
  }
  private joinPublic(name: string, roomId: string): void {
    const msg: Extract<LobbyC2S, { t: 'join_public' }> = {
      t: 'join_public',
      name: cleanName(name),
      roomId,
    };
    this.stampJoin(msg);
    this.roomCode = null; // public room: no code
    this.sessionRoomId = roomId; // candidate; a 'no_room' error clears it again
    saveName(msg.name);
    this.send(msg);
  }
  private joinPrivate(name: string, code: string): void {
    const c = code.length > 0 ? code : (this.roomCode ?? ''); // stored-code fallback
    if (c.length === 0) {
      this.setNotice('enter a room code first');
      return;
    }
    const msg: Extract<LobbyC2S, { t: 'join_private' }> = {
      t: 'join_private',
      name: cleanName(name),
      code: c,
    };
    this.stampJoin(msg);
    this.roomCode = c; // candidate; a 'no_room' error clears it again
    this.sessionRoomId = null; // a code join targets a specific room by code, not by id
    saveName(msg.name);
    this.send(msg);
  }
  private roll(): void {
    this.send({ t: 'roll' });
  }
  private bank(): void {
    this.send({ t: 'bank' });
  }
  /** Opens the match from any lobby (cold or post-match); any seated player may send it. */
  private startMatch(): void {
    this.send({ t: 'start' });
  }

  // ---- message routing -------------------------------------------------------------
  private onMessage(msg: S2C): void {
    switch (msg.t) {
      case 'welcome':
        this.playerId = msg.playerId;
        this.welcomed = true;
        this.send({ t: 'list_rooms' });
        this.setNotice('');
        this.renderMenu();
        if (this.pendingJoin !== null) {
          // an invite link is an explicit ask for THAT room — it outranks a
          // stored session pointer, which is only a fallback for "no ask made"
          const { name, code } = this.pendingJoin;
          this.pendingJoin = null; // single attempt — on failure the error notice shows
          this.joinPrivate(name, code);
        } else {
          // boot or reconnect with no explicit ask: fall back to wherever this
          // browser last was (contract §3) — no-op when there is no session
          this.autoRejoin();
        }
        break;
      case 'room_list':
        this.rooms = msg.rooms.filter((r) => r.game === 'bank-sdk'); // sdk-port room list (shells)
        if (this.screen === 'menu') this.renderRooms();
        break;
      case 'pong': {
        const rtt = performance.now() - msg.ts;
        if (rtt >= 0) this.offset = msg.serverTime + rtt / 2 - Date.now();
        break;
      }
      case 'error':
        // stale room — drop the stored pointer (the resume token stays; only
        // the ROOM target was wrong). Both `roomCode` and `sessionRoomId` are
        // cleared unconditionally because 'no_room' can only come from a
        // join_private (bad code) or join_public (bad roomId) attempt, and
        // only one of those is ever the candidate in flight at a time.
        if (msg.code === 'no_room' && (this.roomCode !== null || this.sessionRoomId !== null)) {
          this.roomCode = null;
          this.sessionRoomId = null;
          if (this.playerId !== null) {
            saveSession(GAME, { playerId: this.playerId, roomId: null, code: null });
          }
        }
        this.setNotice(msg.message);
        break;
      case 'bank_state':
        this.onState(msg.state, msg.code);
        break;
      case 'roll':
        this.onRoll(msg);
        break;
      case 'bank':
        this.onBank(msg);
        break;
      case 'auto_roll':
        this.pushLog(`${this.nameOf(msg.playerId)} timed out — auto-roll`, 'roll');
        break;
      case 'round_end':
        this.onRoundEnd(msg);
        break;
      case 'match_end':
        this.onMatchEnd(msg);
        break;
    }
  }

  private onState(s: BankState, code: string | null): void {
    const first = this.state === null;
    const prevPhase = this.state?.phase ?? null;
    const wasMyTurn =
      this.state !== null && this.state.phase === 'playing' && this.state.currentId === this.playerId;

    if (first) {
      this.showTable();
      this.potShown = s.pot; // no count-up animation on the very first snapshot
      this.pushLog('You joined the table', 'join');
      if (s.lastRoll !== null) this.settleDice(s.lastRoll.d1, s.lastRoll.d2);
    }
    //  matchEnd -> lobby is the server's full reset. This used to eject the
    //  player back to the MENU ("Match over."), which is incompatible with the
    //  room now WAITING in that lobby: the seat you were kicked out of is the
    //  seat that has to press START, and being thrown to the room list is the
    //  dead screen this change exists to remove. Stay at the table; the banner
    //  and the START button explain the state, and the top-bar LEAVE button is
    //  still the way out for anyone who wants it.
    if (prevPhase === 'matchEnd' && s.phase === 'lobby') {
      // drop the finished match's win/lose treatment so the lobby banner is not
      // rendered in the previous result's colours
      this.bannerText = '';
      this.bannerSub = '';
      this.bannerTone = 'none';
      this.pushLog('Match over — press START for the next one', 'join');
    }
    this.state = s;
    this.stateCode = code; // refreshed every snapshot; drives the invite chip
    this.potTarget = s.pot;

    // full rejoin pointer (contract §3): the seat WE hold in THIS room, its id
    // (join_public target for a PUBLIC room) and its code (join_private target
    // for a PRIVATE one) — refreshed on every snapshot so a drop mid-match
    // always resumes into the seat we actually ended up in, not a stale one.
    this.resumeToken = s.you;
    this.roomCode = s.code;
    this.sessionRoomId = s.roomId;
    saveSession(GAME, { playerId: s.you, roomId: s.roomId, code: s.code });

    const myTurn = s.phase === 'playing' && s.currentId === this.playerId;
    if (myTurn && !wasMyTurn) this.audio.sfx('turn');
    if (s.phase === 'playing' && s.rollCount === 0) this.potFlashEl.textContent = '';

    this.renderTable();
  }

  private onRoll(e: Extract<BankEvent, { t: 'roll' }>): void {
    const name = this.nameOf(e.rollerId);
    const sum = e.d1 + e.d2;
    switch (e.effect) {
      case 'bonus70':
        this.pushLog(`${name} rolled 7 → +70 bonus (pot ${e.potAfter})`, 'roll');
        this.flash('+70');
        break;
      case 'double':
        this.pushLog(`${name} rolled doubles → pot doubled to ${e.potAfter}`, 'roll');
        this.flash('×2');
        break;
      case 'bust7':
        this.pushLog(`${name} rolled 7!`, 'bust');
        this.flash('7!');
        break;
      default:
        this.pushLog(`${name} rolled ${sum} → pot ${e.potAfter}`, 'roll');
        this.flash(`+${sum}`);
        break;
    }
    this.audio.sfx('clatter');
    void this.dice.rollTo(e.d1, e.d2, DICE_TUMBLE_MS).catch(() => undefined);
  }

  private onBank(e: Extract<BankEvent, { t: 'bank' }>): void {
    this.pushLog(`${this.nameOf(e.playerId)} BANKED ${e.amount}`, 'bank');
    this.audio.sfx('bank');
  }

  private onRoundEnd(e: Extract<BankEvent, { t: 'round_end' }>): void {
    this.bannerTone = 'none';
    if (e.reason === 'bust7') {
      this.pushLog('7! Round over — the pot is lost', 'bust');
      this.bannerText = '7! POT LOST';
      this.bannerSub = 'everything unbanked is gone';
      this.flash('BUST');
      this.audio.sfx('bust');
    } else {
      this.pushLog('Everyone banked — round over', 'bank');
      this.bannerText = 'ROUND OVER';
      this.bannerSub = 'everyone banked out';
    }
  }

  private onMatchEnd(e: Extract<BankEvent, { t: 'match_end' }>): void {
    if (e.winnerId === null) {
      this.pushLog('Match over — no winner', 'join');
      this.bannerText = 'MATCH OVER';
      this.bannerSub = 'nobody took the table';
      this.bannerTone = 'lose';
    } else {
      const name = this.nameOf(e.winnerId);
      const me = e.winnerId === this.playerId;
      this.pushLog(`${name} WINS THE MATCH`, 'bank');
      this.bannerText = me ? 'YOU WIN!' : `${name.toUpperCase()} WINS!`;
      this.bannerSub = me ? 'you take the table' : 'better luck next hand';
      this.bannerTone = me ? 'win' : 'lose';
      this.audio.sfx(me ? 'win' : 'lose');
    }
  }

  // ---- actions -> screens ------------------------------------------------------------
  private leaveToMenu(notice: string): void {
    this.send({ t: 'leave' });
    // explicit leave: no rejoin back into that room (never on a socket drop —
    // this method only runs from an intentional LEAVE click)
    clearSession(GAME);
    this.resumeToken = null;
    this.roomCode = null;
    this.sessionRoomId = null;
    this.state = null;
    this.stateCode = null;
    this.logLines.length = 0;
    this.bannerText = '';
    this.bannerSub = '';
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

  // ---- rendering ----------------------------------------------------------------------
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
    btn.addEventListener('click', () => {
      this.audio.resume(); // browsers gate AudioContext on a user gesture
      onClick();
    });
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
      this.roomsEl.appendChild(el('div', 'room-empty', 'no tables yet — create one'));
      return;
    }
    for (const room of this.rooms) {
      const row = el('div', 'room-row');
      const title = el('span', 'room-title', room.visibility === 'private' ? 'private table' : 'public table');
      row.appendChild(title);
      row.appendChild(el('span', 'room-label', room.label));
      row.appendChild(el('span', 'room-meta', `${room.players}/${room.maxPlayers} · ${room.phase}`));
      if (room.visibility === 'public') {
        // public rows join by id (join_public); private ones need the code flow
        // hover treatment lives in .room-row / .room-row:hover (style.css) — palette vars only,
        // no inline colour here (VISUAL_UPGRADE §0: no hex/rgba literals outside the palettes)
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => {
          this.audio.resume(); // browsers gate AudioContext on a user gesture
          this.joinPublic(this.menuName(), room.id);
        });
      }
      this.roomsEl.appendChild(row);
    }
  }

  private renderTable(): void {
    const s = this.state;
    if (s === null) return;
    this.variantEl.textContent = variantLabel(s.settings);
    // invite chip: private rooms only (wire code wins; the join-known code is the fallback)
    const inviteCode = this.stateCode ?? this.roomCode;
    this.inviteEl.classList.toggle('hidden', inviteCode === null);
    if (inviteCode !== null) this.inviteCodeEl.textContent = `CODE ${inviteCode}`;
    if (s.settings.raceTarget !== null) {
      const myScore = s.players.find((p) => p.id === this.playerId)?.score ?? 0;
      this.roundEl.textContent = `RACE TO ${s.settings.raceTarget} · ${myScore} / ${s.settings.raceTarget}`;
    } else {
      this.roundEl.textContent = `ROUND ${s.round}/${s.totalRounds}`;
    }
    this.renderPlayers(s);
    this.renderQueue(s);
    this.renderLog();

    // ROLL only on your turn (pulsing); BANK always while unbanked in 'playing'
    const myTurn = s.phase === 'playing' && s.currentId === this.playerId;
    this.rollBtn.classList.toggle('hidden', !myTurn);
    this.rollBtn.classList.toggle('pulse', myTurn);
    this.rollBtn.disabled = !myTurn;
    const me = s.players.find((p) => p.id === this.playerId);
    const canBank = s.phase === 'playing' && me !== undefined && !me.banked;
    this.bankBtn.disabled = !canBank;

    //  START is a lobby-only control. It is shown (not hidden) while the table
    //  is short-handed so the reason is visible — a control that vanishes reads
    //  as a bug, a control that says NEED 1 MORE PLAYER reads as an instruction.
    //  `canStart` is server-authoritative (frozen contract) — never re-derived
    //  client-side, so the button always agrees with what the server will act on.
    this.startBtn.classList.toggle('hidden', s.phase !== 'lobby');
    if (s.phase === 'lobby') {
      this.startBtn.disabled = !s.canStart;
      const short = s.minPlayers - s.playerCount;
      this.startBtn.textContent = s.canStart
        ? 'START MATCH'
        : `NEED ${short} MORE PLAYER${short === 1 ? '' : 'S'}`;
    }

    if (s.phase === 'roundEnd' || s.phase === 'matchEnd') {
      // matchEnd tone comes from the state when the event was missed (a client
      // that joined mid-banner still gets the right win/lose treatment).
      let tone = this.bannerTone;
      if (s.phase === 'matchEnd' && tone === 'none') {
        tone = s.winnerId !== null && s.winnerId === this.playerId ? 'win' : 'lose';
      }
      this.setBanner(this.bannerText, this.bannerSub, s.phase === 'matchEnd' ? tone : 'none', false);
    } else if (s.phase === 'lobby') {
      //  Two very different lobbies wear the same phase, and NEITHER one ever
      //  starts itself — the server never auto-starts a match, cold or
      //  post-match, so both sit idle until somebody presses START.
      //  `awaitingStart` is now COSMETIC ONLY (true = post-match, false =
      //  cold): it only changes the WORDING here, never whether the table is
      //  waiting. `canStart` / `playerCount` / `minPlayers` are all
      //  server-authoritative — never re-derived client-side.
      if (s.awaitingStart) {
        this.setBanner(
          s.canStart ? 'READY WHEN YOU ARE' : 'MATCH COMPLETE',
          s.canStart
            ? `${s.playerCount} seated · anyone can press START`
            : `${s.playerCount} of ${s.minPlayers} seated — waiting for players`,
          'none',
          true,
        );
      } else {
        this.setBanner(
          s.canStart ? 'READY WHEN YOU ARE' : 'WAITING FOR PLAYERS',
          s.canStart
            ? `${s.playerCount} seated · anyone can press START`
            : `${s.playerCount} of ${s.minPlayers} seated`,
          'none',
          true,
        );
      }
    } else {
      this.bannerEl.classList.add('hidden');
      this.bannerEl.classList.remove('banner-win');
      this.bannerEl.classList.remove('banner-lose');
      this.bannerEl.classList.remove('banner-lobby');
    }
  }

  /** Headline + sub-line + win/lose tone on the result banner. */
  private setBanner(main: string, sub: string, tone: BannerTone, isLobby: boolean): void {
    this.bannerMainEl.textContent = main;
    this.bannerSubEl.textContent = sub;
    this.bannerSubEl.classList.toggle('hidden', sub.length === 0);
    this.bannerEl.classList.toggle('banner-win', tone === 'win');
    this.bannerEl.classList.toggle('banner-lose', tone === 'lose');
    //  `banner-lobby` swaps the full-stage scrim+blur (correct for the
    //  TRANSIENT round/match banners) for a compact plate: the lobby is a
    //  state players sit in and interact with (read the rail, press START),
    //  so the table underneath must stay crisp and legible, never blurred.
    this.bannerEl.classList.toggle('banner-lobby', isLobby);
    this.bannerEl.classList.remove('hidden');
  }

  private renderPlayers(s: BankState): void {
    this.playersEl.replaceChildren();
    //  DENSE RAIL — the deliberate answer to MAX_PLAYERS = 32. Full-size chips
    //  are ~150 px wide, so 32 of them wrap to five rows on a 1120 px felt and
    //  eleven on a phone: a wall, not a rail. Past DENSE_SEATS the stylesheet
    //  drops the per-chip prose ('IN' / 'BANKED'), the decorative chip stack
    //  and a chunk of padding, which fits 32 seats into ~4 rows at 1600x900
    //  with no scrolling at all. It is safe to drop the prose because every
    //  state keeps a non-colour cue without it (§5): current = caret + lift +
    //  ring + weight, banked = the ✓ glyph, offline = dashed border. The word
    //  is kept on the current chip, where it is worth the most.
    this.playersEl.classList.toggle('dense', s.players.length > DENSE_SEATS);
    let currentChip: HTMLElement | null = null;
    for (const p of s.players) {
      const isTurn = p.id === s.currentId && s.phase === 'playing';
      const chip = el('div', 'player-chip');
      if (isTurn) currentChip = chip;
      chip.classList.toggle('current', isTurn);
      chip.classList.toggle('you', p.id === this.playerId);
      chip.classList.toggle('offline', !p.connected);

      // avatar: the name's initial, so a chip reads as a seat even at a glance
      chip.appendChild(el('span', 'player-avatar', p.name.trim().charAt(0).toUpperCase() || '?'));

      const name = el('span', 'player-name', p.name);
      if (p.id === this.playerId) name.appendChild(el('span', 'player-you', 'YOU'));
      chip.appendChild(name);

      // decorative chip stack sitting beside the banked total
      const stack = el('span', 'chip-stack');
      stack.setAttribute('aria-hidden', 'true');
      chip.appendChild(stack);
      chip.appendChild(el('span', 'player-score', String(p.score)));
      chip.appendChild(el('span', p.banked ? 'player-banked on' : 'player-banked', p.banked ? '✓' : ''));

      // second, non-colour cue for turn/banked/offline (accessibility, §5)
      // in the lobby a connected seat hasn't "banked" anything yet — 'SEATED'
      // reads as waiting-to-play, where 'IN' (leftover from mid-match wording)
      // would read as mid-round. Same `.player-state` class either way.
      const stateText = !p.connected
        ? 'AWAY'
        : isTurn
          ? 'TURN'
          : p.banked
            ? 'BANKED'
            : s.phase === 'lobby'
              ? 'SEATED'
              : 'IN';
      chip.appendChild(el('span', 'player-state', stateText));

      this.playersEl.appendChild(chip);
    }
    this.keepCurrentChipVisible(currentChip);
  }

  /**
   * At 32 seats the rail can still overflow its cap on a phone, and a rail you
   * have to hunt through is worse than no rail. Nudge the scroll so the roller
   * is always on screen. Scrolls the RAIL only (never `scrollIntoView`, which
   * would drag the page with it), and does nothing when nothing overflows.
   */
  private keepCurrentChipVisible(chip: HTMLElement | null): void {
    const rail = this.playersEl;
    const overflows = rail.scrollHeight > rail.clientHeight;
    // `.scrolls` drives the bottom fade; without it a capped rail cuts its last
    // row in half and reads as a clipping bug rather than as "more below"
    rail.classList.toggle('scrolls', overflows);
    if (chip === null || !overflows) return;
    const top = chip.offsetTop - rail.clientTop;
    const centred = top - (rail.clientHeight - chip.offsetHeight) / 2;
    rail.scrollTop = Math.max(0, Math.min(centred, rail.scrollHeight - rail.clientHeight));
  }

  /**
   * Turn rotation from the current player onward, mirroring the server's
   * `nextTurn()` exactly (`room.ts`): players are walked in JOIN ORDER from the
   * seat after the current one, and a seat is eligible only while it is
   * connected and has not banked. The current player leads the list.
   *
   * Returns at most `PEEK` entries — the queue is an orientation aid, not a
   * second player rail — and an empty array when there is no live rotation.
   */
  private turnOrder(s: BankState): BankPlayerState[] {
    if (s.phase !== 'playing' || s.currentId === null) return [];
    const seats = s.players;
    const from = seats.findIndex((p) => p.id === s.currentId);
    if (from < 0) return [];
    const out: BankPlayerState[] = [];
    const cur = seats[from];
    if (cur !== undefined) out.push(cur);
    for (let step = 1; step < seats.length; step++) {
      const cand = seats[(from + step) % seats.length];
      if (cand !== undefined && cand.connected && !cand.banked) out.push(cand);
    }
    return out;
  }

  /**
   * "UP NEXT" strip: who is rolling now, the next few in rotation, and your own
   * distance from the front. `turnOrder()` is unbounded so the ETA can count
   * past the visible window — at 20 seats "YOU IN 14" is the whole point.
   */
  private renderQueue(s: BankState): void {
    const order = this.turnOrder(s);
    // one live seat (everyone else banked/offline) makes the queue noise
    if (order.length < 2) {
      this.queueEl.classList.add('hidden');
      this.queueListEl.replaceChildren();
      this.queueEtaEl.textContent = '';
      return;
    }
    this.queueEl.classList.remove('hidden');

    this.queueListEl.replaceChildren();
    for (const [i, p] of order.slice(0, QUEUE_PEEK).entries()) {
      const item = el('li', 'turn-queue-item');
      if (i === 0) item.classList.add('now');
      if (p.id === this.playerId) item.classList.add('you');
      // ordinal is the non-colour cue: "NOW" for the roller, then 2 / 3 / 4
      item.appendChild(el('span', 'turn-queue-pos', i === 0 ? 'NOW' : String(i + 1)));
      item.appendChild(el('span', 'turn-queue-name', p.name));
      this.queueListEl.appendChild(item);
    }
    // "+N" tail so a 20-seat table reads as deep rather than as four players
    const rest = order.length - QUEUE_PEEK;
    if (rest > 0) {
      const more = el('li', 'turn-queue-item turn-queue-more');
      more.appendChild(el('span', 'turn-queue-pos', `+${rest}`));
      this.queueListEl.appendChild(more);
    }

    // `mine` is the player's true depth in the rotation, not their depth in the
    // visible window — at 32 seats that number is the single most useful string
    // on the screen for the ~30 people who will not roll this round.
    const mine = order.findIndex((p) => p.id === this.playerId);
    const me = s.players.find((p) => p.id === this.playerId);
    let eta: string;
    if (mine === 0) eta = 'YOUR TURN';
    else if (me !== undefined && me.banked) eta = 'BANKED — SITTING OUT';
    else if (mine < 0) eta = 'WATCHING';
    else if (mine === 1) eta = 'YOU ROLL NEXT';
    else eta = `YOU ROLL IN ~${mine} TURNS`;
    this.queueEtaEl.textContent = eta;
    this.queueEtaEl.classList.toggle('soon', mine >= 0 && mine <= 1);
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
    if (this.screen === 'table') this.renderLog();
  }

  private flash(text: string): void {
    this.potFlashEl.textContent = text;
  }

  /** Copies the invite link; navigator.clipboard first, textarea fallback. */
  private copyInvite(): void {
    const code = this.stateCode ?? this.roomCode;
    if (code === null) return;
    const url = `${location.origin}/bank/?code=${code}`;
    const clip: Clipboard | undefined = navigator.clipboard;
    if (clip !== undefined) {
      clip.writeText(url).then(
        () => this.showCopied(),
        () => this.copyInviteFallback(url), // denied (permissions/insecure ctx): fallback path
      );
    } else {
      this.copyInviteFallback(url);
    }
  }

  /** Pre-clipboard-era path: hidden textarea + execCommand('copy'). */
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

  /** Brief 'COPIED' label on the copy button. */
  private showCopied(): void {
    this.copyBtn.textContent = 'COPIED';
    window.clearTimeout(this.copiedTimer);
    this.copiedTimer = window.setTimeout(() => {
      this.copyBtn.textContent = 'COPY INVITE';
    }, 1200);
  }

  private nameOf(id: string): string {
    return this.state?.players.find((p) => p.id === id)?.name ?? 'Someone';
  }

  private settleDice(d1: number, d2: number): void {
    const [f1, f2] = this.dice.faces();
    if (f1 !== d1 || f2 !== d2) void this.dice.rollTo(d1, d2, 0).catch(() => undefined);
  }

  /** Pot counter + turn timer; runs on a fixed interval so it survives tab blur. */
  private tick(): void {
    if (this.potShown !== this.potTarget) {
      const diff = this.potTarget - this.potShown;
      if (diff <= 0 || diff < 1) {
        this.potShown = this.potTarget; // pot never animates DOWN (reset/new round snaps)
      } else {
        this.potShown += Math.max(1, Math.ceil(diff * POT_STEP));
      }
      this.potEl.textContent = String(this.potShown);
    }
    const s = this.state;
    if (s !== null && s.phase === 'playing' && s.turnEndsAt > 0) {
      const remain = Math.max(0, s.turnEndsAt - this.serverNow());
      const frac = Math.min(1, remain / (TURN_SECONDS * 1000));
      this.timerFillEl.style.width = `${frac * 100}%`;
      this.timerFillEl.classList.toggle('low', frac < TIMER_LOW_FRAC);
    } else {
      this.timerFillEl.style.width = '0%';
      this.timerFillEl.classList.remove('low');
    }
  }

  private debugState(): BankDebugState {
    const s = this.state;
    if (s === null) {
      return {
        phase: 'none',
        settings: null,
        round: 0,
        pot: 0,
        rollCount: 0,
        currentId: null,
        you: this.playerId,
        players: [],
        score: 0,
        code: this.stateCode ?? this.roomCode,
        resume: this.resumeToken,
        awaitingStart: false,
        canStart: false,
        playerCount: 0,
      };
    }
    const me = s.players.find((p) => p.id === this.playerId);
    return {
      phase: s.phase,
      settings: { ...s.settings },
      round: s.round,
      pot: s.pot,
      rollCount: s.rollCount,
      currentId: s.currentId,
      you: this.playerId,
      players: s.players.map((p) => ({ ...p })),
      score: me?.score ?? 0,
      code: this.stateCode ?? this.roomCode,
      resume: this.resumeToken,
      awaitingStart: s.awaitingStart,
      canStart: s.canStart,
      playerCount: s.playerCount,
    };
  }
}
