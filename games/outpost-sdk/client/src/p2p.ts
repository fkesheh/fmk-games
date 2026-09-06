// ============================================================================
// OUTPOST·SDK P2P TRANSPORT (docs/PLATFORM.md §12.6) — the canonical SDK
// connection: the game's OWN menu and join flow, with the authoritative run
// simming in the host player's tab. The server's role shrinks to rendezvous:
// a shell room (presence + code) and the rtc_signal hop.
//
// ONE CODE. The shell room's code IS the game code — the transport
// intercepts the game's own lobby verbs:
//
//   create_private/create_public/quick_join (host): ensure shell → local
//     OutpostRoom adopts the shell code → frames loopback.
//   join_private/quick_join (guest): save the frame → ensure shell by that
//     code → dial the announced host → DC open → replay the frame to the
//     host's mini-lobby. The menu just sees "joining…" a moment longer.
//
// Differences from kart: OutpostGame/Net expose NO socket-injection seam
// (KartApp/BankGame take `{socket}`; Net news up its own `WebSocket` to
// same-origin /ws and game.ts/net.ts are frozen) — so this transport ships a
// same-origin WebSocket shim instead: `new WebSocket(<same-origin>/ws)`
// returns a fake socket routed to the local HostedLobby (host) or the host's
// DataChannel (guest), and the standard boot in main.ts runs unmodified on
// top of it. The rendezvous signalling socket is the REAL WebSocket,
// captured before the shim is installed.
//
// snapshotTag/joinTag are the room's own wire tags: every per-tick broadcast
// is `{t:'snapshot', …}` and the join receipt is `{t:'joined', …}`
// (games/outpost/shared/src/types.ts S2C) — HostedLobby rewrites the shell
// code into both and replays the last snapshot on attach.
//
// Relative imports (not the repo's usual bare specifiers) are deliberate:
// this client's vite.config/tsconfig map only @outpost/shared + @fps/shared,
// and those config files are outside this task's scope — relative paths are
// the only resolution that works for tsc AND the vite build untouched.
// ============================================================================
import { loadIdentity, type PlayerId } from '@platform/shared';
import { OutpostRoom } from '../../../outpost/server/src/room.js';
import { HostedLobby } from '../../../../platform/sdk/src/hosted.js';
import { Profiles } from '../../../../platform/sdk/src/profile.js';
import { RtcStar, type PcLike, type SigChannel } from '../../../../platform/sdk/src/rtc.js';
import { reportStats } from '../../../../platform/sdk/src/stats.js';

/** Registry id of this port — stamped on shell-bound lobby verbs. */
const PORT_GAME_ID = 'outpost-sdk';

// ---- game-socket shim ---------------------------------------------------------
//
// Speaks the exact surface Net uses (net.ts connect/send/teardownSocket):
// construction by URL, readyState, send/close, onopen/onmessage/onerror/
// onclose props, and the OPEN/CONNECTING/CLOSING/CLOSED statics.

interface ShimEvents {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: (() => void) | null;
}

function parseFrame(data: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(data);
    if (typeof v === 'object' && v !== null) return v as Record<string, unknown>;
  } catch {
    // malformed frame: drop
  }
  return null;
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

  const RealWebSocket: typeof WebSocket = window.WebSocket;
  const realUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const rendezvous = new RealWebSocket(realUrl);
  const selfId: PlayerId = await new Promise((resolve, reject) => {
    rendezvous.onmessage = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(ev.data as string) as Record<string, unknown>;
        if (m.t === 'welcome' && typeof m.playerId === 'string') resolve(m.playerId);
      } catch {
        reject(new Error('bad welcome'));
      }
    };
    rendezvous.onerror = () => reject(new Error('ws failed'));
  });
  if (authFrame !== null) rendezvous.send(authFrame);

  const sig: SigChannel = {
    sendSignal: (to, data) => rendezvous.send(JSON.stringify({ t: 'rtc_signal', to, data })),
    onSignal: null,
    onPeers: null,
    close: () => rendezvous.close(),
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
  let lastRunEndKey: string | null = null;
  // Guests currently attached to the host lobby (host-side only) — the fast
  // guest-loss path ghosts any seat the shell's peer list no longer names.
  const attachedGuests = new Set<PlayerId>();
  // Every live shim socket; only the newest receives deliveries (Net tears
  // the previous one down on every connect()).
  let liveSock: ShimEvents | null = null;

  function ensureStar(): void {
    if (star !== null) return;
    star = new RtcStar(sig, {
      selfId,
      deps: {
        pc: () => new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }) as unknown as PcLike,
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
  // reports its own end-of-run counter. One POST per (room, wave) — keyed off
  // the run_end event (outpost is co-op: no wins, waves reached instead).
  function watchStats(json: string): void {
    if (authToken === null) return;
    const m = parseFrame(json);
    if (m === null || m.t !== 'event') return;
    const ev = m.ev;
    if (typeof ev !== 'object' || ev === null) return;
    const e = ev as Record<string, unknown>;
    if (e.t !== 'run_end' || typeof e.wave !== 'number') {
      return;
    }
    const code = typeof m.code === 'string' ? m.code : '';
    const key = `${code}:${e.wave}`;
    if (key === lastRunEndKey) return;
    lastRunEndKey = key;
    void reportStats(PORT_GAME_ID, { 'outpost.matches': 1, 'outpost.waves': e.wave }, { getToken: () => authToken });
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
      attachLoopback();
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
    // The room's own defaults apply: deps undefined (self-seeded clock/rng),
    // settings straight from the create frame ({debug:true} on private rooms
    // — Net stamps it, the room gates its DebugMsg wire on it).
    return new HostedLobby({
      createRoom: (io, settings) => new OutpostRoom('private', io, undefined, settings),
      newRoomCode: () => shell.code ?? 'LOCAL',
      snapshotTag: 'snapshot',
      joinTag: 'joined',
    });
  }

  /** Bridge the host tab's own game socket to its local lobby. */
  function attachLoopback(): void {
    if (lobby === null) return;
    const self = selfId;
    lobby.attach(self, {
      deliver: (data) => {
        watchStats(data);
        if (liveSock !== null) liveSock.onmessage?.({ data });
      },
    });
  }

  function attachGuest(pid: PlayerId): void {
    if (lobby === null || lobby.has(pid)) return;
    const link = star?.link(pid);
    if (link === null || link === undefined) return;
    lobby.attach(pid, { deliver: (data) => star?.send(pid, { frame: data }) });
    attachedGuests.add(pid);
    lobby.sync(pid);
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

  sig.onPeers = (ids) => {
    lastPeers = [...ids];
    if (lobby !== null && selfId === shell.hostId) {
      // Fast guest-loss path: a closed tab's ws dies in ~1s (ICE takes
      // 10-30s). Ghost any attached seat the room no longer lists.
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
  };

  const boot = document.createElement('div');
  boot.style.cssText = 'position:fixed;left:0;right:0;bottom:10vh;text-align:center;font:14px system-ui;color:#9aa3ad;z-index:40;pointer-events:none';
  document.body.appendChild(boot);
  const say = (t: string): void => {
    boot.textContent = t;
  };

  /** One intercepted game frame from the local Net instance. */
  function gameFrame(data: string): void {
    const m = parseFrame(data);
    if (m === null) return;
    if (m.t === 'create_private' || m.t === 'create_public') {
      hostStart = data;
      myJoinFrame = data;
      const settings = typeof m.settings === 'object' && m.settings !== null ? (m.settings as Record<string, unknown>) : {};
      rendezvous.send(JSON.stringify({ t: m.t, name: displayName, game: PORT_GAME_ID, settings: { p2p: true, ...settings } }));
      say('opening a peer-to-peer room…');
      return;
    }
    if (m.t === 'join_private') {
      myJoinFrame = data;
      guestQueue.push(data);
      rendezvous.send(JSON.stringify({ t: 'join_private', name: displayName, code: String(m.code ?? '') }));
      say('connecting to the host…');
      return;
    }
    if (m.t === 'quick_join') {
      // Public matchmaking: the shell may make us host (first member) or
      // guest — save the frame EITHER WAY for the local replay / DC redial.
      hostStart = data;
      myJoinFrame = data;
      guestQueue.push(data);
      rendezvous.send(JSON.stringify({ t: 'quick_join', name: displayName, game: PORT_GAME_ID }));
      say('finding a peer-to-peer table…');
      return;
    }
    if (m.t === 'ping') {
      liveSock?.onmessage?.({ data: JSON.stringify({ t: 'pong', ts: m.ts, serverTime: Date.now() }) });
      return;
    }
    if (m.t === 'list_rooms') {
      rendezvous.send(JSON.stringify({ t: 'list_rooms' }));
      return;
    }
    // Room-level frames (input/reload/switch/buy_*/start/debug/leave):
    // route by transport state.
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

  rendezvous.onmessage = (ev: MessageEvent) => {
    try {
      const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (m.t === 'rtc_signal' && typeof m.from === 'string') sig.onSignal?.(m.from, m.data);
      else if (m.t === 'rtc_peers' && Array.isArray(m.ids)) sig.onPeers?.(m.ids as PlayerId[]);
      else if (m.t === 'room_list' && Array.isArray(m.rooms)) {
        liveSock?.onmessage?.({ data: JSON.stringify({ t: 'room_list', rooms: m.rooms }) });
      } else if (m.t === 'p2p_ready' && typeof m.code === 'string' && typeof m.hostId === 'string') {
        shell.code = m.code;
        shell.hostId = m.hostId;
        shell.ready = true;
      }
    } catch {
      // malformed rendezvous frame: drop
    }
  };

  // ---- the shim ---------------------------------------------------------------
  // Net news up `new WebSocket(<same-origin>/ws)` per connect(). Every such
  // socket is a peer of THIS transport: it opens on the next macrotask (so
  // Net's CONNECTING-queue flushes through onopen, exactly like a real
  // dial), receives the provisional welcome + empty room list, and routes
  // send() through gameFrame above.

  class GameWs implements ShimEvents {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState: number = GameWs.CONNECTING;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      liveSock = this;
      setTimeout(() => {
        if (liveSock !== this || this.readyState !== GameWs.CONNECTING) return;
        this.readyState = GameWs.OPEN;
        this.onopen?.();
        this.onmessage?.({ data: JSON.stringify({ t: 'welcome', playerId: selfId }) });
        this.onmessage?.({ data: JSON.stringify({ t: 'room_list', rooms: [] }) });
      }, 0);
    }
    send(data: string): void {
      if (this.readyState !== GameWs.OPEN) return;
      gameFrame(String(data));
    }
    close(): void {
      if (this.readyState === GameWs.CLOSED) return;
      this.readyState = GameWs.CLOSED;
      if (liveSock === this) liveSock = null;
      this.onclose?.();
    }
  }

  window.WebSocket = GameWs as unknown as typeof WebSocket;

  const pump = setInterval(() => {
    if (!shell.ready) return;
    ensureStar();
    const isHost = selfId === shell.hostId;
    if (isHost && hostStart !== null && !hostMounted) {
      if (lobby === null) {
        lobby = makeLobby();
        attachLoopback();
        const src = parseFrame(hostStart) ?? { t: 'create_private' };
        const framed = JSON.stringify({ ...(src as Record<string, unknown>), shellCode: shell.code });
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
              liveSock?.onmessage?.({ data: m.frame });
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
    if (isHost) {
      for (const pid of star?.established() ?? []) attachGuest(pid);
    }
  }, 100);

  (window as unknown as { __p2pDbg?: () => unknown }).__p2pDbg = () => ({
    ready: shell.ready,
    hostId: shell.hostId,
    selfId,
    lastPeers,
    lobbyFrames: lobby?.debugFrames ?? null,
    lobbyRoom: lobby?.debugRoom() ?? null,
  });

  // Boot the STANDARD shell on top of the shim — menus, HUD, rAF, the frozen
  // window.__outpost surface. From here on Net's /ws sockets are GameWs peers.
  const { bootOnline } = await import('./main.js');
  bootOnline();
  void pump;
}
