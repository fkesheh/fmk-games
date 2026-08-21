// ============================================================================
// SDK AUDIO — tiny synthesized kit: oscillators + noise, envelopes, filters;
// zero samples (docs/PLATFORM.md §4.5). House style from STRICKEN audio.ts.
// Owner: P7_SDK_INPUT_AUDIO — implement AudioKit from types.ts; every voice
// must be DISTINCT and pleasant at high repetition.
// ============================================================================

import type { AudioKit, SfxOpts, SfxVoice } from './types.js';

export class SynthKit implements AudioKit {
  resume(): void {}

  sfx(_voice: SfxVoice, _opts?: SfxOpts): void {
    void _voice;
    void _opts;
  }

  ambient(_kind: 'wind' | 'hum' | 'off'): void {
    void _kind;
  }
}
