// ============================================================================
// BANK·SDK P2P TRANSPORT (docs/PLATFORM.md §12.6) — the canonical SDK
// connection: the game's OWN menu and join flow, with the authoritative
// match running in the host player's tab. The server's role shrinks to
// rendezvous: a shell room (presence + code) and the rtc_signal hop.
//
// ONE CODE. The shell room's code IS the game code — the transport
// intercepts the game's own lobby verbs:
//
//   create_private (host): ensure shell → local BankRoom adopts the shell
//     code → frames flow loopback.
//   join_private/quick_join (guest): save the frame → ensure shell by that
//     code → dial the announced host → DC open → replay the frame to the
//     host's mini-lobby. The menu just sees "joining…" a moment longer.
//
// The platform server never runs the match.
// ============================================================================
import { BankRoom } from '@bank/server/room.js';
import { DEFAULT_SETTINGS, type BankSettings } from '@bank/shared';
import { loadIdentity, type GameRoomHandle, type PlayerId, type RoomIO } from '@platform/shared';
import { Profiles } from '@platform/sdk/profile.js';
import { RtcStar, type SigChannel } from '@platform/sdk/rtc.js';
import type { WsLike } from './game.js';
import { BankGame } from './game.js';

function resolveSettings(raw: Record<string, unknown> | undefined): BankSettings {
  const s = raw ?? {};
  const sevenBonus = s['sevenBonus'] ?? DEFAULT_SETTINGS.sevenBonus;
  const totalRounds = s['totalRounds'] ?? DEFAULT_SETTINGS.totalRounds;
  return {
    sevenBonus: typeof sevenBonus === 'boolean' ? sevenBonus : DEFAULT_SETTINGS.sevenBonus,
    totalRounds: totalRounds === 20 ? 20 : 10,
    raceTarget: null,
  };
}

// ---- host mini-lobby ---------------------------------------------------------

interface GuestSink {
  deliver(data: string): void;
}

class BankP2pLobby {
  private readonly sinks = new Map<PlayerId, GuestSink>();
  private room: GameRoomHandle | null = null;
  private code: string | null = null;
  private readonly io: RoomIO;

  constructor() {
    this.io = {
      send: (id, msg) => {
        // ONE code: the menu renders bank_state.code, which is the BANK
        // room's internal mint — rewrite it to this lobby's (shell) code so
        // the displayed code is the code guests can actually join with.
        if (typeof msg === 'object' && msg !== null && (msg as { t?: string }).t === 'bank_state') {
          msg = { ...(msg as Record<string, unknown>), code: this.code };
        }
        this.sinks.get(id)?.deliver(JSON.stringify(msg));
      },
      rttMs: () => 0,
    };
  }

  attach(id: PlayerId, sink: GuestSink): void {
    this.sinks.set(id, sink);
  }

  has(id: PlayerId): boolean {
    return this.sinks.has(id);
  }

  detach(id: PlayerId): void {
    this.sinks.delete(id);
    this.room?.removePlayer(id, true);
  }

  get joinCode(): string | null {
    return this.code;
  }

  handleFrame(id: PlayerId, data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const m = parsed as Record<string, unknown>;
    switch (m.t) {
      case 'create_private':
      case 'create_public':
      case 'quick_join': {
        if (this.room !== null) {
          this.room.addPlayer(id, String(m.name ?? 'Player'));
          return;
        }
        const room = new BankRoom('private', this.io, resolveSettings(undefined));
        this.room = room;
        this.code = m['shellCode'] as string; // ONE code: the shell's
        const baseInfo = room.info();
        room.info = () => ({ ...baseInfo, code: this.code, game: 'bank-sdk' });
        this.room.addPlayer(id, String(m.name ?? 'Player'));
        return;
      }
      case 'join_private': {
        const room = this.room;
        if (room === null || m.code !== this.code) {
          this.sinks.get(id)?.deliver(JSON.stringify({ t: 'error', code: 'no_room', message: 'no such p2p game' }));
          return;
        }
        room.addPlayer(id, String(m.name ?? 'Player'));
        return;
      }
      case 'ping':
        this.sinks.get(id)?.deliver(JSON.stringify({ t: 'pong', ts: m.ts, serverTime: Date.now() }));
        return;
      case 'leave':
        this.detach(id);
        return;
      default:
        this.room?.handleMessage(id, parsed);
    }
  }
}

// ---- sockets -----------------------------------------------------------------

function loopbackSocket(lobby: BankP2pLobby, selfId: PlayerId): WsLike {
  const sock: WsLike = {
    readyState: 1,
    onopen: null,
    onclose: null,
    onmessage: null,
    send: (data) => lobby.handleFrame(selfId, data),
    close: () => {
      sock.readyState = 3;
      sock.onclose?.();
    },
  };
  lobby.attach(selfId, { deliver: (data) => sock.onmessage?.({ data }) });
  setTimeout(() => sock.onmessage?.({ data: JSON.stringify({ t: 'welcome', playerId: selfId }) }), 0);
  return sock;
}

function dcSocket(star: RtcStar, hostId: PlayerId, selfId: PlayerId): WsLike {
  const sock: WsLike = {
    readyState: 1,
    onopen: null,
    onclose: null,
    onmessage: null,
    send: (data) => star.send(hostId, { frame: data }),
    close: () => {
      sock.readyState = 3;
      sock.onclose?.();
    },
  };
  const link = star.link(hostId);
  if (link === null) throw new Error('p2p: link not open');
  link.onMessage = (d) => {
    const m = d as Record<string, unknown>;
    if (typeof m.frame === 'string') sock.onmessage?.({ data: m.frame });
  };
  link.onClose = () => {
    sock.readyState = 3;
    sock.onclose?.();
  };
  setTimeout(() => sock.onmessage?.({ data: JSON.stringify({ t: 'welcome', playerId: selfId }) }), 0);
  return sock;
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

export async function startP2p(app: HTMLElement): Promise<void> {
  // Platform login — same identity as online play (docs/PLATFORM.md §4.1).
  let displayName = 'Player';
  let authFrame: string | null = null;
  try {
    const profiles = new Profiles(null);
    await profiles.ensureDeviceAuth();
    const token = profiles.token();
    if (token !== null) authFrame = JSON.stringify({ t: 'auth', token });
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
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (m.t === 'rtc_signal' && typeof m.from === 'string') sig.onSignal?.(m.from, m.data);
      // p2p_ready is read by shellWatch below (single consumer).
      else if (m.t === 'p2p_ready' && typeof m.code === 'string' && typeof m.hostId === 'string') {
        shell.code = m.code;
        shell.hostId = m.hostId;
        shell.ready = true;
      }
    } catch {
      // malformed rendezvous frame: drop
    }
  };

  let star: RtcStar | null = null;
  let lobby: BankP2pLobby | null = null; // host-side only
  let hostStart: string | null = null; // the host's own create frame
  const guestQueue: string[] = []; // guest frames saved while dialing

  function ensureStar(): void {
    if (star !== null) return;
    star = new RtcStar(sig, {
      selfId,
      deps: {
        pc: () => new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }) as unknown as import('@platform/sdk/rtc.js').PcLike,
        desc: (sdp, kind) => ({ type: kind, sdp }),
        cand: (c) => c,
      },
    });
  }

  /** Attach an established guest link to the host lobby (frames both ways). */
  function attachGuest(pid: PlayerId): void {
    if (lobby === null || lobby.has(pid)) return;
    const link = star?.link(pid);
    if (link === null || link === undefined) return;
    lobby.attach(pid, { deliver: (data) => star?.send(pid, { frame: data }) });
    link.onMessage = (d) => {
      const m = d as Record<string, unknown>;
      if (typeof m.frame === 'string') lobby?.handleFrame(pid, m.frame);
    };
    link.onClose = () => lobby?.detach(pid);
  }

  // A small boot-status line while the transport works; the game UI takes over.
  const boot = document.createElement('div');
  boot.style.cssText = 'position:fixed;left:0;right:0;bottom:10vh;text-align:center;font:14px system-ui;color:#9aa3ad;z-index:40';
  app.appendChild(boot);
  const say = (t: string): void => {
    boot.textContent = t;
  };

  const gameSocket: WsLike = {
    readyState: 1,
    onopen: null,
    onclose: null,
    onmessage: null,
    send: (data) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (m.t === 'create_private' || m.t === 'create_public') {
        // HOST: claim a shell whose code the game will show, then run the
        // local lobby. The frame is replayed with the shell code attached.
        hostStart = data;
        ws.send(JSON.stringify({ t: m.t, name: displayName, game: 'bank-sdk', settings: { p2p: true, ...(typeof m.settings === 'object' && m.settings !== null ? m.settings : {}) } }));
        say('opening a peer-to-peer room…');
        return;
      }
      if (m.t === 'join_private') {
        guestQueue.push(data);
        ws.send(JSON.stringify({ t: 'join_private', name: displayName, code: String(m.code ?? '') }));
        say('connecting to the host…');
        return;
      }
      if (m.t === 'quick_join') {
        // Public matchmaking: the server's quick_join lands us in the first
        // open public shell (or mints one — its first member hosts). Save
        // the frame EITHER WAY: it may need local replay if we are the host.
        hostStart = data;
        guestQueue.push(data);
        ws.send(JSON.stringify({ t: 'quick_join', name: displayName, game: 'bank-sdk' }));
        say('finding a peer-to-peer table…');
        return;
      }
      if (m.t === 'ping') {
        gameSocket.onmessage?.({ data: JSON.stringify({ t: 'pong', ts: m.ts, serverTime: Date.now() }) });
        return;
      }
      // Room-level frames are meaningless until the transport is live; the
      // host's loopback delivers them directly, guests never get here.
    },
    close: () => {
      gameSocket.readyState = 3;
      gameSocket.onclose?.();
    },
  };

  // The rendezvous pump: shell ready → star; host → lobby + frame replay;
  // guest → dial + frame replay once the DC opens. One idempotent loop.
  const pump = setInterval(() => {
    if (!shell.ready) return;
    ensureStar();
    const isHost = selfId === shell.hostId;
    if (isHost && lobby === null && hostStart !== null) {
      lobby = new BankP2pLobby();
      // Bridge the host's own game to its local lobby: without this attach
      // the room's broadcasts (bank_state, events) reach no sink.
      lobby.attach(selfId, { deliver: (data) => gameSocket.onmessage?.({ data }) });
      const src = JSON.parse(hostStart) as Record<string, unknown>;
      delete src.p2pHint;
      const framed = JSON.stringify({ ...src, shellCode: shell.code });
      lobby.handleFrame(selfId, framed); // local BankRoom adopts the shell code
      say('');
      clearInterval(pump);
    }
    if (!isHost && shell.hostId !== null) {
      const link = star?.link(shell.hostId);
      if (link !== null && link !== undefined && guestQueue.length > 0) {
        for (const f of guestQueue.splice(0)) star?.send(shell.hostId, { frame: f });
        say('');
        clearInterval(pump);
      }
      if ((star === null || star.link(shell.hostId) === null) && shell.hostId !== null) {
        star?.dial(shell.hostId); // idempotent while negotiating
      }
    }
    if (isHost) for (const pid of star?.established() ?? []) attachGuest(pid);
  }, 100);

  // Hand the transport to the game — its standard menu is the join screen.
  // welcome: BankGame gates its menu on a session id (over P2P it is the
  // rendezvous session id).
  setTimeout(() => {
    gameSocket.onopen?.();
    gameSocket.onmessage?.({ data: JSON.stringify({ t: 'welcome', playerId: selfId }) });
    gameSocket.onmessage?.({ data: JSON.stringify({ t: 'room_list', rooms: [] }) });
  }, 0);
  void new BankGame(app, { socket: gameSocket });
  void boot;
  void say;
}
