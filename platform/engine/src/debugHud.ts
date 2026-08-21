// ============================================================================
// DEBUG HUD — tiny fps/tick overlay (docs/PLATFORM.md §4.6).
// Owner: P5_ENGINE — implement.
// ============================================================================

import type { DebugRows } from './types.js';

export interface DebugHud {
  update(): void;
  dispose(): void;
}

/** Monospace top-left overlay; rows() re-read each update(). */
export function createDebugHud(rows: DebugRows): DebugHud {
  void rows;
  throw new Error('P5_ENGINE: not implemented');
}
