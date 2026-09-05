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
// shared cross-game identity (CONTRACT_IDENTITY.md): ONE display name for the
// whole platform, migrated automatically from the old 'stricken.name' key on
// first read — never write that key again.
import { cleanName, loadName, saveName } from '@platform/shared';
import { weaponIcon } from './hud.js';

/**
 * The alive/dead half of a scoreboard row. Structurally a subset of C10's
 * roster-merged snapshot entry, so the caller passes its existing reused array.
 */
export interface LivePlayer {
  readonly id: PlayerId;
  readonly alive: boolean;
}

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
const STYLE_ID = 'fps-menus-style';
const CONSOLE_MAX_LINES = 50; // dev console keeps only the tail of the output log
const SCORE_REFRESH_MS = 120; // open-scoreboard re-read cadence (alive/K/D move)

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

// silhouettes on the same 44x18 grid: body in hudText, cut-in detail in ink.
// Detail is painted OVER the body (the opposite of hud.ts, whose detail rects
// stick out past the silhouette); here every detail sits inside the mass, so it
// has to be a dark cut, not a bright overhang — that is the value break that
// stops the glyph reading as one flat blob at card size.
const GEAR_GLYPH_BODY: Record<GearId, GearRects> = {
  kevlar: [
    // plate carrier, front on: hard rectangular plate, not an organic shape
    [15, 3.2, 14, 10.2], // front plate
    [16.5, 13.4, 11, 2.6], // waist band
    [11.6, 2.2, 4, 4.6], // left shoulder strap
    [28.4, 2.2, 4, 4.6], // right shoulder strap
    [12.6, 5.8, 2.6, 6.2], // left cummerbund panel
    [28.8, 5.8, 2.6, 6.2], // right cummerbund panel
  ],
  helmet: [
    [13.5, 2.5, 17, 7], // dome
    [10.5, 9.5, 23, 2.6], // brim
    [11.5, 12, 3.6, 3.4], // left ear cover
    [29, 12, 3.6, 3.4], // right ear cover
    [31, 4.5, 3.5, 3.5], // rear counterweight
  ],
};

const GEAR_GLYPH_DETAIL: Record<GearId, GearRects> = {
  kevlar: [
    [21.4, 4.2, 1.2, 8.4], // centre closure
    [16.2, 8.2, 11.6, 1], // upper webbing row
    [16.2, 10.6, 11.6, 1], // lower webbing row
  ],
  helmet: [
    [15.5, 5.4, 13, 1.7], // visor slit
    [13.6, 12.4, 16.8, 1], // chin strap
    [14.4, 3.4, 5, 1.1], // crown seam
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
  ctx.fillStyle = PALETTE.hudText; // the mass first
  fill(GEAR_GLYPH_BODY[item]);
  ctx.fillStyle = PALETTE.ink; // then the cuts, over it
  fill(GEAR_GLYPH_DETAIL[item]);
  return c;
}

// ---- buy-card stat meters ---------------------------------------------------
// Bars are normalised against the buyable primaries only, so the four cards
// compare like with like. Every bar carries its literal number beside it —
// the bar is the glance read, the number is the truth.
const MAX_BURST = Math.max(...PRIMARIES.map((w) => WEAPONS[w].damage * WEAPONS[w].pellets));
const MAX_RPM = Math.max(...PRIMARIES.map((w) => 60 / WEAPONS[w].interval));
const MAX_MAG = Math.max(...PRIMARIES.map((w) => WEAPONS[w].mag));

function meter(label: string, value: string, frac: number): HTMLElement {
  const row = el('div', 'm9-meter');
  row.appendChild(el('span', 'm9-meter-label', label));
  const track = el('span', 'm9-meter-track');
  const fill = el('span', 'm9-meter-fill');
  // floor at 8% so a weak stat still reads as a bar and not as an empty slot
  fill.style.width = `${Math.round(Math.min(1, Math.max(0.08, frac)) * 100)}%`;
  track.appendChild(fill);
  row.appendChild(track);
  row.appendChild(el('span', 'm9-meter-val', value));
  return row;
}

function specChip(label: string, value: string): HTMLElement {
  const chip = el('div', 'm9-spec');
  chip.appendChild(el('span', 'm9-spec-label', label));
  chip.appendChild(el('span', 'm9-spec-val', value));
  return chip;
}

/** Card state -> the affordability footer. Never colour alone: glyph + words. */
type BuyState = 'own' | 'closed' | 'locked' | 'poor' | 'ok';

function buyFooter(state: BuyState, delta: number): HTMLElement {
  const glyph = state === 'own' ? '✓' : state === 'ok' ? '▸' : '✕';
  const text =
    state === 'own'
      ? 'IN LOADOUT'
      : state === 'closed'
        ? 'BUY PERIOD CLOSED'
        : state === 'locked'
          ? 'REQUIRES VEST'
          : state === 'poor'
            ? `NEED $${delta} MORE`
            : `LEAVES $${delta}`;
  const kind = state === 'own' ? 'm9-foot-own' : state === 'ok' ? 'm9-foot-ok' : 'm9-foot-bad';
  const foot = el('div', `m9-foot ${kind}`);
  const g = el('span', 'm9-foot-glyph', glyph);
  g.setAttribute('aria-hidden', 'true');
  foot.appendChild(g);
  foot.appendChild(el('span', 'm9-foot-text', text));
  return foot;
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
  private joiningSubEl: HTMLElement | null = null; // showJoining()'s swappable status line
  private removeBotBtn: HTMLButtonElement | null = null;
  private removeAllBotsBtn: HTMLButtonElement | null = null;
  private teamBtns: Record<Team, { btn: HTMLButtonElement; tag: HTMLElement }> | null = null;
  private roomListEl: HTMLElement | null = null;
  private roomReq = 0; // stale-guard for async room-list refreshes
  private scoreSig = ''; // scoreboard content signature — skips no-op rebuilds
  private scoreRaf = 0; // rAF handle for the open scoreboard's refresh loop
  private scoreArgs: {
    roster: RosterEntry[];
    you: PlayerId;
    scoreT: number;
    scoreCT: number;
    live: readonly LivePlayer[] | undefined;
  } | null = null;
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
    this.hideScoreboard(); // a live refresh loop would re-show it over the menu
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
    const meta = el('div', 'm9-hero-meta');
    for (const item of [`${MAP_LIST.length} MAPS`, '5v5 ROUNDS', 'BOTS & PRIVATE ROOMS']) {
      meta.appendChild(el('span', 'm9-hero-metaitem', item));
    }
    hero.appendChild(meta);
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
    // loadName() is '' the first time this browser is ever seen — leave the
    // field EMPTY so the placeholder shows, rather than pre-filling 'Player'
    // (which would make an unset name indistinguishable from a chosen one).
    nameInput.value = loadName();
    nameInput.addEventListener('input', () => {
      const v = nameInput.value.trim();
      if (v !== '') saveName(v);
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
      // each tile previews its own frozen theme: sky gradient over a ground band
      const t = MAPS[m.id].theme;
      const b = el('button', 'm9-map');
      b.type = 'button';
      const swatch = el('span', 'm9-map-swatch');
      swatch.style.background =
        `linear-gradient(180deg, ${t.skyHigh} 0%, ${t.sky} 46%, ${t.horizon} 74%, ` +
        `${t.ground} 74%, ${t.ground} 100%)`;
      const haze = el('span', 'm9-map-haze');
      haze.style.background =
        `linear-gradient(180deg, ${rgba(t.fog, 0)} 40%, ${rgba(t.fog, 0.55)} 74%, ${rgba(t.fog, 0)} 100%)`;
      swatch.appendChild(haze);
      b.appendChild(swatch);
      b.appendChild(el('span', 'm9-map-name', m.name));
      b.appendChild(el('span', 'm9-map-sel', 'SELECTED')); // text marker, never colour alone
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
    sec.appendChild(
      el(
        'div',
        'm9-join-note',
        `Ask the host for their ${PRIVATE_CODE_LEN}-character code, or open their invite link.`,
      ),
    );
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

      // occupancy reads as a bar first, a fraction second
      const cap = el('span', 'm9-room-players');
      const track = el('span', 'm9-cap-track');
      const fill = el('span', 'm9-cap-fill');
      const frac = r.maxPlayers > 0 ? r.players / r.maxPlayers : 0;
      fill.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
      if (frac >= 1) fill.classList.add('m9-cap-full');
      track.appendChild(fill);
      cap.appendChild(track);
      cap.appendChild(el('span', 'm9-cap-num', `${r.players}/${r.maxPlayers}`));
      row.appendChild(cap);

      const phase = el('span', 'm9-room-phase');
      const tier = r.phase === 'live' ? 'live' : r.phase === 'freeze' ? 'buy' : 'idle';
      const dot = el('span', `m9-phase-dot m9-phase-${tier}`);
      dot.setAttribute('aria-hidden', 'true');
      phase.appendChild(dot);
      phase.appendChild(el('span', '', PHASE_LABEL[r.phase]));
      row.appendChild(phase);
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
    box.appendChild(el('span', 'm9-chip-label', roomLabel));
    if (code !== null) {
      box.appendChild(el('span', 'm9-chip-sep'));
      box.appendChild(el('span', 'm9-chip-cap', 'CODE'));
      box.appendChild(el('span', 'm9-chip-code', code));
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

    // masthead: what this is on the left, what you can spend on the right
    const head = el('div', 'm9-buy-head');
    const headL = el('div', 'm9-buy-head-l');
    headL.appendChild(el('div', 'm9-eyebrow', 'LOADOUT'));
    headL.appendChild(el('h2', 'm9-buy-title', 'BUY MENU'));
    head.appendChild(headL);

    // buy-window state: glyph + word + colour, never colour alone
    const state = el('div', canBuy ? 'm9-buystate m9-open' : 'm9-buystate m9-shut');
    const stateGlyph = el('span', 'm9-buystate-glyph', canBuy ? '●' : '✕');
    stateGlyph.setAttribute('aria-hidden', 'true');
    state.appendChild(stateGlyph);
    state.appendChild(el('span', '', canBuy ? 'BUY OPEN' : 'BUY CLOSED'));
    head.appendChild(state);

    const wallet = el('div', 'm9-wallet');
    wallet.appendChild(el('div', 'm9-wallet-label', 'FUNDS'));
    wallet.appendChild(el('div', 'm9-money', `$${money}`));
    head.appendChild(wallet);
    panel.appendChild(head);

    panel.appendChild(this.buildBuySecHead('PRIMARY WEAPONS', `${PRIMARIES.length} AVAILABLE`));
    const grid = el('div', 'm9-buy-grid');
    for (const id of PRIMARIES) {
      grid.appendChild(this.buildBuyCard(id, money, owned.includes(id), canBuy));
    }
    panel.appendChild(grid);

    // CS gear (armor) — kevlar vest + helmet, below the weapon cards
    const gs: GearState = gear ?? { hasKevlar: false, hasHelmet: false };
    panel.appendChild(this.buildBuySecHead('ARMOR', 'VEST BEFORE HELMET'));
    const gearGrid = el('div', 'm9-gear-grid');
    for (const item of GEAR_ITEMS) {
      gearGrid.appendChild(this.buildGearCard(item, money, gs, canBuy));
    }
    panel.appendChild(gearGrid);

    // issued sidearms — a footer strip, deliberately quieter than the cards
    panel.appendChild(this.buildBuySecHead('ISSUED', 'ALWAYS CARRIED'));
    const issued = el('div', 'm9-issued');
    for (const id of ['knife', 'pistol'] as const) {
      const chip = el('div', 'm9-issued-chip');
      const iconWrap = el('div', 'm9-issued-icon');
      const icon = weaponIcon(id, 2);
      icon.setAttribute('role', 'img');
      icon.setAttribute('aria-label', WEAPONS[id].name);
      iconWrap.appendChild(icon);
      chip.appendChild(iconWrap);
      const meta = el('div', 'm9-issued-meta');
      meta.appendChild(el('span', 'm9-issued-name', WEAPONS[id].name));
      meta.appendChild(el('span', 'm9-issued-role', ROLES[id]));
      chip.appendChild(meta);
      chip.appendChild(el('span', 'm9-issued-tag', 'FREE'));
      issued.appendChild(chip);
    }
    panel.appendChild(issued);

    const hint = el('div', 'm9-hint m9-buy-hint');
    hint.appendChild(el('span', 'm9-kbd', 'B'));
    hint.appendChild(el('span', '', 'or'));
    hint.appendChild(el('span', 'm9-kbd', 'Esc'));
    hint.appendChild(el('span', '', 'to close'));
    panel.appendChild(hint);
    layer.appendChild(panel);
  }

  /** Section rule for the buy menu: label left, quiet caption right. */
  private buildBuySecHead(label: string, caption: string): HTMLElement {
    const head = el('div', 'm9-buy-sechead');
    head.appendChild(el('span', 'm9-buy-seclabel', label));
    head.appendChild(el('span', 'm9-buy-secrule'));
    head.appendChild(el('span', 'm9-buy-seccap', caption));
    return head;
  }

  private buildBuyCard(id: WeaponId, money: number, isOwned: boolean, canBuy: boolean): HTMLElement {
    const def = WEAPONS[id];
    const affordable = money >= def.price;
    const off = !isOwned && (!affordable || !canBuy);
    const state: BuyState = isOwned ? 'own' : !canBuy ? 'closed' : !affordable ? 'poor' : 'ok';

    const card = el('button', `m9-card m9-card-weapon m9-st-${state}`);
    card.type = 'button';
    if (isOwned) card.classList.add('m9-owned');
    if (off) card.classList.add('m9-off');

    // procedural silhouette, same glyph family as the killfeed (3x — the buy
    // menu is judged as a captured shot, so the glyph has to read instantly)
    const iconWrap = el('div', 'm9-card-icon');
    const icon = weaponIcon(id, 3);
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', def.name);
    iconWrap.appendChild(icon);
    card.appendChild(iconWrap);

    const top = el('div', 'm9-card-top');
    top.appendChild(el('span', 'm9-card-name', def.name));
    top.appendChild(
      el(
        'span',
        state === 'poor' ? 'm9-card-price m9-price-over' : 'm9-card-price',
        `$${def.price}`,
      ),
    );
    card.appendChild(top);

    const meters = el('div', 'm9-meters');
    const burst = def.damage * def.pellets;
    const rpm = 60 / def.interval;
    const dmg = def.pellets > 1 ? `${def.damage}×${def.pellets}` : `${def.damage}`;
    meters.appendChild(meter('DMG', dmg, burst / MAX_BURST));
    meters.appendChild(meter('RPM', `${Math.round(rpm)}`, rpm / MAX_RPM));
    meters.appendChild(meter('MAG', `${def.mag}`, def.mag / MAX_MAG));
    card.appendChild(meters);

    card.appendChild(el('div', 'm9-card-role', ROLES[id]));
    card.appendChild(buyFooter(state, Math.abs(money - def.price)));

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
    const off = !isOwned && (needsVest || !affordable || !canBuy);
    const state: BuyState = isOwned
      ? 'own'
      : needsVest
        ? 'locked'
        : !canBuy
          ? 'closed'
          : !affordable
            ? 'poor'
            : 'ok';

    const card = el('button', `m9-card m9-card-gear m9-st-${state}`);
    card.type = 'button';
    if (isOwned) card.classList.add('m9-owned');
    if (off) card.classList.add('m9-off');

    // procedural silhouette, same glyph family as the weapon cards
    const iconWrap = el('div', 'm9-card-icon');
    const icon = gearIcon(item, 3);
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', GEAR_NAME[item]);
    iconWrap.appendChild(icon);
    card.appendChild(iconWrap);

    const body = el('div', 'm9-gear-body');
    const top = el('div', 'm9-card-top');
    top.appendChild(el('span', 'm9-card-name', GEAR_NAME[item]));
    top.appendChild(
      el('span', state === 'poor' ? 'm9-card-price m9-price-over' : 'm9-card-price', `$${price}`),
    );
    body.appendChild(top);

    const specs = el('div', 'm9-specs');
    if (item === 'kevlar') {
      specs.appendChild(specChip('ARMOR', `${GEAR.armorStart}`));
      specs.appendChild(specChip('ABSORB', `${Math.round(GEAR.absorb * 100)}%`));
    } else {
      specs.appendChild(specChip('COVERS', 'HEAD'));
      specs.appendChild(specChip('NEEDS', 'VEST'));
    }
    body.appendChild(specs);

    body.appendChild(el('div', 'm9-card-role', GEAR_ROLE[item]));
    body.appendChild(buyFooter(state, Math.abs(money - price)));
    card.appendChild(body);

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
  /**
   * `live` (optional, additive) is C10's roster-merged snapshot array; when it
   * is supplied every row also carries alive/dead for the current round. The
   * frozen 4-arg call still works and simply omits that state.
   *
   * The caller drives this from the Tab EDGE, but the arrays it hands over keep
   * mutating underneath (roster entries track kills/deaths locally, and `live`
   * is C10's reused snapshot array). A board frozen at the keydown would keep
   * claiming a respawned teammate is dead, so while it is open it re-reads them
   * on a throttled rAF; the signature check below makes every idle pass a no-op.
   */
  showScoreboard(
    roster: RosterEntry[],
    you: PlayerId,
    scoreT: number,
    scoreCT: number,
    live?: readonly LivePlayer[],
  ): void {
    this.scoreArgs = { roster, you, scoreT, scoreCT, live };
    this.renderScoreboard();
    if (this.scoreRaf === 0) {
      let last = 0;
      const tick = (t: number): void => {
        if (this.scoreArgs === null) {
          this.scoreRaf = 0;
          return;
        }
        if (t - last >= SCORE_REFRESH_MS) {
          last = t;
          this.renderScoreboard();
        }
        this.scoreRaf = requestAnimationFrame(tick);
      };
      this.scoreRaf = requestAnimationFrame(tick);
    }
  }

  private renderScoreboard(): void {
    const args = this.scoreArgs;
    if (args === null) return;
    const { roster, you, scoreT, scoreCT, live } = args;
    const known = live !== undefined && live.length > 0;
    // `live` holds exactly the players the server has in THIS round, so absence
    // from it is a third state, not death: a mid-round joiner sits out until the
    // next round and must not be libelled as a corpse.
    const inRound = new Set<PlayerId>();
    const aliveIds = new Set<PlayerId>();
    if (live !== undefined) {
      for (const p of live) {
        inRound.add(p.id);
        if (p.alive) aliveIds.add(p.id);
      }
    }
    // runs on every refresh pass — skip no-op rebuilds
    const sig =
      `${scoreT}|${scoreCT}|${you}|${known ? 1 : 0}|` +
      roster
        .map((r) => `${r.id}:${r.name}:${r.team}:${r.kills}:${r.deaths}:${r.headshots}:${r.money ?? ''}:${r.bot ? 1 : 0}:${r.connected ? 1 : 0}:${aliveIds.has(r.id) ? 1 : 0}:${inRound.has(r.id) ? 1 : 0}`)
        .join('|');
    if (sig === this.scoreSig && this.isShown('score')) return;
    this.scoreSig = sig;
    this.show('score'); // stacks over the game (and buy) — not exclusive

    const layer = this.layers.score;
    layer.textContent = '';
    const panel = el('div', 'm9-panel m9-score-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Scoreboard');

    // your side is marked in the masthead too, so the scoreline is personal
    const yourTeam = roster.find((r) => r.id === you)?.team ?? null;

    const head = el('div', 'm9-score-head');
    head.appendChild(this.buildScorePlate('T', scoreT, scoreT > scoreCT, yourTeam));
    head.appendChild(el('span', 'm9-score-vs', 'VS'));
    head.appendChild(this.buildScorePlate('CT', scoreCT, scoreCT > scoreT, yourTeam));
    panel.appendChild(head);

    // YOUR side's table comes FIRST, whichever side it is: the reading order
    // itself answers "which one am I" before any tag or colour is decoded.
    const order: readonly Team[] = yourTeam === 'CT' ? ['CT', 'T'] : ['T', 'CT'];
    const tables = el('div', 'm9-tables');
    for (const t of order) {
      tables.appendChild(
        this.buildTeamTable(t, roster, you, t === yourTeam, known, aliveIds, inRound),
      );
    }
    panel.appendChild(tables);

    const legend = el('div', 'm9-score-legend');
    legend.appendChild(el('span', '', 'K kills · D deaths · HS headshots · K/D ratio'));
    legend.appendChild(el('span', 'm9-legend-you', 'YOU'));
    legend.appendChild(
      el('span', '', known ? 'marks your row · struck-through = out of this round' : 'marks your row'),
    );
    panel.appendChild(legend);
    layer.appendChild(panel);
  }

  /** One side of the scoreline: tag, full team name, big round count. */
  private buildScorePlate(
    team: Team,
    score: number,
    leading: boolean,
    yourTeam: Team | null,
  ): HTMLElement {
    const plate = el('div', `m9-score-plate ${team === 'T' ? 'm9-plate-t' : 'm9-plate-ct'}`);
    if (leading) plate.classList.add('m9-plate-lead');
    const mine = yourTeam === team;
    if (mine) plate.classList.add('m9-plate-mine');
    const tagRow = el('div', 'm9-plate-tags');
    tagRow.appendChild(el('span', team === 'T' ? 'm9-t' : 'm9-ct', team));
    // BOTH plates are tagged — one YOU, one ENEMY — so the pair is never
    // symmetrical and the answer never depends on spotting a single chip.
    if (yourTeam !== null) {
      tagRow.appendChild(el('span', mine ? 'm9-plate-you' : 'm9-plate-foe', mine ? 'YOU' : 'ENEMY'));
    }
    plate.appendChild(tagRow);
    plate.appendChild(el('div', 'm9-plate-name', TEAM_NAME[team]));
    plate.appendChild(el('div', 'm9-plate-score', `${score}`));
    return plate;
  }

  private buildTeamTable(
    team: Team,
    roster: RosterEntry[],
    you: PlayerId,
    mine: boolean,
    known: boolean,
    aliveIds: ReadonlySet<PlayerId>,
    inRound: ReadonlySet<PlayerId>,
  ): HTMLElement {
    const rows = roster.filter((r) => r.team === team).sort(byScore);
    const wrap = el('div', `m9-table ${team === 'T' ? 'm9-table-t' : 'm9-table-ct'}`);
    if (mine) wrap.classList.add('m9-table-mine');
    const head = el('div', `m9-table-head ${team === 'T' ? 'm9-th-t' : 'm9-th-ct'}`);
    head.appendChild(el('span', 'm9-th-tag', team));
    head.appendChild(el('span', 'm9-th-name', TEAM_NAME[team]));
    head.appendChild(el('span', mine ? 'm9-th-mine' : 'm9-th-foe', mine ? 'YOUR TEAM' : 'ENEMY'));
    head.appendChild(el('span', 'm9-th-count', `${rows.length}`));
    wrap.appendChild(head);

    const cols = el('div', 'm9-row m9-cols-head');
    cols.appendChild(el('span', '', ''));
    cols.appendChild(el('span', '', 'PLAYER'));
    cols.appendChild(el('span', 'm9-c-num', 'K'));
    cols.appendChild(el('span', 'm9-c-num', 'D'));
    cols.appendChild(el('span', 'm9-c-num', 'HS'));
    cols.appendChild(el('span', 'm9-c-num', 'K/D'));
    cols.appendChild(el('span', 'm9-c-num', '$'));
    wrap.appendChild(cols);

    if (rows.length === 0) wrap.appendChild(el('div', 'm9-table-empty', 'No players'));
    for (const r of rows) {
      const row = el('div', 'm9-row');
      if (r.id === you) row.classList.add('m9-you');
      // RosterEntry carries no alive flag — it comes from the caller's snapshot
      // mirror (`live`). Without it the dot falls back to `connected` only.
      const out = known && !inRound.has(r.id); // joined mid-round: in next round
      const dead = known && !out && !aliveIds.has(r.id);
      if (dead || out) row.classList.add('m9-dead');
      const dot = el('span', 'm9-dot');
      if (!r.connected || out) dot.classList.add('m9-off');
      else if (dead) dot.classList.add('m9-down');
      dot.title = !r.connected
        ? 'disconnected'
        : out
          ? 'joined mid-round — in from the next round'
          : dead
            ? 'dead this round'
            : 'alive';
      row.appendChild(dot);
      const nameCell = el('span', 'm9-c-name');
      nameCell.appendChild(document.createTextNode(r.name));
      if (r.bot) nameCell.appendChild(el('span', 'm9-bot-tag', 'BOT'));
      // dead is shape (hollow rotated dot) + strike-through + this word
      if (dead) nameCell.appendChild(el('span', 'm9-dead-tag', 'DEAD'));
      if (out) nameCell.appendChild(el('span', 'm9-out-tag', 'NEXT ROUND'));
      // the local row is marked by a rail, a weight change AND this word
      if (r.id === you) nameCell.appendChild(el('span', 'm9-you-tag', 'YOU'));
      row.appendChild(nameCell);
      row.appendChild(el('span', 'm9-c-num m9-c-k', `${r.kills}`));
      row.appendChild(el('span', 'm9-c-num', `${r.deaths}`));
      row.appendChild(el('span', 'm9-c-num', `${r.headshots}`));
      row.appendChild(el('span', 'm9-c-num m9-c-kd', (r.kills / Math.max(1, r.deaths)).toFixed(2)));
      row.appendChild(
        el('span', 'm9-c-num m9-c-cash', r.id === you && r.money !== null ? `$${r.money}` : '—'),
      );
      wrap.appendChild(row);
    }
    return wrap;
  }

  hideScoreboard(): void {
    this.hide('score');
    this.scoreSig = '';
    // drop the refresh loop AND the arrays it holds (the rAF sees the null and
    // stops itself; cancelling here too means a re-show never stacks two loops)
    this.scoreArgs = null;
    if (this.scoreRaf !== 0) {
      cancelAnimationFrame(this.scoreRaf);
      this.scoreRaf = 0;
    }
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
    this.hideScoreboard();
    const layer = this.layers.end;
    layer.textContent = '';

    const won = youTeam !== null && youTeam === winner;
    const lost = youTeam !== null && youTeam !== winner;
    const cls = youTeam === null ? 'm9-end-over' : won ? 'm9-end-win' : 'm9-end-lose';
    // the whole frame carries the result: a wash behind the panel, not just text
    const wash = won ? PALETTE.hpGreen : lost ? PALETTE.danger : PALETTE.steel;
    layer.style.background =
      `radial-gradient(ellipse at 50% 46%, transparent 34%, ${rgba(PALETTE.ink, 0.72)} 100%), ` +
      `radial-gradient(120% 90% at 50% 40%, ${rgba(wash, 0.34)} 0%, ` +
      `${rgba(PALETTE.ink, 0.86)} 58%, ${rgba(PALETTE.ink, 0.96)} 100%)`;

    const panel = el('div', `m9-end-panel ${cls}`);
    const title = youTeam === null ? 'MATCH OVER' : won ? 'VICTORY' : 'DEFEAT';

    const banner = el('div', 'm9-end-banner');
    banner.appendChild(el('div', 'm9-eyebrow m9-end-eyebrow', 'MATCH RESULT'));
    banner.appendChild(el('h1', 'm9-end-title', title));
    banner.appendChild(el('div', 'm9-end-underline'));
    const hi = Math.max(scoreT, scoreCT);
    const lo = Math.min(scoreT, scoreCT);
    banner.appendChild(el('div', 'm9-end-sub', `${TEAM_NAME[winner]} take the match ${hi}–${lo}`));
    panel.appendChild(banner);

    const score = el('div', 'm9-end-score');
    score.appendChild(this.buildEndSide('T', scoreT, winner === 'T'));
    score.appendChild(el('span', 'm9-end-dash', '—'));
    score.appendChild(this.buildEndSide('CT', scoreCT, winner === 'CT'));
    panel.appendChild(score);

    const list = el('div', 'm9-top3');
    list.appendChild(el('div', 'm9-top3-head', 'TOP PERFORMERS'));
    const RANKS = ['1ST', '2ND', '3RD'];
    [...roster]
      .sort(byScore)
      .slice(0, 3)
      .forEach((r, i) => {
        const row = el('div', `m9-top3-row${i === 0 ? ' m9-top3-first' : ''}`);
        row.appendChild(el('span', 'm9-top3-rank', RANKS[i] ?? `${i + 1}TH`));
        row.appendChild(el('span', r.team === 'T' ? 'm9-t' : 'm9-ct', r.team));
        row.appendChild(el('span', 'm9-top3-name', r.name));
        const kd = el('span', 'm9-top3-kd');
        kd.appendChild(el('span', 'm9-top3-k', `${r.kills}`));
        kd.appendChild(el('span', 'm9-top3-klabel', 'KILLS'));
        kd.appendChild(el('span', 'm9-top3-hs', `${r.headshots} HS`));
        row.appendChild(kd);
        list.appendChild(row);
      });
    panel.appendChild(list);
    panel.appendChild(el('div', 'm9-hint m9-end-hint', 'Returning to warmup…'));
    layer.appendChild(panel);
  }

  /** One side of the match-end scoreline; the winner is tagged, not just tinted. */
  private buildEndSide(team: Team, score: number, isWinner: boolean): HTMLElement {
    const side = el('div', `m9-end-side ${team === 'T' ? 'm9-plate-t' : 'm9-plate-ct'}`);
    if (isWinner) side.classList.add('m9-end-winner');
    side.appendChild(el('div', team === 'T' ? 'm9-t m9-end-tag' : 'm9-ct m9-end-tag', team));
    side.appendChild(el('div', 'm9-end-num', `${score}`));
    side.appendChild(el('div', 'm9-end-wintag', isWinner ? 'WINNER' : ''));
    return side;
  }

  // ---- joining / pause (static content, built once) ------------------------------
  private buildJoining(): void {
    const box = el('div', 'm9-join');
    box.appendChild(el('div', 'm9-eyebrow', 'STRICKEN'));
    box.appendChild(el('div', 'm9-join-text', 'JOINING'));
    const bar = el('div', 'm9-join-bar');
    bar.appendChild(el('span', 'm9-join-bar-fill'));
    box.appendChild(bar);
    const sub = el('div', 'm9-join-sub', 'Reserving a slot on the server…');
    this.joiningSubEl = sub; // showJoining() re-labels this for the auto-rejoin path
    box.appendChild(sub);
    this.layers.joining.appendChild(box);
  }

  /**
   * `subtitle` lets a caller distinguish a fresh join ("Reserving a slot…",
   * the default) from an auto-rejoin after a boot/drop ("Reconnecting…") —
   * same overlay, same layer, just the status line so the player never gets
   * silently bounced to the main menu while we're recovering their room.
   */
  showJoining(subtitle?: string): void {
    this.showExclusive('joining');
    this.hideScoreboard();
    this.hide('chip');
    if (this.joiningSubEl !== null) {
      this.joiningSubEl.textContent = subtitle ?? 'Reserving a slot on the server…';
    }
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

    // grouped so the panel reads as three decisions, not seven buttons
    const teamGroup = el('div', 'm9-pause-group');
    teamGroup.appendChild(el('div', 'm9-pause-glabel', 'TEAM'));
    const teamRow = el('div', 'm9-pause-pair');
    teamRow.appendChild(joinT.btn);
    teamRow.appendChild(joinCT.btn);
    teamGroup.appendChild(teamRow);
    panel.appendChild(teamGroup);

    const botGroup = el('div', 'm9-pause-group');
    botGroup.appendChild(el('div', 'm9-pause-glabel', 'BOTS'));
    botGroup.appendChild(addBot);
    const botRow = el('div', 'm9-pause-pair');
    botRow.appendChild(removeBot);
    botRow.appendChild(removeAllBots);
    botGroup.appendChild(botRow);
    panel.appendChild(botGroup);

    panel.appendChild(el('div', 'm9-pause-spacer'));
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

  /**
   * True while ANY modal layer (main / buy / end / joining / pause) is up — i.e.
   * while a menu owns the screen and the keyboard. C10 uses it to gate the
   * warmup ENTER shortcut, so a key pressed at a menu can never reach the game.
   */
  modalOpen(): boolean {
    for (const id of MODALS) if (this.isShown(id)) return true;
    return false;
  }

  hideAll(): void {
    for (const id of Object.keys(this.layers) as LayerId[]) this.hide(id);
    this.hideScoreboard(); // also stops the open board's refresh loop
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

  // ---- name persistence (@platform/shared — shared across all five games) --------
  private name(): string {
    const raw = this.nameInput ? this.nameInput.value : '';
    saveName(raw); // stores the trimmed/capped raw value, even '' (clears a stale name)
    return cleanName(raw); // 'Player' fallback for the wire — never sent blank
  }
}

// ---- injected stylesheet (all colors via --m9-* PALETTE custom properties) ----
const CSS = `
/* ============ foundation ============================================== */
.fps-menus{position:fixed;inset:0;pointer-events:none;z-index:40;
  font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:var(--m9-hudText);}
.fps-menus *{box-sizing:border-box;}
.fps-menus .m9-layer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;}
.fps-menus .m9-modal{pointer-events:auto;
  background:linear-gradient(180deg,rgba(var(--m9-ink-rgb),.86),rgba(var(--m9-ink-rgb),.74));}
/* the buy menu keeps the world readable behind the cards */
.fps-menus .m9-layer-buy.m9-modal{
  background:radial-gradient(120% 90% at 50% 45%,rgba(var(--m9-ink-rgb),.42),rgba(var(--m9-ink-rgb),.72));}

.fps-menus .m9-panel{
  background:linear-gradient(180deg,rgba(var(--m9-charcoal-rgb),.97),rgba(var(--m9-ink-rgb),.98));
  border:1px solid var(--m9-metalDark);border-radius:12px;padding:20px 26px;max-height:94vh;overflow-y:auto;
  box-shadow:0 22px 60px rgba(var(--m9-ink-rgb),.8),
             0 2px 0 rgba(var(--m9-ink-rgb),.9),
             inset 0 1px 0 rgba(var(--m9-hudText-rgb),.08);}
.m9-main-panel{width:min(820px,94vw);}

.m9-eyebrow{font-size:10px;font-weight:700;letter-spacing:.34em;color:var(--m9-steel);}

/* ============ buttons / inputs ========================================= */
.fps-menus .m9-btn{font:inherit;font-size:14px;font-weight:700;letter-spacing:.06em;
  text-transform:uppercase;cursor:pointer;color:var(--m9-hudText);
  background:linear-gradient(180deg,var(--m9-metalDark),var(--m9-charcoal));
  border:1px solid var(--m9-metalDark);border-radius:8px;padding:10px 16px;
  box-shadow:inset 0 1px 0 rgba(var(--m9-hudText-rgb),.08),0 2px 6px rgba(var(--m9-ink-rgb),.5);
  transition:border-color .12s ease,transform .12s ease,box-shadow .12s ease;}
.fps-menus .m9-btn:hover:not(:disabled){border-color:var(--m9-hudAccent);transform:translateY(-1px);
  box-shadow:inset 0 1px 0 rgba(var(--m9-hudText-rgb),.1),0 6px 16px rgba(var(--m9-ink-rgb),.6);}
.fps-menus .m9-btn:active:not(:disabled){transform:translateY(0);}
.fps-menus .m9-btn:disabled{opacity:.38;cursor:default;box-shadow:none;}
/* Brand chrome (primary button, hero rule, meter fill, join scan, chip rail,
   affordable-card rail) is AMBER: hudAccent and its lit companion. It used to
   reach for tLit because tLit happened to be that amber. It no longer is - the
   T family rotated to hue 6 so a T stops sinking into Dustbowl's sand, and menu
   chrome painted in the live enemy colour would teach the wrong read.
   Only .m9-t / .m9-th-t / .m9-btn-t / .m9-plate-t track the team. */
.fps-menus .m9-btn-primary{color:var(--m9-ink);border-color:var(--m9-hazardAmberLit);
  background:linear-gradient(180deg,var(--m9-hazardAmberLit),var(--m9-hudAccent) 55%,var(--m9-tBrown));
  box-shadow:inset 0 1px 0 rgba(var(--m9-paper-rgb),.4),0 6px 18px rgba(var(--m9-hudAccent-rgb),.25);}
.fps-menus .m9-btn-primary:hover:not(:disabled){border-color:var(--m9-paper);}
.m9-btn-small{padding:5px 10px;font-size:12px;}
.fps-menus .m9-btn-danger{border-color:rgba(var(--m9-danger-rgb),.75);color:var(--m9-danger);
  background:linear-gradient(180deg,rgba(var(--m9-danger-rgb),.14),rgba(var(--m9-ink-rgb),.6));}
.fps-menus .m9-btn-danger:hover:not(:disabled){background:rgba(var(--m9-danger-rgb),.24);border-color:var(--m9-danger);}
.m9-wide{width:100%;}

.fps-menus .m9-input{font:inherit;width:100%;color:var(--m9-hudText);
  background:linear-gradient(180deg,rgba(var(--m9-ink-rgb),.9),rgba(var(--m9-charcoal-rgb),.9));
  border:1px solid var(--m9-metalDark);border-radius:8px;padding:11px 13px;font-size:15px;outline:none;
  box-shadow:inset 0 2px 6px rgba(var(--m9-ink-rgb),.7);}
.fps-menus .m9-input:focus{border-color:var(--m9-hudAccent);
  box-shadow:inset 0 2px 6px rgba(var(--m9-ink-rgb),.7),0 0 0 2px rgba(var(--m9-hudAccent-rgb),.22);}
.fps-menus .m9-input::placeholder{color:var(--m9-concreteDark);}

.m9-kbd{background:linear-gradient(180deg,var(--m9-metalDark),var(--m9-ink));
  color:var(--m9-hudText);border:1px solid rgba(var(--m9-steel-rgb),.28);border-radius:4px;padding:1px 6px;
  font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:nowrap;
  box-shadow:0 1px 0 rgba(var(--m9-ink-rgb),.9),inset 0 1px 0 rgba(var(--m9-hudText-rgb),.09);}

/* ============ main menu ================================================ */
/* hero: gradient-sheen title + tagline + sweeping rule over a diagonal accent */
.m9-hero{position:relative;overflow:hidden;margin:-8px -12px 0;padding:10px 0 8px;}
.m9-hero::before{content:'';position:absolute;left:-22%;right:-22%;top:14%;height:56%;
  transform:rotate(-13deg);
  background:linear-gradient(90deg,
    rgba(var(--m9-hudAccent-rgb),0) 0%, rgba(var(--m9-hudAccent-rgb),.14) 24%,
    rgba(var(--m9-hudAccent-rgb),.34) 50%, rgba(var(--m9-hudAccent-rgb),.14) 76%,
    rgba(var(--m9-hudAccent-rgb),0) 100%);
  border-top:1px solid rgba(var(--m9-ink-rgb),.85);
  border-bottom:1px solid rgba(var(--m9-ink-rgb),.85);}
.m9-hero .m9-title{position:relative;}
.m9-hero .m9-tagline{position:relative;}
.m9-title{margin:0;font-size:52px;font-weight:800;letter-spacing:.26em;text-align:center;
  text-indent:.26em;
  background:linear-gradient(105deg,
    var(--m9-hudText) 30%, var(--m9-hudAccent) 46%, var(--m9-paper) 50%,
    var(--m9-hudAccent) 54%, var(--m9-hudText) 70%);
  background-size:250% 100%;background-position:112% 0;
  -webkit-background-clip:text;background-clip:text;color:transparent;
  animation:m9sheen 6s ease-in-out infinite;}
@keyframes m9sheen{0%{background-position:112% 0;}55%{background-position:-112% 0;}100%{background-position:-112% 0;}}
.m9-tagline{text-align:center;font-size:11px;letter-spacing:.42em;color:var(--m9-steel);margin-top:4px;
  text-indent:.42em;}
.m9-hero-meta{position:relative;display:flex;justify-content:center;flex-wrap:wrap;gap:8px;margin-top:9px;}
.m9-hero-metaitem{font-size:9px;font-weight:700;letter-spacing:.22em;color:var(--m9-steel);
  border:1px solid rgba(var(--m9-metalDark-rgb),.95);border-radius:999px;padding:3px 10px;
  background:rgba(var(--m9-ink-rgb),.55);}
.m9-rule{position:relative;overflow:hidden;height:3px;width:108px;margin:11px auto 15px;
  background:rgba(var(--m9-hudAccent-rgb),.28);border-radius:2px;}
.m9-rule::after{content:'';position:absolute;top:0;bottom:0;width:38px;left:-44px;
  background:linear-gradient(90deg,rgba(var(--m9-hudAccent-rgb),0),var(--m9-hazardAmberLit),rgba(var(--m9-hudAccent-rgb),0));
  border-radius:2px;animation:m9rulesweep 2.8s ease-in-out infinite;}
@keyframes m9rulesweep{0%{left:-44px;}55%{left:100%;}100%{left:100%;}}
.m9-field{margin-bottom:11px;}
.m9-label{display:block;font-size:10px;font-weight:700;letter-spacing:.28em;color:var(--m9-steel);margin-bottom:6px;}
.m9-quick{width:100%;padding:13px;font-size:17px;letter-spacing:.16em;margin-bottom:4px;}
.m9-error{color:var(--m9-danger);font-size:13px;margin:10px 0;text-align:center;
  border:1px solid rgba(var(--m9-danger-rgb),.5);background:rgba(var(--m9-danger-rgb),.12);
  border-radius:8px;padding:8px 10px;}

.m9-cols{display:grid;grid-template-columns:1.35fr 1fr;gap:12px;margin:12px 0 10px;}
.m9-sec{border:1px solid var(--m9-metalDark);border-radius:10px;padding:12px;
  background:linear-gradient(180deg,rgba(var(--m9-charcoal-rgb),.55),rgba(var(--m9-ink-rgb),.35));
  box-shadow:inset 0 1px 0 rgba(var(--m9-hudText-rgb),.05);}
.m9-sec-title{margin:0 0 10px;font-size:10px;font-weight:800;letter-spacing:.3em;color:var(--m9-steel);}

/* map picker: every tile previews its own frozen sky/ground theme */
.m9-map-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:10px;}
.m9-map{position:relative;display:block;padding:0;overflow:hidden;cursor:pointer;font:inherit;
  color:var(--m9-hudText);border:1px solid var(--m9-metalDark);border-radius:8px;
  background:var(--m9-charcoal);box-shadow:0 3px 10px rgba(var(--m9-ink-rgb),.5);
  transition:border-color .12s ease,transform .12s ease;}
.m9-map:hover{border-color:var(--m9-hudAccent);transform:translateY(-1px);}
.m9-map-swatch{position:relative;display:block;height:38px;}
.m9-map-haze{position:absolute;inset:0;display:block;}
.m9-map-name{display:block;padding:6px;font-size:11px;font-weight:700;letter-spacing:.1em;
  text-align:center;text-transform:uppercase;
  background:linear-gradient(180deg,rgba(var(--m9-ink-rgb),.92),rgba(var(--m9-ink-rgb),.99));
  border-top:1px solid rgba(var(--m9-ink-rgb),.9);}
.m9-map-sel{display:none;position:absolute;top:5px;right:5px;font-size:8px;font-weight:800;
  letter-spacing:.16em;padding:2px 6px;border-radius:3px;background:var(--m9-hudAccent);color:var(--m9-ink);}
.m9-map.m9-sel{border-color:var(--m9-hudAccent);
  box-shadow:0 0 0 1px var(--m9-hudAccent),0 8px 20px rgba(var(--m9-ink-rgb),.6);}
.m9-map.m9-sel .m9-map-sel{display:block;}
.m9-map.m9-sel .m9-map-name{color:var(--m9-hudAccent);}
.m9-create-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.m9-code{text-align:center;letter-spacing:.4em;text-indent:.4em;text-transform:uppercase;margin-bottom:9px;
  font-size:20px;font-weight:700;font-family:ui-monospace,Menlo,Consolas,monospace;}
.m9-join-note{margin-top:10px;font-size:11px;line-height:1.5;color:var(--m9-concreteDark);}

.m9-rooms-sec{margin-bottom:10px;}
.m9-rooms-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;}
.m9-rooms-head .m9-sec-title{margin:0;}
.m9-room-list{display:flex;flex-direction:column;gap:5px;max-height:128px;overflow-y:auto;}
.m9-room-row{display:grid;grid-template-columns:1fr 116px 100px;gap:10px;align-items:center;
  padding:8px 12px;border:1px solid var(--m9-metalDark);border-radius:8px;
  background:linear-gradient(180deg,rgba(var(--m9-charcoal-rgb),.9),rgba(var(--m9-ink-rgb),.85));
  color:var(--m9-hudText);font:inherit;font-size:13px;cursor:pointer;text-align:left;}
.m9-room-row:hover{border-color:var(--m9-hudAccent);background:rgba(var(--m9-hudAccent-rgb),.1);}
.m9-room-map{font-weight:700;letter-spacing:.06em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m9-room-players{display:flex;align-items:center;gap:8px;}
.m9-cap-track{display:block;flex:1;height:5px;border-radius:3px;overflow:hidden;
  background:rgba(var(--m9-ink-rgb),.9);box-shadow:inset 0 1px 2px rgba(var(--m9-ink-rgb),.9);}
.m9-cap-fill{display:block;height:100%;border-radius:3px;
  background:linear-gradient(90deg,var(--m9-leafLit),var(--m9-hpGreen));}
.m9-cap-fill.m9-cap-full{background:linear-gradient(90deg,var(--m9-hudAccent),var(--m9-danger));}
.m9-cap-num{font-size:11px;color:var(--m9-steel);font-variant-numeric:tabular-nums;}
.m9-room-phase{display:flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.08em;color:var(--m9-steel);}
.m9-phase-dot{display:block;width:7px;height:7px;border-radius:50%;flex:none;}
.m9-phase-live{background:var(--m9-hpGreen);box-shadow:0 0 8px rgba(var(--m9-hpGreen-rgb),.75);}
.m9-phase-buy{background:var(--m9-hudAccent);box-shadow:0 0 8px rgba(var(--m9-hudAccent-rgb),.6);}
.m9-phase-idle{background:transparent;border:1px solid var(--m9-concreteDark);}
.m9-room-empty{color:var(--m9-steel);font-size:13px;padding:12px 2px;letter-spacing:.04em;}

.m9-controls{display:grid;grid-template-columns:repeat(4,1fr);gap:7px 14px;}
.m9-ctl{display:flex;gap:7px;align-items:center;font-size:12px;color:var(--m9-concrete);}

/* ============ buy menu ================================================= */
.m9-buy-panel{width:min(1040px,96vw);}
.m9-buy-head{display:grid;grid-template-columns:1fr auto auto;gap:18px;align-items:center;
  padding-bottom:16px;border-bottom:1px solid var(--m9-metalDark);}
.m9-buy-title{margin:3px 0 0;font-size:27px;font-weight:800;letter-spacing:.2em;line-height:1;}
.m9-buystate{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:800;letter-spacing:.16em;
  padding:6px 12px;border-radius:999px;border:1px solid;}
.m9-buystate-glyph{font-size:9px;line-height:1;}
.m9-buystate.m9-open{color:var(--m9-hpGreen);border-color:rgba(var(--m9-hpGreen-rgb),.55);
  background:rgba(var(--m9-hpGreen-rgb),.12);}
.m9-buystate.m9-shut{color:var(--m9-danger);border-color:rgba(var(--m9-danger-rgb),.55);
  background:rgba(var(--m9-danger-rgb),.14);}
.m9-wallet{text-align:right;}
.m9-wallet-label{font-size:9px;font-weight:700;letter-spacing:.3em;color:var(--m9-steel);}
.m9-money{font-size:32px;font-weight:800;line-height:1.05;color:var(--m9-hpGreen);
  font-variant-numeric:tabular-nums;text-shadow:0 0 22px rgba(var(--m9-hpGreen-rgb),.3);}

.m9-buy-sechead{display:flex;align-items:center;gap:12px;margin:18px 0 10px;}
.m9-buy-seclabel{font-size:10px;font-weight:800;letter-spacing:.3em;color:var(--m9-hudText);}
.m9-buy-secrule{flex:1;height:1px;
  background:linear-gradient(90deg,rgba(var(--m9-hudAccent-rgb),.55),rgba(var(--m9-metalDark-rgb),.2));}
.m9-buy-seccap{font-size:9px;font-weight:700;letter-spacing:.22em;color:var(--m9-steel);}

.m9-buy-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}
.m9-gear-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;}
.m9-card{position:relative;overflow:hidden;text-align:left;font:inherit;cursor:pointer;
  color:var(--m9-hudText);border:1px solid var(--m9-metalDark);border-radius:10px;padding:14px 14px 12px 16px;
  background:linear-gradient(180deg,rgba(var(--m9-charcoal-rgb),.96),rgba(var(--m9-ink-rgb),.94));
  box-shadow:inset 0 1px 0 rgba(var(--m9-hudText-rgb),.07),0 6px 18px rgba(var(--m9-ink-rgb),.55);
  transition:border-color .12s ease,transform .12s ease,box-shadow .12s ease;}
.m9-card-weapon{display:flex;flex-direction:column;gap:9px;}
.m9-card-gear{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:stretch;}
.m9-gear-body{display:flex;flex-direction:column;gap:9px;min-width:0;}
/* state rail: colour AND a worded footer, never colour alone */
.m9-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;}
.m9-card.m9-st-ok::before{background:linear-gradient(180deg,var(--m9-hazardAmberLit),var(--m9-hudAccent));}
.m9-card.m9-st-own::before{background:linear-gradient(180deg,var(--m9-leafLit),var(--m9-hpGreen));}
.m9-card.m9-st-poor::before,.m9-card.m9-st-closed::before,.m9-card.m9-st-locked::before{
  background:linear-gradient(180deg,var(--m9-danger),var(--m9-roofRedDeep));}
.m9-card:hover:not(.m9-off):not(.m9-owned){border-color:var(--m9-hudAccent);transform:translateY(-2px);
  box-shadow:inset 0 1px 0 rgba(var(--m9-hudText-rgb),.09),0 12px 26px rgba(var(--m9-ink-rgb),.65);}
.m9-card.m9-owned{cursor:default;border-color:rgba(var(--m9-hpGreen-rgb),.65);
  box-shadow:inset 0 1px 0 rgba(var(--m9-hudText-rgb),.07),inset 0 0 24px rgba(var(--m9-hpGreen-rgb),.08);}
/* Unavailable cards go DARK and inert, never translucent. A card-level opacity
   is a group opacity: it fades the affordability footer and the struck-through
   price with it (a child cannot opt out), which drops the buy menu's most
   important hierarchy signal to ~1.6:1. Instead the card body sinks toward ink
   — which RAISES text contrast — and only the decorative layers are dimmed. */
.m9-card.m9-off{cursor:default;box-shadow:none;
  border-color:rgba(var(--m9-metalDark-rgb),.6);
  background:linear-gradient(180deg,rgba(var(--m9-ink-rgb),.9),rgba(var(--m9-ink-rgb),.97));}
.m9-card.m9-off:hover{border-color:rgba(var(--m9-metalDark-rgb),.6);}
.m9-card.m9-off .m9-card-icon{opacity:.5;filter:saturate(.25);}
.m9-card.m9-off .m9-meter-fill{opacity:.5;filter:saturate(.3);}
.m9-card-icon{display:flex;align-items:center;justify-content:center;height:70px;border-radius:8px;
  border:1px solid rgba(var(--m9-metalDark-rgb),.9);
  background:radial-gradient(120% 140% at 50% 12%,rgba(var(--m9-metalDark-rgb),.55),rgba(var(--m9-ink-rgb),.92));
  box-shadow:inset 0 2px 8px rgba(var(--m9-ink-rgb),.85);}
.m9-card-gear .m9-card-icon{width:148px;height:100%;min-height:92px;}
.m9-card-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px;}
.m9-card-name{font-weight:800;font-size:15px;letter-spacing:.05em;}
.m9-card-price{color:var(--m9-hudAccent);font-weight:800;font-size:15px;font-variant-numeric:tabular-nums;}
/* brickLit, not danger: the light red tier clears 6.5:1 on the card body where
   danger (#c0392b) sits at 2.8:1. The line-through carries the "unaffordable"
   read; the saturated danger red stays on the state rail, where it is a
   graphical mark and not 15px text. */
.m9-card-price.m9-price-over{color:var(--m9-brickLit);text-decoration:line-through;}
.m9-card-role{font-size:11.5px;color:var(--m9-concrete);line-height:1.4;min-height:32px;}

.m9-meters{display:flex;flex-direction:column;gap:5px;}
.m9-meter{display:grid;grid-template-columns:30px 1fr 46px;gap:8px;align-items:center;font-size:10px;}
.m9-meter-label{font-weight:700;letter-spacing:.12em;color:var(--m9-steel);}
.m9-meter-track{display:block;height:5px;border-radius:3px;overflow:hidden;
  background:rgba(var(--m9-ink-rgb),.92);box-shadow:inset 0 1px 2px rgba(var(--m9-ink-rgb),.95);}
.m9-meter-fill{display:block;height:100%;border-radius:3px;
  background:linear-gradient(90deg,var(--m9-tBrown),var(--m9-hudAccent) 58%,var(--m9-hazardAmberLit));}
.m9-meter-val{text-align:right;font-size:11px;font-weight:700;color:var(--m9-hudText);
  font-variant-numeric:tabular-nums;}

.m9-specs{display:flex;gap:8px;flex-wrap:wrap;}
.m9-spec{display:flex;align-items:baseline;gap:6px;padding:4px 9px;border-radius:6px;
  border:1px solid rgba(var(--m9-metalDark-rgb),.9);background:rgba(var(--m9-ink-rgb),.6);}
.m9-spec-label{font-size:9px;font-weight:700;letter-spacing:.16em;color:var(--m9-steel);}
.m9-spec-val{font-size:12px;font-weight:800;font-variant-numeric:tabular-nums;}

.m9-foot{display:flex;align-items:center;gap:7px;margin-top:auto;padding-top:9px;
  border-top:1px solid rgba(var(--m9-metalDark-rgb),.8);
  font-size:10.5px;font-weight:800;letter-spacing:.12em;font-variant-numeric:tabular-nums;}
.m9-foot-glyph{font-size:11px;line-height:1;}
.m9-foot.m9-foot-ok{color:var(--m9-hudAccent);}
.m9-foot.m9-foot-own{color:var(--m9-hpGreen);}
/* same reason as .m9-price-over: the footer is the affordability signal and has
   to survive as 10.5px text on the darkened unavailable card. */
.m9-foot.m9-foot-bad{color:var(--m9-brickLit);}

.m9-issued{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.m9-issued-chip{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:14px;
  border:1px solid rgba(var(--m9-metalDark-rgb),.85);border-radius:10px;padding:10px 14px;
  background:linear-gradient(180deg,rgba(var(--m9-charcoal-rgb),.6),rgba(var(--m9-ink-rgb),.6));
  box-shadow:inset 0 1px 0 rgba(var(--m9-hudText-rgb),.05);}
.m9-issued-icon{display:flex;align-items:center;justify-content:center;width:110px;height:44px;
  border-radius:6px;border:1px solid rgba(var(--m9-metalDark-rgb),.8);
  background:radial-gradient(120% 140% at 50% 12%,rgba(var(--m9-metalDark-rgb),.4),rgba(var(--m9-ink-rgb),.9));}
.m9-issued-meta{display:flex;flex-direction:column;gap:3px;min-width:0;}
.m9-issued-name{font-size:13px;font-weight:800;letter-spacing:.05em;}
.m9-issued-role{font-size:11px;line-height:1.35;color:var(--m9-concreteDark);}
.m9-issued-tag{font-size:9px;font-weight:800;letter-spacing:.18em;color:var(--m9-steel);
  border:1px solid var(--m9-metalDark);border-radius:999px;padding:3px 9px;}
.m9-hint{font-size:11px;color:var(--m9-steel);text-align:center;letter-spacing:.1em;}
.m9-buy-hint{display:flex;align-items:center;justify-content:center;gap:7px;margin-top:16px;}

/* ============ scoreboard =============================================== */
.m9-score-panel{width:min(980px,96vw);}
.m9-score-head{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:16px;margin-bottom:18px;}
.m9-score-vs{font-size:11px;font-weight:800;letter-spacing:.24em;color:var(--m9-steel);}
.m9-plate-t,.m9-plate-ct{position:relative;overflow:hidden;}
.m9-plate-t::before,.m9-plate-ct::before{content:'';position:absolute;top:0;bottom:0;width:4px;}
.m9-plate-t::before{left:0;background:linear-gradient(180deg,var(--m9-tLit),var(--m9-tDark));}
.m9-plate-ct::before{right:0;background:linear-gradient(180deg,var(--m9-ctLit),var(--m9-ctDark));}
.m9-score-plate{display:grid;grid-template-columns:1fr auto;align-items:center;gap:12px;
  padding:12px 18px;border:1px solid var(--m9-metalDark);border-radius:10px;
  background:linear-gradient(180deg,rgba(var(--m9-charcoal-rgb),.9),rgba(var(--m9-ink-rgb),.9));}
.m9-plate-tags{grid-column:1;grid-row:1;display:flex;align-items:center;gap:8px;}
.m9-plate-name{grid-column:1;grid-row:2;font-size:10px;font-weight:700;letter-spacing:.2em;color:var(--m9-steel);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m9-plate-score{grid-column:2;grid-row:1 / span 2;font-size:44px;font-weight:900;line-height:1;
  font-variant-numeric:tabular-nums;}
.m9-score-plate.m9-plate-ct{grid-template-columns:auto 1fr;text-align:right;}
.m9-plate-ct .m9-plate-tags{grid-column:2;grid-row:1;justify-content:flex-end;}
.m9-plate-ct .m9-plate-name{grid-column:2;grid-row:2;}
.m9-plate-ct .m9-plate-score{grid-column:1;grid-row:1 / span 2;}
.m9-score-plate.m9-plate-lead{box-shadow:inset 0 0 30px rgba(var(--m9-hudAccent-rgb),.1);}
.m9-plate-tags .m9-t,.m9-plate-tags .m9-ct{font-size:16px;font-weight:900;letter-spacing:.18em;}
.m9-plate-you{font-size:9px;font-weight:800;letter-spacing:.16em;color:var(--m9-ink);
  background:var(--m9-paper);border-radius:3px;padding:2px 6px;}
.m9-plate-foe{font-size:9px;font-weight:800;letter-spacing:.16em;color:var(--m9-steel);
  border:1px solid var(--m9-metalDark);border-radius:3px;padding:1px 6px;}
/* your plate is claimed by a lit rim + a full-height side rail, not by hue */
.m9-score-plate.m9-plate-mine{border-color:rgba(var(--m9-paper-rgb),.45);
  box-shadow:inset 0 1px 0 rgba(var(--m9-paper-rgb),.16);}
.m9-plate-mine.m9-plate-t::before,.m9-plate-mine.m9-plate-ct::before{width:7px;}
.m9-t{color:var(--m9-tAmber);}
.m9-ct{color:var(--m9-ctLit);}

.m9-tables{display:flex;gap:14px;flex-wrap:wrap;}
.m9-table{flex:1 1 340px;border:1px solid var(--m9-metalDark);border-radius:10px;overflow:hidden;
  background:rgba(var(--m9-ink-rgb),.6);}
.m9-table-head{display:grid;grid-template-columns:auto 1fr auto auto;align-items:center;gap:10px;
  padding:10px 12px;font-weight:800;font-size:11px;letter-spacing:.2em;}
.m9-th-tag{font-size:15px;font-weight:900;letter-spacing:.14em;}
/* which table is yours: a word in the header band, not a shade of the band */
.m9-th-mine{font-size:9px;font-weight:900;letter-spacing:.18em;padding:2px 8px;border-radius:3px;
  white-space:nowrap;background:rgba(var(--m9-ink-rgb),.8);color:var(--m9-paper);}
.m9-th-foe{font-size:9px;font-weight:800;letter-spacing:.18em;padding:1px 7px;border-radius:3px;
  white-space:nowrap;border:1px solid currentColor;opacity:.72;}
.m9-table.m9-table-mine{border-color:rgba(var(--m9-paper-rgb),.42);
  box-shadow:0 0 0 1px rgba(var(--m9-paper-rgb),.12);}
.m9-th-count{font-size:11px;font-weight:800;letter-spacing:.06em;opacity:.75;
  border:1px solid currentColor;border-radius:999px;padding:1px 8px;}
.m9-th-t{color:var(--m9-ink);background:linear-gradient(180deg,var(--m9-tLit),var(--m9-tAmber));}
.m9-th-ct{color:var(--m9-paper);background:linear-gradient(180deg,var(--m9-ctLit),var(--m9-ctBlue));}
.m9-row{display:grid;grid-template-columns:16px 1fr 36px 36px 36px 50px 62px;gap:5px;align-items:center;
  padding:7px 12px;font-size:13px;border-top:1px solid rgba(var(--m9-metalDark-rgb),.55);}
.m9-table .m9-row:nth-child(even){background:rgba(var(--m9-paper-rgb),.028);}
/* both of these must out-specify the zebra rule above, so they are qualified */
.m9-table .m9-row.m9-cols-head{font-size:9px;font-weight:800;color:var(--m9-steel);letter-spacing:.18em;
  background:rgba(var(--m9-ink-rgb),.75);padding-top:6px;padding-bottom:6px;}
.m9-table .m9-row.m9-you{background:rgba(var(--m9-hudAccent-rgb),.16);font-weight:700;
  box-shadow:inset 3px 0 0 var(--m9-hudAccent);}
.m9-th-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m9-buy-head-l{min-width:0;}
.m9-dot{width:8px;height:8px;border-radius:50%;background:var(--m9-hpGreen);display:inline-block;
  box-shadow:0 0 7px rgba(var(--m9-hpGreen-rgb),.6);}
.m9-dot.m9-off{background:transparent;border:1px solid var(--m9-concreteDark);box-shadow:none;}
/* dead: the mark changes SHAPE (filled circle -> hollow rotated square) */
.m9-dot.m9-down{width:7px;height:7px;background:transparent;border-radius:0;
  border:1px solid var(--m9-danger);box-shadow:none;transform:rotate(45deg);}
.m9-table .m9-row.m9-dead .m9-c-name{color:var(--m9-steel);text-decoration:line-through;}
.m9-table .m9-row.m9-dead .m9-c-num{opacity:.62;}
.m9-dead-tag{margin-left:6px;padding:0 5px;border-radius:3px;font-size:9px;font-weight:800;
  letter-spacing:.12em;background:rgba(var(--m9-danger-rgb),.2);color:var(--m9-paper);
  border:1px solid rgba(var(--m9-danger-rgb),.75);vertical-align:1px;text-decoration:none;}
.m9-out-tag{margin-left:6px;padding:0 5px;border-radius:3px;font-size:9px;font-weight:800;
  letter-spacing:.12em;background:var(--m9-metalDark);color:var(--m9-steel);
  vertical-align:1px;text-decoration:none;}
.m9-c-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:.02em;}
.m9-bot-tag{margin-left:6px;padding:0 5px;border-radius:3px;font-size:9px;font-weight:800;
  letter-spacing:.12em;background:var(--m9-metalDark);color:var(--m9-steel);vertical-align:1px;}
.m9-you-tag{margin-left:6px;padding:0 5px;border-radius:3px;font-size:9px;font-weight:800;
  letter-spacing:.12em;background:var(--m9-hudAccent);color:var(--m9-ink);vertical-align:1px;}
.m9-c-num{text-align:right;font-variant-numeric:tabular-nums;}
.m9-c-k{font-weight:800;}
.m9-c-kd{color:var(--m9-steel);}
.m9-c-cash{color:var(--m9-hpGreen);font-size:12px;}
.m9-table-empty{color:var(--m9-steel);font-size:12px;padding:12px;letter-spacing:.06em;
  border-top:1px solid rgba(var(--m9-metalDark-rgb),.55);}
.m9-score-legend{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:14px;
  font-size:10px;letter-spacing:.14em;color:var(--m9-steel);}
.m9-legend-you{padding:1px 6px;border-radius:3px;font-weight:800;
  background:var(--m9-hudAccent);color:var(--m9-ink);}

/* ============ match end ================================================ */
.m9-end-panel{width:min(760px,94vw);text-align:center;display:flex;flex-direction:column;align-items:center;
  gap:20px;max-height:94vh;overflow-y:auto;padding:30px 32px 26px;border-radius:14px;
  border:1px solid var(--m9-metalDark);
  background:linear-gradient(180deg,rgba(var(--m9-charcoal-rgb),.95),rgba(var(--m9-ink-rgb),.98));
  box-shadow:0 30px 80px rgba(var(--m9-ink-rgb),.85),inset 0 1px 0 rgba(var(--m9-hudText-rgb),.08);}
.m9-end-banner{width:100%;}
.m9-end-eyebrow{margin-bottom:8px;}
.m9-end-title{margin:0;font-size:70px;font-weight:900;letter-spacing:.28em;line-height:1;text-indent:.28em;
  color:var(--m9-hudText);text-shadow:0 3px 0 rgba(var(--m9-ink-rgb),.9),0 16px 44px rgba(var(--m9-ink-rgb),.9);}
.m9-end-win .m9-end-title{color:var(--m9-hpGreen);
  text-shadow:0 3px 0 rgba(var(--m9-ink-rgb),.9),0 0 46px rgba(var(--m9-hpGreen-rgb),.4);}
.m9-end-lose .m9-end-title{color:var(--m9-danger);
  text-shadow:0 3px 0 rgba(var(--m9-ink-rgb),.9),0 0 46px rgba(var(--m9-danger-rgb),.35);}
.m9-end-underline{height:3px;width:200px;margin:14px auto 12px;border-radius:2px;
  background:linear-gradient(90deg,transparent,var(--m9-steel),transparent);}
.m9-end-win .m9-end-underline{background:linear-gradient(90deg,transparent,var(--m9-hpGreen),transparent);}
.m9-end-lose .m9-end-underline{background:linear-gradient(90deg,transparent,var(--m9-danger),transparent);}
.m9-end-sub{font-size:11px;font-weight:700;letter-spacing:.2em;color:var(--m9-steel);text-transform:uppercase;}
.m9-end-score{display:flex;align-items:center;justify-content:center;gap:20px;}
.m9-end-side{min-width:150px;padding:12px 20px;border-radius:10px;border:1px solid var(--m9-metalDark);
  background:linear-gradient(180deg,rgba(var(--m9-charcoal-rgb),.9),rgba(var(--m9-ink-rgb),.92));}
.m9-end-side.m9-end-winner{border-color:var(--m9-hudAccent);
  box-shadow:0 0 0 1px rgba(var(--m9-hudAccent-rgb),.4),0 14px 32px rgba(var(--m9-ink-rgb),.6);}
.m9-end-tag{font-size:13px;font-weight:900;letter-spacing:.24em;}
.m9-end-num{font-size:50px;font-weight:900;line-height:1.05;font-variant-numeric:tabular-nums;}
.m9-end-wintag{min-height:13px;font-size:9px;font-weight:800;letter-spacing:.2em;color:var(--m9-hudAccent);}
.m9-end-dash{font-size:20px;color:var(--m9-steel);}
.m9-top3{width:100%;display:flex;flex-direction:column;gap:6px;}
.m9-top3-head{font-size:9px;font-weight:800;letter-spacing:.3em;color:var(--m9-steel);text-align:left;
  margin-bottom:2px;}
.m9-top3-row{display:grid;grid-template-columns:46px 30px 1fr auto;gap:12px;align-items:center;
  border:1px solid var(--m9-metalDark);border-radius:8px;padding:10px 16px;font-size:14px;
  background:linear-gradient(90deg,rgba(var(--m9-charcoal-rgb),.9),rgba(var(--m9-ink-rgb),.9));}
.m9-top3-first{border-color:rgba(var(--m9-hudAccent-rgb),.7);
  background:linear-gradient(90deg,rgba(var(--m9-hudAccent-rgb),.18),rgba(var(--m9-ink-rgb),.9));}
.m9-top3-rank{font-size:11px;font-weight:900;letter-spacing:.1em;color:var(--m9-steel);text-align:left;}
.m9-top3-first .m9-top3-rank{color:var(--m9-hudAccent);}
.m9-top3-name{text-align:left;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m9-top3-kd{display:flex;align-items:baseline;gap:8px;}
.m9-top3-k{font-size:19px;font-weight:900;font-variant-numeric:tabular-nums;}
.m9-top3-klabel{font-size:9px;font-weight:700;letter-spacing:.18em;color:var(--m9-steel);}
.m9-top3-hs{font-size:11px;color:var(--m9-steel);font-variant-numeric:tabular-nums;}
.m9-end-hint{margin-top:2px;animation:m9pulse 2s ease-in-out infinite;}

/* ============ joining ================================================== */
.m9-join{display:flex;flex-direction:column;align-items:center;gap:12px;}
.m9-join-text{font-size:32px;font-weight:800;letter-spacing:.36em;text-indent:.36em;}
.m9-join-bar{position:relative;width:240px;height:3px;border-radius:2px;overflow:hidden;
  background:rgba(var(--m9-hudAccent-rgb),.18);}
.m9-join-bar-fill{position:absolute;top:0;bottom:0;width:80px;left:-90px;border-radius:2px;
  background:linear-gradient(90deg,rgba(var(--m9-hudAccent-rgb),0),var(--m9-hazardAmberLit),rgba(var(--m9-hudAccent-rgb),0));
  animation:m9scan 1.5s ease-in-out infinite;}
@keyframes m9scan{0%{left:-90px;}100%{left:240px;}}
.m9-join-sub{font-size:11px;letter-spacing:.2em;color:var(--m9-steel);animation:m9pulse 1.8s ease-in-out infinite;}
@keyframes m9pulse{0%,100%{opacity:.5;}50%{opacity:1;}}

/* ============ room chip / bot prompt =================================== */
.fps-menus .m9-layer-chip{align-items:flex-start;justify-content:flex-start;}
.m9-chip{position:relative;overflow:hidden;margin:14px;display:flex;align-items:center;gap:9px;
  padding:7px 12px 7px 14px;border:1px solid var(--m9-metalDark);border-radius:8px;font-size:12px;
  background:linear-gradient(180deg,rgba(var(--m9-charcoal-rgb),.92),rgba(var(--m9-ink-rgb),.9));
  box-shadow:0 6px 18px rgba(var(--m9-ink-rgb),.6),inset 0 1px 0 rgba(var(--m9-hudText-rgb),.08);}
.m9-chip::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;
  background:linear-gradient(180deg,var(--m9-hazardAmberLit),var(--m9-hudAccent));}
.m9-chip-label{font-weight:700;letter-spacing:.1em;}
.m9-chip-sep{display:block;width:1px;height:15px;background:rgba(var(--m9-steel-rgb),.35);}
.m9-chip-cap{font-size:9px;font-weight:700;letter-spacing:.24em;color:var(--m9-steel);}
.m9-chip-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;font-weight:800;
  letter-spacing:.2em;color:var(--m9-hudAccent);}
/* only the invite chip takes pointer events; the plain chip stays click-through */
.m9-chip-copy{pointer-events:auto;}
.m9-chip-btn{padding:4px 9px;font-size:10px;}

.fps-menus .m9-layer-botprompt{align-items:flex-end;justify-content:flex-end;padding:0 6vw 96px;}
.m9-botprompt{display:flex;flex-direction:column;gap:10px;pointer-events:auto;
  background:linear-gradient(180deg,rgba(var(--m9-charcoal-rgb),.92),rgba(var(--m9-ink-rgb),.9));
  border:1px solid var(--m9-metalDark);border-radius:10px;padding:12px 16px;font-size:12px;letter-spacing:.05em;
  box-shadow:0 12px 30px rgba(var(--m9-ink-rgb),.65),inset 0 1px 0 rgba(var(--m9-hudText-rgb),.08);}
.m9-botprompt-text{font-weight:600;}
.m9-botprompt-btns{display:flex;gap:6px;flex-wrap:wrap;}

/* ============ pause ==================================================== */
.m9-pause-panel{width:min(340px,92vw);display:flex;flex-direction:column;gap:12px;text-align:center;}
.m9-pause-title{margin:0;font-size:26px;font-weight:800;letter-spacing:.24em;text-indent:.24em;}
.m9-pause-group{display:flex;flex-direction:column;gap:7px;padding:11px;border-radius:10px;
  border:1px solid rgba(var(--m9-metalDark-rgb),.85);background:rgba(var(--m9-ink-rgb),.5);}
.m9-pause-glabel{font-size:9px;font-weight:800;letter-spacing:.3em;color:var(--m9-steel);text-align:left;}
.m9-pause-pair{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.m9-pause-pair .m9-btn{font-size:11px;padding:9px 4px;letter-spacing:.04em;}
.m9-pause-spacer{height:1px;background:rgba(var(--m9-metalDark-rgb),.8);margin:2px 0;}
.fps-menus .m9-btn-t{border-color:rgba(var(--m9-tAmber-rgb),.8);color:var(--m9-tLit);
  background:linear-gradient(180deg,rgba(var(--m9-tAmber-rgb),.16),rgba(var(--m9-ink-rgb),.6));}
.fps-menus .m9-btn-t:hover:not(:disabled){border-color:var(--m9-tAmber);background:rgba(var(--m9-tAmber-rgb),.28);}
.fps-menus .m9-btn-ct{border-color:rgba(var(--m9-ctBlue-rgb),.85);color:var(--m9-ctLit);
  background:linear-gradient(180deg,rgba(var(--m9-ctBlue-rgb),.2),rgba(var(--m9-ink-rgb),.6));}
.fps-menus .m9-btn-ct:hover:not(:disabled){border-color:var(--m9-ctLit);background:rgba(var(--m9-ctBlue-rgb),.34);}
.m9-team-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;}
.m9-team-current{font-size:9px;font-weight:800;letter-spacing:.14em;color:var(--m9-steel);}

/* ============ dev console ============================================== */
.fps-menus .m9-console{position:absolute;top:0;left:0;right:0;height:40%;display:flex;flex-direction:column;
  pointer-events:auto;background:rgba(var(--m9-ink-rgb),.92);border-bottom:1px solid var(--m9-metalDark);
  box-shadow:0 14px 40px rgba(var(--m9-ink-rgb),.75);
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:var(--m9-hudText);}
.m9-console-out{flex:1;overflow-y:auto;padding:10px 14px;line-height:1.45;}
.m9-console-line{white-space:pre-wrap;word-break:break-word;}
.m9-console-row{display:flex;align-items:center;gap:8px;padding:7px 14px;
  border-top:1px solid rgba(var(--m9-metalDark-rgb),.8);background:rgba(var(--m9-charcoal-rgb),.5);}
.m9-console-prompt{color:var(--m9-hudAccent);font-weight:700;}
.m9-console-input{flex:1;background:transparent;border:none;outline:none;padding:2px 0;
  color:var(--m9-hudText);font:inherit;font-family:inherit;}

/* ============ narrow viewports ========================================= */
@media (max-width:980px){
  .m9-buy-grid{grid-template-columns:repeat(2,1fr);}
}
@media (max-width:760px){
  .m9-cols{grid-template-columns:1fr;}
  .m9-buy-grid{grid-template-columns:repeat(2,1fr);}
  .m9-gear-grid{grid-template-columns:1fr;}
  .m9-issued{grid-template-columns:1fr;}
  .m9-controls{grid-template-columns:repeat(2,1fr);}
  .m9-buy-head{grid-template-columns:1fr auto;}
  .m9-wallet{grid-column:1 / -1;text-align:left;}
  .m9-title{font-size:38px;}
  .m9-end-title{font-size:42px;}
  .m9-map-grid{grid-template-columns:repeat(2,1fr);}
}
`;
