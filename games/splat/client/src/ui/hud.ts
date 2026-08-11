// ============================================================================
// C3 — SKI SPLAT HUD (CONTRACT §7 C3, §7a seam). Pure DOM HUD per UX_BIBLE:
// place chip, progress rail (2D canvas, <= 4 Hz), speed chip, countdown
// overlay, finished banner, results panel, first-run steer hint.
//
// Discipline (the kart updateHud idiom, contract §2.7): the whole tree is
// built ONCE in the constructor; render() updates in place behind change
// guards (textContent / classList / style writes happen only when the value
// actually changed); arrays and strings are built only on change, never per
// frame. Colours reach the canvas through SPAL and the state's colorFor seam
// — no ad-hoc hex (§2.5).
// ============================================================================
import { FINISH_Z, MAX_SPEED, SPAL } from '@splat/shared';
import type { Phase } from '@splat/shared';

// ---- the frozen §7a seam (signatures may not change) ------------------------
export interface HudRacer {
  slot: number;
  z: number;
  finished: boolean;
  finishMs: number;
}

export interface HudState {
  phase: Phase;
  countdown: number;       // 3..1 during countdown else 0
  speedKmh: number;
  place: number;           // 1-based
  total: number;
  you: HudRacer;
  racers: readonly HudRacer[];
  results: readonly HudRacer[] | null;   // non-null only in results
  colorFor(slot: number): string;
  glyphFor(slot: number): string;
}

// ---- private constants ------------------------------------------------------
const HINT_KEY = 'splat.hintseen';
const RAIL_MIN_INTERVAL_MS = 250; // <= 4 Hz redraw (CONTRACT §7 C3)
const GO_LINGER_MS = 900;
const MAX_KMH = MAX_SPEED * 3.6; // full bar = the sim's speed cap
const RAIL_W = 24;
const RAIL_H = 140;
const RAIL_DPR = 2; // 2x backing store
const RAIL_PAD = 8;
const PRESS_CLICK_WINDOW_MS = 500; // a click inside this after a pointerdown is the SAME press

// ---- tiny DOM helpers (change-guarded) --------------------------------------
function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

function setHidden(e: HTMLElement, hidden: boolean): void {
  if (e.classList.contains('hidden') !== hidden) e.classList.toggle('hidden', hidden);
}

function ordinal(n: number): string {
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}

function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** SPAL hex -> rgba() string for canvas strokes (hex stays in palette.ts). */
function rgba(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Race order: finishers by finishMs, then the rest by distance covered. */
function raceOrder(a: HudRacer, b: HudRacer): number {
  if (a.finished && b.finished) return a.finishMs - b.finishMs;
  if (a.finished) return -1;
  if (b.finished) return 1;
  return b.z - a.z;
}

export class SplatHud {
  readonly root: HTMLElement;

  private readonly placeChip: HTMLElement;
  private readonly crown: HTMLElement;
  private readonly placeNum: HTMLElement;
  private readonly speedChip: HTMLElement;
  private readonly speedNum: HTMLElement;
  private readonly speedBarFill: HTMLElement;
  private readonly rail: HTMLCanvasElement;
  private readonly railCtx: CanvasRenderingContext2D | null;
  private readonly countOverlay: HTMLElement;
  private readonly finishedBanner: HTMLElement;
  private readonly resultsPanel: HTMLElement;
  private readonly jumpBtn: HTMLButtonElement;
  private readonly jumpGlyph: HTMLElement;
  private readonly hint: HTMLElement;

  // baselines for the change guards
  private lastPhase: Phase | null = null;
  private goAtMs = -1;
  private placeShown = '';
  private placeColorShown = '';
  private speedShown = -1;
  private barPctShown = -1;
  private railLastDrawMs = Number.NEGATIVE_INFINITY;
  private railSig = '';
  private resultsSig = '';

  // v2 JUMP chip state (UX_BIBLE §V2): the wired seam + press-edge tracking.
  private jumpFn: (() => void) | null = null;
  /** performance.now() of the last pointerdown on the chip, or -1 once that
   *  press was cancelled or its follow-up click consumed. */
  private jumpPressAtMs = -1;

  // steer hint bookkeeping
  private hintVisible = false;
  private hintTimer = 0;
  private readonly onHintInput = (): void => {
    this.dismissHint();
  };

  // ---- v2 JUMP chip edge handlers (UX_BIBLE §V2) ---------------------------
  /**
   * v2 seam (additive): the app wires this to drive.setJump(). Fires `fn`
   * ONCE per press — a pointerdown edge (a held thumb never repeats; the
   * sim's cooldown owns cadence) or a keyboard/AT click with no preceding
   * pointer press. pointercancel / lostpointercapture / blur reset the
   * tracked press so a cancelled press can never fire a second edge.
   */
  onJump(fn: () => void): void {
    this.jumpFn = fn;
  }

  private readonly onJumpPointerDown = (ev: PointerEvent): void => {
    ev.preventDefault(); // pointer presses never spawn a synthetic click
    this.jumpPressAtMs = performance.now();
    this.fireJump();
  };

  private readonly onJumpClick = (): void => {
    if (this.jumpPressAtMs >= 0 && performance.now() - this.jumpPressAtMs < PRESS_CLICK_WINDOW_MS) {
      // the click that follows a pointer press — its edge already fired
      this.jumpPressAtMs = -1;
      return;
    }
    this.fireJump(); // keyboard / assistive-tech activation (no pointer press)
  };

  private readonly onJumpCancel = (): void => {
    // pointercancel / lostpointercapture: the press died mid-flight. Reset the
    // tracked press so the NEXT press fires, but fire no edge here.
    this.jumpPressAtMs = -1;
  };

  private readonly onJumpBlur = (): void => {
    this.jumpPressAtMs = -1;
  };

  private fireJump(): void {
    this.jumpFn?.();
  }

  constructor(parent: HTMLElement) {
    this.root = el('div', 'splat-hud hidden');
    // Scrim washes first so they sit behind every chip (kart .hud-scrim).
    this.root.appendChild(el('div', 'sh-scrim sh-scrim-tl'));
    this.root.appendChild(el('div', 'sh-scrim sh-scrim-rail'));
    this.root.appendChild(el('div', 'sh-scrim sh-scrim-bl'));

    // (1) place chip, top-left
    this.placeChip = el('div', 'sh-place hidden');
    this.crown = el('span', 'sh-crown hidden');
    this.crown.textContent = '👑';
    this.placeNum = el('span', 'sh-place-num');
    this.placeChip.appendChild(this.crown);
    this.placeChip.appendChild(this.placeNum);
    this.root.appendChild(this.placeChip);

    // (2) progress rail, right edge (2x backing store)
    this.rail = document.createElement('canvas');
    this.rail.className = 'sh-rail hidden';
    this.rail.width = RAIL_W * RAIL_DPR;
    this.rail.height = RAIL_H * RAIL_DPR;
    this.railCtx = this.rail.getContext('2d');
    if (this.railCtx !== null) this.railCtx.scale(RAIL_DPR, RAIL_DPR);
    this.root.appendChild(this.rail);

    // (3) speed chip, bottom-left
    this.speedChip = el('div', 'sh-speed hidden');
    this.speedNum = el('span', 'sh-speed-num');
    const unit = el('span', 'sh-speed-unit');
    unit.textContent = ' km/h';
    const bar = el('div', 'sh-speed-bar');
    this.speedBarFill = el('div', 'sh-speed-bar-fill');
    bar.appendChild(this.speedBarFill);
    this.speedChip.appendChild(this.speedNum);
    this.speedChip.appendChild(unit);
    this.speedChip.appendChild(bar);
    this.root.appendChild(this.speedChip);

    // (4) countdown overlay
    this.countOverlay = el('div', 'sh-countdown hidden');
    this.root.appendChild(this.countOverlay);

    // (5) finished banner (the race keeps running behind it)
    this.finishedBanner = el('div', 'sh-finished hidden');
    this.root.appendChild(this.finishedBanner);

    // (6) results panel
    this.resultsPanel = el('div', 'sh-results hidden');
    this.root.appendChild(this.resultsPanel);

    // (6b) v2 JUMP chip — round, bottom-right ABOVE the touch zones: sunGold
    // ring + ink arrow-up glyph on paper (STYLE_BIBLE §V2.8 — labelled by
    // glyph, never colour alone). pointer-events: auto, because the HUD root
    // is none (the steer zones live under it).
    this.jumpBtn = document.createElement('button');
    this.jumpBtn.type = 'button';
    this.jumpBtn.className = 'sh-jump hidden';
    this.jumpBtn.setAttribute('aria-label', 'Jump — hop');
    this.jumpGlyph = el('span', 'sh-jump-glyph');
    this.jumpGlyph.textContent = '↑';
    this.jumpBtn.appendChild(this.jumpGlyph);
    this.jumpBtn.addEventListener('pointerdown', this.onJumpPointerDown);
    this.jumpBtn.addEventListener('click', this.onJumpClick);
    this.jumpBtn.addEventListener('pointercancel', this.onJumpCancel);
    this.jumpBtn.addEventListener('lostpointercapture', this.onJumpCancel);
    this.jumpBtn.addEventListener('blur', this.onJumpBlur);
    this.root.appendChild(this.jumpBtn);

    // (7) first-run steer + JUMP hint (UX_BIBLE §V2 adds the jump line to the
    // same 3 s / once-per-localStorage / any-input-dismissible hint)
    this.hint = el('div', 'sh-hint hidden');
    this.hint.appendChild(el('div', 'sh-hint-thumb sh-hint-left'));
    this.hint.appendChild(el('div', 'sh-hint-thumb sh-hint-right'));
    const hintText = el('div', 'sh-hint-text');
    const label = el('div', 'sh-hint-label');
    label.textContent = 'hold a side to steer';
    const jumpLine = el('div', 'sh-hint-jump');
    jumpLine.textContent = 'SPACE / JUMP = hop — ramps send you flying!';
    hintText.appendChild(label);
    hintText.appendChild(jumpLine);
    this.hint.appendChild(hintText);
    this.root.appendChild(this.hint);

    parent.appendChild(this.root);
  }

  render(s: HudState): void {
    const now = performance.now();
    const inRace = s.phase !== 'lobby';
    setHidden(this.root, !inRace);
    if (!inRace) {
      this.lastPhase = s.phase;
      return;
    }

    const racingUi = s.phase === 'countdown' || s.phase === 'racing';

    // ---- place chip ---------------------------------------------------------
    setHidden(this.placeChip, !racingUi);
    if (racingUi) {
      const ord = ordinal(s.place);
      if (ord !== this.placeShown) {
        this.placeShown = ord;
        this.placeNum.textContent = ord;
      }
      const color = s.colorFor(s.you.slot);
      if (color !== this.placeColorShown) {
        this.placeColorShown = color;
        this.placeNum.style.color = color;
      }
      setHidden(this.crown, s.place !== 1);
    }

    // ---- speed chip ---------------------------------------------------------
    setHidden(this.speedChip, !racingUi);
    if (racingUi) {
      const kmh = Math.round(s.speedKmh);
      if (kmh !== this.speedShown) {
        this.speedShown = kmh;
        this.speedNum.textContent = String(kmh);
      }
      const pct = Math.max(0, Math.min(100, Math.round((s.speedKmh / MAX_KMH) * 100)));
      if (pct !== this.barPctShown) {
        this.barPctShown = pct;
        this.speedBarFill.style.width = `${pct}%`;
      }
    }

    // ---- v2 JUMP chip -------------------------------------------------------
    setHidden(this.jumpBtn, !racingUi);

    // ---- progress rail (redrawn at <= 4 Hz, and only when anything moved) ---
    setHidden(this.rail, !racingUi);
    if (racingUi && now - this.railLastDrawMs >= RAIL_MIN_INTERVAL_MS) {
      this.drawRail(s, now);
    }

    // ---- phase edge: countdown -> racing fires GO! --------------------------
    if (s.phase === 'racing' && this.lastPhase === 'countdown') this.goAtMs = now;
    this.lastPhase = s.phase;

    // ---- countdown overlay ---------------------------------------------------
    const countVisible = s.phase === 'countdown' && Math.ceil(s.countdown) >= 1;
    const goVisible =
      s.phase === 'racing' && this.goAtMs >= 0 && now - this.goAtMs < GO_LINGER_MS;
    setHidden(this.countOverlay, !countVisible && !goVisible);
    if (countVisible) setText(this.countOverlay, String(Math.ceil(s.countdown)));
    else if (goVisible) setText(this.countOverlay, 'GO!');

    // ---- finished banner -----------------------------------------------------
    const finVisible = s.phase === 'racing' && s.you.finished;
    setHidden(this.finishedBanner, !finVisible);
    if (finVisible) setText(this.finishedBanner, `Finished — ${fmtSecs(s.you.finishMs)}`);

    // ---- results panel -------------------------------------------------------
    const resultsVisible = s.phase === 'results' && s.results !== null;
    setHidden(this.resultsPanel, !resultsVisible);
    if (resultsVisible) this.renderResults(s);
  }

  /** First-run steer + JUMP hint: translucent thumb outlines with two lines
   *  of text, dismissed by any pointer/key input or after 3 s, at most once
   *  per localStorage (UX_BIBLE "First 60 seconds" + §V2). */
  showSteerHint(): void {
    if (this.hintVisible) return;
    let seen = false;
    try {
      seen = typeof localStorage !== 'undefined' && localStorage.getItem(HINT_KEY) === '1';
    } catch {
      seen = false; // storage blocked: fall through and show the hint
    }
    if (seen) return;
    this.hintVisible = true;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(HINT_KEY, '1');
    } catch {
      // private mode: the hint simply may show again next launch
    }
    setHidden(this.hint, false);
    window.addEventListener('pointerdown', this.onHintInput);
    window.addEventListener('keydown', this.onHintInput);
    this.hintTimer = window.setTimeout(this.onHintInput, 3000);
  }

  private dismissHint(): void {
    if (!this.hintVisible) return;
    this.hintVisible = false;
    setHidden(this.hint, true);
    window.removeEventListener('pointerdown', this.onHintInput);
    window.removeEventListener('keydown', this.onHintInput);
    window.clearTimeout(this.hintTimer);
  }

  private drawRail(s: HudState, now: number): void {
    this.railLastDrawMs = now;
    const ctx = this.railCtx;
    if (ctx === null) return;
    // Skip the redraw when no racer moved a whole metre / changed finish bit.
    let sig = '';
    for (const r of s.racers) sig += `${r.slot},${r.finished ? 1 : 0},${Math.round(r.z)};`;
    if (sig === this.railSig) return;
    this.railSig = sig;

    const x = RAIL_W / 2;
    const top = RAIL_PAD;
    const bottom = RAIL_H - RAIL_PAD;
    ctx.clearRect(0, 0, RAIL_W, RAIL_H);
    // the rail: start at top, finish at bottom. F4 weight: a subtle paper
    // glow under a thin ink rail so the column reads against the bright sky.
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineWidth = 8;
    ctx.strokeStyle = rgba(SPAL.paper, 0.3);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(SPAL.ink, 0.7);
    ctx.stroke();
    // one dot per racer in slot colour; sorted draw order = race order, you
    // last (on top), larger, every dot paper-rimmed so it stays visible
    // against the sky band. Allocates only on a redraw.
    const dots = [...s.racers].sort(raceOrder);
    for (const r of dots) {
      const isYou = r.slot === s.you.slot;
      const frac = Math.max(0, Math.min(1, (r.finished ? FINISH_Z : r.z) / FINISH_Z));
      const y = top + frac * (bottom - top);
      ctx.beginPath();
      ctx.arc(x, y, isYou ? 7 : 5, 0, Math.PI * 2); // >= 10 px diameter dots
      ctx.fillStyle = s.colorFor(r.slot);
      ctx.fill();
      ctx.lineWidth = isYou ? 2 : 1.5;
      ctx.strokeStyle = SPAL.snowLit;
      ctx.stroke();
    }
  }

  private renderResults(s: HudState): void {
    const results = s.results;
    if (results === null) return;
    // Rebuild only when the standings content actually changed.
    let sig = '';
    for (const r of results) {
      sig += `${r.slot},${r.finished ? Math.round(r.finishMs) : -1},${Math.round(r.z)};`;
    }
    if (sig === this.resultsSig) return;
    this.resultsSig = sig;

    const ordered = [...results].sort(raceOrder);
    const winner = ordered.find((r) => r.finished);
    const winMs = winner === undefined ? 0 : winner.finishMs;

    this.resultsPanel.textContent = ''; // clears the old rows (only on change)
    const title = el('div', 'sh-results-title');
    title.textContent = 'Results';
    this.resultsPanel.appendChild(title);
    for (const r of ordered) {
      const row = el('div', 'sh-row');
      const glyph = el('span', 'sh-row-glyph');
      glyph.textContent = s.glyphFor(r.slot);
      const swatch = el('span', 'sh-row-swatch');
      swatch.style.background = s.colorFor(r.slot);
      const barWrap = el('div', 'sh-row-bar');
      const fill = el('div', 'sh-row-bar-fill');
      fill.style.background = s.colorFor(r.slot);
      const time = el('span', 'sh-row-time');
      if (r.finished) {
        // proportional time bar: the winner's time is the full bar, later
        // finishers get winMs/finishMs of it (a 45.0s next to a 42.3s win
        // reads 94% — proportional, and never a zero bar)
        const pct = r.finishMs > 0 ? Math.round((winMs / r.finishMs) * 100) : 100;
        fill.style.width = `${Math.max(4, Math.min(100, pct))}%`;
        time.textContent = fmtSecs(r.finishMs);
      } else {
        // no rank shame: still on the mountain, with distance covered
        fill.style.width = `${Math.max(2, Math.min(100, Math.round((r.z / FINISH_Z) * 100)))}%`;
        time.textContent = `on the mountain — ${Math.round(r.z)} m`;
      }
      barWrap.appendChild(fill);
      row.appendChild(glyph);
      row.appendChild(swatch);
      row.appendChild(barWrap);
      row.appendChild(time);
      if (winner !== undefined && r.slot === winner.slot) {
        const crown = el('span', 'sh-row-crown');
        crown.textContent = '👑';
        row.appendChild(crown);
        row.classList.add('sh-row-winner');
      }
      this.resultsPanel.appendChild(row);
    }
  }
}
