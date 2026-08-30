// ============================================================================
// Store tests — the entire P2_SRV_DB storage layer exercised through its
// PUBLIC surface only (no node:sqlite import here; that's a db.ts monopoly).
//
// Harness notes
// -------------
// - Every behavioral test runs on `new Store(null)` — the degraded in-memory
//   shim — which executes the exact same prepared SQL as file mode against a
//   ':memory:' database, so parity between the two modes is structural.
// - Degradation itself is proven by pointing the constructor at an
//   unwritable path ('/dev/null/sub/x.db' — ENOTDIR) and asserting the
//   store still comes up fully functional with degraded === true.
// - Claim-code expiry: AUTH.claimTtlMs is fixed at 10 minutes and fake
//   timers can't reach inside sqlite, so tests plant rows with past
//   expiries through the exported __test.insertClaimCode hook — zero sleeps,
//   fully deterministic.
// - One test uses a REAL temp-file database to prove the other half of the
//   contract: WAL-backed durability across close/reopen (which also proves
//   schema_migrations makes re-running migrations on an existing file a
//   no-op).
// ============================================================================
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProfileRow } from './db.js';
import { Store, __test } from './db.js';
import { AUTH, CLAIM_ALPHABET, isValidClaimCode, isValidToken, SAVES, STATS } from '@platform/shared';

const GAME = 'rift';

// ---- lifecycle ----------------------------------------------------------------

let tracked: Store[] = [];

afterEach(() => {
  for (const s of tracked) s.close();
  tracked = [];
});

function memoryStore(): Store {
  const s = new Store(null);
  tracked.push(s);
  return s;
}

// ---- degradation ---------------------------------------------------------------

describe('degraded mode', () => {
  it('a null dbPath means the in-memory shim: degraded === true, but fully functional', () => {
    const s = memoryStore();
    expect(s.degraded).toBe(true);
    const { profile } = s.profileBySig('sig-a');
    expect(s.profileById(profile.id)).not.toBeNull(); // works anyway
  });

  it('an impossible dbPath degrades instead of throwing', () => {
    const s = new Store('/dev/null/sub/x.db');
    tracked.push(s);
    expect(s.degraded).toBe(true);
    // and it behaves like a real (empty) store, not a husk
    const { profile, created } = s.profileBySig('sig-b');
    expect(created).toBe(true);
    expect(s.putSave(profile.id, GAME, 'slot0', 0, '{}', 2)).toEqual({ ok: true, rev: 1 });
  });
});

// ---- file mode: durability across reopen ----------------------------------------

describe('file-backed mode (real sqlite file)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fps-store-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('healthy flag, and data survives close/reopen (WAL + migration idempotence)', () => {
    const path = join(dir, 'store.db');
    const s1 = new Store(path);
    tracked.push(s1);
    expect(s1.degraded).toBe(false);

    const { profile } = s1.profileBySig('device-sig');
    const token = s1.mintToken(profile.id);
    s1.putSave(profile.id, GAME, 'best', 0, '{"hp":10}', 9);

    s1.close();

    const s2 = new Store(path); // second open must migrate-skip cleanly
    tracked.push(s2);
    expect(s2.degraded).toBe(false);
    expect(s2.profileIdByToken(token)).toBe(profile.id);
    expect(s2.getSave(profile.id, GAME, 'best')?.data).toBe('{"hp":10}');
    // same sig still resolves to the SAME profile (no duplicate identity)
    expect(s2.profileBySig('device-sig')).toEqual({ profile, created: false });
  });
});

// ---- profiles + sigs ------------------------------------------------------------

describe('profiles', () => {
  it('profileBySig creates once, then reuses the same profile', () => {
    const s = memoryStore();
    const first = s.profileBySig('sig-x');
    expect(first.created).toBe(true);
    expect(first.profile.name.length).toBeGreaterThan(0);

    const second = s.profileBySig('sig-x');
    expect(second.created).toBe(false);
    expect(second.profile).toEqual(first.profile);

    // different sig => different profile
    expect(s.profileBySig('sig-y').profile.id).not.toBe(first.profile.id);
  });

  it('profileById / renameProfile / unknown-id null', () => {
    const s = memoryStore();
    const { profile } = s.profileBySig('sig-n');
    expect(s.profileById(profile.id)).toEqual(profile);
    expect(s.profileById('nope')).toBeNull();

    s.renameProfile(profile.id, 'Ada');
    const renamed: ProfileRow | null = s.profileById(profile.id);
    expect(renamed?.name).toBe('Ada');
    expect(renamed?.id).toBe(profile.id);
    expect(renamed?.createdAt).toBe(profile.createdAt);
  });

  it('linkSig binds a second device to an existing profile', () => {
    const s = memoryStore();
    const { profile } = s.profileBySig('phone');
    s.linkSig('tablet', profile.id);
    expect(s.profileBySig('tablet')).toEqual({ profile, created: false });
    // re-linking the same sig moves it (idempotent upsert)
    const other = s.profileBySig('laptop').profile;
    s.linkSig('tablet', other.id);
    expect(s.profileBySig('tablet').profile.id).toBe(other.id);
  });

  it('linkSig to a nonexistent profile throws (FK enforced), never silently succeeds', () => {
    const s = memoryStore();
    expect(() => s.linkSig('ghost-sig', 'ghost-profile')).toThrow();
    expect(s.profileBySig('ghost-sig').created).toBe(true); // nothing was linked
  });
});

// ---- tokens -----------------------------------------------------------------------

describe('tokens', () => {
  it('mintToken yields a valid 43-char base64url token that resolves back to the profile', () => {
    const s = memoryStore();
    const { profile } = s.profileBySig('sig-t');
    const t1 = s.mintToken(profile.id);
    expect(isValidToken(t1)).toBe(true);
    expect(t1).toHaveLength(43); // ceil(AUTH.tokenBytes/3)*4 = 44, unpadded = 43
    expect(s.profileIdByToken(t1)).toBe(profile.id);

    // old tokens stay valid after minting another one
    const t2 = s.mintToken(profile.id);
    expect(t2).not.toBe(t1);
    expect(s.profileIdByToken(t1)).toBe(profile.id);
    expect(s.profileIdByToken(t2)).toBe(profile.id);
  });

  it('unknown tokens resolve to null', () => {
    const s = memoryStore();
    expect(s.profileIdByToken('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });
});

// ---- claim codes -------------------------------------------------------------------

describe('claim codes', () => {
  it('mintClaimCode produces a 6-char code from CLAIM_ALPHABET; consume returns the profile exactly once', () => {
    const s = memoryStore();
    const { profile } = s.profileBySig('sig-c');

    const code = s.mintClaimCode(profile.id);
    expect(code).toHaveLength(AUTH.claimCodeLen);
    expect(isValidClaimCode(code)).toBe(true);
    expect([...code].every((c) => CLAIM_ALPHABET.includes(c))).toBe(true);

    expect(s.consumeClaimCode(code)).toBe(profile.id); // first use wins
    expect(s.consumeClaimCode(code)).toBeNull(); // reuse rejected
  });

  it('unknown codes consume to null', () => {
    const s = memoryStore();
    expect(s.consumeClaimCode('ZZZZ99')).toBeNull();
  });

  it('an expired code consumes to null (planted via __test.insertClaimCode)', () => {
    const s = memoryStore();
    const { profile } = s.profileBySig('sig-e');

    __test.insertClaimCode(s, 'OLD123', profile.id, Date.now() - 1); // already expired
    expect(s.consumeClaimCode('OLD123')).toBeNull();

    __test.insertClaimCode(s, 'NEW123', profile.id, Date.now() + AUTH.claimTtlMs); // still live
    expect(s.consumeClaimCode('NEW123')).toBe(profile.id);
  });
});

// ---- saves --------------------------------------------------------------------------

describe('saves: compare-and-set', () => {
  it('first write requires expectedRev 0 and lands at rev 1', () => {
    const s = memoryStore();
    const { profile } = s.profileBySig('sig-s');
    expect(s.getSave(profile.id, GAME, 'best')).toBeNull();

    expect(s.putSave(profile.id, GAME, 'best', 0, '{"lvl":1}', 8)).toEqual({ ok: true, rev: 1 });

    const row = s.getSave(profile.id, GAME, 'best');
    expect(row).toMatchObject({ slot: 'best', rev: 1, data: '{"lvl":1}', size: 8 });
    expect(row?.updatedAt).toBeGreaterThan(0);
  });

  it('CAS conflicts report the CURRENT rev, never write', () => {
    const s = memoryStore();
    const { profile } = s.profileBySig('sig-k');
    s.putSave(profile.id, GAME, 'slot', 0, 'v1', 2); // now rev 1

    expect(s.putSave(profile.id, GAME, 'slot', 0, 'lost', 4)).toEqual({ ok: false, rev: 1 });
    expect(s.putSave(profile.id, GAME, 'slot', 7, 'lost', 4)).toEqual({ ok: false, rev: 1 });
    expect(s.getSave(profile.id, GAME, 'slot')?.data).toBe('v1'); // untouched

    expect(s.putSave(profile.id, GAME, 'slot', 1, 'v2', 2)).toEqual({ ok: true, rev: 2 });
    expect(s.getSave(profile.id, GAME, 'slot')).toMatchObject({ rev: 2, data: 'v2' });

    // absent slot with nonzero expectation conflicts at the "absent" rev 0
    expect(s.putSave(profile.id, GAME, 'ghost', 3, 'x', 1)).toEqual({ ok: false, rev: 0 });
    expect(s.getSave(profile.id, GAME, 'ghost')).toBeNull();
  });

  it('oversized payloads are rejected with quota (boundary: maxBytes itself fits)', () => {
    const s = memoryStore();
    const { profile } = s.profileBySig('sig-q');
    const big = 'x'.repeat(SAVES.maxBytes);
    expect(s.putSave(profile.id, GAME, 'edge', 0, big, SAVES.maxBytes)).toEqual({ ok: true, rev: 1 });
    expect(s.putSave(profile.id, GAME, 'over', 0, big, SAVES.maxBytes + 1)).toBe('quota');
    expect(s.getSave(profile.id, GAME, 'over')).toBeNull();
  });

  it('slots cap at SAVES.maxSlots; updates to existing slots still work when full; delete frees a slot', () => {
    const s = memoryStore();
    const { profile } = s.profileBySig('sig-f');
    for (let i = 0; i < SAVES.maxSlots; i++) {
      expect(s.putSave(profile.id, GAME, `s${i}`, 0, '"ok"', 4)).toEqual({ ok: true, rev: 1 });
    }
    expect(s.putSave(profile.id, GAME, 'overflow', 0, '"no"', 4)).toBe('slots_full');

    // rewriting an EXISTING slot is never slots_full
    expect(s.putSave(profile.id, GAME, 's0', 1, '"upd"', 5)).toEqual({ ok: true, rev: 2 });

    expect(s.deleteSave(profile.id, GAME, 's1')).toBe(true);
    expect(s.deleteSave(profile.id, GAME, 's1')).toBe(false);
    expect(s.getSave(profile.id, GAME, 's1')).toBeNull();
    // freed slot accepts a fresh write at rev 1 again
    expect(s.putSave(profile.id, GAME, 'fresh', 0, '"in"', 4)).toEqual({ ok: true, rev: 1 });
  });

  it('listSaves returns every slot for one game only', () => {
    const s = memoryStore();
    const { profile } = s.profileBySig('sig-l');
    s.putSave(profile.id, GAME, 'a', 0, '1', 1);
    s.putSave(profile.id, GAME, 'b', 0, '2', 1);
    s.putSave(profile.id, 'bank', 'z', 0, '3', 1);

    const list = s.listSaves(profile.id, GAME);
    expect(list.map((r) => r.slot).sort()).toEqual(['a', 'b']);
    expect(list.every((r) => r.size === 1 && r.rev === 1)).toBe(true);
    expect(s.listSaves(profile.id, 'nothing')).toEqual([]);
  });
});

// ---- stats ---------------------------------------------------------------------------

describe('stats', () => {
  it('addStats accumulates per key, isolated per game', () => {
    const s = memoryStore();
    const { profile } = s.profileBySig('sig-st');
    s.addStats(profile.id, GAME, { kills: 3 });
    s.addStats(profile.id, GAME, { kills: 2, deaths: 1 });
    s.addStats(profile.id, 'bank', { kills: 100 });

    expect(s.statsFor(profile.id, GAME)).toEqual([
      { gameId: GAME, key: 'deaths', value: 1 },
      { gameId: GAME, key: 'kills', value: 5 },
    ]);
    expect(s.statsFor(profile.id, 'bank')).toEqual([{ gameId: 'bank', key: 'kills', value: 100 }]);
    expect(s.statsFor(profile.id).map((r) => r.value).sort((a, b) => b - a)).toEqual([100, 5, 1]);
    expect(s.statsFor('nobody', GAME)).toEqual([]);
  });

  it('values clamp to ±STATS.maxValue and non-finite deltas are ignored', () => {
    const s = memoryStore();
    const { profile } = s.profileBySig('sig-cl');
    s.addStats(profile.id, GAME, { score: STATS.maxValue });
    s.addStats(profile.id, GAME, { score: 5 }); // would exceed
    s.addStats(profile.id, GAME, { debt: -STATS.maxValue });
    s.addStats(profile.id, GAME, { debt: -1 });
    s.addStats(profile.id, GAME, { broken: NaN, alsoBroken: Infinity });

    expect(s.statsFor(profile.id, GAME)).toEqual([
      { gameId: GAME, key: 'debt', value: -STATS.maxValue },
      { gameId: GAME, key: 'score', value: STATS.maxValue },
    ]);
  });
});
