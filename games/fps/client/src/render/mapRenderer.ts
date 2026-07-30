// ============================================================================
// C3 — map renderer: MapDef (pure data) => baked static geometry + solids.
// Ground slab, sky dome (the ONE raw-geometry/MeshBasicMaterial exception),
// BoxDefs rendered as RICH boxes, seeded floor life + ceiling light panels,
// and seeded deco prop scatter — everything static is merged by bake() into
// one mesh per material (< 60 draw calls per map).
//
// AAA material richness (all tints derived from PALETTE hexes at build time):
//   - per-box albedo jitter (+-8%, 3 seeded buckets: -8% / base / +8%)
//   - sun-kissed tops: a flush, slightly outset cap slab ~12% lighter than sides
//   - ground-standing tall boxes get a darker skirting strip at floor level and
//     a darker trim band just under the cap (cornice), same mat family
//   - floor life: seeded patchwork tint zones + darker wear lanes running
//     T spawn -> CT spawn (and two offset lanes), plus trampled spawn courts
//   - indoor maps (big overhead slabs) get seeded ceiling light panels:
//     metalDark frame + emissive glow plate (warm paper, some cool screenGlow,
//     ~15% dead dark fixtures) with a soft floor pool quad under each lit panel
//   - wall breakup: pilaster ribs every ~4m on tall long faces (same-family
//     dark accent) + large-scale +-4% value mottling on big wall faces
//   - props upgraded: crate lids, barrel lids, pipe end flanges; new kinds:
//     palletStack, sandbag, icicle, deskChair, waterCooler, sack
//   - per-map data extras: `skyline` (silhouette mesa ring beyond the walls)
//     and `accents` (one deliberate accent color repeated: gates, painted
//     plates, tarps, hazard strips, whiteboards, wayfinding)
//
// Visual layers NEVER extend the collision solids: solids come from BoxDefs
// unchanged (boxToAABB); caps sit flush with the box top, strips protrude
// <= 3cm (decorative ledges, non-collidable).
// Determinism: all scatter/jitter comes from rng(decoSeed(map.id, salt));
// Math.random is never touched. Props are client-only dressing: non-collidable,
// never inside solids (AABB inflated 0.5m) or within 2.5m of any spawn.
// ============================================================================
import * as THREE from 'three';
import {
  PALETTE,
  boxToAABB,
  decoSeed,
  rng,
  rngInt,
  rngRange,
  type AABB,
  type BoxDef,
  type DecoKind,
  type MapDef,
  type MatId,
} from '@fps/shared';
import { at, bake, box, cone, cyl, sphere } from '../contract/visual.js';

// ---- MatId -> PALETTE ---------------------------------------------------------
// The mapping now lives in the shared contract (@fps/shared/matColors.ts) so
// map authors and the renderer never contend for this file. Re-exported here
// for compatibility with existing importers. DO NOT redefine it locally.
export { MAT_COLORS, CONTACT_MAT, TRIM_MAT } from '@fps/shared';

// ---- scatter tuning (frozen by CONTRACT/C3 spec) ------------------------------
const SOLID_PAD = 0.5; // solids inflated by this when rejecting prop points
const SPAWN_CLEARANCE = 2.5; // min prop distance to any spawn
const MAX_ATTEMPTS_PER_PROP = 30; // termination cap for rejection sampling
const DOME_RADIUS = 400;

// ---- richness tuning ----------------------------------------------------------
// rng stream salts (deco zones use salts 0..zoneCount-1; these stay clear)
const SALT_BOX_TINT = 1000;
const SALT_FLOOR = 2000;
const SALT_LIGHT = 3000;
const SALT_SKYLINE = 4000;
const SALT_DESK = 5000;

const JITTER = [0.92, 1.0, 1.08] as const; // per-box albedo buckets (+-8%)
const TOP_LIGHTEN = 1.12; // cap slabs are this much lighter than their side
const TRIM_DARKEN = 0.72; // skirting/trim accent within the same mat family
const CAP_H = 0.035; // top cap slab thickness (flush with the box top)
const CAP_OUT = 0.02; // cap lateral outset (reads as a sunlit rim, hides seam)
const SKIRT_H = 0.14; // floor-level skirting band height
const SKIRT_OUT = 0.024;
const TRIM_H = 0.15; // wall-top trim band height (sits just under the cap)
const TRIM_OUT = 0.028;
const OVERHEAD_BOTTOM = 2.0; // boxes starting above this are "overhead" (plain)

const PATCH_FACTORS = [0.86, 0.93, 1.06] as const; // floor patchwork tints
const WEAR_FACTOR = 0.85; // trampled lane darkening (subtle, read at a glance)
const WEAR_TOP_Y = -0.0008; // overlays stack: patches < courts < lanes < feet(0)

// ---- wall breakup --------------------------------------------------------------
const RIB_EVERY = 4; // pilaster spacing on tall long faces (m)
const RIB_MIN_FACE = 6; // faces shorter than this get no pilasters
const RIB_OUT = 0.03; // proudest strip (over trim/skirt so it reads as a rib)
const MOTTLE_MIN_FACE = 8; // big blockout-tell slabs get value mottling
const MOTTLE_FACTORS = [0.95, 1.05] as const; // large-scale +-5% value clouds
const MOTTLE_OUT = 0.008; // tucks behind skirt/trim/ribs
const GRIME_H = 0.32; // base grime band height (soft dirt over the skirting)
const GRIME_OUT = 0.026; // between skirt (0.024) and trim (0.028): no coplanar

const PANEL_CELL = 2.4; // ceiling light-panel grid pitch (m)
const PANEL_SKIP = 0.38; // seeded fraction of cells left dark
const PANEL_DARK = 0.15; // fraction of lit cells that are dead fixtures
const PANEL_COOL = 0.2; // fraction of lit panels running cool (screenGlow)
const POOL_OPACITY = 0.55; // floor pool quad alpha (transparent, warm spill)

/** Multiply a PALETTE '#rrggbb' hex by f (clamped). All richness tints derive
 *  from PALETTE entries here — no ad-hoc hues are ever introduced. */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 0xff) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 0xff) * f));
  const b = Math.min(255, Math.round((n & 0xff) * f));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/**
 * Build the whole map: ground, sky dome, collidable boxes, floor life,
 * ceiling light panels, deco scatter.
 * Returns the renderable root group and the collision solids (same AABBs the
 * server derives — boxToAABB per BoxDef, order preserved).
 */
export function buildMap(map: MapDef): { root: THREE.Group; solids: AABB[] } {
  const solids = map.boxes.map(boxToAABB);
  const statics = new THREE.Group();

  // ---- ground: factory box as a slab; top surface at y=-0.01, 8m apron ----
  statics.add(at(box(map.sizeX + 8, 0.02, map.sizeZ + 8, MAT_COLORS[map.floorMat]), 0, -0.02, 0));

  // ---- skyline backdrop: giant ground apron + silhouette landmark ring ------
  buildSkyline(statics, map);

  // ---- floor life: patchwork tint zones + wear lanes (visual overlays) ------
  buildFloorLife(statics, map);

  // ---- collidable boxes at exact BoxDef coords (rich materials) --------------
  const boxTint = rng(decoSeed(map.id, SALT_BOX_TINT));
  for (const b of map.boxes) {
    buildRichBox(statics, b, boxTint);
  }

  // ---- desktop dressing: monitors/keyboards/papers on desk-row boxes --------
  buildDesktopDressing(statics, map);

  // ---- ceiling light panels (indoor maps only: big overhead slabs) -----------
  buildLightPanels(statics, map, solids);

  // ---- deliberate accent dressing (per-map data, pure visual overlays) -------
  buildAccents(statics, map);

  // ---- deco scatter: seeded per zone, rejection-sampled ----------------------
  const placed: Array<{ x: number; z: number }> = []; // all zones share spacing knowledge
  map.deco.forEach((zone, zoneIndex) => {
    const next = rng(decoSeed(map.id, zoneIndex));
    let placedInZone = 0;
    const maxAttempts = zone.count * MAX_ATTEMPTS_PER_PROP;
    for (let attempt = 0; attempt < maxAttempts && placedInZone < zone.count; attempt++) {
      const x = rngRange(next, zone.x0, zone.x1);
      const z = rngRange(next, zone.z0, zone.z1);
      if (insideSolid(x, z, solids)) continue;
      if (nearSpawn(x, z, map)) continue;
      if (tooClose(x, z, placed, zone.minSpacing)) continue;
      placed.push({ x, z });
      placedInZone++;
      const prop = buildProp(zone.kind, next, zone.hex);
      prop.position.set(x, 0, z);
      statics.add(prop);
    }
  });

  const root = new THREE.Group();
  root.add(bake(statics)); // one merged mesh per material, shadows on
  root.add(makeSkyDome(map)); // unbaked: must never cast/receive shadows
  return { root, solids };
}

// ---- rich box rendering -------------------------------------------------------

/**
 * One BoxDef => jittered side body + flush lighter top cap, plus (for tall
 * ground-standing boxes) a darker skirting band at floor level and a darker
 * trim band just under the cap. Long tall faces get pilaster ribs every ~4m;
 * big slab faces additionally get large-scale +-4% value mottling (the flat
 * 12m wall is the classic blockout tell). Overhead boxes (ceilings, high
 * bridges) stay plain jittered slabs — their tops are never seen.
 */
function buildRichBox(g: THREE.Group, b: BoxDef, next: () => number): void {
  const base = MAT_COLORS[b.mat];
  const f = JITTER[Math.floor(next() * JITTER.length)] ?? 1;
  const sideHex = shade(base, f);
  const bottom = b.y - b.h / 2;
  const top = b.y + b.h / 2;
  const overhead = bottom > OVERHEAD_BOTTOM;

  if (overhead || b.h <= CAP_H + 0.01) {
    g.add(at(box(b.w, b.h, b.d, sideHex), b.x, b.y, b.z));
    return;
  }

  // body: bottom unchanged, top lowered by CAP_H (cap finishes flush at `top`)
  g.add(at(box(b.w, b.h - CAP_H, b.d, sideHex), b.x, bottom + (b.h - CAP_H) / 2, b.z));
  // cap: sun-kissed top face, slight outset so the seam never z-fights
  g.add(at(box(b.w + CAP_OUT * 2, CAP_H, b.d + CAP_OUT * 2, shade(base, f * TOP_LIGHTEN)), b.x, top - CAP_H / 2, b.z));

  const trimHex = shade(base, TRIM_DARKEN);
  // skirting + grime: floor-level accent band and a soft dark dirt overlay
  // rising past it (surface truth: wall bases collect grime)
  if (b.h >= 1.8 && Math.abs(bottom) <= 0.06 && (b.w >= 0.8 || b.d >= 0.8)) {
    g.add(
      at(box(b.w + SKIRT_OUT * 2, SKIRT_H, b.d + SKIRT_OUT * 2, trimHex), b.x, bottom + SKIRT_H / 2, b.z),
    );
    g.add(
      at(
        box(b.w + GRIME_OUT * 2, GRIME_H, b.d + GRIME_OUT * 2, shade(base, 0.55), {
          transparent: true,
          opacity: 0.35,
        }),
        b.x,
        bottom + GRIME_H / 2,
        b.z,
      ),
    );
  }
  if (b.h >= 2.2) {
    // trim: wall-top accent band just under the cap (cornice read at distance)
    g.add(
      at(box(b.w + TRIM_OUT * 2, TRIM_H, b.d + TRIM_OUT * 2, trimHex), b.x, top - CAP_H - TRIM_H / 2, b.z),
    );
    // pilaster ribs along both faces of each long axis
    if (b.w >= RIB_MIN_FACE) addRibs(g, b, trimHex, 'x');
    if (b.d >= RIB_MIN_FACE) addRibs(g, b, trimHex, 'z');
    // value mottling on the big blockout-tell faces
    if (b.w >= MOTTLE_MIN_FACE) addMottle(g, b, base, next, 'x');
    if (b.d >= MOTTLE_MIN_FACE) addMottle(g, b, base, next, 'z');
  }
}

/** Pilaster ribs: thin vertical strips (same-family dark accent) spaced ~4m
 *  along both faces of one long axis. `axis` is the face's long direction. */
function addRibs(g: THREE.Group, b: BoxDef, trimHex: string, axis: 'x' | 'z'): void {
  const len = axis === 'x' ? b.w : b.d;
  const n = Math.max(1, Math.round(len / RIB_EVERY));
  for (let i = 0; i < n; i++) {
    const c = -len / 2 + (len / n) * (i + 0.5);
    for (const s of [-1, 1]) {
      const rib =
        axis === 'x'
          ? at(box(0.18, b.h - 0.12, RIB_OUT * 2, trimHex), b.x + c, b.y, b.z + s * (b.d / 2 + RIB_OUT))
          : at(box(RIB_OUT * 2, b.h - 0.12, 0.18, trimHex), b.x + s * (b.w / 2 + RIB_OUT), b.y, b.z + c);
      g.add(rib);
    }
  }
}

/** Value mottling: a few large, faint +-4% overlay quads per big face — breaks
 *  the single-flat-value read of 8m+ slabs without touching the silhouette. */
function addMottle(g: THREE.Group, b: BoxDef, baseHex: string, next: () => number, axis: 'x' | 'z'): void {
  const len = axis === 'x' ? b.w : b.d;
  const q = Math.max(2, Math.round(len / 8));
  for (const s of [-1, 1]) {
    for (let i = 0; i < q; i++) {
      const wq = Math.min(rngRange(next, 2.5, 5.5), len - 1);
      const hq = rngRange(next, 0.35, 0.65) * b.h;
      const cq = rngRange(next, -len / 2 + wq / 2 + 0.4, len / 2 - wq / 2 - 0.4);
      const yq = rngRange(next, hq / 2 + 0.12, Math.max(hq / 2 + 0.13, b.h - hq / 2 - 0.25));
      const hex = shade(baseHex, MOTTLE_FACTORS[(i + (s > 0 ? 1 : 0)) % MOTTLE_FACTORS.length] ?? 1);
      const quad =
        axis === 'x'
          ? at(box(wq, hq, MOTTLE_OUT * 2, hex), b.x + cq, yq, b.z + s * (b.d / 2 + MOTTLE_OUT))
          : at(box(MOTTLE_OUT * 2, hq, wq, hex), b.x + s * (b.w / 2 + MOTTLE_OUT), yq, b.z + cq);
      g.add(quad);
    }
  }
}

// ---- floor life (patchwork tint zones + wear lanes; visual overlays only) -----

function buildFloorLife(g: THREE.Group, map: MapDef): void {
  const floorHex = MAT_COLORS[map.floorMat];
  const next = rng(decoSeed(map.id, SALT_FLOOR));
  const halfX = map.sizeX / 2;
  const halfZ = map.sizeZ / 2;

  // patchwork tint zones: large soft rectangles, four depth tiers so
  // overlapping patches never share a plane (no z-fighting)
  const patchCount = Math.round((map.sizeX * map.sizeZ) / 220);
  for (let i = 0; i < patchCount; i++) {
    const w = rngRange(next, 3, 9);
    const d = rngRange(next, 3, 9);
    const x = rngRange(next, -halfX + w / 2 + 1, halfX - w / 2 - 1);
    const z = rngRange(next, -halfZ + d / 2 + 1, halfZ - d / 2 - 1);
    const f = PATCH_FACTORS[i % PATCH_FACTORS.length] ?? 1;
    const y = -0.003 - (i % 4) * 0.0012;
    g.add(at(box(w, 0.002, d, shade(floorHex, f)), x, y, z));
  }

  // wear lanes: darker trampled strips running T -> CT along the mid axis and
  // two offset lanes; segmented with a slight seeded wobble so they read worn,
  // not painted. Spawn courts get a trampled pad as well.
  const wearHex = shade(floorHex, WEAR_FACTOR);
  const t = centroid(map.spawns.T);
  const ct = centroid(map.spawns.CT);
  for (const off of [0, -halfX * 0.62, halfX * 0.62]) {
    const p0 = { x: t.x + off, z: t.z };
    const p3 = { x: ct.x + off, z: ct.z };
    const pts = [p0];
    for (const k of [1 / 3, 2 / 3]) {
      pts.push({
        x: p0.x + (p3.x - p0.x) * k + rngRange(next, -1.2, 1.2),
        z: p0.z + (p3.z - p0.z) * k,
      });
    }
    pts.push(p3);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const c = pts[i + 1];
      if (a === undefined || c === undefined) continue;
      const dx = c.x - a.x;
      const dz = c.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      const wSeg = rngRange(next, 1.5, 2.1);
      const seg = at(box(wSeg, 0.002, len + 0.6, wearHex), (a.x + c.x) / 2, WEAR_TOP_Y - 0.001, (a.z + c.z) / 2);
      seg.rotation.y = Math.atan2(dx, dz);
      g.add(seg);
    }
  }
  for (const c of [t, ct]) {
    g.add(at(box(7, 0.002, 3.2, wearHex), c.x, WEAR_TOP_Y - 0.0014, c.z));
  }
}

function centroid(pts: ReadonlyArray<{ x: number; z: number }>): { x: number; z: number } {
  let x = 0;
  let z = 0;
  for (const p of pts) {
    x += p.x;
    z += p.z;
  }
  const n = Math.max(1, pts.length);
  return { x: x / n, z: z / n };
}

// ---- skyline backdrop (silhouette ring beyond the outer walls) ----------------

/**
 * A giant ground apron (so the horizon never shows void) plus a seeded ring of
 * two-tier mesa/dune silhouettes outside the playable area. Pure backdrop:
 * non-collidable, outside every solid, fog does the aerial perspective.
 */
function buildSkyline(g: THREE.Group, map: MapDef): void {
  const s = map.skyline;
  if (s === undefined) return;
  g.add(at(box(320, 0.02, 320, map.theme.ground), 0, -0.04, 0)); // horizon apron
  const next = rng(decoSeed(map.id, SALT_SKYLINE));
  for (let i = 0; i < s.count; i++) {
    const ang = (i / s.count) * Math.PI * 2 + rngRange(next, -0.15, 0.15);
    const r = rngRange(next, s.minR, s.maxR);
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    const h = rngRange(next, s.minH, s.maxH);
    const w = rngRange(next, h * 1.6, h * 2.8);
    const d = rngRange(next, h * 1.2, h * 2.0);
    const yaw = next() * Math.PI;
    const base = at(box(w, h, d, s.hex), x, h / 2 - 0.5, z); // sunk 0.5 into the apron
    base.rotation.y = yaw;
    g.add(base);
    const h2 = h * rngRange(next, 0.35, 0.55);
    const tier = at(box(w * 0.62, h2, d * 0.62, s.capHex ?? s.hex), x, h - 0.5 + h2 / 2, z);
    tier.rotation.y = yaw + rngRange(next, -0.2, 0.2);
    g.add(tier);
  }
}

// ---- deliberate accent dressing (data-driven visual overlays) ------------------

function buildAccents(g: THREE.Group, map: MapDef): void {
  for (const a of map.accents ?? []) {
    const opts = a.emissive === true ? { emissive: a.hex } : undefined;
    g.add(at(box(a.w, a.h, a.d, a.hex, opts), a.x, a.y, a.z));
  }
}

// ---- desktop dressing (showroom -> workplace) -----------------------------------

/**
 * Seeded workplace props ON 'desk'-material BoxDefs (the bullpen sightlines
 * were bare white desktops): monitors with lit/dark screens + keyboards, and
 * paper piles. Everything sits on the desk top; all non-collidable overlays.
 */
function buildDesktopDressing(g: THREE.Group, map: MapDef): void {
  const next = rng(decoSeed(map.id, SALT_DESK));
  for (const b of map.boxes) {
    if (b.mat !== 'desk' || b.w < 2 || b.d < 0.6) continue;
    const top = b.y + b.h / 2;
    const items = rngInt(next, 1, 2);
    for (let i = 0; i < items; i++) {
      const px = b.x + rngRange(next, -b.w / 2 + 0.5, b.w / 2 - 0.5);
      const pz = b.z + rngRange(next, -b.d / 2 + 0.2, b.d / 2 - 0.2);
      if (next() < 0.6) {
        // monitors within ~9m of a spawn-adjacent sightline are always lit —
        // the hero frames must never show a dead black screen at eye level
        buildMonitor(g, next, px, top, pz, withinSpawnRadius(px, pz, map, 9));
      } else {
        const pile = new THREE.Group();
        buildPaperStack(pile, next);
        pile.position.set(px, top, pz);
        g.add(pile);
      }
    }
  }
}

/** True when (x,z) is within r meters of any spawn point (either team). */
function withinSpawnRadius(x: number, z: number, map: MapDef, r: number): boolean {
  const r2 = r * r;
  for (const team of [map.spawns.T, map.spawns.CT]) {
    for (const s of team) {
      const dx = s.x - x;
      const dz = s.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
  }
  return false;
}

/** monitor: stand + foot + bezel + screen face (~95% lit screenGlow; always
 *  lit when forceLit) + keyboard. */
function buildMonitor(g: THREE.Group, next: () => number, x: number, topY: number, z: number, forceLit: boolean): void {
  const m = new THREE.Group();
  m.add(at(box(0.3, 0.03, 0.2, PALETTE.charcoal), 0, 0.015, 0)); // foot
  m.add(at(box(0.06, 0.22, 0.06, PALETTE.charcoal), 0, 0.13, 0)); // stand
  m.add(at(box(0.56, 0.36, 0.05, PALETTE.charcoal), 0, 0.42, 0)); // bezel
  const lit = forceLit || next() < 0.95;
  m.add(
    at(
      box(0.5, 0.3, 0.02, PALETTE.screenGlow, lit ? { emissive: PALETTE.screenGlow } : undefined),
      0,
      0.42,
      0.037,
    ),
  ); // screen face (+z of group)
  m.add(at(box(0.36, 0.02, 0.13, PALETTE.charcoal), 0, 0.01, 0.28)); // keyboard
  m.rotation.y = (next() < 0.5 ? 0 : Math.PI) + rngRange(next, -0.25, 0.25);
  m.position.set(x, topY, z);
  g.add(m);
}

// ---- ceiling light panels (indoor maps: big mood win) --------------------------

/**
 * Seeded grid of fluorescent panels hung under ceiling slabs. A map "has a
 * ceiling" wherever an overhead box (slab bottom in [2.2, 4.5], >= 3m in both
 * footprint axes) covers the grid point — outdoor maps get nothing, skylight
 * slots stay dark. Panels never spawn inside tall solids (pillars/walls).
 * ~15% of lit cells are dead fixtures (dark plate, no glow, no pool); each
 * live panel spills a soft transparent pool quad onto the floor below.
 */
function buildLightPanels(g: THREE.Group, map: MapDef, solids: AABB[]): void {
  const slabs = map.boxes.filter((b) => {
    const bottom = b.y - b.h / 2;
    return bottom >= 2.2 && bottom <= 4.5 && b.w >= 3 && b.d >= 3;
  });
  if (slabs.length === 0) return;

  const next = rng(decoSeed(map.id, SALT_LIGHT));
  const halfX = map.sizeX / 2;
  const halfZ = map.sizeZ / 2;
  const cols = Math.floor((map.sizeX - 2.6) / PANEL_CELL) + 1;
  const rows = Math.floor((map.sizeZ - 2.6) / PANEL_CELL) + 1;
  const poolHex = shade(PALETTE.paper, 0.82); // warm fixture light on any floor
  const poolGlowHex = shade(PALETTE.paper, 0.5);

  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = -halfX + 1.3 + i * PANEL_CELL;
      const z = -halfZ + 1.3 + j * PANEL_CELL;
      let ceil = Number.POSITIVE_INFINITY;
      for (const s of slabs) {
        if (Math.abs(x - s.x) <= s.w / 2 && Math.abs(z - s.z) <= s.d / 2) {
          ceil = Math.min(ceil, s.y - s.h / 2);
        }
      }
      if (!Number.isFinite(ceil)) continue;
      if (next() < PANEL_SKIP) continue;
      if (insideTallSolid(x, z, ceil, map.boxes)) continue;

      const alongX = (i + j) % 2 === 0; // alternate orientation per cell
      const fw = alongX ? 1.3 : 0.7;
      const fd = alongX ? 0.7 : 1.3;
      const gw = alongX ? 1.16 : 0.56;
      const gd = alongX ? 0.56 : 1.16;
      g.add(at(box(fw, 0.05, fd, PALETTE.metalDark), x, ceil - 0.025, z));

      if (next() < PANEL_DARK) {
        // dead fixture: dark inset plate, no glow, no pool
        g.add(at(box(gw, 0.024, gd, PALETTE.charcoal), x, ceil - 0.062, z));
        continue;
      }
      const warm = next() >= PANEL_COOL;
      const glowHex = warm ? PALETTE.paper : PALETTE.screenGlow;
      g.add(at(box(gw, 0.024, gd, glowHex, { emissive: glowHex }), x, ceil - 0.062, z));
      // floor pool: soft warm emissive-transparent spill on open floor (not
      // under solids) — every live panel gets a visible floor response
      if (!insideSolid(x, z, solids)) {
        const pw = alongX ? 2.8 : 1.8;
        const pd = alongX ? 1.8 : 2.8;
        g.add(
          at(
            box(pw, 0.001, pd, poolHex, { transparent: true, opacity: POOL_OPACITY, emissive: poolGlowHex }),
            x,
            -0.001,
            z,
          ),
        );
      }
    }
  }
}

/** True when (x,z) lies inside a floor-standing solid (padded) whose top
 *  reaches the panel. Overhead boxes (the ceiling slabs themselves, bottom at
 *  or above the panel) are not obstructions — panels hang from them. */
function insideTallSolid(x: number, z: number, ceil: number, boxes: readonly BoxDef[]): boolean {
  for (const b of boxes) {
    if (b.y - b.h / 2 >= ceil - 0.5) continue; // overhead slab, not a pillar
    if (b.y + b.h / 2 < ceil - 0.12) continue; // too low to reach the panel
    if (Math.abs(x - b.x) <= b.w / 2 + 0.35 && Math.abs(z - b.z) <= b.d / 2 + 0.35) return true;
  }
  return false;
}

// ---- scatter rejections -------------------------------------------------------

/** Point (ground plane) vs every solid, each AABB inflated by SOLID_PAD. */
function insideSolid(x: number, z: number, solids: AABB[]): boolean {
  for (const s of solids) {
    if (x > s.minX - SOLID_PAD && x < s.maxX + SOLID_PAD && z > s.minZ - SOLID_PAD && z < s.maxZ + SOLID_PAD) {
      return true;
    }
  }
  return false;
}

/** Props never crowd spawn points (both teams). */
function nearSpawn(x: number, z: number, map: MapDef): boolean {
  const d2 = SPAWN_CLEARANCE * SPAWN_CLEARANCE;
  for (const s of map.spawns.T) {
    const dx = s.x - x;
    const dz = s.z - z;
    if (dx * dx + dz * dz < d2) return true;
  }
  for (const s of map.spawns.CT) {
    const dx = s.x - x;
    const dz = s.z - z;
    if (dx * dx + dz * dz < d2) return true;
  }
  return false;
}

/** Min center distance to every already-placed prop. */
function tooClose(x: number, z: number, placed: ReadonlyArray<{ x: number; z: number }>, minSpacing: number): boolean {
  const d2 = minSpacing * minSpacing;
  for (const p of placed) {
    const dx = p.x - x;
    const dz = p.z - z;
    if (dx * dx + dz * dz < d2) return true;
  }
  return false;
}

// ---- sky dome (factory exception, CONTRACT rule 5) -----------------------------
// Raw SphereGeometry + MeshBasicMaterial with manual vertex colors: the single
// non-Lambert surface in the game. Gradient theme.sky (top) -> theme.horizon.

function makeSkyDome(map: MapDef): THREE.Mesh {
  const geo = new THREE.SphereGeometry(DOME_RADIUS, 24, 12);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(map.theme.sky); // linear work-space, same as mat()
  const bottom = new THREE.Color(map.theme.horizon);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = smooth01(pos.getY(i) / DOME_RADIUS / 2 + 0.5);
    c.copy(bottom).lerp(top, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const dome = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }),
  );
  dome.frustumCulled = false; // the dome always encloses the camera
  return dome;
}

function smooth01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

// ---- deco prop recipes (CONTRACT model sheets: 3-10 prims, PALETTE only) ------
// Every builder fills a group sitting on y=0; buildProp adds yaw + scale jitter.

function buildProp(kind: DecoKind, next: () => number, hex?: string): THREE.Group {
  const g = new THREE.Group();
  switch (kind) {
    case 'crate':
      buildCrate(g);
      break;
    case 'barrel':
      buildBarrel(g, next, hex);
      break;
    case 'pallet':
      buildPallet(g);
      break;
    case 'pipe':
      buildPipe(g);
      break;
    case 'rock':
      scatterRocks(g, next, PALETTE.rockDark);
      break;
    case 'shrub':
      buildShrub(g, next);
      break;
    case 'cactus':
      buildCactus(g, next);
      break;
    case 'snowRock':
      buildSnowRock(g, next);
      break;
    case 'plant':
      buildPlant(g, next);
      break;
    case 'paperStack':
      buildPaperStack(g, next);
      break;
    case 'palletStack':
      buildPalletStack(g, next);
      break;
    case 'sandbag':
      buildSandbag(g, next);
      break;
    case 'icicle':
      buildIcicle(g, next);
      break;
    case 'deskChair':
      buildDeskChair(g);
      break;
    case 'waterCooler':
      buildWaterCooler(g);
      break;
    case 'sack':
      buildSack(g, next);
      break;
  }
  g.rotation.y = next() * Math.PI * 2; // slight organic yaw jitter
  g.scale.setScalar(rngRange(next, 0.85, 1.2));
  return g;
}

/** crate: wood box + 4 woodDark edge battens + raised lid on a darker rim. */
function buildCrate(g: THREE.Group): void {
  const S = 0.9;
  const B = 0.09;
  g.add(at(box(S, S, S, PALETTE.wood), 0, S / 2, 0));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(at(box(B, S, B, PALETTE.woodDark), (sx * (S - B)) / 2, S / 2, (sz * (S - B)) / 2));
    }
  }
  // lid: darker rim plate slightly proud of the body, raised lid panel on top
  g.add(at(box(S + 0.04, 0.04, S + 0.04, PALETTE.woodDark), 0, S + 0.02, 0));
  g.add(at(box(S - 0.08, 0.05, S - 0.08, PALETTE.wood), 0, S + 0.065, 0));
}

/** barrel: cyl + 2 ring bands + inset lid disc. Body: steel/tBrown industrial
 *  by default, or two tones of the zone's family hex when one is set (e.g.
 *  dustbowl's sand family — the gray-blue steel read off-palette there). */
function buildBarrel(g: THREE.Group, next: () => number, hex?: string): void {
  const R = 0.34;
  const H = 0.92;
  const body = hex !== undefined ? shade(hex, next() < 0.5 ? 1 : 0.85) : next() < 0.5 ? PALETTE.steel : PALETTE.tBrown;
  g.add(at(cyl(R, R, H, 12, body), 0, H / 2, 0));
  g.add(at(cyl(R + 0.03, R + 0.03, 0.07, 12, PALETTE.metalDark), 0, H * 0.28, 0));
  g.add(at(cyl(R + 0.03, R + 0.03, 0.07, 12, PALETTE.metalDark), 0, H * 0.72, 0));
  g.add(at(cyl(R - 0.04, R - 0.04, 0.05, 12, PALETTE.metalDark), 0, H + 0.025, 0)); // lid
}

/** pallet: 3 slats over 2 beams. */
function buildPallet(g: THREE.Group): void {
  for (const z of [-0.35, 0, 0.35]) {
    g.add(at(box(1.15, 0.04, 0.28, PALETTE.wood), 0, 0.11, z));
  }
  for (const x of [-0.42, 0.42]) {
    g.add(at(box(0.14, 0.09, 1.0, PALETTE.woodDark), x, 0.045, 0));
  }
}

/** palletStack: 2-3 pallets piled with slight yaw drift (warehouse dressing). */
function buildPalletStack(g: THREE.Group, next: () => number): void {
  const n = rngInt(next, 2, 3);
  for (let i = 0; i < n; i++) {
    const layer = new THREE.Group();
    buildPallet(layer);
    layer.position.y = i * 0.135;
    layer.rotation.y = rngRange(next, -0.14, 0.14);
    g.add(layer);
  }
}

/** pipe: horizontal steel cyl + 2 ring bands + 2 end flanges + elbow riser. */
function buildPipe(g: THREE.Group): void {
  const R = 0.14;
  const L = 1.8;
  const run = at(cyl(R, R, L, 10, PALETTE.steel), 0, R, 0);
  run.rotation.z = Math.PI / 2; // axis along x, resting on the ground
  g.add(run);
  for (const x of [-0.55, 0.55]) {
    const flange = at(cyl(R + 0.06, R + 0.06, 0.08, 10, PALETTE.metalDark), x, R, 0);
    flange.rotation.z = Math.PI / 2;
    g.add(flange);
  }
  for (const x of [-L / 2 + 0.05, L / 2 - 0.05]) {
    const end = at(cyl(R + 0.05, R + 0.05, 0.07, 10, PALETTE.metalDark), x, R, 0);
    end.rotation.z = Math.PI / 2;
    g.add(end);
  }
  g.add(at(cyl(R, R, 0.9, 10, PALETTE.steel), L / 2 - R, R + 0.42, 0)); // elbow up at one end
}

/** sandbag: brickwork rows of squat bags (field fortification). */
function buildSandbag(g: THREE.Group, next: () => number): void {
  const rows = rngInt(next, 2, 3);
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < 3; i++) {
      const bx = (i - 1) * 0.52 + (r % 2 === 1 ? 0.13 : -0.13);
      const bag = at(
        box(0.5, 0.2, 0.34, r % 2 === 0 ? PALETTE.sandDark : PALETTE.dust),
        bx + rngRange(next, -0.03, 0.03),
        0.1 + r * 0.19,
        rngRange(next, -0.03, 0.03),
      );
      bag.rotation.y = rngRange(next, -0.15, 0.15);
      g.add(bag);
    }
  }
}

/** icicle: cluster of small frost shards (short cones, slight lean). */
function buildIcicle(g: THREE.Group, next: () => number): void {
  const n = rngInt(next, 3, 5);
  for (let i = 0; i < n; i++) {
    const h = rngRange(next, 0.3, 0.9);
    const r = rngRange(next, 0.05, 0.12);
    const hex = next() < 0.6 ? PALETTE.ice : PALETTE.snowShadow;
    const shard = at(cone(r, h, 6, hex), rngRange(next, -0.3, 0.3), h / 2, rngRange(next, -0.3, 0.3));
    shard.rotation.z = rngRange(next, -0.12, 0.12);
    shard.rotation.x = rngRange(next, -0.12, 0.12);
    g.add(shard);
  }
}

/** deskChair: post + base disc + seat + back panel (office dressing). */
function buildDeskChair(g: THREE.Group): void {
  g.add(at(cyl(0.26, 0.3, 0.04, 8, PALETTE.metalDark), 0, 0.02, 0)); // base disc
  g.add(at(cyl(0.03, 0.03, 0.42, 6, PALETTE.metalDark), 0, 0.23, 0)); // post
  g.add(at(box(0.46, 0.06, 0.44, PALETTE.charcoal), 0, 0.47, 0)); // seat
  g.add(at(box(0.44, 0.5, 0.06, PALETTE.charcoal), 0, 0.75, -0.22)); // back
}

/** waterCooler: paper-white body + translucent-blue (ice) bottle + neck. */
function buildWaterCooler(g: THREE.Group): void {
  g.add(at(box(0.34, 0.95, 0.34, PALETTE.paper), 0, 0.475, 0)); // body
  g.add(at(box(0.36, 0.05, 0.36, PALETTE.charcoal), 0, 0.975, 0)); // collar trim
  g.add(at(cyl(0.15, 0.15, 0.42, 10, PALETTE.ice), 0, 1.21, 0)); // bottle
  g.add(at(cyl(0.05, 0.05, 0.08, 8, PALETTE.ice), 0, 1.46, 0)); // neck
}

/** sack: 2-3 slumped grain sacks (squashed spheres, market dressing). */
function buildSack(g: THREE.Group, next: () => number): void {
  const n = rngInt(next, 2, 3);
  for (let i = 0; i < n; i++) {
    const r = rngRange(next, 0.26, 0.36);
    const hex = next() < 0.5 ? PALETTE.dust : PALETTE.tBrown;
    const sack = at(sphere(r, 7, hex), rngRange(next, -0.25, 0.25), r * 0.55, rngRange(next, -0.25, 0.25));
    sack.scale.y = rngRange(next, 0.55, 0.7);
    g.add(sack);
  }
}

/** rock/snowRock core: 2-3 overlapping squashed spheres; returns top y. */
function scatterRocks(g: THREE.Group, next: () => number, hex: string): number {
  let top = 0;
  const n = rngInt(next, 2, 3);
  for (let i = 0; i < n; i++) {
    const r = rngRange(next, 0.35, 0.6);
    const sy = rngRange(next, 0.45, 0.7);
    const cy = r * 0.45;
    const m = at(sphere(r, 7, hex), rngRange(next, -0.3, 0.3), cy, rngRange(next, -0.3, 0.3));
    m.scale.set(rngRange(next, 0.9, 1.3), sy, rngRange(next, 0.9, 1.3));
    m.rotation.y = next() * Math.PI;
    g.add(m);
    top = Math.max(top, cy + r * sy);
  }
  return top;
}

/** snowRock: rock recipe in snowShadow + snow cap sphere on top. */
function buildSnowRock(g: THREE.Group, next: () => number): void {
  const top = scatterRocks(g, next, PALETTE.snowShadow);
  const cap = at(sphere(0.4, 7, PALETTE.snow), 0, top + 0.05, 0);
  cap.scale.y = 0.35;
  g.add(cap);
}

/** shrub: 2-3 small leaf/leafDark spheres on a tiny trunk. */
function buildShrub(g: THREE.Group, next: () => number): void {
  g.add(at(cyl(0.035, 0.05, 0.3, 6, PALETTE.woodDark), 0, 0.15, 0));
  const n = rngInt(next, 2, 3);
  for (let i = 0; i < n; i++) {
    const r = rngRange(next, 0.22, 0.38);
    const hex = next() < 0.5 ? PALETTE.leaf : PALETTE.leafDark;
    g.add(at(sphere(r, 6, hex), rngRange(next, -0.18, 0.18), 0.3 + i * 0.16 + r * 0.4, rngRange(next, -0.18, 0.18)));
  }
}

/** cactus: main column + cap, 1-2 arms (horizontal + vertical + tip) = 5-7 prims. */
function buildCactus(g: THREE.Group, next: () => number): void {
  const H = rngRange(next, 1.1, 1.6);
  g.add(at(cyl(0.16, 0.2, H, 8, PALETTE.cactus), 0, H / 2, 0));
  g.add(at(sphere(0.16, 6, PALETTE.cactus), 0, H, 0));
  const arms = rngInt(next, 1, 2);
  for (let i = 0; i < arms; i++) {
    const side = i === 0 ? 1 : -1;
    const ay = H * rngRange(next, 0.45, 0.65);
    const h = at(cyl(0.1, 0.1, 0.36, 6, PALETTE.cactus), side * 0.3, ay, 0);
    h.rotation.z = Math.PI / 2;
    g.add(h);
    g.add(at(cyl(0.1, 0.1, 0.42, 6, PALETTE.cactus), side * 0.44, ay + 0.21, 0));
    g.add(at(sphere(0.1, 6, PALETTE.cactus), side * 0.44, ay + 0.42, 0));
  }
}

/** plant: thin brick pot + 3 leaf spheres. */
function buildPlant(g: THREE.Group, next: () => number): void {
  g.add(at(cyl(0.16, 0.12, 0.3, 8, PALETTE.brick), 0, 0.15, 0));
  for (let i = 0; i < 3; i++) {
    const r = rngRange(next, 0.14, 0.22);
    const hex = i % 2 === 0 ? PALETTE.leaf : PALETTE.leafDark;
    g.add(at(sphere(r, 6, hex), rngRange(next, -0.1, 0.1), 0.34 + i * 0.12, rngRange(next, -0.1, 0.1)));
  }
}

/** paperStack: 2-4 thin paper boxes with slight rotation offsets. */
function buildPaperStack(g: THREE.Group, next: () => number): void {
  const n = rngInt(next, 2, 4);
  for (let i = 0; i < n; i++) {
    const p = at(
      box(0.32, 0.025, 0.24, PALETTE.paper),
      rngRange(next, -0.03, 0.03),
      0.0125 + i * 0.026,
      rngRange(next, -0.03, 0.03),
    );
    p.rotation.y = rngRange(next, -0.4, 0.4);
    g.add(p);
  }
}
