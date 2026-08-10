// ============================================================================
// identity.ts unit tests — mint/persist/memoize, legacy name migration, name
// trim/cap, session-pointer round-trip, corruption resilience, and blocked
// (private-mode) storage degradation. Every case drives the public API only;
// __resetIdentityCache() is the one documented test hook (see identity.ts's
// own comment on it: "never call this from game code").
//
// Harness notes
// --------------
// - This suite has no jsdom (see vitest.config.ts) and this tsconfig has no
//   DOM lib, so there is no ambient `Storage` type and `globalThis` has no
//   `localStorage` property to begin with. `testGlobal` (below) is a
//   narrowly-typed view of `globalThis` that adds one back structurally.
//   MemoryStorage is a minimal in-memory fake; ThrowingStorage simulates a
//   browser that blocks storage outright (private mode / cookie policy) so
//   every getItem/setItem call throws, per the contract's "storage is a
//   courtesy, never a dependency" invariant.
// - A single file-level beforeEach/afterEach saves and restores whatever
//   `testGlobal.localStorage` was before this file ran, so the stubbing here
//   never leaks into a sibling test file sharing the same worker. Each
//   describe block's own beforeEach then installs the specific storage (or
//   lack of it) that block needs, and every test starts from
//   __resetIdentityCache() so the module's memoization can't leak between
//   cases either.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanSig } from '@platform/shared';
import {
  __resetIdentityCache,
  cleanName,
  clearSession,
  DEFAULT_NAME,
  IDENTITY_KEY,
  LEGACY_NAME_KEYS,
  loadIdentity,
  loadName,
  loadSession,
  saveName,
  saveSession,
  SESSION_PREFIX,
  SIG_MAX,
  SIG_MIN,
  type SessionRecord,
} from './identity.js';

// ---- typed view of the global, and fake storages -----------------------------

/**
 * The same narrow, structural slice of `localStorage` identity.ts itself
 * declares (its `StorageLike`) — not the DOM's ambient `Storage`. This
 * tsconfig has no DOM lib and deliberately no `"types": ["node"]` either
 * (identity.ts is compiled by both the browser clients and the Node server,
 * so neither ambient global is safe to assume here). Every get/set/delete of
 * `localStorage` in this file routes through `testGlobal` below instead of
 * touching `globalThis.localStorage` directly, which TypeScript would
 * otherwise reject as an unknown index on `typeof globalThis` (TS7017).
 */
interface TestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface TestGlobal {
  localStorage?: TestStorage;
}

const testGlobal = globalThis as unknown as TestGlobal;

/** Minimal in-memory TestStorage — enough surface for identity.ts's
 *  read/write/drop helpers (getItem/setItem/removeItem). */
class MemoryStorage implements TestStorage {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    const v = this.data.get(key);
    return v === undefined ? null : v;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

/** Counts getItem calls, to prove memoization does not re-read storage — not
 *  merely that the re-read happens to produce the same value. */
class CountingStorage extends MemoryStorage {
  getItemCalls = 0;

  override getItem(key: string): string | null {
    this.getItemCalls++;
    return super.getItem(key);
  }
}

/** A storage that throws on every access — private-mode / blocked-cookie
 *  behaviour. identity.ts's read/write/drop helpers try/catch every call, so
 *  nothing here should ever escape to a caller. */
class ThrowingStorage implements TestStorage {
  getItem(): string | null {
    throw new Error('storage blocked');
  }

  removeItem(): void {
    throw new Error('storage blocked');
  }

  setItem(): void {
    throw new Error('storage blocked');
  }
}

function deleteGlobalStorage(): void {
  delete testGlobal.localStorage;
}

// ---- file-level storage save/restore + cache reset --------------------------

let savedDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  savedDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  __resetIdentityCache();
});

afterEach(() => {
  if (savedDescriptor !== undefined) {
    Object.defineProperty(globalThis, 'localStorage', savedDescriptor);
  } else {
    deleteGlobalStorage();
  }
});

// ---- loadIdentity: mint, persist, memoize ------------------------------------

describe('loadIdentity: mint, persist, memoize', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    testGlobal.localStorage = storage;
  });

  it('mints a signature on first call and persists it under play.identity', () => {
    const id = loadIdentity();
    expect(id.sig.length).toBeGreaterThan(0);

    const raw = storage.getItem(IDENTITY_KEY);
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw as string) as { sig: string; name: string };
    expect(persisted.sig).toBe(id.sig);
  });

  it('returns the SAME sig on a second call (memoized — same object, not just equal)', () => {
    const first = loadIdentity();
    const second = loadIdentity();
    expect(second).toBe(first);
    expect(second.sig).toBe(first.sig);
  });

  it('does not re-read storage on the second call (true memoization)', () => {
    const counting = new CountingStorage();
    testGlobal.localStorage = counting;

    // The FIRST call legitimately issues several reads: one for IDENTITY_KEY,
    // plus one per LEGACY_NAME_KEYS entry since migrateLegacyName() scans all
    // of them when the shared record has no name yet (see identity.ts). The
    // memoization guarantee under test is about the SECOND call only: it must
    // add zero further reads, not that the first call reads exactly once.
    loadIdentity();
    const callsAfterFirst = counting.getItemCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    loadIdentity();
    expect(counting.getItemCalls).toBe(callsAfterFirst);
  });

  it('returns the SAME sig after a cache reset (re-read from storage, not re-minted)', () => {
    const first = loadIdentity();
    __resetIdentityCache();
    const second = loadIdentity();
    expect(second).not.toBe(first); // reset forces a fresh object
    expect(second.sig).toBe(first.sig); // but the persisted value survives it
  });

  it('the minted sig satisfies the wire validator bounds and round-trips through cleanSig', () => {
    const { sig } = loadIdentity();
    expect(sig.length).toBeGreaterThanOrEqual(SIG_MIN);
    expect(sig.length).toBeLessThanOrEqual(SIG_MAX);
    expect(cleanSig(sig)).toBe(sig); // not null: the wire validator accepts it unchanged
  });
});

// ---- fresh browser: name is '' not DEFAULT_NAME ------------------------------

describe('fresh browser: name is never pre-filled', () => {
  it("an empty MemoryStorage yields name === '' (never typed one, not DEFAULT_NAME)", () => {
    testGlobal.localStorage = new MemoryStorage();
    const id = loadIdentity();
    expect(id.name).toBe('');
    expect(id.name).not.toBe(DEFAULT_NAME);
  });

  it("no localStorage object at all still yields name === '' and a usable sig", () => {
    deleteGlobalStorage();
    const id = loadIdentity();
    expect(id.name).toBe('');
    expect(id.sig.length).toBeGreaterThanOrEqual(SIG_MIN);
    expect(id.sig.length).toBeLessThanOrEqual(SIG_MAX);
  });
});

// ---- legacy name migration ----------------------------------------------------

describe('legacy name migration', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    testGlobal.localStorage = storage;
  });

  it('seeding only rift.name migrates it into the shared identity on first load', () => {
    storage.setItem('rift.name', 'Ada');
    const id = loadIdentity();
    expect(id.name).toBe('Ada');

    // and it is written into play.identity, not just returned in memory
    const persisted = JSON.parse(storage.getItem(IDENTITY_KEY) as string) as { name: string };
    expect(persisted.name).toBe('Ada');
  });

  it('seeding only stricken.name migrates it into the shared identity on first load', () => {
    storage.setItem('stricken.name', 'Bea');
    expect(loadIdentity().name).toBe('Bea');
  });

  it('respects LEGACY_NAME_KEYS priority order: the first key in the list wins when all are present', () => {
    LEGACY_NAME_KEYS.forEach((key, i) => storage.setItem(key, `Name${i}`));
    expect(loadIdentity().name).toBe('Name0');
  });

  it('respects LEGACY_NAME_KEYS priority order: falls through to the next key when earlier ones are absent', () => {
    for (let i = 1; i < LEGACY_NAME_KEYS.length; i++) {
      const key = LEGACY_NAME_KEYS[i];
      if (key !== undefined) storage.setItem(key, `Name${i}`);
    }
    expect(loadIdentity().name).toBe('Name1');
  });

  it('a name already present in play.identity is never overwritten by a legacy key', () => {
    storage.setItem('rift.name', 'Legacy');
    storage.setItem(IDENTITY_KEY, JSON.stringify({ sig: 'a'.repeat(SIG_MIN), name: 'Current' }));
    expect(loadIdentity().name).toBe('Current');
  });
});

// ---- saveName / loadName -------------------------------------------------------

describe('saveName / loadName', () => {
  beforeEach(() => {
    testGlobal.localStorage = new MemoryStorage();
  });

  it('trims, caps at NAME_MAX, persists, and is visible to a later loadName()', () => {
    saveName('  ' + 'B'.repeat(20) + '  ');
    const expected = 'B'.repeat(16); // NAME_MAX
    expect(loadName()).toBe(expected);
    expect(loadName().length).toBeLessThanOrEqual(16);
  });

  it('preserves the existing sig when the name changes', () => {
    const before = loadIdentity();
    saveName('Nova');
    const after = loadIdentity();
    expect(after.sig).toBe(before.sig);
    expect(after.name).toBe('Nova');
  });

  it('a name of only whitespace stores as the empty string, not DEFAULT_NAME', () => {
    saveName('    ');
    expect(loadName()).toBe('');
  });

  it('is visible to a later loadName() after a cache reset (re-read from storage)', () => {
    saveName('Rio');
    __resetIdentityCache();
    expect(loadName()).toBe('Rio');
  });
});

describe('cleanName (trim/cap/Player fallback)', () => {
  it('trims surrounding whitespace', () => {
    expect(cleanName('  Nova  ')).toBe('Nova');
  });

  it('caps at NAME_MAX characters', () => {
    const long = 'A'.repeat(16 + 10);
    const capped = cleanName(long);
    expect(capped).toBe('A'.repeat(16));
    expect(capped.length).toBe(16);
  });

  it("maps an empty string to DEFAULT_NAME ('Player')", () => {
    expect(cleanName('')).toBe(DEFAULT_NAME);
    expect(DEFAULT_NAME).toBe('Player');
  });

  it('maps a whitespace-only string to DEFAULT_NAME', () => {
    expect(cleanName('   ')).toBe(DEFAULT_NAME);
  });
});

// ---- session pointer: saveSession / loadSession / clearSession ----------------

describe('session pointer (saveSession/loadSession/clearSession)', () => {
  beforeEach(() => {
    testGlobal.localStorage = new MemoryStorage();
  });

  it('round-trips {playerId, roomId, code} through saveSession/loadSession', () => {
    const rec: SessionRecord = { playerId: 'p1', roomId: 'room-1', code: null };
    saveSession('bank', rec);
    expect(loadSession('bank')).toEqual(rec);
  });

  it('round-trips after a cache reset (re-reads from storage, not just the in-memory mirror)', () => {
    const rec: SessionRecord = { playerId: 'p1', roomId: null, code: 'ABCD' };
    saveSession('bank', rec);
    __resetIdentityCache();
    expect(loadSession('bank')).toEqual(rec);
  });

  it('clearSession removes the record; loadSession then returns null', () => {
    const rec: SessionRecord = { playerId: 'p1', roomId: 'room-1', code: null };
    saveSession('bank', rec);
    clearSession('bank');
    expect(loadSession('bank')).toBeNull();
  });

  it('loadSession returns null when there is no record at all', () => {
    expect(loadSession('bank')).toBeNull();
  });

  it('sessions for different game ids are independent (bank vs fps do not collide)', () => {
    const bankRec: SessionRecord = { playerId: 'bank-player', roomId: 'bank-room', code: null };
    const fpsRec: SessionRecord = { playerId: 'fps-player', roomId: null, code: 'WXYZ' };
    saveSession('bank', bankRec);
    saveSession('fps', fpsRec);

    expect(loadSession('bank')).toEqual(bankRec);
    expect(loadSession('fps')).toEqual(fpsRec);

    clearSession('bank');
    expect(loadSession('bank')).toBeNull();
    expect(loadSession('fps')).toEqual(fpsRec); // clearing bank never touches fps
  });

  it('stores each game under its own SESSION_PREFIX + game key', () => {
    const storage = testGlobal.localStorage;
    if (storage === undefined) throw new Error('expected the beforeEach above to have installed a localStorage');
    const rec: SessionRecord = { playerId: 'p1', roomId: null, code: null };
    saveSession('wordbomb', rec);
    expect(storage.getItem(SESSION_PREFIX + 'wordbomb')).not.toBeNull();
  });
});

// ---- corruption resilience ------------------------------------------------------

describe('corruption resilience — nothing here throws, everything degrades sanely', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    testGlobal.localStorage = storage;
  });

  it('play.identity holding invalid JSON does not throw; a fresh identity is minted', () => {
    storage.setItem(IDENTITY_KEY, '{not valid json');
    expect(() => loadIdentity()).not.toThrow();
    const id = loadIdentity();
    expect(id.sig.length).toBeGreaterThanOrEqual(SIG_MIN);
    expect(id.name).toBe('');
  });

  it('play.identity holding a JSON array does not throw; a fresh identity is minted', () => {
    storage.setItem(IDENTITY_KEY, '[1,2,3]');
    expect(() => loadIdentity()).not.toThrow();
    const id = loadIdentity();
    expect(id.sig.length).toBeGreaterThanOrEqual(SIG_MIN);
  });

  it('play.identity holding an object with a too-short sig discards the sig but keeps a valid name', () => {
    storage.setItem(IDENTITY_KEY, JSON.stringify({ sig: 'short', name: 'Nova' }));
    const id = loadIdentity();
    expect(id.sig).not.toBe('short');
    expect(id.sig.length).toBeGreaterThanOrEqual(SIG_MIN);
    expect(id.name).toBe('Nova');
  });

  it('a session record with a missing playerId does not throw and loadSession returns null', () => {
    storage.setItem(SESSION_PREFIX + 'bank', JSON.stringify({ roomId: 'r1', code: null }));
    expect(() => loadSession('bank')).not.toThrow();
    expect(loadSession('bank')).toBeNull();
  });

  it('a session record with an empty playerId does not throw and loadSession returns null', () => {
    storage.setItem(SESSION_PREFIX + 'bank', JSON.stringify({ playerId: '', roomId: 'r1', code: null }));
    expect(() => loadSession('bank')).not.toThrow();
    expect(loadSession('bank')).toBeNull();
  });

  it('a session record holding invalid JSON does not throw and loadSession returns null', () => {
    storage.setItem(SESSION_PREFIX + 'bank', '{not valid json');
    expect(() => loadSession('bank')).not.toThrow();
    expect(loadSession('bank')).toBeNull();
  });
});

// ---- blocked storage: private-mode browsers ----------------------------------

describe('blocked storage (getItem/setItem/removeItem throw — private-mode browsers)', () => {
  beforeEach(() => {
    testGlobal.localStorage = new ThrowingStorage();
  });

  it('loadIdentity() still returns a usable identity when storage throws on every call', () => {
    expect(() => loadIdentity()).not.toThrow();
    const id = loadIdentity();
    expect(id.sig.length).toBeGreaterThanOrEqual(SIG_MIN);
    expect(id.sig.length).toBeLessThanOrEqual(SIG_MAX);
    expect(id.name).toBe('');
  });

  it('saveName/loadName still work within the page lifetime via the in-memory mirror', () => {
    expect(() => saveName('Nova')).not.toThrow();
    expect(loadName()).toBe('Nova');
  });

  it('saveSession/loadSession/clearSession still work within the page lifetime', () => {
    const rec: SessionRecord = { playerId: 'p1', roomId: 'r1', code: null };
    expect(() => saveSession('bank', rec)).not.toThrow();
    expect(loadSession('bank')).toEqual(rec);
    expect(() => clearSession('bank')).not.toThrow();
    expect(loadSession('bank')).toBeNull();
  });

  it('nothing throws out to the caller across a full mint -> name -> session flow', () => {
    expect(() => {
      loadIdentity();
      saveName('Zed');
      saveSession('fps', { playerId: 'p9', roomId: null, code: 'WXYZ' });
      loadSession('fps');
      clearSession('fps');
    }).not.toThrow();
  });
});
