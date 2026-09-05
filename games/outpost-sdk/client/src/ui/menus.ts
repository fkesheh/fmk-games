// ============================================================================
// ui-menus — OUTPOST's menu surface.
//
// DOM overlays mounted on the `root` element the integrator hands in. Every
// layer is mutually-exclusive-by-construction (`MODALS`) except the three
// lightweight, non-blocking layers (`chip`, `intermission`, `hint`) that sit
// over live gameplay without stealing it. Colours trace to PALETTE via CSS
// custom properties (`--op-*`) set once in the constructor, per CONTRACT.md.
//
// Required-states checklist (UX_BIBLE "Required states" + brief):
//   main (+ error) · joining · lobby · wave-active (owned by hud.ts, not us)
//   · intermission · weapon rack · ammo crate · pause · spectating-while-dead
//   · run-end (per-player RunStats, no win screen) · first-run onboarding
//   · the three one-time contextual hints.
// ============================================================================
import { WEAPONS } from '@fps/shared';
import type { WeaponId } from '@fps/shared';
import { cleanName, loadName, saveName } from '@platform/shared';
import type { RoomInfo } from '@platform/shared';
import { ECONOMY, MAX_PLAYERS, MIN_PLAYERS, PALETTE, SURVIVOR } from '@outpost/shared';
import type { MenuCallbacks, MenusApi, RosterEntry, RunStats } from '@outpost/shared';

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const STYLE_ID = 'outpost-menus-style';
// Mirrors server/src/room.ts's PRIVATE_CODE_LEN (not exported to the client —
// it is a wire-sanitised value there; here it only bounds an input field).
const PRIVATE_CODE_LEN = 5;
const HINT_MS = 8000; // how long a one-time contextual toast stays up
const ONBOARD_KEY = 'outpost.onboard.seen.v1';
const hintStorageKey = (k: HintKey): string => `outpost.hint.${k}.v1`;

type HintKey = 'stairs' | 'repair' | 'revive';

type LayerId =
  | 'main'
  | 'joining'
  | 'lobby'
  | 'weaponRack'
  | 'ammoCrate'
  | 'pause'
  | 'spectating'
  | 'runEnd'
  | 'onboarding'
  | 'chip'
  | 'intermission'
  | 'hint';

// Full-screen, mutually-exclusive layers. `chip` / `intermission` / `hint`
// are deliberately excluded — they sit over live gameplay, never eat pointer
// events on their own, and must not blank the run-continues co-op HUD.
const MODALS: readonly LayerId[] = [
  'main',
  'joining',
  'lobby',
  'weaponRack',
  'ammoCrate',
  'pause',
  'spectating',
  'runEnd',
  'onboarding',
];

// Ascending price order (ECONOMY.weaponPrice) doubles as the natural pacing
// order from DESIGN_BIBLE: shotgun ~wave 3, rifle ~wave 6, sniper ~wave 10.
const SHOP_WEAPONS: readonly WeaponId[] = ['shotgun', 'smg', 'rifle', 'sniper'];
const ISSUED_WEAPONS: readonly WeaponId[] = ['knife', 'pistol'];

const WEAPON_ROLE: Record<WeaponId, string> = {
  knife: 'Issued blade. Silent, but you should never be this close.',
  pistol: 'Issued sidearm — free, unlimited reserve pressure once you’re dry.',
  smg: 'High fire-rate, forgiving hip-fire. Keeps the horde off you up close.',
  shotgun: 'Close-range stopping power at the fence. Useless past the firing step.',
  rifle: 'The all-rounder — reliable at any range a zombie actually reaches you from.',
  sniper: 'One shot drops anything but a brute. Punishing reload; no room to panic.',
};

const MAX_SHOP_DMG = Math.max(...SHOP_WEAPONS.map((w) => WEAPONS[w].damage * WEAPONS[w].pellets));
const MAX_SHOP_RPM = Math.max(...SHOP_WEAPONS.map((w) => 60 / WEAPONS[w].interval));
const MAX_SHOP_MAG = Math.max(...SHOP_WEAPONS.map((w) => WEAPONS[w].mag));

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

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

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function hexRgb(hex: string): string {
  const v = parseInt(hex.slice(1), 16);
  return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
}

function rgba(hex: string, a: number): string {
  return `rgba(${hexRgb(hex)},${a})`;
}

function fmtClock(secondsLeft: number): string {
  const s = Math.max(0, Math.ceil(secondsLeft));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${r.toString().padStart(2, '0')}` : `${r}`;
}

function injectStyleOnce(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function meter(label: string, value: string, frac: number): HTMLElement {
  const row = el('div', 'op-meter');
  row.appendChild(el('span', 'op-meter-label', label));
  const track = el('span', 'op-meter-track');
  const fill = el('span', 'op-meter-fill');
  fill.style.width = `${Math.round(Math.min(1, Math.max(0.08, frac)) * 100)}%`;
  track.appendChild(fill);
  row.appendChild(track);
  row.appendChild(el('span', 'op-meter-val', value));
  return row;
}

function hintRow(pairs: ReadonlyArray<readonly [string, string]>): HTMLElement {
  const row = el('div', 'op-hintrow');
  for (const [key, verb] of pairs) {
    row.appendChild(el('span', 'op-kbd', key));
    row.appendChild(el('span', '', verb));
  }
  return row;
}

/** Buy-card affordability state. Never colour alone — glyph + word too. */
type BuyState = 'own' | 'full' | 'poor' | 'ok';

function buyFooter(state: BuyState, delta: number): HTMLElement {
  const glyph = state === 'own' ? '✓' : state === 'ok' ? '▸' : '✕';
  const text =
    state === 'own'
      ? 'CARRIED'
      : state === 'full'
        ? `SLOTS FULL (${SURVIVOR.firearmSlots}/${SURVIVOR.firearmSlots})`
        : state === 'poor'
          ? `NEED ${delta} MORE SCRAP`
          : `LEAVES ${delta} SCRAP`;
  const kind = state === 'own' ? 'op-foot-own' : state === 'ok' ? 'op-foot-ok' : 'op-foot-bad';
  const foot = el('div', `op-foot ${kind}`);
  const g = el('span', 'op-foot-glyph', glyph);
  g.setAttribute('aria-hidden', 'true');
  foot.appendChild(g);
  foot.appendChild(el('span', '', text));
  return foot;
}

// ============================================================================
export class Menus implements MenusApi {
  private readonly cb: MenuCallbacks;
  private readonly host: HTMLElement;
  private readonly layers: Record<LayerId, HTMLElement>;

  private nameInput: HTMLInputElement | null = null;
  private roomListEl: HTMLElement | null = null;
  private roomReq = 0; // stale-guard for async room-list refreshes

  // intermission: cheap-update refs so a per-tick call never rebuilds the DOM
  private interWaveEl: HTMLElement | null = null;
  private interClockEl: HTMLElement | null = null;
  // EVERY rebuilding dialog carries a signature guard. Unguarded, a dialog on
  // the frame path is torn down and rebuilt ~60x/second, which (a) burns CPU
  // redrawing static markup and (b) makes it UNCLICKABLE, because a real mouse
  // click needs mousedown and mouseup on the SAME element and the button is
  // replaced between them. Synthetic el.click() cannot see this; only a human
  // pressing the button can. Guard first, ship second.
  private mainSig = '';
  private chipSig = '';
  private runEndSig = '';
  private lobbySig = '';
  private rackSig = '';
  private crateSig = '';
  private interSig = '';

  // spectating: same cheap-update discipline
  private specWaveEl: HTMLElement | null = null;
  private specSig = '';

  private hintTimer = 0;
  private onboardKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private rackKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(root: HTMLElement, cb: MenuCallbacks) {
    this.cb = cb;
    for (const [key, hex] of Object.entries(PALETTE)) {
      root.style.setProperty(`--op-${key}`, hex);
      root.style.setProperty(`--op-${key}-rgb`, hexRgb(hex));
    }
    injectStyleOnce();
    this.host = el('div', 'op-menus');
    root.appendChild(this.host);
    this.layers = {
      main: this.makeLayer('main', true),
      joining: this.makeLayer('joining', true),
      lobby: this.makeLayer('lobby', true),
      weaponRack: this.makeLayer('weaponRack', true),
      ammoCrate: this.makeLayer('ammoCrate', true),
      pause: this.makeLayer('pause', true),
      spectating: this.makeLayer('spectating', true),
      runEnd: this.makeLayer('runEnd', true),
      onboarding: this.makeLayer('onboarding', true),
      chip: this.makeLayer('chip', false),
      intermission: this.makeLayer('intermission', false),
      hint: this.makeLayer('hint', false),
    };
    this.buildJoining();
    this.buildPause();
  }

  // ---- layer plumbing -------------------------------------------------------
  private makeLayer(id: LayerId, modal: boolean): HTMLElement {
    const d = el('div', `op-layer${modal ? ' op-modal' : ' op-passthrough'} op-layer-${id}`);
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

  private name(): string {
    const raw = this.nameInput !== null ? this.nameInput.value : '';
    saveName(raw);
    return cleanName(raw);
  }

  // ============================================================================
  // MAIN MENU (+ error)
  // ============================================================================
  showMain(errorText?: string): void {
    this.showExclusive('main');
    this.hide('chip');
    const layer = this.layers.main;
    const sig = errorText ?? '';
    if (sig === this.mainSig && layer.firstChild !== null) return;
    this.mainSig = sig;
    layer.textContent = '';

    const panel = el('div', 'op-panel op-main-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'OUTPOST main menu');

    if (errorText !== undefined && errorText !== '') {
      panel.appendChild(this.buildErrorBanner(errorText));
    }

    const hero = el('div', 'op-hero');
    hero.appendChild(el('div', 'op-eyebrow', 'HOLD THE LINE'));
    hero.appendChild(el('h1', 'op-title', 'OUTPOST'));
    hero.appendChild(
      el(
        'div',
        'op-tagline',
        'A fenced watchtower. Endless waves of the dead. Nobody wins — you just last.',
      ),
    );
    const meta = el('div', 'op-hero-meta');
    for (const item of [`${MIN_PLAYERS}–${MAX_PLAYERS} SURVIVORS`, 'CO-OP DEFENCE', 'NO RESPAWNS']) {
      meta.appendChild(el('span', 'op-hero-metaitem', item));
    }
    hero.appendChild(meta);
    panel.appendChild(hero);
    panel.appendChild(el('div', 'op-rule'));

    const field = el('div', 'op-field');
    field.appendChild(el('label', 'op-label', 'CALLSIGN'));
    const nameInput = el('input', 'op-input');
    nameInput.maxLength = 16;
    nameInput.spellcheck = false;
    nameInput.autocomplete = 'off';
    nameInput.placeholder = 'Survivor';
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

    const quick = el('button', 'op-btn op-btn-primary op-wide', 'QUICK JOIN');
    quick.type = 'button';
    quick.addEventListener('click', () => this.cb.onQuickJoin(this.name()));
    panel.appendChild(quick);

    const cols = el('div', 'op-cols');
    cols.appendChild(this.buildCreateCol());
    cols.appendChild(this.buildJoinCol());
    panel.appendChild(cols);

    const roomsSec = el('div', 'op-sec op-rooms-sec');
    const roomsHead = el('div', 'op-rooms-head');
    roomsHead.appendChild(el('h2', 'op-sec-title', 'PUBLIC OUTPOSTS'));
    const refresh = el('button', 'op-btn op-btn-small', 'REFRESH');
    refresh.type = 'button';
    refresh.addEventListener('click', () => this.loadRooms());
    roomsHead.appendChild(refresh);
    roomsSec.appendChild(roomsHead);
    const list = el('div', 'op-room-list');
    this.roomListEl = list;
    roomsSec.appendChild(list);
    panel.appendChild(roomsSec);

    panel.appendChild(this.buildControls());
    layer.appendChild(panel);
    this.loadRooms();
  }

  private buildErrorBanner(text: string): HTMLElement {
    const box = el('div', 'op-errbox');
    box.setAttribute('role', 'alert');
    box.appendChild(el('span', 'op-errglyph', '⚠'));
    const body = el('div', 'op-errbody');
    body.appendChild(el('div', 'op-erreyebrow', 'CAN’T GET YOU IN'));
    body.appendChild(el('div', 'op-errtext', text));
    body.appendChild(el('div', 'op-errway', 'Fix that, then try Quick Join again below.'));
    box.appendChild(body);
    return box;
  }

  private buildCreateCol(): HTMLElement {
    const sec = el('div', 'op-sec');
    sec.appendChild(el('h2', 'op-sec-title', 'CREATE'));
    sec.appendChild(el('div', 'op-sec-caption', 'One map: the Ridgeline outpost. Seat your squad.'));
    const actions = el('div', 'op-create-actions');
    const pub = el('button', 'op-btn op-btn-primary op-wide', 'CREATE PUBLIC');
    pub.type = 'button';
    pub.title = 'Listed below for anyone to join';
    pub.addEventListener('click', () => this.cb.onCreatePublic(this.name()));
    const priv = el('button', 'op-btn op-wide', 'CREATE PRIVATE');
    priv.type = 'button';
    priv.title = 'Share-code only';
    priv.addEventListener('click', () => this.cb.onCreatePrivate(this.name()));
    actions.appendChild(pub);
    actions.appendChild(priv);
    sec.appendChild(actions);
    return sec;
  }

  private buildJoinCol(): HTMLElement {
    const sec = el('div', 'op-sec');
    sec.appendChild(el('h2', 'op-sec-title', 'JOIN PRIVATE'));
    const code = el('input', 'op-input op-code');
    code.maxLength = PRIVATE_CODE_LEN;
    code.placeholder = 'CODE';
    code.spellcheck = false;
    code.autocomplete = 'off';
    code.setAttribute('aria-label', `${PRIVATE_CODE_LEN}-character room code`);
    const join = el('button', 'op-btn op-btn-primary op-wide', 'JOIN');
    join.type = 'button';
    join.disabled = true;
    const tryJoin = (): void => {
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
    sec.appendChild(
      el('div', 'op-join-note', `Ask the host for their ${PRIVATE_CODE_LEN}-character code.`),
    );
    return sec;
  }

  private buildControls(): HTMLElement {
    const sec = el('div', 'op-sec');
    sec.appendChild(el('h2', 'op-sec-title', 'CONTROLS'));
    const grid = el('div', 'op-controls');
    const rows: ReadonlyArray<readonly [string, string]> = [
      ['WASD', 'Move'],
      ['Mouse', 'Look'],
      ['LMB', 'Fire'],
      ['RMB', 'Aim'],
      ['R', 'Reload'],
      ['1 / 2 / 3', 'Weapons'],
      ['Hold E', 'Interact — repair / revive / buy'],
      ['Tab', 'Squad'],
      ['Esc', 'Pause'],
    ];
    for (const [key, verb] of rows) {
      const item = el('div', 'op-ctl');
      item.appendChild(el('span', 'op-kbd', key));
      item.appendChild(el('span', '', verb));
      grid.appendChild(item);
    }
    sec.appendChild(grid);
    return sec;
  }

  private loadRooms(): void {
    const req = ++this.roomReq;
    this.setRoomsMsg('Scanning for outposts…');
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
    if (list === null) return;
    list.textContent = '';
    list.appendChild(el('div', 'op-room-empty', msg));
  }

  private renderRooms(rooms: RoomInfo[]): void {
    const list = this.roomListEl;
    if (list === null) return;
    list.textContent = '';
    if (rooms.length === 0) {
      list.appendChild(el('div', 'op-room-empty', 'No public outposts yet — Quick Join creates one'));
      return;
    }
    for (const r of rooms) {
      const row = el('button', 'op-room-row');
      row.type = 'button';
      row.title = 'Click to join';
      row.appendChild(el('span', 'op-room-label', r.label !== '' ? r.label : 'OUTPOST'));

      const cap = el('span', 'op-room-players');
      const track = el('span', 'op-cap-track');
      const fill = el('span', 'op-cap-fill');
      const frac = r.maxPlayers > 0 ? r.players / r.maxPlayers : 0;
      fill.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
      if (frac >= 1) fill.classList.add('op-cap-full');
      track.appendChild(fill);
      cap.appendChild(track);
      cap.appendChild(el('span', 'op-cap-num', `${r.players}/${r.maxPlayers}`));
      row.appendChild(cap);

      const phase = el('span', 'op-room-phase');
      const tier =
        r.phase === 'wave' ? 'live' : r.phase === 'intermission' ? 'buy' : r.phase === 'ended' ? 'over' : 'idle';
      const dot = el('span', `op-phase-dot op-phase-${tier}`);
      dot.setAttribute('aria-hidden', 'true');
      phase.appendChild(dot);
      phase.appendChild(el('span', '', r.phase.toUpperCase()));
      row.appendChild(phase);
      row.addEventListener('click', () => this.cb.onQuickJoin(this.name()));
      list.appendChild(row);
    }
  }

  // ============================================================================
  // ROOM CHIP (non-modal, top-left)
  // ============================================================================
  showInRoom(code: string | null): void {
    const chip = this.layers.chip;
    const sig = code ?? '';
    if (sig === this.chipSig && chip.firstChild !== null) {
      this.show('chip');
      return;
    }
    this.chipSig = sig;
    chip.textContent = '';
    const box = el('div', code !== null ? 'op-chip op-chip-copy' : 'op-chip');
    box.appendChild(el('span', 'op-chip-label', 'OUTPOST'));
    if (code !== null) {
      box.appendChild(el('span', 'op-chip-sep'));
      box.appendChild(el('span', 'op-chip-cap', 'CODE'));
      box.appendChild(el('span', 'op-chip-code', code));
      const copy = el('button', 'op-btn op-btn-small op-chip-btn', 'COPY INVITE');
      copy.type = 'button';
      copy.addEventListener('click', () => this.copyInvite(code, copy));
      box.appendChild(copy);
    }
    chip.appendChild(box);
    this.show('chip');
  }

  private copyInvite(code: string, btn: HTMLButtonElement): void {
    const url = `${location.origin}${location.pathname}?code=${code}`;
    const clip: Clipboard | undefined = navigator.clipboard;
    if (clip !== undefined) {
      clip.writeText(url).then(
        () => this.showCopied(btn),
        () => this.copyInviteFallback(url, btn),
      );
    } else {
      this.copyInviteFallback(url, btn);
    }
  }

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

  private showCopied(btn: HTMLButtonElement): void {
    btn.textContent = 'COPIED';
    window.setTimeout(() => {
      btn.textContent = 'COPY INVITE';
    }, 1200);
  }

  // ============================================================================
  // JOINING
  // ============================================================================
  private joiningSubEl: HTMLElement | null = null;

  private buildJoining(): void {
    const box = el('div', 'op-join');
    box.appendChild(el('div', 'op-eyebrow', 'OUTPOST'));
    box.appendChild(el('div', 'op-join-text', 'CONNECTING'));
    const bar = el('div', 'op-join-bar');
    bar.appendChild(el('span', 'op-join-bar-fill'));
    box.appendChild(bar);
    const sub = el('div', 'op-join-sub', 'Reserving a seat on the outpost…');
    this.joiningSubEl = sub;
    box.appendChild(sub);
    this.layers.joining.appendChild(box);
  }

  showJoining(subtitle?: string): void {
    this.showExclusive('joining');
    this.hide('chip');
    if (this.joiningSubEl !== null) {
      setText(this.joiningSubEl, subtitle ?? 'Reserving a seat on the outpost…');
    }
  }

  // ============================================================================
  // LOBBY
  // ============================================================================
  showLobby(seated: readonly RosterEntry[], canStart: boolean): void {
    this.showExclusive('lobby');
    const layer = this.layers.lobby;

    // REBUILD ONLY WHEN THE CONTENT ACTUALLY CHANGES. The integrator calls this
    // every frame while the phase is 'lobby'; unguarded, `layer.textContent=''`
    // tore down and rebuilt the whole panel ~60x/second. That did two things:
    // it burned CPU redrawing a static panel (a 12s capture held 243,765
    // RunTasks), and — far worse — it made the START button UNCLICKABLE, because
    // a real mouse click needs mousedown and mouseup to land on the SAME
    // element and the button was replaced between them. Synthetic `el.click()`
    // dispatches straight at the node, so automated tests never saw it; only a
    // human pressing the button did.
    // `showIntermission` and `showSpectating` already guard this way.
    const sig = `${canStart ? 1 : 0}|${seated.map((s) => `${s.id}:${s.name}:${s.status}`).join(',')}`;
    if (sig === this.lobbySig && layer.firstChild !== null) return;
    this.lobbySig = sig;

    layer.textContent = '';

    const panel = el('div', 'op-panel op-lobby-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Outpost lobby');

    panel.appendChild(el('div', 'op-eyebrow', 'LOBBY — NOBODY HAS STARTED THE RUN'));
    panel.appendChild(el('h1', 'op-lobby-title', 'THE FENCE IS QUIET. FOR NOW.'));
    panel.appendChild(
      el(
        'p',
        'op-lobby-pitch',
        'When someone presses START, an 8-second lull gives the squad time to get oriented — ' +
          'then the dead start walking out of the treeline. Hold the fence. Repair what breaks. ' +
          'Revive who goes down. The run always ends in defeat; how far you get is the whole game.',
      ),
    );
    panel.appendChild(el('div', 'op-rule'));

    const rosterHead = el('div', 'op-roster-head');
    rosterHead.appendChild(el('h2', 'op-sec-title', 'SEATED'));
    rosterHead.appendChild(el('span', 'op-roster-count', `${seated.length} / ${MAX_PLAYERS}`));
    panel.appendChild(rosterHead);

    const roster = el('div', 'op-roster');
    if (seated.length === 0) {
      roster.appendChild(el('div', 'op-roster-empty', 'Waiting for survivors…'));
    }
    for (const p of seated) {
      const row = el('div', 'op-roster-row');
      const dot = el('span', p.connected ? 'op-dot op-dot-on' : 'op-dot op-dot-off');
      dot.title = p.connected ? 'connected' : 'disconnected — seat held';
      row.appendChild(dot);
      row.appendChild(el('span', 'op-roster-name', p.name));
      if (!p.connected) row.appendChild(el('span', 'op-roster-tag', 'RECONNECTING'));
      roster.appendChild(row);
    }
    panel.appendChild(roster);

    const start = el('button', 'op-btn op-btn-primary op-wide op-start-btn', 'START');
    start.type = 'button';
    start.disabled = !canStart;
    start.addEventListener('click', () => this.cb.onStart());
    panel.appendChild(start);

    if (!canStart) {
      const need = Math.max(0, MIN_PLAYERS - seated.length);
      panel.appendChild(
        el(
          'div',
          'op-lobby-note',
          need > 0
            ? `Need at least ${MIN_PLAYERS} survivor${MIN_PLAYERS === 1 ? '' : 's'} seated to start.`
            : 'The outpost isn’t ready to start yet.',
        ),
      );
    } else {
      panel.appendChild(
        el('div', 'op-lobby-note', 'Anyone seated can press START — the room never starts on its own.'),
      );
    }

    layer.appendChild(panel);
  }

  // ============================================================================
  // INTERMISSION (non-modal, corner banner — the loop is taught here)
  // ============================================================================
  showIntermission(secondsLeft: number, wave: number): void {
    const sig = `${wave}`;
    if (sig !== this.interSig || this.interWaveEl === null || this.interClockEl === null) {
      this.interSig = sig;
      const layer = this.layers.intermission;
      layer.textContent = '';
      const panel = el('div', 'op-inter');
      panel.setAttribute('role', 'status');
      panel.appendChild(el('div', 'op-eyebrow', `WAVE ${wave} CLEARED`));
      const clockRow = el('div', 'op-inter-clockrow');
      clockRow.appendChild(el('span', 'op-inter-clocklabel', 'NEXT WAVE IN'));
      const clock = el('span', 'op-inter-clock', fmtClock(secondsLeft));
      clockRow.appendChild(clock);
      panel.appendChild(clockRow);
      this.interClockEl = clock;

      const list = el('div', 'op-inter-todo');
      const items: ReadonlyArray<readonly [string, string]> = [
        ['REPAIR', 'damaged fence segments — hold E at the wall'],
        ['RESTOCK', 'ammo at the ground-floor crate'],
        ['BUY', 'a better gun at the deck-1 rack'],
      ];
      for (const [verb, rest] of items) {
        const row = el('div', 'op-inter-item');
        row.appendChild(el('span', 'op-inter-verb', verb));
        row.appendChild(el('span', '', rest));
        list.appendChild(row);
      }
      panel.appendChild(list);
      layer.appendChild(panel);
      // keep a stable handle so the wave label doesn't need rebuilding either
      this.interWaveEl = panel.firstElementChild as HTMLElement | null;
    } else if (this.interClockEl !== null) {
      setText(this.interClockEl, fmtClock(secondsLeft));
    }
    this.show('intermission');
  }

  hideIntermission(): void {
    this.hide('intermission');
    this.interSig = '';
    this.interWaveEl = null;
    this.interClockEl = null;
  }

  // ============================================================================
  // WEAPON RACK (modal)
  // ============================================================================
  showWeaponRack(scrap: number, owned: readonly WeaponId[]): void {
    this.showExclusive('weaponRack');
    const layer = this.layers.weaponRack;

    // Guarded for the same reason as showLobby: the integrator calls this EVERY
    // FRAME while you stand at the rack, and an unguarded rebuild replaced the
    // CLOSE button between mousedown and mouseup, so the dialog could never be
    // dismissed by a real mouse. Scrap only changes on a kill or a purchase, so
    // in practice this rebuilds a handful of times instead of ~60x/second.
    const sig = `${scrap}|${owned.join(',')}`;
    if (sig === this.rackSig && layer.firstChild !== null) return;
    this.rackSig = sig;

    layer.textContent = '';

    const panel = el('div', 'op-panel op-shop-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Weapon rack');

    const head = el('div', 'op-shop-head');
    const headL = el('div', '');
    headL.appendChild(el('div', 'op-eyebrow', 'DECK 1'));
    headL.appendChild(el('h2', 'op-shop-title', 'WEAPON RACK'));
    head.appendChild(headL);
    const wallet = el('div', 'op-wallet');
    wallet.appendChild(el('div', 'op-wallet-label', 'SCRAP'));
    wallet.appendChild(el('div', 'op-scrap', `${scrap}`));
    head.appendChild(wallet);
    const close = el('button', 'op-btn op-btn-small op-shop-close', 'CLOSE');
    close.type = 'button';
    close.addEventListener('click', () => this.hide('weaponRack'));
    head.appendChild(close);
    panel.appendChild(head);

    const ownedFirearms = owned.filter((w) => w !== 'knife' && w !== 'pistol');
    panel.appendChild(
      this.buildShopSecHead(
        'FIREARMS',
        `${ownedFirearms.length}/${SURVIVOR.firearmSlots} SLOTS FILLED`,
      ),
    );
    const grid = el('div', 'op-shop-grid');
    SHOP_WEAPONS.forEach((id, i) => {
      grid.appendChild(this.buildWeaponCard(id, scrap, owned.includes(id), ownedFirearms.length, i));
    });

    // MAKE THE HOTKEYS REAL. The rack is used while pointer-locked, so there is
    // no cursor to click a card with; digits are the only workable input. 1..N
    // buy, E or Escape closes. Re-installed on each rebuild and torn down by
    // hideAll(), so it can never outlive the panel.
    this.installRackKeys(SHOP_WEAPONS);
    panel.appendChild(grid);

    panel.appendChild(this.buildShopSecHead('ISSUED', 'ALWAYS CARRIED'));
    const issued = el('div', 'op-issued');
    for (const id of ISSUED_WEAPONS) {
      const chip = el('div', 'op-issued-chip');
      const meta = el('div', 'op-issued-meta');
      meta.appendChild(el('span', 'op-issued-name', WEAPONS[id].name));
      meta.appendChild(el('span', 'op-issued-role', WEAPON_ROLE[id]));
      chip.appendChild(meta);
      chip.appendChild(el('span', 'op-issued-tag', 'FREE'));
      issued.appendChild(chip);
    }
    panel.appendChild(issued);

    panel.appendChild(hintRow([['1-4', 'to buy'], ['E', 'or step away to close']]));
    layer.appendChild(panel);
  }

  /** Digits buy; E/Escape closes. Idempotent — replaces any previous handler. */
  private installRackKeys(items: readonly WeaponId[]): void {
    this.removeRackKeys();
    const onKey = (e: KeyboardEvent): void => {
      if (this.layers.weaponRack.style.display === 'none') return;
      if (e.code === 'Escape' || e.code === 'KeyE') {
        this.hide('weaponRack');
        this.rackSig = '';
        this.removeRackKeys();
        return;
      }
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m === null) return;
      const idx = Number(m[1]) - 1;
      const id = items[idx];
      if (id === undefined) return;
      e.preventDefault();
      this.cb.onBuyWeapon(id);
    };
    this.rackKeyHandler = onKey;
    document.addEventListener('keydown', onKey);
  }

  private removeRackKeys(): void {
    if (this.rackKeyHandler !== null) {
      document.removeEventListener('keydown', this.rackKeyHandler);
      this.rackKeyHandler = null;
    }
  }

  private buildShopSecHead(label: string, caption: string): HTMLElement {
    const head = el('div', 'op-shop-sechead');
    head.appendChild(el('span', 'op-shop-seclabel', label));
    head.appendChild(el('span', 'op-shop-secrule'));
    head.appendChild(el('span', 'op-shop-seccap', caption));
    return head;
  }

  private buildWeaponCard(
    id: WeaponId,
    scrap: number,
    isOwned: boolean,
    ownedFirearmCount: number,
    hotkeyIndex: number,
  ): HTMLElement {
    const def = WEAPONS[id];
    const price = ECONOMY.weaponPrice[id];
    const affordable = scrap >= price;
    const slotsFull = !isOwned && ownedFirearmCount >= SURVIVOR.firearmSlots;
    const state: BuyState = isOwned ? 'own' : slotsFull ? 'full' : !affordable ? 'poor' : 'ok';
    const off = !isOwned && state !== 'ok';

    const card = el('button', `op-card op-st-${state}`);
    card.type = 'button';
    if (isOwned) card.classList.add('op-owned');
    if (off) card.classList.add('op-off');

    // A DIGIT, not the name's first letter. The letter was decorative AND
    // ambiguous ("AK-4 Rifle" and "AWM Sniper" both rendered "A"), and nothing
    // listened for it — the rack could only be bought from with a mouse the
    // game does not give you, because pointer lock is held during play.
    const badge = el('div', 'op-card-badge', String(hotkeyIndex + 1));
    card.appendChild(badge);

    const top = el('div', 'op-card-top');
    top.appendChild(el('span', 'op-card-name', def.name));
    top.appendChild(
      el('span', state === 'poor' ? 'op-card-price op-price-over' : 'op-card-price', `${price} SCRAP`),
    );
    card.appendChild(top);

    const meters = el('div', 'op-meters');
    const burst = def.damage * def.pellets;
    const rpm = 60 / def.interval;
    const dmg = def.pellets > 1 ? `${def.damage}×${def.pellets}` : `${def.damage}`;
    meters.appendChild(meter('DMG', dmg, burst / MAX_SHOP_DMG));
    meters.appendChild(meter('RPM', `${Math.round(rpm)}`, rpm / MAX_SHOP_RPM));
    meters.appendChild(meter('MAG', `${def.mag}`, def.mag / MAX_SHOP_MAG));
    card.appendChild(meters);

    card.appendChild(el('div', 'op-card-role', WEAPON_ROLE[id]));
    card.appendChild(buyFooter(state, state === 'poor' ? price - scrap : scrap - price));

    card.addEventListener('click', () => {
      if (isOwned || off) return;
      this.cb.onBuyWeapon(id); // menu stays open; caller re-shows with updated scrap/owned
    });
    return card;
  }

  // ============================================================================
  // AMMO CRATE (modal)
  // ============================================================================
  showAmmoCrate(scrap: number, cost: number): void {
    this.showExclusive('ammoCrate');
    const layer = this.layers.ammoCrate;

    // Same guard. (The crate no longer opens on proximity — the HUD prompt
    // handles it — but leaving this unguarded would re-arm the identical
    // unclickable-dialog bug the moment anything calls it on the frame path.)
    const sig = `${scrap}|${cost}`;
    if (sig === this.crateSig && layer.firstChild !== null) return;
    this.crateSig = sig;

    layer.textContent = '';

    const panel = el('div', 'op-panel op-shop-panel op-crate-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Ammo crate');

    const head = el('div', 'op-shop-head');
    const headL = el('div', '');
    headL.appendChild(el('div', 'op-eyebrow', 'GROUND FLOOR'));
    headL.appendChild(el('h2', 'op-shop-title', 'AMMO CRATE'));
    head.appendChild(headL);
    const wallet = el('div', 'op-wallet');
    wallet.appendChild(el('div', 'op-wallet-label', 'SCRAP'));
    wallet.appendChild(el('div', 'op-scrap', `${scrap}`));
    head.appendChild(wallet);
    const close = el('button', 'op-btn op-btn-small op-shop-close', 'CLOSE');
    close.type = 'button';
    close.addEventListener('click', () => this.hide('ammoCrate'));
    head.appendChild(close);
    panel.appendChild(head);

    const affordable = scrap >= cost;
    const card = el('button', `op-crate-card ${affordable ? 'op-st-ok' : 'op-st-poor'}`);
    card.type = 'button';
    if (!affordable) card.classList.add('op-off');
    card.appendChild(el('div', 'op-card-badge', 'A'));
    const body = el('div', 'op-crate-body');
    body.appendChild(el('div', 'op-crate-name', 'FULL RESTOCK'));
    body.appendChild(el('div', 'op-crate-desc', 'Refills every owned weapon’s reserve ammo to full.'));
    body.appendChild(
      el('div', affordable ? 'op-card-price' : 'op-card-price op-price-over', `${cost} SCRAP`),
    );
    body.appendChild(buyFooter(affordable ? 'ok' : 'poor', affordable ? scrap - cost : cost - scrap));
    card.appendChild(body);
    card.addEventListener('click', () => {
      if (!affordable) return;
      this.cb.onBuyAmmo();
    });
    panel.appendChild(card);

    panel.appendChild(hintRow([['E', 'or step away to close']]));
    layer.appendChild(panel);
  }

  // ============================================================================
  // PAUSE
  // ============================================================================
  private buildPause(): void {
    const panel = el('div', 'op-panel op-pause-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Paused');
    panel.appendChild(el('div', 'op-eyebrow', 'OUTPOST'));
    panel.appendChild(el('h2', 'op-pause-title', 'PAUSED'));
    panel.appendChild(
      el('div', 'op-pause-note', 'This screen only. Your squad and the horde keep fighting.'),
    );
    panel.appendChild(el('div', 'op-rule'));

    const resume = el('button', 'op-btn op-btn-primary op-wide', 'RESUME');
    resume.type = 'button';
    resume.addEventListener('click', () => {
      this.hide('pause');
      this.cb.onResume();
    });
    panel.appendChild(resume);

    const leave = el('button', 'op-btn op-btn-danger op-wide', 'LEAVE OUTPOST');
    leave.type = 'button';
    leave.addEventListener('click', () => {
      this.hide('pause');
      this.cb.onLeave();
    });
    panel.appendChild(leave);

    this.layers.pause.appendChild(panel);
  }

  showPause(): void {
    this.showExclusive('pause');
  }

  // ============================================================================
  // SPECTATING (dead, run continuing)
  // ============================================================================
  showSpectating(returnAtWave: number): void {
    if (this.specWaveEl === null || this.specSig === '') {
      const layer = this.layers.spectating;
      layer.textContent = '';
      const panel = el('div', 'op-spec-panel');
      panel.setAttribute('role', 'status');
      panel.appendChild(el('div', 'op-eyebrow', 'YOU ARE DOWN FOR THE COUNT'));
      panel.appendChild(el('h2', 'op-spec-title', 'SPECTATING'));
      panel.appendChild(
        el('p', 'op-spec-body', 'The squad fights on without you. Watch the fence — you’ll be back.'),
      );
      const ret = el('div', 'op-spec-return');
      ret.appendChild(el('span', 'op-spec-returnlabel', 'RETURNING AT WAVE'));
      const waveEl = el('span', 'op-spec-wave', `${returnAtWave}`);
      ret.appendChild(waveEl);
      panel.appendChild(ret);
      layer.appendChild(panel);
      this.specWaveEl = waveEl;
      this.specSig = 'built';
    } else {
      setText(this.specWaveEl, `${returnAtWave}`);
    }
    this.showExclusive('spectating');
  }

  // ============================================================================
  // RUN END — no win screen; a scoreboard of a good fight.
  // ============================================================================
  showRunEnd(info: { wave: number; stats: readonly RunStats[] } | null): void {
    if (info === null) {
      this.hide('runEnd');
      this.runEndSig = '';
      return;
    }
    const sig = `${info.wave}|${info.stats.map((r) => `${r.id}:${r.kills}:${r.revivesGiven}`).join(',')}`;
    if (sig === this.runEndSig && this.layers.runEnd.firstChild !== null) {
      this.showExclusive('runEnd');
      return;
    }
    this.runEndSig = sig;
    this.showExclusive('runEnd');
    const layer = this.layers.runEnd;
    layer.textContent = '';

    const panel = el('div', 'op-panel op-end-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Run ended');

    panel.appendChild(el('div', 'op-eyebrow', 'RUN ENDED'));
    panel.appendChild(el('h1', 'op-end-title', 'THE FENCE DID NOT HOLD'));
    panel.appendChild(
      el(
        'div',
        'op-end-sub',
        `Wave ${info.wave} reached — ${info.stats.length} survivor${info.stats.length === 1 ? '' : 's'} fought.`,
      ),
    );

    const mvps = el('div', 'op-mvp-row');
    mvps.appendChild(this.buildMvp('TOP KILLER', info.stats, (s) => s.kills, 'KILLS'));
    mvps.appendChild(this.buildMvp('TOP MEDIC', info.stats, (s) => s.revivesGiven, 'REVIVES'));
    mvps.appendChild(this.buildMvp('TOP ENGINEER', info.stats, (s) => s.repairHp, 'HP REPAIRED'));
    panel.appendChild(mvps);

    const table = el('div', 'op-end-table');
    const head = el('div', 'op-end-row op-end-head');
    for (const label of ['SURVIVOR', 'KILLS', 'HS', 'DAMAGE', 'REPAIR HP', 'REVIVES', 'DOWNED']) {
      head.appendChild(el('span', 'op-end-cell', label));
    }
    table.appendChild(head);

    if (info.stats.length === 0) {
      table.appendChild(el('div', 'op-end-empty', 'No survivors were recorded.'));
    }
    const sorted = [...info.stats].sort(
      (a, b) => b.kills + b.revivesGiven * 3 + Math.round(b.repairHp / 10) -
        (a.kills + a.revivesGiven * 3 + Math.round(a.repairHp / 10)),
    );
    for (const s of sorted) {
      const row = el('div', 'op-end-row');
      row.appendChild(el('span', 'op-end-cell op-end-name', s.name));
      row.appendChild(el('span', 'op-end-cell op-end-num', `${s.kills}`));
      row.appendChild(el('span', 'op-end-cell op-end-num', `${s.headshots}`));
      row.appendChild(el('span', 'op-end-cell op-end-num', `${Math.round(s.damage)}`));
      row.appendChild(el('span', 'op-end-cell op-end-num op-end-repair', `${Math.round(s.repairHp)}`));
      row.appendChild(el('span', 'op-end-cell op-end-num op-end-revive', `${s.revivesGiven}`));
      row.appendChild(el('span', 'op-end-cell op-end-num', `${s.timesDowned}`));
      table.appendChild(row);
    }
    panel.appendChild(table);

    const leave = el('button', 'op-btn op-btn-primary op-wide', 'LEAVE OUTPOST');
    leave.type = 'button';
    leave.addEventListener('click', () => this.cb.onLeave());
    panel.appendChild(leave);

    layer.appendChild(panel);
  }

  private buildMvp(
    label: string,
    stats: readonly RunStats[],
    pick: (s: RunStats) => number,
    unit: string,
  ): HTMLElement {
    const card = el('div', 'op-mvp');
    card.appendChild(el('div', 'op-mvp-label', label));
    let best: RunStats | null = null;
    let bestVal = -1;
    for (const s of stats) {
      const v = pick(s);
      if (v > bestVal) {
        bestVal = v;
        best = s;
      }
    }
    if (best === null || bestVal <= 0) {
      card.appendChild(el('div', 'op-mvp-name', '—'));
      card.appendChild(el('div', 'op-mvp-val', `no ${unit.toLowerCase()}`));
    } else {
      card.appendChild(el('div', 'op-mvp-name', best.name));
      const val = el('div', 'op-mvp-val');
      val.appendChild(el('span', 'op-mvp-num', `${bestVal}`));
      val.appendChild(el('span', 'op-mvp-unit', ` ${unit}`));
      card.appendChild(val);
    }
    return card;
  }

  // ============================================================================
  // FIRST-RUN ONBOARDING (fires once ever, per localStorage)
  // ============================================================================
  showOnboarding(): void {
    if (this.readOnce(ONBOARD_KEY)) return;
    const layer = this.layers.onboarding;
    layer.textContent = '';

    const panel = el('div', 'op-onboard');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Welcome to OUTPOST');
    panel.appendChild(el('div', 'op-eyebrow', 'FIRST TIME ON THE WALL'));
    panel.appendChild(
      el(
        'p',
        'op-onboard-body',
        'You are on the tower. They come from the trees. Hold the fence, repair it, ' +
          'pick your people up. Nobody wins — you just last.',
      ),
    );
    panel.appendChild(
      hintRow([
        ['WASD', 'move'],
        ['LMB', 'fire'],
        ['Hold E', 'interact'],
        ['Tab', 'squad'],
      ]),
    );
    const dismiss = el('button', 'op-btn op-btn-primary op-wide', 'GOT IT');
    const close = (): void => {
      this.hide('onboarding');
      this.writeOnce(ONBOARD_KEY);
      if (this.onboardKeyHandler !== null) {
        document.removeEventListener('keydown', this.onboardKeyHandler);
        this.onboardKeyHandler = null;
      }
    };
    dismiss.type = 'button';
    dismiss.addEventListener('click', close);
    panel.appendChild(dismiss);

    layer.appendChild(panel);
    this.show('onboarding');

    // Keyboard-lit games keep the pointer locked, so a mouse click may never
    // reach the button — any keypress dismisses too. One-shot listener.
    this.onboardKeyHandler = (): void => close();
    document.addEventListener('keydown', this.onboardKeyHandler);
  }

  // ============================================================================
  // ONE-TIME CONTEXTUAL HINTS (non-modal toast, once ever per key)
  // ============================================================================
  hint(key: HintKey, text: string): void {
    const storeKey = hintStorageKey(key);
    if (this.readOnce(storeKey)) return;
    this.writeOnce(storeKey);

    const layer = this.layers.hint;
    layer.textContent = '';
    const toast = el('div', 'op-hint-toast');
    toast.setAttribute('role', 'status');
    toast.appendChild(el('span', 'op-hint-glyph', 'ℹ'));
    toast.appendChild(el('span', 'op-hint-text', text));
    layer.appendChild(toast);
    this.show('hint');

    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hide('hint'), HINT_MS);
  }

  private readOnce(key: string): boolean {
    try {
      return window.localStorage.getItem(key) !== null;
    } catch {
      return false; // storage unavailable (private mode etc.) — show every time rather than crash
    }
  }

  private writeOnce(key: string): void {
    try {
      window.localStorage.setItem(key, '1');
    } catch {
      // storage unavailable — the hint simply reappears next session, not fatal
    }
  }

  // ============================================================================
  // Cross-cutting
  // ============================================================================
  modalOpen(): boolean {
    for (const id of MODALS) if (this.isShown(id)) return true;
    return false;
  }

  overlayCount(): number {
    let n = 0;
    for (const id of MODALS) if (this.isShown(id)) n++;
    return n;
  }

  hideAll(): void {
    for (const id of Object.keys(this.layers) as LayerId[]) this.hide(id);
    this.removeRackKeys();
    this.mainSig = '';
    this.chipSig = '';
    this.runEndSig = '';
    this.lobbySig = ''; // so re-entering these rebuilds them
    this.rackSig = '';
    this.crateSig = '';
    this.interSig = '';
    this.interWaveEl = null;
    this.interClockEl = null;
    this.specSig = '';
    this.specWaveEl = null;
    window.clearTimeout(this.hintTimer);
    if (this.onboardKeyHandler !== null) {
      document.removeEventListener('keydown', this.onboardKeyHandler);
      this.onboardKeyHandler = null;
    }
  }
}

// ============================================================================
// STYLE
// ============================================================================
const CSS = `
.op-menus {
  position: absolute; inset: 0;
  font-family: 'Bahnschrift', 'Segoe UI', system-ui, -apple-system, sans-serif;
  color: var(--op-hudText);
  -webkit-font-smoothing: antialiased;
  /* The root menu container spans the whole viewport. Without this it defaults
     to pointer-events:auto and swallows EVERY click before it reaches the
     canvas — so the canvas can never acquire pointer lock, the mouse never
     attaches, and because lock never engages the input controller never owns
     the keyboard either (keys appear stuck). op-layer was already none and
     op-modal re-enables per panel; the root was simply missed. */
  pointer-events: none;
}
/* Anything the player actually clicks re-enables itself. */
.op-panel, .op-onboard, .op-hint, button { pointer-events: auto; }
.op-layer {
  position: absolute; inset: 0;
  display: none; align-items: center; justify-content: center;
  pointer-events: none;
}
.op-modal { pointer-events: auto; }
.op-layer-main, .op-layer-lobby, .op-layer-runEnd {
  background:
    radial-gradient(ellipse at 50% 40%, transparent 30%, rgba(var(--op-ink-rgb),.88) 100%),
    radial-gradient(140% 100% at 50% -8%, rgba(var(--op-duskFog-rgb),.35) 0%, rgba(var(--op-ink-rgb),.9) 60%);
  overflow-y: auto; padding: 32px 16px;
}
.op-layer-joining, .op-layer-pause, .op-layer-weaponRack, .op-layer-ammoCrate,
.op-layer-spectating, .op-layer-onboarding {
  background: radial-gradient(ellipse at 50% 44%, rgba(var(--op-ink-rgb),.55) 0%, rgba(var(--op-ink-rgb),.9) 100%);
  overflow-y: auto; padding: 24px 16px;
}
.op-passthrough { pointer-events: none; }
.op-passthrough > * { pointer-events: auto; }

.op-panel {
  background: linear-gradient(180deg, rgba(var(--op-charcoal-rgb),.97), rgba(var(--op-ink-rgb),.98));
  border: 1px solid rgba(var(--op-scrapGold-rgb),.22);
  border-radius: 10px;
  padding: 26px 30px 30px;
  box-shadow: 0 24px 70px rgba(0,0,0,.55);
  width: 100%;
  box-sizing: border-box;
}
.op-main-panel, .op-lobby-panel, .op-end-panel { max-width: 720px; }
.op-shop-panel { max-width: 620px; }
.op-pause-panel, .op-spec-panel, .op-onboard { max-width: 380px; }

.op-eyebrow {
  font-size: 11px; letter-spacing: .16em; font-weight: 700;
  color: var(--op-scrapGold); text-transform: uppercase; margin-bottom: 6px;
}
.op-title {
  margin: 0 0 6px; font-size: 44px; font-weight: 800; letter-spacing: .06em;
  color: var(--op-hudText);
}
.op-tagline { font-size: 14px; color: rgba(var(--op-hudText-rgb),.75); max-width: 46ch; line-height: 1.5; }
.op-hero-meta { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.op-hero-metaitem {
  font-size: 11px; letter-spacing: .06em; font-weight: 700; padding: 4px 9px;
  border: 1px solid rgba(var(--op-hudAccent-rgb),.35); border-radius: 4px; color: var(--op-hudAccent);
}
.op-rule { height: 1px; background: rgba(var(--op-hudText-rgb),.14); margin: 18px 0; }

.op-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.op-label { font-size: 11px; letter-spacing: .1em; font-weight: 700; color: rgba(var(--op-hudText-rgb),.6); }
.op-input {
  background: rgba(0,0,0,.35); border: 1px solid rgba(var(--op-hudText-rgb),.22); border-radius: 6px;
  color: var(--op-hudText); font-size: 15px; padding: 10px 12px; font-family: inherit;
  outline: none;
}
.op-input:focus { border-color: var(--op-scrapGold); }
.op-code { text-transform: uppercase; letter-spacing: .3em; text-align: center; font-weight: 700; }

.op-errbox {
  display: flex; gap: 12px; align-items: flex-start;
  background: rgba(var(--op-danger-rgb),.14); border: 1px solid rgba(var(--op-danger-rgb),.5);
  border-radius: 8px; padding: 14px 16px; margin-bottom: 18px;
}
.op-errglyph { font-size: 22px; color: var(--op-danger); line-height: 1; }
.op-erreyebrow { font-size: 11px; letter-spacing: .1em; font-weight: 700; color: var(--op-danger); }
.op-errtext { font-size: 14px; margin: 4px 0; color: var(--op-hudText); }
.op-errway { font-size: 12px; color: rgba(var(--op-hudText-rgb),.65); }

.op-btn {
  font-family: inherit; font-size: 13px; font-weight: 700; letter-spacing: .06em;
  padding: 11px 18px; border-radius: 6px; border: 1px solid rgba(var(--op-hudText-rgb),.2);
  background: rgba(var(--op-hudText-rgb),.06); color: var(--op-hudText); cursor: pointer;
}
.op-btn:hover:not(:disabled) { background: rgba(var(--op-hudText-rgb),.14); }
.op-btn:disabled { opacity: .4; cursor: not-allowed; }
.op-btn-primary { background: var(--op-scrapGold); border-color: var(--op-scrapGold); color: var(--op-ink); }
.op-btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
.op-btn-danger { background: rgba(var(--op-danger-rgb),.16); border-color: rgba(var(--op-danger-rgb),.6); color: var(--op-danger); }
.op-btn-danger:hover:not(:disabled) { background: rgba(var(--op-danger-rgb),.28); }
.op-btn-small { padding: 6px 11px; font-size: 11px; }
.op-wide { width: 100%; margin-top: 8px; }

.op-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; margin: 20px 0 8px; }
.op-sec-title { font-size: 13px; letter-spacing: .1em; margin: 0 0 4px; color: var(--op-hudText); }
.op-sec-caption { font-size: 12px; color: rgba(var(--op-hudText-rgb),.6); margin-bottom: 10px; }
.op-create-actions { display: flex; flex-direction: column; gap: 8px; }
.op-join-note { font-size: 11px; color: rgba(var(--op-hudText-rgb),.55); margin-top: 8px; }

.op-rooms-sec { margin-top: 10px; }
.op-rooms-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.op-room-list { display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow-y: auto; }
.op-room-empty { font-size: 12px; color: rgba(var(--op-hudText-rgb),.5); padding: 10px 0; }
.op-room-row {
  display: grid; grid-template-columns: 1fr auto auto; gap: 14px; align-items: center;
  background: rgba(var(--op-hudText-rgb),.05); border: 1px solid rgba(var(--op-hudText-rgb),.12);
  border-radius: 6px; padding: 8px 12px; cursor: pointer; font-family: inherit; color: var(--op-hudText);
  text-align: left;
}
.op-room-row:hover { border-color: var(--op-scrapGold); }
.op-room-label { font-size: 12px; font-weight: 700; }
.op-room-players { display: flex; align-items: center; gap: 8px; }
.op-cap-track { width: 60px; height: 5px; border-radius: 3px; background: rgba(0,0,0,.4); overflow: hidden; }
.op-cap-fill { display: block; height: 100%; background: var(--op-hpGreen); }
.op-cap-fill.op-cap-full { background: var(--op-danger); }
.op-cap-num { font-size: 11px; color: rgba(var(--op-hudText-rgb),.7); }
.op-room-phase { display: flex; align-items: center; gap: 6px; font-size: 10px; letter-spacing: .06em; }
.op-phase-dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(var(--op-hudText-rgb),.4); }
.op-phase-live { background: var(--op-danger); }
.op-phase-buy { background: var(--op-scrapGold); }
.op-phase-over { background: rgba(var(--op-hudText-rgb),.3); }

.op-controls { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 16px; margin-top: 10px; }
.op-ctl { display: flex; align-items: center; gap: 8px; font-size: 11px; color: rgba(var(--op-hudText-rgb),.75); }
.op-kbd {
  font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px;
  border: 1px solid rgba(var(--op-hudText-rgb),.3); background: rgba(0,0,0,.3); white-space: nowrap;
}
.op-hintrow { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin-top: 14px; font-size: 11px; color: rgba(var(--op-hudText-rgb),.6); }

/* ---- lobby ---- */
.op-lobby-title { font-size: 24px; margin: 0 0 10px; font-weight: 800; }
.op-lobby-pitch { font-size: 13px; line-height: 1.6; color: rgba(var(--op-hudText-rgb),.78); max-width: 62ch; }
.op-roster-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
.op-roster-count { font-size: 12px; color: rgba(var(--op-hudText-rgb),.6); }
.op-roster { display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow-y: auto; margin-bottom: 16px; }
.op-roster-empty { font-size: 12px; color: rgba(var(--op-hudText-rgb),.5); padding: 8px 0; }
.op-roster-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 6px;
  background: rgba(var(--op-hudText-rgb),.04); border: 1px solid rgba(var(--op-hudText-rgb),.1);
}
.op-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.op-dot-on { background: var(--op-hpGreen); }
.op-dot-off { background: var(--op-danger); }
.op-roster-name { font-size: 13px; font-weight: 600; flex: 1; }
.op-roster-tag {
  font-size: 10px; letter-spacing: .06em; padding: 2px 7px; border-radius: 4px;
  background: rgba(var(--op-danger-rgb),.2); color: var(--op-danger);
}
.op-start-btn { font-size: 16px; padding: 14px 18px; margin-top: 6px; }
.op-lobby-note { font-size: 11px; color: rgba(var(--op-hudText-rgb),.55); margin-top: 8px; text-align: center; }

/* ---- chip ---- */
.op-layer-chip { justify-content: flex-start; align-items: flex-start; padding: 16px; }
.op-chip {
  display: flex; align-items: center; gap: 8px;
  background: rgba(var(--op-charcoal-rgb),.85); border: 1px solid rgba(var(--op-hudText-rgb),.18);
  border-radius: 7px; padding: 7px 12px; font-size: 11px;
}
.op-chip-label { font-weight: 700; letter-spacing: .08em; color: var(--op-scrapGold); }
.op-chip-sep { width: 1px; height: 14px; background: rgba(var(--op-hudText-rgb),.2); }
.op-chip-cap { color: rgba(var(--op-hudText-rgb),.55); }
.op-chip-code { font-weight: 700; letter-spacing: .16em; }

/* ---- intermission ---- */
.op-layer-intermission { justify-content: center; align-items: flex-start; padding-top: 18px; }
.op-inter {
  background: rgba(var(--op-charcoal-rgb),.92); border: 1px solid rgba(var(--op-scrapGold-rgb),.35);
  border-radius: 9px; padding: 14px 20px; min-width: 300px; text-align: center;
  box-shadow: 0 12px 34px rgba(0,0,0,.4);
}
.op-inter-clockrow { display: flex; align-items: baseline; justify-content: center; gap: 8px; margin: 4px 0 10px; }
.op-inter-clocklabel { font-size: 10px; letter-spacing: .1em; color: rgba(var(--op-hudText-rgb),.6); }
.op-inter-clock { font-size: 26px; font-weight: 800; color: var(--op-scrapGold); }
.op-inter-todo { display: flex; flex-direction: column; gap: 4px; text-align: left; }
.op-inter-item { font-size: 11px; color: rgba(var(--op-hudText-rgb),.8); display: flex; gap: 6px; }
.op-inter-verb { font-weight: 700; color: var(--op-hudAccent); min-width: 62px; }

/* ---- shop (weapon rack / ammo crate) ---- */
.op-shop-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 16px; }
.op-shop-title { margin: 0; font-size: 22px; font-weight: 800; }
.op-wallet { text-align: right; }
.op-wallet-label { font-size: 10px; letter-spacing: .1em; color: rgba(var(--op-hudText-rgb),.6); }
.op-scrap { font-size: 20px; font-weight: 800; color: var(--op-scrapGold); }
.op-shop-close { align-self: flex-start; }

.op-shop-sechead { display: flex; align-items: center; gap: 10px; margin: 14px 0 8px; }
.op-shop-seclabel { font-size: 11px; letter-spacing: .1em; font-weight: 700; color: rgba(var(--op-hudText-rgb),.7); white-space: nowrap; }
.op-shop-secrule { flex: 1; height: 1px; background: rgba(var(--op-hudText-rgb),.14); }
.op-shop-seccap { font-size: 10px; color: rgba(var(--op-hudText-rgb),.45); white-space: nowrap; }

.op-shop-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.op-card {
  text-align: left; font-family: inherit; color: var(--op-hudText); cursor: pointer;
  background: rgba(var(--op-hudText-rgb),.045); border: 1px solid rgba(var(--op-hudText-rgb),.14);
  border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; position: relative;
}
.op-card:hover:not(.op-off) { border-color: var(--op-scrapGold); }
.op-card.op-owned { border-color: var(--op-hpGreen); background: rgba(var(--op-hpGreen-rgb),.08); }
.op-card.op-off { opacity: .55; cursor: not-allowed; }
.op-card-badge {
  position: absolute; top: 10px; right: 10px; width: 24px; height: 24px; border-radius: 5px;
  background: rgba(var(--op-hudAccent-rgb),.18); border: 1px solid rgba(var(--op-hudAccent-rgb),.4);
  color: var(--op-hudAccent); font-weight: 800; font-size: 12px; display: flex; align-items: center; justify-content: center;
}
.op-card-top { display: flex; justify-content: space-between; align-items: baseline; padding-right: 30px; }
.op-card-name { font-size: 13px; font-weight: 700; }
.op-card-price { font-size: 12px; font-weight: 700; color: var(--op-scrapGold); }
.op-price-over { color: var(--op-danger); }
.op-meters { display: flex; flex-direction: column; gap: 3px; }
.op-meter { display: grid; grid-template-columns: 30px 1fr 34px; align-items: center; gap: 6px; }
.op-meter-label { font-size: 9px; letter-spacing: .05em; color: rgba(var(--op-hudText-rgb),.5); }
.op-meter-track { height: 4px; border-radius: 2px; background: rgba(0,0,0,.35); overflow: hidden; }
.op-meter-fill { display: block; height: 100%; background: var(--op-hudAccent); }
.op-meter-val { font-size: 10px; text-align: right; color: rgba(var(--op-hudText-rgb),.7); }
.op-card-role { font-size: 10.5px; line-height: 1.4; color: rgba(var(--op-hudText-rgb),.6); }
.op-foot { display: flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 700; letter-spacing: .04em; }
.op-foot-glyph { width: 14px; text-align: center; }
.op-foot-own { color: var(--op-hpGreen); }
.op-foot-ok { color: var(--op-hudAccent); }
.op-foot-bad { color: var(--op-danger); }

.op-issued { display: flex; flex-direction: column; gap: 6px; }
.op-issued-chip {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 8px 12px; border-radius: 6px; background: rgba(var(--op-hudText-rgb),.03);
  border: 1px solid rgba(var(--op-hudText-rgb),.1);
}
.op-issued-meta { display: flex; flex-direction: column; gap: 2px; }
.op-issued-name { font-size: 12px; font-weight: 700; }
.op-issued-role { font-size: 10.5px; color: rgba(var(--op-hudText-rgb),.55); }
.op-issued-tag { font-size: 10px; font-weight: 700; color: var(--op-hpGreen); }

.op-crate-panel { max-width: 420px; }
.op-crate-card {
  display: flex; gap: 14px; align-items: flex-start; text-align: left; cursor: pointer;
  font-family: inherit; color: var(--op-hudText); width: 100%; box-sizing: border-box;
  background: rgba(var(--op-hudText-rgb),.05); border: 1px solid rgba(var(--op-hudText-rgb),.14);
  border-radius: 9px; padding: 16px;
}
.op-crate-card:hover:not(.op-off) { border-color: var(--op-scrapGold); }
.op-crate-card.op-off { opacity: .55; cursor: not-allowed; }
.op-crate-card .op-card-badge { position: static; flex: none; width: 36px; height: 36px; font-size: 16px; }
.op-crate-body { display: flex; flex-direction: column; gap: 6px; flex: 1; }
.op-crate-name { font-size: 14px; font-weight: 800; letter-spacing: .04em; }
.op-crate-desc { font-size: 11.5px; color: rgba(var(--op-hudText-rgb),.65); }

/* ---- pause ---- */
.op-pause-title { margin: 4px 0 8px; font-size: 22px; font-weight: 800; }
.op-pause-note { font-size: 12px; color: rgba(var(--op-hudText-rgb),.6); margin-bottom: 4px; }

/* ---- spectating ---- */
.op-layer-spectating {
  background: radial-gradient(ellipse at 50% 60%, rgba(var(--op-downedRed-rgb),.14) 0%, rgba(var(--op-ink-rgb),.82) 70%);
}
.op-spec-panel {
  background: rgba(var(--op-charcoal-rgb),.9); border: 1px solid rgba(var(--op-downedRed-rgb),.4);
  border-radius: 10px; padding: 24px 26px; text-align: center; max-width: 380px;
  box-shadow: 0 20px 50px rgba(0,0,0,.5);
}
.op-spec-title { font-size: 22px; font-weight: 800; margin: 2px 0 12px; color: var(--op-downedRed); }
.op-spec-body { font-size: 13px; line-height: 1.6; color: rgba(var(--op-hudText-rgb),.75); margin: 0 0 16px; }
.op-spec-return { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.op-spec-returnlabel { font-size: 10px; letter-spacing: .1em; color: rgba(var(--op-hudText-rgb),.55); }
.op-spec-wave { font-size: 28px; font-weight: 800; color: var(--op-reviveCyan); }

/* ---- run end ---- */
.op-end-title { font-size: 30px; margin: 4px 0 8px; font-weight: 800; }
.op-end-sub { font-size: 13px; color: rgba(var(--op-hudText-rgb),.7); margin-bottom: 20px; }
.op-mvp-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 22px; }
.op-mvp {
  background: rgba(var(--op-scrapGold-rgb),.08); border: 1px solid rgba(var(--op-scrapGold-rgb),.3);
  border-radius: 8px; padding: 12px; text-align: center;
}
.op-mvp-label { font-size: 10px; letter-spacing: .1em; font-weight: 700; color: var(--op-scrapGold); margin-bottom: 6px; }
.op-mvp-name { font-size: 14px; font-weight: 700; margin-bottom: 3px; }
.op-mvp-val { font-size: 12px; color: rgba(var(--op-hudText-rgb),.75); }
.op-mvp-num { font-weight: 800; font-size: 15px; color: var(--op-hudText); }
.op-mvp-unit { font-size: 10px; letter-spacing: .04em; }

.op-end-table { display: flex; flex-direction: column; gap: 2px; margin-bottom: 20px; max-height: 260px; overflow-y: auto; }
.op-end-row {
  display: grid; grid-template-columns: 2fr repeat(6, 0.8fr); gap: 6px; align-items: center;
  padding: 7px 10px; border-radius: 5px; font-size: 11.5px;
}
.op-end-row:not(.op-end-head):nth-child(odd) { background: rgba(var(--op-hudText-rgb),.03); }
.op-end-head { font-size: 10px; letter-spacing: .06em; color: rgba(var(--op-hudText-rgb),.5); font-weight: 700; }
.op-end-cell { text-align: right; }
.op-end-cell.op-end-name { text-align: left; font-weight: 700; }
.op-end-num { font-variant-numeric: tabular-nums; }
.op-end-repair { color: var(--op-hpGreen); }
.op-end-revive { color: var(--op-reviveCyan); }
.op-end-empty { font-size: 12px; color: rgba(var(--op-hudText-rgb),.5); padding: 10px 0; }

/* ---- onboarding ---- */
.op-onboard {
  background: rgba(var(--op-charcoal-rgb),.95); border: 1px solid rgba(var(--op-scrapGold-rgb),.4);
  border-radius: 10px; padding: 22px 24px; box-shadow: 0 20px 50px rgba(0,0,0,.55);
}
.op-onboard-body { font-size: 14px; line-height: 1.6; margin: 4px 0 4px; color: var(--op-hudText); }

/* ---- hint toast ---- */
.op-layer-hint { justify-content: center; align-items: flex-end; padding-bottom: 120px; }
.op-hint-toast {
  display: flex; align-items: center; gap: 9px; max-width: 460px;
  background: rgba(var(--op-charcoal-rgb),.92); border: 1px solid rgba(var(--op-hudAccent-rgb),.4);
  border-radius: 8px; padding: 10px 16px; font-size: 12.5px; box-shadow: 0 10px 28px rgba(0,0,0,.4);
}
.op-hint-glyph { color: var(--op-hudAccent); font-size: 15px; flex: none; }
.op-hint-text { line-height: 1.4; }
`;
