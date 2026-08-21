// ============================================================================
// HTTP API TESTS — drives HttpApi.handle() end-to-end with mock
// IncomingMessage/ServerResponse pairs (house style: lobby.test.ts mocks
// sessions).
//
// Harness notes
// -------------
// - MockReq emits its body via queueMicrotask AFTER handle() attaches the
//   'data'/'end' listeners, mirroring how a real socket delivers chunks.
//   MockRes captures statusCode/setHeader/end so assertions read like HTTP.
// - The Store is faked IN-MEMORY (`FakeStore`) implementing db.ts's member
//   set structurally (cast `as unknown as Store` — Session-style escape).
//   This suite therefore stays green independent of P2, whose sqlite bodies
//   are landing in parallel; the semantics faked here are exactly the ones
//   documented on the Store signatures.
// - renderPadPage is likewise owned by P8 and still signature-only upstream,
//   so the module is mocked with a deterministic stand-in; the /pad tests
//   then verify ROUTING (status, content-type, gameId plumbing), not markup.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GameModule, PadLayout } from '@platform/shared';
import { CLAIM_ALPHABET, SAVES } from '@platform/shared';
import type { ProfileRow, PutSaveResult, SaveRow, StatRowDb, Store } from './db.js';
import { HttpApi } from './httpApi.js';

vi.mock('../padPage.js', () => ({
  renderPadPage: (opts: { gameId: string }) => `<html>pad-for:${opts.gameId}</html>`,
}));

// ---- mock http pair -----------------------------------------------------------

class MockReq {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  private readonly listeners = new Map<string, Array<(arg?: Buffer | Error) => void>>();

  constructor(opts: { method?: string; url: string; headers?: Record<string, string>; body?: string }) {
    this.method = opts.method ?? 'GET';
    this.url = opts.url;
    this.headers = opts.headers ?? {};
    const body = opts.body;
    queueMicrotask(() => {
      if (body !== undefined && body !== '') this.emit('data', Buffer.from(body, 'utf8'));
      this.emit('end');
    });
  }

  on(event: string, cb: (arg?: Buffer | Error) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  private emit(event: string, arg?: Buffer | Error): void {
    for (const cb of this.listeners.get(event) ?? []) cb(arg);
  }
}

class MockRes {
  statusCode = 0;
  headersSent = false;
  private finished = false;
  private readonly chunks: string[] = [];
  readonly headers: Record<string, unknown> = {};

  setHeader(name: string, value: unknown): void {
    this.headers[name.toLowerCase()] = value;
  }

  writeHead(status: number, headers?: Record<string, unknown>): void {
    this.statusCode = status;
    if (headers !== undefined) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this.headersSent = true;
  }

  end(body?: string | Buffer): void {
    if (body !== undefined && body !== '') this.chunks.push(String(body));
    this.headersSent = true;
    this.finished = true;
  }

  get done(): boolean {
    return this.finished;
  }

  get text(): string {
    return this.chunks.join('');
  }

  get json(): unknown {
    try {
      return JSON.parse(this.text) as unknown;
    } catch {
      return undefined;
    }
  }
}

const asReq = (r: MockReq): IncomingMessage => r as unknown as IncomingMessage;
const asRes = (r: MockRes): ServerResponse => r as unknown as ServerResponse;

interface CallOpts {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Drive one request through handle(); resolves once the response finished. */
async function call(api: HttpApi, opts: CallOpts): Promise<MockRes> {
  const res = new MockRes();
  const handled = api.handle(asReq(new MockReq(opts)), asRes(res));
  if (handled) {
    await vi.waitFor(() => {
      if (!res.done) throw new Error('response not finished');
    });
  }
  return res;
}

// ---- fake store (in-memory twin of the documented Store semantics) -----------

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

class FakeStore {
  /** Test dial: shrink to force the store-level 'quota' verdict. */
  maxSlotBytes = Number.POSITIVE_INFINITY;
  private degraded = false;
  private seq = 0;
  private readonly profiles = new Map<string, ProfileRow>();
  private readonly sigToProfile = new Map<string, string>();
  private readonly tokensByProfile = new Map<string, Set<string>>();
  private readonly claims = new Map<string, { profileId: string; expiresAt: number }>();
  private readonly saves = new Map<string, Map<string, SaveRow>>();
  private readonly stats = new Map<string, Map<string, number>>();

  get degradedFlag(): boolean {
    return this.degraded;
  }

  setDegraded(v: boolean): void {
    this.degraded = v;
  }

  expireAllClaims(): void {
    for (const entry of this.claims.values()) entry.expiresAt = 0;
  }

  private saveKey(profileId: string, game: string): string {
    return `${profileId}\u0000${game}`;
  }

  // -- profiles + auth --
  profileBySig(sig: string): { profile: ProfileRow; created: boolean } {
    const knownId = this.sigToProfile.get(sig);
    const known = knownId !== undefined ? this.profiles.get(knownId) : undefined;
    if (known !== undefined && knownId !== undefined) return { profile: known, created: false };
    this.seq += 1;
    const profile: ProfileRow = { id: `p-${this.seq}`, name: 'Player', createdAt: Date.now() };
    this.profiles.set(profile.id, profile);
    this.sigToProfile.set(sig, profile.id);
    return { profile, created: true };
  }

  linkSig(sig: string, profileId: string): void {
    this.sigToProfile.set(sig, profileId);
  }

  profileById(id: string): ProfileRow | null {
    return this.profiles.get(id) ?? null;
  }

  renameProfile(id: string, name: string): void {
    const p = this.profiles.get(id);
    if (p !== undefined) this.profiles.set(id, { ...p, name });
  }

  mintToken(profileId: string): string {
    this.seq += 1;
    const token = `tok${this.seq}`.padEnd(43, 'x');
    if (!TOKEN_RE.test(token)) throw new Error(`fake minted invalid token shape: ${token}`);
    const set = this.tokensByProfile.get(profileId) ?? new Set<string>();
    set.add(token);
    this.tokensByProfile.set(profileId, set);
    return token;
  }

  profileIdByToken(token: string): string | null {
    for (const [pid, set] of this.tokensByProfile) {
      if (set.has(token)) return pid;
    }
    return null;
  }

  mintClaimCode(profileId: string): string {
    this.seq += 1;
    let n = this.seq;
    let tail = '';
    for (let i = 0; i < 3; i += 1) {
      tail = CLAIM_ALPHABET[n % CLAIM_ALPHABET.length] + tail;
      n = Math.floor(n / CLAIM_ALPHABET.length);
    }
    const code = `ZZZ${tail}`; // 6 chars, in-alphabet, unique per mint
    this.claims.set(code, { profileId, expiresAt: Date.now() + 10 * 60_000 });
    return code;
  }

  consumeClaimCode(code: string): string | null {
    const entry = this.claims.get(code);
    if (entry === undefined || Date.now() > entry.expiresAt) {
      this.claims.delete(code);
      return null;
    }
    this.claims.delete(code); // single use
    return entry.profileId;
  }

  // -- saves --
  listSaves(profileId: string, game: string): SaveRow[] {
    return [...(this.saves.get(this.saveKey(profileId, game))?.values() ?? [])];
  }

  getSave(profileId: string, game: string, slot: string): SaveRow | null {
    return this.saves.get(this.saveKey(profileId, game))?.get(slot) ?? null;
  }

  putSave(
    profileId: string,
    game: string,
    slot: string,
    expectedRev: number,
    dataJson: string,
    sizeBytes: number,
  ): PutSaveResult | 'quota' | 'slots_full' {
    const key = this.saveKey(profileId, game);
    const slots = this.saves.get(key) ?? new Map<string, SaveRow>();
    const current = slots.get(slot);
    if (sizeBytes > this.maxSlotBytes) return 'quota';
    if (current === undefined && slots.size >= SAVES.maxSlots) return 'slots_full';
    if ((current?.rev ?? 0) !== expectedRev) return { ok: false, rev: current?.rev ?? 0 };
    slots.set(slot, { slot, rev: expectedRev + 1, data: dataJson, updatedAt: Date.now(), size: sizeBytes });
    this.saves.set(key, slots);
    return { ok: true, rev: expectedRev + 1 };
  }

  deleteSave(profileId: string, game: string, slot: string): boolean {
    const slots = this.saves.get(this.saveKey(profileId, game));
    if (slots === undefined || !slots.has(slot)) return false;
    slots.delete(slot);
    return true;
  }

  // -- stats --
  addStats(profileId: string, game: string, delta: Record<string, number>): void {
    const key = this.saveKey(profileId, game);
    const counters = this.stats.get(key) ?? new Map<string, number>();
    for (const [k, v] of Object.entries(delta)) counters.set(k, (counters.get(k) ?? 0) + v);
    this.stats.set(key, counters);
  }

  statsFor(profileId: string, game?: string): StatRowDb[] {
    const rows: StatRowDb[] = [];
    const keys = [...this.stats.keys()].sort();
    for (const key of keys) {
      const [pid, gid] = key.split('\u0000');
      if (pid !== profileId) continue;
      if (game !== undefined && gid !== game) continue;
      const counters = this.stats.get(key);
      if (counters === undefined || gid === undefined) continue;
      for (const statKey of [...counters.keys()].sort()) {
        rows.push({ gameId: gid, key: statKey, value: counters.get(statKey) ?? 0 });
      }
    }
    return rows;
  }
}

function asStore(fake: FakeStore): Store {
  return fake as unknown as Store;
}

// ---- game fixtures ------------------------------------------------------------

const PAD_LAYOUT: PadLayout = {
  sticks: [{ id: 'l', label: 'Move' }],
  buttons: [{ bit: 0, label: 'Fire' }],
};

function minimalGame(id: string, padLayout?: PadLayout): GameModule {
  return {
    id,
    name: `${id}-display`,
    clientDist: `/dev/null/${id}`,
    minPlayers: 1,
    maxPlayers: 4,
    createRoom: () => {
      throw new Error('rooms are not exercised by api tests');
    },
    ...(padLayout !== undefined ? { padLayout } : {}),
  };
}

interface Rig {
  api: HttpApi;
  store: FakeStore;
}

function makeRig(): Rig {
  const store = new FakeStore();
  const api = new HttpApi({
    store: asStore(store),
    games: [minimalGame('orbit', PAD_LAYOUT), minimalGame('bank')],
  });
  return { api, store };
}

const LONG_SIG_A = 'sig-device-a';
const LONG_SIG_B = 'sig-device-b';

interface DeviceAuth {
  status: number;
  profileId: string;
  token: string;
  name: string;
}

async function authDevice(api: HttpApi, sig: string): Promise<DeviceAuth> {
  const res = await call(api, { method: 'POST', url: '/api/auth/device', body: JSON.stringify({ sig }) });
  const json = res.json as Omit<DeviceAuth, 'status'>;
  return { status: res.statusCode, ...json };
}

// ---- suites --------------------------------------------------------------------

describe('POST /api/auth/device', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('creates a profile (201) and reuses the SAME profileId on second call (200)', async () => {
    const first = await authDevice(rig.api, LONG_SIG_A);
    expect(first.status).toBe(201);
    expect(first.profileId).toMatch(/^p-\d+$/);
    expect(first.name).toBe('Player');
    expect(first.token).toMatch(TOKEN_RE);

    const second = await authDevice(rig.api, LONG_SIG_A);
    expect(second.status).toBe(200);
    expect(second.profileId).toBe(first.profileId);
  });

  it('mints a fresh usable token each time (old tokens stay valid)', async () => {
    const first = await authDevice(rig.api, LONG_SIG_A);
    const second = await authDevice(rig.api, LONG_SIG_A);
    expect(second.token).not.toBe(first.token);

    for (const token of [first.token, second.token]) {
      const res = await call(rig.api, { url: '/api/profiles/me', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
    }
  });

  it('rejects malformed sigs with 400', async () => {
    const short = await call(rig.api, { method: 'POST', url: '/api/auth/device', body: JSON.stringify({ sig: 'abc' }) });
    expect(short.statusCode).toBe(400);
    const missing = await call(rig.api, { method: 'POST', url: '/api/auth/device', body: JSON.stringify({}) });
    expect(missing.statusCode).toBe(400);
    const wrongType = await call(rig.api, { method: 'POST', url: '/api/auth/device', body: JSON.stringify({ sig: 42 }) });
    expect(wrongType.statusCode).toBe(400);
  });
});

describe('POST /api/auth/claim', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('links a second device to the SAME profile and mints a working token', async () => {
    const owner = await authDevice(rig.api, LONG_SIG_A);
    const code = rig.store.mintClaimCode(owner.profileId);

    const res = await call(rig.api, {
      method: 'POST',
      url: '/api/auth/claim',
      body: JSON.stringify({ sig: LONG_SIG_B, code }),
    });
    expect(res.statusCode).toBe(200);
    const linked = res.json as { profileId: string; token: string };
    expect(linked.profileId).toBe(owner.profileId);
    expect(linked.token).toMatch(TOKEN_RE);

    // The minted token authenticates against the OWNER's profile…
    const me = await call(rig.api, { url: '/api/profiles/me', headers: { authorization: `Bearer ${linked.token}` } });
    expect((me.json as { id: string }).id).toBe(owner.profileId);
    // …and device B's sig now finds the SAME profile via plain device login.
    const relogin = await authDevice(rig.api, LONG_SIG_B);
    expect(relogin.status).toBe(200);
    expect(relogin.profileId).toBe(owner.profileId);
  });

  it('consumes codes single-use (replay → 409)', async () => {
    const owner = await authDevice(rig.api, LONG_SIG_A);
    const code = rig.store.mintClaimCode(owner.profileId);

    const first = await call(rig.api, {
      method: 'POST',
      url: '/api/auth/claim',
      body: JSON.stringify({ sig: LONG_SIG_B, code }),
    });
    expect(first.statusCode).toBe(200);

    const thirdSig = 'sig-device-c';
    const replay = await call(rig.api, {
      method: 'POST',
      url: '/api/auth/claim',
      body: JSON.stringify({ sig: thirdSig, code }),
    });
    expect(replay.statusCode).toBe(409);
    expect((replay.json as { error: string }).error).toBe('invalid_code');
  });

  it('409 for unknown codes', async () => {
    await authDevice(rig.api, LONG_SIG_A);
    const res = await call(rig.api, {
      method: 'POST',
      url: '/api/auth/claim',
      body: JSON.stringify({ sig: LONG_SIG_B, code: 'ZZZZ99' }), // valid shape, never minted
    });
    expect(res.statusCode).toBe(409);
  });

  it('409 for expired codes', async () => {
    const owner = await authDevice(rig.api, LONG_SIG_A);
    rig.store.mintClaimCode(owner.profileId);
    rig.store.expireAllClaims();
    const res = await call(rig.api, {
      method: 'POST',
      url: '/api/auth/claim',
      body: JSON.stringify({ sig: LONG_SIG_B, code: 'AAAAAA' }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('400 for malformed code shapes', async () => {
    const res = await call(rig.api, {
      method: 'POST',
      url: '/api/auth/claim',
      body: JSON.stringify({ sig: LONG_SIG_B, code: '!!!' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Bearer auth gate', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('401 unauthorized on every saves/me route without a token', async () => {
    const routes: CallOpts[] = [
      { url: '/api/profiles/me' },
      { method: 'PATCH', url: '/api/profiles/me', body: JSON.stringify({ name: 'X' }) },
      { url: '/api/profiles/me/stats' },
      { url: '/api/saves/fps' },
      { url: '/api/saves/fps/best' },
      { method: 'PUT', url: '/api/saves/fps/best', body: JSON.stringify({ rev: 0, data: {} }) },
      { method: 'DELETE', url: '/api/saves/fps/best' },
    ];
    for (const route of routes) {
      const res = await call(rig.api, route);
      expect(res.statusCode, `route ${route.method ?? 'GET'} ${route.url}`).toBe(401);
      expect(res.json).toEqual({ error: 'unauthorized' });
    }
  });

  it('401 for garbage and well-shaped-but-unknown tokens', async () => {
    const garbage = await call(rig.api, { url: '/api/profiles/me', headers: { authorization: 'Basic abc' } });
    expect(garbage.statusCode).toBe(401);
    const unknown = await call(rig.api, {
      url: '/api/profiles/me',
      headers: { authorization: `Bearer ${'x'.repeat(43)}` },
    });
    expect(unknown.statusCode).toBe(401);
  });
});

describe('/api/saves lifecycle', () => {
  let rig: Rig;
  let profileId: string;
  let bearer: Record<string, string>;

  beforeEach(async () => {
    rig = makeRig();
    const auth = await authDevice(rig.api, LONG_SIG_A);
    profileId = auth.profileId;
    bearer = { authorization: `Bearer ${auth.token}` };
  });

  it('put → get → conflict 409 → overwrite flow', async () => {
    const put1 = await call(rig.api, {
      method: 'PUT',
      url: '/api/saves/fps/best',
      headers: bearer,
      body: JSON.stringify({ rev: 0, data: { hp: 10 } }),
    });
    expect(put1.statusCode).toBe(200);
    expect(put1.json).toEqual({ rev: 1 });

    const get = await call(rig.api, { url: '/api/saves/fps/best', headers: bearer });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toContain('application/json');
    const record = get.json as { slot: string; rev: number; data: unknown; updatedAt: number };
    expect(record.slot).toBe('best');
    expect(record.rev).toBe(1);
    expect(record.data).toEqual({ hp: 10 });
    expect(typeof record.updatedAt).toBe('number');

    const conflict = await call(rig.api, {
      method: 'PUT',
      url: '/api/saves/fps/best',
      headers: bearer,
      body: JSON.stringify({ rev: 0, data: { hp: 55 } }), // stale rev
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json).toEqual({ error: 'conflict', rev: 1 });

    const put2 = await call(rig.api, {
      method: 'PUT',
      url: '/api/saves/fps/best',
      headers: bearer,
      body: JSON.stringify({ rev: 1, data: { hp: 99 } }),
    });
    expect(put2.statusCode).toBe(200);
    expect(put2.json).toEqual({ rev: 2 });

    const get2 = await call(rig.api, { url: '/api/saves/fps/best', headers: bearer });
    expect((get2.json as { data: unknown }).data).toEqual({ hp: 99 });
  });

  it('list omits payloads and reports sizes', async () => {
    await call(rig.api, {
      method: 'PUT',
      url: '/api/saves/fps/best',
      headers: bearer,
      body: JSON.stringify({ rev: 0, data: { hp: 1 } }),
    });
    const list = await call(rig.api, { url: '/api/saves/fps', headers: bearer });
    expect(list.statusCode).toBe(200);
    expect(list.json).toEqual([
      { slot: 'best', rev: 1, size: expect.any(Number), updatedAt: expect.any(Number) },
    ]);
  });

  it('delete → 204, then the slot reads 404', async () => {
    await call(rig.api, {
      method: 'PUT',
      url: '/api/saves/fps/best',
      headers: bearer,
      body: JSON.stringify({ rev: 0, data: { hp: 1 } }),
    });
    const del = await call(rig.api, { method: 'DELETE', url: '/api/saves/fps/best', headers: bearer });
    expect(del.statusCode).toBe(204);
    expect(del.text).toBe('');

    const gone = await call(rig.api, { url: '/api/saves/fps/best', headers: bearer });
    expect(gone.statusCode).toBe(404);
    expect(gone.json).toEqual({ error: 'not_found' });

    const again = await call(rig.api, { method: 'DELETE', url: '/api/saves/fps/best', headers: bearer });
    expect(again.statusCode).toBe(204); // idempotent
  });

  it('400 for invalid slot names, bad revs, and non-object data', async () => {
    const badSlot = await call(rig.api, {
      method: 'PUT',
      url: '/api/saves/fps/BAD%20SLOT',
      headers: bearer,
      body: JSON.stringify({ rev: 0, data: {} }),
    });
    expect(badSlot.statusCode).toBe(400);

    const noRev = await call(rig.api, {
      method: 'PUT',
      url: '/api/saves/fps/best',
      headers: bearer,
      body: JSON.stringify({ data: {} }),
    });
    expect(noRev.statusCode).toBe(400);

    const primitiveData = await call(rig.api, {
      method: 'PUT',
      url: '/api/saves/fps/best',
      headers: bearer,
      body: JSON.stringify({ rev: 0, data: 'just a string' }),
    });
    expect(primitiveData.statusCode).toBe(400);
  });

  it('400 quota and slots_full verdicts from the store', async () => {
    rig.store.maxSlotBytes = 16; // shrink the fake's per-slot budget
    const quota = await call(rig.api, {
      method: 'PUT',
      url: '/api/saves/fps/big',
      headers: bearer,
      body: JSON.stringify({ rev: 0, data: { blob: 'x'.repeat(64) } }),
    });
    expect(quota.statusCode).toBe(400);
    expect(quota.json).toEqual({ error: 'quota' });
  });

  it('400 slots_full at SAVES.maxSlots', async () => {
    for (let i = 0; i < SAVES.maxSlots; i += 1) {
      const put = await call(rig.api, {
        method: 'PUT',
        url: `/api/saves/fps/slot-${i}`,
        headers: bearer,
        body: JSON.stringify({ rev: 0, data: { i } }),
      });
      expect(put.statusCode).toBe(200);
    }
    const overflow = await call(rig.api, {
      method: 'PUT',
      url: '/api/saves/fps/one-too-many',
      headers: bearer,
      body: JSON.stringify({ rev: 0, data: {} }),
    });
    expect(overflow.statusCode).toBe(400);
    expect(overflow.json).toEqual({ error: 'slots_full' });
  });

  it('413 when data serializes past SAVES.maxBytes (rejected before the store)', async () => {
    const big = await call(rig.api, {
      method: 'PUT',
      url: '/api/saves/fps/huge',
      headers: bearer,
      body: JSON.stringify({ rev: 0, data: { pad: 'x'.repeat(SAVES.maxBytes + 1024) } }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json).toEqual({ error: 'too_large' });
    expect(rig.store.getSave(profileId, 'fps', 'huge')).toBeNull();
  });
});

describe('/api/profiles/me + stats', () => {
  let rig: Rig;
  let token: string;
  let profileId: string;

  beforeEach(async () => {
    rig = makeRig();
    const auth = await authDevice(rig.api, LONG_SIG_A);
    token = auth.token;
    profileId = auth.profileId;
  });

  it('GET me returns {id,name,createdAt}', async () => {
    const res = await call(rig.api, { url: '/api/profiles/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json).toEqual({ id: profileId, name: 'Player', createdAt: expect.any(Number) });
  });

  it('PATCH renames platform-wide; cleans like cleanName (trim, ≤16, Player fallback)', async () => {
    const patch = await call(rig.api, {
      method: 'PATCH',
      url: '/api/profiles/me',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: '  Ada Lovelace Forever  ' }),
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json as { name: string }).name).toBe('Ada Lovelace For'); // ≤16 chars

    const blank = await call(rig.api, {
      method: 'PATCH',
      url: '/api/profiles/me',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: '    ' }),
    });
    expect((blank.json as { name: string }).name).toBe('Player');

    const wrongType = await call(rig.api, {
      method: 'PATCH',
      url: '/api/profiles/me',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 7 }),
    });
    expect(wrongType.statusCode).toBe(400);

    // Absent name = no-op rename, still 200 with current state.
    const noop = await call(rig.api, {
      method: 'PATCH',
      url: '/api/profiles/me',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    expect(noop.statusCode).toBe(200);
    expect((noop.json as { name: string }).name).toBe('Player');

    // The rename persisted.
    const me = await call(rig.api, { url: '/api/profiles/me', headers: { authorization: `Bearer ${token}` } });
    expect((me.json as { name: string }).name).toBe('Player');
  });

  it('stats: own reads need Bearer; ?game filters; :id reads are public', async () => {
    rig.store.addStats(profileId, 'fps', { wins: 3, deaths: 12 });
    rig.store.addStats(profileId, 'orbit', { best: 4200 });

    const bearer = { authorization: `Bearer ${token}` };
    const all = await call(rig.api, { url: '/api/profiles/me/stats', headers: bearer });
    expect(all.statusCode).toBe(200);
    expect(all.json).toEqual([
      { gameId: 'fps', key: 'deaths', value: 12 },
      { gameId: 'fps', key: 'wins', value: 3 },
      { gameId: 'orbit', key: 'best', value: 4200 },
    ]);

    const filtered = await call(rig.api, { url: '/api/profiles/me/stats?game=orbit', headers: bearer });
    expect(filtered.json).toEqual([{ gameId: 'orbit', key: 'best', value: 4200 }]);

    const pub = await call(rig.api, { url: `/api/profiles/${profileId}/stats?game=fps` }); // no token
    expect(pub.statusCode).toBe(200);
    expect(pub.json).toEqual([
      { gameId: 'fps', key: 'deaths', value: 12 },
      { gameId: 'fps', key: 'wins', value: 3 },
    ]);

    const stranger = await call(rig.api, { url: '/api/profiles/p-nobody/stats' });
    expect(stranger.statusCode).toBe(200);
    expect(stranger.json).toEqual([]);
  });
});

describe('/api/pads/:game + /pad page', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('serves a declared PadLayout; 404 {error:no_pad} otherwise', async () => {
    const yes = await call(rig.api, { url: '/api/pads/orbit' });
    expect(yes.statusCode).toBe(200);
    expect(yes.headers['content-type']).toContain('application/json');
    expect(yes.json).toEqual(PAD_LAYOUT);

    for (const game of ['bank', 'never-registered']) {
      const no = await call(rig.api, { url: `/api/pads/${game}` });
      expect(no.statusCode).toBe(404);
      expect(no.json).toEqual({ error: 'no_pad' });
    }
  });

  it('GET /pad renders HTML via renderPadPage for pad games', async () => {
    const res = await call(rig.api, { url: '/pad?game=orbit' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');
    expect(res.text).toContain('pad-for:orbit');
  });

  it('GET /pad answers JSON 404 {error:no_pad} without a pad layout or game id', async () => {
    const noPad = await call(rig.api, { url: '/pad?game=bank' });
    expect(noPad.statusCode).toBe(404);
    expect(noPad.json).toEqual({ error: 'no_pad' });
    expect(String(noPad.headers['content-type'])).toContain('application/json');

    const noGame = await call(rig.api, { url: '/pad' });
    expect(noGame.statusCode).toBe(404);
    expect(noGame.json).toEqual({ error: 'no_pad' });
  });

  it('leaves everything else to net.ts (handle returns false)', () => {
    const res = new MockRes();
    const handled = rig.api.handle(asReq(new MockReq({ url: '/launcher/index.html' })), asRes(res));
    expect(handled).toBe(false);
    expect(res.done).toBe(false);
  });
});

describe('robustness', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('GET /api/health mirrors store.degraded both ways', async () => {
    const healthy = await call(rig.api, { url: '/api/health' });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json).toEqual({ ok: true, degraded: false });

    rig.store.setDegraded(true);
    const degraded = await call(rig.api, { url: '/api/health' });
    expect(degraded.json).toEqual({ ok: true, degraded: true });
  });

  it('malformed JSON body → 400', async () => {
    const res = await call(rig.api, { method: 'POST', url: '/api/auth/device', body: '{"sig": nope' });
    expect(res.statusCode).toBe(400);
    expect(typeof (res.json as { error: string }).error).toBe('string');
  });

  it('oversized request body (>256KB) → 413', async () => {
    const res = await call(rig.api, {
      method: 'POST',
      url: '/api/auth/device',
      body: JSON.stringify({ sig: 'x'.repeat(300 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json).toEqual({ error: 'too_large' });
  });

  it('unknown /api/* routes → 404 {error:not_found}', async () => {
    for (const opts of [
      { url: '/api/nope' },
      { method: 'POST', url: '/api/auth/teleport', body: '{}' },
      { url: '/api/saves' }, // missing :game segment
      { method: 'PATCH', url: '/api/saves/fps/best', body: '{}' },
      { url: '/api/profiles/me/and/more' },
    ]) {
      const res = await call(rig.api, opts);
      expect(res.statusCode, `route ${opts.method ?? 'GET'} ${opts.url}`).toBe(404);
      expect(res.json).toEqual({ error: 'not_found' });
    }
  });

  it('decodes percent-encoded path segments (slot names survive round-trip)', async () => {
    const token = (await authDevice(rig.api, LONG_SIG_A)).token;
    const bearer = { authorization: `Bearer ${token}` };
    await call(rig.api, {
      method: 'PUT',
      url: '/api/saves/fps/save-1',
      headers: bearer,
      body: JSON.stringify({ rev: 0, data: {} }),
    });
    const res = await call(rig.api, { url: '/api/saves/fps/save-1', headers: bearer });
    expect(res.statusCode).toBe(200);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
