// ============================================================================
// ui-hud — the always-on DOM overlay. Implements the frozen HudApi
// (shared/src/types.ts). Injects its own <style> once, mirrors PALETTE onto
// CSS custom properties, and is pointer-events:none everywhere except the
// lobby START button. update() is the render-hot-path method: every write is
// gated behind a cached "did this actually change" check, per UX_BIBLE's
// legibility budget and CONTRACT's no-hot-path-allocation rule.
//
// THE FENCE RING is the signature element (CONTRACT + UX_BIBLE, tier 1 #1): a
// square ring of 16 ticks that mirrors the compound's real geometry — 4 per
// side, clockwise from the NW corner, exactly `map.ts`'s SEGMENTS ordering —
// and rotates so the player's current forward direction is always "up", like
// a compass. Every tick carries THREE channels for its health, never colour
// alone: fill height, a PALETTE colour, and an icon that appears at
// damaged/breached. A breach pulses at the highest contrast on the HUD.
//
// Everything with real branching logic is pulled into small, exported pure
// functions above the class so it is unit-testable HEADLESSLY — this
// workspace has no jsdom (see games/rift and games/splat's hud.test.ts), so
// the class itself is exercised only at runtime in a real browser; the tests
// here pin the pure display logic instead.
//
// CONTRACT GAP (reported to the orchestrator): HudState.downed carries only
// `{id, name, dist, bleedout, beingRevived}` — no bearing/screen-position.
// True "through-geometry" markers pinned to a teammate's world position need
// a camera-projected screen point, which is not on this wire. This file
// therefore renders a proximity-sorted list panel (name + distance +
// bleedout, nearest first) instead of a floating world marker — the best
// affordance the given data supports. The UX bible's "visible through
// geometry" requirement is honoured in spirit (it does not depend on
// occluding geometry to disappear) but not in literal screen placement.
// ============================================================================
import type {
  HudApi,
  HudState,
  InteractKind,
  PlayerId,
  RunStats,
  SegmentId,
  SegmentSnap,
} from '@outpost/shared';
import { DOWNED, FENCE, MIN_PLAYERS, PALETTE, SURVIVOR } from '@outpost/shared';
import type { PaletteKey, Side } from '@outpost/shared';

// ---------------------------------------------------------------------------
// Pure display logic — exported, headlessly testable (no DOM involved).
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export type TickState = 'intact' | 'damaged' | 'breached';

export interface TickVisual {
  state: TickState;
  /** 0..1 fill height inside the tick. */
  fill01: number;
  colorKey: PaletteKey;
}

/** STYLE_BIBLE: "Damaged (hp01 < 0.6)". */
const DAMAGED_HP01 = 0.6;

/**
 * One fence tick's visual state. `br` (explicit breach flag) wins over `hp`
 * — a segment being rebuilt has hp climbing from 0 while still breached, so
 * reading hp alone would show a breach as merely "damaged" mid-rebuild,
 * exactly the ambiguity SegmentSnap.br exists to remove. A breached tick's
 * fill tracks REBUILD progress (`rb`), not `hp`, so the ring answers "how
 * close is this hole to closing" while it is open.
 */
export function tickVisual(seg: SegmentSnap): TickVisual {
  if (seg.br) return { state: 'breached', fill01: clamp01(seg.rb), colorKey: 'downedRed' };
  if (seg.hp < DAMAGED_HP01) return { state: 'damaged', fill01: clamp01(seg.hp), colorKey: 'hudAccent' };
  return { state: 'intact', fill01: clamp01(seg.hp), colorKey: 'hpGreen' };
}

/**
 * CSS rotation (degrees, clockwise-positive) that keeps the ring's TOP equal
 * to the player's current forward direction.
 *
 * Sim convention (types.ts header): yaw 0 = -Z (north), increasing CCW as
 * seen from above (forward = (-sin yaw, -cos yaw); yaw = +90 deg faces -X,
 * west). So as the player turns left, yaw increases and their forward swings
 * north -> west -> south -> east, i.e. CCW. For a compass-style ring to keep
 * "forward" pointing at screen-up, the ring (which represents WORLD-fixed
 * directions) must rotate the opposite way — clockwise — by the same amount.
 * CSS `rotate(deg)` is clockwise-positive, so the mapping is the identity:
 * rotate the ring by `+yawDeg`.
 */
export function ringRotationDeg(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  return (yaw * 180) / Math.PI;
}

const RING_SIDES: readonly Side[] = ['north', 'east', 'south', 'west'];

/**
 * Segment id -> which side of the square it renders on. Mirrors map.ts's
 * frozen, clockwise-from-NW ordering exactly: 0-3 north, 4-7 east, 8-11
 * south, 12-15 west.
 */
export function ringSide(id: SegmentId): Side {
  const i = Math.floor(id / 4) % RING_SIDES.length;
  return RING_SIDES[((i % RING_SIDES.length) + RING_SIDES.length) % RING_SIDES.length] ?? 'north';
}

/** 0..3, the tick's position along its own side (ascending id order). */
export function ringIndexOnSide(id: SegmentId): number {
  return ((id % 4) + 4) % 4;
}

/**
 * 0..1 of a downed survivor's OWN bleedout window remaining — 1 = just went
 * down, 0 = about to die. `bleedoutSec` is the wire's countdown; the full
 * window is the frozen DOWNED.bleedoutSec.
 */
export function bleedoutRemaining01(bleedoutSec: number): number {
  return clamp01(bleedoutSec / DOWNED.bleedoutSec);
}

/** Ceiling, not round — showing "0s" one tick before death reads as a lie. */
export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0s';
  return `${Math.ceil(sec)}s`;
}

export function formatDistance(m: number): string {
  if (!Number.isFinite(m) || m < 0) return '0m';
  return `${Math.round(m)}m`;
}

/** mm:ss, for the intermission countdown. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${ss < 10 ? '0' : ''}${ss}`;
}

export interface AmmoText {
  magText: string;
  resText: string;
  melee: boolean;
  /** UX_BIBLE: "a distinct empty-reserve state... a go to the crate signal". */
  emptyReserve: boolean;
}

/** mag/reserve are -1 for melee (types.ts). */
export function ammoText(mag: number, reserve: number): AmmoText {
  if (mag === -1) return { magText: '—', resText: '—', melee: true, emptyReserve: false };
  return {
    magText: String(Math.max(0, Math.trunc(mag))),
    resText: String(Math.max(0, Math.trunc(reserve))),
    melee: false,
    emptyReserve: reserve <= 0,
  };
}

export interface InteractPromptText {
  verb: string;
  costLabel: string | null;
}

const INTERACT_VERB: Record<Exclude<InteractKind, 'none'>, string> = {
  repair: 'REPAIR',
  revive: 'REVIVE',
  weaponRack: 'WEAPON RACK',
  ammoCrate: 'RESUPPLY',
};

/**
 * "HOLD E — REPAIR (112 SCRAP)" — never a bare "Press E" (UX_BIBLE tier 2).
 * `null` for `'none'`: no interactable in range.
 */
export function interactPrompt(kind: InteractKind, cost: number): InteractPromptText | null {
  if (kind === 'none') return null;
  return {
    verb: INTERACT_VERB[kind],
    costLabel: cost > 0 ? `${Math.round(cost)} SCRAP` : null,
  };
}

export function canAfford(scrap: number, cost: number): boolean {
  return cost <= 0 || scrap >= cost;
}

type TickerKind = HudState['ticker'][number]['kind'];

/** Wave and breach outrank kills (UX_BIBLE) — carried here as colour weight;
 *  ORDER on screen is whatever the caller already trimmed the array to. */
const TICKER_COLOR: Record<TickerKind, PaletteKey> = {
  breach: 'downedRed',
  down: 'downedRed',
  wave: 'hudAccent',
  revive: 'reviveCyan',
  kill: 'hudText',
};

export function tickerColorKey(kind: TickerKind): PaletteKey {
  return TICKER_COLOR[kind];
}

/** 0..1 "how bad was that hit" for the pain flash, scaled to a survivor's own
 *  max HP so a near-half-health hit maxes out the response. */
const PAIN_FULL_DMG = SURVIVOR.maxHp * 0.45;
export function damageSeverity01(dmg: number): number {
  if (!Number.isFinite(dmg) || dmg <= 0) return 0;
  return Math.min(1, dmg / PAIN_FULL_DMG);
}

/** Screen rotation (deg) for a damage-direction arc, same convention as the
 *  fence ring: yawRelative 0 = straight ahead (12 o'clock), clockwise-positive. */
export function arcRotationDeg(yawRelative: number): number {
  if (!Number.isFinite(yawRelative)) return 0;
  return (yawRelative * 180) / Math.PI;
}

const LOW_HP_FRAC = 0.3;
const LOWHP_FLOOR_FRAC = 0.08;
const LOW_HP = SURVIVOR.maxHp * LOW_HP_FRAC;
const LOWHP_FLOOR = SURVIVOR.maxHp * LOWHP_FLOOR_FRAC;

/** 0..1 strength of the persistent low-HP screen edge; 1 at/below the floor. */
export function lowHpIntensity01(hp: number): number {
  if (!Number.isFinite(hp)) return 0;
  if (hp >= LOW_HP) return 0;
  if (hp <= LOWHP_FLOOR) return 1;
  return (LOW_HP - hp) / (LOW_HP - LOWHP_FLOOR);
}

/** Run-end scoreboard order: kills desc, damage desc as the tiebreak. Not
 *  specified server-side (unlike STRICKEN's MatchStatRow), so this is where
 *  the order is decided — presentation-only, changes nothing about the data. */
export function sortedRunStats(stats: readonly RunStats[]): RunStats[] {
  return [...stats].sort((a, b) => b.kills - a.kills || b.damage - a.damage);
}

/** Downed teammates nearest-first — "findable on the far side of the tower"
 *  means the closest, most-relevant one reads first. */
export function sortedDowned(downed: HudState['downed']): HudState['downed'] {
  return [...downed].sort((a, b) => a.dist - b.dist);
}

export function weaponLabel(id: string): string {
  return id.toUpperCase();
}

export function phaseLabel(phase: HudState['phase']): string {
  switch (phase) {
    case 'lobby': return 'LOBBY';
    case 'wave': return 'WAVE';
    case 'intermission': return 'INTERMISSION';
    case 'ended': return 'RUN ENDED';
    default: return '';
  }
}

/** '#rrggbb' -> 'rgba(r,g,b,a)'. Still a PALETTE colour, just translucent. */
export function alpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ---------------------------------------------------------------------------
// DOM plumbing
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function span(cls: string, text?: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  if (text !== undefined) s.textContent = text;
  return s;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
}

/** Small inline glyph: one or more filled paths in a 24x24 box. */
function glyph(paths: readonly string[], cls: string): SVGSVGElement {
  const s = svgEl('svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = svgEl('path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'currentColor');
    s.appendChild(p);
  }
  return s;
}

const ICON_HP = 'M8.6 2h6.8v6.6H22v6.8h-6.6V22H8.6v-6.6H2V8.6h6.6z';
const ICON_SCRAP = 'M12 2l9 5v10l-9 5-9-5V7z M12 6.6L6.4 9.8v6.4L12 19.4l5.6-3.2V9.8z';
const ICON_WARN = 'M11 8h2v6.5h-2z M11 16h2v2h-2z';
const ICON_BREACH = 'M4 4l7 7-7 7 2 2 7-7 7 7 2-2-7-7 7-7-2-2-7 7-7-7z';
const ICON_CHEVRON = 'M12 3 3 21h18z';
const ICON_PLAY = 'M6 3l15 9-15 9z';
const ICON_WAIT = 'M3 9h6v6H3z M15 9h6v6h-6z';

const STYLE_ID = 'outpost-hud-style';

// ---------------------------------------------------------------------------
// CSS. `.oh-panel` is the value-ladder card every cluster sits on: a lit rim,
// a charcoal->ink gradient face, a deep contact edge — the 2D restatement of
// the same 4-tier ladder the STYLE_BIBLE mandates for 3D surfaces. `.oh-bar`
// is the matching sunken meter. `.oh-hidden` is the ONE hidden-state class —
// rects() relies on hidden elements measuring 0x0.
// ---------------------------------------------------------------------------
const CSS = `
.oh-layer, .oh-layer * { pointer-events: none; box-sizing: border-box; margin: 0; padding: 0; }
.oh-layer {
  position: absolute; inset: 0; overflow: hidden;
  font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  color: var(--oh-text); text-shadow: 0 1px 3px var(--oh-ink);
  user-select: none; -webkit-user-select: none;
  font-variant-numeric: tabular-nums;
}
.oh-hidden { display: none !important; }

.oh-panel {
  position: relative; overflow: hidden; border-radius: 4px;
  background: linear-gradient(180deg, var(--oh-surf-a) 0%, var(--oh-surf-b) 100%);
  border: 1px solid var(--oh-edge);
  box-shadow: 0 2px 10px var(--oh-shade), inset 0 1px 0 var(--oh-rim-hi), inset 0 -2px 0 var(--oh-deep);
}
.oh-bar { position: relative; overflow: hidden; border-radius: 2px; background: var(--oh-track);
  box-shadow: inset 0 1px 2px var(--oh-deep), inset 0 0 0 1px var(--oh-edge); }
.oh-fill { height: 100%; border-radius: 2px; transition: width 120ms linear;
  box-shadow: inset 0 1px 0 var(--oh-rim-hi), inset 0 -2px 0 var(--oh-deep); }

/* ---- fence ring: the signature element ------------------------------------ */
.oh-ring { position: absolute; left: 50%; top: 10px; transform: translateX(-50%);
  width: 152px; height: 152px; }
.oh-ring-rotor { position: absolute; inset: 0; transition: transform 90ms linear; }
.oh-ring-side { position: absolute; display: flex; gap: 2px; }
.oh-ring-side.n { top: 0; left: 22px; right: 22px; height: 20px; flex-direction: row; }
.oh-ring-side.s { bottom: 0; left: 22px; right: 22px; height: 20px; flex-direction: row-reverse; }
.oh-ring-side.e { right: 0; top: 22px; bottom: 22px; width: 20px; flex-direction: column; }
.oh-ring-side.w { left: 0; top: 22px; bottom: 22px; width: 20px; flex-direction: column-reverse; }
.oh-tick { position: relative; flex: 1; align-self: stretch; overflow: hidden; border-radius: 2px;
  background: var(--oh-track); box-shadow: inset 0 0 0 1px var(--oh-edge); }
.oh-tick-fill { position: absolute; left: 0; right: 0; bottom: 0; transition: height 160ms ease-out; }
.oh-tick-icon { position: absolute; inset: 0; margin: auto; width: 12px; height: 12px;
  color: var(--oh-ink); opacity: 0; }
.oh-tick.dmg .oh-tick-icon, .oh-tick.brch .oh-tick-icon { opacity: 1; }
.oh-tick.brch { animation: oh-breachpulse 900ms ease-in-out infinite; }
@keyframes oh-breachpulse {
  0%, 100% { box-shadow: inset 0 0 0 1px var(--oh-edge), 0 0 0 0 var(--oh-danger-glow); }
  50% { box-shadow: inset 0 0 0 1px var(--oh-text), 0 0 10px 3px var(--oh-danger-glow); }
}
.oh-ring-corner { position: absolute; width: 20px; height: 20px; border: 1px solid var(--oh-rim); }
.oh-ring-corner.nw { top: 0; left: 0; border-right: none; border-bottom: none; }
.oh-ring-corner.ne { top: 0; right: 0; border-left: none; border-bottom: none; }
.oh-ring-corner.sw { bottom: 0; left: 0; border-right: none; border-top: none; }
.oh-ring-corner.se { bottom: 0; right: 0; border-left: none; border-top: none; }
.oh-ring-pointer { position: absolute; left: 50%; top: -7px; width: 0; height: 0;
  transform: translateX(-50%); border-left: 6px solid transparent; border-right: 6px solid transparent;
  border-top: 8px solid var(--oh-accent); filter: drop-shadow(0 1px 2px var(--oh-ink)); }

/* ---- top-left: phase/wave chip --------------------------------------------- */
.oh-wave { position: absolute; left: 14px; top: 14px; padding: 7px 12px; min-width: 128px; }
.oh-wave-phase { font-size: 10px; font-weight: 800; letter-spacing: 2.4px; color: var(--oh-text-mute); }
.oh-wave-num { font-size: 20px; font-weight: 800; letter-spacing: 0.5px; line-height: 1.2; }
.oh-wave-sub { font-size: 11px; font-weight: 700; color: var(--oh-text-dim); margin-top: 2px; }
.oh-wave.urgent .oh-wave-sub { color: var(--oh-danger); animation: oh-pulse 1s ease-in-out infinite; }

/* ---- top-right: scrap chip -------------------------------------------------- */
.oh-scrap { position: absolute; right: 14px; top: 14px; padding: 7px 14px;
  display: flex; align-items: center; gap: 8px; }
.oh-scrap-ico { width: 18px; height: 18px; color: var(--oh-scrap); flex: none; }
.oh-scrap-num { font-size: 20px; font-weight: 800; letter-spacing: 0.5px; color: var(--oh-scrap); }

/* ---- ticker: wave/breach outrank kills (colour weight only; ORDER is the
   caller's) -------------------------------------------------------------- */
.oh-ticker { position: absolute; left: 14px; top: 78px; width: 236px;
  display: flex; flex-direction: column; gap: 4px; }
.oh-ticker-row { padding: 4px 9px; font-size: 12px; font-weight: 700; border-left: 3px solid var(--oh-rim);
  animation: oh-rowin 180ms ease-out; }

/* ---- bottom-left: HP + status ------------------------------------------- */
.oh-hp { position: absolute; left: 26px; bottom: 26px; padding: 10px 14px; min-width: 200px; }
.oh-hp-row { display: flex; align-items: center; gap: 9px; }
.oh-hp-ico { width: 19px; height: 19px; color: var(--oh-text); opacity: 0.85; flex: none; }
.oh-hp-num { font-size: 38px; font-weight: 800; line-height: 0.86; letter-spacing: -1px; }
.oh-hp-unit { font-size: 11px; font-weight: 700; letter-spacing: 2px; color: var(--oh-text-mute);
  align-self: flex-end; padding-bottom: 3px; }
.oh-hp-tag { margin-left: auto; font-size: 10px; font-weight: 800; letter-spacing: 2px; padding: 2px 6px;
  border-radius: 2px; color: var(--oh-text); background: var(--oh-danger-glow); border: 1px solid var(--oh-danger);
  animation: oh-pulse 1.05s ease-in-out infinite; }
.oh-hp-bar { width: 200px; height: 8px; margin-top: 8px; }
.oh-hp-fill { background: var(--oh-hp); }
.oh-hp.low .oh-hp-fill { background: var(--oh-danger); }
.oh-hp.low .oh-hp-ico { color: var(--oh-danger); opacity: 1; }

/* ---- downed-self: bleedout ring replaces the HP bar ---------------------- */
.oh-down-self { margin-top: 9px; display: flex; align-items: center; gap: 10px; }
.oh-down-ring { width: 46px; height: 46px; flex: none; }
.oh-down-ring circle { fill: none; stroke-width: 5; }
.oh-down-track { stroke: var(--oh-track); }
.oh-down-prog { stroke: var(--oh-downed); stroke-linecap: round; transform-origin: center;
  transform: rotate(-90deg); transition: stroke-dashoffset 200ms linear; }
.oh-down-num { fill: var(--oh-text); font-size: 14px; font-weight: 800; text-anchor: middle; }
.oh-down-text { font-size: 12px; font-weight: 800; letter-spacing: 0.6px; line-height: 1.4; }
.oh-down-title { color: var(--oh-downed); letter-spacing: 1.6px; }
.oh-down-help { color: var(--oh-text-dim); }

/* ---- bottom-right: ammo -------------------------------------------------- */
.oh-ammo { position: absolute; right: 26px; bottom: 26px; padding: 10px 14px;
  display: flex; flex-direction: column; align-items: flex-end; min-width: 150px; }
.oh-wname { font-size: 12px; font-weight: 700; letter-spacing: 2.2px; color: var(--oh-text-dim); }
.oh-magline { display: flex; align-items: baseline; gap: 7px; line-height: 0.9; margin-top: 4px; }
.oh-mag { font-size: 40px; font-weight: 800; letter-spacing: -1px; }
.oh-mag.empty { color: var(--oh-danger); }
.oh-res { font-size: 16px; font-weight: 700; color: var(--oh-text-mute); }
.oh-resupply { margin-top: 6px; font-size: 10px; font-weight: 800; letter-spacing: 1.8px; padding: 2px 7px;
  color: var(--oh-text); background: var(--oh-danger-glow); border: 1px solid var(--oh-danger); border-radius: 2px;
  animation: oh-pulse 1.05s ease-in-out infinite; }

/* ---- downed teammates panel ----------------------------------------------- */
.oh-downpanel { position: absolute; right: 14px; top: 172px; width: 208px;
  display: flex; flex-direction: column; gap: 4px; }
.oh-downrow { display: flex; align-items: center; gap: 8px; padding: 5px 9px; }
.oh-downrow-chev { width: 12px; height: 12px; color: var(--oh-revive); flex: none; }
.oh-downrow-name { flex: 1 1 auto; min-width: 0; font-size: 12px; font-weight: 800; color: var(--oh-revive);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oh-downrow-dist { font-size: 11px; font-weight: 700; color: var(--oh-text-dim); }
.oh-downrow-bl { font-size: 13px; font-weight: 800; color: var(--oh-revive); min-width: 26px; text-align: right; }
.oh-downrow.beingrev { box-shadow: inset 3px 0 0 var(--oh-revive); }

/* ---- interact prompt: verb + key + cost + progress ring -------------------
   Never in the centre 40% except this ring + the crosshair (UX_BIBLE). */
.oh-interact { position: absolute; left: 50%; bottom: 132px; transform: translateX(-50%);
  padding: 8px 16px 8px 10px; display: flex; align-items: center; gap: 10px; white-space: nowrap; }
.oh-interact-ring { width: 30px; height: 30px; flex: none; }
.oh-interact-ring circle { fill: none; stroke-width: 4; }
.oh-interact-track { stroke: var(--oh-track); }
.oh-interact-prog { stroke: var(--oh-accent); stroke-linecap: round; transform-origin: center;
  transform: rotate(-90deg); transition: stroke-dashoffset 80ms linear; }
.oh-interact-txt { font-size: 13px; font-weight: 800; letter-spacing: 1.2px; }
.oh-interact-key { font-size: 10px; font-weight: 800; padding: 0 5px; border: 1px solid currentColor;
  border-radius: 2px; opacity: 0.8; margin: 0 2px; }
.oh-interact-cost { font-weight: 800; color: var(--oh-scrap); }
.oh-interact.deny .oh-interact-cost { color: var(--oh-danger); animation: oh-pulse 0.6s ease-in-out 2; }

/* ---- crosshair + scope ------------------------------------------------------ */
.oh-cross { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.oh-cross div { position: absolute; left: 0; top: 0; background: var(--oh-text); box-shadow: 0 0 0 1px var(--oh-ink); }
.oh-ch-t, .oh-ch-b { width: 2px; height: 9px; }
.oh-ch-l, .oh-ch-r { width: 9px; height: 2px; }
.oh-scope { position: absolute; inset: 0; }
.oh-scope-vig { position: absolute; inset: 0; background: radial-gradient(circle at 50% 50%,
  transparent 0, transparent 23vmin, var(--oh-scope-soft) 25.6vmin, var(--oh-scope-ink) 28vmin, var(--oh-scope-ink) 100%); }
.oh-scope-ring { position: absolute; left: 50%; top: 50%; width: 50vmin; height: 50vmin;
  transform: translate(-50%, -50%); border-radius: 50%; border: 1px solid var(--oh-scope-line); }
.oh-scope-dot { position: absolute; left: 50%; top: 50%; width: 2px; height: 2px;
  transform: translate(-50%, -50%); border-radius: 50%; background: var(--oh-text); }

/* ---- hitmarker + kill ring -------------------------------------------------- */
.oh-hit { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; }
.oh-hit.on { animation: oh-hitflash 130ms ease-out forwards; }
.oh-hit.on.kill { animation: oh-killpop 210ms ease-out forwards; }
.oh-hit div { position: absolute; left: -1px; top: -13px; width: 2px; height: 8px;
  background: var(--oh-text); box-shadow: 0 0 0 1px var(--oh-ink); }
.oh-hit.red div { background: var(--oh-danger); }
.oh-hit .h1 { transform: rotate(45deg) translateY(-6px); }
.oh-hit .h2 { transform: rotate(135deg) translateY(-6px); }
.oh-hit .h3 { transform: rotate(225deg) translateY(-6px); }
.oh-hit .h4 { transform: rotate(315deg) translateY(-6px); }
@keyframes oh-hitflash { 0% { opacity:1; transform:scale(.82);} 35%{opacity:1;transform:scale(1.05);} 72%{opacity:1;} 100%{opacity:0;} }
@keyframes oh-killpop { 0%{opacity:1;transform:scale(.9);} 35%{opacity:1;transform:scale(1.4);} 80%{opacity:1;transform:scale(1.1);} 100%{opacity:0;transform:scale(1.15);} }
.oh-kring { position: absolute; left: 50%; top: 50%; width: 44px; height: 44px;
  border: 2px solid var(--oh-danger); border-radius: 50%; opacity: 0; box-shadow: 0 0 8px 1px var(--oh-danger-glow); }
.oh-kring.on { animation: oh-ringpulse 360ms cubic-bezier(.16,1,.3,1) forwards; }
@keyframes oh-ringpulse { 0%{opacity:.95;transform:translate(-50%,-50%) scale(.4);} 100%{opacity:0;transform:translate(-50%,-50%) scale(1.6);} }

/* ---- damage direction ring (pooled arcs) ------------------------------------ */
.oh-dmg { position: absolute; left: 50%; top: 50%; width: 160px; height: 160px; transform: translate(-50%,-50%); }
.oh-arc { opacity: 0; }
.oh-arc.on { animation: oh-arcfade 800ms linear forwards; }
@keyframes oh-arcfade { 0%{opacity:.45;} 8%{opacity:1;} 55%{opacity:.95;} 100%{opacity:0;} }

/* ---- pain flash / low-hp edge / spectate vignette --------------------------- */
.oh-pain { position: absolute; inset: 0; opacity: 0; background: radial-gradient(ellipse closest-side at 50% 50%,
  transparent 0, transparent 28%, var(--oh-danger-glow) 62%, var(--oh-danger) 100%); }
.oh-pain.on { animation: oh-painfade 420ms ease-out forwards; }
@keyframes oh-painfade { 0%{opacity:0;} 12%{opacity:var(--oh-pain-a,.3);} 100%{opacity:0;} }
.oh-low { position: absolute; inset: 0; opacity: calc(var(--oh-low-a, 0) * 0.55); transition: opacity 220ms linear;
  background: radial-gradient(ellipse closest-side at 50% 50%, transparent 0, transparent 42%, var(--oh-danger-glow) 100%); }
.oh-low.pulse { animation: oh-lowpulse 1100ms ease-in-out infinite; }
@keyframes oh-lowpulse { 0%,100%{filter:brightness(.66);} 50%{filter:brightness(1.3);} }
.oh-vig { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 50%, transparent 0, transparent 40%, var(--oh-ink-70) 100%); }
.oh-spec { position: absolute; left: 50%; bottom: 15%; transform: translateX(-50%); padding: 8px 18px;
  font-size: 14px; font-weight: 700; letter-spacing: 2px; white-space: nowrap; }

/* ---- banner / teammate-down toasts ------------------------------------------- */
.oh-banner { position: absolute; left: 50%; top: 176px; transform: translateX(-50%);
  text-align: center; opacity: 0; transition: opacity 340ms ease; padding: 13px 38px 15px; white-space: nowrap; }
.oh-banner.on { opacity: 1; }
.oh-banner-t { font-size: 32px; font-weight: 800; letter-spacing: 3.5px; }
.oh-banner-s { font-size: 12px; font-weight: 700; letter-spacing: 2px; color: var(--oh-text-dim); margin-top: 5px; }
.oh-toasts { position: absolute; left: 50%; top: 236px; transform: translateX(-50%);
  display: flex; flex-direction: column; gap: 6px; align-items: center; }
.oh-toast { padding: 6px 16px; font-size: 12px; font-weight: 800; letter-spacing: 1.4px; color: var(--oh-downed);
  border-left: 3px solid var(--oh-downed); white-space: nowrap; }

/* ---- lobby / start bar (lives IN the HUD, mirrors STRICKEN's warmup) --------- */
.oh-lobby { position: absolute; left: 50%; top: 172px; transform: translateX(-50%); width: min(420px, 82vw); }
.oh-lobby-head { padding: 8px 14px 6px; font-size: 10px; font-weight: 800; letter-spacing: 3px;
  color: var(--oh-text-mute); border-bottom: 1px solid var(--oh-edge); }
.oh-lobby-rows { padding: 6px 0; max-height: 220px; overflow: hidden; }
.oh-lobby-row { padding: 3px 14px; font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.oh-lobby-row .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--oh-hp); flex: none; }
.oh-lobby-bar { display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 10px 14px 12px; border-top: 1px solid var(--oh-edge); }
.oh-layer .oh-start-btn { pointer-events: auto; cursor: pointer; display: flex; align-items: center; gap: 9px;
  font-family: inherit; font-size: 13px; font-weight: 900; letter-spacing: 2.6px; padding: 9px 22px;
  border-radius: 3px; text-shadow: none; color: var(--oh-ink); border: 1px solid var(--oh-accent);
  background: linear-gradient(180deg, var(--oh-accent) 0%, var(--oh-accent-dim) 100%); }
.oh-layer .oh-start-btn[disabled] { cursor: default; color: var(--oh-text-mute); background: var(--oh-track);
  border-color: var(--oh-edge); text-shadow: 0 1px 3px var(--oh-ink); }
.oh-start-ico { width: 13px; height: 13px; flex: none; }
.oh-start-why { font-size: 10px; font-weight: 800; letter-spacing: 1.8px; color: var(--oh-text-dim); }

/* ---- scoreboard (TAB, on demand) --------------------------------------------- */
.oh-score { position: absolute; left: 50%; top: 60px; transform: translateX(-50%); width: min(560px, 88vw); z-index: 2; }
.oh-score-head { padding: 9px 16px; font-size: 11px; font-weight: 800; letter-spacing: 3px;
  color: var(--oh-text-mute); border-bottom: 1px solid var(--oh-edge); }
.oh-score-tbl { max-height: 60vh; overflow: hidden; }
.oh-score-row { display: grid; grid-template-columns: minmax(0,1fr) 44px 44px 64px; gap: 10px; align-items: center;
  padding: 5px 16px; font-size: 13px; font-weight: 700; }
.oh-score-row + .oh-score-row { border-top: 1px solid var(--oh-edge); }
.oh-score-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oh-score-num { text-align: right; font-weight: 800; }
.oh-score-state { font-size: 9px; font-weight: 800; letter-spacing: 1.2px; text-align: right; color: var(--oh-text-mute); }

/* ---- run-end stats panel ------------------------------------------------------ */
.oh-end { position: absolute; inset: 0; z-index: 4; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: radial-gradient(ellipse at 50% 46%, transparent 26%, var(--oh-ink-70) 100%), var(--oh-ink-92); }
.oh-end-panel { width: min(760px, 94vw); max-height: 92vh; overflow: hidden; display: flex; flex-direction: column; }
.oh-end-head { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 18px 18px 12px; }
.oh-end-eyebrow { font-size: 10px; font-weight: 800; letter-spacing: 3.4px; color: var(--oh-text-mute); }
.oh-end-title { font-size: 34px; font-weight: 900; letter-spacing: 4px; color: var(--oh-text); }
.oh-end-rule { align-self: stretch; height: 2px; margin: 6px 0 2px;
  background: linear-gradient(90deg, transparent, var(--oh-accent), transparent); }
.oh-end-tbl { --cols: minmax(0,1fr) 40px 44px 56px 56px 64px 60px; overflow-y: auto; border-top: 1px solid var(--oh-edge); }
.oh-end-row { display: grid; grid-template-columns: var(--cols); align-items: center; gap: 8px; padding: 5px 18px; }
.oh-end-hrow { background: var(--oh-track); border-bottom: 1px solid var(--oh-edge);
  font-size: 9px; font-weight: 800; letter-spacing: 1.6px; color: var(--oh-text-mute); }
.oh-end-num { text-align: right; font-weight: 800; font-size: 13px; }
.oh-end-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
.oh-end-row + .oh-end-row { border-top: 1px solid var(--oh-edge); }
.oh-end-foot { padding: 9px 18px 11px; text-align: center; font-size: 10px; font-weight: 800; letter-spacing: 2.2px;
  color: var(--oh-text-mute); background: var(--oh-track); border-top: 1px solid var(--oh-edge); }

@keyframes oh-pulse { 0%,100%{opacity:1;} 50%{opacity:.45;} }
@keyframes oh-rowin { from { transform: translateX(14px); opacity: 0; } to { transform: none; opacity: 1; } }
`;

const ARC_POOL = 8;
const DAMAGE_MS = 800;
const HITMARK_MS = 130;
const HITMARK_KILL_MS = 210;
const BANNER_MS = 2500;
const DOWN_RING_R = 18;
const DOWN_RING_C = 2 * Math.PI * DOWN_RING_R;
const INTERACT_RING_R = 12;
const INTERACT_RING_C = 2 * Math.PI * INTERACT_RING_R;

interface TickRefs {
  root: HTMLDivElement;
  fill: HTMLDivElement;
  icon: SVGSVGElement;
  iconPath: SVGPathElement;
  lastPct: number;
  lastState: TickState;
}

interface DownedRow {
  root: HTMLDivElement;
  name: HTMLDivElement;
  dist: HTMLSpanElement;
  bl: HTMLSpanElement;
  lastDist: number;
  lastBl: number;
  lastBeingRev: boolean;
}

export class Hud implements HudApi {
  private readonly layer: HTMLDivElement;
  private shown = true;

  // fence ring
  private readonly ringRotor: HTMLDivElement;
  private readonly ticks: TickRefs[] = [];
  private lastYawDeg = Number.NaN;

  // wave/scrap chips + ticker
  private readonly waveEl: HTMLDivElement;
  private readonly wavePhaseEl: HTMLDivElement;
  private readonly waveNumEl: HTMLDivElement;
  private readonly waveSubEl: HTMLDivElement;
  private readonly scrapEl: HTMLDivElement;
  private readonly scrapNumEl: HTMLSpanElement;
  private readonly tickerEl: HTMLDivElement;
  private lastTickerSig = '';

  // HP / downed-self
  private readonly hpWrap: HTMLDivElement;
  private readonly hpNum: HTMLDivElement;
  private readonly hpTag: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly downSelf: HTMLDivElement;
  private readonly downProg: SVGCircleElement;
  private readonly downNum: SVGTextElement;
  private readonly downHelp: HTMLDivElement;

  // ammo
  private readonly ammoWrap: HTMLDivElement;
  private readonly wnameEl: HTMLDivElement;
  private readonly magEl: HTMLSpanElement;
  private readonly resEl: HTMLSpanElement;
  private readonly resupplyEl: HTMLDivElement;

  // downed teammates panel
  private readonly downPanel: HTMLDivElement;
  private readonly downRows = new Map<PlayerId, DownedRow>();

  // interact prompt
  private readonly interactEl: HTMLDivElement;
  private readonly interactProg: SVGCircleElement;
  private readonly interactTxt: HTMLSpanElement;

  // crosshair / scope
  private readonly cross: HTMLDivElement;
  private readonly chT: HTMLDivElement;
  private readonly chB: HTMLDivElement;
  private readonly chL: HTMLDivElement;
  private readonly chR: HTMLDivElement;
  private readonly scope: HTMLDivElement;

  // hitmarker
  private readonly hit: HTMLDivElement;
  private readonly kring: HTMLDivElement;

  // damage arcs
  private readonly arcs: SVGGElement[] = [];
  private readonly arcRots: SVGGElement[] = [];
  private arcNext = 0;

  // pain / low-hp / spectate
  private readonly pain: HTMLDivElement;
  private readonly low: HTMLDivElement;
  private cLowA = -1;
  private readonly vig: HTMLDivElement;
  private readonly specEl: HTMLDivElement;

  // banner + teammate-down toasts
  private readonly bannerEl: HTMLDivElement;
  private readonly bannerT: HTMLDivElement;
  private readonly bannerS: HTMLDivElement;
  private bannerBusy = false;
  private readonly bannerQueue: { title: string; sub: string }[] = [];
  private readonly toastsEl: HTMLDivElement;
  private readonly toasts = new Map<PlayerId, HTMLDivElement>();

  // lobby + START
  private readonly lobbyEl: HTMLDivElement;
  private readonly lobbyRows: HTMLDivElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly startGo: SVGSVGElement;
  private readonly startWait: SVGSVGElement;
  private readonly startWhy: HTMLDivElement;
  onStart: (() => void) | null = null;

  // scoreboard (TAB, self-hosted since HudApi has no dedicated toggle)
  private readonly scoreEl: HTMLDivElement;
  private readonly scoreTbl: HTMLDivElement;
  private scoreboardOn = false;
  private lastSquadSig = '';
  private readonly onTabDown = (e: KeyboardEvent): void => {
    if (e.code !== 'Tab') return;
    e.preventDefault();
    if (!this.scoreboardOn) { this.scoreboardOn = true; this.scoreEl.classList.remove('oh-hidden'); }
  };
  private readonly onTabUp = (e: KeyboardEvent): void => {
    if (e.code !== 'Tab') return;
    this.scoreboardOn = false;
    this.scoreEl.classList.add('oh-hidden');
  };

  // run-end
  private readonly endEl: HTMLDivElement;
  private readonly endTitle: HTMLDivElement;
  private readonly endTbl: HTMLDivElement;

  // change-detection cache
  private cHp = -1;
  private cLow = false;
  private cStatus: HudState['status'] | '' = '';
  private cBleedout = -1;
  private cOwnReviveBy: string | null | undefined = undefined;
  private cScrap = -1;
  private cWeaponName = '';
  private cMag = -2;
  private cRes = -2;
  private cPhase: HudState['phase'] | '' = '';
  private cWave = -1;
  private cWaveRemaining = -1;
  private cPhaseEndsInMs = -1;
  private cInteract: InteractKind | '' = '';
  private cInteractCostLabel: string | null | undefined = undefined;
  private cInteractProgPct = -1;
  private cInteractAfford: boolean | null = null;
  private cScoped = false;
  private cSpreadPx = -1;
  private cCanStart: boolean | null = null;
  private cSeated = -1;
  private cSpecTarget = '';
  private cSpecWave = -1;

  constructor(root: HTMLElement) {
    const st = root.style;
    st.setProperty('--oh-text', PALETTE.hudText);
    st.setProperty('--oh-text-dim', alpha(PALETTE.hudText, 0.62));
    st.setProperty('--oh-text-mute', alpha(PALETTE.hudText, 0.52));
    st.setProperty('--oh-accent', PALETTE.hudAccent);
    st.setProperty('--oh-accent-dim', alpha(PALETTE.hudAccent, 0.72));
    st.setProperty('--oh-danger', PALETTE.danger);
    st.setProperty('--oh-danger-glow', alpha(PALETTE.danger, 0.34));
    st.setProperty('--oh-hp', PALETTE.hpGreen);
    st.setProperty('--oh-scrap', PALETTE.scrapGold);
    st.setProperty('--oh-revive', PALETTE.reviveCyan);
    st.setProperty('--oh-downed', PALETTE.downedRed);
    st.setProperty('--oh-ink', PALETTE.ink);
    st.setProperty('--oh-ink-70', alpha(PALETTE.ink, 0.72));
    st.setProperty('--oh-ink-92', alpha(PALETTE.ink, 0.92));
    st.setProperty('--oh-scope-ink', alpha(PALETTE.ink, 0.97));
    st.setProperty('--oh-scope-soft', alpha(PALETTE.ink, 0.55));
    st.setProperty('--oh-scope-line', alpha(PALETTE.hudText, 0.5));
    st.setProperty('--oh-surf-a', alpha(PALETTE.charcoal, 0.86));
    st.setProperty('--oh-surf-b', alpha(PALETTE.ink, 0.92));
    st.setProperty('--oh-shade', alpha(PALETTE.ink, 0.55));
    st.setProperty('--oh-deep', alpha(PALETTE.ink, 0.9));
    st.setProperty('--oh-track', alpha(PALETTE.ink, 0.72));
    st.setProperty('--oh-rim', alpha(PALETTE.hudText, 0.16));
    st.setProperty('--oh-rim-hi', alpha(PALETTE.hudText, 0.26));
    st.setProperty('--oh-edge', alpha(PALETTE.hudText, 0.09));

    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    this.layer = div('oh-layer');
    root.appendChild(this.layer);

    // ---- fence ring ----
    const ring = div('oh-ring');
    this.ringRotor = div('oh-ring-rotor');
    const sideEls: Record<Side, HTMLDivElement> = {
      north: div('oh-ring-side n'),
      east: div('oh-ring-side e'),
      south: div('oh-ring-side s'),
      west: div('oh-ring-side w'),
    };
    for (let id = 0; id < FENCE.segments; id++) {
      const tickRoot = div('oh-tick');
      const fill = div('oh-tick-fill');
      const iconEl = svgEl('svg');
      iconEl.setAttribute('viewBox', '0 0 24 24');
      iconEl.setAttribute('class', 'oh-tick-icon');
      iconEl.setAttribute('aria-hidden', 'true');
      const iconPath = svgEl('path');
      iconPath.setAttribute('d', ICON_WARN);
      iconPath.setAttribute('fill', 'currentColor');
      iconEl.appendChild(iconPath);
      tickRoot.appendChild(fill);
      tickRoot.appendChild(iconEl);
      sideEls[ringSide(id)].appendChild(tickRoot);
      this.ticks.push({ root: tickRoot, fill, icon: iconEl, iconPath, lastPct: -1, lastState: 'intact' });
    }
    this.ringRotor.append(sideEls.north, sideEls.east, sideEls.south, sideEls.west);
    ring.appendChild(this.ringRotor);
    ring.append(
      div('oh-ring-corner nw'), div('oh-ring-corner ne'),
      div('oh-ring-corner sw'), div('oh-ring-corner se'),
    );
    const pointer = div('oh-ring-pointer');
    ring.appendChild(pointer);
    this.layer.appendChild(ring);

    // ---- wave chip ----
    this.waveEl = div('oh-wave oh-panel');
    this.wavePhaseEl = div('oh-wave-phase');
    this.waveNumEl = div('oh-wave-num');
    this.waveSubEl = div('oh-wave-sub');
    this.waveEl.append(this.wavePhaseEl, this.waveNumEl, this.waveSubEl);
    this.layer.appendChild(this.waveEl);

    // ---- scrap chip ----
    this.scrapEl = div('oh-scrap oh-panel');
    this.scrapNumEl = span('oh-scrap-num');
    this.scrapEl.append(glyph([ICON_SCRAP], 'oh-scrap-ico'), this.scrapNumEl);
    this.layer.appendChild(this.scrapEl);

    // ---- ticker ----
    this.tickerEl = div('oh-ticker');
    this.layer.appendChild(this.tickerEl);

    // ---- HP ----
    this.hpWrap = div('oh-hp oh-panel');
    const hpRow = div('oh-hp-row');
    this.hpNum = div('oh-hp-num');
    const hpUnit = div('oh-hp-unit', 'HP');
    this.hpTag = div('oh-hp-tag oh-hidden', 'LOW');
    hpRow.append(glyph([ICON_HP], 'oh-hp-ico'), this.hpNum, hpUnit, this.hpTag);
    const hpBar = div('oh-hp-bar oh-bar');
    this.hpFill = div('oh-hp-fill oh-fill');
    hpBar.appendChild(this.hpFill);
    // downed-self bleedout ring
    this.downSelf = div('oh-down-self oh-hidden');
    const downSvg = svgEl('svg');
    downSvg.setAttribute('viewBox', '0 0 46 46');
    downSvg.setAttribute('class', 'oh-down-ring');
    const downTrack = svgEl('circle');
    downTrack.setAttribute('class', 'oh-down-track');
    downTrack.setAttribute('cx', '23'); downTrack.setAttribute('cy', '23'); downTrack.setAttribute('r', String(DOWN_RING_R));
    this.downProg = svgEl('circle');
    this.downProg.setAttribute('class', 'oh-down-prog');
    this.downProg.setAttribute('cx', '23'); this.downProg.setAttribute('cy', '23'); this.downProg.setAttribute('r', String(DOWN_RING_R));
    this.downProg.setAttribute('stroke-dasharray', String(DOWN_RING_C));
    this.downNum = svgEl('text');
    this.downNum.setAttribute('class', 'oh-down-num');
    this.downNum.setAttribute('x', '23'); this.downNum.setAttribute('y', '28');
    downSvg.append(downTrack, this.downProg, this.downNum);
    const downText = div('oh-down-text');
    const downTitle = div('oh-down-title', 'DOWN — BLEEDING OUT');
    this.downHelp = div('oh-down-help');
    downText.append(downTitle, this.downHelp);
    this.downSelf.append(downSvg, downText);
    this.hpWrap.append(hpRow, hpBar, this.downSelf);
    this.layer.appendChild(this.hpWrap);

    // ---- ammo ----
    this.ammoWrap = div('oh-ammo oh-panel');
    this.wnameEl = div('oh-wname');
    const magline = div('oh-magline');
    this.magEl = span('oh-mag');
    this.resEl = span('oh-res');
    magline.append(this.magEl, this.resEl);
    this.resupplyEl = div('oh-resupply oh-hidden', 'RESUPPLY AT CRATE');
    this.ammoWrap.append(this.wnameEl, magline, this.resupplyEl);
    this.layer.appendChild(this.ammoWrap);

    // ---- downed teammates ----
    this.downPanel = div('oh-downpanel');
    this.layer.appendChild(this.downPanel);

    // ---- interact prompt ----
    this.interactEl = div('oh-interact oh-panel oh-hidden');
    const iSvg = svgEl('svg');
    iSvg.setAttribute('viewBox', '0 0 30 30');
    iSvg.setAttribute('class', 'oh-interact-ring');
    const iTrack = svgEl('circle');
    iTrack.setAttribute('class', 'oh-interact-track');
    iTrack.setAttribute('cx', '15'); iTrack.setAttribute('cy', '15'); iTrack.setAttribute('r', String(INTERACT_RING_R));
    this.interactProg = svgEl('circle');
    this.interactProg.setAttribute('class', 'oh-interact-prog');
    this.interactProg.setAttribute('cx', '15'); this.interactProg.setAttribute('cy', '15'); this.interactProg.setAttribute('r', String(INTERACT_RING_R));
    this.interactProg.setAttribute('stroke-dasharray', String(INTERACT_RING_C));
    iSvg.append(iTrack, this.interactProg);
    this.interactTxt = span('oh-interact-txt');
    this.interactEl.append(iSvg, this.interactTxt);
    this.layer.appendChild(this.interactEl);

    // ---- crosshair + scope ----
    this.cross = div('oh-cross');
    this.chT = div('oh-ch-t'); this.chB = div('oh-ch-b'); this.chL = div('oh-ch-l'); this.chR = div('oh-ch-r');
    this.cross.append(this.chT, this.chB, this.chL, this.chR);
    this.layer.appendChild(this.cross);
    this.scope = div('oh-scope oh-hidden');
    this.scope.append(div('oh-scope-vig'), div('oh-scope-ring'), div('oh-scope-dot'));
    this.layer.appendChild(this.scope);

    // ---- hitmarker ----
    this.hit = div('oh-hit');
    this.hit.append(div('h1'), div('h2'), div('h3'), div('h4'));
    this.layer.appendChild(this.hit);
    this.kring = div('oh-kring on');
    this.layer.appendChild(this.kring);

    // ---- damage arcs ----
    const dmgSvg = svgEl('svg');
    dmgSvg.setAttribute('viewBox', '0 0 160 160');
    dmgSvg.setAttribute('class', 'oh-dmg');
    for (let i = 0; i < ARC_POOL; i++) {
      const rot = svgEl('g');
      const anim = svgEl('g');
      anim.setAttribute('class', 'oh-arc');
      const p = svgEl('path');
      p.setAttribute('d', 'M 54.64 25.62 A 60 60 0 0 1 105.36 25.62');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', PALETTE.danger);
      p.setAttribute('stroke-width', '7');
      p.setAttribute('stroke-linecap', 'round');
      anim.appendChild(p);
      rot.appendChild(anim);
      dmgSvg.appendChild(rot);
      this.arcs.push(anim);
      this.arcRots.push(rot);
    }
    this.layer.appendChild(dmgSvg);

    // ---- pain / low-hp / spectate ----
    this.low = div('oh-low');
    this.layer.appendChild(this.low);
    this.pain = div('oh-pain');
    this.layer.appendChild(this.pain);
    this.vig = div('oh-vig oh-hidden');
    this.layer.appendChild(this.vig);
    this.specEl = div('oh-spec oh-panel oh-hidden');
    this.layer.appendChild(this.specEl);

    // ---- banner + toasts ----
    this.bannerEl = div('oh-banner oh-panel');
    this.bannerT = div('oh-banner-t');
    this.bannerS = div('oh-banner-s');
    this.bannerEl.append(this.bannerT, this.bannerS);
    this.layer.appendChild(this.bannerEl);
    this.toastsEl = div('oh-toasts');
    this.layer.appendChild(this.toastsEl);

    // ---- lobby + START ----
    this.lobbyEl = div('oh-lobby oh-panel oh-hidden');
    this.lobbyEl.appendChild(div('oh-lobby-head', 'AWAITING SQUAD'));
    this.lobbyRows = div('oh-lobby-rows');
    this.lobbyEl.appendChild(this.lobbyRows);
    const bar = div('oh-lobby-bar');
    this.startBtn = document.createElement('button');
    this.startBtn.type = 'button';
    this.startBtn.className = 'oh-start-btn';
    this.startGo = glyph([ICON_PLAY], 'oh-start-ico');
    this.startWait = glyph([ICON_WAIT], 'oh-start-ico oh-hidden');
    this.startBtn.append(this.startGo, this.startWait, span('', 'START'));
    this.startBtn.addEventListener('click', () => {
      if (this.startBtn.disabled) return;
      this.onStart?.();
    });
    this.startWhy = div('oh-start-why');
    bar.append(this.startBtn, this.startWhy);
    this.lobbyEl.appendChild(bar);
    this.layer.appendChild(this.lobbyEl);

    // ---- scoreboard ----
    this.scoreEl = div('oh-score oh-panel oh-hidden');
    this.scoreEl.appendChild(div('oh-score-head', 'SQUAD'));
    this.scoreTbl = div('oh-score-tbl');
    this.scoreEl.appendChild(this.scoreTbl);
    this.layer.appendChild(this.scoreEl);
    document.addEventListener('keydown', this.onTabDown);
    document.addEventListener('keyup', this.onTabUp);

    // ---- run-end ----
    this.endEl = div('oh-end oh-hidden');
    const endPanel = div('oh-end-panel oh-panel');
    const endHead = div('oh-end-head');
    this.endTitle = div('oh-end-title');
    endHead.append(div('oh-end-eyebrow', 'RUN ENDED'), this.endTitle, div('oh-end-rule'));
    this.endTbl = div('oh-end-tbl');
    endPanel.append(endHead, this.endTbl, div('oh-end-foot', 'THE LINE HELD UNTIL IT DID NOT'));
    this.endEl.appendChild(endPanel);
    this.layer.appendChild(this.endEl);
  }

  // -------------------------------------------------------------------------
  update(s: HudState): void {
    this.updateRing(s);
    this.updateWave(s);
    this.updateScrap(s);
    this.updateTicker(s);
    this.updateHp(s);
    this.updateAmmo(s);
    this.updateDownedPanel(s);
    this.updateInteract(s);
    this.updateCrosshair(s);
    this.updateLobby(s);
    this.updateSquad(s);
    this.updateSpectating(s);
  }

  private updateRing(s: HudState): void {
    const deg = Math.round(ringRotationDeg(s.yaw) * 2) / 2;
    if (deg !== this.lastYawDeg) {
      this.lastYawDeg = deg;
      this.ringRotor.style.transform = `rotate(${deg}deg)`;
    }
    for (let id = 0; id < FENCE.segments; id++) {
      const seg = s.segments[id];
      const t = this.ticks[id];
      if (!seg || !t) continue;
      const v = tickVisual(seg);
      const pct = Math.round(v.fill01 * 100);
      if (pct !== t.lastPct) {
        t.lastPct = pct;
        t.fill.style.height = `${pct}%`;
      }
      // colorKey is a pure function of state, so it only needs writing when
      // the state itself changes (never per-frame while hp merely drains).
      if (v.state !== t.lastState) {
        t.lastState = v.state;
        t.fill.style.background = PALETTE[v.colorKey];
        t.root.classList.toggle('dmg', v.state === 'damaged');
        t.root.classList.toggle('brch', v.state === 'breached');
        t.iconPath.setAttribute('d', v.state === 'breached' ? ICON_BREACH : ICON_WARN);
      }
    }
  }

  private updateWave(s: HudState): void {
    if (s.phase !== this.cPhase) {
      this.cPhase = s.phase;
      this.wavePhaseEl.textContent = phaseLabel(s.phase);
    }
    if (s.wave !== this.cWave) {
      this.cWave = s.wave;
      this.waveNumEl.textContent = s.phase === 'lobby' ? '—' : String(s.wave);
    }
    if (s.phase === 'intermission' && s.phaseEndsInMs > 0) {
      if (s.phaseEndsInMs !== this.cPhaseEndsInMs) {
        this.cPhaseEndsInMs = s.phaseEndsInMs;
        this.waveSubEl.textContent = `REPAIR / RESTOCK — ${formatCountdown(s.phaseEndsInMs)}`;
      }
      this.waveEl.classList.toggle('urgent', s.phaseEndsInMs < 5000);
    } else if (s.waveRemaining !== this.cWaveRemaining) {
      this.cWaveRemaining = s.waveRemaining;
      this.cPhaseEndsInMs = -1;
      this.waveSubEl.textContent = s.phase === 'lobby' ? 'NOT STARTED' : `${s.waveRemaining} REMAINING`;
      this.waveEl.classList.remove('urgent');
    }
  }

  private updateScrap(s: HudState): void {
    const scrap = Math.max(0, Math.round(s.scrap));
    if (scrap !== this.cScrap) {
      this.cScrap = scrap;
      this.scrapNumEl.textContent = String(scrap);
    }
  }

  private updateTicker(s: HudState): void {
    const sig = s.ticker.map((r) => `${r.kind}:${r.text}`).join('|');
    if (sig === this.lastTickerSig) return;
    this.lastTickerSig = sig;
    this.tickerEl.textContent = '';
    for (const row of s.ticker) {
      const el = div('oh-ticker-row oh-panel', row.text);
      const colorKey = tickerColorKey(row.kind);
      el.style.color = PALETTE[colorKey];
      el.style.borderLeftColor = PALETTE[colorKey];
      this.tickerEl.appendChild(el);
    }
  }

  private updateHp(s: HudState): void {
    const hp = Math.max(0, Math.round(s.hp));
    if (hp !== this.cHp) {
      this.cHp = hp;
      this.hpNum.textContent = String(hp);
      this.hpFill.style.width = `${clamp01(hp / SURVIVOR.maxHp) * 100}%`;
    }
    const low = hp > 0 && hp < LOW_HP;
    if (low !== this.cLow) {
      this.cLow = low;
      this.hpWrap.classList.toggle('low', low);
      this.hpTag.classList.toggle('oh-hidden', !low);
    }
    if (s.status !== this.cStatus) {
      this.cStatus = s.status;
      const downed = s.status === 'downed';
      this.downSelf.classList.toggle('oh-hidden', !downed);
    }
    if (s.status === 'downed') {
      const bl = Math.ceil(s.bleedout);
      if (bl !== this.cBleedout) {
        this.cBleedout = bl;
        this.downNum.textContent = formatSeconds(s.bleedout);
        const remain = bleedoutRemaining01(s.bleedout);
        this.downProg.setAttribute('stroke-dashoffset', String(DOWN_RING_C * (1 - remain)));
      }
      if (s.ownReviveBy !== this.cOwnReviveBy) {
        this.cOwnReviveBy = s.ownReviveBy;
        this.downHelp.textContent = s.ownReviveBy ? `${s.ownReviveBy} IS REVIVING YOU` : 'FIND HELP';
      }
    }
  }

  private updateAmmo(s: HudState): void {
    if (s.weaponName !== this.cWeaponName) {
      this.cWeaponName = s.weaponName;
      this.wnameEl.textContent = s.weaponName.toUpperCase();
    }
    const a = ammoText(s.mag, s.reserve);
    const magNum = a.melee ? -1 : Math.max(0, Math.trunc(s.mag));
    if (magNum !== this.cMag) {
      this.cMag = magNum;
      this.magEl.textContent = a.magText;
      this.magEl.classList.toggle('empty', !a.melee && magNum <= 0);
    }
    const resNum = a.melee ? -1 : Math.max(0, Math.trunc(s.reserve));
    if (resNum !== this.cRes) {
      this.cRes = resNum;
      this.resEl.textContent = a.resText;
      this.resupplyEl.classList.toggle('oh-hidden', !a.emptyReserve);
    }
  }

  private updateDownedPanel(s: HudState): void {
    const list = sortedDowned(s.downed);
    const seen = new Set<PlayerId>();
    for (const d of list) {
      seen.add(d.id);
      let row = this.downRows.get(d.id);
      if (!row) {
        const root = div('oh-downrow oh-panel');
        const name = div('oh-downrow-name');
        const distSpan = span('oh-downrow-dist');
        const blSpan = span('oh-downrow-bl');
        root.append(glyph([ICON_CHEVRON], 'oh-downrow-chev'), name, distSpan, blSpan);
        this.downPanel.appendChild(root);
        row = { root, name, dist: distSpan, bl: blSpan, lastDist: -1, lastBl: -1, lastBeingRev: false };
        this.downRows.set(d.id, row);
      }
      if (row.name.textContent !== d.name) row.name.textContent = d.name;
      const distM = Math.round(d.dist);
      if (distM !== row.lastDist) { row.lastDist = distM; row.dist.textContent = formatDistance(d.dist); }
      const blS = Math.ceil(d.bleedout);
      if (blS !== row.lastBl) { row.lastBl = blS; row.bl.textContent = String(Math.max(0, blS)); }
      if (d.beingRevived !== row.lastBeingRev) {
        row.lastBeingRev = d.beingRevived;
        row.root.classList.toggle('beingrev', d.beingRevived);
      }
    }
    for (const [id, row] of this.downRows) {
      if (!seen.has(id)) { row.root.remove(); this.downRows.delete(id); }
    }
  }

  private updateInteract(s: HudState): void {
    const prompt = interactPrompt(s.interact, s.interactCost);
    if (s.interact !== this.cInteract) {
      this.cInteract = s.interact;
      this.interactEl.classList.toggle('oh-hidden', prompt === null);
    }
    if (prompt === null) return;
    const costLabel = prompt.costLabel;
    const progPct = Math.round(s.interactProgress * 100);
    if (costLabel !== this.cInteractCostLabel || progPct !== this.cInteractProgPct) {
      this.cInteractCostLabel = costLabel;
      this.cInteractProgPct = progPct;
      this.interactTxt.textContent = '';
      this.interactTxt.append(
        span('oh-interact-key', 'HOLD E'),
        document.createTextNode(` — ${prompt.verb}`),
      );
      if (costLabel) this.interactTxt.append(span('oh-interact-cost', ` (${costLabel})`));
      this.interactProg.setAttribute(
        'stroke-dashoffset',
        String(INTERACT_RING_C * (1 - clamp01(s.interactProgress))),
      );
    }
    // UX_BIBLE: "Cannot afford: ... the cost flashes — never silence." No
    // dedicated deny event reaches HudState, so this is derived every frame
    // from data already on the wire (scrap vs. the cost the prompt quotes),
    // gated behind its own cache so the class is only toggled on a real edge.
    const afford = canAfford(s.scrap, s.interactCost);
    if (afford !== this.cInteractAfford) {
      this.cInteractAfford = afford;
      this.interactEl.classList.toggle('deny', !afford);
    }
  }

  private updateCrosshair(s: HudState): void {
    if (s.scoped !== this.cScoped) {
      this.cScoped = s.scoped;
      this.scope.classList.toggle('oh-hidden', !s.scoped);
      this.cross.classList.toggle('oh-hidden', s.scoped);
    }
    if (!s.scoped) {
      const spread = Math.round(s.crosshairSpreadPx);
      if (spread !== this.cSpreadPx) {
        this.cSpreadPx = spread;
        const gap = 4 + spread;
        this.chT.style.transform = `translateY(${-gap - 9}px)`;
        this.chB.style.transform = `translateY(${gap}px)`;
        this.chL.style.transform = `translateX(${-gap - 9}px)`;
        this.chR.style.transform = `translateX(${gap}px)`;
      }
    }
  }

  private updateLobby(s: HudState): void {
    const inLobby = s.phase === 'lobby';
    this.lobbyEl.classList.toggle('oh-hidden', !inLobby);
    if (!inLobby) return;
    if (s.canStart !== this.cCanStart || s.seated !== this.cSeated) {
      this.cCanStart = s.canStart;
      this.cSeated = s.seated;
      this.startBtn.disabled = !s.canStart;
      this.startGo.classList.toggle('oh-hidden', !s.canStart);
      this.startWait.classList.toggle('oh-hidden', s.canStart);
      this.startWhy.textContent = s.canStart
        ? 'READY'
        : `WAITING FOR PLAYERS (${s.seated}/${Math.max(MIN_PLAYERS, s.minPlayers)})`;
    }
  }

  private updateSquad(s: HudState): void {
    // Lobby roster (rebuilt on membership change)
    const lobbySig = s.squad.map((m) => m.id).join(',');
    if (this.lobbyRows.dataset['sig'] !== lobbySig) {
      this.lobbyRows.dataset['sig'] = lobbySig;
      this.lobbyRows.textContent = '';
      for (const m of s.squad) {
        const row = div('oh-lobby-row');
        row.append(div('dot'), span('', m.name));
        this.lobbyRows.appendChild(row);
      }
      if (s.squad.length === 0) this.lobbyRows.appendChild(div('oh-lobby-row', 'EMPTY'));
    }
    // Scoreboard (rebuilt whenever the live signature changes, regardless of
    // whether TAB is currently held, so it is ready the instant it is)
    const sig = s.squad.map((m) => `${m.id}:${m.status}:${m.kills}:${m.revives}`).join('|');
    if (sig === this.lastSquadSig) return;
    this.lastSquadSig = sig;
    this.scoreTbl.textContent = '';
    for (const m of s.squad) {
      const row = div('oh-score-row');
      row.append(
        div('oh-score-name', m.name),
        div('oh-score-num', String(m.kills)),
        div('oh-score-num', String(m.revives)),
        div('oh-score-state', m.status.toUpperCase()),
      );
      this.scoreTbl.appendChild(row);
    }
  }

  private updateSpectating(s: HudState): void {
    const spectating = s.status === 'dead' && s.spectating !== null;
    this.vig.classList.toggle('oh-hidden', !spectating);
    this.specEl.classList.toggle('oh-hidden', !spectating);
    if (!spectating || s.spectating === null) return;
    const target = s.squad.find((m) => m.id === s.spectating);
    const name = target ? target.name : 'SQUAD';
    if (name !== this.cSpecTarget || s.returnAtWave !== this.cSpecWave) {
      this.cSpecTarget = name;
      this.cSpecWave = s.returnAtWave;
      this.specEl.textContent = `SPECTATING ${name.toUpperCase()} — RETURNING WAVE ${s.returnAtWave}`;
    }
  }

  // -------------------------------------------------------------------------
  hitmarker(headshot: boolean, killed: boolean): void {
    this.hit.classList.remove('on', 'kill', 'red');
    // force reflow so the animation restarts on rapid repeated hits
    void this.hit.offsetWidth;
    this.hit.classList.add('on');
    if (headshot) this.hit.classList.add('red');
    if (killed) {
      this.hit.classList.add('kill');
      this.kring.classList.remove('on');
      void this.kring.offsetWidth;
      this.kring.classList.add('on');
    }
    window.setTimeout(() => this.hit.classList.remove('on'), killed ? HITMARK_KILL_MS : HITMARK_MS);
  }

  damageFrom(yawRelative: number, dmg: number): void {
    const sev = damageSeverity01(dmg);
    const i = this.arcNext;
    this.arcNext = (this.arcNext + 1) % ARC_POOL;
    const rot = this.arcRots[i];
    const anim = this.arcs[i];
    if (!rot || !anim) return;
    rot.setAttribute('transform', `rotate(${arcRotationDeg(yawRelative)} 80 80)`);
    anim.classList.remove('on');
    void anim.getBBox();
    anim.classList.add('on');

    const painA = 0.1 + sev * 0.42;
    this.pain.style.setProperty('--oh-pain-a', String(painA));
    this.pain.classList.remove('on');
    void this.pain.offsetWidth;
    if (sev > 0) this.pain.classList.add('on');
  }

  banner(title: string, sub: string): void {
    this.bannerQueue.push({ title, sub });
    this.drainBanner();
  }

  private drainBanner(): void {
    if (this.bannerBusy) return;
    const next = this.bannerQueue.shift();
    if (!next) return;
    this.bannerBusy = true;
    this.bannerT.textContent = next.title;
    this.bannerS.textContent = next.sub;
    this.bannerEl.classList.add('on');
    window.setTimeout(() => {
      this.bannerEl.classList.remove('on');
      window.setTimeout(() => {
        this.bannerBusy = false;
        this.drainBanner();
      }, 380);
    }, BANNER_MS);
  }

  teammateDown(id: PlayerId, name: string, on: boolean): void {
    if (!on) {
      this.toasts.get(id)?.remove();
      this.toasts.delete(id);
      return;
    }
    let el = this.toasts.get(id);
    if (!el) {
      el = div('oh-toast oh-panel');
      this.toastsEl.appendChild(el);
      this.toasts.set(id, el);
    }
    el.textContent = `${name.toUpperCase()} IS DOWN`;
  }

  runEnd(info: { wave: number; stats: readonly RunStats[] } | null): void {
    this.endEl.classList.toggle('oh-hidden', info === null);
    if (info === null) return;
    this.endTitle.textContent = `WAVE ${info.wave} — THE FENCE FELL`;
    this.endTbl.textContent = '';
    const head = div('oh-end-row oh-end-hrow');
    head.append(
      div('', 'SURVIVOR'), div('oh-end-num', 'K'), div('oh-end-num', 'HS'),
      div('oh-end-num', 'DMG'), div('oh-end-num', 'REPAIR'), div('oh-end-num', 'REVIVES'),
      div('oh-end-num', 'DOWNS'),
    );
    this.endTbl.appendChild(head);
    for (const r of sortedRunStats(info.stats)) {
      const row = div('oh-end-row');
      row.append(
        div('oh-end-name', r.name),
        div('oh-end-num', String(r.kills)),
        div('oh-end-num', String(r.headshots)),
        div('oh-end-num', String(Math.round(r.damage))),
        div('oh-end-num', String(Math.round(r.repairHp))),
        div('oh-end-num', String(r.revivesGiven)),
        div('oh-end-num', String(r.timesDowned)),
      );
      this.endTbl.appendChild(row);
    }
  }

  show(on: boolean): void {
    this.shown = on;
    this.layer.classList.toggle('oh-hidden', !on);
  }

  visible(): boolean {
    return this.shown;
  }

  rects(): readonly { x: number; y: number; w: number; h: number }[] {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const els = [
      this.ringRotor.parentElement, this.waveEl, this.scrapEl, this.tickerEl,
      this.hpWrap, this.ammoWrap, this.downPanel, this.interactEl, this.bannerEl,
      this.toastsEl, this.lobbyEl, this.scoreEl, this.endEl,
    ];
    const out: { x: number; y: number; w: number; h: number }[] = [];
    for (const el of els) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({ x: r.left * dpr, y: r.top * dpr, w: r.width * dpr, h: r.height * dpr });
    }
    return out;
  }
}
