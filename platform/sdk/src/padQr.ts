// ============================================================================
// SDK PAD PAIRING UI — in-game overlay showing the /pad/ URL + 6-char code
// (docs/PLATFORM.md §4.4). DOM-injective for tests; dismiss() unbinds.
// Owner: P7_SDK_INPUT_AUDIO — implement.
// ============================================================================

export interface PadPairOverlay {
  /** Update the displayed code (re-pair after TTL). */
  setCode(code: string): void;
  /** Show bound state ("controller connected"), auto-hide after 2s. */
  bound(): void;
  dismiss(): void;
}

/** Appends a styled overlay to root (default document.body). */
export function showPadPairing(
  urlPath: string,
  code: string,
  root?: HTMLElement,
): PadPairOverlay {
  void urlPath;
  void code;
  void root;
  throw new Error('P7_SDK_INPUT_AUDIO: not implemented');
}
