// ============================================================================
// KART·SDK P2P TRANSPORT (docs/PLATFORM.md §12.6) — the canonical SDK
// connection: the game's OWN menu and join flow, with the authoritative
// race running in the host player's tab. The server's role shrinks to
// rendezvous: a shell room (presence + code) and the rtc_signal hop.
//
// ONE CODE. The shell room's code IS the game code — the transport
// intercepts the game's own lobby verbs:
//
//   create_private/create_public/quick_join (host): ensure shell → local
//     KartRoom on the chosen track adopts the shell code → frames loopback.
//   join_private/quick_join (guest): save the frame → ensure shell by that
//     code → dial the announced host → DC open → replay the frame to the
//     host's mini-lobby. The menu just sees "joining…" a moment longer.
//
// Differences from bank: the room needs a trackId (from the create frame's
// settings, default greenvale); join state arrives in `kart_joined`
// (snapshotTag for code-rewrite + sync); stats fire on the `results` phase.
// Phone pads (pad.ts, server-routed) stay on the legacy path for now —
// P2P races are keyboard/gamepad; see docs/PAD.md.
// ============================================================================
import { KartRoom } from '@kart/server/room.js';
import { DEFAULT_TRACK_ID, isTrackId } from '@kart/shared/tracks/index.js';
import type { TrackId } from '@kart/shared/track.js';
import { loadIdentity, type GameRoomHandle, type PlayerId, type RoomIO } from '@platform/shared';
import { HostedLobby } from '@platform/sdk/hosted.js';
import { Profiles } from '@platform/sdk/profile.js';
import { RtcStar, type SigChannel } from '@platform/sdk/rtc.js';
import { reportStats } from '@platform/sdk/stats.js';
import type { KartWsLike } from './app.js';
import { KartApp } from './app.js';

function resolveTrack(raw: unknown): TrackId {
  if (typeof raw === 'object' && raw !== null) {
    const t = (raw as Record<string, unknown>)['trackId'];
    if (isTrackId(t)) return t;
  }
  return DEFAULT_TRACK_ID;
}

// ---- sockets -----------------------------------------------------------------

function loopbackSocket(lobby: HostedLobby, selfId: PlayerId): KartWsLike {
  const sock: KartWsLike = {
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

function dcSocket(star: RtcStar, hostId: PlayerId, selfId: PlayerId): KartWsLike {
  const sock: KartWsLike = {
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
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (m.t === 'rtc_signal' && typeof m.from === 'string') sig.onSignal?.(m.from, m.data);
      else if (m.t === 'room_list' && Array.isArray(m.rooms)) {
        gameSocket.onmessage?.({ data: JSON.stringify({ t: 'room_list', rooms: m.rooms }) });
      } else if (m.t === 'p2p_ready' && typeof m.code === 'string' && typeof m.hostId === 'string') {
        shell.code = m.code;
        shell.hostId = m.hostId;
        shell.ready = true;
      }
    } catch {
      // malformed rendezvous frame: drop
    }
  };

  let star: RtcStar | null = null;
  let guestWired = false;
  let hostMounted = false;
  let lobby: HostedLobby | null = null; // host-side only
  let hostStart: string | null = null; // the host's own create frame
  const guestQueue: string[] = []; // guest frames saved while dialing
  let lastPeers: PlayerId[] = [];
  let myJoinFrame: string | null = null;
  let rejoinSent = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingJoinPublic: string | null = null;
  let lastResultsKey: string | null = null;

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

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  // Self-reported P2P stats: every client sees full snapshots, so each
  // reports its own end-of-race counters (matches + win on P1).
  function watchStats(json: string): void {
    if (authToken === null) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    if (m.t !== 'kart_snapshot' || m.phase !== 'results') {
      if (m.t === 'kart_snapshot' && m.phase !== 'results') lastResultsKey = null;
      return;
    }
    const tick = typeof m.tick === 'number' ? m.tick : 0;
    const key = `${typeof m.roomId === 'string' ? m.roomId : ''}:${tick}`;
    if (key === lastResultsKey) return;
    lastResultsKey = key;
    const delta: Record<string, number> = { 'kart.matches': 1 };
    const places = m.places;
    if (Array.isArray(places)) {
      const mine = (places as Array<Record<string, unknown>>).find((p) => p.id === selfId);
      if (mine !== undefined && mine.place === 1) delta['kart.wins'] = 1;
    }
    void reportStats('kart-sdk', delta, { getToken: () => authToken });
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
    const next = [...alive].sort()[0] as PlayerId;
    if (next === selfId) {
      shell.hostId = selfId;
      lobby = makeLobby();
      lobby.attach(selfId, { deliver: (data) => { watchStats(data); gameSocket.onmessage?.({ data }); } });
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

  function makeLobby(): HostedLobby {
    const lb = new HostedLobby({
      createRoom: (io, settings) => new KartRoom(resolveTrack(settings), 'private', io),
      newRoomCode: () => shell.code ?? 'LOCAL',
      snapshotTag: 'kart_snapshot',
      joinTag: 'kart_joined',
    });
    return lb;
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
  let promotedNotice = false;
  const say = (t: string): void => {
    if (promotedNotice && t === '') return;
    boot.textContent = t;
  };

  const gameSocket: KartWsLike = {
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
        hostStart = data;
        myJoinFrame = data;
        ws.send(JSON.stringify({ t: m.t, name: displayName, game: 'kart-sdk', settings: { p2p: true } }));
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
        ws.send(JSON.stringify({ t: 'quick_join', name: displayName, game: 'kart-sdk' }));
        say('finding a peer-to-peer table…');
        return;
      }
      if (m.t === 'ping') {
        gameSocket.onmessage?.({ data: JSON.stringify({ t: 'pong', ts: m.ts, serverTime: Date.now() }) });
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
      // Room-level frames (kart_input/nitro/start): route by transport state.
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
    },
    close: () => {
      gameSocket.readyState = 3;
      gameSocket.onclose?.();
    },
  };

  const pump = setInterval(() => {
    if (!shell.ready) return;
    ensureStar();
    const isHost = selfId === shell.hostId;
    if (isHost && hostStart !== null && !hostMounted) {
      if (lobby === null) {
        lobby = makeLobby();
        lobby.attach(selfId, { deliver: (data) => { watchStats(data); gameSocket.onmessage?.({ data }); } });
        const src = JSON.parse(hostStart) as Record<string, unknown>;
        const framed = JSON.stringify({ ...src, shellCode: shell.code });
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
              gameSocket.onmessage?.({ data: m.frame });
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
  let wiredLink: unknown = null;

  setTimeout(() => {
    gameSocket.onopen?.();
    gameSocket.onmessage?.({ data: JSON.stringify({ t: 'welcome', playerId: selfId }) });
    gameSocket.onmessage?.({ data: JSON.stringify({ t: 'room_list', rooms: [] }) });
  }, 0);
  (window as unknown as { __p2pDbg?: () => unknown }).__p2pDbg = () => ({
    ready: shell.ready, hostId: shell.hostId, selfId, lastPeers,
    electCalls: (window as unknown as { __electCalls?: number }).__electCalls ?? 0,
    lobbyFrames: lobby?.debugFrames ?? null,
    lobbyRoom: lobby?.debugRoom() ?? null,
  });
  void new KartApp(app, { socket: gameSocket });
  void boot;
  void say;
  void pump;
}
