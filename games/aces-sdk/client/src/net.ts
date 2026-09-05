// ============================================================================
// ACES — C_NET (net.ts). One `/ws` socket, the house join flow mirrored from
// games/rift/client/src/game.ts + platform/server/src/lobby.ts:
//
//   1. open ws(s)://host/ws                       (platform NetServer upgrades)
//   2. server immediately sends {t:'welcome', playerId}  ← TRANSPORT welcome
//   3. we send ONE lobby envelope:
//        {t:'quick_join', name, game:'aces'}                 (public seat)
//        {t:'create_private', name, game:'aces', settings}   (private/debug)
//      NEVER a room-level {t:'join'} first — the lobby drops it before a room
//      exists (CONTRACT §5, lobby.ts handleMessage pass-through).
//   4. room.addPlayer makes the ROOM send ITS welcome {t:'welcome', id, seed,
//      tickRate, …}. Both welcomes share the `t`; they are told apart by SHAPE
//      (room welcome carries id+seed+tickRate+snapRate, transport welcome
//      carries playerId) — the transport one is consumed, the room one fires
//      handlers.onWelcome.
//   5. everything after that is room-level and routed to the handlers:
//      snapshot/event/phase/score. Lobby-level {t:'error'} goes down the
//      onClose path with the reason logged (seating never happened).
//
// INPUT SENDER OWNERSHIP (task ruling, resolves CONTRACT §5's phrasing):
// the frozen NetClient seam has no installInputSource, so C_NET does NOT
// sample input and owns no timer for it. C_APP samples its InputSource and
// calls sendInput() at 30 Hz (TICK_RATE) with seq-stamped frames; this module
// only serializes and transmits them. Documented here because the contract
// sentence "samples the app-installed InputSource" reads otherwise.
//
// RTT: the transport answers app-level {t:'ping'} itself (platform
// net.ts intercepts `ping` before the lobby), so we self-measure: send
// {t:'ping', ts:performance.now()} on a 2 s cadence and read rtt off the
// echoed {t:'pong'}. 2 s mirrors @platform/shared NET.pingEveryMs, which the
// aces import law (CONTRACT §2: client imports @aces/shared + own tree only)
// forbids importing — hence the local constant with this citation. Measured
// rtt is stamped onto every SnapshotView (the wire SnapshotMsg carries no
// rttMs; the seam requires one).
//
// Wire discipline (RULES 7): every inbound frame is JSON.parse'd in a
// try/catch and narrowed field-by-field; malformed messages are DROPPED,
// never thrown on; malformed ROWS inside an otherwise-valid snapshot are
// skipped alone (one bad plane must not blank the whole sky). Unknown tags
// drop in silence — the server may be newer.
// ============================================================================

import { INTERP_MS } from '@aces/shared/config.js';

/** This port's registry id — the shared GAME_ID stays 'aces'. */
const PORT_GAME_ID = 'aces-sdk';
import type { DebugCmd, Difficulty, PlaneClassId, RoomSettings, TeamId } from '@aces/shared/config.js';
import { angleDelta, wrapAngle } from '@aces/shared/physics.js';
import type { CrateState, GameEvent, MatchPhase, ScoreRow } from '@aces/shared/types.js';
import { validateSettings } from '@aces/shared/protocol.js';
import type { SnapPlane } from '@aces/shared/protocol.js';
import type { JoinKind, NetClient, NetHandlers, SnapshotView } from './contract/seams.js';

/** App-level ping cadence. Mirrors @platform/shared NET.pingEveryMs — see
 *  the header note for why it is redeclared here rather than imported. */
const PING_EVERY_MS = 2_000;

/** The room-welcome payload handlers.onWelcome receives — structurally the
 *  anonymous parameter of the frozen seam, re-declared so parseRoomWelcome
 *  has a named return. Never widened beyond the seam. */
interface WelcomePayload {
  id: string;
  seed: number;
  tickRate: number;
  snapRate: number;
  settings: Required<RoomSettings>;
  roster: ScoreRow[];
}

// ---- narrowing helpers (platform style: invalid => null, never throw) --------

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
  return v === 'royal' || v === 'iron' ? v : null;
}
function phaseOf(v: unknown): MatchPhase | null {
  return v === 'lobby' || v === 'live' || v === 'end' ? v : null;
}
function classOf(v: unknown): PlaneClassId | null {
  return v === 'scout' || v === 'fighter' || v === 'gunship' ? v : null;
}
function difficultyOf(v: unknown): Difficulty | null {
  return v === 'easy' || v === 'normal' || v === 'hard' ? v : null;
}

// ---- S2C row parsers ---------------------------------------------------------

function parseSnapPlane(v: unknown): SnapPlane | null {
  if (!isObj(v) || !str(v.id) || !str(v.name)) return null;
  const team = teamOf(v.team);
  const cls = classOf(v.cls);
  if (team === null || cls === null) return null;
  if (!bool(v.bot) || !bool(v.jammed) || !bool(v.boosting) || !bool(v.dead)) return null;
  // Every numeric field must be finite — one NaN anywhere would poison the
  // interpolation lerp and, through it, every rendered remote plane. Each
  // guard narrows its own property path, so the literal below type-checks
  // as numbers without a single assertion.
  if (
    !num(v.x) || !num(v.y) || !num(v.h) || !num(v.sp) ||
    !num(v.vx) || !num(v.vy) || !num(v.hp) || !num(v.maxHp) ||
    !num(v.heat) || !num(v.boost) || !num(v.throttle) ||
    !num(v.invulnT) || !num(v.streak) || !num(v.seq)
  ) {
    return null;
  }
  return {
    id: v.id, name: v.name, team, cls, bot: v.bot,
    x: v.x, y: v.y, h: v.h, sp: v.sp, vx: v.vx, vy: v.vy,
    hp: v.hp, maxHp: v.maxHp, heat: v.heat, jammed: v.jammed,
    boost: v.boost, boosting: v.boosting, throttle: v.throttle,
    invulnT: v.invulnT, dead: v.dead, streak: v.streak, seq: v.seq,
  };
}

function parseBullet(v: unknown): SnapshotView['bullets'][number] | null {
  if (!isObj(v)) return null;
  const team = teamOf(v.team);
  if (team === null || !num(v.id) || !num(v.x) || !num(v.y) || !num(v.vx) || !num(v.vy)) return null;
  return { id: v.id, team, x: v.x, y: v.y, vx: v.vx, vy: v.vy };
}

function parseCrate(v: unknown): CrateState | null {
  if (!isObj(v) || !num(v.id) || !num(v.x) || !num(v.y) || !num(v.t)) return null;
  if (v.phase !== 'fall' && v.phase !== 'active') return null;
  return { id: v.id, x: v.x, y: v.y, phase: v.phase, t: v.t };
}

function parseScoreRow(v: unknown): ScoreRow | null {
  if (!isObj(v) || !str(v.id) || !str(v.name)) return null;
  const team = teamOf(v.team);
  const cls = classOf(v.cls);
  if (team === null || cls === null || !bool(v.bot)) return null;
  if (!num(v.kills) || !num(v.deaths) || !num(v.shots) || !num(v.hits) || !num(v.score)) return null;
  return {
    id: v.id, name: v.name, team, cls, bot: v.bot,
    kills: v.kills, deaths: v.deaths, shots: v.shots, hits: v.hits, score: v.score,
  };
}

function parseBoard(v: unknown): ScoreRow[] | null {
  if (!Array.isArray(v)) return null;
  const out: ScoreRow[] = [];
  for (const raw of v) {
    const row = parseScoreRow(raw);
    if (row === null) return null; // strict like rift's parseBoard: one bad row voids the board
    out.push(row);
  }
  return out;
}

function parseGameEvent(v: unknown): GameEvent | null {
  if (!isObj(v)) return null;
  switch (v.kind) {
    case 'kill': {
      const kt = teamOf(v.killerTeam);
      const vt = teamOf(v.victimTeam);
      const kc = classOf(v.killerCls);
      const vc = classOf(v.victimCls);
      if (kt === null || vt === null || kc === null || vc === null) return null;
      if (!str(v.killer) || !str(v.killerName) || !str(v.victim) || !str(v.victimName)) return null;
      if (!bool(v.crash) || !num(v.streak) || !num(v.x) || !num(v.y)) return null;
      return {
        kind: 'kill', killer: v.killer, killerName: v.killerName,
        victim: v.victim, victimName: v.victimName,
        killerTeam: kt, victimTeam: vt, killerCls: kc, victimCls: vc,
        crash: v.crash, streak: v.streak, x: v.x, y: v.y,
      };
    }
    case 'hit': {
      if (!str(v.target) || !str(v.by)) return null;
      if (!num(v.x) || !num(v.y) || !num(v.dmg) || !bool(v.killed)) return null;
      return { kind: 'hit', target: v.target, by: v.by, x: v.x, y: v.y, dmg: v.dmg, killed: v.killed };
    }
    case 'crate': {
      if ((v.what !== 'spawn' && v.what !== 'pickup' && v.what !== 'expire') || !num(v.x) || !num(v.y)) return null;
      const ev: GameEvent = { kind: 'crate', what: v.what, x: v.x, y: v.y };
      // `by` is optional and rides only on pickup; absent keys stay absent
      // (exactOptionalPropertyTypes bans explicit-undefined assignment).
      if (v.by !== undefined) {
        if (!str(v.by)) return null;
        return { kind: 'crate', what: v.what, x: v.x, y: v.y, by: v.by };
      }
      return ev;
    }
    default:
      return null;
  }
}

/**
 * Build the seam's SnapshotView off a narrowed-enough raw snapshot.
 * Scalar fields are strict (a bad tick/phase voids the frame — there is
 * nothing safe to default them to); ARRAY ROWS are skipped individually
 * because losing one bullet/plane for one frame beats blanking the sky.
 */
function parseSnapshot(raw: Record<string, unknown>, rttMs: number): SnapshotView | null {
  const phase = phaseOf(raw.phase);
  if (phase === null || !num(raw.tick) || !num(raw.timeLeftS)) return null;
  if (!isObj(raw.tickets) || !num(raw.tickets.royal) || !num(raw.tickets.iron)) return null;

  if (!Array.isArray(raw.planes) || !Array.isArray(raw.bullets) || !Array.isArray(raw.crates)) return null;
  const planes: SnapPlane[] = [];
  for (const row of raw.planes) {
    const p = parseSnapPlane(row);
    if (p !== null) planes.push(p); // skip bad row, keep the formation flying
  }
  const bullets: NonNullable<SnapshotView['bullets']>[number][] = [];
  for (const row of raw.bullets) {
    const b = parseBullet(row);
    if (b !== null) bullets.push(b);
  }
  const crates: CrateState[] = [];
  for (const row of raw.crates) {
    const c = parseCrate(row);
    if (c !== null) crates.push(c);
  }

  let you: SnapPlane | undefined;
  if (raw.you !== undefined && raw.you !== null) {
    const row = parseSnapPlane(raw.you);
    if (row === null) return null; // own row malformed: void the frame, it drives prediction
    you = row;
  }

  return {
    tick: raw.tick,
    phase,
    timeLeftS: raw.timeLeftS,
    tickets: { royal: raw.tickets.royal, iron: raw.tickets.iron },
    you,
    planes,
    bullets,
    crates,
    rttMs,
  };
}

/** The room's welcome, narrowed. Null when the shape is not the ACES one —
 *  which is also how the TRANSPORT welcome ({t:'welcome', playerId}) is
 *  recognized and consumed upstream (it has no seed/tickRate). */
function parseRoomWelcome(raw: Record<string, unknown>): WelcomePayload | null {
  if (!str(raw.id) || !num(raw.seed) || !num(raw.tickRate) || !num(raw.snapRate)) return null;
  const settings = validateSettings(isObj(raw.settings) ? raw.settings : undefined);
  const roster = parseBoard(raw.roster);
  if (roster === null) return null;
  return { id: raw.id, seed: raw.seed, tickRate: raw.tickRate, snapRate: raw.snapRate, settings, roster };
}

/** The join envelope, built literally: the aces import law bars
 *  @platform/shared's LobbyC2S types from client territory, and the platform
 *  sanitizes name/settings server-side anyway (protocol.ts cleanName /
 *  validateSettings). Settings spread opaquely — the lobby never reads them. */
function joinEnvelope(name: string, join: JoinKind): Record<string, unknown> {
  if (join.kind === 'quick') return { t: 'quick_join', name, game: PORT_GAME_ID };
  return { t: 'create_private', name, game: PORT_GAME_ID, settings: { ...join.settings } };
}

/** wss behind https (mixed-content would be blocked by the browser anyway),
 *  same host (the socket is same-origin by deployment), fixed `/ws` upgrade
 *  path (platform NetServer routes exactly this pathname). */
export function wsUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

// ---- RemoteInterp: snapshot buffer + remote-plane interpolation -----------------

/** Buffer ceiling — ≈2 s of snapshots at SNAP_RATE 15 Hz, far past any
 *  healthy INTERP_MS window; oldest entries fall off. */
const BUF_MAX = 32;

interface TimedSnap {
  readonly snap: SnapshotView;
  /** Local monotonic arrival stamp (ms) — the interpolation clock. Derived
   *  from an injected clock rather than tick deltas so tests can drive time
   *  deterministically and jittered delivery never skews brackets. */
  readonly t: number;
}

/**
 * Ring of recent snapshots rendering REMOTE planes at nowMs − INTERP_MS
 * (config.INTERP_MS = 120 ms): between the two snapshots bracketing that
 * render time, x/y lerp linearly and h takes the SHORTEST ARC (a plane
 * crossing the 0/2π boundary must turn the short way, never unwind backwards).
 *
 * Clamp law: before the first / after the last buffered arrival the nearest
 * snapshot is emitted verbatim — never extrapolated past known truth.
 * Per-id: a row present only in the NEWER bracket (fresh spawn) renders at
 * its new position; a row only in the OLDER one has already despawned and is
 * dropped. ALL rows are returned, own-plane included — filtering `you` out is
 * the app's job (harmless duplication: prediction owns the own-plane draw).
 *
 * Allocation law (RULES 4): output rows are POOLED per plane id and mutated
 * in place; sampleRemotes fills the caller's reused array without allocating
 * in steady state. Non-positional fields always come from the newer bracket
 * (newer truth wins for hp/team/cls cosmetics).
 */
export class RemoteInterp {
  private readonly buf: TimedSnap[] = [];
  private readonly pool = new Map<string, SnapPlane>();
  private lastTick = -Infinity;

  /** Injected for deterministic tests; defaults to the real monotonic clock. */
  constructor(private readonly now: () => number = () => performance.now()) {}

  push(snap: SnapshotView): void {
    // Monotonic-tick gate: a delayed old packet (or duplicate) must not drag
    // the buffer backwards — "stale snapshot ignored" whole.
    if (snap.tick <= this.lastTick) return;
    this.lastTick = snap.tick;
    this.buf.push({ snap, t: this.now() });
    if (this.buf.length > BUF_MAX) this.buf.shift();
  }

  latest(): SnapshotView | undefined {
    return this.buf[this.buf.length - 1]?.snap;
  }

  /** Interpolated remote planes at nowMs − INTERP_MS into `out` (reused). */
  sampleRemotes(nowMs: number, out: SnapPlane[]): void {
    out.length = 0;
    const n = this.buf.length;
    if (n === 0) return;
    const rt = nowMs - INTERP_MS;
    const first = this.buf[0]!;
    const last = this.buf[n - 1]!;
    if (rt <= first.t || rt >= last.t) {
      // Outside the buffered window: clamp to the nearest end. Emitted via
      // the same lerp path with both brackets = that snap (alpha no-ops).
      const edge = rt <= first.t ? first : last;
      this.emit(edge.snap, edge.snap, 0, out);
      return;
    }
    // Find the bracket: last entry starting at/below rt (linear scan over ≤32
    // entries — cheaper than binary search bookkeeping at this size).
    let i = 0;
    while (i < n - 1 && this.buf[i + 1]!.t <= rt) i++;
    const a = this.buf[i]!;
    const b = this.buf[i + 1]!;
    const span = b.t - a.t;
    const alpha = span > 0 ? (rt - a.t) / span : 0;
    this.emit(a.snap, b.snap, alpha, out);
  }

  /** Fill `out` from the newer bracket's roster, lerping x/y/h against the
   *  older one where the id exists there too. */
  private emit(a: SnapshotView, b: SnapshotView, alpha: number, out: SnapPlane[]): void {
    for (let bi = 0; bi < b.planes.length; bi++) {
      const row = b.planes[bi];
      if (row === undefined) continue; // unreachable: bi < length
      const prev = findRow(a, row.id);
      const slot = this.slot(row); // pooled per-id output object
      if (prev === undefined) {
        copyInto(slot, row); // fresh spawn: render at its (only known) pose
      } else {
        copyInto(slot, row);
        slot.x = prev.x + (row.x - prev.x) * alpha;
        slot.y = prev.y + (row.y - prev.y) * alpha;
        // Shortest arc: delta in (−π, π], scaled, re-wrapped into [0, 2π).
        slot.h = wrapAngle(prev.h + angleDelta(prev.h, row.h) * alpha);
      }
      out.push(slot);
    }
  }

  /** Per-id reusable output row — allocated once per new plane id, mutated
   *  every emission thereafter (zero steady-state allocation). */
  private slot(src: SnapPlane): SnapPlane {
    let s = this.pool.get(src.id);
    if (s === undefined) {
      s = {
        id: src.id, name: '', team: src.team, cls: src.cls, bot: false,
        x: 0, y: 0, h: 0, sp: 0, vx: 0, vy: 0,
        hp: 0, maxHp: 1, heat: 0, jammed: false,
        boost: 0, boosting: false, throttle: 0,
        invulnT: 0, dead: false, streak: 0, seq: 0,
      };
      this.pool.set(src.id, s);
    }
    return s;
  }
}

function findRow(snap: SnapshotView, id: string): SnapPlane | undefined {
  for (let i = 0; i < snap.planes.length; i++) {
    const p = snap.planes[i];
    if (p !== undefined && p.id === id) return p;
  }
  return undefined;
}

function copyInto(dst: SnapPlane, src: SnapPlane): void {
  dst.name = src.name;
  dst.team = src.team;
  dst.cls = src.cls;
  dst.bot = src.bot;
  dst.x = src.x;
  dst.y = src.y;
  dst.h = src.h;
  dst.sp = src.sp;
  dst.vx = src.vx;
  dst.vy = src.vy;
  dst.hp = src.hp;
  dst.maxHp = src.maxHp;
  dst.heat = src.heat;
  dst.jammed = src.jammed;
  dst.boost = src.boost;
  dst.boosting = src.boosting;
  dst.throttle = src.throttle;
  dst.invulnT = src.invulnT;
  dst.dead = src.dead;
  dst.streak = src.streak;
  dst.seq = src.seq;
}

// ---- the client ----------------------------------------------------------------

/**
 * The one NetClient the app owns. See the header for the join flow and the
 * input-sender ownership ruling. All sends are no-ops unless the socket is
 * OPEN (mirrors the server's Session.send); racing a close drops the frame.
 */
export function createNet(): NetClient {
  let sock: WebSocket | null = null;
  let handlers: NetHandlers | null = null;
  let snapshotFn: ((snap: SnapshotView) => void) | null = null;
  let rtt = 0; // ms, from our app-level ping/pong; 0 until the first pong
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let closedByUser = false; // explicit close(): suppress the onClose signal

  function sendRaw(msg: unknown): void {
    const s = sock;
    if (s === null || s.readyState !== WebSocket.OPEN) return;
    try {
      s.send(JSON.stringify(msg));
    } catch {
      // racing a close — drop the frame, the close path owns teardown
    }
  }

  function startPinger(): void {
    stopPinger();
    pingTimer = setInterval(() => {
      // Transport answers before the lobby ever sees it (platform net.ts).
      sendRaw({ t: 'ping', ts: performance.now() });
    }, PING_EVERY_MS);
  }

  function stopPinger(): void {
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = null;
  }

  /** Route one decoded frame. Everything unrecognized drops in silence. */
  function dispatch(raw: unknown): void {
    if (!isObj(raw) || typeof raw.t !== 'string') return;
    switch (raw.t) {
      case 'welcome': {
        // Two welcomes share this tag (header note). Shape-test for the ROOM
        // welcome first; a bare playerId is the transport hello — consumed.
        const w = parseRoomWelcome(raw);
        if (w !== null) handlers?.onWelcome(w);
        return;
      }
      case 'snapshot': {
        const view = parseSnapshot(raw, rtt);
        if (view === null) return; // malformed frame: dropped, never fatal
        // REGISTER-ON-FIRST-USE BRIDGE (C_APP integration, disclosed): the
        // frozen seam types NetHandlers.onSnapshot as a REGISTRATION hook —
        // the app hands back its consumer when we call it — yet nothing in
        // this module ever invoked that registration nor assigned the private
        // pump slot below, so every parsed snapshot died right here. Bridge:
        // on the first view of a session (connect() resets the slot), ask the
        // app's handlers to register; its synchronous fn(consumer) round-trip
        // fills the slot before the very pump line runs, so even this first
        // view is delivered.
        if (snapshotFn === null && handlers !== null) {
          handlers.onSnapshot((consumer) => {
            // Registrar-relay: the app invokes us synchronously with its
            // consumer. The seam's contextual typing names that argument
            // "a snapshot" — the exact disguise documented in app.ts.
            snapshotFn = consumer as unknown as (snap: SnapshotView) => void;
          });
        }
        snapshotFn?.(view);
        return;
      }
      case 'event': {
        const e = parseGameEvent(raw.e);
        if (e !== null) handlers?.onEvent(e);
        return;
      }
      case 'phase': {
        const phase = phaseOf(raw.phase);
        if (phase === null || !num(raw.endsAtS)) return;
        // winner is optional on the wire; absent stays undefined
        let winner: TeamId | undefined;
        if (raw.winner !== undefined && raw.winner !== null) {
          const w = teamOf(raw.winner);
          if (w === null) return;
          winner = w;
        }
        handlers?.onPhase(phase, raw.endsAtS, winner);
        return;
      }
      case 'score': {
        const board = parseBoard(raw.board);
        if (board !== null) handlers?.onScore(board);
        return;
      }
      case 'pong': {
        // Our own ping echoed (transport adds serverTime; unused here —
        // snapshots carry match-relative timeLeftS, so no clock sync needed).
        if (num(raw.ts)) rtt = Math.max(0, performance.now() - raw.ts);
        return;
      }
      case 'error': {
        // LOBBY-level failure (no_room / room_full / bad_settings / …): seating
        // never happened, so the contract routes this down the close path with
        // the reason logged (task BEHAVIOR LAW).
        const code = str(raw.code) ? raw.code : 'unknown';
        const message = str(raw.message) ? raw.message : '';
        console.error(`[aces-net] lobby error ${code}: ${message}`);
        handlers?.onClose();
        return;
      }
      default:
        return; // unknown tag: the server may be newer than us
    }
  }

  function ingest(text: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      return; // malformed frame: drop, never throw on wire data
    }
    dispatch(decoded);
  }

  return {
    connect(name: string, join: JoinKind, hs: NetHandlers): Promise<void> {
      // A fresh session resets routing state; a still-draining predecessor
      // socket is silenced by the identity check in its own callbacks.
      handlers = hs;
      snapshotFn = null;
      rtt = 0;
      closedByUser = false;
      return new Promise<void>((resolve, reject) => {
        let opened = false;
        const s = new WebSocket(wsUrl());
        sock = s;
        s.onopen = () => {
          if (sock !== s) return;
          opened = true;
          sendRaw(joinEnvelope(name, join));
          startPinger();
          resolve();
        };
        s.onmessage = (ev: MessageEvent) => {
          if (sock !== s || typeof ev.data !== 'string') return;
          ingest(ev.data);
        };
        s.onclose = () => {
          if (sock !== s) return; // stale socket from a superseded connect()
          stopPinger();
          sock = null;
          if (!opened) {
            // Never got online: the promise is the failure signal and the app
            // has no live handler session yet — no onClose double-report.
            reject(new Error('aces-net: connection failed'));
            return;
          }
          if (!closedByUser) handlers?.onClose(); // reconnect UX is the app's (BACKOFF_MS policy)
        };
        s.onerror = () => {
          // the close event follows and does the teardown/reporting
        };
      });
    },

    sendInput(frame: { seq: number; th: number; tr: number; fire: boolean; boost: boolean }): void {
      // Called by the app at TICK_RATE (30 Hz) — ownership ruling in header.
      sendRaw({ t: 'input', seq: frame.seq, th: frame.th, tr: frame.tr, fire: frame.fire, boost: frame.boost });
    },

    sendSpawn(cls: PlaneClassId): void {
      sendRaw({ t: 'spawn', cls });
    },

    sendDebug(cmd: DebugCmd, x?: number, y?: number): void {
      // Conditional keys: exactOptionalPropertyTypes forbids writing explicit
      // undefined into the optional wire fields (same pattern as parseC2S).
      const msg: { t: 'debug'; cmd: DebugCmd; x?: number; y?: number } = { t: 'debug', cmd };
      if (x !== undefined) msg.x = x;
      if (y !== undefined) msg.y = y;
      sendRaw(msg);
    },

    close(): void {
      closedByUser = true;
      stopPinger();
      const s = sock;
      sock = null;
      if (s === null) return;
      try {
        s.close();
      } catch {
        // already gone
      }
    },

    rttMs(): number {
      return rtt;
    },
  };
}
