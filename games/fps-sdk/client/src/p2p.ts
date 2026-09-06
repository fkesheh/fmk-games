// ============================================================================
// FPS·SDK P2P TRANSPORT (docs/PLATFORM.md §12.6) — the canonical SDK
// connection: the game's OWN menu and join flow, with the authoritative
// match running in the host player's tab. The server's role shrinks to
// rendezvous: a shell room (presence + code) and the rtc_signal hop.
//
// ONE CODE. The shell room's code IS the game code — the transport
// intercepts the game's own lobby verbs:
//
//   create_private/create_public (host): ensure shell → local GameRoom on
//     the chosen map adopts the shell code → frames loopback.
//   join_private/quick_join (guest): save the frame → ensure shell by that
//     code → dial the announced host → DC open → replay the frame to the
//     host's mini-lobby. The menu just sees "joining…" a moment longer.
//
// Differences from kart: ClientGame/Connection expose NO socket seam (kart's
// KartApp takes {socket}), and this file may not add one (net.ts and game/
// are read-only here). So the transport installs a WebSocket stand-in BEFORE
// main.ts boots: Connection's `new WebSocket()` lands here instead of the
// network, and the identical JSON wire flows loopback (host) or over the
// DataChannel (guest). No game, net, shared, or platform edits.
//
// GameRoom needs NO adapter: it already satisfies the HostedLobby
// createRoom(io, settings) => GameRoomHandle shape — constructor (mapId,
// visibility, io), start/stop, addPlayer(id, name, resume?, sig?),
// removePlayer, playerCount, stalePlayers, info, handleMessage(id, unknown).
// The closure below only resolves the mapId (default dustbowl) and pins the
// local room to 'private' (kart does the same; the shell carries visibility).
//
// IMPEDANCE NOTES (all handled or documented, none touch game.ts):
//   1. HostedLobby drops resume/sig on addPlayer (name only), so P2P seats
//      cannot rebind by identity after a DC drop. A dropped guest replays
//      its saved join frame as a FRESH seat; the host-side ghost is purged
//      at the next fullReset, exactly like an online leave-then-rejoin.
//   2. Local 'leave' while hosting TEARS DOWN the hosted lobby (a fps ghost
//      would wedge the host's own rejoin — GameRoom.addPlayer is a no-op
//      while the seat exists) and closes guest links so guests fail over.
//      Kart keeps its room because kart seats full-delete; fps ghosts, so
//      the lobby must go. The 30Hz sim stops with the lobby's last reference.
//   3. Private-code joins are capped at 5 chars by the frozen menu
//      (PRIVATE_CODE_LEN) while shell codes are 6 — a typed private code can
//      never match a shell. Public create + quick-join is the working path
//      (same as bank's tables); the menu cap is a follow-up, not a protocol
//      change, so it stays out of this file.
//   4. The rewritten shell code rides 'joined'/'snapshot' (joinTag/snapshotTag);
//      decodeS2C trusts the server and tolerates the extra snapshot field.
//   5. P2P stats mirror kart: each client reports its own match_end once.
// ============================================================================
import { GameRoom } from '../../../fps/server/src/game.js';
import type { MapId } from '@fps/shared';
import { loadIdentity, type PlayerId } from '@platform/shared';
import { HostedLobby } from '../../../../platform/sdk/src/hosted.js';
import { Profiles } from '../../../../platform/sdk/src/profile.js';
import { RtcStar, type SigChannel } from '../../../../platform/sdk/src/rtc.js';
import { reportStats } from '../../../../platform/sdk/src/stats.js';

const MAP_IDS: readonly MapId[] = ['dustbowl', 'crossfire', 'office', 'frostbite', 'urbana', 'bunker'];
const GAME_ID = 'fps-sdk';

function resolveMapId(raw: unknown): MapId {
  if (typeof raw === 'object' && raw !== null) {
    const m = (raw as Record<string, unknown>)['mapId'];
    if (typeof m === 'string' && (MAP_IDS as readonly string[]).includes(m)) return m as MapId;
  }
  return 'dustbowl';
}

function parseRecord(data: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(data);
    if (typeof v !== 'object' || v === null) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---- the transport -------------------------------------------------------------

interface GameSocket {
  onmessage: ((ev: { data: string }) => void) | null;
}

async function openWs(): Promise<{ ws: WebSocket; selfId: PlayerId }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data as string) as Record<string, unknown>;
        if (m.t === 'welcome' && typeof m.playerId === 'string') resolve({ ws, selfId: m.playerId });
      } catch {
        reject(new Error('bad welcome'));
      }
    };
    ws.onerror = () => reject(new Error('ws failed'));
  });
}

// ---- the transport -------------------------------------------------------------

export async function startP2p(): Promise<void> {
  // Platform login — same identity as online play (docs/PLATFORM.md §4.1).
  let displayName = 'Player';
  let authFrame: string | null = null;
  let authToken: string | null = null;
  try {
    const profiles = new Profiles(null);
    await profiles.ensureDeviceAuth();
    const token = profiles.token();
    if (token !== null) {
      authToken = token;
      authFrame = JSON.stringify({ t: 'auth', token });
    }
    displayName = profiles.me()?.name ?? loadIdentity().name ?? 'Player';
  } catch {
    // anonymous play stays supported
  }

  const { ws, selfId } = await openWs();
  if (authFrame !== null) ws.send(authFrame);

  const sig: SigChannel = {
    sendSignal: (to, data) => ws.send(JSON.stringify({ t: 'rtc_signal', to, data })),
    onSignal: null,
    onPeers: null,
    close: () => ws.close(),
  };
  const shell = { code: null as string | null, hostId: null as PlayerId | null, ready: false };

  let star: RtcStar | null = null;
  let guestWired = false;
  let wiredLink: unknown = null;
  let hostMounted = false;
  let lobby: HostedLobby | null = null; // host-side only
  let hostStart: string | null = null; // the host's own create frame
  const guestQueue: string[] = []; // guest frames saved while dialing
  let lastPeers: PlayerId[] = [];
  let myJoinFrame: string | null = null;
  let rejoinSent = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingJoinPublic: string | null = null;
  let lastMatchKey: string | null = null;
  let gameSock: GameSocket | null = null;

  function deliverToGame(data: string): void {
    gameSock?.onmessage?.({ data });
  }

  function makeLobby(): HostedLobby {
    const lb = new HostedLobby({
      createRoom: (io, settings) => new GameRoom(resolveMapId(settings), 'private', io),
      newRoomCode: () => shell.code ?? 'LOCAL',
      snapshotTag: 'snapshot',
      joinTag: 'joined',
    });
    return lb;
  }

  // Self-reported P2P stats: every client sees full snapshots + events, so
  // each reports its own end-of-match counters. The match_end EVENT fires
  // exactly once per match (snapshots keep ticking through matchEnd, so a
  // snapshot-phase key would double-report); the key resets on warmup.
  function watchStats(json: string): void {
    if (authToken === null) return;
    const m = parseRecord(json);
    if (m === null) return;
    if (m.t === 'snapshot' && m.phase === 'warmup') {
      lastMatchKey = null;
      return;
    }
    if (m.t !== 'event') return;
    const ev = m.ev;
    if (typeof ev !== 'object' || ev === null) return;
    const e = ev as Record<string, unknown>;
    if (e.t !== 'match_end') return;
    const key = `${String(e.winner)}:${String(e.scoreT)}:${String(e.scoreCT)}`;
    if (key === lastMatchKey) return;
    lastMatchKey = key;
    let won = false;
    if (Array.isArray(e.stats)) {
      for (const row of e.stats as Array<Record<string, unknown>>) {
        if (row.id === selfId) {
          won = row.team === e.winner;
          break;
        }
      }
    }
    const delta: Record<string, number> = won ? { 'fps.matches': 1, 'fps.wins': 1 } : { 'fps.matches': 1 };
    void reportStats(GAME_ID, delta, { getToken: () => authToken });
  }

  function ensureStar(): void {
    if (star !== null) return;
    star = new RtcStar(sig, {
      selfId,
      deps: {
        pc: () => new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }) as unknown as import('../../../../platform/sdk/src/rtc.js').PcLike,
        desc: (sdp, kind) => ({ type: kind, sdp }),
        cand: (c) => c,
      },
    });
  }

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function electNow(fromPeers: boolean): void {
    if (shell.hostId === null) return;
    if (shell.hostId === selfId) return; // already hosting
    if (!fromPeers) {
      const link = star?.link(shell.hostId);
      if (link !== null && link !== undefined) return; // pump recovered us
    } else {
      star?.dropPeer(shell.hostId);
    }
    const alive = lastPeers.filter((id) => id !== shell.hostId);
    if (alive.length === 0) {
      say('host left — waiting for players…');
      return;
    }
    const sorted = [...alive].sort();
    const next = sorted[0];
    if (next === undefined) return;
    if (next === selfId) {
      shell.hostId = selfId;
      lobby = makeLobby();
      lobby.attach(selfId, { deliver: (data) => { watchStats(data); deliverToGame(data); } });
      const create = JSON.stringify({ t: 'create_private', name: displayName, settings: {}, shellCode: shell.code });
      lobby.handleFrame(selfId, create);
      say('you are the host now — others rejoining…');
    } else {
      shell.hostId = next;
      say('new host elected — rejoining…');
    }
  }

  function onHostLinkLost(): void {
    if (star === null || shell.hostId === null) return;
    star.dropPeer(shell.hostId);
    guestWired = false;
    rejoinSent = false;
    say('connection lost — reconnecting…');
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      electNow(false);
    }, 2500);
  }

  function attachGuest(pid: PlayerId): void {
    if (lobby === null || lobby.has(pid)) return;
    const link = star?.link(pid);
    if (link === null || link === undefined) return;
    lobby.attach(pid, { deliver: (data) => star?.send(pid, { frame: data }) });
    lobby.sync(pid);
    link.onMessage = (d) => {
      const m = d as Record<string, unknown>;
      if (typeof m.frame === 'string') lobby?.handleFrame(pid, m.frame);
    };
    link.onClose = () => {
      star?.dropPeer(pid);
      lobby?.detach(pid);
    };
  }

  sig.onPeers = (ids) => {
    lastPeers = [...ids];
    if (shell.ready && shell.hostId !== null && shell.hostId !== selfId && !ids.includes(shell.hostId)) {
      electNow(true);
    }
  };

  const boot = document.createElement('div');
  boot.style.cssText = 'position:fixed;left:0;right:0;bottom:10vh;text-align:center;font:14px system-ui;color:#9aa3ad;z-index:40;pointer-events:none';
  document.body.appendChild(boot);
  const say = (t: string): void => {
    boot.textContent = t;
  };

  // Local leave (back to menu) while hosting drops the hosted room: a fps
  // ghost would wedge the host's own rejoin (addPlayer is a no-op while the
  // seat exists), so the next create starts fresh. Guest links are closed so
  // guests fail over instead of hanging on a dead sim.
  function onLocalLeave(): void {
    if (lobby !== null && selfId === shell.hostId && star !== null) {
      for (const pid of star.established()) {
        if (pid !== selfId) star.link(pid)?.close();
      }
      lobby = null;
    }
    hostMounted = false;
    hostStart = null;
    guestQueue.length = 0;
    pendingJoinPublic = null;
    rejoinSent = false;
    guestWired = false;
  }

  function sendFromGame(data: string): void {
    const m = parseRecord(data);
    if (m === null) return;
    if (m.t === 'create_private' || m.t === 'create_public') {
      hostStart = data;
      myJoinFrame = data;
      const settings = typeof m.settings === 'object' && m.settings !== null
        ? (m.settings as Record<string, unknown>)
        : {};
      ws.send(JSON.stringify({ t: m.t, name: displayName, game: GAME_ID, settings: { p2p: true, ...settings } }));
      say('opening a peer-to-peer room…');
      return;
    }
    if (m.t === 'join_private') {
      myJoinFrame = data;
      guestQueue.push(data);
      ws.send(JSON.stringify({ t: 'join_private', name: displayName, code: String(m.code ?? '') }));
      say('connecting to the host…');
      return;
    }
    if (m.t === 'quick_join') {
      hostStart = data;
      myJoinFrame = data;
      guestQueue.push(data);
      ws.send(JSON.stringify({ t: 'quick_join', name: displayName, game: GAME_ID }));
      say('finding a peer-to-peer table…');
      return;
    }
    if (m.t === 'ping') {
      deliverToGame(JSON.stringify({ t: 'pong', ts: m.ts, serverTime: Date.now() }));
      return;
    }
    if (m.t === 'list_rooms') {
      ws.send(JSON.stringify({ t: 'list_rooms' }));
      return;
    }
    if (m.t === 'join_public') {
      pendingJoinPublic = String(m.roomId ?? '');
      ws.send(JSON.stringify({ t: 'join_public', name: displayName, roomId: pendingJoinPublic }));
      say('connecting to the host…');
      return;
    }
    if (m.t === 'leave') {
      onLocalLeave();
      return;
    }
    // Room-level frames (input/reload/switch/buy/start/add_bot/…): route by
    // transport state.
    if (lobby !== null && selfId === shell.hostId) {
      lobby.handleFrame(selfId, data);
      return;
    }
    if (shell.hostId !== null && shell.hostId !== selfId) {
      const live = star?.link(shell.hostId);
      if (live !== null && live !== undefined) {
        star?.send(shell.hostId, { frame: data });
        return;
      }
    }
  }

  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (m.t === 'rtc_signal' && typeof m.from === 'string') sig.onSignal?.(m.from, m.data);
      else if (m.t === 'rtc_peers' && Array.isArray(m.ids)) sig.onPeers?.(m.ids as PlayerId[]);
      else if (m.t === 'room_list' && Array.isArray(m.rooms)) {
        deliverToGame(JSON.stringify({ t: 'room_list', rooms: m.rooms }));
      } else if (m.t === 'p2p_ready' && typeof m.code === 'string' && typeof m.hostId === 'string') {
        shell.code = m.code;
        shell.hostId = m.hostId;
        shell.ready = true;
      }
    } catch {
      // malformed rendezvous frame: drop
    }
  };

  // Install the stand-in BEFORE main.ts boots ClientGame: Connection's
  // `new WebSocket()` resolves at construct time, so every session from now
  // on rides this transport. A plain class, never a subclass — no network
  // socket is ever opened on the game path (a dummy super() URL would error
  // async and trip Connection's pre-open fail path). Only the surface
  // Connection touches is implemented; the cast covers the rest.
  class GameWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = GameWebSocket.OPEN;
    onopen: ((ev?: unknown) => void) | null = null;
    onclose: ((ev?: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: ((ev?: unknown) => void) | null = null;
    readonly url: string;
    constructor(url: string | URL, protocols?: string | string[]) {
      void protocols;
      this.url = String(url);
      gameSock = this;
      // Connection wires its handlers synchronously right after construct;
      // deliver open + the lobby's greeting on the next macrotask, when they
      // are in place (same timing as a real socket).
      setTimeout(() => {
        if (this.readyState !== GameWebSocket.OPEN) return;
        this.onopen?.(undefined);
        this.onmessage?.({ data: JSON.stringify({ t: 'welcome', playerId: selfId }) });
        this.onmessage?.({ data: JSON.stringify({ t: 'room_list', rooms: [] }) });
      }, 0);
    }
    send(data: string): void {
      if (this.readyState !== GameWebSocket.OPEN) return;
      sendFromGame(data);
    }
    close(): void {
      if (this.readyState === GameWebSocket.CLOSED) return;
      this.readyState = GameWebSocket.CLOSED;
      if (gameSock === this) gameSock = null;
      // Explicit close: Connection.close() already suppresses onClose, and a
      // rejoin constructs a FRESH socket — never fire onclose here.
    }
  }
  globalThis.WebSocket = GameWebSocket as unknown as typeof WebSocket;

  const pump = setInterval(() => {
    if (!shell.ready) return;
    ensureStar();
    const isHost = selfId === shell.hostId;
    if (isHost && hostStart !== null && !hostMounted) {
      if (lobby === null) {
        lobby = makeLobby();
        lobby.attach(selfId, { deliver: (data) => { watchStats(data); deliverToGame(data); } });
        const src = parseRecord(hostStart);
        const framed = JSON.stringify({ ...(src ?? {}), shellCode: shell.code });
        lobby.handleFrame(selfId, framed);
        say('');
      }
      hostMounted = true;
    }
    if (!isHost && shell.hostId !== null) {
      const link = star?.link(shell.hostId);
      if (link !== null && link !== undefined) {
        if (!guestWired || wiredLink !== link) {
          guestWired = true;
          wiredLink = link;
          link.onMessage = (d) => {
            const m = d as Record<string, unknown>;
            if (typeof m.frame === 'string') {
              watchStats(m.frame);
              deliverToGame(m.frame);
            }
          };
          link.onClose = () => {
            onHostLinkLost();
          };
        }
        if (guestQueue.length > 0) {
          for (const f of guestQueue.splice(0)) star?.send(shell.hostId, { frame: f });
          say('');
        }
        if (pendingJoinPublic !== null && shell.code !== null) {
          star?.send(shell.hostId, { frame: JSON.stringify({ t: 'join_private', name: displayName, code: shell.code }) });
          pendingJoinPublic = null;
          say('');
        }
      }
      if ((star === null || star.link(shell.hostId) === null) && shell.hostId !== null) {
        star?.dial(shell.hostId);
      }
      const cur = shell.hostId !== null ? star?.link(shell.hostId) : null;
      if (cur !== null && cur !== undefined && shell.hostId !== null && shell.hostId !== selfId && myJoinFrame !== null && !rejoinSent) {
        rejoinSent = true;
        clearReconnect();
        star?.send(shell.hostId, { frame: myJoinFrame });
        say('');
      }
    }
    if (isHost) for (const pid of star?.established() ?? []) attachGuest(pid);
  }, 100);
  void pump;

  (window as unknown as { __p2pDbg?: () => unknown }).__p2pDbg = () => ({
    ready: shell.ready, hostId: shell.hostId, selfId, lastPeers,
    lobbyRoom: lobby?.debugRoom() ?? null,
  });
}
