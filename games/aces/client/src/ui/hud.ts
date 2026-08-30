// ============================================================================
// ACES — C_UI hud.ts. In-match HUD: transparent canvas overlay + DOM chips.
//
// CANVAS OVERLAY (screen space — C_APP resets the world transform before the
// HUD draws; see seams.ts camera convention):
//   · gun crosshair anchored at screen CENTER offset along o.heading
//     ASSUMPTION (documented per brief): OverlayModel carries no own-plane
//     position, but the chase camera keeps the own plane at/near the screen
//     center (CAMERA.LOOKAHEAD_S introduces a small offset we cannot compute
//     from this seam). The crosshair therefore rides center + heading*lead.
//   · amber lead pip toward the nearest target inside the front arc, using
//     shared aimLead geometry. ASSUMPTION: OverlayModel.targets carries world
//     position + class only (no velocity/heading), so the intercept is
//     approximated with a ZERO target velocity — aimLead then reduces to the
//     range-compensated convergence point on the target hull. The pip's job
//     stays honest: it marks "your guns converge HERE now" without inventing
//     target kinematics the frozen seam does not carry.
//   · heat bar under the crosshair — bar LENGTH plus a text state (GUNS /
//     HEAT / JAMMED), warn hue only past HEAT_WARN (D4: never color alone).
//   · hit-marker × flash while (m.tick − o.hitConfirmTick) is small.
//   · directional hurt arcs while (m.tick − o.hurtTick) is small. The seam
//     carries hurtTick but NO shooter bearing, so the arc is oriented toward
//     the nearest living enemy — in a forward-fire duel the shooter is almost
//     always the plane you are turning against. Documented approximation.
//   · offscreen enemy edge arrows: project o.targets through o.cam, clamp the
//     ray from screen center onto an inset viewport box, draw arrow + team
//     badge (letter R/I AND distinct mark shape — D4 double encoding) + class
//     glyph letter. Nearest 3 (CONTRACT §5 C_UI).
//   · SUDDEN DEATH stamp centered while m.suddenDeath (the DOM clock hides;
//     the stamp replaces it here on canvas).
//
// DOM CHIPS ("operations room paperwork", STYLE_BIBLE §8): ink stamps +
// typewritten labels on translucent paper chips. Bottom-left HP + boost +
// throttle needle; top-center ticket bars "ROYAL ◀ n · n ▶ IRON" + clock;
// killfeed paper slips top-right fading after ~4 s of snapshot ticks; Tab
// hold-to-show two-column scoreboard with MVP star; ACE/LEGEND banners as big
// stamped text. Minimum 14 px type everywhere at 1080p.
//
// Discipline (mirrors kart/splat/outpost house idiom): the whole tree is
// built ONCE in createHud(); update() runs every frame and every DOM write is
// change-guarded; lists rebuild only when their content signature changes.
// Zero per-frame allocation in the draw path (RULES 4): all color strings,
// fonts and scratch records are hoisted module constants or instance fields.
//
// Color law: every tint traces to APAL via PAL / withAlpha / mixA / shadeA
// (STYLE_BIBLE §9). This file contains ZERO raw hex/rgba literals — even chip
// shadows derive from ink alpha, so nothing needs the sanctioned transparent
// black/white exception.
// ============================================================================

import {
  BOOST_MAX,
  CLASSES,
  FIRE_BELOW,
  HEAT_WARN,
  SNAP_RATE,
  TICKETS_TO_WIN,
} from '@aces/shared/config.js';
import type { PlaneClassId, TeamId } from '@aces/shared/config.js';
import { aimLead } from '@aces/shared/physics.js';
import type {
  Banner,
  CameraView,
  HudModel,
  KillFeedEntry,
  OverlayModel,
} from '../contract/seams.js';
import {
  fitCanvas,
  PAL,
  poly,
  star,
  withAlpha,
} from '../contract/visual.js';

// ---- tunables (module-private; config has no HUD-layout knobs) --------------

/** Killfeed slip lifetime: ~4 s expressed in snapshot ticks (brief). */
const FEED_TTL_TICKS = SNAP_RATE * 4;
/** Tail window of the slip lifetime over which it fades out linearly. */
const FEED_FADE_TICKS = SNAP_RATE * 1;
/** Hard cap on simultaneous slips — older entries beyond this drop early. */
const FEED_MAX_SLIPS = 6;

/** ACE/LEGEND banner hold (~2.5 s) and its fade tail, in snapshot ticks. */
const BANNER_TTL_TICKS = Math.round(SNAP_RATE * 2.5);
const BANNER_FADE_TICKS = Math.round(SNAP_RATE * 0.7);

/** Hit-marker × flash: ~0.2 s worth of snapshot ticks. */
const HIT_TICKS = Math.max(2, Math.round(SNAP_RATE * 0.2));
/** Directional hurt arcs: ~0.55 s worth of snapshot ticks. */
const HURT_TICKS = Math.round(SNAP_RATE * 0.55);

/** Crosshair lead distance ahead of the screen-center anchor, CSS px. */
const CROSS_LEAD_PX = 58;

// Heat-cluster geometry (CSS px): a paper-chipped gun/heat readout under the
// crosshair — chip backing keeps bar+label legible over open water/clouds.
const HEAT_W = 112;
const HEAT_H = 9;
/** Gap between bar bottom and the label slot's top edge. */
const HEAT_LABEL_GAP = 3;
const HEAT_LABEL_H = 14;
const CHIP_PAD_X = 9;
const CHIP_PAD_T = 6;
const CHIP_PAD_B = 6;
/** Stamped JAMMED plate: fixed-size box (no per-frame measureText), tilt §8. */
const JAM_W = 86;
const JAM_H = 20;
const JAM_ROT = -0.07;
/** Half-width of the "front arc" a target must sit in to earn a lead pip. */
const FRONT_ARC_RAD = 0.62;
/** Inset of the edge-arrow clamp box from the viewport border, CSS px. */
const EDGE_MARGIN_PX = 26;
/** Offscreen arrows drawn for at most the 3 nearest enemies (CONTRACT §5). */
const EDGE_ARROW_MAX = 3;

/**
 * HP fraction below which the status chip takes the warn tint. The brief pins
 * "warn tint when hp<25%"; config's FIRE_BELOW happens to encode the same
 * 0.25 for trails, but semantics differ, so the HUD owns its own constant
 * rather than borrowing a sim threshold (mirrors outpost's local LOW_HP).
 */
const HP_WARN_FRAC = 0.25;

// ---- shared label vocabulary (D4 double-encoding helpers) ---------------------

/** One-letter class glyph used on arrows, slips and roster rows (typewriter). */
export const CLS_GLYPH: Readonly<Record<PlaneClassId, string>> = {
  scout: 'S',
  fighter: 'F',
  gunship: 'G',
};

/** Team letters — ALWAYS paired with color AND a mark shape (D4 law). */
export const TEAM_LETTER: Readonly<Record<TeamId, string>> = {
  royal: 'R',
  iron: 'I',
};

// ============================================================================
// PURE display logic — exported, headlessly testable (no DOM, no canvas).
// Mirrors the outpost/splat split: the class below exercises these at runtime;
// hud.test.ts pins them directly because this workspace has no jsdom.
// ============================================================================

/** Scratch record reused by edgeArrowInto to keep the frame path alloc-free. */
export interface EdgeArrowOut {
  x: number;
  y: number;
  /** Outward direction the arrow should point, radians (canvas y-down). */
  angle: number;
}

/**
 * Project one world point through the camera and, if it lands OUTSIDE the
 * viewport inset by `margin`, pin it onto that inset box along the ray from
 * screen center and report true. Returns false when the point is on-screen
 * (no arrow needed) or the projection degenerates. Pure math; writes into
 * `out` so the 60 fps loop can reuse one scratch record (RULES 4).
 */
export function edgeArrowInto(
  out: EdgeArrowOut,
  wx: number,
  wy: number,
  cam: CameraView,
  vw: number,
  vh: number,
  margin: number = EDGE_MARGIN_PX,
): boolean {
  if (!(vw > 2 && vh > 2)) return false;
  // Keep the clamp box sane on absurdly small viewports.
  const mg = Math.min(margin, Math.floor(Math.min(vw, vh) / 4));
  const sx = (wx - cam.x) * cam.zoom + vw / 2;
  const sy = (wy - cam.y) * cam.zoom + vh / 2;
  const x0 = mg;
  const y0 = mg;
  const x1 = vw - mg;
  const y1 = vh - mg;
  if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) return false;
  const dx = sx - vw / 2;
  const dy = sy - vh / 2;
  const hw = Math.max(1, vw / 2 - mg);
  const hh = Math.max(1, vh / 2 - mg);
  let s = Number.POSITIVE_INFINITY;
  if (Math.abs(dx) > 1e-9) s = Math.min(s, hw / Math.abs(dx));
  if (Math.abs(dy) > 1e-9) s = Math.min(s, hh / Math.abs(dy));
  if (!Number.isFinite(s)) return false; // exactly at center yet outside box: impossible, guarded anyway
  out.x = vw / 2 + dx * s;
  out.y = vh / 2 + dy * s;
  out.angle = Math.atan2(dy, dx);
  return true;
}

/** Allocating wrapper of edgeArrowInto for tests and one-off callers. */
export function edgeArrow(
  wx: number,
  wy: number,
  cam: CameraView,
  vw: number,
  vh: number,
  margin: number = EDGE_MARGIN_PX,
): EdgeArrowOut | null {
  const out: EdgeArrowOut = { x: 0, y: 0, angle: 0 };
  return edgeArrowInto(out, wx, wy, cam, vw, vh, margin) ? out : null;
}

/** A killfeed slip is dead once its age in snapshot ticks reaches the TTL. */
export function feedExpired(e: KillFeedEntry, tick: number): boolean {
  return tick - e.bornTick >= FEED_TTL_TICKS;
}

/** Slip opacity: solid while fresh, linear fade across the final second. */
export function feedAlpha(e: KillFeedEntry, tick: number): number {
  const remain = FEED_TTL_TICKS - (tick - e.bornTick);
  if (remain <= 0) return 0;
  if (remain >= FEED_FADE_TICKS) return 1;
  return remain / FEED_FADE_TICKS;
}

/**
 * Stamped-banner opacity. ACE/LEGEND hold ~2.5 s then fade; kind
 * 'suddendeath' is rendered by the canvas stamp instead of the DOM banner,
 * so its DOM alpha is defined as a steady 1 (never used to hide anything).
 */
export function bannerAlpha(b: Banner, tick: number): number {
  if (b.kind === 'suddendeath') return 1;
  const remain = BANNER_TTL_TICKS - (tick - b.bornTick);
  if (remain <= 0) return 0;
  if (remain >= BANNER_FADE_TICKS) return 1;
  return remain / BANNER_FADE_TICKS;
}

/** True while a non-suddendeath banner should occupy the DOM banner slot. */
export function bannerLive(b: Banner, tick: number): boolean {
  return b.kind !== 'suddendeath' && bannerAlpha(b, tick) > 0;
}

/** mm:ss countdown text, ceiling so "0:01" still means one second left. */
export function clockText(timeLeftS: number): string {
  const s = Math.max(0, Math.ceil(Number.isFinite(timeLeftS) ? timeLeftS : 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/**
 * The top-center clock readout derived from the model. Sudden death REPLACES
 * the clock with the canvas stamp (brief), so the model-derived clock string
 * becomes empty exactly when suddenDeath flips on — the DOM hides on ''.
 */
export function matchClock(timeLeftS: number, suddenDeath: boolean): string {
  return suddenDeath ? '' : clockText(timeLeftS);
}

/** Ticket-bar fill percent vs TICKETS_TO_WIN, clamped to [0,100]. */
export function ticketPct(tickets: number): number {
  if (!Number.isFinite(tickets) || tickets <= 0) return 0;
  return Math.min(100, (tickets / TICKETS_TO_WIN) * 100);
}

/**
 * Scoreboard accuracy percent. shots===0 → null (renders as '—'): a pilot who
 * never fired has no accuracy, not 0% (div-by-zero guard per brief).
 */
export function accPct(shots: number, hits: number): number | null {
  if (!Number.isFinite(shots) || shots <= 0) return null;
  return Math.min(100, Math.round((hits / shots) * 100));
}

/** Human-readable key label for INPUT_KEYS codes (help card + menu listing). */
export function formatKey(code: string): string {
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

/**
 * 'KeyA'+'ArrowLeft' → 'A / ←'. Mirrored physical codes (ShiftLeft/ShiftRight
 * → the same SHIFT stamp) dedupe so a binding never prints one label twice.
 */
export function formatKeys(codes: readonly string[]): string {
  return Array.from(new Set(codes.map(formatKey))).join(' / ');
}

// ============================================================================
// Canvas overlay drawing
// ============================================================================

// ---- hoisted style strings (RULES 11: zero per-frame string churn) ----------

const FONT_TW = "'Courier New', ui-monospace, Menlo, monospace";
const FONT_COND = "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";
const FONT_LABEL_14 = `700 14px ${FONT_TW}`;
const FONT_STAMP = `900 46px ${FONT_COND}`;
const FONT_BADGE = `900 14px ${FONT_COND}`;
const FONT_JAM = `900 17px ${FONT_COND}`;

const INK_STRONG = withAlpha('ink', 0.92);
const PAPER_FILL = withAlpha('paper', 0.85);
const PAPER_EDGE = withAlpha('paper', 0.9);
const HEAT_TRACK = withAlpha('ink', 0.16);
const CHIP_EDGE = withAlpha('ink', 0.4);
const TRACER_FILL = withAlpha('tracer', 0.95);
const WARN_FILL = withAlpha('warn', 0.95);
const OK_FILL = withAlpha('ok', 0.95);
const FLASH_CORE = withAlpha('flash', 0.95);

/** Team fill colors — always paired with letter + shape at draw sites (D4). */
function teamFill(team: TeamId): string {
  return team === 'royal' ? withAlpha('royalNavy', 0.95) : withAlpha('ironRed', 0.95);
}

/**
 * Ink-stamp text block: double-ruled border box, slight rotation, translucent
 * paper ground — the §8 paperwork stamp. Deterministic; no animation rng.
 */
function drawStamp(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  text: string,
  rot: number,
  stroke: string,
  alpha: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.globalAlpha = alpha;
  ctx.font = FONT_STAMP;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width;
  const padX = 26;
  const padY = 16;
  const bw = w + padX * 2;
  const bh = 46 + padY * 2;
  ctx.fillStyle = PAPER_FILL;
  ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
  ctx.lineWidth = 3;
  ctx.strokeStyle = stroke;
  ctx.strokeRect(-bw / 2, -bh / 2, bw, bh);
  ctx.lineWidth = 1;
  ctx.strokeRect(-bw / 2 + 4, -bh / 2 + 4, bw - 8, bh - 8);
  ctx.fillStyle = stroke;
  ctx.fillText(text, 0, 2);
  ctx.restore();
}

/** Off-screen enemy edge arrow: chevron + team badge + class glyph. */
function drawEdgeArrow(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  angle: number,
  team: TeamId,
  cls: PlaneClassId,
): void {
  ctx.save();
  // Chevron pointing outward along the clamped ray.
  ctx.translate(ax, ay);
  ctx.rotate(angle);
  poly(ctx, [
    [13, 0],
    [-7, 8],
    [-3, 0],
    [-7, -8],
  ]);
  ctx.fillStyle = teamFill(team);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = PAPER_EDGE;
  ctx.stroke();
  ctx.restore();

  // Badge sits just INSIDE the viewport from the arrow (opposite the ray),
  // carrying letter R/I AND a distinct mark shape — roundel circle for ROYAL,
  // square plate for IRON — so identity survives any color vision (D4).
  const bx = ax - Math.cos(angle) * 26;
  const by = ay - Math.sin(angle) * 26;
  ctx.save();
  ctx.translate(bx, by);
  ctx.beginPath();
  if (team === 'royal') {
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
  } else {
    ctx.rect(-9, -9, 18, 18);
  }
  ctx.fillStyle = PAPER_FILL;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = teamFill(team);
  ctx.stroke();
  ctx.font = FONT_BADGE;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK_STRONG;
  ctx.fillText(TEAM_LETTER[team], 0, 1);
  // Class glyph trails the badge — typewritten requisition-tag style.
  ctx.font = FONT_LABEL_14;
  ctx.textAlign = 'left';
  ctx.fillText(CLS_GLYPH[cls], 12, 1);
  ctx.restore();
}

// ============================================================================
// The HUD object
// ============================================================================

export interface Hud {
  /** Called each frame; draws the canvas overlay + syncs DOM chips. */
  update(m: HudModel, o: OverlayModel): void;
  destroy(): void;
}

const STYLE_ID = 'aces-hud-style';
const ROOT_ID = 'aces-hud-root';

// CSS is a template fed by palette-derived custom properties (set once on the
// root element below). No raw colors appear here — every var() resolves to a
// withAlpha/mixA product of APAL endpoints (bible §9; no exceptions needed,
// so the transparent-black/white rgba allowance goes unused in this file).
const CSS = `
.aces-hud{position:fixed;inset:0;z-index:20;pointer-events:none;overflow:hidden;
  font-family:var(--ac-font-ui);color:var(--ac-ink);user-select:none;-webkit-user-select:none;}
.aces-hud.off{display:none;}
.aces-tw{font-family:var(--ac-font-tw);text-transform:uppercase;letter-spacing:.08em;}
.aces-chip{position:absolute;background:var(--ac-paper88);border:1px solid var(--ac-ink55);
  border-radius:2px;box-shadow:0 2px 8px var(--ac-ink30);}
.aces-track{position:relative;height:10px;background:var(--ac-ink18);border:1px solid var(--ac-ink40);}
.aces-fill{display:block;height:100%;transition:width .12s linear;}

/* bottom-left flight record */
.aces-status{left:16px;bottom:16px;padding:10px 14px 12px;min-width:236px;}
.aces-status-head{font-size:14px;font-weight:700;color:var(--ac-ink75);margin-bottom:8px;}
.aces-row{display:flex;align-items:center;gap:8px;margin-top:6px;}
.aces-rowlabel{width:52px;font-size:14px;font-weight:700;color:var(--ac-ink75);}
.aces-rowval{width:44px;text-align:right;font-size:15px;font-weight:800;}
.aces-row .aces-track{flex:1;}
.aces-fill.hp{background:var(--ac-ok);}
.aces-fill.bo{background:var(--ac-tracer);}
.aces-lowstamp{display:none;padding:1px 6px;border:2px solid var(--ac-warn);color:var(--ac-warn);
  font-size:14px;font-weight:900;transform:rotate(-4deg);}
.aces-status.low .aces-lowstamp{display:inline-block;}
.aces-status.low .aces-fill.hp{background:var(--ac-warn);}
.aces-gauge{flex:1;display:flex;align-items:flex-end;height:34px;border-bottom:2px solid var(--ac-ink55);
  margin-left:60px;width:110px;position:relative;}
.aces-needle{position:absolute;left:50%;bottom:0;width:2px;height:28px;background:var(--ac-ink);
  transform-origin:bottom center;transition:transform .1s linear;}

/* top-center tickets */
.aces-tickets{left:50%;top:12px;transform:translateX(-50%);padding:8px 14px;display:flex;
  align-items:center;gap:10px;}
.aces-teamname{font-size:15px;font-weight:900;letter-spacing:.14em;}
.aces-badge{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;
  font-size:14px;font-weight:900;border:2px solid currentColor;margin-right:2px;}
.aces-badge.r{border-radius:50%;color:var(--ac-royal);}
.aces-badge.i{border-radius:0;color:var(--ac-iron);}
.aces-count{font-size:15px;font-weight:800;min-width:44px;text-align:center;}
.aces-bars{display:flex;align-items:center;gap:8px;}
.aces-bar{width:150px;}
.aces-bar.royal .aces-fill{background:var(--ac-royal);}
.aces-bar.iron .aces-fill{background:var(--ac-iron);}
.aces-clock{min-width:64px;text-align:center;font-size:17px;font-weight:800;}

/* killfeed slips */
.aces-feed{position:absolute;right:14px;top:56px;display:flex;flex-direction:column;align-items:flex-end;gap:6px;}
.aces-slip{display:flex;align-items:center;gap:8px;padding:4px 10px;max-width:340px;
  background:var(--ac-paper92);border:1px solid var(--ac-ink45);border-radius:2px;
  box-shadow:0 2px 6px var(--ac-ink30);animation:aces-slidein .16s ease-out;}
@keyframes aces-slidein{from{transform:translateX(16px);opacity:0;}to{transform:none;opacity:1;}}
.aces-slip-text{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.aces-slip-glyph{margin-left:auto;font-size:14px;font-weight:800;color:var(--ac-ink75);padding-left:8px;}

/* scoreboard (Tab hold) */
.aces-score{left:50%;top:50%;transform:translate(-50%,-50%);width:min(720px,92vw);
  padding:14px 18px;display:none;}
.aces-score.open{display:block;}
.aces-score-head{font-size:14px;font-weight:700;color:var(--ac-ink75);padding-bottom:8px;
  border-bottom:1px solid var(--ac-ink45);margin-bottom:8px;}
.aces-score-cols{display:flex;gap:22px;}
.aces-score-col{flex:1;min-width:0;}
.aces-score-colhead{display:flex;align-items:center;gap:6px;font-size:15px;font-weight:900;
  letter-spacing:.14em;padding:2px 4px 6px;border-bottom:1px solid var(--ac-ink30);}
.aces-rowline{display:flex;align-items:baseline;gap:8px;padding:3px 4px;font-size:14px;}
.aces-rowline+.aces-rowline{border-top:1px dashed var(--ac-ink18);}
.aces-rowname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;}
.aces-rowstats{white-space:nowrap;font-size:14px;color:var(--ac-ink75);}
.aces-mvp{color:var(--ac-tracer);font-weight:900;}
.aces-bottag{font-size:14px;color:var(--ac-ink55);border:1px solid var(--ac-ink30);padding:0 3px;}

/* stamped banner */
.aces-banner{left:50%;top:19%;transform:translateX(-50%) rotate(-2deg);position:absolute;
  padding:8px 30px;border:4px double var(--ac-ink);background:var(--ac-paper80);
  font-family:var(--ac-font-cond);font-weight:900;font-size:54px;letter-spacing:.14em;line-height:1.05;
  color:var(--ac-ink);text-transform:uppercase;}
.aces-banner.ace{border-color:var(--ac-tracer);color:var(--ac-ink);}
.aces-banner.legend{border-color:var(--ac-warn);}

/* muted tag */
.aces-muted{position:absolute;right:16px;bottom:16px;padding:3px 10px;border:2px solid var(--ac-ink55);
  background:var(--ac-paper80);font-size:14px;font-weight:800;color:var(--ac-ink75);}
.aces-muted.on{display:block;}

@media (prefers-reduced-motion: reduce){
  .aces-slip{animation:none;}
  .aces-fill,.aces-needle{transition:none;}
}
`;

class AcesHud implements Hud {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly root: HTMLElement;
  private readonly styleEl: HTMLStyleElement | null;
  private readonly feedBox: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly scoreEl: HTMLElement;
  private readonly scoreRoyal: HTMLElement;
  private readonly scoreIron: HTMLElement;
  private readonly clockEl: HTMLElement;
  private readonly royalBar: HTMLElement;
  private readonly ironBar: HTMLElement;
  private readonly royalCount: HTMLElement;
  private readonly ironCount: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly hpVal: HTMLElement;
  private readonly boFill: HTMLElement;
  private readonly needle: HTMLElement;
  private readonly statusChip: HTMLElement;
  private readonly mutedTag: HTMLElement;

  /** feed slip id → node + last-applied fade step (change guard). */
  private readonly slips = new Map<number, { node: HTMLElement; lastStep: number }>();
  private feedSig = '';
  private boardSig = '';
  private bannerSig = '';
  private tabHeld = false;
  private destroyed = false;

  // change-guard baselines (avoid per-frame DOM writes)
  private lastW = -1;
  private lastH = -1;
  private lastDpr = 1;
  private lastRoyalTxt = '';
  private lastIronTxt = '';
  private lastClock = '';
  private lastRoyalPct = -1;
  private lastIronPct = -1;
  private lastHpTxt = '';
  private lastHpPct = -1;
  private lastBoPct = -1;
  private lastNeedleDeg = 999;
  private lastMuted: boolean | null = null;
  private lastBannerStep = -1;
  private warnedDraw = false;
  private warnedDom = false;

  // scratch records — the frame path writes numbers into THESE (RULES 4)
  private readonly edge: EdgeArrowOut = { x: 0, y: 0, angle: 0 };
  private readonly nearIdx: number[] = [-1, -1, -1];
  private readonly nearD2: number[] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];

  private readonly onTabDown = (e: KeyboardEvent): void => {
    if (e.code !== 'Tab') return;
    e.preventDefault(); // TAB belongs to the scoreboard, never to focus roaming
    this.tabHeld = true;
  };
  private readonly onTabUp = (e: KeyboardEvent): void => {
    if (e.code !== 'Tab') return;
    this.tabHeld = false;
  };
  private readonly onBlur = (): void => {
    this.tabHeld = false; // RULES 6: blur clears held inputs — scoreboard included
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.styleEl = injectStyleOnce(STYLE_ID, CSS);

    this.root = document.createElement('div');
    this.root.id = ROOT_ID;
    this.root.className = 'aces-hud off';
    applyThemeVars(this.root.style);

    // ---- bottom-left flight record -------------------------------------
    this.statusChip = div('aces-chip aces-status');
    const head = div('aces-status-head aces-tw');
    head.textContent = 'FLIGHT RECORD';
    this.statusChip.appendChild(head);
    const hpRow = div('aces-row');
    hpRow.appendChild(label('HP'));
    const hpTrack = div('aces-track');
    this.hpFill = div('aces-fill hp');
    hpTrack.appendChild(this.hpFill);
    hpRow.appendChild(hpTrack);
    this.hpVal = valSpan('100');
    hpRow.appendChild(this.hpVal);
    const low = span('aces-lowstamp');
    low.textContent = 'LOW';
    low.setAttribute('aria-hidden', 'true');
    hpRow.appendChild(low);
    this.statusChip.appendChild(hpRow);
    const boRow = div('aces-row');
    boRow.appendChild(label('BOOST'));
    const boTrack = div('aces-track');
    this.boFill = div('aces-fill bo');
    boTrack.appendChild(this.boFill);
    boRow.appendChild(boTrack);
    this.statusChip.appendChild(boRow);
    const thrRow = div('aces-row');
    thrRow.appendChild(label('THR'));
    this.needle = div('aces-needle');
    const gauge = div('aces-gauge');
    gauge.setAttribute('aria-hidden', 'true');
    gauge.appendChild(this.needle);
    thrRow.appendChild(gauge);
    this.statusChip.appendChild(thrRow);
    this.root.appendChild(this.statusChip);

    // ---- top-center tickets ---------------------------------------------
    const tickets = div('aces-chip aces-tickets');
    tickets.appendChild(badge('r', TEAM_LETTER.royal));
    const rn = span('aces-teamname');
    rn.textContent = 'ROYAL';
    tickets.appendChild(rn);
    this.royalCount = span('aces-count');
    this.royalCount.textContent = '◀ 0';
    tickets.appendChild(this.royalCount);
    const bars = div('aces-bars');
    const rb = div('aces-track aces-bar royal');
    this.royalBar = div('aces-fill');
    rb.appendChild(this.royalBar);
    bars.appendChild(rb);
    this.clockEl = span('aces-clock');
    this.clockEl.textContent = '8:00';
    bars.appendChild(this.clockEl);
    const ib = div('aces-track aces-bar iron');
    this.ironBar = div('aces-fill');
    ib.appendChild(this.ironBar);
    bars.appendChild(ib);
    tickets.appendChild(bars);
    this.ironCount = span('aces-count');
    this.ironCount.textContent = '0 ▶';
    tickets.appendChild(this.ironCount);
    const iname = span('aces-teamname');
    iname.textContent = 'IRON';
    tickets.appendChild(iname);
    tickets.appendChild(badge('i', TEAM_LETTER.iron));
    this.root.appendChild(tickets);

    // ---- killfeed / banner / scoreboard / muted --------------------------
    this.feedBox = div('aces-feed');
    this.feedBox.setAttribute('aria-live', 'polite');
    this.root.appendChild(this.feedBox);

    this.bannerEl = div('aces-banner');
    this.bannerEl.setAttribute('aria-live', 'polite');
    this.bannerEl.style.opacity = '0';
    this.root.appendChild(this.bannerEl);

    this.scoreEl = div('aces-chip aces-score');
    const sHead = div('aces-score-head aces-tw');
    sHead.textContent = 'SQUADRON RECORD — HOLD TAB';
    this.scoreEl.appendChild(sHead);
    const cols = div('aces-score-cols');
    const colR = div('aces-score-col');
    colR.appendChild(colHeader('r', 'ROYAL'));
    this.scoreRoyal = div('');
    colR.appendChild(this.scoreRoyal);
    cols.appendChild(colR);
    const colI = div('aces-score-col');
    colI.appendChild(colHeader('i', 'IRON'));
    this.scoreIron = div('');
    colI.appendChild(this.scoreIron);
    cols.appendChild(colI);
    this.scoreEl.appendChild(cols);
    this.root.appendChild(this.scoreEl);

    this.mutedTag = div('aces-muted aces-tw');
    this.mutedTag.textContent = 'SOUND OFF';
    this.root.appendChild(this.mutedTag);

    document.body.appendChild(this.root);

    window.addEventListener('keydown', this.onTabDown);
    window.addEventListener('keyup', this.onTabUp);
    window.addEventListener('blur', this.onBlur);
  }

  update(m: HudModel, o: OverlayModel): void {
    try {
      this.drawOverlay(m, o);
    } catch (err) {
      // RULES 5: one subsystem throwing must log once, not kill the loop.
      if (!this.warnedDraw) {
        this.warnedDraw = true;
        console.warn('[aces-hud] overlay draw failed once:', err);
      }
    }
    try {
      this.syncDom(m);
    } catch (err) {
      if (!this.warnedDom) {
        this.warnedDom = true;
        console.warn('[aces-hud] dom sync failed once:', err);
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener('keydown', this.onTabDown);
    window.removeEventListener('keyup', this.onTabUp);
    window.removeEventListener('blur', this.onBlur);
    this.slips.clear();
    this.root.remove();
    this.styleEl?.remove();
    const ctx = this.ctx;
    if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // ---- canvas overlay ----------------------------------------------------

  private drawOverlay(m: HudModel, o: OverlayModel): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const { w, h } = fitCanvas(this.canvas);
    if (w !== this.lastW || h !== this.lastH) {
      this.lastW = w;
      this.lastH = h;
      this.lastDpr = this.canvas.width / Math.max(1, w);
    }
    ctx.setTransform(this.lastDpr, 0, 0, this.lastDpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Nearest-enemy bookkeeping feeds BOTH the hurt-arc bearing and nothing
    // else; the pip uses its own in-front-arc scan. Single pass, numbers only.
    let bestIdx = -1;
    let bestD2 = Number.POSITIVE_INFINITY;

    // Reset nearest-3 selection scratch.
    for (let k = 0; k < EDGE_ARROW_MAX; k++) {
      this.nearIdx[k] = -1;
      this.nearD2[k] = Number.POSITIVE_INFINITY;
    }

    const targets = o.targets;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t === undefined) continue;
      const ddx = t.x - o.cam.x;
      const ddy = t.y - o.cam.y;
      const d2 = ddx * ddx + ddy * ddy;

      // overall nearest (hurt-arc orientation)
      if (d2 < bestD2) {
        bestD2 = d2;
        bestIdx = i;
      }

      // insertion into the ascending nearest-3 slots
      for (let k = 0; k < EDGE_ARROW_MAX; k++) {
        if (d2 < this.nearD2[k]!) {
          for (let j = EDGE_ARROW_MAX - 1; j > k; j--) {
            this.nearD2[j] = this.nearD2[j - 1]!;
            this.nearIdx[j] = this.nearIdx[j - 1]!;
          }
          this.nearD2[k] = d2;
          this.nearIdx[k] = i;
          break;
        }
      }
    }

    // --- offscreen enemy arrows (nearest 3, D4-badged) --------------------
    if (w > 4 && h > 4) {
      for (let k = 0; k < EDGE_ARROW_MAX; k++) {
        const idx = this.nearIdx[k]!;
        if (idx < 0) continue;
        const t = targets[idx];
        if (t === undefined) continue;
        if (edgeArrowInto(this.edge, t.x, t.y, o.cam, w, h)) {
          drawEdgeArrow(ctx, this.edge.x, this.edge.y, this.edge.angle, t.team, t.cls);
        }
      }
    }

    // --- sudden-death stamp replaces the clock (canvas-owned, brief) -------
    if (m.suddenDeath && m.phase === 'live') {
      const pulse = 0.82 + 0.18 * Math.sin(m.tick * 0.35);
      drawStamp(ctx, w / 2, h * 0.3, 'SUDDEN DEATH', -0.05, WARN_FILL, pulse);
    }

    // --- gun cluster: only meaningful while flying -------------------------
    if (!o.alive || m.you === null) return;

    // ASSUMPTION (documented at file head): own plane ≈ screen center; the
    // crosshair rides the heading vector out to a fixed lead distance.
    const hx = w / 2 + Math.cos(o.heading) * CROSS_LEAD_PX;
    const hy = h / 2 + Math.sin(o.heading) * CROSS_LEAD_PX;

    // crosshair ring + ticks — paper core under ink hairline so it reads on
    // both bright sky and dark sea without introducing new tones
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = PAPER_EDGE;
    ctx.beginPath();
    ctx.arc(hx, hy, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = INK_STRONG;
    ctx.stroke();
    for (let q = 0; q < 4; q++) {
      const a = o.heading + (q * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(hx + Math.cos(a) * 12, hy + Math.sin(a) * 12);
      ctx.lineTo(hx + Math.cos(a) * 18, hy + Math.sin(a) * 18);
      ctx.stroke();
    }
    ctx.restore();

    // --- lead pip: nearest target inside the front arc ----------------------
    let pipIdx = -1;
    let pipD2 = Number.POSITIVE_INFINITY;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t === undefined) continue;
      const bearing = Math.atan2(t.y - o.cam.y, t.x - o.cam.x);
      let rel = bearing - o.heading;
      if (rel > Math.PI) rel -= Math.PI * 2;
      if (rel < -Math.PI) rel += Math.PI * 2;
      if (Math.abs(rel) > FRONT_ARC_RAD) continue;
      const dx = t.x - o.cam.x;
      const dy = t.y - o.cam.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < pipD2) {
        pipD2 = d2;
        pipIdx = i;
      }
    }
    if (pipIdx >= 0) {
      const t = targets[pipIdx]!;
      const projSpeed = CLASSES[m.you.cls].gun.bulletSpeed;
      // Zero-velocity intercept (see file-head assumption): aimLead with
      // tvx=tvy=0 collapses onto the target hull — the honest reading of the
      // data the frozen OverlayModel actually carries.
      const lead = aimLead(o.cam.x, o.cam.y, t.x, t.y, 0, 0, projSpeed);
      const lx = (lead.x - o.cam.x) * o.cam.zoom + w / 2;
      const ly = (lead.y - o.cam.y) * o.cam.zoom + h / 2;
      star(ctx, lx, ly, 4, 7, 2.8, o.heading);
      ctx.fillStyle = TRACER_FILL;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = INK_STRONG;
      ctx.stroke();
    }

    // --- heat cluster under crosshair: paper chip + bar LENGTH + strong-ink
    //     text carry the state (D4); jammed swaps in a stamped warn plate ----
    const heat = clamp01(o.heat);
    const bx = hx - HEAT_W / 2;
    const by = hy + 26;
    const chipW = HEAT_W + CHIP_PAD_X * 2;
    const chipH = CHIP_PAD_T + HEAT_H + HEAT_LABEL_GAP + HEAT_LABEL_H + CHIP_PAD_B;
    ctx.fillStyle = PAPER_FILL;
    ctx.fillRect(hx - chipW / 2, by - CHIP_PAD_T, chipW, chipH);
    ctx.lineWidth = 1;
    ctx.strokeStyle = CHIP_EDGE;
    ctx.strokeRect(hx - chipW / 2 + 0.5, by - CHIP_PAD_T + 0.5, chipW - 1, chipH - 1);

    ctx.fillStyle = HEAT_TRACK;
    ctx.fillRect(bx, by, HEAT_W, HEAT_H);
    ctx.fillStyle = o.jammed || heat > HEAT_WARN ? WARN_FILL : OK_FILL;
    ctx.fillRect(bx, by, HEAT_W * heat, HEAT_H);
    ctx.strokeStyle = INK_STRONG;
    ctx.strokeRect(bx, by, HEAT_W, HEAT_H);

    ctx.textAlign = 'center';
    if (o.jammed) {
      // Stamped JAMMED plate — bigger type, warn ink, slight §8-stamp tilt.
      ctx.save();
      ctx.translate(hx, by + HEAT_H + HEAT_LABEL_GAP + HEAT_LABEL_H / 2);
      ctx.rotate(JAM_ROT);
      ctx.font = FONT_JAM;
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = WARN_FILL;
      ctx.fillStyle = WARN_FILL;
      ctx.lineWidth = 2;
      ctx.strokeRect(-JAM_W / 2, -JAM_H / 2, JAM_W, JAM_H);
      ctx.fillText('JAMMED', 0, 1);
      ctx.restore();
    } else {
      ctx.font = FONT_LABEL_14;
      ctx.textBaseline = 'top';
      ctx.fillStyle = heat > HEAT_WARN ? WARN_FILL : INK_STRONG;
      ctx.fillText(heat > HEAT_WARN ? 'HEAT' : 'GUNS', hx, by + HEAT_H + HEAT_LABEL_GAP);
    }

    // --- hit marker × flash --------------------------------------------------
    const hitAge = m.tick - o.hitConfirmTick;
    if (hitAge >= 0 && hitAge < HIT_TICKS) {
      const a = 1 - hitAge / HIT_TICKS;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.lineWidth = 4;
      ctx.strokeStyle = INK_STRONG;
      drawX(ctx, hx, hy, 10);
      ctx.lineWidth = 2;
      ctx.strokeStyle = FLASH_CORE;
      drawX(ctx, hx, hy, 10);
      ctx.restore();
    }

    // --- directional hurt arcs ----------------------------------------------
    // Seam gap (documented): hurtTick carries no bearing. Orient toward the
    // nearest living enemy; skip entirely when nobody is airborne.
    const hurtAge = m.tick - o.hurtTick;
    if (hurtAge >= 0 && hurtAge < HURT_TICKS && bestIdx >= 0) {
      const t = targets[bestIdx]!;
      const ang = Math.atan2(t.y - o.cam.y, t.x - o.cam.x);
      ctx.save();
      ctx.globalAlpha = 0.85 * (1 - hurtAge / HURT_TICKS);
      ctx.lineWidth = 10;
      ctx.strokeStyle = WARN_FILL;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 88, ang - 0.42, ang + 0.42);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = INK_STRONG;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 94, ang - 0.42, ang + 0.42);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- DOM chips -----------------------------------------------------------

  private syncDom(m: HudModel): void {
    const live = m.phase === 'live';
    toggleOff(this.root, !live);
    if (!live) {
      setClass(this.scoreEl, 'open', false);
      return;
    }

    // tickets + clock
    const rp = ticketPct(m.tickets.royal);
    const ip = ticketPct(m.tickets.iron);
    if (rp !== this.lastRoyalPct) {
      this.lastRoyalPct = rp;
      this.royalBar.style.width = `${rp}%`;
    }
    if (ip !== this.lastIronPct) {
      this.lastIronPct = ip;
      this.ironBar.style.width = `${ip}%`;
    }
    const rt = `◀ ${m.tickets.royal}`;
    if (rt !== this.lastRoyalTxt) {
      this.lastRoyalTxt = rt;
      this.royalCount.textContent = rt;
    }
    const it = `${m.tickets.iron} ▶`;
    if (it !== this.lastIronTxt) {
      this.lastIronTxt = it;
      this.ironCount.textContent = it;
    }
    const clock = matchClock(m.timeLeftS, m.suddenDeath);
    if (clock !== this.lastClock) {
      this.lastClock = clock;
      // '' ⇒ the canvas SUDDEN DEATH stamp owns this slot; hide the digits.
      setHidden(this.clockEl, clock === '');
      if (clock !== '') this.clockEl.textContent = clock;
    }

    // flight record (m.you may be null while spectating pre-first-spawn)
    const you = m.you;
    if (you !== null) {
      const hpTxt = String(Math.ceil(Math.max(0, you.hp)));
      if (hpTxt !== this.lastHpTxt) {
        this.lastHpTxt = hpTxt;
        this.hpVal.textContent = hpTxt;
      }
      const hpPct = Math.round(clamp01(you.maxHp > 0 ? you.hp / you.maxHp : 0) * 100);
      if (hpPct !== this.lastHpPct) {
        this.lastHpPct = hpPct;
        this.hpFill.style.width = `${hpPct}%`;
      }
      const low = you.maxHp > 0 && you.hp / you.maxHp < HP_WARN_FRAC;
      setClass(this.statusChip, 'low', low);
      const boPct = Math.round(clamp01(you.boost / BOOST_MAX) * 100);
      if (boPct !== this.lastBoPct) {
        this.lastBoPct = boPct;
        this.boFill.style.width = `${boPct}%`;
      }
      // throttle −0.3..1 → −72°..+72° needle sweep
      const deg = Math.round((((you.throttle + 0.3) / 1.3) * 144 - 72) * 2) / 2;
      if (deg !== this.lastNeedleDeg) {
        this.lastNeedleDeg = deg;
        this.needle.style.transform = `translateX(-50%) rotate(${deg}deg)`;
      }
    }

    // muted tag
    if (m.muted !== this.lastMuted) {
      this.lastMuted = m.muted;
      setClass(this.mutedTag, 'on', m.muted);
    }

    this.syncFeed(m);
    this.syncBanner(m);
    this.syncScoreboard(m);
  }

  private syncFeed(m: HudModel): void {
    // Membership signature includes bornTick so a rebuilt entry (server
    // resend) re-renders, and drops naturally when entries expire.
    const alive: KillFeedEntry[] = [];
    let sig = '';
    for (const e of m.feed) {
      if (feedExpired(e, m.tick)) continue;
      alive.push(e);
      sig += `${e.id}:${e.bornTick};`;
    }
    if (alive.length > FEED_MAX_SLIPS) alive.splice(0, alive.length - FEED_MAX_SLIPS);
    if (sig !== this.feedSig) {
      this.feedSig = sig;
      for (const s of this.slips.values()) s.node.remove();
      this.slips.clear();
      for (const e of alive) {
        const slip = div('aces-slip');
        slip.appendChild(feedBadge(e.killerTeam));
        const txt = span('aces-slip-text');
        txt.textContent = e.crash
          ? `✝ ${e.victimName} CRASHED`
          : `${e.killerName} ▸ ${e.victimName}`;
        slip.appendChild(txt);
        const g = span('aces-slip-glyph');
        g.textContent = CLS_GLYPH[e.killerCls];
        g.setAttribute('aria-hidden', 'true');
        slip.appendChild(g);
        this.feedBox.appendChild(slip);
        this.slips.set(e.id, { node: slip, lastStep: -1 });
      }
    }
    // Fade pass — quantized to 1/20 steps so opacity writes stay rare, and
    // closure-free (a .find callback here would allocate every frame).
    for (const e of alive) {
      const s = this.slips.get(e.id);
      if (s === undefined) continue;
      const step = Math.round(feedAlpha(e, m.tick) * 20);
      if (step !== s.lastStep) {
        s.lastStep = step;
        s.node.style.opacity = String(step / 20);
      }
    }
  }

  private syncBanner(m: HudModel): void {
    let best: Banner | null = null;
    for (const b of m.banners) {
      if (!bannerLive(b, m.tick)) continue;
      if (best === null || b.bornTick > best.bornTick) best = b;
    }
    if (best === null) {
      if (this.bannerSig !== '') {
        this.bannerSig = '';
        this.bannerEl.style.opacity = '0';
      }
      return;
    }
    const sig = `${best.kind}:${best.bornTick}`;
    if (sig !== this.bannerSig) {
      this.bannerSig = sig;
      this.bannerEl.textContent = best.text;
      setClass(this.bannerEl, 'ace', best.kind === 'ace');
      setClass(this.bannerEl, 'legend', best.kind === 'legend');
    }
    const step = Math.round(bannerAlpha(best, m.tick) * 20);
    if (step !== this.lastBannerStep) {
      this.lastBannerStep = step;
      this.bannerEl.style.opacity = String(step / 20);
    }
  }

  private syncScoreboard(m: HudModel): void {
    const open = this.tabHeld;
    setClass(this.scoreEl, 'open', open);
    if (!open) return;

    // Sort a COPY (rebuild path — event-frequency, not per-frame hot).
    const rows = [...m.board].sort(
      (a, b) => b.score - a.score || b.kills - a.kills || a.name.localeCompare(b.name),
    );
    let sig = '';
    for (const r of rows) {
      sig += `${r.id}:${r.kills}:${r.deaths}:${r.shots}:${r.hits}:${r.score};`;
    }
    if (sig === this.boardSig) return;
    this.boardSig = sig;

    this.scoreRoyal.replaceChildren();
    this.scoreIron.replaceChildren();
    let mvpId: string | null = null;
    let mvpScore = -1;
    for (const r of rows) {
      if (r.score > mvpScore) {
        mvpScore = r.score;
        mvpId = r.id;
      }
    }
    for (const r of rows) {
      const line = div('aces-rowline');
      line.appendChild(badge(r.team === 'royal' ? 'r' : 'i', TEAM_LETTER[r.team]));
      const name = span('aces-rowname');
      name.textContent = r.name;
      if (r.bot) {
        const bot = span('aces-bottag');
        bot.textContent = 'BOT';
        name.appendChild(bot);
      }
      if (mvpId === r.id) {
        const starEl = span('aces-mvp');
        starEl.textContent = '★';
        starEl.title = 'MVP';
        name.insertBefore(starEl, name.firstChild);
      }
      line.appendChild(name);
      const stats = span('aces-rowstats');
      const acc = accPct(r.shots, r.hits);
      stats.textContent = `K ${r.kills} · D ${r.deaths} · ${acc === null ? '—' : `${acc}%`}`;
      line.appendChild(stats);
      (r.team === 'royal' ? this.scoreRoyal : this.scoreIron).appendChild(line);
    }
  }
}

// ============================================================================
// small local helpers
// ============================================================================

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function span(cls: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  return s;
}

function label(text: string): HTMLSpanElement {
  const s = span('aces-rowlabel aces-tw');
  s.textContent = text;
  return s;
}

function valSpan(initial: string): HTMLSpanElement {
  const s = span('aces-rowval');
  s.textContent = initial;
  return s;
}

/** Team badge: letter + mark SHAPE (roundel circle vs square plate) — D4. */
function badge(kind: 'r' | 'i', letter: string): HTMLSpanElement {
  const b = span(`aces-badge ${kind}`);
  b.textContent = letter;
  b.setAttribute('aria-hidden', 'true');
  return b;
}

function feedBadge(team: TeamId): HTMLSpanElement {
  return badge(team === 'royal' ? 'r' : 'i', TEAM_LETTER[team]);
}

function colHeader(kind: 'r' | 'i', name: string): HTMLElement {
  const h = div('aces-score-colhead');
  h.appendChild(badge(kind, kind === 'r' ? TEAM_LETTER.royal : TEAM_LETTER.iron));
  const n = span('');
  n.textContent = name;
  h.appendChild(n);
  return h;
}

function drawX(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r);
  ctx.lineTo(x - r, y + r);
  ctx.stroke();
}

function setHidden(e: HTMLElement, hidden: boolean): void {
  const cur = e.style.display === 'none';
  if (cur !== hidden) e.style.display = hidden ? 'none' : '';
}

function toggleOff(e: HTMLElement, hidden: boolean): void {
  const cur = e.classList.contains('off');
  if (cur !== hidden) e.classList.toggle('off', hidden);
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
 * Palette-derived custom properties shared by both C_UI stylesheets. Every
 * value flows from APAL through withAlpha/mixA — the CSS above references
 * only --ac-* names, keeping raw color out of the stylesheet entirely.
 */
function applyThemeVars(target: CSSStyleDeclaration): void {
  target.setProperty('--ac-font-ui', "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif");
  target.setProperty('--ac-font-tw', FONT_TW);
  target.setProperty('--ac-font-cond', FONT_COND);
  target.setProperty('--ac-paper88', withAlpha('paper', 0.88));
  target.setProperty('--ac-paper92', withAlpha('paper', 0.92));
  target.setProperty('--ac-paper80', withAlpha('paper', 0.8));
  target.setProperty('--ac-ink', PAL.ink);
  target.setProperty('--ac-ink75', withAlpha('ink', 0.75));
  target.setProperty('--ac-ink55', withAlpha('ink', 0.55));
  target.setProperty('--ac-ink45', withAlpha('ink', 0.45));
  target.setProperty('--ac-ink40', withAlpha('ink', 0.4));
  target.setProperty('--ac-ink30', withAlpha('ink', 0.3));
  target.setProperty('--ac-ink18', withAlpha('ink', 0.18));
  target.setProperty('--ac-warn', PAL.warn);
  target.setProperty('--ac-ok', PAL.ok);
  target.setProperty('--ac-tracer', PAL.tracer);
  target.setProperty('--ac-royal', PAL.royalNavy);
  target.setProperty('--ac-iron', PAL.ironRed);
}

// ============================================================================
// creator — the frozen public surface
// ============================================================================

export function createHud(hudCanvas: HTMLCanvasElement): Hud {
  return new AcesHud(hudCanvas);
}
