// ============================================================================
// FIXED-STEP LOOP — accumulator sim/rAF loop (docs/PLATFORM.md §4.6).
// Owner: P5_ENGINE — implement; signatures frozen by types.ts LoopOpts.
//
// rAF drives rendering; simulation advances in constant dt = 1/tickHz steps
// drained from an accumulator, clamped at maxCatchUp steps per frame so a slow
// frame can never spiral into an ever-growing debt (the "spiral of death").
// onRender runs once per frame with real elapsed time (clamped to 0.25s) and
// alpha — the fraction of one step left in the accumulator — for interpolation.
// Callback throws are caught: 3 consecutive throws log ONCE and stop the loop.
// The rAF source and wall clock are injectable for deterministic tests.
// ============================================================================

import type { LoopOpts } from './types.js';

/** Frame-time clamp: a longer gap is treated as this (tab switch, breakpoint…). */
const MAX_FRAME_SECONDS = 0.25;
/** Consecutive callback throws tolerated before the loop stops itself. */
const MAX_CONSECUTIVE_THROWS = 3;

export class Loop {
  /** Ticks simulated since start(); reset by start(). */
  tickCount = 0;
  running = false;

  private readonly stepSeconds: number;
  private readonly maxCatchUp: number;
  private readonly requestFrame: (cb: (nowMs: number) => void) => void;
  private readonly nowMs: () => number;

  /** Handle of the currently scheduled frame, if the source gave us one. */
  private frameId: unknown = null;
  /** Wall/virtual ms of the previous frame; anchored at start(). */
  private lastMs = 0;
  private accumulator = 0;
  private throwStreak = 0;
  private errorLogged = false;

  /**
   * @param hooks   frozen LoopOpts contract
   * @param raf     additive test seam: frame scheduler (default window.rAF)
   * @param clock   additive test seam: virtual clock in ms (default performance.now)
   */
  constructor(
    private readonly hooks: LoopOpts,
    raf?: (cb: (nowMs: number) => void) => void,
    clock?: () => number,
  ) {
    const hz = hooks.tickHz !== undefined && hooks.tickHz > 0 ? hooks.tickHz : 30;
    this.stepSeconds = 1 / hz;
    this.maxCatchUp = hooks.maxCatchUp !== undefined && hooks.maxCatchUp >= 1 ? Math.floor(hooks.maxCatchUp) : 5;
    this.requestFrame =
      raf ??
      ((cb: (nowMs: number) => void): void => {
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          this.frameId = window.requestAnimationFrame(cb);
        } else {
          this.frameId = setTimeout(() => cb(performance.now()), 16);
        }
      });
    this.nowMs = clock ?? (() => performance.now());
  }

  /** Start (or restart). Resets tickCount, accumulator and error state. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.tickCount = 0;
    this.accumulator = 0;
    this.lastMs = this.nowMs(); // first frame measures from start(), not epoch
    this.throwStreak = 0;
    this.errorLogged = false;
    this.schedule();
  }

  /** Halt. Cancels any pending frame; callbacks never fire again until start(). */
  stop(): void {
    this.running = false;
    this.cancelPending();
  }

  // ---- internals ---------------------------------------------------------------

  private schedule(): void {
    this.requestFrame((nowMs: number): void => {
      this.frameId = null;
      if (!this.running) return; // stop() raced the pending frame — stay halted
      this.frame(nowMs);
      if (this.running) this.schedule();
    });
  }

  private cancelPending(): void {
    const id = this.frameId;
    this.frameId = null;
    if (id === null || id === undefined) return;
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      if (typeof id === 'number') window.cancelAnimationFrame(id);
      else clearTimeout(id as number);
    }
  }

  /** One rAF beat: drain sim steps, then render once. */
  private frame(nowMs: number): void {
    const rawDt = (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;
    const dtFrame = Math.min(Math.max(rawDt, 0), MAX_FRAME_SECONDS);

    this.accumulator += dtFrame;
    let steps = 0;
    while (this.running && steps < this.maxCatchUp && this.accumulator >= this.stepSeconds) {
      this.accumulator -= this.stepSeconds;
      steps++;
      if (this.guardedTick()) return; // threw — stop() may have fired inside
    }
    if (steps >= this.maxCatchUp) {
      this.accumulator = 0; // snap: drop the unpayable debt instead of growing it
    }
    if (!this.running) return;

    const alpha = Math.min(1, Math.max(0, this.accumulator / this.stepSeconds));
    this.guardedRender(dtFrame, alpha, nowMs);
  }

  /** Run onTick with throw accounting; true if the loop must abort this frame. */
  private guardedTick(): boolean {
    try {
      this.hooks.onTick(this.stepSeconds, this.tickCount++);
      this.throwStreak = 0;
      return false;
    } catch (err) {
      return this.onThrow(err);
    }
  }

  /** Run onRender with throw accounting; true if the loop must stop entirely. */
  private guardedRender(dtFrame: number, alpha: number, nowMs: number): boolean {
    try {
      this.hooks.onRender(dtFrame, alpha, nowMs);
      this.throwStreak = 0;
      return false;
    } catch (err) {
      return this.onThrow(err);
    }
  }

  private onThrow(err: unknown): boolean {
    this.throwStreak++;
    if (this.throwStreak < MAX_CONSECUTIVE_THROWS) return !this.running;
    if (!this.errorLogged) {
      this.errorLogged = true; // exactly once — never spam-console
      console.error('[engine/Loop] stopping after repeated callback throws', err);
    }
    this.stop();
    return true;
  }
}
