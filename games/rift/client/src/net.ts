// ============================================================================
// ANCIENTS (rift) — NET (T8). One `/ws` socket, wordbomb-style: send is a
// no-op unless OPEN, malformed frames are dropped (never thrown on wire data),
// clock offset comes from the platform ping/pong, and a dropped socket
// reconnects with exponential backoff (game.ts re-seats via `rift.resume`).
//
// Parse coverage: the four platform lobby messages plus every RiftS2C and
// RiftEvent (events arrive inside the platform envelope {t:'event', ev} and
// are unwrapped here). pong is consumed internally for clock sync and never
// forwarded. Unknown tags are dropped in silence — the server may be newer.
// ============================================================================
import { NET } from '@platform/shared';
import type { LobbyC2S, RoomInfo } from '@platform/shared';
import { isHeroId, isItemId } from '@rift/shared';
import type {
  AbilitySnap,
  BoardEntry,
  EndReason,
  EntKind,
  EntSnap,
  HeroId,
  Phase,
  PlayerStats,
  RiftC2S,
  RiftEvent,
  RiftS2C,
  RosterEntry,
  StructureKind,
  TeamId,
  YouSnap,
} from '@rift/shared';

// ---- parsed message surface ----------------------------------------------------
export type NetMsg =
  | { readonly t: 'welcome'; readonly playerId: string }
  | { readonly t: 'room_list'; readonly rooms: readonly RoomInfo[] }
  | { readonly t: 'error'; readonly code: string; readonly message: string }
  | RiftS2C
  | RiftEvent;

export interface NetHooks {
  onMessage(msg: NetMsg): void;
  /** The socket dropped (state already torn down); a reconnect is scheduled. */
  onClose(): void;
}

export interface NetHandle {
  /** No-op unless the socket is OPEN (mirrors the server's Session.send). */
  send(msg: LobbyC2S | RiftC2S): void;
  /** Server-clock estimate: Date.now() + ping/pong offset. */
  serverNow(): number;
  readonly connected: boolean;
  /** Every raw decoded frame this socket has received (ring, debug surface). */
  messageLog(): readonly unknown[];
}

// ---- tuning --------------------------------------------------------------------
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const MSG_LOG_MAX = 4000;

// ---- wire parsing (platform style: invalid => null, never throw) ----------------
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
function teamOf(v: unknown): TeamId | null {
  return v === 0 || v === 1 ? v : null;
}
function phaseOf(v: unknown): Phase | null {
  return v === 'lobby' || v === 'live' || v === 'ended' ? v : null;
}
function entKindOf(v: unknown): EntKind | null {
  switch (v) {
    case 'hero':
    case 'melee':
    case 'ranged':
    case 'siege':
    case 'shade':
    case 'tower':
    case 'guard':
    case 'ancient':
    case 'ward':
    case 'proj':
      return v;
    default:
      return null;
  }
}
function structureKindOf(v: unknown): StructureKind | null {
  return v === 'tower' || v === 'guard' || v === 'ancient' ? v : null;
}
function endReasonOf(v: unknown): EndReason | null {
  return v === 'ancient' || v === 'tiebreak' || v === 'draw' ? v : null;
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

function parseRoster(v: unknown): RosterEntry[] | null {
  if (!Array.isArray(v)) return null;
  const out: RosterEntry[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !str(raw.id) || !str(raw.name)) return null;
    const team = teamOf(raw.team);
    if (team === null || !bool(raw.bot) || !bool(raw.connected)) return null;
    if (!(isHeroId(raw.pick) || raw.pick === null)) return null;
    out.push({ id: raw.id, name: raw.name, team, bot: raw.bot, connected: raw.connected, pick: raw.pick });
  }
  return out;
}

function parseBoard(v: unknown): BoardEntry[] | null {
  if (!Array.isArray(v)) return null;
  const out: BoardEntry[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !str(raw.id) || !isHeroId(raw.hero)) return null;
    const team = teamOf(raw.team);
    if (team === null) return null;
    if (!num(raw.level) || !num(raw.kills) || !num(raw.deaths) || !num(raw.assists)) return null;
    if (!bool(raw.bot) || !bool(raw.connected)) return null;
    out.push({
      id: raw.id,
      hero: raw.hero,
      team,
      level: raw.level,
      kills: raw.kills,
      deaths: raw.deaths,
      assists: raw.assists,
      bot: raw.bot,
      connected: raw.connected,
    });
  }
  return out;
}

function parseEnt(v: unknown): EntSnap | null {
  if (!isObj(v) || !num(v.id)) return null;
  const k = entKindOf(v.k);
  const team = teamOf(v.team);
  if (k === null || team === null) return null;
  if (!num(v.x) || !num(v.z) || !num(v.hp) || !num(v.maxHp)) return null;
  const out: EntSnap = { id: v.id, k, team, x: v.x, z: v.z, hp: v.hp, maxHp: v.maxHp };
  if (v.lvl !== undefined) {
    if (!num(v.lvl)) return null;
    out.lvl = v.lvl;
  }
  if (v.hero !== undefined) {
    if (!isHeroId(v.hero)) return null;
    out.hero = v.hero;
  }
  if (v.pid !== undefined) {
    if (!str(v.pid)) return null;
    out.pid = v.pid;
  }
  if (v.tx !== undefined) {
    if (!num(v.tx)) return null;
    out.tx = v.tx;
  }
  if (v.tz !== undefined) {
    if (!num(v.tz)) return null;
    out.tz = v.tz;
  }
  if (v.fx !== undefined) {
    if (!str(v.fx)) return null;
    out.fx = v.fx;
  }
  if (v.atk !== undefined) {
    if (!num(v.atk)) return null;
    out.atk = v.atk;
  }
  return out;
}

function parseAbilitySnap(v: unknown): AbilitySnap | null {
  if (!isObj(v) || !num(v.rank) || !num(v.cdUntilTick)) return null;
  return { rank: v.rank, cdUntilTick: v.cdUntilTick };
}

function parseYou(v: unknown): YouSnap | null {
  if (!isObj(v) || !isHeroId(v.hero)) return null;
  if (!num(v.x) || !num(v.z) || !num(v.hp) || !num(v.maxHp)) return null;
  if (!num(v.mana) || !num(v.maxMana)) return null;
  if (!num(v.level) || !num(v.xp) || !num(v.gold)) return null;
  if (!num(v.kills) || !num(v.deaths) || !num(v.assists)) return null;
  if (!num(v.skillPoints) || !num(v.respawnAtTick)) return null;
  if (!Array.isArray(v.abilities) || v.abilities.length !== 4) return null;
  const abilities: AbilitySnap[] = [];
  for (const raw of v.abilities) {
    const a = parseAbilitySnap(raw);
    if (a === null) return null;
    abilities.push(a);
  }
  if (!Array.isArray(v.items) || v.items.length !== 6) return null;
  const items: (YouSnap['items'][number])[] = [];
  for (const raw of v.items) {
    if (!(isItemId(raw) || raw === null)) return null;
    items.push(raw);
  }
  if (!Array.isArray(v.itemCharges) || v.itemCharges.length !== 6) return null;
  if (!Array.isArray(v.itemCdUntilTick) || v.itemCdUntilTick.length !== 6) return null;
  const itemCharges: number[] = [];
  const itemCdUntilTick: number[] = [];
  for (const raw of v.itemCharges) {
    if (!num(raw)) return null;
    itemCharges.push(raw);
  }
  for (const raw of v.itemCdUntilTick) {
    if (!num(raw)) return null;
    itemCdUntilTick.push(raw);
  }
  return {
    hero: v.hero,
    x: v.x,
    z: v.z,
    hp: v.hp,
    maxHp: v.maxHp,
    mana: v.mana,
    maxMana: v.maxMana,
    level: v.level,
    xp: v.xp,
    gold: v.gold,
    kills: v.kills,
    deaths: v.deaths,
    assists: v.assists,
    skillPoints: v.skillPoints,
    respawnAtTick: v.respawnAtTick,
    abilities,
    items,
    itemCharges,
    itemCdUntilTick,
  };
}

function parsePicks(v: unknown): Record<string, HeroId | null> | null {
  if (!isObj(v)) return null;
  const out: Record<string, HeroId | null> = {};
  for (const [key, raw] of Object.entries(v)) {
    if (!(isHeroId(raw) || raw === null)) return null;
    out[key] = raw;
  }
  return out;
}

function parseLaneAssignment(v: unknown): Record<string, number> | null {
  if (!isObj(v)) return null;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(v)) {
    if (!num(raw)) return null;
    out[key] = raw;
  }
  return out;
}

function parseStats(v: unknown): PlayerStats[] | null {
  if (!Array.isArray(v)) return null;
  const out: PlayerStats[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !str(raw.id) || !str(raw.name) || !isHeroId(raw.hero)) return null;
    const team = teamOf(raw.team);
    if (team === null) return null;
    if (!num(raw.kills) || !num(raw.deaths) || !num(raw.assists)) return null;
    if (!num(raw.goldEarned) || !num(raw.heroDamage) || !num(raw.structureDamage)) return null;
    out.push({
      id: raw.id,
      name: raw.name,
      hero: raw.hero,
      team,
      kills: raw.kills,
      deaths: raw.deaths,
      assists: raw.assists,
      goldEarned: raw.goldEarned,
      heroDamage: raw.heroDamage,
      structureDamage: raw.structureDamage,
    });
  }
  return out;
}

/** One event inside the platform envelope, or null (dropped in silence). */
function parseEvent(raw: Record<string, unknown>): RiftEvent | null {
  switch (raw.t) {
    case 'rift_kill': {
      if (!(str(raw.killer) || raw.killer === null) || !str(raw.victim)) return null;
      if (!num(raw.gold) || !bool(raw.firstBlood)) return null;
      return { t: 'rift_kill', killer: raw.killer, victim: raw.victim, gold: raw.gold, firstBlood: raw.firstBlood };
    }
    case 'rift_structure': {
      const team = teamOf(raw.team);
      const kind = structureKindOf(raw.kind);
      if (team === null || kind === null) return null;
      if (!(num(raw.lane) || raw.lane === null)) return null;
      return { t: 'rift_structure', team, kind, lane: raw.lane };
    }
    case 'rift_surge':
      return { t: 'rift_surge' };
    case 'rift_pick': {
      if (!str(raw.id)) return null;
      if (!(isHeroId(raw.hero) || raw.hero === null)) return null;
      return { t: 'rift_pick', id: raw.id, hero: raw.hero };
    }
    case 'rift_roster': {
      const roster = parseRoster(raw.roster);
      return roster === null ? null : { t: 'rift_roster', roster };
    }
    case 'rift_cast': {
      if (!num(raw.id) || !num(raw.slot) || !num(raw.x) || !num(raw.z)) return null;
      return { t: 'rift_cast', id: raw.id, slot: raw.slot, x: raw.x, z: raw.z };
    }
    case 'rift_end': {
      const winner = teamOf(raw.winner);
      if (winner === null && raw.winner !== null) return null;
      const reason = endReasonOf(raw.reason);
      const stats = parseStats(raw.stats);
      if (reason === null || stats === null) return null;
      return { t: 'rift_end', winner, reason, stats };
    }
    default:
      return null;
  }
}

function parseS2C(raw: unknown): NetMsg | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'welcome':
      return str(raw.playerId) ? { t: 'welcome', playerId: raw.playerId } : null;
    case 'room_list': {
      if (!Array.isArray(raw.rooms)) return null;
      const rooms: RoomInfo[] = [];
      for (const r of raw.rooms) {
        const room = parseRoomInfo(r);
        if (room !== null) rooms.push(room); // skip bad rows, keep the good ones
      }
      return { t: 'room_list', rooms };
    }
    case 'error':
      return str(raw.code) && str(raw.message)
        ? { t: 'error', code: raw.code, message: raw.message }
        : null;
    case 'rift_hello': {
      if (!str(raw.you) || !str(raw.roomId)) return null;
      if (!(str(raw.code) || raw.code === null)) return null;
      const team = teamOf(raw.team);
      if (team === null || !num(raw.teamSize)) return null;
      const roster = parseRoster(raw.roster);
      if (roster === null) return null;
      return { t: 'rift_hello', you: raw.you, roomId: raw.roomId, code: raw.code, team, teamSize: raw.teamSize, roster };
    }
    case 'rift_lobby': {
      if (!num(raw.seated) || !num(raw.humans) || !num(raw.minPlayers)) return null;
      if (!bool(raw.canStart) || !num(raw.teamSize) || !num(raw.countdownEndsAt)) return null;
      const picks = parsePicks(raw.picks);
      if (picks === null) return null;
      return {
        t: 'rift_lobby',
        seated: raw.seated,
        humans: raw.humans,
        minPlayers: raw.minPlayers,
        canStart: raw.canStart,
        teamSize: raw.teamSize,
        picks,
        countdownEndsAt: raw.countdownEndsAt,
      };
    }
    case 'rift_begin': {
      if (!num(raw.lanes) || !num(raw.teamSize) || !num(raw.startAtTick)) return null;
      const laneAssignment = parseLaneAssignment(raw.laneAssignment);
      if (laneAssignment === null) return null;
      return { t: 'rift_begin', lanes: raw.lanes, teamSize: raw.teamSize, startAtTick: raw.startAtTick, laneAssignment };
    }
    case 'rift_snap': {
      const phase = phaseOf(raw.phase);
      if (phase === null) return null;
      if (!num(raw.tick) || !num(raw.serverTime) || !num(raw.matchTick)) return null;
      if (!bool(raw.overtime) || !num(raw.wardStock)) return null;
      if (!Array.isArray(raw.kills) || raw.kills.length !== 2 || !num(raw.kills[0]) || !num(raw.kills[1])) return null;
      const board = parseBoard(raw.board);
      if (board === null) return null;
      if (!(isObj(raw.you) || raw.you === null)) return null;
      const you = raw.you === null ? null : parseYou(raw.you);
      if (raw.you !== null && you === null) return null;
      if (!Array.isArray(raw.ents)) return null;
      const ents: EntSnap[] = [];
      for (const rawEnt of raw.ents) {
        const e = parseEnt(rawEnt);
        if (e === null) return null;
        ents.push(e);
      }
      return {
        t: 'rift_snap',
        tick: raw.tick,
        serverTime: raw.serverTime,
        phase,
        matchTick: raw.matchTick,
        overtime: raw.overtime,
        wardStock: raw.wardStock,
        kills: [raw.kills[0], raw.kills[1]],
        board,
        you,
        ents,
      };
    }
    case 'event':
      // the platform wraps game events as {t:'event', ev} (platform convention)
      return isObj(raw.ev) ? parseEvent(raw.ev) : null;
    default:
      return null; // unknown envelope: drop, never throw on wire data
  }
}

// ---- the handle -------------------------------------------------------------------
export function createNet(hooks: NetHooks): NetHandle {
  let ws: WebSocket | null = null;
  let offset = 0; // serverNow = Date.now() + offset
  let backoffMs = RECONNECT_BASE_MS;
  const log: unknown[] = [];

  function connect(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const sock = new WebSocket(url);
    ws = sock;
    sock.onmessage = (ev: MessageEvent) => {
      if (ws !== sock || typeof ev.data !== 'string') return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(ev.data) as unknown;
      } catch {
        return; // malformed frame: drop, never throw
      }
      log.push(decoded);
      if (log.length > MSG_LOG_MAX) log.shift();
      // Clock sync is consumed here: pong never reaches the game.
      if (isObj(decoded) && decoded.t === 'pong' && num(decoded.ts) && num(decoded.serverTime)) {
        const rtt = performance.now() - decoded.ts;
        if (rtt >= 0) offset = decoded.serverTime + rtt / 2 - Date.now();
        return;
      }
      const msg = parseS2C(decoded);
      if (msg === null) return;
      if (msg.t === 'welcome') backoffMs = RECONNECT_BASE_MS; // healthy socket: reset backoff
      hooks.onMessage(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return; // stale socket from a previous connect()
      ws = null;
      hooks.onClose();
      window.setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
    };
    sock.onerror = () => {
      // the close event follows and does the teardown
    };
  }

  connect();
  window.setInterval(() => {
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
      } catch {
        // racing a close — drop the frame
      }
    }
  }, NET.pingEveryMs);

  return {
    send(msg: LobbyC2S | RiftC2S): void {
      const sock = ws;
      if (sock === null || sock.readyState !== WebSocket.OPEN) return;
      try {
        sock.send(JSON.stringify(msg));
      } catch {
        // racing a close — drop the frame
      }
    },
    serverNow(): number {
      return Date.now() + offset;
    },
    get connected(): boolean {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },
    messageLog(): readonly unknown[] {
      return log.slice();
    },
  };
}
