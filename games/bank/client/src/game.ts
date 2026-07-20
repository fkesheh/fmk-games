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
  if (!str(v.you) || !Array.isArray(v.players)) return null;
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
}

interface BankApi {
  state(): BankDebugState;
  joinQuick(name: string): void;
  createPublic(name: string, settings?: BankSettings): void;
  createPrivate(name: string, settings?: BankSettings): void;
  joinPrivate(name: string, code: string): void;
  roll(): void;
  bank(): void;
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
const NAME_MAX = 16; // lobby cleanName cap (platform protocol)
const CODE_MAX = 8;
const DICE_TUMBLE_MS = 600; // tumble frames before the dice settle on d1/d2
const RESUME_KEY = 'bank.resume'; // localStorage: { playerId, code } rejoin record
const NAME_KEY = 'bank.name'; // localStorage: last joined name (invite-link auto-join)

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

/** Trimmed, length-capped display name; 'Player' when whitespace-only (lobby rule). */
function cleanName(v: string): string {
  return v.trim().slice(0, NAME_MAX) || 'Player';
}

/** Variant chip text, mirroring the server's info().label (docs/BANK.md). */
function variantLabel(s: BankSettings): string {
  const bonus = s.sevenBonus ? '7=70' : 'plain 7';
  return s.raceTarget !== null ? `race to ${s.raceTarget} · ${bonus}` : `${s.totalRounds} rounds · ${bonus}`;
}

export class BankGame {
  private ws: WebSocket | null = null;
  private welcomed = false;
  private playerId: string | null = null;
  private resumeToken: string | null = null; // rejoin token loaded from localStorage
  private roomCode: string | null = null; // code of the room we're in/joining, when known
  private state: BankState | null = null;
  private stateCode: string | null = null; // private-room code piggybacked on bank_state
  private pendingJoin: { name: string; code: string } | null = null; // invite-link auto-join
  private copiedTimer = 0; // 'COPIED' feedback reset handle
  private rooms: RoomInfo[] = [];
  private screen: 'menu' | 'table' = 'menu';
  private readonly logLines: string[] = [];
  private bannerText = '';
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
  private readonly playersEl: HTMLDivElement;
  private readonly logEl: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly rollBtn: HTMLButtonElement;
  private readonly bankBtn: HTMLButtonElement;

  constructor(root: HTMLElement) {
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
    this.menuEl.appendChild(this.nameInput);

    // ---- create-section variant picker (docs/BANK.md "VARIANT UI") -----------
    const options = el('div', 'menu-options');
    options.style.display = 'flex';
    options.style.flexWrap = 'wrap';
    options.style.justifyContent = 'center';
    options.style.alignItems = 'center';
    options.style.gap = '14px';
    options.style.fontSize = '14px';
    options.style.color = 'var(--cream-dim)';

    const sevenLabel = el('label');
    sevenLabel.style.display = 'flex';
    sevenLabel.style.alignItems = 'center';
    sevenLabel.style.gap = '6px';
    sevenLabel.style.cursor = 'pointer';
    this.sevenBonusInput = el('input');
    this.sevenBonusInput.type = 'checkbox';
    this.sevenBonusInput.checked = true; // canonical default (DEFAULT_SETTINGS)
    this.sevenBonusInput.style.accentColor = 'var(--gold)';
    sevenLabel.appendChild(this.sevenBonusInput);
    sevenLabel.appendChild(document.createTextNode('7 = 70 in first 3 rolls'));
    options.appendChild(sevenLabel);

    this.lengthSelect = el('select');
    this.lengthSelect.style.padding = '8px 10px';
    this.lengthSelect.style.border = '1px solid var(--gold-deep)';
    this.lengthSelect.style.borderRadius = '8px';
    this.lengthSelect.style.background = '#101c15';
    this.lengthSelect.style.color = 'var(--cream)';
    this.lengthSelect.style.fontSize = '14px';
    this.lengthSelect.style.outline = 'none';
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
    this.variantEl.style.padding = '4px 12px';
    this.variantEl.style.border = '1px solid var(--gold-deep)';
    this.variantEl.style.borderRadius = '999px';
    this.variantEl.style.fontSize = '12px';
    this.variantEl.style.letterSpacing = '0.18em';
    this.variantEl.style.color = 'var(--gold-bright)';
    this.variantEl.style.textTransform = 'uppercase';
    topBar.appendChild(this.variantEl);
    // invite chip (private rooms only): 'CODE XXXXX' + copyable invite link
    this.inviteEl = el('div', 'table-invite hidden');
    this.inviteEl.style.display = 'flex';
    this.inviteEl.style.alignItems = 'center';
    this.inviteEl.style.gap = '8px';
    this.inviteCodeEl = el('span', 'table-invite-code');
    this.inviteCodeEl.style.padding = '4px 12px';
    this.inviteCodeEl.style.border = '1px solid var(--gold-deep)';
    this.inviteCodeEl.style.borderRadius = '999px';
    this.inviteCodeEl.style.fontSize = '12px';
    this.inviteCodeEl.style.letterSpacing = '0.18em';
    this.inviteCodeEl.style.color = 'var(--gold-bright)';
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

    const felt = el('div', 'felt');
    felt.appendChild(el('div', 'pot-label', 'POT'));
    this.potEl = el('div', 'pot-value', '0');
    felt.appendChild(this.potEl);
    this.potFlashEl = el('div', 'pot-flash');
    felt.appendChild(this.potFlashEl);
    const diceArea = el('div', 'dice-area');
    felt.appendChild(diceArea);
    const timerBar = el('div', 'timer-bar');
    this.timerFillEl = el('div', 'timer-fill');
    timerBar.appendChild(this.timerFillEl);
    felt.appendChild(timerBar);
    this.tableEl.appendChild(felt);

    this.playersEl = el('div', 'player-rail');
    this.tableEl.appendChild(this.playersEl);

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
    actions.appendChild(this.rollBtn);
    actions.appendChild(this.bankBtn);
    this.tableEl.appendChild(actions);

    this.logEl = el('div', 'event-log');
    this.tableEl.appendChild(this.logEl);

    this.bannerEl = el('div', 'table-banner hidden');
    this.tableEl.appendChild(this.bannerEl);

    root.appendChild(this.menuEl);
    root.appendChild(this.tableEl);

    this.dice = new DiceView(diceArea);

    // ---- timers (setInterval everywhere: rAF pauses in background tabs) --------
    window.setInterval(() => this.tick(), TICK_MS);
    window.setInterval(() => {
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
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
    };

    // ---- rejoin record (token captured BEFORE welcome overwrites storage) ------
    this.loadResume();
    if (this.roomCode !== null) this.codeInput.value = this.roomCode; // stored-code prefill

    // ---- invite link (?code=XXXXX): prefill + auto-join, then strip the param ----
    const linkCode = new URLSearchParams(location.search).get('code');
    if (linkCode !== null && linkCode.length > 0) {
      history.replaceState(null, '', location.pathname + location.hash); // no re-trigger on refresh
      this.codeInput.value = linkCode; // link code beats the stored-code prefill
      const name = this.storedName();
      if (name !== null) this.pendingJoin = { name, code: linkCode }; // attempted after welcome
    }

    this.connect();
    this.renderMenu();
  }

  // ---- connection ---------------------------------------------------------------
  private connect(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
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
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg)); // the wire is plain JSON
    } catch {
      // racing a close — drop the frame
    }
  }

  private serverNow(): number {
    return Date.now() + this.offset;
  }

  // ---- rejoin record (localStorage 'bank.resume': { playerId, code }) -----------
  /** Reads the stored record once at startup; corrupt/blocked storage is non-fatal. */
  private loadResume(): void {
    try {
      const raw = localStorage.getItem(RESUME_KEY);
      if (raw === null) return;
      const v: unknown = JSON.parse(raw);
      if (!isObj(v)) return;
      if (str(v.playerId)) this.resumeToken = v.playerId;
      if (str(v.code)) this.roomCode = v.code;
    } catch {
      // storage blocked or corrupt JSON — play without rejoin
    }
  }

  /** Writes { playerId, code } — after every welcome and after joining a room. */
  private persistResume(): void {
    if (this.playerId === null) return;
    try {
      localStorage.setItem(
        RESUME_KEY,
        JSON.stringify({ playerId: this.playerId, code: this.roomCode }),
      );
    } catch {
      // storage blocked — non-fatal
    }
  }

  /** Drops the whole record on an explicit leave (the ghost is removed, not kept). */
  private clearResume(): void {
    this.resumeToken = null;
    this.roomCode = null;
    try {
      localStorage.removeItem(RESUME_KEY);
    } catch {
      // storage blocked — non-fatal
    }
  }

  // ---- last-joined name (localStorage 'bank.name') ------------------------------
  /** The stored name for the invite-link auto-join; blocked storage => null. */
  private storedName(): string | null {
    try {
      const v = localStorage.getItem(NAME_KEY);
      return v !== null && v.trim().length > 0 ? v : null;
    } catch {
      return null; // storage blocked — no auto-join
    }
  }

  /** Remembers the cleaned name on every join so an invite link can auto-join later. */
  private persistName(name: string): void {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // storage blocked — non-fatal
    }
  }

  // ---- lobby actions (game filter 'bank' on every create/join) -------------------
  // Every join flow carries the stored rejoin token when we have one; the server
  // re-binds a disconnected ghost entry with that id (docs/BANK.md "Rejoin").
  private joinQuick(name: string): void {
    const msg: Extract<LobbyC2S, { t: 'quick_join' }> = {
      t: 'quick_join',
      name: cleanName(name),
      game: 'bank',
    };
    if (this.resumeToken !== null) msg.resume = this.resumeToken;
    this.roomCode = null; // public room: no code
    this.persistName(msg.name);
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
      game: 'bank',
      settings: { sevenBonus: s.sevenBonus, totalRounds: s.totalRounds, raceTarget: s.raceTarget },
    };
    if (this.resumeToken !== null) msg.resume = this.resumeToken;
    this.roomCode = null; // public room: no code
    this.persistName(msg.name);
    this.send(msg);
  }
  private createPrivate(name: string, settings?: BankSettings): void {
    const s = settings ?? this.menuSettings();
    const msg: Extract<LobbyC2S, { t: 'create_private' }> = {
      t: 'create_private',
      name: cleanName(name),
      game: 'bank',
      settings: { sevenBonus: s.sevenBonus, totalRounds: s.totalRounds, raceTarget: s.raceTarget },
    };
    if (this.resumeToken !== null) msg.resume = this.resumeToken;
    this.roomCode = null; // the code is server-generated; not known client-side
    this.persistName(msg.name);
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
    if (this.resumeToken !== null) msg.resume = this.resumeToken;
    this.roomCode = c; // candidate; a 'no_room' error clears it again
    this.persistName(msg.name);
    this.send(msg);
  }
  private roll(): void {
    this.send({ t: 'roll' });
  }
  private bank(): void {
    this.send({ t: 'bank' });
  }

  // ---- message routing -------------------------------------------------------------
  private onMessage(msg: S2C): void {
    switch (msg.t) {
      case 'welcome':
        this.playerId = msg.playerId;
        this.welcomed = true;
        this.persistResume(); // fresh session id for the next page load
        this.send({ t: 'list_rooms' });
        this.setNotice('');
        this.renderMenu();
        if (this.pendingJoin !== null) {
          const { name, code } = this.pendingJoin;
          this.pendingJoin = null; // single attempt — on failure the error notice shows
          this.joinPrivate(name, code);
        }
        break;
      case 'room_list':
        this.rooms = msg.rooms.filter((r) => r.game === 'bank'); // bank-only room list
        if (this.screen === 'menu') this.renderRooms();
        break;
      case 'pong': {
        const rtt = performance.now() - msg.ts;
        if (rtt >= 0) this.offset = msg.serverTime + rtt / 2 - Date.now();
        break;
      }
      case 'error':
        if (msg.code === 'no_room' && this.roomCode !== null) {
          this.roomCode = null; // stale room — drop the stored code (token stays)
          this.persistResume();
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
        this.pushLog(`${this.nameOf(msg.playerId)} timed out — auto-roll`);
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
      this.pushLog('You joined the table');
      if (s.lastRoll !== null) this.settleDice(s.lastRoll.d1, s.lastRoll.d2);
      if (this.playerId !== null) {
        // joined: a rebind makes the CURRENT session id the valid rejoin token
        this.resumeToken = this.playerId;
        this.persistResume();
      }
    }
    // matchEnd -> lobby is the server's full reset: banner has been shown, auto-return
    if (prevPhase === 'matchEnd' && s.phase === 'lobby') {
      this.leaveToMenu('Match over.');
      return;
    }
    this.state = s;
    this.stateCode = code; // refreshed every snapshot; drives the invite chip
    this.potTarget = s.pot;

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
        this.pushLog(`${name} rolled 7 → +70 bonus (pot ${e.potAfter})`);
        this.flash('+70');
        break;
      case 'double':
        this.pushLog(`${name} rolled doubles → pot doubled to ${e.potAfter}`);
        this.flash('×2');
        break;
      case 'bust7':
        this.pushLog(`${name} rolled 7!`);
        this.flash('7!');
        break;
      default:
        this.pushLog(`${name} rolled ${sum} → pot ${e.potAfter}`);
        this.flash(`+${sum}`);
        break;
    }
    this.audio.sfx('clatter');
    void this.dice.rollTo(e.d1, e.d2, DICE_TUMBLE_MS).catch(() => undefined);
  }

  private onBank(e: Extract<BankEvent, { t: 'bank' }>): void {
    this.pushLog(`${this.nameOf(e.playerId)} BANKED ${e.amount}`);
    this.audio.sfx('bank');
  }

  private onRoundEnd(e: Extract<BankEvent, { t: 'round_end' }>): void {
    if (e.reason === 'bust7') {
      this.pushLog('7! Round over — the pot is lost');
      this.bannerText = '7! POT LOST';
      this.flash('BUST');
      this.audio.sfx('bust');
    } else {
      this.pushLog('Everyone banked — round over');
      this.bannerText = 'ROUND OVER';
    }
  }

  private onMatchEnd(e: Extract<BankEvent, { t: 'match_end' }>): void {
    if (e.winnerId === null) {
      this.pushLog('Match over — no winner');
      this.bannerText = 'MATCH OVER';
    } else {
      const name = this.nameOf(e.winnerId);
      const me = e.winnerId === this.playerId;
      this.pushLog(`${name} WINS THE MATCH`);
      this.bannerText = me ? 'YOU WIN!' : `${name.toUpperCase()} WINS!`;
      this.audio.sfx(me ? 'win' : 'lose');
    }
  }

  // ---- actions -> screens ------------------------------------------------------------
  private leaveToMenu(notice: string): void {
    this.send({ t: 'leave' });
    this.clearResume(); // explicit leave: no rejoin back into that room
    this.state = null;
    this.stateCode = null;
    this.logLines.length = 0;
    this.bannerText = '';
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
    this.renderLog();

    // ROLL only on your turn (pulsing); BANK always while unbanked in 'playing'
    const myTurn = s.phase === 'playing' && s.currentId === this.playerId;
    this.rollBtn.classList.toggle('hidden', !myTurn);
    this.rollBtn.classList.toggle('pulse', myTurn);
    this.rollBtn.disabled = !myTurn;
    const me = s.players.find((p) => p.id === this.playerId);
    const canBank = s.phase === 'playing' && me !== undefined && !me.banked;
    this.bankBtn.disabled = !canBank;

    if (s.phase === 'roundEnd' || s.phase === 'matchEnd') {
      this.bannerEl.textContent = this.bannerText;
      this.bannerEl.classList.remove('hidden');
      this.bannerEl.classList.toggle('banner-win', s.phase === 'matchEnd');
    } else if (s.phase === 'lobby') {
      const connected = s.players.filter((p) => p.connected).length;
      this.bannerEl.textContent = `WAITING FOR PLAYERS ${connected}/${MIN_PLAYERS}`;
      this.bannerEl.classList.remove('hidden');
      this.bannerEl.classList.remove('banner-win');
    } else {
      this.bannerEl.classList.add('hidden');
      this.bannerEl.classList.remove('banner-win');
    }
  }

  private renderPlayers(s: BankState): void {
    this.playersEl.replaceChildren();
    for (const p of s.players) {
      const chip = el('div', 'player-chip');
      chip.classList.toggle('current', p.id === s.currentId && s.phase === 'playing');
      chip.classList.toggle('you', p.id === this.playerId);
      chip.classList.toggle('offline', !p.connected);
      const name = el('span', 'player-name', p.name);
      if (p.id === this.playerId) name.appendChild(el('span', 'player-you', 'YOU'));
      chip.appendChild(name);
      chip.appendChild(el('span', 'player-score', String(p.score)));
      chip.appendChild(el('span', p.banked ? 'player-banked on' : 'player-banked', p.banked ? '✓' : ''));
      this.playersEl.appendChild(chip);
    }
  }

  private renderLog(): void {
    this.logEl.replaceChildren();
    for (const line of this.logLines) {
      this.logEl.appendChild(el('div', 'log-line', line));
    }
  }

  private pushLog(text: string): void {
    this.logLines.unshift(text); // newest first
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
      this.timerFillEl.classList.toggle('low', remain < 5000);
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
    };
  }
}
