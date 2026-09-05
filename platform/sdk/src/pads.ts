// ============================================================================
// PAD LAYOUT FETCH (docs/PLATFORM.md §4.4) — read the game's virtual-
// controller schema so any client (or the generic /pad page) can render it.
// Returns null when the game declares no layout OR the request fails —
// callers treat "no pads" as a normal state, never an error.
// ============================================================================
import type { PadLayout } from '@platform/shared';

function isPadLayout(v: unknown): v is PadLayout {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return Array.isArray(r.sticks) && Array.isArray(r.buttons);
}

/** GET /api/pads/:gameId — null when absent or unreachable. */
export async function fetchPadLayout(
  gameId: string,
  fetchFn: typeof fetch = fetch,
): Promise<PadLayout | null> {
  try {
    const res = await fetchFn(`/api/pads/${encodeURIComponent(gameId)}`);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return isPadLayout(data) ? data : null;
  } catch {
    return null;
  }
}
