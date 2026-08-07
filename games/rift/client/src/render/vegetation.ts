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
// Twenty-one archetypes are built here, seven of them trees, and every placed
// instance gets seeded scale/rotation/lean/tint variation so no two neighbours
// are the same object.
//
// THE FIVE LAWS THIS FILE OBEYS, and where each is enforced below:
//
//  1. MATERIAL LAW. Every material is `surface(id)` from the kit — there is not
//     one material constructor in this file. Per-instance colour variation is
//     NOT `surface(id, tint)`: a tint mints a material and therefore a draw
//     call, and three tint steps across thirty buckets would be ninety draw
//     calls for the jungle alone. It is the InstancedMesh colour attribute
//     instead (see INSTANCE COLOUR below), which is exactly the "per-instance
//     tint step" the vertex-colour law in core.ts reserves it for.
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
//  4. DRAW-CALL LAW (GRAPHICS_CONTRACT §5, AMENDMENT_3 §D). One `InstancedMesh`
//     per (archetype, surface bucket): twenty-one archetypes over THIRTY
//     buckets. The draw meter accumulates the SHADOW PASS as well
//     (`info.autoReset = false`, one `reset()` per frame), so the module's cost
//     is buckets + shadow-casting buckets, not buckets — 30 + 23 = 53 before
//     AMENDMENT_3 §D.2, which is what the review measured against a header
//     claiming 30. §D.2 makes casters a whitelist — see SHADOW POLICY below —
//     leaving 13 casters and a MEASURED 43 draw calls, identical at 1, 2 and 3
//     lanes, read back from `renderer.info.render.calls` after a real
//     `renderer.render` with `shadowMap.enabled`.
//
//  5. KEEP-OUT LAW. Nothing may be planted where the sim or another module
//     needs the ground read: the lane corridor, the ramps, the base platforms,
//     the cliff faces, the river channel, `map.terrain.camps`' clearings and
//     `map.terrain.landmarks`' anchors. Clearance is measured against the
//     archetype's MEASURED MESH ENVELOPE, not its trunk origin — see PLANTING
//     CLEARANCE.
//
// SHADOW POLICY (AMENDMENT_3 §D.2). "Only cliffRock, structures, heroes and
// tree trunks cast. Ferns, ground cover, decals, FX, motes, banners and every
// anim part do not." A bucket here casts iff BOTH halves agree: the archetype
// is not ground cover (`ArchDef.castShadow`) AND the bucket's surface family is
// a caster (`VegSurface.castsShadow` — `bark` and `cliffRock` only). That means
// a tree's TRUNK casts and its CANOPY does not, which is the whole reason this
// module fits: canopy is half of every tree's bucket count. `monumentStone`
// ruin fragments and `wetRock` bank stones are props, not structures, and are
// off the whitelist too.
//
// INSTANCE COLOUR. `scatter()` hands back one of the family's {base, Lit, Deep}
// palette steps per instance; this module stores the STEP INDEX, and each
// bucket then resolves that index against ITS OWN surface family's ladder. A
// tree instance drawn one step deep therefore gets `canopyDeep` on the canopy
// bucket and `barkDeep` on the trunk bucket, instead of the canopy step being
// multiplied into the trunk. The modulation is computed by mixing toward the
// step IN THE SPACE THE PALETTE IS AUTHORED IN (sRGB) at `TINT_GAIN`, then
// converting to the linear ratio the InstancedMesh colour attribute multiplies
// by — see {@link ladderMods} for the measured band.
//
// WIND. Canopy and frond buckets hang off their own sway node — a `Group` whose
// position oscillates a few centimetres with a per-archetype phase. Per frame
// that is a dozen sin/cos and a dozen `position.set` calls, allocation-free and
// independent of instance count; re-composing instance matrices every frame to
// sway them individually would re-upload the whole matrix buffer and buy motion
// nobody can resolve at gameplay zoom. The trunk bucket does NOT sway, so the
// canopy moves against a fixed trunk, which is what reads as wind.
//
// COLD LOAD (AMENDMENT_3 §E). 120 ms of the 400 ms budget, spent through one
// queue of small work units stepped from this module's own frame hook: surface
// pre-warm → distance fields → keep-out field → zone classification →
// archetype bakes → per-bucket AO and envelope scan → per-tile scatter →
// chunked instance fill. Every unit is sized so that `SLICE_MS` plus the worst
// single unit stays inside one 16 ms frame — a budget that does not bound the
// frame is not a budget.
//
// MEASURED IN SEVEN FRESH BROWSER PROCESSES PER LANE COUNT, empty `matCache`,
// texture generation INCLUDED: 80.6 / 82.2 / 93.0 ms best-case at 1 / 2 / 3
// lanes. With R_SCENE's §E.3 surface pre-warm already paid — which is where the
// amendment puts the texture cost — 49-62 ms at 3 lanes, worst frame 9.7 ms and
// ZERO frames over 16 ms in every run at every lane count. The warm figures are
// reported ALONGSIDE the cold ones, never instead.
//
// The host is shared with other build agents, so every measurement also times a
// fixed `buildTerrain(3)` in the same process as a calibration anchor: it ran
// 17.6-34.8 ms across those processes and tracks the build cost 1:1, at a stable
// ratio of 4.1-4.7x. The uncontended processes (calibration ~19 ms) are the ones
// quoted above; a contended one stretches everything by the same factor.
//
// `ready()` is false until the queue drains, and STAYS false forever if any
// unit threw.
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

/** Main-thread slice per frame for the construction queue.
 *
 *  AMENDMENT_3 §E.2: "a budget of 16 ms means no frame exceeds 16 ms". The loop
 *  below stops as soon as `SLICE_MS` is spent, so the worst frame it can
 *  produce is `SLICE_MS` (just under) plus the cost of the ONE unit that was
 *  already running — which is why every unit in this file is sized, and why the
 *  surface pre-warm is a unit of its own rather than an ambush inside a bake
 *  step.
 *
 *  MEASURED, 3 lanes, in a fresh process: the worst single call of any unit
 *  this module OWNS is 5.9 ms (`bake: treeGiant`), so the bound on a frame of
 *  this module's own work is `4 + 5.9 = 9.9 ms`, and the measured worst frame
 *  with the surface cache warm is 9.0 ms over five fresh processes. The one
 *  call above that is `surface('bark')` at 16.2 ms — a single atomic
 *  texture rasterisation inside `kit.ts` that no caller can subdivide, paid at
 *  most once per family, and assigned to R_SCENE by AMENDMENT_3 §E.3. It runs
 *  first in the queue precisely so it lands in a frame of its own. */
const SLICE_MS = 4;

/** Per-step slice handed to the kit's `bakeChunked` for one archetype. An
 *  archetype is 3-31 parts, so this is one or two steps; the cap exists so a
 *  single step cannot eat the frame budget on the biggest tree. Measured worst
 *  `bake:` call: 5.9 ms, on `treeGiant`. */
const BAKE_SLICE_MS = 3;

/** Instances written per instance-fill call. `setMatrixAt` + `setColorAt` over
 *  640 instances across an archetype's two buckets is otherwise one unbounded
 *  unit at the very end of the queue, which is exactly the shape §E.2 rejects.
 *  Measured worst `instance fill:` call with this chunk size: 1.1 ms. */
const FILL_CHUNK = 128;

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
 *  island and leaves the rest of the jungle bare. The tile grid is what reaches
 *  every island, and the per-tile zone histogram below is what keeps
 *  8x8x14 units affordable. */
const TILES = 8;

/** How far from the river a `ground` cell still counts as bank (metres). */
const BANK_REACH = 3.5;
/** How far from a lane/ramp/base cell a `ground` cell counts as lane shoulder
 *  rather than jungle (metres). Beyond this the map is jungle and gets the
 *  enclosing densities; inside it the lane stays clean and readable. */
const SHOULDER_REACH = 4.5;

// ---- PLANTING CLEARANCE -----------------------------------------------------
// Clearance is measured from the MESH, not from the trunk origin. Every
// archetype's bake is scanned once (see {@link envelopeScan}) for two radii:
//
//   envFull — the worst-case lateral reach of ANY vertex,
//   envLow  — the worst-case lateral reach of vertices inside the walkable
//             band (below LANE_HEADROOM),
//
// both already multiplied by the kit's maximum per-instance scale and rotated
// out by its maximum per-instance lean, so they bound where the mesh can
// actually end up rather than where its origin is.
//
// The two radii are used for two different rules, and the difference is
// deliberate and measured:
//
//   * LANE / RAMP / BASE use `envLow`. BUILD_SPECS §R_VEG gives the reason for
//     this rule in the same sentence as the rule: "vegetation must not encroach
//     on walkable lane width, because there is no collision on it and players
//     will read it as blocking when it is not." Only geometry a player can walk
//     into reads as blocking, so only geometry inside the walkable band has to
//     clear. Applying `envFull` instead was measured against the terrain
//     itself: at a 5.8 m lane keep-out only 31.4% of the `foliage` zone is left
//     plantable at 3 lanes and 26.2% at 2 — and the real `envFull` of a
//     broadleaf is 7.42 m, so the true figures are lower still. That makes
//     STYLE_BIBLE §8's floor of 8 trees per 100 m² OF THE ZONE arithmetically
//     unreachable, whichever way the rest of the module is tuned. A canopy that
//     overhangs a lane at 6 m is what a jungle edge looks like; a trunk in the
//     lane is the defect. Verified: zero instances put walkable-band geometry
//     over a lane, ramp or base cell at 1, 2 or 3 lanes.
//
//   * CAMP CLEARINGS AND LANDMARK ANCHORS use `envFull`. The camera is a fixed
//     55° top-down (STYLE_BIBLE §5), so an overhanging canopy DOES bury a camp
//     mesh and its spawn point, and DOES hide the set piece players navigate
//     by. Nothing of the prop may cross those discs at any height. Verified:
//     zero instances put ANY geometry over a camp clearing or a landmark disc
//     at 1, 2 or 3 lanes, against 59 and 42 before this field existed.

/** Top of the walkable band, metres. The tallest thing that walks is a 1.9 u
 *  hero (STYLE_BIBLE §7); 2.6 m clears it with head room, so nothing below this
 *  height may enter a lane, ramp or base cell. */
const LANE_HEADROOM = 2.6;

/** The kit's per-instance scale and lean maxima, frozen in `InstanceXform`'s
 *  doc comment ("already varied +/-30%", "magnitude never exceeds 12 deg").
 *  Transcribed rather than imported because `kit.ts` does not export them; they
 *  are the bound this module's envelope arithmetic has to survive. */
const SCATTER_MAX_SCALE = 1.3;
const SCATTER_MAX_LEAN = (12 * Math.PI) / 180;

/** Extra clearance added beyond the mesh envelope around camp clearings and
 *  landmark anchors, metres. Pure art-direction breathing room: the sampling
 *  and chamfer errors are handled exactly, in {@link Family} `fits`, not by
 *  this number. */
const SITE_MARGIN = 0.5;

/** Worst-case ratio by which the (1, sqrt2) chamfer transform overestimates true
 *  Euclidean distance: `1 / cos(22.5 deg)`, at the 22.5 deg direction where a
 *  mix of axial and diagonal steps is furthest from the straight line. Keep-out
 *  tests divide by it, because for a keep-out an overestimate is the direction
 *  that lets a prop through. */
const CHAMFER_MAX_OVER = 1 / Math.cos(Math.PI / 8);

/** Camp clearing radius per tier, metres. Transcribed from `CAMP_CLEARING_R` in
 *  `shared/src/terrain.ts`, which is module-private and cannot be imported —
 *  it is the ground the terrain generator carves to `'ground'` for the camp and
 *  the room the tier's bodies need. */
const CAMP_CLEARING_R: Readonly<Record<string, number>> = { pack: 2.5, brute: 3, hive: 3.5 };
/** Fallback for a camp tier this file has not heard of. `CampDef['tier']` is a
 *  frozen three-way union, so this is unreachable today; it exists so a fourth
 *  tier degrades to the largest known clearing instead of to zero. */
const CAMP_CLEARING_FALLBACK = 3.5;

/** Footprint radius kept clear around every landmark anchor, metres.
 *
 *  This is an ASSUMPTION, not a measurement: `TerrainDef.landmarks` carries only
 *  `{kind, x, z}`, R_MAPMESH owns the set-piece geometry and has not landed, so
 *  there is no mesh to measure. 4 m is the radius the review measured this
 *  module's encroachment at ("42 instances within 4 m of landmark anchors") and
 *  is consistent with the contract's own descriptions — a ring of standing
 *  stones, a lying colossus, an arch over a lane are ~8 m across. One radius for
 *  all four kinds rather than a switch, because `kind` is typed as bare `string`
 *  and an exhaustive switch on it would be a lie. If R_MAPMESH lands a set piece
 *  wider than this, this number is the thing to move. */
const LANDMARK_KEEP_R = 4;

/** Gain and clamp of the per-instance colour modulation. See {@link ladderMods}. */
const TINT_GAIN = 0.35;
const TINT_MIN = 0.7;
const TINT_MAX = 1.45;

/** Sway amplitude in metres and angular rate in rad/s, per sway class. */
const SWAY_CANOPY_AMP = 0.075;
const SWAY_FROND_AMP = 0.038;
const SWAY_RATE = 1.35;

/** Global instance ceiling across every family — the triangle-budget backstop
 *  (GRAPHICS_CONTRACT §5, <= 1.2 M rendered per pass). The per-family `max`
 *  values sum well below this at every lane count measured; it exists so a lane
 *  count nobody has measured cannot plant the map straight through the budget. */
const TOTAL_CAP = 4200;

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

/** Grow one branch level off a set of parent tips and return the new tips.
 *
 *  STYLE_BIBLE §7 asks for 3-5 branch LEVELS on every tree, and a level is not
 *  a spray: each child starts at a parent's tip, is thinner and shorter than its
 *  parent, and opens further from vertical. Pushing that here rather than
 *  copying five loops per archetype is what keeps every tree honest about how
 *  many levels it actually has — the part counts in each build's doc comment are
 *  `roots + trunk + sum(level sizes) + shells`, and they are literal. */
function branchLevel(
  parts: Part[],
  id: SurfaceId,
  from: readonly Pt[],
  count: number,
  rTop: number,
  rBot: number,
  lenMin: number,
  lenMax: number,
  tiltMin: number,
  tiltMax: number,
  seg: number,
  r: Rng,
): Pt[] {
  const tips: Pt[] = [];
  if (from.length === 0) return tips;
  for (let i = 0; i < count; i++) {
    const base = from[i % from.length] ?? from[0];
    if (base === undefined) break;
    tips.push(
      limb(
        parts,
        id,
        rTop,
        rBot,
        r.range(lenMin, lenMax),
        seg,
        r.range(tiltMin, tiltMax),
        (i * TAU) / count + r.range(-0.45, 0.45),
        base,
      ),
    );
  }
  return tips;
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
// The archetype library — 21 builds, 7 of them trees. STYLE_BIBLE §7 requires
// at least 6 tree archetypes, 18-40 parts each, with 3-5 BRANCH LEVELS: every
// tree below grows level 1 off the trunk, level 2 off level 1's tips and level
// 3 off level 2's. Part counts are noted per build and are literal, because
// every loop bound is a literal.
// ============================================================================

/** GIANT emergent, ~11.5 m. 29 parts (5 roots + 3 trunk + 4/6/5 branch levels
 *  + 6 shells). The jungle's ceiling, and the only archetype spending detail-1
 *  canopy shells. */
function buildTreeGiant(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 5; i++) rootFlare(p, 'bark', 0.66, 2.6, (i * TAU) / 5 + r.range(-0.25, 0.25), 0.52);
  let t: Pt = { x: 0, y: 0, z: 0 };
  t = limb(p, 'bark', 0.5, 0.8, 3.3, 9, 0.03, r.range(0, TAU), t);
  t = limb(p, 'bark', 0.38, 0.5, 3.1, 9, 0.05, r.range(0, TAU), t);
  const crown = limb(p, 'bark', 0.26, 0.38, 3.0, 8, 0.04, r.range(0, TAU), t);
  const l1: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const from: Pt = { x: crown.x * 0.6, y: 6.4 + i * 0.75, z: crown.z * 0.6 };
    l1.push(limb(p, 'bark', 0.14, 0.24, r.range(2.2, 3.0), 6, r.range(0.72, 1.05), (i * TAU) / 4 + r.range(-0.3, 0.3), from));
  }
  const l2 = branchLevel(p, 'bark', l1, 6, 0.08, 0.14, 1.2, 1.9, 0.5, 0.95, 5, r);
  branchLevel(p, 'bark', l2, 5, 0.045, 0.08, 0.6, 1.05, 0.55, 1.15, 4, r);
  for (let i = 0; i < 6; i++) {
    const az = (i * TAU) / 6 + r.range(-0.4, 0.4);
    const rad = i === 0 ? 0 : r.range(1.1, 2.2);
    shell(p, 'canopy', r.range(1.9, 2.6), 1, { x: Math.sin(az) * rad, y: r.range(9.0, 11.0), z: Math.cos(az) * rad }, r);
  }
  return p;
}

/** BROADLEAF, ~8 m. 28 parts (4 roots + 2 trunk + 5/6/5 branch levels +
 *  6 shells). The default jungle tree: wide low dome. */
function buildTreeBroad(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 4; i++) rootFlare(p, 'bark', 0.5, 1.8, (i * TAU) / 4 + r.range(-0.3, 0.3), 0.4);
  let t: Pt = { x: 0, y: 0, z: 0 };
  t = limb(p, 'bark', 0.4, 0.58, 2.6, 8, 0.05, r.range(0, TAU), t);
  const crown = limb(p, 'bark', 0.26, 0.4, 2.4, 8, 0.07, r.range(0, TAU), t);
  const l1: Pt[] = [];
  for (let i = 0; i < 5; i++) {
    const from: Pt = { x: crown.x * 0.5, y: 3.4 + i * 0.42, z: crown.z * 0.5 };
    l1.push(limb(p, 'bark', 0.11, 0.2, r.range(1.7, 2.5), 6, r.range(0.85, 1.2), (i * TAU) / 5 + r.range(-0.25, 0.25), from));
  }
  const l2 = branchLevel(p, 'bark', l1, 6, 0.07, 0.12, 0.9, 1.5, 0.6, 1.0, 5, r);
  branchLevel(p, 'bark', l2, 5, 0.04, 0.07, 0.5, 0.85, 0.6, 1.2, 4, r);
  for (let i = 0; i < 6; i++) {
    const az = (i * TAU) / 6 + r.range(-0.35, 0.35);
    const rad = i === 0 ? 0 : r.range(1.2, 2.1);
    shell(p, 'canopy', r.range(1.6, 2.3), 0, { x: Math.sin(az) * rad, y: r.range(6.0, 7.6), z: Math.cos(az) * rad }, r);
  }
  return p;
}

/** SLENDER, ~9 m. 31 parts (4 roots + 3 trunk + 6/6/4 branch levels + 2 shed
 *  lower stubs + 6 shells). Tall thin understorey form with a small high canopy
 *  — its job is vertical rhythm inside a mass of broadleaves. */
function buildTreeSlender(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 4; i++) rootFlare(p, 'bark', 0.3, 1.1, (i * TAU) / 4 + r.range(-0.3, 0.3), 0.24);
  const lean = r.range(0.05, 0.14);
  const leanAz = r.range(0, TAU);
  let t: Pt = { x: 0, y: 0, z: 0 };
  t = limb(p, 'bark', 0.24, 0.34, 3.2, 7, lean, leanAz, t);
  t = limb(p, 'bark', 0.18, 0.24, 3.0, 7, lean, leanAz, t);
  const crown = limb(p, 'bark', 0.13, 0.18, 2.4, 6, lean, leanAz, t);
  const l1 = branchLevel(p, 'bark', [crown], 6, 0.05, 0.09, 1.0, 1.7, 0.9, 1.25, 5, r);
  const l2 = branchLevel(p, 'bark', l1, 6, 0.035, 0.055, 0.55, 0.95, 0.7, 1.2, 4, r);
  branchLevel(p, 'bark', l2, 4, 0.025, 0.04, 0.3, 0.55, 0.7, 1.3, 4, r);
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

/** FORKED, ~7.5 m. 31 parts (4 roots + 1 base + 2 x (2 trunk + 3/3/2 branch
 *  levels) + 6 shells). Splits into two trunks at 1.7 m — the archetype that
 *  most changes a tree line's silhouette from the fixed camera. */
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
    const l1 = branchLevel(p, 'bark', [t], 3, 0.07, 0.13, 1.1, 1.8, 0.7, 1.1, 5, r);
    const l2 = branchLevel(p, 'bark', l1, 3, 0.045, 0.07, 0.6, 1.05, 0.6, 1.15, 4, r);
    branchLevel(p, 'bark', l2, 2, 0.028, 0.045, 0.3, 0.6, 0.6, 1.25, 4, r);
  }
  for (let i = 0; i < 6; i++) {
    const base = crowns[i % 2] ?? split;
    const az = r.range(0, TAU);
    const rad = r.range(0.3, 1.4);
    shell(p, 'canopy', r.range(1.3, 1.9), 0, { x: base.x + Math.sin(az) * rad, y: base.y + r.range(-0.3, 0.9), z: base.z + Math.cos(az) * rad }, r);
  }
  return p;
}

/** CONIFER spire, ~9 m. 29 parts (4 roots + 3 trunk + 5/5/4 branch levels +
 *  8 tiers). The only tree whose canopy silhouette is a triangle, which is what
 *  makes it read at distance and on the bare high ground. */
function buildTreeConifer(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 4; i++) rootFlare(p, 'bark', 0.34, 1.2, (i * TAU) / 4 + r.range(-0.3, 0.3), 0.26);
  let t: Pt = { x: 0, y: 0, z: 0 };
  t = limb(p, 'bark', 0.28, 0.42, 3.0, 7, 0.03, r.range(0, TAU), t);
  t = limb(p, 'bark', 0.16, 0.28, 3.0, 6, 0.03, r.range(0, TAU), t);
  limb(p, 'bark', 0.05, 0.16, 2.4, 5, 0.02, r.range(0, TAU), t);
  const l1: Pt[] = [];
  for (let i = 0; i < 5; i++) {
    l1.push(limb(p, 'bark', 0.05, 0.09, r.range(0.8, 1.3), 5, r.range(1.0, 1.3), (i * TAU) / 5 + r.range(-0.3, 0.3), { x: 0, y: 1.7 + i * 0.62, z: 0 }));
  }
  const l2 = branchLevel(p, 'bark', l1, 5, 0.035, 0.05, 0.4, 0.7, 1.05, 1.35, 4, r);
  branchLevel(p, 'bark', l2, 4, 0.025, 0.035, 0.2, 0.4, 1.05, 1.4, 4, r);
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

/** DEAD tree, ~6.5 m. 23 parts (4 roots + 3 trunk + 5/4/3 branch levels +
 *  4 crown stubs), bark only. Bare, broken-topped, snapped branches —
 *  STYLE_BIBLE §8 puts these on the scoured high ground, where a leafless
 *  vertical against open sky is the plateau's whole silhouette, and §7 asks for
 *  "some dead and bare" in the tree line, which is why the open-jungle family
 *  weights one in eight to this archetype too. */
function buildTreeDead(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 4; i++) rootFlare(p, 'bark', 0.42, 1.4, (i * TAU) / 4 + r.range(-0.3, 0.3), 0.34);
  let t: Pt = { x: 0, y: 0, z: 0 };
  t = limb(p, 'bark', 0.32, 0.48, 2.4, 7, 0.06, r.range(0, TAU), t);
  t = limb(p, 'bark', 0.2, 0.32, 2.3, 6, 0.09, r.range(0, TAU), t);
  const top = limb(p, 'bark', 0.11, 0.2, 1.5, 6, 0.12, r.range(0, TAU), t);
  const l1: Pt[] = [];
  for (let i = 0; i < 5; i++) {
    const from: Pt = { x: 0, y: 2.6 + i * 0.66, z: 0 };
    l1.push(limb(p, 'bark', 0.05, 0.13, r.range(1.1, 2.0), 5, r.range(0.55, 1.15), (i * TAU) / 5 + r.range(-0.4, 0.4), from));
  }
  const l2 = branchLevel(p, 'bark', l1, 4, 0.03, 0.06, 0.5, 0.9, 0.4, 1.0, 4, r);
  branchLevel(p, 'bark', l2, 3, 0.022, 0.03, 0.25, 0.5, 0.5, 1.15, 4, r);
  for (let i = 0; i < 4; i++) {
    limb(p, 'bark', 0.03, 0.07, r.range(0.3, 0.6), 4, r.range(0.7, 1.3), r.range(0, TAU), top);
  }
  return p;
}

/** MOSSY squat, ~6 m. 24 parts (5 roots + 2 gnarled trunk + 5/4/3 branch levels
 *  + 5 shells). Leaning, with a low heavy canopy — the tree that makes a jungle
 *  pocket feel closed over the player's head. */
function buildTreeMossy(r: Rng): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < 5; i++) rootFlare(p, 'bark', 0.56, 1.7, (i * TAU) / 5 + r.range(-0.3, 0.3), 0.46);
  const leanAz = r.range(0, TAU);
  let t: Pt = { x: 0, y: 0, z: 0 };
  t = limb(p, 'bark', 0.46, 0.66, 2.2, 8, r.range(0.1, 0.2), leanAz, t);
  const crown = limb(p, 'bark', 0.32, 0.46, 1.9, 8, r.range(0.12, 0.26), leanAz + Math.PI * 0.6, t);
  const l1 = branchLevel(p, 'bark', [crown], 5, 0.1, 0.2, 1.4, 2.2, 0.95, 1.3, 6, r);
  const l2 = branchLevel(p, 'bark', l1, 4, 0.05, 0.09, 0.7, 1.2, 0.6, 1.1, 5, r);
  branchLevel(p, 'bark', l2, 3, 0.03, 0.05, 0.35, 0.65, 0.6, 1.2, 4, r);
  for (let i = 0; i < 5; i++) {
    const base = l1[i] ?? crown;
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
// Surface families used by this module
// ============================================================================

/**
 * The six surface families every archetype in this file is built from, each
 * with its own {base, Lit, Deep} ladder and its own half of the shadow-caster
 * whitelist (AMENDMENT_3 §D.2).
 *
 * This table is what makes a bucket self-describing. `bake()` returns
 * `{geo, material}` and nothing else, so the bucket's FAMILY is recovered by
 * material identity — `surface(id)` is cached per (id, tint, emissive) and this
 * module never tints or emits, so `surface(id) === material` is an exact test
 * with no naming convention to drift out of sync. That one lookup answers all
 * three questions the instance fill has to ask: which tint ladder modulates it,
 * whether it sways, and whether it casts.
 */
interface VegSurface {
  readonly id: SurfaceId;
  readonly ladder: readonly string[];
  /** The surface half of the AMENDMENT_3 §D.2 whitelist: "only cliffRock,
   *  structures, heroes and tree TRUNKS cast". Canopy, fronds, ruin fragments
   *  and bank stones do not. */
  readonly castsShadow: boolean;
}

const VEG_SURFACES: readonly VegSurface[] = [
  { id: 'bark', ladder: LADDER_BARK, castsShadow: true },
  { id: 'canopy', ladder: LADDER_CANOPY, castsShadow: false },
  { id: 'fern', ladder: LADDER_FERN, castsShadow: false },
  { id: 'cliffRock', ladder: LADDER_CLIFF, castsShadow: true },
  { id: 'monumentStone', ladder: LADDER_MONUMENT, castsShadow: false },
  { id: 'wetRock', ladder: LADDER_WET, castsShadow: false },
];

/** The three per-instance colour multipliers of each family's ladder, in the
 *  same order as {@link VEG_SURFACES}. Computed once at module load: it is pure
 *  arithmetic over frozen palette entries, allocates 18 `THREE.Color`s in
 *  total, and touches no texture. */
const VEG_MODS: readonly (readonly THREE.Color[])[] = VEG_SURFACES.map((s) => ladderMods(s.ladder));

/** Recover a bucket's surface family from its material. Returns -1 for a
 *  material this module did not ask for, which cannot happen while every part
 *  above names one of the six ids — the branch exists so an unknown bucket
 *  degrades to "no modulation, no sway, no shadow" instead of indexing past the
 *  end of a table. */
function vegSurfaceIndex(material: THREE.MeshStandardMaterial): number {
  for (let i = 0; i < VEG_SURFACES.length; i++) {
    const s = VEG_SURFACES[i];
    if (s !== undefined && surface(s.id) === material) return i;
  }
  return -1;
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
  /** The archetype half of the AMENDMENT_3 §D.2 shadow whitelist. `false` marks
   *  GROUND COVER, which never casts whatever family it is built from — a bush
   *  and a sapling have `bark` stems, and `bark` is a caster, so without this
   *  flag they would join the shadow pass. A bucket casts iff this AND
   *  {@link VegSurface.castsShadow} are both true. */
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
//
// SPACING IS THE BINDING CONSTRAINT, NOT DENSITY. `ScatterOpts` says it in
// terms: "The scatter stops early if `spacing` cannot physically fit that many
// — density is a target, spacing is a guarantee." A Poisson disc of radius s
// admits at most 100 * 2 / (sqrt(3) * s^2) = 115.5 / s^2 instances per 100 m²,
// and Bridson reaches roughly two thirds of that, so a family asking for D per
// 100 m² needs s <= sqrt(77 / D) or its density is unreachable arithmetic. The
// previous values asked for 14 trees at s = 3.0 — a ceiling of 12.8 before any
// packing loss — and delivered a measured 6.3 per 100 m², below §8's floor of 8.
//
// The keep-outs tighten it further: the instances have to fit into the PLANTABLE
// part of the zone, which for `treeDense` at 3 lanes is 934 m² of the 1344 m²
// foliage zone, so the effective requirement is 14 / 0.695 = 20.1 per 100 m² and
// s <= 1.96. Every `spacing` below is set from that inequality and then
// CONFIRMED BY MEASURING THE PLANTED MAP — achieved 11.43 / 9.03 / 8.33 foliage
// trees per 100 m² at 1 / 2 / 3 lanes, against the floor of 8.
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
  /** FLOOR on the distance from any lane / ramp / base cell, metres. The real
   *  clearance is `max(clearLane, envLow)` — see PLANTING CLEARANCE — so this
   *  is the art-direction minimum (keep the shoulder tidier than the geometry
   *  strictly requires), not the safety rule. */
  readonly clearLane: number;
  /** Minimum distance from any cliff cell — props hanging over a plateau lip
   *  float, because the cliff face drops away under them. */
  readonly clearCliff: number;
  /** Minimum distance from the river channel. */
  readonly clearRiver: number;
  /** The family's dominant ladder. `scatter` needs a {base, Lit, Deep} triplet
   *  (it rejects fewer than three steps) and returns one step per instance;
   *  this module keeps only the STEP INDEX and re-resolves it against each
   *  BUCKET's own family ladder, so a canopy step never lands on a trunk. */
  readonly ladder: readonly string[];
  /** Global ceiling on this family, for the triangle budget. */
  readonly max: number;
}

const FAMILIES: readonly Family[] = [
  // Jungle — foliage cells. Top of the §8 range (8-14 trees, 20-35 undergrowth):
  // the sim treats these cells as concealing, and a player must be able to guess
  // where they are hidden from the density alone.
  { key: 'treeDense', zones: M_DENSE, archs: [A_GIANT, A_BROAD, A_BROAD, A_SLENDER, A_FORKED, A_CONIFER, A_MOSSY, A_MOSSY], density: 14, spacing: 1.8, clearLane: 1.6, clearCliff: 1.4, clearRiver: 1.6, ladder: LADDER_CANOPY, max: 460 },
  { key: 'underDense', zones: M_DENSE, archs: [A_FERN, A_BUSH, A_SAPLING], density: 28, spacing: 1.25, clearLane: 1.2, clearCliff: 0.7, clearRiver: 1.0, ladder: LADDER_FERN, max: 620 },
  // Jungle proper — open low ground away from the lanes. Mid range, and the one
  // in eight dead trunk STYLE_BIBLE §7 asks for in a tree line.
  { key: 'treeOpen', zones: M_OPEN, archs: [A_BROAD, A_BROAD, A_SLENDER, A_SLENDER, A_FORKED, A_CONIFER, A_MOSSY, A_DEAD], density: 10, spacing: 2.1, clearLane: 1.6, clearCliff: 1.4, clearRiver: 1.6, ladder: LADDER_CANOPY, max: 380 },
  { key: 'underOpen', zones: M_OPEN, archs: [A_FERN, A_BUSH, A_SAPLING], density: 23, spacing: 1.3, clearLane: 1.2, clearCliff: 0.7, clearRiver: 1.0, ladder: LADDER_FERN, max: 640 },
  { key: 'rockJungle', zones: M_DENSE | M_OPEN, archs: [A_BOULDER, A_ROCKS, A_OUTCROP], density: 7.5, spacing: 2.6, clearLane: 1.4, clearCliff: 0.8, clearRiver: 1.2, ladder: LADDER_CLIFF, max: 400 },
  { key: 'deadwood', zones: M_DENSE | M_OPEN, archs: [A_LOG, A_STUMP], density: 3.5, spacing: 4.0, clearLane: 1.6, clearCliff: 1.0, clearRiver: 1.4, ladder: LADDER_BARK, max: 190 },
  { key: 'ruins', zones: M_DENSE | M_OPEN | M_SHOULDER, archs: [A_RUINBLOCK, A_RUINCOLUMN], density: 1.4, spacing: 5.5, clearLane: 1.8, clearCliff: 1.0, clearRiver: 1.4, ladder: LADDER_MONUMENT, max: 130 },
  // Lane shoulders — sparse, so the lanes stay clean and the fights readable.
  { key: 'tufts', zones: M_SHOULDER, archs: [A_GRASS, A_FERN], density: 5.5, spacing: 2.1, clearLane: 0.9, clearCliff: 0.7, clearRiver: 1.0, ladder: LADDER_FERN, max: 400 },
  { key: 'rockShoulder', zones: M_SHOULDER, archs: [A_BOULDER, A_ROCKS], density: 3, spacing: 3.2, clearLane: 1.4, clearCliff: 0.8, clearRiver: 1.2, ladder: LADDER_CLIFF, max: 220 },
  // High ground — bare and wind-scoured. The contrast with the dense low jungle
  // is what makes elevation READ from a fixed 55 deg camera.
  { key: 'rockHigh', zones: M_HIGH, archs: [A_OUTCROP, A_BOULDER, A_ROCKS], density: 3, spacing: 3.0, clearLane: 1.6, clearCliff: 0.9, clearRiver: 1.2, ladder: LADDER_CLIFF, max: 160 },
  // "Occasional dead tree" (§8). The plateaus are small and ringed by cliff, so
  // this family lives or dies on `clearCliff`: at 1.8 m it landed 1-4 dead trees
  // across the whole map and the archetype was baked, AO'd and instanced for
  // nothing. 1.1 m still keeps a 6.5 m trunk off the lip.
  { key: 'treeHigh', zones: M_HIGH, archs: [A_DEAD, A_DEAD, A_CONIFER], density: 2.4, spacing: 3.4, clearLane: 1.8, clearCliff: 1.1, clearRiver: 1.6, ladder: LADDER_BARK, max: 60 },
  // River banks — reeds, wet stones, driftwood.
  { key: 'reeds', zones: M_BANK, archs: [A_REEDS], density: 14, spacing: 1.35, clearLane: 1.0, clearCliff: 0.7, clearRiver: 0.55, ladder: LADDER_FERN, max: 300 },
  { key: 'bankStones', zones: M_BANK, archs: [A_BANKSTONE], density: 9, spacing: 1.8, clearLane: 1.0, clearCliff: 0.7, clearRiver: 0.55, ladder: LADDER_WET, max: 220 },
  // Driftwood at density 1.6 and spacing 5.0 landed 6 / 0 / 12 instances at
  // 1 / 2 / 3 lanes — NONE AT ALL on the 2-lane map, an archetype baked, AO'd
  // and instanced for no read. The bank zone is ~736 m2 spread thinly over 22
  // tiles at 3 lanes, so at that density a tile's target rounds to zero or one
  // and `scatter` returns nothing at all when it rounds to zero.
  { key: 'driftwood', zones: M_BANK, archs: [A_DRIFTWOOD], density: 4.5, spacing: 3.0, clearLane: 1.2, clearCliff: 0.9, clearRiver: 0.6, ladder: LADDER_BARK, max: 70 },
];

// ============================================================================
// Placement bookkeeping
// ============================================================================

/** One placed prop. `step` is the index into the family's tint ladder that
 *  `scatter` chose — NOT a colour: each bucket resolves that index against its
 *  own surface family's ladder at fill time, which is what keeps a canopy step
 *  off a trunk. */
interface Place {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly rotY: number;
  readonly leanX: number;
  readonly leanZ: number;
  readonly step: number;
}

/** One bucket of a finished archetype. */
interface Bucket {
  readonly geo: THREE.BufferGeometry;
  readonly material: THREE.MeshStandardMaterial;
  /** Index into {@link VEG_SURFACES}, or -1. Resolved once, at bake time. */
  readonly surf: number;
}

/** One archetype's bake in flight, then its finished buckets and the envelope
 *  measured off them. */
interface ArchState {
  job: ChunkedBake | null;
  /** Cursor of the per-bucket finishing pass (white colours + AO + envelope). */
  finished: number;
  done: boolean;
  buckets: Bucket[];
  /** Worst-case lateral reach of any vertex, and of vertices inside the walkable
   *  band, both already scaled and leaned. Zero until `done`. */
  envFull: number;
  envLow: number;
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
 * The InstancedMesh colour attribute MULTIPLIES the material's albedo in LINEAR
 * space, so the value written has to be the linear ratio between the ladder step
 * and the ladder's base. Two things about that are easy to get wrong, and the
 * previous implementation got both:
 *
 *  1. The ratio must be taken AFTER mixing, not mixed after being taken. A
 *     palette ladder is authored in sRGB, and a +8 L* step is a linear ratio of
 *     roughly 2.0 — so compressing the LINEAR ratio toward 1 by a gain and then
 *     clamping it into a narrow band drove every channel of every ladder into
 *     the clamp. Measured on the frozen palette at the old
 *     `gain 0.45 / clamp [0.78, 1.24]`: 18 of 18 channels across all six
 *     ladders clamped, so all six shipped the identical achromatic pair
 *     (1.240, 1.240, 1.240) and (0.780, 0.780, 0.780) — hue discarded entirely.
 *     Here the mix happens in sRGB, where the ladder was authored, and the
 *     ratio is taken from the result.
 *  2. The clamp is a guard, not a dial. At `TINT_GAIN = 0.35` the frozen
 *     palette's widest channel is 1.4083 (wetStoneLit) and its narrowest 0.7461
 *     (barkDeep), so nothing clamps and `TINT_MIN`/`TINT_MAX` only fire if a
 *     future palette entry moves. The achieved perceptual step is at most
 *     +/-5.84 L*, about a third of a full ladder step — multiplicative and
 *     small, per the R_VEG spec.
 */
function ladderMods(ladder: readonly string[]): THREE.Color[] {
  const baseHex = ladder[0] ?? APAL.moss;
  const srgb = new THREE.Color();
  const base = new THREE.Color(baseHex);
  const baseS = { r: 0, g: 0, b: 0 };
  base.getRGB(srgb, THREE.SRGBColorSpace);
  baseS.r = srgb.r;
  baseS.g = srgb.g;
  baseS.b = srgb.b;
  const out: THREE.Color[] = [];
  const mixed = new THREE.Color();
  for (const hex of ladder) {
    new THREE.Color(hex).getRGB(srgb, THREE.SRGBColorSpace);
    mixed.setRGB(
      baseS.r + (srgb.r - baseS.r) * TINT_GAIN,
      baseS.g + (srgb.g - baseS.g) * TINT_GAIN,
      baseS.b + (srgb.b - baseS.b) * TINT_GAIN,
      THREE.SRGBColorSpace,
    );
    const mod = new THREE.Color();
    // Direct component writes: these are MULTIPLIERS, not a colour, and must
    // not be run through a colour-space conversion on the way in or out.
    mod.r = clampMod(safeRatio(mixed.r, base.r));
    mod.g = clampMod(safeRatio(mixed.g, base.g));
    mod.b = clampMod(safeRatio(mixed.b, base.b));
    out.push(mod);
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
// Envelope measurement
// ============================================================================

/**
 * Widen `out` with the worst-case lateral reach of `geo`'s vertices.
 *
 * "Worst case" means after the kit has applied its per-instance variation: an
 * instance may be scaled up to `SCATTER_MAX_SCALE` and leaned up to
 * `SCATTER_MAX_LEAN`, and a lean converts height into lateral reach. A vertex at
 * radius r and height y therefore reaches `(r cos θ + y sin θ) * s` at worst.
 * Measured on the broadleaf: a canopy shell 4.45 m out at ~7.6 m up becomes a
 * 7.42 m keep-out radius, against a 1.40 m walkable-band radius from the same
 * mesh. Those two numbers being 5x apart is the whole reason the two rules
 * below are separate.
 *
 * `low` collects only the vertices that stay inside the walkable band once
 * scaled, because that is the band a player can walk into — see PLANTING
 * CLEARANCE for why the two radii feed two different rules.
 */
function envelopeScan(geo: THREE.BufferGeometry, out: { full: number; low: number }): void {
  const pos = geo.getAttribute('position');
  const cos = Math.cos(SCATTER_MAX_LEAN);
  const sin = Math.sin(SCATTER_MAX_LEAN);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const reach = (Math.sqrt(x * x + z * z) * cos + Math.abs(y) * sin) * SCATTER_MAX_SCALE;
    if (reach > out.full) out.full = reach;
    if (y * SCATTER_MAX_SCALE <= LANE_HEADROOM && reach > out.low) out.low = reach;
  }
}

// ============================================================================
// Terrain fields
// ============================================================================

/**
 * Chamfer distance transform: metres from every cell to the nearest cell for
 * which `isSource` holds. Two sweeps, 1 / sqrt(2) weights, so the error against
 * true Euclidean distance is under 4% — far inside the tolerance of a clearance
 * test measured in whole metres.
 *
 * `isSource` receives the cell's terrain kind code AND its index, because two of
 * the four fields are terrain-kind queries and the third (camp clearings and
 * landmark anchors) is a rasterised mask that has nothing to do with kind.
 *
 * O(dim²) with two passes. At the frozen res = 1 a 3-lane map is 128 x 128, so
 * each field is ~16 k cells and costs well under a millisecond.
 */
function distanceField(t: TerrainDef, isSource: (code: number, index: number) => boolean): Float32Array {
  const g = t.grid;
  const dim = g.dim;
  const n = dim * dim;
  const FAR = 1e6;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = isSource(g.kind[i] ?? 0, i) ? 0 : FAR;
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
  let dSite: Float32Array = new Float32Array(0);

  const placements: Place[][] = ARCHETYPES.map(() => []);
  const archStates: ArchState[] = ARCHETYPES.map(() => ({
    job: null,
    finished: 0,
    done: false,
    buckets: [],
    envFull: 0,
    envLow: 0,
  }));
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
  // Each unit returns true when it is finished and the cursor may advance. Every
  // unit carries a label, because the ONLY thing worse than a build unit that
  // throws is a build unit that throws anonymously.
  interface Unit {
    readonly label: string;
    readonly run: () => boolean;
  }
  const units: Unit[] = [];
  const push = (label: string, run: () => boolean): void => {
    units.push({ label, run });
  };

  // SURFACE PRE-WARM, FIRST IN THE QUEUE. The first `surface(id)` of a family
  // rasterises its noise, normal and roughness textures, and that cost lands on
  // whoever happens to build first — measured at 16.2 ms for `bark`, buried
  // inside a `bakeChunked` step, which is how a 4 ms bake slice produced a 20 ms
  // frame. Cold total for the six families here: 57 ms of the 95 ms build.
  // AMENDMENT_3 §E.3 moves the cost to R_SCENE's construction-time pre-warm;
  // these units are what makes this module correct either way. Once R_SCENE has
  // pre-warmed they are `matCache` hits costing microseconds; until then the
  // cost is paid HERE, one family per unit, in a unit whose whole job it is.
  //
  // They go FIRST because each one on its own exceeds `SLICE_MS`, so the loop
  // breaks after it and no other work can be stacked into the same frame. That
  // is what makes the frame bound `max(worst unit, SLICE_MS + next worst)`
  // rather than `SLICE_MS + worst unit`.
  for (const vs of VEG_SURFACES) {
    push(`surface pre-warm: ${vs.id}`, () => {
      surface(vs.id);
      return true;
    });
  }

  push('distance field: lane', () => {
    dLane = distanceField(terrain, (c) => c === K_LANE || c === K_RAMP || c === K_BASE);
    return true;
  });
  push('distance field: cliff', () => {
    dCliff = distanceField(terrain, (c) => c === K_CLIFF);
    return true;
  });
  push('distance field: river', () => {
    dRiver = distanceField(terrain, (c) => c === K_RIVER);
    return true;
  });

  // KEEP-OUT FIELD (defect: `map.terrain.camps` and `map.terrain.landmarks` were
  // never read at all, so 59 props were measured standing inside camp clearings
  // — burying the camp mesh and the sim's spawn point — and 42 within 4 m of a
  // landmark anchor R_MAPMESH owns). Both are discs on the ground, so both
  // rasterise into one mask and one distance field; a family then keeps its
  // whole mesh envelope outside it.
  push('distance field: camps + landmarks', () => {
    const mask = new Uint8Array(dim * dim);
    // Rasterised CONSERVATIVELY: a cell joins the mask if its centre is within
    // `r` plus half a cell diagonal, so the marked region always CONTAINS the
    // true disc. Marking only centre-inside cells shrinks every disc by up to
    // 0.71 m at res 1, and that shortfall is exactly what left a handful of
    // props inside camp clearings after the field was introduced.
    const half = Math.SQRT1_2 / res;
    const disc = (cx: number, cz: number, r0: number): void => {
      const r = r0 + half;
      const x0 = Math.max(0, Math.floor((cx - r) * res));
      const x1 = Math.min(dim - 1, Math.ceil((cx + r) * res));
      const z0 = Math.max(0, Math.floor((cz - r) * res));
      const z1 = Math.min(dim - 1, Math.ceil((cz + r) * res));
      const r2 = r * r;
      for (let iz = z0; iz <= z1; iz++) {
        for (let ix = x0; ix <= x1; ix++) {
          const px = (ix + 0.5) / res;
          const pz = (iz + 0.5) / res;
          const dx = px - cx;
          const dz = pz - cz;
          if (dx * dx + dz * dz <= r2) mask[iz * dim + ix] = 1;
        }
      }
    };
    for (const camp of terrain.camps) {
      disc(camp.x, camp.z, CAMP_CLEARING_R[camp.tier] ?? CAMP_CLEARING_FALLBACK);
    }
    for (const lm of terrain.landmarks) disc(lm.x, lm.z, LANDMARK_KEEP_R);
    dSite = distanceField(terrain, (_c, i) => mask[i] === 1);
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
  push('zone classification', () => {
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

  // Archetype geometry. Two units per archetype: the first opens and steps a
  // chunked bake, the second finishes ONE bucket per call (white vertex colours,
  // baked AO, envelope scan). They are separate because the finishing pass used
  // to ride on the bake's last step, which made that one call the most expensive
  // unit in the queue.
  for (let a = 0; a < ARCHETYPES.length; a++) {
    const def = ARCHETYPES[a];
    const st = archStates[a];
    if (def === undefined || st === undefined) continue;
    push(`bake: ${def.key}`, () => {
      if (st.job === null) {
        st.job = bakeChunked(def.build(rng(`rift:veg:arch:${def.key}`)), BAKE_SLICE_MS);
        return false;
      }
      return !st.job.step();
    });
    push(`finish: ${def.key}`, () => {
      const job = st.job;
      if (job === null) return true;
      const part = job.mesh.parts[st.finished];
      if (part === undefined) {
        st.done = true;
        return true;
      }
      // Idempotent by contract: bake() already emitted the white attribute.
      // Called anyway so this module's correctness does not rest on knowing
      // that — a geometry reaching a kit material without one renders BLACK.
      whiteVertexColors(part.geo);
      if (def.ao) bakeVertexAO(part.geo, AO_STRENGTH);
      const env = { full: st.envFull, low: st.envLow };
      envelopeScan(part.geo, env);
      st.envFull = env.full;
      st.envLow = env.low;
      st.buckets.push({ geo: part.geo, material: part.material, surf: vegSurfaceIndex(part.material) });
      st.finished++;
      return false;
    });
  }

  // Scatter, one unit per (family, tile).
  const tileSize = side / TILES;
  let totalPlaced = 0;
  for (const fam of FAMILIES) {
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

    // CLEARANCE IS PER ARCHETYPE, IN TWO STAGES, and the split is what makes the
    // envelope rule affordable.
    //
    // `scatter` picks the position first and the archetype second (`accept` is a
    // point test; `variant` is only decided once the point is placed), so a
    // single family-wide clearance would have to be the worst archetype's — and
    // for `treeDense` that is the emergent giant's measured 7.94 m of leaned,
    // scaled envelope, imposed on every sapling-sized neighbour beside it.
    //
    // So: the POINT test uses the family's SMALLEST archetype envelope, which
    // generates the widest legal Poisson field; then {@link fits} re-tests each
    // placed instance against ITS OWN archetype's measured envelope and drops
    // the ones that do not fit. Exact rather than conservative, and it plants
    // strictly more than one family-wide worst case would.
    //
    // Every archetype bake precedes every scatter unit in the queue, so the
    // envelopes are final by the time this runs; an archetype whose bake failed
    // contributes nothing, which is right, because it also has no buckets and
    // will never be instanced.
    let clearLaneM = fam.clearLane;
    let clearSiteM = SITE_MARGIN;
    let clearanceReady = false;
    const resolveClearance = (): void => {
      if (clearanceReady) return;
      clearanceReady = true;
      let minLow = Number.POSITIVE_INFINITY;
      let minFull = Number.POSITIVE_INFINITY;
      for (const a of fam.archs) {
        const st = archStates[a];
        if (st === undefined || !st.done) continue;
        if (st.envLow < minLow) minLow = st.envLow;
        if (st.envFull < minFull) minFull = st.envFull;
      }
      if (minLow !== Number.POSITIVE_INFINITY && minLow > clearLaneM) clearLaneM = minLow;
      if (minFull !== Number.POSITIVE_INFINITY) clearSiteM = minFull + SITE_MARGIN;
    };

    const inZone = (i: number): boolean => ((1 << (zone[i] ?? Z_NONE)) & fam.zones) !== 0;

    const plantable = (i: number): boolean =>
      inZone(i) &&
      (dLane[i] ?? 0) >= clearLaneM &&
      (dCliff[i] ?? 0) >= fam.clearCliff &&
      (dRiver[i] ?? 0) >= fam.clearRiver &&
      (dSite[i] ?? 0) >= clearSiteM;

    const accept = (x: number, z: number): boolean =>
      plantable(cellIndex(x, z)) && farFromCommitted(x, z);

    /** The exact, per-archetype half of the keep-out law: nothing of this
     *  archetype's walkable-band geometry may enter a lane, ramp or base cell,
     *  and nothing of it AT ANY HEIGHT may cross a camp clearing or a landmark
     *  anchor.
     *
     *  This has to be a LOWER BOUND on the true Euclidean clearance, and two
     *  things stand between the stored field and that bound:
     *
     *   1. The field is sampled at CELL CENTRES and an instance stands anywhere
     *      inside its cell, up to half a diagonal away. A distance field is
     *      1-Lipschitz, so `d(point) >= d(cellCentre) - |point - cellCentre|`
     *      is rigorous.
     *   2. The (1, sqrt2) chamfer OVERESTIMATES Euclidean distance — by up to
     *      1 / cos(22.5 deg) = 8.24% — and overestimation is the dangerous
     *      direction for a keep-out, so the stored value is divided back down
     *      before the offset is subtracted.
     *
     *  Together they are exact rather than a magic margin, and they are what
     *  took the residual sub-cell violations to zero instead of "a few". */
    const clearanceAt = (f: Float32Array, x: number, z: number): number => {
      const i = cellIndex(x, z);
      const cx = (Math.floor(x * res) + 0.5) / res;
      const cz = (Math.floor(z * res) + 0.5) / res;
      const dx = x - cx;
      const dz = z - cz;
      return (f[i] ?? 0) / CHAMFER_MAX_OVER - Math.sqrt(dx * dx + dz * dz);
    };

    const fits = (x: number, z: number, archId: number): boolean => {
      const st = archStates[archId];
      if (st === undefined) return false;
      const lane = Math.max(fam.clearLane, st.envLow);
      return (
        clearanceAt(dLane, x, z) >= lane &&
        clearanceAt(dSite, x, z) >= st.envFull + SITE_MARGIN
      );
    };

    for (let tz = 0; tz < TILES; tz++) {
      for (let tx = 0; tx < TILES; tx++) {
        const minX = tx * tileSize;
        const minZ = tz * tileSize;
        const maxX = minX + tileSize;
        const maxZ = minZ + tileSize;
        const seed = `rift:veg:${fam.key}:${map.lanes}:${tz * TILES + tx}`;
        const tileIdx = tz * TILES + tx;
        push(`scatter: ${fam.key} tile ${tileIdx}`, () => {
          if (famCount >= fam.max || totalPlaced >= TOTAL_CAP) return true;
          resolveClearance();
          let anyZone = 0;
          for (let z = 1; z < 8; z++) {
            if (((1 << z) & fam.zones) !== 0) anyZone += tileZone[(tileIdx << 3) + z] ?? 0;
          }
          if (anyZone === 0) return true;
          // TARGET COUNT. `ScatterOpts.density` is per 100 m² of the RECT it is
          // given, and STYLE_BIBLE §8's densities are per 100 m² OF THE ZONE, so
          // the tile's zone area is what converts between them.
          //
          // It must be the ZONE area, not the plantable area, and that
          // distinction is the whole of the density defect. Targeting
          // `density * plantableArea` asks for §8's figure per 100 m² of the
          // part of the zone that survived the keep-outs, which under-delivers
          // by exactly the plantable fraction: measured at 3 lanes, `treeDense`
          // reached 9.31 trees per 100 m² of its 934 m² plantable area and
          // therefore 6.47 per 100 m² of the 1344 m² foliage zone the §8 floor
          // of 8 is written against. The instances still go only where
          // `accept` allows — the keep-outs are unchanged — they are just
          // counted against the zone the density is quoted for.
          let zoneCells = 0;
          let plantCells = 0;
          const x0 = Math.max(0, Math.floor(minX * res));
          const x1 = Math.min(dim - 1, Math.ceil(maxX * res) - 1);
          const z0 = Math.max(0, Math.floor(minZ * res));
          const z1 = Math.min(dim - 1, Math.ceil(maxZ * res) - 1);
          for (let cz = z0; cz <= z1; cz++) {
            for (let cx = x0; cx <= x1; cx++) {
              const i = cz * dim + cx;
              if (!inZone(i)) continue;
              zoneCells++;
              if (plantable(i)) plantCells++;
            }
          }
          if (plantCells === 0) return true;
          const rectArea = (maxX - minX) * (maxZ - minZ);
          const zoneArea = zoneCells / (res * res);
          const density = (fam.density * zoneArea) / rectArea;
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
            // ARCHETYPE SUBSTITUTION. `scatter` picks the point before the
            // variant, so the point was accepted against the family's SMALLEST
            // envelope; the variant it then drew may be too big for where it
            // landed. Dropping it leaves a hole — measured at 28% of the dense
            // jungle's placements — so instead walk the family's own weighted
            // list from the drawn variant and take the first archetype that
            // does fit. That is deterministic (the starting index comes from
            // the seeded `variant`), it keeps the family's weighting wherever
            // there is room, and it puts the small trees at the edge of a camp
            // clearing and the big ones in the deep jungle, which is also what
            // a real tree line does. Only when nothing in the family fits is
            // the instance dropped.
            let archId = -1;
            for (let k = 0; k < fam.archs.length; k++) {
              const cand = fam.archs[(Math.min(fam.archs.length - 1, xf.variant) + k) % fam.archs.length];
              if (cand !== undefined && fits(xf.x, xf.z, cand)) {
                archId = cand;
                break;
              }
            }
            if (archId < 0) continue;
            const list = placements[archId];
            if (list === undefined) continue;
            const found = fam.ladder.indexOf(xf.tint);
            list.push({
              x: xf.x,
              y: xf.y,
              z: xf.z,
              scale: xf.scale,
              rotY: xf.rotY,
              leanX: xf.leanX,
              leanZ: xf.leanZ,
              step: found < 0 ? 0 : found,
            });
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

  // Instance fill: one unit per archetype, one FILL_CHUNK of instances per call.
  // Every bucket of the archetype becomes one InstancedMesh — the whole
  // draw-call story of this module.
  const mat = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const white = new THREE.Color(1, 1, 1);
  for (let a = 0; a < ARCHETYPES.length; a++) {
    const def = ARCHETYPES[a];
    const st = archStates[a];
    if (def === undefined || st === undefined) continue;
    let b = 0;
    let filled = 0;
    let im: THREE.InstancedMesh | null = null;
    push(`instance fill: ${def.key}`, () => {
      const list = placements[a] ?? [];
      if (list.length === 0 || b >= st.buckets.length) return true;
      const bucket = st.buckets[b];
      if (bucket === undefined) {
        b++;
        return false;
      }
      let mesh = im;
      if (mesh === null) {
        mesh = new THREE.InstancedMesh(bucket.geo, bucket.material, list.length);
        mesh.name = `rift:veg:${def.key}:${b}`;
        // AMENDMENT_3 §D.2's whitelist, both halves. See SHADOW POLICY.
        const vs = bucket.surf >= 0 ? VEG_SURFACES[bucket.surf] : undefined;
        mesh.castShadow = def.castShadow && vs !== undefined && vs.castsShadow;
        mesh.receiveShadow = true;
        im = mesh;
        filled = 0;
      }
      const mods = bucket.surf >= 0 ? VEG_MODS[bucket.surf] : undefined;
      const end = Math.min(list.length, filled + FILL_CHUNK);
      for (let i = filled; i < end; i++) {
        const p = list[i];
        if (p === undefined) continue;
        euler.set(p.leanX, p.rotY, p.leanZ, 'YXZ');
        quat.setFromEuler(euler);
        pos.set(p.x, p.y, p.z);
        scl.set(p.scale, p.scale, p.scale);
        mat.compose(pos, quat, scl);
        mesh.setMatrixAt(i, mat);
        mesh.setColorAt(i, mods?.[p.step] ?? white);
      }
      filled = end;
      if (filled < list.length) return false;

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      // Instances span the whole map, so the bounds must be recomputed from
      // the instance matrices. Without this the mesh keeps the archetype's own
      // metre-wide sphere at the origin and the frustum culls the entire
      // jungle the moment the camera leaves the map corner. Only the sphere is
      // computed: `Frustum.intersectsObject` reads that one, and the box costs
      // a second O(instances) pass for a raycast this module never takes (no
      // vegetation is in the pick set).
      mesh.computeBoundingSphere();
      const swaySurface = bucket.surf >= 0 ? VEG_SURFACES[bucket.surf] : undefined;
      if (swaySurface !== undefined && def.sway.includes(swaySurface.id)) {
        const node = new THREE.Group();
        node.name = `${mesh.name}:sway`;
        node.add(mesh);
        root.add(node);
        sways.push({ node, amp: def.swayAmp, phase: (a * 1.618) % TAU });
      } else {
        root.add(mesh);
      }
      im = null;
      b++;
      return b >= st.buckets.length;
    });
  }

  // ---- the frame hook -------------------------------------------------------
  let cursor = 0;
  let failures = 0;
  /** The label of the first unit that threw. Non-null means the jungle is
   *  INCOMPLETE and `ready()` must never return true again (AMENDMENT_3 §G.1:
   *  a failed build reports not ready, loudly — this module used to swallow the
   *  throw, drop a whole archetype, and report ready anyway). */
  let firstFailure: string | null = null;
  let reported = false;
  let windT = 0;
  const clock = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance : null;

  const fail = (label: string, err: unknown): void => {
    failures++;
    if (firstFailure === null) {
      firstFailure = label;
      console.error(
        `rift vegetation: build unit "${label}" threw. The jungle is INCOMPLETE and ready() will stay false.`,
        err,
      );
    }
  };

  const stepBuild = (): void => {
    if (cursor >= units.length) return;
    const t0 = clock !== null ? clock.now() : 0;
    while (cursor < units.length) {
      const unit = units[cursor];
      if (unit === undefined) {
        cursor++;
        continue;
      }
      try {
        if (unit.run()) cursor++;
      } catch (err) {
        // A single bad unit must not take the frame — or the rest of the
        // jungle — down with it (GRAPHICS_CONTRACT §7 robustness). It does take
        // `ready()` down with it, permanently, which is the point.
        cursor++;
        fail(unit.label, err);
      }
      if (clock === null || clock.now() - t0 >= SLICE_MS) break;
    }
    if (cursor >= units.length && failures > 0 && !reported) {
      reported = true;
      console.error(
        `rift vegetation: build finished with ${failures} failed unit(s); first was "${firstFailure ?? '?'}". ` +
          'ready() stays false.',
      );
    }
  };

  const stepWind = (dtMs: number): void => {
    // Allocation-free and O(sway nodes), never O(instances).
    windT += dtMs * 0.001;
    for (let i = 0; i < sways.length; i++) {
      const s = sways[i];
      if (s === undefined) continue;
      const a = windT * SWAY_RATE + s.phase;
      s.node.position.set(Math.sin(a) * s.amp, 0, Math.cos(a * 0.83 + s.phase) * s.amp * 0.7);
    }
  };

  core.addFrameHook((dtMs: number) => {
    // GUARD YOUR OWN ENTRY POINT (core.ts `addFrameHook`, AMENDMENT_3 §G.2): a
    // hook that throws takes the whole frame down, including every hook
    // registered after it. Neither half below is allowed to throw — the build
    // loop already catches per unit — so reaching here is itself a defect, and
    // it is recorded as one rather than swallowed.
    try {
      stepBuild();
      stepWind(dtMs);
    } catch (err) {
      fail('frame hook', err);
    }
  });

  return {
    /** True only when every unit ran AND none of them threw. A build that lost
     *  an archetype reports NOT ready forever, so the capture harness blocks
     *  instead of photographing a half-planted map (AMENDMENT_3 §G.1). */
    ready(): boolean {
      return firstFailure === null && cursor >= units.length;
    },
  };
}
