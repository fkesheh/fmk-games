// ============================================================================
// FIXED-STEP LOOP — accumulator sim/rAF loop (docs/PLATFORM.md §4.6).
// Owner: P5_ENGINE — implement; signatures frozen by types.ts LoopOpts.
// ============================================================================

import type { LoopOpts } from './types.js';

export class Loop {
  /** Ticks simulated since start(); reset by start(). */
  tickCount = 0;
  running = false;

  constructor(private readonly hooks: LoopOpts) {
    void hooks;
  }

  start(): void {
    throw new Error('P5_ENGINE: not implemented');
  }

  stop(): void {
    throw new Error('P5_ENGINE: not implemented');
  }
}
