// ============================================================================
// ANCIENTS (rift) GameModule — the plug into the platform registry (the ONLY
// rift-server file shaped by @platform/shared's GameModule). Mirrors
// games/wordbomb/server/src/module.ts: it owns three things and nothing else:
//   1. the clientDist probe (identical in shape to the other games'),
//   2. settings validation, delegated to the frozen parseRiftSettings(),
//   3. the MODULE-SCOPE rand stream handed to every room as deps.rand.
// All match logic lives in room.ts, all sim in sim/, all bot policy in
// bots.ts — this file contains no game logic (CONTRACT §5).
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rng, CLAIM_ALPHABET, PAD } from '@platform/shared';
import type { GameModule, GameRoomHandle, PadLayout, RoomIO } from '@platform/shared';
import { MAX_PLAYERS, MIN_PLAYERS, parseRiftSettings } from '@rift/shared';
import type { RiftRoomCtor } from './ports.js';
import { RiftRoom } from './room.js';

/**
 * Absolute path to the built rift client. Candidates cover the two layouts
 * this module runs in (first existing index.html wins):
 *   1. dev (tsx): here = games/rift/server/src -> games/rift/client/dist
 *   2. bundled (repo root or Docker /app): here = platform/server/dist
 *      (esbuild inlines this module into dist/server.js, so import.meta.url
 *      is the BUNDLE's url)                    -> <root>/games/rift/client/dist
 *   3/4. cwd fallbacks: repo root, and the package dir (npm -w scripts).
 * When nothing is built yet the dev path is returned; the platform entry
 * already falls back to its placeholder text when index.html is absent.
 */
function resolveClientDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../client/dist'),
    path.resolve(here, '../../../games/rift/client/dist'),
    path.resolve(process.cwd(), 'games/rift/client/dist'),
    path.resolve(process.cwd(), '../client/dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  const dev = candidates[0];
  if (dev === undefined) throw new Error('unreachable: empty candidate list');
  return dev;
}

/**
 * One shared rng stream for every room's id/code draws — IDS ONLY.
 *
 * Gameplay never touches this stream: the sim core is fully deterministic
 * (createWorld accepts but does not consume its rand argument) and bot brains
 * are seeded by the room-local hashSeed(roomId, index) FNV-1a helper. The id
 * stream is deliberately module scope rather than a fresh rng(Date.now()) per
 * room: two rooms created inside the same millisecond would otherwise draw
 * identical ids, and one stream cannot collide with itself. `roomSeq` mixes
 * into the seed as belt-and-braces against a rewound clock. Rooms take `rand`
 * as an injected dep (ports.ts RoomDeps) precisely so room.test.ts can
 * substitute a deterministic one.
 */
let roomSeq = 0;
const rand: () => number = rng((Date.now() ^ (roomSeq++ * 0x9e3779b9)) >>> 0);

/**
 * Compile-time proof that room.ts's constructor still matches the frozen
 * seam. If the signature ever drifts from `RiftRoomCtor` this line fails to
 * typecheck here, rather than at the `new` below with a vaguer message.
 */
const Room: RiftRoomCtor = RiftRoom;

export const riftModule: GameModule = {
  id: 'rift',
  name: 'ANCIENTS',
  clientDist: resolveClientDist(),
  // vite dev server (npm run dev -w @rift/client): the platform proxies /rift/
  // here when it answers, so one port serves launcher + HMR client. Must match
  // `server.port` in the client's vite.config.ts.
  devPort: 5177,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  createRoom(opts): GameRoomHandle {
    // parseRiftSettings THROWS Error(message) on bad input; the lobby turns
    // that into { t: 'error', code: 'bad_settings', message }. It also accepts
    // `undefined` and returns a fresh copy of DEFAULT_SETTINGS, so quick-join
    // needs no special case here.
    const settings = parseRiftSettings(opts.settings);
    return new Room(opts.visibility, opts.io, settings, { rand });
  },
};

// ============================================================================
// RIFT VARIANT FACTORY (platform v2) — register ANCIENTS under a SECOND id
// ('ancients') alongside the legacy 'rift' registration, per docs/PLATFORM.md
// §7. Same rooms, same sim, same wire protocol; the variant adds:
//   1. its own id/name/devPort/clientDist (the SDK-built shell client),
//   2. a stats sink: on `rift_end`, per human seat, reportStats credits
//      {'ancients.kill','ancients.death'} + {'ancients.win':1} for winners,
//   3. a PHONE-PAD adapter: bound pad sessions deliver {t:'pad_input'};
//      the wrapper tracks each owner's hero position from outgoing snapshots
//      and translates stick deflection into throttled `rift_order move`
//      world-space orders (click-to-move MOBA), button bits 0/1 into
//      `rift_cast` slots 0/1 at the hero's feet. Zero legacy-room edits.
// ============================================================================

export interface RiftVariantOpts {
  readonly id: string;
  readonly name?: string;
  readonly devPort?: number;
  readonly clientDist?: string;
}

/** Stick must deflect past this to emit an order (deadzone). */
const PAD_STICK_DEADZONE = 0.35;
/** Min interval between synthesized move orders per pad (ms) — ~8 Hz. */
const PAD_ORDER_EVERY_MS = 120;
/** Move-order target distance ahead of the hero (world units). */
const PAD_ORDER_DIST = 6;

/** The virtual controller the ANCIENTS·SDK pad page renders for this game. */
const ANCIENTS_PAD_LAYOUT: PadLayout = {
  sticks: [{ id: 'l', label: 'move' }],
  buttons: [
    { bit: 0, label: 'Q' },
    { bit: 1, label: 'W' },
    { bit: 2, label: 'E' },
  ],
};

interface PadBind {
  readonly owner: string;
  lastOrderMs: number;
  bits: number;
}

const pendingPads = new Map<string, { owner: string; expiresAt: number }>();

/** 6-char unambiguous pairing code (docs/PAD.md token discipline). */
function pairCode(): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += CLAIM_ALPHABET[Math.floor(rng(Date.now() ^ i)() * CLAIM_ALPHABET.length)];
  return out;
}

export function riftModuleVariant(o: RiftVariantOpts): GameModule {
  const base = riftModule;
  /** padSessionId → bind state; bounded by room lifetime + hard cap below. */
  const pads = new Map<string, PadBind>();
  /** playerId → last-seen hero position (from outgoing snapshots). */
  const posOf = new Map<string, { x: number; z: number }>();

  function notePositions(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null || pads.size === 0) return;
    const m = msg as Record<string, unknown>;
    if (m.t !== 'rift_snap') return;
    const ents = m.ents;
    if (!Array.isArray(ents)) return;
    for (const e of ents) {
      if (typeof e !== 'object' || e === null) continue;
      const ent = e as Record<string, unknown>;
      if (typeof ent.pid !== 'string' || typeof ent.x !== 'number' || typeof ent.z !== 'number') continue;
      posOf.set(ent.pid, { x: ent.x, z: ent.z });
    }
    if (posOf.size > 1024) posOf.clear(); // bound: stale seats fall out on next snap
  }

  function wrapIo(io: RoomIO): RoomIO {
    const wrapped: RoomIO = {
      send: (id, msg) => {
        notePositions(msg);
        // Stats sink (v2): credit humans when a match ends.
        if (
          typeof io.reportStats === 'function' && typeof io.profileId === 'function' &&
          typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).t === 'rift_end'
        ) {
          const end = msg as unknown as { winner?: unknown; stats?: unknown };
          if (Array.isArray(end.stats)) {
            for (const row of end.stats) {
              if (typeof row !== 'object' || row === null) continue;
              const s = row as Record<string, unknown>;
              const pid = typeof s.id === 'string' ? s.id : '';
              if (pid === '' || io.profileId(pid) === '') continue;
              const delta: Record<string, number> = {};
              if (typeof s.kills === 'number' && Number.isFinite(s.kills)) delta['ancients.kill'] = Math.trunc(s.kills);
              if (typeof s.deaths === 'number' && Number.isFinite(s.deaths)) delta['ancients.death'] = Math.trunc(s.deaths);
              if (end.winner != null && s.team === end.winner) delta['ancients.win'] = 1;
              if (Object.keys(delta).length > 0) io.reportStats(pid, delta);
            }
          }
        }
        io.send(id, msg);
      },
      rttMs: (id) => io.rttMs(id),
    };
    const profileIdOf = io.profileId?.bind(io);
    const reportStatsOf = io.reportStats?.bind(io);
    if (profileIdOf !== undefined) wrapped.profileId = (id) => profileIdOf(id);
    if (reportStatsOf !== undefined) wrapped.reportStats = (pid, d) => reportStatsOf(pid, d);
    return wrapped;
  }

  function handlePadInput(
    padSessionId: string,
    msg: Record<string, unknown>,
    io: RoomIO,
    deliver: (seatId: string, cmd: Record<string, unknown>) => void,
  ): boolean {
    if (msg.t !== 'pad_input') return false;
    if (pads.size >= 32) return true; // consumed-and-dropped: absurd pad count
    const bind = pads.get(padSessionId);
    if (bind === undefined) return true; // unbound pad: drop
    const owner = bind.owner;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const lx = num(msg.lx);
    const ly = num(msg.ly);
    const buttons = typeof msg.buttons === 'number' ? Math.max(0, Math.min(0xffffffff, Math.trunc(msg.buttons))) : 0;
    const pos = posOf.get(owner);
    const now = Date.now();

    // Stick → throttled click-to-move order toward the deflection direction.
    const mag = Math.hypot(lx, ly);
    if (pos !== undefined && mag >= PAD_STICK_DEADZONE && now - bind.lastOrderMs >= PAD_ORDER_EVERY_MS) {
      bind.lastOrderMs = now;
      // Enter the room AS the owner — the same path a desktop click takes.
      // (Sending this outward via io.send would hand the client an unknown
      // S2C tag, which its parser drops: the hero would never move.)
      deliver(owner, {
        t: 'rift_order',
        kind: 'move',
        x: pos.x + (lx / mag) * PAD_ORDER_DIST,
        z: pos.z + (ly / mag) * PAD_ORDER_DIST,
      });
      // v2 stats: the pad adapter's synthesized orders are themselves a
      // counter — this is what e2e-platform asserts to prove the full
      // pad → room → stats pipeline without needing a 12-minute match.
      io.reportStats?.(owner, { 'ancients.pad_order': 1 });
    }
    // Button edges → casts at the hero's feet (slots 0/1).
    const prev = bind.bits;
    bind.bits = buttons;
    if (pos !== undefined) {
      for (const bit of [0, 1, 2] as const) {
        const pressed = (buttons & (1 << bit)) !== 0;
        const was = (prev & (1 << bit)) !== 0;
        if (pressed && !was) deliver(owner, { t: 'rift_cast', slot: bit, x: pos.x, z: pos.z });
      }
    }
    return true; // consumed
  }

  return {
    id: o.id,
    name: o.name ?? base.name,
    clientDist: o.clientDist ?? base.clientDist,
    ...(o.devPort !== undefined ? { devPort: o.devPort } : {}),
    padLayout: ANCIENTS_PAD_LAYOUT,
    minPlayers: base.minPlayers,
    maxPlayers: base.maxPlayers,
    createRoom(opts) {
      const io = wrapIo(opts.io);
      const room = base.createRoom({ ...opts, io });
      // Explicit delegation — spreading a class instance would silently drop
      // every prototype method (info/start/…) and hand the lobby a handle
      // that only half-exists.
      return {
        id: room.id,
        // RoomInfo.game is documented as GameModule.id — the lobby builds
        // /pad/?game=<id> URLs and launcher labels from it, so the variant
        // must report ITS id, not the inner legacy room's.
        info: () => ({ ...room.info(), game: o.id }),
        // docs/PAD.md handshake, implemented by the WRAPPER (the legacy room
        // is untouched): validate a pending pair code, bind pad→seat, notify
        // both sides. Codes were minted when we intercepted pad_pair_request.
        addPad: (padSessionId: string, token: string): boolean => {
          const pending = pendingPads.get(token);
          if (pending === undefined || pending.expiresAt <= Date.now()) {
            pendingPads.delete(token);
            return false;
          }
          pendingPads.delete(token); // single use
          pads.set(padSessionId, { owner: pending.owner, lastOrderMs: 0, bits: 0 });
          io.send(padSessionId, { t: 'pad_joined' });
          io.send(pending.owner, { t: 'pad_status', bound: true });
          return true;
        },
        playerCount: () => room.playerCount(),
        stalePlayers: () => room.stalePlayers(),
        addPlayer: (id, name, resume, sig) => room.addPlayer(id, name, resume, sig),
        removePlayer: (id, permanent) => room.removePlayer(id, permanent),
        handleMessage(id, msg) {
          if (typeof msg === 'object' && msg !== null) {
            const m = msg as Record<string, unknown>;
            if (m.t === 'pad_pair_request') {
              // docs/PAD.md Lifecycle 1: room-minted single-use code.
              const token = pairCode();
              pendingPads.set(token, { owner: id, expiresAt: Date.now() + PAD.tokenTtlMs });
              if (pendingPads.size > 64) pendingPads.clear(); // bound
              opts.io.send(id, {
                t: 'pad_pair',
                room: room.info().code ?? room.info().id,
                token,
                expiresInMs: PAD.tokenTtlMs,
              });
              return;
            }
            if (handlePadInput(id, m, opts.io, (seatId, cmd) => { room.handleMessage(seatId, cmd); })) {
              return; // consumed by the pad adapter
            }
          }
          room.handleMessage(id, msg);
        },
        start: () => room.start(),
        stop: () => room.stop(),
      };
    },
  };
}
