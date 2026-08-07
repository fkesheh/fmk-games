// ============================================================================
// ANCIENTS (rift) — VEGETATION (R_VEG). The jungle: trees, undergrowth, rocks,
// deadwood, ruin fragments and the river bank.
//
// WHAT THIS MODULE IS FOR (STYLE_BIBLE §0.1, §7, §8, §10a.4). The baseline
// build's tree was "one cylinder plus one green icosahedron" — the textbook
// lollipop — copy-pasted across a flat plane. That single defect is most of the
// distance between our frame and the Dota 2 frame it is judged against: a MOBA
// jungle is a WALL, and a wall is made of trunks with root flare, three to five
// branch levels, and layered canopy shells at different scales and rotations.
// Twenty-one archetypes are built here, seven of them trees, and every one of
// the ~2.4 k placed instances gets seeded scale/rotation/lean/tint variation so
// no two neighbours are the same object.
//
// THE FOUR LAWS THIS FILE OBEYS, and where each is enforced below:
//
//  1. MATERIAL LAW. Every material is `surface(id)` from the kit — there is not
//     one material constructor in this file. Per-instance colour variation is
//     NOT `surface(id, tint)`: a tint mints a material and therefore a draw
//     call, and three tint steps across twenty-nine buckets would be eighty-
//     seven draw calls for the jungle alone. It is the InstancedMesh colour
//     attribute instead (see INSTANCE COLOUR below), which is exactly the
//     "per-instance tint step" the vertex-colour law in core.ts reserves it for.
//
//  2. VERTEX-COLOUR LAW. Archetype geometry goes through the kit's
//     `bakeChunked` → `bake()`, which emits the white `color` attribute
//     unconditionally; `whiteVertexColors` is still called on every bucket
//     before it reaches a material, because it is idempotent and because this
//     module must not depend on a detail of another module's internals to avoid
//     rendering black. `bakeVertexAO` then multiplies contact + crowding
//     occlusion into that attribute — the cheap half of the AO story, and the
//     reason a canopy underside and a root flare read as occluded before the
//     screen-space pass has done anything.
//
//  3. UV LAW. Nothing here touches `texture.repeat`; `bake()` reprojects every
//     part into world space at 1 UV unit = 1 m. Trunk parts use the `bark`
//     family, which the kit projects cylindrically — the reason a trunk's
//     vertical strata run UP the trunk rather than smearing across it.
//
//  4. DRAW-CALL LAW (GRAPHICS_CONTRACT §5). One `InstancedMesh` per (archetype,
//     surface bucket). Twenty-one archetypes over twenty-nine buckets = 29 draw
//     calls for roughly 2 400 props. Baking the same props into 16 m chunks
//     instead would cost hundreds of buckets and lose the instancing entirely.
//
// INSTANCE COLOUR. `scatter()` hands back one of the family's {base, Lit, Deep}
// palette steps per instance. Because the InstancedMesh colour attribute
// MULTIPLIES the material albedo, the step is converted once per family into a
// multiplicative ratio against that ladder's base — gain-compressed and clamped
// into a narrow band, because the raw Lit/Deep ratio is a ±8 L* step and applied
// multiplicatively on top of an already-correct albedo it reads as a different
// species rather than a different tree. Small and multiplicative, per the law.
//
// WIND. Canopy and frond buckets hang off their own sway node — a `Group` whose
// position oscillates a few centimetres with a per-archetype phase. Per frame
// that is a dozen sin/cos and a dozen `position.set` calls, allocation-free and
// independent of instance count; re-composing 1 200 instance matrices every
// frame to sway them individually would re-upload the whole matrix buffer and
// buy motion nobody can resolve at gameplay zoom. The trunk bucket does NOT
// sway, so the canopy moves against a fixed trunk, which is what reads as wind.
//
// COLD LOAD. 150 ms of the 400 ms budget, spent through one queue of small work
// units stepped from this module's own frame hook at SLICE_MS per frame:
// distance fields → zone classification → archetype bakes → per-tile scatter →
// instance fill. `ready()` is false until the queue drains.
// ============================================================================
import * as THREE from 'three';
import { APAL, TERRAIN_KINDS } from '@rift/shared';
import type { MapDef, SurfaceId, TerrainDef } from '@rift/shared';
import type { SceneHandle, VegetationHandle } from '../contract.js';
import { sceneCore, whiteVertexColors } from './core.js';
import {
  bakeChunked,
  bakeVertexAO,
  box,
  cone,
  cyl,
  ico,
  lathe,
  rng,
  scatter,
  sphere,
  surface,
} from './kit.js';
import type { ChunkedBake, InstanceXform, Part, Rng } from './kit.js';

// ============================================================================
// Tuning — art direction and budget, transcribed from the contracts
// ============================================================================

const TAU = Math.PI * 2;

/** Main-thread slice per frame for the construction queue. 6 ms sits inside one
 *  60 fps frame with room for the rest of the renderer, and the 150 ms cold-load
 *  budget is met by how many frames it takes, never by making a slice longer. */
const SLICE_MS = 6;

/** Per-step slice handed to the kit's `bakeChunked` for one archetype. An
 *  archetype is 18-40 parts, so this is almost always one step; the cap only
 *  matters for the biggest tree. */
const BAKE_SLICE_MS = 4;

/** Baked-AO strength for archetype geometry. Applied once per archetype, shared
 *  by every instance of it — which is correct: the occlusion being baked is the
 *  prop's own self-shadowing (canopy underside, root crotch, rock crevice), not
 *  its relationship to the ground. Carried only by archetypes with real interior
 *  volume (`ArchDef.ao`): on a six-blade grass tuft it is measurable cold-load
 *  cost for occlusion nothing can resolve. */
const AO_STRENGTH = 0.55;

/** Scatter tiles per map axis. Tiling exists so `scatter()`'s seed-point search
 *  starts inside the zone rather than 64 blind attempts across the whole map —
 *  the river bank is ~6% of the map and would otherwise sometimes scatter
 *  nothing. The Poisson spacing guarantee is preserved ACROSS tile seams by the
 *  committed-point hash in the family's `accept`, so there is no seam clumping.
 *
 *  It is also, measurably, the SEEDING density. Bridson's algorithm can only
 *  fill the connected component its seed point lands in, and `foliage` is a
 *  scatter of disconnected islands — so one seed per family per map plants one
 *  island and leaves the rest of the jungle bare. Measured at 3 lanes: 3 tiles
 *  planted 175 trees, 8 tiles planted 337 from the same densities. The tile grid
 *  is what reaches every island, and the per-tile zone histogram below is what
 *  keeps 8x8x14 units affordable. */
const TILES = 8;

/** How far from the river a `ground` cell still counts as bank (metres). */
const BANK_REACH = 3.5;
/** How far from a lane/ramp/base cell a `ground` cell counts as lane shoulder
 *  rather than jungle (metres). Beyond this the map is jungle and gets the
 *  enclosing densities; inside it the lane stays clean and readable. */
const SHOULDER_REACH = 4.5;

/** Gain and clamp of the per-instance colour modulation. See INSTANCE COLOUR. */
const TINT_GAIN = 0.45;
const TINT_MIN = 0.78;
const TINT_MAX = 1.24;

/** Sway amplitude in metres and angular rate in rad/s, per sway class. */
const SWAY_CANOPY_AMP = 0.075;
const SWAY_FROND_AMP = 0.038;
const SWAY_RATE = 1.35;

/** Global instance ceiling across every family — the triangle-budget backstop
 *  (GRAPHICS_CONTRACT §5, <= 1.2 M rendered per pass). The per-family `max`
 *  values sum well below this at every lane count measured; it exists so a lane
 *  count nobody has measured cannot plant the map straight through the budget. */
const TOTAL_CAP = 3200;

// Terrain kind codes. Derived from the frozen `TERRAIN_KINDS` order rather than
// hard-coded, so a contract-level reorder cannot silently plant trees in the
// river.
const K_GROUND = TERRAIN_KINDS.indexOf('ground');
const K_HIGH = TERRAIN_KINDS.indexOf('high');
const K_CLIFF = TERRAIN_KINDS.indexOf('cliff');
const K_RIVER = TERRAIN_KINDS.indexOf('river');
const K_FOLIAGE = TERRAIN_KINDS.indexOf('foliage');
const K_LANE = TERRAIN_KINDS.indexOf('lane');
const K_RAMP = TERRAIN_KINDS.indexOf('ramp');
const K_BASE = TERRAIN_KINDS.indexOf('base');

// Planting zones. A cell is in exactly one, and `Z_NONE` is everything nothing
// may be planted on: the lane corridor, the ramps, the base platforms, the cliff
// faces and the river channel itself.
const Z_NONE = 0;
/** `foliage` cells — the concealment the sim reads. Densest planting in the
 *  game, because a player must be able to GUESS where they are hidden. */
const Z_DENSE = 1;
/** Open low ground away from lanes: jungle proper. */
const Z_OPEN = 2;
/** Low ground within `SHOULDER_REACH` of a lane: sparse, so fights stay legible. */
const Z_SHOULDER = 3;
/** The plateaus: bare and wind-scoured (STYLE_BIBLE §8). */
const Z_HIGH = 4;
/** Low ground within `BANK_REACH` of the river channel. */
const Z_BANK = 5;

const M_DENSE = 1 << Z_DENSE;
const M_OPEN = 1 << Z_OPEN;
const M_SHOULDER = 1 << Z_SHOULDER;
const M_HIGH = 1 << Z_HIGH;
const M_BANK = 1 << Z_BANK;

// The family tint ladders. Each is a palette {base, Lit, Deep} triplet — never
// an ad-hoc lighten/darken (STYLE_BIBLE §3, §8).
const LADDER_CANOPY: readonly string[] = [APAL.canopy, APAL.canopyLit, APAL.canopyDeep];
const LADDER_FERN: readonly string[] = [APAL.fern, APAL.fernLit, APAL.fernDeep];
const LADDER_BARK: readonly string[] = [APAL.bark, APAL.barkLit, APAL.barkDeep];
const LADDER_CLIFF: readonly string[] = [APAL.cliff, APAL.cliffLit, APAL.cliffDeep];
const LADDER_MONUMENT: readonly string[] = [APAL.monument, APAL.monumentLit, APAL.monumentDeep];
const LADDER_WET: readonly string[] = [APAL.wetStone, APAL.wetStoneLit, APAL.wetStoneDeep];

// ============================================================================
// Geometry helpers — local build vocabulary over the kit primitives
// ============================================================================

interface Pt {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Unit direction of a limb tilted `tilt` from vertical and swung to azimuth
 *  `az`. Mirrors `PartOpts`' rotateX-then-rotateY order exactly, which is why a
 *  limb built with these numbers lands where this function says it does. */
function limbDir(tilt: number, az: number): Pt {
  const s = Math.sin(tilt);
  return { x: s * Math.sin(az), y: Math.cos(tilt), z: s * Math.cos(az) };
}

/** Push a tapered limb (trunk section, branch, root spur) growing from `base`
 *  and return its tip, so the next level can grow from there. This is the whole
 *  reason the trees have branch LEVELS rather than a spray of sticks from one
 *  point: level n+1 starts at level n's tip. */
function limb(
  parts: Part[],
  id: SurfaceId,
  rTop: number,
  rBot: number,
  len: number,
  seg: number,
  tilt: number,
  az: number,
  base: Pt,
): Pt {
  const d = limbDir(tilt, az);
  parts.push({
    surface: id,
    geo: cyl(rTop, rBot, len, seg, {
      rx: tilt,
      ry: az,
      x: base.x + d.x * len * 0.5,
      y: base.y + d.y * len * 0.5,
      z: base.z + d.z * len * 0.5,
    }),
  });
  return { x: base.x + d.x * len, y: base.y + d.y * len, z: base.z + d.z * len };
}

/** One canopy shell: a squashed, rotated icosphere. Layered shells of differing
 *  scale and rotation are what stop a canopy reading as one ball (STYLE_BIBLE
 *  §7); a single shell IS the lollipop.
 *
 *  `detail` is a triangle-budget dial, not an art dial: at 1 a shell is 80
 *  triangles and at 0 it is 20, and five overlapping non-uniformly scaled shells
 *  read as one soft volume either way once `canopy`'s smooth shading and soft
 *  normal map are on them. Only the emergent giant — the one tree whose crown
 *  breaks the skyline and is read against the sky — spends detail 1. */
function shell(parts: Part[], id: SurfaceId, r: number, detail: number, at: Pt, rr: Rng): void {
  parts.push({
    surface: id,
    geo: ico(r, detail, {
      sx: rr.range(0.86, 1.25),
      sy: rr.range(0.5, 0.78),
      sz: rr.range(0.86, 1.25),
      rx: rr.range(-0.3, 0.3),
      ry: rr.range(0, TAU),
      rz: rr.range(-0.3, 0.3),
      x: at.x,
      y: at.y,
      z: at.z,
    }),
  });
}

/** A buttress root flare: a vertically-stretched, laterally-flattened cone
 *  leaning out of the trunk base. Root flare is the single cheapest cue that a
 *  trunk grew out of the ground rather than being stuck into it. */
function rootFlare(parts: Part[], id: SurfaceId, r: number, h: number, az: number, out: number): void {
  parts.push({
    surface: id,
    geo: cone(r, h, 5, {
      sz: 0.42,
      rx: 0.42,
      ry: az,
      x: Math.sin(az) * out,
      y: h * 0.42,
      z: Math.cos(az) * out,
    }),
  });
}

/** A frond / blade: a flattened tapered cone leaning out from a root point.
 *  Never thinner than ~5 cm at the base — nothing in this game may be thin
 *  enough to alias at gameplay zoom (STYLE_BIBLE §7). */
function frond(
  parts: Part[],
  id: SurfaceId,
  r: number,
  len: number,
  tilt: number,
  az: number,
  base: Pt,
): void {
  const d = limbDir(tilt, az);
  parts.push({
    surface: id,
    geo: cone(r, len, 4, {
      sz: 0.34,
      rx: tilt,
      ry: az,
      x: base.x + d.x * len * 0.42,
      y: base.y + d.y * len * 0.42,
      z: base.z + d.z * len * 0.42,
    }),
  });
}

/** An irregular stone mass: two-to-four interpenetrating icospheres at
 *  different non-uniform scales and rotations. Deliberately never ONE
 *  icosahedron — "a Platonic-solid rock" is a named hard ban (STYLE_BIBLE §11),
 *  and the `cliffRock` family is flat-shaded, so the facets do the rest. */
function stoneMass(
  parts: Part[],
  id: SurfaceId,
  r: number,
  lumps: number,
  at: Pt,
  rr: Rng,
  detail: number,
): void {
  for (let i = 0; i < lumps; i++) {
    const az = rr.range(0, TAU);
    const off = i === 0 ? 0 : r * rr.range(0.28, 0.62);
    parts.push({
      surface: id,
      geo: ico(r * (i === 0 ? 1 : rr.range(0.42, 0.74)), i === 0 ? detail : 0, {
        sx: rr.range(0.78, 1.3),
        sy: rr.range(0.52, 0.92),
        sz: rr.range(0.78, 1.3),
        rx: rr.range(0, TAU),
        ry: rr.range(0, TAU),
        rz: rr.range(0, TAU),
        x: at.x + Math.sin(az) * off,
        y: at.y + rr.range(-0.14, 0.18) * r,
        z: at.z + Math.cos(az) * off,
      }),
    });
  }
}

// ============================================================================
// The archetype library — 21 builds, 7 of them trees (STYLE_BIBLE §7 requires
// at least 6 tree archetypes at 18-40 parts each). Part counts are noted per
// build and are fixed, because every loop bound is a literal.
// ============================================================================

/** GIANT emergent, ~11.5 m. 24 parts (5 roots + 3 trunk + 4 + 6 branches +
 *  6 shells). The jungle's ceiling, and the only archetype spending detail-1
 *  canopy shells. */
function buildTreeGiant(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 5; i++) rootFlare(p, 'bark', 0.66, 2.6, (i * TAU) / 5 + r.range(-0.25, 0.25), 0.52);
  let t: Pt = { x: 0, y: 0, z: 0 };
  t = limb(p, 'bark', 0.5, 0.8, 3.3, 9, 0.03, r.range(0, TAU), t);
  t = limb(p, 'bark', 0.38, 0.5, 3.1, 9, 0.05, r.range(0, TAU), t);
  const crown = limb(p, 'bark', 0.26, 0.38, 3.0, 8, 0.04, r.range(0, TAU), t);
  const tips: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const from: Pt = { x: crown.x * 0.6, y: 6.4 + i * 0.75, z: crown.z * 0.6 };
    tips.push(limb(p, 'bark', 0.14, 0.24, r.range(2.2, 3.0), 6, r.range(0.72, 1.05), (i * TAU) / 4 + r.range(-0.3, 0.3), from));
  }
  for (let i = 0; i < 6; i++) {
    const from = tips[i % 4] ?? crown;
    limb(p, 'bark', 0.08, 0.14, r.range(1.2, 1.9), 5, r.range(0.5, 0.95), r.range(0, TAU), from);
  }
  for (let i = 0; i < 6; i++) {
    const az = (i * TAU) / 6 + r.range(-0.4, 0.4);
    const rad = i === 0 ? 0 : r.range(1.1, 2.2);
    shell(p, 'canopy', r.range(1.9, 2.6), 1, { x: Math.sin(az) * rad, y: r.range(9.0, 11.0), z: Math.cos(az) * rad }, r);
  }
  return p;
}

/** BROADLEAF, ~8 m. 23 parts (4 roots + 2 trunk + 5 + 6 branches + 6 shells).
 *  The default jungle tree: wide low dome. */
function buildTreeBroad(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 4; i++) rootFlare(p, 'bark', 0.5, 1.8, (i * TAU) / 4 + r.range(-0.3, 0.3), 0.4);
  let t: Pt = { x: 0, y: 0, z: 0 };
  t = limb(p, 'bark', 0.4, 0.58, 2.6, 8, 0.05, r.range(0, TAU), t);
  const crown = limb(p, 'bark', 0.26, 0.4, 2.4, 8, 0.07, r.range(0, TAU), t);
  const tips: Pt[] = [];
  for (let i = 0; i < 5; i++) {
    const from: Pt = { x: crown.x * 0.5, y: 3.4 + i * 0.42, z: crown.z * 0.5 };
    tips.push(limb(p, 'bark', 0.11, 0.2, r.range(1.7, 2.5), 6, r.range(0.85, 1.2), (i * TAU) / 5 + r.range(-0.25, 0.25), from));
  }
  for (let i = 0; i < 6; i++) {
    const from = tips[i % 5] ?? crown;
    limb(p, 'bark', 0.07, 0.12, r.range(0.9, 1.5), 5, r.range(0.6, 1.0), r.range(0, TAU), from);
  }
  for (let i = 0; i < 6; i++) {
    const az = (i * TAU) / 6 + r.range(-0.35, 0.35);
    const rad = i === 0 ? 0 : r.range(1.2, 2.1);
    shell(p, 'canopy', r.range(1.6, 2.3), 0, { x: Math.sin(az) * rad, y: r.range(6.0, 7.6), z: Math.cos(az) * rad }, r);
  }
  return p;
}

/** SLENDER, ~9 m. 21 parts (4 roots + 3 trunk + 6 crown branches + 2 shed lower
 *  stubs + 6 shells). Tall thin understorey form with a small high canopy — its
 *  job is vertical rhythm inside a mass of broadleaves. */
function buildTreeSlender(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 4; i++) rootFlare(p, 'bark', 0.3, 1.1, (i * TAU) / 4 + r.range(-0.3, 0.3), 0.24);
  const lean = r.range(0.05, 0.14);
  const leanAz = r.range(0, TAU);
  let t: Pt = { x: 0, y: 0, z: 0 };
  t = limb(p, 'bark', 0.24, 0.34, 3.2, 7, lean, leanAz, t);
  t = limb(p, 'bark', 0.18, 0.24, 3.0, 7, lean, leanAz, t);
  const crown = limb(p, 'bark', 0.13, 0.18, 2.4, 6, lean, leanAz, t);
  for (let i = 0; i < 6; i++) {
    limb(p, 'bark', 0.05, 0.09, r.range(1.0, 1.7), 5, r.range(0.9, 1.25), (i * TAU) / 6 + r.range(-0.3, 0.3), crown);
  }
  // Shed lower branches: the stubs a palm-form leaves down the trunk, and the
  // detail that stops the middle of this silhouette being a bare pole.
  for (let i = 0; i < 2; i++) {
    limb(p, 'bark', 0.03, 0.06, r.range(0.3, 0.55), 4, r.range(1.0, 1.4), r.range(0, TAU), { x: 0, y: 3.0 + i * 1.6, z: 0 });
  }
  for (let i = 0; i < 6; i++) {
    const az = (i * TAU) / 6 + r.range(-0.4, 0.4);
    const rad = i === 0 ? 0 : r.range(0.7, 1.4);
    shell(p, 'canopy', r.range(1.1, 1.6), 0, { x: crown.x + Math.sin(az) * rad, y: crown.y + r.range(-0.2, 0.8), z: crown.z + Math.cos(az) * rad }, r);
  }
  return p;
}

/** FORKED, ~7.5 m. 21 parts (4 roots + 1 base + 2 x 5 fork + 6 shells). Splits
 *  into two trunks at 1.7 m — the archetype that most changes a tree line's
 *  silhouette from the fixed camera. */
function buildTreeForked(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 4; i++) rootFlare(p, 'bark', 0.48, 1.6, (i * TAU) / 4 + r.range(-0.3, 0.3), 0.38);
  const split = limb(p, 'bark', 0.42, 0.6, 1.7, 8, 0.02, 0, { x: 0, y: 0, z: 0 });
  const forkAz = r.range(0, TAU);
  const crowns: Pt[] = [];
  for (let f = 0; f < 2; f++) {
    const az = forkAz + f * Math.PI;
    let t = limb(p, 'bark', 0.26, 0.36, 2.5, 7, r.range(0.2, 0.34), az, split);
    t = limb(p, 'bark', 0.17, 0.26, 2.2, 6, r.range(0.1, 0.2), az, t);
    crowns.push(t);
    for (let i = 0; i < 3; i++) {
      limb(p, 'bark', 0.07, 0.13, r.range(1.1, 1.8), 5, r.range(0.7, 1.1), az + r.range(-1.1, 1.1), t);
    }
  }
  for (let i = 0; i < 6; i++) {
    const base = crowns[i % 2] ?? split;
    const az = r.range(0, TAU);
    const rad = r.range(0.3, 1.4);
    shell(p, 'canopy', r.range(1.3, 1.9), 0, { x: base.x + Math.sin(az) * rad, y: base.y + r.range(-0.3, 0.9), z: base.z + Math.cos(az) * rad }, r);
  }
  return p;
}

/** CONIFER spire, ~9 m. 20 parts (4 roots + 3 trunk + 5 bare lower branches +
 *  8 tiers). The only tree whose canopy silhouette is a triangle, which is what
 *  makes it read at distance and on the bare high ground. */
function buildTreeConifer(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 4; i++) rootFlare(p, 'bark', 0.34, 1.2, (i * TAU) / 4 + r.range(-0.3, 0.3), 0.26);
  let t: Pt = { x: 0, y: 0, z: 0 };
  t = limb(p, 'bark', 0.28, 0.42, 3.0, 7, 0.03, r.range(0, TAU), t);
  t = limb(p, 'bark', 0.16, 0.28, 3.0, 6, 0.03, r.range(0, TAU), t);
  limb(p, 'bark', 0.05, 0.16, 2.4, 5, 0.02, r.range(0, TAU), t);
  for (let i = 0; i < 5; i++) {
    limb(p, 'bark', 0.05, 0.09, r.range(0.8, 1.3), 5, r.range(1.0, 1.3), (i * TAU) / 5 + r.range(-0.3, 0.3), { x: 0, y: 1.7 + i * 0.62, z: 0 });
  }
  for (let i = 0; i < 8; i++) {
    const h = 2.2 + i * 0.86;
    const rad = 2.15 * (1 - i / 9) + 0.28;
    p.push({
      surface: 'canopy',
      geo: cone(rad, 1.9, 7, {
        sx: r.range(0.9, 1.1),
        sz: r.range(0.9, 1.1),
        rx: r.range(-0.05, 0.05),
        ry: r.range(0, TAU),
        y: h,
      }),
    });
  }
  return p;
}

/** DEAD tree, ~6.5 m. 19 parts (4 roots + 3 trunk + 5 + 3 snapped branches +
 *  4 crown stubs), bark only. Bare, broken-topped, snapped
 *  branches — STYLE_BIBLE §8 puts these on the scoured high ground, where a
 *  leafless vertical against open sky is the plateau's whole silhouette. */
function buildTreeDead(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 4; i++) rootFlare(p, 'bark', 0.42, 1.4, (i * TAU) / 4 + r.range(-0.3, 0.3), 0.34);
  let t: Pt = { x: 0, y: 0, z: 0 };
  t = limb(p, 'bark', 0.32, 0.48, 2.4, 7, 0.06, r.range(0, TAU), t);
  t = limb(p, 'bark', 0.2, 0.32, 2.3, 6, 0.09, r.range(0, TAU), t);
  const top = limb(p, 'bark', 0.11, 0.2, 1.5, 6, 0.12, r.range(0, TAU), t);
  for (let i = 0; i < 5; i++) {
    const from: Pt = { x: 0, y: 2.6 + i * 0.66, z: 0 };
    const tip = limb(p, 'bark', 0.05, 0.13, r.range(1.1, 2.0), 5, r.range(0.55, 1.15), (i * TAU) / 5 + r.range(-0.4, 0.4), from);
    if (i < 3) limb(p, 'bark', 0.03, 0.06, r.range(0.5, 0.9), 4, r.range(0.4, 1.0), r.range(0, TAU), tip);
  }
  for (let i = 0; i < 4; i++) {
    limb(p, 'bark', 0.03, 0.07, r.range(0.3, 0.6), 4, r.range(0.7, 1.3), r.range(0, TAU), top);
  }
  return p;
}

/** MOSSY squat, ~6 m. 20 parts (5 roots + 2 gnarled trunk + 5 primary + 3
 *  secondary branches + 5 shells). Leaning, with a low heavy canopy — the tree
 *  that makes a jungle pocket feel closed over the player's head. */
function buildTreeMossy(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 5; i++) rootFlare(p, 'bark', 0.56, 1.7, (i * TAU) / 5 + r.range(-0.3, 0.3), 0.46);
  const leanAz = r.range(0, TAU);
  let t: Pt = { x: 0, y: 0, z: 0 };
  t = limb(p, 'bark', 0.46, 0.66, 2.2, 8, r.range(0.1, 0.2), leanAz, t);
  const crown = limb(p, 'bark', 0.32, 0.46, 1.9, 8, r.range(0.12, 0.26), leanAz + Math.PI * 0.6, t);
  const tips: Pt[] = [];
  for (let i = 0; i < 5; i++) {
    tips.push(limb(p, 'bark', 0.1, 0.2, r.range(1.4, 2.2), 6, r.range(0.95, 1.3), (i * TAU) / 5 + r.range(-0.3, 0.3), crown));
  }
  for (let i = 0; i < 3; i++) {
    limb(p, 'bark', 0.05, 0.09, r.range(0.7, 1.2), 5, r.range(0.6, 1.1), r.range(0, TAU), tips[i] ?? crown);
  }
  for (let i = 0; i < 5; i++) {
    const base = tips[i] ?? crown;
    shell(p, 'canopy', r.range(1.5, 2.1), 0, { x: base.x * 0.75, y: base.y + r.range(0.1, 0.7), z: base.z * 0.75 }, r);
  }
  return p;
}

/** FERN cluster. 8 parts. Seven fronds off a low crown. */
function buildFernCluster(r: Rng): Part[] {
  const p: Part[] = [];
  p.push({ surface: 'fern', geo: ico(0.22, 0, { sy: 0.5, y: 0.1 }) });
  for (let i = 0; i < 7; i++) {
    frond(p, 'fern', 0.13, r.range(0.85, 1.35), r.range(0.75, 1.15), (i * TAU) / 7 + r.range(-0.3, 0.3), { x: 0, y: 0.14, z: 0 });
  }
  return p;
}

/** BUSH. 7 parts. Four leaf blobs on three short stems. */
function buildBush(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 3; i++) {
    limb(p, 'bark', 0.035, 0.06, r.range(0.3, 0.55), 4, r.range(0.15, 0.5), (i * TAU) / 3, { x: 0, y: 0, z: 0 });
  }
  for (let i = 0; i < 4; i++) {
    const az = (i * TAU) / 4 + r.range(-0.4, 0.4);
    const rad = i === 0 ? 0 : r.range(0.18, 0.42);
    shell(p, 'fern', r.range(0.34, 0.52), 0, { x: Math.sin(az) * rad, y: r.range(0.42, 0.68), z: Math.cos(az) * rad }, r);
  }
  return p;
}

/** SAPLING. 7 parts. A young tree — the mid layer between fern and canopy that
 *  stops the jungle reading as two flat strata. */
function buildSapling(r: Rng): Part[] {
  const p: Part[] = [];
  let t = limb(p, 'bark', 0.06, 0.1, 1.5, 5, r.range(0.03, 0.12), r.range(0, TAU), { x: 0, y: 0, z: 0 });
  t = limb(p, 'bark', 0.04, 0.06, 0.9, 5, r.range(0.05, 0.18), r.range(0, TAU), t);
  for (let i = 0; i < 2; i++) {
    limb(p, 'bark', 0.025, 0.04, r.range(0.4, 0.7), 4, r.range(0.7, 1.1), r.range(0, TAU), t);
  }
  for (let i = 0; i < 3; i++) {
    const az = (i * TAU) / 3;
    shell(p, 'canopy', r.range(0.5, 0.75), 0, { x: t.x + Math.sin(az) * 0.28, y: t.y + r.range(0.0, 0.35), z: t.z + Math.cos(az) * 0.28 }, r);
  }
  return p;
}

/** GRASS tuft. 6 parts. Lane-shoulder dressing; blades never below 5 cm. */
function buildGrassTuft(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 6; i++) {
    const az = (i * TAU) / 6 + r.range(-0.4, 0.4);
    const tilt = r.range(0.2, 0.6);
    const h = r.range(0.3, 0.55);
    const d = limbDir(tilt, az);
    p.push({
      surface: 'fern',
      geo: box(0.075, h, 0.045, { rx: tilt, ry: az, x: d.x * h * 0.5, y: d.y * h * 0.5, z: d.z * h * 0.5 }),
    });
  }
  return p;
}

/** BOULDER. 3 lumps. Half-buried, so it sits IN the ground, not on it. */
function buildBoulder(r: Rng): Part[] {
  const p: Part[] = [];
  stoneMass(p, 'cliffRock', 0.72, 3, { x: 0, y: 0.4, z: 0 }, r, 1);
  return p;
}

/** ROCK cluster. 5 lumps at three sizes. */
function buildRockCluster(r: Rng): Part[] {
  const p: Part[] = [];
  stoneMass(p, 'cliffRock', 0.44, 3, { x: 0, y: 0.24, z: 0 }, r, 1);
  stoneMass(p, 'cliffRock', 0.26, 2, { x: r.range(0.4, 0.7), y: 0.14, z: r.range(-0.6, 0.6) }, r, 0);
  return p;
}

/** OUTCROP. 6 parts. Angular tilted slabs — the scoured high-ground read, and
 *  deliberately a different geometric family from the rounded jungle boulder. */
function buildOutcrop(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 4; i++) {
    const az = (i * TAU) / 4 + r.range(-0.5, 0.5);
    p.push({
      surface: 'cliffRock',
      geo: box(r.range(0.7, 1.25), r.range(0.32, 0.7), r.range(0.5, 0.95), {
        rx: r.range(-0.28, 0.28),
        rz: r.range(-0.28, 0.28),
        ry: az,
        x: Math.sin(az) * r.range(0.1, 0.45),
        y: 0.18 + i * 0.24,
        z: Math.cos(az) * r.range(0.1, 0.45),
      }),
    });
  }
  stoneMass(p, 'cliffRock', 0.3, 2, { x: r.range(-0.8, 0.8), y: 0.16, z: r.range(-0.8, 0.8) }, r, 0);
  return p;
}

/** FALLEN LOG. 10 parts. Three trunk sections lying along one axis, two torn
 *  ends, three snapped branch stubs, two moss patches on the upper face. */
function buildFallenLog(r: Rng): Part[] {
  const p: Part[] = [];
  const len = 1.5;
  for (let i = 0; i < 3; i++) {
    p.push({
      surface: 'bark',
      geo: cyl(0.3 - i * 0.04, 0.34 - i * 0.04, len, 8, { rz: Math.PI / 2, rx: r.range(-0.05, 0.05), x: (i - 1) * len, y: 0.3, z: r.range(-0.09, 0.09) }),
    });
  }
  p.push({ surface: 'bark', geo: ico(0.34, 0, { sx: 0.5, x: -len * 1.6, y: 0.3, z: 0 }) });
  p.push({ surface: 'bark', geo: ico(0.26, 0, { sx: 0.5, x: len * 1.6, y: 0.28, z: 0 }) });
  for (let i = 0; i < 3; i++) {
    limb(p, 'bark', 0.04, 0.08, r.range(0.4, 0.75), 4, r.range(0.9, 1.4), r.range(0, TAU), { x: r.range(-1.4, 1.4), y: 0.42, z: 0 });
  }
  for (let i = 0; i < 2; i++) {
    shell(p, 'fern', r.range(0.24, 0.36), 0, { x: r.range(-1.2, 1.2), y: 0.52, z: r.range(-0.12, 0.12) }, r);
  }
  return p;
}

/** STUMP. 6 parts. Sheared trunk with four surface roots and a splintered top. */
function buildStump(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 4; i++) rootFlare(p, 'bark', 0.36, 1.0, (i * TAU) / 4 + r.range(-0.3, 0.3), 0.3);
  p.push({ surface: 'bark', geo: cyl(0.38, 0.46, 0.85, 8, { y: 0.42 }) });
  p.push({ surface: 'bark', geo: cone(0.36, 0.4, 6, { rx: r.range(-0.24, 0.24), rz: r.range(-0.24, 0.24), y: 0.95 }) });
  return p;
}

/** RUIN block. 5 parts. A toppled carved lintel and its broken-off fragments —
 *  the "this valley had builders" cue STYLE_BIBLE §1 rests the mood on. */
function buildRuinBlock(r: Rng): Part[] {
  const p: Part[] = [];
  p.push({ surface: 'monumentStone', geo: box(1.5, 0.62, 0.72, { rx: r.range(-0.14, 0.14), rz: r.range(-0.2, 0.2), y: 0.3 }) });
  p.push({ surface: 'monumentStone', geo: box(0.9, 0.42, 0.6, { ry: r.range(0.3, 1.2), rz: r.range(-0.3, 0.3), x: r.range(0.7, 1.2), y: 0.2, z: r.range(-0.4, 0.4) }) });
  p.push({ surface: 'monumentStone', geo: box(0.5, 0.3, 0.44, { ry: r.range(0, TAU), rx: r.range(-0.4, 0.4), x: r.range(-1.1, -0.6), y: 0.15, z: r.range(-0.5, 0.5) }) });
  stoneMass(p, 'monumentStone', 0.2, 2, { x: r.range(-0.6, 0.6), y: 0.1, z: r.range(0.5, 0.9) }, r, 0);
  return p;
}

/** RUIN column. 6 parts. Stacked drums, one displaced, on a plinth. */
function buildRuinColumn(r: Rng): Part[] {
  const p: Part[] = [];
  p.push({ surface: 'monumentStone', geo: box(1.05, 0.28, 1.05, { ry: r.range(0, TAU), y: 0.14 }) });
  let y = 0.28;
  for (let i = 0; i < 3; i++) {
    const h = r.range(0.5, 0.8);
    p.push({
      surface: 'monumentStone',
      geo: cyl(0.34 - i * 0.02, 0.37 - i * 0.02, h, 10, { rx: r.range(-0.05, 0.05), x: r.range(-0.05, 0.05), y: y + h * 0.5, z: r.range(-0.05, 0.05) }),
    });
    y += h;
  }
  p.push({
    surface: 'monumentStone',
    geo: lathe([{ r: 0.3, y: 0 }, { r: 0.44, y: 0.16 }, { r: 0.4, y: 0.3 }], 10, {
      rx: r.range(0.5, 1.3),
      ry: r.range(0, TAU),
      x: r.range(0.55, 1.1),
      y: 0.2,
      z: r.range(-0.7, 0.7),
    }),
  });
  p.push({ surface: 'monumentStone', geo: box(0.42, 0.24, 0.4, { ry: r.range(0, TAU), rz: r.range(-0.5, 0.5), x: r.range(-1.0, -0.5), y: 0.12, z: r.range(-0.6, 0.6) }) });
  return p;
}

/** REEDS. 9 parts. Tall thin river-margin blades. */
function buildReeds(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 9; i++) {
    const az = (i * TAU) / 9 + r.range(-0.3, 0.3);
    const rad = r.range(0, 0.28);
    frond(p, 'fern', 0.055, r.range(0.9, 1.5), r.range(0.08, 0.34), az, { x: Math.sin(az) * rad, y: 0, z: Math.cos(az) * rad });
  }
  return p;
}

/** BANK stone. 3 parts. River-washed and rounded — the `wetRock` family at
 *  roughness 0.35 is what makes these read as WET beside the dry cliff rock. */
function buildBankStone(r: Rng): Part[] {
  const p: Part[] = [];
  p.push({ surface: 'wetRock', geo: sphere(0.42, 8, { sy: r.range(0.44, 0.66), sx: r.range(0.85, 1.2), rx: r.range(-0.2, 0.2), y: 0.16 }) });
  p.push({ surface: 'wetRock', geo: sphere(0.24, 7, { sy: 0.6, ry: r.range(0, TAU), x: r.range(0.3, 0.55), y: 0.1, z: r.range(-0.45, 0.45) }) });
  p.push({ surface: 'wetRock', geo: sphere(0.17, 6, { sy: 0.6, x: r.range(-0.5, -0.25), y: 0.07, z: r.range(-0.4, 0.4) }) });
  return p;
}

/** DRIFTWOOD. 4 parts. A bleached branch stranded on the silt. */
function buildDriftwood(r: Rng): Part[] {
  const p: Part[] = [];
  const az = r.range(0, TAU);
  p.push({ surface: 'bark', geo: cyl(0.1, 0.14, 1.7, 6, { rz: Math.PI / 2 - r.range(0.05, 0.2), ry: az, y: 0.14 }) });
  p.push({ surface: 'bark', geo: cyl(0.06, 0.09, 0.9, 5, { rz: Math.PI / 2 - r.range(0.1, 0.35), ry: az + r.range(0.5, 1.1), x: r.range(0.3, 0.7), y: 0.1, z: r.range(-0.4, 0.4) }) });
  p.push({ surface: 'bark', geo: cyl(0.04, 0.06, 0.55, 5, { rz: Math.PI / 2 - r.range(0.2, 0.6), ry: az + r.range(-1.4, -0.6), x: r.range(-0.7, -0.3), y: 0.08, z: r.range(-0.3, 0.3) }) });
  p.push({ surface: 'bark', geo: ico(0.15, 0, { sx: 0.6, ry: az, x: r.range(-1.0, -0.7), y: 0.13, z: 0 }) });
  return p;
}

// ============================================================================
// Archetype table
// ============================================================================

interface ArchDef {
  readonly key: string;
  readonly build: (r: Rng) => Part[];
  /** Surfaces whose bucket gets a wind sway node. Trunks never sway; canopy and
   *  frond masses do, and moving them against a fixed trunk is what reads as
   *  wind rather than as the whole prop sliding. */
  readonly sway: readonly SurfaceId[];
  readonly swayAmp: number;
  readonly castShadow: boolean;
  /** Whether this archetype's buckets get baked vertex AO. See AO_STRENGTH. */
  readonly ao: boolean;
}

const ARCHETYPES: readonly ArchDef[] = [
  { key: 'treeGiant', build: buildTreeGiant, sway: ['canopy'], swayAmp: SWAY_CANOPY_AMP, castShadow: true, ao: true },
  { key: 'treeBroad', build: buildTreeBroad, sway: ['canopy'], swayAmp: SWAY_CANOPY_AMP, castShadow: true, ao: true },
  { key: 'treeSlender', build: buildTreeSlender, sway: ['canopy'], swayAmp: SWAY_CANOPY_AMP, castShadow: true, ao: true },
  { key: 'treeForked', build: buildTreeForked, sway: ['canopy'], swayAmp: SWAY_CANOPY_AMP, castShadow: true, ao: true },
  { key: 'treeConifer', build: buildTreeConifer, sway: ['canopy'], swayAmp: SWAY_CANOPY_AMP * 0.6, castShadow: true, ao: true },
  { key: 'treeDead', build: buildTreeDead, sway: [], swayAmp: 0, castShadow: true, ao: true },
  { key: 'treeMossy', build: buildTreeMossy, sway: ['canopy'], swayAmp: SWAY_CANOPY_AMP, castShadow: true, ao: true },
  { key: 'fernCluster', build: buildFernCluster, sway: ['fern'], swayAmp: SWAY_FROND_AMP, castShadow: false, ao: false },
  { key: 'bush', build: buildBush, sway: ['fern'], swayAmp: SWAY_FROND_AMP, castShadow: false, ao: false },
  { key: 'sapling', build: buildSapling, sway: ['canopy'], swayAmp: SWAY_FROND_AMP, castShadow: false, ao: false },
  { key: 'grassTuft', build: buildGrassTuft, sway: ['fern'], swayAmp: SWAY_FROND_AMP, castShadow: false, ao: false },
  { key: 'boulder', build: buildBoulder, sway: [], swayAmp: 0, castShadow: true, ao: true },
  { key: 'rockCluster', build: buildRockCluster, sway: [], swayAmp: 0, castShadow: true, ao: true },
  { key: 'outcrop', build: buildOutcrop, sway: [], swayAmp: 0, castShadow: true, ao: true },
  { key: 'fallenLog', build: buildFallenLog, sway: [], swayAmp: 0, castShadow: true, ao: true },
  { key: 'stump', build: buildStump, sway: [], swayAmp: 0, castShadow: true, ao: true },
  { key: 'ruinBlock', build: buildRuinBlock, sway: [], swayAmp: 0, castShadow: true, ao: true },
  { key: 'ruinColumn', build: buildRuinColumn, sway: [], swayAmp: 0, castShadow: true, ao: true },
  { key: 'reeds', build: buildReeds, sway: ['fern'], swayAmp: SWAY_FROND_AMP * 1.4, castShadow: false, ao: false },
  { key: 'bankStone', build: buildBankStone, sway: [], swayAmp: 0, castShadow: true, ao: true },
  { key: 'driftwood', build: buildDriftwood, sway: [], swayAmp: 0, castShadow: true, ao: false },
];

const A_GIANT = 0;
const A_BROAD = 1;
const A_SLENDER = 2;
const A_FORKED = 3;
const A_CONIFER = 4;
const A_DEAD = 5;
const A_MOSSY = 6;
const A_FERN = 7;
const A_BUSH = 8;
const A_SAPLING = 9;
const A_GRASS = 10;
const A_BOULDER = 11;
const A_ROCKS = 12;
const A_OUTCROP = 13;
const A_LOG = 14;
const A_STUMP = 15;
const A_RUINBLOCK = 16;
const A_RUINCOLUMN = 17;
const A_REEDS = 18;
const A_BANKSTONE = 19;
const A_DRIFTWOOD = 20;

// ============================================================================
// Families — one scatter recipe each. Densities are STYLE_BIBLE §8, per 100 m²
// of the ZONE (not of the map), which is exactly the unit `ScatterOpts.density`
// speaks; the per-tile zone-area correction below is what converts between them.
// ============================================================================

interface Family {
  readonly key: string;
  /** Bitmask of the zones this family may plant in. */
  readonly zones: number;
  /** Archetype ids; `scatter`'s `variant` indexes this array uniformly, so a
   *  repeated id is how a family WEIGHTS its mix. The giant emergent appears
   *  once in eight because an emergent that is one tree in six is not an
   *  emergent — and because it is the most expensive archetype in the file. */
  readonly archs: readonly number[];
  /** Instances per 100 m² of accepted zone area. */
  readonly density: number;
  /** Poisson-disc minimum centre distance, metres. */
  readonly spacing: number;
  /** Minimum distance from any lane / ramp / base cell, metres. This is the
   *  lane-corridor guarantee: there is no collision on vegetation, so anything
   *  overhanging walkable lane width reads as blocking when it is not. */
  readonly clearLane: number;
  /** Minimum distance from any cliff cell — props hanging over a plateau lip
   *  float, because the cliff face drops away under them. */
  readonly clearCliff: number;
  /** Minimum distance from the river channel. */
  readonly clearRiver: number;
  readonly ladder: readonly string[];
  /** Global ceiling on this family, for the triangle budget. */
  readonly max: number;
}

const FAMILIES: readonly Family[] = [
  // Jungle — foliage cells. Top of the §8 range (8-14 trees, 20-35 undergrowth):
  // the sim treats these cells as concealing, and a player must be able to guess
  // where they are hidden from the density alone.
  { key: 'treeDense', zones: M_DENSE, archs: [A_GIANT, A_BROAD, A_BROAD, A_SLENDER, A_FORKED, A_CONIFER, A_MOSSY, A_MOSSY], density: 14, spacing: 3.0, clearLane: 2.6, clearCliff: 1.4, clearRiver: 1.6, ladder: LADDER_CANOPY, max: 300 },
  { key: 'underDense', zones: M_DENSE, archs: [A_FERN, A_BUSH, A_SAPLING], density: 28, spacing: 1.6, clearLane: 1.4, clearCliff: 0.7, clearRiver: 1.0, ladder: LADDER_FERN, max: 480 },
  // Jungle proper — open low ground away from the lanes. Mid range.
  { key: 'treeOpen', zones: M_OPEN, archs: [A_BROAD, A_BROAD, A_SLENDER, A_SLENDER, A_FORKED, A_CONIFER, A_MOSSY], density: 9, spacing: 3.4, clearLane: 2.6, clearCliff: 1.4, clearRiver: 1.6, ladder: LADDER_CANOPY, max: 280 },
  { key: 'underOpen', zones: M_OPEN, archs: [A_FERN, A_BUSH, A_SAPLING], density: 20, spacing: 1.85, clearLane: 1.4, clearCliff: 0.7, clearRiver: 1.0, ladder: LADDER_FERN, max: 400 },
  { key: 'rockJungle', zones: M_DENSE | M_OPEN, archs: [A_BOULDER, A_ROCKS, A_OUTCROP], density: 7.5, spacing: 2.8, clearLane: 2.0, clearCliff: 0.8, clearRiver: 1.2, ladder: LADDER_CLIFF, max: 260 },
  { key: 'deadwood', zones: M_DENSE | M_OPEN, archs: [A_LOG, A_STUMP], density: 3.5, spacing: 4.4, clearLane: 2.2, clearCliff: 1.0, clearRiver: 1.4, ladder: LADDER_BARK, max: 120 },
  { key: 'ruins', zones: M_DENSE | M_OPEN | M_SHOULDER, archs: [A_RUINBLOCK, A_RUINCOLUMN], density: 1.4, spacing: 5.5, clearLane: 2.2, clearCliff: 1.0, clearRiver: 1.4, ladder: LADDER_MONUMENT, max: 100 },
  // Lane shoulders — sparse, so the lanes stay clean and the fights readable.
  { key: 'tufts', zones: M_SHOULDER, archs: [A_GRASS, A_FERN], density: 5.5, spacing: 2.1, clearLane: 0.9, clearCliff: 0.7, clearRiver: 1.0, ladder: LADDER_FERN, max: 340 },
  { key: 'rockShoulder', zones: M_SHOULDER, archs: [A_BOULDER, A_ROCKS], density: 3, spacing: 3.2, clearLane: 1.6, clearCliff: 0.8, clearRiver: 1.2, ladder: LADDER_CLIFF, max: 180 },
  // High ground — bare and wind-scoured. The contrast with the dense low jungle
  // is what makes elevation READ from a fixed 55 deg camera.
  { key: 'rockHigh', zones: M_HIGH, archs: [A_OUTCROP, A_BOULDER, A_ROCKS], density: 3, spacing: 3.0, clearLane: 2.0, clearCliff: 0.9, clearRiver: 1.2, ladder: LADDER_CLIFF, max: 160 },
  { key: 'treeHigh', zones: M_HIGH, archs: [A_DEAD, A_CONIFER], density: 0.9, spacing: 5.0, clearLane: 2.6, clearCliff: 1.8, clearRiver: 1.6, ladder: LADDER_BARK, max: 48 },
  // River banks — reeds, wet stones, driftwood.
  { key: 'reeds', zones: M_BANK, archs: [A_REEDS], density: 14, spacing: 1.35, clearLane: 1.2, clearCliff: 0.7, clearRiver: 0.55, ladder: LADDER_FERN, max: 300 },
  { key: 'bankStones', zones: M_BANK, archs: [A_BANKSTONE], density: 9, spacing: 1.8, clearLane: 1.2, clearCliff: 0.7, clearRiver: 0.55, ladder: LADDER_WET, max: 220 },
  { key: 'driftwood', zones: M_BANK, archs: [A_DRIFTWOOD], density: 1.6, spacing: 5.0, clearLane: 1.6, clearCliff: 0.9, clearRiver: 0.6, ladder: LADDER_BARK, max: 48 },
];

// ============================================================================
// Placement bookkeeping
// ============================================================================

/** One placed prop. `mod` is a SHARED THREE.Color — three per family — so 2 400
 *  of these hold three colour objects between them, not 2 400. */
interface Place {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly rotY: number;
  readonly leanX: number;
  readonly leanZ: number;
  readonly mod: THREE.Color;
}

/** One archetype's bake in flight, then its finished buckets. */
interface ArchState {
  job: ChunkedBake | null;
  done: boolean;
  buckets: { geo: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }[];
}

interface Sway {
  readonly node: THREE.Object3D;
  readonly amp: number;
  readonly phase: number;
}

// ============================================================================
// Colour modulation
// ============================================================================

/**
 * The three per-instance colour multipliers of one tint ladder.
 *
 * The InstancedMesh colour attribute MULTIPLIES the material's albedo, so the
 * value written is the ratio of the ladder step to the ladder's base — not the
 * step's colour. Raw, that ratio is the palette's full +/-8 L* step applied on
 * top of an already-correct albedo, which reads as a different species rather
 * than a different individual; `TINT_GAIN` compresses it toward 1 and the clamp
 * bounds it, which is the "keep variation multiplicative and small" rule.
 */
function ladderMods(ladder: readonly string[]): THREE.Color[] {
  const baseHex = ladder[0] ?? APAL.moss;
  const base = new THREE.Color(baseHex);
  const out: THREE.Color[] = [];
  for (const hex of ladder) {
    const step = new THREE.Color(hex);
    out.push(
      new THREE.Color(
        clampMod(1 + (safeRatio(step.r, base.r) - 1) * TINT_GAIN),
        clampMod(1 + (safeRatio(step.g, base.g) - 1) * TINT_GAIN),
        clampMod(1 + (safeRatio(step.b, base.b) - 1) * TINT_GAIN),
      ),
    );
  }
  return out;
}

function safeRatio(a: number, b: number): number {
  return b > 1e-4 ? a / b : 1;
}

function clampMod(v: number): number {
  return v < TINT_MIN ? TINT_MIN : v > TINT_MAX ? TINT_MAX : v;
}

// ============================================================================
// Terrain fields
// ============================================================================

/**
 * Chamfer distance transform: metres from every cell to the nearest cell whose
 * kind code satisfies `isSource`. Two sweeps, 1 / sqrt(2) weights, so the error
 * against true Euclidean distance is under 4% — far inside the tolerance of a
 * clearance test measured in whole metres.
 *
 * O(dim²) with two passes. At the frozen res = 1 a 3-lane map is 128 x 128, so
 * each field is ~16 k cells and costs well under a millisecond.
 */
function distanceField(t: TerrainDef, isSource: (code: number) => boolean): Float32Array {
  const g = t.grid;
  const dim = g.dim;
  const n = dim * dim;
  const FAR = 1e6;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = isSource(g.kind[i] ?? 0) ? 0 : FAR;
  const DIAG = Math.SQRT2;
  for (let z = 0; z < dim; z++) {
    for (let x = 0; x < dim; x++) {
      const i = z * dim + x;
      let v = d[i] ?? FAR;
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, (d[i - 1] ?? FAR) + 1);
      if (z > 0) v = Math.min(v, (d[i - dim] ?? FAR) + 1);
      if (x > 0 && z > 0) v = Math.min(v, (d[i - dim - 1] ?? FAR) + DIAG);
      if (x < dim - 1 && z > 0) v = Math.min(v, (d[i - dim + 1] ?? FAR) + DIAG);
      d[i] = v;
    }
  }
  for (let z = dim - 1; z >= 0; z--) {
    for (let x = dim - 1; x >= 0; x--) {
      const i = z * dim + x;
      let v = d[i] ?? FAR;
      if (v === 0) continue;
      if (x < dim - 1) v = Math.min(v, (d[i + 1] ?? FAR) + 1);
      if (z < dim - 1) v = Math.min(v, (d[i + dim] ?? FAR) + 1);
      if (x < dim - 1 && z < dim - 1) v = Math.min(v, (d[i + dim + 1] ?? FAR) + DIAG);
      if (x > 0 && z < dim - 1) v = Math.min(v, (d[i + dim - 1] ?? FAR) + DIAG);
      d[i] = v;
    }
  }
  // Cells are 1/res metres across, so the chamfer's cell counts become metres
  // here and nowhere else.
  if (g.res !== 1) for (let i = 0; i < n; i++) d[i] = (d[i] ?? 0) / g.res;
  return d;
}

// ============================================================================
// createVegetation
// ============================================================================

/**
 * Plant the jungle. Constructed by wire.ts after `SceneHandle.setTerrain`, so
 * `heightAt` is real for every placement sampled here.
 */
export function createVegetation(scene: SceneHandle, map: MapDef): VegetationHandle {
  const core = sceneCore(scene);
  const terrain = map.terrain;
  const grid = terrain.grid;
  const dim = grid.dim;
  const res = grid.res;
  const side = grid.side;

  const root = new THREE.Group();
  root.name = 'rift:vegetation';
  core.three.add(root);

  // ---- shared build state ---------------------------------------------------
  const zone = new Uint8Array(dim * dim);
  // Explicitly annotated: `new Float32Array(0)` narrows its buffer type, and the
  // fields are reassigned from `distanceField`, whose buffer type is the wider
  // ArrayBufferLike.
  let dLane: Float32Array = new Float32Array(0);
  let dCliff: Float32Array = new Float32Array(0);
  let dRiver: Float32Array = new Float32Array(0);

  const placements: Place[][] = ARCHETYPES.map(() => []);
  const archStates: ArchState[] = ARCHETYPES.map(() => ({ job: null, done: false, buckets: [] }));
  const sways: Sway[] = [];

  const cellIndex = (x: number, z: number): number => {
    let ix = Math.floor(x * res);
    let iz = Math.floor(z * res);
    if (!(ix > 0)) ix = 0;
    else if (ix > dim - 1) ix = dim - 1;
    if (!(iz > 0)) iz = 0;
    else if (iz > dim - 1) iz = dim - 1;
    return iz * dim + ix;
  };

  const heightAt = (x: number, z: number): number => core.heightAt(x, z);

  // ---- the construction queue ----------------------------------------------
  // Each unit returns true when it is finished and the cursor may advance.
  const units: (() => boolean)[] = [];

  units.push(() => {
    dLane = distanceField(terrain, (c) => c === K_LANE || c === K_RAMP || c === K_BASE);
    return true;
  });
  units.push(() => {
    dCliff = distanceField(terrain, (c) => c === K_CLIFF);
    return true;
  });
  units.push(() => {
    dRiver = distanceField(terrain, (c) => c === K_RIVER);
    return true;
  });

  // Zone classification, plus the per-tile zone histogram. Exactly one zone per
  // cell; everything not named here stays Z_NONE and is never planted on —
  // which is the "never on lane, river, ramp, base or cliff" rule, enforced once
  // here instead of fourteen times in fourteen family predicates.
  //
  // The histogram is what lets a (family, tile) unit answer "is any of my zone
  // in this tile?" in O(1). There are TILES x TILES x FAMILIES of those units,
  // and without the histogram every one of them scans its tile's cells even when
  // the answer is obviously no — the three river-bank families alone would scan
  // the whole map three times over to find the ~6% of it they can plant on.
  const tileZone = new Int32Array(TILES * TILES * 8);
  units.push(() => {
    const tileSizeM = side / TILES;
    for (let iz = 0; iz < dim; iz++) {
      for (let ix = 0; ix < dim; ix++) {
        const i = iz * dim + ix;
        const code = grid.kind[i] ?? K_GROUND;
        let z = Z_NONE;
        if (code === K_FOLIAGE) {
          z = Z_DENSE;
        } else if (code === K_HIGH) {
          z = Z_HIGH;
        } else if (code === K_GROUND) {
          const river = dRiver[i] ?? 1e6;
          const lane = dLane[i] ?? 1e6;
          z = river <= BANK_REACH ? Z_BANK : lane <= SHOULDER_REACH ? Z_SHOULDER : Z_OPEN;
        }
        zone[i] = z;
        if (z === Z_NONE) continue;
        const tx = Math.min(TILES - 1, Math.floor((ix + 0.5) / res / tileSizeM));
        const tz = Math.min(TILES - 1, Math.floor((iz + 0.5) / res / tileSizeM));
        const h = ((tz * TILES + tx) << 3) + z;
        tileZone[h] = (tileZone[h] ?? 0) + 1;
      }
    }
    return true;
  });

  // Archetype geometry. One unit per archetype: first call builds the parts and
  // opens a chunked bake, later calls step it, and the last call finishes the
  // buckets (white vertex colours + baked AO) before returning true.
  for (let a = 0; a < ARCHETYPES.length; a++) {
    const def = ARCHETYPES[a];
    const st = archStates[a];
    if (def === undefined || st === undefined) continue;
    units.push(() => {
      if (st.job === null) {
        st.job = bakeChunked(def.build(rng(`rift:veg:arch:${def.key}`)), BAKE_SLICE_MS);
        return false;
      }
      if (st.job.step()) return false;
      for (const part of st.job.mesh.parts) {
        // Idempotent by contract: bake() already emitted the white attribute.
        // Called anyway so this module's correctness does not rest on knowing
        // that — a geometry reaching a kit material without one renders BLACK.
        whiteVertexColors(part.geo);
        if (def.ao) bakeVertexAO(part.geo, AO_STRENGTH);
        st.buckets.push({ geo: part.geo, material: part.material });
      }
      st.done = true;
      return true;
    });
  }

  // Scatter, one unit per (family, tile).
  const tileSize = side / TILES;
  let totalPlaced = 0;
  for (const fam of FAMILIES) {
    const mods = ladderMods(fam.ladder);
    let famCount = 0;
    // Points already committed for this family, in a spacing-sized hash. It is
    // what preserves the Poisson guarantee ACROSS tile seams: `scatter`
    // guarantees spacing inside its own rect only, and two tiles meeting would
    // otherwise put two identical props shoulder to shoulder — the exact defect
    // STYLE_BIBLE §8 says a reviewer files.
    const committed = new Map<number, number[]>();
    const hashOf = (x: number, z: number): number =>
      (Math.floor(x / fam.spacing) + 4096) * 8192 + Math.floor(z / fam.spacing) + 4096;
    const farFromCommitted = (x: number, z: number): boolean => {
      const gx = Math.floor(x / fam.spacing);
      const gz = Math.floor(z / fam.spacing);
      const s2 = fam.spacing * fam.spacing;
      for (let oz = -1; oz <= 1; oz++) {
        for (let ox = -1; ox <= 1; ox++) {
          const bucket = committed.get((gx + ox + 4096) * 8192 + gz + oz + 4096);
          if (bucket === undefined) continue;
          for (let k = 0; k < bucket.length; k += 2) {
            const dx = (bucket[k] ?? 0) - x;
            const dz = (bucket[k + 1] ?? 0) - z;
            if (dx * dx + dz * dz < s2) return false;
          }
        }
      }
      return true;
    };
    const accept = (x: number, z: number): boolean => {
      const i = cellIndex(x, z);
      if (((1 << (zone[i] ?? Z_NONE)) & fam.zones) === 0) return false;
      if ((dLane[i] ?? 0) < fam.clearLane) return false;
      if ((dCliff[i] ?? 0) < fam.clearCliff) return false;
      if ((dRiver[i] ?? 0) < fam.clearRiver) return false;
      return farFromCommitted(x, z);
    };

    for (let tz = 0; tz < TILES; tz++) {
      for (let tx = 0; tx < TILES; tx++) {
        const minX = tx * tileSize;
        const minZ = tz * tileSize;
        const maxX = minX + tileSize;
        const maxZ = minZ + tileSize;
        const seed = `rift:veg:${fam.key}:${map.lanes}:${tz * TILES + tx}`;
        const tileIdx = tz * TILES + tx;
        units.push(() => {
          if (famCount >= fam.max || totalPlaced >= TOTAL_CAP) return true;
          let anyZone = 0;
          for (let z = 1; z < 8; z++) {
            if (((1 << z) & fam.zones) !== 0) anyZone += tileZone[(tileIdx << 3) + z] ?? 0;
          }
          if (anyZone === 0) return true;
          // Accepted area inside this tile, in m². `ScatterOpts.density` is per
          // 100 m² of the RECT it is given, so the family's per-100 m²-of-zone
          // target is converted by the fraction of the rect that is actually
          // plantable. Without this, a tile that is 10% jungle would be planted
          // as if it were 100% jungle.
          let cells = 0;
          const x0 = Math.max(0, Math.floor(minX * res));
          const x1 = Math.min(dim - 1, Math.ceil(maxX * res) - 1);
          const z0 = Math.max(0, Math.floor(minZ * res));
          const z1 = Math.min(dim - 1, Math.ceil(maxZ * res) - 1);
          for (let cz = z0; cz <= z1; cz++) {
            for (let cx = x0; cx <= x1; cx++) {
              const i = cz * dim + cx;
              if (((1 << (zone[i] ?? Z_NONE)) & fam.zones) === 0) continue;
              if ((dLane[i] ?? 0) < fam.clearLane) continue;
              if ((dCliff[i] ?? 0) < fam.clearCliff) continue;
              if ((dRiver[i] ?? 0) < fam.clearRiver) continue;
              cells++;
            }
          }
          if (cells === 0) return true;
          const rectArea = (maxX - minX) * (maxZ - minZ);
          const cellArea = cells / (res * res);
          const density = (fam.density * cellArea) / rectArea;
          const xforms: readonly InstanceXform[] = scatter({
            seed,
            minX,
            maxX,
            minZ,
            maxZ,
            spacing: fam.spacing,
            density,
            accept,
            heightAt,
            tints: fam.ladder,
            archetypes: fam.archs.length,
            max: fam.max,
          });
          for (const xf of xforms) {
            if (famCount >= fam.max || totalPlaced >= TOTAL_CAP) break;
            const archId = fam.archs[Math.min(fam.archs.length - 1, xf.variant)];
            if (archId === undefined) continue;
            const list = placements[archId];
            if (list === undefined) continue;
            const step = fam.ladder.indexOf(xf.tint);
            const mod = mods[step < 0 ? 0 : step] ?? mods[0];
            if (mod === undefined) continue;
            list.push({ x: xf.x, y: xf.y, z: xf.z, scale: xf.scale, rotY: xf.rotY, leanX: xf.leanX, leanZ: xf.leanZ, mod });
            const key = hashOf(xf.x, xf.z);
            const bucket = committed.get(key);
            if (bucket === undefined) committed.set(key, [xf.x, xf.z]);
            else bucket.push(xf.x, xf.z);
            famCount++;
            totalPlaced++;
          }
          return true;
        });
      }
    }
  }

  // Instance fill: one unit per archetype. Every bucket of the archetype becomes
  // one InstancedMesh — the whole draw-call story of this module.
  const mat = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (let a = 0; a < ARCHETYPES.length; a++) {
    const def = ARCHETYPES[a];
    const st = archStates[a];
    if (def === undefined || st === undefined) continue;
    units.push(() => {
      const list = placements[a] ?? [];
      if (list.length === 0 || !st.done) return true;
      for (let b = 0; b < st.buckets.length; b++) {
        const bucket = st.buckets[b];
        if (bucket === undefined) continue;
        const im = new THREE.InstancedMesh(bucket.geo, bucket.material, list.length);
        im.name = `rift:veg:${def.key}:${b}`;
        im.castShadow = def.castShadow;
        im.receiveShadow = true;
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          if (p === undefined) continue;
          euler.set(p.leanX, p.rotY, p.leanZ, 'YXZ');
          quat.setFromEuler(euler);
          pos.set(p.x, p.y, p.z);
          scl.set(p.scale, p.scale, p.scale);
          mat.compose(pos, quat, scl);
          im.setMatrixAt(i, mat);
          im.setColorAt(i, p.mod);
        }
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor !== null) im.instanceColor.needsUpdate = true;
        // Instances span the whole map, so the bounds must be recomputed from
        // the instance matrices. Without this the mesh keeps the archetype's own
        // metre-wide sphere at the origin and the frustum culls the entire
        // jungle the moment the camera leaves the map corner. Only the sphere is
        // computed: `Frustum.intersectsObject` reads that one, and the box costs
        // a second O(instances) pass for a raycast this module never takes (no
        // vegetation is in the pick set).
        im.computeBoundingSphere();
        if (isSwayBucket(def, bucket.material)) {
          const node = new THREE.Group();
          node.name = `${im.name}:sway`;
          node.add(im);
          root.add(node);
          sways.push({ node, amp: def.swayAmp, phase: (a * 1.618) % TAU });
        } else {
          root.add(im);
        }
      }
      return true;
    });
  }

  // ---- the frame hook -------------------------------------------------------
  let cursor = 0;
  let failures = 0;
  let windT = 0;
  const clock = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance : null;

  core.addFrameHook((dtMs: number) => {
    if (cursor < units.length) {
      const t0 = clock !== null ? clock.now() : 0;
      while (cursor < units.length) {
        const unit = units[cursor];
        if (unit === undefined) {
          cursor++;
          continue;
        }
        try {
          if (unit()) cursor++;
        } catch (err) {
          // A single bad unit must not take the frame — or the rest of the
          // jungle — down with it (GRAPHICS_CONTRACT §7 robustness).
          cursor++;
          failures++;
          if (failures <= 3) console.warn('rift vegetation: build unit failed', err);
          if (failures > 8) cursor = units.length;
        }
        if (clock === null || clock.now() - t0 >= SLICE_MS) break;
      }
    }

    // Wind. Allocation-free and O(sway nodes), never O(instances).
    windT += dtMs * 0.001;
    for (let i = 0; i < sways.length; i++) {
      const s = sways[i];
      if (s === undefined) continue;
      const a = windT * SWAY_RATE + s.phase;
      s.node.position.set(Math.sin(a) * s.amp, 0, Math.cos(a * 0.83 + s.phase) * s.amp * 0.7);
    }
  });

  return {
    ready(): boolean {
      return cursor >= units.length;
    },
  };
}

/** True when this bucket's material is one of the archetype's sway surfaces.
 *  `surface(id)` is cached per (id, tint) and this module never tints, so
 *  identity comparison is an exact bucket→family test with no naming
 *  convention to drift out of sync. */
function isSwayBucket(def: ArchDef, material: THREE.MeshStandardMaterial): boolean {
  for (const id of def.sway) {
    if (surface(id) === material) return true;
  }
  return false;
}
