// ============================================================================
// PLATFORM v2 SAVE HANDLERS — cloud key-value slots with optimistic
// concurrency (docs/PLATFORM.md §4.2). All take a resolved profileId (the
// router's Bearer middleware guarantees it) plus the path's :game/:slot.
// Pure functions over the Store; every failure mode becomes an {error} reply.
// Owner: P3_SRV_API.
// ============================================================================

import type { SaveRecord, SaveSummary } from '@platform/shared';
import { SAVES, isValidSaveData, isValidSaveSlot } from '@platform/shared';
import type { SaveRow, Store } from './db.js';
import type { ApiReply } from './httpApi.js';

/** Envelope-checked body object, or null when the top level isn't an object. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** The listing shape carries everything except the payload. */
function toSummary(row: SaveRow): SaveSummary {
  return { slot: row.slot, rev: row.rev, updatedAt: row.updatedAt, size: row.size };
}

/**
 * GET /api/saves/:game → 200 [SaveSummary].
 */
export function listSaves(store: Store, profileId: string, gameId: string): ApiReply {
  return { status: 200, json: store.listSaves(profileId, gameId).map(toSummary) };
}

/** The one valid-shape guard shared by every :slot route (router calls it). */
export function slotIsValid(slot: string): boolean {
  return isValidSaveSlot(slot);
}

/**
 * GET /api/saves/:game/:slot → 200 SaveRecord with `data` parsed back to JSON.
 * → 404 {error:'not_found'} when the slot is empty.
 */
export function getSave(store: Store, profileId: string, gameId: string, slot: string): ApiReply {
  const row = store.getSave(profileId, gameId, slot);
  if (row === null) return { status: 404, json: { error: 'not_found' } };

  let data: unknown;
  try {
    data = JSON.parse(row.data) as unknown;
  } catch {
    // Stored bytes are always written by putSave as serialized JSON; a parse
    // failure means real corruption — report internal, never leak details.
    return { status: 500, json: { error: 'internal' } };
  }
  const record: SaveRecord = { slot: row.slot, rev: row.rev, data, updatedAt: row.updatedAt };
  return { status: 200, json: record };
}

/**
 * PUT /api/saves/:game/:slot {rev, data}
 * → 200 {rev} on success (new rev = expected + 1).
 * → 409 {error:'conflict', rev} when `rev` isn't the current one.
 * → 400 {error:'quota' | 'slots_full'} per the store's quota verdicts.
 * → 413 {error:'too_large'} when the payload serializes past SAVES.maxBytes.
 * → 400 {error:'bad_request'} for a non-integer rev or data that isn't a
 *   plain object/array (isValidSaveData).
 */
export function putSave(
  store: Store,
  profileId: string,
  gameId: string,
  slot: string,
  body: unknown,
): ApiReply {
  const rec = asRecord(body);
  const rev = rec?.rev;
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) {
    return { status: 400, json: { error: 'bad_request' } };
  }
  const data = rec?.data;
  if (!isValidSaveData(data)) return { status: 400, json: { error: 'bad_request' } };

  const dataJson = JSON.stringify(data);
  const sizeBytes = Buffer.byteLength(dataJson, 'utf8');
  if (sizeBytes > SAVES.maxBytes) return { status: 413, json: { error: 'too_large' } };

  const result = store.putSave(profileId, gameId, slot, rev, dataJson, sizeBytes);
  if (result === 'quota') return { status: 400, json: { error: 'quota' } };
  if (result === 'slots_full') return { status: 400, json: { error: 'slots_full' } };
  if (!result.ok) return { status: 409, json: { error: 'conflict', rev: result.rev } };
  return { status: 200, json: { rev: result.rev } };
}

/**
 * DELETE /api/saves/:game/:slot → 204 always (idempotent; deleting an empty
 * slot succeeds by doing nothing). `json` is null so the router sends no body.
 */
export function deleteSave(store: Store, profileId: string, gameId: string, slot: string): ApiReply {
  store.deleteSave(profileId, gameId, slot);
  return { status: 204, json: null };
}
