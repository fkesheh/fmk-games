// ============================================================================
// ANCIENTS (rift) client — MINIMAP (CONTRACT §6 ui/minimap.ts, T9; extended by
// GRAPHICS_CONTRACT §6 / R_MINIMAP). A 2D canvas redrawn at ~4Hz over the REAL
// terrain: the shared terrain grid painted cell-by-cell (a value step for
// elevation, the river band, a dithered jungle mass, the near-black cliff rings
// that give every plateau its silhouette), lane polylines on top, jungle-camp
// blips with alive/dead/unknown state, every structure ALWAYS (positions/hp are
// public — destroyed ones go dark), own + fog-visible mobiles as team dots (the
// server's snap is already fog-filtered, so drawing every mobile it contains can
// never leak), wards, the fog maskCanvas composited on top, the camera frustum
// rect, click/drag-to-pan via actions.panCameraTo and right-click/right-drag-to-
// order via actions.send.
//
// TERRAIN COMES FROM `buildMap(lanes).terrain` — the SAME object buildMap
// already compiled (shared/src/map.ts, `return { …, terrain: buildTerrain(lanes) }`,
// and contract.ts:148 names that exact expression). buildTerrain is the most
// expensive call on this path; calling it a second time here would double it for
// nothing. Terrain never travels on the wire, so recomputing it from the lane
// count is the seam, not a second source of truth.
//
// World [0,side]^2 maps linearly onto the square canvas, ROTATED 180° so the
// minimap agrees with the fixed camera rig (measured by scripts/repro-pan.mjs:
// screen-right is world -x, screen-up is world +z): world x -> canvas LEFT,
// world z -> canvas UP. The terrain layer is a `dim x dim` offscreen canvas
// (grid res is frozen at 1 cell/metre, so dim === side) built ONCE per lane
// count and blitted through that same 180° flip — the per-frame cost of the
// terrain is one drawImage.
//
// ---- THE VALUE LADDER ------------------------------------------------------
// The spec's bar is "legible at ~200 px, not pretty at 800", and the law is
// valueLadder.test.ts's large-surface rule: any two families separate by
// >= 12 L* OR >= 25 deg of hue. It binds every pair of the eight terrain fills,
// and the ladder below is MONOTONE in L* — the order written here is the order
// the numbers are in. Measured with @platform/shared's L()/hue():
//
//   cliff    #07090c   L*  2.4   h 216     river    #3a6b7d   L* 42.6   h 196
//   foliage  #161c12   L*  9.4   h  96     high     #5e7d3f   L* 48.8   h  90
//   ramp     #524231   L* 29.2   h  31     lane     #8d8577   L* 55.9   h  38
//   ground   #424e38   L* 31.6   h  93     base     #c6c0b4   L* 77.9   h  40
//
// All 28 pairs clear the law. The pair that leans hardest on VALUE is
// ground/high at 17.2 L* (2.7 deg of hue apart — the same green by palette
// design); the pair that leans hardest on HUE is ramp/ground, 2.4 L* apart at
// 61.8 deg. The smallest hue gap anywhere is high/base at 50.0 deg, and that
// pair is 29.1 L* apart as well. The pre-fix fills failed the law outright:
// foliage/ground 4.7, ground/high 9.4, foliage/high 4.7 L*, all under 4 deg.
//
// ---- AND THE LADDER UNDER FOG ----------------------------------------------
// Most of the map, most of the match, is explored-not-visible, and the shroud
// mask composited below lays APAL.shroud over it at fog.ts's DIM_ALPHA = 0.55.
//
// THIS IS A 2D CANVAS, so `ctx.drawImage(mask)` is a source-over in 8-BIT
// sRGB. It is NOT the linear-light blend `composite()` from @platform/shared
// models — that helper exists for three.js materials, where the renderer
// linearises first. An earlier revision of this file measured the shroud with
// `composite()` and overstated every surviving separation by ~1.6x. The sRGB
// lerp IS `mix(fill, APAL.shroud, 0.55)`, and it very nearly HALVES L*:
// measured in Chrome off this module's own terrain layer, downscaled to the
// shipped 200 CSS px, open ground 31.6 -> 15.3, high 48.8 -> 23.8, river
// 42.6 -> 20.8, lane 55.9 -> 27.6, base 77.9 -> 38.8.
//
// So the dim state has only ~15 L* of range BELOW open ground for cliff and
// jungle to share, and no palette can put two more 12 L* rungs in there. The
// dark end is therefore carried by HUE (cliff is 120 deg off every green) and
// by the lattice below; value carries the light end, where the range exists.
// Measured over all 28 pairs at DIM_ALPHA: every value-reliant pair (hue < 25
// deg) keeps >= 8.52 L* — ground/high, the worst — and every hue-reliant pair
// keeps >= 51.8 deg. R_FOG's mist modulates the local alpha over 0.471..0.629
// around that mean; at its darkest, 0.629, those floors are 7.08 L* and
// 52.1 deg. Nothing here collapses under the shroud.
//
// The jungle is additionally DITHERED: a deterministic 1-in-4 lattice of the
// GROUND fill, i.e. ground showing through the canopy. It introduces no ninth
// colour, which is the whole point: the PRE-FIX speckle was a ninth entry,
// canopy L* 41.8, and it landed inside a 2.1 L* band with the pre-fix river
// (42.6) and the pre-fix lane (43.9). The lattice is exactly
// 1 cell in 4 — (3x + 5z) mod 4 is (3x + z) mod 4, and 3x mod 4 hits all four
// residues as x runs over any span of 4 — and the browser's downscale averages
// the stored sRGB samples, so the mass reads as mix(foliage, ground, 0.25) =
// #21291c, L* 15.45. That is the IDEAL mean; the browser's box filter is not
// exactly 4:1 at 1.56-2.08 px per cell, so what a player actually reads is
// slightly lighter. MEASURED in Chrome at the shipped 200 CSS px over every
// interior jungle pixel (n = 631/668/702 at 2/3/1 lanes): the mass is
// L* 16.8 / 16.9 / 16.5 — 14.8 / 14.7 / 15.1 L* below open ground clear, and
// 7.5 / 7.5 / 7.7 L* below it under the shroud. The lattice's own internal
// contrast is 10.22 L* dimmed: a PATTERN is the one terrain cue an alpha wash
// cannot flatten, which is why the jungle gets one and no other kind does.
//
// Cliff is the exception the smoothing-off blit exists for. At 200 px a cliff
// ring is a sub-pixel hairline — only 2-8 output pixels per map are pure cliff
// — and where one survives it measures exactly L* 2.41. Its job is the plateau
// silhouette, not an area read, so it is the one kind measured as an edge.
//
// DOM CLASS CONTRACT (§6): renders only .minimap (the wrapper); the canvas
// itself is classless (T8: `.minimap > canvas`). All canvas colours are APAL
// entries, or mix() of two APAL entries — the only derivation palette.ts
// sanctions. Team dots are dots + team colour; the SELF dot gets a paper ring;
// NEUTRAL camps are TRIANGLES in the neutral-camp family — identity is shape +
// colour, never colour alone (§8, GRAPHICS_CONTRACT §6). `EntSnap.team` is an
// `EntTeam`, so every per-team index narrows through `isPlayerTeam` first.
//
// Every stroke width and glyph size below is expressed in CSS pixels at the
// shipped element size (style.css `.minimap { width: 200px; height: 200px }`)
// and converted once through CSSPX, because "legible at 200 px" is a statement
// about CSS pixels and the backing store is 2.56x that.
//
// The camera frustum is an approximation: the frozen seam exposes camera
// centre + height but not the scene's fov, so the rect derives from height
// with a 16:9, ~55° pitch estimate (constants below) — T7 owns the truth.
// ============================================================================
import {
  APAL,
  CAMP_LEASH_RADIUS,
  TEAM_COLORS,
  TERRAIN_KINDS,
  buildMap,
  isPlayerTeam,
} from '@rift/shared';
import type { CampDef, EntSnap, MapDef, TerrainDef, TerrainKind } from '@rift/shared';
import { mix } from '@platform/shared';
import type { ClientState, UiActions, UiHandle } from '../contract.js';

const RES = 512; // canvas backing store
/** The element's CSS side, from style.css `.minimap`. The backing store is
 *  square and CSS scales it, so this is the ONLY place the two units meet. */
const CSS_SIZE = 200;
/** Backing-store pixels per CSS pixel at the shipped size: 2.56. Every width
 *  below is `<css px> * CSSPX`, so the numbers in this file are the numbers a
 *  player sees. The element is 200 px at every viewport except
 *  `@media (min-width: 2200px)`, where style.css grows it to 240 — and a
 *  LARGER element scales the same backing-store width UP (240/512 CSS px per
 *  backing px, not 200/512, so 2 CSS px becomes 2.4). 200 is therefore where
 *  every stroke in this file is at its THINNEST, which is why the legibility
 *  floors below are sized against it. */
const CSSPX = RES / CSS_SIZE;
const REDRAW_MS = 250; // ~4Hz
const DOT_R = 2.4 * CSSPX; // mobile dot radius — 4.8 CSS px across
const SELF_RING_W = 1.4 * CSSPX;
/** Contact outline on every blip, and the frustum rect. One CSS pixel is the
 *  floor for a line that has to survive the browser's downscale; the previous
 *  0.78 CSS px did not. */
const OUTLINE_W = 1.0 * CSSPX;
/** The lane centreline. It is the map's primary read — the paved band is in
 *  the grid but the river crossings interrupt it — so it gets 2 CSS px. */
const LANE_W = 2.0 * CSSPX;
// camera frustum estimate: ground half-extents at the given camera height
// (16:9 view through a ~50° fov pitched ~55° down — close enough for a rect)
const FRUSTUM_HALF_W_PER_M = 0.9;
const FRUSTUM_HALF_H_PER_M = 0.55;
// right-button drag issues at most one move order per this interval, so a slow
// sweep across the map cannot flood the socket with a per-pointermove order
const ORDER_DRAG_MS = 120;

// ---- terrain palette -------------------------------------------------------
// One entry per TerrainKind, in the header's measured L* order. Four are mix()
// of two APAL entries — palette.ts's only sanctioned derivation — because the
// eight kinds need eight rungs and the named steps of the moss/dirt/monument
// families do not land on eight that clear the law.
//
// Open ground is `mossLit`, not `moss`. The minimap is a lit top-down
// abstraction, not a shaded world surface, and the choice is forced by the
// shroud: at moss's L* 22.1 the dim state leaves 10.6 L* of range beneath open
// ground for BOTH cliff and the jungle mass, and the jungle collapsed to 4.4 L*
// there. mossLit's 31.6 opens that to 15.3 and puts the jungle at 8.08. Raising
// the darkest large surface strengthens valueLadder.test.ts's L5 floor (>= 22);
// it does not weaken it.
const KIND_FILL: Readonly<Record<TerrainKind, string>> = {
  // L*  2.4, h 216 — the near-black ink, so a plateau ring reads as a hard wall
  cliff: APAL.inkDeep,
  // L*  9.4, h  96 (#161c12) — the jungle mass, dithered with `ground` below
  foliage: mix(APAL.mossDeep, APAL.inkDeep, 0.2),
  // L* 29.2, h  31 (#524231) — cut earth; warm, so it splits from ground on hue
  ramp: mix(APAL.dirt, APAL.dirtDeep, 0.5),
  // L* 31.6, h  93 — open ground; see the note above on why it is the Lit step
  ground: APAL.mossLit,
  // L* 42.6, h 196 — the river channel; the only saturated teal on the map
  river: APAL.water,
  // L* 48.8, h  90 (#5e7d3f) — high ground: the same green, a clear step lighter
  high: mix(APAL.canopy, APAL.canopyLit, 0.5),
  // L* 55.9, h  38 — the paved lane band, the brightest large surface
  lane: APAL.stoneLit,
  // L* 77.9, h  40 (#c6c0b4) — the two base platforms, the map's brightest mass
  base: mix(APAL.monumentLit, APAL.paper, 0.5),
};
const KIND_FILL_BY_CODE: readonly string[] = TERRAIN_KINDS.map((k) => KIND_FILL[k]);
const FOLIAGE_CODE = TERRAIN_KINDS.indexOf('foliage');
/** The jungle dither: ground showing through the canopy. Deliberately the
 *  ground fill itself, so the lattice adds no colour the ladder has to hold. */
const FOLIAGE_DITHER = KIND_FILL.ground;
/** The lane centreline, drawn over the `lane` band and across the river that
 *  interrupts it. Cool near-black (#20262f, L* 14.9, h 216): 40.9 L* under the
 *  band, 27.7 L* under the river, and 16.6 L* / 123 deg off open ground where
 *  it clips the shoulder. */
const LANE_INK = APAL.inkLit;

/** Camp blip size by tier — the objective's weight is its size. The number is
 *  the triangle's half-width `h` in CSS px; `triangle()` draws it 2h wide and
 *  1.8h tall, so the shipped glyphs are 6.4x5.8 (pack), 8.0x7.2 (brute) and
 *  9.6x8.6 (hive) CSS px at the 200 px element. */
const CAMP_SIZE: Readonly<Record<CampDef['tier'], number>> = {
  pack: 3.2 * CSSPX,
  brute: 4.0 * CSSPX,
  hive: 4.8 * CSSPX,
};
const CAMP_UNKNOWN = 0;
const CAMP_ALIVE = 1;
const CAMP_DEAD = 2;
/** Camp state is a three-step VALUE ladder inside one shape, never fill-vs-
 *  hollow: alive `neutral` L* 69.5, unknown `neutralDeep` L* 52.6, dead
 *  `inkDeep` L* 2.4 — 16.9 and 50.2 L* apart. Every state is stroked. */
const CAMP_FILL: readonly string[] = [APAL.neutralDeep, APAL.neutral, APAL.inkDeep];
const CAMP_STROKE: readonly string[] = [APAL.inkDeep, APAL.inkDeep, APAL.neutralDeep];

function isStructure(k: EntSnap['k']): boolean {
  return k === 'tower' || k === 'guard' || k === 'ancient';
}

function isCampEnt(k: EntSnap['k']): boolean {
  return k === 'campPack' || k === 'campBrute' || k === 'campHive';
}

/** Index of the clearing whose leash disc holds (x, z), or -1 for none. The
 *  ONE query both the camp-state refresh and the mobile pass use, so a camp
 *  creep standing on its own clearing is drawn exactly once — as that
 *  clearing's blip — and only a PULLED creep gets a marker of its own.
 *  Allocation-free; camps.length is 4..8. */
function clearingAt(camps: readonly CampDef[], x: number, z: number): number {
  let best = -1;
  let bestD2 = CAMP_LEASH_RADIUS * CAMP_LEASH_RADIUS;
  for (let i = 0; i < camps.length; i += 1) {
    const c = camps[i];
    if (!c) continue;
    const dx = c.x - x;
    const dz = c.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}

/**
 * The terrain layer: one offscreen canvas at grid resolution (1 px per cell).
 * Built once per lane count. Rows are painted as runs of equal kind so a
 * 128x128 grid costs a few hundred fillRects rather than 16384, then the
 * foliage mass is dithered with a deterministic 1-in-4 lattice of the ground
 * fill so jungle reads as a textured region and not as one more flat green —
 * shape, not colour alone. The lattice is pure index arithmetic: no rng, no
 * Math.random.
 *
 * Returns `null` when the 2D context is unavailable. It must NOT return the
 * blank canvas: a transparent layer is truthy, and a truthy layer takes the
 * blit branch in `draw`, which would leave the previous frame showing through
 * for the rest of the match.
 */
function buildTerrainLayer(t: TerrainDef): HTMLCanvasElement | null {
  const dim = t.grid.dim;
  const layer = document.createElement('canvas');
  layer.width = dim;
  layer.height = dim;
  const g = layer.getContext('2d');
  if (!g) return null;
  const kind = t.grid.kind;

  for (let z = 0; z < dim; z += 1) {
    const row = z * dim;
    let x = 0;
    while (x < dim) {
      const code = kind[row + x] ?? 0;
      let end = x + 1;
      while (end < dim && kind[row + end] === code) end += 1;
      g.fillStyle = KIND_FILL_BY_CODE[code] ?? KIND_FILL.ground;
      g.fillRect(x, z, end - x, 1);
      x = end;
    }
  }

  g.fillStyle = FOLIAGE_DITHER;
  for (let z = 0; z < dim; z += 1) {
    const row = z * dim;
    for (let x = 0; x < dim; x += 1) {
      if (kind[row + x] !== FOLIAGE_CODE) continue;
      if ((x * 3 + z * 5) % 4 !== 0) continue;
      g.fillRect(x, z, 1, 1);
    }
  }
  return layer;
}

export function createMinimap(parent: HTMLElement): UiHandle {
  const root = document.createElement('div');
  root.className = 'minimap';
  root.style.display = 'none';
  parent.appendChild(root);

  const canvas = document.createElement('canvas');
  canvas.width = RES;
  canvas.height = RES;
  // Pan and order are POINTER gestures held across pointermove. Without this
  // the browser claims the drag for scroll/zoom on the first touchmove and
  // fires pointercancel, which kills both gestures on touch (AMENDMENT_3 §F).
  // R_HUD's style.css now carries the same rule on `.minimap`, the wrapper;
  // this sets it on the canvas, which is the actual pointer TARGET, so the
  // gesture does not depend on another module's stylesheet landing — and a
  // later `.minimap` rule cannot silently take it away.
  canvas.style.touchAction = 'none';
  root.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let actionsRef: UiActions | null = null;
  let live = false;
  let map: MapDef | null = null;
  let terrain: TerrainDef | null = null;
  let terrainLayer: HTMLCanvasElement | null = null;
  let mapLanes = 0;
  let lastDraw = 0;
  let faults = 0;
  // camp bookkeeping, allocated once per map: last-known state, and the
  // per-draw "a camp entity is standing here" scratch. Never reallocated in a
  // draw, so a 4Hz redraw allocates nothing.
  let campState = new Uint8Array(0);
  let campSeen = new Uint8Array(0);

  // pointer gesture state: left = pan (click AND drag), right = order (click
  // AND drag), matching input.ts's in-world convention (right-click = move).
  // Both drag arms are net-new input (AMENDMENT_3 §F) and are pinned by
  // minimap.test.ts.
  let dragMode: 'none' | 'pan' | 'order' = 'none';
  let dragPointerId = -1;
  let lastOrderAt = 0;

  // Canvas rect, cached as four numbers. getBoundingClientRect ALLOCATES a
  // DOMRect, so it is called on pointerdown only — never on pointermove, which
  // is the event that can fire at display rate. `.minimap` is position:fixed
  // and the pointer is captured for the life of the gesture, so the only thing
  // that could move it mid-drag is a window resize, and the next pointerdown
  // re-reads it.
  let rectX = 0;
  let rectY = 0;
  let rectW = 0;
  let rectH = 0;

  function captureRect(): boolean {
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    rectX = r.left;
    rectY = r.top;
    rectW = r.width;
    rectH = r.height;
    return true;
  }

  /** Canvas-local pointer position -> world, honouring the 180° rotation.
   *  Writes into `ptScratch`, and reads the cached rect, so the pointer path
   *  allocates nothing. */
  const ptScratch = { x: 0, z: 0 };
  function toWorld(clientX: number, clientY: number): boolean {
    if (!map || rectW <= 0 || rectH <= 0) return false;
    const u = (clientX - rectX) / rectW;
    const v = (clientY - rectY) / rectH;
    // the drawing is rotated 180° (see header): canvas right is world -x,
    // canvas down is world -z
    ptScratch.x = (1 - Math.min(Math.max(u, 0), 1)) * map.side;
    ptScratch.z = (1 - Math.min(Math.max(v, 0), 1)) * map.side;
    return true;
  }

  function order(now: number): void {
    if (!actionsRef || !live) return;
    if (now - lastOrderAt < ORDER_DRAG_MS) return;
    lastOrderAt = now;
    actionsRef.send({ t: 'rift_order', kind: 'move', x: ptScratch.x, z: ptScratch.z });
  }

  /** Ends whatever gesture is running and gives the capture back. Called from
   *  pointerup/pointercancel AND from `render` the moment the match stops being
   *  live: a match that ends mid-drag used to leave the capture on the canvas
   *  forever, so every later pointer event in the document went to a hidden
   *  element. */
  function endDrag(): void {
    if (dragMode === 'none' && dragPointerId < 0) return;
    dragMode = 'none';
    const id = dragPointerId;
    dragPointerId = -1;
    if (id >= 0 && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }

  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault(); // right-drag is an order gesture, not a browser menu
  });

  canvas.addEventListener('pointerdown', (ev) => {
    if (!actionsRef || !live) return;
    if (!captureRect()) return;
    if (!toWorld(ev.clientX, ev.clientY)) return;
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    dragPointerId = ev.pointerId;
    if (ev.button === 2) {
      dragMode = 'order';
      lastOrderAt = 0;
      order(performance.now());
    } else {
      dragMode = 'pan';
      actionsRef.panCameraTo(ptScratch.x, ptScratch.z);
    }
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (dragMode === 'none' || !actionsRef || !live) return;
    if (!toWorld(ev.clientX, ev.clientY)) return;
    if (dragMode === 'order') order(performance.now());
    else actionsRef.panCameraTo(ptScratch.x, ptScratch.z);
  });

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /** Refresh last-known camp state from the snapshot. A camp is ALIVE while a
   *  living neutral camp entity stands within its leash radius; it is DEAD once
   *  the clearing is visible with no such entity on it; otherwise the last known
   *  state stands (an unscouted camp must not lie about being cleared). */
  function updateCamps(s: ClientState, camps: readonly CampDef[]): void {
    campSeen.fill(0);
    const ents = s.snap?.ents;
    if (ents) {
      for (const e of ents) {
        if (!isCampEnt(e.k) || e.hp <= 0) continue;
        const at = clearingAt(camps, e.x, e.z);
        if (at >= 0) campSeen[at] = 1;
      }
    }
    const fog = s.fog;
    for (let i = 0; i < camps.length; i += 1) {
      const c = camps[i];
      if (!c) continue;
      if (campSeen[i] === 1) campState[i] = CAMP_ALIVE;
      else if (fog && fog.isVisible(c.x, c.z)) campState[i] = CAMP_DEAD;
    }
  }

  /** Neutral marker: an upward triangle, the shape no team entity ever uses. */
  function triangle(g: CanvasRenderingContext2D, x: number, y: number, h: number): void {
    g.beginPath();
    g.moveTo(x, y - h);
    g.lineTo(x + h, y + h * 0.8);
    g.lineTo(x - h, y + h * 0.8);
    g.closePath();
  }

  function draw(s: ClientState): void {
    if (!ctx || !map || !terrain) return;
    const side = map.side;
    // rotated 180°: canvas right = world -x, canvas down = world -z
    const px = (x: number): number => (1 - x / side) * RES;
    const pz = (z: number): number => (1 - z / side) * RES;

    // ---- terrain -----------------------------------------------------------
    // Clear FIRST, unconditionally. Every branch below is additive, so without
    // this the canvas accumulates every frame it has ever drawn.
    ctx.clearRect(0, 0, RES, RES);
    // Blit the cached grid through the same 180° flip. Smoothing stays OFF: a
    // 1 m cell is 1.56 CSS px at 3 lanes and 2.08 at 1 lane, and the browser's
    // downscale to the element already resolves it — an extra upscale blur
    // would smear the cliff hairlines that carry every plateau silhouette.
    if (terrainLayer) {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.translate(RES, RES);
      ctx.scale(-1, -1);
      ctx.drawImage(terrainLayer, 0, 0, RES, RES);
      ctx.restore();
    } else {
      // No terrain layer (2D context refused): flat open ground, so the map is
      // obviously unbuilt rather than transparent and smearing.
      ctx.fillStyle = KIND_FILL.ground;
      ctx.fillRect(0, 0, RES, RES);
    }

    // lane centrelines — the paved band is already in the grid, but the river
    // crossings interrupt it, and lane continuity is the map's primary read.
    // Indexed loop: `path.entries()` allocates an iterator AND a [i, w] tuple
    // per waypoint per draw.
    ctx.strokeStyle = LANE_INK;
    ctx.lineWidth = LANE_W;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const path of map.paths) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < path.length; i += 1) {
        const w = path[i];
        if (!w) continue;
        if (!started) {
          ctx.moveTo(px(w.x), pz(w.z));
          started = true;
        } else {
          ctx.lineTo(px(w.x), pz(w.z));
        }
      }
      ctx.stroke();
    }

    const snap = s.snap;
    const selfId = snap?.you ? findSelfEntId(s) : -1;

    // ---- jungle camps ------------------------------------------------------
    // Drawn beneath the fog like structures: an unexplored camp stays shrouded,
    // so the blip reports what this team knows and never wallhacks.
    const camps = terrain.camps;
    updateCamps(s, camps);
    ctx.lineWidth = OUTLINE_W;
    for (let i = 0; i < camps.length; i += 1) {
      const c = camps[i];
      if (!c) continue;
      const state = campState[i] ?? CAMP_UNKNOWN;
      triangle(ctx, px(c.x), pz(c.z), CAMP_SIZE[c.tier]);
      ctx.fillStyle = CAMP_FILL[state] ?? APAL.neutralDeep;
      ctx.fill();
      ctx.strokeStyle = CAMP_STROKE[state] ?? APAL.inkDeep;
      ctx.stroke();
    }

    // structures — always sent, always drawn; dead ones go dark, never vanish
    if (snap) {
      ctx.lineWidth = OUTLINE_W;
      ctx.strokeStyle = APAL.inkDeep;
      for (const e of snap.ents) {
        if (!isStructure(e.k)) continue;
        const alive = e.hp > 0;
        // `team` is an EntTeam; a structure is always a player team, but the
        // narrowing is mandatory before any per-team index (§6)
        const teamCol = isPlayerTeam(e.team) ? TEAM_COLORS[e.team] ?? APAL.paper : APAL.neutral;
        const x = px(e.x);
        const y = pz(e.z);
        ctx.fillStyle = alive ? teamCol : APAL.stoneDeep;
        if (e.k === 'ancient') {
          // diamond landmark, larger than towers
          const r = 4.0 * CSSPX;
          ctx.beginPath();
          ctx.moveTo(x, y - r);
          ctx.lineTo(x + r, y);
          ctx.lineTo(x, y + r);
          ctx.lineTo(x - r, y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          const half = (e.k === 'guard' ? 2.8 : 2.2) * CSSPX;
          ctx.fillRect(x - half, y - half, half * 2, half * 2);
          ctx.strokeRect(x - half, y - half, half * 2, half * 2);
        }
      }

      // mobiles — the snap is fog-filtered server-side, so every mobile here
      // is own-team or currently visible; wards are own-team-only by wire rule
      for (const e of snap.ents) {
        if (isStructure(e.k) || e.k === 'proj') continue;
        // a corpse is not a unit: structures go dark in place, mobiles leave
        if (e.hp <= 0) continue;
        const x = px(e.x);
        const y = pz(e.z);
        if (e.k === 'ward') {
          ctx.fillStyle = APAL.ward;
          const half = 1.3 * CSSPX;
          ctx.fillRect(x - half, y - half, half * 2, half * 2);
          continue;
        }
        if (isCampEnt(e.k)) {
          // A camp creep on its own clearing is ALREADY drawn, as that
          // clearing's blip — drawing it again stacked a second triangle on
          // the first and made a full camp look like a bigger one. Only a
          // PULLED creep, outside every leash disc, gets its own marker.
          if (clearingAt(camps, e.x, e.z) >= 0) continue;
          triangle(ctx, x, y, 2.2 * CSSPX);
          ctx.fillStyle = APAL.neutral;
          ctx.fill();
          ctx.strokeStyle = APAL.inkDeep;
          ctx.lineWidth = OUTLINE_W;
          ctx.stroke();
          continue;
        }
        const isSelf = e.id === selfId;
        ctx.fillStyle = isSelf
          ? APAL.heal
          : isPlayerTeam(e.team)
            ? TEAM_COLORS[e.team] ?? APAL.paper
            : APAL.neutral;
        ctx.beginPath();
        ctx.arc(x, y, e.k === 'hero' ? DOT_R : DOT_R * 0.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = APAL.inkDeep;
        ctx.lineWidth = OUTLINE_W;
        ctx.stroke();
        if (isSelf) {
          ctx.strokeStyle = APAL.paper;
          ctx.lineWidth = SELF_RING_W;
          ctx.beginPath();
          ctx.arc(x, y, DOT_R + 1.4 * CSSPX, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // fog shroud, composited over the world (T7 owns the mask pixels; §6 fog
    // amendment makes it a map-aligned canvas, visible = clear). The mask is
    // world x -> u, z -> v, so the 180°-rotated minimap draws it flipped.
    const mask = s.fog?.maskCanvas;
    if (mask && mask.width > 0 && mask.height > 0) {
      try {
        ctx.save();
        ctx.translate(RES, RES);
        ctx.scale(-1, -1);
        ctx.drawImage(mask, 0, 0, RES, RES);
        ctx.restore();
      } catch {
        // a mid-rebuild mask must never break the minimap
      }
    }

    // camera frustum rect (estimate — see header). px/pz DECREASE with
    // x/z, so the rect's top-left corner is the +x/+z edge.
    const halfW = s.cameraHeight * FRUSTUM_HALF_W_PER_M;
    const halfH = s.cameraHeight * FRUSTUM_HALF_H_PER_M;
    ctx.strokeStyle = APAL.paper;
    ctx.lineWidth = OUTLINE_W;
    ctx.strokeRect(
      px(s.cameraX + halfW),
      pz(s.cameraZ + halfH),
      ((halfW * 2) / side) * RES,
      ((halfH * 2) / side) * RES,
    );
  }

  /** The ent id of the local hero (its snap row carries pid === hello.you). */
  function findSelfEntId(s: ClientState): number {
    const snap = s.snap;
    const youId = s.hello?.you;
    if (!snap || youId === undefined) return -1;
    for (const e of snap.ents) {
      if (e.k === 'hero' && e.pid === youId) return e.id;
    }
    return -1;
  }

  return {
    root,

    // game.ts calls this straight from the frame loop with no try/catch of its
    // own, and `menus.render` runs after it — a throw here would take the whole
    // UI pass down. Guard the entry point (core.ts: "a hook that throws takes
    // the frame down with it"), report the first fault loudly, and let the next
    // frame try again.
    render(s: ClientState, a: UiActions): void {
      try {
        live = s.phase === 'live';
        root.style.display = live ? '' : 'none';
        if (!live) {
          // A match that ends mid-drag must hand the pointer capture back.
          endDrag();
          return;
        }
        actionsRef = a;

        // (re)build the geometry cache when the match's lane count changes.
        // `buildMap` already compiled the terrain (map.ts: `terrain:
        // buildTerrain(lanes)`); take it, never rebuild it.
        const lanes = s.begin?.lanes ?? 0;
        if (lanes > 0 && lanes !== mapLanes) {
          map = buildMap(lanes);
          terrain = map.terrain;
          terrainLayer = buildTerrainLayer(terrain);
          campState = new Uint8Array(terrain.camps.length);
          campSeen = new Uint8Array(terrain.camps.length);
          mapLanes = lanes;
        }
        if (!map || !terrain) return;

        const now = performance.now();
        if (now - lastDraw < REDRAW_MS) return;
        lastDraw = now;
        draw(s);
      } catch (err) {
        faults += 1;
        if (faults === 1) {
          console.error('[minimap] render failed — the minimap frame was dropped', err);
        }
      }
    },
  };
}
