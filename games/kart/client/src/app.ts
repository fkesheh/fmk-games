// ============================================================================
// KART GP client — connection, lobby flow, race screens, net wiring.
// Lobby protocol: platform/shared/src/protocol.ts (every join/create carries
// game:'kart'; the room list is filtered to it). Race protocol + tuning come
// from the frozen @kart/shared contract. Driving (./drive.js), rendering
// (./render.js) and sound (./audio.js) are separate frozen modules — this
// file codes against their frozen signatures only (docs/KART.md). Juice
// (skid marks / smoke / dust / sparks / nitro trail / speed lines) lives in
// ./fx.js — pooled and zero-alloc; this file only feeds it sim facts.
//
// Net model: SERVER-AUTHORITATIVE. The wire carries INPUTS, never coordinates
// — drive.ts owns the keyboard (WASD/arrows/Space, R = respawn) and emits one
// kart_input per SIM_DT (SIM_HZ = 30); app.ts flushes them to the socket. The
// server integrates the shared sim over those inputs and owns every position,
// including kart-vs-kart contact (which arrives back as a 'bump' race event
// both drivers see identically). The client PREDICTS locally — each input is
// applied the instant it is produced, so steering never waits for the server —
// and each snapshot at SNAPSHOT_HZ carries you.sim + you.lastProcessedSeq, on
// top of which drive.reconcile() replays every unacknowledged input; a
// converged client corrects by 0m. Remote karts render ~120ms behind
// serverTime from per-player interpolation buffers. Debug surface window.__kart
// per docs/KART.md.
// ============================================================================
import {
  DEFAULT_TRACK_ID,
  GATES,
  KART_COLORS,
  KPAL,
  LAPS_TO_WIN,
  MIN_PLAYERS,
  NITRO_CHARGES,
  SIM_HZ,
  SNAPSHOT_HZ,
  TOP_SPEED,
  TRACKS,
  buildTrack,
  engineRevs,
  forwardSpeed,
  gridSlot,
  isTrackId,
  surfaceAt,
} from '@kart/shared';
import type {
  KartC2S,
  KartInput,
  KartPhase,
  KartPlayerInfo,
  KartPlayerSnap,
  KartS2C,
  KartSeason,
  KartSim,
  KartStandingRow,
  KartState,
  KartYou,
  RaceEvent,
  TrackDef,
  TrackId,
} from '@kart/shared';
import type { LobbyC2S, RoomInfo } from '@platform/shared';
import { cleanName, clearSession, loadName, loadSession, loadSig, saveName, saveSession } from '@platform/shared';
import { KartScene } from './render.js';
import QrCreator from 'qr-creator';
import { KART_PAD_PAGE_PATH, parseKartPadToPlayerS2C } from '@kart/shared';
import type { KartPadToPlayerS2C } from '@kart/shared';
import { DriveController, TouchPointers } from './drive.js';
import type { TouchControl } from './drive.js';
import { KartAudio } from './audio.js';
import { KartFx } from './fx.js';
import { setKartTrack } from './kartMesh.js';

// ---- wire parsing (mirror of the platform style: invalid => null, never throw) ----
type LobbyMsg =
  | { t: 'welcome'; playerId: string }
  | { t: 'room_list'; rooms: RoomInfo[] }
  | { t: 'pong'; ts: number; serverTime: number }
  | { t: 'error'; code: string; message: string };

// kart_joined carries roomId + code straight off the frozen contract — the
// rejoin pointer a reloading driver needs to re-enter THIS grid rather than
// quick-joining a stranger's race (platform contract §3; stored via
// @platform/shared SessionRecord in onJoined() below).
type JoinedMsg = Extract<KartS2C, { t: 'kart_joined' }>;
type SnapshotMsg = Extract<KartS2C, { t: 'kart_snapshot' }>;
type RaceEventMsg = Extract<KartS2C, { t: 'race_event' }>;

type S2C = LobbyMsg | JoinedMsg | SnapshotMsg | RaceEventMsg;

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
function vec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && num(v[0]) && num(v[1]) && num(v[2]);
}
function vec2(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);
}
function kartPhase(v: unknown): KartPhase | null {
  return v === 'lobby' || v === 'ready' || v === 'countdown' || v === 'racing' || v === 'results'
    ? v
    : null;
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

function parsePlayerInfo(v: unknown): KartPlayerInfo | null {
  if (!isObj(v) || !str(v.id) || !str(v.name) || !num(v.slot) || !num(v.color)) return null;
  return { id: v.id, name: v.name, slot: v.slot, color: v.color };
}

/** The server's authoritative own-kart state — every field or nothing (a
 *  half-parsed KartSim would re-base the predictor onto garbage). Rebuilt as a
 *  plain object so nothing downstream retains the decoded wire reference. */
function parseSim(v: unknown): KartSim | null {
  if (!isObj(v)) return null;
  if (!num(v.x) || !num(v.y) || !num(v.z) || !num(v.yaw)) return null;
  if (!num(v.vx) || !num(v.vz) || !num(v.gear) || !num(v.shiftLeft)) return null;
  if (!bool(v.drifting) || !num(v.nitroLeft) || !num(v.expectedGate)) return null;
  if (!num(v.anchorX) || !num(v.anchorZ) || !num(v.anchorYaw)) return null;
  return {
    x: v.x,
    y: v.y,
    z: v.z,
    yaw: v.yaw,
    vx: v.vx,
    vz: v.vz,
    gear: v.gear,
    shiftLeft: v.shiftLeft,
    drifting: v.drifting,
    nitroLeft: v.nitroLeft,
    expectedGate: v.expectedGate,
    anchorX: v.anchorX,
    anchorZ: v.anchorZ,
    anchorYaw: v.anchorYaw,
  };
}

function parseYou(v: unknown): KartYou | null {
  if (!isObj(v)) return null;
  if (!num(v.lap) || !num(v.nextGate) || !num(v.progress) || !num(v.place)) return null;
  if (!bool(v.finished) || !num(v.finishMs) || !num(v.bestLapMs)) return null;
  if (!num(v.nitroLeft) || !num(v.gapAheadMs)) return null;
  if (!num(v.lastProcessedSeq)) return null; // the ack the replay drops from
  const sim = parseSim(v.sim);
  if (sim === null) return null;
  return {
    lap: v.lap,
    nextGate: v.nextGate,
    progress: v.progress,
    place: v.place,
    finished: v.finished,
    finishMs: v.finishMs,
    bestLapMs: v.bestLapMs,
    nitroLeft: v.nitroLeft,
    gapAheadMs: v.gapAheadMs,
    lastProcessedSeq: v.lastProcessedSeq,
    sim,
  };
}

function parsePlayerSnap(v: unknown): KartPlayerSnap | null {
  if (!isObj(v)) return null;
  const info = parsePlayerInfo(v);
  if (info === null) return null;
  if (!vec3(v.p) || !num(v.yaw) || !vec2(v.v) || !num(v.steer) || !bool(v.drift)) return null;
  if (!num(v.lap) || !num(v.nextGate) || !num(v.progress) || !num(v.place)) return null;
  if (!bool(v.finished) || !num(v.finishMs) || !bool(v.nitroActive)) return null;
  return {
    ...info,
    p: v.p,
    yaw: v.yaw,
    v: v.v,
    steer: v.steer,
    drift: v.drift,
    lap: v.lap,
    nextGate: v.nextGate,
    progress: v.progress,
    place: v.place,
    finished: v.finished,
    finishMs: v.finishMs,
    nitroActive: v.nitroActive,
  };
}

/** One championship line. All-or-nothing per ROW (a half-parsed row would put a
 *  driver on the table with a phantom points total), but a bad row drops alone —
 *  see parseSeason. */
function parseStandingRow(v: unknown): KartStandingRow | null {
  if (!isObj(v) || !str(v.id) || !str(v.name)) return null;
  if (!num(v.pos) || !num(v.points) || !num(v.delta) || !num(v.wins)) return null;
  if (!num(v.bestFinish) || !bool(v.here) || !num(v.joinedRound)) return null;
  return {
    id: v.id,
    name: v.name,
    pos: v.pos,
    points: v.points,
    delta: v.delta,
    wins: v.wins,
    bestFinish: v.bestFinish,
    here: v.here,
    joinedRound: v.joinedRound,
  };
}

/**
 * The room's season block. `null` is a LEGITIMATE wire value (a room booked
 * `{championship:false}`), so malformed input degrades to exactly that rather
 * than failing the frame: the race must keep rendering at SNAPSHOT_HZ even if
 * the championship did not survive the wire. Standings arrive pre-sorted by
 * `pos` and are kept in wire order — the tie-break is the server's to own.
 */
function parseSeason(raw: unknown): KartSeason | null {
  if (!isObj(raw)) return null;
  if (!num(raw.round) || !num(raw.rounds) || !bool(raw.over)) return null;
  if (!isTrackId(raw.trackId)) return null; // an unknown circuit has no display name
  if (!Array.isArray(raw.standings)) return null;
  const standings: KartStandingRow[] = [];
  for (const r of raw.standings) {
    const row = parseStandingRow(r);
    if (row !== null) standings.push(row); // one bad row ≠ a lost table
  }
  return {
    round: raw.round,
    rounds: raw.rounds,
    trackId: raw.trackId,
    // null on the final round; anything unrecognised is treated as "no next"
    nextTrackId: isTrackId(raw.nextTrackId) ? raw.nextTrackId : null,
    over: raw.over,
    championId: str(raw.championId) ? raw.championId : null,
    standings,
  };
}

function parseRaceEvent(v: unknown): RaceEvent | null {
  if (!isObj(v) || !str(v.kind)) return null;
  switch (v.kind) {
    case 'countdown':
      return num(v.n) ? { kind: 'countdown', n: v.n } : null;
    case 'go':
      return { kind: 'go' };
    case 'gate':
      return str(v.playerId) && num(v.gate) ? { kind: 'gate', playerId: v.playerId, gate: v.gate } : null;
    case 'lap':
      return str(v.playerId) && num(v.lap) && num(v.lapMs)
        ? { kind: 'lap', playerId: v.playerId, lap: v.lap, lapMs: v.lapMs }
        : null;
    case 'nitro':
      return str(v.playerId) && num(v.left)
        ? { kind: 'nitro', playerId: v.playerId, left: v.left }
        : null;
    case 'bump':
      // server-resolved contact: BOTH drivers get this same event for the tick
      return str(v.a) && str(v.b) && num(v.impulse)
        ? { kind: 'bump', a: v.a, b: v.b, impulse: v.impulse }
        : null;
    case 'finish':
      return str(v.playerId) && num(v.place)
        ? { kind: 'finish', playerId: v.playerId, place: v.place }
        : null;
    case 'timeout':
      return { kind: 'timeout' };
    case 'restart':
      return { kind: 'restart' };
    default:
      return null;
  }
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
    case 'kart_joined': {
      const ph = kartPhase(raw.phase);
      if (!str(raw.you) || !num(raw.slot) || !num(raw.color) || ph === null || !str(raw.roomId)) return null;
      if (!Array.isArray(raw.players)) return null;
      const players: KartPlayerInfo[] = [];
      for (const p of raw.players) {
        const info = parsePlayerInfo(p);
        if (info === null) return null;
        players.push(info);
      }
      return {
        t: 'kart_joined',
        you: raw.you,
        slot: raw.slot,
        color: raw.color,
        phase: ph,
        trackId: isTrackId(raw.trackId) ? raw.trackId : DEFAULT_TRACK_ID,
        players,
        roomId: raw.roomId,
        code: str(raw.code) ? raw.code : null,
      };
    }
    case 'kart_snapshot': {
      const ph = kartPhase(raw.phase);
      if (ph === null) return null;
      if (!num(raw.tick) || !num(raw.serverTime) || !num(raw.countdown) || !num(raw.phaseEndsAt)) {
        return null;
      }
      const you = parseYou(raw.you);
      if (you === null || !Array.isArray(raw.players)) return null;
      const players: KartPlayerSnap[] = [];
      for (const p of raw.players) {
        // a malformed entry drops alone at SNAPSHOT_HZ — never the whole frame
        const snap = parsePlayerSnap(p);
        if (snap !== null) players.push(snap);
      }
      // lobby contract fields are additive: an older server that omits them
      // still yields a valid snapshot (count from the roster, min from config)
      return {
        t: 'kart_snapshot',
        tick: raw.tick,
        serverTime: raw.serverTime,
        phase: ph,
        trackId: isTrackId(raw.trackId) ? raw.trackId : DEFAULT_TRACK_ID,
        countdown: raw.countdown,
        phaseEndsAt: raw.phaseEndsAt,
        playerCount: num(raw.playerCount) ? raw.playerCount : players.length,
        minPlayers: num(raw.minPlayers) ? raw.minPlayers : MIN_PLAYERS,
        canStart: raw.canStart === true,
        // additive like the lobby block: an older server (or one still shipping
        // the championship) simply yields null and the screens stay as they were
        championship: parseSeason(raw.championship),
        you,
        players,
      };
    }
    case 'race_event': {
      const ev = parseRaceEvent(raw.ev);
      return ev !== null ? { t: 'race_event', ev } : null;
    }
    case 'event': {
      // server may wrap game events as {t:'event', ev} (fps convention) — unwrap + re-parse
      const ev = parseRaceEvent(raw.ev);
      if (ev !== null) return { t: 'race_event', ev };
      return parseS2C(raw.ev);
    }
    default:
      return null; // unknown envelope: drop, never throw on wire data
  }
}

// ---- frozen e2e surface (docs/KART.md "Client modules") --------------------------
/** JSON-safe snapshot of everything a test driver needs. */
interface KartDebugState {
  phase: KartPhase | 'menu'; // 'menu' before/after a room
  place: number; // 0 until the first snapshot
  lap: number;
  nextGate: number;
  progress: number;
  pos: { x: number; y: number; z: number };
  speed: number; // signed forward speed, m/s
  gear: number; // 1-based automatic gearbox gear (index into the contract GEARS)
  players: number; // karts the client KNOWS are seated (roster/server count, not snapshot-only)
  nitroLeft: number; // charges left this race (you.nitroLeft, server-authoritative)
  gapAheadMs: number; // ms behind the player one place ahead; 0 for the leader
  frozen: boolean; // drive sim frozen (pre-GO freeze: every phase but 'racing')
  assist: boolean; // KIDS MODE auto-steer active (drive.setAssist)
  code: string | null; // private-room invite code (null for public rooms / before join)
  canStart: boolean; // the lobby START button is live (server says a {t:'start'} lands)
}

interface KartRemoteDebug {
  id: string;
  name: string;
  place: number;
  lap: number;
  x: number; // last INTERPOLATED position (what is on screen)
  z: number;
  yaw: number;
  samples: number; // interpolation buffer depth
}

interface KartTelemetry {
  phase: KartPhase | 'menu';
  trackId: TrackId; // the currently loaded circuit (room's, or selectedTrackId pre-join)
  playerId: string | null;
  slot: number;
  seq: number; // kart_input frames sent (drive.ts owns the wire seq) — now SIM_HZ paced
  seqHz: number; // SIM_HZ: the input/sim rate, so a harness can calibrate its clock
  /** Reconciliation health — the netcode's own report card. */
  net: {
    ack: number; // you.lastProcessedSeq: the last input the server consumed
    pending: number; // unacknowledged inputs still queued for replay
    lastCorrectionM: number; // metres the last reconcile moved the predicted kart
    maxCorrectionM: number; // biggest this race (reset on each race reset)
    corrections: number; // reconciles that moved us > 0.05m this race
  };
  /** Most recent server-resolved contact seen (atMs = serverNow when received). */
  lastBump: { a: string; b: string; impulse: number; atMs: number } | null;
  offsetMs: number; // serverNow = Date.now() + offsetMs
  rttMs: number;
  input: KartInput; // the latched ext input (keyboard is drive-internal)
  own: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    speedMps: number;
    speedKmh: number;
    gear: number; // current gearbox gear (1-based)
    drifting: boolean;
    nitroLeft: number; // remaining nitro BOOST seconds (client sim, not the charge count)
  };
  remotes: KartRemoteDebug[];
  phaseEndsInMs: number;
  nitroLeft: number; // nitro charges left (you.nitroLeft, server-authoritative)
  gapAheadMs: number; // ms behind the player one place ahead; 0 for the leader
  frozen: boolean; // drive sim frozen (pre-GO freeze: every phase but 'racing')
  assist: boolean; // KIDS MODE auto-steer active (drive.setAssist)
  /**
   * Where the room is in its season, plus OUR line in it — so the screenshot
   * harness can assert WHICH championship screen it is shooting instead of
   * reading pixels. `null` on a championship-disabled room (and before the
   * first snapshot); points/pos are 0 while we have no standings row yet.
   */
  season: { round: number; rounds: number; points: number; pos: number; over: boolean } | null;
}

interface KartApi {
  state(): KartDebugState;
  joinQuick(name: string): void;
  createPublic(name: string): void;
  createPrivate(name: string): void;
  joinPrivate(name: string, code: string): void;
  /** Ask the room to start the race (same message the lobby START button sends). */
  startRace(): void;
  setInput(throttle: number, brake: number, steer: number, drift: boolean): void;
  telemetry(): KartTelemetry;
  /** Choose the circuit the NEXT create_public/create_private room will use. */
  setTrack(id: string): boolean;
}

declare global {
  interface Window {
    __kart?: KartApi;
  }
}

// ---- tuning ------------------------------------------------------------------
const RECONNECT_MS = 1000; // socket dropped -> back to the menu, retry quietly
const PING_EVERY_MS = 2000; // mirrors NET.pingEveryMs (platform protocol)
const ROOMS_EVERY_MS = 3000; // menu room-list poll
const WATCHDOG_MS = 200; // background-tab keepalive cadence (rAF pauses there)
const WATCHDOG_DT = 0.2; // s of sim per watchdog step (slow-mo, still < INPUT_STALE_MS)
const FRAME_STALE_MS = 250; // rAF silence that wakes the watchdog
// Remote karts render this far behind serverTime. Expressed as ~1.8 SNAPSHOT_HZ
// intervals rather than a constant, because that ratio — not the millisecond
// value — is what buys jitter tolerance: a snapshot may arrive most of an
// interval late and still be interpolated rather than extrapolated. It was a
// hardcoded 120ms, which was exactly 1.8 intervals at the old SNAPSHOT_HZ 15;
// keeping the RATIO at the new 20Hz makes it 90ms, so the faster snapshot rate
// is spent on latency (~0.6m less positional lag at racing speed) instead of on
// buffer nobody asked for. Two clients disagree about a kart's position by
// roughly (this delay x its speed), so it is the single biggest term in that
// number once the two peers agree on the physics.
const INTERP_DELAY_MS = Math.round(1800 / SNAPSHOT_HZ);
const BUFFER_KEEP_MS = 1000; // per-remote snapshot history
const EXTRAPOLATE_MAX_MS = 250; // past-newest velocity extrapolation cap
const TELEPORT_SQ = 10 * 10; // m² — bigger jumps snap, never lerp (matches fps interp)
const CORRECTION_EPS_M = 0.05; // reconciles that move us less than this are "converged"
const OFFSET_EMA = 0.2; // server-clock offset smoothing per pong (spike must not lurch remotes)
const MAX_FRAME_DT = 0.05; // s — tab-switch clamp for the local sim
const GO_FLASH_MS = 900; // how long the big GO! stays up
const HINT_HOLD_MS = 5000; // controls hint card stays fully up this long after GO…
const HINT_FADE_MS = 1000; // …then fades out (gone at ~6s, per docs/KART.md)
const MSG_MS = 2600; // transient center message lifetime
const THUD_DROP = 4; // m/s of forward speed lost in one frame => barrier thud
// ---- fx emit pacing (fx.ts pools; distances in m, rates in s) -----------------
const SKID_MARK_EVERY = 0.5; // per-wheel mark spacing (fx pool covers ~32m of trail)
const SKID_MIN_SPEED = 3; // no marks while crawling
const BRAKE_SKID_DECEL = 14; // m/s² — hard braking lays marks too (BRAKE is 24)
const BRAKE_SKID_MIN_SPEED = 8; // ...only at real speed
const SMOKE_EVERY_S = 0.045; // drift smoke cadence — discrete puffs with gaps
const DUST_EVERY_S = 0.045; // grass dust cadence
const DUST_MIN_SPEED = 6;
const TRAIL_EVERY_S = 0.03; // nitro streak cadence
const WHEEL_REAR = 0.78; // rear axle offset behind the kart origin (kartMesh)
const WHEEL_HALF = 0.66; // half track width (kartMesh wheel spots)
const NOSE_AHEAD = 1.4; // spark burst point ahead of the kart origin
const MINIMAP_EVERY_MS = 250; // 4Hz minimap redraw
const MINIMAP_SIZE = 140; // css px (2x backing store for retina)
const NAME_MAX = 16; // lobby cleanName cap (platform protocol)
const CODE_MAX = 8;
const KIDS_KEY = 'kart.kids'; // localStorage key for the KIDS MODE assist toggle
// ---- tablet mode (docs/TOUCH_PWA.md §4) --------------------------------------
// TABLET MODE is an input SURFACE for anyone on a touch device, adults
// included; KIDS MODE is an ASSIST layered on top. They are independent axes and
// all four combinations are live, so they are separate keys and separate
// toggles. `kart.tablet` absent = auto-detect; '1'/'0' = the player decided.
const TABLET_KEY = 'kart.tablet';
const LEFTY_KEY = 'kart.lefty'; // swap the steering/driving halves for left-handers
const TWO_PI = Math.PI * 2;

/** drive.state() shape per the frozen drive.ts signature (docs/KART.md). */
type DriveState = KartState & { steer: number; driftVisual: number };

/** One buffered remote snapshot (serverTime ms). */
interface RemoteSample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  steer: number;
  drift: boolean;
  nitroActive: boolean;
}

/** What gets drawn for a remote kart this frame. */
interface RemoteVisual {
  x: number;
  y: number;
  z: number;
  yaw: number;
  steer: number;
  drift: boolean;
  nitroActive: boolean;
}

/** Per-remote fx bookkeeping: last laid skid-mark position per rear wheel + emit clocks. */
interface RemoteFxState {
  lx: number;
  lz: number;
  rx: number;
  rz: number;
  init: boolean;
  smokeAcc: number;
  trailAcc: number;
  side: boolean; // smoke/dust puff wheel alternation
}

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

/**
 * A persisted settings flag. `null` means "never set" — which is NOT the same
 * as false for tablet mode (absent = auto-detect) or auto-throttle (absent =
 * follow KIDS MODE), so the tri-state is the return type rather than a default
 * baked in here. Storage blocked (private mode) reads as never-set.
 */
function readFlag(key: string): boolean | null {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return null;
    return v === '1' || v === 'true';
  } catch {
    return null;
  }
}

/** Persist a settings flag; a blocked store still leaves the toggle live for the session. */
function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // storage unavailable — the toggle still works for this session
  }
}

/** KIDS MODE persisted toggle (localStorage 'kart.kids'); false when storage is blocked. */
function readKidsStored(): boolean {
  return readFlag(KIDS_KEY) === true;
}

/** 'm:ss.mmm' race-clock format; '—' for unset (-1) times. */
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const mmm = total % 1000;
  const ss = String(s).padStart(2, '0');
  const tail = String(mmm).padStart(3, '0');
  return `${m}:${ss}.${tail}`;
}

/** English ordinal suffix for a 1-based place (grid is ≤ 8, no 11/12/13 case). */
function ordinalSuffix(place: number): string {
  if (place === 1) return 'st';
  if (place === 2) return 'nd';
  if (place === 3) return 'rd';
  return 'th';
}

/** Shortest-arc lerp for wrapped radians (same as the fps interp). */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

function clampNum(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
}

/** Sample a remote buffer at renderTime: lerp the bracketing pair, snap on
 *  teleports, extrapolate by velocity only up to EXTRAPOLATE_MAX_MS. */
function sampleBuffer(buf: RemoteSample[], renderTime: number): RemoteVisual | null {
  const n = buf.length;
  if (n === 0) return null;
  let lo = -1;
  for (let i = n - 1; i >= 0; i--) {
    const s = buf[i];
    if (s !== undefined && s.t <= renderTime) {
      lo = i;
      break;
    }
  }
  if (lo < 0) {
    const first = buf[0];
    if (first === undefined) return null; // unreachable; satisfies noUncheckedIndexedAccess
    return { x: first.x, y: first.y, z: first.z, yaw: first.yaw, steer: first.steer, drift: first.drift, nitroActive: first.nitroActive };
  }
  const a = buf[lo];
  if (a === undefined) return null; // unreachable
  const b = buf[lo + 1];
  if (b === undefined) {
    // at/after the newest sample: short velocity extrapolation, position only
    const k = Math.min(EXTRAPOLATE_MAX_MS, Math.max(0, renderTime - a.t)) / 1000;
    return { x: a.x + a.vx * k, y: a.y, z: a.z + a.vz * k, yaw: a.yaw, steer: a.steer, drift: a.drift, nitroActive: a.nitroActive };
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  if (dx * dx + dy * dy + dz * dz > TELEPORT_SQ) {
    return { x: b.x, y: b.y, z: b.z, yaw: b.yaw, steer: b.steer, drift: b.drift, nitroActive: b.nitroActive }; // teleport: snap
  }
  const span = b.t - a.t;
  const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.t) / span)) : 1;
  return {
    x: a.x + dx * t,
    y: a.y + dy * t,
    z: a.z + dz * t,
    yaw: lerpAngle(a.yaw, b.yaw, t),
    steer: a.steer + (b.steer - a.steer) * t,
    drift: b.drift, // discrete fields from the newer sample
    nitroActive: b.nitroActive,
  };
}

export class KartApp {
  private ws: WebSocket | null = null;
  private welcomed = false;
  private playerId: string | null = null;
  private rooms: RoomInfo[] = [];
  private screen: 'menu' | 'race' = 'menu';

  // ---- room/race state (server truth arrives via kart_joined + snapshots) -------
  private joined = false;
  private slot = 0; // our grid slot (join order)
  private colorIdx = 0; // our KART_COLORS index
  private roomCode: string | null = null; // invite code from kart_joined (private rooms)
  private phase: KartPhase = 'lobby';
  private you: KartYou | null = null;
  private phaseEndsAt = 0; // serverTime ms; 0 when no phase timer
  // ---- lobby contract (server truth; the START button reads these) --------------
  private seatedCount = 0; // players seated in the room (snapshot playerCount)
  private minPlayers = MIN_PLAYERS; // the room's minimum (snapshot minPlayers)
  private canStart = false; // a {t:'start'} would be accepted right now
  // ---- championship contract (mirrored on every snapshot; null = disabled room) ----
  // Held raw and rendered from, never mutated: `standings` is the server's
  // sorted table and re-sorting it here would silently re-litigate the tie-break.
  private season: KartSeason | null = null;
  private readonly players = new Map<string, KartPlayerSnap>(); // latest snapshot per id
  private readonly roster = new Map<string, KartPlayerInfo>(); // names/colors/slots per id
  private readonly bestLaps = new Map<string, number>(); // from 'lap' race events (results table)

  // ---- net timing ----------------------------------------------------------------
  private offset = 0; // serverNow = Date.now() + offset (rtt/2 estimate, like bank)
  private offsetSet = false; // first pong sets the offset directly; later pongs EMA it
  private rttMs = 0;
  private packetsSent = 0; // kart_input frames actually sent (drive.ts owns the seq)
  // ---- reconciliation health (telemetry; the two-client verification reads these) ----
  private ackSeq = 0; // you.lastProcessedSeq — the last input the server consumed
  private maxCorrectionM = 0; // biggest reconcile this race (reset per race)
  private corrections = 0; // reconciles that moved us > CORRECTION_EPS_M (per race)
  private lastBump: { a: string; b: string; impulse: number; atMs: number } | null = null;

  // ---- local kart + remotes -------------------------------------------------------
  private trackId: TrackId = DEFAULT_TRACK_ID;
  private track: TrackDef = buildTrack(TRACKS[DEFAULT_TRACK_ID]);
  /** Room-create circuit choice (no track-picker UI yet; set via __kart.setTrack). */
  private selectedTrackId: TrackId = DEFAULT_TRACK_ID;
  private readonly drive: DriveController;
  private readonly scene: KartScene;
  private readonly audio = new KartAudio();
  private readonly sceneKarts = new Set<string>(); // ids currently added to the scene
  private readonly buffers = new Map<string, RemoteSample[]>(); // per-remote interp history
  private readonly visuals = new Map<string, RemoteVisual>(); // last drawn remote pose (telemetry)

  // ---- input -----------------------------------------------------------------------
  // The keyboard is owned by drive.ts. app.ts injects exactly ONE external
  // input — `extInput`, the merge of the latched debug driver (e2e) and the
  // tablet touch pad — through the single drive.setInput() latch. There is no
  // second input path, and touch never disables the keyboard: a tablet with a
  // keyboard attached drives with either, or both.
  private debugInput: KartInput | null = null; // __kart.setInput override (e2e driver)
  /** The merged latch handed to drive.setInput(). Reused — never allocated per event. */
  private readonly extInput: KartInput = { throttle: 0, brake: 0, steer: 0, drift: false };
  /** Tablet pad: which pointerId is on which control (see drive.ts TouchPointers). */
  private readonly touch = new TouchPointers();
  /** Pad targets in hit-test order + a flat rect cache (x0,y0,x1,y1 per entry). */
  private readonly touchTargets: { el: HTMLDivElement; control: TouchControl }[] = [];
  private readonly touchRects: number[] = [];
  private touchRectsDirty = true; // resize / layout change: re-measure before the next press
  private tabletPref: boolean | null = null; // explicit settings override (null = auto-detect)
  private tabletSeen = false; // a coarse/no-hover pointer exists (media query or a real event)
  private padVisible = false; // last written pad visibility, so the phase sync is a no-op write
  private lefty = false; // swap the halves for a left-handed player
  private wakeLock: WakeLockSentinel | null = null; // screen wake lock while a race is live

  // ---- presentation state ------------------------------------------------------------
  private countdownShown = 0; // big number currently up (dedupes event + snapshot)
  private goActive = false;
  private goUntil = 0; // performance.now() deadline for the GO! flash
  private goAt = 0; // performance.now() at GO (0 = none yet); times the hint card fade
  private msgUntil = 0; // performance.now() deadline for the transient message
  private lapStartAt = 0; // serverNow ms when the current lap began
  private lastYouLap = 1; // previous snapshot lap (edge detection)
  private lastLapMs = -1; // our last completed lap (from 'lap' events)
  private frozenLapMs = -1; // lap-time value frozen at our finish
  private wasFinished = false;
  private prevSpeed = 0;
  private lastFrame = 0;
  private assist = false; // KIDS MODE auto-steer (docs/KART.md) — mirrored to localStorage 'kart.kids'

  // ---- fx (./fx.js pools) + minimap ------------------------------------------------
  private readonly fx: KartFx;
  private readonly ownFx: RemoteFxState = {
    lx: 0, lz: 0, rx: 0, rz: 0, init: false, smokeAcc: 0, trailAcc: 0, side: false,
  };
  private dustAcc = 0;
  private readonly remoteFx = new Map<string, RemoteFxState>();
  private minimapNextAt = 0; // performance.now() of the next 4Hz redraw
  // not readonly: fitMinimap() recomputes these when applyTrack() swaps circuits
  private mapPath: Path2D = new Path2D(); // track outline, precomputed once
  private mapScale = 1; // world -> map px: mx = (x + mapOffX) * mapScale
  private mapOffX = 0;
  private mapOffZ = 0;

  // ---- DOM handles (built once in the constructor, updated in place) ----------------
  private readonly menuEl: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly kidsInput: HTMLInputElement; // menu KIDS MODE checkbox
  private readonly tabletInput: HTMLInputElement; // menu TABLET CONTROLS checkbox
  private readonly leftyInput: HTMLInputElement; // menu LEFT-HANDED checkbox
  private readonly touchEl: HTMLDivElement; // the tablet control surface (hidden off touch)
  private readonly roomsEl: HTMLDivElement;
  private readonly menuButtons: HTMLButtonElement[] = [];
  private readonly raceEl: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly hudEl: HTMLDivElement;
  // PAD (docs/PAD.md): pair a phone as this seat's controller.
  private padBtn!: HTMLButtonElement;
  private padQrEl!: HTMLDivElement;
  private padQrCodeEl!: HTMLDivElement;
  private padQrNoteEl!: HTMLDivElement;
  private readonly hudLeftEl: HTMLDivElement; // top-left chip stack (pos + lap; hosts the invite chip mid-race)
  private readonly placeNumEl: HTMLSpanElement; // big ordinal numeral ('2')
  private readonly placeSufEl: HTMLSpanElement; // ordinal suffix ('nd')
  private readonly placeTotalEl: HTMLSpanElement; // '/N' field size
  private readonly placeGapEl: HTMLDivElement; // '+1.8s' / 'LEADER'
  private readonly crownEl: HTMLDivElement; // P1 accent badge, hidden off the lead
  private readonly kidsBadgeEl: HTMLDivElement; // small 'KIDS' badge in the position chip
  private readonly lapEl: HTMLDivElement;
  private readonly speedNumEl: HTMLSpanElement;
  private readonly speedBarEl: HTMLDivElement; // speed meter fill (width is the only JS-set style)
  private prevSpeedPct = -1; // last written meter width, to skip no-op style writes
  private readonly gearEl: HTMLSpanElement;
  private prevShifting = false; // upshift rising edge, for the one-shot gear flash
  private readonly lapTimeEl: HTMLSpanElement;
  private readonly bestEl: HTMLSpanElement;
  private readonly nitroEl: HTMLDivElement;
  private readonly nitroPips: HTMLSpanElement[] = []; // NITRO_CHARGES pips, dim when spent
  private prevNitroPips = NITRO_CHARGES; // spend-edge detection for the pip flash
  private lastSurface: 'asphalt' | 'grass' = 'asphalt'; // from updateFx, for the skid sfx
  private readonly minimapEl: HTMLCanvasElement;
  private readonly gateWrapEl: HTMLDivElement;
  private readonly gateEl: HTMLDivElement;
  private readonly gateLabelEl: HTMLDivElement;
  private readonly lobbyEl: HTMLDivElement;
  private readonly lobbySeasonEl: HTMLDivElement; // championship placard (hidden when disabled)
  private readonly lobbyRoundEl: HTMLDivElement; // 'ROUND 3 OF 8 · RIVERSIDE'
  private readonly lobbySeasonNoteEl: HTMLDivElement; // our own standing, in words
  private readonly lobbyPlayersEl: HTMLDivElement;
  private readonly lobbyStatusEl: HTMLDivElement;
  private readonly lobbyHintEl: HTMLDivElement; // grid controls line (keyboard vs tablet)
  private readonly startBtn: HTMLButtonElement; // explicit race start (no auto-start)
  private readonly countdownEl: HTMLDivElement;
  private readonly msgEl: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private readonly inviteEl: HTMLDivElement; // private-room invite chip ('CIRCUIT · code XXXXX')
  private readonly inviteCodeEl: HTMLSpanElement;
  private readonly copyBtn: HTMLButtonElement;
  private copiedTimer = 0; // 'COPIED' feedback reset handle
  private readonly resultsEl: HTMLDivElement;
  private readonly resultsPanelEl: HTMLDivElement; // carries 'season-final' at season end
  private readonly resultsBodyEl: HTMLTableSectionElement;
  // ---- championship block inside the results panel (hidden when disabled) ----
  private readonly standingsEl: HTMLDivElement;
  private readonly standingsTitleEl: HTMLDivElement;
  private readonly standingsBodyEl: HTMLTableSectionElement;
  private readonly standingsNextEl: HTMLDivElement; // 'NEXT ROUND · CLIFFSIDE'
  private readonly championEl: HTMLDivElement; // trophy banner, only when season.over
  private readonly championNameEl: HTMLDivElement;
  private readonly championStatEl: HTMLDivElement;
  private readonly resultsNoteEl: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.assist = readKidsStored(); // KIDS MODE persisted toggle (localStorage 'kart.kids')
    this.tabletPref = readFlag(TABLET_KEY); // null = auto-detect from the pointer
    this.lefty = readFlag(LEFTY_KEY) === true;
    // §4.4: no user-agent sniffing. A coarse pointer with no hover IS a touch
    // device by the only definition the platform gives us; a real touch/pen
    // pointerdown (wired below) arms it too, for the hybrids the query misses.
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const coarse = window.matchMedia('(hover: none) and (pointer: coarse)');
      this.tabletSeen = coarse.matches;
      coarse.addEventListener('change', (e) => {
        this.tabletSeen = this.tabletSeen || e.matches;
        this.syncTouchUi();
      });
    }

    // ---- menu screen ----------------------------------------------------------
    this.menuEl = el('div', 'screen menu');
    this.menuEl.appendChild(el('h1', 'menu-title', 'KART GP'));
    this.menuEl.appendChild(el('p', 'menu-sub', 'multiplayer kart racing — 3 laps, first over the line'));
    this.noticeEl = el('div', 'menu-notice hidden');
    this.menuEl.appendChild(this.noticeEl);

    this.nameInput = el('input', 'menu-name');
    this.nameInput.maxLength = NAME_MAX;
    this.nameInput.placeholder = 'your name';
    this.nameInput.autocomplete = 'off';
    this.nameInput.value = loadName(); // shared across every game; '' leaves the placeholder showing
    this.menuEl.appendChild(this.nameInput);

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

    // invite link (?code=XXXXX): prefill the private-code input (bank convention)
    const linkCode = new URLSearchParams(location.search).get('code');
    if (linkCode !== null && linkCode.trim().length > 0) {
      this.codeInput.value = linkCode.trim().slice(0, CODE_MAX);
    }

    // KIDS MODE auto-steer assist (docs/KART.md "Kids mode") — persisted in localStorage
    const kidsRow = el('label', 'menu-kids');
    this.kidsInput = el('input');
    this.kidsInput.type = 'checkbox';
    this.kidsInput.checked = this.assist;
    this.kidsInput.addEventListener('change', () => this.setAssist(this.kidsInput.checked));
    kidsRow.appendChild(this.kidsInput);
    kidsRow.appendChild(el('span', 'menu-kids-label', 'KIDS MODE — auto steer'));
    this.menuEl.appendChild(kidsRow);

    // TABLET MODE and its one shape setting. Deliberately a separate row from
    // KIDS MODE: the pad is a full racing surface for an adult on an iPad, not
    // a children's feature (docs/TOUCH_PWA.md §4.2.0), and KIDS MODE does not
    // change it — there is ONE touch layout. Both are visible on desktop too —
    // a touchscreen laptop must be able to opt IN, and a tablet player must be
    // able to opt OUT, without any user-agent guessing.
    const toggles = el('div', 'menu-toggles');
    this.tabletInput = this.toggleChip(toggles, 'TABLET CONTROLS', this.tabletActive(), (on) => {
      this.tabletPref = on;
      writeFlag(TABLET_KEY, on);
      this.syncTouchUi();
    });
    this.leftyInput = this.toggleChip(toggles, 'LEFT-HANDED', this.lefty, (on) => {
      this.lefty = on;
      writeFlag(LEFTY_KEY, on);
      this.syncTouchUi();
    });
    this.menuEl.appendChild(toggles);

    this.menuEl.appendChild(el('h2', 'menu-rooms-title', 'TRACKS'));
    this.roomsEl = el('div', 'menu-rooms');
    this.menuEl.appendChild(this.roomsEl);

    // ---- race screen ----------------------------------------------------------
    this.raceEl = el('div', 'screen race hidden');
    this.canvas = el('canvas', 'race-canvas');
    this.raceEl.appendChild(this.canvas);

    const raceTop = el('div', 'race-top');
    const leaveBtn = el('button', 'btn btn-small', 'LEAVE');
    leaveBtn.addEventListener('click', () => {
      this.audio.resume();
      leaveBtn.blur(); // keep SPACE/arrows off the focused button while driving
      this.leaveToMenu('');
    });
    raceTop.appendChild(leaveBtn);
    this.raceEl.appendChild(raceTop);

    // HUD: compact position chip + lap chip (top-left), gear/speed + minimap
    // (top-right), times (bottom-left), nitro pips (bottom-right), next-gate
    // chevron (top-center)
    this.hudEl = el('div', 'hud hidden');
    // corner scrims: a soft ink wash under each chip cluster so the HUD reads
    // over near-black asphalt AND over a white sky. Decorative only, appended
    // first so they sit behind every cluster.
    for (const corner of ['hud-corner-tl', 'hud-corner-tr', 'hud-corner-bl', 'hud-corner-br']) {
      this.hudEl.appendChild(el('div', `hud-scrim ${corner}`));
    }
    const hudLeft = el('div', 'hud-left');
    this.hudLeftEl = hudLeft;
    // top of the HUD value ladder: place and speed are the two reads a driver
    // takes at 200 km/h, so they carry the 'hi' chip tier; everything else is
    // reference data on 'lo'
    const pos = el('div', 'hud-pos hud-chip hud-chip-hi');
    // P1 accent — textless, so the stylesheet draws its own mark
    this.crownEl = el('div', 'hud-pos-crown hidden');
    pos.appendChild(this.crownEl);
    const posMain = el('div', 'hud-pos-main');
    this.placeNumEl = el('span', 'hud-pos-num', '—');
    this.placeSufEl = el('span', 'hud-pos-suf', '');
    posMain.appendChild(this.placeNumEl);
    posMain.appendChild(this.placeSufEl);
    this.placeTotalEl = el('span', 'hud-pos-total', '');
    posMain.appendChild(this.placeTotalEl);
    pos.appendChild(posMain);
    this.placeGapEl = el('div', 'hud-pos-gap', '');
    pos.appendChild(this.placeGapEl);
    // KIDS badge: small, inside the position chip
    this.kidsBadgeEl = el('div', 'hud-kids hidden', 'KIDS');
    pos.appendChild(this.kidsBadgeEl);
    hudLeft.appendChild(pos);
    this.lapEl = el('div', 'hud-lap hud-chip hud-chip-lo', `LAP 1/${LAPS_TO_WIN}`);
    hudLeft.appendChild(this.lapEl);
    this.hudEl.appendChild(hudLeft);

    const hudRight = el('div', 'hud-right');
    const speed = el('div', 'hud-speed hud-chip hud-chip-hi');
    // gear stacked ABOVE the speed — adjacent big numerals kerned into one read
    const gearRow = el('div', 'hud-gear-row');
    gearRow.appendChild(el('span', 'hud-gear-label', 'GEAR'));
    this.gearEl = el('span', 'hud-gear', '1');
    gearRow.appendChild(this.gearEl);
    speed.appendChild(gearRow);
    const speedRow = el('div', 'hud-speed-row');
    this.speedNumEl = el('span', 'hud-speed-num', '0');
    speedRow.appendChild(this.speedNumEl);
    speedRow.appendChild(el('span', 'hud-speed-unit', 'km/h'));
    speed.appendChild(speedRow);
    // speed meter: fraction of the physics ceiling, so only nitro pegs it
    this.speedBarEl = el('div', 'hud-speed-bar');
    speed.appendChild(this.speedBarEl);
    hudRight.appendChild(speed);
    // minimap: track outline + live player dots, redrawn at 4Hz (MINIMAP_EVERY_MS)
    this.minimapEl = el('canvas', 'hud-minimap hud-chip hud-chip-lo');
    this.minimapEl.width = MINIMAP_SIZE * 2; // 2x backing store — crisp on retina
    this.minimapEl.height = MINIMAP_SIZE * 2;
    hudRight.appendChild(this.minimapEl);
    this.hudEl.appendChild(hudRight);

    const hudTimes = el('div', 'hud-times hud-chip hud-chip-lo');
    const lapRow = el('div', 'hud-time-row');
    lapRow.appendChild(el('span', 'hud-time-label', 'LAP'));
    this.lapTimeEl = el('span', 'hud-time-value', '—');
    lapRow.appendChild(this.lapTimeEl);
    hudTimes.appendChild(lapRow);
    hudTimes.appendChild(el('div', 'hud-rule')); // hairline between current and best
    const bestRow = el('div', 'hud-time-row');
    bestRow.appendChild(el('span', 'hud-time-label', 'BEST'));
    this.bestEl = el('span', 'hud-time-value hud-best', '—');
    bestRow.appendChild(this.bestEl);
    hudTimes.appendChild(bestRow);
    this.hudEl.appendChild(hudTimes);

    // nitro pips: NITRO_CHARGES small charges at the bottom-right, dim when spent
    this.nitroEl = el('div', 'hud-nitro hud-chip hud-chip-lo');
    this.nitroEl.appendChild(el('div', 'hud-turbo-label', 'NITRO'));
    this.nitroEl.appendChild(el('div', 'hud-rule'));
    const pipRow = el('div', 'hud-nitro-pips');
    for (let i = 0; i < NITRO_CHARGES; i++) {
      // pips start FULL — the base class is the empty socket, the modifier is the charge
      const pip = el('span', 'hud-nitro-pip hud-nitro-pip-full');
      this.nitroPips.push(pip);
      pipRow.appendChild(pip);
    }
    this.nitroEl.appendChild(pipRow);
    this.hudEl.appendChild(this.nitroEl);

    // next-gate marker: rotating chevron + distance label in one chip-family wrap
    this.gateWrapEl = el('div', 'hud-gate-wrap hidden');
    this.gateEl = el('div', 'hud-gate');
    this.gateWrapEl.appendChild(this.gateEl);
    this.gateLabelEl = el('div', 'hud-gate-label', '');
    this.gateWrapEl.appendChild(this.gateLabelEl);
    this.hudEl.appendChild(this.gateWrapEl);
    this.raceEl.appendChild(this.hudEl);

    // ---- tablet control surface (docs/TOUCH_PWA.md §4) ------------------------
    // Built once, hidden unless tablet mode is live, and appended HERE so the
    // lobby / countdown / results overlays (added below, higher z-index) always
    // paint over it — a pad on top of the START button would be unrecoverable.
    // Left half steers, right half drives; KIDS MODE removes the right half
    // from the DOM's reach via CSS `display:none`, so a child never sees a
    // control she cannot use. Sides swap with `.lefty`.
    this.touchEl = el('div', 'touch-pad hidden');
    const steerWrap = el('div', 'touch-steer');
    this.padButton(steerWrap, 'left', 'touch-btn touch-steer-btn', el('div', 'touch-arrow-l'));
    this.padButton(steerWrap, 'right', 'touch-btn touch-steer-btn', el('div', 'touch-arrow-r'));
    this.touchEl.appendChild(steerWrap);
    const driveWrap = el('div', 'touch-drive');
    // GAS is the largest target and sits lowest/outermost, under the resting
    // thumb; NITRO and DRIFT are smaller and set inboard-and-up, off the arc a
    // thumb sweeps while pulling gas.
    this.padButton(driveWrap, 'gas', 'touch-btn touch-gas', el('div', 'touch-label', 'GAS'));
    this.padButton(driveWrap, 'drift', 'touch-btn touch-drift', el('div', 'touch-label', 'DRIFT'));
    this.padButton(driveWrap, 'nitro', 'touch-btn touch-nitro', el('div', 'touch-label', 'NITRO'));
    this.touchEl.appendChild(driveWrap);
    this.raceEl.appendChild(this.touchEl);

    // lobby overlay: the grid (player list) + phase status
    this.lobbyEl = el('div', 'lobby-overlay hidden');
    const lobbyPanel = el('div', 'lobby-panel');
    lobbyPanel.appendChild(el('div', 'lobby-title', 'GRID'));
    // Championship placard, directly under the title: a joiner has to be able to
    // read what they walked into (which round, which circuit, where THEY stand)
    // before they read the grid. Whole block hides on a championship-disabled
    // room, so that lobby is pixel-identical to the pre-championship one.
    this.lobbySeasonEl = el('div', 'lobby-season hidden');
    this.lobbyRoundEl = el('div', 'lobby-round', '');
    this.lobbySeasonEl.appendChild(this.lobbyRoundEl);
    this.lobbySeasonNoteEl = el('div', 'lobby-season-note', '');
    this.lobbySeasonEl.appendChild(this.lobbySeasonNoteEl);
    lobbyPanel.appendChild(this.lobbySeasonEl);
    this.lobbyPlayersEl = el('div', 'lobby-players');
    lobbyPanel.appendChild(this.lobbyPlayersEl);
    this.lobbyStatusEl = el('div', 'lobby-status', '');
    lobbyPanel.appendChild(this.lobbyStatusEl);
    // START: the room never auto-starts. Any seated player may press it; it is
    // disabled (with the reason on .lobby-status right above) below MIN_PLAYERS.
    this.startBtn = el('button', 'btn btn-gold lobby-start', 'START RACE');
    this.startBtn.addEventListener('click', () => {
      this.audio.resume();
      this.startBtn.blur(); // keep SPACE/arrows off the focused button once racing
      if (this.canStart) this.send({ t: 'start' });
    });
    lobbyPanel.appendChild(this.startBtn);
    // USE PHONE: asks the room for a single-use pairing token; the QR that
    // answers is the phone's whole entry point (docs/PAD.md step 1-2).
    this.padBtn = el('button', 'btn btn-small lobby-pad', 'USE PHONE');
    this.padBtn.addEventListener('click', () => {
      this.audio.resume();
      this.padBtn.blur();
      this.send({ t: 'pad_pair_request' } as unknown as KartC2S);
    });
    lobbyPanel.appendChild(this.padBtn);
    this.lobbyHintEl = el('div', 'lobby-hint', 'WASD / ARROWS to drive — SPACE to drift');
    lobbyPanel.appendChild(this.lobbyHintEl);
    this.lobbyEl.appendChild(lobbyPanel);
    this.raceEl.appendChild(this.lobbyEl);

    // controls hint card (docs/KART.md "Onboarding hints"): non-modal, bottom-center;
    // up pre-GO, holds ~5s after GO, then fades.
    this.hintEl = el(
      'div',
      'hint-card',
      `WASD/arrows drive · Space/Shift drift · N nitro ×${NITRO_CHARGES} · R respawn at last gate`,
    );
    this.raceEl.appendChild(this.hintEl);

    // Pairing overlay: the QR itself plus the URL in text, because a phone on
    // the same LAN cannot scan a code it cannot see from across the room.
    this.padQrEl = el('div', 'pad-qr hidden');
    const padPanel = el('div', 'pad-qr-panel');
    padPanel.appendChild(el('div', 'pad-qr-title', 'SCAN TO USE YOUR PHONE'));
    this.padQrCodeEl = el('div', 'pad-qr-code');
    padPanel.appendChild(this.padQrCodeEl);
    this.padQrNoteEl = el('div', 'pad-qr-note', '');
    padPanel.appendChild(this.padQrNoteEl);
    const padClose = el('button', 'btn btn-small', 'CLOSE');
    padClose.addEventListener('click', () => {
      padClose.blur();
      this.padQrEl.classList.add('hidden');
    });
    padPanel.appendChild(padClose);
    this.padQrEl.appendChild(padPanel);
    this.raceEl.appendChild(this.padQrEl);

    this.countdownEl = el('div', 'countdown-overlay hidden');
    this.raceEl.appendChild(this.countdownEl);

    this.msgEl = el('div', 'race-msg hidden');
    this.raceEl.appendChild(this.msgEl);

    // invite chip (private rooms only): top-left 'CIRCUIT · code XXXXX' + COPY
    // INVITE. Parks inside hud-left while the HUD is up (the position/lap chips
    // own the corner then); top-level above the lobby/results overlays otherwise.
    // Both homes — and the pill itself — are styled from style.css by parent
    // selector (`.hud-left > .race-invite` / `.race > .race-invite`); this file
    // sets no geometry (VISUAL_UPGRADE.md §9 inline-style hazard).
    this.inviteEl = el('div', 'race-invite hidden');
    this.inviteCodeEl = el('span', 'race-invite-code race-invite-chip');
    this.inviteEl.appendChild(this.inviteCodeEl);
    this.copyBtn = el('button', 'btn btn-small', 'COPY INVITE');
    this.copyBtn.addEventListener('click', () => {
      this.audio.resume();
      this.copyBtn.blur(); // keep SPACE/arrows off the focused button while driving
      this.copyInvite();
    });
    this.inviteEl.appendChild(this.copyBtn);
    this.raceEl.appendChild(this.inviteEl);

    // results overlay: place / name / time / best lap, auto-return note
    this.resultsEl = el('div', 'results-overlay hidden');
    const resultsPanel = el('div', 'results-panel');
    this.resultsPanelEl = resultsPanel;
    resultsPanel.appendChild(el('div', 'results-title', 'RESULTS'));
    const table = el('table', 'results-table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const h of ['PLACE', 'NAME', 'TIME', 'BEST LAP']) headRow.appendChild(el('th', undefined, h));
    thead.appendChild(headRow);
    table.appendChild(thead);
    this.resultsBodyEl = el('tbody');
    table.appendChild(this.resultsBodyEl);
    resultsPanel.appendChild(table);

    // Championship block: the race you just ran, then the season it belongs to.
    // Built once here and refilled in buildStandings(); `hidden` (and therefore
    // zero-height) on a championship-disabled room. Order is deliberate — the
    // trophy banner outranks the table it summarises, so it sits above it.
    this.standingsEl = el('div', 'results-standings hidden');
    this.championEl = el('div', 'champion-banner hidden');
    this.championEl.appendChild(el('div', 'champion-label', 'WORLD CHAMPION'));
    this.championNameEl = el('div', 'champion-name', '');
    this.championEl.appendChild(this.championNameEl);
    this.championStatEl = el('div', 'champion-stat', '');
    this.championEl.appendChild(this.championStatEl);
    this.standingsEl.appendChild(this.championEl);
    this.standingsTitleEl = el('div', 'standings-title', '');
    this.standingsEl.appendChild(this.standingsTitleEl);
    // the table lives in its own scroll box: 8 drivers fit at 720p, a 20-kart
    // season caps here instead of pushing the auto-return note off the panel
    const standingsScroll = el('div', 'standings-scroll');
    const standingsTable = el('table', 'standings-table');
    const standingsHead = el('thead');
    const standingsHeadRow = el('tr');
    for (const h of ['POS', 'DRIVER', 'PTS', '+']) {
      standingsHeadRow.appendChild(el('th', undefined, h));
    }
    standingsHead.appendChild(standingsHeadRow);
    standingsTable.appendChild(standingsHead);
    this.standingsBodyEl = el('tbody');
    standingsTable.appendChild(this.standingsBodyEl);
    standingsScroll.appendChild(standingsTable);
    this.standingsEl.appendChild(standingsScroll);
    this.standingsNextEl = el('div', 'standings-next', '');
    this.standingsEl.appendChild(this.standingsNextEl);
    resultsPanel.appendChild(this.standingsEl);

    this.resultsNoteEl = el('div', 'results-note', '');
    resultsPanel.appendChild(this.resultsNoteEl);
    this.resultsEl.appendChild(resultsPanel);
    this.raceEl.appendChild(this.resultsEl);

    root.appendChild(this.menuEl);
    root.appendChild(this.raceEl);

    // ---- scene + kart (frozen module signatures) ---------------------------------
    this.scene = new KartScene(this.canvas);
    this.scene.setTheme(this.track.theme);
    this.scene.buildTrack(this.track);
    setKartTrack(this.track); // arms the off-road check for the default circuit
    this.drive = new DriveController(this.track);
    this.drive.setAssist(this.assist); // kids-mode assist restored before the first join
    // nitro key (N) asks the SERVER to spend a charge; only racing may spend one.
    // The boost itself starts when the server's nitro race event echoes back.
    // The pad's NITRO button lands on the SAME request — one hook, two surfaces.
    this.drive.onNitro = () => this.requestNitro();
    this.scene.resize();

    // ---- fx pools + minimap precompute -------------------------------------------
    this.fx = new KartFx(KartFx.sceneRoot(this.scene), this.raceEl);
    this.fitMinimap();

    // ---- listeners (driving keys are owned by drive.ts; audio unlocks on clicks) ----
    window.addEventListener('resize', () => {
      if (this.screen === 'race') this.scene.resize();
      this.touchRectsDirty = true; // the pad moved: its cached rects are lies now
    });
    window.addEventListener('orientationchange', () => {
      this.touchRectsDirty = true;
    });
    // T toggles KIDS MODE in-game (docs/KART.md "Kids mode"); the menu uses the checkbox
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyT' || e.repeat || this.screen !== 'race') return;
      this.setAssist(!this.assist);
    });

    // ---- tablet pad: pointer wiring (docs/TOUCH_PWA.md §4.3) --------------------
    // Pointer Events, never Touch Events, so a mouse, a stylus and a thumb are
    // one code path. Everything is keyed by pointerId.
    //
    // The listeners live on the PAD, not on each button, because a touch
    // pointer is IMPLICITLY CAPTURED by whatever element it went down on: after
    // pointerdown, every pointermove keeps reporting that first element no
    // matter where the finger actually is. Sliding between zones is therefore
    // resolved against cached rects, not against e.target — the same reason
    // `touch-action: none` is on the pad in style.css.
    const pad = this.touchEl;
    pad.addEventListener('pointerdown', (e: PointerEvent) => {
      this.armTablet(e.pointerType);
      const control = this.hitTest(e.clientX, e.clientY);
      if (control === null) return;
      e.preventDefault(); // no scroll, no synthetic click, no text selection
      if (this.touch.press(e.pointerId, control) && control === 'nitro') this.requestNitro();
      this.audio.resume(); // first race touch may be the page's only gesture (iOS)
      this.paintTouch();
      this.applyExternalInput();
    });
    pad.addEventListener('pointermove', (e: PointerEvent) => {
      if (this.touch.count() === 0) return; // nothing down: a hovering mouse must not steer
      const control = this.hitTest(e.clientX, e.clientY);
      if (!this.touch.retarget(e.pointerId, control)) {
        this.paintTouch(); // the slide may still have RELEASED a control
        this.applyExternalInput();
        return;
      }
      if (control === 'nitro') this.requestNitro();
      this.paintTouch();
      this.applyExternalInput();
    });
    // pointerup, pointercancel (system interruption mid-press: notification,
    // app switch, palm rejection) and a lost capture all release identically.
    // If pointercancel did not release, the steering would stay latched until
    // the next press — the single worst failure this control scheme has.
    const releasePointer = (e: PointerEvent): void => {
      this.touch.release(e.pointerId);
      this.paintTouch();
      this.applyExternalInput();
    };
    pad.addEventListener('pointerup', releasePointer);
    pad.addEventListener('pointercancel', releasePointer);
    pad.addEventListener('lostpointercapture', releasePointer);
    // A pointer can also be lost with no event of its own: the tab is hidden,
    // the window is blurred by an app switch, the page navigates away. Nothing
    // may stay held through any of those.
    window.addEventListener('blur', () => this.clearTouch());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') {
        this.clearTouch();
      } else if (this.screen === 'race') {
        void this.acquireWakeLock(); // the lock is dropped whenever we are hidden
      }
    });
    // Auto-detect: the first REAL touch/pen pointer anywhere arms tablet mode,
    // which covers hybrids the media query calls a mouse. Capture phase so a
    // tap on a menu button arms it before the click handler changes screens.
    window.addEventListener(
      'pointerdown',
      (e: PointerEvent) => this.armTablet(e.pointerType),
      { capture: true, passive: true },
    );

    // ---- timers (setInterval for net: rAF pauses in background tabs) ---------------
    window.setInterval(() => {
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
        this.send({ t: 'ping', ts: performance.now() });
      }
    }, PING_EVERY_MS);
    window.setInterval(() => {
      if (this.screen === 'menu' && this.welcomed) this.send({ t: 'list_rooms' });
    }, ROOMS_EVERY_MS);
    window.setInterval(() => this.watchdog(), WATCHDOG_MS);

    this.lastFrame = performance.now();
    requestAnimationFrame(this.frameBound);

    // ---- frozen e2e debug surface ---------------------------------------------------
    window.__kart = {
      state: () => this.debugState(),
      joinQuick: (name) => this.joinQuick(name),
      createPublic: (name) => this.createPublic(name),
      createPrivate: (name) => this.createPrivate(name),
      joinPrivate: (name, code) => this.joinPrivate(name, code),
      // the room validates phase + count, so an early call is a harmless no-op
      startRace: () => this.send({ t: 'start' }),
      setInput: (throttle, brake, steer, drift) => this.setDebugInput(throttle, brake, steer, drift),
      telemetry: () => this.telemetrySnapshot(),
      setTrack: (id) => {
        if (!isTrackId(id)) return false;
        this.selectedTrackId = id;
        return true;
      },
    };

    this.syncTouchUi(); // pad + layout classes; a no-op on a desktop pointer
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
      const wasInRace = this.screen === 'race';
      this.welcomed = false;
      this.resetRoom();
      this.showMenu(wasInRace ? 'Connection lost — rejoining…' : '');
      window.setTimeout(() => this.connect(), RECONNECT_MS);
    };
    ws.onerror = () => {
      // the close event follows and does the teardown
    };
  }

  /** No-op unless the socket is open (mirrors the server's Session.send). */
  private send(msg: LobbyC2S | KartC2S): void {
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

  private selfId(): string {
    return this.playerId ?? 'you'; // welcome always precedes kart_joined
  }

  // ---- lobby actions (game filter 'kart' on every create/join; kart has no settings) --
  /**
   * Stamp identity on every outgoing join: `sig` always (the durable per-browser
   * signature — @platform/shared), `resume` when a dropped kart session exists
   * (exact and cheapest, so the room's rebind rule tries it first — platform
   * contract §2.3). Every join call site below routes through this; never stamp
   * inline.
   */
  private withIdentity<T extends LobbyC2S>(msg: T): T {
    const resume = loadSession('kart')?.playerId;
    return resume !== undefined ? { ...msg, sig: loadSig(), resume } : { ...msg, sig: loadSig() };
  }

  private joinQuick(name: string): void {
    const clean = cleanName(name);
    saveName(clean);
    const msg: Extract<LobbyC2S, { t: 'quick_join' }> = {
      t: 'quick_join',
      name: clean,
      game: 'kart',
    };
    this.send(this.withIdentity(msg));
  }
  private createPublic(name: string): void {
    const clean = cleanName(name);
    saveName(clean);
    const msg: Extract<LobbyC2S, { t: 'create_public' }> = {
      t: 'create_public',
      name: clean,
      game: 'kart',
      settings: { trackId: this.selectedTrackId },
    };
    this.send(this.withIdentity(msg));
  }
  private createPrivate(name: string): void {
    const clean = cleanName(name);
    saveName(clean);
    const msg: Extract<LobbyC2S, { t: 'create_private' }> = {
      t: 'create_private',
      name: clean,
      game: 'kart',
      settings: { trackId: this.selectedTrackId },
    };
    this.send(this.withIdentity(msg));
  }
  private joinPrivate(name: string, code: string): void {
    const c = code.trim();
    if (c.length === 0) {
      this.setNotice('enter a room code first');
      return;
    }
    const clean = cleanName(name);
    saveName(clean);
    const msg: Extract<LobbyC2S, { t: 'join_private' }> = {
      t: 'join_private',
      name: clean,
      code: c,
    };
    this.send(this.withIdentity(msg));
  }

  /** Room-list row click: join a specific room by id (same flow as joinPrivate). Carries
   *  `sig` + `resume` like every other join — kart used to carry no resume token
   *  (docs/KART.md: "resume token optional v1: NOT required"); that call is reversed:
   *  kart now persists a rejoin pointer like every other game (see @platform/shared
   *  SessionRecord and onJoined() below). */
  private joinPublic(name: string, roomId: string): void {
    const clean = cleanName(name);
    saveName(clean);
    const msg: Extract<LobbyC2S, { t: 'join_public' }> = {
      t: 'join_public',
      name: clean,
      roomId,
    };
    this.send(this.withIdentity(msg));
  }

  // ---- message routing -------------------------------------------------------------
  private onMessage(msg: S2C): void {
    switch (msg.t) {
      case 'welcome': {
        this.playerId = msg.playerId;
        this.welcomed = true;
        this.send({ t: 'list_rooms' });
        // Auto-rejoin is the point of the identity contract: 'welcome' is the
        // first message on EVERY connection — fresh boot and post-drop
        // reconnect alike — so a stored kart session re-enters that same room
        // with no click. Refresh the session's playerId first so the `resume`
        // this join sends (via withIdentity) chains to THIS socket, not a
        // dropped one — otherwise a second drop would resume a dead id.
        const session = loadSession('kart');
        if (session !== null) {
          saveSession('kart', { ...session, playerId: msg.playerId });
          this.setNotice('reconnecting…');
          const name = cleanName(loadName());
          if (session.code !== null) this.joinPrivate(name, session.code);
          else if (session.roomId !== null) this.joinPublic(name, session.roomId);
          else this.joinQuick(name);
        } else {
          this.setNotice('');
        }
        this.renderMenu();
        break;
      }
      case 'room_list':
        this.rooms = msg.rooms.filter((r) => r.game === 'kart'); // kart-only room list
        if (this.screen === 'menu') this.renderRooms();
        break;
      case 'pong': {
        const rtt = performance.now() - msg.ts;
        if (rtt >= 0) {
          this.rttMs = rtt;
          const measured = msg.serverTime + rtt / 2 - Date.now();
          // EMA, never replacement: a single rtt spike must not jump the
          // shared render time base — every remote kart would visibly lurch
          // by speed × Δoffset (worst on nitro-fast karts).
          this.offset = this.offsetSet
            ? this.offset + (measured - this.offset) * OFFSET_EMA
            : measured;
          this.offsetSet = true;
        }
        break;
      }
      case 'error':
        // 'no_room' is the server confirming the stored rejoin pointer is dead
        // (reaped room / stale code) — NOT a transport hiccup. Clear it so
        // auto-rejoin on the next 'welcome' falls through to quickJoin instead
        // of retrying the same corpse forever. Any other error code (e.g. a
        // drop) must leave the session alone: that is exactly what resume is
        // for (platform contract §3).
        if (msg.code === 'no_room') clearSession('kart');
        this.setNotice(msg.message);
        break;
      case 'kart_joined':
        this.onJoined(msg);
        break;
      case 'kart_snapshot':
        this.onSnapshot(msg);
        break;
      case 'race_event':
        this.onRaceEvent(msg.ev);
        break;
      default: {
        // Pad S2C rides the raw game envelope; the platform never parses it.
        const pad = parseKartPadToPlayerS2C(msg);
        if (pad !== null) this.onPadMessage(pad);
        break;
      }
    }
  }

  /** pad_pair / pad_status / pad_input — the seat's side of docs/PAD.md. */
  private onPadMessage(msg: KartPadToPlayerS2C): void {
    switch (msg.t) {
      case 'pad_pair':
        this.showPadQr(msg.room, msg.token, msg.expiresInMs);
        break;
      case 'pad_status':
        // The predictor switches input source here: while bound this client
        // emits nothing and predicts on the server's echoes instead.
        this.drive.setPadBound(msg.bound);
        if (msg.bound) this.padQrEl.classList.add('hidden');
        this.padBtn.textContent = msg.bound ? 'PHONE CONNECTED' : 'USE PHONE';
        this.setMsg(msg.bound ? 'phone connected — it drives now' : 'phone disconnected — keyboard restored');
        break;
      case 'pad_input':
        this.drive.applyPadInput(msg.input);
        break;
    }
  }

  private showPadQr(room: string, token: string, expiresInMs: number): void {
    const url = `${location.origin}${KART_PAD_PAGE_PATH}?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`;
    this.padQrCodeEl.replaceChildren();
    QrCreator.render(
      { text: url, radius: 0.4, ecLevel: 'M', fill: '#0b0b0f', background: '#ffffff', size: 220 },
      this.padQrCodeEl,
    );
    // location.origin is whatever THIS tab used: a phone on the LAN can only
    // reach it if the desktop is open on the LAN address, not localhost.
    this.padQrNoteEl.textContent = `${url}  ·  expires in ${String(Math.round(expiresInMs / 1000))}s`;
    this.padQrEl.classList.remove('hidden');
  }

  /**
   * Fit the minimap's static outline path + world->px projection to whichever
   * circuit is currently loaded (this.track). Recomputed on construction and
   * every time applyTrack() swaps circuits — a track-specific bounds fit that
   * used to assume the one track's centerline.
   */
  private fitMinimap(): void {
    const cl = this.track.centerline;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const c of cl) {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minZ) minZ = c[1];
      if (c[1] > maxZ) maxZ = c[1];
    }
    const pad = 9;
    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    this.mapScale = Math.min((MINIMAP_SIZE - pad * 2) / spanX, (MINIMAP_SIZE - pad * 2) / spanZ);
    // center the shorter axis; project: mx = (x + mapOffX) * mapScale
    this.mapOffX = -minX + (MINIMAP_SIZE / this.mapScale - spanX) / 2;
    this.mapOffZ = -minZ + (MINIMAP_SIZE / this.mapScale - spanZ) / 2;
    const path = new Path2D();
    for (let i = 0; i < cl.length; i++) {
      const c = cl[i]!;
      const mx = (c[0] + this.mapOffX) * this.mapScale;
      const my = (c[1] + this.mapOffZ) * this.mapScale;
      if (i === 0) path.moveTo(mx, my);
      else path.lineTo(mx, my);
    }
    path.closePath();
    this.mapPath = path;
  }

  /**
   * Adopt the room's circuit. No-op when it is already loaded. Rebuilds the
   * mesh, the sim/predictor track, the kart off-road check and the minimap
   * fit. Cheap identity check keeps this off the per-snapshot hot path.
   */
  private applyTrack(id: TrackId): void {
    if (id === this.trackId) return;
    this.trackId = id;
    this.track = buildTrack(TRACKS[id]);
    this.scene.setTheme(this.track.theme);
    this.scene.buildTrack(this.track); // idempotent: disposes the previous circuit's geometry
    this.drive.setTrack(this.track);
    setKartTrack(this.track);
    this.fitMinimap();
    // setTrack() only guarantees the predictor holds SOME valid state on the
    // new circuit (the origin) — re-anchor onto OUR grid slot on the NEW
    // circuit right away, or a track swap would visibly leave the kart at the
    // old circuit's coordinates (or the origin) until the next manual reset.
    const g = gridSlot(this.track, this.slot);
    this.drive.reset(g.x, g.z, g.yaw);
  }

  // ---- join / leave -------------------------------------------------------------------
  private onJoined(msg: JoinedMsg): void {
    this.applyTrack(msg.trackId); // circuit FIRST — resetRaceLocal()/gridSlot below reads this.track
    this.joined = true;
    this.slot = msg.slot;
    this.colorIdx = msg.color;
    this.roomCode = msg.code; // private rooms carry their invite code; null = public
    // Store the rejoin pointer: welcome always precedes kart_joined, so
    // this.playerId is set here (this.selfId()'s 'you' fallback is only for
    // pre-welcome debug reads). A reload/drop re-enters THIS room via welcome's
    // auto-rejoin, not a fresh quick_join.
    if (this.playerId !== null) {
      saveSession('kart', { playerId: this.playerId, roomId: msg.roomId, code: msg.code });
    }
    this.updateInviteChip();
    this.phase = msg.phase; // set directly — joining is not a phase TRANSITION
    this.applyFreeze(); // mid-race joiners drive at once; everyone else waits for GO
    this.drive.setAssist(this.assist); // kids-mode assist follows the stored toggle into the room
    this.you = null;
    this.phaseEndsAt = 0;
    this.seatedCount = msg.players.length; // until the first snapshot lands
    this.canStart = false; // the server decides; a stale true would lie for a frame
    this.countdownShown = 0;
    this.goActive = false;
    this.players.clear();
    this.roster.clear();
    for (const info of msg.players) this.roster.set(info.id, info);
    this.clearSceneKarts();
    this.resetRaceLocal(); // mid-race joiners start at the back of the grid (their slot)
    this.ensureKart(this.selfId(), this.colorIdx);
    for (const info of msg.players) this.ensureKart(info.id, info.color);
    this.renderLobbyList();
    this.showRace();
  }

  private leaveToMenu(notice: string): void {
    this.send({ t: 'leave' });
    clearSession('kart'); // explicit leave — never on a drop, which keeps the pointer for auto-rejoin
    this.resetRoom();
    this.showMenu(notice);
    if (this.welcomed) this.send({ t: 'list_rooms' });
  }

  /** Drops all per-room state (leave + socket close share this). */
  private resetRoom(): void {
    this.joined = false;
    this.you = null;
    this.phase = 'lobby';
    this.roomCode = null;
    this.updateInviteChip();
    this.phaseEndsAt = 0;
    this.seatedCount = 0;
    this.minPlayers = MIN_PLAYERS;
    this.canStart = false;
    this.season = null; // the season belongs to the ROOM — carrying it out would lie
    this.players.clear();
    this.roster.clear();
    this.buffers.clear();
    this.visuals.clear();
    this.bestLaps.clear();
    this.remoteFx.clear();
    this.ownFx.init = false;
    this.fx.clear();
    this.debugInput = null;
    this.touch.clear(); // and any thumb still down when the room went away
    this.paintTouch();
    this.applyExternalInput(); // clears the latch (debug driver + pad both empty now)
    this.applyFreeze(); // back at the menu the sim is frozen ('lobby' !== 'racing')
    this.countdownShown = 0;
    this.goActive = false;
    this.goAt = 0;
    this.audio.engine(0, false);
    this.audio.skid(0); // cut the persistent tire voice so it can't leak onto the menu
    this.clearSceneKarts();
  }

  /** Fresh race: own kart back on its grid slot, per-race locals cleared. */
  private resetRaceLocal(): void {
    const g = gridSlot(this.track, this.slot);
    this.drive.reset(g.x, g.z, g.yaw); // also drops the predictor's replay queue
    this.maxCorrectionM = 0; // netcode health is measured per race
    this.corrections = 0;
    this.buffers.clear(); // remotes re-appear at their slots via fresh snapshots
    this.visuals.clear();
    this.bestLaps.clear();
    this.remoteFx.clear();
    this.ownFx.init = false;
    this.dustAcc = 0;
    this.fx.clear(); // a fresh race starts on a clean track (marks are per-race)
    this.lastYouLap = 1;
    this.lastLapMs = -1;
    this.frozenLapMs = -1;
    this.wasFinished = false;
    this.prevSpeed = 0;
    this.prevNitroPips = NITRO_CHARGES; // charges refill at GO — no flash on the reset
    this.lapStartAt = this.serverNow();
  }

  // ---- snapshots -----------------------------------------------------------------------
  private onSnapshot(snap: SnapshotMsg): void {
    if (!this.joined) return; // stale room traffic after a leave
    this.applyTrack(snap.trackId); // cheap identity check; recovery path for a missed/mis-parsed join
    const prevPhase = this.phase;
    this.phase = snap.phase;
    this.applyFreeze(); // pre-GO freeze: the sim integrates only while 'racing'
    this.you = snap.you;
    this.phaseEndsAt = snap.phaseEndsAt;
    this.seatedCount = snap.playerCount; // lobby contract: server truth, not a DOM count
    this.minPlayers = snap.minPlayers;
    this.canStart = snap.canStart;
    this.season = snap.championship; // null on a disabled room, or on a bad block
    if (snap.phase !== prevPhase) this.onPhaseChange(prevPhase, snap.phase);

    // AUTHORITATIVE OWN STATE — exactly once per snapshot, from the `you` block
    // (the roster entry carries only p/yaw/v, which cannot restart a replay).
    // After onPhaseChange so a grid reset is followed by the server's truth.
    this.ackSeq = snap.you.lastProcessedSeq;
    const corr = this.drive.reconcile(snap.you.sim, snap.you.lastProcessedSeq);
    if (corr > CORRECTION_EPS_M) {
      this.corrections += 1;
      if (corr > this.maxCorrectionM) this.maxCorrectionM = corr;
    }

    const seen = new Set<string>();
    let rosterDirty = false;
    for (const p of snap.players) {
      seen.add(p.id);
      this.players.set(p.id, p);
      const info = this.roster.get(p.id);
      if (info === undefined || info.name !== p.name || info.slot !== p.slot || info.color !== p.color) {
        this.roster.set(p.id, { id: p.id, name: p.name, slot: p.slot, color: p.color });
        rosterDirty = true;
      }
      this.ensureKart(p.id, p.color);
      if (p.id !== this.playerId) this.pushRemote(p, snap.serverTime);
    }
    for (const id of [...this.players.keys()]) {
      if (!seen.has(id) && id !== this.playerId) {
        this.players.delete(id);
        this.roster.delete(id);
        this.buffers.delete(id);
        this.visuals.delete(id);
        this.remoteFx.delete(id);
        this.removeKart(id);
        rosterDirty = true;
      }
    }
    if (rosterDirty) this.renderLobbyList();

    // countdown numbers also ride the snapshot (fallback for a lost race_event)
    if (snap.phase === 'countdown' && snap.countdown > 0) this.showCountdown(snap.countdown);

    // own lap / finish edges (fallbacks — the events normally land first)
    const you = snap.you;
    if (you.lap !== this.lastYouLap) {
      if (you.lap > this.lastYouLap) this.lapStartAt = this.serverNow();
      this.lastYouLap = you.lap;
    }
    if (you.finished && !this.wasFinished) {
      this.wasFinished = true;
      this.frozenLapMs = this.serverNow() - this.lapStartAt;
    }
    if (snap.phase === 'results') this.buildResults();
  }

  /** Pre-GO freeze (docs/KART.md): the local sim integrates only while racing —
   *  frozen in lobby/ready/countdown/results. Idempotent; safe to call per snapshot. */
  private applyFreeze(): void {
    this.drive.setFrozen(this.phase !== 'racing');
  }

  private onPhaseChange(prev: KartPhase, next: KartPhase): void {
    // a new race runs through 'ready' first: reset onto the grid exactly once per race
    if ((next === 'ready' || next === 'countdown') && prev !== 'ready' && prev !== 'countdown') {
      this.resetRaceLocal();
    }
    if (next === 'ready') this.countdownShown = 0; // arm the 3-2-1 dedupe for the new race
    if (prev === 'countdown' && next === 'racing' && !this.goActive) this.showGo(); // lost 'go' event
    this.syncTouchUi(); // the pad is up from the countdown and down on the results screen
  }

  // ---- race events ---------------------------------------------------------------------
  private onRaceEvent(ev: RaceEvent): void {
    switch (ev.kind) {
      case 'countdown':
        this.showCountdown(ev.n);
        break;
      case 'go':
        this.showGo();
        break;
      case 'gate':
        break; // progress shows on the HUD via the snapshot; no extra chrome
      case 'lap': {
        const prev = this.bestLaps.get(ev.playerId);
        if (prev === undefined || ev.lapMs < prev) this.bestLaps.set(ev.playerId, ev.lapMs);
        if (ev.playerId === this.playerId) {
          this.lastLapMs = ev.lapMs;
          this.setMsg(`LAP ${ev.lap} — ${fmtMs(ev.lapMs)}`);
        }
        break;
      }
      case 'nitro':
        if (ev.playerId === this.playerId) {
          this.drive.activateNitro(); // the server spent a charge — the boost is client-side
          if (this.you !== null) this.you.nitroLeft = ev.left; // beats the next snapshot by a tick
          this.audio.sfx('turbo'); // nitro whoosh
        } else {
          // remote whoosh, gain scaled by distance to that kart (audio.ts reads opts.distance)
          const remote = this.players.get(ev.playerId);
          const s = this.drive.state();
          const dist =
            remote !== undefined
              ? Math.hypot(remote.p[0] - s.x, remote.p[2] - s.z)
              : 0;
          this.audio.sfx('turbo', { distance: Math.round(dist) });
        }
        break;
      case 'bump': {
        // server-resolved contact — the SAME fact reaches both drivers
        this.lastBump = { a: ev.a, b: ev.b, impulse: ev.impulse, atMs: this.serverNow() };
        if (ev.a === this.playerId || ev.b === this.playerId) {
          this.audio.sfx('thud'); // we were in it: full-volume hit
        } else {
          const otherId = ev.a; // a remote-on-remote hit: locate it and scale by distance
          const remote = this.players.get(otherId);
          const s = this.drive.state();
          const dist =
            remote !== undefined ? Math.hypot(remote.p[0] - s.x, remote.p[2] - s.z) : 0;
          this.audio.sfx('thud', { distance: Math.round(dist) });
        }
        break;
      }
      case 'finish':
        if (ev.playerId === this.playerId) {
          this.audio.sfx('finish');
          this.setMsg(`FINISH — P${ev.place}`);
        }
        break;
      case 'timeout':
        this.setMsg('TIME UP');
        break;
      case 'restart':
        break; // the snapshot phase machine drives the return to the grid
    }
  }

  private showCountdown(n: number): void {
    if (this.countdownShown === n) return; // same second via event + snapshot
    this.countdownShown = n;
    this.audio.sfx('beep');
  }

  private showGo(): void {
    if (this.goActive) return;
    this.goActive = true;
    this.goAt = performance.now();
    this.goUntil = this.goAt + GO_FLASH_MS;
    this.countdownShown = 0;
    this.lapStartAt = this.serverNow(); // the race clock starts at GO
    // no grid reset here: the server wipes positions at GO and the first racing
    // snapshot's reconcile adopts that authoritative state onto our slot
    this.audio.sfx('go');
  }

  private setMsg(text: string): void {
    this.msgEl.textContent = text;
    this.msgUntil = performance.now() + MSG_MS;
  }

  // ---- kart_input stream ------------------------------------------------------------------
  /** Bound once: flush() calls it per queued input, so it must never re-allocate. */
  private readonly sendInput = (m: KartC2S): void => this.send(m);

  /** Drains every input drive.ts produced since the last flush (SIM_HZ paced). */
  private sendPacket(): void {
    if (!this.joined) return;
    this.packetsSent += this.drive.flush(this.sendInput);
  }

  /** rAF pauses in background tabs: keep the sim + the input stream alive at a
   *  slow clip (INPUT_STALE_MS keepalive). Never double-steps while rAF is healthy. */
  private watchdog(): void {
    if (this.screen !== 'race') return;
    if (performance.now() - this.lastFrame <= FRAME_STALE_MS) return;
    this.drive.step(WATCHDOG_DT);
    this.sendPacket();
  }

  // ---- kids mode (auto-steer assist, docs/KART.md "Kids mode") -----------------------------
  /** Single funnel for the assist toggle: the menu checkbox and the T key both land here. */
  private setAssist(on: boolean): void {
    this.assist = on;
    this.kidsInput.checked = on;
    this.drive.setAssist(on);
    writeFlag(KIDS_KEY, on);
    // Nothing else to reconcile: KIDS MODE's ONLY effect on touch is the
    // auto-steer above (docs/TOUCH_PWA.md §4.2.1). It does not reshape the pad,
    // hide a control or change the throttle — there is one touch layout.
  }

  // ---- tablet mode (touch control surface, docs/TOUCH_PWA.md §4) ---------------------------

  /** Is the touch pad live? Explicit setting wins; otherwise the detected pointer decides. */
  private tabletActive(): boolean {
    return this.tabletPref ?? this.tabletSeen;
  }

  /** A real touch/pen pointer proves this is a touch device (never the user agent). */
  private armTablet(pointerType: string): void {
    if (this.tabletSeen || (pointerType !== 'touch' && pointerType !== 'pen')) return;
    this.tabletSeen = true;
    this.syncTouchUi();
  }

  /**
   * Reconcile every touch-shaped piece of the DOM with the settings: the two
   * layout classes the stylesheet keys off, the pad's visibility, the hint text
   * and the settings checkboxes. KIDS MODE is deliberately absent from all of
   * it — the pad is identical with the assist on or off. Cheap and idempotent:
   * the only DOM writes are class toggles classList already no-ops when
   * unchanged, plus one guarded visibility flip.
   */
  private syncTouchUi(): void {
    const on = this.tabletActive();
    // The pad has no brake and no reverse (docs/TOUCH_PWA.md §4.2.1), so a
    // tablet player who buries the kart cannot back out and has no R key: the
    // stuck auto-respawn is armed for EVERY touch player, not just kids.
    this.drive.setStuckGuard(on);
    const cls = this.raceEl.classList;
    cls.toggle('tablet', on);
    cls.toggle('lefty', this.lefty);
    this.tabletInput.checked = on;
    this.leftyInput.checked = this.lefty;
    // The pad is up on the race screen while the track is drivable. It stays
    // DOWN in the lobby and on the results screen: those overlays own the
    // screen and their buttons must be tappable.
    const visible =
      on && this.screen === 'race' && (this.phase === 'countdown' || this.phase === 'racing');
    if (visible !== this.padVisible) {
      this.padVisible = visible;
      this.touchEl.classList.toggle('hidden', !visible);
      this.touchRectsDirty = true;
      if (!visible) this.clearTouch();
    }
    this.touchRectsDirty = true; // a layout class change moves every target
    // One hint for every touch player, child included — they have the same
    // controls. KIDS MODE announces itself with the HUD's own KIDS badge.
    const hint = on
      ? `LEFT SIDE steers · GAS bottom right · NITRO ×${NITRO_CHARGES} · DRIFT to slide`
      : `WASD/arrows drive · Space/Shift drift · N nitro ×${NITRO_CHARGES} · R respawn at last gate`;
    if (this.hintEl.textContent !== hint) this.hintEl.textContent = hint;
    const lobbyHint = on
      ? 'TABLET CONTROLS — thumbs on the pad once the lights go out'
      : 'WASD / ARROWS to drive — SPACE to drift';
    if (this.lobbyHintEl.textContent !== lobbyHint) this.lobbyHintEl.textContent = lobbyHint;
  }

  /** Re-measure the pad targets. Layout read only — never inside a pointermove. */
  private measurePad(): void {
    const r = this.touchRects;
    r.length = 0;
    for (const t of this.touchTargets) {
      const box = t.el.getBoundingClientRect();
      // a hidden pad measures 0x0 at 0,0 — pushed anyway so the indices stay
      // aligned with touchTargets, and the hit test can never match a zero-area
      // rect
      r.push(box.left, box.top, box.right, box.bottom);
    }
    this.touchRectsDirty = false;
  }

  /**
   * Which control is under a viewport point. Rect-based, because a touch
   * pointer's move events are implicitly captured by the element it started on
   * and `e.target` would answer "the one you first pressed" forever.
   */
  private hitTest(x: number, y: number): TouchControl | null {
    if (this.touchRectsDirty) this.measurePad();
    const r = this.touchRects;
    for (let i = 0; i < this.touchTargets.length; i++) {
      const x0 = r[i * 4] ?? 0;
      const y0 = r[i * 4 + 1] ?? 0;
      const x1 = r[i * 4 + 2] ?? 0;
      const y1 = r[i * 4 + 3] ?? 0;
      if (x1 <= x0 || y1 <= y0) continue; // hidden target: zero-area, never hit
      if (x >= x0 && x < x1 && y >= y0 && y < y1) return this.touchTargets[i]?.control ?? null;
    }
    return null; // dead space
  }

  /** Mirror the held set onto the buttons (pressed look). Event-driven, not per frame. */
  private paintTouch(): void {
    for (const t of this.touchTargets) {
      t.el.classList.toggle('is-down', this.touch.isDown(t.control));
    }
  }

  /** Drop every tracked pointer (blur / tab hide / leaving the race screen). */
  private clearTouch(): void {
    if (this.touch.count() === 0) return;
    this.touch.clear();
    this.paintTouch();
    this.applyExternalInput();
  }

  /** The NITRO button and the N key make the identical request; only racing may spend. */
  private requestNitro(): void {
    if (this.phase === 'racing') this.send({ t: 'nitro' });
  }

  /** Screen Wake Lock while a race is live; silently absent where unsupported. */
  private async acquireWakeLock(): Promise<void> {
    if (this.wakeLock !== null || !('wakeLock' in navigator)) return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (this.screen !== 'race') {
        void lock.release().catch(() => undefined); // we left while the request was in flight
        return;
      }
      this.wakeLock = lock;
      // the platform drops it on hide; forget it so the visibility handler re-takes it
      lock.addEventListener('release', () => {
        if (this.wakeLock === lock) this.wakeLock = null;
      });
    } catch {
      // denied / unsupported / not visible — a race without it is still a race
    }
  }

  private releaseWakeLock(): void {
    const lock = this.wakeLock;
    if (lock === null) return;
    this.wakeLock = null;
    void lock.release().catch(() => undefined);
  }

  // ---- input ------------------------------------------------------------------------------
  /** Latch the debug driver into drive.ts (survives grid resets until resetRoom). */
  private setDebugInput(throttle: number, brake: number, steer: number, drift: boolean): void {
    this.debugInput = {
      throttle: clampNum(throttle, 0, 1),
      brake: clampNum(brake, 0, 1),
      steer: clampNum(steer, -1, 1),
      drift: drift === true,
    };
    this.applyExternalInput();
  }

  /**
   * The ONE external input drive.ts ever sees: the debug latch merged with the
   * tablet pad. Event-driven (a press, a release, a settings change) — never
   * per frame — and it writes into a single reused object, so the input path
   * allocates nothing.
   *
   * Merged, not exclusive: a tablet with a keyboard attached drives with
   * either, and the e2e driver keeps working with a pad on screen. drive.ts
   * then merges THIS with the held keyboard state exactly as before.
   */
  private applyExternalInput(): void {
    const d = this.debugInput;
    const pad = this.padVisible;
    const e = this.extInput;
    // The throttle is always a held thumb — there is no auto-throttle anywhere,
    // for anyone (docs/TOUCH_PWA.md §4.2.1). Holding one button is the easiest
    // thing a small child does; steering is the hard part, and that is exactly
    // what KIDS MODE's auto-steer already handles.
    e.throttle = clampNum((d?.throttle ?? 0) + (pad && this.touch.isDown('gas') ? 1 : 0), 0, 1);
    e.brake = clampNum(d?.brake ?? 0, 0, 1);
    e.steer = clampNum((d?.steer ?? 0) + (pad ? this.touch.steer() : 0), -1, 1);
    e.drift = (d?.drift ?? false) || (pad && this.touch.isDown('drift'));
    this.drive.setInput(e);
  }

  // ---- frame loop (sim + render; net runs on packet ticks + setInterval) --------------------
  private readonly frameBound = (now: number): void => this.frame(now);

  private frame(now: number): void {
    const dt = Math.min(MAX_FRAME_DT, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    if (this.screen === 'race') {
      this.drive.step(dt);
      this.sendPacket();
      const s = this.drive.state(); // module scratch — consume, never retain
      this.scene.updateKart(this.selfId(), s.x, s.y, s.z, s.yaw, s.steer, s.drifting, s.nitroLeft > 0, dt);
      this.updateRemotes(dt);
      this.updateFx(s, dt); // after remotes: their fx ride the same frame
      this.scene.setCamera(s.x, s.y, s.z, s.yaw, Math.abs(forwardSpeed(s)), dt);
      this.updateHud(s, now);
      this.updateAudio(s, now);
      this.scene.render();
    } else {
      // Menu frames pay the race's first-render bill a slice at a time (shader
      // programs, the shadow depth pass, first uploads) into the hidden canvas
      // — otherwise all of it lands in one ~1s blocking task inside the join
      // handler, right as the snapshot stream starts. Self-limiting, and a
      // no-op once warm; see KartScene.prewarm().
      this.scene.prewarm();
    }
    requestAnimationFrame(this.frameBound);
  }

  private updateRemotes(dt: number): void {
    const renderTime = this.serverNow() - INTERP_DELAY_MS;
    for (const [id, buf] of this.buffers) {
      const v = sampleBuffer(buf, renderTime);
      if (v === null) continue;
      this.visuals.set(id, v);
      this.scene.updateKart(id, v.x, v.y, v.z, v.yaw, v.steer, v.drift, v.nitroActive, dt);
      this.updateRemoteFx(id, v, dt);
    }
  }

  // ---- fx emission (fx.ts owns the pools; this only feeds it sim facts) ----------------

  /** Own-kart fx for this frame: skid marks (drift/hard brake, road only), drift
   *  smoke, grass dust, barrier sparks, nitro trail, camera speed lines. */
  private updateFx(s: DriveState, dt: number): void {
    const spd = Math.abs(forwardSpeed(s));
    const fx = -Math.sin(s.yaw);
    const fz = -Math.cos(s.yaw);
    const st = this.ownFx;
    const onRoad = surfaceAt(this.track, s.x, s.z) === 'road';
    this.lastSurface = onRoad ? 'asphalt' : 'grass'; // feeds the skid voice character
    const drifting = s.drifting && spd > SKID_MIN_SPEED;
    // continuous tire voice (audio.skid): per-frame slip amount 0..1 — the
    // smoothed driftVisual envelope while drifting at speed, else 0
    this.audio.skid(drifting ? Math.min(1, Math.max(0, s.driftVisual)) : 0, this.lastSurface);
    // hard-brake proxy: a big forward-speed loss without the handbrake (a barrier
    // hit trips it too — crash marks at the wall are the right read)
    const decel = (this.prevSpeed - spd) / Math.max(dt, 1e-4);
    const braking = !s.drifting && decel > BRAKE_SKID_DECEL && spd > BRAKE_SKID_MIN_SPEED;
    if ((drifting || braking) && onRoad) {
      this.emitSlideFx(st, s.x, s.z, s.yaw, dt, drifting);
    } else {
      st.init = false; // next slide starts a fresh streak, not a jump-cut line
    }
    if (!onRoad && spd > DUST_MIN_SPEED) {
      this.dustAcc += dt;
      while (this.dustAcc >= DUST_EVERY_S) {
        this.dustAcc -= DUST_EVERY_S;
        st.side = !st.side;
        const side = st.side ? 1 : -1;
        this.fx.dust(
          s.x - fx * WHEEL_REAR + Math.cos(s.yaw) * WHEEL_HALF * side,
          0.25,
          s.z - fz * WHEEL_REAR - Math.sin(s.yaw) * WHEEL_HALF * side,
        );
      }
    }
    if (this.prevSpeed - spd > THUD_DROP) {
      this.fx.sparks(s.x + fx * NOSE_AHEAD, 0.45, s.z + fz * NOSE_AHEAD);
    }
    if (s.nitroLeft > 0) {
      st.trailAcc += dt;
      while (st.trailAcc >= TRAIL_EVERY_S) {
        st.trailAcc -= TRAIL_EVERY_S;
        // exhaust tip (kartMesh local (0.28, 0.5, 1.3)): behind + right of the origin
        this.fx.trail(
          s.x - fx * 1.3 + Math.cos(s.yaw) * 0.28,
          0.5,
          s.z - fz * 1.3 - Math.sin(s.yaw) * 0.28,
          fx,
          fz,
        );
      }
    }
    this.fx.update(dt, spd);
  }

  /** Remote kart fx from snapshot flags: drift marks + smoke, nitro streak. */
  private updateRemoteFx(id: string, v: RemoteVisual, dt: number): void {
    let st = this.remoteFx.get(id);
    if (st === undefined) {
      st = { lx: 0, lz: 0, rx: 0, rz: 0, init: false, smokeAcc: 0, trailAcc: 0, side: false };
      this.remoteFx.set(id, st);
    }
    if (v.drift) {
      this.emitSlideFx(st, v.x, v.z, v.yaw, dt, true);
    } else {
      st.init = false;
    }
    if (v.nitroActive) {
      const fx = -Math.sin(v.yaw);
      const fz = -Math.cos(v.yaw);
      st.trailAcc += dt;
      while (st.trailAcc >= TRAIL_EVERY_S) {
        st.trailAcc -= TRAIL_EVERY_S;
        this.fx.trail(
          v.x - fx * 1.3 + Math.cos(v.yaw) * 0.28,
          0.5,
          v.z - fz * 1.3 - Math.sin(v.yaw) * 0.28,
          fx,
          fz,
        );
      }
    }
  }

  /**
   * Skid marks (+ drift smoke when smoke=true) for one kart sliding on the road.
   * One mark per rear wheel every SKID_MARK_EVERY m of wheel travel, each segment
   * oriented along the wheel's motion; smoke puffs alternate wheels.
   */
  private emitSlideFx(
    st: RemoteFxState,
    x: number,
    z: number,
    yaw: number,
    dt: number,
    smoke: boolean,
  ): void {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rearX = x - fx * WHEEL_REAR;
    const rearZ = z - fz * WHEEL_REAR;
    const wlX = rearX - Math.cos(yaw) * WHEEL_HALF;
    const wlZ = rearZ + Math.sin(yaw) * WHEEL_HALF;
    const wrX = rearX + Math.cos(yaw) * WHEEL_HALF;
    const wrZ = rearZ - Math.sin(yaw) * WHEEL_HALF;
    if (st.init) {
      const dxl = wlX - st.lx;
      const dzl = wlZ - st.lz;
      const dl = Math.hypot(dxl, dzl);
      if (dl >= SKID_MARK_EVERY) {
        this.fx.skid(st.lx, st.lz, dxl / dl, dzl / dl);
        st.lx = wlX;
        st.lz = wlZ;
      }
      const dxr = wrX - st.rx;
      const dzr = wrZ - st.rz;
      const dr = Math.hypot(dxr, dzr);
      if (dr >= SKID_MARK_EVERY) {
        this.fx.skid(st.rx, st.rz, dxr / dr, dzr / dr);
        st.rx = wrX;
        st.rz = wrZ;
      }
    } else {
      // streak start: record the wheel positions WITHOUT laying a mark — stamping
      // both wheels at once reads as a symmetric 'H' rung; real marks appear as
      // each wheel travels SKID_MARK_EVERY, staggered along its own path
      st.lx = wlX;
      st.lz = wlZ;
      st.rx = wrX;
      st.rz = wrZ;
      st.init = true;
    }
    if (smoke) {
      st.smokeAcc += dt;
      while (st.smokeAcc >= SMOKE_EVERY_S) {
        st.smokeAcc -= SMOKE_EVERY_S;
        st.side = !st.side;
        this.fx.smoke(st.side ? wlX : wrX, 0.35, st.side ? wlZ : wrZ);
      }
    }
  }

  private updateAudio(s: DriveState, now: number): void {
    const spd = forwardSpeed(s);
    const on = this.phase === 'ready' || this.phase === 'countdown' || this.phase === 'racing';
    this.audio.engine(engineRevs(s), on, this.drive.throttle()); // revs per gear, load per real throttle
    // no skid here: the continuous tire voice is driven per frame from updateFx
    // no sim-edge whoosh: nitro is the only boost now, and its sfx rides the race event
    if (this.prevSpeed - spd > THUD_DROP) this.audio.sfx('thud'); // barrier killed our speed
    this.prevSpeed = spd;
  }

  // ---- HUD + overlays (all visibility is computed here, once per frame) ----------------------
  private updateHud(s: DriveState, now: number): void {
    const phase = this.phase;
    const you = this.you;
    this.lobbyEl.classList.toggle('hidden', !(phase === 'lobby' || phase === 'ready'));
    this.hudEl.classList.toggle(
      'hidden',
      !(phase === 'ready' || phase === 'countdown' || phase === 'racing'),
    );
    this.resultsEl.classList.toggle('hidden', phase !== 'results');

    // invite chip parking: while the HUD is up the position/lap chips own the
    // top-left corner — stack beneath them; overlays leave the corner free
    // ('ready' shows the lobby overlay ABOVE the hud, so only countdown/racing park)
    // the two homes are styled by parent selector in style.css — reparenting is
    // the whole toggle, no inline position write
    const parkInHud = phase === 'countdown' || phase === 'racing';
    const inviteParent = parkInHud ? this.hudLeftEl : this.raceEl;
    if (this.inviteEl.parentElement !== inviteParent) inviteParent.appendChild(this.inviteEl);

    // countdown big number / GO! flash
    if (this.goActive && now > this.goUntil) this.goActive = false;
    const showCd = this.goActive || (phase === 'countdown' && this.countdownShown > 0);
    this.countdownEl.classList.toggle('hidden', !showCd);
    if (showCd) this.countdownEl.textContent = this.goActive ? 'GO!' : String(this.countdownShown);

    this.msgEl.classList.toggle('hidden', now > this.msgUntil);

    // controls hint card: up through lobby/ready/countdown, holds after GO, then
    // fades out (docs/KART.md "Onboarding hints")
    const preGo = phase === 'lobby' || phase === 'ready' || phase === 'countdown';
    const sinceGo = this.goAt > 0 ? now - this.goAt : Number.POSITIVE_INFINITY;
    const hintUp = preGo || (phase === 'racing' && sinceGo < HINT_HOLD_MS + HINT_FADE_MS);
    this.hintEl.classList.toggle('hidden', !hintUp);
    if (hintUp) {
      const fade =
        preGo || sinceGo <= HINT_HOLD_MS ? 1 : 1 - (sinceGo - HINT_HOLD_MS) / HINT_FADE_MS;
      this.hintEl.style.opacity = String(fade);
    }

    // lobby status line + the explicit START control. Nothing auto-starts: in
    // 'lobby' the panel always states the count against the minimum, and the
    // button carries the reason it is disabled. During 'ready' the race is
    // already on its way, so the button goes away and the line counts down.
    if (phase === 'ready') {
      this.lobbyStatusEl.textContent =
        this.phaseEndsAt > 0
          ? `GET READY — ${Math.max(0, Math.ceil((this.phaseEndsAt - this.serverNow()) / 1000))}`
          : 'GET READY';
    } else if (phase === 'lobby') {
      const n = Math.max(this.seatedCount, this.roster.size);
      const need = Math.max(0, this.minPlayers - n);
      this.lobbyStatusEl.textContent =
        need > 0
          ? `DRIVERS ${n}/${this.minPlayers} — NEED ${need} MORE`
          : `DRIVERS ${n} · MIN ${this.minPlayers} — READY WHEN YOU ARE`;
      this.startBtn.disabled = !this.canStart;
      this.startBtn.title = this.canStart
        ? 'Start the race'
        : `Waiting for ${need > 0 ? need : this.minPlayers} more driver${need === 1 ? '' : 's'}`;
    }
    this.startBtn.classList.toggle('hidden', phase !== 'lobby');

    // Championship placard. Written unconditionally (not per-phase) because the
    // lobby overlay is up in BOTH 'lobby' and 'ready' and the placard must read
    // the same in each; the overlay's own hidden flag handles every other phase.
    // Text only — the layout is style.css's (VISUAL_UPGRADE.md §9).
    const season = this.season;
    this.lobbySeasonEl.classList.toggle('hidden', season === null);
    if (season !== null) {
      this.lobbyRoundEl.textContent = `ROUND ${season.round} OF ${season.rounds} · ${TRACKS[
        season.trackId
      ].name.toUpperCase()}`;
      const mine = this.standingOf(this.playerId, season);
      // "New here" is `joinedRound`, NOT zero points — the two look identical on
      // the table and mean opposite things. An incumbent who DNF'd round 1 is on
      // 0 pts and must be told exactly that ("YOU: 0 PTS · P3 OF 3"): a zero he
      // earned is information, and greeting him as a newcomer erases his round.
      // Only a driver with no row at all, or one whose first round IS this one,
      // gets the welcome — and only once the season is actually underway.
      const arrivedNow = season.round > 1 && (mine === null || mine.joinedRound === season.round);
      let note: string;
      if (arrivedNow) {
        note = 'YOU JOIN ON 0 PTS — SEASON ALREADY UNDERWAY';
      } else if (mine === null || (season.round === 1 && mine.points <= 0)) {
        // round 1: nobody has scored yet, so a standing line would be noise
        note = 'EVERY DRIVER STARTS ON 0 PTS';
      } else {
        note = `YOU: ${mine.points} PTS · P${mine.pos} OF ${season.standings.length}`;
      }
      this.lobbySeasonNoteEl.textContent = note;
    }

    // results auto-return note (the server sends the room back to 'lobby')
    if (phase === 'results') {
      this.resultsNoteEl.textContent =
        this.phaseEndsAt > 0
          ? `BACK TO GRID IN ${Math.max(0, Math.ceil((this.phaseEndsAt - this.serverNow()) / 1000))}S`
          : 'BACK TO GRID…';
    }

    // position chip: big ordinal + /N, gap to the kart one place ahead
    // (docs/KART.md "Gap timing"); 'LEADER' for P1
    if (you !== null && you.place > 0) {
      this.placeNumEl.textContent = String(you.place);
      this.placeSufEl.textContent = ordinalSuffix(you.place);
      this.placeTotalEl.textContent = `/${Math.max(this.players.size, you.place)}`;
      this.placeGapEl.textContent =
        you.place === 1 ? 'LEADER' : `+${(you.gapAheadMs / 1000).toFixed(1)}s`;
      this.placeGapEl.classList.toggle('hud-pos-leader', you.place === 1);
      this.crownEl.classList.toggle('hidden', you.place !== 1);
    } else {
      this.placeNumEl.textContent = '—';
      this.placeSufEl.textContent = '';
      this.placeTotalEl.textContent = '';
      this.placeGapEl.textContent = '';
      this.placeGapEl.classList.remove('hud-pos-leader');
      this.crownEl.classList.add('hidden');
    }
    this.kidsBadgeEl.classList.toggle('hidden', !this.assist); // KIDS badge while assist is on
    this.lapEl.textContent = `LAP ${Math.min(you?.lap ?? 1, LAPS_TO_WIN)}/${LAPS_TO_WIN}`;

    // speed: numeral + meter. The meter is normalised to the physics ceiling
    // (TOP_SPEED * 1.15, the nitro overspeed clamp) so only a boost pegs it.
    const spdAbs = Math.abs(forwardSpeed(s));
    this.speedNumEl.textContent = String(Math.round(spdAbs * 3.6));
    const pct = Math.round(Math.min(1, spdAbs / (TOP_SPEED * 1.15)) * 100);
    if (pct !== this.prevSpeedPct) {
      this.prevSpeedPct = pct;
      this.speedBarEl.style.width = `${pct}%`; // the meter fill — data-driven, like BANK's timer
    }

    // gear: big number above the speed; the upshift fires a one-shot flash
    // animation (class, not a per-frame opacity write)
    this.gearEl.textContent = String(s.gear);
    const shifting = s.shiftLeft > 0;
    if (shifting && !this.prevShifting) {
      this.gearEl.classList.remove('gear-flash');
      void this.gearEl.offsetWidth; // restart the animation on back-to-back shifts
      this.gearEl.classList.add('gear-flash');
    }
    this.prevShifting = shifting;

    // current lap time (frozen at our finish) + best lap
    let current = -1;
    if (phase === 'racing') {
      current = you !== null && you.finished ? this.frozenLapMs : this.serverNow() - this.lapStartAt;
    }
    this.lapTimeEl.textContent = fmtMs(current);
    let best = you?.bestLapMs ?? -1;
    if (best < 0 && this.playerId !== null) best = this.bestLaps.get(this.playerId) ?? this.lastLapMs;
    this.bestEl.textContent = fmtMs(best);

    // nitro pips: one lit pip per charge left (you.nitroLeft is authoritative);
    // a spent pip falls back to the empty-socket base class and flashes
    const nitroLeft = you?.nitroLeft ?? NITRO_CHARGES;
    this.nitroPips.forEach((pip, i) => {
      pip.classList.toggle('hud-nitro-pip-full', i < nitroLeft);
    });
    if (nitroLeft < this.prevNitroPips) {
      const spent = this.nitroPips[nitroLeft]; // the pip that just went dark
      if (spent !== undefined) {
        spent.classList.remove('pip-flash');
        void spent.offsetWidth; // restart the animation on rapid successive spends
        spent.classList.add('pip-flash');
      }
    }
    this.prevNitroPips = nitroLeft;

    // minimap: outline + gate 0 + live dots, throttled to 4Hz (MINIMAP_EVERY_MS)
    if (now >= this.minimapNextAt) {
      this.minimapNextAt = now + MINIMAP_EVERY_MS;
      this.drawMinimap(s);
    }

    // next-gate chevron: rotate toward the gate relative to our yaw, distance below
    const showGate = (phase === 'countdown' || phase === 'racing') && you !== null;
    this.gateWrapEl.classList.toggle('hidden', !showGate);
    if (showGate && you !== null) {
      const gates = this.track.gates;
      const gate = gates[((you.nextGate % GATES) + GATES) % GATES]!;
      const dx = gate.x - s.x;
      const dz = gate.z - s.z;
      // platform yaw convention: forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)
      const fwd = dx * -Math.sin(s.yaw) + dz * -Math.cos(s.yaw);
      const right = dx * Math.cos(s.yaw) + dz * -Math.sin(s.yaw);
      this.gateEl.style.transform = `rotate(${(Math.atan2(right, fwd) * 180) / Math.PI}deg)`;
      const distTxt = `${Math.round(Math.hypot(dx, dz))}m`;
      if (this.gateLabelEl.textContent !== distTxt) this.gateLabelEl.textContent = distTxt;
    }
  }

  /** Minimap (top-right): the static track outline (precomputed Path2D) drawn
   *  cream over a dark under-stroke for full-alpha readability, a start/finish
   *  tick at gate 0, saturated per-player dots in kart colors, and your kart as
   *  a filled heading arrow. Redrawn at 4Hz. */
  private drawMinimap(s: DriveState): void {
    const ctx = this.minimapEl.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0); // 2x backing store — draw in css px
    ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // track outline: dark under-stroke then full-alpha cream — reads on any scene
    ctx.strokeStyle = KPAL.ink;
    ctx.lineWidth = 6.5;
    ctx.stroke(this.mapPath);
    ctx.strokeStyle = KPAL.hudText;
    ctx.lineWidth = 4;
    ctx.stroke(this.mapPath);
    // start/finish tick: perpendicular to the gate-0 tangent
    const g0 = this.track.gates[0]!;
    const gx = (g0.x + this.mapOffX) * this.mapScale;
    const gz = (g0.z + this.mapOffZ) * this.mapScale;
    const px = -g0.tz * this.mapScale * 0.9;
    const pz = g0.tx * this.mapScale * 0.9;
    ctx.strokeStyle = KPAL.gold;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(gx - px, gz - pz);
    ctx.lineTo(gx + px, gz + pz);
    ctx.stroke();
    // player dots: saturated kart colors, dark ring for separation — you LAST
    const n = KART_COLORS.length;
    const dot = (px2: number, pz2: number, color: number): void => {
      ctx.fillStyle = KART_COLORS[((color % n) + n) % n] ?? KPAL.kartRed;
      ctx.beginPath();
      ctx.arc(
        (px2 + this.mapOffX) * this.mapScale,
        (pz2 + this.mapOffZ) * this.mapScale,
        3.2,
        0,
        TWO_PI,
      );
      ctx.fill();
      ctx.strokeStyle = KPAL.ink;
      ctx.lineWidth = 0.9;
      ctx.stroke();
    };
    let ownColor = this.colorIdx;
    for (const p of this.players.values()) {
      if (p.id === this.playerId) {
        ownColor = p.color;
        continue;
      }
      dot(p.p[0], p.p[2], p.color);
    }
    // you: a filled heading arrow (map y = world z, so fwd = (-sin yaw, -cos yaw))
    const ox = (s.x + this.mapOffX) * this.mapScale;
    const oz = (s.z + this.mapOffZ) * this.mapScale;
    const ang = Math.atan2(-Math.cos(s.yaw), -Math.sin(s.yaw));
    ctx.save();
    ctx.translate(ox, oz);
    ctx.rotate(ang);
    ctx.fillStyle = KART_COLORS[((ownColor % n) + n) % n] ?? KPAL.kartRed;
    ctx.strokeStyle = KPAL.hudText;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-4.5, 4);
    ctx.lineTo(-4.5, -4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ---- scene kart bookkeeping -----------------------------------------------------------------
  private ensureKart(id: string, colorIdx: number): void {
    if (this.sceneKarts.has(id)) return;
    const n = KART_COLORS.length;
    const color = KART_COLORS[((colorIdx % n) + n) % n] ?? KPAL.kartRed;
    this.scene.addKart(id, color);
    this.sceneKarts.add(id);
  }

  private removeKart(id: string): void {
    if (!this.sceneKarts.delete(id)) return;
    this.scene.removeKart(id);
  }

  private clearSceneKarts(): void {
    for (const id of this.sceneKarts) this.scene.removeKart(id);
    this.sceneKarts.clear();
  }

  private pushRemote(p: KartPlayerSnap, time: number): void {
    let buf = this.buffers.get(p.id);
    if (buf === undefined) {
      buf = [];
      this.buffers.set(p.id, buf);
    }
    const sample: RemoteSample = {
      t: time,
      x: p.p[0],
      y: p.p[1],
      z: p.p[2],
      yaw: p.yaw,
      vx: p.v[0],
      vz: p.v[1],
      steer: p.steer,
      drift: p.drift,
      nitroActive: p.nitroActive,
    };
    const last = buf[buf.length - 1];
    if (last !== undefined && time < last.t) return; // out-of-order: drop (the next snapshot self-heals)
    if (last !== undefined && time === last.t) buf[buf.length - 1] = sample; // duplicate tick: newest wins
    else buf.push(sample);
    // evict beyond ~1s of history, keeping one older entry for bracketing
    while (buf.length > 2) {
      const second = buf[1];
      if (second === undefined || second.t > time - BUFFER_KEEP_MS) break;
      buf.shift();
    }
  }

  // ---- screens --------------------------------------------------------------------------------
  private showMenu(notice: string): void {
    this.screen = 'menu';
    this.raceEl.classList.add('hidden');
    this.menuEl.classList.remove('hidden');
    this.setNotice(notice);
    this.renderMenu();
    this.syncTouchUi(); // the pad comes down with the race screen
    this.releaseWakeLock(); // ...and the screen may sleep again
  }

  private showRace(): void {
    this.screen = 'race';
    this.menuEl.classList.add('hidden');
    this.raceEl.classList.remove('hidden');
    this.scene.resize(); // the canvas was display:none — measurable only now
    this.syncTouchUi(); // pad geometry is measurable only now, too
    void this.acquireWakeLock(); // a screen that sleeps mid-race is blamed on the game
  }

  // ---- menu rendering ---------------------------------------------------------------------------
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

  /** One compact settings toggle in the menu's toggle row (same idiom as .menu-kids). */
  private toggleChip(
    parent: HTMLElement,
    label: string,
    checked: boolean,
    onChange: (on: boolean) => void,
  ): HTMLInputElement {
    const row = el('label', 'menu-toggle');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => {
      this.audio.resume(); // browsers gate AudioContext on a user gesture
      onChange(input.checked);
    });
    row.appendChild(input);
    row.appendChild(el('span', 'menu-toggle-label', label));
    parent.appendChild(row);
    return input;
  }

  /** One target on the tablet pad. A div, not a button: nothing on the pad may
   *  take focus, or the next SPACE/arrow press would go to it instead of the kart. */
  private padButton(
    parent: HTMLElement,
    control: TouchControl,
    className: string,
    inner: HTMLElement,
  ): HTMLDivElement {
    const btn = el('div', className);
    btn.appendChild(inner);
    parent.appendChild(btn);
    this.touchTargets.push({ el: btn, control });
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
      this.roomsEl.appendChild(el('div', 'room-empty', 'no tracks yet — create one'));
      return;
    }
    for (const room of this.rooms) {
      const row = el('div', 'room-row'); // the click affordance is `.room-row { cursor }` in style.css
      row.addEventListener('click', () => {
        this.audio.resume(); // same gesture unlock as the menu buttons
        this.joinPublic(this.menuName(), room.id);
      });
      row.appendChild(
        el('span', 'room-title', room.visibility === 'private' ? 'private race' : 'public race'),
      );
      row.appendChild(el('span', 'room-label', room.label));
      row.appendChild(el('span', 'room-meta', `${room.players}/${room.maxPlayers} · ${room.phase}`));
      this.roomsEl.appendChild(row);
    }
  }

  // ---- race rendering (lobby list + results table) ----------------------------------------------
  private renderLobbyList(): void {
    this.lobbyPlayersEl.replaceChildren();
    const list = [...this.roster.values()].sort((a, b) => a.slot - b.slot);
    for (const p of list) {
      const chip = el('div', 'player-chip');
      chip.classList.toggle('you', p.id === this.playerId);
      const sw = el('span', 'player-color');
      const n = KART_COLORS.length;
      sw.style.background = KART_COLORS[((p.color % n) + n) % n] ?? KPAL.kartRed;
      chip.appendChild(sw);
      const name = el('span', 'player-name', p.name);
      if (p.id === this.playerId) name.appendChild(el('span', 'player-you', 'YOU'));
      chip.appendChild(name);
      chip.appendChild(el('span', 'player-slot', `GRID ${p.slot + 1}`));
      this.lobbyPlayersEl.appendChild(chip);
    }
  }

  private buildResults(): void {
    const rows = [...this.players.values()].sort((a, b) => a.place - b.place);
    this.resultsBodyEl.replaceChildren();
    for (const p of rows) {
      const tr = el('tr');
      if (p.id === this.playerId) tr.classList.add('you', 'results-row-you');
      tr.appendChild(el('td', 'result-place', `P${p.place}`));
      tr.appendChild(el('td', 'result-name', p.name));
      tr.appendChild(
        el('td', 'result-time', p.finished && p.finishMs >= 0 ? fmtMs(p.finishMs) : 'DNF'),
      );
      // per-player best lap: 'lap' events for everyone, the snapshot's bestLapMs for us
      let best = this.bestLaps.get(p.id) ?? -1;
      if (p.id === this.playerId && this.you !== null && this.you.bestLapMs >= 0) {
        best = this.you.bestLapMs;
      }
      tr.appendChild(el('td', 'result-best', fmtMs(best)));
      this.resultsBodyEl.appendChild(tr);
    }
    this.buildStandings();
  }

  /** A driver's championship line, or null (no season / no id / never seated). */
  private standingOf(id: string | null, season: KartSeason): KartStandingRow | null {
    if (id === null) return null;
    return season.standings.find((r) => r.id === id) ?? null;
  }

  /**
   * The season table under the race result. Rebuilt whole per snapshot, matching
   * the results table's replaceChildren budget above it: 'results' is a paused
   * screen and the row count is the season's driver list, not a per-frame
   * stream, so this is a handful of nodes a few times a second.
   */
  private buildStandings(): void {
    const season = this.season;
    this.standingsEl.classList.toggle('hidden', season === null);
    // two separate markers: 'has-standings' buys the season table its vertical
    // room on EVERY championship screen (a disabled room never gets it, so that
    // panel is unchanged); 'season-final' is the finale's own dressing.
    this.resultsPanelEl.classList.toggle('has-standings', season !== null);
    this.resultsPanelEl.classList.toggle('season-final', season !== null && season.over);
    if (season === null) {
      this.standingsBodyEl.replaceChildren(); // drop stale rows with the season
      this.championEl.classList.add('hidden');
      return;
    }

    this.standingsTitleEl.textContent = season.over
      ? 'FINAL CHAMPIONSHIP STANDINGS'
      : `CHAMPIONSHIP · AFTER ROUND ${season.round} OF ${season.rounds}`;

    // The trophy, only once the final round is scored — and only when the named
    // champion actually has a row. A championId with no standings line is a wire
    // mismatch, and an empty banner is worse than no banner.
    const champ = season.over ? this.standingOf(season.championId, season) : null;
    this.championEl.classList.toggle('hidden', champ === null);
    if (champ !== null) {
      this.championNameEl.textContent = champ.name;
      this.championStatEl.textContent = `${champ.points} PTS · ${champ.wins} WIN${
        champ.wins === 1 ? '' : 'S'
      }`;
    }

    this.standingsBodyEl.replaceChildren();
    for (const row of season.standings) {
      // wire order IS championship order (points, then the server's tie-break) —
      // sorting here would quietly re-decide who is second
      const tr = el('tr');
      if (row.id === this.playerId) tr.classList.add('you', 'standing-row-you');
      if (champ !== null && row.id === champ.id) tr.classList.add('standing-row-champion');
      if (!row.here) tr.classList.add('standing-row-gone'); // left the room, kept the points
      tr.appendChild(el('td', 'standing-pos', `P${row.pos}`));
      tr.appendChild(el('td', 'standing-name', row.name));
      tr.appendChild(el('td', 'standing-pts', String(row.points)));
      // a scoreless round must read as NOTHING; '+0' reads as a bug
      const scored = row.delta > 0;
      const delta = el('td', 'standing-delta', scored ? `+${row.delta}` : '—');
      if (scored) delta.classList.add('standing-delta-up');
      tr.appendChild(delta);
      this.standingsBodyEl.appendChild(tr);
    }

    const next = season.nextTrackId;
    this.standingsNextEl.classList.toggle('hidden', next === null); // nothing follows the finale
    if (next !== null) {
      this.standingsNextEl.textContent = `NEXT ROUND · ${TRACKS[next].name.toUpperCase()}`;
    }
  }

  // ---- invite chip (private rooms) ---------------------------------------------------
  /** Shows/hides the chip and refreshes its label from the current roomCode. */
  private updateInviteChip(): void {
    const code = this.roomCode;
    this.inviteEl.classList.toggle('hidden', code === null);
    if (code !== null) this.inviteCodeEl.textContent = `CIRCUIT · code ${code}`;
  }

  /** Copies the invite link; navigator.clipboard first, textarea fallback. */
  private copyInvite(): void {
    const code = this.roomCode;
    if (code === null) return;
    const url = `${location.origin}/kart/?code=${code}`;
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

  // ---- debug surface ------------------------------------------------------------------------------
  private debugState(): KartDebugState {
    const s = this.drive.state();
    const you = this.you;
    return {
      phase: this.screen === 'menu' ? 'menu' : this.phase,
      place: you?.place ?? 0,
      lap: you?.lap ?? 1,
      nextGate: you?.nextGate ?? 0,
      progress: you?.progress ?? 0,
      pos: { x: s.x, y: s.y, z: s.z },
      speed: forwardSpeed(s),
      gear: s.gear,
      // What the client KNOWS is seated, not what the last snapshot carried:
      // kart_joined fills the roster immediately, but the first snapshot can be
      // ~1s behind it (the joiner blocks on the track-mesh build, then every
      // queued snapshot flushes at once). Reading `players` alone reported 0 for
      // that whole window while the lobby chips were already on screen. Same
      // idiom as the lobby status line, and all three sources are cleared by
      // resetRoom(), so a leave drops this straight back to 0.
      players: Math.max(this.players.size, this.roster.size, this.seatedCount),
      nitroLeft: you?.nitroLeft ?? NITRO_CHARGES,
      gapAheadMs: you?.gapAheadMs ?? 0,
      frozen: this.phase !== 'racing',
      assist: this.assist,
      code: this.roomCode,
      canStart: this.canStart,
    };
  }

  private telemetrySnapshot(): KartTelemetry {
    const s = this.drive.state();
    const spd = forwardSpeed(s);
    const remotes: KartRemoteDebug[] = [];
    for (const [id, p] of this.players) {
      if (id === this.playerId) continue;
      const v = this.visuals.get(id);
      remotes.push({
        id,
        name: p.name,
        place: p.place,
        lap: p.lap,
        x: v?.x ?? p.p[0],
        z: v?.z ?? p.p[2],
        yaw: v?.yaw ?? p.yaw,
        samples: this.buffers.get(id)?.length ?? 0,
      });
    }
    return {
      phase: this.screen === 'menu' ? 'menu' : this.phase,
      trackId: this.trackId,
      playerId: this.playerId,
      slot: this.slot,
      seq: this.packetsSent, // kart_input frames sent (drive.ts owns the wire seq)
      seqHz: SIM_HZ,
      net: {
        ack: this.ackSeq,
        pending: this.drive.pending(),
        lastCorrectionM: this.drive.lastCorrection(),
        maxCorrectionM: this.maxCorrectionM,
        corrections: this.corrections,
      },
      lastBump:
        this.lastBump === null
          ? null
          : {
              a: this.lastBump.a,
              b: this.lastBump.b,
              impulse: this.lastBump.impulse,
              atMs: this.lastBump.atMs,
            },
      offsetMs: this.offset,
      rttMs: this.rttMs,
      // the latched ext input only — the keyboard is drive-internal and not
      // observable here. This is the MERGED latch (debug driver + tablet pad),
      // i.e. exactly what drive.ts was handed, so a touch harness can read back
      // what a thumb produced.
      input: { ...this.extInput },
      own: {
        x: s.x,
        y: s.y,
        z: s.z,
        yaw: s.yaw,
        speedMps: spd,
        speedKmh: spd * 3.6,
        gear: s.gear,
        drifting: s.drifting,
        nitroLeft: s.nitroLeft, // boost seconds left (client sim), NOT the charge count
      },
      remotes,
      phaseEndsInMs: this.phaseEndsAt > 0 ? Math.max(0, this.phaseEndsAt - this.serverNow()) : 0,
      nitroLeft: this.you?.nitroLeft ?? NITRO_CHARGES,
      gapAheadMs: this.you?.gapAheadMs ?? 0,
      frozen: this.phase !== 'racing',
      assist: this.assist,
      season: this.seasonTelemetry(),
    };
  }

  /** Debug-only projection of the season + our line in it (null = disabled room). */
  private seasonTelemetry(): KartTelemetry['season'] {
    const season = this.season;
    if (season === null) return null;
    const mine = this.standingOf(this.playerId, season);
    return {
      round: season.round,
      rounds: season.rounds,
      points: mine?.points ?? 0, // 0, not -1: no row means no points, which is a real answer
      pos: mine?.pos ?? 0, // 0 = "not on the table" (positions are 1-based)
      over: season.over,
    };
  }
}
