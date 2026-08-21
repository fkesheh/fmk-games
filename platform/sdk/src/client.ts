// ============================================================================
// SDK FACADE — createGameClient(): wires net/profile/saves/input/audio into
// one object (docs/PLATFORM.md §4.5). Also owns the pad-pairing flow:
// pad_pair_request → overlay with code → pad_status updates.
// Owner: P6_SDK_CORE — implement GameClient from types.ts.
// ============================================================================

import type { GameClient, GameClientOpts } from './types.js';

export function createGameClient(_opts: GameClientOpts): GameClient {
  void _opts;
  throw new Error('P6_SDK_CORE: not implemented');
}
