// ============================================================================
// C9 — Menus (main / buy / scoreboard / match end / joining / pause / room chip).
// DOM overlays mounted on the #menu root handed in by C11. Styles are injected
// here (style.css belongs to C11). Every color traces to PALETTE via CSS custom
// properties (--m9-*) set on the root element.
// ============================================================================
import { MAP_LIST, PALETTE, PRIVATE_CODE_LEN, WEAPONS } from '@fps/shared';
import type {
  MapId,
  PlayerId,
  RoomInfo,
  RoomPhase,
  RosterEntry,
  Team,
  WeaponId,
} from '@fps/shared';

export interface MenuCallbacks {
  onQuickJoin(name: string): void;
  onCreatePrivate(name: string, mapId: MapId): void;
  onJoinPrivate(name: string, code: string): void;
  onListRooms(): Promise<RoomInfo[]>;
  onBuy(weapon: WeaponId): void;
  onResume(): void; // re-request pointer lock
  onLeave(): void; // leave room -> main menu
}

// ---- private constants ------------------------------------------------------
const NAME_KEY = 'stricken.name';
const STYLE_ID = 'fps-menus-style';

type LayerId = 'main' | 'buy' | 'score' | 'end' | 'joining' | 'pause' | 'chip';
// modal layers are mutually exclusive; scoreboard + chip stack on top freely
const MODALS: readonly LayerId[] = ['main', 'buy', 'end', 'joining', 'pause'];

// buyable primaries; knife+pistol are issued and never for sale
const PRIMARIES: readonly WeaponId[] = ['smg', 'shotgun', 'rifle', 'sniper'];

// one-line roles, from DESIGN_BIBLE weapon intent
const ROLES: Record<WeaponId, string> = {
  knife: 'Issued blade — fastest move, desperation kills.',
  pistol: 'Issued sidearm — free default; headshot ×3 rewards aim.',
  smg: 'Close-range shredder, anti-eco; falls off hard past 14m.',
  shotgun: 'One-pump burst up to 6m, useless past 18m; hold tight corners.',
  rifle: 'The default competitive gun — 1-tap headshot at all ranges.',
  sniper: '1-shot body kill, slowest handling; scope to be lethal.',
};

const PHASE_LABEL: Record<RoomPhase, string> = {
  warmup: 'Warmup',
  freeze: 'Buy',
  live: 'Live',
  roundEnd: 'Round end',
  matchEnd: 'Match end',
};

const TEAM_NAME: Record<Team, string> = { T: 'TERRORISTS', CT: 'COUNTER-TERRORISTS' };

const MAP_NAMES = new Map<MapId, string>(MAP_LIST.map((m) => [m.id, m.name]));

// onboarding controls card per UX_BIBLE (WASD/mouse/LMB/R/B/Tab/1-6/Esc)
const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['WASD', 'Move'],
  ['Mouse', 'Look'],
  ['LMB', 'Fire'],
  ['R', 'Reload'],
  ['B', 'Buy'],
  ['Tab', 'Score'],
  ['1-6 / Wheel', 'Weapons'],
  ['Esc', 'Menu'],
];

// ---- small DOM helpers ------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== '') n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// '#rrggbb' -> 'r,g,b' so the stylesheet can build rgba() tints from PALETTE
function hexRgb(hex: string): string {
  const v = parseInt(hex.slice(1), 16);
  return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
}

function byScore(a: RosterEntry, b: RosterEntry): number {
  return b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name);
}

function injectStyleOnce(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ============================================================================
export class Menus {
  private readonly cb: MenuCallbacks;
  private readonly host: HTMLElement;
  private readonly layers: Record<LayerId, HTMLElement>;

  private nameInput: HTMLInputElement | null = null;
  private roomListEl: HTMLElement | null = null;
  private roomReq = 0; // stale-guard for async room-list refreshes
  private scoreSig = ''; // scoreboard content signature — skips no-op rebuilds
  private selectedMap: MapId = MAP_LIST[0]?.id ?? 'dustbowl';

  constructor(root: HTMLElement, cb: MenuCallbacks) {
    this.cb = cb;
    for (const [key, hex] of Object.entries(PALETTE)) {
      root.style.setProperty(`--m9-${key}`, hex);
      root.style.setProperty(`--m9-${key}-rgb`, hexRgb(hex));
    }
    injectStyleOnce();
    this.host = el('div', 'fps-menus');
    root.appendChild(this.host);
    this.layers = {
      main: this.makeLayer('main', true),
      buy: this.makeLayer('buy', true),
      score: this.makeLayer('score', true),
      end: this.makeLayer('end', true),
      joining: this.makeLayer('joining', true),
      pause: this.makeLayer('pause', true),
      chip: this.makeLayer('chip', false), // non-modal: never eats pointer events
    };
    this.buildJoining();
    this.buildPause();
  }

  // ---- layer plumbing -------------------------------------------------------
  private makeLayer(id: LayerId, modal: boolean): HTMLElement {
    const d = el('div', `m9-layer${modal ? ' m9-modal' : ''} m9-layer-${id}`);
    d.style.display = 'none';
    this.host.appendChild(d);
    return d;
  }

  private show(id: LayerId): void {
    this.layers[id].style.display = 'flex';
  }
  private hide(id: LayerId): void {
    this.layers[id].style.display = 'none';
  }
  private isShown(id: LayerId): boolean {
    return this.layers[id].style.display !== 'none';
  }
  private showExclusive(id: LayerId): void {
    for (const m of MODALS) this.hide(m);
    this.show(id);
  }

  // ---- main menu ------------------------------------------------------------
  showMain(errorText?: string): void {
    this.showExclusive('main');
    this.hide('score');
    this.hide('chip');
    const layer = this.layers.main;
    layer.textContent = '';

    const panel = el('div', 'm9-panel m9-main-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Main menu');
    panel.appendChild(el('h1', 'm9-title', 'STRICKEN'));
    panel.appendChild(el('div', 'm9-rule'));

    // name (persisted)
    const field = el('div', 'm9-field');
    field.appendChild(el('label', 'm9-label', 'CALLSIGN'));
    const nameInput = el('input', 'm9-input');
    nameInput.maxLength = 16;
    nameInput.spellcheck = false;
    nameInput.autocomplete = 'off';
    nameInput.placeholder = 'Player';
    nameInput.value = this.loadName();
    nameInput.addEventListener('input', () => {
      const v = nameInput.value.trim();
      if (v !== '') this.persistName(v);
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.cb.onQuickJoin(this.name());
    });
    this.nameInput = nameInput;
    field.appendChild(nameInput);
    panel.appendChild(field);

    const quick = el('button', 'm9-btn m9-btn-primary m9-quick', 'QUICK JOIN');
    quick.type = 'button';
    quick.addEventListener('click', () => this.cb.onQuickJoin(this.name()));
    panel.appendChild(quick);

    if (errorText !== undefined && errorText !== '') {
      const err = el('div', 'm9-error', errorText);
      err.setAttribute('role', 'alert');
      panel.appendChild(err);
    }

    const cols = el('div', 'm9-cols');
    cols.appendChild(this.buildCreateCol());
    cols.appendChild(this.buildJoinCol());
    panel.appendChild(cols);

    // public room list
    const roomsSec = el('div', 'm9-sec m9-rooms-sec');
    const roomsHead = el('div', 'm9-rooms-head');
    roomsHead.appendChild(el('h2', 'm9-sec-title', 'PUBLIC ROOMS'));
    const refresh = el('button', 'm9-btn m9-btn-small', 'REFRESH');
    refresh.type = 'button';
    refresh.addEventListener('click', () => this.loadRooms());
    roomsHead.appendChild(refresh);
    roomsSec.appendChild(roomsHead);
    const list = el('div', 'm9-room-list');
    this.roomListEl = list;
    roomsSec.appendChild(list);
    panel.appendChild(roomsSec);

    panel.appendChild(this.buildControls());
    layer.appendChild(panel);
    this.loadRooms();
  }

  private buildCreateCol(): HTMLElement {
    const sec = el('div', 'm9-sec');
    sec.appendChild(el('h2', 'm9-sec-title', 'CREATE PRIVATE'));
    const grid = el('div', 'm9-map-grid');
    const buttons: HTMLButtonElement[] = [];
    for (const m of MAP_LIST) {
      const b = el('button', 'm9-btn m9-map', m.name);
      b.type = 'button';
      if (m.id === this.selectedMap) b.classList.add('m9-sel');
      b.addEventListener('click', () => {
        this.selectedMap = m.id;
        for (const other of buttons) other.classList.toggle('m9-sel', other === b);
      });
      buttons.push(b);
      grid.appendChild(b);
    }
    sec.appendChild(grid);
    const create = el('button', 'm9-btn m9-btn-primary m9-wide', 'CREATE');
    create.type = 'button';
    create.addEventListener('click', () => this.cb.onCreatePrivate(this.name(), this.selectedMap));
    sec.appendChild(create);
    return sec;
  }

  private buildJoinCol(): HTMLElement {
    const sec = el('div', 'm9-sec');
    sec.appendChild(el('h2', 'm9-sec-title', 'JOIN PRIVATE'));
    const code = el('input', 'm9-input m9-code');
    code.maxLength = PRIVATE_CODE_LEN;
    code.placeholder = 'CODE';
    code.spellcheck = false;
    code.autocomplete = 'off';
    code.setAttribute('aria-label', '5-character room code');
    const join = el('button', 'm9-btn m9-btn-primary m9-wide', 'JOIN');
    join.type = 'button';
    join.disabled = true;
    const tryJoin = () => {
      if (code.value.length === PRIVATE_CODE_LEN) this.cb.onJoinPrivate(this.name(), code.value);
    };
    code.addEventListener('input', () => {
      code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      join.disabled = code.value.length !== PRIVATE_CODE_LEN;
    });
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tryJoin();
    });
    join.addEventListener('click', tryJoin);
    sec.appendChild(code);
    sec.appendChild(join);
    return sec;
  }

  private buildControls(): HTMLElement {
    const sec = el('div', 'm9-sec');
    sec.appendChild(el('h2', 'm9-sec-title', 'CONTROLS'));
    const grid = el('div', 'm9-controls');
    for (const [key, verb] of CONTROLS) {
      const item = el('div', 'm9-ctl');
      item.appendChild(el('span', 'm9-kbd', key));
      item.appendChild(el('span', '', verb));
      grid.appendChild(item);
    }
    sec.appendChild(grid);
    return sec;
  }

  private loadRooms(): void {
    const req = ++this.roomReq;
    this.setRoomsMsg('Scanning for rooms…');
    this.cb
      .onListRooms()
      .then((rooms) => {
        if (req !== this.roomReq || !this.isShown('main')) return;
        this.renderRooms(rooms.filter((r) => r.visibility === 'public'));
      })
      .catch(() => {
        if (req !== this.roomReq || !this.isShown('main')) return;
        this.setRoomsMsg('Room list unavailable — try Refresh');
      });
  }

  private setRoomsMsg(msg: string): void {
    const list = this.roomListEl;
    if (!list) return;
    list.textContent = '';
    list.appendChild(el('div', 'm9-room-empty', msg));
  }

  private renderRooms(rooms: RoomInfo[]): void {
    const list = this.roomListEl;
    if (!list) return;
    list.textContent = '';
    if (rooms.length === 0) {
      // exact empty-state copy from UX_BIBLE
      list.appendChild(el('div', 'm9-room-empty', 'No public rooms yet — Quick Join creates one'));
      return;
    }
    for (const r of rooms) {
      const row = el('button', 'm9-room-row');
      row.type = 'button';
      row.title = 'Click to join';
      row.appendChild(el('span', 'm9-room-map', MAP_NAMES.get(r.mapId) ?? r.mapId));
      row.appendChild(el('span', 'm9-room-players', `${r.players}/${r.maxPlayers}`));
      row.appendChild(el('span', 'm9-room-phase', PHASE_LABEL[r.phase]));
      row.addEventListener('click', () => this.cb.onQuickJoin(this.name()));
      list.appendChild(row);
    }
  }

  // ---- room chip (top-left, non-modal) --------------------------------------
  showInRoom(roomLabel: string, code: string | null): void {
    const chip = this.layers.chip;
    chip.textContent = '';
    chip.appendChild(
      el('div', 'm9-chip', code !== null ? `${roomLabel} · code ${code} (share)` : roomLabel),
    );
    this.show('chip');
  }

  // ---- buy menu ---------------------------------------------------------------
  showBuy(money: number, owned: WeaponId[], canBuy: boolean): void {
    this.showExclusive('buy');
    const layer = this.layers.buy;
    layer.textContent = '';

    const panel = el('div', 'm9-panel m9-buy-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Buy menu');

    const head = el('div', 'm9-buy-head');
    head.appendChild(el('h2', 'm9-sec-title m9-buy-title', 'BUY MENU'));
    head.appendChild(el('div', 'm9-money', `$${money}`));
    panel.appendChild(head);

    if (!canBuy) panel.appendChild(el('div', 'm9-note', 'Buy time expired'));

    const grid = el('div', 'm9-buy-grid');
    for (const id of PRIMARIES) {
      grid.appendChild(this.buildBuyCard(id, money, owned.includes(id), canBuy));
    }
    panel.appendChild(grid);

    const issued = el('div', 'm9-issued');
    for (const id of ['knife', 'pistol'] as const) {
      const chip = el('div', 'm9-issued-chip');
      chip.appendChild(el('span', 'm9-issued-name', WEAPONS[id].name));
      chip.appendChild(el('span', 'm9-tag', 'ISSUED'));
      issued.appendChild(chip);
    }
    panel.appendChild(issued);
    panel.appendChild(el('div', 'm9-hint', 'B / Esc to close'));
    layer.appendChild(panel);
  }

  private buildBuyCard(id: WeaponId, money: number, isOwned: boolean, canBuy: boolean): HTMLElement {
    const def = WEAPONS[id];
    const affordable = money >= def.price;
    const off = !isOwned && (!affordable || !canBuy); // disabled at 40% opacity

    const card = el('button', 'm9-card');
    card.type = 'button';
    if (isOwned) card.classList.add('m9-owned');
    if (off) card.classList.add('m9-off');

    const top = el('div', 'm9-card-top');
    top.appendChild(el('span', 'm9-card-name', def.name));
    top.appendChild(el('span', 'm9-card-price', `$${def.price}`));
    card.appendChild(top);

    const dmg = def.pellets > 1 ? `${def.damage}×${def.pellets}` : `${def.damage}`;
    card.appendChild(
      el('div', 'm9-card-stats', `DMG ${dmg} · RPM ${Math.round(60 / def.interval)} · MAG ${def.mag}`),
    );
    card.appendChild(el('div', 'm9-card-role', ROLES[id]));

    let tag = '';
    let bad = false;
    if (isOwned) tag = 'OWNED';
    else if (!canBuy) {
      tag = 'CLOSED';
      bad = true;
    } else if (!affordable) {
      tag = 'TOO EXPENSIVE';
      bad = true;
    }
    if (tag !== '') card.appendChild(el('div', bad ? 'm9-tag m9-bad' : 'm9-tag', tag));

    card.addEventListener('click', () => {
      if (isOwned || off) return;
      this.cb.onBuy(id); // menu stays open; caller re-shows with updated money
    });
    return card;
  }

  hideBuy(): void {
    this.hide('buy');
  }

  // ---- scoreboard -------------------------------------------------------------
  showScoreboard(roster: RosterEntry[], you: PlayerId, scoreT: number, scoreCT: number): void {
    // C10 may call this every snapshot while Tab is held — skip no-op rebuilds
    const sig =
      `${scoreT}|${scoreCT}|${you}|` +
      roster
        .map((r) => `${r.id}:${r.name}:${r.team}:${r.kills}:${r.deaths}:${r.money ?? ''}:${r.connected ? 1 : 0}`)
        .join('|');
    if (sig === this.scoreSig && this.isShown('score')) return;
    this.scoreSig = sig;
    this.show('score'); // stacks over the game (and buy) — not exclusive

    const layer = this.layers.score;
    layer.textContent = '';
    const panel = el('div', 'm9-panel m9-score-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Scoreboard');

    const head = el('div', 'm9-score-head');
    head.appendChild(el('span', 'm9-t', 'T'));
    head.appendChild(document.createTextNode(` ${scoreT} : ${scoreCT} `));
    head.appendChild(el('span', 'm9-ct', 'CT'));
    panel.appendChild(head);

    const tables = el('div', 'm9-tables');
    tables.appendChild(this.buildTeamTable('T', roster, you));
    tables.appendChild(this.buildTeamTable('CT', roster, you));
    panel.appendChild(tables);
    layer.appendChild(panel);
  }

  private buildTeamTable(team: Team, roster: RosterEntry[], you: PlayerId): HTMLElement {
    const wrap = el('div', 'm9-table');
    const head = el('div', `m9-table-head ${team === 'T' ? 'm9-th-t' : 'm9-th-ct'}`);
    head.textContent = `${team} — ${TEAM_NAME[team]}`;
    wrap.appendChild(head);

    const cols = el('div', 'm9-row m9-cols-head');
    cols.appendChild(el('span', '', ''));
    cols.appendChild(el('span', '', 'NAME'));
    cols.appendChild(el('span', 'm9-c-num', 'K'));
    cols.appendChild(el('span', 'm9-c-num', 'D'));
    cols.appendChild(el('span', 'm9-c-num', '$'));
    wrap.appendChild(cols);

    const rows = roster.filter((r) => r.team === team).sort(byScore);
    if (rows.length === 0) wrap.appendChild(el('div', 'm9-room-empty', 'No players'));
    for (const r of rows) {
      const row = el('div', 'm9-row');
      if (r.id === you) row.classList.add('m9-you');
      // RosterEntry carries no alive flag — the status dot tracks `connected`
      const dot = el('span', 'm9-dot');
      if (!r.connected) dot.classList.add('m9-off');
      dot.title = r.connected ? 'connected' : 'disconnected';
      row.appendChild(dot);
      row.appendChild(el('span', 'm9-c-name', r.name));
      row.appendChild(el('span', 'm9-c-num', `${r.kills}`));
      row.appendChild(el('span', 'm9-c-num', `${r.deaths}`));
      row.appendChild(el('span', 'm9-c-num', r.id === you && r.money !== null ? `$${r.money}` : ''));
      wrap.appendChild(row);
    }
    return wrap;
  }

  hideScoreboard(): void {
    this.hide('score');
    this.scoreSig = '';
  }

  // ---- match end ----------------------------------------------------------------
  showMatchEnd(
    winner: Team,
    scoreT: number,
    scoreCT: number,
    youTeam: Team | null,
    roster: RosterEntry[],
  ): void {
    this.showExclusive('end');
    this.hide('score');
    const layer = this.layers.end;
    layer.textContent = '';

    const panel = el('div', 'm9-end-panel');
    const title = youTeam === null ? 'MATCH OVER' : youTeam === winner ? 'VICTORY' : 'DEFEAT';
    const cls = youTeam === null ? 'm9-end-over' : youTeam === winner ? 'm9-end-win' : 'm9-end-lose';
    panel.appendChild(el('h1', `m9-end-title ${cls}`, title));

    const score = el('div', 'm9-end-score');
    score.appendChild(el('span', 'm9-t', 'T'));
    score.appendChild(document.createTextNode(` ${scoreT} : ${scoreCT} `));
    score.appendChild(el('span', 'm9-ct', 'CT'));
    panel.appendChild(score);

    const list = el('div', 'm9-top3');
    [...roster]
      .sort(byScore)
      .slice(0, 3)
      .forEach((r, i) => {
        const row = el('div', 'm9-top3-row');
        row.appendChild(el('span', 'm9-top3-rank', `#${i + 1}`));
        row.appendChild(el('span', r.team === 'T' ? 'm9-t' : 'm9-ct', r.team));
        row.appendChild(el('span', 'm9-top3-name', r.name));
        row.appendChild(el('span', 'm9-top3-kd', `${r.kills} K · ${r.deaths} D`));
        list.appendChild(row);
      });
    panel.appendChild(list);
    panel.appendChild(el('div', 'm9-hint', 'Returning to warmup…'));
    layer.appendChild(panel);
  }

  // ---- joining / pause (static content, built once) ------------------------------
  private buildJoining(): void {
    this.layers.joining.appendChild(el('div', 'm9-join-text', 'Joining…'));
  }

  showJoining(): void {
    this.showExclusive('joining');
    this.hide('score');
    this.hide('chip');
  }

  private buildPause(): void {
    const panel = el('div', 'm9-panel m9-pause-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Paused');
    panel.appendChild(el('h2', 'm9-pause-title', 'PAUSED'));
    const resume = el('button', 'm9-btn m9-btn-primary m9-wide', 'RESUME');
    resume.type = 'button';
    resume.addEventListener('click', () => {
      this.hide('pause');
      this.cb.onResume();
    });
    const leave = el('button', 'm9-btn m9-btn-danger m9-wide', 'LEAVE ROOM');
    leave.type = 'button';
    leave.addEventListener('click', () => {
      this.hide('pause');
      this.cb.onLeave();
    });
    panel.appendChild(resume);
    panel.appendChild(leave);
    this.layers.pause.appendChild(panel);
  }

  showPause(): void {
    this.showExclusive('pause');
  }

  hideAll(): void {
    for (const id of Object.keys(this.layers) as LayerId[]) this.hide(id);
    this.scoreSig = '';
  }

  // ---- name persistence ----------------------------------------------------------
  private name(): string {
    const raw = this.nameInput ? this.nameInput.value : '';
    const n = raw.trim() || 'Player';
    this.persistName(n);
    return n;
  }

  private loadName(): string {
    try {
      const v = localStorage.getItem(NAME_KEY);
      return v !== null && v.trim() !== '' ? v : 'Player';
    } catch {
      return 'Player'; // storage blocked (private mode) — non-fatal
    }
  }

  private persistName(n: string): void {
    try {
      localStorage.setItem(NAME_KEY, n);
    } catch {
      // storage blocked — non-fatal
    }
  }
}

// ---- injected stylesheet (all colors via --m9-* PALETTE custom properties) ----
const CSS = `
.fps-menus{position:fixed;inset:0;pointer-events:none;z-index:40;
  font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:var(--m9-hudText);}
.fps-menus *{box-sizing:border-box;}
.fps-menus .m9-layer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;}
.fps-menus .m9-modal{pointer-events:auto;background:rgba(var(--m9-ink-rgb),.78);}

.fps-menus .m9-panel{background:rgba(var(--m9-ink-rgb),.97);border:1px solid var(--m9-metalDark);
  border-radius:10px;padding:22px 26px;max-height:94vh;overflow-y:auto;
  box-shadow:0 14px 44px rgba(var(--m9-ink-rgb),.7);}
.m9-main-panel{width:min(760px,94vw);}

.fps-menus .m9-btn{font:inherit;font-size:14px;font-weight:700;letter-spacing:.06em;
  text-transform:uppercase;cursor:pointer;color:var(--m9-hudText);
  background:var(--m9-charcoal);border:1px solid var(--m9-metalDark);border-radius:6px;padding:10px 16px;}
.fps-menus .m9-btn:hover:not(:disabled){border-color:var(--m9-hudAccent);}
.fps-menus .m9-btn:disabled{opacity:.4;cursor:default;}
.m9-btn-primary{background:var(--m9-hudAccent);border-color:var(--m9-hudAccent);color:var(--m9-ink);}
.m9-btn-small{padding:5px 10px;font-size:12px;}
.m9-btn-danger{border-color:var(--m9-danger);color:var(--m9-danger);}
.m9-btn-danger:hover{background:rgba(var(--m9-danger-rgb),.15);}
.m9-wide{width:100%;}

.fps-menus .m9-input{font:inherit;width:100%;background:var(--m9-charcoal);color:var(--m9-hudText);
  border:1px solid var(--m9-metalDark);border-radius:6px;padding:10px 12px;font-size:15px;outline:none;}
.fps-menus .m9-input:focus{border-color:var(--m9-hudAccent);}

.m9-title{margin:0;font-size:42px;font-weight:800;letter-spacing:.24em;text-align:center;}
.m9-rule{height:3px;width:88px;margin:10px auto 18px;background:var(--m9-hudAccent);border-radius:2px;}
.m9-field{margin-bottom:12px;}
.m9-label{display:block;font-size:12px;letter-spacing:.14em;color:var(--m9-steel);margin-bottom:6px;}
.m9-quick{width:100%;padding:14px;font-size:17px;margin-bottom:4px;}
.m9-error{color:var(--m9-danger);font-size:13px;margin:8px 0 10px;text-align:center;}

.m9-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
.m9-sec{border:1px solid var(--m9-metalDark);border-radius:8px;padding:12px;}
.m9-sec-title{margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:.16em;color:var(--m9-steel);}
.m9-map-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;}
.m9-map{padding:8px 2px;font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:none;}
.m9-map.m9-sel{border-color:var(--m9-hudAccent);color:var(--m9-hudAccent);}
.m9-code{text-align:center;letter-spacing:.4em;text-transform:uppercase;margin-bottom:10px;
  font-family:ui-monospace,Menlo,Consolas,monospace;}

.m9-rooms-sec{margin-bottom:12px;}
.m9-rooms-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
.m9-rooms-head .m9-sec-title{margin:0;}
.m9-room-list{display:flex;flex-direction:column;gap:4px;max-height:168px;overflow-y:auto;}
.m9-room-row{display:grid;grid-template-columns:1fr 64px 84px;gap:8px;align-items:center;
  padding:7px 10px;background:var(--m9-charcoal);border:1px solid var(--m9-metalDark);border-radius:6px;
  color:var(--m9-hudText);font:inherit;font-size:13px;cursor:pointer;text-align:left;}
.m9-room-row:hover{border-color:var(--m9-hudAccent);}
.m9-room-players,.m9-room-phase{color:var(--m9-steel);font-variant-numeric:tabular-nums;}
.m9-room-empty{color:var(--m9-steel);font-size:13px;padding:10px 2px;}

.m9-controls{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 12px;}
.m9-ctl{display:flex;gap:6px;align-items:baseline;font-size:12px;color:var(--m9-steel);}
.m9-kbd{background:var(--m9-metalDark);color:var(--m9-hudText);border-radius:4px;padding:1px 6px;
  font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:nowrap;}

.m9-buy-panel{width:min(880px,96vw);}
.m9-buy-head{display:flex;align-items:center;gap:14px;margin-bottom:12px;}
.m9-buy-title{margin:0;}
.m9-money{flex:1;font-size:22px;font-weight:800;color:var(--m9-hpGreen);font-variant-numeric:tabular-nums;}
.m9-close{padding:4px 10px;}
.m9-note{color:var(--m9-danger);font-size:13px;margin-bottom:10px;}
.m9-buy-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px;}
.m9-card{display:flex;flex-direction:column;gap:6px;text-align:left;background:var(--m9-charcoal);
  border:1px solid var(--m9-metalDark);border-radius:8px;padding:12px;color:var(--m9-hudText);
  font:inherit;cursor:pointer;}
.m9-card:hover{border-color:var(--m9-hudAccent);}
.m9-card.m9-owned{border-color:var(--m9-hudAccent);cursor:default;}
.m9-card.m9-off{opacity:.4;cursor:default;}
.m9-card.m9-off:hover{border-color:var(--m9-metalDark);}
.m9-card-top{display:flex;justify-content:space-between;align-items:baseline;gap:6px;}
.m9-card-name{font-weight:700;font-size:14px;}
.m9-card-price{color:var(--m9-hudAccent);font-weight:700;font-variant-numeric:tabular-nums;}
.m9-card-stats{font-size:12px;color:var(--m9-steel);font-variant-numeric:tabular-nums;}
.m9-card-role{font-size:12px;color:var(--m9-concrete);line-height:1.35;min-height:32px;}
.m9-tag{font-size:12px;font-weight:800;letter-spacing:.12em;color:var(--m9-hudAccent);}
.m9-tag.m9-bad{color:var(--m9-danger);}
.m9-issued{display:flex;gap:10px;margin-bottom:10px;}
.m9-issued-chip{display:flex;align-items:center;gap:8px;border:1px solid var(--m9-metalDark);
  border-radius:6px;padding:8px 12px;background:rgba(var(--m9-charcoal-rgb),.6);}
.m9-issued-name{font-size:13px;font-weight:600;}
.m9-hint{font-size:12px;color:var(--m9-steel);text-align:center;}

.m9-score-panel{width:min(920px,96vw);}
.m9-score-head{text-align:center;font-size:26px;font-weight:800;letter-spacing:.12em;
  margin-bottom:14px;font-variant-numeric:tabular-nums;}
.m9-t{color:var(--m9-tAmber);}
.m9-ct{color:var(--m9-ctBlue);}
.m9-tables{display:flex;gap:14px;flex-wrap:wrap;}
.m9-table{flex:1 1 320px;border:1px solid var(--m9-metalDark);border-radius:8px;overflow:hidden;}
.m9-table-head{padding:9px 12px;font-weight:800;font-size:13px;letter-spacing:.14em;}
.m9-th-t{background:var(--m9-tAmber);color:var(--m9-ink);}
.m9-th-ct{background:var(--m9-ctBlue);color:var(--m9-paper);}
.m9-row{display:grid;grid-template-columns:18px 1fr 44px 44px 64px;gap:4px;align-items:center;
  padding:6px 12px;font-size:13px;border-top:1px solid rgba(var(--m9-metalDark-rgb),.5);}
.m9-cols-head{font-size:12px;color:var(--m9-steel);letter-spacing:.08em;}
.m9-row.m9-you{background:rgba(var(--m9-hudAccent-rgb),.16);}
.m9-dot{width:8px;height:8px;border-radius:50%;background:var(--m9-hpGreen);display:inline-block;}
.m9-dot.m9-off{background:transparent;border:1px solid var(--m9-concreteDark);}
.m9-c-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m9-c-num{text-align:right;font-variant-numeric:tabular-nums;}

.m9-end-panel{text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px;
  max-height:94vh;overflow-y:auto;padding:16px;}
.m9-end-title{margin:0;font-size:64px;font-weight:900;letter-spacing:.3em;}
.m9-end-win{color:var(--m9-hpGreen);}
.m9-end-lose{color:var(--m9-danger);}
.m9-end-over{color:var(--m9-hudText);}
.m9-end-score{font-size:24px;font-weight:800;letter-spacing:.1em;font-variant-numeric:tabular-nums;}
.m9-top3{display:flex;flex-direction:column;gap:6px;min-width:280px;}
.m9-top3-row{display:grid;grid-template-columns:36px 32px 1fr auto;gap:8px;align-items:center;
  background:rgba(var(--m9-ink-rgb),.9);border:1px solid var(--m9-metalDark);border-radius:6px;
  padding:8px 14px;font-size:14px;}
.m9-top3-rank{color:var(--m9-hudAccent);font-weight:800;}
.m9-top3-name{text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m9-top3-kd{color:var(--m9-steel);font-variant-numeric:tabular-nums;}

.m9-join-text{font-size:22px;font-weight:700;letter-spacing:.24em;animation:m9pulse 1.4s ease-in-out infinite;}
@keyframes m9pulse{0%,100%{opacity:.5;}50%{opacity:1;}}

.m9-layer-chip{align-items:flex-start;justify-content:flex-start;}
.m9-chip{margin:14px;background:rgba(var(--m9-ink-rgb),.82);border:1px solid var(--m9-metalDark);
  border-radius:6px;padding:6px 10px;font-size:12px;letter-spacing:.05em;}

.m9-pause-panel{width:min(320px,92vw);display:flex;flex-direction:column;gap:10px;text-align:center;}
.m9-pause-title{margin:0 0 6px;font-size:24px;letter-spacing:.2em;}

@media (max-width:760px){
  .m9-cols{grid-template-columns:1fr;}
  .m9-buy-grid{grid-template-columns:repeat(2,1fr);}
  .m9-controls{grid-template-columns:repeat(2,1fr);}
  .m9-end-title{font-size:42px;}
}
`;
