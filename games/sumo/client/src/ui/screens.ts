// ============================================================================
// SUMO SCREENS — menu (quick join / create private / join code), connection
// state and toasts. The app supplies the lobby callbacks.
// ============================================================================
import { loadName, saveName } from '@platform/shared';

export type Screen = 'menu' | 'game';

export interface ScreenCallbacks {
  onQuickJoin(name: string): void;
  onCreatePrivate(name: string): void;
  onJoinCode(name: string, code: string): void;
  onLeave(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  parent?.appendChild(e);
  return e;
}

export class Screens {
  readonly root: HTMLElement;
  private readonly menu: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly toastBox: HTMLDivElement;
  private toastTimer = 0;
  screen: Screen = 'menu';
  private readonly cb: ScreenCallbacks;

  constructor(parent: HTMLElement, cb: ScreenCallbacks) {
    this.cb = cb;

    this.menu = el('div', 'overlay', parent);
    const panel = el('div', 'menu-panel', this.menu);
    el('div', 'menu-title', panel).textContent = 'SUMO';
    el('div', 'menu-sub', panel).textContent =
      'shrink. shove. survive. — first to 3 rounds';

    this.nameInput = el('input', undefined, panel) as HTMLInputElement;
    this.nameInput.maxLength = 16;
    this.nameInput.placeholder = 'Your name';
    this.nameInput.value = loadName();

    const quick = el('button', 'btn primary', panel);
    quick.textContent = 'QUICK JOIN';
    quick.addEventListener('click', () => this.withName((n) => this.cb.onQuickJoin(n)));

    const priv = el('button', 'btn', panel);
    priv.textContent = 'CREATE PRIVATE ROOM';
    priv.addEventListener('click', () => this.withName((n) => this.cb.onCreatePrivate(n)));

    const row = el('div', 'join-row', panel);
    this.codeInput = el('input', undefined, row) as HTMLInputElement;
    this.codeInput.maxLength = 8;
    this.codeInput.placeholder = 'CODE';
    const go = el('button', 'btn', row);
    go.textContent = 'JOIN';
    go.addEventListener('click', () =>
      this.withName((n) => {
        const code = this.codeInput.value.trim().toUpperCase();
        if (code.length >= 4) this.cb.onJoinCode(n, code);
        else this.toast('enter a room code');
      }),
    );

    el('div', 'hint', panel).textContent =
      'WASD/arrows move · SHIFT dash · SPACE jump · TAB scoreboard';

    // in-game leave button
    this.leaveBtn = el('button', 'leave-btn hidden', parent);
    this.leaveBtn.textContent = 'LEAVE';
    this.leaveBtn.addEventListener('click', () => this.cb.onLeave());

    this.toastBox = el('div', 'toast hidden', parent);

    this.root = parent;
  }

  private readonly leaveBtn: HTMLButtonElement;

  setScreen(s: Screen): void {
    this.screen = s;
    this.menu.classList.toggle('hidden', s === 'game');
    this.leaveBtn.classList.toggle('hidden', s === 'menu');
    if (s === 'menu') this.toastBox.classList.add('hidden');
  }

  busy(busy: boolean): void {
    for (const b of this.menu.querySelectorAll('button')) {
      (b as HTMLButtonElement).disabled = busy;
    }
    if (busy) this.toast('connecting…');
  }

  toast(text: string): void {
    this.toastBox.textContent = text;
    this.toastBox.classList.remove('hidden');
    this.toastBox.style.opacity = '1';
    if (this.toastTimer !== 0) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastBox.style.opacity = '0';
      this.toastTimer = 0;
      window.setTimeout(() => {
        if (this.toastTimer === 0) this.toastBox.classList.add('hidden');
      }, 300);
    }, 2600);
  }

  private withName(fn: (name: string) => void): void {
    const name = this.nameInput.value.trim().slice(0, 16) || 'Player';
    saveName(name);
    fn(name);
  }
}
