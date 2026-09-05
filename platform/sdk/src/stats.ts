// ============================================================================
// SELF-REPORTED STATS (docs/PLATFORM.md §12) — in a host-tab match there is
// no server room to report through, so each client reports its OWN counters
// from the snapshots it saw. Bearer-bound: a profile can only write its own
// rows. Best-effort by contract (a failed POST never throws into game code).
// ============================================================================

export interface StatsReporterOpts {
  /** Bearer token supplier (Profiles.token bound method works). */
  getToken: () => string | null;
  /** Same-origin default; override for tests. */
  fetchFn?: typeof fetch;
  /** Rethrow network errors instead of swallowing (default false). */
  throwOnError?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Report one counter delta for the caller's own profile.
 * Game id + key are validated server-side; finite numbers only.
 */
export async function reportStat(
  gameId: string,
  key: string,
  value: number,
  opts: StatsReporterOpts,
): Promise<boolean> {
  const token = opts.getToken();
  if (token === null || token === '') return false;
  if (!Number.isFinite(value)) return false;
  const run = opts.fetchFn ?? fetch;
  try {
    const res = await run(`/api/stats/${encodeURIComponent(gameId)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    return res.ok;
  } catch {
    if (opts.throwOnError === true) throw new Error('reportStat: network failed');
    return false;
  }
}

/**
 * Report several counters; resolves false unless every POST lands.
 * Values are truncated to integers and clamped to ±1e6 (server clamps too).
 */
export async function reportStats(
  gameId: string,
  delta: Record<string, number>,
  opts: StatsReporterOpts,
): Promise<boolean> {
  let ok = true;
  for (const [key, value] of Object.entries(delta)) {
    if (typeof value !== 'number') continue;
    const v = Math.max(-1e6, Math.min(1e6, Math.trunc(value)));
    if (Number.isNaN(v)) continue;
    const one = await reportStat(gameId, key, v, opts);
    if (!one) ok = false;
  }
  return ok;
}

/** Shape check for a stats GET response row (defensive, never throws). */
export function isStatRow(v: unknown): v is { gameId: string; key: string; value: number } {
  if (!isRecord(v)) return false;
  return typeof v.gameId === 'string' && typeof v.key === 'string' && typeof v.value === 'number';
}
