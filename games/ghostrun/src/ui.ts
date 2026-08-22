// ============================================================================
// GHOSTRUN UI — plain-DOM overlay (menu / HUD / results / offline banner).
// Dumb by design: it renders state snapshots and forwards clicks through the
// callbacks handed to mountUi(). All styling lives in style.css; no assets.
// ============================================================================

export interface MenuData {
  readonly dateKey: string;
  readonly seed: number;
  readonly bestTimeMs: number | null;
  readonly hasGhostToday: boolean;
  readonly ghostTimeMs: number | null;
  readonly raceGhost: boolean;
  readonly localOnly: boolean;
}

export interface ResultsData {
  readonly timeMs: number;
  /** Delta vs the PREVIOUS best, or null on a first-ever finish. */
  readonly deltaMs: number | null;
  readonly isPb: boolean;
  readonly beatGhost: boolean;
  readonly respawns: number;
  readonly name: string;
}

export interface UiCallbacks {
  onStart(): void;
  onToggleRace(on: boolean): void;
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

/** mm:ss.cc — the one timer format used everywhere. */
export function formatMs(ms: number): string {
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${`${m}`.padStart(2, '0')}:${`${s}`.padStart(2, '0')}.${`${cs}`.padStart(2, '0')}`;
}

export class Ui {
  private readonly cb: UiCallbacks;

  private readonly root: HTMLDivElement;
  private readonly menuScreen: HTMLDivElement;
  private readonly dateValue: HTMLSpanElement;
  private readonly bestValue: HTMLSpanElement;
  private readonly ghostRow: HTMLDivElement;
  private readonly ghostValue: HTMLSpanElement;
  private readonly raceToggle: HTMLInputElement;
  private readonly offlineBanner: HTMLDivElement;

  private readonly hud: HTMLDivElement;
  private readonly timerEl: HTMLDivElement;
  private readonly bestChip: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly resultsScreen: HTMLDivElement;
  private readonly resultsBody: HTMLDivElement;

  screen: 'menu' | 'run' | 'results' = 'menu';

  constructor(cb: UiCallbacks) {
    this.cb = cb;
    this.root = el('div', 'gr-ui');
    document.body.appendChild(this.root);

    // ---- menu ----
    this.menuScreen = el('div', 'gr-screen', this.root);
    const title = el('h1', 'gr-title', this.menuScreen);
    title.textContent = 'GHOSTRUN';
    const sub = el('div', 'gr-sub', this.menuScreen);
    sub.textContent = "race yesterday's you";

    const card = el('div', 'gr-card', this.menuScreen);
    const dateRow = el('div', 'gr-row', card);
    const dateK = el('span', 'k', dateRow);
    dateK.textContent = "today's track";
    this.dateValue = el('span', 'v amber', dateRow);

    const bestRow = el('div', 'gr-row', card);
    const bestK = el('span', 'k', bestRow);
    bestK.textContent = 'personal best';
    this.bestValue = el('span', 'v teal', bestRow);

    this.ghostRow = el('div', 'gr-row', card);
    const gK = el('span', 'k', this.ghostRow);
    gK.textContent = 'ghost';
    this.ghostValue = el('span', 'v', this.ghostRow);

    const toggleLabel = el('label', 'gr-toggle', card);
    const tText = el('span', '', toggleLabel);
    tText.textContent = 'GHOST RACE';
    this.raceToggle = el('input', '', toggleLabel) as HTMLInputElement;
    this.raceToggle.type = 'checkbox';
    this.raceToggle.addEventListener('change', () => {
      this.cb.onToggleRace(this.raceToggle.checked);
    });

    const startBtn = el('button', 'gr-btn', card);
    startBtn.type = 'button';
    startBtn.textContent = 'START RUN';
    startBtn.addEventListener('click', () => this.cb.onStart());

    this.offlineBanner = el('div', 'gr-banner hidden', card);
    this.offlineBanner.textContent = 'offline — progress saves locally';

    const hint = el('div', 'gr-hint', this.menuScreen);
    hint.innerHTML =
      '<b>WASD / arrows</b> move &middot; <b>space</b> jump &middot; gamepad left stick + A<br>' +
      'gaps need jumps &middot; ferries cross wide gaps &middot; falls cost <b>+1s</b><br>' +
      'beat your saved ghost — it runs beside you';

    // ---- HUD ----
    this.hud = el('div', 'hidden', this.root);
    this.hud.id = 'gr-hud';
    this.timerEl = el('div', '', this.hud);
    this.timerEl.id = 'gr-timer';
    this.bestChip = el('div', '', this.hud);
    this.bestChip.id = 'gr-bestchip';
    this.toastEl = el('div', '', this.hud);
    this.toastEl.id = 'gr-toast';

    // ---- results ----
    this.resultsScreen = el('div', 'gr-screen hidden', this.root);
    const rTitle = el('h1', 'gr-title', this.resultsScreen);
    rTitle.style.fontSize = 'clamp(30px, 6vw, 52px)';
    rTitle.textContent = 'FINISH';
    const rCard = el('div', 'gr-card', this.resultsScreen);
    this.resultsBody = el('div', '', rCard);
    const actions = el('div', 'gr-actions', rCard);
    const retryBtn = el('button', 'gr-btn', actions);
    retryBtn.type = 'button';
    retryBtn.textContent = 'RETRY';
    retryBtn.addEventListener('click', () => this.cb.onRetry());
    const menuBtn = el('button', 'gr-btn ghosty', actions);
    menuBtn.type = 'button';
    menuBtn.textContent = 'MENU';
    menuBtn.addEventListener('click', () => this.cb.onMenu());
  }

  // ---- menu ---------------------------------------------------------------

  showMenu(d: MenuData): void {
    this.screen = 'menu';
    this.menuScreen.classList.remove('hidden');
    this.hud.classList.add('hidden');
    this.resultsScreen.classList.add('hidden');

    const dateEl = this.dateValue;
    dateEl.textContent = `#${d.seed.toString(16)} · ${d.dateKey}`;

    this.bestValue.textContent = d.bestTimeMs === null ? '— no finish yet' : formatMs(d.bestTimeMs);

    if (d.ghostTimeMs !== null && d.hasGhostToday) {
      this.ghostValue.textContent = `ready · ${formatMs(d.ghostTimeMs)}`;
      this.ghostValue.className = 'v teal';
      this.raceToggle.disabled = false;
    } else {
      this.ghostValue.textContent = 'none yet — set a time';
      this.ghostValue.className = 'v';
      this.raceToggle.checked = false;
      this.raceToggle.disabled = true;
    }
    if (!this.raceToggle.disabled && d.raceGhost) this.raceToggle.checked = true;

    this.offlineBanner.classList.toggle('hidden', !d.localOnly);
  }

  get raceGhost(): boolean {
    return !this.raceToggle.disabled && this.raceToggle.checked;
  }

  // ---- hud ------------------------------------------------------------------

  showHud(bestTimeMs: number | null): void {
    this.screen = 'run';
    this.menuScreen.classList.add('hidden');
    this.resultsScreen.classList.add('hidden');
    this.hud.classList.remove('hidden');
    this.bestChip.textContent =
      bestTimeMs === null ? 'no personal best yet' : `best ${formatMs(bestTimeMs)}`;
    this.updateTimer(0);
  }

  updateTimer(ms: number): void {
    this.timerEl.textContent = formatMs(ms);
  }

  toast(text: string, bad = false): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.toggle('bad', bad);
    this.toastEl.classList.add('show');
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 1400);
  }

  hideHud(): void {
    this.hud.classList.add('hidden');
  }

  // ---- results -----------------------------------------------------------------

  showResults(d: ResultsData): void {
    this.screen = 'results';
    this.hideHud();
    this.resultsScreen.classList.remove('hidden');
    this.resultsBody.textContent = '';

    const time = el('div', 'gr-delta', this.resultsBody);
    time.style.fontSize = '40px';
    time.style.color = '#f5f8fa';
    time.textContent = formatMs(d.timeMs);

    const delta = el('div', 'gr-delta', this.resultsBody);
    if (d.deltaMs === null) {
      delta.className = 'gr-delta first';
      delta.textContent = 'FIRST FINISH — SAVED';
    } else if (d.isPb) {
      delta.className = 'gr-delta pb';
      delta.textContent = `−${formatMs(-d.deltaMs)} PERSONAL BEST`;
    } else {
      delta.className = 'gr-delta slow';
      delta.textContent = `+${formatMs(d.deltaMs)} vs best`;
    }
    if (d.beatGhost) {
      const beat = el('div', 'gr-delta first', this.resultsBody);
      beat.style.fontSize = '14px';
      beat.textContent = 'YOU BEAT YOUR GHOST';
    }

    const meta = el('div', 'gr-row', this.resultsBody);
    const mk = el('span', 'k', meta);
    mk.textContent = 'runner · falls';
    const mv = el('span', 'v', meta);
    mv.textContent = `${d.name} · ${d.respawns}`;

    const name = el('div', 'gr-name', this.resultsBody);
    name.textContent = 'cloud saves as gameplay data';
  }
}
