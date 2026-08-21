// ============================================================================
// SDK SAVES — cloud slots with optimistic concurrency (docs/PLATFORM.md
// §4.2). REST via fetch with Bearer token from Profiles:
//   GET    /api/saves/:game       → [summary]
//   GET    /api/saves/:game/:slot → record | 404
//   PUT    /api/saves/:game/:slot {rev, data} → {rev} | 409 {error, rev}
//   DELETE /api/saves/:game/:slot → 204
// put() is optimistic: on 409 it resolves {ok:false, record:CURRENT} (fetched)
// so callers can merge/retry; network failures and other statuses THROW.
// Owner: P6_SDK_CORE — implement SavesApi from types.ts.
//
// DOM-free: no window/localStorage here — the token arrives via getToken().
// ============================================================================

import type { SaveRecord, SaveSlot, SaveSummary } from '@platform/shared';
import type { SavesApi } from './types.js';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Loose row validation for list replies — bad rows are dropped, never thrown. */
function toSummary(v: unknown): SaveSummary | null {
  if (!isObj(v)) return null;
  const slot = v.slot;
  const rev = v.rev;
  const updatedAt = v.updatedAt;
  const size = v.size;
  if (
    typeof slot !== 'string' ||
    typeof rev !== 'number' ||
    typeof updatedAt !== 'number' ||
    typeof size !== 'number'
  ) {
    return null;
  }
  return { slot, rev, updatedAt, size };
}

export class CloudSaves implements SavesApi {
  private readonly gameId: string;
  private readonly getToken: () => string | null;

  constructor(gameId: string, getToken: () => string | null) {
    this.gameId = gameId;
    this.getToken = getToken;
  }

  async list(): Promise<readonly SaveSummary[]> {
    const json = await this.request('GET', `/api/saves/${this.gameId}`);
    if (!Array.isArray(json)) throw new Error('CloudSaves: list reply malformed');
    return json.flatMap((row) => {
      const s = toSummary(row);
      return s === null ? [] : [s];
    });
  }

  async get<T = unknown>(slot: SaveSlot): Promise<SaveRecord<T>> {
    const json = await this.request('GET', `/api/saves/${this.gameId}/${slot}`);
    if (!isObj(json) || typeof json.slot !== 'string' || typeof json.rev !== 'number') {
      throw new Error('CloudSaves: get reply malformed');
    }
    return {
      slot: json.slot,
      rev: json.rev,
      data: json.data as T,
      updatedAt: typeof json.updatedAt === 'number' ? json.updatedAt : 0,
    };
  }

  async put(
    slot: SaveSlot,
    expectedRev: number,
    data: unknown,
  ): Promise<{ ok: boolean; record: SaveRecord }> {
    let res: Response;
    try {
      res = await fetch(`/api/saves/${this.gameId}/${slot}`, {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({ rev: expectedRev, data }),
      });
    } catch (err) {
      // Network failure THROWS (the caller can't distinguish conflict from offline otherwise).
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (res.status === 401) throw new Error('CloudSaves: unauthorized');
    if (res.ok) {
      const json: unknown = await res.json().catch(() => null);
      const rev = isObj(json) && typeof json.rev === 'number' ? json.rev : expectedRev + 1;
      return { ok: true, record: { slot, rev, data, updatedAt: Date.now() } };
    }
    if (res.status === 409) {
      // Conflict: resolve with the CURRENT record so callers can merge/retry.
      const current = await this.get(slot);
      return { ok: false, record: current };
    }
    throw new Error(`CloudSaves: put failed (${res.status})`);
  }

  async del(slot: SaveSlot): Promise<void> {
    const res = await fetch(`/api/saves/${this.gameId}/${slot}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (res.status === 401) throw new Error('CloudSaves: unauthorized');
    if (!res.ok) throw new Error(`CloudSaves: delete failed (${res.status})`);
  }

  // ---- internals ---------------------------------------------------------------

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = this.getToken();
    if (token !== null && token !== '') headers.authorization = `Bearer ${token}`;
    return headers;
  }

  private async request(method: 'GET', url: string): Promise<unknown> {
    const res = await fetch(url, { method, headers: this.headers() });
    if (res.status === 401) throw new Error('CloudSaves: unauthorized');
    if (!res.ok) throw new Error(`CloudSaves: ${method} ${url} failed (${res.status})`);
    return res.json();
  }
}

/**
 * Convenience read-modify-write helper; retries ONCE on rev conflict using the
 * freshly merged current data. Resolves the written record on success, or the
 * conflicting CURRENT record when even the retry loses. Missing slots merge
 * from null; unreadable/unreachable slots throw.
 */
export async function updateSave<T>(
  saves: SavesApi,
  slot: SaveSlot,
  merge: (current: T | null) => T,
): Promise<SaveRecord> {
  let current: T | null = null;
  let rev = 0;
  try {
    const rec = await saves.get<T>(slot);
    current = rec.data;
    rev = rec.rev;
  } catch {
    // no slot yet — write from a clean base at rev 0
  }

  for (let attempt = 0; ; attempt++) {
    const merged = merge(current);
    const res = await saves.put(slot, rev, merged);
    if (res.ok) return res.record;
    // Conflict: adopt the server's current record; one retry, then give up
    // with the CURRENT record so callers can decide what to do.
    current = res.record.data as T;
    rev = res.record.rev;
    if (attempt >= 1) return res.record;
  }
}
