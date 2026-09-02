// ============================================================================
// BANK·SDK P2P RUNTIME (docs/PLATFORM.md §12.6 P2) — the user-as-server
// pilot. The host tab runs a REAL BankRoom (isomorphic TS) behind a
// mini-lobby; guests connect DataChannel-direct via the platform's
// rtc_signal relay. The server's role shrinks to rendezvous: presence
// (rtc_peers) + signaling hop. The BankGame client is UNCHANGED — both
// sides speak the exact wire protocol of online play through a SocketLike.
//
//   host:  ws shell room (presence) ──┐
//   guest: ws shell room (presence) ──┤ rtc_peers → lowest id hosts
//                                     ▼
//              RtcStar DataChannel star ── host tab: P2pLobby + BankRoom
//   each BankGame talks to its SocketLike: loopback (host) / DC (guest)
// ============================================================================
import { BankRoom } from '@bank/server/room.js';
import { DEFAULT_SETTINGS, MAX_PLAYERS, type BankSettings } from '@bank/shared';
import { CLAIM_ALPHABET, rng, type GameRoomHandle, type PlayerId, type RoomIO } from '@platform/shared';
import { RtcStar, type SigChannel } from '@platform/sdk/rtc.js';
import type { WsLike } from './game.js';
import { BankGame } from './game.js';


// ---- settings (mirrors bank module's resolveSettings; browser-safe) --------

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

// ---- host mini-lobby -------------------------------------------------------

interface GuestSink {
  deliver(data: string): void;
}

/** In-tab replacement for the platform lobby + room, hosting ONE BankRoom. */
class BankP2pLobby {
  private readonly sinks = new Map<PlayerId, GuestSink>();
  private room: GameRoomHandle & { info: () => { code: string | null } } | null = null;
  private code: string | null = null;
  private readonly io: RoomIO;

  constructor() {
    this.io = {
      send: (id, msg) => {
        const sink = this.sinks.get(id);
        if (sink !== undefined) sink.deliver(JSON.stringify(msg));
      },
      rttMs: () => 0,
    };
  }

  /** The host's own loopback sink (local BankGame). */
  attachLocal(id: PlayerId, sink: GuestSink): void {
    this.sinks.set(id, sink);
  }

  /** A guest DataChannel just opened. */
  attachGuest(id: PlayerId, sink: GuestSink): void {
    this.sinks.set(id, sink);
  }

  detach(id: PlayerId): void {
    this.sinks.delete(id);
    if (this.room !== null) this.room.removePlayer(id, true);
  }

  /** One C2S frame from ANY session (local loopback or guest DC). */
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
        this.code = this.mintCode();
        // The UI-facing code is ours (the join target over the DC).
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

  private mintCode(): string {
    let out = '';
    for (let i = 0; i < 6; i++) out += CLAIM_ALPHABET[Math.floor(rng(Date.now() ^ (i * 104729))() * CLAIM_ALPHABET.length)];
    return out;
  }
}

// ---- sockets ---------------------------------------------------------------

/** Loopback: local BankGame frames go straight into the lobby, replies come back. */
function loopbackSocket(lobby: BankP2pLobby, selfId: PlayerId): WsLike {
  let sink: GuestSink | null = null;
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
  sink = {
    deliver: (data) => sock.onmessage?.({ data }),
  };
  lobby.attachLocal(selfId, sink);
  setTimeout(() => sock.onmessage?.({ data: JSON.stringify({ t: 'welcome', playerId: selfId }) }), 0);
  return sock;
}

/** Guest: BankGame frames ride the DataChannel to the host. */
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
  // Synthetic welcome (deferred: BankGame assigns handlers in its ctor).
  // Over P2P the session id is the rendezvous ws id.
  setTimeout(() => sock.onmessage?.({ data: JSON.stringify({ t: 'welcome', playerId: selfId }) }), 0);
  return sock;
}

// ---- rendezvous + role wiring -----------------------------------------------

function el(tag: string, cls: string, text = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

function openWs(): Promise<{ ws: WebSocket; selfId: PlayerId }> {
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

export function startP2p(app: HTMLElement): void {
  const panel = el('div', 'screen menu');
  panel.appendChild(el('h1', 'menu-title', 'BANK·SDK P2P'));
  panel.appendChild(el('p', 'menu-sub', 'host-authoritative — the game runs in a player tab'));
  const status = el('p', 'menu-notice', 'connecting…');
  panel.appendChild(status);
  const hostBtn = el('button', 'btn', 'HOST A GAME');
  const codeInput = document.createElement('input');
  codeInput.className = 'input';
  codeInput.placeholder = 'CODE';
  codeInput.maxLength = 8;
  const joinBtn = el('button', 'btn', 'JOIN WITH CODE');
  panel.appendChild(hostBtn);
  panel.appendChild(codeInput);
  panel.appendChild(joinBtn);
  app.appendChild(panel);

  void (async () => {
    const { ws, selfId } = await openWs();
    const sig: SigChannel = {
      sendSignal: (to, data) => ws.send(JSON.stringify({ t: 'rtc_signal', to, data })),
      onSignal: null,
      onPeers: null,
      close: () => ws.close(),
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (m.t === 'rtc_signal' && typeof m.from === 'string') {
          console.log('[rtc-debug] signal arrived, onSignal set?', sig.onSignal !== null);
          sig.onSignal?.(m.from, m.data);
        }
        else if (m.t === 'rtc_peers' && Array.isArray(m.ids)) sig.onPeers?.(m.ids as PlayerId[]);
        else if (m.t === 'p2p_ready' && typeof m.code === 'string' && typeof m.hostId === 'string') {
          (window as unknown as { __p2pCode?: string }).__p2pCode = m.code;
          (window as unknown as { __p2pHostId?: string }).__p2pHostId = m.hostId;
          hostId.v = m.hostId;
          amHost = selfId === m.hostId;
          // The HOST star exists from this moment — an early guest offer
          // can never hit a null onSignal.
          if (star === null) {
            star = new RtcStar(sig, {
              selfId,
              deps: {
                pc: () => new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }) as unknown as import('@platform/sdk/rtc.js').PcLike,
                desc: (sd, kind) => ({ type: kind, sdp: sd }),
                cand: (c) => c,
              },
            });
          }
          status.textContent = amHost ? `hosting — code ${m.code}` : `paired — dialing host…`;
        }
      } catch {
        // ignore malformed rendezvous frames
      }
    };
    status.textContent = `connected (${selfId.slice(0, 4)}) — host or join?`;

    let role: 'host' | 'guest' | null = null;
    let amHost = false;
    let star: RtcStar | null = null;
    const hostId: { v: PlayerId | null } = { v: null };
    const guestNames = new Map<PlayerId, string>();

    function mountHostGame(selfId2: PlayerId, lobby: BankP2pLobby): void {
      const sock = loopbackSocket(lobby, selfId2);
      panel.remove();
      // The host's BankGame creates its local room; ITS code is what
      // guests type into their in-game join box (over the DataChannel).
      void new BankGame(app, { socket: sock });
    }

    function mountGuestGame(selfId2: PlayerId, host: PlayerId): void {
      if (star === null) return;
      const sock = dcSocket(star, host, selfId2);
      panel.remove();
      void new BankGame(app, { socket: sock });
    }

    hostBtn.addEventListener('click', () => {
      if (role !== null) return;
      role = 'host';
      lobby = new BankP2pLobby(); // role snapshots AFTER the click, not at boot
      ws.send(JSON.stringify({ t: 'create_private', name: `host-${selfId.slice(0, 4)}`, game: 'bank-sdk', settings: { p2p: true } }));
      status.textContent = 'hosting — waiting for a peer…';
    });

    joinBtn.addEventListener('click', () => {
      if (role !== null) return;
      const code = codeInput.value.trim().toUpperCase();
      if (code.length < 4) {
        status.textContent = 'enter the host code first';
        return;
      }
      role = 'guest';
      ws.send(JSON.stringify({ t: 'join_private', name: `guest-${selfId.slice(0, 4)}`, code }));
      status.textContent = 'joining…';
    });

    sig.onPeers = (ids) => {
      if (role === null || star === null) return;
      if (amHost) {
        if (ids.length >= 2) status.textContent = 'peer found — opening channel…';
        return; // host accepts inbound offers; nothing to dial
      }
      const target = hostId.v;
      if (target !== null && !star.established().includes(target)) {
        star.dial(target); // dial is idempotent while negotiating
      }
    };

    // Wire DC-open → game mount for BOTH roles.
    const origOnSignal = sig.onSignal;
    void origOnSignal;
    // Poll-free mount: RtcStar has no onOpen hook yet, so bridge via links().
    let lobby: BankP2pLobby | null = null; // created when the HOST button is clicked (role is null at boot)
    const attached = new Set<PlayerId>();
    const mountCheck = setInterval(() => {
      const starLive = star;
      if (starLive === null || role === null) return;
      if (!amHost && hostId.v !== null && !starLive.established().includes(hostId.v)) {
        starLive.dial(hostId.v); // idempotent; covers lost rtc_peers races
      }
      // HOST: attach every established guest — sink wraps frames back over
      // the DC; inbound frames unwrap {frame} into lobby.handleFrame.
      const hostLobby = lobby;
      if (role === 'host' && hostLobby !== null) {
        for (const pid of starLive.established()) {
          if (attached.has(pid)) continue;
          attached.add(pid);
          const link = starLive.link(pid);
          if (link === null) continue;
          hostLobby.attachGuest(pid, {
            deliver: (data) => starLive.send(pid, { frame: data }),
          });
          link.onMessage = (d) => {
            const m = d as Record<string, unknown>;
            if (typeof m.frame === 'string') hostLobby.handleFrame(pid, m.frame);
          };
          link.onClose = () => hostLobby.detach(pid);
        }
      }
      const others = starLive.established();
      if (others.length === 0) return;
      clearInterval(mountCheck);
      if (role === 'host') {
        if (lobby !== null) mountHostGame(selfId, lobby);
      } else {
        const host = others[0];
        if (host !== undefined) mountGuestGame(selfId, host);
      }
    }, 100);
  })().catch((err) => {
    status.textContent = `p2p failed: ${err instanceof Error ? err.message : String(err)}`;
  });
}
