// ============================================================================
// WORDBOMB GameModule — the plug into the platform registry (the ONLY
// wordbomb-server file that imports @platform/shared). Owns three things and
// nothing else:
//   1. the clientDist probe (identical in shape to bank's / kart's),
//   2. settings validation, delegated to the frozen parseWordbombSettings(),
//   3. the PROCESS-WIDE dictionary + picker singletons handed to every room.
// All match logic lives in room.ts, all lookup in dict.ts, all selection in
// prompts.ts — this file contains no word logic (docs/WORDBOMB.md §7 seams).
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rng } from '@platform/shared';
import type { GameModule, GameRoomHandle } from '@platform/shared';
import { MAX_PLAYERS, MIN_PLAYERS, parseWordbombSettings } from '@wordbomb/shared';
import { loadDict } from './dict.js';
import type { DictBundle, FragmentPicker, WordbombRoomCtor } from './ports.js';
import { createPicker } from './prompts.js';
import { WordbombRoom } from './room.js';

/**
 * Absolute path to the built wordbomb client. Candidates cover the two layouts
 * this module runs in (first existing index.html wins):
 *   1. dev (tsx): here = games/wordbomb/server/src -> games/wordbomb/client/dist
 *   2. bundled (repo root or Docker /app): here = platform/server/dist
 *      (esbuild inlines this module into dist/server.js, so import.meta.url
 *      is the BUNDLE's url)                    -> <root>/games/wordbomb/client/dist
 *   3/4. cwd fallbacks: repo root, and the package dir (npm -w scripts).
 * When nothing is built yet the dev path is returned; the platform entry
 * already falls back to its placeholder text when index.html is absent.
 */
function resolveClientDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../client/dist'),
    path.resolve(here, '../../../games/wordbomb/client/dist'),
    path.resolve(process.cwd(), 'games/wordbomb/client/dist'),
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
 * THE DICTIONARY IS LOADED ONCE PER PROCESS, HERE, AT MODULE SCOPE.
 *
 * Not per room, and not lazily on first createRoom. The blob + sparse index +
 * fragment pools are ~5 MB resident (docs/WORDBOMB.md §3.1 budgets under 8 MB)
 * and are entirely READ-ONLY, so N rooms must share one copy: doing it per room
 * would multiply 5 MB and 25 ms of derivation by the room count, and a lobby
 * with a dozen rooms would spend more memory on duplicate dictionaries than on
 * the game. Doing it lazily would instead pay that 25 ms inside the first
 * createRoom — i.e. inside a player's "create room" click — and would hide a
 * missing words.blob until the first match rather than at boot.
 *
 * Loading at import time means a missing/corrupt blob fails the server at
 * startup with a clear stack, which is the correct failure: the Dockerfile has
 * to COPY games/wordbomb/server/data (docs/WORDBOMB.md §7, W9 site 6), and a
 * silent ENOENT hours later is exactly the failure that note exists to prevent.
 *
 * `loadDict()` runs its own multi-candidate data-dir probe (ports.ts), so no
 * path is passed here.
 */
const DICT: DictBundle = loadDict();

/**
 * Derived from the one dictionary, also once: `FragmentPicker` is stateless
 * with respect to a match (ports.ts) — the room owns the per-match `used` set
 * and passes it to `pick()` — so a single picker serves every room.
 */
const PICKER: FragmentPicker = createPicker(DICT);

/**
 * Startup budget line. §3.1 makes the resident cost a measured, reported number
 * rather than an aspiration, so it is printed where an operator will see it
 * next to `[net] listening`.
 */
console.log(
  `[wordbomb] dictionary ready: ${DICT.dict.size} words, ` +
    `${(DICT.bytesResident / 1_048_576).toFixed(2)} MB resident ` +
    `(${DICT.bytesResident} bytes); pools easy/normal/hard = ` +
    `${PICKER.poolSize('easy')}/${PICKER.poolSize('normal')}/${PICKER.poolSize('hard')}`,
);

/**
 * One shared rng stream for every room's fuse draws, per the platform rule that
 * server-side non-gameplay generation uses `rng(Date.now())`.
 *
 * Deliberately module scope rather than `rng(Date.now())` per room: two rooms
 * created inside the same millisecond would otherwise be seeded identically and
 * burn the SAME 20 fuse lengths, which is both a correlation bug and, for two
 * players hopping rooms together, learnable. One stream cannot collide with
 * itself. Rooms take `rand` as an injected dep (ports.ts `RoomDeps`) precisely
 * so room.test.ts can substitute a deterministic one.
 */
const rand: () => number = rng(Date.now());

/**
 * Compile-time proof that room.ts's constructor still matches the frozen seam.
 * If W3's signature ever drifts from `WordbombRoomCtor` this line fails to
 * typecheck here, rather than at the `new` below with a vaguer message.
 */
const Room: WordbombRoomCtor = WordbombRoom;

export const wordbombModule: GameModule = {
  id: 'wordbomb',
  name: 'WORDBOMB',
  clientDist: resolveClientDist(),
  // vite dev server (npm run dev -w @wordbomb/client): the platform proxies
  // /wordbomb/ here when it answers, so one port (8080) serves launcher + HMR
  // client. Must match `server.port` in the client's vite.config.ts.
  devPort: 5176,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  createRoom(opts): GameRoomHandle {
    // parseWordbombSettings THROWS Error(message) on bad input; the lobby turns
    // that into { t: 'error', code: 'bad_settings', message }. It also accepts
    // `undefined` and returns a fresh copy of DEFAULT_SETTINGS, so quick-join
    // needs no special case here.
    const settings = parseWordbombSettings(opts.settings);
    return new Room(opts.visibility, opts.io, settings, {
      dict: DICT.dict,
      picker: PICKER,
      rand,
    });
  },
};
