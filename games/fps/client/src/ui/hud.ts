// ============================================================================
// C8 — HUD. DOM-based overlay, pointer-events none, layered. All colors trace
// to PALETTE (set as CSS custom props on the root); styling lives in the
// injected <style> block below. update() is on the render hot path: DOM is
// only touched when a cached value actually changes; zero allocation per
// frame (killfeed/banner are event-driven; damage arc groups, damage numbers
// and the kill ring come from fixed pools). Exports weaponIcon(): the
// procedural canvas weapon-glyph factory shared with the buy menu (C9).
//
// Depth model (VISUAL_UPGRADE.md §1 restated in CSS, §0 item 8 permits
// gradients/shadows/borders on 2D surfaces): every chip is a three-step value
// ladder — a lit rim, a charcoal->ink gradient face, and a deep contact edge —
// and every meter is a sunken track with a lit-capped fill. Corner scrims keep
// the vitals legible over snow and desert sand. No state is signalled by hue
// alone: each pairs colour with an icon, a tag, motion or position.
// ============================================================================
import { PALETTE, WEAPONS } from '@fps/shared';
import type { RoomPhase, Team, WeaponId } from '@fps/shared';

export interface HudState {
  hp: number; armor: number; alive: boolean; money: number; canBuy: boolean;
  weapon: WeaponId; weaponName: string; mag: number; reserve: number;
  phase: RoomPhase; phaseEndsInSec: number; round: number; scoreT: number; scoreCT: number;
  spreadPx: number; scoped: boolean;
  /** Convention: a string starting with 'respawn' is a self respawn countdown
   *  (rendered as-is); anything else is a spectate target name ('SPECTATING X'). */
  spectating: string | null;
}

const PHASE_LABEL: Record<RoomPhase, string> = {
  warmup: 'WARMUP', freeze: 'FREEZE', live: 'LIVE', roundEnd: 'ROUND END', matchEnd: 'MATCH END',
};

const LOW_HP = 30;          // below this: danger + pulse
const KILLFEED_MAX = 5;     // rows, newest on top
const KILLFEED_MS = 5000;   // visible time before fade+remove
const HITMARK_MS = 130;     // hitmarker flash (kill holds a touch longer)
const HITMARK_KILL_MS = 210;
const DAMAGE_MS = 800;      // directional arc fade
const DNUM_MS = 650;        // floating damage number rise+fade
const BANNER_MS = 2500;     // banner hold before fade
const ARC_POOL = 8;         // pooled damage arcs (rapid hits reuse)
const DNUM_POOL = 8;        // pooled floating damage numbers

// preset offsets (px from screen center) for pooled damage numbers — round-
// robin, so no rng and no per-spawn style string building beyond two vars
const DNUM_OFF: ReadonlyArray<readonly [number, number]> = [
  [-30, -36], [34, -32], [-44, -20], [46, -24], [-16, -46], [22, -44], [-38, -30], [40, -40],
];

// ============================================================================
// Procedural weapon glyphs — tiny canvas silhouettes, one per WeaponId, drawn
// from blocky fillRect paths (matches the flat-shaded art direction). Shared
// by the killfeed (scale 1) and the buy menu cards (scale 2). All colors
// trace to PALETTE. Allocation happens per event (killfeed row / menu open),
// never per frame.
// ============================================================================
const GLYPH_W = 44;
const GLYPH_H = 18;
const GLYPH_SS = 2; // supersample factor — crisp on retina
const THICK_W = 1.08; // glyph rect expansion — thicker silhouettes read smaller
const THICK_H = 1.24;

type Rects = ReadonlyArray<readonly [number, number, number, number]>;

// silhouettes on a 44x18 grid: body in hudText, detail in steel
const GLYPH_BODY: Record<WeaponId, Rects> = {
  knife: [
    [16, 6.5, 18, 3.5], // blade
    [34, 7.5, 7, 2], // blade tip taper
    [4, 6.5, 10, 3.5], // handle
  ],
  pistol: [
    [12, 5, 18, 4], // slide
    [12, 9, 15, 2], // frame
    [13, 11, 5, 6], // grip
    [30, 6, 2, 2], // muzzle
  ],
  smg: [
    [1, 7, 4, 4], // stock
    [5, 6, 19, 5], // receiver
    [24, 7.5, 11, 2], // barrel
    [35, 7, 4, 3], // muzzle
  ],
  shotgun: [
    [1, 7, 6, 5], // stock
    [7, 6.5, 9, 4], // receiver
    [16, 6.5, 26, 2.5], // barrel
    [16, 9.5, 22, 1.5], // mag tube
  ],
  rifle: [
    [0, 7, 5, 5], // stock
    [5, 6, 21, 4], // receiver + handguard
    [26, 7, 15, 1.8], // barrel
    [41, 6.5, 2, 2.6], // muzzle
  ],
  sniper: [
    [0, 7, 6, 5], // stock
    [6, 6.5, 22, 3.5], // body
    [28, 7.5, 14, 1.6], // barrel
    [42, 6.5, 2, 3], // muzzle brake
  ],
};

const GLYPH_DETAIL: Record<WeaponId, Rects> = {
  knife: [
    [14, 5.5, 2, 6], // guard
    [2.5, 6, 2, 4.5], // pommel
  ],
  pistol: [
    [19, 10.5, 6, 1.2], // trigger guard top
    [24, 10.5, 1.2, 3], // trigger guard front
    [13, 3.5, 2, 1.5], // front sight
  ],
  smg: [
    [13, 11, 4, 6.5], // mag
    [7.5, 11, 3, 4], // grip
    [9, 4.5, 6, 1.5], // top sight
  ],
  shotgun: [
    [22, 9, 8, 3], // pump
    [8, 10.5, 3, 4], // grip
  ],
  rifle: [
    [14, 10, 4, 5], // mag
    [15, 15, 3, 2], // mag curve
    [8, 10, 3, 5], // grip
    [6, 4.5, 2, 1.5], // rear sight
    [37, 5.5, 1.6, 1.5], // front sight
  ],
  sniper: [
    [11, 2.5, 9, 3.2], // scope tube
    [9.5, 3.5, 2, 1.6], // scope bell
    [13.5, 5.7, 1.6, 1.2], // mount a
    [17.5, 5.7, 1.6, 1.2], // mount b
    [14, 10, 3.5, 4], // mag
    [8, 10, 3, 4], // grip
  ],
};

/**
 * Draw a procedural silhouette icon for `id`. `scale` multiplies the logical
 * 44x18 size (killfeed 1, buy cards 2); the backing store is always
 * supersampled GLYPH_SSx for sharp edges. Rects are expanded around their own
 * centers (THICK_W/THICK_H) so the glyphs read as guns at killfeed size.
 */
export function weaponIcon(id: WeaponId, scale = 1): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = GLYPH_W * GLYPH_SS * scale;
  c.height = GLYPH_H * GLYPH_SS * scale;
  c.style.width = `${GLYPH_W * scale}px`;
  c.style.height = `${GLYPH_H * scale}px`;
  const ctx = c.getContext('2d');
  if (ctx === null) return c; // 2d unavailable — empty icon, layout still holds
  ctx.scale(GLYPH_SS * scale, GLYPH_SS * scale);
  const fill = (rects: Rects): void => {
    for (const [x, y, w, h] of rects) {
      const nw = w * THICK_W;
      const nh = h * THICK_H;
      ctx.fillRect(x - (nw - w) / 2, y - (nh - h) / 2, nw, nh);
    }
  };
  ctx.fillStyle = PALETTE.paper; // bright detail (mag/scope/sights) — reads small
  fill(GLYPH_DETAIL[id]);
  ctx.fillStyle = PALETTE.hudText;
  fill(GLYPH_BODY[id]);
  return c;
}

/** '#rrggbb' -> 'rgba(r,g,b,a)'. Still a PALETTE color, just translucent. */
function alpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ============================================================================
// Procedural state icons — inline SVG, `fill: currentColor` so each icon
// inherits the value/colour of the cluster it labels. These exist so no HUD
// state is ever signalled by COLOUR ALONE: health carries a cross, armour a
// shield, low health an explicit LOW tag, an empty mag the reload prompt.
// ============================================================================
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_HP = 'M8.6 2h6.8v6.6H22v6.8h-6.6V22H8.6v-6.6H2V8.6h6.6z';
const ICON_ARMOR = 'M12 2l8.2 3.1v6.2c0 4.9-3.3 8.9-8.2 10.7C7.1 20.2 3.8 16.2 3.8 11.3V5.1z';

function icon(path: string, cls: string): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'currentColor');
  s.appendChild(p);
  return s;
}

const STYLE_ID = 'fps-hud-style';
const CSS = `
.fh-layer, .fh-layer * { pointer-events: none; box-sizing: border-box; margin: 0; padding: 0; }
.fh-layer {
  position: absolute; inset: 0; overflow: hidden;
  font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  color: var(--fh-text); text-shadow: 0 1px 3px var(--fh-ink);
  user-select: none; -webkit-user-select: none;
  font-variant-numeric: tabular-nums;
}
.fh-hidden { display: none !important; }

/* ---- corner scrims: guarantee the vitals read over a bright ground -------- */
/* Corner-anchored RADIAL falloff, sized farthest-side: the gradient is fully
   transparent by the time it reaches any edge of its own box, so the scrim has
   no visible boundary on a bright ground (a linear wedge shows its box). */
.fh-scrim { position: absolute; width: 430px; height: 300px; }
.fh-scrim-bl { left: 0; bottom: 0;
  background: radial-gradient(farthest-side at 0% 100%, var(--fh-scrim), transparent); }
.fh-scrim-br { right: 0; bottom: 0;
  background: radial-gradient(farthest-side at 100% 100%, var(--fh-scrim), transparent); }

/* ---- shared chip surface: rim (lit) / face (gradient) / contact (deep) ----
   The 2D expression of the value ladder — every panel is three steps, never a
   flat grey box. Declared FIRST so component rules below can override it. */
.fh-panel {
  position: relative; overflow: hidden; border-radius: 4px;
  background: linear-gradient(180deg, var(--fh-surf-a) 0%, var(--fh-surf-b) 100%);
  border: 1px solid var(--fh-edge);
  box-shadow: 0 2px 10px var(--fh-shade),
              inset 0 1px 0 var(--fh-rim-hi),
              inset 0 -2px 0 var(--fh-deep);
}
/* ---- shared meter: sunken track, lit-capped fill, quarter ticks ----------- */
.fh-bar {
  position: relative; overflow: hidden; border-radius: 2px;
  background: var(--fh-track);
  box-shadow: inset 0 1px 2px var(--fh-deep), inset 0 0 0 1px var(--fh-edge);
}
.fh-fill {
  height: 100%; border-radius: 2px;
  box-shadow: inset 0 1px 0 var(--fh-rim-hi), inset 0 -2px 0 var(--fh-deep);
  transition: width 120ms linear;
}
.fh-bar::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(90deg,
    transparent 0 calc(25% - 1px), var(--fh-tick) calc(25% - 1px) 25%,
    transparent 25% calc(50% - 1px), var(--fh-tick) calc(50% - 1px) 50%,
    transparent 50% calc(75% - 1px), var(--fh-tick) calc(75% - 1px) 75%,
    transparent 75%);
}

/* ---- crosshair: 4 lines, gap = spreadPx, 2px white w/ dark outline -------- */
.fh-cross { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.fh-cross div {
  position: absolute; left: 0; top: 0; background: var(--fh-text);
  box-shadow: 0 0 0 1px var(--fh-ink);
}
.fh-ch-t, .fh-ch-b { width: 2px; height: 10px; }
.fh-ch-l, .fh-ch-r { width: 10px; height: 2px; }
.fh-ch-c { width: 2px; height: 2px; border-radius: 50%; opacity: 0.62;
  transform: translate(-1px, -1px); }

/* ---- scope overlay: soft-edge vignette + fine cross + center dot ---------- */
.fh-scope { position: absolute; inset: 0; }
.fh-scope-vig {
  position: absolute; inset: 0;
  background: radial-gradient(circle at 50% 50%,
    transparent 0, transparent 23vmin, var(--fh-scope-soft) 25.6vmin,
    var(--fh-scope-ink) 28vmin, var(--fh-scope-ink) 100%);
}
.fh-scope-ring {
  position: absolute; left: 50%; top: 50%; width: 53vmin; height: 53vmin;
  transform: translate(-50%, -50%); border-radius: 50%;
  border: 1px solid var(--fh-scope-line);
  box-shadow: 0 0 16px 2px var(--fh-scope-soft), inset 0 0 22px 6px var(--fh-scope-soft);
}
.fh-scope-h, .fh-scope-v { position: absolute; background: var(--fh-scope-line); }
.fh-scope-h { top: 50%; height: 1px; width: calc(50% - 5px); }
.fh-scope-hl { left: 0; }
.fh-scope-hr { right: 0; }
.fh-scope-v { left: 50%; width: 1px; height: calc(50% - 5px); }
.fh-scope-vt { top: 0; }
.fh-scope-vb { bottom: 0; }
.fh-scope-dot {
  position: absolute; left: 50%; top: 50%; width: 2px; height: 2px;
  transform: translate(-50%, -50%); border-radius: 50%;
  background: var(--fh-text);
}

/* ---- hitmarker: 4 diagonal ticks; red headshot; kill = pop + ring pulse ---
   Both states are animation-driven so a burst of hits reads as distinct
   flashes rather than one continuous smear (restarted via WAAPI). */
.fh-hit { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; }
.fh-hit.fh-on { animation: fh-hitflash ${HITMARK_MS}ms ease-out forwards; }
.fh-hit.fh-on.fh-kill { animation: fh-killpop ${HITMARK_KILL_MS}ms ease-out forwards; }
.fh-hit div {
  position: absolute; left: -1px; top: -14px; width: 2px; height: 9px;
  background: var(--fh-text); box-shadow: 0 0 0 1px var(--fh-ink);
}
.fh-hit.fh-red div { background: var(--fh-danger); }
.fh-hit .fh-hm1 { transform: rotate(45deg)  translateY(-6px); }
.fh-hit .fh-hm2 { transform: rotate(135deg) translateY(-6px); }
.fh-hit .fh-hm3 { transform: rotate(225deg) translateY(-6px); }
.fh-hit .fh-hm4 { transform: rotate(315deg) translateY(-6px); }
/* Both hold full opacity for most of their window, then cut — a hit must be
   unmissable at gameplay zoom; an early fade reads as a dropped shot. */
@keyframes fh-hitflash {
  0% { opacity: 1; transform: scale(0.82); }
  35% { opacity: 1; transform: scale(1.06); }
  72% { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1); }
}
@keyframes fh-killpop {
  0% { opacity: 1; transform: scale(0.9); }
  35% { opacity: 1; transform: scale(1.45); }
  80% { opacity: 1; transform: scale(1.12); }
  100% { opacity: 0; transform: scale(1.2); }
}
.fh-ring {
  position: absolute; left: 50%; top: 50%; width: 46px; height: 46px;
  border: 2px solid var(--fh-danger); border-radius: 50%; opacity: 0;
  box-shadow: 0 0 8px 1px var(--fh-danger-glow);
}
.fh-ring.fh-on { animation: fh-ringpulse 380ms cubic-bezier(.16,1,.3,1) forwards; }
@keyframes fh-ringpulse {
  0% { opacity: 0.95; transform: translate(-50%, -50%) scale(0.4); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(1.6); }
}

/* ---- floating damage numbers (pooled, WAAPI-restarted CSS animation) ------ */
.fh-dnum {
  position: absolute; left: 50%; top: 50%; font-size: 15px; font-weight: 800;
  letter-spacing: 0.5px; opacity: 0; color: var(--fh-text);
  text-shadow: 0 0 4px var(--fh-ink), 0 1px 3px var(--fh-ink);
}
.fh-dnum.fh-big { color: var(--fh-danger); font-size: 21px; }
/* linear timing: the shape lives in the keyframes, so the number stays fully
   opaque through the middle of its life instead of easing itself invisible. */
.fh-dnum.fh-on { animation: fh-dnumfloat ${DNUM_MS}ms linear forwards; }
@keyframes fh-dnumfloat {
  0% { opacity: 0; transform: translate(var(--dx, 0px), var(--dy, 0px)) scale(0.78); }
  10% { opacity: 1; transform: translate(var(--dx, 0px), calc(var(--dy, 0px) - 6px)) scale(1.12); }
  22% { opacity: 1; transform: translate(var(--dx, 0px), calc(var(--dy, 0px) - 11px)) scale(1); }
  65% { opacity: 1; transform: translate(var(--dx, 0px), calc(var(--dy, 0px) - 24px)) scale(1); }
  100% { opacity: 0; transform: translate(var(--dx, 0px), calc(var(--dy, 0px) - 36px)) scale(0.92); }
}

/* ---- damage direction ring (pooled arc groups: ink outline + danger arc) -- */
.fh-dmg { position: absolute; left: 50%; top: 50%; width: 160px; height: 160px;
  transform: translate(-50%, -50%); }
.fh-arc { opacity: 0; }
.fh-arc.fh-on { animation: fh-arcfade ${DAMAGE_MS}ms linear forwards; }
@keyframes fh-arcfade {
  0% { opacity: 0.45; transform: translateY(7px); }
  8% { opacity: 1; transform: translateY(0); }
  55% { opacity: 0.95; transform: translateY(-2px); }
  100% { opacity: 0; transform: translateY(-8px); }
}

/* ---- top-center: score | phase+timer+BUY | score, round beneath -----------
   Reading order is position-led: T left, CT right, clock centre, so the
   scores stay identifiable without relying on their team colour. */
.fh-top { position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: stretch; gap: 10px; }
.fh-score { display: flex; align-items: center; justify-content: center;
  min-width: 88px; font-size: 26px; font-weight: 800; letter-spacing: 1px;
  padding: 5px 14px 8px;
  text-shadow: 0 0 3px var(--fh-ink), 0 1px 2px var(--fh-ink); }
.fh-score::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0;
  height: 3px; background: var(--fh-teambar, transparent); }
.fh-score-t { color: var(--fh-t-lit); --fh-teambar: var(--fh-t); }
.fh-score-ct { color: var(--fh-ct-lit); --fh-teambar: var(--fh-ct); }
.fh-clock { text-align: center; padding: 5px 16px 7px; min-width: 112px; }
.fh-phase { font-size: 11px; font-weight: 700; letter-spacing: 3px;
  color: var(--fh-text-mute); }
.fh-timer { font-size: 28px; font-weight: 800; line-height: 1.06; letter-spacing: 1px; }
.fh-clock.fh-urgent .fh-timer { color: var(--fh-danger);
  animation: fh-pulse 0.85s ease-in-out infinite; }
.fh-clock.fh-urgent .fh-phase { color: var(--fh-danger); }
.fh-buy { display: inline-block; margin-top: 3px; font-size: 11px; font-weight: 800;
  letter-spacing: 1.5px; color: var(--fh-ink); background: var(--fh-accent);
  padding: 2px 8px; border-radius: 2px; text-shadow: none;
  box-shadow: inset 0 1px 0 var(--fh-buy-lit), 0 1px 0 var(--fh-deep); }
.fh-round { position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
  margin-top: 7px; font-size: 11px; font-weight: 700; letter-spacing: 3px;
  color: var(--fh-text-dim); padding: 3px 11px; white-space: nowrap; }

/* ---- HP + armor bottom-left ------------------------------------------------
   Icon + number + unit + (LOW) tag: the state never rides on hue alone. */
.fh-hp { position: absolute; left: 26px; bottom: 26px; }
.fh-vital { display: flex; align-items: center; gap: 9px; }
.fh-ico { display: block; flex: none; color: var(--fh-text); opacity: 0.8;
  filter: drop-shadow(0 1px 2px var(--fh-ink)); }
.fh-hp-num { font-size: 42px; font-weight: 800; line-height: 0.86;
  letter-spacing: -1px; color: var(--fh-text);
  text-shadow: 0 0 4px var(--fh-ink), 0 2px 4px var(--fh-ink); }
.fh-unit { font-size: 11px; font-weight: 700; letter-spacing: 2px;
  color: var(--fh-text-mute); align-self: flex-end; padding-bottom: 3px;
  text-shadow: 0 0 3px var(--fh-ink), 0 1px 2px var(--fh-ink); }
.fh-tag { font-size: 10px; font-weight: 800; letter-spacing: 2px; padding: 2px 6px;
  border-radius: 2px; color: var(--fh-text); background: var(--fh-danger-glow);
  border: 1px solid var(--fh-danger); text-shadow: none;
  animation: fh-pulse 1.05s ease-in-out infinite; }
.fh-hp-ico { width: 19px; height: 19px; }
.fh-hp-bar { width: 232px; height: 9px; margin-top: 8px; }
.fh-hp-fill { background: var(--fh-hp); }
.fh-hp.fh-low .fh-hp-fill { background: var(--fh-danger); }
/* The digits stay at full-contrast --fh-text in the low state: they are the
   most-read number in the game and recolouring them to --fh-danger drops them
   from ~14:1 to ~3.3:1 exactly when they matter most. The low state is already
   carried by three non-hue cues (danger bar fill, pulsing LOW tag, danger
   icon); here the hue arrives as a danger ring *behind* the glyphs instead. */
.fh-hp.fh-low .fh-hp-num { color: var(--fh-text);
  text-shadow: 0 0 4px var(--fh-ink), 0 2px 4px var(--fh-ink),
    0 0 3px var(--fh-danger), 0 0 11px var(--fh-danger-glow); }
.fh-hp.fh-low .fh-hp-ico { color: var(--fh-danger); opacity: 1; }
@keyframes fh-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

.fh-armor { margin-top: 10px; }
.fh-armor-ico { width: 15px; height: 15px; color: var(--fh-armor); opacity: 0.95; }
.fh-armor-num { font-size: 22px; font-weight: 800; line-height: 0.9;
  color: var(--fh-text); text-shadow: 0 0 3px var(--fh-ink), 0 1px 3px var(--fh-ink); }
.fh-armor-bar { width: 232px; height: 6px; margin-top: 5px; }
.fh-armor-fill { background: var(--fh-armor); }
.fh-armor-bar::after { opacity: 0.7; }

/* ---- money + ammo bottom-right --------------------------------------------
   Glanceable order, biggest first: mag > weapon > money. */
.fh-ammo { position: absolute; right: 26px; bottom: 26px;
  display: flex; flex-direction: column; align-items: flex-end; }
.fh-money { display: flex; align-items: baseline; gap: 4px; font-weight: 800;
  transition: color 200ms; }
.fh-money.fh-flash { animation: fh-bump 440ms cubic-bezier(.16,1,.3,1); }
.fh-money-sym { font-size: 13px; color: var(--fh-accent-dim); }
.fh-money-num { font-size: 20px; letter-spacing: 0.5px; color: var(--fh-accent);
  text-shadow: 0 0 3px var(--fh-ink), 0 1px 2px var(--fh-ink); }
.fh-money.fh-flash .fh-money-num, .fh-money.fh-flash .fh-money-sym { color: var(--fh-hp); }
@keyframes fh-bump {
  0% { transform: translateY(5px); } 55% { transform: translateY(-3px); }
  100% { transform: none; }
}
.fh-wrow { display: flex; align-items: center; gap: 9px; margin-top: 7px; }
.fh-wglyph { display: block; opacity: 0.92; filter: drop-shadow(0 1px 2px var(--fh-ink)); }
.fh-wglyph canvas { display: block; }
.fh-wname { font-size: 13px; font-weight: 700; letter-spacing: 2.5px;
  color: var(--fh-text-dim); text-transform: uppercase; }
.fh-magline { display: flex; align-items: baseline; gap: 7px; line-height: 0.9;
  margin-top: 3px; }
.fh-mag { font-size: 46px; font-weight: 800; letter-spacing: -1px;
  text-shadow: 0 0 4px var(--fh-ink), 0 2px 4px var(--fh-ink); }
.fh-mag.fh-empty { color: var(--fh-danger); }
.fh-res { font-size: 17px; font-weight: 700; color: var(--fh-text-mute);
  text-shadow: 0 0 3px var(--fh-ink), 0 1px 2px var(--fh-ink); }
.fh-reload { font-size: 11px; font-weight: 800; letter-spacing: 2px;
  color: var(--fh-text); background: var(--fh-danger-glow);
  border: 1px solid var(--fh-danger); border-radius: 2px; padding: 2px 7px;
  margin-top: 6px; text-shadow: none; animation: fh-pulse 1.05s ease-in-out infinite; }

/* ---- killfeed top-right: team-colored names + procedural weapon glyph -----
   The killer's team is carried by the left accent bar AND the name colour AND
   the left-to-right killer>victim order — never by hue alone. */
.fh-feed { position: absolute; right: 20px; top: 16px; display: flex;
  flex-direction: column; align-items: flex-end; gap: 5px; }
.fh-row { display: flex; align-items: center; font-size: 13px; font-weight: 600;
  padding: 4px 10px; letter-spacing: 0.4px; white-space: nowrap;
  border-left: 3px solid var(--fh-rim); border-radius: 2px 3px 3px 2px;
  opacity: 1; transition: opacity 400ms ease, transform 400ms ease;
  animation: fh-rowin 200ms cubic-bezier(.16,1,.3,1); }
.fh-row.fh-fade { opacity: 0; transform: translateX(16px); }
.fh-row-t { border-left-color: var(--fh-t); }
.fh-row-ct { border-left-color: var(--fh-ct); }
.fh-row .fh-wicon { margin: 0 9px; opacity: 0.95; display: block; }
.fh-row .fh-n-t { color: var(--fh-t-lit); font-weight: 800; }
.fh-row .fh-n-ct { color: var(--fh-ct-lit); font-weight: 800; }
.fh-row .fh-hs { color: var(--fh-danger); font-weight: 800; margin-left: 6px;
  font-size: 14px; }
@keyframes fh-rowin { from { transform: translateX(18px); opacity: 0; } to { transform: none; opacity: 1; } }

/* ---- banner (round start/end), queued -------------------------------------- */
.fh-banner { position: absolute; left: 50%; top: 24%; transform: translateX(-50%);
  text-align: center; opacity: 0; transition: opacity 380ms ease; white-space: nowrap;
  padding: 15px 46px 17px; }
.fh-banner.fh-on { opacity: 1; }
.fh-banner.fh-on .fh-banner-t { animation: fh-bannerin 520ms cubic-bezier(.16,1,.3,1); }
.fh-banner-t { font-size: 46px; font-weight: 800; letter-spacing: 5px; line-height: 1;
  text-shadow: 0 0 10px var(--fh-ink), 0 3px 6px var(--fh-ink); }
.fh-banner-rule { height: 2px; margin: 11px 0 9px;
  background: linear-gradient(90deg, transparent, var(--fh-accent), transparent); }
.fh-banner-s { font-size: 15px; font-weight: 700; letter-spacing: 3px;
  color: var(--fh-text-dim); }
@keyframes fh-bannerin {
  from { letter-spacing: 15px; opacity: 0; } to { letter-spacing: 5px; opacity: 1; }
}

/* ---- dead / spectating ------------------------------------------------------ */
.fh-vig { position: absolute; inset: 0;
  background: radial-gradient(ellipse at 50% 50%,
    transparent 0, transparent 40%, var(--fh-ink-70) 100%); }
.fh-spec { position: absolute; left: 50%; bottom: 15%; transform: translateX(-50%);
  font-size: 15px; font-weight: 700; letter-spacing: 3px;
  padding: 7px 18px; white-space: nowrap; }
`;

export class Hud {
  private readonly layer: HTMLDivElement;

  // crosshair / scope
  private readonly cross: HTMLDivElement;
  private readonly chT: HTMLDivElement;
  private readonly chB: HTMLDivElement;
  private readonly chL: HTMLDivElement;
  private readonly chR: HTMLDivElement;
  private readonly scope: HTMLDivElement;

  // hitmarker (+ kill confirmation ring)
  private readonly hit: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private hitTimer = 0;

  // damage ring: each pool slot is a rotated outer <g> (aim) wrapping an inner
  // <g> that carries the fade/drift animation — a CSS transform on the rotated
  // node would clobber its `transform` attribute, hence the two levels.
  private readonly arcs: SVGGElement[] = [];
  private readonly arcRots: SVGGElement[] = [];
  private arcNext = 0;
  private readonly dnums: HTMLDivElement[] = [];
  private dnumNext = 0;

  // top center
  private readonly clockEl: HTMLDivElement;
  private readonly phaseEl: HTMLDivElement;
  private readonly timerEl: HTMLDivElement;
  private readonly buyEl: HTMLDivElement;
  private readonly roundEl: HTMLDivElement;
  private readonly scoreTEl: HTMLDivElement;
  private readonly scoreCTEl: HTMLDivElement;

  // hp / armor / ammo / money
  private readonly hpWrap: HTMLDivElement;
  private readonly hpNum: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly hpTag: HTMLDivElement;
  private readonly armorWrap: HTMLDivElement;
  private readonly armorNum: HTMLDivElement;
  private readonly armorFill: HTMLDivElement;
  private readonly moneyEl: HTMLDivElement;
  private readonly moneyNum: HTMLSpanElement;
  private moneyTimer = 0;
  private readonly wglyph: HTMLDivElement;
  private readonly wnameEl: HTMLDivElement;
  private readonly magEl: HTMLSpanElement;
  private readonly resEl: HTMLSpanElement;
  private readonly reloadEl: HTMLDivElement;

  // feed / banner / spectate
  private readonly feed: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly bannerT: HTMLDivElement;
  private readonly bannerS: HTMLDivElement;
  private bannerBusy = false;
  private readonly bannerQueue: Array<{ title: string; sub: string }> = [];
  private readonly vig: HTMLDivElement;
  private readonly specEl: HTMLDivElement;

  // change-detection cache (update() touches DOM only on change)
  private cHp = -1;
  private cArmor = -1;
  private cLow = false;
  private cAlive = true;
  private cMoney = -1;
  private cCanBuy = false;
  private cWname = '';
  private cMag = -2;
  private cRes = -2;
  private cPhase: RoomPhase | '' = '';
  private cSec = -1;
  private cRound = -1;
  private cScoreT = -1;
  private cScoreCT = -1;
  private cGap = -1;
  private cScoped = false;
  private cSpec: string | null = null;
  private cWeapon: WeaponId | '' = '';
  private cUrgent = false;

  constructor(root: HTMLElement) {
    // PALETTE -> CSS custom properties on the root (single source of truth).
    const st = root.style;
    // Text ladder: text -> dim -> mute, all one hue, three clearly separated values.
    st.setProperty('--fh-text', PALETTE.hudText);
    st.setProperty('--fh-text-dim', alpha(PALETTE.hudText, 0.62));
    st.setProperty('--fh-text-mute', alpha(PALETTE.hudText, 0.52));
    st.setProperty('--fh-accent', PALETTE.hudAccent);
    st.setProperty('--fh-accent-dim', alpha(PALETTE.hudAccent, 0.72));
    st.setProperty('--fh-buy-lit', alpha(PALETTE.sandLit, 0.45)); // lit rim on the BUY pill
    st.setProperty('--fh-danger', PALETTE.danger);
    st.setProperty('--fh-danger-glow', alpha(PALETTE.danger, 0.34));
    st.setProperty('--fh-hp', PALETTE.hpGreen);
    st.setProperty('--fh-armor', PALETTE.steel); // blue-ish shield tone
    st.setProperty('--fh-ink', PALETTE.ink);
    st.setProperty('--fh-ink-55', alpha(PALETTE.ink, 0.55));
    st.setProperty('--fh-ink-70', alpha(PALETTE.ink, 0.72));
    st.setProperty('--fh-ink-85', alpha(PALETTE.ink, 0.85));
    st.setProperty('--fh-scope-ink', alpha(PALETTE.ink, 0.97));
    st.setProperty('--fh-scope-soft', alpha(PALETTE.ink, 0.55));
    st.setProperty('--fh-scope-line', alpha(PALETTE.hudText, 0.5));
    // Panel ladder: charcoal face over an ink base, lit rim on top, deep contact
    // at the bottom — the CSS restatement of the §1 value ladder.
    st.setProperty('--fh-surf-a', alpha(PALETTE.charcoal, 0.86));
    st.setProperty('--fh-surf-b', alpha(PALETTE.ink, 0.92));
    st.setProperty('--fh-shade', alpha(PALETTE.ink, 0.55));
    st.setProperty('--fh-deep', alpha(PALETTE.ink, 0.9));
    st.setProperty('--fh-track', alpha(PALETTE.ink, 0.72));
    st.setProperty('--fh-tick', alpha(PALETTE.ink, 0.65));
    st.setProperty('--fh-scrim', alpha(PALETTE.ink, 0.42));
    st.setProperty('--fh-rim', alpha(PALETTE.hudText, 0.16));
    st.setProperty('--fh-rim-hi', alpha(PALETTE.hudText, 0.26));
    st.setProperty('--fh-edge', alpha(PALETTE.hudText, 0.09));
    st.setProperty('--fh-t', PALETTE.tAmber);
    st.setProperty('--fh-t-lit', PALETTE.tLit);
    st.setProperty('--fh-ct', PALETTE.ctBlue);
    st.setProperty('--fh-ct-lit', PALETTE.ctLit);

    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    this.layer = div('fh-layer');
    root.appendChild(this.layer);

    // corner scrims — the vitals must stay legible over snow and desert sand
    this.layer.append(div('fh-scrim fh-scrim-bl'), div('fh-scrim fh-scrim-br'));

    // spectate vignette (over the scrims, under everything else)
    this.vig = div('fh-vig fh-hidden');
    this.layer.appendChild(this.vig);

    // damage ring — fixed SVG, arcs pooled + reused round-robin. Each slot is
    // an ink outline under a danger arc so the direction reads over a bright
    // sky as clearly as over a dark floor.
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 160 160');
    svg.setAttribute('class', 'fh-dmg');
    for (let i = 0; i < ARC_POOL; i++) {
      const rot = document.createElementNS(SVG_NS, 'g');
      const anim = document.createElementNS(SVG_NS, 'g');
      anim.setAttribute('class', 'fh-arc');
      for (const [hex, width] of [[PALETTE.ink, '10'], [PALETTE.danger, '6']] as const) {
        const p = document.createElementNS(SVG_NS, 'path');
        // arc segment centered on 12 o'clock (yawRelative 0 = ahead)
        p.setAttribute('d', 'M 54.64 25.62 A 60 60 0 0 1 105.36 25.62');
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', hex);
        p.setAttribute('stroke-width', width);
        p.setAttribute('stroke-linecap', 'round');
        anim.appendChild(p);
      }
      rot.appendChild(anim);
      svg.appendChild(rot);
      this.arcs.push(anim);
      this.arcRots.push(rot);
    }
    this.layer.appendChild(svg);

    // floating damage numbers — fixed pool of divs, reused round-robin
    for (let i = 0; i < DNUM_POOL; i++) {
      const d = div('fh-dnum fh-on');
      const [ox, oy] = DNUM_OFF[i % DNUM_OFF.length]!;
      d.style.setProperty('--dx', `${ox}px`);
      d.style.setProperty('--dy', `${oy}px`);
      this.layer.appendChild(d);
      this.dnums.push(d);
    }

    // crosshair
    this.cross = div('fh-cross');
    this.chT = div('fh-ch-t');
    this.chB = div('fh-ch-b');
    this.chL = div('fh-ch-l');
    this.chR = div('fh-ch-r');
    this.cross.append(this.chT, this.chB, this.chL, this.chR, div('fh-ch-c'));
    this.layer.appendChild(this.cross);

    // scope overlay (soft vignette, fine cross with center gap + dot)
    this.scope = div('fh-scope fh-hidden');
    this.scope.append(
      div('fh-scope-vig'),
      div('fh-scope-h fh-scope-hl'),
      div('fh-scope-h fh-scope-hr'),
      div('fh-scope-v fh-scope-vt'),
      div('fh-scope-v fh-scope-vb'),
      div('fh-scope-dot'),
      div('fh-scope-ring'),
    );
    this.layer.appendChild(this.scope);

    // hitmarker + kill confirmation ring
    this.hit = div('fh-hit');
    this.hit.append(div('fh-hm1'), div('fh-hm2'), div('fh-hm3'), div('fh-hm4'));
    this.layer.appendChild(this.hit);
    this.ring = div('fh-ring fh-on');
    this.layer.appendChild(this.ring);

    // top center: score T | clock | score CT, round beneath. `fh-round` hangs
    // off `fh-top` (not the clock) — the clock clips its own overflow, which
    // used to swallow the ROUND label whole.
    const top = div('fh-top');
    this.scoreTEl = div('fh-score fh-panel fh-score-t');
    this.scoreCTEl = div('fh-score fh-panel fh-score-ct');
    this.clockEl = div('fh-clock fh-panel');
    this.phaseEl = div('fh-phase');
    this.timerEl = div('fh-timer');
    this.buyEl = div('fh-buy fh-hidden');
    this.buyEl.textContent = 'BUY (B)';
    this.roundEl = div('fh-round fh-panel');
    this.clockEl.append(this.phaseEl, this.timerEl, this.buyEl);
    top.append(this.scoreTEl, this.clockEl, this.scoreCTEl, this.roundEl);
    this.layer.appendChild(top);

    // HP bottom-left (armor cluster tucked under it, only while armor > 0)
    this.hpWrap = div('fh-hp');
    const hpRow = div('fh-vital');
    this.hpNum = div('fh-hp-num');
    this.hpTag = div('fh-tag fh-hidden');
    this.hpTag.textContent = 'LOW';
    const hpUnit = div('fh-unit');
    hpUnit.textContent = 'HP';
    hpRow.append(icon(ICON_HP, 'fh-ico fh-hp-ico'), this.hpNum, hpUnit, this.hpTag);
    const bar = div('fh-hp-bar fh-bar');
    this.hpFill = div('fh-hp-fill fh-fill');
    bar.appendChild(this.hpFill);
    this.armorWrap = div('fh-armor fh-hidden');
    const armorRow = div('fh-vital');
    this.armorNum = div('fh-armor-num');
    const apUnit = div('fh-unit');
    apUnit.textContent = 'AP';
    armorRow.append(icon(ICON_ARMOR, 'fh-ico fh-armor-ico'), this.armorNum, apUnit);
    const armorBar = div('fh-armor-bar fh-bar');
    this.armorFill = div('fh-armor-fill fh-fill');
    armorBar.appendChild(this.armorFill);
    this.armorWrap.append(armorRow, armorBar);
    this.hpWrap.append(hpRow, bar, this.armorWrap);
    this.layer.appendChild(this.hpWrap);

    // money + ammo bottom-right
    const ammo = div('fh-ammo');
    this.moneyEl = div('fh-money');
    const moneySym = document.createElement('span');
    moneySym.className = 'fh-money-sym';
    moneySym.textContent = '$';
    this.moneyNum = document.createElement('span');
    this.moneyNum.className = 'fh-money-num';
    this.moneyEl.append(moneySym, this.moneyNum);
    const wrow = div('fh-wrow');
    this.wglyph = div('fh-wglyph');
    this.wnameEl = div('fh-wname');
    wrow.append(this.wglyph, this.wnameEl);
    const magline = div('fh-magline');
    this.magEl = document.createElement('span');
    this.magEl.className = 'fh-mag';
    this.resEl = document.createElement('span');
    this.resEl.className = 'fh-res';
    magline.append(this.magEl, this.resEl);
    this.reloadEl = div('fh-reload fh-hidden');
    this.reloadEl.textContent = 'R TO RELOAD';
    ammo.append(this.moneyEl, wrow, magline, this.reloadEl);
    this.layer.appendChild(ammo);

    // killfeed
    this.feed = div('fh-feed');
    this.layer.appendChild(this.feed);

    // banner
    this.bannerEl = div('fh-banner fh-panel');
    this.bannerT = div('fh-banner-t');
    this.bannerS = div('fh-banner-s');
    this.bannerEl.append(this.bannerT, div('fh-banner-rule'), this.bannerS);
    this.layer.appendChild(this.bannerEl);

    // spectating label
    this.specEl = div('fh-spec fh-panel fh-hidden');
    this.layer.appendChild(this.specEl);
  }

  update(s: HudState): void {
    // hp
    const hp = Math.max(0, Math.round(s.hp));
    if (hp !== this.cHp) {
      this.cHp = hp;
      this.hpNum.textContent = String(hp);
      this.hpFill.style.width = `${hp}%`;
    }
    // low health is signalled three ways at once — value (danger bar + icon),
    // motion (pulse) and text (the LOW tag) — never by hue alone. The HP
    // digits themselves stay at full-contrast --fh-text; see .fh-hp.fh-low.
    const low = s.alive && hp < LOW_HP;
    if (low !== this.cLow) {
      this.cLow = low;
      this.hpWrap.classList.toggle('fh-low', low);
      this.hpTag.classList.toggle('fh-hidden', !low);
    }

    // armor (0..100; cluster hidden entirely at 0 — no vest)
    const armor = Math.max(0, Math.min(100, Math.round(s.armor)));
    if (armor !== this.cArmor) {
      this.cArmor = armor;
      this.armorWrap.classList.toggle('fh-hidden', armor <= 0);
      this.armorNum.textContent = String(armor);
      this.armorFill.style.width = `${armor}%`;
    }

    // money (flash green on increase)
    if (s.money !== this.cMoney) {
      const gained = this.cMoney >= 0 && s.money > this.cMoney;
      this.cMoney = s.money;
      this.moneyNum.textContent = String(s.money);
      if (gained) {
        this.moneyEl.classList.remove('fh-flash');
        this.moneyEl.classList.add('fh-flash');
        window.clearTimeout(this.moneyTimer);
        this.moneyTimer = window.setTimeout(() => this.moneyEl.classList.remove('fh-flash'), 460);
      }
    }

    // weapon glyph — the same procedural silhouette the killfeed and buy menu
    // use, so "what am I holding" is answerable by shape, not just by name.
    if (s.weapon !== this.cWeapon) {
      this.cWeapon = s.weapon;
      const g = weaponIcon(s.weapon);
      this.wglyph.textContent = '';
      this.wglyph.appendChild(g);
    }

    // weapon / ammo (mag -1 = melee)
    if (s.weaponName !== this.cWname) {
      this.cWname = s.weaponName;
      this.wnameEl.textContent = s.weaponName;
    }
    if (s.mag !== this.cMag) {
      this.cMag = s.mag;
      this.magEl.textContent = s.mag < 0 ? '—' : String(s.mag);
      this.magEl.classList.toggle('fh-empty', s.mag === 0);
      this.reloadEl.classList.toggle('fh-hidden', s.mag !== 0);
    }
    if (s.reserve !== this.cRes) {
      this.cRes = s.reserve;
      this.resEl.textContent = s.reserve < 0 ? '' : `/ ${s.reserve}`;
    }

    // phase / timer / buy chip / round / score
    if (s.phase !== this.cPhase) {
      this.cPhase = s.phase;
      this.phaseEl.textContent = PHASE_LABEL[s.phase];
    }
    const timed = s.phase === 'freeze' || s.phase === 'live' || s.phase === 'roundEnd';
    const sec = timed ? Math.max(0, Math.ceil(s.phaseEndsInSec)) : -1;
    if (sec !== this.cSec) {
      this.cSec = sec;
      if (sec < 0) {
        this.timerEl.textContent = '';
        this.timerEl.classList.add('fh-hidden');
      } else {
        this.timerEl.classList.remove('fh-hidden');
        const mm = Math.floor(sec / 60);
        const ss = sec % 60;
        this.timerEl.textContent = `${mm}:${ss < 10 ? '0' : ''}${ss}`;
      }
    }
    // last 20s of a live round: colour AND pulse, so the urgency survives a
    // colour-blind read and a glance from the far side of the screen.
    const urgent = s.phase === 'live' && sec >= 0 && sec <= 20;
    if (urgent !== this.cUrgent) {
      this.cUrgent = urgent;
      this.clockEl.classList.toggle('fh-urgent', urgent);
    }
    if (s.canBuy !== this.cCanBuy) {
      this.cCanBuy = s.canBuy;
      this.buyEl.classList.toggle('fh-hidden', !s.canBuy);
    }
    if (s.round !== this.cRound) {
      this.cRound = s.round;
      this.roundEl.textContent = s.round > 0 ? `ROUND ${s.round}` : '';
    }
    if (s.scoreT !== this.cScoreT) {
      this.cScoreT = s.scoreT;
      this.scoreTEl.textContent = `T ${s.scoreT}`;
    }
    if (s.scoreCT !== this.cScoreCT) {
      this.cScoreCT = s.scoreCT;
      this.scoreCTEl.textContent = `${s.scoreCT} CT`;
    }

    // crosshair gap = spreadPx; hidden while scoped (scope overlay instead)
    const gap = Math.max(2, Math.round(s.spreadPx));
    if (gap !== this.cGap) {
      this.cGap = gap;
      this.chT.style.transform = `translate(-1px, ${-(gap + 10)}px)`;
      this.chB.style.transform = `translate(-1px, ${gap}px)`;
      this.chL.style.transform = `translate(${-(gap + 10)}px, -1px)`;
      this.chR.style.transform = `translate(${gap}px, -1px)`;
    }
    if (s.scoped !== this.cScoped) {
      this.cScoped = s.scoped;
      this.cross.classList.toggle('fh-hidden', s.scoped);
      this.scope.classList.toggle('fh-hidden', !s.scoped);
    }

    // dead / spectating
    if (s.alive !== this.cAlive) {
      this.cAlive = s.alive;
      this.vig.classList.toggle('fh-hidden', s.alive);
    }
    if (s.spectating !== this.cSpec) {
      this.cSpec = s.spectating;
      this.specEl.classList.toggle('fh-hidden', s.spectating === null);
      if (s.spectating !== null) {
        // 'respawn in N' is a self countdown, not a spectate target — no prefix.
        this.specEl.textContent = s.spectating.startsWith('respawn')
          ? s.spectating
          : `SPECTATING ${s.spectating}`;
      }
    }
  }

  /**
   * ≤5 rows, newest on top, each fades out after 5s. Killer/victim names are
   * team-colored when the caller supplies roster teams (additive optional
   * args — the frozen 4-arg call still works and renders neutral names).
   */
  killfeed(
    killer: string | null,
    victim: string,
    weapon: WeaponId,
    headshot: boolean,
    killerTeam?: Team | null,
    victimTeam?: Team | null,
  ): void {
    const row = div('fh-row fh-panel');
    const k = document.createElement('span');
    k.textContent = killer ?? '—';
    if (killerTeam === 'T' || killerTeam === 'CT') {
      k.className = killerTeam === 'T' ? 'fh-n-t' : 'fh-n-ct';
      // second cue for the killer's side: an accent bar on the row's leading edge
      row.classList.add(killerTeam === 'T' ? 'fh-row-t' : 'fh-row-ct');
    }
    const icon = weaponIcon(weapon);
    icon.className = 'fh-wicon';
    icon.title = WEAPONS[weapon].name;
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', WEAPONS[weapon].name);
    const v = document.createElement('span');
    v.textContent = victim;
    if (victimTeam === 'T' || victimTeam === 'CT') {
      v.className = victimTeam === 'T' ? 'fh-n-t' : 'fh-n-ct';
    }
    row.append(k, icon, v);
    if (headshot) {
      const hs = document.createElement('span');
      hs.className = 'fh-hs';
      hs.textContent = '✕';
      row.appendChild(hs);
    }
    this.feed.prepend(row);
    while (this.feed.childElementCount > KILLFEED_MAX) {
      this.feed.lastElementChild?.remove();
    }
    window.setTimeout(() => {
      row.classList.add('fh-fade');
      window.setTimeout(() => row.remove(), 450);
    }, KILLFEED_MS);
  }

  /**
   * 4 diagonal ticks flash: white on a body hit, red on a headshot; a kill
   * pops the ticks and fires one expanding confirmation ring. `dmg` (additive
   * optional) also floats a pooled damage number next to the marker.
   */
  hitmarker(headshot: boolean, killed: boolean, dmg?: number): void {
    this.hit.classList.toggle('fh-red', headshot || killed);
    this.hit.classList.toggle('fh-kill', killed);
    this.hit.classList.add('fh-on');
    // restart the flash so a fast burst reads as N distinct pops, not one smear
    this.hit.getAnimations().forEach((a) => { a.cancel(); a.play(); });
    window.clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(
      () => this.hit.classList.remove('fh-on'),
      killed ? HITMARK_KILL_MS : HITMARK_MS,
    );
    if (killed) {
      // restart the ring pulse via WAAPI — no layout read on the combat path
      this.ring.getAnimations().forEach((a) => { a.cancel(); a.play(); });
    }
    if (dmg !== undefined && dmg > 0) {
      const d = this.dnums[this.dnumNext];
      if (d !== undefined) {
        this.dnumNext = (this.dnumNext + 1) % DNUM_POOL;
        d.textContent = String(dmg);
        d.classList.toggle('fh-big', killed);
        d.getAnimations().forEach((a) => { a.cancel(); a.play(); });
      }
    }
  }

  /** Red arc pointing at the damage source. yawRelative 0 = ahead, positive =
   *  source to the left (yaw increases CCW) — hence the negative CSS rotation. */
  damageFrom(yawRelative: number): void {
    const arc = this.arcs[this.arcNext];
    const rot = this.arcRots[this.arcNext];
    // pool is fixed-size; unreachable, satisfies noUncheckedIndexedAccess
    if (arc === undefined || rot === undefined) return;
    this.arcNext = (this.arcNext + 1) % ARC_POOL;
    const deg = (-yawRelative * 180) / Math.PI;
    rot.setAttribute('transform', `rotate(${deg} 80 80)`);
    arc.classList.add('fh-on');
    // restart the fade via WAAPI — no layout read on the combat hot path
    arc.getAnimations().forEach((a) => { a.cancel(); a.play(); });
  }

  /** Big center text for 2.5s; queues while another banner is up. */
  banner(title: string, sub: string): void {
    this.bannerQueue.push({ title, sub });
    this.pumpBanner();
  }

  private pumpBanner(): void {
    if (this.bannerBusy) return;
    const next = this.bannerQueue.shift();
    if (next === undefined) return;
    this.bannerBusy = true;
    this.bannerT.textContent = next.title;
    this.bannerS.textContent = next.sub;
    this.bannerEl.classList.add('fh-on');
    window.setTimeout(() => {
      this.bannerEl.classList.remove('fh-on');
      window.setTimeout(() => {
        this.bannerBusy = false;
        this.pumpBanner();
      }, 420); // wait out the opacity transition before the next banner
    }, BANNER_MS);
  }

  show(on: boolean): void {
    this.layer.classList.toggle('fh-hidden', !on);
  }
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}
