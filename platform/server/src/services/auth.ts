// ============================================================================
// PLATFORM v2 AUTH HANDLERS — POST /api/auth/device + /api/auth/claim
// (docs/PLATFORM.md §4.1). Device-first: the browser's durable `sig` IS the
// credential; find-or-create the profile behind it and mint a bearer token.
// Claim links ANOTHER device's sig to an existing profile via a single-use,
// TTL'd 6-char code. Pure functions over the Store — no I/O, no throwing:
// every failure mode becomes an {error} reply for the router to write.
// Owner: P3_SRV_API.
// ============================================================================

import { SIG_MAX, SIG_MIN, isValidClaimCode } from '@platform/shared';
import type { Store } from './db.js';
import type { ApiReply } from './httpApi.js';

/** Same discipline as protocol.ts cleanSig: bounded string, else reject. */
function cleanSig(v: unknown): string | null {
  return typeof v === 'string' && v.length >= SIG_MIN && v.length <= SIG_MAX ? v : null;
}

/** Envelope-checked body object, or null when the top level isn't an object. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * POST /api/auth/device {sig}
 * → 201 {profileId, token, name} when the sig was new, 200 on reuse.
 * → 400 {error:'bad_request'} for a missing/malformed sig.
 */
export function handleDevice(store: Store, body: unknown): ApiReply {
  const rec = asRecord(body);
  const sig = rec !== null ? cleanSig(rec.sig) : null;
  if (sig === null) return { status: 400, json: { error: 'bad_request' } };

  const { profile, created } = store.profileBySig(sig);
  const token = store.mintToken(profile.id);
  return { status: created ? 201 : 200, json: { profileId: profile.id, token, name: profile.name } };
}

/**
 * POST /api/auth/claim {sig, code}
 * → 200 {profileId, token}: the code's profile, now linked to THIS sig.
 * → 400 {error:'bad_request'} for malformed sig/code shapes.
 * → 409 {error:'invalid_code'} when the code is unknown, expired or already
 *   used (single-use consumption happens BEFORE linking, so replays fail).
 */
export function handleClaim(store: Store, body: unknown): ApiReply {
  const rec = asRecord(body);
  const sig = rec !== null ? cleanSig(rec.sig) : null;
  if (sig === null || rec === null || !isValidClaimCode(rec.code)) {
    return { status: 400, json: { error: 'bad_request' } };
  }
  const code = rec.code as string;

  const profileId = store.consumeClaimCode(code);
  if (profileId === null) return { status: 409, json: { error: 'invalid_code' } };

  store.linkSig(sig, profileId);
  const token = store.mintToken(profileId);
  return { status: 200, json: { profileId, token } };
}
