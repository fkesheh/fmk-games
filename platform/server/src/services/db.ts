// ============================================================================
// PLATFORM v2 STORAGE — sqlite-backed store behind ONE interface (docs/
// PLATFORM.md §6). node:sqlite only; when the file cannot be opened the
// store degrades to in-memory (platform must never die over persistence).
// Owner: P2_SRV_DB — implement every member; do not change signatures.
// ============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue, StatementSync } from 'node:sqlite';
import type { AuthToken } from '@platform/shared';
import { AUTH, CLAIM_ALPHABET, SAVES, STATS } from '@platform/shared';

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
  #db: DatabaseSync | null;
  #degraded: boolean;

  // ---- prepared once in ctor ------------------------------------------------
  #selProfileBySig: StatementSync;
  #insProfile: StatementSync;
  #insIdentity: StatementSync;
  #selProfileById: StatementSync;
  #updProfileName: StatementSync;
  #insToken: StatementSync;
  #selProfileByToken: StatementSync;
  #insClaimCode: StatementSync;
  #selClaimCode: StatementSync;
  #useClaimCode: StatementSync;
  #listSaves: StatementSync;
  #selSaveFull: StatementSync;
  #cntSaves: StatementSync;
  #insSave: StatementSync;
  #updSaveCas: StatementSync;
  #delSave: StatementSync;
  #selStat: StatementSync;
  #upsertStat: StatementSync;
  #listStatsAll: StatementSync;
  #listStatsGame: StatementSync;

  constructor(dbPath: string | null) {
    // Tier 1: the real file. ANY failure to open/WAL/migrate degrades us —
    // the platform must never die over persistence.
    let opened: DatabaseSync | null = null;
    if (dbPath !== null) {
      try {
        opened = new DatabaseSync(dbPath);
        opened.exec('PRAGMA journal_mode = WAL;');
        migrate(opened);
      } catch {
        opened = null;
      }
    }

    let degraded = true;
    if (opened === null) {
      // Tier 2: same SQL against ':memory:' — always works, keeps every code
      // path below identical between degraded and healthy modes.
      try {
        const mem = new DatabaseSync(':memory:');
        mem.exec('PRAGMA journal_mode = WAL;');
        migrate(mem);
        opened = mem;
      } catch {
        // Tier 3 (unreachable short of OS-wide storage failure): a private
        // temp file gives identical behavior without rethrowing from here.
        const tmp = new DatabaseSync(join(tmpdir(), `fps-store-${randomUUID()}.db`));
        tmp.exec('PRAGMA journal_mode = WAL;');
        migrate(tmp);
        opened = tmp;
      }
    } else {
      degraded = false;
    }

    this.#db = opened;
    this.#degraded = degraded;

    this.#selProfileBySig = opened.prepare(
      'SELECT profile_id FROM auth_identities WHERE sig = ?',
    );
    this.#insProfile = opened.prepare(
      'INSERT INTO profiles (id, name, created_at) VALUES (?, ?, ?)',
    );
    this.#insIdentity = opened.prepare(
      `INSERT INTO auth_identities (sig, profile_id) VALUES (?, ?)
       ON CONFLICT (sig) DO UPDATE SET profile_id = excluded.profile_id`,
    );
    this.#selProfileById = opened.prepare(
      'SELECT id, name, created_at FROM profiles WHERE id = ?',
    );
    this.#updProfileName = opened.prepare('UPDATE profiles SET name = ? WHERE id = ?');
    this.#insToken = opened.prepare(
      'INSERT INTO tokens (token, profile_id, created_at) VALUES (?, ?, ?)',
    );
    this.#selProfileByToken = opened.prepare(
      'SELECT profile_id FROM tokens WHERE token = ?',
    );
    this.#insClaimCode = opened.prepare(
      'INSERT INTO claim_codes (code, profile_id, expires_at, used) VALUES (?, ?, ?, 0)',
    );
    this.#selClaimCode = opened.prepare(
      'SELECT profile_id, expires_at, used FROM claim_codes WHERE code = ?',
    );
    this.#useClaimCode = opened.prepare(
      'UPDATE claim_codes SET used = 1 WHERE code = ? AND used = 0',
    );
    this.#listSaves = opened.prepare(
      `SELECT slot, rev, data, size, updated_at FROM saves
       WHERE profile_id = ? AND game_id = ?
       ORDER BY updated_at DESC, slot ASC`,
    );
    this.#selSaveFull = opened.prepare(
      'SELECT slot, rev, data, size, updated_at FROM saves WHERE profile_id = ? AND game_id = ? AND slot = ?',
    );
    this.#cntSaves = opened.prepare(
      'SELECT count(*) AS n FROM saves WHERE profile_id = ? AND game_id = ?',
    );
    this.#insSave = opened.prepare(
      'INSERT INTO saves (profile_id, game_id, slot, rev, data, size, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.#updSaveCas = opened.prepare(
      `UPDATE saves SET rev = ?, data = ?, size = ?, updated_at = ?
       WHERE profile_id = ? AND game_id = ? AND slot = ? AND rev = ?`,
    );
    this.#delSave = opened.prepare(
      'DELETE FROM saves WHERE profile_id = ? AND game_id = ? AND slot = ?',
    );
    this.#selStat = opened.prepare(
      'SELECT value FROM stats WHERE profile_id = ? AND game_id = ? AND key = ?',
    );
    this.#upsertStat = opened.prepare(
      `INSERT INTO stats (profile_id, game_id, key, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (profile_id, game_id, key) DO UPDATE SET value = excluded.value`,
    );
    this.#listStatsAll = opened.prepare(
      'SELECT game_id, key, value FROM stats WHERE profile_id = ? ORDER BY game_id ASC, key ASC',
    );
    this.#listStatsGame = opened.prepare(
      'SELECT game_id, key, value FROM stats WHERE profile_id = ? AND game_id = ? ORDER BY key ASC',
    );

    registerInternals(this, {
      insClaimCode: this.#insClaimCode,
    });
  }

  /** True when running on the in-memory shim (logged loudly by index.ts). */
  get degraded(): boolean {
    return this.#degraded;
  }

  close(): void {
    const db = this.#db;
    if (db === null) return;
    this.#db = null;
    db.close();
  }

  // ---- profiles + auth -------------------------------------------------------
  /** Find-or-create the profile a browser sig belongs to. */
  profileBySig(sig: string): { profile: ProfileRow; created: boolean } {
    return this.#tx(() => {
      const hit = this.#selProfileBySig.get(sig);
      if (hit !== undefined) {
        const id = colStr(hit, 'profile_id');
        const profile = this.profileById(id);
        if (profile === null) {
          throw new Error(`Store: identity "${sig}" references missing profile "${id}"`);
        }
        return { profile, created: false };
      }
      const id = randomUUID();
      const name = `player-${id.slice(0, 6)}`;
      const createdAt = Date.now();
      this.#insProfile.run(id, name, createdAt);
      this.#insIdentity.run(sig, id);
      return { profile: { id, name, createdAt }, created: true };
    });
  }

  /** Link another device sig to an existing profile (claim flow). */
  linkSig(sig: string, profileId: string): void {
    // Upsert: re-linking an existing sig moves it; FK still rejects unknown profiles.
    this.#insIdentity.run(sig, profileId);
  }

  profileById(id: string): ProfileRow | null {
    const row = this.#selProfileById.get(id);
    if (row === undefined) return null;
    return {
      id: colStr(row, 'id'),
      name: colStr(row, 'name'),
      createdAt: colNum(row, 'created_at'),
    };
  }

  renameProfile(id: string, name: string): void {
    this.#updProfileName.run(name, id);
  }

  /** Mint a new bearer token for a profile (old tokens stay valid). */
  mintToken(profileId: string): AuthToken {
    const token = randomBytes(AUTH.tokenBytes).toString('base64url'); // 43 chars
    this.#insToken.run(token, profileId, Date.now());
    return token;
  }

  /** Resolve a bearer token to its profile id, or null. */
  profileIdByToken(token: string): string | null {
    const row = this.#selProfileByToken.get(token);
    if (row === undefined) return null;
    return colStr(row, 'profile_id');
  }

  /** Mint a 6-char claim code bound to a profile (single use, TTL'd). */
  mintClaimCode(profileId: string): string {
    const expiresAt = Date.now() + AUTH.claimTtlMs;
    // PK collisions are ~impossible (32^6 space) but retry a few times anyway.
    let lastErr: unknown = new Error('Store.mintClaimCode: could not allocate a unique code');
    for (let attempt = 0; attempt < 16; attempt++) {
      const code = randomCode(AUTH.claimCodeLen);
      try {
        this.#insClaimCode.run(code, profileId, expiresAt);
        return code;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /** Consume a claim code → profileId, or null (unknown/expired/used). */
  consumeClaimCode(code: string): string | null {
    const row = this.#selClaimCode.get(code);
    if (row === undefined) return null;
    if (colNum(row, 'used') !== 0) return null;
    if (colNum(row, 'expires_at') <= Date.now()) return null;
    // Guarded update: even under a future concurrent caller only one wins.
    const res = this.#useClaimCode.run(code);
    if (Number(res.changes) === 0) return null;
    return colStr(row, 'profile_id');
  }

  // ---- saves -----------------------------------------------------------------
  listSaves(profileId: string, gameId: string): SaveRow[] {
    const rows = this.#listSaves.all(profileId, gameId);
    return rows.map((row) => saveRowOf(row));
  }

  getSave(profileId: string, gameId: string, slot: string): SaveRow | null {
    const row = this.#selSaveFull.get(profileId, gameId, slot);
    if (row === undefined) return null;
    return saveRowOf(row);
  }

  putSave(
    profileId: string,
    gameId: string,
    slot: string,
    expectedRev: number,
    dataJson: string,
    sizeBytes: number,
  ): PutSaveResult | 'quota' | 'slots_full' {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > SAVES.maxBytes) {
      return 'quota';
    }
    return this.#tx(() => {
      const cur = this.#selSaveFull.get(profileId, gameId, slot);
      if (cur === undefined) {
        // Absent slot: current rev is conventionally 0, so only expectedRev 0
        // creates — the first write lands at rev 1.
        if (expectedRev !== 0) return { ok: false, rev: 0 };
        const cnt = this.#cntSaves.get(profileId, gameId);
        const n = cnt === undefined ? 0 : colNum(cnt, 'n');
        if (n >= SAVES.maxSlots) return 'slots_full';
        this.#insSave.run(profileId, gameId, slot, 1, dataJson, sizeBytes, Date.now());
        return { ok: true, rev: 1 };
      }
      const curRev = colNum(cur, 'rev');
      if (expectedRev !== curRev) return { ok: false, rev: curRev };
      const res = this.#updSaveCas.run(
        curRev + 1,
        dataJson,
        sizeBytes,
        Date.now(),
        profileId,
        gameId,
        slot,
        curRev,
      );
      if (Number(res.changes) !== 1) return { ok: false, rev: curRev }; // unreachable; defensive
      return { ok: true, rev: curRev + 1 };
    });
  }

  deleteSave(profileId: string, gameId: string, slot: string): boolean {
    const res = this.#delSave.run(profileId, gameId, slot);
    return Number(res.changes) > 0;
  }

  // ---- stats -----------------------------------------------------------------
  /** Add finite counter deltas (clamped by caller to STATS limits). */
  addStats(profileId: string, gameId: string, delta: Record<string, number>): void {
    const keys = Object.keys(delta);
    if (keys.length === 0) return;
    this.#tx(() => {
      for (const key of keys) {
        const d = delta[key];
        if (d === undefined || !Number.isFinite(d)) continue;
        const row = this.#selStat.get(profileId, gameId, key);
        const cur = row === undefined ? 0 : colNum(row, 'value');
        const next = clampStat(cur + d);
        this.#upsertStat.run(profileId, gameId, key, next);
      }
    });
  }

  statsFor(profileId: string, gameId?: string): StatRowDb[] {
    const rows =
      gameId === undefined
        ? this.#listStatsAll.all(profileId)
        : this.#listStatsGame.all(profileId, gameId);
    return rows.map((row) => ({
      gameId: colStr(row, 'game_id'),
      key: colStr(row, 'key'),
      value: colNum(row, 'value'),
    }));
  }

  // ---- internals ---------------------------------------------------------------
  /** Run fn atomically; no-op nesting guard is unnecessary (methods never nest). */
  #tx<T>(fn: () => T): T {
    const db = this.#db;
    if (db === null) return fn(); // closed store: let the statements themselves fail
    db.exec('BEGIN IMMEDIATE;');
    try {
      const out = fn();
      db.exec('COMMIT;');
      return out;
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // already rolled back / connection gone — original error matters more
      }
      throw err;
    }
  }
}

// ---- schema migrations -------------------------------------------------------

const V1_SQL = `
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_identities (
  sig TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles (id)
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles (id),
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS claim_codes (
  code TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS saves (
  profile_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  rev INTEGER NOT NULL,
  data TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, game_id, slot)
);
CREATE TABLE IF NOT EXISTS stats (
  profile_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (profile_id, game_id, key)
);
`;

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);');
  const row = db.prepare('SELECT max(version) AS v FROM schema_migrations').get();
  const raw = row === undefined ? undefined : row.v; // NULL on a fresh table
  const version = typeof raw === 'number' ? raw : 0;
  if (version >= 1) return;
  db.exec(V1_SQL);
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(Date.now());
}

// ---- row/value helpers (noUncheckedIndexedAccess-safe) ------------------------

function colStr(row: Record<string, SQLOutputValue>, col: string): string {
  const v = row[col];
  if (typeof v !== 'string') throw new TypeError(`sqlite column "${col}": expected TEXT`);
  return v;
}

function colNum(row: Record<string, SQLOutputValue>, col: string): number {
  const v = row[col];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`sqlite column "${col}": expected finite NUMBER`);
  }
  return v;
}

function saveRowOf(row: Record<string, SQLOutputValue>): SaveRow {
  return {
    slot: colStr(row, 'slot'),
    rev: colNum(row, 'rev'),
    data: colStr(row, 'data'),
    updatedAt: colNum(row, 'updated_at'),
    size: colNum(row, 'size'),
  };
}

/** CLAIM_ALPHABET.length === 32 divides 256 evenly, so `byte % 32` is unbiased. */
function randomCode(len: number): string {
  let out = '';
  while (out.length < len) {
    const bytes = randomBytes(len);
    for (let i = 0; i < bytes.length && out.length < len; i++) {
      const b = bytes[i];
      if (b === undefined) break; // noUncheckedIndexedAccess paranoia
      out += CLAIM_ALPHABET.charAt(b % CLAIM_ALPHABET.length);
    }
  }
  return out;
}

function clampStat(v: number): number {
  return Math.max(-STATS.maxValue, Math.min(STATS.maxValue, v));
}

// ---- test-only access ---------------------------------------------------------
//
// The class surface above is frozen; tests reach one internal statement (the
// claim-code insert) through this WeakMap so expiry can be exercised without
// fake timers or real sleeps.

interface StoreInternals {
  insClaimCode: StatementSync;
}

const internals = new WeakMap<Store, StoreInternals>();

function registerInternals(store: Store, value: StoreInternals): void {
  internals.set(store, value);
}

export const __test = {
  /**
   * Insert a claim_codes row with a caller-chosen expiry so TTL behaviour is
   * testable deterministically (AUTH.claimTtlMs itself stays fixed).
   */
  insertClaimCode(store: Store, code: string, profileId: string, expiresAtMs: number): void {
    const i = internals.get(store);
    if (i === undefined) throw new Error('__test.insertClaimCode: unknown Store instance');
    i.insClaimCode.run(code, profileId, expiresAtMs);
  },
};
