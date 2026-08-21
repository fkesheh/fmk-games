// ============================================================================
// PLATFORM v2 STORAGE — sqlite-backed store behind ONE interface (docs/
// PLATFORM.md §6). node:sqlite only; when the file cannot be opened the
// store degrades to in-memory (platform must never die over persistence).
// Owner: P2_SRV_DB — implement every member; do not change signatures.
// ============================================================================

import type { AuthToken } from '@platform/shared';

export interface ProfileRow {
  id: string;
  name: string;
  createdAt: number; // epoch ms
}

export interface SaveRow {
  slot: string;
  rev: number;
  /** Serialized JSON string as stored. */
  data: string;
  updatedAt: number; // epoch ms
  size: number; // bytes of `data`
}

export interface StatRowDb {
  gameId: string;
  key: string;
  value: number;
}

export interface PutSaveResult {
  ok: boolean;
  /** Current rev after the attempt (the new rev on ok, the conflicting rev otherwise). */
  rev: number;
}

/**
 * All times are epoch ms. All methods are synchronous (sqlite is); callers
 * wrap in try/catch at the API edge — this class THROWS on real errors when
 * backed by a live db, and never throws in in-memory fallback mode.
 */
export class Store {
  constructor(dbPath: string | null);
  /** True when running on the in-memory shim (logged loudly by index.ts). */
  get degraded(): boolean;
  close(): void;

  // ---- profiles + auth -----------------------------------------------------
  /** Find-or-create the profile a browser sig belongs to. */
  profileBySig(sig: string): { profile: ProfileRow; created: boolean };
  /** Link another device sig to an existing profile (claim flow). */
  linkSig(sig: string, profileId: string): void;
  profileById(id: string): ProfileRow | null;
  renameProfile(id: string, name: string): void;
  /** Mint a new bearer token for a profile (old tokens stay valid). */
  mintToken(profileId: string): AuthToken;
  /** Resolve a bearer token to its profile id, or null. */
  profileIdByToken(token: string): string | null;
  /** Mint a 6-char claim code bound to a profile (single use, TTL'd). */
  mintClaimCode(profileId: string): string;
  /** Consume a claim code → profileId, or null (unknown/expired/used). */
  consumeClaimCode(code: string): string | null;

  // ---- saves ---------------------------------------------------------------
  listSaves(profileId: string, gameId: string): SaveRow[];
  getSave(profileId: string, gameId: string, slot: string): SaveRow | null;
  putSave(
    profileId: string,
    gameId: string,
    slot: string,
    expectedRev: number,
    dataJson: string,
    sizeBytes: number,
  ): PutSaveResult | 'quota' | 'slots_full';
  deleteSave(profileId: string, gameId: string, slot: string): boolean;

  // ---- stats ---------------------------------------------------------------
  /** Add finite counter deltas (clamped by caller to STATS limits). */
  addStats(profileId: string, gameId: string, delta: Record<string, number>): void;
  statsFor(profileId: string, gameId?: string): StatRowDb[];
}
