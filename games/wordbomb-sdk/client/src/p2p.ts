// ============================================================================
// WORDBOMB·SDK P2P TRANSPORT (docs/PLATFORM.md §12.6) — the canonical SDK
// connection: the game's OWN menu and join flow, with the authoritative
// match running in the host player's tab. The server's role shrinks to
// rendezvous: a room (presence + code) and the rtc_signal hop.
//
// ONE CODE. The room's code IS the game code — the transport intercepts the
// game's own lobby verbs:
//
//   create_private/create_public (host): seat in a server room, sniff its
//     code out of the server snapshot, run the local WordbombRoom under that
//     same code → frames flow loopback.
//   join_private/quick_join/join_public (guest): seat in the same server
//     room, sniff the creator's seat as the host, dial it → DC open → replay
//     the frame to the host's mini-lobby. The menu just sees "joining…" a
//     moment longer.
//
// Line-by-line template: games/bank-sdk/client/src/p2p.ts. Deviations:
//
//   1. RENDEZVOUS VEHICLE. Bank shells on p2pShellRoom (server emits
//      p2p_ready with an authoritative hostId). wordbombSdkModule has no
//      p2pShell flag and module.ts is frozen for this task, so the transport
//      rendezvous on a REAL (but forever-idle) server room instead: gameplay
//      frames are never sent there, wb_start is never forwarded, and the
//      match never starts server-side — the room sits in `lobby` as presence
//      + code + rtc relay only. p2p_ready is therefore SYNTHESIZED locally:
//      the host knows itself (it sent create_*), guests read the creator's
//      seat (players[0], insertion order = join order) out of the sniffed
//      server wb_public. Role comes from the VERB the game sent, never from
//      comparing session ids, so no election churn on lower-id joins.
//   2. SETTINGS. Bank reads BankSettings field-by-field; wordbomb reuses the
//      frozen parseWordbombSettings() (throws on bad input → DEFAULT_SETTINGS).
//   3. SNAPSHOT TAG is 'wb_public' (room.ts publicState). There is NO joinTag:
//      wordbomb has no join-receipt message (unlike kart's kart_joined) — the
//      code rides ON the snapshot itself, so the HostedLobby code-rewrite on
//      the snapshot tag covers the invite chip. wb_private is DELIBERATELY
//      never the snapshot tag: it is per-recipient (you/yourWord) and caching
//      + sync-replaying it to another seat would leak a word across seats (I1).
//   4. SOCKET SEAM. BankGame/KartApp take a WsLike override; WordbombGame has
//      no such seam and game.ts is frozen for this task, so startP2p installs
//      a minimal global WebSocket shim whose instances ARE the game socket
//      (same object the transport delivers into). ?online=1 skips this file
//      entirely (legacy path, real WebSocket).
//   5. HOST DATA. WordbombRoom needs RoomDeps (dict + picker + rand). The
//      server dictionary (node blob, ~5 MB) cannot load in a tab, so the host
//      tab runs a compact embedded pilot bundle below (339 common words, 78
//      frequency-derived fragments, pools sized past ROUNDS_MAX so no match
//      repeats a fragment). Full-dictionary bundling is deliberately left out.
//   6. IMPORTS are relative (../../../wordbomb/server, ../../../../platform/sdk)
//      instead of @wordbomb/server / @platform/sdk aliases: the sdk client's
//      vite/tsconfig alias set is frozen for this task, and relative imports
//      resolve to the identical modules.
//   7. STATS go through the shared reportStats() helper (kart precedent) on
//      the unwrapped wb_match_end event — never hand-rolled fetch.
//   8. Bank's loopbackSocket/dcSocket helpers and electTimer are dead code in
//      the template (the pump speaks to the lobby/star directly); not copied.
//   9. Server 'error' frames (e.g. no_room on a mistyped code) are forwarded
//      to the game so the menu can say so; bank drops them (hangs on "…").
//  10. Explicit leave is forwarded to the server too (frees the ghost seat and
//      keeps rtc_peers truthful for elections); bank only ghosts locally.
//      A fresh create_* resets the local lobby so leave → create starts a new
//      table under the new code (bank reuses the stale lobby).
//  11. Public rooms have no code (code null): a row-click join replays
//      quick_join (not join_private) to the host lobby once the DC opens.
// ============================================================================
import { WordbombRoom } from '../../../wordbomb/server/src/room.js';
import type { RoomDeps } from '../../../wordbomb/server/src/ports.js';
import { DEFAULT_SETTINGS, parseWordbombSettings } from '@wordbomb/shared';
import type { WbDifficulty, WordbombSettings } from '@wordbomb/shared';
import { loadIdentity, rng, type PlayerId } from '@platform/shared';
import { HostedLobby, mintRoomCode } from '../../../../platform/sdk/src/hosted.js';
import { Profiles } from '../../../../platform/sdk/src/profile.js';
import { RtcStar, type PcLike, type SigChannel } from '../../../../platform/sdk/src/rtc.js';
import { reportStats } from '../../../../platform/sdk/src/stats.js';
import { boot } from './game.js';

/** Structural WebSocket stand-in (mirrors BankGame's WsLike): the game talks
 *  to this; the far end is the host tab's mini-lobby. */
// (WordbombGame has no exported seam, so the transport defines the shape and
// hands the SAME object to the game via the WebSocket shim below.)
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror?: ((ev?: unknown) => void) | null;
}

function resolveSettings(raw: Record<string, unknown> | undefined): WordbombSettings {
  try {
    return parseWordbombSettings(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ---- pilot host data (deviation 5) -------------------------------------------
//
// The host tab authors fragments and validates words, so it needs a Dict and
// a FragmentPicker satisfying ports.ts RoomDeps. Compact by design: every
// pool fragment is guaranteed 2+ holder words in WORDS (checked at author
// time), every pool is sized past ROUNDS_MAX, and the picker never throws and
// never repeats within a match while the pool allows it.

const PILOT_WORDS: readonly string[] = ['above','after','again','agent','ahead','alive','allow','anger','angle','apart','apple','arena','around','arrow','artist','aside','atlas','attend','award','aware','ballet','balloon','basket','beard','beast','being','believe','below','blast','blend','bless','block','board','border','borrow','bound','brave','bread','break','bride','bright','bring','cable','catch','cater','cease','chain','chair','chalk','champion','change','chant','chart','cheap','cherry','chess','chest','chicken','chill','class','clean','clear','clever','client','clock','clown','coast','comfort','copper','count','cover','crack','craft','crane','crash','crate','craven','cream','create','credit','creek','crest','cricket','current','curtain','danger','dapple','daring','debate','decide','declare','decorate','defend','delight','deliver','dense','derive','direct','discover','distant','elder','elect','elegant','embrace','emerge','enable','enchant','endure','enlarge','enter','entire','entry','envelope','error','essay','estate','esteem','eternal','evening','event','every','example','excess','exchange','exist','expect','expert','explain','express','extend','extra','fable','facing','faint','farmer','fasten','father','feast','fever','fiction','fight','flash','flock','flower','forge','forget','formal','format','former','fortune','forward','founder','fresh','friend','fright','fringe','garden','gather','giant','ginger','glare','glass','gleam','glide','glimmer','glove','golden','govern','grace','grade','grain','grand','grant','grape','gravel','great','grill','grind','grove','guard','guess','guest','guide','hammer','hamster','harden','harvest','haven','health','heard','hearth','hearty','heaven','height','hello','herald','herb','herd','hidden','hollow','horror','hound','humble','ideal','import','increase','index','infect','inherit','insect','inside','insight','inspire','install','instant','instead','intense','interest','interior','jacket','kettle','kitchen','ladder','large','laser','lasting','learn','least','leather','leave','level','listen','lively','locket','lounge','lovely','mango','market','marvel','master','match','mellow','mercy','merge','merit','mirror','modern','motive','naive','narrow','nation','north','notch','onion','opera','opinion','option','orange','paint','palace','paper','parade','parcel','pardon','parent','parish','party','pasta','patch','peaceful','people','pepper','perfect','peril','period','place','plain','planet','plank','plant','pleasant','please','pocket','point','ponder','praise','prance','prepare','present','price','pride','priest','prince','print','prize','prudent','racer','raise','rally','ranch','raven','recall','render','renew','repeat','report','rescue','resist','resort','retreat','rocket','satchel','serene','shallow','sister','skill','slender','spill','stable','still','straight','strain','strange','stream','street','stretch','stride','strike','string','stripe','strive','surrender','tender','theater','trace','track','trail','trial','trillion'];

const PILOT_POOLS: Record<WbDifficulty, readonly string[]> = {
  easy: ['ter','ent','der','rea','ing','sta','ste','igh','ast','ble','ght','res','ver','ant','est','ove','ard','ate','end','ide','per','ain','ion','nge','ple','str'],
  normal: ['tri','tra','cha','eas','gra','her','ket','nde','par','ran','all','ear','eat','ect','eve','for','mer','pri','rin','vel','ang','are','cre','hea','int','ist'],
  hard: ['ive','low','pla','rge','tch','ten','ven','ace','art','ave','cke','cra','den','eri','ess','ill','ins','las','lea','llo','ock','ort','oun','rai','ren','rro'],
};

/** Last-resort fragment: reachable only if a const pool were empty (it never
 *  is) — the picker must not throw (I6 sits behind this call). */
const FALLBACK_FRAGMENT = 'art';

const PILOT_SET: ReadonlySet<string> = new Set(PILOT_WORDS);

const pilotDict = {
  has(word: string): boolean {
    return PILOT_SET.has(word);
  },
  size: PILOT_SET.size,
};

const pilotPicker = {
  pick(difficulty: WbDifficulty, used: ReadonlySet<string>, rand: () => number): string {
    const pool = PILOT_POOLS[difficulty] ?? PILOT_POOLS.normal;
    const fresh: string[] = [];
    for (const f of pool) {
      if (!used.has(f)) fresh.push(f);
    }
    const src = fresh.length > 0 ? fresh : [...pool];
    const at = Math.floor(rand() * src.length);
    const frag = at >= 0 && at < src.length ? src[at] : undefined;
    if (frag !== undefined) return frag;
    const first = pool[0];
    return first ?? FALLBACK_FRAGMENT;
  },
  poolSize(difficulty: WbDifficulty): number {
    return (PILOT_POOLS[difficulty] ?? PILOT_POOLS.normal).length;
  },
};

/** Frozen at import: one fuse stream per tab (same role as the server's
 *  module-scope rand). Tabs never share draws, so same-ms tabs cannot burn
 *  identical fuse sequences. */
const browserDeps: RoomDeps = {
  dict: pilotDict,
  picker: pilotPicker,
  rand: rng(Date.now()),
};

// ---- sockets -----------------------------------------------------------------

/**
 * Deviation 4: WordbombGame builds its own `new WebSocket(url)`, so the
 * transport swaps the global constructor for one deploy per page load. Every
 * instance IS the game socket (constructor returns it), which is exactly the
 * object the transport delivers frames into — so the game's onmessage
 * assignment and the transport's delivery can never diverge onto two objects.
 * ?online=1 never imports this module, so the legacy path keeps the real one.
 */
function installSocketShim(gameSocket: WsLike): void {
  class Shim {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    constructor() {
      return gameSocket;
    }
  }
  globalThis.WebSocket = Shim as unknown as typeof WebSocket;
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
  // snapshots, so each reports its OWN end-of-match counters via the shared
  // helper. One POST set per match — keyed off wb_match_end, reset whenever a
  // non-matchEnd snapshot passes (a lobby always intervenes between matches).
  let lastMatchKey: string | null = null;
  function watchStats(json: string): void {
    if (authToken === null) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    // The room wraps game events as {t:'event', ev} (platform convention).
    if (m.t === 'event' && typeof m.ev === 'object' && m.ev !== null) {
      m = m.ev as Record<string, unknown>;
    }
    if (m.t === 'wb_public') {
      if (m.phase !== 'matchEnd') lastMatchKey = null;
      return;
    }
    if (m.t !== 'wb_match_end') return;
    const winnerId = typeof m.winnerId === 'string' ? m.winnerId : null;
    const standings = Array.isArray(m.standings) ? (m.standings as Array<Record<string, unknown>>) : [];
    const key = `${winnerId ?? ''}|${standings.map((s) => `${String(s.playerId)}:${String(s.score)}`).join(',')}`;
    if (key === lastMatchKey) return;
    lastMatchKey = key;
    const mine = standings.find((s) => s.playerId === selfId);
    const score = mine !== undefined && typeof mine.score === 'number' ? Math.trunc(mine.score) : 0;
    const delta: Record<string, number> = { 'wordbomb.matches': 1 };
    if (winnerId === selfId) delta['wordbomb.wins'] = 1;
    delta['wordbomb.score'] = score;
    void reportStats('wordbomb-sdk', delta, { getToken: () => authToken });
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
      // p2p_ready never arrives here (no p2pShell rooms for wordbomb-sdk):
      // readiness is synthesized in sniffPublic below (deviation 1).
      else if (m.t === 'room_list' && Array.isArray(m.rooms)) {
        gameSocket.onmessage?.({ data: JSON.stringify({ t: 'room_list', rooms: m.rooms }) });
      } else if (m.t === 'error' && typeof m.code === 'string' && typeof m.message === 'string') {
        // Deviation 9: a mistyped code would otherwise hang on "connecting…".
        gameSocket.onmessage?.({ data: JSON.stringify({ t: 'error', code: m.code, message: m.message }) });
      } else if (m.t === 'wb_public') {
        sniffPublic(m);
      }
      // Everything else from the ghost room (wb_private, events, errors
      // already handled): drop. The local lobby is the game's truth.
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
  let lobby: HostedLobby | null = null; // host-side only
  let hostStart: string | null = null; // the host's own create frame
  let createdRoom = false; // the game sent create_* (I rendezvous as the host)
  let typedCode: string | null = null; // join_private code the game typed
  const guestQueue: string[] = []; // guest frames saved while dialing
  let pendingJoinPublic: string | null = null; // shell roomId awaiting table-click join

  /**
   * Deviation 1 (readiness): fold one server wb_public into the shell state.
   * The server room is rendezvous only — its snapshots must NEVER reach the
   * game — but they carry the two facts the template reads from p2p_ready:
   * the joinable code and the host seat (players[0]: the server preserves
   * insertion order, so the creator stays first, ghosts included).
   */
  function sniffPublic(m: Record<string, unknown>): void {
    if (m.phase !== 'matchEnd') lastMatchKey = null; // ghost room idles in lobby; keep stats key fresh
    // Rendezvous is one-shot: after ready, elections own shell.hostId — a
    // later ghost-room snapshot must never drag it back to a dead creator.
    if (shell.ready) return;
    const code = typeof m.code === 'string' ? m.code : null;
    const players = Array.isArray(m.players) ? (m.players as Array<Record<string, unknown>>) : [];
    const selfSeated = players.some((p) => p.id === selfId);
    if (!selfSeated) return;
    const first = players[0];
    const creatorId = first !== undefined && typeof first.id === 'string' ? first.id : null;
    if (creatorId === null) return;
    if (createdRoom) {
      // I opened this room: I host as soon as its code is known. Public
      // rooms carry no code — mint the local one (row-click guests join by
      // quick_join replay, which needs no code at all).
      if (shell.code === null) shell.code = code ?? mintRoomCode();
      shell.hostId = selfId;
      shell.ready = true;
      return;
    }
    if (shell.code === null) shell.code = typedCode ?? code;
    shell.hostId = creatorId;
    if (shell.code !== null || pendingJoinPublic !== null) shell.ready = true;
    else if (myJoinFrame !== null) shell.ready = true; // quick_join: code optional (replay needs none)
  }

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
  const bootEl = document.createElement('div');
  bootEl.style.cssText = 'position:fixed;left:0;right:0;bottom:10vh;text-align:center;font:14px system-ui;color:#9aa3ad;z-index:40;pointer-events:none';
  document.body.appendChild(bootEl); // NOT app: game re-renders would wipe it
  let promotedNotice = false;
  const say = (t: string): void => {
    if (promotedNotice && t === '') return; // promotion banner sticks
    bootEl.textContent = t;
  };

  /** Fresh local room under the shell code (or a mint when codeless). */
  function mountHost(createFrame: string | null): void {
    if (lobby === null) {
      lobby = new HostedLobby({
        createRoom: (io, settings) => new WordbombRoom('private', io, resolveSettings(settings), browserDeps),
        newRoomCode: () => shell.code ?? mintRoomCode(),
        snapshotTag: 'wb_public',
      });
      // Bridge the host's own game to its local lobby: without this attach
      // the room's broadcasts (wb_public, events) reach no sink.
      lobby.attach(selfId, {
        deliver: (data) => {
          watchStats(data);
          gameSocket.onmessage?.({ data });
        },
      });
      let framed: string;
      if (createFrame !== null) {
        const src = JSON.parse(createFrame) as Record<string, unknown>;
        delete src.p2pHint;
        framed = JSON.stringify({ ...src, shellCode: shell.code });
      } else {
        framed = JSON.stringify({ t: 'create_private', name: displayName, settings: {}, shellCode: shell.code });
      }
      lobby.handleFrame(selfId, framed); // local WordbombRoom adopts the shell code
      say('');
    }
    hostMounted = true;
  }

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
        // HOST: claim a room whose code the game will show, then run the
        // local lobby. Fresh local room per explicit create (deviation 10):
        // leave → create starts a new table under the new code.
        lobby = null;
        hostMounted = false;
        shell.code = null;
        shell.hostId = selfId;
        shell.ready = false;
        createdRoom = true;
        typedCode = null;
        guestQueue.length = 0;
        pendingJoinPublic = null;
        hostStart = data;
        myJoinFrame = data;
        ws.send(JSON.stringify({ t: m.t, name: displayName, game: 'wordbomb-sdk', settings: { p2p: true, ...(typeof m.settings === 'object' && m.settings !== null ? m.settings : {}) } }));
        say('opening a peer-to-peer room…');
        return;
      }
      if (m.t === 'join_private') {
        createdRoom = false;
        shell.code = null;
        shell.hostId = null;
        shell.ready = false;
        typedCode = typeof m.code === 'string' ? m.code : null;
        if (typedCode !== null) shell.code = typedCode;
        myJoinFrame = data;
        guestQueue.push(data);
        ws.send(JSON.stringify({ t: 'join_private', name: displayName, code: String(m.code ?? '') }));
        say('connecting to the host…');
        return;
      }
      if (m.t === 'quick_join') {
        // Public matchmaking: the server's quick_join lands us in a real
        // room (or mints one — its first seat hosts). Save the frame EITHER
        // WAY: it may need local replay if we are the host.
        createdRoom = false;
        shell.code = null;
        shell.hostId = null;
        shell.ready = false;
        typedCode = null;
        hostStart = data;
        myJoinFrame = data;
        guestQueue.push(data);
        ws.send(JSON.stringify({ t: 'quick_join', name: displayName, game: 'wordbomb-sdk' }));
        say('finding a peer-to-peer table…');
        return;
      }
      if (m.t === 'ping') {
        gameSocket.onmessage?.({ data: JSON.stringify({ t: 'pong', ts: m.ts, serverTime: Date.now() }) });
        return;
      }
      if (m.t === 'list_rooms') {
        // TABLES list: the rendezvous server knows the rooms.
        ws.send(JSON.stringify({ t: 'list_rooms' }));
        return;
      }
      if (m.t === 'join_public') {
        // Row click: join the room for presence, then reach the host lobby
        // over the DC (code-join, or quick_join replay when codeless).
        createdRoom = false;
        shell.code = null;
        shell.hostId = null;
        shell.ready = false;
        typedCode = null;
        pendingJoinPublic = m.roomId !== undefined ? String(m.roomId) : '';
        ws.send(JSON.stringify({ t: 'join_public', name: displayName, roomId: pendingJoinPublic }));
        say('connecting to the host…');
        return;
      }
      if (m.t === 'leave') {
        // Deviation 10: free the server ghost too (presence stays truthful).
        lobby?.handleFrame(selfId, data);
        try {
          ws.send(JSON.stringify({ t: 'leave' }));
        } catch {
          // racing a close — drop the frame
        }
        return;
      }
      // Room-level frames (wb_submit/wb_start): route by transport state.
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
  let lastSnapIds: PlayerId[] = []; // seats in the latest host-lobby snapshot (seated-ack)
  let lastJoinSendAt = 0; // throttle for the seated-ack retry below
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
    lastSnapIds = [];
    rejoinSent = false; // a new host needs a fresh join (its lobby never saw us)
    if (next === selfId) {
      // WE promote: fresh local lobby, SAME shell code, seat ourselves.
      shell.hostId = selfId;
      promotedNotice = true;
      try {
        lobby = new HostedLobby({
          createRoom: (io, settings) => new WordbombRoom('private', io, resolveSettings(settings), browserDeps),
          newRoomCode: () => shell.code ?? mintRoomCode(),
          snapshotTag: 'wb_public',
        });
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
    if (isHost && !hostMounted) {
      // NOTE: the pump keeps running — guests attach whenever their links
      // open, which can be seconds after we mount our own game.
      mountHost(hostStart);
    }
    if (!isHost && shell.hostId !== null) {
      // Seated-ack: a host snapshot seating us proves the join landed.
      const acked = lastSnapIds.includes(selfId);
      const link = star?.link(shell.hostId);
      if (link !== null && link !== undefined) {
        // Route the host's replies into our game socket. Re-wire whenever
        // the link object itself changes (ICE flap → new link object).
        if (!guestWired || wiredLink !== link) {
          guestWired = true;
          wiredLink = link;
          link.onMessage = (d) => {
            const m = d as Record<string, unknown>;
            if (typeof m.frame !== 'string') return;
            watchStats(m.frame);
            gameSocket.onmessage?.({ data: m.frame });
            try {
              const inner = JSON.parse(m.frame) as Record<string, unknown>;
              if (inner.t === 'wb_public' && Array.isArray(inner.players)) {
                const ids: PlayerId[] = [];
                for (const p of inner.players as Array<Record<string, unknown>>) {
                  if (typeof p.id === 'string') ids.push(p.id);
                }
                lastSnapIds = ids;
              }
            } catch {
              // snapshot tracking is best-effort; the frame was still delivered
            }
          };
          link.onClose = () => {
            onHostLinkLost();
          };
        }
        if (guestQueue.length > 0) {
          for (const f of guestQueue.splice(0)) star?.send(shell.hostId, { frame: f });
          lastJoinSendAt = Date.now();
          say('');
        }
        // Seated-ack retry: the first join can race the host's attach (link
        // open here does not mean onMessage is installed there yet), and a
        // one-shot replay loses that race silently. Duplicate joins are
        // idempotent (the same seat is refreshed), so resend — throttled —
        // until a snapshot seats us.
        if (!acked && Date.now() - lastJoinSendAt > 500) {
          lastJoinSendAt = Date.now();
          if (pendingJoinPublic !== null) {
            // Table-click join: codeless rooms replay quick_join (deviation 11).
            const joinFrame =
              shell.code !== null
                ? JSON.stringify({ t: 'join_private', name: displayName, code: shell.code })
                : JSON.stringify({ t: 'quick_join', name: displayName, game: 'wordbomb-sdk' });
            star?.send(shell.hostId, { frame: joinFrame });
          } else if (myJoinFrame !== null) {
            star?.send(shell.hostId, { frame: myJoinFrame });
          }
        }
      }
      if ((star === null || star.link(shell.hostId) === null) && shell.hostId !== null) {
        star?.dial(shell.hostId); // idempotent while negotiating
      }
      if (acked) {
        pendingJoinPublic = null;
        if (!rejoinSent) {
          rejoinSent = true;
          clearReconnect();
          say('');
        }
      }
    }
    if (isHost) for (const pid of star?.established() ?? []) attachGuest(pid);
  }, 100);

  // Hand the transport to the game through the shim: its standard menu is the
  // join screen. welcome: the game gates its menu on a session id (over P2P
  // it is the rendezvous session id).
  installSocketShim(gameSocket);
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
  void pump;
  void say;
  boot(app);
}
