// ============================================================================
// GENERIC PHONE-PAD PAGE — self-rendering virtual controller served at
// /pad/?game=<id> (docs/PLATFORM.md §4.4). Server-generated HTML, no build
// step (same pattern as the launcher page). The page connects to /ws itself,
// exchanges {t:'join_as_pad'} with the pairing code, renders the game's
// PadLayout, streams {t:'pad_input'} ≤ PADS.inputMaxHz, tracks pad_input_echo
// for latency display.
// Owner: P8_PAD_PAGE — implement renderPadPage; keep this signature.
// ============================================================================

import type { PadLayout } from '@platform/shared';

/** Full standalone HTML document for the pad page. Never throws. */
export function renderPadPage(opts: {
  readonly gameId: string;
  readonly gameName: string;
  readonly layout: PadLayout;
}): string;
