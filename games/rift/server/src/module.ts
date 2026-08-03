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
import { rng } from '@platform/shared';
import type { GameModule, GameRoomHandle } from '@platform/shared';
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
