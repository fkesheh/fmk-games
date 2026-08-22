// ============================================================================
// SUMO HUD — round timer, alive count, dash/jump cooldown pips, center
// banners, killfeed and the Tab scoreboard. Pure DOM; the app drives it.
// ============================================================================
import { DASH_COOLDOWN_S } from '@sumo/shared';
import type { SumoEvent, SumoWinRow } from '@sumo/shared';

export interface HudState {
  phase: string;
  msLeft: number; // until phaseEndsAt (server clock)
  alive: number;
  round: number;
  radiusFrac: number; // 0..1 (radius - R_END)/(R_START - R_END)
  dashCdSec: number;
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

export class Hud {
  readonly root: HTMLDivElement;
  private readonly timer: HTMLDivElement;
  private readonly alive: HTMLDivElement;
  private readonly roundLbl: HTMLDivElement;
  private readonly bannerBox: HTMLDivElement;
  private readonly feedBox: HTMLDivElement;
  private readonly board: HTMLDivElement;
  private readonly boardBody: HTMLTableSectionElement;
  private readonly dashFill: HTMLElement;
  private readonly jumpFill: HTMLElement;
  private bannerTimer = 0;
  private readonly names = new Map<string, string>();

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hidden', parent);
    this.root.id = 'hud';

    const top = el('div', 'hud-top', this.root);
    this.roundLbl = el('div', 'hud-round', top);
    this.timer = el('div', 'hud-timer', top);
    this.alive = el('div', 'hud-alive', top);

    const pips = el('div', 'pips', this.root);
    const dashPip = el('div', 'pip', pips);
    el('span', 'pip-label', dashPip).textContent = 'DASH';
    this.dashFill = el('i', undefined, dashPip);
    const jumpPip = el('div', 'pip jump', pips);
    el('span', 'pip-label', jumpPip).textContent = 'JUMP';
    this.jumpFill = el('i', undefined, jumpPip);

    this.bannerBox = el('div', 'banner', this.root);
    this.feedBox = el('div', 'feed', this.root);

    this.board = el('div', 'board hidden', this.root);
    el('h3', undefined, this.board).textContent = 'FIRST TO 3 — SCOREBOARD';
    const table = el('table', undefined, this.board);
    this.boardBody = el('tbody', undefined, table);
  }

  show(): void {
    this.root.classList.remove('hidden');
  }
  hide(): void {
    this.root.classList.add('hidden');
  }

  setNames(names: ReadonlyMap<string, string>): void {
    for (const [id, name] of names) this.names.set(id, name);
  }

  nameOf(id: string): string {
    return this.names.get(id) ?? id.slice(0, 6);
  }

  update(st: HudState): void {
    // timer text per phase
    let txt = '';
    let warn = false;
    switch (st.phase) {
      case 'warmup':
        txt = 'WAITING';
        break;
      case 'countdown':
        txt = String(Math.max(1, Math.ceil(st.msLeft / 1000)));
        break;
      case 'live': {
        const s = Math.max(0, Math.ceil(st.msLeft / 1000));
        txt = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        warn = st.radiusFrac < 0.35 || s <= 10;
        break;
      }
      default:
        txt = '—';
    }
    this.timer.textContent = txt;
    this.timer.classList.toggle('warn', warn);
    this.alive.textContent = `${st.alive} ALIVE`;
    this.roundLbl.textContent = `ROUND ${st.round}`;

    const dashReady = st.dashCdSec <= 0;
    this.dashFill.style.transform = `scaleX(${dashReady ? 1 : 1 - Math.min(1, st.dashCdSec / DASH_COOLDOWN_S)})`;
    this.jumpFill.style.transform = 'scaleX(1)'; // jump has no cooldown

    // banner auto-hide
    if (this.bannerTimer !== 0 && Date.now() > this.bannerTimer) this.hideBanner();
  }

  showBanner(text: string, sub: string | null, mood: '' | 'win' | 'lose', holdMs: number): void {
    this.bannerBox.className = `banner show ${mood}`.trim();
    this.bannerBox.textContent = text;
    if (sub !== null) {
      const s = document.createElement('span');
      s.className = 'sub';
      s.textContent = sub;
      this.bannerBox.appendChild(s);
    }
    this.bannerTimer = Date.now() + holdMs;
  }

  hideBanner(): void {
    this.bannerBox.className = 'banner';
    this.bannerTimer = 0;
  }

  feedEvent(ev: SumoEvent, youId: string | null): void {
    let html: string | null = null;
    if (ev.kind === 'ko') {
      const victim = this.nameOf(ev.victim);
      html =
        ev.by === null || ev.by === ev.victim
          ? `${victim} slipped into the void`
          : `<b>${this.nameOf(ev.by)}</b> yeeted ${victim}`;
      if (ev.victim === youId) html += ' — YOU';
    } else if (ev.kind === 'round_end') {
      html =
        ev.draw || ev.winner === null
          ? 'round ended — draw'
          : `<b>${this.nameOf(ev.winner)}</b> takes the round`;
    } else if (ev.kind === 'match_end') {
      html = `<b>${this.nameOf(ev.champion)}</b> wins the MATCH`;
    }
    if (html === null) return;
    const line = el('div', 'feed-line', this.feedBox);
    line.innerHTML = html;
    while (this.feedBox.children.length > 4) {
      this.feedBox.firstChild?.remove();
    }
    window.setTimeout(() => line.remove(), 5200);
  }

  showBoard(rows: SumoWinRow[], youId: string | null): void {
    this.board.classList.remove('hidden');
    this.boardBody.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      if (r.id === youId) tr.className = 'me';
      const tdName = document.createElement('td');
      tdName.textContent = r.name;
      const tdWins = document.createElement('td');
      tdWins.textContent = '★'.repeat(Math.min(r.wins, 5)) + (r.wins > 5 ? `+${r.wins - 5}` : '');
      tr.appendChild(tdName);
      tr.appendChild(tdWins);
      this.boardBody.appendChild(tr);
    }
  }

  hideBoard(): void {
    this.board.classList.add('hidden');
  }
}
