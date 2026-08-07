// ============================================================================
// ANCIENTS (rift) client — MINIMAP (CONTRACT §6 ui/minimap.ts, T9; extended by
// GRAPHICS_CONTRACT §6 / R_MINIMAP). A 2D canvas redrawn at ~4Hz over the REAL
// terrain: the shared `buildTerrain(lanes)` grid painted cell-by-cell (a value
// step for elevation, the river band, a stippled jungle mass, the near-black
// cliff rings that give every plateau its silhouette), lane polylines from
// buildMap(begin.lanes) on top, jungle-camp blips with alive/dead/unknown
// state, every structure ALWAYS (positions/hp are public — destroyed ones go
// dark), own + fog-visible mobiles as team dots (the server's snap is already
// fog-filtered, so drawing every mobile it contains can never leak), wards, the
// fog maskCanvas composited on top, the camera frustum rect, click/drag-to-pan
// via actions.panCameraTo and right-drag-to-order via actions.send.
//
// World [0,side]^2 maps linearly onto the square canvas, ROTATED 180° so the
// minimap agrees with the fixed camera rig (measured by scripts/repro-pan.mjs:
// screen-right is world -x, screen-up is world +z): world x -> canvas LEFT,
// world z -> canvas UP. The terrain layer is a `dim x dim` offscreen canvas
// (grid res is frozen at 1 cell/metre, so dim === side) built ONCE per lane
// count and blitted through that same 180° flip — the per-frame cost of the
// terrain is one drawImage.
//
// LEGIBILITY (the spec's bar is "legible at ~200 px, not pretty at 800"): the
// terrain kinds are separated on the value ladder first and hue second —
// cliff L*2 < foliage L*27 (speckled with canopy L*42) < ground L*22 <
// high L*32 < river L*43 (teal, S37) ~ lane L*44 (warm grey, S10) <
// ramp L*51 < base L*64. Every blip additionally carries a dark contact
// outline so a unit can never merge into the terrain value beneath it.
//
// DOM CLASS CONTRACT (§6): renders only .minimap (the wrapper); the canvas
// itself is classless (T8: `.minimap > canvas`). All canvas colours are APAL
// entries. Team dots are dots + team colour; the SELF dot gets a paper ring;
// NEUTRAL camps are TRIANGLES in the neutral-camp family — identity is shape +
// colour, never colour alone (§8, GRAPHICS_CONTRACT §6). `EntSnap.team` is an
// `EntTeam`, so every per-team index narrows through `isPlayerTeam` first.
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
  buildTerrain,
  isPlayerTeam,
} from '@rift/shared';
import type { CampDef, EntSnap, MapDef, TerrainDef, TerrainKind } from '@rift/shared';
import type { ClientState, UiActions, UiHandle } from '../contract.js';

const RES = 512; // canvas backing store (CSS sizes the element to 200-240px)
const PX = RES / 256; // one "design pixel" — the pre-R_MINIMAP art was authored at 256
const REDRAW_MS = 250; // ~4Hz
const DOT_R = 3 * PX; // mobile dot radius
const SELF_RING_W = 1.5 * PX;
const HAIRLINE = PX; // 1 design px — outlines, lane centreline, frustum
// camera frustum estimate: ground half-extents at the given camera height
// (16:9 view through a ~50° fov pitched ~55° down — close enough for a rect)
const FRUSTUM_HALF_W_PER_M = 0.9;
const FRUSTUM_HALF_H_PER_M = 0.55;
// right-button drag issues at most one move order per this interval, so a slow
// sweep across the map cannot flood the socket with a per-pointermove order
const ORDER_DRAG_MS = 120;

// ---- terrain palette -------------------------------------------------------
// One APAL entry per TerrainKind. Chosen for separation at 200 px, in the value
// order documented in the header; `cliff` is deliberately the near-black ink so
// a plateau ring reads as a hard wall rather than as more grey rock.
const KIND_FILL: Readonly<Record<TerrainKind, string>> = {
  ground: APAL.moss,
  lane: APAL.stone,
  high: APAL.mossLit,
  cliff: APAL.inkDeep,
  river: APAL.water,
  foliage: APAL.canopyDeep,
  ramp: APAL.dirtLit,
  base: APAL.monumentLit,
};
const KIND_FILL_BY_CODE: readonly string[] = TERRAIN_KINDS.map((k) => KIND_FILL[k]);
const FOLIAGE_CODE = TERRAIN_KINDS.indexOf('foliage');

// camp blip half-height, by tier — the objective's weight is its size
const CAMP_SIZE: Readonly<Record<CampDef['tier'], number>> = {
  pack: 3.5 * PX,
  brute: 4.5 * PX,
  hive: 5.5 * PX,
};
const CAMP_UNKNOWN = 0;
const CAMP_ALIVE = 1;
const CAMP_DEAD = 2;

function isStructure(k: EntSnap['k']): boolean {
  return k === 'tower' || k === 'guard' || k === 'ancient';
}

function isCampEnt(k: EntSnap['k']): boolean {
  return k === 'campPack' || k === 'campBrute' || k === 'campHive';
}

/**
 * The terrain layer: one offscreen canvas at grid resolution (1 px per cell).
 * Built once per lane count. Rows are painted as runs of equal kind so a
 * 128x128 grid costs a few hundred fillRects rather than 16384, then the
 * foliage mass is speckled with a deterministic 1-in-4 lattice so jungle reads
 * as a textured region and not as one more flat green — shape, not colour
 * alone. The lattice is pure index arithmetic: no rng, no Math.random.
 */
function buildTerrainLayer(t: TerrainDef): HTMLCanvasElement {
  const dim = t.grid.dim;
  const layer = document.createElement('canvas');
  layer.width = dim;
  layer.height = dim;
  const g = layer.getContext('2d');
  if (!g) return layer;
  const kind = t.grid.kind;

  for (let z = 0; z < dim; z += 1) {
    const row = z * dim;
    let x = 0;
    while (x < dim) {
      const code = kind[row + x] ?? 0;
      let end = x + 1;
      while (end < dim && kind[row + end] === code) end += 1;
      g.fillStyle = KIND_FILL_BY_CODE[code] ?? APAL.moss;
      g.fillRect(x, z, end - x, 1);
      x = end;
    }
  }

  g.fillStyle = APAL.canopy;
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
  root.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let actionsRef: UiActions | null = null;
  let live = false;
  let map: MapDef | null = null;
  let terrain: TerrainDef | null = null;
  let terrainLayer: HTMLCanvasElement | null = null;
  let mapLanes = 0;
  let lastDraw = 0;
  // camp bookkeeping, allocated once per map: last-known state, and the
  // per-draw "a camp entity is standing here" scratch. Never reallocated in a
  // draw, so a 4Hz redraw allocates nothing.
  let campState = new Uint8Array(0);
  let campSeen = new Uint8Array(0);

  // pointer gesture state: left = pan (click AND drag), right = order (click
  // AND drag), matching input.ts's in-world convention (right-click = move).
  let dragMode: 'none' | 'pan' | 'order' = 'none';
  let lastOrderAt = 0;

  /** Canvas-local pointer position -> world, honouring the 180° rotation.
   *  Writes into `ptScratch` so the pointer path allocates nothing either. */
  const ptScratch = { x: 0, z: 0 };
  function toWorld(clientX: number, clientY: number): boolean {
    if (!map) return false;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const u = (clientX - rect.left) / rect.width;
    const v = (clientY - rect.top) / rect.height;
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

  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault(); // right-drag is an order gesture, not a browser menu
  });

  canvas.addEventListener('pointerdown', (ev) => {
    if (!actionsRef || !live) return;
    if (!toWorld(ev.clientX, ev.clientY)) return;
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
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

  function endDrag(ev: PointerEvent): void {
    if (dragMode === 'none') return;
    dragMode = 'none';
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /** Refresh last-known camp state from the snapshot. A camp is ALIVE while a
   *  neutral camp entity stands within its leash radius; it is DEAD once the
   *  clearing is visible with no such entity on it; otherwise the last known
   *  state stands (an unscouted camp must not lie about being cleared). */
  function updateCamps(s: ClientState, camps: readonly CampDef[]): void {
    campSeen.fill(0);
    const ents = s.snap?.ents;
    if (ents) {
      for (const e of ents) {
        if (!isCampEnt(e.k) || e.hp <= 0) continue;
        let best = -1;
        let bestD2 = CAMP_LEASH_RADIUS * CAMP_LEASH_RADIUS;
        for (let i = 0; i < camps.length; i += 1) {
          const c = camps[i];
          if (!c) continue;
          const dx = c.x - e.x;
          const dz = c.z - e.z;
          const d2 = dx * dx + dz * dz;
          if (d2 <= bestD2) {
            bestD2 = d2;
            best = i;
          }
        }
        if (best >= 0) campSeen[best] = 1;
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
    // Blit the cached grid through the same 180° flip. Smoothing stays OFF: a
    // 1 m cell is ~1.6 CSS px at the shipped size and the browser's downscale
    // to the element already resolves it — an extra upscale blur would smear
    // the cliff hairlines that carry every plateau silhouette.
    if (terrainLayer) {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.translate(RES, RES);
      ctx.scale(-1, -1);
      ctx.drawImage(terrainLayer, 0, 0, RES, RES);
      ctx.restore();
    } else {
      ctx.fillStyle = APAL.mossDeep;
      ctx.fillRect(0, 0, RES, RES);
    }

    // lane centrelines — the paved band is already in the grid, but the river
    // crossings interrupt it, and lane continuity is the map's primary read
    ctx.strokeStyle = APAL.stoneLit;
    ctx.lineWidth = 1.5 * PX;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const path of map.paths) {
      ctx.beginPath();
      for (const [i, w] of path.entries()) {
        if (i === 0) ctx.moveTo(px(w.x), pz(w.z));
        else ctx.lineTo(px(w.x), pz(w.z));
      }
      ctx.stroke();
    }

    const snap = s.snap;
    const selfId = snap?.you ? findSelfEntId(s) : -1;

    // ---- jungle camps ------------------------------------------------------
    // Drawn beneath the fog like structures: an unexplored camp stays shrouded,
    // so the blip reports what this team knows and never wallhacks.
    updateCamps(s, terrain.camps);
    ctx.lineWidth = HAIRLINE;
    const camps = terrain.camps;
    for (let i = 0; i < camps.length; i += 1) {
      const c = camps[i];
      if (!c) continue;
      const state = campState[i] ?? CAMP_UNKNOWN;
      const x = px(c.x);
      const y = pz(c.z);
      const h = CAMP_SIZE[c.tier];
      triangle(ctx, x, y, h);
      if (state === CAMP_DEAD) {
        ctx.strokeStyle = APAL.neutralDeep;
        ctx.stroke();
      } else {
        ctx.fillStyle = state === CAMP_ALIVE ? APAL.neutral : APAL.neutralDeep;
        ctx.fill();
        ctx.strokeStyle = APAL.inkDeep;
        ctx.stroke();
      }
    }

    // structures — always sent, always drawn; dead ones go dark, never vanish
    if (snap) {
      ctx.lineWidth = HAIRLINE;
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
          const r = 5 * PX;
          ctx.beginPath();
          ctx.moveTo(x, y - r);
          ctx.lineTo(x + r, y);
          ctx.lineTo(x, y + r);
          ctx.lineTo(x - r, y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          const half = (e.k === 'guard' ? 3 : 2.5) * PX;
          ctx.fillRect(x - half, y - half, half * 2, half * 2);
          ctx.strokeRect(x - half, y - half, half * 2, half * 2);
        }
      }

      // mobiles — the snap is fog-filtered server-side, so every mobile here
      // is own-team or currently visible; wards are own-team-only by wire rule
      for (const e of snap.ents) {
        if (isStructure(e.k) || e.k === 'proj') continue;
        const x = px(e.x);
        const y = pz(e.z);
        if (e.k === 'ward') {
          ctx.fillStyle = APAL.ward;
          ctx.fillRect(x - 1.5 * PX, y - 1.5 * PX, 3 * PX, 3 * PX);
          continue;
        }
        if (isCampEnt(e.k)) {
          // a pulled camp stands away from its clearing: mark the creep itself,
          // in the neutral family and in the neutral SHAPE (§6)
          triangle(ctx, x, y, 2.5 * PX);
          ctx.fillStyle = APAL.neutral;
          ctx.fill();
          ctx.strokeStyle = APAL.inkDeep;
          ctx.lineWidth = HAIRLINE;
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
        ctx.lineWidth = HAIRLINE;
        ctx.stroke();
        if (isSelf) {
          ctx.strokeStyle = APAL.paper;
          ctx.lineWidth = SELF_RING_W;
          ctx.beginPath();
          ctx.arc(x, y, DOT_R + 1.5 * PX, 0, Math.PI * 2);
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
    ctx.lineWidth = HAIRLINE;
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

    render(s: ClientState, a: UiActions): void {
      live = s.phase === 'live';
      root.style.display = live ? '' : 'none';
      if (!live) {
        dragMode = 'none';
        return;
      }
      actionsRef = a;

      // (re)build the geometry cache when the match's lane count changes.
      // buildTerrain is the same pure function the renderer runs, so this is a
      // recompute, not a second source of truth — the seam gives the UI layer
      // no TerrainDef, and terrain never travels on the wire.
      const lanes = s.begin?.lanes ?? 0;
      if (lanes > 0 && lanes !== mapLanes) {
        map = buildMap(lanes);
        terrain = buildTerrain(lanes);
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
    },
  };
}
