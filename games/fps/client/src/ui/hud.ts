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
import { MIN_PLAYERS_FOR_MATCH, PALETTE, WEAPONS } from '@fps/shared';
import type { RoomPhase, Team, WeaponId } from '@fps/shared';

/**
 * One player as the team rail / warmup lobby needs them. Structurally a subset
 * of C10's roster-merged sync entry, so the caller passes its existing reused
 * array — no per-frame allocation on either side.
 */
export interface HudPlayer {
  readonly id: string;
  readonly name: string;
  readonly team: Team;
  readonly alive: boolean;
}

export interface HudState {
  hp: number; armor: number; alive: boolean; money: number; canBuy: boolean;
  weapon: WeaponId; weaponName: string; mag: number; reserve: number;
  phase: RoomPhase; phaseEndsInSec: number; round: number; scoreT: number; scoreCT: number;
  spreadPx: number; scoped: boolean;
  /** Convention: a string starting with 'respawn' is a self respawn countdown
   *  (rendered as-is); anything else is a spectate target name ('SPECTATING X'). */
  spectating: string | null;
  /** YOUR side. null before 'joined' lands — the team rail stays hidden then. */
  team: Team | null;
  /** YOUR player id, '' before 'joined' — marks your row in the rail/lobby. */
  you: string;
  /** Everyone in the latest snapshot, merged with the roster's name/team. */
  players: readonly HudPlayer[];
}

const PHASE_LABEL: Record<RoomPhase, string> = {
  warmup: 'WARMUP', freeze: 'FREEZE', live: 'LIVE', roundEnd: 'ROUND END', matchEnd: 'MATCH END',
};

const TEAM_FULL: Record<Team, string> = { T: 'TERRORISTS', CT: 'COUNTER-TERRORISTS' };
const OTHER: Record<Team, Team> = { T: 'CT', CT: 'T' };

// The warmup->live threshold the server actually enforces (advancePhase reads
// the same constant) — the lobby quotes it rather than restating a magic 2.
const MATCH_MIN_PLAYERS = MIN_PLAYERS_FOR_MATCH;

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
// Team marks. Two differences at once — orientation (down vs up) AND weight
// (solid vs hollow) — because these get used at 11-15px, where a shield and a
// wedge blur into the same blob. The hollow one is a single path whose inner
// triangle is wound the other way, so plain nonzero fill knocks it out.
const ICON_T = 'M2 3.4h20L12 22z';
const ICON_CT = 'M12 2L22 21L2 21Z M12 7.6L6.4 18.2L17.6 18.2Z';
const TEAM_ICON: Record<Team, string> = { T: ICON_T, CT: ICON_CT };

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
.fh-score { display: flex; align-items: center; justify-content: center; gap: 8px;
  min-width: 128px; font-size: 26px; font-weight: 800; letter-spacing: 1px;
  padding: 5px 13px 9px;
  text-shadow: 0 0 3px var(--fh-ink), 0 1px 2px var(--fh-ink); }
.fh-score::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0;
  height: 3px; background: var(--fh-teambar, transparent); }
.fh-score-t { color: var(--fh-t-lit); --fh-teambar: var(--fh-t); }
.fh-score-ct { color: var(--fh-ct-lit); --fh-teambar: var(--fh-ct);
  flex-direction: row-reverse; }
/* YOUR side, spelled out four ways at once: the word YOU on a bright pill, the
   word ENEMY on the other chip, a fatter fully-lit team bar, and a lit rim —
   so the two chips are never symmetrical and none of it rides on hue. */
.fh-side { display: flex; align-items: center; gap: 5px; font-size: 15px;
  font-weight: 900; letter-spacing: 1.6px; }
.fh-side-ico { display: block; width: 13px; height: 13px; flex: none;
  filter: drop-shadow(0 1px 2px var(--fh-ink)); }
.fh-score-num { font-size: 26px; font-weight: 800; letter-spacing: 1px; }
.fh-pill { font-size: 9px; font-weight: 800; letter-spacing: 1.6px;
  padding: 1px 5px; border-radius: 2px; line-height: 1.5; }
.fh-pill-you { color: var(--fh-ink); background: var(--fh-text); text-shadow: none; }
.fh-pill-foe { color: var(--fh-text-mute); border: 1px solid var(--fh-edge); }
.fh-score.fh-mine { border-color: var(--fh-rim-hi);
  box-shadow: 0 2px 10px var(--fh-shade), inset 0 1px 0 var(--fh-rim-hi),
              inset 0 -2px 0 var(--fh-deep), 0 0 0 1px var(--fh-teambar); }
.fh-score.fh-mine::after { height: 6px; }
.fh-score:not(.fh-mine) .fh-score-num { opacity: 0.8; }

/* ---- team rail (left): who is with you, and who is still standing ---------
   Alive/dead is carried by the mark's SHAPE (filled square vs hollow rotated
   outline), a strike-through name and the word DEAD — never by hue. */
/* Wide enough to fit COUNTER-TERRORISTS un-truncated beside the mark, the tag
   and the YOU pill — the header must never abbreviate the one thing the panel
   exists to say. (Measured on the built client at 1600x900.) */
.fh-team { position: absolute; left: 32px; top: 98px; width: 252px; }
.fh-team-head { display: flex; align-items: center; gap: 6px; padding: 6px 9px; }
.fh-team-head-t { color: var(--fh-ink);
  background: linear-gradient(180deg, var(--fh-t-lit), var(--fh-t)); }
.fh-team-head-ct { color: var(--fh-text);
  background: linear-gradient(180deg, var(--fh-ct-lit), var(--fh-ct)); }
.fh-team-ico { display: block; width: 15px; height: 15px; flex: none; }
.fh-team-tag { font-size: 14px; font-weight: 900; letter-spacing: 2px;
  text-shadow: none; }
.fh-team-name { font-size: 9px; font-weight: 800; letter-spacing: 1.1px;
  opacity: 0.86; text-shadow: none; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.fh-team-mine { margin-left: auto; font-size: 9px; font-weight: 800;
  letter-spacing: 1.4px; padding: 1px 5px; border-radius: 2px;
  background: var(--fh-ink); color: var(--fh-text); text-shadow: none; }
.fh-team-sub { display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 4px 9px; font-size: 9px; font-weight: 800;
  letter-spacing: 1.8px; color: var(--fh-text-mute); background: var(--fh-track); }
.fh-team-alive { color: var(--fh-text); }
.fh-team-list { padding: 3px 0 4px; }
.fh-tm { display: flex; align-items: center; gap: 7px; padding: 2px 9px;
  font-size: 12px; font-weight: 700; line-height: 1.55; }
.fh-tm-mark { width: 9px; height: 9px; flex: none; border-radius: 2px;
  background: var(--fh-hp); box-shadow: inset 0 -2px 0 var(--fh-deep); }
.fh-tm-dead .fh-tm-mark { background: transparent; border-radius: 0;
  border: 1px solid var(--fh-text-mute); box-shadow: none;
  width: 7px; height: 7px; margin: 1px; transform: rotate(45deg); }
.fh-tm-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--fh-text); }
.fh-tm-dead .fh-tm-name { color: var(--fh-text-mute); text-decoration: line-through; }
.fh-tm-state { margin-left: auto; font-size: 9px; font-weight: 800;
  letter-spacing: 1.2px; color: var(--fh-text-mute); }
.fh-tm-self { background: var(--fh-rim); box-shadow: inset 3px 0 0 var(--fh-text); }
.fh-tm-self .fh-tm-name { font-weight: 800; }
.fh-tm-tag { margin-left: 6px; font-size: 9px; font-weight: 800;
  letter-spacing: 1.2px; padding: 0 4px; border-radius: 2px;
  background: var(--fh-text); color: var(--fh-ink); text-shadow: none; }
.fh-none { padding: 4px 10px; font-size: 10px; font-weight: 800;
  letter-spacing: 1.8px; color: var(--fh-text-mute); }
.fh-team-foe { display: flex; align-items: center; gap: 6px; padding: 4px 9px;
  font-size: 9px; font-weight: 800; letter-spacing: 1.6px;
  color: var(--fh-text-mute); background: var(--fh-track);
  border-top: 1px solid var(--fh-edge); }
.fh-foe-ico { display: block; width: 11px; height: 11px; flex: none; }
.fh-foe-t { color: var(--fh-t-lit); }
.fh-foe-ct { color: var(--fh-ct-lit); }
.fh-foe-n { margin-left: auto; color: var(--fh-text); }

/* ---- warmup lobby: both rosters side by side + the start condition --------
   Pointer-events stay off (it is part of .fh-layer): warmup is playable, so
   this is a readout, never a gate. It sits above the crosshair and clears it. */
.fh-lobby { position: absolute; left: 50%; top: 104px; transform: translateX(-50%);
  width: min(640px, 80vw); }
.fh-lobby-head { display: flex; align-items: center; justify-content: space-between;
  gap: 14px; padding: 9px 14px 8px; border-bottom: 1px solid var(--fh-edge); }
.fh-lobby-eyebrow { font-size: 10px; font-weight: 800; letter-spacing: 3.4px;
  color: var(--fh-text-mute); }
.fh-lobby-you { display: flex; align-items: center; gap: 7px; font-size: 11px;
  font-weight: 800; letter-spacing: 1.6px; color: var(--fh-text); }
.fh-lobby-you-ico { display: block; width: 14px; height: 14px; flex: none; }
.fh-lobby-you-t { color: var(--fh-t-lit); }
.fh-lobby-you-ct { color: var(--fh-ct-lit); }
.fh-lobby-cols { display: flex; }
.fh-lobby-col { flex: 1 1 0; min-width: 0; }
.fh-lobby-col + .fh-lobby-col { border-left: 1px solid var(--fh-edge); }
.fh-lobby-ch { display: flex; align-items: center; gap: 6px; padding: 5px 12px; }
.fh-lobby-ch-t { color: var(--fh-ink);
  background: linear-gradient(180deg, var(--fh-t-lit), var(--fh-t)); }
.fh-lobby-ch-ct { color: var(--fh-text);
  background: linear-gradient(180deg, var(--fh-ct-lit), var(--fh-ct)); }
.fh-lobby-ch-n { margin-left: auto; font-size: 10px; font-weight: 800;
  letter-spacing: 1px; border: 1px solid currentColor; border-radius: 999px;
  padding: 0 7px; text-shadow: none; white-space: nowrap; flex: none; }
.fh-lobby-ch-mine { margin-left: auto; font-size: 9px; font-weight: 900;
  letter-spacing: 1.4px; padding: 1px 6px; border-radius: 2px; flex: none;
  white-space: nowrap; background: var(--fh-ink); color: var(--fh-text);
  text-shadow: none; }
.fh-lobby-ch-mine + .fh-lobby-ch-n { margin-left: 6px; }
.fh-lobby-rows { padding: 6px 0 8px; min-height: 78px; }
.fh-lobby-row { padding-left: 12px; padding-right: 12px; }
.fh-lobby-rows .fh-none { padding-left: 12px; }
.fh-lobby-foot { padding: 7px 14px 9px; text-align: center; font-size: 10px;
  font-weight: 800; letter-spacing: 2.2px; color: var(--fh-text-mute);
  background: var(--fh-track); border-top: 1px solid var(--fh-edge); }
.fh-lobby-foot.fh-ready { color: var(--fh-text); }
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
  private readonly scoreTNum: HTMLSpanElement;
  private readonly scoreCTNum: HTMLSpanElement;
  private readonly scoreTPill: HTMLSpanElement;
  private readonly scoreCTPill: HTMLSpanElement;

  // team rail (in a round) + warmup lobby. Both are rebuilt wholesale, and only
  // when the roster signature actually moves (a join, a leave, a death, a side
  // swap) — never per frame. ~20 nodes, a handful of times per round.
  private readonly teamEl: HTMLDivElement;
  private readonly lobbyEl: HTMLDivElement;

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
  private cMine: Team | null | '' = '';   // which score chip carries the YOU pill
  private cTeamSig = Number.NaN;          // roster+alive hash behind the rail/lobby
  private cWarmup = false;                // lobby visible instead of the rail

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
    // Each score chip is [side mark + tag] [number] [YOU|ENEMY pill]; the CT
    // chip mirrors it with row-reverse so the pair still reads T-left/CT-right.
    this.scoreTEl = div('fh-score fh-panel fh-score-t');
    this.scoreTNum = span('fh-score-num');
    this.scoreTPill = span('fh-pill fh-pill-foe', 'ENEMY');
    this.scoreTEl.append(side('T'), this.scoreTNum, this.scoreTPill);
    this.scoreCTEl = div('fh-score fh-panel fh-score-ct');
    this.scoreCTNum = span('fh-score-num');
    this.scoreCTPill = span('fh-pill fh-pill-foe', 'ENEMY');
    this.scoreCTEl.append(side('CT'), this.scoreCTNum, this.scoreCTPill);
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

    // team rail + warmup lobby (contents built on the first roster signature)
    this.teamEl = div('fh-team fh-panel fh-hidden');
    this.lobbyEl = div('fh-lobby fh-panel fh-hidden');
    this.layer.append(this.teamEl, this.lobbyEl);
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
      this.scoreTNum.textContent = String(s.scoreT);
    }
    if (s.scoreCT !== this.cScoreCT) {
      this.cScoreCT = s.scoreCT;
      this.scoreCTNum.textContent = String(s.scoreCT);
    }
    // which of the two score chips is MINE — the pair must never be symmetrical
    if (s.team !== this.cMine) {
      this.cMine = s.team;
      const mineT = s.team === 'T';
      const mineCT = s.team === 'CT';
      this.scoreTEl.classList.toggle('fh-mine', mineT);
      this.scoreCTEl.classList.toggle('fh-mine', mineCT);
      pill(this.scoreTPill, s.team === null ? null : mineT);
      pill(this.scoreCTPill, s.team === null ? null : mineCT);
    }
    this.syncTeams(s);

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
   * The team rail and the warmup lobby. Both are pure functions of (your side,
   * your id, every player's name/side/alive) plus the warmup flag, so a 32-bit
   * FNV-1a over exactly those inputs decides whether anything is rebuilt: the
   * frames where nothing changed — the overwhelming majority — touch no DOM and
   * allocate nothing. A rebuild costs ~20 nodes and happens on a join, a leave,
   * a death, a respawn or a side swap.
   */
  private syncTeams(s: HudState): void {
    const warmup = s.phase === 'warmup';
    const sig = rosterSig(s);
    if (sig === this.cTeamSig && warmup === this.cWarmup) return;
    this.cTeamSig = sig;
    this.cWarmup = warmup;
    const team = s.team;
    if (team === null) {
      // not in a room yet: no side to claim, so claim nothing
      this.teamEl.classList.add('fh-hidden');
      this.lobbyEl.classList.add('fh-hidden');
      return;
    }
    // exactly one of the two is up: the lobby IS the warmup form of the rail
    this.teamEl.classList.toggle('fh-hidden', warmup);
    this.lobbyEl.classList.toggle('fh-hidden', !warmup);
    if (warmup) this.buildLobby(s, team);
    else this.buildRail(s, team);
  }

  /** Left rail: your side named and marked, your squad, the enemy head-count. */
  private buildRail(s: HudState, team: Team): void {
    const foeTeam = OTHER[team];
    const mine = pickTeam(s.players, team, s.you);
    const foe = pickTeam(s.players, foeTeam, s.you);
    const head = div(`fh-team-head fh-team-head-${lc(team)}`);
    head.append(
      icon(TEAM_ICON[team], 'fh-team-ico'),
      span('fh-team-tag', team),
      span('fh-team-name', TEAM_FULL[team]),
      span('fh-team-mine', 'YOU'),
    );
    const sub = div('fh-team-sub');
    sub.append(
      span('', 'YOUR TEAM'),
      span('fh-team-alive', `${aliveOf(mine)}/${mine.length} ALIVE`),
    );
    const list = div('fh-team-list');
    if (mine.length === 0) list.appendChild(div('fh-none', 'WAITING FOR SPAWN'));
    for (const p of mine) list.appendChild(memberRow(p, p.id === s.you, ''));
    const foeRow = div('fh-team-foe');
    foeRow.append(
      icon(TEAM_ICON[foeTeam], `fh-foe-ico fh-foe-${lc(foeTeam)}`),
      span(`fh-foe-${lc(foeTeam)}`, foeTeam),
      span('', 'ENEMY'),
      span('fh-foe-n', `${aliveOf(foe)}/${foe.length} ALIVE`),
    );
    this.teamEl.textContent = '';
    this.teamEl.append(head, sub, list, foeRow);
  }

  /** Warmup pre-match view: both rosters side by side + the start condition. */
  private buildLobby(s: HudState, team: Team): void {
    const head = div('fh-lobby-head');
    head.appendChild(span('fh-lobby-eyebrow', 'WARMUP LOBBY'));
    const you = div('fh-lobby-you');
    you.append(
      span('', 'YOU ARE'),
      icon(TEAM_ICON[team], `fh-lobby-you-ico fh-lobby-you-${lc(team)}`),
      span(`fh-lobby-you-${lc(team)}`, team),
      span('', TEAM_FULL[team]),
    );
    head.appendChild(you);

    const cols = div('fh-lobby-cols');
    cols.append(lobbyCol(s, 'T', team), lobbyCol(s, 'CT', team));

    const total = s.players.length;
    const ready = total >= MATCH_MIN_PLAYERS;
    const foot = div(`fh-lobby-foot${ready ? ' fh-ready' : ''}`);
    foot.textContent = ready
      ? `${total} PLAYERS IN — THE MATCH STARTS ANY MOMENT`
      : `WAITING FOR PLAYERS · ${total}/${MATCH_MIN_PLAYERS} — WARMUP IS LIVE, MOVE AND SHOOT`;

    this.lobbyEl.textContent = '';
    this.lobbyEl.append(head, cols, foot);
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

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function span(cls: string, text?: string): HTMLSpanElement {
  const s = document.createElement('span');
  if (cls !== '') s.className = cls;
  if (text !== undefined) s.textContent = text;
  return s;
}

const lc = (team: Team): string => (team === 'T' ? 't' : 'ct');

/** The [team mark + tag] cluster that leads a score chip. */
function side(team: Team): HTMLDivElement {
  const d = div('fh-side');
  d.append(icon(TEAM_ICON[team], 'fh-side-ico'), span('', team));
  return d;
}

/** Retag a score chip's pill: YOU (bright) / ENEMY (outline) / hidden (no room). */
function pill(el: HTMLSpanElement, mine: boolean | null): void {
  const you = mine === true;
  el.textContent = you ? 'YOU' : 'ENEMY';
  el.classList.toggle('fh-pill-you', you);
  el.classList.toggle('fh-pill-foe', !you);
  el.classList.toggle('fh-hidden', mine === null);
}

/** One roster line. Alive/dead is shape + strike-through + the word DEAD. */
function memberRow(p: HudPlayer, isYou: boolean, extra: string): HTMLDivElement {
  const row = div(`fh-tm${extra === '' ? '' : ` ${extra}`}${p.alive ? '' : ' fh-tm-dead'}${isYou ? ' fh-tm-self' : ''}`);
  row.append(
    div('fh-tm-mark'),
    span('fh-tm-name', p.name),
    span('fh-tm-state', p.alive ? '' : 'DEAD'),
  );
  if (isYou) row.appendChild(span('fh-tm-tag', 'YOU'));
  return row;
}

/** One warmup-lobby column: side header, head-count, the players on it. */
function lobbyCol(s: HudState, team: Team, yours: Team): HTMLDivElement {
  const rows = pickTeam(s.players, team, s.you);
  const col = div('fh-lobby-col');
  const ch = div(`fh-lobby-ch fh-lobby-ch-${lc(team)}`);
  ch.append(
    icon(TEAM_ICON[team], 'fh-team-ico'),
    span('fh-team-tag', team),
    span('fh-team-name', TEAM_FULL[team]),
  );
  if (team === yours) ch.appendChild(span('fh-lobby-ch-mine', 'YOURS'));
  ch.appendChild(span('fh-lobby-ch-n', `${rows.length}`));
  const body = div('fh-lobby-rows');
  if (rows.length === 0) body.appendChild(div('fh-none', 'NOBODY YET'));
  for (const p of rows) body.appendChild(memberRow(p, p.id === s.you, 'fh-lobby-row'));
  col.append(ch, body);
  return col;
}

/** One side's players, YOU pinned to the top, everyone else by name. */
function pickTeam(players: readonly HudPlayer[], team: Team, you: string): HudPlayer[] {
  const out = players.filter((p) => p.team === team);
  out.sort((a, b) => {
    if (a.id === you) return -1;
    if (b.id === you) return 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

function aliveOf(list: readonly HudPlayer[]): number {
  let n = 0;
  for (const p of list) if (p.alive) n++;
  return n;
}

/**
 * FNV-1a over EXACTLY what the rail and lobby render (your side + your id, then
 * every player's id, name, side and alive flag, in order). Runs every frame, so
 * it reads chars instead of building a signature string: no allocation.
 */
function rosterSig(s: HudState): number {
  let h = 0x811c9dc5;
  h = Math.imul(h ^ (s.team === null ? 0 : s.team === 'T' ? 1 : 2), 16777619);
  for (let i = 0; i < s.you.length; i++) h = Math.imul(h ^ s.you.charCodeAt(i), 16777619);
  for (const p of s.players) {
    for (let i = 0; i < p.id.length; i++) h = Math.imul(h ^ p.id.charCodeAt(i), 16777619);
    for (let i = 0; i < p.name.length; i++) h = Math.imul(h ^ p.name.charCodeAt(i), 16777619);
    h = Math.imul(h ^ (p.alive ? 1 : 2), 16777619);
    h = Math.imul(h ^ (p.team === 'T' ? 3 : 4), 16777619);
  }
  return h | 0;
}
