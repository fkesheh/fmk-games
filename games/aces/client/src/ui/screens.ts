// ============================================================================
// ACES — C_UI screens.ts. Every match state as a DESIGNED screen (STYLE_BIBLE
// §8): propaganda-poster menu, connecting, lobby countdown + roster, live
// (overlays hidden — the HUD owns in-match chrome), death + requisition-form
// class picker, end-of-patrol scoreboard poster, disconnect notice, and an
// Esc "controls" card that is explicitly NOT a pause (multiplayer sim keeps
// running, CONTRACT §5 C_APP).
//
// SURFACE NOTE (reported to orchestrator): seams.ts's illustrative creator
// comment reads `createScreens(root, hooks)`, but this task's brief pins the
// exact public surface as `createScreens(hooks)` with the DOM self-mounted
// under a #aces-screens root this module creates on document.body. The pinned
// *Screens type block* is reproduced verbatim below; only the root argument
// differs — C_APP must call createScreens(hooks) with no root.
//
// IDENTITY GAP (documented, graceful): neither HudModel nor showEnd()'s
// arguments carry the local player's id/name, so a literal "personal row"
// marker has no authoritative source. This file captures the pilot name the
// app itself hands to showMenu(prefName) and best-effort highlights the
// lobby-roster and end-board rows whose names match it (trim/case-insensitive,
// tagged "(YOU)"). The stored name persists across showLobby/showEnd calls;
// when no name was ever passed (menu skipped by debug/e2e joins) nothing is
// highlighted.
//
// Discipline: layers are built ONCE; every show*() is change-guarded and list
// rebuilds are signature-gated. Colors flow from APAL through PAL / withAlpha /
// mixA / shadeA into custom properties — zero raw hex/rgba literals here (the
// transparent-black/white shadow allowance goes unused; chip shadows derive
// from ink alpha). System font stacks only, all text ≥14 px at 1080p.
//
// Module top-level is DOM-free so headless tests can import the pure helpers;
// all document/window access happens inside createScreens() and its class.
// ============================================================================

import {
  CLASSES,
  END_SECONDS,
  INPUT_KEYS,
  NET,
  PLANE_CLASSES,
  SPAWN_PROTECT_SECONDS,
} from '@aces/shared/config.js';
import type { PlaneClassId, TeamId } from '@aces/shared/config.js';
import type { ScoreRow } from '@aces/shared/types.js';
import {
  INK_STROKE,
  PAL,
  makeRng,
  mixA,
  poly,
  shadeA,
  softPuff,
  star,
  withAlpha,
} from '../contract/visual.js';
import type { JoinKind } from '../contract/seams.js';

// ============================================================================
// PURE display logic — exported, headlessly testable (no DOM at call time).
// ============================================================================

/** End-screen headline derived from the PhaseMsg winner (undefined = draw). */
export function endBanner(winner: TeamId | undefined): string {
  if (winner === 'royal') return 'VICTORY ROYAL';
  if (winner === 'iron') return 'VICTORY IRON';
  return 'DRAW';
}

/** Lobby headline: null countdown = no clock running yet (room waiting). */
export function lobbyLine(countdownS: number | null): string {
  if (countdownS === null || !Number.isFinite(countdownS)) {
    return 'AWAITING SQUADRON — FIRST PATROL FORMING';
  }
  return `FIRST PATROL LAUNCHES IN ${Math.max(0, Math.ceil(countdownS))}`;
}

/**
 * True while the respawn clock still runs: the picker stays on screen but
 * dimmed (.waiting) — D3 keeps death cheap, and an early pick is safe because
 * the server queues one spawn (early sends are idempotent).
 */
export function pickerWaiting(respawnT: number): boolean {
  return Number.isFinite(respawnT) && respawnT > 0;
}

/** Death-screen line: >0 s counts down, ≤0 s means the picker is open. */
export function respawnLine(respawnT: number): string {
  if (!pickerWaiting(respawnT)) return 'CHOOSE YOUR AIRFRAME';
  return `NEXT AIRFRAME IN ${respawnT.toFixed(1)}S`;
}

/** Disconnect-screen primary action label (the panel's reload-wired button). */
export const RE_ENLIST_LABEL = 'RE-ENLIST';

/** Disconnect note: auto-retry backoff while retrying, fresh-seat truth after. */
export function disconnectNote(retrying: boolean): string {
  if (retrying) {
    return `RECONNECTING — BACKOFF ${NET.BACKOFF_MS.join(' / ')} MS`;
  }
  return 'LINE DOWN. ON REJOIN A FRESH SEAT IS ISSUED — SEATS ARE NOT RESERVED.';
}

/**
 * Requisition-form stat strips normalized across ALL three airframes so the
 * three cards share one visual scale: speed = speedMax fraction of the fastest
 * airframe, agility = turnRate fraction, guns = raw DPS (dmg×count×rateHz)
 * fraction. Each value lands in (0..1]; scout tops speed+agility, gunship
 * tops guns — CONTRACT §Balance's asymmetry made legible.
 */
export interface ClassStrips {
  speed: number;
  agility: number;
  guns: number;
}

export function classStrips(id: PlaneClassId): ClassStrips {
  let maxSpeed = 1;
  let maxTurn = 1;
  let maxDps = 1;
  for (const c of PLANE_CLASSES) {
    const spec = CLASSES[c];
    maxSpeed = Math.max(maxSpeed, spec.speedMax);
    maxTurn = Math.max(maxTurn, spec.turnRate);
    maxDps = Math.max(maxDps, spec.gun.dmg * spec.gun.count * spec.gun.rateHz);
  }
  const spec = CLASSES[id];
  return {
    speed: spec.speedMax / maxSpeed,
    agility: spec.turnRate / maxTurn,
    guns: (spec.gun.dmg * spec.gun.count * spec.gun.rateHz) / maxDps,
  };
}

/**
 * Digit1..3 / Numpad1..3 → PlaneClassId, matching the picker cards' big
 * numerals. Exported because the hotkey map IS display logic (the numerals
 * are painted on the cards) and belongs under test like any other mapping.
 */
export function spawnHotkey(code: string): PlaneClassId | null {
  switch (code) {
    case 'Digit1': case 'Numpad1': return PLANE_CLASSES[0] ?? null;
    case 'Digit2': case 'Numpad2': return PLANE_CLASSES[1] ?? null;
    case 'Digit3': case 'Numpad3': return PLANE_CLASSES[2] ?? null;
    default: return null;
  }
}

/** Human-readable key label — duplicated from hud.ts because sibling imports
 *  are forbidden by the seam law (each module imports shared + contract only). */
function formatKey(code: string): string {
  switch (code) {
    case 'ArrowLeft': return '←';
    case 'ArrowRight': return '→';
    case 'ArrowUp': return '↑';
    case 'ArrowDown': return '↓';
    case 'Space': return 'SPACE';
    case 'Escape': return 'ESC';
    case 'Tab': return 'TAB';
    default:
      if (code.startsWith('Key')) return code.slice(3);
      if (code.startsWith('Shift')) return 'SHIFT';
      if (code.startsWith('Digit')) return code.slice(5);
      if (code.startsWith('Numpad')) return `NUM${code.slice(6)}`;
      return code.toUpperCase();
  }
}

/** Set-deduped exactly like hud.ts's exported formatKeys — ShiftLeft +
 *  ShiftRight print one SHIFT stamp, not two (menu controls card). */
function formatKeys(codes: readonly string[]): string {
  return Array.from(new Set(codes.map(formatKey))).join(' / ');
}

export interface ControlRow {
  readonly label: string;
  readonly keys: string;
}

/** Controls listing built FROM INPUT_KEYS — never a hand-typed copy (C_UI brief). */
export function controlsRows(): readonly ControlRow[] {
  return [
    { label: 'TURN', keys: `${formatKeys(INPUT_KEYS.turnLeft)} · ${formatKeys(INPUT_KEYS.turnRight)}` },
    { label: 'THROTTLE', keys: `${formatKeys(INPUT_KEYS.throttleUp)} · ${formatKeys(INPUT_KEYS.throttleDown)}` },
    { label: 'FIRE GUNS', keys: formatKeys(INPUT_KEYS.fire) },
    { label: 'BOOST', keys: formatKeys(INPUT_KEYS.boost) },
    { label: 'SCOREBOARD', keys: `${formatKeys(INPUT_KEYS.scoreboard)} (HOLD)` },
    { label: 'MUTE', keys: formatKeys(INPUT_KEYS.mute) },
    { label: 'CONTROLS CARD', keys: formatKeys(INPUT_KEYS.help) },
  ];
}

// ============================================================================
// Public surface (exact per brief + seams.ts pinned Screens block)
// ============================================================================

export interface ScreenHooks {
  onPlay(name: string, join: JoinKind): void;
  onSpawn(cls: PlaneClassId): void;
  onMuteToggle(): void;
  onHelp(open: boolean): void;
}

export type Screens = {
  showMenu(prefName: string): void;
  showConnecting(): void;
  showLobby(countdownS: number | null, roster: ScoreRow[]): void;
  showMatchUI(): void;
  showDeath(respawnT: number, lastCls: PlaneClassId): void;
  showEnd(board: ScoreRow[], winner: TeamId | undefined): void;
  showDisconnected(retrying: boolean): void;
  hideAll(): void;
};

const STYLE_ID = 'aces-screens-style';
const ROOT_ID = 'aces-screens';

const FONT_TW = "'Courier New', ui-monospace, Menlo, monospace";
const FONT_COND = "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";

// Flat-ink paperwork stylesheet. Every color is a var() fed by APAL below —
// flat fills only (bible §2: gradients belong to sky banding and softPuff,
// not UI chrome). Shadows are ink-alpha products, not black/white rgba.
const CSS = `
.aces-scr{position:fixed;inset:0;z-index:30;font-family:var(--ac-font-ui);color:var(--ac-ink);
  user-select:none;-webkit-user-select:none;}
.aces-scr-layer{position:absolute;inset:0;display:none;pointer-events:none;}
.aces-scr-layer.on{display:block;}
.aces-scr-layer.on .aces-panel,.aces-scr-layer.on .aces-poster,.aces-scr-layer.on button{
  pointer-events:auto;}
.aces-l-menu{background:var(--ac-haze);}
.aces-scr-scrim{position:absolute;inset:0;background:var(--ac-ink30);}
.aces-tw{font-family:var(--ac-font-tw);text-transform:uppercase;letter-spacing:.08em;}

/* ---- poster frame --------------------------------------------------------- */
.aces-poster{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:min(560px,92vw);max-height:92vh;overflow:auto;background:var(--ac-paper);
  border:2px solid var(--ac-ink);border-radius:2px;box-shadow:0 4px 18px var(--ac-ink45);
  padding:34px 40px 26px;text-align:center;}
.aces-bar{display:flex;height:10px;margin:-34px -40px 26px;border-bottom:2px solid var(--ac-ink);}
.aces-bar i{flex:1;display:block;}
.aces-bar .r{background:var(--ac-royal);}
.aces-bar .w{background:var(--ac-paper);flex:0 0 8px;}
.aces-bar .i{background:var(--ac-iron);}
/* §8 masthead art: dawn bands + scout silhouette, painted once at build */
.aces-masthead{display:block;width:100%;height:auto;margin:0 auto 12px;
  border:1px solid var(--ac-ink30);}
.aces-mark{margin:0;font-family:var(--ac-font-cond);font-weight:900;line-height:.88;
  font-size:clamp(76px,15vw,132px);letter-spacing:.02em;color:var(--ac-ink);}
.aces-sub{margin:10px 0 22px;font-size:14px;color:var(--ac-ink75);}

/* ---- menu form ---------------------------------------------------------------- */
.aces-field{display:flex;align-items:center;gap:12px;margin:0 auto 14px;width:min(320px,80vw);
  text-align:left;}
.aces-fieldlabel{width:86px;font-size:14px;font-weight:700;color:var(--ac-ink75);}
.aces-input{flex:1;min-width:0;padding:9px 10px;font-family:var(--ac-font-tw);font-size:16px;
  letter-spacing:.06em;text-transform:uppercase;background:var(--ac-paper92);
  border:1px solid var(--ac-ink55);border-radius:2px;color:var(--ac-ink);}
.aces-input:focus-visible,.aces-btn:focus-visible,.aces-card:focus-visible{
  outline:2px dashed var(--ac-warn);outline-offset:2px;}
.aces-btn{display:block;margin:10px auto 0;width:min(320px,80vw);padding:13px 18px;cursor:pointer;
  font-family:var(--ac-font-cond);font-weight:900;font-size:22px;letter-spacing:.16em;
  text-transform:uppercase;border-radius:2px;}
.aces-btn.primary{background:var(--ac-ink);color:var(--ac-paper);border:2px solid var(--ac-ink);}
.aces-btn.primary:hover:not(:disabled){background:var(--ac-ink75);border-color:var(--ac-ink75);}
.aces-btn.secondary{background:transparent;color:var(--ac-ink);border:2px solid var(--ac-ink55);}
.aces-btn.secondary:hover{border-color:var(--ac-ink);background:var(--ac-paper88);}
.aces-btn:disabled{opacity:.45;cursor:default;}
.aces-controls{margin:24px auto 0;width:min(360px,84vw);text-align:left;
  border-top:1px solid var(--ac-ink30);padding-top:12px;}
.aces-kbdrow{display:flex;justify-content:space-between;align-items:center;padding:2px 0;font-size:14px;}
.aces-kbdrow .k{color:var(--ac-inksoft);}

/* ---- lobby ---------------------------------------------------------------------- */
.aces-headline{margin:0 0 18px;font-family:var(--ac-font-cond);font-weight:900;
  font-size:clamp(28px,6vw,44px);letter-spacing:.08em;text-transform:uppercase;color:var(--ac-ink);}
.aces-roster{display:flex;gap:22px;text-align:left;}
.aces-rostercol{flex:1;min-width:0;}
.aces-rosterhead{display:flex;align-items:center;gap:6px;font-size:15px;font-weight:900;
  letter-spacing:.14em;padding-bottom:6px;border-bottom:1px solid var(--ac-ink30);margin-bottom:4px;}
.aces-rosterrow{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:14px;font-weight:700;}
.aces-rosterrow.aces-you{background:var(--ac-tracer28);box-shadow:inset 3px 0 0 var(--ac-ink);}
.aces-glyph{font-size:14px;font-weight:800;color:var(--ac-inksoft);}
.aces-bottag{font-size:14px;color:var(--ac-inksoft);border:1px solid var(--ac-ink30);padding:0 3px;}
.aces-badge{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;
  font-size:14px;font-weight:900;border:2px solid currentColor;flex:none;}
.aces-badge.r{border-radius:50%;color:var(--ac-royal);}
.aces-badge.i{border-radius:0;color:var(--ac-iron);}

/* ---- death / class picker ------------------------------------------------------------ */
.aces-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:min(760px,94vw);max-height:92vh;overflow:auto;background:var(--ac-paper);
  border:2px solid var(--ac-ink);border-radius:2px;box-shadow:0 4px 18px var(--ac-ink45);
  padding:26px 30px;text-align:center;}
.aces-picker{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;}
/* Waiting recedes the requisition form but NEVER its hotkey numerals: dimming
   via an ancestor opacity group would multiply through the tree and cap the
   numerals at 45% no matter what they declare, so the card CONTENTS dim here
   while .aces-cardkey stays full-strength ink — early picking is invited
   exactly while this class is on (D3). */
.aces-picker.waiting .aces-card{border-color:var(--ac-ink30);}
.aces-picker.waiting .aces-cardname,
.aces-picker.waiting .aces-strip,
.aces-picker.waiting .aces-cardspec,
.aces-picker.waiting .aces-lasttag{opacity:.45;}
.aces-picker.waiting .aces-cardkey{opacity:1;color:var(--ac-ink);}
.aces-card{width:196px;padding:14px 14px 12px;text-align:left;background:var(--ac-paper92);
  border:2px solid var(--ac-ink55);border-radius:2px;cursor:pointer;position:relative;}
.aces-card:hover{border-color:var(--ac-ink);}
.aces-card.picked{border-color:var(--ac-warn);box-shadow:0 0 0 1px var(--ac-warn);}
.aces-cardkey{position:absolute;top:8px;right:10px;font-family:var(--ac-font-cond);
  font-weight:900;font-size:30px;color:var(--ac-ink75);}
.aces-cardname{margin:0 0 10px;font-family:var(--ac-font-cond);font-weight:900;font-size:24px;
  letter-spacing:.1em;color:var(--ac-ink);}
.aces-strip{display:flex;align-items:center;gap:8px;margin-top:6px;}
.aces-striplabel{width:56px;font-size:14px;color:var(--ac-ink75);}
.aces-track{flex:1;height:9px;background:var(--ac-ink18);border:1px solid var(--ac-ink40);}
.aces-stripfill{display:block;height:100%;background:var(--ac-ink);}
.aces-cardspec{margin-top:10px;font-size:14px;color:var(--ac-ink75);}
.aces-lasttag{position:absolute;top:-11px;left:8px;display:none;padding:0 6px;
  background:var(--ac-warn);color:var(--ac-paper);font-size:14px;font-weight:800;
  transform:rotate(-2deg);}
.aces-card.picked .aces-lasttag{display:inline-block;}
.aces-note{margin-top:16px;font-size:14px;color:var(--ac-ink75);}

/* ---- end board ------------------------------------------------------------------------- */
.aces-endbanner{margin:0 0 6px;font-family:var(--ac-font-cond);font-weight:900;
  font-size:clamp(40px,8vw,64px);letter-spacing:.1em;line-height:1;color:var(--ac-ink);}
.aces-endbanner.royal{color:var(--ac-royal);}
.aces-endbanner.iron{color:var(--ac-iron);}
.aces-board{width:100%;margin-top:14px;text-align:left;border-collapse:collapse;}
.aces-board th{font-size:14px;color:var(--ac-ink75);text-align:right;padding:2px 8px;
  border-bottom:1px solid var(--ac-ink45);font-weight:700;}
.aces-board th:first-child{text-align:left;}
.aces-board td{padding:4px 8px;font-size:15px;text-align:right;border-bottom:1px dashed var(--ac-ink18);}
.aces-board td:first-child{text-align:left;font-weight:700;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;max-width:220px;}
.aces-mvp{color:var(--ac-tracer);font-weight:900;margin-right:4px;}
tr.aces-you td{background:var(--ac-tracer28);}
tr.aces-you td:first-child{border-left:3px solid var(--ac-ink);}

/* ---- misc stamps ---------------------------------------------------------------------------- */
.aces-line{margin:8px 0;font-size:16px;font-weight:700;}
@keyframes aces-dots{0%{content:'';}25%{content:'.';}50%{content:'..';}75%{content:'...';}}
.aces-dots::after{content:'';animation:aces-dots 1.2s steps(1) infinite;}

@media (prefers-reduced-motion: reduce){
  .aces-dots::after{animation:none;}
}
`;

type LayerState =
  | 'none'
  | 'menu'
  | 'connecting'
  | 'lobby'
  | 'match'
  | 'death'
  | 'end'
  | 'disconnect';

class AcesScreens implements Screens {
  private readonly hooks: ScreenHooks;
  private readonly root: HTMLElement;
  private readonly styleEl: HTMLStyleElement | null;
  private readonly layers: Record<Exclude<LayerState, 'none'> | 'help', HTMLElement>;

  // menu elements
  private readonly nameInput: HTMLInputElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly privateBtn: HTMLButtonElement;

  // lobby
  private rosterBox!: HTMLElement;
  private lobbyHeadline!: HTMLElement;
  private rosterSig = '';

  // death
  private respawnLineEl!: HTMLElement;
  private pickerEl!: HTMLElement;
  private lastPickedCls: PlaneClassId | null = null;

  // end
  private endBannerEl!: HTMLElement;
  private endBoardBody!: HTMLElement;
  private endSig = '';

  // disconnect
  private discRetry!: HTMLElement;
  private discDown!: HTMLElement;

  // state machine + identity capture (see file-head IDENTITY GAP note)
  private cur: LayerState = 'none';
  private helpOpen = false;
  private prefName = '';

  constructor(hooks: ScreenHooks) {
    this.hooks = hooks;

    this.styleEl = injectStyleOnce(STYLE_ID, CSS);
    this.root = document.createElement('div');
    this.root.id = ROOT_ID;
    this.root.className = 'aces-scr';
    applyThemeVars(this.root.style);
    document.body.appendChild(this.root);

    const L = (name: string): HTMLElement => {
      const el = document.createElement('section');
      el.className = `aces-scr-layer aces-l-${name}`;
      this.root.appendChild(el);
      return el;
    };

    // ---- MENU (propaganda poster) ------------------------------------------
    const menu = L('menu');
    const poster = div('aces-poster');
    poster.appendChild(teamBar());
    poster.appendChild(buildMasthead());
    const mark = div('aces-mark');
    mark.textContent = 'ACES';
    mark.setAttribute('role', 'heading');
    mark.setAttribute('aria-level', '1');
    poster.appendChild(mark);
    poster.appendChild(
      textDiv('aces-sub aces-tw', 'DAWN PATROL OVER THE COLD STRAIT — FIRST SQUADRON TO 25 KILLS'),
    );

    const field = div('aces-field');
    field.appendChild(textSpan('aces-fieldlabel aces-tw', 'PILOT'));
    this.nameInput = document.createElement('input');
    this.nameInput.className = 'aces-input';
    this.nameInput.type = 'text';
    this.nameInput.maxLength = 16; // wire limit: join trims names to 1..16 chars
    this.nameInput.placeholder = 'CALLSIGN';
    this.nameInput.setAttribute('aria-label', 'Pilot callsign');
    this.nameInput.addEventListener('input', () => this.syncPlayEnabled());
    // Enter in the field plays — the keyboard path needs no mouse.
    this.nameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') this.playQuick();
    });
    field.appendChild(this.nameInput);
    poster.appendChild(field);

    this.playBtn = document.createElement('button');
    this.playBtn.type = 'button';
    this.playBtn.className = 'aces-btn primary';
    this.playBtn.textContent = 'FLY — QUICK PATROL';
    this.playBtn.addEventListener('click', () => this.playQuick());
    poster.appendChild(this.playBtn);

    this.privateBtn = document.createElement('button');
    this.privateBtn.type = 'button';
    this.privateBtn.className = 'aces-btn secondary';
    this.privateBtn.textContent = 'HOST A PRIVATE ROOM';
    this.privateBtn.addEventListener('click', () => this.playPrivate());
    poster.appendChild(this.privateBtn);

    poster.appendChild(buildControls());
    poster.appendChild(
      textDiv('aces-footnote aces-tw', 'TWO SQUADRONS · THREE AIRFRAMES · FORWARD GUNS ONLY'),
    );
    menu.appendChild(poster);

    // ---- CONNECTING ------------------------------------------------------------
    const connecting = L('connecting');
    connecting.appendChild(scrim());
    const cPanel = panel();
    cPanel.appendChild(smallMark());
    cPanel.appendChild(textDiv('aces-headline', 'JOINING THE PATROL'));
    cPanel.appendChild(textDiv('aces-line aces-tw aces-dots', 'WIRE TO OPERATIONS ROOM'));
    connecting.appendChild(cPanel);

    // ---- LOBBY -------------------------------------------------------------------
    const lobby = L('lobby');
    lobby.appendChild(scrim());
    const lPanel = panel();
    this.lobbyHeadline = div('aces-headline');
    lPanel.appendChild(this.lobbyHeadline);
    this.rosterBox = div('aces-roster');
    lPanel.appendChild(this.rosterBox);
    lPanel.appendChild(
      textDiv('aces-note aces-tw', 'BOTS FLY THE EMPTY SEATS UNTIL HUMANS ARRIVE'),
    );
    lobby.appendChild(lPanel);

    // ---- DEATH + CLASS PICKER ---------------------------------------------------------
    const death = L('death');
    death.appendChild(scrim());
    const dPanel = panel();
    dPanel.setAttribute('role', 'dialog');
    dPanel.setAttribute('aria-modal', 'true');
    dPanel.setAttribute('aria-label', 'Respawn — choose your airframe');
    this.respawnLineEl = div('aces-headline');
    dPanel.appendChild(this.respawnLineEl);
    this.pickerEl = div('aces-picker');
    for (let i = 0; i < PLANE_CLASSES.length; i++) {
      this.pickerEl.appendChild(this.buildCard(PLANE_CLASSES[i]!, i));
    }
    dPanel.appendChild(this.pickerEl);
    dPanel.appendChild(
      textDiv(
        'aces-note aces-tw',
        `SPAWN PROTECTION ${SPAWN_PROTECT_SECONDS}S — GUNS COLD UNTIL IT FADES`,
      ),
    );
    death.appendChild(dPanel);

    // ---- END ----------------------------------------------------------------------------
    const end = L('end');
    end.appendChild(scrim());
    const ePanel = panel();
    ePanel.setAttribute('role', 'dialog');
    ePanel.setAttribute('aria-modal', 'true');
    ePanel.setAttribute('aria-label', 'Patrol result');
    this.endBannerEl = div('aces-endbanner');
    ePanel.appendChild(this.endBannerEl);
    ePanel.appendChild(textDiv('aces-sub aces-tw', 'FLIGHT RECORD — FINAL'));
    const table = document.createElement('table');
    table.className = 'aces-board';
    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    for (const name of ['PILOT', 'K', 'D', 'ACC', 'SCORE']) {
      const cell = document.createElement('th');
      cell.textContent = name;
      cell.scope = 'col';
      hrow.appendChild(cell);
    }
    thead.appendChild(hrow);
    table.appendChild(thead);
    this.endBoardBody = document.createElement('tbody');
    table.appendChild(this.endBoardBody);
    ePanel.appendChild(table);
    ePanel.appendChild(
      textDiv('aces-note aces-tw', `NEXT PATROL LAUNCHES IN ${END_SECONDS}S — THE SQUADRON REARMS`),
    );
    end.appendChild(ePanel);

    // ---- DISCONNECT ------------------------------------------------------------------------
    const disc = L('disconnect');
    disc.appendChild(scrim());
    const xPanel = panel();
    xPanel.appendChild(smallMark());
    xPanel.appendChild(textDiv('aces-headline', 'SIGNAL LOST'));
    this.discRetry = textDiv('aces-line aces-tw', '');
    xPanel.appendChild(this.discRetry);
    this.discDown = textDiv('aces-line aces-tw', disconnectNote(false));
    xPanel.appendChild(this.discDown);
    xPanel.appendChild(
      textDiv('aces-note aces-tw', 'RETURN TO THE OPERATIONS ROOM AND ENLIST AGAIN'),
    );
    const reup = document.createElement('button');
    reup.type = 'button';
    reup.className = 'aces-btn primary';
    reup.textContent = RE_ENLIST_LABEL;
    reup.addEventListener('click', () => location.reload());
    xPanel.appendChild(reup);
    disc.appendChild(xPanel);

    // ---- HELP (Esc controls card — NOT a pause) ---------------------------------------------
    const help = L('help');
    help.appendChild(scrim());
    const hPanel = panel();
    hPanel.setAttribute('role', 'dialog');
    hPanel.setAttribute('aria-modal', 'true');
    hPanel.setAttribute('aria-label', 'Controls');
    hPanel.appendChild(textDiv('aces-headline', 'CONTROLS'));
    hPanel.appendChild(buildControls());
    hPanel.appendChild(
      textDiv('aces-note aces-tw', 'THE PATROL CONTINUES WHILE THIS CARD IS OPEN — ESC TO CLOSE'),
    );
    help.appendChild(hPanel);

    // The 'match' layer exists only so the state loop finds a key for it — it
    // stays hidden forever: live gameplay shows the sky + HUD chips, not us.
    this.layers = {
      menu,
      connecting,
      lobby,
      match: L('match'),
      death,
      end,
      disconnect: disc,
      help,
    };

    window.addEventListener('keydown', this.handleKeyDown);
  }

  // ---- card factory (death picker) ---------------------------------------------

  private buildCard(cls: PlaneClassId, hotkeyIndex: number): HTMLElement {
    const spec = CLASSES[cls];
    const strips = classStrips(cls);
    const card = document.createElement('article');
    card.className = 'aces-card';
    card.dataset.cls = cls;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;

    const key = spanEl('aces-cardkey');
    key.textContent = String(hotkeyIndex + 1);
    key.setAttribute('aria-hidden', 'true');
    card.appendChild(key);

    card.appendChild(spanEl2('aces-lasttag', 'LAST AIRFRAME'));

    const name = document.createElement('h3');
    name.className = 'aces-cardname';
    name.textContent = spec.name;
    card.appendChild(name);

    card.appendChild(stripRow('SPEED', strips.speed));
    card.appendChild(stripRow('AGILITY', strips.agility));
    card.appendChild(stripRow('GUNS', strips.guns));

    card.appendChild(textDiv('aces-cardspec aces-tw', `HP ${spec.hp} · GUNS ×${spec.gun.count}`));

    const activate = (): void => this.hooks.onSpawn(cls);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        activate();
      }
    });
    return card;
  }

  // ---- Screens surface -------------------------------------------------------------

  showMenu(prefName: string): void {
    this.setState('menu');
    // Capture for the end-screen personal-row heuristic (file-head note).
    this.prefName = typeof prefName === 'string' ? prefName : '';
    if (this.prefName !== '' && this.nameInput.value !== this.prefName) {
      this.nameInput.value = this.prefName;
    }
    this.syncPlayEnabled();
  }

  showConnecting(): void {
    this.setState('connecting');
  }

  showLobby(countdownS: number | null, roster: ScoreRow[]): void {
    this.setState('lobby');
    const line = lobbyLine(countdownS);
    if (this.lobbyHeadline.textContent !== line) this.lobbyHeadline.textContent = line;
    let sig = '';
    for (const r of roster) sig += `${r.id}:${r.team}:${r.name}:${r.bot}:${r.cls};`;
    if (sig !== this.rosterSig) {
      this.rosterSig = sig;
      renderRoster(this.rosterBox, roster, this.prefName);
    }
  }

  showMatchUI(): void {
    this.setState('match');
  }

  showDeath(respawnT: number, lastCls: PlaneClassId): void {
    this.setState('death');
    const line = respawnLine(respawnT);
    if (this.respawnLineEl.textContent !== line) this.respawnLineEl.textContent = line;
    // The requisition form owns the WHOLE death window (D3): dimmed while the
    // clock runs, full-strength once it hits zero. Early picks are safe — the
    // server queues one spawn, so a pre-zero send is idempotent.
    setClass(this.pickerEl, 'waiting', pickerWaiting(respawnT));
    if (this.lastPickedCls !== lastCls) {
      this.lastPickedCls = lastCls;
      for (const child of Array.from(this.pickerEl.children)) {
        setClass(child as HTMLElement, 'picked', (child as HTMLElement).dataset.cls === lastCls);
      }
    }
  }

  showEnd(board: ScoreRow[], winner: TeamId | undefined): void {
    this.setState('end');
    const banner = endBanner(winner);
    if (this.endBannerEl.textContent !== banner) this.endBannerEl.textContent = banner;
    setClass(this.endBannerEl, 'royal', winner === 'royal');
    setClass(this.endBannerEl, 'iron', winner === 'iron');

    const rows = [...board].sort((a, b) => b.score - a.score || b.kills - a.kills);
    let sig = `${winner ?? 'draw'}|`;
    for (const r of rows) sig += `${r.id}:${r.kills}:${r.deaths}:${r.shots}:${r.hits}:${r.score};`;
    if (sig === this.endSig) return;
    this.endSig = sig;

    this.endBoardBody.replaceChildren();
    const mine = this.prefName.trim().toLowerCase();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const tr = document.createElement('tr');
      const you = mine !== '' && r.name.trim().toLowerCase() === mine;
      if (you) tr.className = 'aces-you';
      const nameCell = document.createElement('td');
      if (i === 0) {
        const starEl = spanEl('aces-mvp');
        starEl.textContent = '★';
        starEl.title = 'MVP';
        nameCell.appendChild(starEl);
      }
      nameCell.appendChild(document.createTextNode(you ? `${r.name} (YOU)` : r.name));
      if (r.bot) nameCell.appendChild(spanEl2('aces-bottag', 'BOT'));
      nameCell.insertBefore(badgeEl(r.team), nameCell.firstChild);
      tr.appendChild(nameCell);
      tr.appendChild(numCell(String(r.kills)));
      tr.appendChild(numCell(String(r.deaths)));
      const acc = accPct(r.shots, r.hits);
      tr.appendChild(numCell(acc === null ? '—' : `${acc}%`));
      tr.appendChild(numCell(String(r.score)));
      this.endBoardBody.appendChild(tr);
    }
  }

  showDisconnected(retrying: boolean): void {
    this.setState('disconnect');
    setHidden(this.discRetry, !retrying);
    if (retrying) {
      const note = disconnectNote(true);
      if (this.discRetry.textContent !== note) this.discRetry.textContent = note;
    }
  }

  hideAll(): void {
    this.setState('none');
  }

  // ---- internals --------------------------------------------------------------------

  /** PLAY button: lobby quick_join envelope (public room, bot fill). */
  private playQuick(): void {
    const name = this.readName();
    if (name === '') return;
    this.hooks.onPlay(name, { kind: 'quick' });
  }

  /** PRIVATE ROOM: create_private with default settings ({}) per brief. */
  private playPrivate(): void {
    const name = this.readName();
    if (name === '') return;
    this.hooks.onPlay(name, { kind: 'private', settings: {} });
  }

  /** Wire-sanitised read: trim + cap to the protocol's 1..16 char window. */
  private readName(): string {
    return this.nameInput.value.trim().slice(0, 16);
  }

  private syncPlayEnabled(): void {
    const ok = this.readName().length >= 1;
    if (this.playBtn.disabled !== !ok) this.playBtn.disabled = !ok;
    if (this.privateBtn.disabled !== !ok) this.privateBtn.disabled = !ok;
  }

  /**
   * State switch. If the controls card was open it closes WITH its hook fired:
   * C_APP tracks the same boolean, so silent closes would desync it. User Esc
   * toggles go through toggleHelp(); scene churn goes through here.
   */
  private setState(next: LayerState): void {
    if (this.cur === next) return;
    this.cur = next;
    if (this.helpOpen) {
      this.helpOpen = false;
      setClass(this.layers.help, 'on', false);
      this.hooks.onHelp(false);
    }
    for (const [name, layer] of Object.entries(this.layers)) {
      setClass(layer, 'on', name === next);
    }
  }

  private toggleHelp(): void {
    const next = !this.helpOpen;
    this.helpOpen = next;
    setClass(this.layers.help, 'on', next);
    this.hooks.onHelp(next);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    const st = this.cur;

    // TAB never roams focus out of fullscreen game states (menu keeps native
    // tabbing for its form; hud.ts additionally swallows global Tabs once the
    // HUD exists — belt and braces, both idempotent).
    if (e.code === 'Tab' && st !== 'menu' && st !== 'none') {
      e.preventDefault();
      return;
    }

    if (e.code === 'Escape') {
      if (this.helpOpen) {
        e.preventDefault();
        this.toggleHelp(); // closes from any state it was opened over
        return;
      }
      // Scope law: the controls card exists for gameplay states (live + the
      // death picker). Informational screens stay put under Escape.
      if (st === 'match' || st === 'death') {
        e.preventDefault();
        this.toggleHelp();
      }
      return;
    }

    if (e.code === 'KeyM' && !isTypingTarget()) {
      this.hooks.onMuteToggle();
      return;
    }

    // Digit hotkeys answer through the whole death window — the countdown is
    // no longer a gate (server queues the spawn, so early picks are safe).
    if (st === 'death' && !this.helpOpen) {
      const cls = spawnHotkey(e.code);
      if (cls !== null) this.hooks.onSpawn(cls);
    }
  };
}

// ============================================================================
// helpers
// ============================================================================

function accPct(shots: number, hits: number): number | null {
  if (!Number.isFinite(shots) || shots <= 0) return null;
  return Math.min(100, Math.round((hits / shots) * 100));
}

function isTypingTarget(): boolean {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (active === null) return false;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function spanEl(cls: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  return s;
}

function spanEl2(cls: string, text: string): HTMLSpanElement {
  const s = spanEl(cls);
  s.textContent = text;
  return s;
}

function textDiv(cls: string, text: string): HTMLDivElement {
  const d = div(cls);
  d.textContent = text;
  return d;
}

function textSpan(cls: string, text: string): HTMLSpanElement {
  const s = spanEl(cls);
  s.textContent = text;
  return s;
}

function scrim(): HTMLElement {
  return div('aces-scr-scrim');
}

function panel(): HTMLElement {
  return div('aces-panel');
}

function smallMark(): HTMLElement {
  const m = div('aces-mark');
  m.style.fontSize = '54px';
  m.textContent = 'ACES';
  m.setAttribute('aria-hidden', 'true');
  return m;
}

/** Team accent bar: ROYAL navy | paper notch | IRON crimson (flat, §8). */
function teamBar(): HTMLElement {
  const bar = div('aces-bar');
  const r = document.createElement('i');
  r.className = 'r';
  const w = document.createElement('i');
  w.className = 'w';
  const i = document.createElement('i');
  i.className = 'i';
  bar.append(r, w, i);
  return bar;
}

// ---- menu masthead art (STYLE_BIBLE §8 propaganda poster) --------------------
//
// Painted ONCE at menu build onto an inline canvas between the accent bar and
// the wordmark: a two-tone SCOUT silhouette (royalNavy body + deck-cream
// roundel ring — the D4 team identity pair) banking across warm dawn bands,
// sunGlare disc upper right under a softPuff halo, thin haze strips at the
// horizon. Geometry mirrors render/planes.ts's SCOUT part table at ~3×
// gameplay scale so poster and gameplay read as one printed page. Deterministic
// by law: fixed-seed rng, no Math.random (§9).

const MASTHEAD_W = 720;
const MASTHEAD_H = 140;
/** Gameplay-unit → px factor; the scout spans ~33u → ~99px of poster hero. */
const MASTHEAD_SCALE = 3;
/** Fixed seed — the same poster every boot. */
const MASTHEAD_SEED = 19170401;

function buildMasthead(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.round(MASTHEAD_W * dpr);
  c.height = Math.round(MASTHEAD_H * dpr);
  c.className = 'aces-masthead';
  c.setAttribute('aria-hidden', 'true');
  const ctx = c.getContext('2d');
  if (ctx !== null) paintMasthead(ctx, dpr);
  return c;
}

function paintMasthead(ctx: CanvasRenderingContext2D, dpr: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Dawn sky as FLAT horizontal stops (bible §2 — bands, not gradients).
  const horizon = MASTHEAD_H * 0.56;
  ctx.fillStyle = PAL.dawnHi;
  ctx.fillRect(0, 0, MASTHEAD_W, horizon);
  ctx.fillStyle = PAL.dawnLo;
  ctx.fillRect(0, horizon, MASTHEAD_W, MASTHEAD_H - horizon);
  ctx.fillStyle = shadeA('dawnLo', -0.07); // deep band anchoring the bottom edge
  ctx.fillRect(0, MASTHEAD_H * 0.86, MASTHEAD_W, MASTHEAD_H * 0.14);

  // Thin haze band strips drifting along the horizon (seeded jitter).
  const rng = makeRng(MASTHEAD_SEED);
  ctx.fillStyle = withAlpha('haze', 0.5);
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(0, horizon - 14 + rng() * 26, MASTHEAD_W, 2 + rng() * 3);
  }

  // SunGlare disc upper right: softPuff halo, faint starburst rays, solid core.
  const sx = MASTHEAD_W * 0.82;
  const sy = MASTHEAD_H * 0.24;
  const sr = 22;
  softPuff(ctx, sx, sy, sr * 3.4, withAlpha('sunGlare', 0.9), withAlpha('sunGlare', 0));
  star(ctx, sx, sy, 12, sr * 2.1, sr * 1.4, -Math.PI / 2);
  ctx.fillStyle = withAlpha('sunGlare', 0.55);
  ctx.fill();
  ctx.fillStyle = PAL.sunGlare;
  ctx.beginPath();
  ctx.arc(sx, sy, sr, 0, Math.PI * 2);
  ctx.fill();

  // Two-tone SCOUT banking toward the sun — planes.ts geometry × MASTHEAD_SCALE.
  ctx.save();
  ctx.translate(MASTHEAD_W * 0.42, MASTHEAD_H * 0.47);
  ctx.rotate(-0.12);
  ctx.scale(MASTHEAD_SCALE, MASTHEAD_SCALE);

  ctx.fillStyle = PAL.royalNavy;
  poly(ctx, [
    [15, 2.6], [-14, 1.5], [-14, -1.5], [15, -2.6], // fuselage — stubby nose-heavy
  ]);
  ctx.fill();
  poly(ctx, [
    [4.8, 13], [0.2, 13], [0.2, -13], [4.8, -13], // upper wing (span 26)
  ]);
  ctx.fill();
  poly(ctx, [
    [6.6, 11.5], [2.4, 11.5], [2.4, -11.5], [6.6, -11.5], // lower wing
  ]);
  ctx.fill();
  poly(ctx, [
    [-10.5, 5.2], [-14.5, 4.2], [-14.5, -4.2], [-10.5, -5.2], // tailplane
  ]);
  ctx.fill();
  poly(ctx, [
    [-14.5, 1.1], [-17.2, 0.7], [-17.2, -0.7], [-14.5, -1.1], // HIGH rudder
  ]);
  ctx.fill();
  ctx.fillStyle = PAL.wood;
  poly(ctx, [
    [5.4, 8.7], [3.4, 8.7], [3.4, 5.5], [5.4, 5.5], // interplane strut +
  ]);
  ctx.fill();
  poly(ctx, [
    [5.4, -5.5], [3.4, -5.5], [3.4, -8.7], [5.4, -8.7], // …interplane strut −
  ]);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(12.8, 0, 3.3, 0, Math.PI * 2); // ROUND cowl — the scout's signature
  ctx.fill();
  ctx.fillStyle = PAL.dope;
  ctx.beginPath();
  ctx.arc(-1.5, 0, 2.5, 0, Math.PI * 2); // single-seat hump
  ctx.fill();

  // Hairline ink outline over every silhouette shape (§2) — lifts the print.
  ctx.strokeStyle = INK_STROKE;
  ctx.lineWidth = 0.8;
  poly(ctx, [[15, 2.6], [-14, 1.5], [-14, -1.5], [15, -2.6]]);
  ctx.stroke();
  poly(ctx, [[4.8, 13], [0.2, 13], [0.2, -13], [4.8, -13]]);
  ctx.stroke();
  poly(ctx, [[6.6, 11.5], [2.4, 11.5], [2.4, -11.5], [6.6, -11.5]]);
  ctx.stroke();
  poly(ctx, [[-10.5, 5.2], [-14.5, 4.2], [-14.5, -4.2], [-10.5, -5.2]]);
  ctx.stroke();
  poly(ctx, [[-14.5, 1.1], [-17.2, 0.7], [-17.2, -0.7], [-14.5, -1.1]]);
  ctx.stroke();

  // ROYAL roundel ring on the wing — deck cream, mirrors planes.ts identity.
  ctx.strokeStyle = PAL.royalDeck;
  ctx.lineWidth = 1.9;
  ctx.beginPath();
  ctx.arc(2.5, 0, 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = PAL.royalDeck;
  ctx.beginPath();
  ctx.arc(2.5, 0, 3 * 0.42, 0, Math.PI * 2);
  ctx.fill();

  // Static prop-blur arc (poster freeze-frame).
  ctx.strokeStyle = withAlpha('prop', 0.8);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(15.9, 0, 3.6, -0.7, 1.4);
  ctx.stroke();

  ctx.restore();
}

function badgeEl(team: TeamId): HTMLElement {
  const b = spanEl(`aces-badge ${team === 'royal' ? 'r' : 'i'}`);
  b.textContent = team === 'royal' ? 'R' : 'I';
  b.setAttribute('aria-hidden', 'true');
  return b;
}

function numCell(text: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function stripRow(label: string, frac01: number): HTMLElement {
  const row = div('aces-strip');
  row.appendChild(textSpan('aces-striplabel aces-tw', label));
  const track = div('aces-track');
  const fill = spanEl('aces-stripfill');
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, frac01)) * 100)}%`;
  track.appendChild(fill);
  row.appendChild(track);
  return row;
}

function buildControls(): HTMLElement {
  const box = div('aces-controls');
  for (const row of controlsRows()) {
    const line = div('aces-kbdrow');
    const keys = spanEl('k aces-tw');
    keys.textContent = row.keys;
    const lab = spanEl('l aces-tw');
    lab.textContent = row.label;
    line.append(keys, lab);
    box.appendChild(line);
  }
  return box;
}

function renderRoster(box: HTMLElement, roster: ScoreRow[], prefName: string): void {
  box.replaceChildren();
  const mine = prefName.trim().toLowerCase();
  const royal = div('aces-rostercol');
  const iron = div('aces-rostercol');
  royal.appendChild(colHead('r', 'ROYAL'));
  iron.appendChild(colHead('i', 'IRON'));
  for (const r of roster) {
    const row = div('aces-rosterrow');
    const you = mine !== '' && r.name.trim().toLowerCase() === mine;
    if (you) row.classList.add('aces-you');
    row.appendChild(badgeEl(r.team));
    const g = spanEl('aces-glyph');
    g.textContent = r.cls.charAt(0).toUpperCase();
    g.setAttribute('aria-hidden', 'true');
    row.appendChild(g);
    row.appendChild(spanEl2('', you ? `${r.name} (YOU)` : r.name));
    if (r.bot) row.appendChild(spanEl2('aces-bottag', 'BOT'));
    (r.team === 'royal' ? royal : iron).appendChild(row);
  }
  box.append(royal, iron);
}

function colHead(kind: 'r' | 'i', name: string): HTMLElement {
  const h = div('aces-rosterhead');
  h.appendChild(badgeEl(kind === 'r' ? 'royal' : 'iron'));
  h.appendChild(spanEl2('', name));
  return h;
}

function setHidden(e: HTMLElement, hidden: boolean): void {
  const cur = e.style.display === 'none';
  if (cur !== hidden) e.style.display = hidden ? 'none' : '';
}

function setClass(e: HTMLElement, cls: string, on: boolean): void {
  if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
}

function injectStyleOnce(id: string, css: string): HTMLStyleElement | null {
  const existing = document.getElementById(id);
  if (existing !== null) return existing instanceof HTMLStyleElement ? existing : null;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

/**
 * Palette-derived custom properties shared by both C_UI stylesheets (hud.ts
 * defines the same names on its own root — the two files may not import each
 * other, so each carries its own copy of this tiny theme block). Every value
 * flows from APAL through withAlpha/mixA/shadeA; the CSS references only
 * --ac-* names, keeping raw color out of the stylesheet entirely.
 */
function applyThemeVars(target: CSSStyleDeclaration): void {
  target.setProperty('--ac-font-ui', "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif");
  target.setProperty('--ac-font-tw', FONT_TW);
  target.setProperty('--ac-font-cond', FONT_COND);
  target.setProperty('--ac-paper', PAL.paper);
  target.setProperty('--ac-paper92', withAlpha('paper', 0.92));
  target.setProperty('--ac-paper88', withAlpha('paper', 0.88));
  target.setProperty('--ac-ink', PAL.ink);
  target.setProperty('--ac-inksoft', shadeA('ink', 0.35)); // printed-gray for tags
  target.setProperty('--ac-ink75', withAlpha('ink', 0.75));
  target.setProperty('--ac-ink55', withAlpha('ink', 0.55));
  target.setProperty('--ac-ink45', withAlpha('ink', 0.45));
  target.setProperty('--ac-ink40', withAlpha('ink', 0.4));
  target.setProperty('--ac-ink30', withAlpha('ink', 0.3));
  target.setProperty('--ac-ink18', withAlpha('ink', 0.18));
  target.setProperty('--ac-warn', PAL.warn);
  target.setProperty('--ac-tracer', PAL.tracer);
  target.setProperty('--ac-tracer28', withAlpha('tracer', 0.28));
  target.setProperty('--ac-royal', PAL.royalNavy);
  target.setProperty('--ac-iron', PAL.ironRed);
  // Menu backdrop: dawn haze flattened to ONE tone (no gradient — bible §2).
  target.setProperty('--ac-haze', mixA('haze', 'paper', 0.35));
}

// ============================================================================
// creator — the frozen public surface
// ============================================================================

export function createScreens(hooks: ScreenHooks): Screens {
  return new AcesScreens(hooks);
}
