// ============================================================================
// SDK SAVES — cloud slots with optimistic concurrency (docs/PLATFORM.md
// §4.2). REST via fetch with Bearer token from Profiles.
// Owner: P6_SDK_CORE — implement SavesApi from types.ts (keep signatures).
// ============================================================================

import type { SaveRecord, SaveSlot, SaveSummary } from '@platform/shared';
import type { SavesApi } from './types.js';

export class CloudSaves implements SavesApi {
  constructor(
    private readonly gameId: string,
    private readonly getToken: () => string | null,
  ) {
    void gameId;
    void getToken;
  }

  list(): Promise<readonly SaveSummary[]> {
    throw new Error('P6_SDK_CORE: not implemented');
  }

  get<T = unknown>(_slot: SaveSlot): Promise<SaveRecord<T>> {
    void _slot;
    return Promise.reject(new Error('P6_SDK_CORE: not implemented'));
  }

  put(_slot: SaveSlot, _expectedRev: number, _data: unknown): Promise<{ ok: boolean; record: SaveRecord }> {
    void _slot;
    void _expectedRev;
    void _data;
    throw new Error('P6_SDK_CORE: not implemented');
  }

  del(_slot: SaveSlot): Promise<void> {
    void _slot;
    throw new Error('P6_SDK_CORE: not implemented');
  }
}

/** Convenience: read-modify-write helper; retries once on rev conflict. */
export async function updateSave<T>(
  saves: SavesApi,
  slot: SaveSlot,
  merge: (current: T | null) => T,
): Promise<SaveRecord> {
  void saves;
  void slot;
  void merge;
  throw new Error('P6_SDK_CORE: not implemented');
}
