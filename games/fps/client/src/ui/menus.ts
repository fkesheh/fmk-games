// ============================================================================
// C9 — Menus (main / buy / scoreboard / match end / joining / pause / room chip / dev console).
// DOM overlays mounted on the #menu root handed in by C11. Styles are injected
// here. Every color traces to PALETTE via CSS custom properties (--m9-*) set
// on the root element. Weapon silhouettes come from hud.ts's procedural
// weaponIcon() factory (shared with the killfeed).
// ============================================================================
import { GEAR, MAP_LIST, MAPS, PALETTE, PRIVATE_CODE_LEN, WEAPONS } from '@fps/shared';
import type {
  GearId,
  MapId,
  PlayerId,
  RoomInfo,
  RoomPhase,
  RosterEntry,
  Team,
  WeaponId,
} from '@fps/shared';
import { weaponIcon } from './hud.js';

export interface MenuCallbacks {
  onQuickJoin(name: string): void;
  onCreatePublic(name: string, mapId: MapId): void; // listed in the room browser
  onCreatePrivate(name: string, mapId: MapId): void; // share-code only
  onJoinPrivate(name: string, code: string): void;
  onListRooms(): Promise<RoomInfo[]>;
  onBuy(weapon: WeaponId): void;
  onBuyGear(item: GearId): void; // CS gear: kevlar vest / helmet (buy_gear message)
  onAddBot(): void;
  onRemoveBot(): void;
  onRemoveAllBots(): void;
  onSwitchTeam(team: Team): void; // request team change (server guards balance)
  onResume(): void; // re-request pointer lock
  onLeave(): void; // leave room -> main menu
}

// ---- private constants ------------------------------------------------------
const NAME_KEY = 'stricken.name';
const STYLE_ID = 'fps-menus-style';
const CONSOLE_MAX_LINES = 50; // dev console keeps only the tail of the output log

type LayerId = 'main' | 'buy' | 'score' | 'end' | 'joining' | 'pause' | 'chip' | 'botprompt';
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

// buyable CS gear (armor); prices and absorb values come from the frozen GEAR config
const GEAR_ITEMS: readonly GearId[] = ['kevlar', 'helmet'];

const GEAR_NAME: Record<GearId, string> = {
  kevlar: 'KEVLAR VEST',
  helmet: 'KEVLAR + HELMET',
};

const GEAR_PRICE: Record<GearId, number> = {
  kevlar: GEAR.kevlarPrice,
  helmet: GEAR.helmetPrice,
};

const GEAR_ROLE: Record<GearId, string> = {
  kevlar: `Soaks ${Math.round(GEAR.absorb * 100)}% of body-shot damage until depleted.`,
  helmet: 'Extends the armor to headshots — requires the vest.',
};

// gear state the caller (C11) derives from the YouSnap armor/helmet fields
export interface GearState {
  hasKevlar: boolean;
  hasHelmet: boolean;
}

const PHASE_LABEL: Record<RoomPhase, string> = {
  warmup: 'Warmup',
  freeze: 'Buy',
  live: 'Live',
  roundEnd: 'Round end',
  matchEnd: 'Match end',
};

const TEAM_NAME: Record<Team, string> = { T: 'TERRORISTS', CT: 'COUNTER-TERRORISTS' };

const MAP_NAMES = new Map<MapId, string>(MAP_LIST.map((m) => [m.id, m.name]));

// onboarding controls card per UX_BIBLE (full binding set)
const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['WASD', 'Move'],
  ['Mouse', 'Look'],
  ['LMB', 'Fire'],
  ['RMB / F', 'Scope (AWM)'],
  ['Space', 'Jump'],
  ['C / Caps Lock', 'Crouch'],
  ['R', 'Reload'],
  ['B', 'Buy'],
  ['Tab', 'Scoreboard'],
  ['1-6 / Wheel', 'Weapons'],
  ['Esc', 'Pause'],
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

// '#rrggbb' + alpha -> 'rgba(r,g,b,a)' — still a PALETTE color, just translucent
function rgba(hex: string, a: number): string {
  return `rgba(${hexRgb(hex)},${a})`;
}

// ---- gear glyphs (same procedural style as hud.ts's weaponIcon) -------------
const GEAR_GLYPH_W = 44;
const GEAR_GLYPH_H = 18;
const GEAR_GLYPH_SS = 2; // supersample factor — crisp on retina
const GEAR_THICK_W = 1.08;
const GEAR_THICK_H = 1.24;

type GearRects = ReadonlyArray<readonly [number, number, number, number]>;

// silhouettes on the same 44x18 grid: body in hudText, detail in paper
const GEAR_GLYPH_BODY: Record<GearId, GearRects> = {
  kevlar: [
    // shield: wide top tapering to a point
    [13, 2.5, 18, 3.5], // shoulders
    [15, 6, 14, 4], // upper body
    [17, 10, 10, 3], // mid taper
    [19, 13, 6, 2.5], // lower taper
    [21, 15.5, 2, 1.5], // point
  ],
  helmet: [
    [14, 3.5, 16, 6], // dome
    [11, 9.5, 22, 2.5], // brim
    [12, 11.5, 3, 3], // left ear cover
    [29, 11.5, 3, 3], // right ear cover
  ],
};

const GEAR_GLYPH_DETAIL: Record<GearId, GearRects> = {
  kevlar: [
    [21, 4, 2, 10], // center rib
  ],
  helmet: [
    [16, 6.5, 12, 1.6], // visor slit
  ],
};

/**
 * Procedural silhouette icon for a gear item, mirroring hud.ts's weaponIcon():
 * same logical 44x18 grid, same supersampled backing store, same center-
 * expanded rects so the glyphs sit naturally beside the weapon cards.
 */
function gearIcon(item: GearId, scale = 1): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = GEAR_GLYPH_W * GEAR_GLYPH_SS * scale;
  c.height = GEAR_GLYPH_H * GEAR_GLYPH_SS * scale;
  c.style.width = `${GEAR_GLYPH_W * scale}px`;
  c.style.height = `${GEAR_GLYPH_H * scale}px`;
  const ctx = c.getContext('2d');
  if (ctx === null) return c; // 2d unavailable — empty icon, layout still holds
  ctx.scale(GEAR_GLYPH_SS * scale, GEAR_GLYPH_SS * scale);
  const fill = (rects: GearRects): void => {
    for (const [x, y, w, h] of rects) {
      const nw = w * GEAR_THICK_W;
      const nh = h * GEAR_THICK_H;
      ctx.fillRect(x - (nw - w) / 2, y - (nh - h) / 2, nw, nh);
    }
  };
  ctx.fillStyle = PALETTE.paper; // bright detail — reads small
  fill(GEAR_GLYPH_DETAIL[item]);
  ctx.fillStyle = PALETTE.hudText;
  fill(GEAR_GLYPH_BODY[item]);
  return c;
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
  private removeBotBtn: HTMLButtonElement | null = null;
  private removeAllBotsBtn: HTMLButtonElement | null = null;
  private teamBtns: Record<Team, { btn: HTMLButtonElement; tag: HTMLElement }> | null = null;
  private roomListEl: HTMLElement | null = null;
  private roomReq = 0; // stale-guard for async room-list refreshes
  private scoreSig = ''; // scoreboard content signature — skips no-op rebuilds
  private selectedMap: MapId = MAP_LIST[0]?.id ?? 'dustbowl';
  private consoleEl: HTMLElement | null = null; // built lazily on first use
  private consoleOutEl: HTMLElement | null = null;
  private consoleInputEl: HTMLInputElement | null = null;
  private consoleCmd: ((text: string) => string) | null = null;
  // ?code= invite prefill: undefined = URL not yet consulted, null = absent/consumed
  private pendingCode: string | null | undefined = undefined;
  private copiedTimer = 0; // resets the room chip's 'COPIED' feedback label

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
      botprompt: this.makeLayer('botprompt', false), // non-modal: only its panel takes events
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
    // hero band: wordmark + tagline over a bold diagonal ink/amber accent
    const hero = el('div', 'm9-hero');
    hero.appendChild(el('h1', 'm9-title', 'STRICKEN'));
    hero.appendChild(el('div', 'm9-tagline', 'TACTICAL ROUND-BASED FPS'));
    panel.appendChild(hero);
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
    this.applyMainTint();
    this.loadRooms();
  }

  /**
   * Main-menu hero backdrop: a map-themed tint behind the panel, built from
   * the selected map's frozen theme colors (sky glow from the top, horizon
   * warmth mid-frame, fog haze low) over the standard ink dim. Re-applied
   * live when the map picker selection changes.
   */
  private applyMainTint(): void {
    const theme = MAPS[this.selectedMap].theme;
    this.layers.main.style.background =
      // top layer: vignette so the panel edges fall off into ink
      `radial-gradient(ellipse at 50% 42%, transparent 48%, ${rgba(PALETTE.ink, 0.6)} 100%), ` +
      // under it: the selected map's theme tint
      `radial-gradient(135% 105% at 50% -12%, ${rgba(theme.sky, 0.36)} 0%, ` +
      `${rgba(theme.horizon, 0.2)} 38%, ${rgba(theme.fog, 0.1)} 62%, ` +
      `${rgba(PALETTE.ink, 0.88)} 100%)`;
  }

  private buildCreateCol(): HTMLElement {
    const sec = el('div', 'm9-sec');
    sec.appendChild(el('h2', 'm9-sec-title', 'CREATE'));
    const grid = el('div', 'm9-map-grid');
    const buttons: HTMLButtonElement[] = [];
    for (const m of MAP_LIST) {
      const b = el('button', 'm9-btn m9-map', m.name);
      b.type = 'button';
      if (m.id === this.selectedMap) b.classList.add('m9-sel');
      b.addEventListener('click', () => {
        this.selectedMap = m.id;
        for (const other of buttons) other.classList.toggle('m9-sel', other === b);
        this.applyMainTint(); // hero backdrop follows the picked map's theme
      });
      buttons.push(b);
      grid.appendChild(b);
    }
    sec.appendChild(grid);
    const actions = el('div', 'm9-create-actions');
    const pub = el('button', 'm9-btn m9-btn-primary', 'CREATE PUBLIC');
    pub.type = 'button';
    pub.title = 'Listed in the room browser';
    pub.addEventListener('click', () => this.cb.onCreatePublic(this.name(), this.selectedMap));
    const priv = el('button', 'm9-btn', 'CREATE PRIVATE');
    priv.type = 'button';
    priv.title = 'Share-code only';
    priv.addEventListener('click', () => this.cb.onCreatePrivate(this.name(), this.selectedMap));
    actions.appendChild(pub);
    actions.appendChild(priv);
    sec.appendChild(actions);
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
    // invite-link prefill: /fps/?code=XXXXX fills the code once; a successful
    // join (showInRoom) consumes it so later menu visits start empty
    if (this.pendingCode === undefined) {
      const fromUrl = new URLSearchParams(location.search).get('code');
      const clean = fromUrl !== null ? fromUrl.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
      this.pendingCode = clean === '' ? null : clean;
    }
    if (this.pendingCode !== null) {
      code.value = this.pendingCode.slice(0, PRIVATE_CODE_LEN);
      join.disabled = code.value.length !== PRIVATE_CODE_LEN;
    }
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
    this.pendingCode = null; // a successful join consumed any ?code= prefill
    const chip = this.layers.chip;
    chip.textContent = '';
    const box = el('div', code !== null ? 'm9-chip m9-chip-copy' : 'm9-chip');
    box.appendChild(
      el('span', '', code !== null ? `${roomLabel} · code ${code} (share)` : roomLabel),
    );
    if (code !== null) {
      const copy = el('button', 'm9-btn m9-btn-small m9-chip-btn', 'COPY INVITE');
      copy.type = 'button';
      copy.addEventListener('click', () => this.copyInvite(code, copy));
      box.appendChild(copy);
    }
    chip.appendChild(box);
    this.show('chip');
  }

  /** Copies the invite link; navigator.clipboard first, textarea fallback. */
  private copyInvite(code: string, btn: HTMLButtonElement): void {
    const url = `${location.origin}/fps/?code=${code}`;
    const clip: Clipboard | undefined = navigator.clipboard;
    if (clip !== undefined) {
      clip.writeText(url).then(
        () => this.showCopied(btn),
        () => this.copyInviteFallback(url, btn), // denied (permissions/insecure ctx): fallback path
      );
    } else {
      this.copyInviteFallback(url, btn);
    }
  }

  /** Pre-clipboard-era path: hidden textarea + execCommand('copy'). */
  private copyInviteFallback(url: string, btn: HTMLButtonElement): void {
    const ta = el('textarea', '');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      // copy unsupported — the code is still readable in the chip
    }
    ta.remove();
    this.showCopied(btn);
  }

  /** Brief 'COPIED' label on the copy button. */
  private showCopied(btn: HTMLButtonElement): void {
    btn.textContent = 'COPIED';
    window.clearTimeout(this.copiedTimer);
    this.copiedTimer = window.setTimeout(() => {
      btn.textContent = 'COPY INVITE';
    }, 1200);
  }

  // ---- bot prompt (bottom center-right, non-modal) --------------------------
  // Suggests bots when a room is empty; auto-dismiss is the caller's job (C11).
  showBotPrompt(onAdd: (n: number) => void, onDismiss: () => void): void {
    const layer = this.layers.botprompt;
    layer.textContent = '';

    const panel = el('div', 'm9-botprompt');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Add bots to this room');
    panel.appendChild(el('div', 'm9-botprompt-text', 'Alone in this room — add some bots?'));

    const row = el('div', 'm9-botprompt-btns');
    const add3 = el('button', 'm9-btn m9-btn-primary m9-btn-small', 'ADD 3 BOTS');
    add3.type = 'button';
    add3.addEventListener('click', () => onAdd(3));
    const add1 = el('button', 'm9-btn m9-btn-small', 'ADD 1 BOT');
    add1.type = 'button';
    add1.addEventListener('click', () => onAdd(1));
    const nope = el('button', 'm9-btn m9-btn-small', 'NO THANKS');
    nope.type = 'button';
    nope.addEventListener('click', () => onDismiss());
    row.appendChild(add3);
    row.appendChild(add1);
    row.appendChild(nope);
    panel.appendChild(row);

    layer.appendChild(panel);
    this.show('botprompt');
  }

  hideBotPrompt(): void {
    this.hide('botprompt');
  }

  // ---- buy menu ---------------------------------------------------------------
  showBuy(money: number, owned: WeaponId[], canBuy: boolean, gear?: GearState): void {
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

    // CS gear (armor) — kevlar vest + helmet, below the weapon cards
    const gs: GearState = gear ?? { hasKevlar: false, hasHelmet: false };
    const gearSec = el('div', 'm9-gear-sec');
    gearSec.appendChild(el('h2', 'm9-sec-title', 'GEAR'));
    const gearGrid = el('div', 'm9-gear-grid');
    for (const item of GEAR_ITEMS) {
      gearGrid.appendChild(this.buildGearCard(item, money, gs, canBuy));
    }
    gearSec.appendChild(gearGrid);
    panel.appendChild(gearSec);

    const issued = el('div', 'm9-issued');
    for (const id of ['knife', 'pistol'] as const) {
      const chip = el('div', 'm9-issued-chip');
      const icon = weaponIcon(id);
      icon.setAttribute('role', 'img');
      icon.setAttribute('aria-label', WEAPONS[id].name);
      chip.appendChild(icon);
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

    // procedural silhouette, same glyph family as the killfeed (2x size)
    const iconWrap = el('div', 'm9-card-icon');
    const icon = weaponIcon(id, 2);
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', def.name);
    iconWrap.appendChild(icon);
    card.appendChild(iconWrap);

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

  private buildGearCard(item: GearId, money: number, gear: GearState, canBuy: boolean): HTMLElement {
    const price = GEAR_PRICE[item];
    const isOwned = item === 'kevlar' ? gear.hasKevlar : gear.hasHelmet;
    const needsVest = item === 'helmet' && !gear.hasKevlar;
    const affordable = money >= price;
    const off = !isOwned && (needsVest || !affordable || !canBuy); // disabled at 40% opacity

    const card = el('button', 'm9-card');
    card.type = 'button';
    if (isOwned) card.classList.add('m9-owned');
    if (off) card.classList.add('m9-off');

    // procedural silhouette, same glyph family as the weapon cards (2x size)
    const iconWrap = el('div', 'm9-card-icon');
    const icon = gearIcon(item, 2);
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', GEAR_NAME[item]);
    iconWrap.appendChild(icon);
    card.appendChild(iconWrap);

    const top = el('div', 'm9-card-top');
    top.appendChild(el('span', 'm9-card-name', GEAR_NAME[item]));
    top.appendChild(el('span', 'm9-card-price', `$${price}`));
    card.appendChild(top);

    card.appendChild(
      el(
        'div',
        'm9-card-stats',
        item === 'kevlar'
          ? `ARMOR ${GEAR.armorStart} · ABSORBS ${Math.round(GEAR.absorb * 100)}%`
          : 'HEAD PROTECTION',
      ),
    );
    card.appendChild(el('div', 'm9-card-role', GEAR_ROLE[item]));

    let tag = '';
    let bad = false;
    if (isOwned) tag = 'OWNED';
    else if (needsVest) {
      tag = 'REQUIRES VEST';
      bad = true;
    } else if (!canBuy) {
      tag = 'CLOSED';
      bad = true;
    } else if (!affordable) {
      tag = 'TOO EXPENSIVE';
      bad = true;
    }
    if (tag !== '') card.appendChild(el('div', bad ? 'm9-tag m9-bad' : 'm9-tag', tag));

    card.addEventListener('click', () => {
      if (isOwned || off) return;
      this.cb.onBuyGear(item); // menu stays open; caller re-shows with updated money
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
        .map((r) => `${r.id}:${r.name}:${r.team}:${r.kills}:${r.deaths}:${r.headshots}:${r.money ?? ''}:${r.bot ? 1 : 0}:${r.connected ? 1 : 0}`)
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
    cols.appendChild(el('span', 'm9-c-num', 'HS'));
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
      const nameCell = el('span', 'm9-c-name');
      nameCell.appendChild(document.createTextNode(r.name));
      if (r.bot) nameCell.appendChild(el('span', 'm9-bot-tag', 'BOT'));
      row.appendChild(nameCell);
      row.appendChild(el('span', 'm9-c-num', `${r.kills}`));
      row.appendChild(el('span', 'm9-c-num', `${r.deaths}`));
      row.appendChild(el('span', 'm9-c-num', `${r.headshots}`));
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
        row.appendChild(el('span', 'm9-top3-kd', `${r.kills}K (${r.headshots} HS)`));
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
    panel.appendChild(el('div', 'm9-rule'));
    const resume = el('button', 'm9-btn m9-btn-primary m9-wide', 'RESUME');
    resume.type = 'button';
    resume.addEventListener('click', () => {
      this.hide('pause');
      this.cb.onResume();
    });
    const addBot = el('button', 'm9-btn m9-wide', 'ADD BOT');
    addBot.type = 'button';
    addBot.addEventListener('click', () => this.cb.onAddBot()); // menu stays open; caller re-shows
    const removeBot = el('button', 'm9-btn m9-wide', 'REMOVE BOT');
    removeBot.type = 'button';
    removeBot.disabled = true;
    removeBot.addEventListener('click', () => this.cb.onRemoveBot());
    this.removeBotBtn = removeBot;
    // muted-danger variant: destructive like LEAVE ROOM but not its visual twin
    const removeAllBots = el('button', 'm9-btn m9-btn-danger m9-wide', 'REMOVE ALL BOTS');
    removeAllBots.type = 'button';
    removeAllBots.disabled = true;
    removeAllBots.addEventListener('click', () => this.cb.onRemoveAllBots()); // menu stays open; caller re-shows
    this.removeAllBotsBtn = removeAllBots;
    // team switch: menu stays open; caller re-shows with the updated team
    const joinT = this.buildTeamBtn('T', 'JOIN T', 'm9-btn-t');
    const joinCT = this.buildTeamBtn('CT', 'JOIN CT', 'm9-btn-ct');
    this.teamBtns = { T: joinT, CT: joinCT };
    const leave = el('button', 'm9-btn m9-btn-danger m9-wide', 'LEAVE ROOM');
    leave.type = 'button';
    leave.addEventListener('click', () => {
      this.hide('pause');
      this.cb.onLeave();
    });
    panel.appendChild(resume);
    panel.appendChild(addBot);
    panel.appendChild(removeBot);
    panel.appendChild(removeAllBots);
    panel.appendChild(joinT.btn);
    panel.appendChild(joinCT.btn);
    panel.appendChild(leave);
    this.layers.pause.appendChild(panel);
  }

  private buildTeamBtn(
    team: Team,
    label: string,
    cls: string,
  ): { btn: HTMLButtonElement; tag: HTMLElement } {
    const btn = el('button', `m9-btn m9-wide m9-team-btn ${cls}`);
    btn.type = 'button';
    btn.appendChild(el('span', '', label));
    const tag = el('span', 'm9-team-current', 'CURRENT'); // text marker, never color-only
    tag.style.display = 'none';
    btn.appendChild(tag);
    btn.addEventListener('click', () => this.cb.onSwitchTeam(team));
    return { btn, tag };
  }

  showPause(botCount: number, youTeam: Team | null): void {
    if (this.removeBotBtn !== null) this.removeBotBtn.disabled = botCount <= 0;
    if (this.removeAllBotsBtn !== null) this.removeAllBotsBtn.disabled = botCount <= 0;
    if (this.teamBtns !== null) {
      for (const team of ['T', 'CT'] as const) {
        const { btn, tag } = this.teamBtns[team];
        const current = team === youTeam;
        btn.disabled = current; // already on this team — nothing to switch to
        tag.style.display = current ? '' : 'none';
      }
    }
    this.showExclusive('pause');
  }

  hideAll(): void {
    for (const id of Object.keys(this.layers) as LayerId[]) this.hide(id);
    this.scoreSig = '';
    this.hideConsole();
  }

  // ---- developer console (`~`, CONTRACT.md 'Developer console') ----------------
  // Top-of-screen panel, not a modal layer: it stacks over the game and menus.
  // Pointer unlock + game-input suppression are the caller's job (C11); Esc here
  // closes (the caller's Esc edge also closes — hiding is idempotent).
  showConsole(onCommand: (text: string) => string): void {
    if (this.consoleEl === null) this.buildConsole();
    this.consoleCmd = onCommand;
    const root = this.consoleEl;
    if (root === null) return;
    root.style.display = 'flex';
    const out = this.consoleOutEl;
    if (out !== null) out.scrollTop = out.scrollHeight;
    const input = this.consoleInputEl;
    if (input !== null) input.focus();
  }

  hideConsole(): void {
    if (this.consoleEl !== null) this.consoleEl.style.display = 'none';
    if (this.consoleInputEl !== null) this.consoleInputEl.blur();
  }

  consoleLog(line: string): void {
    if (this.consoleEl === null) this.buildConsole();
    const out = this.consoleOutEl;
    if (out === null) return;
    out.appendChild(el('div', 'm9-console-line', line));
    while (out.childElementCount > CONSOLE_MAX_LINES) out.firstElementChild?.remove();
    out.scrollTop = out.scrollHeight;
  }

  consoleVisible(): boolean {
    return this.consoleEl !== null && this.consoleEl.style.display !== 'none';
  }

  private buildConsole(): void {
    const root = el('div', 'm9-console');
    root.style.display = 'none';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Developer console');

    const out = el('div', 'm9-console-out');
    const row = el('div', 'm9-console-row');
    row.appendChild(el('span', 'm9-console-prompt', '>'));
    const input = el('input', 'm9-console-input');
    input.type = 'text';
    input.maxLength = 120;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Console command');
    input.addEventListener('keydown', (e) => this.onConsoleKey(e));
    row.appendChild(input);

    root.appendChild(out);
    root.appendChild(row);
    this.host.appendChild(root);
    this.consoleEl = root;
    this.consoleOutEl = out;
    this.consoleInputEl = input;
  }

  private onConsoleKey(e: KeyboardEvent): void {
    const input = this.consoleInputEl;
    if (input === null) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation(); // never leak into game input (buy on B, etc.)
      const text = input.value;
      input.value = '';
      if (text.trim() === '' || this.consoleCmd === null) return;
      this.consoleLog(`> ${text}`); // echo, then the result line (ok or error reason)
      const result = this.consoleCmd(text);
      if (result !== '') this.consoleLog(result);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.hideConsole();
    } else if (e.key === '`' || e.key === '~') {
      e.preventDefault(); // never type the toggle char; the caller's `~` toggle closes us
    }
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
/* the buy menu keeps the world readable behind the cards */
.fps-menus .m9-layer-buy.m9-modal{background:rgba(var(--m9-ink-rgb),.52);}

.fps-menus .m9-panel{background:rgba(var(--m9-ink-rgb),.97);border:1px solid var(--m9-metalDark);
  border-radius:10px;padding:22px 26px;max-height:94vh;overflow-y:auto;
  box-shadow:0 14px 44px rgba(var(--m9-ink-rgb),.7), inset 0 1px 0 rgba(var(--m9-hudText-rgb),.06);}
.m9-main-panel{width:min(760px,94vw);}

.fps-menus .m9-btn{font:inherit;font-size:14px;font-weight:700;letter-spacing:.06em;
  text-transform:uppercase;cursor:pointer;color:var(--m9-hudText);
  background:var(--m9-charcoal);border:1px solid var(--m9-metalDark);border-radius:8px;padding:10px 16px;}
.fps-menus .m9-btn:hover:not(:disabled){border-color:var(--m9-hudAccent);}
.fps-menus .m9-btn:disabled{opacity:.4;cursor:default;}
.fps-menus .m9-btn-primary{background:var(--m9-hudAccent);border-color:var(--m9-hudAccent);color:var(--m9-ink);}
.m9-btn-small{padding:5px 10px;font-size:12px;}
.fps-menus .m9-btn-danger{border-color:var(--m9-danger);color:var(--m9-danger);}
.m9-btn-danger:hover{background:rgba(var(--m9-danger-rgb),.15);}
.m9-wide{width:100%;}

.fps-menus .m9-input{font:inherit;width:100%;background:var(--m9-charcoal);color:var(--m9-hudText);
  border:1px solid var(--m9-metalDark);border-radius:8px;padding:10px 12px;font-size:15px;outline:none;}
.fps-menus .m9-input:focus{border-color:var(--m9-hudAccent);}

/* hero: gradient-sheen title + tagline + sweeping rule over a diagonal accent */
.m9-hero{position:relative;overflow:hidden;margin:-8px -10px 0;padding:10px 0 6px;}
.m9-hero::before{content:'';position:absolute;left:-22%;right:-22%;top:14%;height:62%;
  transform:rotate(-13deg);
  background:linear-gradient(90deg,
    rgba(var(--m9-hudAccent-rgb),0) 0%, rgba(var(--m9-hudAccent-rgb),.14) 24%,
    rgba(var(--m9-hudAccent-rgb),.32) 50%, rgba(var(--m9-hudAccent-rgb),.14) 76%,
    rgba(var(--m9-hudAccent-rgb),0) 100%);
  border-top:1px solid rgba(var(--m9-ink-rgb),.85);
  border-bottom:1px solid rgba(var(--m9-ink-rgb),.85);}
.m9-hero .m9-title{position:relative;}
.m9-hero .m9-tagline{position:relative;}
.m9-title{margin:0;font-size:46px;font-weight:800;letter-spacing:.24em;text-align:center;
  background:linear-gradient(105deg,
    var(--m9-hudText) 30%, var(--m9-hudAccent) 46%, var(--m9-paper) 50%,
    var(--m9-hudAccent) 54%, var(--m9-hudText) 70%);
  background-size:250% 100%;background-position:112% 0;
  -webkit-background-clip:text;background-clip:text;color:transparent;
  animation:m9sheen 6s ease-in-out infinite;}
@keyframes m9sheen{0%{background-position:112% 0;}55%{background-position:-112% 0;}100%{background-position:-112% 0;}}
.m9-tagline{text-align:center;font-size:11px;letter-spacing:.42em;color:var(--m9-steel);margin-top:3px;}
.m9-rule{position:relative;overflow:hidden;height:3px;width:88px;margin:10px auto 18px;
  background:rgba(var(--m9-hudAccent-rgb),.3);border-radius:2px;}
.m9-rule::after{content:'';position:absolute;top:0;bottom:0;width:34px;left:-40px;
  background:var(--m9-hudAccent);border-radius:2px;animation:m9rulesweep 2.8s ease-in-out infinite;}
@keyframes m9rulesweep{0%{left:-40px;}55%{left:100%;}100%{left:100%;}}
.m9-field{margin-bottom:12px;}
.m9-label{display:block;font-size:12px;letter-spacing:.14em;color:var(--m9-steel);margin-bottom:6px;}
.m9-quick{width:100%;padding:14px;font-size:17px;margin-bottom:4px;}
.m9-error{color:var(--m9-danger);font-size:13px;margin:8px 0 10px;text-align:center;}

.m9-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
.m9-sec{border:1px solid var(--m9-metalDark);border-radius:8px;padding:12px;
  box-shadow:inset 0 1px 0 rgba(var(--m9-hudText-rgb),.04);}
.m9-sec-title{margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:.16em;color:var(--m9-steel);}
.m9-map-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;}
.m9-map{padding:8px 2px;font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:none;}
.m9-map.m9-sel{border-color:var(--m9-hudAccent);color:var(--m9-hudAccent);}
.m9-create-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.m9-code{text-align:center;letter-spacing:.4em;text-transform:uppercase;margin-bottom:10px;
  font-family:ui-monospace,Menlo,Consolas,monospace;}

.m9-rooms-sec{margin-bottom:12px;}
.m9-rooms-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
.m9-rooms-head .m9-sec-title{margin:0;}
.m9-room-list{display:flex;flex-direction:column;gap:4px;max-height:168px;overflow-y:auto;}
.m9-room-row{display:grid;grid-template-columns:1fr 64px 84px;gap:8px;align-items:center;
  padding:7px 10px;background:var(--m9-charcoal);border:1px solid var(--m9-metalDark);border-radius:8px;
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
  font:inherit;cursor:pointer;box-shadow:inset 0 1px 0 rgba(var(--m9-hudText-rgb),.05);}
.m9-card:hover:not(.m9-off){border-color:var(--m9-hudAccent);transform:translateY(-1px);}
.m9-card.m9-owned{border-color:var(--m9-hudAccent);cursor:default;
  box-shadow:inset 0 1px 0 rgba(var(--m9-hudText-rgb),.05), inset 0 -2px 0 var(--m9-hudAccent);}
.m9-card.m9-off{opacity:.4;cursor:default;}
.m9-card.m9-off:hover{border-color:var(--m9-metalDark);}
.m9-card-icon{display:flex;align-items:center;justify-content:center;height:52px;
  background:rgba(var(--m9-ink-rgb),.55);border:1px solid rgba(var(--m9-metalDark-rgb),.8);
  border-radius:6px;}
.m9-card-top{display:flex;justify-content:space-between;align-items:baseline;gap:6px;}
.m9-card-name{font-weight:700;font-size:14px;}
.m9-card-price{color:var(--m9-hudAccent);font-weight:700;font-variant-numeric:tabular-nums;}
.m9-card-stats{font-size:12px;color:var(--m9-steel);font-variant-numeric:tabular-nums;}
.m9-card-role{font-size:12px;color:var(--m9-concrete);line-height:1.35;min-height:32px;}
.m9-tag{font-size:12px;font-weight:800;letter-spacing:.12em;color:var(--m9-hudAccent);}
.m9-tag.m9-bad{color:var(--m9-danger);}
.m9-gear-sec{margin-bottom:12px;}
.m9-gear-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;}
.m9-issued{display:flex;gap:10px;margin-bottom:10px;}.m9-issued-chip{display:flex;align-items:center;gap:10px;border:1px solid var(--m9-metalDark);
  border-radius:8px;padding:8px 14px;background:rgba(var(--m9-charcoal-rgb),.6);
  box-shadow:inset 0 1px 0 rgba(var(--m9-hudText-rgb),.05);}
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
.m9-row{display:grid;grid-template-columns:18px 1fr 44px 44px 44px 64px;gap:4px;align-items:center;
  padding:6px 12px;font-size:13px;border-top:1px solid rgba(var(--m9-metalDark-rgb),.5);}
.m9-cols-head{font-size:12px;color:var(--m9-steel);letter-spacing:.08em;}
.m9-row.m9-you{background:rgba(var(--m9-hudAccent-rgb),.16);}
.m9-dot{width:8px;height:8px;border-radius:50%;background:var(--m9-hpGreen);display:inline-block;}
.m9-dot.m9-off{background:transparent;border:1px solid var(--m9-concreteDark);}
.m9-c-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m9-bot-tag{margin-left:6px;padding:0 5px;border-radius:3px;font-size:10px;font-weight:800;
  letter-spacing:.1em;background:var(--m9-steel);color:var(--m9-ink);vertical-align:1px;}
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
  background:rgba(var(--m9-ink-rgb),.9);border:1px solid var(--m9-metalDark);border-radius:8px;
  padding:8px 14px;font-size:14px;}
.m9-top3-rank{color:var(--m9-hudAccent);font-weight:800;}
.m9-top3-name{text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m9-top3-kd{color:var(--m9-steel);font-variant-numeric:tabular-nums;}

.m9-join-text{font-size:22px;font-weight:700;letter-spacing:.24em;animation:m9pulse 1.4s ease-in-out infinite;}
@keyframes m9pulse{0%,100%{opacity:.5;}50%{opacity:1;}}

.fps-menus .m9-layer-chip{align-items:flex-start;justify-content:flex-start;}
.m9-chip{margin:14px;background:rgba(var(--m9-ink-rgb),.82);border:1px solid var(--m9-metalDark);
  border-radius:8px;padding:6px 10px;font-size:12px;letter-spacing:.05em;display:flex;
  align-items:center;gap:8px;
  box-shadow:inset 0 1px 0 rgba(var(--m9-hudText-rgb),.07);}
/* only the invite chip takes pointer events; the plain chip stays click-through */
.m9-chip-copy{pointer-events:auto;}
.m9-chip-btn{padding:3px 8px;font-size:10px;}

.fps-menus .m9-layer-botprompt{align-items:flex-end;justify-content:flex-end;padding:0 6vw 96px;}
.m9-botprompt{display:flex;flex-direction:column;gap:10px;pointer-events:auto;
  background:rgba(var(--m9-ink-rgb),.82);border:1px solid var(--m9-metalDark);
  border-radius:8px;padding:10px 14px;font-size:12px;letter-spacing:.05em;
  box-shadow:inset 0 1px 0 rgba(var(--m9-hudText-rgb),.07);}
.m9-botprompt-btns{display:flex;gap:6px;flex-wrap:wrap;}

.m9-pause-panel{width:min(320px,92vw);display:flex;flex-direction:column;gap:10px;text-align:center;}
.m9-pause-title{margin:0;font-size:24px;letter-spacing:.2em;}
.fps-menus .m9-btn-t{border-color:var(--m9-tAmber);color:var(--m9-tAmber);}
.fps-menus .m9-btn-t:hover:not(:disabled){border-color:var(--m9-tAmber);background:rgba(var(--m9-tAmber-rgb),.15);}
.fps-menus .m9-btn-ct{border-color:var(--m9-ctBlue);color:var(--m9-ctBlue);}
.fps-menus .m9-btn-ct:hover:not(:disabled){border-color:var(--m9-ctBlue);background:rgba(var(--m9-ctBlue-rgb),.15);}
.m9-team-btn{display:flex;align-items:center;justify-content:center;gap:8px;}
.m9-team-current{font-size:10px;font-weight:800;letter-spacing:.12em;color:var(--m9-steel);}

.fps-menus .m9-console{position:absolute;top:0;left:0;right:0;height:40%;display:flex;flex-direction:column;
  pointer-events:auto;background:rgba(var(--m9-ink-rgb),.88);border-bottom:1px solid var(--m9-metalDark);
  box-shadow:0 10px 32px rgba(var(--m9-ink-rgb),.65);
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:var(--m9-hudText);}
.m9-console-out{flex:1;overflow-y:auto;padding:8px 12px;line-height:1.45;}
.m9-console-line{white-space:pre-wrap;word-break:break-word;}
.m9-console-row{display:flex;align-items:center;gap:8px;padding:6px 12px;
  border-top:1px solid rgba(var(--m9-metalDark-rgb),.7);}
.m9-console-prompt{color:var(--m9-hudAccent);font-weight:700;}
.m9-console-input{flex:1;background:transparent;border:none;outline:none;padding:2px 0;
  color:var(--m9-hudText);font:inherit;font-family:inherit;}

@media (max-width:760px){
  .m9-cols{grid-template-columns:1fr;}
  .m9-buy-grid{grid-template-columns:repeat(2,1fr);}
  .m9-controls{grid-template-columns:repeat(2,1fr);}
  .m9-end-title{font-size:42px;}
}
`;
