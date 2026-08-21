// ============================================================================
// CloudSaves unit tests — mocked global fetch, no network. Covers the REST
// contract of docs/PLATFORM.md §4.2 as the SDK consumes it: list/get/put
// happy paths, the 409 conflict shape ({ok:false, record:CURRENT}), 401 →
// throw, and the updateSave merge+single-retry path. Bearer header wiring is
// asserted once so token plumbing can't silently break.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudSaves, updateSave } from './saves.js';
import type { SaveRecord } from '@platform/shared';

type FetchCall = { method: string; url: string; body?: unknown; auth?: string | undefined };

/** Minimal scripted fetch: pops one handler per call; records what was sent. */
function scriptFetch(handlers: Array<(call: FetchCall) => { status: number; json?: unknown }>): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fake = vi.fn((_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof _url === 'string' ? _url : String(_url);
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    let body: unknown;
    try {
      body = raw === undefined ? undefined : (JSON.parse(raw) as unknown);
    } catch {
      body = raw;
    }
    const auth = new Headers(init?.headers).get('authorization') ?? undefined;
    const call: FetchCall = { method: init?.method ?? 'GET', url, body, auth };
    calls.push(call);
    const h = handlers.shift();
    if (h === undefined) throw new Error(`unexpected fetch #${calls.length}: ${init?.method} ${url}`);
    const res = h(call);
    return Promise.resolve({
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: () => Promise.resolve(res.json),
    } as Response);
  });
  vi.stubGlobal('fetch', fake);
  return { calls };
}

const TOKEN = 'a'.repeat(43); // isValidToken shape

describe('CloudSaves', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists summaries with the Bearer token attached', async () => {
    const rows = [
      { slot: 'best', rev: 3, updatedAt: 111, size: 42 },
      { slot: 'auto', rev: 1, updatedAt: 222, size: 7 },
    ];
    const { calls } = scriptFetch([() => ({ status: 200, json: rows })]);
    const saves = new CloudSaves('fps', () => TOKEN);

    const out = await saves.list();
    expect(out).toEqual(rows);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('/api/saves/fps');
    expect(calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it('gets a record and returns it typed', async () => {
    const rec = { slot: 'best', rev: 2, data: { score: 9 }, updatedAt: 333 };
    const { calls } = scriptFetch([() => ({ status: 200, json: rec })]);
    const saves = new CloudSaves('fps', () => TOKEN);

    const got = await saves.get<{ score: number }>('best');
    expect(got.slot).toBe('best');
    expect(got.rev).toBe(2);
    expect(got.data.score).toBe(9);
    expect(calls[0]?.url).toBe('/api/saves/fps/best');
  });

  it('puts with {rev,data} and resolves ok:true with the new rev', async () => {
    const data = { hp: 100 };
    const { calls } = scriptFetch([() => ({ status: 200, json: { rev: 5 } })]);
    const saves = new CloudSaves('fps', () => TOKEN);

    const res = await saves.put('best', 4, data);
    expect(res.ok).toBe(true);
    expect(res.record).toMatchObject({ slot: 'best', rev: 5, data });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.body).toEqual({ rev: 4, data });
  });

  it('resolves the conflict shape: ok:false with the CURRENT record', async () => {
    // PUT races (409), then put() GETs the current record to hand back.
    const current = { slot: 'best', rev: 7, data: { hp: 55 }, updatedAt: 999 };
    const { calls } = scriptFetch([
      () => ({ status: 409, json: { error: 'conflict', rev: 7 } }),
      () => ({ status: 200, json: current }),
    ]);
    const saves = new CloudSaves('fps', () => TOKEN);

    const res = await saves.put('best', 4, { hp: 100 });
    expect(res.ok).toBe(false);
    expect(res.record).toEqual(current);
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.url).toBe('/api/saves/fps/best');
  });

  it('throws on 401 and on network failure', async () => {
    scriptFetch([() => ({ status: 401, json: { error: 'unauthorized' } })]);
    const saves = new CloudSaves('fps', () => TOKEN);
    await expect(saves.get('best')).rejects.toThrow('unauthorized');

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    await expect(saves.list()).rejects.toThrow('offline');
  });

  it('updateSave merges an existing slot and writes through', async () => {
    const existing = { slot: 'stats', rev: 2, data: { wins: 1 }, updatedAt: 10 };
    const { calls } = scriptFetch([
      () => ({ status: 200, json: existing }), // get
      () => ({ status: 200, json: { rev: 3 } }), // put ok
    ]);
    const saves = new CloudSaves('fps', () => TOKEN);

    const final = await updateSave<{ wins: number; losses: number }>(saves, 'stats', (cur) => ({
      wins: (cur?.wins ?? 0) + 1,
      losses: cur?.losses ?? 0,
    }));
    expect(final.rev).toBe(3);
    expect(calls[1]?.body).toEqual({ rev: 2, data: { wins: 2, losses: 0 } });
  });

  it('updateSave merges from null on a missing slot', async () => {
    const { calls } = scriptFetch([
      () => ({ status: 404, json: { error: 'not_found' } }), // get → clean base
      () => ({ status: 200, json: { rev: 1 } }), // put ok
    ]);
    const saves = new CloudSaves('fps', () => TOKEN);

    const final = await updateSave<{ runs: number }>(saves, 'runs', (cur) => ({
      runs: (cur?.runs ?? 0) + 5,
    }));
    expect(final.rev).toBe(1);
    expect(calls[1]?.body).toEqual({ rev: 0, data: { runs: 5 } });
  });

  it('updateSave retries ONCE on conflict using merged current data', async () => {
    const serverCurrent: SaveRecord = {
      slot: 'stats',
      rev: 8,
      data: { wins: 10, losses: 2 },
      updatedAt: 20,
    };
    let putCount = 0;
    const { calls } = scriptFetch([
      () => ({ status: 200, json: { slot: 'stats', rev: 2, data: { wins: 1 }, updatedAt: 10 } }), // get
      () => {
        putCount++;
        return { status: 409, json: { error: 'conflict', rev: 8 } }; // put #1 loses
      },
      () => ({ status: 200, json: serverCurrent }), // conflict GET
      () => {
        putCount++;
        return { status: 200, json: { rev: 9 } }; // put #2 wins
      },
    ]);
    const saves = new CloudSaves('fps', () => TOKEN);

    const final = await updateSave<{ wins: number; losses: number }>(saves, 'stats', (cur) => ({
      wins: (cur?.wins ?? 0) + 1,
      losses: cur?.losses ?? 0,
    }));

    expect(putCount).toBe(2); // exactly ONE retry
    expect(final.rev).toBe(9);
    // retry carried the SERVER's rev + our increment applied to ITS data
    expect(calls[3]?.body).toEqual({ rev: 8, data: { wins: 11, losses: 2 } });
  });
});
