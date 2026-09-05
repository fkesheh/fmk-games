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
  private lastState: string | null = null; // latest bank_state (replay on late attach)
  private readonly io: RoomIO;

  constructor() {
    const self = this;
    this.io = {
      send: (id, msg) => {
        // ONE code: the menu renders bank_state.code, which is the BANK
        // room's internal mint — rewrite it to this lobby's (shell) code so
        // the displayed code is the code guests can actually join with.
        if (typeof msg === 'object' && msg !== null && (msg as { t?: string }).t === 'bank_state') {
          msg = { ...(msg as Record<string, unknown>), code: self.code };
        }
        const json = JSON.stringify(msg);
        if (typeof msg === 'object' && msg !== null && (msg as { t?: string }).t === 'bank_state') {
          self.lastState = json;
        }
        self.sinks.get(id)?.deliver(json);
      },
      rttMs: () => 0,
    };
  }

  /** Re-send the current snapshot to a just-attached sink (join/attach race:
  the reply to a join can arrive before the sink exists on a slow tick). */
  sync(id: PlayerId): void {
    const sink = this.sinks.get(id);
    if (sink !== undefined && this.lastState !== null) {
      sink.deliver(this.lastState);
    }
  }

  attach(id: PlayerId, sink: GuestSink): void {
    this.sinks.set(id, sink);
  }

  has(id: PlayerId): boolean {
    return this.sinks.has(id);
  }

  detach(id: PlayerId): void {
    this.sinks.delete(id);
    // Ghost, don't purge: removePlayer() without `permanent` keeps the
    // seat + score so a reconnect re-binds in place (same session id).
    this.room?.removePlayer(id);
  }

  get joinCode(): string | null {
    return this.code;
  }
  debugRoom(): { members: number; hasRoom: boolean } {
    return { members: this.sinks.size, hasRoom: this.room !== null };
  }
  debugFrames: string[] = [];
  recordFrame(id: PlayerId, data: string): void {
    this.debugFrames.push(id + ':' + data.slice(0, 60));
    if (this.debugFrames.length > 20) this.debugFrames.shift();
  }

  handleFrame(id: PlayerId, data: string): void {
    this.recordFrame(id, data);
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

  // P2P match stats (docs/PLATFORM.md §12): every client sees full
  // snapshots, so each reports its OWN end-of-match counters. One POST per
  // (room, match) — keyed off the phase transition into matchEnd.
  let lastMatchKey: string | null = null;
  function watchStats(json: string): void {
    if (authToken === null) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    if (m.t !== 'bank_state' || m.phase !== 'matchEnd') {
      if (m.t === 'bank_state' && m.phase !== 'matchEnd') lastMatchKey = null;
      return;
    }
    const code = typeof m.code === 'string' ? m.code : '';
    const round = typeof m.round === 'number' ? m.round : 0;
    const key = `${code}:${round}`;
    if (key === lastMatchKey) return;
    lastMatchKey = key;
    const players = Array.isArray(m.players) ? (m.players as Array<Record<string, unknown>>) : [];
    const me = players.find((pl) => pl.id === selfId);
    if (me === undefined) return;
    const score = typeof me.score === 'number' ? Math.trunc(me.score) : 0;
    const won = m.winnerId === selfId ? 1 : 0;
    const headers = { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' };
    void (async () => {
      try {
        await fetch('/api/stats/bank-sdk', { method: 'POST', headers, body: JSON.stringify({ key: 'bank.matches', value: 1 }) });
        if (won === 1) await fetch('/api/stats/bank-sdk', { method: 'POST', headers, body: JSON.stringify({ key: 'bank.wins', value: 1 }) });
        await fetch('/api/stats/bank-sdk', { method: 'POST', headers, body: JSON.stringify({ key: 'bank.score', value: score }) });
      } catch {
        // stats are best-effort in P2P mode
      }
    })();
  }

  const { ws, selfId } = await openWs();
  if (authFrame !== null) ws.send(authFrame);

  const sig: SigChannel = {
    sendSignal: (to, data) => ws.send(JSON.stringify({ t: 'rtc_signal', to, data })),
    onSignal: null,
    onPeers: (ids) => {
      lastPeers = [...ids];
      // Fast guest-loss path: a closed tab's ws dies in ~1s (ICE takes
      // 10-30s). Ghost any attached seat the room no longer lists.
      if (lobby !== null && selfId === shell.hostId) {
        for (const pid of [...attachedGuests]) {
          if (pid !== selfId && !ids.includes(pid)) {
            attachedGuests.delete(pid);
            lobby.detach(pid);
          }
        }
      }
      // Fast host-loss path: the server notices a dead ws long before ICE
      // consent times out. If our host is gone from the room, elect now.
      if (shell.ready && shell.hostId !== null && shell.hostId !== selfId && !ids.includes(shell.hostId)) {
        electNow(true);
      }
    },
    close: () => ws.close(),
  };
  const shell = { code: null as string | null, hostId: null as PlayerId | null, ready: false };
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (m.t === 'rtc_signal' && typeof m.from === 'string') sig.onSignal?.(m.from, m.data);
      else if (m.t === 'rtc_peers' && Array.isArray(m.ids)) sig.onPeers?.(m.ids as PlayerId[]);
      // p2p_ready is read by shellWatch below (single consumer).
      else if (m.t === 'room_list' && Array.isArray(m.rooms)) {
        gameSocket.onmessage?.({ data: JSON.stringify({ t: 'room_list', rooms: m.rooms }) });
      }
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
  let guestWired = false; // inbound DC→game routing installed
  let wiredLink: unknown = null; // link object currently wired (flaps replace it)
  let hostMounted = false;
  let lastPeers: PlayerId[] = []; // latest rtc_peers (election input)
  let myJoinFrame: string | null = null; // what got me in — replayed on rejoin
  let electTimer: ReturnType<typeof setTimeout> | null = null; // inbound DC→game routing installed once
  let lobby: BankP2pLobby | null = null; // host-side only
  let hostStart: string | null = null; // the host's own create frame
  const guestQueue: string[] = []; // guest frames saved while dialing
  let pendingJoinPublic: string | null = null; // shell roomId awaiting table-click join


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
  const attachedGuests = new Set<PlayerId>();
  function attachGuest(pid: PlayerId): void {
    if (lobby === null || lobby.has(pid)) return;
    const link = star?.link(pid);
    if (link === null || link === undefined) return;
    lobby.attach(pid, { deliver: (data) => star?.send(pid, { frame: data }) });
    attachedGuests.add(pid);
    lobby.sync(pid); // the join reply may have raced ahead of this attach
    link.onMessage = (d) => {
      const m = d as Record<string, unknown>;
      if (typeof m.frame === 'string') lobby?.handleFrame(pid, m.frame);
    };
    link.onClose = () => {
            star?.dropPeer(pid);
            attachedGuests.delete(pid);
            lobby?.detach(pid);
          };
  }

  // A small boot-status line while the transport works; the game UI takes over.
  const boot = document.createElement('div');
  boot.style.cssText = 'position:fixed;left:0;right:0;bottom:10vh;text-align:center;font:14px system-ui;color:#9aa3ad;z-index:40;pointer-events:none';
  document.body.appendChild(boot); // NOT app: game re-renders would wipe it
  let promotedNotice = false;
  const say = (t: string): void => {
    if (promotedNotice && t === '') return; // promotion banner sticks
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
      myJoinFrame = data;
        ws.send(JSON.stringify({ t: m.t, name: displayName, game: 'bank-sdk', settings: { p2p: true, ...(typeof m.settings === 'object' && m.settings !== null ? m.settings : {}) } }));
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
        // Public matchmaking: the server's quick_join lands us in the first
        // open public shell (or mints one — its first member hosts). Save
        // the frame EITHER WAY: it may need local replay if we are the host.
        hostStart = data;
      myJoinFrame = data;
        guestQueue.push(data);
        ws.send(JSON.stringify({ t: 'quick_join', name: displayName, game: 'bank-sdk' }));
        say('finding a peer-to-peer table…');
        return;
      }
      if (m.t === 'ping') {
        gameSocket.onmessage?.({ data: JSON.stringify({ t: 'pong', ts: m.ts, serverTime: Date.now() }) });
        return;
      }
      if (m.t === 'list_rooms') {
        // TABLES list: the rendezvous server knows the public shells.
        ws.send(JSON.stringify({ t: 'list_rooms' }));
        return;
      }
      if (m.t === 'join_public') {
        // Row click: join the SHELL for presence, then synthesize the
        // code-join the host lobby expects once the DC opens.
        pendingJoinPublic = m.roomId !== undefined ? String(m.roomId) : '';
        ws.send(JSON.stringify({ t: 'join_public', name: displayName, roomId: pendingJoinPublic }));
        say('connecting to the host…');
        return;
      }
      // Room-level frames (roll/bank/leave): route by transport state.
      if (lobby !== null && selfId === shell.hostId) {
        lobby.handleFrame(selfId, data);
        return;
      }
      // Guest path: the DC carries gameplay frames to the host's lobby.
      // (Join frames never reach here — they return early above.)
      if (shell.hostId !== null && shell.hostId !== selfId) {
        const live = star?.link(shell.hostId);
        if (live !== null && live !== undefined) {
          star?.send(shell.hostId, { frame: data });
          return;
        }
      }
      return; // DC not open yet — join frames are queued above
    },
    close: () => {
      gameSocket.readyState = 3;
      gameSocket.onclose?.();
    },
  };

  // Reconnect + election engine.
  // - Transient DC drop: keep the game socket alive, redial, and replay the
  //   saved join frame; the host kept our seat as a ghost (score intact).
  // - Host loss: after the grace window the lowest remaining session id
  //   promotes itself (docs/PLATFORM.md §12.3); everyone recomputes the same
  //   answer from the same rtc_peers list. New match, same code.
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let rejoinSent = false; // my join frame reached the current host
  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
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
  function electNow(fromPeers: boolean): void {
    if (shell.hostId === null) return;
    if (shell.hostId === selfId) return; // already hosting — late timers must not clobber us
    if (!fromPeers) {
      // Timer path (link loss, no server confirmation yet): a live link
      // means the pump already recovered us — stand down.
      const link = star?.link(shell.hostId);
      if (link !== null && link !== undefined) return;
    } else {
      // Peer-list path: the server confirmed the host is gone — a stale
      // local link entry must NOT veto the election.
      star?.dropPeer(shell.hostId);
    }
    const alive = lastPeers.filter((id) => id !== shell.hostId);
    if (alive.length === 0) {
      say('host left — waiting for players…');
      return;
    }
    const sorted = [...alive].sort();
    const next = sorted[0] as PlayerId;
    if (next === selfId) {
      // WE promote: fresh local lobby, SAME shell code, seat ourselves.
      shell.hostId = selfId;
      promotedNotice = true;
      try {
      lobby = new BankP2pLobby();
      lobby.attach(selfId, { deliver: (data) => { watchStats(data); gameSocket.onmessage?.({ data }); } });
      const create = JSON.stringify({ t: 'create_private', name: displayName, settings: {}, shellCode: shell.code });
      lobby.handleFrame(selfId, create);
      } catch (err) {
        (window as unknown as { __electErr?: string }).__electErr = String(err).slice(0, 200);
      }
      say('you are the host now — others rejoining…');
    } else {
      shell.hostId = next;
      say('new host elected — rejoining…');
    }
  }

  // The rendezvous pump: shell ready → star; host → lobby + frame replay;
  // guest → dial + frame replay once the DC opens. One idempotent loop.
  const pump = setInterval(() => {
    if (!shell.ready) return;
    ensureStar();
    const isHost = selfId === shell.hostId;
    if (isHost && hostStart !== null && !hostMounted) {
      if (lobby === null) {
        lobby = new BankP2pLobby();
        // Bridge the host's own game to its local lobby: without this attach
        // the room's broadcasts (bank_state, events) reach no sink.
        lobby.attach(selfId, {
        deliver: (data) => {
          watchStats(data);
          gameSocket.onmessage?.({ data });
        },
      });
        const src = JSON.parse(hostStart) as Record<string, unknown>;
        delete src.p2pHint;
        const framed = JSON.stringify({ ...src, shellCode: shell.code });
        lobby.handleFrame(selfId, framed); // local BankRoom adopts the shell code
        say('');
      }
      hostMounted = true;
      // NOTE: the pump keeps running — guests attach whenever their links
      // open, which can be seconds after we mount our own game.
    }
    if (!isHost && shell.hostId !== null) {
      const link = star?.link(shell.hostId);
      if (link !== null && link !== undefined) {
        // Route the host's replies into our game socket. Re-wire whenever
        // the link object itself changes (ICE flap → new link object).
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
          // Table-click join: the host lobby speaks codes, not room ids.
          star?.send(shell.hostId, { frame: JSON.stringify({ t: 'join_private', name: displayName, code: shell.code }) });
          pendingJoinPublic = null;
          say('');
        }
      }
      if ((star === null || star.link(shell.hostId) === null) && shell.hostId !== null) {
        star?.dial(shell.hostId); // idempotent while negotiating
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

  // Hand the transport to the game — its standard menu is the join screen.
  // welcome: BankGame gates its menu on a session id (over P2P it is the
  // rendezvous session id).
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
  void new BankGame(app, { socket: gameSocket });
  void boot;
  void say;
}
