// reportStats + fetchPadLayout: Bearer wiring, validation, null-on-failure.
import { describe, expect, it, vi } from 'vitest';
import { fetchPadLayout } from './pads.js';
import { isStatRow, reportStat, reportStats } from './stats.js';

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
}

describe('reportStat(s)', () => {
  it('POSTs Bearer + JSON shape', async () => {
    const f = mockFetch(() => ({ ok: true }));
    const ok = await reportStat('bank-sdk', 'bank.wins', 2, { getToken: () => 'tok', fetchFn: f as unknown as typeof fetch });
    expect(ok).toBe(true);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/stats/bank-sdk');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ key: 'bank.wins', value: 2 });
  });

  it('null token and non-finite values resolve false without fetching', async () => {
    const f = mockFetch(() => ({ ok: true }));
    expect(await reportStat('g', 'k', 1, { getToken: () => null, fetchFn: f as unknown as typeof fetch })).toBe(false);
    expect(await reportStat('g', 'k', NaN, { getToken: () => 't', fetchFn: f as unknown as typeof fetch })).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('reportStats truncates/clamps and skips non-numbers', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const f = mockFetch((_u, init) => {
      seen.push(JSON.parse(init?.body as string));
      return { ok: true };
    });
    const ok = await reportStats('g', { a: 1.9, b: 'x' as unknown as number, c: 1e9 }, { getToken: () => 't', fetchFn: f as unknown as typeof fetch });
    expect(ok).toBe(true);
    expect(seen).toEqual([{ key: 'a', value: 1 }, { key: 'c', value: 1000000 }]);
  });

  it('isStatRow validates', () => {
    expect(isStatRow({ gameId: 'g', key: 'k', value: 1 })).toBe(true);
    expect(isStatRow({ gameId: 'g', key: 'k' })).toBe(false);
    expect(isStatRow(null)).toBe(false);
  });
});

describe('fetchPadLayout', () => {
  it('returns the layout on 200, null otherwise', async () => {
    const layout = { sticks: [], buttons: [] };
    const okFetch = mockFetch(() => ({ ok: true, json: async () => layout }));
    expect(await fetchPadLayout('sumo', okFetch as unknown as typeof fetch)).toEqual(layout);
    const missFetch = mockFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));
    expect(await fetchPadLayout('fps', missFetch as unknown as typeof fetch)).toBeNull();
    const deadFetch = mockFetch(() => {
      throw new Error('down');
    });
    expect(await fetchPadLayout('x', deadFetch as unknown as typeof fetch)).toBeNull();
  });
});
