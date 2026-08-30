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
//
// REJECTION GRANULARITY (BUILD_SPECS §R_WIRE item 1). A malformed MESSAGE is
// dropped whole; a malformed ENTITY inside an otherwise-valid `rift_snap` is
// dropped ALONE and counted (`NetHandle.droppedEntities`). The two are not the
// same failure: nulling a snapshot because one row did not parse blanks every
// unit, structure and projectile on screen for that frame, and it degrades
// with load — the more the server sends, the likelier the whole frame is lost.
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
  EntTeam,
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
  /** How many entities have been DROPPED from otherwise-valid snapshots since
   *  the page loaded, because they failed {@link parseEnt}. See
   *  {@link droppedEnts} — this is the diagnosable half of "skip, never
   *  fatal", and the debug surface reports it. */
  droppedEntities(): number;
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
/** An ENTITY's team: `0 | 1 | NEUTRAL_TEAM(2)`. Jungle camps ride the same
 *  snapshot path as players' units and carry team 2 (types.ts `EntTeam`), so a
 *  parser that admits only 0 and 1 rejects every camp on the wire. Anything
 *  that INDEXES a per-team structure with the result must narrow with
 *  `isPlayerTeam` first — this function deliberately does not do that for the
 *  caller. */
function teamOf(v: unknown): EntTeam | null {
  return v === 0 || v === 1 || v === 2 ? v : null;
}
/** A PLAYER's team: `0 | 1` only, and `NEUTRAL_TEAM` is malformed here. Roster
 *  rows, scoreboard rows, end-screen stats, `rift_hello` and the two
 *  structure/winner event fields are all typed `TeamId` in protocol.ts — a
 *  neutral in any of them is a protocol violation, not a jungle camp. Keeping
 *  the two parsers apart is what lets {@link teamOf} widen without silently
 *  widening five things that must not. */
function playerTeamOf(v: unknown): TeamId | null {
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
    // The three neutral jungle kinds (types.ts EntKind, AMENDMENT_2 §D.2).
    // Omitting them rejected every camp member the server sends.
    case 'campPack':
    case 'campBrute':
    case 'campHive':
      return v;
    default:
      return null;
  }
}
/** One-shot notice that the server is not sending `dayPhase`. */
let dayPhaseMissingWarned = false;

/**
 * `dayPhase` (protocol.ts rift_snap): 0 = full day, 1 = full night,
 * continuous, wraps. Finite number required; CLAMPED into [0, 1] rather than
 * rejected, so a server whose wrapping triangle overshoots by a float epsilon
 * cannot blank a frame. A present-but-corrupt value IS rejected, like every
 * other scalar in this parser — a NaN here would poison the PMREM rebuild, the
 * exposure ramp and the grade in one go.
 *
 * ABSENT is treated as 0 (full day) with a one-shot warning, and that is a
 * live defect being tolerated, not a design: `dayPhase` is REQUIRED by
 * protocol.ts, and `server/src/room.ts` does not put it on the wire —
 * `SnapMut` has no such field and nothing there calls the `dayPhase(matchTick)`
 * that AMENDMENT_1 §B.1 hoisted into config.ts for exactly this purpose. That
 * is S_ROOM's outstanding obligation and R_WIRE does not own room.ts.
 * Rejecting the snapshot instead would mean every snapshot from the current
 * server is dropped and the client never leaves the lobby — a whole broken
 * client to signal one missing scalar. Until S_ROOM lands, the cycle is pinned
 * at day and only `__rift.setDayPhase` moves it.
 */
function dayPhaseOf(v: unknown): number | null {
  if (v === undefined) {
    if (!dayPhaseMissingWarned) {
      dayPhaseMissingWarned = true;
      console.warn(
        'rift net: rift_snap carries no `dayPhase` — the server is not sending a protocol-required ' +
          'field (room.ts must call config.ts dayPhase(matchTick), AMENDMENT_1 §B.1). ' +
          'Assuming full day; the day/night cycle will not advance.',
      );
    }
    return 0;
  }
  if (!num(v)) return null;
  return v < 0 ? 0 : v > 1 ? 1 : v;
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
    const team = playerTeamOf(raw.team);
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
    const team = playerTeamOf(raw.team);
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

/** Entities dropped from otherwise-valid snapshots since page load, and a
 *  one-shot console warning so a drop is visible without opening the debug
 *  surface. A malformed entity must NOT null the snapshot: the whole frame
 *  would go blank over one unrecognised unit, which is exactly what happened
 *  to every snapshot carrying a jungle camp before this pass. Skipping is only
 *  safe if it is COUNTED — a silent skip is how a protocol drift survives a
 *  whole build. */
let droppedEnts = 0;
let droppedEntsWarned = false;

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
    const team = playerTeamOf(raw.team);
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
      const team = playerTeamOf(raw.team);
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
    case 'rift_miss': {
      // ENTITY ids, exactly like rift_cast — never player ids (protocol.ts,
      // AMENDMENT_1 §B.2). Without this arm every uphill miss fell through
      // `default: return null` and hud.ts's MISS/EVADED float was unreachable.
      if (!num(raw.attacker) || !num(raw.target)) return null;
      return { t: 'rift_miss', attacker: raw.attacker, target: raw.target };
    }
    case 'rift_end': {
      const winner = playerTeamOf(raw.winner);
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
      const team = playerTeamOf(raw.team);
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
      const dayPhase = dayPhaseOf(raw.dayPhase);
      if (dayPhase === null) return null;
      if (!Array.isArray(raw.ents)) return null;
      const ents: EntSnap[] = [];
      for (const rawEnt of raw.ents) {
        const e = parseEnt(rawEnt);
        if (e === null) {
          // SKIP, never fatal: one bad row loses one unit for one frame,
          // whereas returning null here loses the entire world for one frame.
          droppedEnts++;
          if (!droppedEntsWarned) {
            droppedEntsWarned = true;
            console.warn(
              'rift net: dropped a malformed entity from a snapshot (running total: __rift.droppedEnts())',
            );
          }
          continue;
        }
        ents.push(e);
      }
      return {
        t: 'rift_snap',
        tick: raw.tick,
        serverTime: raw.serverTime,
        phase,
        matchTick: raw.matchTick,
        overtime: raw.overtime,
        dayPhase,
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
export interface CreateNetOpts {
  /**
   * Platform v2: messages sent immediately after EVERY (re)open, before any
   * game traffic — the SDK shell uses this for {t:'auth'} so rooms can
   * attribute stats. Legacy callers omit it and stay anonymous.
   */
  readonly onOpenExtra?: () => readonly unknown[];
}

export function createNet(hooks: NetHooks, opts?: CreateNetOpts): NetHandle {
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
    // Platform v2: fire the shell's auth payload right after every open —
    // BEFORE the server could route anything that depends on it.
    sock.onopen = () => {
      const extra = opts?.onOpenExtra?.() ?? [];
      for (const m of extra) {
        try {
          sock.send(JSON.stringify(m));
        } catch {
          break; // racing a close — drop the frame
        }
      }
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
    droppedEntities(): number {
      return droppedEnts;
    },
  };
}
