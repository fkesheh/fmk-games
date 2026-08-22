// ============================================================================
// ORBIT UI — plain-DOM overlay (menu / HUD / game-over / offline banner).
// Dumb by design: renders state snapshots, forwards clicks through the
// UiCallbacks handed to the constructor. All styling lives in style.css.
// Palette: deep-space ink #0b0e14, neon cyan #35e0ff, amber #ffb454,
// magenta #ff4fd8.
// ============================================================================

export interface MenuData {
  /** Personal best score from slot 'best' (null = none yet). */
  readonly best: number | null;
  /** True when slot 'resume' holds a run worth continuing (score > 0). */
  readonly canResume: boolean;
  readonly localOnly: boolean;
}

export interface HudData {
  readonly score: number;
  readonly combo: number;
  readonly speed: number;
  readonly shields: number;
  /** 0..1 boost readiness (1 = ready). */
  readonly boostFrac: number;
}

export interface GameOverData {
  readonly score: number;
  readonly dist: number;
  readonly nearMisses: number;
  readonly topCombo: number;
  /** Previous best at run start (null = first ever run). */
  readonly prevBest: number | null;
  readonly isPb: boolean;
}

export interface UiCallbacks {
  onStart(): void;
  onContinue(): void;
  onRetry(): void;
  onMenu(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className !== undefined) e.className = className;
  parent?.appendChild(e);
  return e;
}

export class Ui {
  private readonly cb: UiCallbacks;

  private readonly root: HTMLDivElement;
  private readonly menuScreen: HTMLDivElement;
  private readonly bestValue: HTMLSpanElement;
  private readonly continueBtn: HTMLButtonElement;
  private readonly offlineBanner: HTMLDivElement;

  private readonly hud: HTMLDivElement;
  private readonly scoreEl: HTMLDivElement;
  private readonly comboEl: HTMLDivElement;
  private readonly speedEl: HTMLDivElement;
  private readonly shieldEl: HTMLDivElement;
  private readonly boostFill: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly overScreen: HTMLDivElement;
  private readonly overScore: HTMLDivElement;
  private readonly overDelta: HTMLDivElement;
  private readonly overMeta: HTMLDivElement;

  screen: 'menu' | 'run' | 'over' = 'menu';

  constructor(cb: UiCallbacks) {
    this.cb = cb;
    this.root = el('div', 'ob-ui');
    document.body.appendChild(this.root);

    // ---- menu ----
    this.menuScreen = el('div', 'ob-screen', this.root);
    const title = el('h1', 'ob-title', this.menuScreen);
    title.textContent = 'ORBIT';
    const sub = el('div', 'ob-sub', this.menuScreen);
    sub.textContent = 'thread the tunnel · chain the near misses';

    const card = el('div', 'ob-card', this.menuScreen);
    const bestRow = el('div', 'ob-row', card);
    const bestK = el('span', 'k', bestRow);
    bestK.textContent = 'personal best';
    this.bestValue = el('span', 'v cyan', bestRow);

    this.continueBtn = el('button', 'ob-btn alt', card);
    this.continueBtn.type = 'button';
    this.continueBtn.textContent = 'CONTINUE';
    this.continueBtn.classList.add('hidden');
    this.continueBtn.addEventListener('click', () => this.cb.onContinue());

    const startBtn = el('button', 'ob-btn', card);
    startBtn.type = 'button';
    startBtn.textContent = 'START RUN';
    startBtn.addEventListener('click', () => this.cb.onStart());

    this.offlineBanner = el('div', 'ob-banner hidden', card);
    this.offlineBanner.textContent = 'offline — progress saves locally';

    const hint = el('div', 'ob-hint', this.menuScreen);
    hint.innerHTML =
      '<b>WASD / arrows</b> steer &middot; <b>space</b> boost &middot; gamepad left stick + A<br>' +
      'graze debris within <b>1.2u</b> for combo points &middot; shields eat one hit<br>' +
      'speed climbs for three minutes — how far can you get?';

    // ---- HUD ----
    this.hud = el('div', 'hidden', this.root);
    this.scoreEl = el('div', 'ob-score', this.hud);
    this.comboEl = el('div', 'ob-combo', this.hud);
    const right = el('div', 'ob-right', this.hud);
    this.shieldEl = el('div', 'ob-shield', right);
    this.speedEl = el('div', 'ob-speed', right);
    const boostWrap = el('div', 'ob-boostwrap', this.hud);
    this.boostFill = el('div', 'ob-boostfill', boostWrap);
    this.toastEl = el('div', 'ob-toast', this.hud);

    // ---- game-over ----
    this.overScreen = el('div', 'ob-screen hidden', this.root);
    const oTitle = el('h1', 'ob-title small magenta', this.overScreen);
    oTitle.textContent = 'RUN OVER';
    const oCard = el('div', 'ob-card', this.overScreen);
    this.overScore = el('div', 'ob-final', oCard);
    this.overDelta = el('div', 'ob-delta', oCard);
    this.overMeta = el('div', 'ob-meta', oCard);
    const actions = el('div', 'ob-actions', oCard);
    const retryBtn = el('button', 'ob-btn', actions);
    retryBtn.type = 'button';
    retryBtn.textContent = 'RETRY';
    retryBtn.addEventListener('click', () => this.cb.onRetry());
    const menuBtn = el('button', 'ob-btn ghosty', actions);
    menuBtn.type = 'button';
    menuBtn.textContent = 'MENU';
    menuBtn.addEventListener('click', () => this.cb.onMenu());
  }

  /** HUD mounts under its own fixed container so screens never contain it. */

  // ---- menu ---------------------------------------------------------------

  showMenu(d: MenuData): void {
    this.screen = 'menu';
    this.menuScreen.classList.remove('hidden');
    this.overScreen.classList.add('hidden');
    this.hud.classList.add('hidden');

    this.bestValue.textContent = d.best === null ? '— none yet' : `${d.best}`;
    this.continueBtn.classList.toggle('hidden', !d.canResume);
    if (d.canResume) this.continueBtn.focus();
    this.offlineBanner.classList.toggle('hidden', !d.localOnly);
  }

  // ---- hud ------------------------------------------------------------------

  showHud(): void {
    this.screen = 'run';
    this.menuScreen.classList.add('hidden');
    this.overScreen.classList.add('hidden');
    this.hud.classList.remove('hidden');
    this.updateHud({ score: 0, combo: 0, speed: 18, shields: 0, boostFrac: 1 });
    this.comboEl.classList.remove('show');
  }

  updateHud(d: HudData): void {
    this.scoreEl.textContent = `${d.score}`;
    if (d.combo >= 2) {
      this.comboEl.textContent = `NEAR MISS ×${d.combo}`;
      this.comboEl.classList.add('show');
      this.comboEl.style.setProperty('--combo', `${Math.min(10, d.combo)}`);
    } else {
      this.comboEl.classList.remove('show');
    }
    this.speedEl.textContent = `${d.speed.toFixed(0)} u/s`;
    this.shieldEl.textContent = d.shields > 0 ? `●${d.shields > 1 ? d.shields : ''}` : '○';
    this.shieldEl.classList.toggle('lit', d.shields > 0);
    this.boostFill.style.width = `${(d.boostFrac * 100).toFixed(1)}%`;
    this.boostFill.classList.toggle('ready', d.boostFrac >= 1);
  }

  toast(text: string, bad = false): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.toggle('bad', bad);
    this.toastEl.classList.add('show');
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 1100);
  }

  hideHud(): void {
    this.hud.classList.add('hidden');
  }

  // ---- game over -----------------------------------------------------------------

  showGameOver(d: GameOverData): void {
    this.screen = 'over';
    this.hideHud();
    this.overScreen.classList.remove('hidden');

    this.overScore.textContent = `${d.score}`;
    if (d.prevBest === null || d.isPb) {
      this.overDelta.className = 'ob-delta pb';
      this.overDelta.textContent =
        d.prevBest === null ? 'FIRST RUN — SAVED' : 'NEW PERSONAL BEST';
    } else {
      this.overDelta.className = 'ob-delta slow';
      this.overDelta.textContent = `+${d.score - d.prevBest} vs best`;
    }
    this.overMeta.textContent = `${Math.floor(d.dist)}u · ${d.nearMisses} near misses · top combo ×${d.topCombo}`;
  }
}
