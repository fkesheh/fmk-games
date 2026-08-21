// ============================================================================
// PLATFORM v2 PROFILE HANDLERS — GET/PATCH /api/profiles/me and the stats
// reads (docs/PLATFORM.md §4.1 + §4.3). All require a resolved profileId —
// the router's Bearer middleware guarantees it before calling in. Pure
// functions over the Store; every failure mode becomes an {error} reply.
// Owner: P3_SRV_API.
// ============================================================================

import { cleanName } from '@platform/shared';
import type { StatRow } from '@platform/shared';
import type { Store } from './db.js';
import type { ApiReply } from './httpApi.js';

/** Envelope-checked body object, or null when the top level isn't an object. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * GET /api/profiles/me → 200 {id, name, createdAt}.
 * A token that resolves but whose profile is gone (shouldn't happen) is an
 * auth failure, not a 404: 401 {error:'unauthorized'}.
 */
export function getMe(store: Store, profileId: string): ApiReply {
  const profile = store.profileById(profileId);
  if (profile === null) return { status: 401, json: { error: 'unauthorized' } };
  return { status: 200, json: { id: profile.id, name: profile.name, createdAt: profile.createdAt } };
}

/**
 * PATCH /api/profiles/me {name?} → 200 {id, name}.
 * `name` is optional; when present it MUST be a string (else 400) and is
 * cleaned exactly like identity.ts cleanName (trim, ≤16, 'Player' fallback).
 * An absent name renames nothing and just reports the current one.
 */
export function patchMe(store: Store, profileId: string, body: unknown): ApiReply {
  const profile = store.profileById(profileId);
  if (profile === null) return { status: 401, json: { error: 'unauthorized' } };

  let name = profile.name;
  const rec = asRecord(body);
  if (rec !== null && 'name' in rec) {
    if (typeof rec.name !== 'string') return { status: 400, json: { error: 'bad_request' } };
    name = cleanName(rec.name);
    store.renameProfile(profileId, name);
  }
  return { status: 200, json: { id: profile.id, name } };
}

/**
 * Shared read for GET /api/profiles/me/stats (Bearer) and
 * GET /api/profiles/:id/stats (public). `game` filters to one game when set.
 * → 200 [{gameId, key, value}].
 */
export function getStats(store: Store, profileId: string, game: string | undefined): ApiReply {
  const rows = store.statsFor(profileId, game);
  const out: StatRow[] = rows.map((r) => ({ gameId: r.gameId, key: r.key, value: r.value }));
  return { status: 200, json: out };
}
